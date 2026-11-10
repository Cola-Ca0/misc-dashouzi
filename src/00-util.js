/* misc大手子 — 00 基础工具
 * 目标：零依赖、可在浏览器与 Node 中共用。
 */
(function (root) {
  'use strict';
  const MDZ = root.MDZ = root.MDZ || {};

  const VERSION = '1.0.0';

  // ---------- 字节 ----------
  function toU8(x) {
    if (x instanceof Uint8Array) return x;
    if (x instanceof ArrayBuffer) return new Uint8Array(x);
    if (ArrayBuffer.isView(x)) return new Uint8Array(x.buffer, x.byteOffset, x.byteLength);
    if (Array.isArray(x)) return Uint8Array.from(x);
    throw new TypeError('not bytes');
  }

  function hex(n, width) {
    if (width === undefined) width = 2;
    return Number(n).toString(16).padStart(width, '0');
  }

  function hex32(n) { return hex(n >>> 0, 8); }

  function bytesToHex(bytes, max) {
    const b = toU8(bytes);
    const n = Math.min(b.length, max === undefined ? b.length : max);
    let s = '';
    for (let i = 0; i < n; i++) s += hex(b[i]);
    return s;
  }

  // 逐字节 `s += String.fromCharCode(c)` 在 50MB 输入上会建出 5000 万个 cons 节点
  // （实测 2319ms / 堆 +1.6GB，且这块内存在 GC 后仍然挂在结果串上）。
  // 统一改成「先落成字节，再一次性解码」：同一份输入 11ms、堆 +0。
  const LATIN1 = new TextDecoder('latin1');
  const UTF16_LE = new TextDecoder('utf-16le');
  const ASCII_MAP = (() => {
    const m = new Uint8Array(256);
    for (let c = 0; c < 256; c++) m[c] = (c >= 32 && c < 127) || c === 10 || c === 13 || c === 9 ? c : 46;   // 其余落成 '.'
    return m;
  })();

  function ascii(bytes, max) {
    const b = toU8(bytes);
    const n = Math.min(b.length, max === undefined ? 256 : max);
    if (!n) return '';
    const tmp = new Uint8Array(n);
    for (let i = 0; i < n; i++) tmp[i] = ASCII_MAP[b[i]];
    return LATIN1.decode(tmp);
  }

  // UTF-8 严格解码；失败返回 null
  function utf8(bytes) {
    try { return new TextDecoder('utf-8', { fatal: true }).decode(toU8(bytes)); }
    catch (e) { return null; }
  }

  // 只用在元数据（EXIF/ID3）上，长度都很小；这里保留逐字符写法，
  // 因为 TextDecoder 会把孤立代理项替换成 U+FFFD，语义会变。
  function utf16le(bytes) {
    const b = toU8(bytes);
    let s = '';
    for (let i = 0; i + 1 < b.length; i += 2) {
      const c = b[i] | (b[i + 1] << 8);
      if (c === 0) break;
      s += String.fromCharCode(c);
    }
    return s;
  }

  function cstr(bytes, start) {
    const b = toU8(bytes);
    let end = start === undefined ? 0 : start;
    while (end < b.length && b[end] !== 0) end++;
    return utf8(b.subarray(start || 0, end)) || ascii(b.subarray(start || 0, end), end - (start || 0));
  }

  // ---------- 统计 ----------
  function entropy(bytes) {
    const b = toU8(bytes);
    if (!b.length) return 0;
    const freq = new Uint32Array(256);
    for (let i = 0; i < b.length; i++) freq[b[i]]++;
    let h = 0;
    for (let i = 0; i < 256; i++) {
      if (!freq[i]) continue;
      const p = freq[i] / b.length;
      h -= p * Math.log2(p);
    }
    return h;
  }

  function printableRatio(bytes) {
    const b = toU8(bytes);
    if (!b.length) return 0;
    let ok = 0;
    for (let i = 0; i < b.length; i++) {
      const c = b[i];
      if ((c >= 32 && c < 127) || c === 9 || c === 10 || c === 13) ok++;
    }
    return ok / b.length;
  }

  // 连续可打印串
  function strings(bytes, minLen) {
    const b = toU8(bytes);
    const n = minLen || 4;
    const out = [];
    let i = 0;
    while (i < b.length) {
      if (b[i] < 32 || b[i] > 126) { i++; continue; }
      const st = i;
      while (i < b.length && b[i] >= 32 && b[i] <= 126) i++;
      if (i - st >= n) out.push(LATIN1.decode(b.subarray(st, i)));
    }
    return out;
  }

  function utf16strings(bytes, minLen) {
    const b = toU8(bytes);
    const n = minLen || 4;
    const out = [];
    let i = 0;
    while (i + 1 < b.length) {
      if (b[i] < 32 || b[i] > 126 || b[i + 1] !== 0) { i += 2; continue; }
      const st = i;
      while (i + 1 < b.length && b[i] >= 32 && b[i] <= 126 && b[i + 1] === 0) i += 2;
      if ((i - st) / 2 >= n) out.push(UTF16_LE.decode(b.subarray(st, i)));
    }
    return out;
  }

  // ---------- 哈希 ----------
  function fnv1a(bytes) {
    const b = toU8(bytes);
    let h = 0x811c9dc5;
    for (let i = 0; i < b.length; i++) {
      h ^= b[i];
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h;
  }

  // 同步 SHA-256（大文件也可接受；用于去重与报告）
  const SHA_K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
  ]);

  function sha256(bytes) {
    const b = toU8(bytes);
    const bitLen = b.length * 8;
    const withPad = new Uint8Array(((b.length + 8) >> 6 << 6) + 64);
    withPad.set(b);
    withPad[b.length] = 0x80;
    const dv = new DataView(withPad.buffer);
    dv.setUint32(withPad.length - 8, Math.floor(bitLen / 0x100000000));
    dv.setUint32(withPad.length - 4, bitLen >>> 0);

    let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a,
        h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;
    const w = new Uint32Array(64);

    for (let off = 0; off < withPad.length; off += 64) {
      for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4);
      for (let i = 16; i < 64; i++) {
        const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
        const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
        w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
      }
      let a = h0, bb = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
      for (let i = 0; i < 64; i++) {
        const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
        const ch = (e & f) ^ (~e & g);
        const t1 = (h + S1 + ch + SHA_K[i] + w[i]) >>> 0;
        const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
        const maj = (a & bb) ^ (a & c) ^ (bb & c);
        const t2 = (S0 + maj) >>> 0;
        h = g; g = f; f = e; e = (d + t1) >>> 0;
        d = c; c = bb; bb = a; a = (t1 + t2) >>> 0;
      }
      h0 = (h0 + a) >>> 0; h1 = (h1 + bb) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0;
      h4 = (h4 + e) >>> 0; h5 = (h5 + f) >>> 0; h6 = (h6 + g) >>> 0; h7 = (h7 + h) >>> 0;
    }
    return [h0, h1, h2, h3, h4, h5, h6, h7].map(x => hex32(x)).join('');
  }

  function rotr(x, n) { return (x >>> n) | (x << (32 - n)); }

  // ---------- 文件身份 ----------
  const MAGICS = [
    { name: 'PNG', mime: 'image/png', sig: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
    { name: 'JPEG', mime: 'image/jpeg', sig: [0xff, 0xd8, 0xff] },
    { name: 'GIF', mime: 'image/gif', sig: [0x47, 0x49, 0x46, 0x38] },
    { name: 'BMP', mime: 'image/bmp', sig: [0x42, 0x4d] },
    { name: 'ICO', mime: 'image/x-icon', sig: [0x00, 0x00, 0x01, 0x00] },
    { name: 'TIFF', mime: 'image/tiff', sig: [0x49, 0x49, 0x2a, 0x00] },
    { name: 'TIFF', mime: 'image/tiff', sig: [0x4d, 0x4d, 0x00, 0x2a] },
    { name: 'WAV', mime: 'audio/wav', sig: [0x52, 0x49, 0x46, 0x46], tail: 'WAVE' },
    { name: 'WEBP', mime: 'image/webp', sig: [0x52, 0x49, 0x46, 0x46], tail: 'WEBP' },
    { name: 'MP3', mime: 'audio/mpeg', sig: [0x49, 0x44, 0x33] },
    { name: 'PCAP', mime: 'application/vnd.tcpdump.pcap', sig: [0xd4, 0xc3, 0xb2, 0xa1] },
    { name: 'PCAP', mime: 'application/vnd.tcpdump.pcap', sig: [0xa1, 0xb2, 0xc3, 0xd4] },
    { name: 'PCAP', mime: 'application/vnd.tcpdump.pcap', sig: [0x4d, 0x3c, 0xb2, 0xa1] },
    { name: 'PCAP', mime: 'application/vnd.tcpdump.pcap', sig: [0xa1, 0xb2, 0x3c, 0x4d] },
    { name: 'PCAPNG', mime: 'application/vnd.tcpdump.pcap', sig: [0x0a, 0x0d, 0x0d, 0x0a] },
    { name: 'ZIP', mime: 'application/zip', sig: [0x50, 0x4b, 0x03, 0x04] },
    { name: 'ZIP', mime: 'application/zip', sig: [0x50, 0x4b, 0x05, 0x06] },
    { name: 'RAR', mime: 'application/vnd.rar', sig: [0x52, 0x61, 0x72, 0x21] },
    { name: '7Z', mime: 'application/x-7z-compressed', sig: [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c] },
    { name: 'GZIP', mime: 'application/gzip', sig: [0x1f, 0x8b] },
    { name: 'PDF', mime: 'application/pdf', sig: [0x25, 0x50, 0x44, 0x46] },
    { name: 'BPG', mime: 'image/bpg', sig: [0x42, 0x50, 0x47, 0xfb] },
    { name: 'TTF', mime: 'font/ttf', sig: [0x00, 0x01, 0x00, 0x00] },
    { name: 'TTF', mime: 'font/ttf', sig: [0x74, 0x72, 0x75, 0x65] },
    { name: 'OTF', mime: 'font/otf', sig: [0x4f, 0x54, 0x54, 0x4f] },
    { name: 'WOFF', mime: 'font/woff', sig: [0x77, 0x4f, 0x46, 0x46] },
    { name: 'WOFF2', mime: 'font/woff2', sig: [0x77, 0x4f, 0x46, 0x32] },
    { name: 'SQLITE', mime: 'application/vnd.sqlite3', sig: [0x53, 0x51, 0x4c, 0x69, 0x74, 0x65, 0x20, 0x66, 0x6f, 0x72, 0x6d, 0x61, 0x74, 0x20, 0x33, 0x00] },
    { name: 'ELF', mime: 'application/x-elf', sig: [0x7f, 0x45, 0x4c, 0x46] },
    { name: 'PE', mime: 'application/vnd.microsoft.portable-executable', sig: [0x4d, 0x5a] },
    { name: 'XZ', mime: 'application/x-xz', sig: [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00] }
  ];

  function startsWith(bytes, sig) {
    if (bytes.length < sig.length) return false;
    for (let i = 0; i < sig.length; i++) if (bytes[i] !== sig[i]) return false;
    return true;
  }

  // 这段字节像不像文本：ASCII 快判，不是再按 UTF-8 严格解一次
  // （纯 ASCII 判据会把中文/emoji 挡在外面：UTF-8 续字节落 0x80-0x9F，正好在 \x7E 与   之间）
  function looksLikeText(b, n) {
    let asciiOnly = true;
    for (let i = 0; i < n; i++) {
      const c = b[i];
      if (c === 9 || c === 10 || c === 13) continue;
      if (c < 0x20 || c > 0x7e) { asciiOnly = false; break; }
    }
    if (asciiOnly) return n > 8;
    if (typeof TextDecoder === 'undefined') return false;
    for (let cut = 0; cut <= 3 && n - cut > 8; cut++) {
      try {
        const dec = new TextDecoder('utf-8', { fatal: true }).decode(b.subarray(0, n - cut));
        let bad = 0;
        for (const ch of dec) {
          const cp = ch.codePointAt(0);
          if (cp < 0x20 && cp !== 9 && cp !== 10 && cp !== 13) bad++;
        }
        if (bad === 0 && dec.length > 8) return true;
        return false;
      } catch (e) { /* 截断在多字节字符中间，少切一个再试 */ }
    }
    return false;
  }

  function detectType(input, name) {
    const b = toU8(input);
    let format = 'unknown', mime = 'application/octet-stream', label = '未知';
    for (const m of MAGICS) {
      if (!startsWith(b, m.sig)) continue;
      if (m.tail) {
        const at = 8;
        let ok = true;
        for (let i = 0; i < m.tail.length; i++) if (b[at + i] !== m.tail.charCodeAt(i)) { ok = false; break; }
        if (!ok) continue;
      }
      format = m.name; mime = m.mime; label = m.name;
      break;
    }
    // TAR 的 'ustar' 在 257 偏移，MAGICS 的 startsWith 表达不了
    if (format === 'unknown' && b.length >= 512 && ascii(b.subarray(257, 262), 5) === 'ustar') {
      format = 'TAR'; mime = 'application/x-tar'; label = 'TAR';
    }
    // MP3 帧同步（无 ID3 头）
    if (format === 'unknown' && b.length >= 2 && b[0] === 0xff && (b[1] & 0xe0) === 0xe0) {
      format = 'MP3'; mime = 'audio/mpeg'; label = 'MP3';
    }
    // 文本型 SVG / XML（允许 XML 声明、注释、DOCTYPE 在 <svg> 之前）
    if (format === 'unknown' && b.length) {
      let s = '';
      const n = Math.min(b.length, 4096);
      for (let i = 0; i < n; i++) s += String.fromCharCode(b[i]);
      let t = s.replace(/^\uFEFF/, '').trimStart();
      for (let k = 0; k < 6; k++) {
        const before = t;
        t = t.replace(/^<\?[\s\S]*?\?>\s*/, '')
             .replace(/^<!--[\s\S]*?-->\s*/, '')
             .replace(/^<!DOCTYPE[^>]*>\s*/i, '');
        if (t === before) break;
      }
      if (/^<svg[\s>]/i.test(t)) { format = 'SVG'; mime = 'image/svg+xml'; label = 'SVG'; }
      else if (looksLikeText(b, n)) {
        format = 'TEXT'; mime = 'text/plain'; label = '文本';
      }
    }
    const ext = (name || '').split('.').pop().toLowerCase();
    const extMap = {
      png: 'PNG', jpg: 'JPEG', jpeg: 'JPEG', gif: 'GIF', bmp: 'BMP', ico: 'ICO',
      tif: 'TIFF', tiff: 'TIFF', webp: 'WEBP', svg: 'SVG', zip: 'ZIP', rar: 'RAR',
      '7z': '7Z', gz: 'GZIP', pdf: 'PDF', txt: 'TEXT', bpg: 'BPG',
      wav: 'WAV', mp3: 'MP3', pcap: 'PCAP', pcapng: 'PCAPNG', cap: 'PCAP',
      tar: 'TAR', rar: 'RAR', '7z': '7Z'
    };
    const byExt = extMap[ext];
    return {
      format, mime, label,
      ext, byExt,
      extMismatch: !!byExt && byExt !== format,
      lossless: format === 'PNG' || format === 'BMP' || format === 'ICO' || format === 'GIF'
    };
  }

  // ---------- 文件头被削 / 多出字节：猜格式并给出修复后的字节 ----------
  function _le32(b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0; }
  function _be32(b, o) { return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0; }

  // 结构自检：true = 明确像，false = 明确不像，null = 单看魔数判断不了
  function headerLooksRight(format, b) {
    switch (format) {
      case 'PNG':
        return ascii(b.subarray(12, 16), 4) === 'IHDR' ? true : (b.length > 16 ? false : null);
      case 'GIF':
        return /^GIF8[79]a/.test(ascii(b, 6)) ? true : false;
      case 'BMP': {
        if (b.length < 54) return null;
        const size = _le32(b, 2), off = _le32(b, 10), dib = _le32(b, 14);
        if (dib !== 12 && dib !== 40 && dib !== 52 && dib !== 56 && dib !== 108 && dib !== 124) return false;
        if (off < 14 || off > b.length) return false;
        if (size && Math.abs(size - b.length) > Math.max(4096, b.length * 0.02)) return false;
        return true;
      }
      case 'JPEG': {
        if (b[0] !== 0xff || b[1] !== 0xd8) return false;
        const lim = Math.min(b.length - 1, 200000);
        for (let i = 2; i < lim; i++) {
          if (b[i] !== 0xff) continue;
          const m = b[i + 1];
          if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return true;
        }
        return null;
      }
      case 'ZIP': {
        if (b.length < 30) return null;
        const method = b[8] | (b[9] << 8);
        const nlen = b[26] | (b[27] << 8);
        return method <= 100 && nlen > 0 && nlen < 1024 ? true : false;
      }
      case 'PDF':
        return ascii(b, 5) === '%PDF-' ? true : false;
      case 'ELF':
        return (b[4] === 1 || b[4] === 2) && (b[5] === 1 || b[5] === 2) ? true : false;
      case 'SQLITE': {
        if (b.length < 20) return null;
        const ps = (b[16] << 8) | b[17];
        return ps >= 512 && (ps & (ps - 1)) === 0 ? true : false;
      }
      case 'ICO': {
        if (b.length < 6) return null;
        const count = b[4] | (b[5] << 8);
        return count > 0 && count <= 256 ? true : false;
      }
      case 'TIFF':
        return (b[0] === 0x49 && b[1] === 0x49 && b[2] === 0x2A && b[3] === 0x00) ||
          (b[0] === 0x4D && b[1] === 0x4D && b[2] === 0x00 && b[3] === 0x2A) ? true : false;
      case 'RAR':
        return b[0] === 0x52 && b[1] === 0x61 && b[2] === 0x72 && b[3] === 0x21 ? true : false;
      case 'WAV':
        return ascii(b.subarray(8, 12), 4) === 'WAVE' ? true : false;
      case 'WEBP':
        return ascii(b.subarray(8, 12), 4) === 'WEBP' ? true : false;
      default:
        return null;   // 6 字节以上的魔数本身就够硬
    }
  }

  // 返回按可信度排序的候选：{ format, mime, mode:'prepend'|'strip', missing|extra, fixed, score, matched, total }
  function detectDamagedHeader(input, opts) {
    const b = toU8(input);
    const o = opts || {};
    const out = [];
    if (!b.length) return out;
    const seen = new Set();

    function add(format, mime, mode, extra, fixed, matched, total) {
      const key = mode + ':' + format + ':' + extra.length;
      if (seen.has(key)) return;
      const structural = headerLooksRight(format, fixed);
      if (structural === false) return;
      let score;
      if (structural === true) score = 0.96;
      else if (matched >= 5) score = 0.85;
      else if (matched >= 3) score = 0.7;
      else return;                       // 短匹配又没有结构证据：不要
      seen.add(key);
      out.push({ format, mime, mode, extra, fixed, matched, total, score });
    }

    for (const m of MAGICS) {
      const L = m.sig.length;
      if (L < 4) continue;
      const maxK = Math.min(3, L - 3);
      for (let k = 1; k <= maxK; k++) {          // 开头少了 k 字节
        const need = L - k;
        if (b.length < need) continue;
        let ok = true;
        for (let i = 0; i < need; i++) if (b[i] !== m.sig[i + k]) { ok = false; break; }
        if (!ok) continue;
        const fixed = new Uint8Array(b.length + k);
        fixed.set(m.sig.slice(0, k), 0);
        fixed.set(b, k);
        const t = detectType(fixed, '');
        if (t.format === 'unknown') continue;
        add(t.format, t.mime, 'prepend', m.sig.slice(0, k), fixed, need, L);
      }
      for (let k = 1; k <= 3; k++) {             // 开头多了 k 字节
        if (b.length < k + L) continue;
        let ok = true;
        for (let i = 0; i < L; i++) if (b[k + i] !== m.sig[i]) { ok = false; break; }
        if (!ok) continue;
        const fixed = new Uint8Array(b.subarray(k));
        const t = detectType(fixed, '');
        if (t.format === 'unknown') continue;
        add(t.format, t.mime, 'strip', b.subarray(0, k), fixed, L, L);
      }
    }
    // 3 字节 / 2 字节魔数单独处理：JPEG 与 BMP
    if (b.length > 16 && b[0] === 0xd8 && b[1] === 0xff) {
      const fixed = new Uint8Array(b.length + 1);
      fixed[0] = 0xff; fixed.set(b, 1);
      add('JPEG', 'image/jpeg', 'prepend', [0xff], fixed, 2, 3);
    }
    if (b.length > 64 && b[0] === 0x4d) {
      const fixed = new Uint8Array(b.length + 1);
      fixed[0] = 0x42; fixed.set(b, 1);
      add('BMP', 'image/bmp', 'prepend', [0x42], fixed, 1, 2);
    }
    // 魔数里恰好一个字节被改错：把那个字节改回去就能认
    for (const m of MAGICS) {
      const L = m.sig.length;
      if (L < 4 || b.length < L) continue;
      let bad = -1, nbad = 0;
      for (let i = 0; i < L; i++) {
        if (b[i] !== m.sig[i]) { bad = i; if (++nbad > 1) break; }
      }
      if (nbad !== 1) continue;
      if (bad === 0 && L < 6) continue;    // 首字节错 + 魔数短：证据太弱
      const fixed = new Uint8Array(b);
      fixed[bad] = m.sig[bad];
      const t = detectType(fixed, '');
      if (t.format === 'unknown') continue;
      // 短魔数只错一个字节太容易撞（零填充、随机数据），必须有结构证据
      if (L < 6 && headerLooksRight(t.format, fixed) !== true) continue;
      add(t.format, t.mime, 'patch', [bad, m.sig[bad], b[bad]], fixed, L - 1, L);
    }
    // PNG 整个 8 字节签名被删：文件直接以「IHDR 的长度」开头
    if (b.length > 16 && ascii(b.subarray(4, 8), 4) === 'IHDR' && _be32(b, 0) === 13) {
      const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
      const fixed = new Uint8Array(b.length + 8);
      fixed.set(sig, 0); fixed.set(b, 8);
      add('PNG', 'image/png', 'prepend', sig, fixed, 4, 8);
    }
    out.sort((x, y) => (y.score - x.score) || (y.matched - x.matched));
    return out.slice(0, o.limit || 6);
  }

  // ---------- Finding ----------
  let findingSeq = 0;
  function finding(layer, type, title, opts) {
    const o = opts || {};
    return {
      id: ++findingSeq,
      layer, type, title,
      confidence: o.confidence === undefined ? 0.5 : o.confidence,
      offset: o.offset === undefined ? null : o.offset,
      declared: o.declared || null,
      actual: o.actual || null,
      detail: o.detail || '',
      preview: o.preview || '',
      recipe: o.recipe || '',
      payload: o.payload || null,   // {name, bytes?, image?, kind}
      repair: o.repair || null,     // {name, bytes}：一键修复再分析
      file: o.file || null,
      depth: o.depth === undefined ? null : o.depth,
      children: o.children || []
    };
  }

  function artifact(name, bytes, note, source) {
    return { name, bytes: bytes ? toU8(bytes) : null, note: note || '', source: source || '' };
  }

  function safeSlice(bytes, start, end) {
    const b = toU8(bytes);
    const s = Math.max(0, Math.min(b.length, start));
    const e = Math.max(s, Math.min(b.length, end === undefined ? b.length : end));
    return b.subarray(s, e);
  }

  function concatBytes(list) {
    let total = 0;
    for (const x of list) total += x.length;
    const out = new Uint8Array(total);
    let p = 0;
    for (const x of list) { out.set(x, p); p += x.length; }
    return out;
  }

  // ---------- flag 格式 ----------
  // 默认只认「前缀{正文}」：flag{} / ctf{} / ctfshow{} …（绝大多数比赛的写法）。
  // 换赛场时可在 UI 里改成别的模板，{} 代表正文，例如 #{}#
  const FLAG_PREFIXES = ['flag', 'ctf', 'litctf', 'susctf', 'qctf', 'ctfshow'];
  const FLAG_BODY = '[ -~]{1,200}?';   // 惰性：遇到第一个结束符就收，避免跨两个 flag 连成一条
  const FLAG_DEFAULT_TPL = 'flag{}';
  const FLAG_DEFAULT_SRC = '(?:' + FLAG_PREFIXES.join('|') + ')\\{(' + FLAG_BODY + ')\\}';
  let flagTpl = FLAG_DEFAULT_TPL;
  let flagHasBody = true;
  let flagRe = new RegExp(FLAG_DEFAULT_SRC, 'i');
  let flagReG = new RegExp(FLAG_DEFAULT_SRC, 'gi');

  function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
  function flagSane(body) {
    if (!flagHasBody || flagTpl === FLAG_DEFAULT_TPL) return true;
    // 自定义模板（多半是 #...#）= 噪声大，要求正文像个词：不能是长重复、不能一堆符号
    if (!body || body.length < 4) return false;
    if (/(.)\1{4,}/.test(body) || new Set(body).size < 5) return false;
    const alnum = (body.match(/[A-Za-z0-9_]/g) || []).length;
    return alnum >= body.length * 0.8;
  }
  function setFlagFormat(tpl) {
    const t = String(tpl == null ? '' : tpl).trim();
    if (!t || t === FLAG_DEFAULT_TPL || t.toLowerCase() === 'default') {
      flagTpl = FLAG_DEFAULT_TPL; flagHasBody = true;
      flagRe = new RegExp(FLAG_DEFAULT_SRC, 'i');
      flagReG = new RegExp(FLAG_DEFAULT_SRC, 'gi');
      return flagTpl;
    }
    flagTpl = t;
    const i = t.indexOf('{}');
    flagHasBody = i >= 0;
    const src = flagHasBody
      ? escapeRe(t.slice(0, i)) + '(' + FLAG_BODY + ')' + escapeRe(t.slice(i + 2))
      : escapeRe(t);
    flagRe = new RegExp(src, 'i');
    flagReG = new RegExp(src, 'gi');
    return flagTpl;
  }
  function flagMatch(text) {
    const m = String(text == null ? '' : text).match(flagRe);
    if (!m) return null;
    return flagSane(m[1] === undefined ? '' : m[1]) ? m[0] : null;
  }
  function flagFindAll(text) {
    const s = String(text == null ? '' : text);
    const out = [];
    flagReG.lastIndex = 0;
    let m;
    while ((m = flagReG.exec(s))) {
      if (flagSane(m[1] === undefined ? '' : m[1])) out.push(m[0]);
      if (m.index === flagReG.lastIndex) flagReG.lastIndex++;
    }
    return out;
  }
  function getFlagFormat() { return flagTpl; }
  function isFlagFormatCustom() { return flagTpl !== FLAG_DEFAULT_TPL; }

  Object.assign(MDZ, {
    VERSION,
    toU8, hex, hex32, bytesToHex, ascii, utf8, utf16le, cstr,
    entropy, printableRatio, strings, utf16strings,
    fnv1a, sha256,
    detectType, detectDamagedHeader, startsWith, finding, artifact, safeSlice, concatBytes,
    setFlagFormat, getFlagFormat, isFlagFormatCustom, flagMatch, flagFindAll
  });
})(typeof globalThis !== 'undefined' ? globalThis : this);
