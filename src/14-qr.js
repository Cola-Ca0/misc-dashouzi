/* misc大手子 — 14 二维码识别（纯 JS，不需要 zbarimg / companion）
 * 流程：Otsu 二值化 → 扫 1:1:3:1:1 寻像图形 → 三点定仿射 → 采样模块 → 读格式信息
 *      → 去掩码 → 之字形读码字 → 按版本/纠错级别拆交织 → 解析数字/字母/字节段
 * 边界：截图级清晰图（轴对齐 / 轻微旋转）；不做 RS 纠错，不认镜像码。
 */
(function (root) {
  'use strict';
  const MDZ = root.MDZ = root.MDZ || {};

  // 版本 1..40 × 纠错级别 L,M,Q,H 的 RS 块表：
  // [块数, 总码字, 数据码字] 或 [块数1, 总1, 数据1, 块数2, 总2, 数据2]
  const RS_TABLE = [
    [1,26,19],[1,26,16],[1,26,13],[1,26,9],
    [1,44,34],[1,44,28],[1,44,22],[1,44,16],
    [1,70,55],[1,70,44],[2,35,17],[2,35,13],
    [1,100,80],[2,50,32],[2,50,24],[4,25,9],
    [1,134,108],[2,67,43],[2,33,15,2,34,16],[2,33,11,2,34,12],
    [2,86,68],[4,43,27],[4,43,19],[4,43,15],
    [2,98,78],[4,49,31],[2,32,14,4,33,15],[4,39,13,1,40,14],
    [2,121,97],[2,60,38,2,61,39],[4,40,18,2,41,19],[4,40,14,2,41,15],
    [2,146,116],[3,58,36,2,59,37],[4,36,16,4,37,17],[4,36,12,4,37,13],
    [2,86,68,2,87,69],[4,69,43,1,70,44],[6,43,19,2,44,20],[6,43,15,2,44,16],
    [4,101,81],[1,80,50,4,81,51],[4,50,22,4,51,23],[3,36,12,8,37,13],
    [2,116,92,2,117,93],[6,58,36,2,59,37],[4,46,20,6,47,21],[7,42,14,4,43,15],
    [4,133,107],[8,59,37,1,60,38],[8,44,20,4,45,21],[12,33,11,4,34,12],
    [3,145,115,1,146,116],[4,64,40,5,65,41],[11,36,16,5,37,17],[11,36,12,5,37,13],
    [5,109,87,1,110,88],[5,65,41,5,66,42],[5,54,24,7,55,25],[11,36,12,7,37,13],
    [5,122,98,1,123,99],[7,73,45,3,74,46],[15,43,19,2,44,20],[3,45,15,13,46,16],
    [1,135,107,5,136,108],[10,74,46,1,75,47],[1,50,22,15,51,23],[2,42,14,17,43,15],
    [5,150,120,1,151,121],[9,69,43,4,70,44],[17,50,22,1,51,23],[2,42,14,19,43,15],
    [3,141,113,4,142,114],[3,70,44,11,71,45],[17,47,21,4,48,22],[9,39,13,16,40,14],
    [3,135,107,5,136,108],[3,67,41,13,68,42],[15,54,24,5,55,25],[15,43,15,10,44,16],
    [4,144,116,4,145,117],[17,68,42],[17,50,22,6,51,23],[19,46,16,6,47,17],
    [2,139,111,7,140,112],[17,74,46],[7,54,24,16,55,25],[34,37,13],
    [4,151,121,5,152,122],[4,75,47,14,76,48],[11,54,24,14,55,25],[16,45,15,14,46,16],
    [6,147,117,4,148,118],[6,73,45,14,74,46],[11,54,24,16,55,25],[30,46,16,2,47,17],
    [8,132,106,4,133,107],[8,75,47,13,76,48],[7,54,24,22,55,25],[22,45,15,13,46,16],
    [10,142,114,2,143,115],[19,74,46,4,75,47],[28,50,22,6,51,23],[33,46,16,4,47,17],
    [8,152,122,4,153,123],[22,73,45,3,74,46],[8,53,23,26,54,24],[12,45,15,28,46,16],
    [3,147,117,10,148,118],[3,73,45,23,74,46],[4,54,24,31,55,25],[11,45,15,31,46,16],
    [7,146,116,7,147,117],[21,73,45,7,74,46],[1,53,23,37,54,24],[19,45,15,26,46,16],
    [5,145,115,10,146,116],[19,75,47,10,76,48],[15,54,24,25,55,25],[23,45,15,25,46,16],
    [13,145,115,3,146,116],[2,74,46,29,75,47],[42,54,24,1,55,25],[23,45,15,28,46,16],
    [17,145,115],[10,74,46,23,75,47],[10,54,24,35,55,25],[19,45,15,35,46,16],
    [17,145,115,1,146,116],[14,74,46,21,75,47],[29,54,24,19,55,25],[11,45,15,46,46,16],
    [13,145,115,6,146,116],[14,74,46,23,75,47],[44,54,24,7,55,25],[59,46,16,1,47,17],
    [12,151,121,7,152,122],[12,75,47,26,76,48],[39,54,24,14,55,25],[22,45,15,41,46,16],
    [6,151,121,14,152,122],[6,75,47,34,76,48],[46,54,24,10,55,25],[2,45,15,64,46,16],
    [17,152,122,4,153,123],[29,74,46,14,75,47],[49,54,24,10,55,25],[24,45,15,46,46,16],
    [4,152,122,18,153,123],[13,74,46,32,75,47],[48,54,24,14,55,25],[42,45,15,32,46,16],
    [20,147,117,4,148,118],[40,75,47,7,76,48],[43,54,24,22,55,25],[10,45,15,67,46,16],
    [19,148,118,6,149,119],[18,75,47,31,76,48],[34,54,24,34,55,25],[20,45,15,61,46,16]
  ];

  const ALNUM = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:';
  const EC_LABEL = ['L', 'M', 'Q', 'H'];
  // 格式信息里的 2 bit 纠错级别 → RS 表下标（01=L 00=M 11=Q 10=H）
  const EC_FROM_BITS = [1, 0, 3, 2];

  function binarize(img) {
    const w = img.width, h = img.height, src = img.data;
    const n = w * h;
    const gray = new Uint8Array(n);
    const hist = new Uint32Array(256);
    for (let i = 0; i < n; i++) {
      const g = (src[i * 4] * 77 + src[i * 4 + 1] * 150 + src[i * 4 + 2] * 29) >> 8;
      gray[i] = g;
      hist[g]++;
    }
    let sum = 0;
    for (let i = 0; i < 256; i++) sum += i * hist[i];
    let sumB = 0, wB = 0, best = -1, thr = 127;
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
    const bin = new Uint8Array(n);
    for (let i = 0; i < n; i++) bin[i] = gray[i] <= thr ? 1 : 0;   // 1 = 深色
    return { bin, w, h };
  }

  // 按行扫 1:1:3:1:1 的深浅交替，收集寻像图形候选并聚类
  function findFinders(bin, w, h) {
    const raw = [];
    const runs = [];
    for (let y = 0; y < h; y++) {
      runs.length = 0;
      let x = 0;
      while (x < w) {
        const c = bin[y * w + x];
        const s = x;
        while (x < w && bin[y * w + x] === c) x++;
        runs.push({ s, len: x - s, dark: c === 1 });
      }
      for (let i = 0; i + 4 < runs.length; i++) {
        const a = runs[i], b = runs[i + 1], c = runs[i + 2], d = runs[i + 3], e = runs[i + 4];
        if (!a.dark || b.dark || !c.dark || d.dark || !e.dark) continue;
        const total = a.len + b.len + c.len + d.len + e.len;
        const unit = total / 7;
        if (unit < 1.5) continue;
        const tol = unit * 0.7;
        if (Math.abs(a.len - unit) > tol || Math.abs(b.len - unit) > tol ||
            Math.abs(c.len - unit * 3) > unit * 1.6 ||
            Math.abs(d.len - unit) > tol || Math.abs(e.len - unit) > tol) continue;
        raw.push({ x: c.s + c.len / 2, y, unit });
      }
    }
    const clusters = [];
    for (const r of raw) {
      if (!verticalOk(bin, w, h, r)) continue;   // 先逐行验证，避免假候选把真簇的均值拖偏
      let hit = null;
      for (const cl of clusters) {
        if (Math.abs(cl.x - r.x) <= cl.unit * 2 && Math.abs(cl.y - r.y) <= cl.unit * 4) { hit = cl; break; }
      }
      if (hit) {
        hit.x = (hit.x * hit.n + r.x) / (hit.n + 1);
        hit.y = (hit.y * hit.n + r.y) / (hit.n + 1);
        hit.unit = (hit.unit * hit.n + r.unit) / (hit.n + 1);
        hit.n++;
      } else {
        clusters.push({ x: r.x, y: r.y, unit: r.unit, n: 1 });
      }
    }
    return clusters.filter(c => c.n >= 3 && verticalOk(bin, w, h, c))
      .sort((a, b) => b.n - a.n).slice(0, 12);
  }

  // 竖直方向再过一遍 1:1:3:1:1，滤掉横条纹/文字造成的假寻像图形
  function verticalOk(bin, w, h, c) {
    const x = Math.round(c.x), y = Math.round(c.y);
    if (x < 0 || x >= w || y < 0 || y >= h || !bin[y * w + x]) return false;
    let up = 0, yy = y;
    while (yy >= 0 && bin[yy * w + x]) { up++; yy--; }
    let lu = 0;
    while (yy >= 0 && !bin[yy * w + x]) { lu++; yy--; }
    let du = 0;
    while (yy >= 0 && bin[yy * w + x]) { du++; yy--; }
    let dn = 0;
    yy = y;
    while (yy < h && bin[yy * w + x]) { dn++; yy++; }
    let ld = 0;
    while (yy < h && !bin[yy * w + x]) { ld++; yy++; }
    let dd = 0;
    while (yy < h && bin[yy * w + x]) { dd++; yy++; }
    const center = up + dn - 1;
    const light = lu + ld;
    const outer = (du + dd) / 2;
    if (outer < 1) return false;
    const unit = (outer * 2 + light + center) / 7;   // 1:1:3:1:1，外侧两条各一段
    if (unit < 1) return false;
    return Math.abs(outer - unit) <= unit * 0.9 &&
      Math.abs(light - unit * 2) <= unit * 1.4 &&      // 上下两条浅色合起来是 2 个单元
      Math.abs(center - unit * 3) <= unit * 2.1;
  }

  function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }

  // 三个寻像图形组成等腰直角三角形：斜边对面的顶点就是左上角
  // 返回按可信度排序的多个候选，让上层逐个尝试（旋转图里常有假寻像图形混进来）
  function pickTriples(list, limit) {
    const out = [];
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        for (let k = j + 1; k < list.length; k++) {
          const ps = [list[i], list[j], list[k]];
          const pairs = [[0, 1], [0, 2], [1, 2]].map(([u, v]) => ({ u, v, d: dist(ps[u], ps[v]) }));
          pairs.sort((a, b) => b.d - a.d);
          const hyp = pairs[0].d, l1 = pairs[1].d, l2 = pairs[2].d;
          if (!(hyp > 4)) continue;
          if (Math.abs(l1 - l2) / hyp > 0.22) continue;
          if (Math.abs(hyp - Math.hypot(l1, l2)) / hyp > 0.2) continue;
          const units = ps.map(p => p.unit);
          const uMin = Math.min.apply(null, units), uMax = Math.max.apply(null, units);
          if (uMax > uMin * 1.7) continue;
          const score = Math.abs(l1 - l2) / hyp + Math.abs(hyp - Math.hypot(l1, l2)) / hyp + (uMax - uMin) / uMax * 0.3;
          const corner = ps.find((_, idx) => idx !== pairs[0].u && idx !== pairs[0].v);
          const p = ps[pairs[0].u], q = ps[pairs[0].v];
          const cross = (p.x - corner.x) * (q.y - corner.y) - (p.y - corner.y) * (q.x - corner.x);
          out.push(cross > 0
            ? { tl: corner, tr: p, bl: q, score, n: ps[0].n + ps[1].n + ps[2].n }
            : { tl: corner, tr: q, bl: p, score, n: ps[0].n + ps[1].n + ps[2].n });
        }
      }
    }
    out.sort((a, b) => (a.score - b.score) || (b.n - a.n));
    return out.slice(0, limit || 40);
  }

  function alignmentPositions(version) {
    if (version === 1) return [];
    const num = Math.floor(version / 7) + 2;
    let step = version === 32 ? 26 : Math.ceil((version * 4 + 4) / (num * 2 - 2)) * 2;
    const dim = version * 4 + 17;
    const out = [6];
    const pos = [];
    for (let p = dim - 7; pos.length < num - 1; p -= step) pos.push(p);
    return out.concat(pos.reverse());
  }

  function buildFunctionMask(dim, version) {
    const f = new Uint8Array(dim * dim);
    const mark = (r0, c0, r1, c1) => {
      for (let r = Math.max(0, r0); r <= Math.min(dim - 1, r1); r++) {
        for (let c = Math.max(0, c0); c <= Math.min(dim - 1, c1); c++) f[r * dim + c] = 1;
      }
    };
    mark(0, 0, 8, 8);
    mark(0, dim - 8, 8, dim - 1);
    mark(dim - 8, 0, dim - 1, 8);
    mark(6, 0, 6, dim - 1);
    mark(0, 6, dim - 1, 6);
    const ap = alignmentPositions(version);
    for (const r of ap) {
      for (const c of ap) {
        if ((r <= 8 && c <= 8) || (r <= 8 && c >= dim - 9) || (r >= dim - 9 && c <= 8)) continue;
        mark(r - 2, c - 2, r + 2, c + 2);
      }
    }
    if (version >= 7) {
      mark(0, dim - 11, 5, dim - 9);
      mark(dim - 11, 0, dim - 9, 5);
    }
    return f;
  }

  const MASKS = [
    (r, c) => (r + c) % 2 === 0,
    (r) => r % 2 === 0,
    (r, c) => c % 3 === 0,
    (r, c) => (r + c) % 3 === 0,
    (r, c) => (Math.floor(c / 2) + Math.floor(r / 3)) % 2 === 0,
    (r, c) => (r * c) % 2 + (r * c) % 3 === 0,
    (r, c) => ((r * c) % 2 + (r * c) % 3) % 2 === 0,
    (r, c) => ((r + c) % 2 + (r * c) % 3) % 2 === 0
  ];

  function bchOk(v) {
    let r = v;
    for (let i = 14; i >= 10; i--) if ((r >> i) & 1) r ^= 0x537 << (i - 10);
    return (r & 0x3FF) === 0;
  }

  function readFormatBits(grid, dim, get) {
    let bits = 0;
    const put = (v, i) => { if (v) bits |= 1 << i; };
    // 左上副本：bit0..7 竖排（列 8），bit8..14 横排（行 8）
    for (let i = 0; i < 6; i++) put(get(i, 8), i);
    put(get(7, 8), 6);
    put(get(8, 8), 7);
    put(get(8, 7), 8);
    for (let i = 9; i < 15; i++) put(get(8, 14 - i), i);
    return bits;
  }

  function readFormat(grid, dim) {
    const get = (r, c) => (grid[r * dim + c] ? 1 : 0);
    const copies = [];
    copies.push(readFormatBits(grid, dim, get));
    // 右上 + 左下副本
    let bits2 = 0;
    for (let i = 0; i < 8; i++) if (grid[8 * dim + (dim - 1 - i)]) bits2 |= 1 << i;
    for (let i = 8; i < 15; i++) if (grid[(dim - 15 + i) * dim + 8]) bits2 |= 1 << i;
    copies.push(bits2);
    for (const raw of copies) {
      const v = raw ^ 0x5412;
      if (!bchOk(v)) continue;
      const data = v >> 10;
      return { ec: EC_FROM_BITS[data >> 3], mask: data & 7 };
    }
    return null;
  }

  function readCodewords(grid, dim, mask, fn) {
    const out = [];
    let bits = 0, nbits = 0, up = true;
    const maskFn = MASKS[mask];
    for (let col = dim - 1; col > 0; col -= 2) {
      if (col === 6) col--;
      for (let i = 0; i < dim; i++) {
        const row = up ? dim - 1 - i : i;
        for (let k = 0; k < 2; k++) {
          const c = col - k;
          if (fn[row * dim + c]) continue;
          let bit = grid[row * dim + c] ? 1 : 0;
          if (maskFn(row, c)) bit ^= 1;
          bits = (bits << 1) | bit;
          if (++nbits === 8) { out.push(bits); bits = 0; nbits = 0; }
        }
      }
      up = !up;
    }
    return out;
  }

  function totalCodewords(spec) {
    return spec[0] * spec[1] + (spec.length > 3 ? spec[3] * spec[4] : 0);
  }

  function deinterleave(codewords, version, ec) {
    const spec = RS_TABLE[(version - 1) * 4 + ec];
    if (!spec) return null;
    if (codewords.length < totalCodewords(spec)) return null;
    const blocks = [];
    for (let i = 0; i < spec[0]; i++) blocks.push(spec[2]);
    if (spec.length > 3) for (let i = 0; i < spec[3]; i++) blocks.push(spec[5]);
    const maxDc = Math.max.apply(null, blocks);
    const bufs = blocks.map(() => []);
    let p = 0;
    for (let i = 0; i < maxDc; i++) {
      for (let b = 0; b < blocks.length; b++) {
        if (i < blocks[b]) {
          if (p >= codewords.length) return null;
          bufs[b].push(codewords[p++]);
        }
      }
    }
    const out = [];
    for (const b of bufs) for (const v of b) out.push(v);
    return out;
  }

  function charCountBits(mode, version) {
    const g = version <= 9 ? 0 : version <= 26 ? 1 : 2;
    if (mode === 1) return [10, 12, 14][g];
    if (mode === 2) return [9, 11, 13][g];
    if (mode === 4) return [8, 16, 16][g];
    if (mode === 8) return [8, 10, 12][g];
    return 0;
  }

  const utf8 = (() => {
    try { return new TextDecoder('utf-8', { fatal: true }); } catch (e) { return null; }
  })();
  const sjis = (() => {
    try { return new TextDecoder('shift_jis', { fatal: true }); } catch (e) { return null; }
  })();

  function decodeBytes(arr) {
    const u = new Uint8Array(arr);
    if (utf8) { try { return utf8.decode(u); } catch (e) { /* 不是合法 UTF-8 */ } }
    let s = '';
    for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]);
    return s;
  }

  function parseData(bytes, version) {
    let pos = 0;
    const total = bytes.length * 8;
    const readBits = n => {
      let v = 0;
      for (let i = 0; i < n; i++) {
        const byte = bytes[pos >> 3];
        const bit = byte === undefined ? 0 : (byte >> (7 - (pos & 7))) & 1;
        v = v * 2 + bit;
        pos++;
      }
      return v;
    };
    let text = '';
    while (pos + 4 <= total) {
      const mode = readBits(4);
      if (mode === 0) break;
      if (mode === 7) {                       // ECI
        const first = readBits(8);
        if (first & 0x80) readBits(16);
        continue;
      }
      if (mode === 1) {                       // 数字
        let n = readBits(charCountBits(1, version));
        while (n >= 3) { text += String(readBits(10)).padStart(3, '0'); n -= 3; }
        if (n === 2) text += String(readBits(7)).padStart(2, '0');
        else if (n === 1) text += String(readBits(4));
        continue;
      }
      if (mode === 2) {                       // 字母数字
        let n = readBits(charCountBits(2, version));
        while (n >= 2) { const v = readBits(11); text += ALNUM[(v / 45) | 0] + ALNUM[v % 45]; n -= 2; }
        if (n === 1) text += ALNUM[readBits(6)];
        continue;
      }
      if (mode === 4) {                       // 字节
        const n = readBits(charCountBits(4, version));
        const arr = [];
        for (let i = 0; i < n; i++) arr.push(readBits(8));
        text += decodeBytes(arr);
        continue;
      }
      if (mode === 8) {                       // 汉字（Shift-JIS）
        const n = readBits(charCountBits(8, version));
        const arr = [];
        for (let i = 0; i < n; i++) {
          const v = readBits(13);
          let c1 = (v / 0xC0) | 0, c2 = v % 0xC0;
          c1 += c1 < 0x1F ? 0x81 : 0xC1;
          c2 += c2 < 0x1E ? 0x40 : 0x41;
          arr.push(c1, c2);
        }
        if (sjis) { try { text += sjis.decode(new Uint8Array(arr)); } catch (e) { /* 非法 SJIS */ } }
        continue;
      }
      break;                                   // 未知模式
    }
    return text;
  }

  function sampleGrid(bin, w, h, tri, dim) {
    const span = dim - 7;
    const grid = new Uint8Array(dim * dim);
    for (let r = 0; r < dim; r++) {
      for (let c = 0; c < dim; c++) {
        const u = (c + 0.5 - 3.5) / span;
        const v = (r + 0.5 - 3.5) / span;
        const px = tri.tl.x + (tri.tr.x - tri.tl.x) * u + (tri.bl.x - tri.tl.x) * v;
        const py = tri.tl.y + (tri.tr.y - tri.tl.y) * u + (tri.bl.y - tri.tl.y) * v;
        let dark = 0, tot = 0;
        const rad = Math.max(0, Math.round(Math.min(tri.tr.unit || 1, 2) * 0.5) - 1);
        for (let dy = -rad; dy <= rad; dy++) {
          for (let dx = -rad; dx <= rad; dx++) {
            const x = Math.round(px + dx), y = Math.round(py + dy);
            if (x < 0 || y < 0 || x >= w || y >= h) continue;
            tot++;
            if (bin[y * w + x]) dark++;
          }
        }
        if (!tot) { const x = Math.round(px), y = Math.round(py); tot = 1; dark = (x >= 0 && y >= 0 && x < w && y < h && bin[y * w + x]) ? 1 : 0; }
        grid[r * dim + c] = dark * 2 > tot ? 1 : 0;
      }
    }
    return grid;
  }

  function decodeWithTriple(bin, w, h, tri) {
    const unit = (tri.tl.unit + tri.tr.unit + tri.bl.unit) / 3;
    const modules = (dist(tri.tl, tri.tr) + dist(tri.tl, tri.bl)) / 2 / unit;   // = dim - 7
    let dim = Math.round(modules) + 7;
    dim = 21 + 4 * Math.round((dim - 21) / 4);
    if (dim < 21 || dim > 177) return null;
    const version = (dim - 17) / 4;
    const grid = sampleGrid(bin, w, h, tri, dim);
    const fmt = readFormat(grid, dim);
    if (!fmt) return null;
    const fn = buildFunctionMask(dim, version);
    const codewords = readCodewords(grid, dim, fmt.mask, fn);
    const spec = RS_TABLE[(version - 1) * 4 + fmt.ec];
    if (!spec) return null;
    const need = totalCodewords(spec);
    if (codewords.length < need) return null;
    const data = deinterleave(codewords.slice(0, need), version, fmt.ec);
    if (!data) return null;
    const text = parseData(data, version);
    if (!text) return null;
    return { text, version, ec: EC_LABEL[fmt.ec], mask: fmt.mask, dim };
  }

  function qrDecodeImageData(img, opts) {
    const o = opts || {};
    try {
      if (!img || !img.data || !(img.width > 0) || !(img.height > 0)) return [];
      if (img.width * img.height > (o.maxPixels || 4000000)) return [];
      const { bin, w, h } = binarize(img);
      const cands = findFinders(bin, w, h);
      if (cands.length < 3) return [];
      for (const tri of pickTriples(cands, 40)) {
        const r = decodeWithTriple(bin, w, h, tri);
        if (r) return [r];
      }
      return [];
    } catch (e) {
      return [];
    }
  }

  Object.assign(MDZ, { qrDecodeImageData });
  // 供回归测试逐段调用（不属于 UI 用的公开接口）
  MDZ.qrInternals = { binarize, findFinders, pickTriples, decodeWithTriple, sampleGrid, readFormat, buildFunctionMask, readCodewords, deinterleave, parseData, alignmentPositions };
})(typeof globalThis !== 'undefined' ? globalThis : this);
