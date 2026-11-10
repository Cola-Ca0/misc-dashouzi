/* misc大手子 — 65 双图对比
 * 两张同尺寸图逐像素 XOR / 绝对差 / 差值，输出可视化 + 统计。
 */
(function (root) {
  'use strict';
  const MDZ = root.MDZ = root.MDZ || {};

  const MODES = {
    xor: { label: 'XOR', fn: (a, b) => a ^ b },
    abs: { label: '绝对差', fn: (a, b) => Math.abs(a - b) },
    sub: { label: '差值 a-b', fn: (a, b) => (a - b) & 255 }
  };

  function diffImages(a, b, opts) {
    const o = opts || {};
    if (!a || !b || !a.channels || !b.channels) return { error: '需要两张已解码的图片' };
    if (!(a.width > 0) || !(a.height > 0) || !(b.width > 0) || !(b.height > 0)) {
      return { error: `图片尺寸无效：${a.width}x${a.height} 与 ${b.width}x${b.height}` };
    }
    if (a.width !== b.width || a.height !== b.height) {
      return { error: `尺寸不同：${a.width}x${a.height} 与 ${b.width}x${b.height}` };
    }
    const n = a.width * a.height;
    for (const [img, label] of [[a, 'A'], [b, 'B']]) {
      for (const k of ['R', 'G', 'B', 'A']) {
        const ch = img.channels[k];
        if (ch && ch.length !== n) return { error: `${label} 的 ${k} 通道长度 ${ch.length} 与 ${n} 个像素不符` };
      }
    }
    const mode = MODES[o.mode] ? o.mode : 'xor';
    const fn = MODES[mode].fn;
    const ca = a._chans || (a._chans = MDZ.channelBytes(a));
    const cb = b._chans || (b._chans = MDZ.channelBytes(b));
    const out = new Uint8ClampedArray(n * 4);
    let changed = 0, maxDiff = 0, sum = 0;
    for (let i = 0; i < n; i++) {
      // 16-bit 图走 channelBytes 的低字节；对比是视觉辅助，不做 16-bit 合成
      const ra = ca.R ? ca.R[i] : 0, rb = cb.R ? cb.R[i] : 0;
      const ga = ca.G ? ca.G[i] : ra, gb = cb.G ? cb.G[i] : rb;
      const ba = ca.B ? ca.B[i] : ra, bb = cb.B ? cb.B[i] : rb;
      const di = i * 4;
      out[di] = fn(ra, rb);
      out[di + 1] = fn(ga, gb);
      out[di + 2] = fn(ba, bb);
      out[di + 3] = 255;
      const dr = Math.abs(ra - rb), dg = Math.abs(ga - gb), db = Math.abs(ba - bb);
      const d = dr + dg + db;
      if (d) changed++;
      sum += d;
      if (dr > maxDiff) maxDiff = dr;
      if (dg > maxDiff) maxDiff = dg;
      if (db > maxDiff) maxDiff = db;
    }
    return {
      width: a.width, height: a.height, data: out, mode,
      stats: { pixels: n, changed, changedRatio: n ? changed / n : 0, maxDiff, meanDiff: n ? sum / (n * 3) : 0 }
    };
  }

  Object.assign(MDZ, { diffImages, DIFF_MODES: MODES });
})(typeof globalThis !== 'undefined' ? globalThis : this);
