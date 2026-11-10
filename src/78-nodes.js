/* misc大手子 — 78 节点编辑器核心
 * 参考 Blender 合成器：图像从输入节点流经操作块，最后到输出节点。
 * 这里只做纯图像运算与图求值，不碰 DOM，方便 Node 端测试。
 */
(function (root) {
  'use strict';
  const MDZ = root.MDZ = root.MDZ || {};

  function clampInt(v, lo, hi, def) {
    v = Math.floor(Number(v));
    if (!isFinite(v)) v = def;
    return Math.max(lo, Math.min(hi, v));
  }

  function makeImage(w, h) {
    const n = w * h;
    return {
      width: w, height: h, bitDepth: 8, colorType: 'NODE', error: null,
      channels: { R: new Uint8Array(n), G: new Uint8Array(n), B: new Uint8Array(n), A: new Uint8Array(n).fill(255) }
    };
  }

  function readChannel(image, key, i) {
    const c = image.channels;
    if (key === 'L') {
      const r = c.R ? c.R[i] : 0, g = c.G ? c.G[i] : r, b = c.B ? c.B[i] : r;
      return Math.round(0.299 * r + 0.587 * g + 0.114 * b);
    }
    const a = c[key];
    if (a) return a[i];
    if (key === 'A') return 255;
    return c.R ? c.R[i] : 0;
  }

  // 一进一出通用：fn(v, i, image) 返回 0..255
  function mapGray(image, fn) {
    const w = image.width, h = image.height, n = w * h;
    const out = makeImage(w, h);
    for (let i = 0; i < n; i++) {
      const v = fn(i);
      out.channels.R[i] = out.channels.G[i] = out.channels.B[i] = v;
    }
    return out;
  }

  // ---------- 操作块 ----------
  function opChannel(image, p) {
    const key = p.ch || 'R', inv = !!p.invert;
    return { image: mapGray(image, i => {
      const v = readChannel(image, key, i);
      return inv ? 255 - v : v;
    }) };
  }

  function opPlane(image, p) {
    const key = p.ch || 'R';
    const bit = clampInt(p.bit, 0, 7, 0);
    return { image: mapGray(image, i => ((readChannel(image, key, i) >> bit) & 1) ? 255 : 0) };
  }

  function opGray(image) {
    return { image: mapGray(image, i => readChannel(image, 'L', i)) };
  }

  function opInvert(image) {
    const w = image.width, h = image.height, n = w * h;
    const out = makeImage(w, h);
    for (let i = 0; i < n; i++) {
      const c = image.channels;
      out.channels.R[i] = c.R ? 255 - c.R[i] : 0;
      out.channels.G[i] = c.G ? 255 - c.G[i] : 0;
      out.channels.B[i] = c.B ? 255 - c.B[i] : 0;
      out.channels.A[i] = c.A ? c.A[i] : 255;
    }
    return { image: out };
  }

  function opThreshold(image, p) {
    const level = clampInt(p.level, 0, 255, 128);
    const key = p.ch || 'L';
    return { image: mapGray(image, i => readChannel(image, key, i) >= level ? 255 : 0) };
  }

  function opOrder(image, p) {
    const order = String(p.order || 'RGB').toUpperCase();
    if (!/^[RGB]{3}$/.test(order) || new Set(order).size !== 3) return { error: '通道顺序必须是 RGB 三色的排列' };
    const w = image.width, h = image.height, n = w * h;
    const out = makeImage(w, h);
    const c = image.channels;
    const dst = { R: out.channels.R, G: out.channels.G, B: out.channels.B };
    for (let k = 0; k < 3; k++) {
      const src = c[order[k]];
      const d = dst['RGB'[k]];
      if (!src) continue;
      for (let i = 0; i < n; i++) d[i] = src[i];
    }
    if (c.A) out.channels.A.set(c.A.subarray(0, n));
    return { image: out };
  }

  function opCrop(image, p) {
    const w0 = image.width, h0 = image.height;
    const x = clampInt(p.x, 0, Math.max(0, w0 - 1), 0);
    const y = clampInt(p.y, 0, Math.max(0, h0 - 1), 0);
    const w = p.w > 0 ? clampInt(p.w, 1, w0 - x, w0 - x) : w0 - x;
    const h = p.h > 0 ? clampInt(p.h, 1, h0 - y, h0 - y) : h0 - y;
    const out = makeImage(w, h);
    const c = image.channels;
    for (let yy = 0; yy < h; yy++) {
      for (let xx = 0; xx < w; xx++) {
        const si = (y + yy) * w0 + (x + xx), di = yy * w + xx;
        out.channels.R[di] = c.R ? c.R[si] : 0;
        out.channels.G[di] = c.G ? c.G[si] : 0;
        out.channels.B[di] = c.B ? c.B[si] : 0;
        out.channels.A[di] = c.A ? c.A[si] : 255;
      }
    }
    return { image: out };
  }

  function opScale(image, p) {
    const w = p.w > 0 ? clampInt(p.w, 1, 8192, image.width) : image.width;
    const h = p.h > 0 ? clampInt(p.h, 1, 8192, image.height) : image.height;
    if (w * h > 50000000) return { error: '目标尺寸过大（像素上限 5000 万）' };
    const out = makeImage(w, h);
    const c = image.channels, sw = image.width;
    for (let y = 0; y < h; y++) {
      const sy = Math.min(image.height - 1, Math.floor(y * image.height / h));
      for (let x = 0; x < w; x++) {
        const sx = Math.min(sw - 1, Math.floor(x * sw / w));
        const si = sy * sw + sx, di = y * w + x;
        out.channels.R[di] = c.R ? c.R[si] : 0;
        out.channels.G[di] = c.G ? c.G[si] : 0;
        out.channels.B[di] = c.B ? c.B[si] : 0;
        out.channels.A[di] = c.A ? c.A[si] : 255;
      }
    }
    return { image: out };
  }

  // 双输入按左上角对齐，尺寸取两者最小值
  function opTwoImages(a, b, fn) {
    if (!a) return { error: '缺少第一路输入' };
    if (!b) return { error: '缺少第二路输入' };
    const w = Math.min(a.width, b.width), h = Math.min(a.height, b.height);
    const out = makeImage(w, h);
    const hasA = !!(a.channels.A && b.channels.A);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const ia = y * a.width + x, ib = y * b.width + x, di = y * w + x;
        out.channels.R[di] = fn(readChannel(a, 'R', ia), readChannel(b, 'R', ib));
        out.channels.G[di] = fn(readChannel(a, 'G', ia), readChannel(b, 'G', ib));
        out.channels.B[di] = fn(readChannel(a, 'B', ia), readChannel(b, 'B', ib));
        out.channels.A[di] = hasA ? fn(a.channels.A[ia], b.channels.A[ib]) : 255;
      }
    }
    return { image: out };
  }

  function opXor(p, inputs) {
    return opTwoImages(inputs[0], inputs[1], (x, y) => x ^ y);
  }

  function opDiff(p, inputs) {
    return opTwoImages(inputs[0], inputs[1], (x, y) => Math.abs(x - y));
  }

  function opPosterize(image, p) {
    const bits = clampInt(p.bits, 1, 8, 4);
    if (bits >= 8) return { image };
    const levels = (1 << bits) - 1;
    const q = v => Math.round(Math.round(v * levels / 255) * 255 / levels);
    const w = image.width, h = image.height, n = w * h;
    const out = makeImage(w, h);
    for (let i = 0; i < n; i++) {
      const c = image.channels;
      out.channels.R[i] = q(c.R ? c.R[i] : 0);
      out.channels.G[i] = q(c.G ? c.G[i] : 0);
      out.channels.B[i] = q(c.B ? c.B[i] : 0);
      out.channels.A[i] = c.A ? c.A[i] : 255;
    }
    return { image: out };
  }

  function opSpectrum(image) {
    if (!MDZ.spectrum) return { error: '频域模块未加载' };
    const r = MDZ.spectrum(image);
    if (!r || !r.image) return { error: '图像太小或无法计算频域（至少 32x32）' };
    return { image: r.image };
  }

  // 调色板：BMP/GIF 自带 palette 时直接画；否则按出现次数取前 256 色
  function opPalette(image) {
    let pal = image.palette;
    if (!pal || pal.length < 3) {
      const freq = new Map();
      const c = image.channels, n = image.width * image.height;
      for (let i = 0; i < n; i++) {
        const r = c.R ? c.R[i] : 0, g = c.G ? c.G[i] : 0, b = c.B ? c.B[i] : 0;
        const k = (r << 16) | (g << 8) | b;
        freq.set(k, (freq.get(k) || 0) + 1);
      }
      const top = Array.from(freq.entries()).sort((a, b) => b[1] - a[1]).slice(0, 256);
      pal = new Uint8Array(top.length * 3);
      top.forEach(([k], i) => {
        pal[i * 3] = (k >> 16) & 255; pal[i * 3 + 1] = (k >> 8) & 255; pal[i * 3 + 2] = k & 255;
      });
    }
    const count = Math.min(256, Math.floor(pal.length / 3));
    if (!count) return { error: '没有可显示的调色板' };
    const cols = 16, cell = 16, rows = Math.ceil(count / cols);
    const out = makeImage(cols * cell, rows * cell);
    for (let i = 0; i < out.width * out.height; i++) {
      out.channels.R[i] = 28; out.channels.G[i] = 38; out.channels.B[i] = 42;
    }
    for (let i = 0; i < count; i++) {
      const x = (i % cols) * cell, y = Math.floor(i / cols) * cell;
      for (let yy = 0; yy < cell - 1; yy++) {
        for (let xx = 0; xx < cell - 1; xx++) {
          const di = (y + yy) * out.width + (x + xx);
          out.channels.R[di] = pal[i * 3];
          out.channels.G[di] = pal[i * 3 + 1];
          out.channels.B[di] = pal[i * 3 + 2];
        }
      }
    }
    return { image: out };
  }

  // ---------- 节点定义 ----------
  const NODE_OPS = {
    source: { label: '图像输入', inputs: 0, params: [] },
    channel: {
      label: '通道', inputs: 1, params: [
        { key: 'ch', label: '通道', type: 'select', options: ['R', 'G', 'B', 'A', 'L'], def: 'R' },
        { key: 'invert', label: '反色', type: 'check', def: false }
      ]
    },
    plane: {
      label: '位平面', inputs: 1, params: [
        { key: 'ch', label: '通道', type: 'select', options: ['R', 'G', 'B', 'A', 'L'], def: 'R' },
        { key: 'bit', label: '位', type: 'number', min: 0, max: 7, def: 0 }
      ]
    },
    gray: { label: '转灰度', inputs: 1, params: [] },
    invert: { label: '反色', inputs: 1, params: [] },
    threshold: {
      label: '阈值', inputs: 1, params: [
        { key: 'level', label: '阈值', type: 'number', min: 0, max: 255, def: 128 },
        { key: 'ch', label: '依据', type: 'select', options: ['L', 'R', 'G', 'B', 'A'], def: 'L' }
      ]
    },
    posterize: {
      label: '量化', inputs: 1, params: [
        { key: 'bits', label: '位数', type: 'number', min: 1, max: 8, def: 4 }
      ]
    },
    order: {
      label: '通道重排', inputs: 1, params: [
        { key: 'order', label: '顺序', type: 'select', options: ['RGB', 'RBG', 'GRB', 'GBR', 'BRG', 'BGR'], def: 'RGB' }
      ]
    },
    crop: {
      label: '裁剪', inputs: 1, params: [
        { key: 'x', label: 'X', type: 'number', min: 0, def: 0 },
        { key: 'y', label: 'Y', type: 'number', min: 0, def: 0 },
        { key: 'w', label: '宽', type: 'number', min: 1, def: 0 },
        { key: 'h', label: '高', type: 'number', min: 1, def: 0 }
      ]
    },
    scale: {
      label: '缩放', inputs: 1, params: [
        { key: 'w', label: '宽', type: 'number', min: 1, max: 8192, def: 0 },
        { key: 'h', label: '高', type: 'number', min: 1, max: 8192, def: 0 }
      ]
    },
    xor: { label: 'XOR 双图', inputs: 2, params: [] },
    diff: { label: '差值双图', inputs: 2, params: [] },
    spectrum: { label: '频域图', inputs: 1, params: [] },
    palette: { label: '调色板', inputs: 1, params: [] },
    output: { label: '输出', inputs: 1, params: [] }
  };

  function defaultParams(type) {
    const def = NODE_OPS[type];
    const p = {};
    if (!def) return p;
    for (const f of def.params) p[f.key] = f.def;
    return p;
  }

  function applyNodeOp(type, params, inputs) {
    const p = params || {};
    const ins = inputs || [];
    const first = ins[0] || null;
    if (type === 'output') {
      return first ? { image: first } : { error: '输出节点没有输入' };
    }
    if (type === 'xor') return opXor(p, ins);
    if (type === 'diff') return opDiff(p, ins);
    if (!first || !first.channels || !(first.width > 0) || !(first.height > 0)) {
      return { error: '缺少输入图像' };
    }
    switch (type) {
      case 'channel': return opChannel(first, p);
      case 'plane': return opPlane(first, p);
      case 'gray': return opGray(first);
      case 'invert': return opInvert(first);
      case 'threshold': return opThreshold(first, p);
      case 'posterize': return opPosterize(first, p);
      case 'order': return opOrder(first, p);
      case 'crop': return opCrop(first, p);
      case 'scale': return opScale(first, p);
      case 'spectrum': return opSpectrum(first);
      case 'palette': return opPalette(first);
      default: return { error: '未知节点类型：' + type };
    }
  }

  // 图求值：sources = { 节点id: 图像 }
  function evalNodeGraph(nodes, links, sources) {
    const byId = new Map();
    for (const n of nodes || []) byId.set(n.id, n);
    const incoming = new Map();
    for (const l of links || []) {
      const to = byId.get(l.to);
      if (!to) continue;
      const def = NODE_OPS[to.type] || { inputs: 1 };
      const port = Math.max(0, Math.min((def.inputs || 1) - 1, l.port | 0));
      incoming.set(l.to + ':' + port, l.from);
    }
    const src = sources || {};
    const memo = new Map(), errors = new Map(), visiting = new Set();

    function evalInput(id, port) {
      const from = incoming.get(id + ':' + port);
      if (from === undefined) return null;
      return evalNode(from);
    }

    function evalNode(id) {
      if (memo.has(id)) return memo.get(id);
      if (errors.has(id)) return null;
      if (visiting.has(id)) { errors.set(id, '检测到环（节点互相引用）'); return null; }
      const n = byId.get(id);
      if (!n) return null;
      visiting.add(id);
      let img = null;
      try {
        if (n.type === 'source') {
          img = src[id] || null;
          if (!img) errors.set(id, '未选择图像');
        } else {
          const def = NODE_OPS[n.type] || { inputs: 1 };
          const inputs = [];
          for (let i = 0; i < (def.inputs || 1); i++) inputs.push(evalInput(id, i));
          const r = applyNodeOp(n.type, n.params, inputs);
          if (r.error) { if (!errors.has(id)) errors.set(id, r.error); }
          else img = r.image;
        }
      } catch (e) {
        errors.set(id, String(e && e.message || e));
      }
      visiting.delete(id);
      if (img) memo.set(id, img);
      return img;
    }

    for (const n of nodes || []) evalNode(n.id);
    const images = {}, errs = {};
    for (const [k, v] of memo) images[k] = v;
    for (const [k, v] of errors) errs[k] = v;
    return { images, errors: errs };
  }

  Object.assign(MDZ, { NODE_OPS, applyNodeOp, evalNodeGraph, nodeDefaultParams: defaultParams, makeImage });
})(typeof globalThis !== 'undefined' ? globalThis : this);
