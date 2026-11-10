/* misc大手子 — 66 图像频域
 * 2D FFT 幅度谱：网格水印、周期噪声、摩尔纹、频域隐写都会在谱上冒出对称亮点。
 * 零依赖、只对下采样后的 256x256 做，够用且快。
 */
(function (root) {
  'use strict';
  const MDZ = root.MDZ = root.MDZ || {};
  const { finding, artifact } = MDZ;

  const N = 256;
  const MAX_PEAKS = 6;

  function fft(re, im) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const ang = -2 * Math.PI / len;
      const wr = Math.cos(ang), wi = Math.sin(ang);
      for (let i = 0; i < n; i += len) {
        let cr = 1, ci = 0;
        for (let k = 0; k < len / 2; k++) {
          const ar = re[i + k], ai = im[i + k];
          const br = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
          const bi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
          re[i + k] = ar + br; im[i + k] = ai + bi;
          re[i + k + len / 2] = ar - br; im[i + k + len / 2] = ai - bi;
          const ncr = cr * wr - ci * wi;
          ci = cr * wi + ci * wr;
          cr = ncr;
        }
      }
    }
  }

  function luminance(image) {
    const c = image._chans || (image._chans = MDZ.channelBytes(image));
    const w = image.width, h = image.height, n = w * h;
    const out = new Float32Array(n);
    const R = c.R, G = c.G, B = c.B;
    if (R && G && B) for (let i = 0; i < n; i++) out[i] = 0.299 * R[i] + 0.587 * G[i] + 0.114 * B[i];
    else if (R) out.set(R.subarray(0, n));
    return out;
  }

  function downsample(lum, w, h, N2) {
    const out = new Float64Array(N2 * N2);
    for (let y = 0; y < N2; y++) {
      const sy0 = Math.floor(y * h / N2), sy1 = Math.max(sy0 + 1, Math.floor((y + 1) * h / N2));
      for (let x = 0; x < N2; x++) {
        const sx0 = Math.floor(x * w / N2), sx1 = Math.max(sx0 + 1, Math.floor((x + 1) * w / N2));
        let sum = 0, cnt = 0;
        for (let sy = sy0; sy < sy1 && sy < h; sy++) {
          for (let sx = sx0; sx < sx1 && sx < w; sx++) { sum += lum[sy * w + sx]; cnt++; }
        }
        out[y * N2 + x] = cnt ? sum / cnt : 0;
      }
    }
    return out;
  }

  function spectrum(image, opts) {
    if (!image || !image.channels || !(image.width > 8) || !(image.height > 8)) return null;
    const o = opts || {};
    // 不放大：N2 取 ≤ min(w,h) 的 2 的幂（上限 256），这样 fx 就是"每源像素的周期数"
    const cap = o.size || N;
    let N2 = 1;
    while (N2 * 2 <= Math.min(image.width, image.height) && N2 < cap) N2 *= 2;
    if (N2 < 32) return null;
    const lum = luminance(image);
    const g = downsample(lum, image.width, image.height, N2);

    // 去均值，避免 DC 把整张谱压平
    let mean = 0;
    for (let i = 0; i < g.length; i++) mean += g[i];
    mean /= g.length;
    const re = new Float64Array(N2 * N2), im = new Float64Array(N2 * N2);
    for (let i = 0; i < g.length; i++) re[i] = g[i] - mean;

    // 行 FFT
    const rr = new Float64Array(N2), ii = new Float64Array(N2);
    for (let y = 0; y < N2; y++) {
      for (let x = 0; x < N2; x++) { rr[x] = re[y * N2 + x]; ii[x] = im[y * N2 + x]; }
      fft(rr, ii);
      for (let x = 0; x < N2; x++) { re[y * N2 + x] = rr[x]; im[y * N2 + x] = ii[x]; }
    }
    // 列 FFT
    for (let x = 0; x < N2; x++) {
      for (let y = 0; y < N2; y++) { rr[y] = re[y * N2 + x]; ii[y] = im[y * N2 + x]; }
      fft(rr, ii);
      for (let y = 0; y < N2; y++) { re[y * N2 + x] = rr[y]; im[y * N2 + x] = ii[y]; }
    }

    // 幅度 + 中心化
    const half = N2 >> 1;
    const mag = new Float64Array(N2 * N2);
    let maxMag = 0;
    for (let y = 0; y < N2; y++) {
      for (let x = 0; x < N2; x++) {
        const sx = (x + half) % N2, sy = (y + half) % N2;
        const idx = sy * N2 + sx;
        const m = Math.sqrt(re[idx] * re[idx] + im[idx] * im[idx]);
        mag[y * N2 + x] = m;
        if (m > maxMag) maxMag = m;
      }
    }
    const logMax = Math.log1p(maxMag) || 1;
    const R = new Uint8Array(N2 * N2), G2 = new Uint8Array(N2 * N2), B = new Uint8Array(N2 * N2);
    for (let i = 0; i < mag.length; i++) {
      const v = Math.round(255 * Math.log1p(mag[i]) / logMax);
      R[i] = G2[i] = B[i] = v;
    }

    // 峰：跳过中心低频圈，做 5x5 非极大抑制
    const cx = half, cy = half;
    const r0 = Math.max(6, Math.round(N2 * 0.045));
    const peaks = [];
    const minV = maxMag * 0.01;
    for (let y = 0; y < N2; y++) {
      for (let x = 0; x < N2; x++) {
        const dx = x - cx, dy = y - cy;
        if (dx * dx + dy * dy < r0 * r0) continue;
        const v = mag[y * N2 + x];
        if (v < minV) continue;
        let isMax = true;
        for (let yy = -2; yy <= 2 && isMax; yy++) {
          for (let xx = -2; xx <= 2; xx++) {
            const nx = x + xx, ny = y + yy;
            if (nx < 0 || ny < 0 || nx >= N2 || ny >= N2) continue;
            if (mag[ny * N2 + nx] > v) { isMax = false; break; }
          }
        }
        if (isMax) peaks.push({ x, y, v });
      }
    }
    peaks.sort((a, b) => b.v - a.v);
    const top = peaks.slice(0, MAX_PEAKS).map(p => ({
      fx: +( (p.x - cx) / N2 ).toFixed(4),
      fy: +((p.y - cy) / N2).toFixed(4),
      mag: Math.round(p.v),
      rel: +(p.v / (maxMag || 1)).toFixed(3)
    }));

    return {
      image: { width: N2, height: N2, channels: { R, G: G2, B }, bitDepth: 8, colorType: 2, error: null },
      peaks: top,
      size: N2
    };
  }

  function auditSpectrum(image) {
    const findings = [], artifacts = [];
    const r = spectrum(image);
    if (!r) return { findings, artifacts };
    const label = `频域幅度谱 ${r.size}x${r.size}`;
    const bmp = MDZ.encodeBMP ? MDZ.encodeBMP(r.image) : null;
    artifacts.push(Object.assign(artifact('spectrum.bmp', bmp, label, 'spectrum'), { image: r.image }));
    const strong = r.peaks.filter(p => p.rel >= 0.12);
    findings.push(finding('L4', 'spectrum', strong.length ? `频域有 ${strong.length} 个明显亮点` : label, {
      confidence: strong.length ? 0.6 : 0.3,
      declared: `${image.width}x${image.height}`,
      actual: r.peaks.slice(0, 4).map(p => `(${p.fx}, ${p.fy}) rel=${p.rel}`).join(' | ') || '无明显峰',
      detail: '谱图已作为产物导出（中心=低频）。规则对称的亮点常来自网格水印、周期性噪声或频域隐写；坐标是归一化频率（每像素周期数），fx=0.25 表示每 4 像素一个周期。',
      preview: r.peaks.slice(0, 6).map(p => `fx=${p.fx} fy=${p.fy} rel=${p.rel}`).join('\n'),
      recipe: '对亮度做 256x256 下采样 → 2D FFT → log 幅度谱中心化'
    }));
    return { findings, artifacts };
  }

  Object.assign(MDZ, { fft, spectrum, auditSpectrum });
})(typeof globalThis !== 'undefined' ? globalThis : this);
