/* misc大手子 — 12 编码侦探
 * 常用编码解码 + 自动解码链：hex / base64 / base32 / base85 / base91 / uuencode / URL / HTML 实体
 * 另附显式变换：rot13 / rot47 / atbash（不进步自动链，否则满屏都是"结果"）
 */
(function (root) {
  'use strict';
  const MDZ = root.MDZ = root.MDZ || {};
  const { toU8, printableRatio, utf8, bytesToHex } = MDZ;

  function bytesOf(s) { return Uint8Array.from(s, c => c.charCodeAt(0) & 255); }

  // ---------- base32 (RFC 4648) ----------
  function b32decode(s, hexAlphabet) {
    const A = hexAlphabet ? '0123456789ABCDEFGHIJKLMNOPQRSTUV' : 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    const t = String(s).toUpperCase().replace(/[=\s]/g, '');
    if (!t.length) return null;
    let bits = 0, val = 0;
    const out = [];
    for (const ch of t) {
      const i = A.indexOf(ch);
      if (i < 0) return null;
      val = (val << 5) | i;
      bits += 5;
      if (bits >= 8) { bits -= 8; out.push((val >>> bits) & 255); }
    }
    return Uint8Array.from(out);
  }

  // ---------- base85 (Ascii85 / Adobe) ----------
  function a85decode(s) {
    let t = String(s).trim().replace(/^<~|~>$/g, '').replace(/\s+/g, '');
    if (!t.length) return null;
    const out = [];
    let tuple = [];
    for (const ch of t) {
      if (ch === 'z' && tuple.length === 0) { out.push(0, 0, 0, 0); continue; }
      const c = ch.charCodeAt(0) - 33;
      if (c < 0 || c > 84) return null;
      tuple.push(c);
      if (tuple.length === 5) {
        let v = 0;
        for (const x of tuple) v = v * 85 + x;
        if (v > 0xFFFFFFFF) return null;
        out.push((v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255);
        tuple = [];
      }
    }
    if (tuple.length) {
      const n = tuple.length;
      while (tuple.length < 5) tuple.push(84);
      let v = 0;
      for (const x of tuple) v = v * 85 + x;
      const b = [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
      out.push(...b.slice(0, n - 1));
    }
    return Uint8Array.from(out);
  }

  // ---------- base91 (原版字母表) ----------
  const B91 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!#$%&()*+,./:;<=>?@[]^_`{|}~"';
  function b91decode(s) {
    const t = String(s).replace(/\s+/g, '');
    if (!t.length) return null;
    const out = [];
    let b = 0, n = 0, v = -1;
    for (const ch of t) {
      const c = B91.indexOf(ch);
      if (c < 0) return null;
      if (v < 0) { v = c; } else {
        v += c * 91;
        b |= v << n;
        n += (v & 8191) > 88 ? 13 : 14;
        while (n > 7) { out.push(b & 255); b >>= 8; n -= 8; }
        v = -1;
      }
    }
    if (v >= 0) out.push((b | (v << n)) & 255);
    return Uint8Array.from(out);
  }

  // ---------- base92（thenoviceoof 原版：91 字符、13 bit → 2 字符） ----------
  // 可打印 ASCII 去掉 " ` ~ 三个字符，共 91 个；~ 单独表示空串。
  const B92 = (() => {
    let a = '';
    for (let c = 33; c <= 126; c++) if (c !== 34 && c !== 96 && c !== 126) a += String.fromCharCode(c);
    return a;
  })();
  const B92_INDEX = new Map(Array.from(B92, (c, i) => [c, i]));
  function b92encode(bytes) {
    const b = toU8(bytes);
    if (!b.length) return '~';
    let out = '', val = 0, bits = 0;
    for (const byte of b) {
      val = (val << 8) | byte; bits += 8;
      while (bits >= 13) {
        const x = (val >>> (bits - 13)) & 0x1FFF;
        out += B92[Math.floor(x / 91)] + B92[x % 91];
        bits -= 13;
        val = bits ? val & ((1 << bits) - 1) : 0;
      }
    }
    if (bits > 0) {
      if (bits < 7) {
        out += B92[(val << (6 - bits)) & 0x3F];
      } else {
        const x = (val << (13 - bits)) & 0x1FFF;
        out += B92[Math.floor(x / 91)] + B92[x % 91];
      }
    }
    return out;
  }
  function b92decode(s) {
    const t = String(s).replace(/\s+/g, '');
    if (t === '~') return new Uint8Array(0);
    if (!t.length || t.length === 1) return null;   // 单字符不构成完整编码
    const out = [];
    let val = 0, bits = 0;
    const pushBits = (x, n) => {
      val = (val << n) | x; bits += n;
      while (bits >= 8) { out.push((val >>> (bits - 8)) & 255); bits -= 8; }
      val = bits ? val & ((1 << bits) - 1) : 0;
    };
    for (let i = 0; i < t.length; i += 2) {
      const a = B92_INDEX.get(t[i]);
      if (a === undefined) return null;
      if (i + 1 < t.length) {
        const b = B92_INDEX.get(t[i + 1]);
        if (b === undefined) return null;
        const x = a * 91 + b;
        if (x > 0x1FFF) return null;   // 超出 13 bit 的编码不合法
        pushBits(x, 13);
      } else {
        if (a > 0x3F) return null;     // 末位单字符只能是 6 bit
        pushBits(a, 6);
      }
    }
    return Uint8Array.from(out);
  }

  // ---------- base100（AdamNiederer/base100：U+1F3F7 + byte，一字符一字节） ----------
  const B100_BASE = 0x1F3F7;
  function b100encode(bytes) {
    let s = '';
    for (const b of toU8(bytes)) s += String.fromCodePoint(B100_BASE + b);
    return s;
  }
  function b100decode(s) {
    const chars = Array.from(String(s).replace(/\s+/g, ''));
    if (!chars.length) return null;
    const out = [];
    for (const ch of chars) {
      const cp = ch.codePointAt(0);
      if (cp < B100_BASE || cp > B100_BASE + 255) return null;
      out.push(cp - B100_BASE);
    }
    return Uint8Array.from(out);
  }

  // ---------- uuencode：每行 1 个长度字符 + 若干 4 字符组 ----------
  function uudecode(text) {
    const lines = String(text).split(/\r?\n/);
    const out = [];
    let started = false;
    for (const line of lines) {
      if (!line) continue;
      if (/^begin\s+\d{3}\s+/.test(line)) { started = true; continue; }
      if (/^end\s*$/.test(line)) break;
      const c0 = line.charCodeAt(0);
      if (c0 < 32 || c0 > 96) return null;
      const len = (c0 - 32) & 63;
      if (!started && len === 0) continue;
      const start = out.length;
      for (let i = 1; i + 1 < line.length; i += 4) {
        const a = (line.charCodeAt(i) - 32) & 63;
        const b = (line.charCodeAt(i + 1) - 32) & 63;
        const c = i + 2 < line.length ? (line.charCodeAt(i + 2) - 32) & 63 : 0;
        const d = i + 3 < line.length ? (line.charCodeAt(i + 3) - 32) & 63 : 0;
        out.push((a << 2) | (b >> 4));
        if (i + 2 < line.length) out.push(((b & 15) << 4) | (c >> 2));
        if (i + 3 < line.length) out.push(((c & 3) << 6) | d);
      }
      out.length = Math.min(out.length, start + len);   // 行首那个字符才是本行真实字节数
    }
    return out.length ? Uint8Array.from(out) : null;
  }

  // ---------- 文本变换（显式调用，不进自动链） ----------
  function rotN(s, n) {
    return String(s).replace(/[a-zA-Z]/g, c => {
      const base = c <= 'Z' ? 65 : 97;
      return String.fromCharCode((c.charCodeAt(0) - base + n + 26) % 26 + base);
    });
  }
  function rot47(s) {
    return String(s).replace(/[!-~]/g, c => String.fromCharCode((c.charCodeAt(0) - 33 + 47) % 94 + 33));
  }
  function atbash(s) {
    return String(s).replace(/[a-zA-Z]/g, c => {
      const base = c <= 'Z' ? 65 : 97;
      return String.fromCharCode(base + 25 - (c.charCodeAt(0) - base));
    });
  }
  function urlDecode(s) {
    try {
      const t = decodeURIComponent(String(s).replace(/\+/g, ' '));
      return t === String(s) ? null : t;
    } catch (e) { return null; }
  }
  function htmlDecode(s) {
    const t = String(s).replace(/&#x([0-9a-f]+);/gi, (m, h) => String.fromCodePoint(parseInt(h, 16)))
      .replace(/&#(\d+);/g, (m, d) => String.fromCodePoint(parseInt(d, 10)))
      .replace(/&(amp|lt|gt|quot|apos|nbsp);/g, (m, n) => ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }[n]));
    return t === String(s) ? null : t;
  }

  const B64_RE = /[A-Za-z0-9+/]{12,}={0,2}/g;
  const HEX_RE = /(?:^|[^0-9a-fA-F])([0-9a-fA-F]{16,})(?![0-9a-fA-F])/g;
  const B32_RE = /[A-Z2-7]{10,}={0,6}/g;
  const A85_RE = /(?:<~)?[!-u]{20,}(?:~>)?/g;
  const B91_RE = /[A-Za-z0-9!#$%&()*+,./:;<=>?@[\]^_`{|}~"]{20,}/g;
  const B100_RE = /[\u{1F3F7}-\u{1F4F6}]{6,}/gu;

  function asText(bytes) {
    if (!bytes || bytes.length < 4) return null;
    if (printableRatio(bytes.subarray(0, Math.min(bytes.length, 512))) < 0.92) return null;
    const u = utf8(bytes);
    if (!u) return null;
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(u)) return null;
    return u;
  }

  // 解出来不是文本、但一眼能认出的二进制载荷（PNG/ZIP/7Z/ELF/PDF…）
  function looksBinary(bytes) {
    if (!bytes || bytes.length < 16) return false;
    const t = MDZ.detectType(bytes);
    return t.format !== 'unknown' && t.format !== 'TEXT' && t.format !== 'MP3';
  }

  // 单层解码：返回 [{kind, text}]；opts.binaries 时二进制载荷也返回 {kind, bytes, binary:true}
  function decodeOnce(text, opts) {
    const s = String(text || '');
    const out = [];
    const o = opts || {};
    const push = (kind, bytes) => {
      if (!bytes || !bytes.length) return;
      const t = asText(bytes);
      if (t && t !== s) { out.push({ kind, text: t }); return; }
      if (o.binaries && !t && looksBinary(bytes)) out.push({ kind, bytes: bytes.slice(0), text: '', binary: true });
    };
    for (const m of s.matchAll(HEX_RE)) {
      const h = m[1];
      if (h.length % 2) continue;
      const b = new Uint8Array(h.length / 2);
      for (let i = 0; i < b.length; i++) b[i] = parseInt(h.substr(i * 2, 2), 16);
      push('hex', b);
    }
    for (const m of s.matchAll(B64_RE)) {
      try {
        const b = MDZ.b64decode ? MDZ.b64decode(m[0]) : null;
        if (b) push('base64', b);
      } catch (e) { /* 不是合法 base64 */ }
    }
    for (const m of s.matchAll(B32_RE)) { const b = b32decode(m[0]); if (b) push('base32', b); }
    for (const m of s.matchAll(A85_RE)) { const b = a85decode(m[0]); if (b) push('ascii85', b); }
    for (const m of s.matchAll(B91_RE)) { const b = b91decode(m[0]); if (b) push('base91', b); }
    for (const m of s.matchAll(B100_RE)) { const b = b100decode(m[0]); if (b) push('base100', b); }
    if (/^begin\s+\d{3}\s+/m.test(s)) { const b = uudecode(s); if (b) push('uuencode', b); }
    const u = urlDecode(s); if (u) out.push({ kind: 'url', text: u });
    const h = htmlDecode(s); if (h) out.push({ kind: 'html', text: h });
    return o.all ? out : out.slice(0, 8);
  }

  // 多层链：最多 3 层，结果去重
  function decodeChain(text, maxDepth) {
    const seen = new Set([String(text)]);
    const results = [];
    let frontier = [{ text: String(text), path: [] }];
    const depthMax = maxDepth || 3;
    for (let d = 0; d < depthMax && frontier.length; d++) {
      const next = [];
      for (const item of frontier) {
        for (const r of decodeOnce(item.text)) {
          if (seen.has(r.text)) continue;
          seen.add(r.text);
          const path = item.path.concat(r.kind);
          results.push({ text: r.text, kind: r.kind, path });
          next.push({ text: r.text, path });
          if (results.length > 64) return results;
        }
      }
      frontier = next.slice(0, 16);
    }
    return results;
  }

  // 从一段任意文本里挑出"像编码"的片段，跑链
  function scanText(text, minLen) {
    const s = String(text || '');
    const out = [];
    const tokens = [];
    for (const m of s.matchAll(/[A-Za-z0-9+/=<>~!#$%&()*+,./:;<=>?@[\]^_`{|}~"]{12,}|[\u{1F3F7}-\u{1F4F6}]{6,}/gu)) tokens.push(m[0]);
    for (const t of tokens.slice(0, 32)) {
      if (t.length < (minLen || 12)) continue;
      for (const r of decodeChain(t)) out.push(r);
      if (out.length > 40) break;
    }
    return out;
  }

  // ---------- 编码方向 + 自定义 Base 表 ----------
  const B58_A = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  const B62_A = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

  function utf8Bytes(s) {
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(String(s));
    return bytesOf(String(s));
  }

  function bytesToText(bytes) {
    if (!bytes || !bytes.length) return null;
    const t = utf8(bytes);
    if (t == null) return null;
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(t)) return null;
    return t;
  }

  function hexEncode(input) { return bytesToHex(input); }

  function hexDecode(s) {
    let t = String(s).replace(/0x/gi, '').replace(/[^0-9a-fA-F]/g, '');
    if (t.length & 1) t = t.slice(0, -1);
    const out = new Uint8Array(t.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(t.substr(i * 2, 2), 16);
    return out;
  }

  function b32encode(input) {
    const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    const b = toU8(input);
    let bits = 0, val = 0, out = '';
    for (const byte of b) {
      val = ((val << 8) | byte) >>> 0;
      bits += 8;
      while (bits >= 5) { bits -= 5; out += A[(val >>> bits) & 31]; }
      val &= (1 << bits) - 1;
    }
    if (bits) out += A[(val << (5 - bits)) & 31];
    while (out.length % 8) out += '=';
    return out;
  }

  function b64urlEncode(input) {
    return MDZ.b64encode(toU8(input)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function b64urlDecode(s) {
    let t = String(s).trim().replace(/-/g, '+').replace(/_/g, '/');
    while (t.length % 4) t += '=';
    return MDZ.b64decode(t);
  }

  function a85encode(input) {
    const b = toU8(input);
    let out = '';
    for (let i = 0; i < b.length; i += 4) {
      const n = Math.min(4, b.length - i);
      let v = 0;
      for (let j = 0; j < 4; j++) v = v * 256 + (j < n ? b[i + j] : 0);
      let chunk = '';
      for (let j = 0; j < 5; j++) { chunk = String.fromCharCode(33 + (v % 85)) + chunk; v = Math.floor(v / 85); }
      out += chunk.slice(0, n + 1);
    }
    return out;
  }

  const B91_A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!#$%&()*+,./:;<=>?@[]^_`{|}~"';
  function b91encode(input) {
    const b = toU8(input);
    let out = '', v = 0, bits = 0;
    for (const byte of b) {
      v |= byte << bits;
      bits += 8;
      if (bits > 13) {
        let q = v & 8191;
        if (q > 88) { v >>>= 13; bits -= 13; }
        else { q = v & 16383; v >>>= 14; bits -= 14; }
        out += B91_A[q % 91] + B91_A[Math.floor(q / 91)];
      }
    }
    if (bits) {
      out += B91_A[v % 91];
      if (bits > 7 || v > 90) out += B91_A[Math.floor(v / 91)];
    }
    return out;
  }

  // 任意字母表：2/4/8/16/32/64 位按位流处理（换表 Base64 的用法），其余按大整数
  function baseBitsEncode(input, A, bits) {
    const b = toU8(input);
    const mask = (1 << bits) - 1;
    let out = '', val = 0, n = 0;
    for (const byte of b) {
      val = ((val << 8) | byte) >>> 0;
      n += 8;
      while (n >= bits) { n -= bits; out += A[(val >>> n) & mask]; }
      val &= (1 << n) - 1;
    }
    if (n) out += A[(val << (bits - n)) & mask];
    return out;
  }
  function baseBitsDecode(s, A, bits) {
    const t = String(s).replace(/[\s=]+/g, '');
    let val = 0, n = 0;
    const out = [];
    for (const ch of t) {
      const v = A.indexOf(ch);
      if (v < 0) return null;
      val = ((val << bits) | v) & 0xFFFF;
      n += bits;
      if (n >= 8) { n -= 8; out.push((val >>> n) & 255); }
    }
    return Uint8Array.from(out);
  }
  function baseBigEncode(input, A) {
    const b = toU8(input);
    let zeros = 0;
    while (zeros < b.length && b[zeros] === 0) zeros++;
    const digits = [];
    for (let i = zeros; i < b.length; i++) {
      let carry = b[i];
      for (let j = 0; j < digits.length; j++) {
        const v = digits[j] * 256 + carry;
        digits[j] = v % A.length;
        carry = Math.floor(v / A.length);
      }
      while (carry) { digits.push(carry % A.length); carry = Math.floor(carry / A.length); }
    }
    let out = A[0].repeat(zeros);
    for (let i = digits.length - 1; i >= 0; i--) out += A[digits[i]];
    return out;
  }
  function baseBigDecode(s, A) {
    const t = String(s).replace(/\s+/g, '');
    let zeros = 0;
    while (zeros < t.length && t[zeros] === A[0]) zeros++;
    const bytes = [];
    for (let i = zeros; i < t.length; i++) {
      let carry = A.indexOf(t[i]);
      if (carry < 0) return null;
      for (let j = 0; j < bytes.length; j++) {
        const v = bytes[j] * A.length + carry;
        bytes[j] = v & 255;
        carry = v >> 8;
      }
      while (carry) { bytes.push(carry & 255); carry >>= 8; }
    }
    const out = new Uint8Array(zeros + bytes.length);
    for (let i = 0; i < bytes.length; i++) out[zeros + i] = bytes[bytes.length - 1 - i];
    return out;
  }
  function customTable(alphabet) {
    const A = String(alphabet || '');
    if (A.length < 2 || A.length > 94) return { error: '字母表需要 2-94 个字符' };
    if (new Set(A).size !== A.length) return { error: '字母表里有重复字符' };
    return { A };
  }
  function baseCustomEncode(input, alphabet) {
    const c = customTable(alphabet);
    if (c.error) return { error: c.error };
    const bits = Math.log2(c.A.length);
    return { text: Number.isInteger(bits) && bits <= 8 ? baseBitsEncode(input, c.A, bits) : baseBigEncode(input, c.A) };
  }
  function baseCustomDecode(s, alphabet) {
    const c = customTable(alphabet);
    if (c.error) return { error: c.error };
    const bits = Math.log2(c.A.length);
    const bytes = Number.isInteger(bits) && bits <= 8 ? baseBitsDecode(s, c.A, bits) : baseBigDecode(s, c.A);
    return bytes ? { bytes } : { error: '输入里有字母表之外的字符' };
  }
  function b58encode(input) { return baseBigEncode(input, B58_A); }
  function b58decode(s) { return baseBigDecode(s, B58_A); }
  function b62encode(input) { return baseBigEncode(input, B62_A); }
  function b62decode(s) { return baseBigDecode(s, B62_A); }

  // ---------- base36 / base58check / z85 / base85(IPv6) / base45 ----------
  const B36_A = '0123456789abcdefghijklmnopqrstuvwxyz';
  const B85_IPV6 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz!#$%&()*+-;<=>?@^_`{|}~';
  const Z85_A = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ.-:+=^!/*?&<>()[]{}@%$#';
  const B45_A = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:';
  function b36encode(input) { return baseBigEncode(input, B36_A); }
  function b36decode(s) { return baseBigDecode(String(s).toLowerCase(), B36_A); }

  function sha256Bytes(bytes) {
    return hexDecode(MDZ.sha256(toU8(bytes)));
  }
  function b58checkEncode(input) {
    const b = toU8(input);
    const sum = sha256Bytes(sha256Bytes(b)).subarray(0, 4);
    const out = new Uint8Array(b.length + 4);
    out.set(b); out.set(sum, b.length);
    return b58encode(out);
  }
  function b58checkDecode(s) {
    const all = b58decode(s);
    if (!all || all.length < 4) return null;
    const payload = all.subarray(0, all.length - 4);
    const want = sha256Bytes(sha256Bytes(payload)).subarray(0, 4);
    for (let i = 0; i < 4; i++) if (all[all.length - 4 + i] !== want[i]) return null;
    return payload;
  }

  function b85ipv6Encode(input) {
    const b = toU8(input);
    let out = '';
    for (let i = 0; i < b.length; i += 4) {
      const n = Math.min(4, b.length - i);
      let v = 0;
      for (let j = 0; j < 4; j++) v = v * 256 + (j < n ? b[i + j] : 0);
      let chunk = '';
      for (let j = 0; j < 5; j++) { chunk = B85_IPV6[v % 85] + chunk; v = Math.floor(v / 85); }
      out += chunk.slice(0, n + 1);
    }
    return out;
  }
  function b85ipv6Decode(s) {
    const t = String(s).replace(/\s+/g, '');
    if (!t.length) return null;
    const out = [];
    for (let i = 0; i < t.length; i += 5) {
      const n = Math.min(5, t.length - i);
      if (n < 2) return null;
      let v = 0;
      for (let j = 0; j < 5; j++) {
        const dig = j < n ? B85_IPV6.indexOf(t[i + j]) : 84;
        if (dig < 0) return null;
        v = v * 85 + dig;
      }
      if (v > 0xFFFFFFFF) return null;
      const bytes = [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
      out.push(...bytes.slice(0, n - 1));
    }
    return Uint8Array.from(out);
  }

  function z85Encode(input) {
    const b = toU8(input);
    if (b.length % 4) return { error: 'Z85 要求输入长度是 4 的倍数' };
    let out = '';
    for (let i = 0; i < b.length; i += 4) {
      let v = b[i] * 16777216 + b[i + 1] * 65536 + b[i + 2] * 256 + b[i + 3];
      let chunk = '';
      for (let j = 0; j < 5; j++) { chunk = Z85_A[v % 85] + chunk; v = Math.floor(v / 85); }
      out += chunk;
    }
    return { text: out };
  }
  function z85Decode(s) {
    const t = String(s).replace(/\s+/g, '');
    if (!t.length || t.length % 5) return null;
    const out = [];
    for (let i = 0; i < t.length; i += 5) {
      let v = 0;
      for (let j = 0; j < 5; j++) {
        const d = Z85_A.indexOf(t[i + j]);
        if (d < 0) return null;
        v = v * 85 + d;
        if (v > 0xFFFFFFFF) return null;
      }
      out.push((v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255);
    }
    return Uint8Array.from(out);
  }

  function b45encode(input) {
    const b = toU8(input);
    let out = '';
    for (let i = 0; i + 1 < b.length; i += 2) {
      const n = b[i] * 256 + b[i + 1];
      out += B45_A[n % 45] + B45_A[Math.floor(n / 45) % 45] + B45_A[Math.floor(n / 2025)];
    }
    if (b.length % 2) {
      const n = b[b.length - 1];
      out += B45_A[n % 45] + B45_A[Math.floor(n / 45)];
    }
    return out;
  }
  function b45decode(s) {
    const t = String(s);
    if (!t.length) return null;
    const out = [];
    for (let i = 0; i < t.length;) {
      const spare = t.length - i;
      if (spare >= 3) {
        const a = B45_A.indexOf(t[i]), b = B45_A.indexOf(t[i + 1]), c = B45_A.indexOf(t[i + 2]);
        if (a < 0 || b < 0 || c < 0) return null;
        const n = a + b * 45 + c * 2025;
        if (n > 0xFFFF) return null;
        out.push((n >>> 8) & 255, n & 255);
        i += 3;
      } else if (spare === 2) {
        const a = B45_A.indexOf(t[i]), b = B45_A.indexOf(t[i + 1]);
        if (a < 0 || b < 0) return null;
        const n = a + b * 45;
        if (n > 0xFF) return null;
        out.push(n);
        i += 2;
      } else return null;
    }
    return Uint8Array.from(out);
  }

  function qpEncode(s) {
    const b = utf8Bytes(s);
    let out = '';
    for (let i = 0; i < b.length; i++) {
      const c = b[i];
      if ((c >= 33 && c <= 126 && c !== 61) || c === 32 || c === 9) out += String.fromCharCode(c);
      else out += '=' + (c < 16 ? '0' : '') + c.toString(16).toUpperCase();
    }
    return out;
  }
  function qpDecode(s) {
    const src = String(s).replace(/=\r?\n/g, '');
    const bytes = [];
    for (let i = 0; i < src.length; i++) {
      if (src[i] === '=' && /^[0-9A-Fa-f]{2}$/.test(src.substr(i + 1, 2))) {
        bytes.push(parseInt(src.substr(i + 1, 2), 16)); i += 2;
      } else {
        bytes.push(src.charCodeAt(i) & 255);
      }
    }
    return Uint8Array.from(bytes);
  }

  function uuencode(input) {
    const b = toU8(input);
    const lines = ['begin 644 -'];
    for (let i = 0; i < b.length; i += 45) {
      const n = Math.min(45, b.length - i);
      let line = String.fromCharCode(32 + n);
      for (let j = 0; j < n; j += 3) {
        const a = b[i + j];
        const c2 = j + 1 < n ? b[i + j + 1] : 0;
        const c3 = j + 2 < n ? b[i + j + 2] : 0;
        line += String.fromCharCode(32 + (a >> 2), 32 + (((a << 4) | (c2 >> 4)) & 63), 32 + (((c2 << 2) | (c3 >> 6)) & 63), 32 + (c3 & 63));
      }
      lines.push(line);
    }
    lines.push('`', 'end', '');
    return lines.join('\n');
  }

  function urlEncode(s) { return encodeURIComponent(String(s)); }
  function htmlEncode(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function unicodeEncode(s) {
    return Array.from(String(s)).map(c => {
      const cp = c.codePointAt(0);
      return cp > 0xFFFF ? '\\u{' + cp.toString(16) + '}' : '\\u' + cp.toString(16).padStart(4, '0');
    }).join('');
  }
  function unicodeDecode(s) {
    return String(s).replace(/\\u\{([0-9a-fA-F]+)\}|\\u([0-9a-fA-F]{4})|\\x([0-9a-fA-F]{2})|&#x([0-9a-fA-F]+);|&#(\d+);/g, (m, a, b, c, d, e) => {
      const cp = a ? parseInt(a, 16) : b ? parseInt(b, 16) : c ? parseInt(c, 16) : d ? parseInt(d, 16) : parseInt(e, 10);
      try { return String.fromCodePoint(cp); } catch (_) { return m; }
    });
  }

  const MORSE_A = {
    A: '.-', B: '-...', C: '-.-.', D: '-..', E: '.', F: '..-.', G: '--.', H: '....', I: '..', J: '.---',
    K: '-.-', L: '.-..', M: '--', N: '-.', O: '---', P: '.--.', Q: '--.-', R: '.-.', S: '...', T: '-',
    U: '..-', V: '...-', W: '.--', X: '-..-', Y: '-.--', Z: '--..',
    0: '-----', 1: '.----', 2: '..---', 3: '...--', 4: '....-', 5: '.....', 6: '-....', 7: '--...', 8: '---..', 9: '----.',
    '.': '.-.-.-', ',': '--..--', '?': '..--..', "'": '.----.', '!': '-.-.--', '/': '-..-.', '(': '-.--.', ')': '-.--.-',
    '&': '.-...', ':': '---...', ';': '-.-.-.', '=': '-...-', '+': '.-.-.', '-': '-....-', '_': '..--.-', '"': '.-..-.', '$': '...-..-', '@': '.--.-.'
  };
  const MORSE_REV = {};
  for (const k of Object.keys(MORSE_A)) MORSE_REV[MORSE_A[k]] = k;
  function morseEncode(s) {
    return String(s).toUpperCase().split('').map(c => c === ' ' ? '/' : (MORSE_A[c] || '')).filter(Boolean).join(' ');
  }
  function morseDecode(s) {
    return String(s).trim().split(/\s+/).map(tok => {
      if (tok === '/' || tok === '|') return ' ';
      return MORSE_REV[tok] || '';
    }).join('');
  }

  function baconEncode(s) {
    return String(s).toUpperCase().replace(/[^A-Z]/g, '').split('').map(c =>
      (c.charCodeAt(0) - 65).toString(2).padStart(5, '0').replace(/0/g, 'A').replace(/1/g, 'B')
    ).join(' ');
  }
  function baconDecode(s) {
    const t = String(s).toUpperCase().replace(/[^AB]/g, '');
    let out = '';
    for (let i = 0; i + 5 <= t.length; i += 5) {
      const v = parseInt(t.slice(i, i + 5).replace(/A/g, '0').replace(/B/g, '1'), 2);
      if (v < 26) out += String.fromCharCode(65 + v);
    }
    return out;
  }

  function a1z26Encode(s) {
    return String(s).toUpperCase().replace(/[^A-Z]/g, '').split('').map(c => c.charCodeAt(0) - 64).join('-');
  }
  function a1z26Decode(s) {
    return String(s).trim().split(/[^0-9]+/).filter(Boolean).map(n => {
      const v = parseInt(n, 10);
      return v >= 1 && v <= 26 ? String.fromCharCode(64 + v) : '';
    }).join('');
  }

  function binEncode(input) { return Array.from(toU8(input), x => x.toString(2).padStart(8, '0')).join(' '); }
  function binDecode(s) {
    const t = String(s).replace(/[^01]/g, '');
    const out = [];
    for (let i = 0; i + 8 <= t.length; i += 8) out.push(parseInt(t.slice(i, i + 8), 2));
    return Uint8Array.from(out);
  }
  function octEncode(input) { return Array.from(toU8(input), x => x.toString(8).padStart(3, '0')).join(' '); }
  function octDecode(s) {
    const parts = String(s).trim().split(/[^0-7]+/).filter(Boolean);
    let nums;
    if (parts.length && parts.every(x => x.length <= 3)) {
      nums = parts.map(x => parseInt(x, 8));
    } else {
      const t = String(s).replace(/[^0-7]/g, '');
      nums = [];
      for (let i = 0; i + 3 <= t.length; i += 3) nums.push(parseInt(t.slice(i, i + 3), 8));
    }
    return Uint8Array.from(nums.filter(v => v <= 255));
  }
  function decEncode(input) { return Array.from(toU8(input)).join(' '); }
  function decDecode(s) {
    return Uint8Array.from(String(s).trim().split(/[^0-9]+/).filter(Boolean).map(x => parseInt(x, 10)).filter(v => v >= 0 && v <= 255));
  }

  // ---------- 统一入口 ----------
  const CODEC_OPS = [
    { group: 'Base 系列', items: [
      { id: 'hex-encode', label: 'Base16 编码（Hex）' }, { id: 'hex-decode', label: 'Base16 解码（Hex）' },
      { id: 'base32-encode', label: 'Base32 编码' }, { id: 'base32-decode', label: 'Base32 解码' },
      { id: 'base36-encode', label: 'Base36 编码' }, { id: 'base36-decode', label: 'Base36 解码' },
      { id: 'base45-encode', label: 'Base45 编码' }, { id: 'base45-decode', label: 'Base45 解码' },
      { id: 'base58-encode', label: 'Base58 编码' }, { id: 'base58-decode', label: 'Base58 解码' },
      { id: 'base58check-encode', label: 'Base58Check 编码' }, { id: 'base58check-decode', label: 'Base58Check 解码' },
      { id: 'base62-encode', label: 'Base62 编码' }, { id: 'base62-decode', label: 'Base62 解码' },
      { id: 'base64-encode', label: 'Base64 编码' }, { id: 'base64-decode', label: 'Base64 解码' },
      { id: 'base64url-encode', label: 'Base64URL 编码' }, { id: 'base64url-decode', label: 'Base64URL 解码' },
      { id: 'base85-encode', label: 'Base85 / Ascii85 编码' }, { id: 'base85-decode', label: 'Base85 / Ascii85 解码' },
      { id: 'base85ipv6-encode', label: 'Base85 编码（IPv6 / RFC1924）' }, { id: 'base85ipv6-decode', label: 'Base85 解码（IPv6 / RFC1924）' },
      { id: 'z85-encode', label: 'Z85 编码（ZeroMQ）' }, { id: 'z85-decode', label: 'Z85 解码（ZeroMQ）' },
      { id: 'base91-encode', label: 'Base91 编码' }, { id: 'base91-decode', label: 'Base91 解码' },
      { id: 'base92-encode', label: 'Base92 编码' }, { id: 'base92-decode', label: 'Base92 解码' },
      { id: 'base100-encode', label: 'Base100 编码（Emoji）' }, { id: 'base100-decode', label: 'Base100 解码（Emoji）' },
      { id: 'custom-encode', label: '自定义 Base 编码（填字母表）' }, { id: 'custom-decode', label: '自定义 Base 解码（填字母表）' }
    ] },
    { group: '字节 / 文本', items: [
      { id: 'bin-encode', label: '二进制 (01) 编码' }, { id: 'bin-decode', label: '二进制 (01) 解码' },
      { id: 'oct-encode', label: '八进制编码' }, { id: 'oct-decode', label: '八进制解码' },
      { id: 'dec-encode', label: '十进制字节编码' }, { id: 'dec-decode', label: '十进制字节解码' },
      { id: 'url-encode', label: 'URL 编码' }, { id: 'url-decode', label: 'URL 解码' },
      { id: 'html-encode', label: 'HTML 实体编码' }, { id: 'html-decode', label: 'HTML 实体解码' },
      { id: 'qp-encode', label: 'Quoted-Printable 编码' }, { id: 'qp-decode', label: 'Quoted-Printable 解码' },
      { id: 'unicode-encode', label: 'Unicode 转义编码' }, { id: 'unicode-decode', label: 'Unicode 转义解码' },
      { id: 'uuencode-encode', label: 'UUencode 编码' }, { id: 'uuencode-decode', label: 'UUencode 解码' }
    ] },
    { group: '经典替换', items: [
      { id: 'rot13', label: 'ROT13' }, { id: 'rot47', label: 'ROT47' }, { id: 'atbash', label: 'Atbash' },
      { id: 'morse-encode', label: '摩斯电码编码' }, { id: 'morse-decode', label: '摩斯电码解码' },
      { id: 'bacon-encode', label: '培根密码编码' }, { id: 'bacon-decode', label: '培根密码解码' },
      { id: 'a1z26-encode', label: 'A1Z26 编码' }, { id: 'a1z26-decode', label: 'A1Z26 解码' }
    ] }
  ];

  function codecApply(op, text, opts) {
    const s = String(text == null ? '' : text);
    const o = opts || {};
    const enc = utf8Bytes(s);
    const okText = t => t == null ? { ok: false, error: '没有解出内容' } : { ok: true, text: String(t) };
    const okBytes = bytes => {
      if (!bytes || !bytes.length) return { ok: false, error: '没有解出内容' };
      const t = bytesToText(bytes);
      if (t != null) return { ok: true, text: t };
      return { ok: true, text: hexEncode(bytes), binary: true, bytes };
    };
    try {
      switch (op) {
        case 'base64-encode': return okText(MDZ.b64encode(enc));
        case 'base64-decode': return okBytes(MDZ.b64decode(s));
        case 'base64url-encode': return okText(b64urlEncode(enc));
        case 'base64url-decode': return okBytes(b64urlDecode(s));
        case 'base32-encode': return okText(b32encode(enc));
        case 'base32-decode': { const b = b32decode(s); return b ? okBytes(b) : { ok: false, error: '不是合法 Base32' }; }
        case 'base36-encode': return okText(b36encode(enc));
        case 'base36-decode': { const b = b36decode(s); return b ? okBytes(b) : { ok: false, error: '不是合法 Base36' }; }
        case 'base45-encode': return okText(b45encode(enc));
        case 'base45-decode': { const b = b45decode(s); return b ? okBytes(b) : { ok: false, error: '不是合法 Base45' }; }
        case 'base58-encode': return okText(b58encode(enc));
        case 'base58-decode': { const b = b58decode(s); return b ? okBytes(b) : { ok: false, error: '不是合法 Base58' }; }
        case 'base58check-encode': return okText(b58checkEncode(enc));
        case 'base58check-decode': { const b = b58checkDecode(s); return b ? okBytes(b) : { ok: false, error: 'Base58Check 校验和不匹配' }; }
        case 'base62-encode': return okText(b62encode(enc));
        case 'base62-decode': { const b = b62decode(s); return b ? okBytes(b) : { ok: false, error: '不是合法 Base62' }; }
        case 'base85-encode': return okText(a85encode(enc));
        case 'base85-decode': { const b = a85decode(s); return b ? okBytes(b) : { ok: false, error: '不是合法 Ascii85' }; }
        case 'base85ipv6-encode': return okText(b85ipv6Encode(enc));
        case 'base85ipv6-decode': { const b = b85ipv6Decode(s); return b ? okBytes(b) : { ok: false, error: '不是合法 Base85 (IPv6)' }; }
        case 'z85-encode': { const r = z85Encode(enc); return r.error ? { ok: false, error: r.error } : okText(r.text); }
        case 'z85-decode': { const b = z85Decode(s); return b ? okBytes(b) : { ok: false, error: '不是合法 Z85（长度需为 5 的倍数）' }; }
        case 'base91-encode': return okText(b91encode(enc));
        case 'base91-decode': { const b = b91decode(s); return b ? okBytes(b) : { ok: false, error: '不是合法 Base91' }; }
        case 'base92-encode': return okText(b92encode(enc));
        case 'base92-decode': {
          const b = b92decode(s);
          if (!b) return { ok: false, error: '不是合法 Base92' };
          return b.length ? okBytes(b) : okText('');
        }
        case 'base100-encode': return okText(b100encode(enc));
        case 'base100-decode': { const b = b100decode(s); return b ? okBytes(b) : { ok: false, error: '不是合法 Base100（应为 U+1F3F7–U+1F4F6 的 emoji）' }; }
        case 'custom-encode': { const r = baseCustomEncode(enc, o.alphabet); return r.error ? { ok: false, error: r.error } : okText(r.text); }
        case 'custom-decode': { const r = baseCustomDecode(s, o.alphabet); return r.error ? { ok: false, error: r.error } : okBytes(r.bytes); }
        case 'hex-encode': return okText(hexEncode(enc));
        case 'hex-decode': return okBytes(hexDecode(s));
        case 'bin-encode': return okText(binEncode(enc));
        case 'bin-decode': return okBytes(binDecode(s));
        case 'oct-encode': return okText(octEncode(enc));
        case 'oct-decode': return okBytes(octDecode(s));
        case 'dec-encode': return okText(decEncode(enc));
        case 'dec-decode': return okBytes(decDecode(s));
        case 'url-encode': return okText(urlEncode(s));
        case 'url-decode': return okText(urlDecode(s));
        case 'html-encode': return okText(htmlEncode(s));
        case 'html-decode': return okText(htmlDecode(s));
        case 'qp-encode': return okText(qpEncode(s));
        case 'qp-decode': return okBytes(qpDecode(s));
        case 'unicode-encode': return okText(unicodeEncode(s));
        case 'unicode-decode': return okText(unicodeDecode(s));
        case 'uuencode-encode': return okText(uuencode(enc));
        case 'uuencode-decode': { const b = uudecode(s); return b ? okBytes(b) : { ok: false, error: '不是合法 UUencode' }; }
        case 'rot13': return okText(rotN(s, 13));
        case 'rot47': return okText(rot47(s));
        case 'atbash': return okText(atbash(s));
        case 'morse-encode': return okText(morseEncode(s));
        case 'morse-decode': return okText(morseDecode(s));
        case 'bacon-encode': return okText(baconEncode(s));
        case 'bacon-decode': return okText(baconDecode(s));
        case 'a1z26-encode': return okText(a1z26Encode(s));
        case 'a1z26-decode': return okText(a1z26Decode(s));
        default: return { ok: false, error: '未知操作：' + op };
      }
    } catch (e) {
      return { ok: false, error: String(e && e.message || e) };
    }
  }

  // 从 CODEC_OPS 派生，避免「界面上有、爆破里漏了」；自定义表需要用户给字母表，不进爆破
  const DECODE_OPS = CODEC_OPS
    .reduce((all, g) => all.concat(g.items), [])
    .map(it => it.id)
    .filter(id => /-decode$/.test(id) && id !== 'custom-decode');

  function textReadableRatio(t) {
    const chars = Array.from(String(t));
    if (!chars.length) return 0;
    let ok = 0;
    for (const ch of chars) {
      const c = ch.codePointAt(0);
      if ((c >= 32 && c < 127) || c === 9 || c === 10 || c === 13 || (c >= 0x4e00 && c <= 0x9fff)) ok++;
    }
    return ok / chars.length;
  }

  function scoreCandidate(t, orig) {
    if (!t || t === orig) return -1;
    let score = textReadableRatio(t) * 40;
    if (MDZ.flagMatch && MDZ.flagMatch(t)) score += 60;
    else if (/[A-Za-z0-9_]{2,}\{[^}\r\n]{4,}\}/.test(t)) score += 24;
    if (/\b(?:flag|ctf|key|secret|passw(?:or)?d)\b/i.test(t)) score += 8;
    if (t.length >= 16) score += 4;
    return score;
  }

  // 常见换表 Base64/Base62 候选：CTF 里最常出现的几张「表」
  const COMMON_BASE_TABLES = [
    { label: '自定义Base 标准表', table: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/' },
    { label: '自定义Base URL表', table: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_' },
    { label: '自定义Base 数字在前', table: '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz+/' },
    { label: '自定义Base 小写在前', table: 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789+/' },
    { label: '自定义Base 倒序表', table: 'zyxwvutsrqponmlkjihgfedcbaZYXWVUTSRQPONMLKJIHGFEDCBA9876543210+/' },
    { label: '自定义Base Base62', table: '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz' }
  ];

  // 编码爆破：常见解码器 + ROT/Atbash + 常见换表 + 两层组合 + 自动链
  function bruteDecode(text, opts) {
    const s = String(text == null ? '' : text);
    const o = opts || {};
    const seen = new Map();
    const add = (kind, t, path) => {
      if (!t || typeof t !== 'string') return;
      const score = scoreCandidate(t, s);
      if (score < 0) return;
      const prev = seen.get(t);
      if (prev) { if (prev.score < score) { prev.score = score; prev.kind = kind; } return; }
      seen.set(t, { kind, path: path || [kind], text: t, score });
    };
    for (const op of DECODE_OPS) {
      const r = codecApply(op, s, o);
      if (r.ok) add(op.replace(/-decode$/, ''), r.text);
    }
    for (let n = 1; n <= 25; n++) add('rot' + n, rotN(s, n));
    add('rot47', rot47(s));
    add('atbash', atbash(s));
    for (const t of COMMON_BASE_TABLES) {
      const r = baseCustomDecode(s, t.table);
      if (r.bytes) add(t.label, bytesToText(r.bytes) || hexEncode(r.bytes));
    }
    // 第二层：只从可读性最高的候选继续解，避免组合爆炸
    const singles = Array.from(seen.values()).sort((a, b) => b.score - a.score).slice(0, 6);
    for (const base of singles) {
      for (const op of DECODE_OPS) {
        const r = codecApply(op, base.text, o);
        if (r.ok && !r.binary && r.text !== base.text) add(op.replace(/-decode$/, ''), r.text, base.path.concat(op.replace(/-decode$/, '')));
      }
      if (seen.size > 1200) break;
    }
    for (const r of decodeChain(s, 3)) add(r.kind, r.text, r.path);
    const out = Array.from(seen.values()).filter(x => x.score > 0);
    out.sort((a, b) => b.score - a.score || a.text.length - b.text.length);
    return out.slice(0, o.limit || 30);
  }

  Object.assign(MDZ, {
    b32decode, a85decode, b91decode, uudecode,
    rotN, rot47, atbash, urlDecode, htmlDecode,
    decodeOnce, decodeChain, scanText,
    b32encode, b64urlEncode, b64urlDecode, a85encode, b91encode, b58encode, b58decode,
    b92encode, b92decode, b100encode, b100decode, B92, B100_BASE,
    b36encode, b36decode, b45encode, b45decode, b58checkEncode, b58checkDecode,
    z85Encode, z85Decode, b85ipv6Encode, b85ipv6Decode,
    b62encode, b62decode, hexEncode, hexDecode, qpEncode, qpDecode, uuencode,
    urlEncode, htmlEncode, unicodeEncode, unicodeDecode, morseEncode, morseDecode,
    baconEncode, baconDecode, a1z26Encode, a1z26Decode, binEncode, binDecode,
    octEncode, octDecode, decEncode, decDecode, baseCustomEncode, baseCustomDecode,
    CODEC_OPS, codecApply, bruteDecode, MORSE_A, MORSE_REV
  });
})(typeof globalThis !== 'undefined' ? globalThis : this);
