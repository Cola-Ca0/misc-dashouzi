/* misc大手子 — 13 LZMA / LZMA2 / XZ 解压
 * .lzma = 1 字节属性(lc/lp/pb) + 4 字节字典大小 + 8 字节原始长度(LE，全 FF = 未知) + 范围编码数据
 * .xz   = 流头 + 若干块（过滤器链，支持 LZMA2 / Delta）+ 块校验
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

  function createModel(lc, lp, pb) {
    const m = {
      lc, lp, pb,
      probs: new Uint16Array(O_LITERAL + (0x300 << (lc + lp))),
      state: 0, rep0: 0, rep1: 0, rep2: 0, rep3: 0,
      resetProbs() { this.probs.fill(PROB_INIT); },
      resetState() { this.state = 0; this.rep0 = this.rep1 = this.rep2 = this.rep3 = 0; }
    };
    m.resetProbs();
    return m;
  }

  // 范围解码器核心：LZMA1 与 LZMA2 共用。
  // host 提供 outLen / at / push / copyMatch / floor；limit 是本次要产出的字节数。
  function decodeRange(b, start, model, host, limit, opts) {
    const o = opts || {};
    let pos = start;
    let range = 0xFFFFFFFF, code = 0;
    for (let i = 0; i < 5; i++) code = ((code << 8) | (pos < b.length ? b[pos++] : 0)) >>> 0;

    const probs = model.probs;
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

    const baseOut = host.outLen;
    const pbMask = (1 << model.pb) - 1;
    const lpMask = (1 << model.lp) - 1;
    let err = null, endMarker = false;
    try {
      while (host.outLen - baseOut < limit) {
        if (o.stopAtInputEnd && pos >= b.length && host.outLen > baseOut) break;
        const posState = host.outLen & pbMask;
        if (decodeBit(O_IS_MATCH, (model.state << 4) + posState) === 0) {
          const prevByte = host.outLen > 0 ? host.at(host.outLen - 1) : 0;
          const litBase = O_LITERAL + 0x300 * (((host.outLen & lpMask) << model.lc) + (prevByte >>> (8 - model.lc)));
          let symbol = 1;
          if (model.state >= 7) {
            let matchByte = host.at(host.outLen - model.rep0 - 1);
            do {
              const matchBit = (matchByte >> 7) & 1;
              matchByte <<= 1;
              const bit = decodeBit(litBase, ((1 + matchBit) << 8) + symbol);
              symbol = (symbol << 1) | bit;
              if (matchBit !== bit) break;
            } while (symbol < 0x100);
          }
          while (symbol < 0x100) symbol = (symbol << 1) | decodeBit(litBase, symbol);
          host.push(symbol & 0xFF);
          model.state = model.state < 4 ? 0 : model.state < 10 ? model.state - 3 : model.state - 6;
          continue;
        }
        if (decodeBit(O_IS_REP, model.state) === 1) {
          if (decodeBit(O_IS_REP_G0, model.state) === 0) {
            if (decodeBit(O_IS_REP0_LONG, (model.state << 4) + posState) === 0) {
              model.state = model.state < 7 ? 9 : 11;
              host.push(host.at(host.outLen - model.rep0 - 1));
              continue;
            }
          } else {
            let dist;
            if (decodeBit(O_IS_REP_G1, model.state) === 0) dist = model.rep1;
            else {
              if (decodeBit(O_IS_REP_G2, model.state) === 0) dist = model.rep2;
              else { dist = model.rep3; model.rep3 = model.rep2; }
              model.rep2 = model.rep1;
            }
            model.rep1 = model.rep0;
            model.rep0 = dist;
          }
          const len = decodeLen(O_REP_LEN, posState) + MATCH_MIN_LEN;
          model.state = model.state < 7 ? 8 : 11;
          host.copyMatch(model.rep0, len);
          continue;
        }
        model.rep3 = model.rep2;
        model.rep2 = model.rep1;
        model.rep1 = model.rep0;
        const len = decodeLen(O_LEN, posState) + MATCH_MIN_LEN;
        model.state = model.state < 7 ? 7 : 10;
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
        model.rep0 = dist;
        if (dist === 0xFFFFFFFF) {
          if (o.endMarker) { endMarker = true; break; }
          throw new Error('非法的结束标记');
        }
        host.copyMatch(dist, len);
      }
    } catch (e) {
      err = String(e && e.message || e);
    }
    return { produced: host.outLen - baseOut, consumed: pos - start, endMarker, error: err };
  }

  // ---------- LZMA 单独格式 ----------
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

    const model = createModel(lc, lp, pb);
    const out = known ? new Uint8Array(declared) : null;
    let dyn = out ? null : new Uint8Array(Math.min(maxOut, 1 << 16));
    const host = {
      outLen: 0,
      floor: 0,
      at(i) { return out ? out[i] : dyn[i]; },
      push(byte) {
        if (out) {
          if (this.outLen >= out.length) throw new Error('输出超过声明长度');
          out[this.outLen++] = byte;
          return;
        }
        if (this.outLen >= dyn.length) {
          if (dyn.length >= maxOut) throw new Error('输出超过上限');
          const g = new Uint8Array(Math.min(maxOut, dyn.length * 2));
          g.set(dyn);
          dyn = g;
        }
        dyn[this.outLen++] = byte;
      },
      copyMatch(dist, len) {
        if (dist + 1 > this.outLen - this.floor) throw new Error('回溯距离越界');
        for (let i = 0; i < len; i++) this.push(this.at(this.outLen - dist - 1));
      }
    };
    const r = decodeRange(b, 13, model, host, known ? declared : maxOut, { endMarker: true, stopAtInputEnd: !known });
    const res = out ? out.subarray(0, host.outLen) : dyn.subarray(0, host.outLen);
    return {
      out: res.length ? res : null,
      error: r.error,
      partial: !!r.error,
      declared: known ? declared : null,
      dictSize,
      props: { lc, lp, pb }
    };
  }

  // ---------- LZMA2 ----------
  function lzma2Decompress(input, start, maxOut) {
    const b = input;
    const max = maxOut || 64 * 1024 * 1024;
    let out = new Uint8Array(Math.min(max, 1 << 20));
    const host = {
      outLen: 0,
      floor: 0,
      at(i) { return out[i]; },
      push(v) {
        if (this.outLen >= out.length) {
          if (out.length >= max) throw new Error('解压超过上限');
          const g = new Uint8Array(Math.min(max, out.length * 2));
          g.set(out);
          out = g;
        }
        out[this.outLen++] = v;
      },
      copyMatch(dist, len) {
        if (dist + 1 > this.outLen - this.floor) throw new Error('LZMA2 回溯越界');
        for (let i = 0; i < len; i++) this.push(this.at(this.outLen - dist - 1));
      }
    };
    let model = createModel(3, 0, 2);
    let propsSet = false;
    let p = start, consumed = 0, error = null;
    while (p < b.length) {
      const control = b[p];
      if (control === 0) { p++; consumed = p - start; break; }
      if (control < 0x80) {
        if (control !== 1 && control !== 2) { error = 'LZMA2 控制字节非法（' + control + '）'; break; }
        if (p + 3 > b.length) { error = 'LZMA2 头截断'; break; }
        const size = ((b[p + 1] << 8) | b[p + 2]) + 1;
        p += 3;
        if (p + size > b.length) { error = 'LZMA2 未压缩块截断'; break; }
        if (control === 1) host.floor = host.outLen;
        for (let i = 0; i < size; i++) host.push(b[p++]);
        consumed = p - start;
        continue;
      }
      p++;   // 控制字节
      if (p + 4 > b.length) { error = 'LZMA2 压缩块头截断'; break; }
      const reset = (control >> 5) & 3;
      const unpacked = (((control & 0x1F) << 16) | (b[p] << 8) | b[p + 1]) + 1;
      p += 2;
      const packed = ((b[p] << 8) | b[p + 1]) + 1;
      p += 2;
      if (reset >= 2) {
        if (p >= b.length) { error = 'LZMA2 属性字节缺失'; break; }
        const props = b[p++];
        if (props >= 9 * 5 * 5) { error = 'LZMA2 属性字节非法'; break; }
        const lc = props % 9, lp = Math.floor(props / 9) % 5, pb = Math.floor(props / 45);
        model = createModel(lc, lp, pb);
        propsSet = true;
      } else if (!propsSet) {
        error = '首个 LZMA2 压缩块没有属性字节';
        break;
      }
      if (reset >= 1) model.resetState();
      if (reset === 3) host.floor = host.outLen;
      if (p + packed > b.length) { error = 'LZMA2 压缩数据截断'; break; }
      const r = decodeRange(b.subarray(p, p + packed), 0, model, host, unpacked, { endMarker: false });
      p += packed;
      if (r.error) { error = r.error; break; }
      if (r.produced !== unpacked) { error = 'LZMA2 未解满 ' + unpacked + ' 字节'; break; }
      consumed = p - start;
    }
    return { out: out.subarray(0, host.outLen), consumed, error, outputLen: host.outLen };
  }

  // ---------- XZ ----------
  function le32(b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0; }

  // CRC-64/XZ（反射多项式 0xC96C5795D7870F42）。JS 没有 64 位整数运算，
  // 拆成高低 32 位两张表；init/xorout 都是全 F。
  const CRC64 = (() => {
    const hi = new Uint32Array(256), lo = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let h = 0, l = i;
      for (let k = 0; k < 8; k++) {
        const bit = l & 1;
        l = ((l >>> 1) | (h << 31)) >>> 0;
        h = h >>> 1;
        if (bit) { l = (l ^ 0xD7870F42) >>> 0; h = (h ^ 0xC96C5795) >>> 0; }
      }
      hi[i] = h; lo[i] = l;
    }
    return { hi, lo };
  })();
  function crc64(bytes) {
    let h = 0xFFFFFFFF, l = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) {
      const idx = (l ^ bytes[i]) & 0xFF;
      l = (((l >>> 8) | (h << 24)) ^ CRC64.lo[idx]) >>> 0;
      h = ((h >>> 8) ^ CRC64.hi[idx]) >>> 0;
    }
    return { hi: (h ^ 0xFFFFFFFF) >>> 0, lo: (l ^ 0xFFFFFFFF) >>> 0 };
  }

  function xzVli(b, p) {
    let v = 0, shift = 0, c;
    do {
      if (p >= b.length) return { value: -1, next: p };
      c = b[p++];
      v += (c & 0x7f) * Math.pow(2, shift);
      shift += 7;
    } while (c & 0x80);
    return { value: v, next: p };
  }

  // x87 BCJ 的 x86 分支（CALL/JMP 相对地址转绝对）。数组与状态机照 liblzma x86.c。
  const BCJ_MASK_ALLOWED = [true, true, true, false, true, false, false, false];
  const BCJ_MASK_BIT = [0, 1, 2, 2, 3, 3, 3, 3];
  function bcjX86Decode(data) {
    const n = data.length;
    if (n <= 4) return;
    const test = b => b === 0 || b === 0xFF;
    let prevPos = -5, prevMask = 0;
    for (let i = 0; i < n - 4; i++) {
      if ((data[i] & 0xFE) !== 0xE8) continue;
      const offset = i - prevPos;
      if (offset > 3) {
        prevMask = 0;
      } else {
        prevMask = (prevMask << (offset - 1)) & 7;
        if (prevMask !== 0) {
          const b = data[i + 4 - BCJ_MASK_BIT[prevMask]];
          if (!BCJ_MASK_ALLOWED[prevMask] || test(b)) {
            prevPos = i;
            prevMask = (prevMask << 1) | 1;
            continue;
          }
        }
      }
      prevPos = i;
      if (test(data[i + 4])) {
        let src = ((data[i + 4] << 24) | (data[i + 3] << 16) | (data[i + 2] << 8) | data[i + 1]) >>> 0;
        let dest = 0;
        while (true) {
          dest = (src - (i + 5)) >>> 0;
          if (prevMask === 0) break;
          const bit = BCJ_MASK_BIT[prevMask] * 8;
          const b = (dest >>> (24 - bit)) & 0xFF;
          if (!test(b)) break;
          src = (dest ^ (0xFFFFFFFF >>> bit)) >>> 0;
        }
        data[i + 4] = (~((((dest >>> 24) & 1) - 1))) & 0xFF;
        data[i + 3] = (dest >>> 16) & 0xFF;
        data[i + 2] = (dest >>> 8) & 0xFF;
        data[i + 1] = dest & 0xFF;
        i += 4;
      } else {
        prevMask |= 1;
        if (test(data[i + 4 - BCJ_MASK_BIT[prevMask]])) prevMask |= 2;
      }
    }
  }

  function xzDecompress(input, opts) {
    const o = opts || {};
    const b = input instanceof Uint8Array ? input : new Uint8Array(input || []);
    if (b.length < 24 || b[0] !== 0xFD || b[1] !== 0x37 || b[2] !== 0x7A || b[3] !== 0x58 || b[4] !== 0x5A || b[5] !== 0x00) {
      return { out: null, error: '不是 XZ' };
    }
    const maxOut = o.maxOut || 64 * 1024 * 1024;
    const warnings = [];
    const chunks = [];
    let p = 0, blocks = 0, total = 0, error = null, streams = 0, lastCheck = -1, verifiedChecks = 0, tail = null;
    while (p + 12 <= b.length && !error) {
      if (!(b[p] === 0xFD && b[p + 1] === 0x37 && b[p + 2] === 0x7A && b[p + 3] === 0x58 && b[p + 4] === 0x5A && b[p + 5] === 0x00)) {
        // 连接流之间的 padding 必须是 4 字节的零
        if (b[p] === 0 && b[p + 1] === 0 && b[p + 2] === 0 && b[p + 3] === 0) { p += 4; continue; }
        // 已经完整读过至少一个流：后面不是下一个流也不是 padding，就是尾部附加数据。
        if (streams > 0) { tail = b.subarray(p); break; }
        error = 'XZ 流头魔数不符';
        break;
      }
      const checkType = ((b[p + 6] << 8) | b[p + 7]) & 0x0F;
      const checkSize = { 0: 0, 1: 4, 4: 8, 10: 32 }[checkType];
      if (checkSize === undefined) { error = 'XZ 校验类型 ' + checkType + ' 不支持'; break; }
      lastCheck = checkType;
      if (MDZ.crc32 && MDZ.crc32(b.subarray(p + 6, p + 8)) !== le32(b, p + 8)) warnings.push('流头 CRC32 不匹配');
      streams++;
      p += 12;
      while (p < b.length && !error) {
        if (b[p] === 0) break;   // index 指示符
        const headerStart = p;
        const headerSize = (b[p] + 1) * 4;
        if (p + headerSize > b.length) { error = 'XZ 块头越界'; break; }
        const headerEnd = p + headerSize;
        if (MDZ.crc32 && MDZ.crc32(b.subarray(headerStart, headerEnd - 4)) !== le32(b, headerEnd - 4)) warnings.push('块头 CRC32 不匹配');
        const flags = b[p + 1];
        let q = p + 2;
        let compSize = -1, uncompSize = -1;
        if (flags & 0x40) { const v = xzVli(b, q); compSize = v.value; q = v.next; }
        if (flags & 0x80) { const v = xzVli(b, q); uncompSize = v.value; q = v.next; }
        const nFilters = (flags & 0x03) + 1;
        // 头部顺序 = 编码顺序（最后一项一定是 LZMA2）；解码要倒着走。
        let dictProp = -1, unsupported = '';
        const filters = [];
        for (let i = 0; i < nFilters; i++) {
          const id = xzVli(b, q); q = id.next;
          const ps = xzVli(b, q); q = ps.next;
          if (id.value < 0 || ps.value < 0 || q + ps.value > headerEnd - 4) { unsupported = '过滤属性越界'; break; }
          if (id.value === 0x21) {
            if (ps.value !== 1) unsupported = 'LZMA2 属性长度异常';
            else dictProp = b[q];
          } else if (id.value === 0x03) {
            if (ps.value !== 1) unsupported = 'Delta 属性长度异常';
            else filters.push({ delta: b[q] + 1 });   // 属性 = 距离 - 1，合法 1..256
          } else if (id.value === 0x04 && ps.value === 0) {
            filters.push({ bcj: true });
          } else {
            unsupported = 'XZ 过滤器 0x' + id.value.toString(16) + ' 暂不支持（仅 x86 BCJ / Delta）';
          }
          q += ps.value;
        }
        if (unsupported) { error = unsupported; break; }
        if (dictProp < 0) { error = 'XZ 块里没有 LZMA2 过滤器'; break; }
        const dataStart = headerEnd;
        const lz = lzma2Decompress(b, dataStart, maxOut - total);
        if (!lz.out || lz.error) { error = lz.error || 'LZMA2 解压失败'; break; }
        const data = lz.out;
        // 反向应用过滤器：头部 [x86, delta, lzma2] 解码顺序是 lzma2 → delta → x86。
        for (let fi = filters.length - 1; fi >= 0; fi--) {
          const f = filters[fi];
          if (f.bcj) bcjX86Decode(data);
          else if (f.delta) {
            const d = f.delta;
            for (let i = d; i < data.length; i++) data[i] = (data[i] + data[i - d]) & 255;
          }
        }
        p = dataStart + lz.consumed;
        const pad = (4 - ((p - dataStart) % 4)) % 4;
        p += pad;
        if (p + checkSize > b.length) { error = 'XZ 块校验字段越界'; break; }
        if (checkType === 1 && MDZ.crc32) {
          verifiedChecks++;
          if ((MDZ.crc32(data) >>> 0) !== le32(b, p)) warnings.push('块数据 CRC32 不匹配');
        } else if (checkType === 4) {
          verifiedChecks++;
          const c = crc64(data);
          if (c.lo !== le32(b, p) || c.hi !== le32(b, p + 4)) warnings.push('块数据 CRC64 不匹配');
        } else if (checkType === 10 && MDZ.sha256) {
          verifiedChecks++;
          if (MDZ.sha256(data) !== MDZ.bytesToHex(b.subarray(p, p + 32))) warnings.push('块数据 SHA-256 不匹配');
        }
        p += checkSize;
        if (compSize >= 0 && compSize !== lz.consumed) warnings.push('压缩大小字段不一致');
        if (uncompSize >= 0 && uncompSize !== data.length) warnings.push('解压大小字段不一致');
        chunks.push(data);
        total += data.length;
        blocks++;
        if (total > maxOut) { error = '解压超过上限'; break; }
        if (lz.consumed <= 0) { error = 'LZMA2 没有前进'; break; }
      }
      if (error) break;
      if (p >= b.length || b[p] !== 0) { error = 'XZ 缺少 index'; break; }
      const indexStart = p;
      p++;
      const nrec = xzVli(b, p);
      if (!nrec || nrec.value < 0) { error = 'XZ index 截断'; break; }
      p = nrec.next;
      for (let i = 0; i < nrec.value; i++) {
        const a = xzVli(b, p); if (!a || a.value < 0) { error = 'XZ index 记录截断'; break; }
        const c = xzVli(b, a.next); if (!c || c.value < 0) { error = 'XZ index 记录截断'; break; }
        p = c.next;
      }
      if (error) break;
      while ((p - indexStart) % 4 !== 0) p++;
      p += 4;   // index CRC32
      if (p + 12 > b.length) { error = 'XZ footer 越界'; break; }
      if (b[p + 10] !== 0x59 || b[p + 11] !== 0x5A) { error = 'XZ footer 魔数不符'; break; }
      p += 12;
    }
    const out = new Uint8Array(total);
    let at = 0;
    for (const c of chunks) { out.set(c, at); at += c.length; }
    if (!error && !tail && p < b.length) {
      const rest = b.subarray(p);
      if (rest.some(x => x !== 0)) tail = rest;
    }
    return { out, error, warnings, blocks, checkType: lastCheck, streams, verifiedChecks, tail };
  }

  Object.assign(MDZ, { lzmaDecompressAlone, lzma2Decompress, xzDecompress, bcjX86Decode });
})(typeof globalThis !== 'undefined' ? globalThis : this);
