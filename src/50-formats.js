/* misc大手子 — 50 GIF / ICO / SVG / ZIP
 * 「其余基础」：结构审计 + 载荷提取，够用即止。
 */
(function (root) {
  'use strict';
  const MDZ = root.MDZ = root.MDZ || {};
  const { toU8, hex, ascii, utf8, strings, finding, artifact } = MDZ;

  function le16(b, o) { return b[o] | (b[o + 1] << 8); }
  function le32(b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0; }
  // PSD 等大端格式用
  function rd16(b, o) { return (b[o] << 8) | b[o + 1]; }
  function rd32(b, o) { return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0; }
  // 文件大小远在 2^53 以内，用 double 拼 64 位即可
  function le64(b, o) { return le32(b, o) + le32(b, o + 4) * 0x100000000; }

  // ZIP64 的 0x0001 扩展字段：只包含那些 32 位字段为 0xFFFFFFFF 的值，顺序固定
  function zip64Extra(b, start, len) {
    const end = Math.min(b.length, start + len);
    let p = start;
    while (p + 4 <= end) {
      const id = le16(b, p), sz = le16(b, p + 2);
      if (p + 4 + sz > end) return null;
      if (id === 0x0001) return b.subarray(p + 4, p + 4 + sz);
      p += 4 + sz;
    }
    return null;
  }

  // EOCD 里的 0xFFFF/0xFFFFFFFF 只是哨兵，真值在紧邻的 ZIP64 EOCD 记录里
  function zip64EOCD(b, eocdPos) {
    const loc = eocdPos - 20;
    if (loc < 0 || b[loc] !== 0x50 || b[loc + 1] !== 0x4B || b[loc + 2] !== 0x06 || b[loc + 3] !== 0x07) return null;
    const off = le64(b, loc + 8);
    if (off + 56 > b.length) return null;
    if (b[off] !== 0x50 || b[off + 1] !== 0x4B || b[off + 2] !== 0x06 || b[off + 3] !== 0x06) return null;
    return { count: le64(b, off + 32), cdSize: le64(b, off + 40), cdOffset: le64(b, off + 48) };
  }

  // ---------- base64 ----------
  const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  function b64decode(str) {
    const s = String(str).replace(/[^A-Za-z0-9+\/=]/g, '');
    const out = [];
    let buf = 0, bits = 0;
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (c === '=') break;
      const v = B64.indexOf(c);
      if (v < 0) continue;
      buf = (buf << 6) | v;
      bits += 6;
      if (bits >= 8) {
        bits -= 8;
        out.push((buf >> bits) & 255);
      }
    }
    return Uint8Array.from(out);
  }

  // ---------- GIF ----------
  function isGIF(input) {
    const b = toU8(input);
    return b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38;
  }

  // ---------- GIF: LZW 解码 ----------
  function lzwDecode(minCodeSize, data, maxPixels) {
    if (minCodeSize < 2 || minCodeSize > 8) return { indices: new Uint8Array(0), decoded: 0, error: '非法 LZW 最小码长：' + minCodeSize };
    const clear = 1 << minCodeSize;
    const end = clear + 1;
    let codeSize = minCodeSize + 1;
    let next = end + 1;
    const dict = [];
    for (let i = 0; i < clear; i++) dict[i] = [i];
    dict[clear] = [];
    dict[end] = [];
    let prev = null;
    const out = new Uint8Array(Math.max(0, maxPixels));
    let oi = 0;
    let bitPos = 0;
    const totalBits = data.length * 8;
    function readCode() {
      if (bitPos + codeSize > totalBits) return -1;
      let code = 0;
      for (let i = 0; i < codeSize; i++) {
        const byte = data[(bitPos >> 3)];
        code |= ((byte >> (bitPos & 7)) & 1) << i;
        bitPos++;
      }
      return code;
    }
    while (oi < out.length) {
      const code = readCode();
      if (code < 0) break;
      if (code === clear) {
        codeSize = minCodeSize + 1;
        next = end + 1;
        dict.length = end + 1;
        prev = null;
        continue;
      }
      if (code === end) break;
      let entry;
      if (code < next && dict[code]) entry = dict[code];
      else if (code === next && prev) {
        entry = prev.concat(prev[0]);
      } else break; // 码表损坏
      for (let i = 0; i < entry.length && oi < out.length; i++) out[oi++] = entry[i];
      if (prev && next < 4096) {
        const ne = prev.concat(entry[0]);
        dict[next++] = ne;
        if (next === (1 << codeSize) && codeSize < 12) codeSize++;
      }
      prev = entry;
    }
    return { indices: out, decoded: oi, error: oi === 0 ? 'LZW 未解出像素' : null };
  }

  function deinterlaceGIF(indices, w, h) {
    const out = new Uint8Array(w * h);
    let src = 0;
    const passes = [[0, 8], [4, 8], [2, 4], [1, 2]];
    for (const [start, step] of passes) {
      for (let y = start; y < h; y += step) {
        for (let x = 0; x < w; x++) {
          if (src < indices.length) out[y * w + x] = indices[src++];
        }
      }
    }
    return out;
  }

  function gifFrameImage(frame, gct, opts) {
    const o = opts || {};
    const pal = frame.palette || gct;
    if (!pal) return { error: '帧没有可用调色板' };
    const w = frame.width, h = frame.height;
    if (!w || !h) return { error: '帧尺寸为 0' };
    if (w * h > 50000000) return { error: `帧像素数过大：${w}x${h}` };
    // full 模式多解 4096 行：GIF 帧高度被改小时，LZW 里往往还压着下面的画面
    const cap = o.full
      ? Math.min(50000000, Math.max(w * h, w * Math.min(65535, h + (o.extraRows || 4096))))
      : w * h;
    const dec = lzwDecode(frame.lzwMin, frame.data, cap);
    if (dec.error) return { error: dec.error };
    const fullRows = Math.floor(dec.decoded / w);
    const extraRows = o.full && fullRows > h ? fullRows - h : 0;
    const outH = o.full && fullRows > h ? fullRows : h;
    const idx = frame.interlace ? deinterlaceGIF(dec.indices, w, outH) : dec.indices;
    const n = w * outH;
    const R = new Uint8Array(n), G = new Uint8Array(n), B = new Uint8Array(n), A = new Uint8Array(n);
    A.fill(255);
    for (let i = 0; i < n; i++) {
      const k = idx[i];
      const p = k * 3;
      if (p + 2 < pal.length) { R[i] = pal[p]; G[i] = pal[p + 1]; B[i] = pal[p + 2]; }
      if (frame.transparent && k === frame.transparentIndex) A[i] = 0;
    }
    return {
      error: null,
      image: { width: w, height: outH, bitDepth: 8, colorType: 'GIF', channels: { R, G, B, A }, error: null, palette: pal },
      indices: idx, lzwDecoded: dec.decoded,
      fullHeight: fullRows, extraRows, declaredHeight: h
    };
  }

  // 把某帧的描述符高度与逻辑屏高度改大（LZW 数据里有完整帧时用）
  function editGIFDims(input, frameIndex, height) {
    const b = toU8(input);
    const g = parseGIF(b);
    if (g.error) return { error: g.error };
    const idx = Math.max(0, Math.min(g.frames.length - 1, frameIndex | 0));
    const f = g.frames[idx];
    if (!f) return { error: '帧不存在' };
    const h = Math.max(1, Math.min(65535, Math.round(Number(height))));
    if (!isFinite(h) || h < 1) return { error: '高度必须是正整数' };
    const out = new Uint8Array(b);
    const lsdH = Math.max(h, g.lsd.height);
    out[8] = lsdH & 255; out[9] = (lsdH >> 8) & 255;
    out[f.offset + 7] = h & 255;
    out[f.offset + 8] = (h >> 8) & 255;
    return { bytes: out, height: h, canvasHeight: lsdH, frameIndex: idx, frameOffset: f.offset };
  }

  // ---------- GIF: 结构 ----------
  function parseGIF(input) {
    const b = toU8(input);
    if (!isGIF(b)) return { error: 'not GIF' };
    let pos = 6;
    if (pos + 7 > b.length) return { error: 'LSD 截断' };
    const lsd = {
      version: ascii(b.subarray(3, 6), 3),
      width: le16(b, pos), height: le16(b, pos + 2),
      packed: b[pos + 4], bg: b[pos + 5], aspect: b[pos + 6]
    };
    const hasGCT = !!(lsd.packed & 0x80);
    const gctSize = hasGCT ? 3 * (1 << ((lsd.packed & 7) + 1)) : 0;
    pos += 7;
    const gct = hasGCT && pos + gctSize <= b.length ? b.subarray(pos, pos + gctSize) : null;
    pos += gctSize;
    const frames = [];
    const comments = [];
    const apps = [];
    let trailer = -1;
    let pendingGCE = null;
    while (pos < b.length) {
      const marker = b[pos++];
      if (marker === 0x3B) { trailer = pos; break; }
      if (marker === 0x21) {
        if (pos >= b.length) break;
        const label = b[pos++];
        const blocks = [];
        while (pos < b.length) {
          const len = b[pos++];
          if (len === 0) break;
          blocks.push(b.subarray(pos, Math.min(b.length, pos + len)));
          pos += len;
        }
        if (label === 0xFE) comments.push(blocks.map(x => ascii(x, x.length)).join(''));
        else if (label === 0xFF) {
          const id = blocks[0] ? ascii(blocks[0], Math.min(11, blocks[0].length)) : '';
          apps.push({ id, blocks: blocks.length });
        } else if (label === 0xF9 && blocks[0] && blocks[0].length >= 4) {
          const g = blocks[0];
          pendingGCE = {
            packed: g[0],
            delay: g[1] | (g[2] << 8),
            transparent: !!(g[0] & 1),
            transparentIndex: g[3],
            disposal: (g[0] >> 2) & 7
          };
        }
      } else if (marker === 0x2C) {
        if (pos + 9 > b.length) break;
        const desc = {
          offset: pos - 1, left: le16(b, pos), top: le16(b, pos + 2),
          width: le16(b, pos + 4), height: le16(b, pos + 6), packed: b[pos + 8]
        };
        pos += 9;
        const hasLCT = !!(desc.packed & 0x80);
        const lctSize = hasLCT ? 3 * (1 << ((desc.packed & 7) + 1)) : 0;
        const palette = hasLCT && pos + lctSize <= b.length ? b.subarray(pos, pos + lctSize) : null;
        pos += lctSize;
        if (pos >= b.length) break;
        const lzwMin = b[pos++];
        const chunks = [];
        while (pos < b.length) {
          const len = b[pos++];
          if (len === 0) break;
          chunks.push(b.subarray(pos, Math.min(b.length, pos + len)));
          pos += len;
        }
        const data = MDZ.concatBytes ? MDZ.concatBytes(chunks) : (() => {
          let total = 0; for (const c of chunks) total += c.length;
          const out = new Uint8Array(total); let p = 0;
          for (const c of chunks) { out.set(c, p); p += c.length; }
          return out;
        })();
        const gce = pendingGCE || { packed: 0, delay: 0, transparent: false, transparentIndex: 0, disposal: 0 };
        pendingGCE = null;
        frames.push(Object.assign(desc, {
          interlace: !!(desc.packed & 0x40),
          palette, lzwMin, data, gce,
          transparent: gce.transparent, transparentIndex: gce.transparentIndex,
          disposal: gce.disposal, delay: gce.delay
        }));
      } else {
        break;
      }
    }
    return {
      error: null, lsd, hasGCT, gctSize, gct, frames, comments, apps,
      trailer, trailing: trailer > 0 && trailer < b.length ? b.subarray(trailer) : null
    };
  }

  function auditGIF(input, name) {
    const b = toU8(input);
    const findings = [], artifacts = [];
    const g = parseGIF(b);
    if (g.error) return { findings: [finding('L0', 'format', '不是 GIF', { detail: g.error })], artifacts, image: null, images: [], parsed: g };

    findings.push(finding('L1', 'gif_header', `GIF${g.lsd.version} ${g.lsd.width}x${g.lsd.height}`, {
      confidence: 0.2, offset: 0, actual: `${g.frames.length} 帧`,
      detail: (g.hasGCT ? `全局调色板 ${g.gctSize / 3} 色` : '无全局调色板') + '；本版已支持 LZW 逐帧解码与逐帧 LSB 扫描。'
    }));

    for (const c of g.comments) {
      findings.push(finding('L3', 'gif_comment', 'GIF Comment Extension', {
        confidence: /flag|ctf|pass|key/i.test(c) ? 0.95 : 0.6,
        actual: c.slice(0, 200), preview: c.slice(0, 300), recipe: '解析 0x21 0xFE 扩展块'
      }));
    }
    for (const a of g.apps) {
      if (/NETSCAPE/i.test(a.id)) continue;
      findings.push(finding('L3', 'gif_app', `GIF 应用扩展：${a.id}`, { confidence: 0.4, actual: `${a.blocks} 个子块` }));
    }
    if (g.trailing && g.trailing.length) {
      findings.push(finding('L1', 'trailer', 'GIF 结束符 0x3B 之后还有数据', {
        confidence: 0.95, offset: g.trailer, actual: `${g.trailing.length} 字节`,
        preview: ascii(g.trailing, 120), recipe: `从 0x${hex(g.trailer)} 切出`,
        payload: { name: 'gif-trailer.bin', bytes: g.trailing.slice(0) }
      }));
      artifacts.push(artifact('gif-trailer.bin', g.trailing, 'GIF 0x3B 之后的数据'));
    }

    const images = [];
    let decoded = 0;
    let skipped = 0;
    // 逐帧全解码（含「比声明高度多出来的行」）很贵：100 帧 400×400 要 13 秒 / 314MB。
    // 帧数与总像素各设一个上限，超出的帧保留元数据、不解码，并在发现里说清楚。
    let pxBudget = 32 * 1000 * 1000;
    for (let i = 0; i < g.frames.length; i++) {
      const f = g.frames[i];
      if (decoded >= 64 || pxBudget <= 0) { skipped++; continue; }
      const r = gifFrameImage(f, g.gct, { full: true });
      if (r.error) {
        findings.push(finding('L4', 'gif_frame', `第 ${i} 帧解码失败`, {
          confidence: 0.65, offset: f.offset,
          declared: `${f.width}x${f.height}`, actual: r.error,
          recipe: '检查 LZW 最小码长 / 子块 / 调色板'
        }));
        continue;
      }
      decoded++;
      pxBudget -= r.image.width * r.image.height;
      f.image = r.image;
      f.indices = r.indices;
      f.fullHeight = r.fullHeight;
      f.extraRows = r.extraRows;
      images.push({
        name: `gif-frame-${i}`, image: r.image,
        note: `GIF 第 ${i} 帧 ${f.width}x${r.image.height}${r.extraRows ? '（含声明的 ' + f.height + ' 行之外的 ' + r.extraRows + ' 行）' : ''}${f.interlace ? '（隔行）' : ''}${f.transparent ? '，含透明色' : ''}`
      });
      findings.push(finding('L4', 'gif_frame', `第 ${i} 帧可解码：${f.width}x${r.image.height}`, {
        confidence: 0.5, offset: f.offset,
        declared: `${f.width}x${f.height} @(${f.left},${f.top})${f.interlace ? ' 隔行' : ''}`,
        actual: `${r.lzwDecoded} 像素${f.palette ? '，本地调色板' : '，全局调色板'}${f.transparent ? '，透明索引 ' + f.transparentIndex : ''}`,
        recipe: '已加入递归队列，自动做位平面/LSB 扫描'
      }));
      if (r.extraRows > 0) {
        findings.push(finding('L1', 'gif_extra_rows', `第 ${i} 帧比声明高度多 ${r.extraRows} 行`, {
          confidence: 0.99, offset: f.offset,
          declared: `${f.width}x${f.height}`,
          actual: `${f.width}x${r.fullHeight}（LZW 解出 ${r.lzwDecoded} 像素）`,
          detail: 'GIF 帧的 height 被改小，LZW 数据里还压着下面的画面。完整帧已加入查看器/扫描队列，可用「完整帧」按钮修复并重新分析。',
          preview: `帧 ${i}：${f.width}×${f.height} → ${f.width}×${r.fullHeight}`,
          recipe: '按 LZW 实际像素数 / 帧宽 得到真实高度，再把 LSD 与帧描述符的 height 改回去'
        }));
      }
    }
    if (g.frames.length) {
      findings.push(finding('L4', 'gif_frames', `GIF 共 ${g.frames.length} 帧，已解码 ${decoded} 帧`, {
        confidence: 0.35,
        detail: '多帧 GIF 的隐写常在某一帧的 LSB 或调色板；每帧都已作为独立图像进入扫描队列。',
        recipe: '位平面查看器可逐帧切换'
      }));
    }
    if (skipped) {
      findings.push(finding('L2', 'gif_frames_limit', `另有 ${skipped} 帧未解码（超过 ${decoded} 帧 / 3200 万像素上限）`, {
        confidence: 0.9,
        declared: `共 ${g.frames.length} 帧`,
        actual: `已解码 ${decoded}，跳过 ${skipped}`,
        detail: '逐帧全解码很贵（100 帧 400×400 约 13 秒 / 314MB），这里设了上限。跳过的帧仍保留偏移与尺寸，可用帧表里的按钮单独解码。',
        recipe: '用帧表逐帧打开，或先用 gifsicle 拆帧'
      }));
    }
    return { findings, artifacts, image: null, images, parsed: g };
  }

  // ---------- TIFF ----------
  function isTIFF(input) {
    const b = toU8(input);
    return b.length >= 4 && ((b[0] === 0x49 && b[1] === 0x49 && b[2] === 0x2A && b[3] === 0x00) ||
      (b[0] === 0x4D && b[1] === 0x4D && b[2] === 0x00 && b[3] === 0x2A));
  }

  function tiffNums(t) {
    if (!t) return null;
    const v = Array.isArray(t.value) ? t.value : [t.value];
    return v.map(x => typeof x === 'number' ? x : parseInt(x, 10)).filter(x => Number.isFinite(x));
  }

  function tiffPackBits(src, maxOut) {
    const out = new Uint8Array(maxOut);
    let i = 0, o = 0;
    while (i < src.length && o < maxOut) {
      const n = (src[i++] << 24) >> 24;
      if (n >= 0) {
        const take = Math.min(n + 1, src.length - i, maxOut - o);
        out.set(src.subarray(i, i + take), o);
        o += take; i += n + 1;
      } else if (n !== -128) {
        if (i >= src.length) break;
        const v = src[i++];
        const take = Math.min(1 - n, maxOut - o);
        out.fill(v, o, o + take);
        o += take;
      }
    }
    return o ? out.subarray(0, o) : null;
  }

  function tiffLZW(src, maxOut) {
    let bitPos = 0;
    const readCode = (width) => {
      let v = 0;
      for (let i = 0; i < width; i++) {
        const byte = src[bitPos >> 3];
        if (byte === undefined) return -1;
        v = (v << 1) | ((byte >> (7 - (bitPos & 7))) & 1);
        bitPos++;
      }
      return v;
    };
    const out = [];
    let width = 9, dict = [], next = 258, prev = null;
    const reset = () => { dict = []; next = 258; width = 9; prev = null; };
    reset();
    while (out.length < maxOut) {
      const code = readCode(width);
      if (code < 0) break;
      if (code === 256) { reset(); continue; }
      if (code === 257) break;
      let entry;
      if (code < 258) entry = [code];
      else if (code < next && dict[code - 258]) entry = dict[code - 258];
      else if (code === next && prev) entry = prev.concat([prev[0]]);
      else break;
      for (const x of entry) if (out.length < maxOut) out.push(x);
      if (prev && next < 4096) {
        dict[next - 258] = prev.concat([entry[0]]);
        next++;
        if (next === (1 << width) - 1 && width < 12) width++;
      }
      prev = entry;
    }
    return out.length ? Uint8Array.from(out) : null;
  }

  // 基线 TIFF 像素：无压缩 / PackBits / LZW / Deflate，8/16 位，chunky 平面
  function tiffDecode(b, tags, little) {
    const get = id => tags.find(t => t.tag === id && t.ifd === 'IFD0');
    const w = (tiffNums(get(0x0100)) || [0])[0];
    const h = (tiffNums(get(0x0101)) || [0])[0];
    if (!(w > 0) || !(h > 0) || w * h > 20e6) return { error: '尺寸无效' };
    const compression = (tiffNums(get(0x0103)) || [1])[0];
    const photo = (tiffNums(get(0x0106)) || [1])[0];
    const spp = (tiffNums(get(0x0115)) || [1])[0];
    const bits = (tiffNums(get(0x0102)) || [8])[0];
    const planar = (tiffNums(get(0x011C)) || [1])[0];
    const predictor = (tiffNums(get(0x013D)) || [1])[0];
    const rowsPerStrip = (tiffNums(get(0x0116)) || [h])[0] || h;
    const offsets = tiffNums(get(0x0111)) || [];
    const counts = tiffNums(get(0x0117)) || [];
    if (planar !== 1) return { error: '平面配置 2 暂不支持' };
    if (!offsets.length || !counts.length) return { error: '缺少 strip offsets' };
    if (![1, 4, 8, 16].includes(bits)) return { error: bits + ' 位样本暂不支持' };
    if (predictor === 2 && bits !== 8) return { error: 'predictor 2 目前只解 8 位样本' };
    const bytesPerSample = bits === 16 ? 2 : 1;
    const rowBytes = Math.ceil(w * spp * bits / 8);
    const raw = new Uint8Array(rowBytes * h);
    let outRow = 0, maxEnd = 0;
    for (let s = 0; s < offsets.length && outRow < h; s++) {
      const off = offsets[s], len = counts[s];
      if (!Number.isFinite(off) || !Number.isFinite(len) || off + len > b.length) continue;
      maxEnd = Math.max(maxEnd, off + len);
      const stripRows = Math.min(rowsPerStrip, h - outRow);
      const need = stripRows * rowBytes;
      let decoded;
      if (compression === 1) decoded = b.subarray(off, off + Math.min(len, need));
      else if (compression === 32773) decoded = tiffPackBits(b.subarray(off, off + len), need);
      else if (compression === 5) decoded = tiffLZW(b.subarray(off, off + len), need);
      else if (compression === 8 || compression === 32946) {
        const z = MDZ.inflateZlib(b.subarray(off, off + len), 0, need);
        decoded = z.out;
      } else return { error: '压缩方式 ' + compression + ' 不支持', maxEnd };
      if (!decoded || decoded.length < need) return { error: '条带解压后不足 ' + need + ' 字节', maxEnd };
      if (predictor === 2 && bits === 8) {
        for (let r = 0; r < stripRows; r++) {
          const ro = r * rowBytes;
          for (let i = spp; i < rowBytes; i++) decoded[ro + i] = (decoded[ro + i] + decoded[ro + i - spp]) & 255;
        }
      }
      raw.set(decoded.subarray(0, need), outRow * rowBytes);
      outRow += stripRows;
    }
    if (!outRow) return { error: '没有可解码的条带' };
    const n = w * h;
    const R = new Uint8Array(n), G = new Uint8Array(n), B = new Uint8Array(n), A = new Uint8Array(n).fill(255);
    const sample = (x, y, c) => {
      const base = y * rowBytes + x * spp * bytesPerSample + c * bytesPerSample;
      if (base >= raw.length) return 0;
      return bits === 16 ? raw[base + (little ? 1 : 0)] : raw[base];
    };
    let palette = null;
    if (photo === 3) {
      const cm = tiffNums(get(0x0140)) || [];
      const size = 1 << bits;
      if (cm.length >= size * 3) {
        palette = new Uint8Array(size * 3);
        for (let i = 0; i < size; i++) {
          palette[i * 3] = (cm[i] >> 8) & 255;
          palette[i * 3 + 1] = (cm[i + size] >> 8) & 255;
          palette[i * 3 + 2] = (cm[i + 2 * size] >> 8) & 255;
        }
      }
    }
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (bits === 1 || bits === 4) {
          const byte = raw[y * rowBytes + ((x * bits) >> 3)];
          let v;
          if (bits === 1) v = (byte >> (7 - (x & 7))) & 1;
          else v = (x & 1) ? (byte & 15) : (byte >> 4);
          if (photo === 0) v = (bits === 1 ? 1 - v : 15 - v);
          const g = bits === 1 ? v * 255 : v * 17;
          R[i] = G[i] = B[i] = g;
        } else if (photo === 2) {
          R[i] = sample(x, y, 0); G[i] = sample(x, y, 1); B[i] = sample(x, y, 2);
          if (spp >= 4) A[i] = sample(x, y, 3);
        } else if (photo === 3) {
          const idx = sample(x, y, 0);
          if (palette && idx * 3 + 2 < palette.length) {
            R[i] = palette[idx * 3]; G[i] = palette[idx * 3 + 1]; B[i] = palette[idx * 3 + 2];
          }
        } else if (photo === 0 || photo === 1) {
          let g = sample(x, y, 0);
          if (photo === 0) g = 255 - g;
          R[i] = G[i] = B[i] = g;
        } else {
          return { error: 'Photometric ' + photo + ' 暂不支持', maxEnd };
        }
      }
    }
    return {
      image: { width: w, height: h, bitDepth: bits, colorType: 'TIFF', channels: { R, G, B, A }, error: null },
      maxEnd,
      meta: { compression, photo, spp, bits, predictor, rowsPerStrip, strips: offsets.length }
    };
  }

  const TIFF_COMP = { 1: '无压缩', 5: 'LZW', 8: 'Deflate', 32773: 'PackBits', 32946: 'Deflate' };

  function auditTIFF(input, name) {
    const b = toU8(input);
    const findings = [], artifacts = [];
    if (!isTIFF(b)) return { findings: [finding('L0', 'format', '不是 TIFF')], artifacts, image: null };
    let ex;
    try { ex = MDZ.parseEXIF(b, 0); } catch (e) { ex = { error: String(e && e.message || e) }; }
    if (!ex || ex.error) {
      findings.push(finding('L1', 'tiff', 'TIFF 头解析失败', { confidence: 0.8, detail: (ex && ex.error) || '未知' }));
      return { findings, artifacts, image: null, parsed: ex };
    }
    const tags = ex.tags || [];
    const ifds = Array.from(new Set(tags.map(t => t.ifd)));
    findings.push(finding('L1', 'tiff_header', `TIFF（${ex.order}），${ifds.length} 个 IFD`, {
      confidence: 0.3, offset: 0, actual: ifds.join(' / '),
      detail: '已解析 IFD/ExifIFD/GPS/IFD1；基线像素（无压缩/PackBits/LZW/Deflate）也会解码进扫描链。'
    }));
    const lines = [];
    let flagHit = null;
    for (const t of tags) {
      if (!t.name || /^Tag_0x/.test(t.name)) continue;
      let v = t.value;
      if (Array.isArray(v)) v = v.join(',');
      v = String(v == null ? '' : v);
      if (!v) continue;
      lines.push(`${t.ifd}/${t.name}: ${v}`);
      if (!flagHit) {
        const m = v.match(/(?:flag|ctf|litctf|susctf|qctf|ctfshow)\{[ -~]{1,200}\}/i);
        if (m) flagHit = { tag: t, flag: m[0] };
      }
    }
    if (lines.length) {
      findings.push(finding('L3', 'tiff_tags', 'TIFF 标签', {
        confidence: flagHit ? 0.95 : 0.5, offset: 8,
        declared: `${tags.length} 个标签`, actual: `${lines.length} 个有值`,
        detail: lines.slice(0, 60).join('\n'), preview: lines.slice(0, 15).join('\n'),
        recipe: '按 IFD 读取标签；ASCII/UNDEFINED 类型直接看原值'
      }));
    }
    if (flagHit) {
      findings.push(finding('L3', 'tiff_flag', `TIFF 标签里出现 ${flagHit.flag}`, {
        confidence: 0.99, offset: flagHit.tag.valueOffset || 0,
        actual: flagHit.flag, preview: String(flagHit.tag.value).slice(0, 300),
        recipe: `读取 ${flagHit.tag.ifd}/${flagHit.tag.name}`
      }));
    }
    for (const ifdName of ['IFD0', 'IFD1']) {
      const offT = tags.find(t => t.tag === 0x0201 && t.ifd === ifdName);
      const lenT = tags.find(t => t.tag === 0x0202 && t.ifd === ifdName);
      if (!offT || !lenT) continue;
      const off = (Array.isArray(offT.value) ? offT.value[0] : parseInt(offT.value, 10)) >>> 0;
      const len = (Array.isArray(lenT.value) ? lenT.value[0] : parseInt(lenT.value, 10)) >>> 0;
      if (off && len && off + len <= b.length) {
        const bytes = b.subarray(off, off + len);
        artifacts.push(artifact(`tiff-${ifdName}-embedded.jpg`, bytes, `${ifdName} 内嵌 JPEG`));
        findings.push(finding('L3', 'tiff_embedded', `${ifdName} 内嵌 JPEG ${len} 字节`, {
          confidence: 0.7, offset: off, declared: `${len} 字节`, actual: `@0x${hex(off)}`,
          recipe: '已提取，递归分析内嵌图'
        }));
      }
    }
    const px = tiffDecode(b, tags, ex.order === 'II');
    let image = null;
    if (px.image) {
      image = px.image;
      findings.push(finding('L1', 'tiff_pixels', `TIFF 像素 ${image.width} × ${image.height} · ${px.meta.bits} 位 · ${TIFF_COMP[px.meta.compression] || px.meta.compression}`, {
        confidence: 0.85, offset: 0,
        actual: `photometric ${px.meta.photo} · ${px.meta.spp} 样本/像素 · ${px.meta.strips} 条带${px.meta.predictor === 2 ? ' · predictor 2' : ''}`,
        detail: '已解码为可扫描像素：位平面/LSB 会继续走后面的图像扫描链。'
      }));
    } else if (px.error) {
      findings.push(finding('L1', 'tiff_pixels_skip', 'TIFF 像素未解码：' + px.error, { confidence: 0.7 }));
    }
    if (px.maxEnd && px.maxEnd < b.length) {
      // IFD/标签值可能排在像素条带之后，所以从文件尾往前找连续可打印段
      let ts = b.length;
      while (ts > px.maxEnd && b[ts - 1] >= 32 && b[ts - 1] < 127) ts--;
      if (b.length - ts >= 8) {
        const tr = b.subarray(ts);
        findings.push(finding('L1', 'tiff_trailer', `文件尾部 ${tr.length} 字节可打印数据`, {
          confidence: 0.9, offset: ts,
          declared: `像素条带结束于 0x${hex(px.maxEnd)}`,
          actual: `可打印段从 0x${hex(ts)} 到文件尾`,
          preview: ascii(tr.subarray(0, 120), Math.min(120, tr.length))
        }));
        artifacts.push(artifact('tiff-trailer.bin', tr, 'TIFF 文件尾部的可打印数据'));
      }
    }
    const hits = MDZ.strings(b, 6).filter(x => /flag|ctf|pass|key|secret/i.test(x));
    if (hits.length && !flagHit) {
      findings.push(finding('L3', 'strings', 'TIFF 原始字节命中可打印串', {
        confidence: 0.6, actual: hits.slice(0, 8).join(' | '), preview: hits.slice(0, 20).join('\n')
      }));
    }
    return { findings, artifacts, image, parsed: { tags, order: ex.order, pixels: px.meta || null } };
  }

  // ---------- WebP ----------
  function isWEBP(input) {
    const b = toU8(input);
    return b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
      b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50;
  }

  function auditWEBP(input, name) {
    const b = toU8(input);
    const findings = [], artifacts = [];
    if (!isWEBP(b)) return { findings: [finding('L0', 'format', '不是 WebP')], artifacts, image: null };
    const riffSize = le32(b, 4);
    const chunks = [];
    let pos = 12;
    while (pos + 8 <= b.length) {
      const fourcc = ascii(b.subarray(pos, pos + 4), 4);
      const size = le32(b, pos + 4);
      const dataStart = pos + 8;
      const dataEnd = dataStart + size;
      if (dataEnd > b.length) {
        findings.push(finding('L1', 'webp', `WebP chunk 越界：${fourcc}`, {
          confidence: 0.85, offset: pos, declared: size + ' 字节', actual: (b.length - dataStart) + ' 字节'
        }));
        break;
      }
      chunks.push({ fourcc, offset: pos, size, data: b.subarray(dataStart, dataEnd) });
      pos = dataEnd + (size & 1);
    }
    findings.push(finding('L1', 'webp_header', `WebP（${chunks.length} 个 chunk）`, {
      confidence: 0.3, offset: 0, actual: chunks.map(c => c.fourcc).join(' / '),
      detail: `RIFF 声明 ${riffSize} 字节；像素解码暂不做，重点看 EXIF/XMP/ANMF/尾部。`
    }));
    for (const c of chunks) {
      if (c.fourcc === 'VP8X' && c.size >= 10) {
        const canvasW = 1 + (c.data[4] | (c.data[5] << 8) | (c.data[6] << 16));
        const canvasH = 1 + (c.data[7] | (c.data[8] << 8) | (c.data[9] << 16));
        findings.push(finding('L3', 'webp_vp8x', `VP8X 画布 ${canvasW}x${canvasH}`, {
          confidence: 0.3, offset: c.offset, actual: `flags=0x${hex(c.data[0], 2)}`
        }));
      }
      if (c.fourcc === 'EXIF') {
        let ex = null;
        try {
          if (c.data.length >= 6 && c.data[0] === 0x45 && c.data[1] === 0x78 && c.data[2] === 0x69 && c.data[3] === 0x66) ex = MDZ.parseEXIF(c.data, 6);
          if (!ex || ex.error) ex = MDZ.parseEXIF(c.data, 0);
        } catch (e) { ex = { error: String(e && e.message || e) }; }
        if (ex && !ex.error) {
          const lines = (ex.tags || []).filter(t => t.value != null && String(t.value)).map(t => `${t.ifd}/${t.name}: ${Array.isArray(t.value) ? t.value.join(',') : t.value}`);
          const txt = lines.join('\n');
          const m = txt.match(/(?:flag|ctf|litctf|susctf|qctf|ctfshow)\{[ -~]{1,200}\}/i);
          findings.push(finding('L3', 'webp_exif', `WebP EXIF（${(ex.tags || []).length} 个标签）`, {
            confidence: m ? 0.98 : 0.6, offset: c.offset,
            detail: txt.slice(0, 800), preview: txt.slice(0, 300),
            recipe: 'WebP EXIF chunk 内是 TIFF 结构，可带 Exif\\0\\0 前缀也可不带'
          }));
          artifacts.push(artifact('webp-exif.bin', c.data, 'WebP EXIF chunk'));
        } else {
          findings.push(finding('L3', 'webp_exif', 'WebP EXIF 存在但解析失败', { confidence: 0.6, offset: c.offset, detail: (ex && ex.error) || '' }));
        }
      }
      if (c.fourcc === 'XMP ') {
        const txt = utf8(c.data) || ascii(c.data, Math.min(c.data.length, 20000));
        const m = txt.match(/(?:flag|ctf|litctf|susctf|qctf|ctfshow)\{[ -~]{1,200}\}/i);
        findings.push(finding('L3', 'webp_xmp', 'WebP XMP', {
          confidence: m ? 0.98 : 0.5, offset: c.offset, preview: txt.slice(0, 300),
          actual: m ? m[0] : `${c.size} 字节`
        }));
      }
      if (c.fourcc === 'ANIM' || c.fourcc === 'ANMF') {
        findings.push(finding('L3', 'webp_anim', `WebP 动画 chunk：${c.fourcc}`, {
          confidence: 0.4, offset: c.offset, actual: `${c.size} 字节`,
          detail: 'WebP 动画帧可逐帧提取；当前版本只做结构审计。'
        }));
      }
    }
    const declaredEnd = 8 + riffSize;
    if (declaredEnd < b.length) {
      const tr = b.subarray(declaredEnd);
      findings.push(finding('L1', 'trailer', 'RIFF 声明长度之后还有数据', {
        confidence: 0.9, offset: declaredEnd, actual: `${tr.length} 字节`,
        preview: ascii(tr, 120), recipe: `从 0x${hex(declaredEnd)} 切出`,
        payload: { name: 'webp-trailer.bin', bytes: tr.slice(0) }
      }));
      artifacts.push(artifact('webp-trailer.bin', tr, 'RIFF 之后的数据'));
    }
    const hits = MDZ.strings(b, 6).filter(x => /flag|ctf|pass|key|secret/i.test(x));
    if (hits.length) {
      findings.push(finding('L3', 'strings', 'WebP 原始字节命中可打印串', {
        confidence: 0.6, actual: hits.slice(0, 8).join(' | '), preview: hits.slice(0, 20).join('\n')
      }));
    }
    return { findings, artifacts, image: null, parsed: { chunks } };
  }

  // ---------- ICO ----------
  function isICO(input) {
    const b = toU8(input);
    return b.length >= 6 && b[0] === 0 && b[1] === 0 && b[2] === 1 && b[3] === 0;
  }

  function parseICO(input) {
    const b = toU8(input);
    if (!isICO(b)) return { error: 'not ICO' };
    const count = le16(b, 4);
    if (count > 256) return { error: 'count 异常：' + count };
    const frames = [];
    for (let i = 0; i < count; i++) {
      const p = 6 + i * 16;
      if (p + 16 > b.length) break;
      const w = b[p] || 256, h = b[p + 1] || 256;
      const bpp = le16(b, p + 6);
      const size = le32(b, p + 8);
      const offset = le32(b, p + 12);
      const data = offset + size <= b.length ? b.subarray(offset, offset + size) : null;
      frames.push({ index: i, width: w, height: h, bpp, size, offset, data });
    }
    return { error: null, count, frames };
  }

  function auditICO(input, name) {
    const b = toU8(input);
    const findings = [], artifacts = [];
    const ico = parseICO(b);
    if (ico.error) return { findings: [finding('L0', 'format', '不是 ICO', { detail: ico.error })], artifacts, image: null, parsed: ico };

    findings.push(finding('L1', 'ico_frames', `ICO 含 ${ico.frames.length} 帧`, {
      confidence: 0.3, offset: 0,
      actual: ico.frames.map(f => `${f.width}x${f.height}@${f.bpp}bpp`).join(' / '),
      detail: '多帧 ICO 常把 data 藏在某一帧；注意“大帧其实是缩略图”的迷魂阵。'
    }));

    const images = [];
    for (const f of ico.frames) {
      if (!f.data) {
        findings.push(finding('L1', 'ico_frame', `第 ${f.index} 帧越界`, { confidence: 0.8, offset: f.offset, declared: f.size + ' 字节' }));
        continue;
      }
      artifacts.push(artifact(`ico-frame-${f.index}-${f.width}x${f.height}.bin`, f.data, `ICO 第 ${f.index} 帧`));
      if (f.data[0] === 0x89 && f.data[1] === 0x50) {
        const dec = MDZ.decodePNG(f.data, {});
        if (!dec.error && dec.channels) {
          images.push({
            name: `ico-frame-${f.index}-${f.width}x${f.height}`, bytes: f.data,
            image: { width: dec.width, height: dec.height, bitDepth: dec.bitDepth, colorType: dec.colorType, channels: dec.channels, error: null },
            note: `ICO 第 ${f.index} 帧（PNG 存储）`, kind: 'image'
          });
          findings.push(finding('L4', 'ico_frame', `第 ${f.index} 帧可解码：${dec.width}x${dec.height}`, {
            confidence: 0.5, offset: f.offset, actual: `${f.size} 字节（PNG）`,
            recipe: '已加入递归队列，自动做位平面/LSB 扫描'
          }));
        }
      } else {
        findings.push(finding('L4', 'ico_bmp', `第 ${f.index} 帧为 BMP DIB`, {
          confidence: 0.4, offset: f.offset, detail: 'BMP 帧高度字段通常是显示高度的 2 倍（含 AND 掩码），本工具暂不逐帧解码。'
        }));
      }
    }
    return { findings, artifacts, image: images[0] ? images[0].image : null, images, parsed: ico };
  }

  // ---------- SVG ----------
  function isSVG(input) {
    const b = toU8(input);
    let s = '';
    const n = Math.min(b.length, 512);
    for (let i = 0; i < n; i++) s += String.fromCharCode(b[i]);
    return /^﻿?\s*(<\?xml|<!--|<svg[\s>])/i.test(s) && /<svg[\s>]/i.test(s);
  }

  function auditSVG(input, name) {
    const b = toU8(input);
    const text = utf8(b) || ascii(b, Math.min(b.length, 200000));
    const findings = [], artifacts = [];
    if (!/<svg[\s>]/i.test(text)) return { findings: [finding('L0', 'format', '不是 SVG')], artifacts, image: null };

    // 内嵌 data URI
    const re = /data:image\/(png|jpeg|jpg|gif|webp|bmp);base64,([A-Za-z0-9+\/=\s]+)/gi;
    let m, idx = 0;
    while ((m = re.exec(text)) !== null) {
      const bytes = b64decode(m[2]);
      if (!bytes.length) continue;
      idx++;
      const kind = m[1].toLowerCase();
      findings.push(finding('L2', 'svg_embedded', `SVG 内嵌第 ${idx} 张图（${kind}）`, {
        confidence: 0.95, offset: m.index,
        declared: `${m[2].length} 个 base64 字符`, actual: `${bytes.length} 字节`,
        detail: 'SVG 的 <image> 常直接内嵌 base64 图片；LSB 隐写往往在这张内嵌图上。',
        preview: ascii(bytes, 80),
        recipe: 'base64 解码后按图片格式继续分析',
        payload: { name: `svg-embedded-${idx}.bin`, bytes: bytes.slice(0) }
      }));
      artifacts.push(artifact(`svg-embedded-${idx}.${kind}`, bytes, `SVG 内嵌图 #${idx}`));
    }

    // 注释 / metadata / text
    const comments = [];
    const cre = /<!--([\s\S]*?)-->/g;
    while ((m = cre.exec(text)) !== null) comments.push(m[1].trim());
    for (const c of comments) {
      if (!c) continue;
      findings.push(finding('L3', 'svg_comment', 'SVG 注释', {
        confidence: /flag|ctf|pass|key/i.test(c) ? 0.95 : 0.4,
        offset: text.indexOf(c), actual: c.slice(0, 200), preview: c.slice(0, 300)
      }));
    }
    const texts = [];
    const tre = /<(text|title|desc|metadata)[^>]*>([\s\S]*?)<\/\1>/gi;
    while ((m = tre.exec(text)) !== null) {
      const t = m[2].replace(/<[^>]+>/g, '').trim();
      if (t) texts.push(t);
    }
    for (const t of texts) {
      if (!/flag|ctf|pass|key|\{/i.test(t)) continue;
      findings.push(finding('L3', 'svg_text', 'SVG 文本节点', {
        confidence: 0.7, offset: text.indexOf(t), actual: t.slice(0, 200), preview: t.slice(0, 300)
      }));
    }

    if (!idx && !findings.length) {
      findings.push(finding('L2', 'svg_image', 'SVG 未发现内嵌 base64 图', {
        confidence: 0.3, detail: '可能是外部 href、纯矢量图，或图片以其他编码内嵌。'
      }));
    }
    return { findings, artifacts, image: null, text };
  }

  // ---------- ZIP ----------
  function isZIP(input) {
    const b = toU8(input);
    if (b.length < 4 || b[0] !== 0x50 || b[1] !== 0x4B) return false;
    // 本地头 / 空档（只有中央目录）/ 跨卷，都算 ZIP
    return (b[2] === 0x03 && b[3] === 0x04) || (b[2] === 0x05 && b[3] === 0x06) || (b[2] === 0x07 && b[3] === 0x08);
  }

  // 从尾部找 EOCD（PK\x05\x06），带宽高限 65557，顺带取注释
  function parseZipEOCD(b) {
    const min = Math.max(0, b.length - 65557);
    for (let i = b.length - 22; i >= min; i--) {
      if (b[i] !== 0x50 || b[i + 1] !== 0x4B || b[i + 2] !== 0x05 || b[i + 3] !== 0x06) continue;
      let count = le16(b, i + 10);
      let cdSize = le32(b, i + 12);
      let cdOffset = le32(b, i + 16);
      const commentLen = le16(b, i + 20);
      if (count === 0xFFFF || cdSize === 0xFFFFFFFF || cdOffset === 0xFFFFFFFF) {
        const z64 = zip64EOCD(b, i);
        if (z64) { count = z64.count; cdSize = z64.cdSize; cdOffset = z64.cdOffset; }
      }
      if (cdOffset + cdSize > b.length) continue;
      const comment = commentLen > 0 && i + 22 + commentLen <= b.length
        ? b.subarray(i + 22, i + 22 + commentLen) : null;
      return { offset: i, count, cdSize, cdOffset, comment };
    }
    return null;
  }

  function parseZIP(input) {
    const b = toU8(input);
    if (!isZIP(b)) return { error: 'not ZIP' };
    const entries = [];
    const eocd = parseZipEOCD(b);
    // 首选中央目录：数据描述符（bit 3）条目只有中央目录才拿得到 csize
    if (eocd && eocd.count > 0) {
      let p = eocd.cdOffset, guard = 0;
      while (guard++ < 512 && p + 46 <= b.length) {
        if (b[p] !== 0x50 || b[p + 1] !== 0x4B || b[p + 2] !== 0x01 || b[p + 3] !== 0x02) break;
        const flags = le16(b, p + 8);
        const method = le16(b, p + 10);
        const crc = le32(b, p + 16);
        let csize = le32(b, p + 20);
        let usize = le32(b, p + 24);
        const nameLen = le16(b, p + 28);
        const extraLen = le16(b, p + 30);
        const commentLen = le16(b, p + 32);
        let localOffset = le32(b, p + 42);
        // ZIP64：32 位字段是 0xFFFFFFFF 时，真值按 usize → csize → localOffset 的顺序写在 0x0001 扩展里
        if (csize === 0xFFFFFFFF || usize === 0xFFFFFFFF || localOffset === 0xFFFFFFFF) {
          const body = zip64Extra(b, p + 46 + nameLen, extraLen);
          if (body) {
            let q = 0;
            const take = () => { if (q + 8 > body.length) return null; const v = le64(body, q); q += 8; return v; };
            if (usize === 0xFFFFFFFF) { const v = take(); if (v !== null) usize = v; }
            if (csize === 0xFFFFFFFF) { const v = take(); if (v !== null) csize = v; }
            if (localOffset === 0xFFFFFFFF) { const v = take(); if (v !== null) localOffset = v; }
          }
        }
        const nameB = b.subarray(p + 46, Math.min(b.length, p + 46 + nameLen));
        const name = utf8(nameB) || ascii(nameB, nameB.length);
        let dataStart = -1;
        if (localOffset + 30 <= b.length &&
            b[localOffset] === 0x50 && b[localOffset + 1] === 0x4B &&
            b[localOffset + 2] === 0x03 && b[localOffset + 3] === 0x04) {
          dataStart = localOffset + 30 + le16(b, localOffset + 26) + le16(b, localOffset + 28);
        }
        entries.push({
          offset: localOffset, name, flags, method, crc, csize, usize,
          encrypted: !!(flags & 1), hasDescriptor: !!(flags & 8), dataStart, fromCD: true
        });
        p += 46 + nameLen + extraLen + commentLen;
      }
    }
    // 中央目录缺失（截断 / 流式写出）：退回本地头顺序扫描
    if (!entries.length) {
      let pos = 0, guard = 0;
      while (guard++ < 512) {
        const p = findSig(b, [0x50, 0x4B, 0x03, 0x04], pos);
        if (p < 0 || p + 30 > b.length) break;
        const flags = le16(b, p + 6);
        const method = le16(b, p + 8);
        const crc = le32(b, p + 14);
        const csize = le32(b, p + 18);
        const usize = le32(b, p + 22);
        const nameLen = le16(b, p + 26);
        const extraLen = le16(b, p + 28);
        const nameB = b.subarray(p + 30, Math.min(b.length, p + 30 + nameLen));
        const name = utf8(nameB) || ascii(nameB, nameB.length);
        const dataStart = p + 30 + nameLen + extraLen;
        const hasDescriptor = !!(flags & 8);
        entries.push({ offset: p, name, flags, method, crc, csize, usize, encrypted: !!(flags & 1), hasDescriptor, dataStart, fromCD: false });
        if (hasDescriptor) {
          // 没有 csize：跳到下一个本地头 / 中央目录
          const a = findSig(b, [0x50, 0x4B, 0x03, 0x04], dataStart);
          const c = findSig(b, [0x50, 0x4B, 0x01, 0x02], dataStart);
          const cand = [a, c].filter(x => x >= 0).sort((x, y) => x - y)[0];
          if (cand === undefined) break;
          pos = cand;
          continue;
        }
        pos = dataStart + csize;
      }
    }
    return { error: null, entries, eocd };
  }

  function findSig(b, sig, from) {
    outer: for (let i = from; i + sig.length <= b.length; i++) {
      for (let k = 0; k < sig.length; k++) if (b[i + k] !== sig[k]) continue outer;
      return i;
    }
    return -1;
  }

  function unzipEntry(b, e) {
    if (e.dataStart < 0 || e.encrypted) return { data: null, error: null };
    const declared = e.csize === 0xFFFFFFFF ? null : e.csize;
    // 声明的条目越过文件尾 = 截断包：能拿多少给多少，但必须标成部分恢复
    if (declared != null && (e.dataStart > b.length || e.dataStart + declared > b.length)) {
      const data = e.dataStart < b.length ? b.subarray(e.dataStart, b.length) : null;
      return {
        data,
        error: '条目被截断：声明 ' + declared + ' 字节，实际 ' + Math.max(0, b.length - e.dataStart),
        partial: true
      };
    }
    const end = declared == null ? b.length : Math.min(b.length, e.dataStart + declared);
    if (e.method === 0) {
      const data = b.subarray(e.dataStart, end);
      const bad = e.crc && MDZ.crc32 && (MDZ.crc32(data) >>> 0) !== (e.crc >>> 0);
      return { data, error: bad ? 'CRC 不匹配（数据被改过或不是这个条目）' : null, partial: false };
    }
    if (e.method === 8) {
      // 只把条目自己的字节喂给解压器，别让它读进后面的中央目录
      const z = MDZ.inflateRaw(b.subarray(e.dataStart, end), 0, 64 * 1024 * 1024);
      const out = z.out && z.out.length ? z.out : null;
      let err = z.error || null;
      if (!err && out && e.crc && MDZ.crc32 && (MDZ.crc32(out) >>> 0) !== (e.crc >>> 0)) {
        err = 'CRC 不匹配（解压结果与声明不符）';
      }
      return { data: out, error: err, partial: !!err };
    }
    if (e.method === 14 && MDZ.lzmaDecompressAlone) {
      // method 14：2 字节版本 + 2 字节 props 长度(=5) + props/dict(5) + 裸 LZMA 数据
      // end 已按条目自己的 csize 截过：后面的成员和中央目录不会被喂进解码器
      if (e.dataStart + 4 > b.length) return { data: null, error: 'LZMA 头部缺失' };
      const ps = le16(b, e.dataStart + 2);
      if (ps !== 5) return { data: null, error: 'LZMA 头部异常' };
      const rest = end - (e.dataStart + 4 + ps);
      if (rest <= 0) return { data: null, error: 'LZMA 数据缺失' };
      const hdr = new Uint8Array(13 + rest);
      hdr.set(b.subarray(e.dataStart + 4, e.dataStart + 9), 0);
      if (e.usize && e.usize !== 0xFFFFFFFF) {
        for (let i = 0; i < 8; i++) hdr[5 + i] = Math.floor(e.usize / Math.pow(2, 8 * i)) & 255;
      } else {
        for (let i = 0; i < 8; i++) hdr[5 + i] = 0xFF;
      }
      hdr.set(b.subarray(e.dataStart + 4 + ps, end), 13);
      const dz = MDZ.lzmaDecompressAlone(hdr, { maxOut: 64 * 1024 * 1024 });
      return { data: dz.out && dz.out.length ? dz.out : null, error: dz.error, partial: !!dz.partial, fed: rest };
    }
    return { data: null, error: 'method ' + e.method + ' 未支持', unsupported: true };
  }

  function auditZIP(input, name) {
    const b = toU8(input);
    const findings = [], artifacts = [];
    const z = parseZIP(b);
    if (z.error) return { findings: [finding('L0', 'format', '不是 ZIP', { detail: z.error })], artifacts, image: null, parsed: z };

    // EOCD 注释：经典藏点，不打开压缩包也能带走一整段数据
    if (z.eocd && z.eocd.comment && z.eocd.comment.length) {
      const txt = ascii(z.eocd.comment, z.eocd.comment.length);
      findings.push(finding('L3', 'zip_comment', 'ZIP 注释（' + z.eocd.comment.length + ' 字节）', {
        confidence: 0.95, offset: z.eocd.offset + 22,
        declared: 'EOCD 记录 ' + z.eocd.count + ' 个条目', actual: txt.slice(0, 200),
        preview: txt,
        detail: 'ZIP 末尾 EOCD 的注释字段是经典藏点。',
        recipe: 'unzip -z <file>，或直接读 EOCD 之后的字节',
        payload: { name: 'zip-comment.txt', bytes: z.eocd.comment.slice(0) }
      }));
      artifacts.push(artifact('zip-comment.txt', z.eocd.comment, 'ZIP EOCD 注释'));
    }

    if (!z.entries.length) {
      findings.push(finding('L2', 'zip', z.eocd ? '空 ZIP（只有中央目录）' : 'ZIP 签名存在但未解析出条目', {
        confidence: 0.7,
        detail: z.eocd
          ? 'EOCD 显示 0 个条目；注释或尾部附加数据才是重点。'
          : '可能是截断的 ZIP、中央目录损坏，或只有 EOCD。',
        recipe: 'unzip -l 确认；再看文件尾部'
      }));
    }

    for (const e of z.entries) {
      findings.push(finding('L2', 'zip_entry', 'ZIP 条目：' + (e.name || '(无名)'), {
        confidence: e.encrypted ? 0.9 : 0.6, offset: e.offset,
        declared: e.usize + ' 字节 → ' + e.csize + ' 字节（method ' + e.method + (e.hasDescriptor ? '，数据描述符' : '') + '）',
        actual: e.encrypted ? 'ZipCrypto 加密' : '未加密',
        detail: e.encrypted ? '需要口令。可尝试 bkcrack（已知明文）或 john/hashcat（爆破）。' : '',
        recipe: e.encrypted ? 'bkcrack -C file.zip -c <已知条目>' : '直接解压'
      }));
      if (e.encrypted) continue;
      const r = unzipEntry(b, e);
      if (r.data && r.data.length) {
        artifacts.push(artifact('zip-' + (e.name || 'entry'), r.data,
          'ZIP 条目（method ' + e.method + (e.method === 0 ? ' stored' : '，已解压') + '）' + (r.partial ? ' · 部分提取' : '')));
      }
      if (r.error && r.unsupported) {
        findings.push(finding('L2', 'zip_method', 'ZIP 条目 ' + e.name + '：' + r.error, {
          confidence: 0.8, offset: e.offset,
          declared: 'method ' + e.method, actual: '未提取',
          detail: '该压缩方法还没实现解压；可以先用 7z / unzip 手工展开。',
          recipe: '7z x <file.zip>'
        }));
      } else if (r.error) {
        // 截断 / CRC 不符：即使已经拿到部分字节，也要明确说是「部分提取」
        findings.push(finding('L2', 'zip_extract', 'ZIP 条目 ' + (e.name || '(无名)') + '：' + r.error, {
          confidence: r.partial ? 0.9 : 0.8, offset: e.offset,
          declared: e.csize === 0xFFFFFFFF ? 'ZIP64 尺寸缺失' : e.csize + ' 字节',
          actual: r.data ? r.data.length + ' 字节' : '未提取',
          detail: r.partial ? '后面的字节不属于这个条目，产物只到截断处为止。' : '',
          recipe: 'unzip -t <file.zip> 核对完整性'
        }));
      }
    }
    return { findings, artifacts, image: null, parsed: z };
  }

  // ---------- TGA ----------
  // 无魔数格式：18 字节头 + 可选 ID/调色板 + 像素（可 RLE）+ 可选 26 字节 footer
  function parseTGA(b) {
    if (b.length < 18) return { error: '不足 18 字节' };
    const info = {
      idLength: b[0], colorMapType: b[1], imageType: b[2],
      colorMapFirst: le16(b, 3), colorMapLength: le16(b, 5), colorMapDepth: b[7],
      xOrigin: le16(b, 8), yOrigin: le16(b, 10),
      width: le16(b, 12), height: le16(b, 14),
      pixelDepth: b[16], descriptor: b[17]
    };
    if (info.width <= 0 || info.height <= 0) return { error: '宽高为 0' };
    if (![8, 15, 16, 24, 32].includes(info.pixelDepth)) return { error: 'bpp=' + info.pixelDepth + ' 不支持' };
    if (![1, 2, 3, 9, 10, 11].includes(info.imageType)) return { error: 'imageType=' + info.imageType + ' 不支持' };
    const bpp = Math.ceil(info.pixelDepth / 8);
    const cmapBytes = info.colorMapType ? info.colorMapLength * Math.ceil(info.colorMapDepth / 8) : 0;
    info.dataOffset = 18 + info.idLength + cmapBytes;
    info.topDown = !!(info.descriptor & 0x20);
    info.rightToLeft = !!(info.descriptor & 0x10);
    info.rle = info.imageType >= 9;
    info.footer = null;
    if (b.length >= 26) {
      const t = b.subarray(b.length - 18, b.length);
      if (ascii(t, 18).indexOf('TRUEVISION-XFILE') === 0) {
        info.footer = { extOffset: le32(b, b.length - 26), devOffset: le32(b, b.length - 22) };
      }
    }
    if (info.dataOffset > b.length) return { error: '像素数据偏移越界' };
    return info;
  }

  function decodeTGA(b, info) {
    const bpp = Math.ceil(info.pixelDepth / 8);
    const n = info.width * info.height;
    const R = new Uint8Array(n), G = new Uint8Array(n), B = new Uint8Array(n), A = new Uint8Array(n);
    const cmapDst = Math.ceil(info.colorMapDepth / 8);
    const cmapStart = 18 + info.idLength;
    const baseType = info.rle ? info.imageType - 8 : info.imageType;
    const pick = (at) => {
      // 返回 [r,g,b,a]
      if (baseType === 1) {
        const idx = bpp === 1 ? b[at] : le16(b, at);
        const off = cmapStart + (idx - info.colorMapFirst) * cmapDst;
        if (off < 0 || off + cmapDst > b.length) return [0, 0, 0, 0];
        if (cmapDst === 2) {
          const v = le16(b, off);
          return [((v >> 10) & 31) << 3, ((v >> 5) & 31) << 3, (v & 31) << 3, 255];
        }
        if (cmapDst === 3) return [b[off + 2], b[off + 1], b[off], 255];
        return [b[off + 2], b[off + 1], b[off], b[off + 3]];
      }
      if (baseType === 3) {
        if (bpp === 1) return [b[at], b[at], b[at], 255];
        return [b[at], b[at], b[at], 255];
      }
      if (bpp === 2) {
        const v = le16(b, at);
        return [((v >> 10) & 31) << 3, ((v >> 5) & 31) << 3, (v & 31) << 3, (v & 0x8000) ? 255 : 255];
      }
      if (bpp === 3) return [b[at + 2], b[at + 1], b[at], 255];
      return [b[at + 2], b[at + 1], b[at], b[at + 3]];
    };
    let p = info.dataOffset;
    let i = 0;
    try {
      while (i < n) {
        let count = 1, repeated = false;
        if (info.rle) {
          if (p >= b.length) throw new Error('RLE 数据提前结束');
          const hdr = b[p++];
          count = (hdr & 0x7F) + 1;
          repeated = !!(hdr & 0x80);
        }
        if (repeated) {
          if (p + bpp > b.length) throw new Error('像素数据被截断');
          const px = pick(p); p += bpp;
          for (let k = 0; k < count && i < n; k++, i++) { R[i] = px[0]; G[i] = px[1]; B[i] = px[2]; A[i] = px[3]; }
        } else {
          for (let k = 0; k < count && i < n; k++, i++) {
            if (p + bpp > b.length) throw new Error('像素数据被截断');
            const px = pick(p); p += bpp;
            R[i] = px[0]; G[i] = px[1]; B[i] = px[2]; A[i] = px[3];
          }
        }
      }
    } catch (e) {
      return { width: info.width, height: info.height, bitDepth: info.pixelDepth, colorType: 'TGA', channels: { R, G, B, A }, error: String(e && e.message || e), consumed: p };
    }
    return {
      width: info.width, height: info.height, bitDepth: info.pixelDepth, colorType: 'TGA',
      channels: { R, G, B, A }, error: null, consumed: p
    };
  }

  function auditTGA(input, name) {
    const b = toU8(input);
    const findings = [], artifacts = [];
    const info = parseTGA(b);
    if (info.error) return { findings: [finding('L0', 'format', '不是 TGA', { detail: info.error })], artifacts, image: null, info };
    const dec = decodeTGA(b, info);
    findings.push(finding('L1', 'tga', `TGA ${info.width} × ${info.height} · ${info.pixelDepth} bpp${info.rle ? ' · RLE' : ''}`, {
      confidence: 0.9, offset: 0,
      declared: `imageType ${info.imageType}${info.colorMapType ? '，调色板 ' + info.colorMapLength + ' 项' : ''}`,
      actual: dec.error ? dec.error : `${dec.consumed - info.dataOffset} 字节像素`,
      detail: (info.topDown ? '原点在左上' : '原点在左下（自下而上）') + (info.rightToLeft ? '，列方向从右到左' : '')
        + (info.idLength ? `；图像 ID ${info.idLength} 字节` : ''),
      recipe: '直接查看像素；TGA 无压缩头，改宽高只需改 12-15 字节'
    }));
    if (dec.error) {
      findings.push(finding('L2', 'tga_partial', 'TGA 像素不完整：' + dec.error, {
        confidence: 0.9, actual: '部分解码'
      }));
    }
    if (info.footer) {
      findings.push(finding('L2', 'tga_footer', 'TGA footer（扩展区/开发者目录）', {
        confidence: 0.8, offset: b.length - 26,
        declared: 'TRUEVISION-XFILE',
        actual: `扩展区 0x${hex(info.footer.extOffset)}，开发者目录 0x${hex(info.footer.devOffset)}`,
        detail: '扩展区（495 字节）里有作者名、注释、色表等字段，是常见的夹带位置。'
      }));
    }
    const end = dec.consumed || b.length;
    if (end < b.length && !info.footer) {
      const tail = b.subarray(end);
      findings.push(finding('L1', 'tga_trailer', `像素之后还有 ${tail.length} 字节`, {
        confidence: tail.some(x => x !== 0) ? 0.95 : 0.6, offset: end,
        declared: `像素区应到 0x${hex(end)}`, actual: `文件到 0x${hex(b.length)}`,
        detail: '多出来的尾部一般就是夹带数据。',
        preview: ascii(tail.subarray(0, 120), Math.min(120, tail.length))
      }));
      artifacts.push(artifact('tga-trailer.bin', tail, 'TGA 尾部附加数据'));
    }
    return { findings, artifacts, image: dec.error ? null : dec, info, parsed: { info, consumed: dec.consumed } };
  }

  // ---------- PSD ----------
  // 头部 + 色彩模式数据 + 图像资源 + 图层与蒙版 + 合成图像。
  // CTF 看点：隐藏图层、图层名、资源段字符串、合成图之后的夹带。
  const PSD_ALPHA = -1;   // 图层通道 id -1 = 透明度
  const PSD_MODE = { 0: '位图', 1: '灰度', 2: '索引', 3: 'RGB', 4: 'CMYK', 7: '多通道', 8: '双色调', 9: 'Lab' };

  function psdPackBits(src, off, count, out, outOff, rowLen) {
    let i = off, end = Math.min(off + count, src.length), o = outOff;
    const stop = outOff + rowLen;
    while (i < end && o < stop) {
      const n = (src[i++] << 24) >> 24;
      if (n >= 0) {
        const take = Math.min(n + 1, end - i, stop - o);
        for (let k = 0; k < take; k++) out[o++] = src[i + k];
        i += n + 1;
      } else if (n !== -128) {
        if (i >= end) break;
        const v = src[i++];
        const take = Math.min(1 - n, stop - o);
        for (let k = 0; k < take; k++) out[o++] = v;
      }
    }
    return o - outOff;
  }

  function psdSample(decoded, w, h, depth) {
    const n = w * h;
    if (!decoded || decoded.length < n) return null;
    if (depth <= 8) return decoded.subarray(0, n);
    if (depth === 16) {
      if (decoded.length < n * 2) return null;
      const out = new Uint8Array(n);
      for (let i = 0; i < n; i++) out[i] = decoded[i * 2];
      return out;
    }
    return null;
  }

  function psdImage(w, h, mode, decoded, palette) {
    const n = w * h;
    if (!(w > 0) || !(h > 0) || n > 6e6 || mode === 0) return null;
    const R = new Uint8Array(n), G = new Uint8Array(n), B = new Uint8Array(n), A = new Uint8Array(n).fill(255);
    const gray = decoded[0];
    if (mode === 2) {
      if (!gray || !palette || palette.length < 3) return null;
      for (let i = 0; i < n; i++) {
        const idx = gray[i];
        R[i] = palette[idx * 3] || 0; G[i] = palette[idx * 3 + 1] || 0; B[i] = palette[idx * 3 + 2] || 0;
      }
    } else if (mode === 4) {
      const C = decoded[0], M = decoded[1], Y = decoded[2], K = decoded[3];
      if (!C || !M || !Y || !K) return null;
      for (let i = 0; i < n; i++) {
        R[i] = 255 - Math.min(255, C[i] + K[i]);
        G[i] = 255 - Math.min(255, M[i] + K[i]);
        B[i] = 255 - Math.min(255, Y[i] + K[i]);
      }
    } else if (gray && !decoded[1]) {
      for (let i = 0; i < n; i++) { R[i] = G[i] = B[i] = gray[i]; }
    } else {
      if (!decoded[0] || !decoded[1] || !decoded[2]) return null;
      R.set(decoded[0]); G.set(decoded[1]); B.set(decoded[2]);
    }
    if (decoded[PSD_ALPHA]) A.set(decoded[PSD_ALPHA]);
    return { width: w, height: h, bitDepth: 8, colorType: 'PSD', channels: { R, G, B, A }, error: null };
  }

  function psdDecodeChannel(b, ch, w, h, depth, psb) {
    const n = w * h;
    const bp = depth >= 16 ? 2 : 1;
    const rawLen = n * bp;
    const out = new Uint8Array(rawLen);
    const start = ch.offset, end = ch.dataEnd;
    if (start === undefined || end <= start) return { out: null, error: '通道数据为空' };
    if (ch.compression === 0) {
      out.set(b.subarray(start, Math.min(start + rawLen, end)));
      return { out, error: end - start < rawLen ? '通道数据被截断' : null };
    }
    if (ch.compression === 1) {
      const cntLen = psb ? 4 : 2;
      const tableLen = h * cntLen;
      if (start + tableLen > end) return { out: null, error: 'RLE 行表越界' };
      const counts = [];
      let off = start + tableLen;
      for (let y = 0; y < h; y++) {
        const c = cntLen === 2 ? rd16(b, start + y * 2) : rd32(b, start + y * 4);
        counts.push(c);
      }
      for (let y = 0; y < h; y++) {
        psdPackBits(b, off, counts[y], out, y * w * bp, w * bp);
        off += counts[y];
      }
      return { out, error: null };
    }
    if (ch.compression === 2 || ch.compression === 3) {
      const z = MDZ.inflateZlib(b.subarray(start, end), 0, Math.max(rawLen * 4, 1 << 20));
      if (!z.out) return { out: null, error: 'ZIP 通道解压失败' };
      if (ch.compression === 3) {
        // 16/32 位 ZIP 预测：行内后一字节是前一字节的差分
        const buf = z.out;
        const rowBytes = w * bp;
        for (let y = 0; y < h; y++) {
          const base = y * rowBytes;
          for (let i = 1; i < rowBytes && base + i < buf.length; i++) buf[base + i] = (buf[base + i] + buf[base + i - 1]) & 255;
        }
      }
      out.set(z.out.subarray(0, rawLen));
      return { out, error: null };
    }
    return { out: null, error: '压缩方式 ' + ch.compression + ' 不支持' };
  }

  function parsePSD(input) {
    const b = toU8(input);
    if (b.length < 26) return { error: '不足 26 字节' };
    if (ascii(b.subarray(0, 4), 4) !== '8BPS') return { error: '缺少 8BPS 签名' };
    const version = rd16(b, 4);
    if (version !== 1 && version !== 2) return { error: '版本 ' + version + ' 不支持' };
    const psb = version === 2;
    const info = {
      version, psb, channels: rd16(b, 12), height: rd32(b, 14), width: rd32(b, 18),
      depth: rd16(b, 22), mode: rd16(b, 24)
    };
    info.modeName = PSD_MODE[info.mode] || ('#' + info.mode);
    if (!info.width || !info.height) return { error: '宽高为 0' };
    if (info.width * info.height > 268435456) return { error: '尺寸异常：' + info.width + '×' + info.height };
    let p = 26;
    if (p + 4 > b.length) return { error: '头部之后被截断' };
    const colorLen = rd32(b, p); p += 4;
    info.palette = b.subarray(p, Math.min(p + colorLen, b.length)).subarray(0, 768);
    p += colorLen;
    if (p + 4 > b.length) return { error: '色彩模式数据越界' };
    const resLen = rd32(b, p); p += 4;
    info.resourceLen = Math.min(resLen, Math.max(0, b.length - p));
    info.resources = b.subarray(p, p + info.resourceLen);
    p += resLen;
    if (p + 4 > b.length) return { error: '图像资源段越界' };
    const lmLen = rd32(b, p); p += 4;
    const lmEnd = Math.min(p + lmLen, b.length);
    const layers = [];
    info.layers = layers;
    info.mergedAlpha = false;
    if (p + 4 <= lmEnd) {
      const liLen = rd32(b, p); p += 4;
      const liEnd = Math.min(p + liLen, lmEnd);
      if (p + 2 <= liEnd) {
        const raw = (rd16(b, p) << 16) >> 16; p += 2;
        info.mergedAlpha = raw < 0;
        const count = Math.min(Math.abs(raw), 512);
        for (let i = 0; i < count; i++) {
          if (p + 34 > liEnd) break;
          const top = rd32(b, p) | 0, left = rd32(b, p + 4) | 0, bottom = rd32(b, p + 8) | 0, right = rd32(b, p + 12) | 0;
          p += 16;
          const w = right - left, h = bottom - top;
          const nch = rd16(b, p); p += 2;
          const chans = [];
          for (let c = 0; c < nch && p + 6 <= liEnd; c++) {
            const id = (rd16(b, p) << 16) >> 16; p += 2;
            let len;
            if (psb) { const hi = rd32(b, p); len = hi ? -1 : rd32(b, p + 4); p += 8; }
            else { len = rd32(b, p); p += 4; }
            chans.push({ id, len });
          }
          if (p + 12 > liEnd) break;
          p += 4;   // '8BIM'
          const blend = ascii(b.subarray(p, p + 4), 4).replace(/\0/g, ''); p += 4;
          const opacity = b[p];
          const flags = b[p + 2];
          p += 4;
          const extraLen = rd32(b, p); p += 4;
          const extraEnd = Math.min(p + extraLen, liEnd);
          if (p + 4 <= extraEnd) { const ml = rd32(b, p); p += 4 + Math.min(ml, extraEnd - p - 4); }
          if (p + 4 <= extraEnd) { const bl = rd32(b, p); p += 4 + Math.min(bl, extraEnd - p - 4); }
          let name = '', section = 0, hasText = false;
          if (p < extraEnd) {
            const nameStart = p;
            const sl = b[p];
            name = ascii(b.subarray(p + 1, Math.min(p + 1 + sl, extraEnd)), sl);
            p = nameStart + Math.ceil((1 + sl) / 4) * 4;
          }
          let guard = 0;
          while (p + 12 <= extraEnd && guard++ < 128) {
            const sig = ascii(b.subarray(p, p + 4), 4);
            if (sig !== '8BIM' && sig !== '8B64') break;
            const key = ascii(b.subarray(p + 4, p + 8), 4);
            let dl;
            if (psb) { const hi = rd32(b, p + 8); dl = hi ? -1 : rd32(b, p + 12); p += 16; }
            else { dl = rd32(b, p + 8); p += 12; }
            if (!(dl >= 0) || p + dl > extraEnd) break;
            if (key === 'luni' && dl >= 4) {
              const n2 = rd32(b, p);
              if (n2 >= 2 && n2 <= dl && p + 4 + n2 <= extraEnd) name = MDZ.utf16be(b.subarray(p + 4, p + 4 + n2));
            } else if (key === 'lsct' && dl >= 4) {
              section = rd32(b, p);
            } else if (key === 'TySh') {
              hasText = true;
            }
            p += dl;
            if (dl & 1) p += 1;
          }
          p = extraEnd;
          layers.push({
            index: layers.length, name: name || ('图层 ' + (layers.length + 1)),
            rect: { top, left, bottom, right }, w, h, chans, blend, opacity, flags,
            visible: !(flags & 0x02), section, hasText, decoded: {}
          });
        }
        // 通道数据区紧跟在所有图层记录之后；记录里的长度含 2 字节压缩标记
        for (const layer of layers) {
          for (const ch of layer.chans) {
            if (p + 2 > liEnd || !(ch.len >= 0)) { ch.skip = true; continue; }
            const compOff = p;
            ch.compression = rd16(b, p); p += 2;
            ch.offset = p;
            ch.dataEnd = Math.min(compOff + ch.len, liEnd, b.length);
            p = Math.min(compOff + ch.len, b.length);
            if (p > liEnd) break;
          }
          if (p > liEnd) break;
        }
      }
      p = liEnd;
    }
    // 全局图层蒙版 / Lr16 / Lr32 块都在合成图之前，直接从蒙版段末尾跳到合成图
    info.compStart = lmEnd;
    return { info, layers, error: null };
  }

  function psdDecodeComposite(b, info) {
    const w = info.width, h = info.height, nch = info.channels, depth = info.depth, psb = info.psb;
    const n = w * h;
    const bp = depth >= 16 ? 2 : 1;
    let p = info.compStart;
    if (!(p > 0) || p + 2 > b.length) return { image: null, end: null, reason: '合成图起点越界' };
    if (nch < 1 || nch > 56 || n <= 0 || n > 6e6) return { image: null, end: null, reason: '合成图尺寸/通道异常' };
    if (depth > 16) return { image: null, end: null, reason: `合成图 ${depth} 位浮点暂不预览` };
    const compression = rd16(b, p); p += 2;
    const planes = [];
    if (compression === 0) {
      for (let c = 0; c < nch; c++) {
        planes.push(b.subarray(p, p + n * bp));
        p += n * bp;
        if (p > b.length) break;
      }
    } else if (compression === 1) {
      const cntLen = psb ? 4 : 2;
      const tableLen = h * nch * cntLen;
      if (p + tableLen > b.length) return { image: null, end: null, reason: '合成图 RLE 行表越界' };
      const counts = [];
      let total = 0;
      for (let i = 0; i < h * nch; i++) {
        const c = cntLen === 2 ? rd16(b, p + i * 2) : rd32(b, p + i * 4);
        counts.push(c); total += c;
      }
      p += tableLen;
      const dataStart = p;
      const rowBytes = w * bp;
      let off = dataStart;
      for (let c = 0; c < nch; c++) {
        const plane = new Uint8Array(n * bp);
        for (let y = 0; y < h; y++) {
          psdPackBits(b, off, counts[c * h + y], plane, y * rowBytes, rowBytes);
          off += counts[c * h + y];
        }
        planes.push(plane);
      }
      p = dataStart + total;
    } else if (compression === 2 || compression === 3) {
      // 合成图 ZIP：一个 zlib 流里按通道平面顺序排列；compression 3 多一层行内预测
      const z = MDZ.inflateZlib(b, p, Math.max(n * nch * bp * 2, 1 << 20));
      if (!z.out || !z.consumed) return { image: null, end: null, reason: '合成图 ZIP 解压失败' };
      const need = n * nch * bp;
      if (z.out.length < need) return { image: null, end: p + z.consumed, reason: `合成图 ZIP 只解出 ${z.out.length}/${need} 字节` };
      for (let c = 0; c < nch; c++) {
        const plane = z.out.subarray(c * n * bp, (c + 1) * n * bp);
        if (compression === 3) {
          const rowBytes = w * bp;
          for (let y = 0; y < h; y++) {
            const baseOff = y * rowBytes;
            for (let i = 1; i < rowBytes; i++) plane[baseOff + i] = (plane[baseOff + i] + plane[baseOff + i - 1]) & 255;
          }
        }
        planes.push(plane);
      }
      p += z.consumed;
    } else {
      return { image: null, end: null, reason: '合成图压缩方式 ' + compression + ' 不支持' };
    }
    info.compression = compression;
    const base = info.mode === 4 ? 4 : (info.mode === 1 || info.mode === 2 || info.mode === 0 || info.mode === 8 ? 1 : 3);
    const decoded = {};
    for (let i = 0; i < planes.length; i++) {
      const s = psdSample(planes[i], w, h, depth);
      if (!s) continue;
      if (i < base) decoded[i] = s;
      else if (i === base) decoded[PSD_ALPHA] = s;
    }
    const image = psdImage(w, h, info.mode, decoded, info.palette);
    return { image, end: Math.min(p, b.length), reason: image ? null : '合成图模式/位深暂无预览' };
  }

  function auditPSD(input, name) {
    const b = toU8(input);
    const findings = [], artifacts = [];
    const parsed = parsePSD(b);
    if (parsed.error) return { findings: [finding('L0', 'format', '不是 PSD', { detail: parsed.error })], artifacts, image: null, parsed };
    const info = parsed.info, layers = parsed.layers;
    const images = [];
    let hidden = 0;
    for (const layer of layers) {
      const px = layer.w * layer.h;
      if (px > 0 && px <= 6e6 && info.depth <= 16) {
        for (const ch of layer.chans) {
          if (ch.skip || layer.decoded[ch.id]) continue;
          const d = psdDecodeChannel(b, ch, layer.w, layer.h, info.depth, info.psb);
          if (!d.out) continue;
          const s = psdSample(d.out, layer.w, layer.h, info.depth);
          if (s) layer.decoded[ch.id] = s;
        }
        layer.image = psdImage(layer.w, layer.h, info.mode, layer.decoded, info.palette);
        if (layer.image && images.length < 16) {
          images.push({ name: `层 ${layer.index + 1}${layer.visible ? '' : ' · 隐藏'} · ${layer.name}`, image: layer.image });
        }
      }
      if (!layer.visible) hidden++;
    }
    findings.push(finding('L1', 'psd', `PSD ${info.width} × ${info.height} · ${info.depth} 位 · ${info.modeName} · ${layers.length} 图层`, {
      confidence: 0.95, offset: 0,
      declared: `v${info.version}${info.psb ? ' (PSB)' : ''} · ${info.channels} 个合成通道`,
      actual: info.mergedAlpha ? '首通道含合并透明' : '无合并透明通道',
      detail: `色彩模式数据 ${info.palette.length} 字节 · 图像资源 ${info.resourceLen} 字节`,
      recipe: '8BPS 头之后依次是色彩模式数据、图像资源、图层与蒙版、合成图像'
    }));
    if (layers.length) {
      findings.push(finding('L2', 'psd_layers', `图层 ${layers.length} 个${hidden ? '（' + hidden + ' 个隐藏）' : ''}`, {
        confidence: hidden ? 0.95 : 0.6,
        preview: layers.map(l => `#${l.index + 1} ${l.visible ? '可见' : '隐藏'} ${l.w}×${l.h} ${l.blend} ${Math.round(l.opacity / 255 * 100)}%${l.hasText ? ' [文本]' : ''} ${l.name}`).join('\n'),
        actual: layers.slice(0, 6).map(l => l.name).join(' | ')
      }));
    }
    if (hidden) {
      findings.push(finding('L2', 'psd_hidden', `${hidden} 个隐藏图层：常见藏 flag 位置`, {
        confidence: 0.9,
        actual: layers.filter(l => !l.visible).map(l => l.name).join(' | '),
        detail: '隐藏图层不会出现在合成图里；本工具已解出每层预览（右栏可切换），隐藏层还导出了 BMP。',
        recipe: 'Photoshop 打开后取消隐藏；或直接看本工具的图层预览 / psd-hidden-*.bmp'
      }));
    }
    let exported = 0;
    for (const layer of layers) {
      if (layer.visible || !layer.image || exported >= 4) continue;
      const bmp = MDZ.encodeBMP ? MDZ.encodeBMP(layer.image) : null;
      if (bmp) {
        const nm = layer.name.replace(/[^\w.-]+/g, '_').slice(0, 32) || ('layer' + (layer.index + 1));
        artifacts.push(artifact(`psd-hidden-${layer.index + 1}-${nm}.bmp`, bmp, '隐藏图层像素'));
        exported++;
      }
    }
    const resStr = MDZ.strings(info.resources, 8).filter(s => !/^\d+$/.test(s)).slice(0, 40);
    if (resStr.length) {
      findings.push(finding('L3', 'psd_resources', `图像资源段 ${resStr.length} 条文本`, {
        confidence: 0.5,
        preview: resStr.slice(0, 8).join('\n'),
        detail: '资源段里常见 XMP、IPTC、作者、色板名；出题人有时把口令写在资源名里。'
      }));
    }
    const names = layers.map(l => l.name).join('\n');
    const fm = MDZ.flagMatch(names + '\n' + resStr.join('\n'));
    if (fm) findings.push(finding('L3', 'psd_flag', `图层名/资源段出现 ${fm}`, { confidence: 0.99, actual: fm, preview: names.slice(0, 400) }));
    const comp = psdDecodeComposite(b, info);
    if (!comp.image && comp.reason) {
      findings.push(finding('L1', 'psd_composite_skip', comp.reason, {
        confidence: 0.8,
        detail: '合成图没解出来不代表文件坏了：图层预览和隐藏图层仍可用；需要完整合成图时用 Photoshop / psd-tools 导出。'
      }));
    }
    if (comp.end != null && comp.end < b.length) {
      const tr = b.subarray(comp.end);
      findings.push(finding('L1', 'psd_trailer', `合成图像之后还有 ${tr.length} 字节`, {
        confidence: tr.some(x => x !== 0) ? 0.95 : 0.6,
        offset: comp.end,
        declared: `合成图像结束于 0x${hex(comp.end)}`,
        actual: `文件到 0x${hex(b.length)}`,
        detail: '声明之外的数据没人会读，常用于夹带。已导出为产物。',
        preview: ascii(tr.subarray(0, 120), Math.min(120, tr.length))
      }));
      artifacts.push(artifact('psd-trailer.bin', tr, 'PSD 合成图之后的尾部数据'));
    }
    return { findings, artifacts, image: comp.image || null, images, info, parsed: { info, layers, end: comp.end } };
  }

  // ---------- PCX ----------
  // 128 字节头 + RLE 像素；8 位单平面在数据后跟 0x0C + 768 字节调色板。
  function decodePCX(b) {
    if (b.length < 128 || b[0] !== 0x0A || b[2] !== 1) return { error: '不是 PCX' };
    const hdr = {
      version: b[1], bpp: b[3], planes: b[65], bytesPerLine: le16(b, 66), paletteInfo: le16(b, 68),
      xmin: le16(b, 4), ymin: le16(b, 6), xmax: le16(b, 8), ymax: le16(b, 10)
    };
    const w = hdr.xmax - hdr.xmin + 1, h = hdr.ymax - hdr.ymin + 1;
    if (!(w > 0) || !(h > 0) || w * h > 20e6) return { error: '尺寸无效' };
    if (![1, 2, 4, 8].includes(hdr.bpp) || hdr.planes < 1 || hdr.planes > 4) return { error: 'bpp/plane 不支持' };
    if (!hdr.bytesPerLine) return { error: 'bytesPerLine=0' };
    const need = h * hdr.planes * hdr.bytesPerLine;
    const raw = new Uint8Array(need);
    let p = 128, o = 0;
    while (o < need && p < b.length) {
      const c = b[p++];
      if ((c & 0xC0) === 0xC0) {
        const n = c & 0x3F;
        const v = b[p++];
        for (let i = 0; i < n && o < need; i++) raw[o++] = v;
      } else {
        raw[o++] = c;
      }
    }
    const truncated = o < need;
    let palette = null, paletteAt = -1;
    if (hdr.bpp === 8 && hdr.planes === 1 && p + 769 <= b.length && b[p] === 0x0C) {
      palette = b.subarray(p + 1, p + 769);
      paletteAt = p;
      p += 769;
    }
    if (!palette) palette = b.subarray(16, 64);
    const n = w * h;
    const R = new Uint8Array(n), G = new Uint8Array(n), B = new Uint8Array(n), A = new Uint8Array(n).fill(255);
    const pal = (idx, dst, i) => {
      const off = idx * 3;
      if (off + 2 < palette.length) { dst[0][i] = palette[off]; dst[1][i] = palette[off + 1]; dst[2][i] = palette[off + 2]; }
    };
    if (hdr.bpp === 8 && hdr.planes === 3) {
      for (let y = 0; y < h; y++) {
        const rowBase = y * 3 * hdr.bytesPerLine;
        for (let x = 0; x < w; x++) {
          const i = y * w + x;
          R[i] = raw[rowBase + x];
          G[i] = raw[rowBase + hdr.bytesPerLine + x];
          B[i] = raw[rowBase + 2 * hdr.bytesPerLine + x];
        }
      }
    } else if (hdr.bpp === 8 && hdr.planes === 4) {
      for (let y = 0; y < h; y++) {
        const rowBase = y * 4 * hdr.bytesPerLine;
        for (let x = 0; x < w; x++) {
          const i = y * w + x;
          R[i] = raw[rowBase + x];
          G[i] = raw[rowBase + hdr.bytesPerLine + x];
          B[i] = raw[rowBase + 2 * hdr.bytesPerLine + x];
          A[i] = raw[rowBase + 3 * hdr.bytesPerLine + x];
        }
      }
    } else if (hdr.bpp === 8 && hdr.planes === 1) {
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const i = y * w + x;
          pal(raw[y * hdr.bytesPerLine + x], [R, G, B], i);
        }
      }
    } else if (hdr.bpp === 1) {
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          let idx = 0;
          for (let pl = 0; pl < hdr.planes; pl++) {
            const byte = raw[(y * hdr.planes + pl) * hdr.bytesPerLine + (x >> 3)];
            idx |= ((byte >> (7 - (x & 7))) & 1) << pl;
          }
          pal(idx, [R, G, B], y * w + x);
        }
      }
    } else if (hdr.bpp === 4 && hdr.planes === 1) {
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const byte = raw[y * hdr.bytesPerLine + (x >> 1)];
          pal((x & 1) ? (byte & 15) : (byte >> 4), [R, G, B], y * w + x);
        }
      }
    } else {
      return { error: `bpp=${hdr.bpp} planes=${hdr.planes} 不支持` };
    }
    return {
      width: w, height: h, bitDepth: hdr.bpp, colorType: 'PCX', channels: { R, G, B, A },
      hdr, consumed: p, paletteAt, truncated, error: null
    };
  }

  function auditPCX(input, name) {
    const b = toU8(input);
    const findings = [], artifacts = [];
    const dec = decodePCX(b);
    if (dec.error) return { findings: [finding('L0', 'format', '不是 PCX', { detail: dec.error })], artifacts, image: null };
    const hdr = dec.hdr;
    findings.push(finding('L1', 'pcx', `PCX ${dec.width} × ${dec.height} · ${hdr.bpp} bpp · ${hdr.planes} 平面${hdr.version ? ' · v' + hdr.version : ''}`, {
      confidence: 0.9, offset: 0,
      declared: `每行 ${hdr.bytesPerLine} 字节`,
      actual: dec.truncated ? '像素数据被截断' : `像素到 0x${hex(dec.consumed)}`,
      detail: `调色板 ${dec.paletteAt >= 0 ? '256 色（0x0C + 768 字节）' : '16 色（头部 48 字节）'}；RLE 编码。`,
      recipe: 'PCX 无全局偏移表，逐行 RLE：0xC0|n 后跟重复字节'
    }));
    if (dec.truncated) findings.push(finding('L1', 'pcx_truncated', 'PCX 像素数据不完整', { confidence: 0.8 }));
    if (dec.consumed < b.length) {
      const tr = b.subarray(dec.consumed);
      findings.push(finding('L1', 'pcx_trailer', `像素/调色板之后还有 ${tr.length} 字节`, {
        confidence: tr.some(x => x !== 0) ? 0.95 : 0.6,
        offset: dec.consumed,
        preview: ascii(tr.subarray(0, 120), Math.min(120, tr.length)),
        detail: 'PCX 没有「文件长度」字段，播放器读完像素就停，尾部可夹带。'
      }));
      artifacts.push(artifact('pcx-trailer.bin', tr, 'PCX 尾部附加数据'));
    }
    return { findings, artifacts, image: dec.error ? null : dec, parsed: { hdr, consumed: dec.consumed, paletteAt: dec.paletteAt } };
  }

  Object.assign(MDZ, {
    isGIF, parseGIF, auditGIF, lzwDecode, deinterlaceGIF, gifFrameImage, editGIFDims,
    isICO, parseICO, auditICO,
    isSVG, auditSVG,
    isZIP, parseZIP, unzipEntry, auditZIP, b64decode,
    isTIFF, auditTIFF, isWEBP, auditWEBP,
    parseTGA, decodeTGA, auditTGA,
    parsePSD, auditPSD, decodePCX, auditPCX, tiffLZW
  });
})(typeof globalThis !== 'undefined' ? globalThis : this);
