/* misc大手子 — 12 编码侦探
 * 常用编码解码 + 自动解码链：hex / base64 / base32 / base85 / base91 / uuencode / URL / HTML 实体
 * 另附显式变换：rot13 / rot47 / atbash（不进步自动链，否则满屏都是"结果"）
 */
(function (root) {
  'use strict';
  const MDZ = root.MDZ = root.MDZ || {};
  const { toU8, printableRatio, utf8 } = MDZ;

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
    for (const m of s.matchAll(/[A-Za-z0-9+/=<>~!#$%&()*+,./:;<=>?@[\]^_`{|}~"]{12,}/g)) tokens.push(m[0]);
    for (const t of tokens.slice(0, 32)) {
      if (t.length < (minLen || 12)) continue;
      for (const r of decodeChain(t)) out.push(r);
      if (out.length > 40) break;
    }
    return out;
  }

  Object.assign(MDZ, {
    b32decode, a85decode, b91decode, uudecode,
    rotN, rot47, atbash, urlDecode, htmlDecode,
    decodeOnce, decodeChain, scanText
  });
})(typeof globalThis !== 'undefined' ? globalThis : this);
