/* misc大手子 — 50 GIF / ICO / SVG / ZIP
 * 「其余基础」：结构审计 + 载荷提取，够用即止。
 */
(function (root) {
  'use strict';
  const MDZ = root.MDZ = root.MDZ || {};
  const { toU8, hex, ascii, utf8, strings, finding, artifact } = MDZ;

  function le16(b, o) { return b[o] | (b[o + 1] << 8); }
  function le32(b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0; }

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
      detail: '已解析 IFD/ExifIFD/GPS/IFD1；像素解码暂不做，重点看标签与内嵌缩略图。'
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
    const hits = MDZ.strings(b, 6).filter(x => /flag|ctf|pass|key|secret/i.test(x));
    if (hits.length && !flagHit) {
      findings.push(finding('L3', 'strings', 'TIFF 原始字节命中可打印串', {
        confidence: 0.6, actual: hits.slice(0, 8).join(' | '), preview: hits.slice(0, 20).join('\n')
      }));
    }
    return { findings, artifacts, image: null, parsed: { tags, order: ex.order } };
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
      const count = le16(b, i + 10);
      const cdSize = le32(b, i + 12);
      const cdOffset = le32(b, i + 16);
      const commentLen = le16(b, i + 20);
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
        const csize = le32(b, p + 20);
        const usize = le32(b, p + 24);
        const nameLen = le16(b, p + 28);
        const extraLen = le16(b, p + 30);
        const commentLen = le16(b, p + 32);
        const localOffset = le32(b, p + 42);
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
    if (e.method === 0) {
      return { data: b.subarray(e.dataStart, Math.min(b.length, e.dataStart + e.csize)), error: null };
    }
    if (e.method === 8) {
      const z = MDZ.inflateRaw(b, e.dataStart, 64 * 1024 * 1024);
      return { data: z.out && z.out.length ? z.out : null, error: z.out ? null : (z.error || 'deflate 解压失败') };
    }
    if (e.method === 14 && MDZ.lzmaDecompressAlone) {
      // method 14：2 字节版本 + 2 字节 props 长度(=5) + props/dict(5) + 裸 LZMA 数据
      const ps = le16(b, e.dataStart + 2);
      if (ps !== 5) return { data: null, error: 'LZMA 头部异常' };
      const rest = b.length - (e.dataStart + 4 + ps);
      if (rest <= 0) return { data: null, error: 'LZMA 数据缺失' };
      const hdr = new Uint8Array(13 + rest);
      hdr.set(b.subarray(e.dataStart + 4, e.dataStart + 9), 0);
      if (e.usize && e.usize !== 0xFFFFFFFF) {
        for (let i = 0; i < 8; i++) hdr[5 + i] = Math.floor(e.usize / Math.pow(2, 8 * i)) & 255;
      } else {
        for (let i = 0; i < 8; i++) hdr[5 + i] = 0xFF;
      }
      hdr.set(b.subarray(e.dataStart + 4 + ps), 13);
      const dz = MDZ.lzmaDecompressAlone(hdr, { maxOut: 64 * 1024 * 1024 });
      return { data: dz.out && dz.out.length ? dz.out : null, error: dz.error };
    }
    return { data: null, error: 'method ' + e.method + ' 未支持' };
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
        artifacts.push(artifact('zip-' + (e.name || 'entry'), r.data, 'ZIP 条目（method ' + e.method + (e.method === 0 ? ' stored' : '，已解压') + '）'));
      } else if (r.error && e.method !== 0 && e.method !== 8) {
        findings.push(finding('L2', 'zip_method', 'ZIP 条目 ' + e.name + '：' + r.error, {
          confidence: 0.8, offset: e.offset,
          declared: 'method ' + e.method, actual: '未提取',
          detail: '该压缩方法还没实现解压；可以先用 7z / unzip 手工展开。',
          recipe: '7z x <file.zip>'
        }));
      }
    }
    return { findings, artifacts, image: null, parsed: z };
  }

  Object.assign(MDZ, {
    isGIF, parseGIF, auditGIF, lzwDecode, deinterlaceGIF, gifFrameImage, editGIFDims,
    isICO, parseICO, auditICO,
    isSVG, auditSVG,
    isZIP, parseZIP, auditZIP, b64decode,
    isTIFF, auditTIFF, isWEBP, auditWEBP
  });
})(typeof globalThis !== 'undefined' ? globalThis : this);
