/* misc大手子 — 13 LZMA 单独格式解压
 * .lzma = 1 字节属性(lc/lp/pb) + 4 字节字典大小 + 8 字节原始长度(LE，全 FF = 未知) + 范围编码数据
 * 纯 JS，浏览器与 Node 通用；不依赖 xz / companion。
 */
(function (root) {
  'use strict';
  const MDZ = root.MDZ = root.MDZ || {};

  const NUM_STATES = 12;
  const POS_STATES_MAX = 16;
  const LEN_TO_POS_STATES = 4;
  const END_POS_MODEL_INDEX = 14;
  const POS_SLOT_BITS = 6;
  const FULL_DISTANCES = 1 << (END_POS_MODEL_INDEX >> 1);   // 128
  const ALIGN_BITS = 4;
  const MATCH_MIN_LEN = 2;
  const PROB_INIT = 1024;

  // 概率表按固定布局塞进一个 Uint16Array
  const O_IS_MATCH = 0;                                   // 12 * 16
  const O_IS_REP = O_IS_MATCH + NUM_STATES * POS_STATES_MAX;
  const O_IS_REP_G0 = O_IS_REP + NUM_STATES;
  const O_IS_REP_G1 = O_IS_REP_G0 + NUM_STATES;
  const O_IS_REP_G2 = O_IS_REP_G1 + NUM_STATES;
  const O_IS_REP0_LONG = O_IS_REP_G2 + NUM_STATES;        // 12 * 16
  const O_POS_SLOT = O_IS_REP0_LONG + NUM_STATES * POS_STATES_MAX;
  const O_SPEC_POS = O_POS_SLOT + LEN_TO_POS_STATES * (1 << POS_SLOT_BITS);
  const O_ALIGN = O_SPEC_POS + (FULL_DISTANCES - END_POS_MODEL_INDEX);
  const O_LEN = O_ALIGN + (1 << ALIGN_BITS);
  const O_REP_LEN = O_LEN + 514;
  const O_LITERAL = O_REP_LEN + 514;
  // 长度编码器：choice(1) + choice2(1) + low(16*8) + mid(16*8) + high(256) = 514

  function lzmaDecompressAlone(input, opts) {
    const o = opts || {};
    const b = input instanceof Uint8Array ? input : new Uint8Array(input || []);
    if (!b || b.length < 13) return { out: null, error: '数据不足 13 字节' };
    const props = b[0];
    if (props >= 9 * 5 * 5) return { out: null, error: '属性字节非法（' + props + '）' };
    const lc = props % 9;
    const lp = Math.floor(props / 9) % 5;
    const pb = Math.floor(props / 45);
    const dictSize = (b[1] | (b[2] << 8) | (b[3] << 16) | (b[4] << 24)) >>> 0;
    const lo = (b[5] | (b[6] << 8) | (b[7] << 16) | (b[8] << 24)) >>> 0;
    const hi = (b[9] | (b[10] << 8) | (b[11] << 16) | (b[12] << 24)) >>> 0;
    const known = !(lo === 0xFFFFFFFF && hi === 0xFFFFFFFF);
    const declared = known ? hi * 4294967296 + lo : -1;
    const maxOut = o.maxOut || 64 * 1024 * 1024;
    if (declared > maxOut) return { out: null, error: '声明解压后 ' + declared + ' 字节，超过上限' };

    const probs = new Uint16Array(O_LITERAL + (0x300 << (lc + lp)));
    probs.fill(PROB_INIT);

    let pos = 13;
    let range = 0xFFFFFFFF, code = 0;
    for (let i = 0; i < 5; i++) code = ((code << 8) | (pos < b.length ? b[pos++] : 0)) >>> 0;

    function normalize() {
      if (range < 0x1000000) {
        range = (range << 8) >>> 0;
        code = ((code << 8) | (pos < b.length ? b[pos++] : 0)) >>> 0;
      }
    }
    function decodeBit(base, i) {
      normalize();
      const p = probs[base + i];
      const bound = (range >>> 11) * p;
      if (code < bound) {
        range = bound >>> 0;
        probs[base + i] = p + ((2048 - p) >> 5);
        return 0;
      }
      range = (range - bound) >>> 0;
      code = (code - bound) >>> 0;
      probs[base + i] = p - (p >> 5);
      return 1;
    }
    function directBits(numBits) {
      let res = 0;
      for (let i = 0; i < numBits; i++) {
        normalize();
        range = range >>> 1;
        let t = 0;
        if (code >= range) { code = (code - range) >>> 0; t = 1; }
        res = res * 2 + t;
      }
      return res;
    }
    function bitTree(base, numBits) {
      let m = 1;
      for (let i = 0; i < numBits; i++) m = (m << 1) | decodeBit(base, m);
      return m - (1 << numBits);
    }
    function bitTreeRev(base, numBits) {
      let m = 1, sym = 0;
      for (let i = 0; i < numBits; i++) {
        const bit = decodeBit(base, m);
        m = (m << 1) | bit;
        sym |= bit << i;
      }
      return sym;
    }
    function decodeLen(base, posState) {
      if (decodeBit(base, 0) === 0) return bitTree(base + 2 + posState * 8, 3);
      if (decodeBit(base, 1) === 0) return 8 + bitTree(base + 2 + 128 + posState * 8, 3);
      return 16 + bitTree(base + 2 + 256, 8);
    }

    const out = known ? new Uint8Array(declared) : null;
    let dyn = out ? null : new Uint8Array(Math.min(maxOut, 1 << 16));
    let outLen = 0;
    const at = i => (out ? out[i] : dyn[i]);
    function push(byte) {
      if (out) {
        if (outLen >= out.length) throw new Error('输出超过声明长度');
        out[outLen++] = byte;
        return;
      }
      if (outLen >= dyn.length) {
        if (dyn.length >= maxOut) throw new Error('输出超过上限');
        const g = new Uint8Array(Math.min(maxOut, dyn.length * 2));
        g.set(dyn);
        dyn = g;
      }
      dyn[outLen++] = byte;
    }
    function copyMatch(dist, len) {
      if (dist + 1 > outLen) throw new Error('回溯距离越界');
      for (let i = 0; i < len; i++) push(at(outLen - dist - 1));
    }

    const pbMask = (1 << pb) - 1;
    const lpMask = (1 << lp) - 1;
    const limit = known ? declared : maxOut;
    let state = 0, rep0 = 0, rep1 = 0, rep2 = 0, rep3 = 0;
    let err = null;
    try {
      while (outLen < limit) {
        if (!known && pos >= b.length && outLen > 0) break;
        const posState = outLen & pbMask;
        if (decodeBit(O_IS_MATCH, (state << 4) + posState) === 0) {
          const prevByte = outLen > 0 ? at(outLen - 1) : 0;
          const litBase = O_LITERAL + 0x300 * (((outLen & lpMask) << lc) + (prevByte >>> (8 - lc)));
          let symbol = 1;
          if (state >= 7) {
            let matchByte = at(outLen - rep0 - 1);
            do {
              const matchBit = (matchByte >> 7) & 1;
              matchByte <<= 1;
              const bit = decodeBit(litBase, ((1 + matchBit) << 8) + symbol);
              symbol = (symbol << 1) | bit;
              if (matchBit !== bit) break;
            } while (symbol < 0x100);
          }
          while (symbol < 0x100) symbol = (symbol << 1) | decodeBit(litBase, symbol);
          push(symbol & 0xFF);
          state = state < 4 ? 0 : state < 10 ? state - 3 : state - 6;
          continue;
        }
        if (decodeBit(O_IS_REP, state) === 1) {
          if (decodeBit(O_IS_REP_G0, state) === 0) {
            if (decodeBit(O_IS_REP0_LONG, (state << 4) + posState) === 0) {
              state = state < 7 ? 9 : 11;
              push(at(outLen - rep0 - 1));
              continue;
            }
          } else {
            let dist;
            if (decodeBit(O_IS_REP_G1, state) === 0) dist = rep1;
            else {
              if (decodeBit(O_IS_REP_G2, state) === 0) dist = rep2;
              else { dist = rep3; rep3 = rep2; }
              rep2 = rep1;
            }
            rep1 = rep0;
            rep0 = dist;
          }
          const len = decodeLen(O_REP_LEN, posState) + MATCH_MIN_LEN;
          state = state < 7 ? 8 : 11;
          copyMatch(rep0, len);
          continue;
        }
        rep3 = rep2;
        rep2 = rep1;
        rep1 = rep0;
        const len = decodeLen(O_LEN, posState) + MATCH_MIN_LEN;
        state = state < 7 ? 7 : 10;
        const lenState = Math.min(len - MATCH_MIN_LEN, LEN_TO_POS_STATES - 1);
        const posSlot = bitTree(O_POS_SLOT + lenState * (1 << POS_SLOT_BITS), POS_SLOT_BITS);
        let dist;
        if (posSlot < 4) {
          dist = posSlot;
        } else {
          const numDirect = (posSlot >> 1) - 1;
          dist = ((2 | (posSlot & 1)) << numDirect) >>> 0;   // 必须无符号：30 位时 << 会变负数
          if (posSlot < END_POS_MODEL_INDEX) {
            dist += bitTreeRev(O_SPEC_POS + dist - posSlot - 1, numDirect);
          } else {
            dist += directBits(numDirect - ALIGN_BITS) * (1 << ALIGN_BITS);
            dist += bitTreeRev(O_ALIGN, ALIGN_BITS);
          }
        }
        rep0 = dist;
        if (dist === 0xFFFFFFFF) break;   // 结束标记（.lzma 原长未知时靠它收尾）
        copyMatch(dist, len);
      }
    } catch (e) {
      err = String(e && e.message || e);
    }

    const res = out ? out.subarray(0, outLen) : dyn.subarray(0, outLen);
    return {
      out: res.length ? res : null,
      error: err,
      partial: !!err,
      declared: known ? declared : null,
      dictSize,
      props: { lc, lp, pb }
    };
  }

  Object.assign(MDZ, { lzmaDecompressAlone });
})(typeof globalThis !== 'undefined' ? globalThis : this);
