/* misc大手子 — 64 PCAP / PCAPNG
 * 经典 pcap + pcapng、Ethernet/raw-IP/SLL/NULL、IPv4/IPv6、TCP 重组、UDP、DNS/HTTP、TTL 异常。
 */
(function (root) {
  'use strict';
  const MDZ = root.MDZ = root.MDZ || {};
  const { toU8, hex, ascii, finding, artifact, FLAG_RE, printableRatio, strings } = MDZ;

  function be16(b, o) { return ((b[o] << 8) | b[o + 1]) & 0xffff; }
  function be32(b, o) { return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0; }
  function le16(b, o) { return (b[o] | (b[o + 1] << 8)) & 0xffff; }
  function le32(b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0; }
  function ip4(b, o) { return `${b[o]}.${b[o + 1]}.${b[o + 2]}.${b[o + 3]}`; }
  function ip6(b, o) {
    const parts = [];
    for (let i = 0; i < 16; i += 2) parts.push(be16(b, o + i).toString(16));
    return parts.join(':');
  }
  function concat(list) {
    let n = 0;
    for (const x of list) n += x.length;
    const out = new Uint8Array(n);
    let p = 0;
    for (const x of list) { out.set(x, p); p += x.length; }
    return out;
  }
  function portStr(ip, port) { return `${ip}:${port}`; }

  const MAX_PACKETS = 100000;
  const MAX_STREAM = 8 * 1024 * 1024;
  const MAX_ARTIFACTS = 128;
  const MAX_ARTIFACT_TOTAL = 32 * 1024 * 1024;

  function read32(b, o, le) { return le ? le32(b, o) : be32(b, o); }
  function read16(b, o, le) { return le ? le16(b, o) : be16(b, o); }

  // ---------- pcap / pcapng ----------
  function parsePCAP(input) {
    const b = toU8(input);
    if (b.length < 4) return { error: '文件太短' };
    if (b[0] === 0x0a && b[1] === 0x0d && b[2] === 0x0d && b[3] === 0x0a) {
      return parsePCAPNG(b);
    }
    const magic = b[0] === 0xd4 && b[1] === 0xc3 && b[2] === 0xb2 && b[3] === 0xa1 ? 'le'
      : b[0] === 0xa1 && b[1] === 0xb2 && b[2] === 0xc3 && b[3] === 0xd4 ? 'be'
      : b[0] === 0x4d && b[1] === 0x3c && b[2] === 0xb2 && b[3] === 0xa1 ? 'len'
      : b[0] === 0xa1 && b[1] === 0xb2 && b[2] === 0x3c && b[3] === 0x4d ? 'ben' : null;
    if (!magic) return { error: '不是 pcap/pcapng（magic 不匹配）' };
    const le = magic === 'le' || magic === 'len';
    if (b.length < 24) return { error: 'pcap 全局头不完整' };
    const linkType = read32(b, 20, le);
    const packets = [];
    const warnings = [];
    let pos = 24, trailing = null, capHit = false;
    while (pos + 16 <= b.length) {
      const ts = read32(b, pos, le);
      const frac = read32(b, pos + 4, le);
      const incl = read32(b, pos + 8, le);
      const orig = read32(b, pos + 12, le);
      if (incl > b.length - pos - 16) {
        // 常见 CTF 尾挂：剩下的字节不是完整包，整体作为 trailing 交给上层
        trailing = b.subarray(pos);
        break;
      }
      packets.push({
        index: packets.length + 1, ts, frac, linkType, data: b.subarray(pos + 16, pos + 16 + incl),
        inclLen: incl, origLen: orig, truncated: incl < orig
      });
      pos += 16 + incl;
      if (packets.length >= MAX_PACKETS) { warnings.push('包数超过上限，后续截断'); capHit = true; break; }
    }
    if (!trailing && !capHit && pos < b.length) trailing = b.subarray(pos);
    return {
      error: null, format: 'pcap', littleEndian: le, nano: magic === 'len' || magic === 'ben',
      linkType, linkTypes: [linkType], packets, warnings, trailing, size: b.length,
      bytes: packets.reduce((a, p) => a + p.inclLen, 0)
    };
  }

  function parsePCAPNG(b) {
    const packets = [];
    const warnings = [];
    let interfaces = [];
    let linkTypes = [];
    let le = null;
    let pos = 0;
    let capHit = false;
    while (pos + 12 <= b.length) {
      const isSHB = b[pos] === 0x0a && b[pos + 1] === 0x0d && b[pos + 2] === 0x0d && b[pos + 3] === 0x0a;
      if (isSHB) {
        if (pos + 12 > b.length) break;
        const bom = b.subarray(pos + 8, pos + 12);
        // 0x1A2B3C4D 的落盘字节：LE 4d 3c 2b 1a；BE 1a 2b 3c 4d
        if (bom[0] === 0x4d && bom[1] === 0x3c && bom[2] === 0x2b && bom[3] === 0x1a) le = true;
        else if (bom[0] === 0x1a && bom[1] === 0x2b && bom[2] === 0x3c && bom[3] === 0x4d) le = false;
        else { warnings.push('SHB byte-order magic 异常'); break; }
        interfaces = [];
      }
      if (le === null) { warnings.push('首个 block 不是 SHB'); break; }
      const type = read32(b, pos, le);
      const total = read32(b, pos + 4, le);
      if (total < 12 || pos + total > b.length) {
        warnings.push(`block @0x${hex(pos)} 长度异常（${total}）`);
        break;
      }
      const bodyStart = pos + 8, bodyEnd = pos + total - 4;
      const trailer = read32(b, pos + total - 4, le);
      if (trailer !== total) warnings.push(`block @0x${hex(pos)} 尾部长度 ${trailer} 与头部 ${total} 不一致`);
      if (type === 1 && bodyEnd - bodyStart >= 8) { // IDB
        const lt = read16(b, bodyStart, le);
        interfaces.push({ linkType: lt, snapLen: read32(b, bodyStart + 4, le) });
        if (!linkTypes.includes(lt)) linkTypes.push(lt);
      } else if (type === 6 && bodyEnd - bodyStart >= 20) { // EPB
        const iface = read32(b, bodyStart, le);
        const cap = read32(b, bodyStart + 12, le);
        const orig = read32(b, bodyStart + 16, le);
        const start = bodyStart + 20;
        const end = Math.min(bodyEnd, start + cap);
        const info = interfaces[iface];
        if (!info) warnings.push(`EPB 引用不存在接口 ${iface}`);
        else {
          const data = b.subarray(start, end);
          packets.push({
            index: packets.length + 1, linkType: info.linkType, data,
            inclLen: data.length, origLen: orig, truncated: data.length < orig,
            ts: read32(b, bodyStart + 4, le) * 4294967296 + read32(b, bodyStart + 8, le),
            frac: 0
          });
        }
      } else if (type === 3 && bodyEnd - bodyStart >= 4) { // SPB
        const orig = read32(b, bodyStart, le);
        const start = bodyStart + 4;
        const avail = bodyEnd - start;
        const take = Math.max(0, Math.min(avail, orig || avail)); // 去掉 4 字节块填充
        const info = interfaces[0];
        if (!info) warnings.push('SPB 没有接口');
        else packets.push({
          index: packets.length + 1, linkType: info.linkType, data: b.subarray(start, start + take),
          inclLen: take, origLen: orig, truncated: take < orig, ts: 0, frac: 0
        });
      }
      pos += total;
      if (packets.length >= MAX_PACKETS) { warnings.push('包数超过上限，后续截断'); capHit = true; break; }
    }
    const trailing = !capHit && pos < b.length ? b.subarray(pos) : null;
    return {
      error: null, format: 'pcapng', littleEndian: le, linkType: linkTypes[0], linkTypes,
      packets, warnings, trailing, size: b.length,
      bytes: packets.reduce((a, p) => a + p.inclLen, 0)
    };
  }

  // ---------- 链路层 / IP / 传输层 ----------
  function parseTCP(data, off, end, src, dst) {
    if (off + 20 > end) return null;
    const dataOff = (data[off + 12] >> 4) * 4;
    if (dataOff < 20 || off + dataOff > end) return null;
    const sport = be16(data, off), dport = be16(data, off + 2);
    const seq = be32(data, off + 4), ack = be32(data, off + 8);
    const flags = data[off + 13];
    return {
      proto: 'TCP', src, dst, sport, dport, seq, ack, flags,
      payload: data.subarray(off + dataOff, end)
    };
  }

  function parseUDP(data, off, end, src, dst) {
    if (off + 8 > end) return null;
    const sport = be16(data, off), dport = be16(data, off + 2);
    const len = be16(data, off + 4);
    const pEnd = Math.min(end, off + Math.max(8, len));
    return { proto: 'UDP', src, dst, sport, dport, payload: data.subarray(off + 8, pEnd) };
  }

  function parseICMP(data, off, end, src, dst, proto) {
    if (off + 8 > end) return null;
    return {
      proto: proto === 1 ? 'ICMP' : 'ICMPv6',
      src, dst, type: data[off], code: data[off + 1],
      payload: data.subarray(Math.min(off + 8, end), end)
    };
  }

  function parseTransport(proto, data, off, end, src, dst, state) {
    if (proto === 6) {
      const t = parseTCP(data, off, end, src, dst);
      if (t) state.tcp.push(t);
      return t;
    }
    if (proto === 17) {
      const u = parseUDP(data, off, end, src, dst);
      if (u) state.udp.push(u);
      return u;
    }
    if (proto === 1 || proto === 58) {
      const c = parseICMP(data, off, end, src, dst, proto);
      if (c) state.icmp.push(c);
      return c;
    }
    return { proto: 'IP-' + proto, src, dst };
  }

  function parseIPv4(data, off, state) {
    if (off + 20 > data.length) return null;
    const ihl = (data[off] & 0x0f) * 4;
    if (ihl < 20 || off + ihl > data.length) return null;
    const total = be16(data, off + 2);
    const end = Math.min(data.length, off + (total || data.length - off));
    const proto = data[off + 9];
    const ttl = data[off + 8];
    const src = ip4(data, off + 12), dst = ip4(data, off + 16);
    const frag = be16(data, off + 6);
    const fragOff = (frag & 0x1fff) * 8;
    const mf = !!(frag & 0x2000);
    const payload = data.subarray(off + ihl, end);
    const ip = { version: 4, src, dst, ttl, proto };
    if (fragOff || mf) {
      const id = be16(data, off + 4);
      const key = `${src}>${dst}/${proto}/${id}`;
      if (!state.fragments.has(key)) state.fragments.set(key, []);
      const list = state.fragments.get(key);
      if (list.length < 256) list.push({ off: fragOff, data: payload, mf });
      const parts = list.slice().sort((a, b) => a.off - b.off);
      let assembled = null, next = 0, complete = false;
      const chunks = [];
      for (const p of parts) {
        if (p.off > next) break;
        if (p.off + p.data.length > next) {
          chunks.push(p.data.subarray(Math.max(0, next - p.off)));
          next = p.off + p.data.length;
        }
        if (!p.mf) { complete = true; break; }
      }
      if (complete && parts[0] && parts[0].off === 0) assembled = concat(chunks);
      if (assembled) {
        state.fragments.delete(key);
        state.incompleteFrags.delete(key);
        const l4 = parseTransport(proto, assembled, 0, assembled.length, src, dst, state);
        if (l4) l4.ttl = ttl;
        return { ip, l4, fragmented: true };
      }
      state.incompleteFrags.add(key);
      return { ip, fragmented: true, incomplete: true, fragKey: key };
    }
    const l4 = parseTransport(proto, data, off + ihl, end, src, dst, state);
    if (l4) l4.ttl = ttl;
    return { ip, l4 };
  }

  function parseIPv6(data, off, state) {
    if (off + 40 > data.length) return null;
    const plen = be16(data, off + 4);
    const end = Math.min(data.length, off + 40 + plen);
    const src = ip6(data, off + 8), dst = ip6(data, off + 24);
    let next = data[off + 6], pos = off + 40;
    let hops = 0;
    while (hops++ < 12 && pos < end) {
      if (next === 6 || next === 17) break;
      if (next === 0 || next === 43 || next === 60) {
        if (pos + 2 > end) return { ip: { version: 6, src, dst, ttl: data[off + 7], proto: next }, incomplete: true };
        const len = (data[pos + 1] + 1) * 8;
        next = data[pos];
        pos += len;
        if (pos > end) return { ip: { version: 6, src, dst, ttl: data[off + 7], proto: next }, incomplete: true };
      } else if (next === 44) {
        if (pos + 8 > end) return { ip: { version: 6, src, dst, ttl: data[off + 7], proto: next }, incomplete: true };
        const field = be16(data, pos + 2);
        if ((field & 0xfff8) || (field & 1)) {
          const id = be32(data, pos + 4);
          state.incompleteFrags.add(`${src}>${dst}/44/${id}`);
          return { ip: { version: 6, src, dst, ttl: data[off + 7], proto: next }, incomplete: true };
        }
        next = data[pos]; pos += 8;
      } else if (next === 51) {
        if (pos + 2 > end) return { ip: { version: 6, src, dst, ttl: data[off + 7], proto: next }, incomplete: true };
        const len = (data[pos + 1] + 2) * 4;
        next = data[pos];
        pos += len;
        if (pos > end) return { ip: { version: 6, src, dst, ttl: data[off + 7], proto: next }, incomplete: true };
      } else {
        return { ip: { version: 6, src, dst, ttl: data[off + 7], proto: next }, l4: { proto: 'IPv6-' + next, src, dst } };
      }
    }
    const ip = { version: 6, src, dst, ttl: data[off + 7], proto: next };
    const l4 = parseTransport(next, data, pos, end, src, dst, state);
    if (l4) l4.ttl = ip.ttl;
    return { ip, l4 };
  }

  function parsePacket(pkt, state) {
    const data = pkt.data;
    let frame = null;
    const lt = pkt.linkType;
    if (lt === 1) { // Ethernet
      if (data.length < 14) return null;
      let off = 14, type = be16(data, 12);
      while ((type === 0x8100 || type === 0x88a8) && off + 4 <= data.length) {
        type = be16(data, off + 2); off += 4;
      }
      if (type === 0x0800) frame = parseIPv4(data, off, state);
      else if (type === 0x86dd) frame = parseIPv6(data, off, state);
    } else if (lt === 101) { // raw IP
      if (!data.length) return null;
      const v = data[0] >> 4;
      frame = v === 4 ? parseIPv4(data, 0, state) : v === 6 ? parseIPv6(data, 0, state) : null;
    } else if (lt === 113) { // Linux SLL
      if (data.length < 16) return null;
      const type = be16(data, 14);
      if (type === 0x0800) frame = parseIPv4(data, 16, state);
      else if (type === 0x86dd) frame = parseIPv6(data, 16, state);
    } else if (lt === 0 || lt === 108) { // NULL/LOOP
      if (data.length < 4) return null;
      let fam = le32(data, 0);
      if (fam > 0xffff) fam = be32(data, 0);
      if (fam === 2) frame = parseIPv4(data, 4, state);
      else if (fam === 24 || fam === 28 || fam === 30) frame = parseIPv6(data, 4, state);
    } else {
      state.unsupported.set(lt, (state.unsupported.get(lt) || 0) + 1);
      return null;
    }
    return frame;
  }

  // ---------- TCP 重组 ----------
  function reassembleTCP(tcp) {
    const dirs = new Map();
    for (const p of tcp) {
      if (!p.payload || !p.payload.length) continue;
      const key = `${p.src}|${p.sport}>${p.dst}|${p.dport}`;
      if (!dirs.has(key)) dirs.set(key, []);
      dirs.get(key).push(p);
    }
    const out = [];
    for (const [key, list] of dirs) {
      // 找序列号环上的最大空档，缺口之后的第一个 seq 作为基准；兼容乱序与 32-bit wrap
      const seqs = list.map(p => p.seq >>> 0).sort((a, b) => a - b);
      let baseSeq = seqs[0], bestGap = -1;
      for (let i = 1; i < seqs.length; i++) {
        const gap = seqs[i] - seqs[i - 1];
        if (gap > bestGap) { bestGap = gap; baseSeq = seqs[i]; }
      }
      const wrapGap = (seqs[0] + 0x100000000) - seqs[seqs.length - 1];
      if (wrapGap > bestGap) baseSeq = seqs[0];
      const ordered = list.map(p => ({ p, rel: (p.seq - baseSeq) >>> 0 }))
        .sort((a, b) => a.rel - b.rel);
      let next = 0, gaps = 0, retrans = 0, overlap = 0;
      const chunks = [];
      let bytes = 0;
      for (const item of ordered) {
        const p = item.p, rel = item.rel;
        const endSeq = rel + p.payload.length;
        if (endSeq <= next && next !== 0) { retrans++; continue; }
        let skip = 0;
        if (rel < next) { skip = next - rel; overlap++; }
        else if (rel > next) gaps++;
        if (skip < p.payload.length) {
          const part = p.payload.subarray(skip);
          chunks.push(part);
          bytes += part.length;
          next = endSeq;
          if (bytes >= MAX_STREAM) break;
        }
      }
      const payload = concat(chunks).subarray(0, MAX_STREAM);
      const ttls = list.map(p => p.ttl).filter(v => typeof v === 'number');
      out.push({
        key, src: list[0].src, dst: list[0].dst, sport: list[0].sport, dport: list[0].dport,
        packets: list.length, bytes: payload.length, payload,
        gaps, retrans, overlap,
        ttlMin: ttls.length ? Math.min(...ttls) : null,
        ttlMax: ttls.length ? Math.max(...ttls) : null,
        truncated: bytes >= MAX_STREAM
      });
    }
    return out;
  }

  // ---------- DNS / HTTP ----------
  function readDNSName(b, pos, depth) {
    if (depth > 8) return null;
    const labels = [];
    let next = pos;
    while (pos < b.length) {
      const len = b[pos];
      if (len === 0) { pos++; next = Math.max(next, pos); break; }
      if ((len & 0xc0) === 0xc0) {
        if (pos + 1 >= b.length) return null;
        const ptr = ((len & 0x3f) << 8) | b[pos + 1];
        const sub = readDNSName(b, ptr, depth + 1);
        if (sub && sub.name) labels.push(sub.name);
        next = Math.max(next, pos + 2);
        break;
      }
      if (len > 63 || pos + 1 + len > b.length) return null;
      labels.push(ascii(b.subarray(pos + 1, pos + 1 + len), len));
      pos += 1 + len;
      next = Math.max(next, pos);
    }
    return { name: labels.filter(Boolean).join('.'), next };
  }

  function parseDNS(b) {
    if (b.length < 12) return null;
    const qd = be16(b, 4);
    let pos = 12;
    const names = [];
    for (let i = 0; i < qd && i < 32 && pos < b.length; i++) {
      const r = readDNSName(b, pos, 0);
      if (!r) break;
      pos = r.next;
      if (pos + 4 > b.length) break;
      const type = be16(b, pos);
      pos += 4;
      names.push({ name: r.name, type });
    }
    return { names };
  }

  function httpInfo(payload) {
    const head = ascii(payload, Math.min(payload.length, 4096));
    let m = head.match(/^(GET|POST|PUT|HEAD|DELETE|OPTIONS|PATCH|CONNECT)\s+(\S+)\s+HTTP\/1\.[01]/m);
    if (m) {
      const host = (head.match(/^Host:\s*([^\r\n]+)/mi) || [])[1] || '';
      return { kind: 'request', method: m[1], path: m[2], host };
    }
    m = head.match(/^HTTP\/1\.[01]\s+(\d{3})(?:\s+([^\r\n]*))?/m);
    if (m) return { kind: 'response', status: parseInt(m[1], 10), reason: m[2] || '' };
    return null;
  }

  // ---------- HTTP 对象 ----------
  // 把响应/请求的真正 body 切出来：Content-Length / chunked / multipart 三种都认
  function latin1(b) {
    let s = '';
    for (let i = 0; i < b.length; i += 8192) s += String.fromCharCode.apply(null, b.subarray(i, i + 8192));
    return s;
  }

  function dechunk(buf) {
    const parts = [];
    let p = 0;
    while (p < buf.length) {
      let e = p;
      while (e + 1 < buf.length && !(buf[e] === 13 && buf[e + 1] === 10)) e++;
      if (e + 1 >= buf.length) break;
      const size = parseInt(ascii(buf.subarray(p, e), e - p).split(';')[0].trim(), 16);
      if (!isFinite(size)) return null;
      p = e + 2;
      if (!size) break;
      if (p + size > buf.length) { parts.push(buf.subarray(p)); break; }
      parts.push(buf.subarray(p, p + size));
      p += size + 2;
    }
    return parts.length ? concat(parts) : null;
  }

  const HTTP_EXT = { PNG: 'png', JPEG: 'jpg', GIF: 'gif', BMP: 'bmp', ZIP: 'zip', '7Z': '7z', RAR: 'rar', PDF: 'pdf', GZIP: 'gz', TAR: 'tar', WEBP: 'webp', ICO: 'ico', WAV: 'wav', MP3: 'mp3', ELF: 'elf', PE: 'exe', SQLITE: 'db' };

  function httpObjectName(hdr, path, idx, format) {
    const m = /filename\*?=(?:"([^"]+)"|([^;\r\n]+))/i.exec(hdr || '');
    let base = m ? (m[1] || m[2] || '').trim() : '';
    if (!base && path) base = path.split('?')[0].split('/').pop();
    base = base.replace(/[\\/:*?"<>|]/g, '_').slice(0, 60);
    if (!/\.[a-z0-9]{1,5}$/i.test(base)) base = (base || 'obj' + idx) + '.' + (HTTP_EXT[format] || 'bin');
    return 'http-' + base;
  }

  function httpExtract(s) {
    const out = [];
    const p = s.payload;
    if (!p || p.length < 40) return out;
    const head = ascii(p, Math.min(p.length, 16384));
    let path = '', isReq = false;
    if (/^HTTP\/1\.[01]\s+\d{3}/.test(head)) { /* 响应 */ }
    else {
      const m = head.match(/^(?:GET|POST|PUT|HEAD|DELETE|OPTIONS|PATCH)\s+(\S+)\s+HTTP\/1\.[01]/);
      if (!m) return out;
      isReq = true; path = m[1];
    }
    const he = head.indexOf('\r\n\r\n');
    if (he < 0) return out;
    const hdr = head.slice(0, he);
    const H = n => { const m = hdr.match(new RegExp('^' + n + ':\\s*(.+)$', 'mi')); return m ? m[1].trim() : ''; };
    let body = p.subarray(he + 4);
    if (/chunked/i.test(H('Transfer-Encoding'))) {
      const d = dechunk(body);
      if (d && d.length) body = d;
    } else {
      const cl = parseInt(H('Content-Length') || '', 10);
      if (cl > 0 && cl < body.length) body = body.subarray(0, cl);
    }
    if (body.length < 16) return out;
    const origin = `${s.src}:${s.sport} → ${s.dst}:${s.dport}`;
    const bm = /boundary="?([^";]+)"?/i.exec(H('Content-Type'));
    if (bm) {
      const parts = latin1(body).split('--' + bm[1]);
      let idx = 0;
      for (let k = 1; k < parts.length && out.length < 8; k++) {
        const part = parts[k];
        if (part.slice(0, 2) === '--') break;
        const sep = part.indexOf('\r\n\r\n');
        if (sep < 0) continue;
        const ph = part.slice(0, sep);
        let pb = part.slice(sep + 4);
        if (pb.slice(-2) === '\r\n') pb = pb.slice(0, -2);
        if (pb.length < 8) continue;
        idx++;
        const fn = /filename="([^"]*)"/i.exec(ph);
        const nm = /name="([^"]*)"/i.exec(ph);
        const label = (fn ? fn[1] : '') || (nm ? nm[1] : '') || 'part' + idx;
        const probe = Uint8Array.from(pb.slice(0, 16), c => c.charCodeAt(0) & 255);
        out.push({
          name: httpObjectName(ph, label, idx, MDZ.detectType(probe).format),
          bytes: Uint8Array.from(pb, c => c.charCodeAt(0) & 255),
          note: `HTTP multipart ${label} · ${origin}`
        });
      }
      return out;
    }
    const t = MDZ.detectType(body);
    const cd = /filename\*?=(?:"([^"]+)"|([^;\r\n]+))/i.exec(hdr);
    if ((t.format === 'unknown' || t.format === 'TEXT') && !cd) return out;
    out.push({
      name: httpObjectName(hdr, path, 1, t.format),
      bytes: body.slice(0),
      note: `HTTP ${isReq ? '请求' : '响应'} body · ${origin}${t.format !== 'unknown' && t.format !== 'TEXT' ? ' · ' + t.format : ''}`
    });
    return out;
  }

  // ---------- USB HID 键盘 ----------
  // 常见题：pcap linktype 189/220/249，载荷里是 8 字节 HID 键盘报文。
  // 头长度各家不同，所以对多个候选偏移各解一遍，取可打印率最高的。
  function hidChar(key, mod) {
    const shift = (mod & 0x22) !== 0;
    if (key >= 0x04 && key <= 0x1D) {
      const ch = String.fromCharCode(97 + key - 0x04);
      return shift ? ch.toUpperCase() : ch;
    }
    if (key >= 0x1E && key <= 0x27) {
      return shift ? '!@#$%^&*()'[key - 0x1E] : '1234567890'[key - 0x1E];
    }
    if (key === 0x28) return '\n';
    if (key === 0x2C) return ' ';
    if (key === 0x2D) return shift ? '_' : '-';
    if (key === 0x2E) return shift ? '+' : '=';
    if (key === 0x2F) return shift ? '{' : '[';
    if (key === 0x30) return shift ? '}' : ']';
    if (key === 0x31) return shift ? '|' : String.fromCharCode(92);
    if (key === 0x33) return shift ? ':' : ';';
    if (key === 0x34) return shift ? '"' : "'";
    if (key === 0x35) return shift ? '~' : '`';
    if (key === 0x36) return shift ? '<' : ',';
    if (key === 0x37) return shift ? '>' : '.';
    if (key === 0x38) return shift ? '?' : '/';
    return '';
  }

  function decodeUSBAt(packets, offset) {
    let out = '', last = 0;
    for (const p of packets) {
      const d = p.data;
      if (d.length < offset + 8) continue;
      const key = d[offset + 2], mod = d[offset];
      if (!key && !mod) { last = 0; continue; }
      const id = (key << 3) | mod;
      if (id === last) continue;
      last = id;
      const ch = hidChar(key, mod);
      if (ch) out += ch;
    }
    return out;
  }

  function usbKeyboard(packets) {
    let best = null;
    for (const off of [0, 8, 16, 24, 27, 32, 35, 40, 48, 56, 64]) {
      const text = decodeUSBAt(packets, off);
      if (text.length < 4) continue;
      const pr = printableRatio(new TextEncoder().encode(text));
      if (!best || pr > best.pr) best = { offset: off, text, pr };
    }
    return best && best.pr >= 0.85 ? best : null;
  }

  // ---------- 审计 ----------
  function auditPCAP(input, name) {
    const b = toU8(input);
    const findings = [], artifacts = [];
    const parsed = parsePCAP(b);
    if (parsed.error) {
      return { findings: [finding('L0', 'format', '不是 pcap/pcapng', { detail: parsed.error })], artifacts, image: null, pcap: null };
    }
    const state = {
      tcp: [], udp: [], icmp: [], fragments: new Map(), incompleteFrags: new Set(), warnings: parsed.warnings.slice(),
      unsupported: new Map(), ttls: new Map(), conversations: new Map(), ipPackets: 0, bytes: 0
    };
    for (const pkt of parsed.packets) {
      const frame = parsePacket(pkt, state);
      if (!frame || !frame.ip) continue;
      state.ipPackets++;
      state.bytes += pkt.inclLen;
      const ip = frame.ip;
      const ttlKey = `${ip.src}>${ip.dst}`;
      if (!state.ttls.has(ttlKey)) state.ttls.set(ttlKey, { src: ip.src, dst: ip.dst, ttls: [] });
      const t = state.ttls.get(ttlKey);
      if (t.ttls.length < 5000) t.ttls.push(ip.ttl);
      const l4 = frame.l4 || {};
      const a = l4.src || ip.src, d = l4.dst || ip.dst;
      const ap = l4.sport !== undefined ? portStr(a, l4.sport) : a;
      const dp = l4.dport !== undefined ? portStr(d, l4.dport) : d;
      const convKey = [ap, dp].sort().join(' <-> ');
      if (!state.conversations.has(convKey)) state.conversations.set(convKey, { a: ap, b: dp, packets: 0, bytes: 0, ttlMin: Infinity, ttlMax: -Infinity });
      const conv = state.conversations.get(convKey);
      conv.packets++; conv.bytes += pkt.inclLen;
      if (typeof ip.ttl === 'number') { conv.ttlMin = Math.min(conv.ttlMin, ip.ttl); conv.ttlMax = Math.max(conv.ttlMax, ip.ttl); }
    }
    if (state.incompleteFrags.size) state.warnings.push(`${state.incompleteFrags.size} 组分片未完整重组`);
    // USB HID 键盘流量
    const usbLt = (parsed.linkTypes || []).find(lt => lt === 189 || lt === 220 || lt === 249);
    let usb = null;
    if (usbLt != null) {
      usb = usbKeyboard(parsed.packets);
      if (usb) {
        const u8 = new TextEncoder().encode(usb.text);
        findings.push(finding('L4', 'usb_hid', `USB HID 键盘：解出 ${usb.text.length} 个字符（偏移 ${usb.offset}）`, {
          confidence: 0.85, declared: `linktype ${usbLt}`,
          actual: usb.text.slice(0, 160),
          preview: usb.text.slice(0, 400),
          detail: '按 HID 键盘 8 字节报文在多个候选偏移上试解，取可打印率最高的一组。',
          recipe: 'tshark -r x.pcap -T fields -e usb.capdata',
          payload: { name: 'usb-hid.txt', bytes: u8.slice(0) }
        }));
        artifacts.push(artifact('usb-hid.txt', u8, 'USB HID 键盘还原'));
      }
    }

    const icmp = [];
    for (const c of state.icmp.slice(0, 2000)) {
      const head = c.payload.subarray(0, Math.min(c.payload.length, 4096));
      const txt = ascii(head, head.length);
      icmp.push({
        proto: c.proto, src: c.src, dst: c.dst, type: c.type, code: c.code,
        bytes: c.payload.length, preview: txt.replace(/[^ -~]/g, '.').slice(0, 120),
        flag: !!MDZ.flagMatch(txt)
      });
    }
    const streams = reassembleTCP(state.tcp);
    const dns = [];
    const http = [];
    for (const u of state.udp) {
      if (u.sport === 53 || u.dport === 53) {
        const d = parseDNS(u.payload);
        if (d) for (const q of d.names) dns.push({ proto: 'UDP', src: u.src, dst: u.dst, name: q.name, type: q.type });
      }
    }
    for (const s of streams) {
      const h = httpInfo(s.payload);
      if (h) { s.http = h; http.push({ src: s.src, dst: s.dst, sport: s.sport, dport: s.dport, ...h }); }
      if (s.sport === 53 || s.dport === 53) {
        const p = s.payload.length > 2 ? s.payload.subarray(2, 2 + be16(s.payload, 0)) : s.payload;
        const d = parseDNS(p);
        if (d) for (const q of d.names) dns.push({ proto: 'TCP', src: s.src, dst: s.dst, name: q.name, type: q.type });
      }
    }

    // TTL 异常
    const ttlAnomalies = [];
    for (const v of state.ttls.values()) {
      if (v.ttls.length < 2) continue;
      const min = Math.min(...v.ttls), max = Math.max(...v.ttls);
      if (max - min >= 8 || min <= 4) {
        ttlAnomalies.push({ flow: `${v.src} -> ${v.dst}`, min, max, count: v.ttls.length, values: Array.from(new Set(v.ttls)).slice(0, 12) });
      }
    }

    // 流/载荷候选
    const candidates = [];
    for (const s of streams) {
      if (!s.payload.length) continue;
      const text = ascii(s.payload, Math.min(s.payload.length, 65536));
      const flag = FLAG_RE.test(text);
      const h = s.http;
      const pr = printableRatio(s.payload.subarray(0, Math.min(s.payload.length, 4096)));
      const score = flag ? 100 : h ? 70 : pr > 0.85 ? 45 : s.payload.length > 32 ? 20 : 0;
      s.flag = flag; s.printable = pr; s.score = score;
      s.preview = ascii(s.payload, 160);
      // HTTP 对象：把 body 从头部里剥出来单独当产物（chunked / multipart 也拆开）
      if (h) {
        for (const obj of httpExtract(s)) {
          candidates.push({ score: 85, bytes: obj.bytes, name: obj.name, note: obj.note });
          findings.push(finding('L3', 'http_object', `HTTP 对象：${obj.name}（${obj.bytes.length} 字节）`, {
            confidence: 0.85, declared: `${h.kind === 'response' ? 'HTTP ' + h.status : h.method + ' ' + h.path}`,
            actual: `${obj.bytes.length} 字节 body`,
            detail: '按 Content-Length / Transfer-Encoding: chunked / multipart 边界切出真正的 body，已作为产物保留（会自动递归分析）。',
            preview: ascii(obj.bytes, 120),
            recipe: 'tshark --export-objects http,out'
          }));
        }
      }
      if (score >= 20) {
        candidates.push({
          score, bytes: s.payload, name: `tcp-${s.src.replace(/[:|]/g, '-')}-${s.sport}-to-${s.dst.replace(/[:|]/g, '-')}-${s.dport}.bin`,
          note: `TCP ${s.src}:${s.sport} → ${s.dst}:${s.dport}`, stream: s
        });
      }
      if (flag) {
        const m = text.match(FLAG_RE);
        findings.push(finding('L3', 'pcap_flag', `TCP 流命中 flag：${m ? m[0] : ''}`, {
          confidence: 0.98,
          declared: `${s.src}:${s.sport} → ${s.dst}:${s.dport}`, actual: `${s.payload.length} 字节`,
          preview: s.preview, recipe: '按四元组重组 TCP 流'
        }));
      } else if (h) {
        findings.push(finding('L3', 'http', `HTTP ${h.kind === 'request' ? h.method + ' ' + h.path : h.status}`, {
          confidence: 0.7, declared: `${s.src}:${s.sport} → ${s.dst}:${s.dport}`,
          detail: h.host ? 'Host: ' + h.host : '', preview: s.preview
        }));
      } else if (pr > 0.85 && s.payload.length >= 32) {
        findings.push(finding('L3', 'tcp_text', 'TCP 流可打印率很高', {
          confidence: 0.55, declared: `${s.src}:${s.sport} → ${s.dst}:${s.dport}`, actual: `${s.payload.length} 字节`,
          preview: s.preview
        }));
      }
    }
    const udpViews = [];
    let udpTextFindings = 0;
    for (const u of state.udp) {
      if (!u.payload.length || u.sport === 53 || u.dport === 53) continue;
      const text = ascii(u.payload, Math.min(u.payload.length, 65536));
      const flag = FLAG_RE.test(text);
      const pr = printableRatio(u.payload.subarray(0, Math.min(u.payload.length, 4096)));
      const view = {
        src: u.src, dst: u.dst, sport: u.sport, dport: u.dport, bytes: u.payload.length,
        flag, printable: pr, preview: ascii(u.payload, 160), artifact: null
      };
      udpViews.push(view);
      if (flag || (pr > 0.85 && u.payload.length >= 8)) {
        const tag = MDZ.fnv1a(u.payload).toString(16).padStart(8, '0');
        const cand = {
          score: flag ? 95 : 35, bytes: u.payload,
          name: `udp-${u.src.replace(/[:|]/g, '-')}-${u.sport}-to-${u.dst.replace(/[:|]/g, '-')}-${u.dport}-${tag}.bin`,
          note: `UDP ${u.src}:${u.sport} → ${u.dst}:${u.dport}`, udp: view
        };
        candidates.push(cand);
        if (flag) {
          const fm = text.match(FLAG_RE);
          findings.push(finding('L3', 'pcap_udp_flag', `UDP 载荷命中 flag：${fm ? fm[0] : ''}`, {
            confidence: 0.95, declared: `${u.src}:${u.sport} → ${u.dst}:${u.dport}`, actual: `${u.payload.length} 字节`,
            preview: ascii(u.payload, 200), recipe: '提取 UDP 载荷'
          }));
        } else if (udpTextFindings++ < 40) {
          findings.push(finding('L3', 'pcap_udp_text', `UDP 可打印载荷：${ascii(u.payload, 32)}`, {
            confidence: 0.5, declared: `${u.src}:${u.sport} → ${u.dst}:${u.dport}`,
            actual: `${u.payload.length} 字节`, preview: ascii(u.payload, 400),
            detail: `可打印率 ${(pr * 100).toFixed(0)}%，已在产物里保留原始字节。`,
            recipe: '提取 UDP 载荷'
          }));
        }
      }
    }
    // ICMP / ICMPv6 载荷：以前整包丢弃，其实它也能当文件/文本信道
    for (const c of state.icmp.slice(0, 2000)) {
      if (!c.payload.length) continue;
      const text = ascii(c.payload, Math.min(c.payload.length, 65536));
      const flag = FLAG_RE.test(text);
      const pr = printableRatio(c.payload.subarray(0, Math.min(c.payload.length, 4096)));
      if (!flag && !(pr > 0.85 && c.payload.length >= 8)) continue;
      const tag = MDZ.fnv1a(c.payload).toString(16).padStart(8, '0');
      candidates.push({
        score: flag ? 95 : 30, bytes: c.payload,
        name: `icmp-${c.src.replace(/[:|]/g, '-')}-to-${c.dst.replace(/[:|]/g, '-')}-t${c.type}-${tag}.bin`,
        note: `${c.proto} ${c.src} → ${c.dst} type ${c.type} code ${c.code}`
      });
    }
    candidates.sort((a, b) => b.score - a.score);
    let total = 0;
    for (const c of candidates) {
      if (artifacts.length >= MAX_ARTIFACTS || total + c.bytes.length > MAX_ARTIFACT_TOTAL) continue;
      total += c.bytes.length;
      artifacts.push(artifact(c.name, c.bytes, c.note, 'pcap'));
      if (c.stream) c.stream.artifact = c.name;
      if (c.udp) c.udp.artifact = c.name;
    }

    if (parsed.trailing && parsed.trailing.length) {
      findings.push(finding('L1', 'pcap_trailer', 'pcap 结束之后还有数据', {
        confidence: 0.9, offset: parsed.size - parsed.trailing.length, actual: `${parsed.trailing.length} 字节`,
        preview: ascii(parsed.trailing, 160), payload: { name: 'pcap-trailer.bin', bytes: parsed.trailing.slice(0) }
      }));
      artifacts.push(artifact('pcap-trailer.bin', parsed.trailing, 'pcap 之后的数据'));
    }
    if (state.unsupported.size) {
      findings.push(finding('L1', 'pcap_link', '存在暂不支持的链路类型', {
        confidence: 0.5, preview: Array.from(state.unsupported.entries()).map(([k, v]) => `linktype ${k} × ${v}`).join('\n')
      }));
    }
    const truncated = parsed.packets.filter(p => p.truncated).length;
    if (truncated) findings.push(finding('L1', 'pcap_truncated', `${truncated} 个包被截断`, { confidence: 0.6 }));
    if (state.warnings.length) {
      findings.push(finding('L1', 'pcap_warnings', 'pcap 解析告警', {
        confidence: 0.6, preview: state.warnings.slice(0, 20).join('\n')
      }));
    }
    if (dns.length) {
      findings.push(finding('L3', 'dns', `DNS 查询 ${dns.length} 条`, {
        confidence: 0.7, preview: dns.slice(0, 30).map(x => `${x.name} (type ${x.type}, ${x.proto})`).join('\n')
      }));
    }
    for (const a of ttlAnomalies.slice(0, 8)) {
      findings.push(finding('L3', 'ttl', `TTL 异常：${a.flow}`, {
        confidence: 0.65, declared: `TTL ${a.values.join('/')}`, actual: `min ${a.min} / max ${a.max}（${a.count} 包）`,
        detail: '同一方向 TTL 跳变通常表示多跳路径、NAT 或手工构造。'
      }));
    }
    const conversations = Array.from(state.conversations.values()).map(c => ({
      ...c, ttlMin: isFinite(c.ttlMin) ? c.ttlMin : null, ttlMax: isFinite(c.ttlMax) ? c.ttlMax : null
    })).sort((a, b) => b.bytes - a.bytes).slice(0, 50);
    const streamView = streams.map(s => ({
      src: s.src, dst: s.dst, sport: s.sport, dport: s.dport, packets: s.packets, bytes: s.bytes,
      gaps: s.gaps, retrans: s.retrans, overlap: s.overlap, flag: !!s.flag,
      printable: s.printable, http: s.http || null, artifact: s.artifact || null,
      ttlMin: s.ttlMin, ttlMax: s.ttlMax, preview: s.preview || ''
    })).sort((a, b) => b.bytes - a.bytes).slice(0, 50);
    const pcap = {
      format: parsed.format, packets: parsed.packets.length, bytes: parsed.bytes || state.bytes,
      linkTypes: parsed.linkTypes, conversations, streams: streamView, udp: udpViews.sort((a, b) => b.bytes - a.bytes).slice(0, 50),
      dns: dns.slice(0, 100), http: http.slice(0, 50), ttlAnomalies, icmp: icmp.slice(0, 100), usb: usb ? { offset: usb.offset, text: usb.text.slice(0, 200) } : null, warnings: state.warnings.slice(0, 30),
      truncated, trailer: parsed.trailing ? parsed.trailing.length : 0
    };
    findings.push(finding('L1', 'pcap_summary', `${parsed.format.toUpperCase()}：${pcap.packets} 包 / ${pcap.bytes} 字节`, {
      confidence: 0.5, detail: `${streamView.length} 条 TCP 流，${dns.length} 条 DNS，${http.length} 条 HTTP，${ttlAnomalies.length} 条 TTL 异常`
    }));
    return { findings, artifacts, image: null, pcap };
  }

  Object.assign(MDZ, { parsePCAP, parseDNS, readDNSName, httpInfo, reassembleTCP, auditPCAP, httpExtract, dechunk });
})(typeof globalThis !== 'undefined' ? globalThis : this);
