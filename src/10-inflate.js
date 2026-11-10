/* misc大手子 — 10 校验与解压
 * 自带 DEFLATE 解码器：需要知道「第一条流到底吃了多少字节」，
 * 浏览器原生 DecompressionStream 不返回 consumed，因此手写。
 */
(function (root) {
  'use strict';
  const MDZ = root.MDZ = root.MDZ || {};
  const { toU8 } = MDZ;

  // ---------- CRC32 ----------
  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(input, start, end) {
    const b = toU8(input);
    const s = start || 0;
    const e = end === undefined ? b.length : end;
    let c = 0xFFFFFFFF;
    for (let i = s; i < e; i++) c = CRC_TABLE[(c ^ b[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  // ---------- Adler32 ----------
  function adler32(input) {
    const b = toU8(input);
    let a = 1, s = 0;
    const MOD = 65521;
    let i = 0;
    while (i < b.length) {
      const n = Math.min(i + 5552, b.length);
      for (; i < n; i++) { a += b[i]; s += a; }
      a %= MOD; s %= MOD;
    }
    return ((s << 16) | a) >>> 0;
  }

  // ---------- 位读取 ----------
  function makeBitReader(src, start) {
    const b = toU8(src);
    let pos = start || 0;
    let bitbuf = 0, bitcnt = 0;
    function ensure(n) {
      while (bitcnt < n) {
        if (pos >= b.length) throw new Error('unexpected EOF');
        bitbuf |= b[pos++] << bitcnt;
        bitcnt += 8;
      }
    }
    return {
      bits(n) {
        if (n === 0) return 0;
        ensure(n);
        const v = bitbuf & ((1 << n) - 1);
        bitbuf >>>= n;
        bitcnt -= n;
        return v;
      },
      align() {
        const d = bitcnt & 7;
        bitbuf >>>= d;
        bitcnt -= d;
      },
      consumedBits() { return pos * 8 - bitcnt; },
      get pos() { return pos; },
      get bitcnt() { return bitcnt; }
    };
  }

  // ---------- Huffman ----------
  function buildHuff(lengths, n) {
    const count = new Uint16Array(16);
    for (let i = 0; i < n; i++) count[lengths[i] & 15]++;
    count[0] = 0;
    const offs = new Uint16Array(16);
    let sum = 0;
    for (let i = 1; i < 16; i++) { offs[i] = sum; sum += count[i]; }
    const symbol = new Uint16Array(n);
    for (let i = 0; i < n; i++) {
      const l = lengths[i] & 15;
      if (l) symbol[offs[l]++] = i;
    }
    return { count, symbol };
  }

  function decodeSym(br, h) {
    let code = 0, first = 0, index = 0;
    for (let len = 1; len <= 15; len++) {
      code |= br.bits(1);
      const count = h.count[len];
      if (code - first < count) return h.symbol[index + (code - first)];
      index += count;
      first = (first + count) << 1;
      code <<= 1;
    }
    throw new Error('bad huffman code');
  }

  const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
  const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
  const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
  const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];

  let FIXED_LIT = null, FIXED_DIST = null;
  function fixedTables() {
    if (FIXED_LIT) return;
    const litLens = new Uint8Array(288);
    for (let i = 0; i <= 143; i++) litLens[i] = 8;
    for (let i = 144; i <= 255; i++) litLens[i] = 9;
    for (let i = 256; i <= 279; i++) litLens[i] = 7;
    for (let i = 280; i <= 287; i++) litLens[i] = 8;
    const distLens = new Uint8Array(30);
    for (let i = 0; i < 30; i++) distLens[i] = 5;
    FIXED_LIT = buildHuff(litLens, 288);
    FIXED_DIST = buildHuff(distLens, 30);
  }

  const CL_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

  function dynamicTables(br) {
    const hlit = br.bits(5) + 257;
    const hdist = br.bits(5) + 1;
    const hclen = br.bits(4) + 4;
    if (hlit > 286 || hdist > 30) throw new Error('bad huffman counts');
    const clLens = new Uint8Array(19);
    for (let i = 0; i < hclen; i++) clLens[CL_ORDER[i]] = br.bits(3);
    const clHuff = buildHuff(clLens, 19);
    const lens = new Uint8Array(hlit + hdist);
    let n = 0;
    while (n < lens.length) {
      const sym = decodeSym(br, clHuff);
      if (sym < 16) lens[n++] = sym;
      else if (sym === 16) {
        if (n === 0) throw new Error('repeat with no previous');
        const prev = lens[n - 1];
        let rep = 3 + br.bits(2);
        while (rep-- && n < lens.length) lens[n++] = prev;
      } else if (sym === 17) {
        let rep = 3 + br.bits(3);
        while (rep-- && n < lens.length) lens[n++] = 0;
      } else if (sym === 18) {
        let rep = 11 + br.bits(7);
        while (rep-- && n < lens.length) lens[n++] = 0;
      } else throw new Error('bad code length symbol');
    }
    const lit = buildHuff(lens.subarray(0, hlit), hlit);
    const dist = buildHuff(lens.subarray(hlit), hdist);
    return { lit, dist };
  }

  // ---------- DEFLATE ----------
  // maxOut：防止压缩炸弹，默认 256MB
  function inflateRaw(input, start, maxOut) {
    const src = toU8(input);
    const br = makeBitReader(src, start || 0);
    const cap = maxOut || (256 * 1024 * 1024);
    let out = new Uint8Array(1 << 16);
    let olen = 0;
    function ensure(n) {
      if (olen + n <= out.length) return;
      if (olen + n > cap) throw new Error('inflate output cap exceeded');
      let ns = out.length;
      while (ns < olen + n) ns = Math.min(cap, ns * 2);
      const n2 = new Uint8Array(ns);
      n2.set(out.subarray(0, olen));
      out = n2;
    }
    try {
      let last = 0;
      while (!last) {
        last = br.bits(1);
        const type = br.bits(2);
        if (type === 0) {
          br.align();
          const len = br.bits(16);
          const nlen = br.bits(16);
          if ((len ^ 0xFFFF) !== nlen) throw new Error('stored block length mismatch');
          ensure(len);
          for (let i = 0; i < len; i++) {
            const v = br.bits(8);   // 先读再写：bits(8) 抛错时 olen 不能先加
            out[olen++] = v;
          }
        } else if (type === 1 || type === 2) {
          fixedTables();
          const t = type === 1 ? { lit: FIXED_LIT, dist: FIXED_DIST } : dynamicTables(br);
          for (;;) {
            const sym = decodeSym(br, t.lit);
            if (sym < 256) {
              ensure(1);
              out[olen++] = sym;
            } else if (sym === 256) {
              break;
            } else {
              const li = sym - 257;
              if (li >= 29) throw new Error('bad length symbol');
              const len = LEN_BASE[li] + br.bits(LEN_EXTRA[li]);
              const ds = decodeSym(br, t.dist);
              if (ds >= 30) throw new Error('bad distance symbol');
              const dist = DIST_BASE[ds] + br.bits(DIST_EXTRA[ds]);
              if (dist > olen) throw new Error('distance beyond output');
              ensure(len);
              for (let k = 0; k < len; k++) { out[olen] = out[olen - dist]; olen++; }
            }
          }
        } else {
          throw new Error('reserved block type');
        }
      }
      const bits = br.consumedBits() - (start || 0) * 8;
      return { out: out.slice(0, olen), consumed: Math.ceil(bits / 8), bits, error: null };
    } catch (e) {
      const bits = br.consumedBits() - (start || 0) * 8;
      return { out: out.slice(0, olen), consumed: Math.ceil(bits / 8), bits, error: String(e && e.message || e) };
    }
  }

  // ---------- zlib ----------
  function isZlibHeader(src, at) {
    if (at + 2 > src.length) return false;
    const cmf = src[at], flg = src[at + 1];
    return (cmf & 0x0F) === 8 && ((cmf << 8) | flg) % 31 === 0;
  }

  function inflateZlib(input, start, maxOut) {
    const src = toU8(input);
    const s = start || 0;
    if (!isZlibHeader(src, s)) return { out: null, consumed: 0, error: 'not zlib' };
    if (src[s + 1] & 0x20) return { out: null, consumed: 0, error: 'FDICT 预设字典流暂不支持' };
    const r = inflateRaw(src, s + 2, maxOut);
    if (r.error) return { out: r.out, consumed: 2 + r.consumed, deflateConsumed: r.consumed, adlerOk: false, error: r.error };
    let consumed = 2 + r.consumed;
    let adlerOk = null;
    if (s + consumed + 4 <= src.length) {
      const want = ((src[s + consumed] << 24) | (src[s + consumed + 1] << 16) | (src[s + consumed + 2] << 8) | src[s + consumed + 3]) >>> 0;
      adlerOk = want === adler32(r.out);
      consumed += 4;
      if (!adlerOk) return { out: r.out, consumed, deflateConsumed: r.consumed, adlerOk, error: 'adler32 校验失败' };
    } else {
      adlerOk = false;
      return { out: r.out, consumed, deflateConsumed: r.consumed, adlerOk, error: '缺少 adler32 尾部' };
    }
    return { out: r.out, consumed, deflateConsumed: r.consumed, adlerOk, error: null };
  }

  // ---------- gzip ----------
  function inflateGzip(input, start, maxOut) {
    const src = toU8(input);
    let p = start || 0;
    if (p + 10 > src.length || src[p] !== 0x1F || src[p + 1] !== 0x8B) return { out: null, consumed: 0, error: 'not gzip' };
    const flg = src[p + 3];
    p += 10;
    if (flg & 4) { p += 2 + (src[p] | (src[p + 1] << 8)); } // FEXTRA
    if (flg & 8) { while (p < src.length && src[p]) p++; p++; } // FNAME
    if (flg & 16) { while (p < src.length && src[p]) p++; p++; } // FCOMMENT
    if (flg & 2) p += 2; // FHCRC
    const r = inflateRaw(src, p, maxOut);
    const s0 = start || 0;
    if (r.error) return { out: r.out, consumed: p - s0 + r.consumed, error: r.error };
    let consumed = p - s0 + r.consumed;
    if (s0 + consumed + 8 <= src.length) {
      const crcWant = (src[s0 + consumed] | (src[s0 + consumed + 1] << 8) | (src[s0 + consumed + 2] << 16) | (src[s0 + consumed + 3] << 24)) >>> 0;
      const sizeWant = (src[s0 + consumed + 4] | (src[s0 + consumed + 5] << 8) | (src[s0 + consumed + 6] << 16) | (src[s0 + consumed + 7] << 24)) >>> 0;
      const crcGot = crc32(r.out);
      const sizeGot = r.out.length >>> 0;
      consumed += 8;
      if (crcWant !== crcGot || sizeWant !== sizeGot) {
        return { out: r.out, consumed, error: 'gzip CRC32/ISIZE 校验失败' };
      }
    } else {
      return { out: r.out, consumed, error: '缺少 gzip 尾部（CRC32/ISIZE）' };
    }
    return { out: r.out, consumed, error: null };
  }

  // ---------- 压缩流签名扫描 ----------
  // LZMA 单独格式(.lzma)没有魔数：props(1) + 字典大小(4 LE) + 原长(8 LE) + 裸数据。
  // 判据与 binwalk 一致：props 合法(≤224) + 字典大小是 2^n 或 1.5*2^n。
  const LZMA_DICT_SIZES = (() => {
    const s = new Set();
    for (let n = 12; n <= 30; n++) { s.add(2 ** n); s.add(2 ** n + 2 ** (n - 1)); }
    return s;
  })();

  function isLzmaAlone(b, i) {
    if (i + 14 > b.length) return false;
    if (b[i] > 224) return false;
    const dict = (b[i + 1] | (b[i + 2] << 8) | (b[i + 3] << 16) | (b[i + 4] << 24)) >>> 0;
    if (!LZMA_DICT_SIZES.has(dict)) return false;
    const lo = (b[i + 5] | (b[i + 6] << 8) | (b[i + 7] << 16) | (b[i + 8] << 24)) >>> 0;
    const hi = (b[i + 9] | (b[i + 10] << 8) | (b[i + 11] << 16) | (b[i + 12] << 24)) >>> 0;
    // 原长字段：全 0xff = 未知；否则应当是 ≤256MB 的实际长度
    return (hi === 0xFFFFFFFF && lo === 0xFFFFFFFF) || (hi === 0 && lo <= 0x10000000);
  }

  function findStreamSignatures(input, from, to) {
    const b = toU8(input);
    const s = from || 0;
    const e = to === undefined ? b.length : Math.min(b.length, to);
    const hits = [];
    for (let i = s; i + 8 < e; i++) {
      if (b[i] === 0x78 && isZlibHeader(b, i)) hits.push({ kind: 'zlib', offset: i });
      // gzip 头：0x1F8B + CM=8（deflate）+ FLG 保留位为 0。随机数据里 1F 8B 每 64KB 就有一个，
      // 而头部假阳性会触发一次很贵的 inflate（实测平均 25ms/次），所以这里按 RFC 1952 收紧。
      else if (b[i] === 0x1F && b[i + 1] === 0x8B && b[i + 2] === 8 && (b[i + 3] & 0xE0) === 0) hits.push({ kind: 'gzip', offset: i });
      else if (b[i] === 0x50 && b[i + 1] === 0x4B && b[i + 2] === 0x03 && b[i + 3] === 0x04) hits.push({ kind: 'zip', offset: i });
      // PNG 要 8 字节全签名：只认前 4 字节的话随机数据每 4GB 就有一次假命中，
      // 而一次假命中会切出一个几 MB 的产物、再被递归扫一遍（实测 20MB 随机数据多花 6 秒）。
      else if (b[i] === 0x89 && b[i + 1] === 0x50 && b[i + 2] === 0x4E && b[i + 3] === 0x47 &&
        b[i + 4] === 0x0D && b[i + 5] === 0x0A && b[i + 6] === 0x1A && b[i + 7] === 0x0A) hits.push({ kind: 'png', offset: i });
      // JPEG 的 SOI 后面必须紧跟一个合法的段标记（0xC0–0xFE，且不是 0xFF）
      else if (b[i] === 0xFF && b[i + 1] === 0xD8 && b[i + 2] === 0xFF && b[i + 3] >= 0xC0 && b[i + 3] !== 0xFF) hits.push({ kind: 'jpeg', offset: i });
      else if (isLzmaAlone(b, i)) hits.push({ kind: 'lzma', offset: i });
    }
    return hits;
  }

  // CRC32 反查：已知目标 CRC，枚举短字符串（ZIP 短条目内容/口令的常见考法）
  // 支持已知前缀/后缀，例如 prefix="flag{" suffix="}"；默认只到 4 位，避免页面卡死。
  function crc32Brute(target, opts) {
    const o = opts || {};
    const charset = String(o.charset || 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ!-@_{}');
    const minLen = Math.max(1, Math.min(8, Math.floor(o.minLen || 1)));
    const maxLen = Math.max(minLen, Math.min(8, Math.floor(o.maxLen || 4)));
    const prefix = String(o.prefix || '');
    const suffix = String(o.suffix || '');
    const maxHits = Math.max(1, Math.min(256, Math.floor(o.maxHits || 32)));
    const limitMs = Math.max(200, Math.min(120000, Math.floor(o.limitMs || 15000)));
    const enc = s => Array.from(s, ch => ch.charCodeAt(0) & 255);
    const pre = enc(prefix), suf = enc(suffix);
    const alpha = Array.from(new Set(Array.from(charset)));
    if (!alpha.length) return { hits: [], tried: 0, truncated: false, elapsed: 0, error: '字符集为空' };
    const want = target >>> 0;
    const t0 = Date.now();
    let tried = 0, truncated = false;
    const hits = [];
    const cand = new Array(maxLen);
    const feed = (c, byte) => CRC_TABLE[(c ^ byte) & 0xFF] ^ (c >>> 8);
    let state0 = 0xFFFFFFFF;
    for (const b of pre) state0 = feed(state0, b);

    function check(depth, state) {
      let c = state;
      for (const b of suf) c = feed(c, b);
      if (((c ^ 0xFFFFFFFF) >>> 0) === want) hits.push(cand.slice(0, depth).join(''));
    }

    function walk(depth, state) {
      if (hits.length >= maxHits || truncated) return;
      if (depth >= minLen) check(depth, state);
      if (depth >= maxLen) return;
      for (const ch of alpha) {
        let c = state;
        for (const b of enc(ch)) c = feed(c, b);
        cand[depth] = ch;
        tried++;
        if ((tried & 0x3FFF) === 0 && Date.now() - t0 > limitMs) { truncated = true; return; }
        walk(depth + 1, c);
        if (hits.length >= maxHits || truncated) return;
      }
    }

    walk(0, state0);
    return { hits, tried, truncated, elapsed: Date.now() - t0 };
  }

  Object.assign(MDZ, {
    crc32, adler32, inflateRaw, inflateZlib, inflateGzip,
    isZlibHeader, isLzmaAlone, findStreamSignatures, crc32Brute
  });
})(typeof globalThis !== 'undefined' ? globalThis : this);
