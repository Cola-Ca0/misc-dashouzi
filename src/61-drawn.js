/* misc大手子 — 61 画字检测
 * 找"在平坦背景上用 ±1 差异画出来的字"：这类字不做 OCR 也看不出，只能把人眼放到位平面上。
 * 判据：局部平坦（std 很小）+ 某一位是少数派（位平面局部均值明显偏离 0.5）。
 */
(function (root) {
  'use strict';
  const MDZ = root.MDZ = root.MDZ || {};
  const { finding, artifact } = MDZ;

  const MAX_PX = 1200000;      // 再大就跳过（积分图吃内存）
  const WIN = 7;               // 15x15 窗口
  const TILE = 32;             // 热点聚类的瓦片
  const TILE_INK_MIN = 6;      // 瓦片里至少这么多"墨点"
  const TILE_FLAT_MIN = 0.75;

  function integral(arr, w, h) {
    const W = w + 1;
    const I = new Float64Array(W * (h + 1));
    for (let y = 0; y < h; y++) {
      const row = y * w, cur = (y + 1) * W, prev = y * W;
      let rs = 0;
      for (let x = 0; x < w; x++) {
        rs += arr[row + x];
        I[cur + x + 1] = I[prev + x + 1] + rs;
      }
    }
    return I;
  }

  function boxSum(I, w, x0, y0, x1, y1) {
    const W = w + 1;
    return I[y1 * W + x1] - I[y0 * W + x1] - I[y1 * W + x0] + I[y0 * W + x0];
  }

  // 把 mask 裁到 bbox 画成黑白图（窄了放大 2 倍，方便直接读）
  function maskImage(mask, w, h, bb) {
    const p = 4;
    const x0 = Math.max(0, bb.x0 - p), y0 = Math.max(0, bb.y0 - p);
    const x1 = Math.min(w, bb.x1 + p + 1), y1 = Math.min(h, bb.y1 + p + 1);
    const cw = x1 - x0, ch = y1 - y0;
    const scale = cw < 260 ? 2 : 1;
    const W = cw * scale, H = ch * scale;
    const R = new Uint8Array(W * H), G = new Uint8Array(W * H), B = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) {
      const sy = y0 + Math.floor(y / scale);
      for (let x = 0; x < W; x++) {
        const sx = x0 + Math.floor(x / scale);
        const v = mask[sy * w + sx] ? 255 : 0;
        const i = y * W + x;
        R[i] = v; G[i] = v; B[i] = v;
      }
    }
    return { width: W, height: H, channels: { R, G, B }, bitDepth: 8, colorType: 2, error: null };
  }

  function detectDrawn(image) {
    const findings = [], artifacts = [];
    if (!image || !image.channels || !(image.width > 0) || !(image.height > 0)) return { findings, artifacts };
    const w = image.width, h = image.height, n = w * h;
    if (n > MAX_PX) return { findings, artifacts };
    const chans = image._chans || (image._chans = MDZ.channelBytes(image));
    const names = ['R', 'G', 'B'].filter(k => chans[k]);
    if (!names.length) return { findings, artifacts };

    const found = [];
    for (const name of names) {
      const ch = chans[name];
      for (let bit = 0; bit <= 2; bit++) {
        // 把被测那一位清掉再看背景：文字只改这一位，清掉后背景和字都变成同一个值
        // → 窗口方差为 0 才算"平坦"，JPEG 噪声区（±2 以上）就自然被排除
        const q = new Uint8Array(n);
        for (let i = 0; i < n; i++) q[i] = ch[i] >> (bit + 1);
        const Iq = integral(q, w, h);
        const Iqq = new Float64Array(n);
        for (let i = 0; i < n; i++) Iqq[i] = q[i] * q[i];
        const Iq2 = integral(Iqq, w, h);

        const flat = new Uint8Array(n);
        let flatCount = 0;
        for (let y = 0; y < h; y++) {
          for (let x = 0; x < w; x++) {
            const x0 = Math.max(0, x - WIN), y0 = Math.max(0, y - WIN);
            const x1 = Math.min(w, x + WIN + 1), y1 = Math.min(h, y + WIN + 1);
            const cnt = (x1 - x0) * (y1 - y0);
            const m1 = boxSum(Iq, w, x0, y0, x1, y1) / cnt;
            const m2 = boxSum(Iq2, w, x0, y0, x1, y1) / cnt;
            if (m2 - m1 * m1 < 1e-6) { flat[y * w + x] = 1; flatCount++; }
          }
        }
        if (flatCount < n * 0.02) continue;

        const plane = new Uint8Array(n);
        for (let i = 0; i < n; i++) plane[i] = (ch[i] >> bit) & 1;
        const Ip = integral(plane, w, h);
        const ink = new Uint8Array(n);
        let inkCount = 0;
        for (let y = 0; y < h; y++) {
          for (let x = 0; x < w; x++) {
            const i = y * w + x;
            if (!flat[i]) continue;
            const x0 = Math.max(0, x - WIN), y0 = Math.max(0, y - WIN);
            const x1 = Math.min(w, x + WIN + 1), y1 = Math.min(h, y + WIN + 1);
            const cnt = (x1 - x0) * (y1 - y0);
            const pm = boxSum(Ip, w, x0, y0, x1, y1) / cnt;
            if ((pm < 0.45 && plane[i] === 1) || (pm > 0.55 && plane[i] === 0)) { ink[i] = 1; inkCount++; }
          }
        }
        if (inkCount < 40) continue;

        const tw = Math.ceil(w / TILE), th = Math.ceil(h / TILE);
        const hot = new Uint8Array(tw * th);
        for (let ty = 0; ty < th; ty++) {
          for (let tx = 0; tx < tw; tx++) {
            let ic = 0, fc = 0, tc = 0;
            const yEnd = Math.min(h, (ty + 1) * TILE), xEnd = Math.min(w, (tx + 1) * TILE);
            for (let y = ty * TILE; y < yEnd; y++) {
              for (let x = tx * TILE; x < xEnd; x++) {
                const i = y * w + x;
                tc++;
                if (ink[i]) ic++;
                if (flat[i]) fc++;
              }
            }
            if (ic >= TILE_INK_MIN && ic / tc <= 0.5 && fc / tc >= TILE_FLAT_MIN) hot[ty * tw + tx] = 1;
          }
        }

        const seenT = new Uint8Array(tw * th);
        for (let t = 0; t < hot.length; t++) {
          if (!hot[t] || seenT[t]) continue;
          const stack = [t];
          seenT[t] = 1;
          let minX = w, minY = h, maxX = -1, maxY = -1;
          while (stack.length) {
            const cur = stack.pop();
            const cx = cur % tw, cy = (cur / tw) | 0;
            minX = Math.min(minX, cx * TILE); minY = Math.min(minY, cy * TILE);
            maxX = Math.max(maxX, Math.min(w - 1, (cx + 1) * TILE - 1));
            maxY = Math.max(maxY, Math.min(h - 1, (cy + 1) * TILE - 1));
            for (let dy = -1; dy <= 1; dy++) {
              for (let dx = -1; dx <= 1; dx++) {
                const nx = cx + dx, ny = cy + dy;
                if (nx < 0 || ny < 0 || nx >= tw || ny >= th) continue;
                const ni = ny * tw + nx;
                if (hot[ni] && !seenT[ni]) { seenT[ni] = 1; stack.push(ni); }
              }
            }
          }
          // 瓦片框太粗：按行投影找"最有墨的一条带"，字基本都躺在一条横带里
          const H = maxY - minY + 1;
          const rowCnt = new Int32Array(H);
          for (let y = minY; y <= maxY; y++) {
            for (let x = minX; x <= maxX; x++) if (ink[y * w + x]) rowCnt[y - minY]++;
          }
          let maxRow = 0;
          for (let i = 0; i < H; i++) if (rowCnt[i] > maxRow) maxRow = rowCnt[i];
          if (maxRow < 5) continue;
          let bs = -1, bl = 0, cs = -1, cl = 0;
          for (let i = 0; i < H; i++) {
            if (rowCnt[i] >= maxRow * 0.25) {
              if (cs < 0) { cs = i; cl = 0; }
              cl++;
              if (cl > bl) { bl = cl; bs = cs; }
            } else { cs = -1; cl = 0; }
          }
          if (bl < 8) continue;
          const y0b = minY + bs, y1b = y0b + bl - 1;
          const xs = [];
          for (let y = y0b; y <= y1b; y++) for (let x = minX; x <= maxX; x++) if (ink[y * w + x]) xs.push(x);
          const inkInBox = xs.length;
          if (inkInBox < 50) continue;
          xs.sort((a, b) => a - b);
          const q = (arr, p) => arr[Math.min(arr.length - 1, Math.floor(arr.length * p))];
          const ix0 = q(xs, 0.01), ix1 = q(xs, 0.99);
          const bw = ix1 - ix0 + 1, bh = y1b - y0b + 1;
          if (bw < 40 || bh < 8 || bw / bh < 1.2) continue;
          const dens = inkInBox / (bw * bh);
          if (dens < 0.12 || dens > 0.5) continue;
          // 一行字是横向连续的：有墨点的列要覆盖足够宽；零散噪声块会出现大段空列
          let distinctCols = 0;
          for (let i = 0; i < xs.length; i++) if (i === 0 || xs[i] !== xs[i - 1]) distinctCols++;
          if (distinctCols / bw < 0.45) continue;

          // 字由很多小笔画组成；噪声往往是一两个大块
          const seen2 = new Uint8Array(bw * bh);
          const stack2 = [];
          let comps = 0, maxComp = 0;
          for (let yy = 0; yy < bh; yy++) {
            for (let xx = 0; xx < bw; xx++) {
              const ci = yy * bw + xx;
              if (seen2[ci]) continue;
              if (!ink[(y0b + yy) * w + (ix0 + xx)]) continue;
              let size = 0;
              stack2.push(ci); seen2[ci] = 1;
              while (stack2.length) {
                const cur = stack2.pop(); size++;
                const cx = cur % bw, cy = (cur / bw) | 0;
                for (let k = 0; k < 4; k++) {
                  const nx = cx + (k === 0 ? 1 : k === 1 ? -1 : 0);
                  const ny = cy + (k === 2 ? 1 : k === 3 ? -1 : 0);
                  if (nx < 0 || ny < 0 || nx >= bw || ny >= bh) continue;
                  const ni2 = ny * bw + nx;
                  if (seen2[ni2]) continue;
                  if (!ink[(y0b + ny) * w + (ix0 + nx)]) continue;
                  seen2[ni2] = 1; stack2.push(ni2);
                }
              }
              comps++;
              if (size > maxComp) maxComp = size;
            }
          }
          if (comps < 8 || maxComp > inkInBox * 0.4) continue;

          found.push({ plane: `${name}${bit}`, bit, bbox: { x0: ix0, y0: y0b, x1: ix1, y1: y1b }, ink: inkInBox, mask: ink });
        }
      }
    }

    found.sort((a, b) => b.ink - a.ink);
    const iou = (a, b) => {
      const x0 = Math.max(a.x0, b.x0), y0 = Math.max(a.y0, b.y0);
      const x1 = Math.min(a.x1, b.x1), y1 = Math.min(a.y1, b.y1);
      if (x1 < x0 || y1 < y0) return 0;
      const inter = (x1 - x0 + 1) * (y1 - y0 + 1);
      const areaA = (a.x1 - a.x0 + 1) * (a.y1 - a.y0 + 1);
      const areaB = (b.x1 - b.x0 + 1) * (b.y1 - b.y0 + 1);
      return inter / (areaA + areaB - inter);
    };
    const keptBoxes = [];
    let kept = 0;
    for (const f of found) {
      if (keptBoxes.some(b => iou(b, f.bbox) > 0.35)) continue;   // 同一块字在不同通道/位重复出现，只留墨点最多的
      keptBoxes.push(f.bbox);
      if (kept++ >= 3) break;
      const img = maskImage(f.mask, w, h, f.bbox);
      const bw = f.bbox.x1 - f.bbox.x0 + 1, bh = f.bbox.y1 - f.bbox.y0 + 1;
      const label = `${f.plane} 画字候选 ${bw}x${bh}`;
      const bmp = MDZ.encodeBMP ? MDZ.encodeBMP(img) : null;
      artifacts.push(Object.assign(artifact(`drawn-${f.plane}.bmp`, bmp, label, 'drawn'), { image: img }));
      findings.push(finding('L4', 'drawn', label, {
        confidence: 0.7,
        declared: `${w}x${h}`,
        actual: `bbox (${f.bbox.x0},${f.bbox.y0})-(${f.bbox.x1},${f.bbox.y1})，墨点 ${f.ink}`,
        detail: '在平坦背景上用 ±1 差异写出来的字：位平面上是"少数派"像素，普通看图完全看不见。已把该区域裁出来放在产物里，直接看即可。',
        preview: `${f.plane} 通道 bit${f.bit}`,
        recipe: `取 ${f.plane} 通道第 ${f.bit} 位，在局部平坦处找少数派像素`
      }));
    }
    return { findings, artifacts };
  }

  Object.assign(MDZ, { detectDrawn });
})(typeof globalThis !== 'undefined' ? globalThis : this);
