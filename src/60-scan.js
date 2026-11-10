/* misc大手子 — 60 像素扫描
 * 位平面 / LSB：多通道 × 位 × 顺序 × 打包 × 子集，带打分，避免“命中即报”。
 */
(function (root) {
  'use strict';
  const MDZ = root.MDZ = root.MDZ || {};
  const { toU8, ascii, entropy, printableRatio, finding, artifact, inflateZlib } = MDZ;

  const SETS = {
    R: ['R'], G: ['G'], B: ['B'], A: ['A'],
    RGB: ['R', 'G', 'B'], RGBA: ['R', 'G', 'B', 'A'],
    BGR: ['B', 'G', 'R'], GRB: ['G', 'R', 'B'], RBG: ['R', 'B', 'G'],
    GBR: ['G', 'B', 'R'], BRG: ['B', 'R', 'G'],
    RG: ['R', 'G'], GB: ['G', 'B'], RB: ['R', 'B'],
    // 四位通道里 Alpha 排在最前面的次序：StegSolve 的 AGBR 等选项就藏在这里
    AGBR: ['A', 'G', 'B', 'R'], ARGB: ['A', 'R', 'G', 'B'], ABGR: ['A', 'B', 'G', 'R'],
    ABRG: ['A', 'B', 'R', 'G'], ARBG: ['A', 'R', 'B', 'G'], AGRB: ['A', 'G', 'R', 'B'],
    GARB: ['G', 'A', 'R', 'B'], BGRA: ['B', 'G', 'R', 'A'],
    // 16-bit 样本的高字节平面（channelBytes 会自动生成 *hi）
    Rhi: ['Rhi'], Ghi: ['Ghi'], Bhi: ['Bhi'], Ahi: ['Ahi'],
    RGBhi: ['Rhi', 'Ghi', 'Bhi'], RGBAhi: ['Rhi', 'Ghi', 'Bhi', 'Ahi']
  };

  const MAGICS = [
    { sig: [0x50, 0x4B, 0x03, 0x04], name: 'ZIP' },
    { sig: [0x89, 0x50, 0x4E, 0x47], name: 'PNG' },
    { sig: [0xFF, 0xD8, 0xFF], name: 'JPEG' },
    { sig: [0x47, 0x49, 0x46, 0x38], name: 'GIF' },
    { sig: [0x42, 0x4D], name: 'BMP' },
    { sig: [0x1F, 0x8B], name: 'GZIP' },
    { sig: [0x78, 0x9C], name: 'zlib' },
    { sig: [0x78, 0xDA], name: 'zlib' },
    { sig: [0x25, 0x50, 0x44, 0x46], name: 'PDF' },
    { sig: [0x52, 0x61, 0x72, 0x21], name: 'RAR' },
    { sig: [0x37, 0x7A, 0xBC, 0xAF], name: '7Z' },
    { sig: [0x00, 0x00, 0x01, 0x00], name: 'ICO' }
  ];

  // FLAG_RE 仍是严格的 word{...}；#...# 型噪声太大，只在本模块的像素打分里用
  const FLAG_RE = /(flag|ctf|litctf|susctf|qctf|ctfshow)\{[ -~]{1,200}\}/i;

  function channelBytes(image) {
    // 16-bit 通道拆成低字节 + 高字节；统一返回 Uint8Array
    const map = {};
    for (const k of Object.keys(image.channels || {})) {
      const a = image.channels[k];
      if (!a) continue;
      if (a instanceof Uint16Array) {
        const lo = new Uint8Array(a.length), hi = new Uint8Array(a.length);
        for (let i = 0; i < a.length; i++) { lo[i] = a[i] & 255; hi[i] = (a[i] >> 8) & 255; }
        map[k] = lo; map[k + 'hi'] = hi;
      } else {
        map[k] = a instanceof Uint8Array ? a : new Uint8Array(a);
      }
    }
    return map;
  }

  function buildMask(image, chans, subset) {
    if (subset === 'all') return null;
    image._masks = image._masks || {};
    if (image._masks[subset]) return image._masks[subset];   // 同图同 mask 只算一次，深扫要复用几千次
    const n = image.width * image.height;
    const mask = new Uint8Array(n);
    const R = chans.R, G = chans.G, B = chans.B;
    if (subset === 'nearWhite') {
      for (let i = 0; i < n; i++) mask[i] = (R && G && B && R[i] >= 200 && G[i] >= 200 && B[i] >= 200) ? 1 : 0;
    } else if (subset === 'nonWhite') {
      for (let i = 0; i < n; i++) mask[i] = !(R && G && B && R[i] >= 245 && G[i] >= 245 && B[i] >= 245) ? 1 : 0;
    } else {
      return null;
    }
    image._masks[subset] = mask;
    return mask;
  }

  // 返回打包后的字节 + 实际使用的 bit 数
  function extract(image, chans, keys, bitSpec, order, packing, subset) {
    const bitList = Array.isArray(bitSpec) ? bitSpec : [bitSpec];
    const w = image.width, h = image.height, n = w * h;
    const mask = subset === 'all' ? null : buildMask(image, chans, subset);
    const plan = keys.map(k => chans[k]).filter(Boolean);
    if (!plan.length) return null;
    let totalPixels = n;
    if (mask) {
      image._maskCounts = image._maskCounts || {};
      totalPixels = image._maskCounts[subset] || (image._maskCounts[subset] = mask.reduce((a, b) => a + b, 0));
    }
    const totalBits = totalPixels * plan.length * bitList.length;
    const byteLen = Math.floor(totalBits / 8);
    if (byteLen < 4) return null;
    const out = new Uint8Array(byteLen);
    let acc = 0, bits = 0, oi = 0;
    const P = plan.length, B = bitList.length, msbMode = packing === 'msb';
    const a0 = plan[0], a1 = P > 1 ? plan[1] : null, a2 = P > 2 ? plan[2] : null, a3 = P > 3 ? plan[3] : null;
    // 热循环：不再每 bit 调一次 push()
    for (let step = 0; step < n; step++) {
      const i = order === 'col' ? (step % h) * w + (step / h | 0) : step;
      if (mask && !mask[i]) continue;
      for (let c = 0; c < P; c++) {
        const v = c === 0 ? a0[i] : c === 1 ? a1[i] : c === 2 ? a2[i] : a3[i];
        for (let bi = 0; bi < B; bi++) {
          const bv = (v >> bitList[bi]) & 1;
          if (msbMode) acc = (acc << 1) | bv; else acc |= bv << bits;
          if (++bits === 8) { out[oi++] = acc; acc = 0; bits = 0; }
        }
      }
    }
    return out;
  }

  function scoreStream(bytes, meta) {
    let score = 0;
    let strong = false;
    let hardStrong = false;
    const reasons = [];
    const head = bytes.subarray(0, Math.min(bytes.length, 65536));   // 载荷可能在流后段，别只看 4KB
    // 魔数
    for (const m of MAGICS) {
      for (let off = 0; off <= Math.min(64, head.length - m.sig.length); off++) {
        let ok = true;
        for (let k = 0; k < m.sig.length; k++) if (head[off + k] !== m.sig[k]) { ok = false; break; }
        if (ok) {
          score += off === 0 ? 60 : 30;
          reasons.push(`${m.name}@${off}`);
          strong = true;   // 魔数只是候选；重复字节惩罚仍可把它压下去
          break;
        }
      }
    }
    // 合法 zlib
    if (head.length > 8 && MDZ.isZlibHeader(head, 0)) {
      const z = inflateZlib(head, 0, 8 * 1024 * 1024);
      if (z.out && z.out.length > 8 && !z.error) { score += 50; reasons.push(`zlib→${z.out.length}B`); strong = true; hardStrong = true; }
    }
    // flag 匹配走全局格式（默认 flag{...}，可在 UI 改）
    const text = ascii(head, Math.min(head.length, 4096));
    const fm = MDZ.flagMatch(text);
    if (fm) {
      const at = text.indexOf(fm);
      const custom = MDZ.isFlagFormatCustom();
      // 自定义格式（#...# 一类）在噪声里也能偶然出现：只给靠前命中的高分
      score += !custom ? 100 : (at < 64 ? 90 : 35);
      reasons.push(`flag@${at}`);
      strong = true;
      if (!custom || at < 64) hardStrong = true;
    }
    // 可打印率
    const pr = printableRatio(head);
    if (pr > 0.85) {
      score += 25; reasons.push(`可打印 ${(pr * 100).toFixed(0)}%`);
      if (pr > 0.92 && head.length >= 32) strong = true;
    } else if (pr > 0.7) { score += 12; reasons.push(`可打印 ${(pr * 100).toFixed(0)}%`); }
    // UTF-8
    if (MDZ.utf8(head)) { score += 6; }
    // 熵
    const ent = entropy(head);
    if (ent > 0.5 && ent < 7.2) { score += 5; reasons.push(`熵 ${ent.toFixed(2)}`); }
    // 全 0/全 FF 惩罚
    let nonzero = 0;
    for (let i = 0; i < head.length; i++) if (head[i] !== 0 && head[i] !== 0xFF) { nonzero++; }
    if (nonzero < head.length * 0.05) score -= 40;
    // 重复字节惩罚：自然图像的 LSB 常出现 0x55/0xAA 长串，不能当明文
    if (!hardStrong && head.length) {
      const freq = new Uint32Array(256);
      for (let i = 0; i < head.length; i++) freq[head[i]]++;
      let uniq = 0, maxf = 0;
      for (let i = 0; i < 256; i++) if (freq[i]) { uniq++; if (freq[i] > maxf) maxf = freq[i]; }
      if (uniq <= 2 || maxf > head.length * 0.7) { score -= 35; strong = false; }
    }
    return { score, reasons, entropy: ent, printable: pr, strong };
  }

  function autoCandidates(pixels) {
    const big = (pixels || 0) > 1500000;
    if (big) {
      // 大图只跑最可能命中的组合，避免 UI 卡顿；深度扫描另开
      return [
        { sets: 'RGB', bit: 0, order: 'row', packing: 'msb', subset: 'all' },
        { sets: 'RGB', bit: 0, order: 'row', packing: 'msb', subset: 'nearWhite' },
        { sets: 'RGB', bit: 0, order: 'col', packing: 'msb', subset: 'all' },
        { sets: 'BGR', bit: 0, order: 'row', packing: 'msb', subset: 'all' },
        { sets: 'RGBA', bit: 0, order: 'row', packing: 'msb', subset: 'all' },
        { sets: 'R', bit: 0, order: 'row', packing: 'msb', subset: 'all' },
        { sets: 'G', bit: 0, order: 'row', packing: 'msb', subset: 'all' },
        { sets: 'B', bit: 0, order: 'row', packing: 'msb', subset: 'all' },
        { sets: 'RGBhi', bit: 0, order: 'row', packing: 'msb', subset: 'all' },
        { sets: 'RGB', bit: 7, order: 'row', packing: 'msb', subset: 'all' }
      ];
    }
    const out = [];
    const sets = ['RGB', 'RGBA', 'BGR', 'R', 'G', 'B', 'RGBhi', 'RGBAhi', 'Rhi', 'Ghi', 'Bhi'];
    for (const s of sets) {
      for (const order of ['row', 'col']) {
        for (const packing of ['msb', 'lsb']) {
          for (const subset of ['all', 'nearWhite']) {
            out.push({ sets: s, bit: 0, order, packing, subset });
          }
        }
      }
    }
    // bit1 只跑最常见的组合
    out.push({ sets: 'RGB', bit: 1, order: 'row', packing: 'msb', subset: 'all' });
    out.push({ sets: 'RGB', bit: 1, order: 'row', packing: 'msb', subset: 'nearWhite' });
    // MSB（bit7）也是最常见的一类隐写，默认就带上
    out.push({ sets: 'RGB', bit: 7, order: 'row', packing: 'msb', subset: 'all' });
    out.push({ sets: 'RGBA', bit: 7, order: 'row', packing: 'msb', subset: 'all' });
    return out;
  }

  function deepCandidates(maxBit) {
    const out = [];
    const sets = Object.keys(SETS);
    for (const s of sets) {
      for (let bit = 0; bit <= (maxBit === undefined ? 7 : maxBit); bit++) {
        for (const order of ['row', 'col']) {
          for (const packing of ['msb', 'lsb']) {
            for (const subset of ['all', 'nearWhite', 'nonWhite']) {
              out.push({ sets: s, bit, order, packing, subset });
            }
          }
        }
      }
    }
    // 多位组合（两三个位平面拼起来当一条流，StegSolve 可以勾多行）
    for (const s of ['RGB', 'RGBA', 'AGBR', 'RG', 'GBR']) {
      for (const bits of [[1, 2], [2, 1], [0, 1], [1, 0], [2, 3], [3, 2], [0, 1, 2]]) {
        for (const order of ['row', 'col']) {
          for (const packing of ['msb', 'lsb']) {
            out.push({ sets: s, bits, order, packing, subset: 'all' });
          }
        }
      }
    }
    return out;
  }

  function scanOnce(image, cand) {
    const chans = image._chans || (image._chans = channelBytes(image));
    const keys = SETS[cand.sets] || SETS.RGB;
    if (!keys.every(k => chans[k])) return null;
    const bytes = extract(image, chans, keys, cand.bits || cand.bit, cand.order, cand.packing, cand.subset);
    if (!bytes || bytes.length < 8) return null;
    return bytes;
  }

  function scanImage(image, opts) {
    const o = opts || {};
    const findings = [], artifacts = [];
    if (!image || !image.channels) return { findings, artifacts, candidates: [] };
    const chans = image._chans || (image._chans = channelBytes(image));
    const px = image.width * image.height;
    let cands;
    let limited = false;
    if (o.deep) {
      cands = deepCandidates(o.maxBit);
      if (px > 1500000) {
        const lowBits = c => (c.bits ? Math.max(...c.bits) : c.bit) <= 2;
        cands = cands.filter(c => lowBits(c) && c.order === 'row' && ['RGB', 'RGBA', 'BGR'].includes(c.sets));
        limited = true;
      }
    } else {
      cands = autoCandidates(px);
    }
    const seen = new Set();
    const results = [];
    for (const c of cands) {
      const keys = SETS[c.sets];
      if (!keys.every(k => chans[k])) continue;
      const bytes = scanOnce(image, c);
      if (!bytes) continue;
      const h = MDZ.fnv1a(bytes.subarray(0, Math.min(4096, bytes.length)));
      if (seen.has(h)) continue;
      seen.add(h);
      const s = scoreStream(bytes, c);
      if (s.score >= 30 && s.strong) results.push({ cand: c, bytes, score: s.score, reasons: s.reasons, entropy: s.entropy, printable: s.printable });
    }
    if (limited) {
      findings.push(finding('L4', 'scan_limit', '深度扫描已按大图裁剪组合', {
        confidence: 0.8,
        detail: `图像 ${image.width}x${image.height} 超过 1.5M 像素，深度模式只跑 bit0-2 / RGB·RGBA·BGR / row。需要全组合请分块处理。`
      }));
    }
    results.sort((a, b) => b.score - a.score);
    const top = results.slice(0, o.top || 12);
    for (const r of top) {
      const c = r.cand;
      const bitLabel = c.bits ? c.bits.join('+') : c.bit;
      const label = `${c.sets} bit${bitLabel} ${c.order}/${c.packing}/${c.subset}`;
      findings.push(finding('L4', 'lsb', `LSB 候选：${label}（${r.score} 分）`, {
        confidence: Math.min(0.99, r.score / 100),
        declared: `${image.width}x${image.height}`, actual: `${r.bytes.length} 字节`,
        detail: '证据：' + r.reasons.join('；'),
        preview: ascii(r.bytes, 160),
        recipe: `按 ${c.sets} 通道、bit${bitLabel}、${c.order} 序、${c.packing} 打包提取` + (c.subset !== 'all' ? `，仅取 ${c.subset} 像素` : ''),
        payload: { name: `lsb-${c.sets}-b${bitLabel}-${c.order}-${c.packing}-${c.subset}.bin`, bytes: r.bytes }
      }));
      artifacts.push(artifact(`lsb-${c.sets}-b${bitLabel}-${c.order}-${c.packing}-${c.subset}.bin`, r.bytes, `LSB 候选（${r.score} 分）`, 'lsb'));
    }
    return { findings, artifacts, candidates: results.length, top };
  }

  // ---------- 渲染 ----------
  function renderImage(image, maxSide) {
    if (!image || !image.channels || !(image.width > 0) || !(image.height > 0)) return null;
    const w = image.width, h = image.height;
    const scale = maxSide ? Math.min(1, maxSide / Math.max(w, h)) : 1;
    const W = Math.max(1, Math.round(w * scale)), H = Math.max(1, Math.round(h * scale));
    const out = new Uint8ClampedArray(W * H * 4);
    const c = image._chans || (image._chans = channelBytes(image));
    for (let y = 0; y < H; y++) {
      const sy = Math.min(h - 1, Math.floor(y / scale));
      for (let x = 0; x < W; x++) {
        const sx = Math.min(w - 1, Math.floor(x / scale));
        const si = sy * w + sx, di = (y * W + x) * 4;
        // 16-bit 预览用高字节，低字节看起来会像噪声
        out[di] = c.Rhi ? c.Rhi[si] : (c.R ? c.R[si] : 0);
        out[di + 1] = c.Ghi ? c.Ghi[si] : (c.G ? c.G[si] : 0);
        out[di + 2] = c.Bhi ? c.Bhi[si] : (c.B ? c.B[si] : 0);
        out[di + 3] = c.Ahi ? c.Ahi[si] : (c.A ? c.A[si] : 255);
      }
    }
    return { width: W, height: H, data: out };
  }

  function renderPlane(image, key, bit, opts) {
    if (!image || !image.channels || !(image.width > 0) || !(image.height > 0)) return null;
    const o = opts || {};
    const w = image.width, h = image.height;
    const chans = image._chans || (image._chans = channelBytes(image));
    const a = chans[key] || chans.R;
    if (!a) return null;
    const out = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      let v = ((a[i] >> bit) & 1) ? 255 : 0;
      if (o.invert) v = 255 - v;
      const di = i * 4;
      out[di] = out[di + 1] = out[di + 2] = v;
      out[di + 3] = 255;
    }
    return { width: w, height: h, data: out };
  }

  Object.assign(MDZ, {
    SCAN_SETS: SETS, FLAG_RE, channelBytes, extract, scoreStream,
    autoCandidates, deepCandidates, scanImage, renderImage, renderPlane
  });
})(typeof globalThis !== 'undefined' ? globalThis : this);
