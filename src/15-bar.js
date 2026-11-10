/* misc大手子 — 15 一维条码
 * EAN-13 / EAN-8 / Code 128 / Code 39：灰度扫描线 + 游程解码
 * 只处理正拍/扫描件（水平或竖直）；倾斜请先转正再喂进来。
 * 每种码都有强校验：EAN 校验位、Code128 mod-103、Code39 起止星号。
 */
(function (root) {
  'use strict';
  const MDZ = root.MDZ = root.MDZ || {};

  // ---------- Code 39：9 个元素（bar,space,bar,...）的宽窄图样，1=宽 ----------
  const C39 = {
    '0': '000110100', '1': '100100001', '2': '001100001', '3': '101100000', '4': '000110001',
    '5': '100110000', '6': '001110000', '7': '000100101', '8': '100100100', '9': '001100100',
    'A': '100001001', 'B': '001001001', 'C': '101001000', 'D': '000011001', 'E': '100011000',
    'F': '001011000', 'G': '000001101', 'H': '100001100', 'I': '001001100', 'J': '000011100',
    'K': '100000011', 'L': '001000011', 'M': '101000010', 'N': '000010011', 'O': '100010010',
    'P': '001010010', 'Q': '000000111', 'R': '100000110', 'S': '001000110', 'T': '000010110',
    'U': '110000001', 'V': '011000001', 'W': '111000000', 'X': '010010001', 'Y': '110010000',
    'Z': '011010000', '-': '010000101', '.': '110000100', ' ': '011000100',
    '$': '010101000', '/': '010100010', '+': '010001010', '%': '000101010', '*': '010010100'
  };
  const C39_REV = {};
  for (const k in C39) C39_REV[C39[k]] = k;

  // ---------- Code 128：0..105 每个 6 元素 11 模块，106 是 stop（7 元素 13 模块） ----------
  const C128 = (
    '212222 222122 222221 121223 121322 131222 122213 122312 132212 221213 ' +
    '221312 231212 112232 122132 122231 113222 123122 123221 223211 221132 ' +
    '221231 213212 223112 312131 311222 321122 321221 312212 322112 322211 ' +
    '212123 212321 232121 111323 131123 131321 112313 132113 132311 211313 ' +
    '231113 231311 112133 112331 132131 113123 113321 133121 313121 211331 ' +
    '231131 213113 213311 213131 311123 311321 331121 312113 312311 332111 ' +
    '314111 221411 431111 111224 111422 121124 121421 141122 141221 112214 ' +
    '112412 122114 122411 142112 142211 241211 221114 413111 241112 134111 ' +
    '111242 121142 121241 114212 124112 124211 411212 421112 421211 212141 ' +
    '214121 412121 111143 111341 131141 114113 114311 411113 411311 113141 ' +
    '114131 311141 411131 211412 211214 211232 2331112'
  ).split(' ');

  // ---------- EAN：L 码表；R = L 反码；G = R 镜像 ----------
  const EAN_L = ['0001101', '0011001', '0010011', '0111101', '0100011', '0110001', '0101111', '0111011', '0110111', '0001011'];
  const EAN_R = EAN_L.map(s => s.replace(/[01]/g, c => (c === '0' ? '1' : '0')));
  const EAN_G = EAN_R.map(s => s.split('').reverse().join(''));
  // 首位数字 → 左半 6 位的 L/G 排列（1=G）
  const EAN_PARITY = ['000000', '001011', '001101', '001110', '010011', '011001', '011100', '010101', '010110', '011010'];

  // ---------- 灰度 / 游程 ----------
  function otsu(hist, n) {
    let sum = 0;
    for (let i = 0; i < 256; i++) sum += i * hist[i];
    let wB = 0, sumB = 0, best = -1, thr = 128;
    for (let t = 0; t < 256; t++) {
      wB += hist[t];
      if (!wB) continue;
      const wF = n - wB;
      if (!wF) break;
      sumB += t * hist[t];
      const mB = sumB / wB, mF = (sum - sumB) / wF;
      const v = wB * wF * (mB - mF) * (mB - mF);
      if (v > best) { best = v; thr = t; }
    }
    return thr;
  }

  // 一条扫描线 → 游程（保证首尾都是黑条）
  function runsOf(getPx, n) {
    const vals = new Uint8Array(n);
    const hist = new Uint32Array(256);
    for (let i = 0; i < n; i++) { const v = getPx(i); vals[i] = v; hist[v]++; }
    const thr = otsu(hist, n);
    const runs = [];
    let dark = vals[0] <= thr;
    const firstDark = dark;
    runs.push(1);
    for (let i = 1; i < n; i++) {
      const d = vals[i] <= thr;
      if (d === dark) runs[runs.length - 1]++;
      else { dark = d; runs.push(1); }
    }
    if (!firstDark) runs.shift();          // 去掉左侧静区
    if (runs.length % 2 === 0) runs.pop(); // 去掉右侧静区（此时末位是亮）
    return runs;
  }

  // 把 n 条游程量化到 total 个模块；量化误差最大的一项逐格修正
  function quantizeAll(w, total) {
    const n = w.length;
    if (!n || n > total) return null;
    let sum = 0;
    for (let i = 0; i < n; i++) sum += w[i];
    if (!sum) return null;
    const m = sum / total;
    const q = new Array(n);
    let acc = 0;
    for (let i = 0; i < n; i++) {
      q[i] = Math.min(4, Math.max(1, Math.round(w[i] / m)));
      acc += q[i];
    }
    for (let guard = 0; acc !== total && guard < 32; guard++) {
      let bi = -1, be = 1e-9;
      if (acc < total) {
        for (let i = 0; i < n; i++) { const e = w[i] / m - q[i]; if (e > be) { be = e; bi = i; } }
        if (bi < 0 || q[bi] >= 4) return null;
        q[bi]++; acc++;
      } else {
        for (let i = 0; i < n; i++) { const e = q[i] - w[i] / m; if (e > be) { be = e; bi = i; } }
        if (bi < 0 || q[bi] <= 1) return null;
        q[bi]--; acc--;
      }
    }
    return acc === total ? q : null;
  }

  function bitsOf(q) {
    let s = '';
    for (let i = 0; i < q.length; i++) s += (i % 2 ? '0' : '1').repeat(q[i]);
    return s;
  }

  // ---------- EAN ----------
  function eanCheck(d, eight) {
    let s = 0;
    for (let i = 0; i < d.length; i++) {
      const w = eight ? (i % 2 === 0 ? 3 : 1) : (i % 2 ? 3 : 1);
      s += d[i] * w;
    }
    return (10 - (s % 10)) % 10;
  }

  function digitsOf(b, off, cnt, table) {
    let s = '';
    for (let i = 0; i < cnt; i++) {
      const k = table.indexOf(b.slice(off + i * 7, off + i * 7 + 7));
      if (k < 0) return null;
      s += k;
    }
    return s;
  }

  function ean13FromBits(b) {
    if (b.slice(0, 3) !== '101' || b.slice(45, 50) !== '01010' || b.slice(92, 95) !== '101') return null;
    let parity = '', left = '';
    for (let i = 0; i < 6; i++) {
      const g = b.slice(3 + i * 7, 10 + i * 7);
      const li = EAN_L.indexOf(g);
      if (li >= 0) { parity += '0'; left += li; continue; }
      const gi = EAN_G.indexOf(g);
      if (gi < 0) return null;
      parity += '1'; left += gi;
    }
    const first = EAN_PARITY.indexOf(parity);
    if (first < 0) return null;
    const right = digitsOf(b, 50, 6, EAN_R);
    if (!right) return null;
    const d = ('' + first + left + right).split('').map(Number);
    if (eanCheck(d.slice(0, 12), false) !== d[12]) return null;
    return { symbology: 'EAN-13', text: d.join('') };
  }

  function ean8FromBits(b) {
    if (b.slice(0, 3) !== '101' || b.slice(31, 36) !== '01010' || b.slice(64, 67) !== '101') return null;
    const left = digitsOf(b, 3, 4, EAN_L);
    const right = digitsOf(b, 36, 4, EAN_R);
    if (!left || !right) return null;
    const d = (left + right).split('').map(Number);
    if (eanCheck(d.slice(0, 7), true) !== d[7]) return null;
    return { symbology: 'EAN-8', text: d.join('') };
  }

  function decodeEAN(runs) {
    for (const [total, fn] of [[95, ean13FromBits], [67, ean8FromBits]]) {
      const q = quantizeAll(runs, total);
      if (!q) continue;
      const r = fn(bitsOf(q));
      if (r) return r;
    }
    return null;
  }

  // ---------- Code 128 ----------
  function c128Text(vals) {
    let mode = vals[0] === 103 ? 'A' : vals[0] === 104 ? 'B' : 'C';
    let out = '';
    for (let k = 1; k < vals.length - 1; k++) {
      const v = vals[k];
      if (mode === 'C') {
        if (v < 100) { out += String(v).padStart(2, '0'); continue; }
        if (v === 100) { mode = 'B'; continue; }
        if (v === 101) { mode = 'A'; continue; }
        return null;
      }
      if (v === 99) { mode = 'C'; continue; }
      if (v === 98) return null;      // SHIFT 单字符切换，misc 题里没见过
      if (v === 100 && mode === 'A') { mode = 'B'; continue; }
      if (v === 101 && mode === 'B') { mode = 'A'; continue; }
      if (v >= 96) return null;       // FNC1-4
      out += String.fromCharCode(mode === 'B' ? 32 + v : (v < 64 ? 32 + v : v - 64));
    }
    return out;
  }

  function decodeC128(runs) {
    const n = runs.length;
    if (n < 20) return null;
    const stop = quantizeAll(runs.slice(n - 7), 13);
    if (!stop || stop.join('') !== '2331112') return null;
    const body = n - 7;
    if (body % 6) return null;
    const vals = [];
    for (let i = 0; i < body; i += 6) {
      const q = quantizeAll(runs.slice(i, i + 6), 11);
      if (!q) return null;
      const v = C128.indexOf(q.join(''));
      if (v < 0 || v > 105) return null;
      vals.push(v);
    }
    if (vals.length < 3) return null;
    if (vals[0] !== 103 && vals[0] !== 104 && vals[0] !== 105) return null;
    // 最后一格是校验字符：check = (起始符 + Σ i·数据符) mod 103
    let sum = vals[0];
    for (let k = 1; k < vals.length - 1; k++) sum += k * vals[k];
    if (sum % 103 !== vals[vals.length - 1]) return null;
    const text = c128Text(vals);
    if (!text) return null;
    return { symbology: 'Code128', text };
  }

  // ---------- Code 39 ----------
  function decodeC39(runs) {
    const n = runs.length;
    if (n < 19) return null;
    const chars = [];
    for (let i = 0; i + 9 <= n; i += 10) {
      const w = runs.slice(i, i + 9);
      const srt = w.slice().sort((a, b) => a - b);
      if (srt[6] < srt[5] * 1.4) return null;   // 宽窄分不开
      const thr = (srt[5] + srt[6]) / 2;
      let pat = '';
      for (const v of w) pat += v > thr ? '1' : '0';
      const ch = C39_REV[pat];
      if (ch === undefined) return null;
      chars.push(ch);
    }
    if (chars.length < 3) return null;
    if (chars[0] !== '*' || chars[chars.length - 1] !== '*') return null;
    const text = chars.slice(1, -1).join('');
    return text ? { symbology: 'Code39', text } : null;
  }

  function decodeRuns(runs) {
    return decodeC128(runs) || decodeEAN(runs) || decodeC39(runs);
  }

  // ---------- 对外：RGBA → 条码 ----------
  function barDecodeRGBA(img, opts) {
    const o = opts || {};
    try {
      if (!img || !img.data || !(img.width > 0) || !(img.height > 0)) return [];
      const w = img.width, h = img.height;
      if (w * h > (o.maxPixels || 4000000) || w < 40 || h < 12) return [];
      const d = img.data;
      const gray = new Uint8Array(w * h);
      for (let i = 0, j = 0; i < gray.length; i++, j += 4) {
        gray[i] = (d[j] * 77 + d[j + 1] * 150 + d[j + 2] * 29) >> 8;
      }
      const out = [], seen = new Set();
      const tryLine = (getPx, n, axis, at) => {
        const runs = runsOf(getPx, n);
        if (runs.length < 20) return;
        const r = decodeRuns(runs);
        if (!r || !r.text || seen.has(r.text)) return;
        seen.add(r.text);
        r.axis = axis;
        r.at = at;
        out.push(r);
      };
      for (let k = 0; k < 17; k++) {
        const y = Math.min(h - 1, Math.floor(h * (k + 1) / 18));
        tryLine(x => gray[y * w + x], w, 'h', y);
      }
      if (!out.length) {
        for (let k = 0; k < 11; k++) {
          const x = Math.min(w - 1, Math.floor(w * (k + 1) / 12));
          tryLine(y => gray[y * w + x], h, 'v', x);
        }
      }
      return out;
    } catch (e) { return []; }
  }

  Object.assign(MDZ, { barDecodeRGBA });
  // 供回归测试逐段调用
  MDZ.barInternals = { otsu, runsOf, quantizeAll, bitsOf, decodeRuns, decodeEAN, decodeC128, decodeC39, C128, C39, EAN_L, EAN_G, EAN_R, EAN_PARITY };
})(typeof globalThis !== 'undefined' ? globalThis : this);
