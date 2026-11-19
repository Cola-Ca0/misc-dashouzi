/* misc大手子 — 55 归档：TAR / RAR / 7Z
 *   TAR：成员遍历 + 全部成员直接取出（tar 本身不压缩）
 *   RAR：RAR4/RAR5 头解析改名 + 加密检测 + stored 成员取出
 *   7Z ：文件表 + LZMA/LZMA2 成员解压（Delta / x86 BCJ 过滤器），加密/未知过滤器明确报告
 */
(function (root) {
  'use strict';
  const MDZ = root.MDZ = root.MDZ || {};
  const { toU8, ascii, cstr, hex, finding, artifact } = MDZ;

  const le16 = (b, o) => b[o] | (b[o + 1] << 8);
  const le32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
  const u64 = (b, o) => le32(b, o) + le32(b, o + 4) * 4294967296;
  const be32 = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;

  // ---------- TAR ----------
  function tarChecksumOk(h) {
    const want = tarNum(h.subarray(148, 156));
    if (want === null) return false;
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += (i >= 148 && i < 156) ? 32 : h[i];
    return sum === want;
  }

  // tar 的数字字段：八进制（前后空格/NUL），或 GNU base-256
  function tarNum(buf) {
    if (buf[0] & 0x80) {
      let v = buf[0] & 0x7f;
      for (let i = 1; i < buf.length; i++) v = v * 256 + buf[i];
      return v;
    }
    let s = '';
    for (let i = 0; i < buf.length; i++) {
      const c = buf[i];
      if (c === 0 || c === 32) { if (s) break; continue; }
      if (c < 48 || c > 55) return null;
      s += String.fromCharCode(c);
    }
    return s ? parseInt(s, 8) : 0;
  }

  function isTAR(input) {
    const b = toU8(input);
    if (b.length < 512) return false;
    if (ascii(b.subarray(257, 262), 5) === 'ustar') return true;
    // 旧 tar 没有 ustar：用头校验和兜底
    return tarChecksumOk(b.subarray(0, 512));
  }

  function auditTAR(input, name) {
    const b = toU8(input);
    const findings = [], artifacts = [];
    const entries = [];
    let off = 0, guard = 0, longName = null, totalOut = 0;
    while (off + 512 <= b.length && guard++ < 4096) {
      const h = b.subarray(off, off + 512);
      let zero = true;
      for (let i = 0; i < 512; i++) if (h[i]) { zero = false; break; }
      if (zero) { off += 512; continue; }
      if (!tarChecksumOk(h)) {
        findings.push(finding('L1', 'tar', 'TAR 头校验和不符，停止解析', {
          confidence: 0.8, offset: off,
          detail: '可能不是 TAR，或中间被截断/拼接。后面的数据仍会走通用扫描。'
        }));
        break;
      }
      const nameB = h.subarray(0, 100);
      const size = tarNum(h.subarray(124, 136)) || 0;
      const type = h[156] ? String.fromCharCode(h[156]) : '0';
      const magic = ascii(h.subarray(257, 262), 5);
      const prefix = magic === 'ustar' ? cstr(h.subarray(345, 500)) : '';
      const localName = cstr(nameB) || ascii(nameB, nameB.length);
      const fullName = (prefix ? prefix.replace(/\/$/, '') + '/' : '') + localName;
      const ds = off + 512;
      const dl = Math.max(0, Math.min(size, b.length - ds));
      if (type === 'L') {
        longName = cstr(b.subarray(ds, ds + dl));
      } else if (type === 'x') {
        const m = /(?:^|\n)\d+ path=([^\n]+)/.exec(ascii(b.subarray(ds, ds + dl), dl));
        if (m) longName = m[1];
      } else if (type === '5') {
        entries.push({ name: fullName + '/', size: 0, type: 'dir' });
      } else if (type === '2') {
        entries.push({ name: fullName, size: 0, type: 'symlink', link: cstr(h.subarray(157, 257)) });
      } else if (type === '0' || type === '7' || type === '\u0000') {
        const nm = longName || fullName;
        longName = null;
        entries.push({ name: nm, size, type: 'file' });
        if (dl > 0 && totalOut + dl <= 32 * 1024 * 1024) {
          artifacts.push(artifact('tar-' + (nm.split('/').pop() || 'entry'), b.subarray(ds, ds + dl), 'TAR 成员'));
          totalOut += dl;
        }
      }
      off = ds + Math.ceil(size / 512) * 512;
    }
    if (!entries.length) {
      findings.push(finding('L1', 'tar', 'TAR 里没有解析出成员', { confidence: 0.5, detail: '可能是空包或头已损坏。' }));
    } else {
      const dirs = entries.filter(e => e.type === 'dir').length;
      findings.push(finding('L1', 'tar', `TAR：${entries.length} 个成员`, {
        confidence: 0.9, offset: 0,
        declared: `${entries.length - dirs} 个文件 / ${dirs} 个目录`,
        actual: entries.slice(0, 10).map(e => e.name).join(' | '),
        detail: 'TAR 不压缩，成员已经作为产物取出；嵌套容器会继续递归分析。',
        preview: entries.map(e => `${e.name}${e.size ? ' (' + e.size + 'B)' : ''}`).join('\n'),
        recipe: 'tar -tvf <file>'
      }));
    }
    return { findings, artifacts, image: null, parsed: { entries } };
  }

  // ---------- RAR ----------
  function isRAR(input) {
    const b = toU8(input);
    if (b.length < 7) return false;
    return b[0] === 0x52 && b[1] === 0x61 && b[2] === 0x72 && b[3] === 0x21 && b[4] === 0x1A && b[5] === 0x07;
  }

  const rar4Method = m => (m === 0x30 ? 'stored' : 'rar');

  function auditRAR4(b, findings, artifacts) {
    let off = 7, guard = 0;
    const entries = [];
    let totalOut = 0;
    while (off + 7 <= b.length && guard++ < 4096) {
      const type = b[off + 2];
      const flags = le16(b, off + 3);
      const headSize = le16(b, off + 5);
      if (headSize < 7 || off + headSize > b.length) break;
      if (type === 0x74) {                      // 文件头
        const p = off + 7;
        if (p + 25 > b.length) break;
        const packSize = le32(b, p);
        const unpSize = le32(b, p + 4);
        const method = b[p + 18];
        const nameLen = le16(b, p + 19);
        const nameStart = p + 25;
        if (nameStart + nameLen > b.length) break;
        let nameB = b.subarray(nameStart, nameStart + nameLen);
        // 0x200 = unicode：名字里有压缩编码，先按 latin1 兜底
        const name = cstr(nameB) || ascii(nameB, nameB.length);
        const encrypted = !!(flags & 0x01);
        const isDir = !!(flags & 0x08);
        let dataStart = off + headSize;
        let realPack = packSize;
        if (flags & 0x100) {                    // 大文件：HIGH_PACK_SIZE 在名字之后
          const hp = nameStart + nameLen;
          if (hp + 8 <= b.length) {
            realPack = le32(b, hp) * 4294967296 + packSize;
            dataStart = off + headSize + 4;      // 头部多两对 4 字节
            dataStart = off + headSize;
          }
        }
        entries.push({ name, size: unpSize, packSize: realPack, method: rar4Method(method), encrypted, dir: isDir });
        if (!encrypted && !isDir && method === 0x30 && realPack > 0 && dataStart + realPack <= b.length && totalOut + realPack <= 32 * 1024 * 1024) {
          artifacts.push(artifact('rar-' + (name.split('/').pop() || 'entry'), b.subarray(dataStart, dataStart + realPack), 'RAR stored 成员'));
          totalOut += realPack;
        }
        off = off + headSize + realPack;
        continue;
      }
      if (type === 0x7B) break;                 // 结束块
      let add = 0;
      if (flags & 0x8000) { if (off + 11 > b.length) break; add = le32(b, off + 7); }
      off += headSize + add;
    }
    return entries;
  }

  // RAR5 的 vint（7 位一组，最高位继续）
  function rar5Vint(b, p) {
    let v = 0, shift = 0, n = 0;
    while (p + n < b.length && n < 10) {
      const c = b[p + n++];
      v += (c & 0x7F) * Math.pow(2, shift);
      shift += 7;
      if (!(c & 0x80)) return { value: v, size: n };
    }
    return null;
  }

  function auditRAR5(b, findings, artifacts) {
    const entries = [];
    let off = 8, guard = 0;
    let encryptedHeader = false;
    while (off + 6 <= b.length && guard++ < 4096) {
      const headSize = rar5Vint(b, off + 4);
      if (!headSize) break;
      const bodyStart = off + 4 + headSize.size;
      const bodyEnd = bodyStart + headSize.value;
      if (bodyEnd > b.length) break;
      let q = bodyStart;
      const type = rar5Vint(b, q); if (!type) break; q += type.size;
      const flags = rar5Vint(b, q); if (!flags) break; q += flags.size;
      let extraSize = 0, dataSize = 0;
      if (flags.value & 0x0001) { const x = rar5Vint(b, q); if (!x) break; extraSize = x.value; q += x.size; }
      if (flags.value & 0x0002) { const x = rar5Vint(b, q); if (!x) break; dataSize = x.value; q += x.size; }
      if (type.value === 4) encryptedHeader = true;       // 加密头块
      if (type.value === 2) {                              // 文件头
        const fflags = rar5Vint(b, q); if (!fflags) break; q += fflags.size;
        const unp = rar5Vint(b, q); if (!unp) break; q += unp.size;
        const attr = rar5Vint(b, q); if (!attr) break; q += attr.size;
        if (fflags.value & 0x0002) q += 4;                 // mtime
        if (fflags.value & 0x0004) q += 4;                 // crc32
        const comp = rar5Vint(b, q); if (!comp) break; q += comp.size;
        const host = rar5Vint(b, q); if (!host) break; q += host.size;
        const nameLen = rar5Vint(b, q); if (!nameLen) break; q += nameLen.size;
        if (q + nameLen.value > b.length) break;
        const nameB = b.subarray(q, q + nameLen.value);
        const name = MDZ.utf8(nameB) || ascii(nameB, nameB.length);
        const method = comp.value & 0x3F;
        entries.push({ name, size: unp.value, packSize: dataSize, method: method === 0 ? 'stored' : 'rar5', encrypted: encryptedHeader, dir: !!(fflags.value & 0x0001) });
        if (method === 0 && dataSize > 0 && bodyEnd + dataSize <= b.length && name) {
          artifacts.push(artifact('rar-' + (name.split('/').pop() || 'entry'), b.subarray(bodyEnd, bodyEnd + dataSize), 'RAR5 stored 成员'));
        }
      }
      off = bodyEnd + dataSize;
    }
    return { entries, encryptedHeader };
  }

  function auditRAR(input, name) {
    const b = toU8(input);
    const findings = [], artifacts = [];
    const isV5 = b.length >= 8 && b[6] === 0x01 && b[7] === 0x00;
    let entries = [], encryptedHeader = false;
    try {
      if (isV5) { const r = auditRAR5(b, findings, artifacts); entries = r.entries; encryptedHeader = r.encryptedHeader; }
      else entries = auditRAR4(b, findings, artifacts);
    } catch (e) {
      findings.push(finding('L1', 'rar', 'RAR 头解析中断', { confidence: 0.6, detail: String(e && e.message || e) }));
    }
    if (!entries.length) {
      findings.push(finding('L1', 'rar', 'RAR 容器（未解析出成员）', {
        confidence: 0.6,
        detail: (isV5 ? 'RAR5' : 'RAR4') + ' 头解析没有拿到文件表；可能用了加密头或非标准分卷。可以试 unrar l。',
        recipe: 'unrar l <file.rar>'
      }));
    } else {
      const enc = entries.filter(e => e.encrypted).length;
      findings.push(finding('L1', 'rar', `RAR${isV5 ? '5' : ''}：${entries.length} 个成员${enc ? '（' + enc + ' 个加密）' : ''}`, {
        confidence: 0.9, offset: 0,
        declared: entries.map(e => e.name).slice(0, 8).join(' | '),
        actual: encryptedHeader ? '加密头（连文件名都看不到）' : '文件表可读',
        detail: 'RAR 的压缩算法不实现；stored（不压缩）成员会直接取出来。加密包可试 john/hashcat 或 ARCHPR。',
        preview: entries.map(e => `${e.name}  ${e.size}B  ${e.method}${e.encrypted ? '  [enc]' : ''}`).join('\n'),
        recipe: 'unrar x <file.rar>'
      }));
    }
    return { findings, artifacts, image: null, parsed: { entries, v5: isV5 } };
  }

  // ---------- 7Z ----------
  function is7Z(input) {
    const b = toU8(input);
    return b.length >= 6 && b[0] === 0x37 && b[1] === 0x7A && b[2] === 0xBC && b[3] === 0xAF && b[4] === 0x27 && b[5] === 0x1C;
  }

  function sevenVint(b, p) {
    let v = 0, shift = 0, n = 0;
    while (p + n < b.length && n < 9) {
      const c = b[p + n++];
      v += (c & 0x7F) * Math.pow(2, shift);
      shift += 7;
      if (!(c & 0x80)) return { value: v, size: n };
    }
    return null;
  }

  function sevenU64(b, p) { return le32(b, p) + le32(b, p + 4) * 4294967296; }

  // 只认未压缩的 kHeader：kFilesInfo 里取文件名（UTF-16LE）
  function parse7zNames(hdr, start) {
    const names = [];
    let p = start;
    if (hdr[p] !== 0x01) return null;                 // kHeader
    p++;
    let guard = 0;
    while (p < hdr.length && guard++ < 64) {
      const id = hdr[p++];
      if (id === 0x00) break;                          // kEnd
      if (id === 0x02) {                               // kArchiveProperties
        while (p < hdr.length) {
          const t = hdr[p++];
          if (t === 0x00) break;
          const sz = sevenVint(hdr, p); if (!sz) return names;
          p += sz.size + sz.value;
        }
      } else if (id === 0x04 || id === 0x03) {         // kMainStreamsInfo / kAdditionalStreamsInfo
        const sz = sevenVint(hdr, p); if (!sz) break;
        p += sz.size + sz.value;
      } else if (id === 0x05) {                         // kFilesInfo
        const num = sevenVint(hdr, p); if (!num) break;
        p += num.size;
        let guard2 = 0;
        while (p < hdr.length && guard2++ < 64) {
          const prop = hdr[p++];
          if (prop === 0x00) break;
          const sz = sevenVint(hdr, p); if (!sz) return names;
          p += sz.size;
          const bodyStart = p;
          if (prop === 0x11) {                          // kName
            const external = hdr[bodyStart];
            if (!external) {
              // sz.value 是文件里声明的长度，头部被改坏时能到 2^63：
              // 不夹到 hdr.length 的话，内层循环对着越界字节转上几十亿次，直接卡死。
              let q = bodyStart + 1;
              const end = Math.min(bodyStart + sz.value, hdr.length);
              while (q + 1 < end) {
                let s = '';
                while (q + 1 < end) {
                  const ch = hdr[q] | (hdr[q + 1] << 8);
                  q += 2;
                  if (!ch) break;
                  s += String.fromCharCode(ch);
                }
                if (s) names.push(s);
              }
            }
          }
          p = Math.min(bodyStart + sz.value, hdr.length);
        }
      } else {
        const sz = sevenVint(hdr, p);
        if (!sz) break;
        p += sz.size + sz.value;
      }
    }
    return names;
  }

  // 7z 的 ReadNumber：首字节高位是「后续还有几字节」的掩码，不是普通 varint
  function sevenNum(b, p) {
    if (p >= b.length) return null;
    const first = b[p++];
    let mask = 0x80, value = 0;
    for (let i = 0; i < 8; i++) {
      if (!(first & mask)) {
        value += (first & (mask - 1)) * Math.pow(2, 8 * i);
        return { value, next: p };
      }
      if (p >= b.length) return null;
      value += b[p++] * Math.pow(2, 8 * i);
      mask >>= 1;
    }
    return null;
  }

  function sevenReadBits(b, p, n) {
    const bytes = Math.ceil(n / 8);
    if (p + bytes > b.length) return null;
    const bits = [];
    for (let i = 0; i < n; i++) bits.push(!!(b[p + (i >> 3)] & (0x80 >> (i & 7))));
    return { bits, next: p + bytes };
  }

  function sevenBitVector(b, p, n) {
    // FilesInfo 里的布尔向量是纯位流，没有 Digests 那种 allAreDefined 字节
    const v = sevenReadBits(b, p, n);
    if (!v) return null;
    return { bits: v.bits, next: v.next };
  }

  function sevenDigests(b, p, n) {
    if (p >= b.length) return null;
    const all = b[p++];
    let defined;
    if (all) defined = new Array(n).fill(true);
    else {
      const d = sevenReadBits(b, p, n);
      if (!d) return null;
      defined = d.bits; p = d.next;
    }
    for (let i = 0; i < n; i++) if (defined[i]) { if (p + 4 > b.length) return null; p += 4; }
    return { next: p };
  }

  function sevenFolder(b, p) {
    const numCoders = b[p++];
    if (!numCoders || numCoders > 32) return null;
    const coders = [];
    let totalIn = 0, totalOut = 0, inBase = 0, outBase = 0;
    for (let i = 0; i < numCoders; i++) {
      if (p >= b.length) return null;
      const flags = b[p++];
      const idSize = flags & 0x0F;
      if (!idSize || p + idSize > b.length) return null;
      const id = b.subarray(p, p + idSize); p += idSize;
      let numIn = 1, numOut = 1;
      if (flags & 0x10) {
        const a = sevenNum(b, p); if (!a) return null;
        const c = sevenNum(b, a.next); if (!c) return null;
        numIn = a.value; numOut = c.value; p = c.next;
      }
      let props = null;
      if (flags & 0x20) {
        const n = sevenNum(b, p); if (!n) return null;
        p = n.next;
        if (p + n.value > b.length) return null;
        props = b.subarray(p, p + n.value); p += n.value;
      }
      coders.push({ id, props, numIn, numOut, inBase, outIndex: outBase });
      totalIn += numIn; totalOut += numOut; inBase += numIn; outBase += numOut;
    }
    const bind = [];
    for (let i = 0; i < totalOut - 1; i++) {
      const a = sevenNum(b, p); if (!a) return null;
      const c = sevenNum(b, a.next); if (!c) return null;
      bind.push({ inIndex: a.value, outIndex: c.value }); p = c.next;
    }
    const numPacked = totalIn - bind.length;
    const packed = [];
    if (numPacked === 1) packed.push(0);
    else {
      for (let i = 0; i < numPacked; i++) {
        const n = sevenNum(b, p); if (!n) return null;
        packed.push(n.value); p = n.next;
      }
    }
    const used = new Set(bind.map(x => x.outIndex));
    let finalOut = 0;
    for (let i = 0; i < totalOut; i++) if (!used.has(i)) { finalOut = i; break; }
    return { folder: { coders, bind, packed, totalIn, totalOut, finalOut, unpackSizes: [] }, next: p };
  }

  function sevenMethod(id) {
    if (id.length === 1) {
      if (id[0] === 0x21) return 'lzma2';
      if (id[0] === 0x03) return 'delta';
      if (id[0] === 0x00) return 'copy';
    }
    if (id.length === 3 && id[0] === 0x03 && id[1] === 0x01 && id[2] === 0x01) return 'lzma1';
    if (id.length === 4 && id[0] === 0x03 && id[1] === 0x03 && id[2] === 0x01 && id[3] === 0x03) return 'bcj';
    if (id.length === 4 && id[0] === 0x06 && id[1] === 0xF1 && id[2] === 0x07 && id[3] === 0x01) return 'aes';
    return 'other';
  }

  function sevenMethodName(id) {
    const m = sevenMethod(id);
    if (m !== 'other') return m;
    return Array.from(id, x => x.toString(16).padStart(2, '0')).join('');
  }

  // StreamsInfo：PackInfo / UnpackInfo / SubStreamsInfo
  function sevenStreams(b, p) {
    const s = { packPos: 0, packSizes: [], folders: [], counts: [], sizes: [] };
    let id = p < b.length ? b[p++] : 0;
    if (id === 0x06) {
      const pp = sevenNum(b, p); if (!pp) return null;
      s.packPos = pp.value; p = pp.next;
      const np = sevenNum(b, p); if (!np) return null;
      const nPack = np.value; p = np.next;
      if (nPack > 65536) return null;
      while (p < b.length) {
        const t = b[p++];
        if (t === 0) break;
        if (t === 0x09) {
          for (let i = 0; i < nPack; i++) {
            const z = sevenNum(b, p); if (!z) return null;
            s.packSizes.push(z.value); p = z.next;
          }
        } else if (t === 0x0A) {
          const d = sevenDigests(b, p, nPack); if (!d) return null;
          p = d.next;
        } else return null;
      }
      id = p < b.length ? b[p++] : 0;
    }
    if (id === 0x07) {
      if (b[p++] !== 0x0B) return null;
      const nf = sevenNum(b, p); if (!nf) return null;
      p = nf.next;
      if (b[p++] !== 0) return null;   // external folder 不支持
      if (nf.value > 4096) return null;
      for (let i = 0; i < nf.value; i++) {
        const f = sevenFolder(b, p); if (!f) return null;
        s.folders.push(f.folder); p = f.next;
      }
      if (b[p++] !== 0x0C) return null;
      for (const f of s.folders) {
        for (let i = 0; i < f.totalOut; i++) {
          const z = sevenNum(b, p); if (!z) return null;
          f.unpackSizes.push(z.value); p = z.next;
        }
      }
      while (p < b.length) {
        const t = b[p++];
        if (t === 0) break;
        if (t === 0x0A) {
          const total = s.folders.reduce((a, f) => a + f.totalOut, 0);
          const d = sevenDigests(b, p, total); if (!d) return null;
          p = d.next;
        } else return null;
      }
      id = p < b.length ? b[p++] : 0;
    }
    if (id === 0x08) {
      s.counts = s.folders.map(() => 1);
      while (p < b.length) {
        const t = b[p++];
        if (t === 0) break;
        if (t === 0x0D) {
          for (let i = 0; i < s.folders.length; i++) {
            const z = sevenNum(b, p); if (!z) return null;
            s.counts[i] = z.value; p = z.next;
          }
        } else if (t === 0x09) {
          s.sizes = s.folders.map(() => []);
          for (let i = 0; i < s.folders.length; i++) {
            const c = s.counts[i] || 1;
            for (let k = 0; k < c - 1; k++) {
              const z = sevenNum(b, p); if (!z) return null;
              s.sizes[i].push(z.value); p = z.next;
            }
          }
        } else if (t === 0x0A) {
          const total = s.counts.reduce((a, c) => a + c, 0);
          const d = sevenDigests(b, p, total); if (!d) return null;
          p = d.next;
        } else return null;
      }
      id = p < b.length ? b[p++] : 0;
    }
    if (id !== 0) return null;
    if (!s.counts.length) s.counts = s.folders.map(() => 1);
    if (!s.sizes.length) s.sizes = s.folders.map(() => []);
    for (let i = 0; i < s.folders.length; i++) {
      const f = s.folders[i];
      const c = Math.max(1, s.counts[i] || 1);
      const arr = s.sizes[i] || (s.sizes[i] = []);
      const final = f.unpackSizes[f.finalOut] || 0;
      const known = arr.reduce((a, x) => a + x, 0);
      while (arr.length < c) arr.push(arr.length === c - 1 ? Math.max(0, final - known) : 0);
    }
    return { streams: s, next: p };
  }

  function sevenDecodeFolder(packed, folder, cap) {
    const lz = folder.coders.find(c => sevenMethod(c.id) === 'lzma2' || sevenMethod(c.id) === 'lzma1');
    if (!lz) return { error: '7Z 压缩方法暂不支持（' + folder.coders.map(c => sevenMethodName(c.id)).join(' + ') + '）' };
    const outSize = folder.unpackSizes[lz.outIndex] || 0;
    let data;
    if (sevenMethod(lz.id) === 'lzma2') {
      const z = MDZ.lzma2Decompress ? MDZ.lzma2Decompress(packed, 0, Math.max(cap, outSize)) : null;
      if (!z || z.error || !z.out) return { error: (z && z.error) || 'LZMA2 解压失败' };
      data = z.out;
    } else {
      if (!lz.props || lz.props.length < 5) return { error: 'LZMA 属性缺失' };
      const synth = new Uint8Array(13 + packed.length);
      synth.set(lz.props.subarray(0, 5));
      let n = outSize;
      for (let i = 0; i < 8; i++) { synth[5 + i] = n % 256; n = Math.floor(n / 256); }
      synth.set(packed, 13);
      const z = MDZ.lzmaDecompressAlone ? MDZ.lzmaDecompressAlone(synth, { maxOut: Math.max(cap, outSize) }) : null;
      if (!z || z.error || !z.out) return { error: (z && z.error) || 'LZMA 解压失败' };
      data = z.out;
    }
    // 过滤器（Delta / BCJ）都在压缩器之前，解码时按反序作用在 LZMA 输出上
    const filters = folder.coders.filter(c => c !== lz && sevenMethod(c.id) !== 'copy');
    for (let i = filters.length - 1; i >= 0; i--) {
      const f = filters[i];
      const m = sevenMethod(f.id);
      if (m === 'bcj' && MDZ.bcjX86Decode) MDZ.bcjX86Decode(data);
      else if (m === 'delta') {
        const d = (f.props && f.props.length ? f.props[0] : 0) + 1;
        for (let k = d; k < data.length; k++) data[k] = (data[k] + data[k - d]) & 255;
      } else {
        return { error: '7Z 过滤器暂不支持（' + sevenMethodName(f.id) + '）' };
      }
    }
    const final = folder.unpackSizes[folder.finalOut] || data.length;
    if (data.length > final) data = data.subarray(0, final);
    return { out: data };
  }

  function sevenDecodeStreams(b, packedBase, streams, cap) {
    let packIdx = 0, cursor = packedBase + streams.packPos, totalOut = 0;
    const outputs = [];
    for (const f of streams.folders) {
      const parts = [];
      for (let i = 0; i < f.packed.length; i++) {
        const n = streams.packSizes[packIdx++] || 0;
        if (cursor + n > b.length) return { error: '7Z 打包数据越界' };
        parts.push(b.subarray(cursor, cursor + n)); cursor += n;
      }
      let packed;
      if (parts.length === 1) packed = parts[0];
      else {
        const len = parts.reduce((a, x) => a + x.length, 0);
        packed = new Uint8Array(len);
        let off = 0;
        for (const x of parts) { packed.set(x, off); off += x.length; }
      }
      const r = sevenDecodeFolder(packed, f, cap);
      if (r.error) return r;
      totalOut += r.out.length;
      if (totalOut > cap) return { error: '7Z 解压超过上限' };
      outputs.push(r.out);
    }
    return { outputs };
  }

  function sevenFiles(b, p) {
    const n = sevenNum(b, p); if (!n) return null;
    p = n.next;
    const num = n.value;
    if (num > 65536) return null;
    const files = [];
    for (let i = 0; i < num; i++) files.push({ name: '', empty: false, dir: false });
    while (p < b.length) {
      const id = b[p++];
      if (id === 0) break;
      const sz = sevenNum(b, p); if (!sz) return null;
      p = sz.next;
      const bodyStart = p, bodyEnd = Math.min(p + sz.value, b.length);
      if (id === 0x0E) {
        const v = sevenBitVector(b, bodyStart, num); if (!v) return null;
        for (let i = 0; i < num; i++) files[i].empty = v.bits[i];
      } else if (id === 0x0F) {
        const empties = files.filter(f => f.empty);
        const v = sevenBitVector(b, bodyStart, empties.length); if (!v) return null;
        for (let i = 0; i < empties.length; i++) empties[i].dir = !v.bits[i];
      } else if (id === 0x11) {
        if (b[bodyStart] !== 0) return null;
        let q = bodyStart + 1, fi = 0;
        while (q + 1 < bodyEnd && fi < num) {
          let s = '';
          while (q + 1 < bodyEnd) {
            const ch = b[q] | (b[q + 1] << 8); q += 2;
            if (!ch) break;
            s += String.fromCharCode(ch);
          }
          files[fi++].name = s;
        }
      }
      p = bodyEnd;
    }
    return { files, next: p };
  }

  function sevenHeader(b, nextOff, nextSize, cap) {
    const start = 32 + nextOff;
    if (start + nextSize > b.length) return null;
    let hdr = b.subarray(start, start + nextSize);
    let encoded = false;
    if (hdr[0] === 0x17) {
      encoded = true;
      const st = sevenStreams(hdr, 1);
      if (!st) return null;
      const dec = sevenDecodeStreams(b, 32, st.streams, 64 * 1024 * 1024);
      if (dec.error || !dec.outputs.length) return null;
      hdr = dec.outputs[0];
    }
    if (hdr[0] !== 0x01) return null;
    let p = 1, streams = null, files = null;
    while (p < hdr.length) {
      const id = hdr[p++];
      if (id === 0) break;
      if (id === 0x02) {
        while (p < hdr.length) {
          const t = hdr[p++];
          if (t === 0) break;
          const n = sevenNum(hdr, p); if (!n) return null;
          p = n.next + n.value;
        }
      } else if (id === 0x04) {
        const st = sevenStreams(hdr, p); if (!st) return null;
        streams = st.streams; p = st.next;
      } else if (id === 0x05) {
        const fi = sevenFiles(hdr, p); if (!fi) return null;
        files = fi.files; p = fi.next;
      } else {
        const n = sevenNum(hdr, p); if (!n) return null;
        p = n.next + n.value;
      }
    }
    return { hdr, streams, files, encoded };
  }

  function audit7Z(input, name) {
    const b = toU8(input);
    const findings = [], artifacts = [];
    if (b.length < 32) return { findings: [finding('L0', 'format', '不是 7Z', { detail: '头太短' })], artifacts, image: null };
    const nextOff = sevenU64(b, 12);
    const nextSize = sevenU64(b, 20);
    const CAP = 64 * 1024 * 1024;
    const head = sevenHeader(b, nextOff, nextSize, CAP);
    if (!head) {
      const names = (() => {
        const start = 32 + nextOff;
        if (start + nextSize > b.length || nextSize > CAP) return null;
        const hdr = b.subarray(start, start + nextSize);
        return hdr[0] === 0x17 ? null : parse7zNames(hdr, 0);
      })();
      const encoded = 32 + nextOff < b.length && b[32 + nextOff] === 0x17;
      findings.push(finding('L1', '7z', encoded ? '7Z 容器（头部被压缩，解析失败）' : '7Z 容器（文件表解析失败）', {
        confidence: 0.6, offset: 0,
        declared: `${b.length} 字节`,
        actual: encoded ? 'kEncodedHeader' : '未知布局',
        detail: '7z 头/压缩流结构超出当前解析范围；可以先确认容器身份与是否加密。',
        preview: names && names.length ? names.join('\n') : undefined,
        recipe: '7z l <file.7z>'
      }));
      return { findings, artifacts, image: null, parsed: { names, encoded } };
    }
    const files = head.files || [];
    const encrypted = head.streams && head.streams.folders.some(f => f.coders.some(c => sevenMethod(c.id) === 'aes'));
    let decoded = null;
    if (head.streams && !encrypted) {
      decoded = sevenDecodeStreams(b, 32, head.streams, CAP);
    }
    const entries = [];
    if (decoded && decoded.outputs) {
      const flat = [];
      for (let i = 0; i < decoded.outputs.length; i++) {
        const out = decoded.outputs[i];
        const c = head.streams.counts[i] || 1;
        const sizes = head.streams.sizes[i] || [];
        let off = 0;
        for (let k = 0; k < c; k++) {
          const sz = sizes[k] || 0;
          flat.push(out.subarray(off, Math.min(off + sz, out.length)));
          off += sz;
        }
      }
      let idx = 0;
      for (const f of files) {
        if (f.empty || f.dir) continue;
        const bytes = flat[idx++];
        if (!bytes) break;
        entries.push({ name: f.name || `file${idx}`, bytes });
      }
      if (!files.length) {
        for (let i = 0; i < flat.length; i++) entries.push({ name: `file${i}`, bytes: flat[i] });
      }
    }
    const totalBytes = entries.reduce((a, e) => a + e.bytes.length, 0);
    if (entries.length) {
      findings.push(finding('L1', '7z', `7Z：${entries.length} 个文件，已解压 ${entries.length} 个（${totalBytes} 字节）`, {
        confidence: 0.95, offset: 0,
        declared: `${files.length} 个文件`,
        actual: entries.map(e => `${e.name} (${e.bytes.length}B)`).join(' | ').slice(0, 500),
        detail: '支持 LZMA2 / LZMA + Delta / x86 BCJ；成员已作为产物切出，内容会继续进入递归分析。',
        preview: entries.map(e => `${e.name}  ${e.bytes.length} 字节`).join('\n'),
        recipe: '7z l -slt <file.7z>'
      }));
      let n = 0;
      const seenFlags = new Set();
      for (const e of entries) {
        if (n++ >= 64) break;
        const safe = String(e.name).split(/[\\/]/).pop().replace(/[^\w.\-]+/g, '_').slice(0, 80) || `file${n}`;
        artifacts.push(artifact(safe, e.bytes, `7Z 成员：${e.name}`));
        const text = MDZ.strings(e.bytes, 6).join('\n');
        for (const fl of MDZ.flagFindAll(text)) {
          if (seenFlags.has(fl)) continue;
          seenFlags.add(fl);
          findings.push(finding('L3', '7z_flag', `7Z 成员 ${e.name} 里出现 ${fl}`, { confidence: 0.99, actual: fl }));
        }
      }
    } else {
      findings.push(finding('L1', '7z', encrypted ? '7Z 容器（已加密）' : '7Z 容器（未能解出成员）', {
        confidence: 0.75, offset: 0,
        declared: files.length ? `${files.length} 个文件` : '未知',
        actual: encrypted ? 'AES 加密，无法离线解压' : (decoded && decoded.error) || '未解出文件内容',
        preview: files.length ? files.map(f => f.name).join('\n') : undefined,
        detail: '文件表已解析但内容解压失败；常见原因是加密或使用了未支持的过滤器。',
        recipe: '7z x -p<password> <file.7z>'
      }));
    }
    return { findings, artifacts, image: null, parsed: { names: files.map(f => f.name), encoded: head.encoded, entries: entries.map(e => e.name) } };
  }

  // ---------- bzip2 ----------
  function auditBzip2(input, name) {
    const b = toU8(input);
    const z = MDZ.inflateBzip2(b, 0, 64 * 1024 * 1024);
    const findings = [], artifacts = [];
    if (!z.out || !z.out.length) {
      findings.push(finding('L0', 'bzip2', 'bzip2 解压失败', {
        confidence: 0.9, detail: z.error || '没有产出'
      }));
      return { findings, artifacts, image: null, parsed: z };
    }
    const out = z.out;
    findings.push(finding('L1', 'bzip2', `bzip2 解压（${z.blocks} 块，${out.length} 字节）`, {
      confidence: 0.85,
      declared: `块大小 ${b[3] - 48}00k`,
      actual: `${out.length} 字节`,
      detail: (z.crcOk ? '块 CRC 校验通过。' : '块 CRC 不匹配：数据可能被改过。')
        + (z.error ? ' 解码在中途停止：' + z.error : ''),
      preview: ascii(out, 120)
    }));
    artifacts.push(artifact('bzip2-out.bin', out, 'bzip2 解压产物' + (z.error ? ' · 部分' : '')));
    return { findings, artifacts, image: null, parsed: z };
  }

  // ---------- ISO9660 ----------
  // 主卷描述符在扇区 16；目录记录里 ext attr 之后的 extent 就是文件数据。
  // Joliet 用 supplementary volume descriptor 的 UTF-16BE 文件名。
  function isoRecord(b, off, end) {
    if (off + 33 > end || off + 33 > b.length) return null;
    const len = b[off];
    if (len < 34 || off + len > end || off + len > b.length) return null;
    const nameLen = b[off + 32];
    if (33 + nameLen > len) return null;
    const lbaLE = le32(b, off + 2), lbaBE = be32(b, off + 6);
    const sizeLE = le32(b, off + 10), sizeBE = be32(b, off + 14);
    return {
      len,
      lba: lbaLE + b[off + 1],
      size: sizeLE,
      beMismatch: lbaLE !== lbaBE || sizeLE !== sizeBE,
      flags: b[off + 25],
      nameBytes: b.subarray(off + 33, off + 33 + nameLen)
    };
  }

  function isoName(rec, joliet) {
    const n = rec.nameBytes;
    if (n.length === 1 && n[0] === 0) return '.';
    if (n.length === 1 && n[0] === 1) return '..';
    let s;
    if (joliet) {
      s = '';
      for (let i = 0; i + 1 < n.length; i += 2) s += String.fromCharCode((n[i] << 8) | n[i + 1]);
    } else {
      s = ascii(n, n.length);
    }
    return s.replace(/;1$/, '').replace(/\.$/, '');
  }

  function isoWalk(b, blockSize, lba, size, prefix, out, depth, seen, joliet, state) {
    if (depth > 12 || out.length >= 2000) { state.truncated = true; return; }
    const key = lba + ':' + size;
    if (seen.has(key)) return;
    seen.add(key);
    const start = lba * blockSize;
    const end = Math.min(start + size, b.length);
    let p = start;
    while (p + 33 <= end && out.length < 2000) {
      const len = b[p];
      if (len === 0) { p = (Math.floor(p / blockSize) + 1) * blockSize; continue; }
      if (len < 34 || p + len > end) { state.broken = true; break; }
      const rec = isoRecord(b, p, end);
      if (!rec) { state.broken = true; break; }
      if (rec.beMismatch) state.beMismatch = (state.beMismatch || 0) + 1;
      const nm = isoName(rec, joliet);
      if (nm && nm !== '.' && nm !== '..') {
        const path = prefix ? prefix + '/' + nm : nm;
        if (rec.flags & 0x02) isoWalk(b, blockSize, rec.lba, rec.size, path, out, depth + 1, seen, joliet, state);
        else out.push({ path, lba: rec.lba, size: rec.size });
      }
      p += len;
    }
  }

  function auditISO(input, name) {
    const b = toU8(input);
    const findings = [], artifacts = [];
    if (b.length < 17 * 2048) return { findings: [finding('L0', 'format', 'ISO 不足 17 个扇区')], artifacts, image: null };
    let pvd = -1, svd = -1;
    for (let sec = 16; sec < 48 && sec * 2048 + 7 <= b.length; sec++) {
      const off = sec * 2048;
      if (ascii(b.subarray(off + 1, off + 6), 5) !== 'CD001') continue;
      if (b[off] === 1 && pvd < 0) pvd = off;
      else if (b[off] === 2 && svd < 0) svd = off;
      else if (b[off] === 255) break;
    }
    if (pvd < 0) return { findings: [finding('L0', 'format', '找不到 ISO 主卷描述符')], artifacts, image: null };
    const blockSize = le16(b, pvd + 128) || 2048;
    const volBlocks = le32(b, pvd + 80);
    const volId = ascii(b.subarray(pvd + 40, pvd + 72), 32).replace(/\s+$/, '');
    const sysId = ascii(b.subarray(pvd + 8, pvd + 40), 32).replace(/\s+$/, '');
    const joliet = svd >= 0 && ascii(b.subarray(svd + 88, svd + 90), 2) === '%/';
    const rootOff = (joliet ? svd : pvd) + 156;
    const root = isoRecord(b, rootOff, rootOff + 4096);
    if (!root) return { findings: [finding('L0', 'format', 'ISO 根目录记录无效')], artifacts, image: null };
    const files = [];
    const walkState = { truncated: false, broken: false, beMismatch: root.beMismatch ? 1 : 0 };
    isoWalk(b, blockSize, root.lba, root.size, '', files, 0, new Set(), joliet, walkState);
    findings.push(finding('L1', 'iso', `ISO9660 · ${volId || '(无卷标)'} · ${blockSize} 字节/块 · ${volBlocks} 块 · ${files.length} 个文件`, {
      confidence: 0.95, offset: 16 * 2048,
      declared: `卷空间 ${volBlocks} 块（${volBlocks * blockSize} 字节）`,
      actual: `文件 ${files.length} 个${joliet ? '，Joliet UTF-16 文件名' : ''}`,
      detail: `System ID: ${sysId || '(空)'}；主卷描述符 @ 0x${hex(pvd)}${svd >= 0 ? '，补充卷 @ 0x' + hex(svd) : ''}`,
      recipe: '7z l image.iso / isoinfo -l -i image.iso'
    }));
    if (walkState.beMismatch) {
      findings.push(finding('L1', 'iso_be', `${walkState.beMismatch} 条目录记录的 LE/BE 副本不一致`, {
        confidence: 0.85, actual: '两个本应相同的字段被改成不同值',
        detail: 'ISO 的 extent/size 字段大小端各存一份；不一致通常意味着有人手工改过，按 LE 读到的位置可能不是真数据。'
      }));
    }
    if (walkState.truncated || walkState.broken) {
      findings.push(finding('L1', 'iso_limit', '目录树没有完整列完', {
        confidence: 0.6,
        actual: `${walkState.truncated ? '达到深度/数量上限' : ''}${walkState.broken ? '目录记录越界' : ''}`,
        detail: `已列出 ${files.length} 个文件；剩余部分可用 7z / isoinfo 继续看。`
      }));
    }
    if (files.length) {
      findings.push(finding('L2', 'iso_files', `ISO 文件列表（${files.length} 个）`, {
        confidence: 0.7,
        actual: files.slice(0, 6).map(f => `${f.path} (${f.size})`).join(' | '),
        preview: files.slice(0, 40).map(f => `${f.path}  ${f.size} 字节  LBA ${f.lba}`).join('\n'),
        detail: '文件数据按目录记录里的 LBA 直接切出，小文件已作为产物导出。'
      }));
    }
    const seenFlags = new Set();
    const addFlag = (f, where) => {
      if (!f || seenFlags.has(f)) return;
      seenFlags.add(f);
      findings.push(finding('L3', 'iso_flag', `${where}出现 ${f}`, { confidence: 0.99, actual: f }));
    };
    for (const f of MDZ.flagFindAll(volId + '\n' + sysId + '\n' + files.map(x => x.path).join('\n'))) addFlag(f, '卷标/文件名');
    let exported = 0;
    for (const rec of files) {
      if (exported >= 40 || rec.size > 8 * 1024 * 1024) continue;
      const off = rec.lba * blockSize;
      if (off + rec.size > b.length) continue;
      const data = b.subarray(off, off + rec.size);
      const safe = rec.path.replace(/[^\w.\-\/]+/g, '_').replace(/\//g, '_').slice(0, 80);
      artifacts.push(artifact('iso-' + (safe || 'file'), data, `ISO 文件 ${rec.path}（${rec.size} 字节）`));
      exported++;
      const text = MDZ.utf8(data) || ascii(data.subarray(0, Math.min(data.length, 65536)), Math.min(data.length, 65536));
      for (const f of MDZ.flagFindAll(text)) addFlag(f, `文件 ${rec.path} `);
    }
    if (files.length > exported) {
      findings.push(finding('L3', 'iso_limit', `只导出了 ${exported}/${files.length} 个文件`, {
        confidence: 0.5, detail: '其余文件超过 8MB 或数量上限；可用 7z/bsdtar 按目录记录手工取。'
      }));
    }
    if (volBlocks && volBlocks * blockSize < b.length) {
      const tr = b.subarray(volBlocks * blockSize);
      findings.push(finding('L1', 'iso_trailer', `卷空间之后还有 ${tr.length} 字节`, {
        confidence: tr.some(x => x !== 0) ? 0.95 : 0.6,
        offset: volBlocks * blockSize,
        preview: ascii(tr.subarray(0, 120), Math.min(120, tr.length)),
        detail: 'ISO 之外的附加区，常见于多会话盘或直接夹带。'
      }));
      artifacts.push(artifact('iso-trailer.bin', tr, 'ISO 卷空间之后的尾部数据'));
    }
    return { findings, artifacts, image: null, parsed: { volId, blockSize, volBlocks, joliet, files } };
  }

  // ---------- MP4 / MOV ----------
  // box 树：size + type；size=1 时用 64 位 largesize，size=0 表示到文件尾。
  // 只解元数据与 free/skip/mdat 结构，不解码音视频。
  const MP4_CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'udta', 'meta', 'edts', 'dinf', 'mvex', 'moof', 'traf', 'mfra']);
  const MP4_NAMES = { '©nam': 'title', '©cmt': 'comment', '©too': 'encoder', '©day': 'date', '©ART': 'artist', '©alb': 'album', '©gen': 'genre', desc: 'description', '----': 'custom' };

  function mp4Type(b, off) {
    return b[off] === 0xA9 ? '©' + ascii(b.subarray(off + 1, off + 4), 3) : ascii(b.subarray(off, off + 4), 4);
  }

  function auditMP4(input, name) {
    const b = toU8(input);
    const findings = [], artifacts = [];
    if (b.length < 12) return { findings: [finding('L0', 'format', 'MP4 太短')], artifacts, image: null };
    const boxes = [], meta = [], flags = [];
    let mdatBytes = 0, tailAt = -1, truncated = false;
    const addFlag = (f, where) => {
      if (!f || flags.some(x => x.flag === f)) return;
      flags.push({ flag: f, where });
    };
    const addFlags = (text, where) => { for (const f of MDZ.flagFindAll(text)) addFlag(f, where); };
    function walk(start, end, depth, path) {
      if (depth > 16 || boxes.length >= 5000) { truncated = true; return; }
      let p = start;
      let lastEnd = start;
      while (p + 8 <= end) {
        if (boxes.length >= 5000) { truncated = true; break; }
        let size = be32(b, p);
        const type = mp4Type(b, p + 4);
        let header = 8;
        if (size === 1) {
          if (p + 16 > end) break;
          size = be32(b, p + 8) * 4294967296 + be32(b, p + 12);
          header = 16;
        } else if (size === 0) {
          size = end - p;
        }
        if (size < header || p + size > end) {
          findings.push(finding('L1', 'mp4_box', `box ${type} 越界（声明 ${size} 字节）`, {
            confidence: 0.8, offset: p, declared: `${size} 字节`, actual: `只剩 ${end - p} 字节`
          }));
          break;
        }
        const body = p + header, bodyEnd = p + size;
        boxes.push({ type, off: p, size, path });
        if (type === 'ftyp') {
          const major = ascii(b.subarray(body, Math.min(body + 4, bodyEnd)), 4);
          findings.push(finding('L1', 'mp4_ftyp', `MP4 ftyp · 主品牌 ${major}`, {
            confidence: 0.9, offset: p,
            actual: ascii(b.subarray(body, Math.min(body + 24, bodyEnd)), Math.min(24, bodyEnd - body)).replace(/\x00/g, ' ')
          }));
        } else if (type === 'mvhd' && body + 20 <= bodyEnd) {
          const ver = b[body];
          let ts = 0, dur = 0;
          if (ver === 1 && body + 32 <= bodyEnd) {
            ts = be32(b, body + 20);
            dur = be32(b, body + 24) * 4294967296 + be32(b, body + 28);
          } else if (ver === 0) {
            ts = be32(b, body + 12); dur = be32(b, body + 16);
          }
          if (ts) {
            findings.push(finding('L3', 'mp4_mvhd', `时长 ${(dur / ts).toFixed(2)} 秒`, {
              confidence: 0.6, offset: p, actual: `version ${ver} · timescale ${ts} · duration ${dur}`
            }));
          }
        } else if (type === 'mdat') {
          mdatBytes += bodyEnd - body;
        } else if (type === 'free' || type === 'skip') {
          let nz = 0;
          for (let i = body; i < bodyEnd; i++) if (b[i]) nz++;
          if (nz) {
            findings.push(finding('L1', 'mp4_free', `${type} box 里有 ${nz} 个非零字节`, {
              confidence: 0.9, offset: body,
              declared: `${bodyEnd - body} 字节（应为空）`,
              actual: `${nz} 字节非零`,
              detail: 'free/skip 是播放器会跳过的填充区，出题人常直接写数据进去。',
              preview: ascii(b.subarray(body, Math.min(bodyEnd, body + 200)), Math.min(200, bodyEnd - body)),
              recipe: `从 0x${hex(body)} 起切 ${bodyEnd - body} 字节`
            }));
            artifacts.push(artifact(`mp4-${type}.bin`, b.subarray(body, bodyEnd), `MP4 ${type} box 数据`));
            addFlags(ascii(b.subarray(body, Math.min(bodyEnd, body + 65536)), Math.min(65536, bodyEnd - body)), 'free/skip');
          }
        } else if (type === 'ilst') {
          let ip = body;
          while (ip + 8 <= bodyEnd) {
            const isize = be32(b, ip);
            const itype = mp4Type(b, ip + 4);
            if (isize < 8 || ip + isize > bodyEnd) break;
            let dp = ip + 8;
            while (dp + 8 <= ip + isize) {
              const dsize = be32(b, dp);
              const dtype = ascii(b.subarray(dp + 4, dp + 8), 4);
              if (dsize < 8 || dp + dsize > ip + isize) break;
              if (dtype === 'data' && dsize >= 16) {
                const dataType = be32(b, dp + 8);
                const payload = b.subarray(dp + 16, dp + dsize);
                let text;
                if (dataType === 2) text = MDZ.utf16be(payload);
                else text = MDZ.utf8(payload) || ascii(payload, Math.min(payload.length, 4096));
                if (text) {
                  meta.push({ key: itype, label: MP4_NAMES[itype] || itype, text });
                  addFlags(text, `元数据 ${MP4_NAMES[itype] || itype}`);
                }
              }
              dp += dsize;
            }
            ip += isize;
          }
        }
        if (MP4_CONTAINERS.has(type)) {
          walk(body + (type === 'meta' ? 4 : 0), bodyEnd, depth + 1, path.concat(type));
        }
        lastEnd = bodyEnd;
        p = bodyEnd;
      }
      if (depth === 0) tailAt = lastEnd;
    }
    walk(0, b.length, 0, []);
    if (truncated) {
      findings.push(finding('L1', 'mp4_limit', 'box 树超过扫描上限（5000 个 / 16 层），后面的 box 未列出', {
        confidence: 0.7, actual: `已列出 ${boxes.length} 个`
      }));
    }
    if (mdatBytes) {
      findings.push(finding('L2', 'mp4_mdat', `mdat 媒体数据 ${mdatBytes} 字节（未解码）`, {
        confidence: 0.4, actual: '音视频本体；本工具只查元数据与填充区',
        recipe: 'ffmpeg -i file.mp4 / mp4box -info file.mp4'
      }));
    }
    if (meta.length) {
      findings.push(finding('L3', 'mp4_meta', `元数据 ${meta.length} 条`, {
        confidence: 0.8,
        actual: meta.slice(0, 6).map(m => `${m.label}=${m.text.slice(0, 60)}`).join(' | '),
        preview: meta.slice(0, 24).map(m => `${m.label}: ${m.text.slice(0, 300)}`).join('\n'),
        recipe: 'ffprobe -show_format -show_streams file.mp4 / exiftool file.mp4'
      }));
    }
    for (const f of flags.slice(0, 10)) {
      findings.push(finding('L3', 'mp4_flag', `${f.where}出现 ${f.flag}`, { confidence: 0.99, actual: f.flag }));
    }
    if (tailAt >= 0 && tailAt < b.length) {
      const tr = b.subarray(tailAt);
      findings.push(finding('L1', 'mp4_trailer', `最后一个 box 之后还有 ${tr.length} 字节`, {
        confidence: tr.some(x => x !== 0) ? 0.95 : 0.6,
        offset: tailAt,
        preview: ascii(tr.subarray(0, 120), Math.min(120, tr.length)),
        detail: '播放器读完最后一个 box 就停，尾部是天然夹带区。'
      }));
      artifacts.push(artifact('mp4-trailer.bin', tr, 'MP4 尾部附加数据'));
      addFlags(ascii(tr.subarray(0, 65536), Math.min(65536, tr.length)), '尾部');
    }
    findings.push(finding('L1', 'mp4', `MP4 · ${boxes.length} 个 box`, {
      confidence: 0.8, offset: 0,
      actual: boxes.slice(0, 12).map(x => x.type + '(' + x.size + ')').join(' '),
      detail: `顶层/嵌套 box 共 ${boxes.length} 个；元数据 ${meta.length} 条；mdat ${mdatBytes} 字节。`
    }));
    return { findings, artifacts, image: null, parsed: { boxes, meta, mdatBytes, tailAt } };
  }

  function auditXZ(input, name) {
    const b = toU8(input);
    const findings = [], artifacts = [];
    const z = MDZ.xzDecompress(b, { maxOut: 128 * 1024 * 1024 });
    const out = z.out || new Uint8Array(0);
    if (z.error && !out.length) {
      findings.push(finding('L0', 'xz', 'XZ 解压失败', {
        confidence: 0.9, detail: z.error || '没有产出'
      }));
      return { findings, artifacts, image: null, parsed: z };
    }
    const checkName = { 0: '无', 1: 'CRC32', 4: 'CRC64', 10: 'SHA-256' }[z.checkType] || ('#' + z.checkType);
    const warnings = z.warnings || [];
    findings.push(finding('L1', 'xz', `XZ 解压（${z.blocks} 块，${out.length} 字节）`, {
      confidence: z.error ? 0.7 : 0.85,
      declared: `check ${checkName}`,
      actual: `${out.length} 字节${z.error ? ' · 部分' : ''}`,
      detail: z.error ? z.error : (warnings.length ? warnings.join('；')
        : (z.verifiedChecks ? `${checkName} 块校验通过` : '流未设置块校验')),
      preview: ascii(out, 120)
    }));
    if (out.length) artifacts.push(artifact('xz-out.bin', out, 'XZ 解压产物' + (z.error ? ' · 部分' : '')));
    if (z.tail && z.tail.length) {
      findings.push(finding('L2', 'xz_tail', `XZ 流之后还有 ${z.tail.length} 字节`, {
        confidence: 0.85, offset: b.length - z.tail.length,
        preview: ascii(z.tail, 120),
        detail: '合法 XZ 流在 footer 结束后就应结束，后面的数据不会被解压；CTF 常把 flag 挂在这里。'
      }));
      artifacts.push(artifact('xz-tail.bin', z.tail, 'XZ 尾部附加数据'));
    }
    return { findings, artifacts, image: null, parsed: z };
  }

  Object.assign(MDZ, { isTAR, auditTAR, isRAR, auditRAR, is7Z, audit7Z, auditBzip2, auditXZ, auditISO, auditMP4, tarNum, tarChecksumOk });
})(typeof globalThis !== 'undefined' ? globalThis : this);
