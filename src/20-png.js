/* misc大手子 — 20 PNG
 * 深挖：chunk 审计 / CRC / 双 zlib / unused_data / 多余扫描行 / 文本块 / 尺寸恢复
 */
(function (root) {
  'use strict';
  const MDZ = root.MDZ = root.MDZ || {};
  const {
    toU8, hex, hex32, ascii, utf8, utf16le, strings, entropy, printableRatio,
    crc32, inflateZlib, findStreamSignatures, finding, artifact, safeSlice, concatBytes
  } = MDZ;

  function rd32(b, o) {
    return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
  }
  function wr32(b, o, v) {
    b[o] = (v >>> 24) & 255; b[o + 1] = (v >>> 16) & 255; b[o + 2] = (v >>> 8) & 255; b[o + 3] = v & 255;
  }
  function rd16(b, o) { return (b[o] << 8) | b[o + 1]; }
  function wr16(b, o, v) { b[o] = (v >>> 8) & 255; b[o + 1] = v & 255; }

  const PNG_SIG = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];

  function isPNG(input) {
    const b = toU8(input);
    if (b.length < 8) return false;
    for (let i = 0; i < 8; i++) if (b[i] !== PNG_SIG[i]) return false;
    return true;
  }

  function channelCount(colorType) {
    return { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType] || 0;
  }

  // ---------- chunk ----------
  function parseChunks(input) {
    const b = toU8(input);
    const chunks = [];
    const errors = [];
    if (!isPNG(b)) return { ok: false, error: 'not PNG', chunks, errors, trailing: null };
    let pos = 8;
    let iendEnd = -1;
    while (pos + 8 <= b.length) {
      const length = rd32(b, pos);
      const typeBytes = b.subarray(pos + 4, pos + 8);
      const type = String.fromCharCode(typeBytes[0], typeBytes[1], typeBytes[2], typeBytes[3]);
      const dataStart = pos + 8;
      const dataEnd = dataStart + length;
      if (length > 0x7FFFFFFF || dataEnd + 4 > b.length) {
        errors.push({ type, offset: pos, message: 'chunk 越界（文件截断或长度字段被改）', declared: length, actual: b.length - dataStart });
        break;
      }
      const data = b.subarray(dataStart, dataEnd);
      const crcStored = rd32(b, dataEnd);
      const crcCalc = crc32(b, pos + 4, dataEnd);
      chunks.push({ type, offset: pos, length, dataStart, dataEnd, data, crcStored, crcCalc, crcOk: crcStored === crcCalc });
      pos = dataEnd + 4;
      if (type === 'IEND') { iendEnd = pos; break; }
    }
    if (iendEnd < 0) errors.push({ type: 'IEND', offset: pos, message: '缺少 IEND' });
    return {
      ok: true, chunks, errors,
      trailing: iendEnd >= 0 && iendEnd < b.length ? b.subarray(iendEnd) : null,
      iendEnd
    };
  }

  function parseIHDR(chunk) {
    const d = chunk.data;
    if (d.length < 13) return null;
    return {
      width: rd32(d, 0), height: rd32(d, 4),
      bitDepth: d[8], colorType: d[9], compression: d[10], filter: d[11], interlace: d[12]
    };
  }

  function chunkTypeBytes(type) {
    return Uint8Array.from([type.charCodeAt(0), type.charCodeAt(1), type.charCodeAt(2), type.charCodeAt(3)]);
  }

  function ihdrBytes(w, h, bitDepth, colorType, comp, filt, inter) {
    const d = new Uint8Array(13);
    wr32(d, 0, w); wr32(d, 4, h);
    d[8] = bitDepth; d[9] = colorType; d[10] = comp; d[11] = filt; d[12] = inter;
    return d;
  }

  // ---------- 解压 + 反滤波 ----------
  function rowBytesOf(width, colorType, bitDepth) {
    const bits = channelCount(colorType) * bitDepth;
    return Math.ceil(width * bits / 8);
  }

  function unfilter(raw, width, height, bpp, rowBytes) {
    const need = height * (rowBytes + 1);
    if (raw.length < need) return null;
    const out = new Uint8Array(height * rowBytes);
    let p = 0;
    let prev = new Uint8Array(rowBytes);
    for (let y = 0; y < height; y++) {
      const f = raw[p++];
      const line = raw.subarray(p, p + rowBytes);
      p += rowBytes;
      const cur = out.subarray(y * rowBytes, (y + 1) * rowBytes);
      if (f === 0) cur.set(line);
      else if (f === 1) {
        for (let x = 0; x < rowBytes; x++) cur[x] = (line[x] + (x >= bpp ? cur[x - bpp] : 0)) & 255;
      } else if (f === 2) {
        for (let x = 0; x < rowBytes; x++) cur[x] = (line[x] + prev[x]) & 255;
      } else if (f === 3) {
        for (let x = 0; x < rowBytes; x++) {
          const a = x >= bpp ? cur[x - bpp] : 0;
          cur[x] = (line[x] + ((a + prev[x]) >> 1)) & 255;
        }
      } else if (f === 4) {
        for (let x = 0; x < rowBytes; x++) {
          const a = x >= bpp ? cur[x - bpp] : 0;
          const b = prev[x];
          const c = x >= bpp ? prev[x - bpp] : 0;
          const pp = a + b - c;
          const pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c);
          const pr = (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
          cur[x] = (line[x] + pr) & 255;
        }
      } else {
        return null;
      }
      prev = cur;
    }
    return out;
  }

  // 返回每通道数组（bitDepth<8 时为 0..2^d-1 的样本；>=8 时为 Uint8/Uint16）
  function samplesFromRaw(raw, width, height, colorType, bitDepth) {
    const channels = channelCount(colorType);
    const pxCount = width * height;
    const arrays = [];
    if (bitDepth === 8) {
      for (let c = 0; c < channels; c++) arrays.push(new Uint8Array(pxCount));
      let p = 0;
      for (let i = 0; i < pxCount; i++) for (let c = 0; c < channels; c++) arrays[c][i] = raw[p++];
      return arrays;
    }
    if (bitDepth === 16) {
      for (let c = 0; c < channels; c++) arrays.push(new Uint16Array(pxCount));
      let p = 0;
      for (let i = 0; i < pxCount; i++) for (let c = 0; c < channels; c++) { arrays[c][i] = (raw[p] << 8) | raw[p + 1]; p += 2; }
      return arrays;
    }
    if (bitDepth === 1 || bitDepth === 2 || bitDepth === 4) {
      for (let c = 0; c < channels; c++) arrays.push(new Uint8Array(pxCount));
      const mask = (1 << bitDepth) - 1;
      if (channels !== 1) return null;
      // 每行末尾按字节对齐，可能有余位；必须逐行推进，不能把整个缓冲当连续流
      const rb = Math.ceil(width * bitDepth / 8);
      let p = 0;
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const bitPos = x * bitDepth;
          const byte = raw[p + (bitPos >> 3)];
          const shift = 8 - bitDepth - (bitPos & 7);
          arrays[0][y * width + x] = (byte >> shift) & mask;
        }
        p += rb;
      }
      return arrays;
    }
    return null;
  }

  const ADAM7 = [
    [0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4],
    [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]
  ];

  function adam7Dims(w, h, pass) {
    return {
      pw: w > pass[0] ? Math.ceil((w - pass[0]) / pass[2]) : 0,
      ph: h > pass[1] ? Math.ceil((h - pass[1]) / pass[3]) : 0
    };
  }

  function adam7Expected(w, h, colorType, bitDepth) {
    const bits = channelCount(colorType) * bitDepth;
    let total = 0;
    for (const pass of ADAM7) {
      const { pw, ph } = adam7Dims(w, h, pass);
      if (!pw || !ph) continue;
      const rb = Math.ceil(pw * bits / 8);
      total += ph * (rb + 1);
    }
    return total;
  }

  function decodeAdam7(raw, ihdr) {
    const ch = channelCount(ihdr.colorType);
    const px = ihdr.width * ihdr.height;
    const full = [];
    if (ihdr.bitDepth === 16) for (let c = 0; c < ch; c++) full.push(new Uint16Array(px));
    else for (let c = 0; c < ch; c++) full.push(new Uint8Array(px));
    let p = 0;
    for (const pass of ADAM7) {
      const { pw, ph } = adam7Dims(ihdr.width, ihdr.height, pass);
      if (!pw || !ph) continue;
      const rb = Math.ceil(pw * ch * ihdr.bitDepth / 8);
      const bpp = Math.max(1, Math.ceil(ch * ihdr.bitDepth / 8));
      const need = ph * (rb + 1);
      if (p + need > raw.length) return { error: 'Adam7 pass 数据不足（截断）', samples: null, consumed: p };
      const pixels = unfilter(raw.subarray(p, p + need), pw, ph, bpp, rb);
      if (!pixels) return { error: 'Adam7 反滤波失败', samples: null, consumed: p };
      const s = samplesFromRaw(pixels, pw, ph, ihdr.colorType, ihdr.bitDepth);
      if (!s) return { error: 'Adam7 样本解包失败', samples: null, consumed: p };
      for (let y = 0; y < ph; y++) {
        for (let x = 0; x < pw; x++) {
          const di = (pass[1] + y * pass[3]) * ihdr.width + (pass[0] + x * pass[2]);
          for (let c = 0; c < ch; c++) full[c][di] = s[c][y * pw + x];
        }
      }
      p += need;
    }
    return { error: null, samples: full, consumed: p };
  }

  function buildChannels(samples, ihdr, parsed, sizeOverride) {
    let channels = null, palette = null;
    if (ihdr.colorType === 3) {
      const plte = parsed.chunks.find(c => c.type === 'PLTE');
      const trns = parsed.chunks.find(c => c.type === 'tRNS');
      if (plte && samples) {
        const n = plte.data.length / 3;
        palette = new Uint8Array(n * 3);
        palette.set(plte.data.subarray(0, n * 3));
        const size = sizeOverride || (ihdr.width * ihdr.height);
        const R = new Uint8Array(size), G = new Uint8Array(size), B = new Uint8Array(size), A = new Uint8Array(size);
        A.fill(255);
        for (let i = 0; i < size; i++) {
          const idx = samples[0][i];
          R[i] = palette[idx * 3] || 0;
          G[i] = palette[idx * 3 + 1] || 0;
          B[i] = palette[idx * 3 + 2] || 0;
          if (trns && idx < trns.data.length) A[i] = trns.data[idx];
        }
        channels = { R, G, B, A };
      }
    } else if (ihdr.colorType === 0 && samples) {
      channels = { R: samples[0], G: samples[0], B: samples[0] };
    } else if (ihdr.colorType === 4 && samples) {
      channels = { R: samples[0], G: samples[0], B: samples[0], A: samples[1] };
    } else if (ihdr.colorType === 2 && samples) {
      channels = { R: samples[0], G: samples[1], B: samples[2] };
    } else if (ihdr.colorType === 6 && samples) {
      channels = { R: samples[0], G: samples[1], B: samples[2], A: samples[3] };
    }
    return { channels, palette, indices: ihdr.colorType === 3 && samples ? samples[0] : null };
  }

  function decodePNG(input, opts) {
    const b = toU8(input);
    const parsed = parseChunks(b);
    if (!parsed.ok) return { error: parsed.error, parsed };
    const ihdrChunk = parsed.chunks.find(c => c.type === 'IHDR');
    const ihdr = ihdrChunk && parseIHDR(ihdrChunk);
    if (!ihdr) return { error: 'IHDR 缺失或损坏', parsed };
    const idat = parsed.chunks.filter(c => c.type === 'IDAT');
    if (!idat.length) return { error: '没有 IDAT', parsed, ihdr };
    const idatData = concatBytes(idat.map(c => c.data));
    const interlace = ihdr.interlace === 1;
    // 先按声明尺寸估一遍再解压：260KB 的「尺寸炸弹」能把解压 + 反滤波 + 建通道一起撑到 GB 级。
    // 上限按像素数卡（32M 像素 ≈ 5656²，远超 misc 题的实际尺寸），超了直接拒绝解码。
    const expectedEst = interlace
      ? adam7Expected(ihdr.width, ihdr.height, ihdr.colorType, ihdr.bitDepth)
      : ihdr.height * (1 + rowBytesOf(ihdr.width, ihdr.colorType, ihdr.bitDepth));
    if (ihdr.width * ihdr.height > 32 * 1000 * 1000 || expectedEst > 128 * 1024 * 1024) {
      return {
        error: `声明尺寸 ${ihdr.width}×${ihdr.height} 过大（像素数据约 ${(expectedEst / 1048576).toFixed(1)} MB），已跳过解码；用「尺寸反推」改小再试`,
        parsed, ihdr, expected: expectedEst, tooBig: true
      };
    }
    const z = inflateZlib(idatData, 0, Math.min(256 * 1024 * 1024, expectedEst + 4 * 1024 * 1024));
    if (z.error && !z.out) return { error: 'IDAT 解压失败：' + z.error, parsed, ihdr };
    const raw = z.out;

    let expected;
    if (interlace) expected = adam7Expected(ihdr.width, ihdr.height, ihdr.colorType, ihdr.bitDepth);
    else expected = ihdr.height * (1 + rowBytesOf(ihdr.width, ihdr.colorType, ihdr.bitDepth));
    const extraRaw = raw.length > expected ? raw.subarray(expected) : new Uint8Array(0);
    if (raw.length < expected) {
      return { error: 'IDAT 数据不足（截断或尺寸被改大）', parsed, ihdr, raw, expected, actual: raw.length, idatData, z, interlace };
    }

    let samples = null, consumed = 0;
    if (interlace) {
      const a = decodeAdam7(raw, ihdr);
      if (a.error) return { error: a.error, parsed, ihdr, raw, expected, actual: raw.length, idatData, z, interlace };
      samples = a.samples; consumed = a.consumed;
    } else {
      const rowBytes = rowBytesOf(ihdr.width, ihdr.colorType, ihdr.bitDepth);
      const bpp = Math.max(1, Math.ceil(channelCount(ihdr.colorType) * ihdr.bitDepth / 8));
      const pixels = unfilter(raw.subarray(0, expected), ihdr.width, ihdr.height, bpp, rowBytes);
      if (!pixels) return { error: '反滤波失败', parsed, ihdr, raw, expected, interlace };
      samples = samplesFromRaw(pixels, ihdr.width, ihdr.height, ihdr.colorType, ihdr.bitDepth);
      consumed = expected;
    }
    const built = buildChannels(samples, ihdr, parsed);

    return {
      error: null, parsed, ihdr, idatData, z, raw, expected, extraRaw,
      width: ihdr.width, height: ihdr.height,
      bitDepth: ihdr.bitDepth, colorType: ihdr.colorType,
      interlace, consumed, channels: built.channels, palette: built.palette, indices: built.indices
    };
  }

  // ---------- 文本块 ----------
  function decodeTextChunk(chunk) {
    const d = chunk.data;
    if (chunk.type === 'tEXt') {
      const z = d.indexOf(0);
      if (z < 0) return null;
      return { keyword: ascii(d.subarray(0, z), z), text: ascii(d.subarray(z + 1), d.length - z - 1) };
    }
    if (chunk.type === 'zTXt') {
      const z = d.indexOf(0);
      if (z < 0 || z + 2 > d.length) return null;
      const r = inflateZlib(d, z + 2);
      return { keyword: ascii(d.subarray(0, z), z), text: (!r.error && r.out) ? (utf8(r.out) || ascii(r.out, r.out.length)) : '(解压失败：' + (r.error || '无输出') + ')', compressed: true };
    }
    if (chunk.type === 'iTXt') {
      const z = d.indexOf(0);
      if (z < 0 || z + 3 > d.length) return null;
      const compFlag = d[z + 1];
      let p = z + 3;
      const langEnd = d.indexOf(0, p); if (langEnd < 0) return null;
      const lang = ascii(d.subarray(p, langEnd), langEnd - p);
      p = langEnd + 1;
      const transEnd = d.indexOf(0, p); if (transEnd < 0) return null;
      const translated = utf8(d.subarray(p, transEnd)) || '';
      p = transEnd + 1;
      let textBytes = d.subarray(p);
      if (compFlag) {
        const r = inflateZlib(textBytes, 0);
        textBytes = (!r.error && r.out) ? r.out : new Uint8Array(0);
      }
      return { keyword: ascii(d.subarray(0, z), z), lang, translated, text: utf8(textBytes) || ascii(textBytes, Math.min(textBytes.length, 4096)), compressed: !!compFlag };
    }
    return null;
  }

  // ---------- 尺寸恢复 ----------
  function dimsFromRawLength(rawLen, colorType, bitDepth, limit) {
    const out = [];
    const maxW = limit || 20000;
    const bits = channelCount(colorType) * bitDepth;
    for (let w = 1; w <= maxW; w++) {
      const rb = Math.ceil(w * bits / 8);
      const denom = rb + 1;
      if (rawLen % denom) continue;
      const h = rawLen / denom;
      if (h >= 1 && h <= 100000) out.push({ width: w, height: h });
      if (out.length > 64) break;
    }
    return out;
  }

  function crcMatchesIHDR(ihdr, stored) {
    const type = Uint8Array.from([0x49, 0x48, 0x44, 0x52]);
    const data = ihdrBytes(ihdr.width, ihdr.height, ihdr.bitDepth, ihdr.colorType, ihdr.compression, ihdr.filter, ihdr.interlace);
    const buf = concatBytes([type, data]);
    return crc32(buf) === stored;
  }

  function recoverDims(input, opts) {
    const b = toU8(input);
    const parsed = parseChunks(b);
    if (!parsed.ok) return { candidates: [], error: 'not PNG' };
    const ihdrChunk = parsed.chunks.find(c => c.type === 'IHDR');
    if (!ihdrChunk) return { candidates: [], error: 'no IHDR' };
    const ihdr = parseIHDR(ihdrChunk);
    const storedCRC = ihdrChunk.crcStored;
    const candidates = [];
    const limit = (opts && opts.limit) || 20000;

    // 1) 已知高度，爆破宽度
    for (let w = 1; w <= limit; w++) {
      const t = Object.assign({}, ihdr, { width: w });
      if (crcMatchesIHDR(t, storedCRC)) candidates.push({ width: w, height: ihdr.height, how: 'IHDR CRC（宽）', crcOk: true });
    }
    // 2) 已知宽度，爆破高度
    for (let h = 1; h <= limit; h++) {
      const t = Object.assign({}, ihdr, { height: h });
      if (crcMatchesIHDR(t, storedCRC)) candidates.push({ width: ihdr.width, height: h, how: 'IHDR CRC（高）', crcOk: true });
    }
    // 3) 用 IDAT 解压长度约束
    try {
      const idat = concatBytes(parsed.chunks.filter(c => c.type === 'IDAT').map(c => c.data));
      const z = inflateZlib(idat, 0, 256 * 1024 * 1024);
      if (z.out) {
        const byLen = dimsFromRawLength(z.out.length, ihdr.colorType, ihdr.bitDepth, limit);
        for (const d of byLen) {
          const t = Object.assign({}, ihdr, d);
          const crcOk = crcMatchesIHDR(t, storedCRC);
          candidates.push({ width: d.width, height: d.height, how: crcOk ? 'IDAT 长度 + IHDR CRC' : 'IDAT 长度', crcOk });
        }
      }
    } catch (e) { /* ignore */ }
    // 去重 + 可信度排序
    const seen = new Set(), uniq = [];
    for (const c of candidates) {
      const k = c.width + 'x' + c.height;
      if (seen.has(k)) continue;
      seen.add(k);
      const ratio = c.width / Math.max(1, c.height);
      c.ratio = ratio;
      c.plausible = ratio >= 0.1 && ratio <= 10 && c.width <= 20000 && c.height <= 20000;
      uniq.push(c);
    }
    uniq.sort((a, b) => (b.crcOk ? 1 : 0) - (a.crcOk ? 1 : 0));
    return { candidates: uniq, ihdr, ihdrChunk, storedCRC };
  }

  // ---------- 重建 / 修复 ----------
  function buildPNG(chunks, newIHDRData, trailing) {
    const parts = [Uint8Array.from(PNG_SIG)];
    for (const c of chunks) {
      const data = (c.type === 'IHDR' && newIHDRData) ? newIHDRData : c.data;
      const typeBytes = chunkTypeBytes(c.type);
      const len = new Uint8Array(4); wr32(len, 0, data.length);
      const crc = crc32(concatBytes([typeBytes, data]));
      const tail = new Uint8Array(4); wr32(tail, 0, crc);
      parts.push(len, typeBytes, data, tail);
    }
    // 原文件缺 IEND 时补一个，保证修复副本结构完整
    if (!chunks.some(c => c.type === 'IEND')) {
      const t = chunkTypeBytes('IEND');
      const len = new Uint8Array(4);
      const crc = crc32(t);
      const tail = new Uint8Array(4); wr32(tail, 0, crc);
      parts.push(len, t, tail);
    }
    // IEND 之后的载荷原样保留，修复副本不能悄悄丢东西
    if (trailing && trailing.length) parts.push(trailing);
    return concatBytes(parts);
  }

  function repairPNG(input, opts) {
    const b = toU8(input);
    const parsed = parseChunks(b);
    if (!parsed.ok) return { error: 'not PNG' };
    const o = opts || {};
    let ihdrData = null;
    const ihdrChunk = parsed.chunks.find(c => c.type === 'IHDR');
    if (!ihdrChunk) return { error: '缺少 IHDR，无法修复' };
    if (o.width || o.height) {
      const ihdr = parseIHDR(ihdrChunk);
      const w = o.width || ihdr.width, h = o.height || ihdr.height;
      ihdrData = ihdrBytes(w, h, ihdr.bitDepth, ihdr.colorType, ihdr.compression, ihdr.filter, ihdr.interlace);
    }
    return { bytes: buildPNG(parsed.chunks, ihdrData, parsed.trailing), fixedCRC: true, ihdrData };
  }

  // 把「拼接后的 IDAT 偏移」映射回文件真实偏移
  function idatOffsetToFile(idatChunks, offset) {
    let acc = 0;
    for (const c of idatChunks) {
      if (offset < acc + c.length) return c.dataStart + (offset - acc);
      acc += c.length;
    }
    return idatChunks.length ? idatChunks[idatChunks.length - 1].dataEnd : 0;
  }

  // ---------- APNG ----------
  function parseAPNG(parsed, ihdr) {
    const actl = parsed.chunks.find(c => c.type === 'acTL');
    if (!actl || actl.data.length < 8) return null;
    const frames = [];
    let cur = null;
    for (const c of parsed.chunks) {
      if (c.type === 'fcTL' && c.data.length >= 26) {
        const d = c.data;
        cur = {
          offset: c.offset, seq: rd32(d, 0), width: rd32(d, 4), height: rd32(d, 8),
          x: rd32(d, 12), y: rd32(d, 16),
          delayNum: rd16(d, 20), delayDen: rd16(d, 22),
          dispose: d[24], blend: d[25],
          idat: [], fdat: []
        };
        frames.push(cur);
      } else if (c.type === 'IDAT' && cur && !cur.fdat.length) {
        cur.idat.push(c.data);
      } else if (c.type === 'fdAT' && cur && c.data.length >= 4) {
        cur.fdat.push(c.data.subarray(4));
      }
    }
    const out = [];
    for (let i = 0; i < frames.length; i++) {
      const f = frames[i];
      const parts = f.idat.length ? f.idat : f.fdat;
      if (!parts.length) { out.push({ meta: f, error: '帧没有数据块' }); continue; }
      const data = concatBytes(parts);
      const z = inflateZlib(data, 0, 64 * 1024 * 1024);
      if ((z.error && !z.out) || !z.out) { out.push({ meta: f, error: '帧解压失败：' + z.error }); continue; }
      if (f.width * f.height > 50000000) { out.push({ meta: f, error: `帧像素数过大：${f.width}x${f.height}` }); continue; }
      const rb = rowBytesOf(f.width, ihdr.colorType, ihdr.bitDepth);
      const expected = f.height * (1 + rb);
      if (z.out.length < expected) { out.push({ meta: f, error: '帧数据不足（截断）' }); continue; }
      const bpp = Math.max(1, Math.ceil(channelCount(ihdr.colorType) * ihdr.bitDepth / 8));
      const px = unfilter(z.out.subarray(0, expected), f.width, f.height, bpp, rb);
      if (!px) { out.push({ meta: f, error: '帧反滤波失败' }); continue; }
      const sm = samplesFromRaw(px, f.width, f.height, ihdr.colorType, ihdr.bitDepth);
      if (!sm) { out.push({ meta: f, error: '帧样本解包失败' }); continue; }
      const built = buildChannels(sm, ihdr, parsed, f.width * f.height);
      out.push({
        meta: f,
        image: { width: f.width, height: f.height, bitDepth: ihdr.bitDepth, colorType: ihdr.colorType, channels: built.channels, error: null }
      });
    }
    return { numFrames: rd32(actl.data, 0), numPlays: rd32(actl.data, 4), frames: out };
  }

  // ---------- 元数据二次编码 ----------
  const B58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  function base58Decode(s) {
    let n = 0n;
    for (const ch of s) {
      const i = B58_ALPHABET.indexOf(ch);
      if (i < 0) return null;
      n = n * 58n + BigInt(i);
    }
    let hexs = n.toString(16);
    if (hexs.length % 2) hexs = '0' + hexs;
    const out = new Uint8Array(hexs.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(hexs.substr(i * 2, 2), 16);
    return out;
  }

  // 只在解出来是"像文本"的时候才报，避免把随机串当结果
  function decodeMetaText(text) {
    const out = [];
    const add = (kind, bytes) => {
      if (!bytes || bytes.length < 4) return;
      if (printableRatio(bytes.subarray(0, 300)) < 0.9) return;
      const s = ascii(bytes, Math.min(bytes.length, 300));
      if (/[\u0000-\u0008]/.test(s)) return;
      out.push({ kind, text: s });
    };
    for (const m of String(text).matchAll(/(?:^|[^0-9a-fA-F])([0-9a-fA-F]{16,})(?![0-9a-fA-F])/g)) {
      const h = m[1];
      if (h.length % 2) continue;
      const bytes = new Uint8Array(h.length / 2);
      for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(h.substr(i * 2, 2), 16);
      add('hex', bytes);
    }
    for (const m of String(text).matchAll(/[1-9A-HJ-NP-Za-km-z]{20,}/g)) {
      const d = base58Decode(m[0]);
      if (d) add('base58', d);
    }
    for (const m of String(text).matchAll(/[A-Za-z0-9+/]{20,}={0,2}/g)) {
      const d = MDZ.b64decode ? MDZ.b64decode(m[0]) : null;
      if (d) add('base64', d);
    }
    // 其余编码（base32/base85/base91/uu/url/html）交给 12-encode
    if (MDZ.decodeOnce) {
      for (const d of MDZ.decodeOnce(text)) {
        if (!out.some(x => x.text === d.text)) out.push({ kind: d.kind, text: d.text });
      }
    }
    return out;
  }

  // ---------- 审计 ----------
  function auditPNG(input, name, opts) {
    const b = toU8(input);
    const findings = [];
    const artifacts = [];
    const parsed = parseChunks(b);
    if (!parsed.ok) return { findings: [finding('L0', 'format', '不是 PNG', { detail: parsed.error })], artifacts, image: null, parsed };

    const ihdrChunk = parsed.chunks.find(c => c.type === 'IHDR');
    const ihdr = ihdrChunk && parseIHDR(ihdrChunk);

    if (ihdr && ihdr.interlace === 1) {
      findings.push(finding('L1', 'interlace', 'Adam7 隔行 PNG（已解码）', {
        confidence: 0.4, offset: ihdrChunk.offset,
        detail: '按 7 个 pass 分别反滤波后重组；像素已参与 LSB 扫描，位平面查看器显示的是重组后的整图。'
      }));
    }

    // 结构错误
    for (const e of parsed.errors) {
      findings.push(finding('L1', 'structure', 'PNG 结构异常：' + e.message, {
        confidence: 0.95, offset: e.offset, declared: e.declared, actual: e.actual,
        detail: `${e.type} chunk @ 0x${hex(e.offset)}`
      }));
    }

    // CRC
    const badCRC = parsed.chunks.filter(c => !c.crcOk);
    for (const c of badCRC) {
      findings.push(finding('L1', 'crc', `${c.type} chunk CRC 不匹配`, {
        confidence: c.type === 'IHDR' ? 0.99 : 0.85,
        offset: c.offset,
        declared: `存储 ${hex32(c.crcStored)}`,
        actual: `实际 ${hex32(c.crcCalc)}`,
        detail: c.type === 'IHDR' ? 'IHDR 的 CRC 通常对应原始宽高——可用「尺寸恢复」反推。' : '可能是改字节后未重算 CRC。',
        recipe: '重算 CRC 后另存副本'
      }));
    }

    // CRC 字段本身被写成 ASCII：4 字节里塞 3~4 个字符，解码时根本用不到
    const crcText = [];
    for (const c of badCRC) {
      const raw = Uint8Array.from([(c.crcStored >>> 24) & 255, (c.crcStored >>> 16) & 255, (c.crcStored >>> 8) & 255, c.crcStored & 255]);
      let s = '';
      for (const v of raw) if (v >= 32 && v <= 126) s += String.fromCharCode(v);   // 不可打印的直接丢掉，不要留占位点
      if (s.length >= 3 && /[#A-Za-z0-9_]/.test(s)) crcText.push({ c, s });
    }
    if (crcText.length) {
      const joined = crcText.map(x => x.s).join('');
      const flagHit = MDZ.flagMatch(joined);
      findings.push(finding('L1', 'crc_ascii', `坏 CRC 字段里读出 ${crcText.length} 段 ASCII`, {
        confidence: flagHit ? 0.99 : 0.75,
        offset: crcText[0].c.offset,
        declared: `${badCRC.length} 个块 CRC 不匹配`,
        actual: flagHit || joined.slice(0, 120),
        detail: 'CRC 只占 4 字节且解码时不被使用，是天然夹带区。逐块拼读：'
          + crcText.map(x => `${x.c.type}@0x${hex(x.c.offset)}→"${x.s}"`).join('；'),
        preview: joined.slice(0, 200),
        recipe: '把每个 chunk 的 4 字节 CRC 当 ASCII 读出并按块序拼接'
      }));
    }

    // 非标准 chunk 类型：拼写型伪块（tEXt → tXEt 之类）
    const KNOWN_CHUNKS = new Set(['IHDR', 'PLTE', 'IDAT', 'IEND', 'tRNS', 'cHRM', 'gAMA', 'iCCP', 'sBIT', 'sRGB', 'tEXt', 'zTXt', 'iTXt', 'bKGD', 'hIST', 'pHYs', 'sPLT', 'tIME', 'eXIf', 'acTL', 'fcTL', 'fdAT', 'cICP', 'mDCV', 'cLLI', 'sTER']);
    for (const c of parsed.chunks) {
      if (KNOWN_CHUNKS.has(c.type)) continue;
      const near = [...KNOWN_CHUNKS].find(k => [...k].filter((ch, i) => ch !== c.type[i]).length === 1);
      const body = ascii(c.data, Math.min(c.data.length, 200));
      const flagHit = MDZ.flagMatch(body);
      findings.push(finding('L1', 'chunk_name', `非标准 chunk 类型 "${c.type}"` + (near ? `（与 ${near} 仅一字之差）` : ''), {
        confidence: flagHit ? 0.99 : (near ? 0.9 : 0.5),
        offset: c.offset,
        declared: `${c.length} 字节`,
        actual: flagHit || (body.slice(0, 120) || '（无可打印内容）'),
        detail: '解码器会跳过未知块，内容不会被渲染——正是夹带的好地方。'
          + (near ? `名字故意与 ${near} 差一个字母，像是伪装成文本块。` : ''),
        preview: body.slice(0, 300),
        recipe: `直接读该块的 ${c.length} 字节原文`,
        payload: c.data.length ? { name: `chunk-${c.type}.bin`, bytes: c.data.slice(0) } : null
      }));
    }

    // 尺寸恢复（IHDR CRC 坏时）
    if (ihdr && ihdrChunk && !ihdrChunk.crcOk) {
      const r = recoverDims(b, { limit: 20000 });
      const shown = r.candidates.filter(c => c.crcOk).concat(r.candidates.filter(c => !c.crcOk && c.plausible)).slice(0, 8);
      if (shown.length) {
        const list = shown.map(c => `${c.width}x${c.height}（${c.how}${c.crcOk ? ' ✓' : ''}）`).join('；');
        findings.push(finding('L1', 'ihdr_dims', 'IHDR 宽高可能被改过', {
          confidence: 0.98, offset: ihdrChunk.offset,
          declared: `${ihdr.width}x${ihdr.height}`,
          actual: list,
          detail: '用 IHDR 存储的 CRC 与/或 IDAT 解压长度反推出候选尺寸。',
          recipe: '在「修复」面板选择候选尺寸，生成修复副本'
        }));
      }
    }

    // 文本块
    for (const c of parsed.chunks) {
      if (c.type !== 'tEXt' && c.type !== 'zTXt' && c.type !== 'iTXt') continue;
      const t = decodeTextChunk(c);
      if (!t) continue;
      const text = t.text || '';
      const looksFlag = !!MDZ.flagMatch(text);
      findings.push(finding('L3', 'text_chunk', `${c.type} 文本块：${t.keyword || '(无关键字)'}`, {
        confidence: looksFlag ? 0.99 : 0.6,
        offset: c.offset,
        declared: `${c.length} 字节`,
        actual: text.slice(0, 120),
        detail: text.slice(0, 400),
        preview: text.slice(0, 400),
        recipe: `解析 ${c.type} 块${t.compressed ? '（已解压）' : ''}`
      }));
      artifacts.push(Object.assign(artifact(`${c.type}-${t.keyword || c.offset}.txt`, new TextEncoder().encode(text), '来自 ' + c.type), { kind: 'text' }));
      // 元数据里常见的二次编码：hex / base58 / base64
      for (const d of decodeMetaText(text)) {
        findings.push(finding('L3', 'meta_decode', `${c.type} 里的 ${d.kind} 编码解出文本`, {
          confidence: 0.85, offset: c.offset,
          declared: `${t.keyword || '(无关键字)'} 的 ${d.kind} 串`,
          actual: d.text.slice(0, 120),
          detail: `解出：${d.text.slice(0, 300)}`,
          preview: d.text.slice(0, 300),
          recipe: `${d.kind} 解码`
        }));
      }
    }

    // 尾部数据
    if (parsed.trailing && parsed.trailing.length) {
      const tr = parsed.trailing;
      const kinds = [];
      if (tr[0] === 0x89 && tr[1] === 0x50) kinds.push('PNG');
      if (tr[0] === 0xFF && tr[1] === 0xD8) kinds.push('JPEG');
      if (tr[0] === 0x50 && tr[1] === 0x4B) kinds.push('ZIP');
      findings.push(finding('L1', 'trailer', 'IEND 之后还有数据', {
        confidence: 0.95, offset: parsed.iendEnd,
        declared: '文件应在此结束', actual: `${tr.length} 字节`,
        detail: kinds.length ? `尾部以 ${kinds.join('/')} 签名开头` : '尾部无已知签名，已作为 artifact 提取',
        preview: ascii(tr, 96),
        recipe: `从 0x${hex(parsed.iendEnd)} 切出尾部`,
        payload: { name: 'png-trailer.bin', bytes: tr.slice(0) }
      }));
      artifacts.push(artifact('png-trailer.bin', tr, 'IEND 之后的数据'));
    }

    // IDAT 双流 / unused_data
    const idatChunks = parsed.chunks.filter(c => c.type === 'IDAT');
    if (idatChunks.length) {
      const idatData = concatBytes(idatChunks.map(c => c.data));
      const first = inflateZlib(idatData, 0, 256 * 1024 * 1024);
      const consumed = first.consumed || 0;
      if (first.error && !first.out) {
        findings.push(finding('L2', 'idat', 'IDAT zlib 流解压失败', {
          confidence: 0.9, offset: idatChunks[0].dataStart,
          declared: `${idatData.length} 字节`, actual: first.error,
          detail: '可能不是标准 zlib，或流被截断。'
        }));
      } else if (first.error) {
        findings.push(finding('L2', 'idat', 'IDAT zlib 流校验失败（但可部分解码）', {
          confidence: 0.85, offset: idatChunks[0].dataStart,
          declared: `${idatData.length} 字节`, actual: first.error,
          detail: '解压出了数据，但 adler32 对不上：可能被改过字节或尾部被截断。图像内容仍可作参考。'
        }));
      } else if (consumed < idatData.length) {
        const rest = idatData.subarray(consumed);
        const restOffset = idatOffsetToFile(idatChunks, consumed);
        // 找剩余部分里的流签名
        const sigs = findStreamSignatures(idatData, consumed, idatData.length);
        let decoded = null;
        let lzmaHit = null;
        let tried = 0;
        for (const s of sigs) {
          if (tried++ > 64) break;
          if (s.kind === 'zlib') {
            const z = inflateZlib(idatData, s.offset, 256 * 1024 * 1024);
            if (!z.error && z.out && z.out.length > 8) { decoded = { kind: 'zlib', offset: s.offset, out: z.out, consumed: z.consumed }; break; }
          } else if (s.kind === 'gzip') {
            const z = MDZ.inflateGzip(idatData, s.offset, 256 * 1024 * 1024);
            if (!z.error && z.out && z.out.length > 8) { decoded = { kind: 'gzip', offset: s.offset, out: z.out, consumed: z.consumed }; break; }
          } else if (s.kind === 'lzma' && !lzmaHit) {
            // LZMA 无法在浏览器内解压，先占位；真解出 zlib/gzip 时优先报那个
            lzmaHit = s;
          }
        }
        if (decoded) {
          const pad = decoded.offset - consumed;
          findings.push(finding('L2', 'second_stream', `IDAT 内发现第二条 ${decoded.kind} 流`, {
            confidence: 0.99, offset: idatOffsetToFile(idatChunks, decoded.offset),
            declared: `首流消费 ${consumed} 字节`, actual: `第二流 @ +${decoded.offset}（${decoded.kind}，产出 ${decoded.out.length} 字节）`,
            detail: pad > 0 ? `两条流之间有 ${pad} 字节垫层。` : '第二条流紧贴第一条。',
            preview: ascii(decoded.out, 120),
            recipe: `在 IDAT 数据 +0x${hex(decoded.offset)} 处 inflate`,
            payload: { name: 'png-second-stream.bin', bytes: decoded.out.slice(0) }
          }));
          artifacts.push(artifact('png-second-stream.bin', decoded.out, 'IDAT 内的第二条流'));
          // 尝试当图像解码
          if (decoded.out.length > 8 && decoded.out[0] === 0x89) {
            const inner = decodePNG(decoded.out, {});
            if (!inner.error) artifacts.push({ name: 'png-second-stream-image', bytes: decoded.out, image: inner, note: '第二条流本身就是 PNG', kind: 'image' });
          } else if (ihdr) {
            const rb = rowBytesOf(ihdr.width, ihdr.colorType, ihdr.bitDepth);
            if (decoded.out.length >= (rb + 1) && decoded.out.length % (rb + 1) === 0) {
              const h2 = decoded.out.length / (rb + 1);
              const bpp = Math.max(1, Math.ceil(channelCount(ihdr.colorType) * ihdr.bitDepth / 8));
              const px = unfilter(decoded.out, ihdr.width, h2, bpp, rb);
              if (px) {
                const samples = samplesFromRaw(px, ihdr.width, h2, ihdr.colorType, ihdr.bitDepth);
                let channels = null;
                if (ihdr.colorType === 2 && samples) channels = { R: samples[0], G: samples[1], B: samples[2] };
                else if (ihdr.colorType === 6 && samples) channels = { R: samples[0], G: samples[1], B: samples[2], A: samples[3] };
                else if (ihdr.colorType === 0 && samples) channels = { R: samples[0], G: samples[0], B: samples[0] };
                else if (ihdr.colorType === 4 && samples) channels = { R: samples[0], G: samples[0], B: samples[0], A: samples[1] };
                if (channels) {
                  artifacts.push({
                    name: `png-second-stream-image-${ihdr.width}x${h2}`, bytes: decoded.out,
                    image: { width: ihdr.width, height: h2, bitDepth: ihdr.bitDepth, colorType: ihdr.colorType, channels, error: null },
                    note: `按原图宽 ${ihdr.width} 反滤波得到 ${ihdr.width}x${h2}`, kind: 'image'
                  });
                }
              }
            }
          }
        } else if (lzmaHit) {
          const tail = idatData.subarray(lzmaHit.offset);
          const zl = MDZ.lzmaDecompressAlone ? MDZ.lzmaDecompressAlone(tail, { maxOut: 64 * 1024 * 1024 }) : null;
          const zout = zl && zl.out;
          const zhead = zout ? zout.subarray(0, Math.min(4096, zout.length)) : null;
          const zpr = zout ? MDZ.printableRatio(zhead) : 0;
          const zflag = zout ? MDZ.FLAG_RE.test(ascii(zhead, zhead.length)) : false;
          if (zout && zout.length && (zflag || (zout.length >= 32 && zpr >= 0.8))) {
            findings.push(finding('L2', 'second_stream', 'IDAT 剩余数据里的 LZMA 流（已解压）', {
              confidence: 0.95, offset: idatOffsetToFile(idatChunks, lzmaHit.offset),
              declared: `首流消费 ${consumed} 字节`,
              actual: `解出 ${zout.length} 字节`,
              detail: `可打印率 ${(zpr * 100).toFixed(0)}%${zflag ? '；命中 flag 正则' : ''}${zl.partial ? '；流被截断，只解出前段' : ''}`,
              preview: ascii(zout, 160),
              recipe: `从 IDAT +0x${lzmaHit.offset} 切出后 LZMA 解压`,
              payload: { name: 'png-lzma.bin', bytes: zout.slice(0) }
            }));
            artifacts.push(artifact('png-lzma.bin', zout, 'IDAT 内 LZMA 解压产物'));
          } else {
            findings.push(finding('L2', 'second_stream_lzma', 'IDAT 剩余数据里有 LZMA 流', {
              confidence: 0.9, offset: idatOffsetToFile(idatChunks, lzmaHit.offset),
              declared: `首流消费 ${consumed} 字节`,
              actual: `LZMA @ +${lzmaHit.offset}（${tail.length} 字节）`,
              detail: 'LZMA 单独格式没有魔数，按属性字节 + 字典大小识别（与 binwalk 同判据）；内置解压没解出可读内容，下载载荷后可用 xz --format=lzma -dc 再试。',
              preview: ascii(tail, 160),
              recipe: '下载 png-lzma.lzma 后执行：xz --format=lzma -dc png-lzma.lzma',
              payload: { name: 'png-lzma.lzma', bytes: tail.slice(0) }
            }));
            artifacts.push(artifact('png-lzma.lzma', tail, 'IDAT 内的 LZMA 流'));
          }
        } else {
          findings.push(finding('L2', 'unused_data', 'zlib 流结束后仍有未消费数据', {
            confidence: 0.8, offset: restOffset,
            declared: `首流消费 ${consumed} 字节`, actual: `剩余 ${rest.length} 字节`,
            detail: '剩余部分没有可识别的新流；可能是垫层、碎片或另一种编码。',
            preview: ascii(rest, 160),
            recipe: `从 IDAT +0x${hex(consumed)} 切出剩余数据`,
            payload: { name: 'png-idat-rest.bin', bytes: rest.slice(0) }
          }));
          artifacts.push(artifact('png-idat-rest.bin', rest, 'zlib 流结束后的剩余数据'));
        }
      }

      // 逐 chunk 独立流（misc10 同族）
      if (idatChunks.length > 1) {
        for (let i = 1; i < idatChunks.length; i++) {
          const c = idatChunks[i];
          const z = inflateZlib(c.data, 0, 256 * 1024 * 1024);
          if (z.out && z.out.length > 8 && !z.error) {
            findings.push(finding('L2', 'independent_idat', `第 ${i + 1} 个 IDAT 是独立 zlib 流`, {
              confidence: 0.95, offset: c.offset,
              declared: `${c.length} 字节`, actual: `独立解压出 ${z.out.length} 字节`,
              preview: ascii(z.out, 96),
              recipe: `单独 inflate 这个 IDAT`,
              payload: { name: `idat-${i + 1}.bin`, bytes: z.out.slice(0) }
            }));
            artifacts.push(artifact(`idat-${i + 1}.bin`, z.out, '独立 IDAT 流'));
          }
        }
      }
    }

    // 解码 + 多余扫描行
    let image = null;
    const dec = decodePNG(b, opts);
    const plte = parsed.chunks.find(c => c.type === 'PLTE');
    if (plte) {
      const entries = Math.floor(plte.data.length / 3);
      const palText = ascii(plte.data, plte.data.length);
      findings.push(finding('L3', 'palette', `PLTE 调色板 ${entries} 项`, {
        confidence: 0.3, offset: plte.offset,
        declared: `${entries} 项 / ${plte.length} 字节`,
        actual: ihdr && ihdr.colorType === 3 ? `索引色 bitDepth ${ihdr.bitDepth}` : '非索引色图仍带 PLTE',
        recipe: '读取 PLTE 原始字节（每项 RGB 三字节）'
      }));
      const fm = palText.match(/(?:flag|ctf|litctf|susctf|qctf|ctfshow)\{[ -~]{1,200}\}/i);
      if (fm) {
        findings.push(finding('L3', 'palette_flag', `PLTE 字节里出现 ${fm[0]}`, {
          confidence: 0.99, offset: plte.offset,
          actual: fm[0], preview: palText.slice(0, 300),
          recipe: 'PLTE 的 RGB 字节直接按 ASCII 拼读',
          payload: { name: 'plte-bytes.bin', bytes: plte.data.slice(0) }
        }));
      }
      if (ihdr && ihdr.colorType === 3 && dec.indices) {
        const used = new Uint8Array(entries);
        for (let i = 0; i < dec.indices.length; i++) {
          const v = dec.indices[i];
          if (v < entries) used[v] = 1;
        }
        const unused = [];
        for (let i = 0; i < entries; i++) if (!used[i]) unused.push(i);
        if (unused.length) {
          const unusedBytes = [];
          for (const i of unused) unusedBytes.push(plte.data[i * 3], plte.data[i * 3 + 1], plte.data[i * 3 + 2]);
          const ut = ascii(Uint8Array.from(unusedBytes), unusedBytes.length);
          const ufm = ut.match(/(?:flag|ctf|litctf|susctf|qctf|ctfshow)\{[ -~]{1,200}\}/i);
          findings.push(finding('L3', 'palette_unused', `PLTE 有 ${unused.length} 个未使用颜色`, {
            confidence: ufm ? 0.95 : 0.6, offset: plte.offset,
            declared: `${entries} 项`, actual: `实际使用 ${entries - unused.length} 项`,
            detail: '未使用项没人会画出来，是天然的夹带区。' + (ufm ? ` 未使用项字节中出现 ${ufm[0]}。` : ''),
            preview: ut.slice(0, 200) || unused.slice(0, 32).map(i => `#${i}`).join(' '),
            recipe: '按 PLTE 项序读出未使用项的 RGB 字节',
            payload: ufm ? { name: 'plte-unused.bin', bytes: Uint8Array.from(unusedBytes) } : null
          }));
        }
        const seen = new Map();
        const dups = [];
        for (let i = 0; i < entries; i++) {
          const k = (plte.data[i * 3] << 16) | (plte.data[i * 3 + 1] << 8) | plte.data[i * 3 + 2];
          if (seen.has(k)) dups.push([seen.get(k), i]); else seen.set(k, i);
        }
        if (dups.length) {
          findings.push(finding('L3', 'palette_dup', `PLTE 有 ${dups.length} 组重复颜色`, {
            confidence: 0.5, offset: plte.offset,
            actual: dups.slice(0, 8).map(([a, b]) => `#${a}=#${b}`).join(' '),
            detail: '重复颜色常被用来暗示索引顺序/隐藏位。',
            recipe: '检查重复项与使用频率'
          }));
        }
      }
    }
    if (!dec.error) {
      image = dec.channels ? {
        width: dec.width, height: dec.height, bitDepth: dec.bitDepth, colorType: dec.colorType,
        channels: dec.channels, palette: dec.palette, error: null
      } : null;
      if (dec.extraRaw && dec.extraRaw.length) {
        findings.push(finding('L1', 'extra_scanlines', 'IDAT 解压出的数据比 IHDR 声明的多', {
          confidence: 0.99, offset: ihdrChunk ? ihdrChunk.offset : 0,
          declared: `${dec.expected} 字节（${dec.width}x${dec.height}）`, actual: `${dec.raw.length} 字节`,
          detail: `多出 ${dec.extraRaw.length} 字节。常见于：高度被改小、底下压着第二张图。`,
          preview: ascii(dec.extraRaw, 120),
          recipe: '按原图宽度继续反滤波，或直接提取多余扫描行'
        }));
        artifacts.push(artifact('png-extra-scanlines.bin', dec.extraRaw, 'IHDR 声明之外的扫描行'));
        // 即使 IHDR CRC 被重算过，IDAT 的实际行数仍会暴露真实高度
        const dimCands = dimsFromRawLength(dec.raw.length, dec.colorType, dec.bitDepth, 20000)
          .filter(c => !(c.width === dec.width && c.height === dec.height))
          .filter(c => {
            const r = c.width / Math.max(1, c.height);
            return r >= 0.1 && r <= 10 && c.width <= 20000 && c.height <= 20000;
          })
          .slice(0, 6);
        if (dimCands.length) {
          findings.push(finding('L1', 'idat_dims', 'IDAT 实际行数对应其它尺寸', {
            confidence: 0.95, offset: ihdrChunk ? ihdrChunk.offset : 8,
            declared: `${dec.width}x${dec.height}`,
            actual: dimCands.map(c => `${c.width}x${c.height}`).join(' / '),
            detail: `IDAT 解出 ${dec.raw.length} 字节，按当前位深/颜色类型换算，行数不止声明的高度。即使 IHDR CRC 被重算，这里也会暴露。`,
            recipe: '在修复面板选择 IDAT 长度推出的尺寸（可能未过 CRC）'
          }));
        }
        const rb = rowBytesOf(dec.width, dec.colorType, dec.bitDepth);
        if (rb + 1 > 0 && dec.extraRaw.length % (rb + 1) === 0) {
          const h2 = dec.extraRaw.length / (rb + 1);
          const bpp = Math.max(1, Math.ceil(channelCount(dec.colorType) * dec.bitDepth / 8));
          const px = unfilter(dec.extraRaw, dec.width, h2, bpp, rb);
          if (px) {
            const s = samplesFromRaw(px, dec.width, h2, dec.colorType, dec.bitDepth);
            let ch = null;
            if (dec.colorType === 2 && s) ch = { R: s[0], G: s[1], B: s[2] };
            else if (dec.colorType === 6 && s) ch = { R: s[0], G: s[1], B: s[2], A: s[3] };
            else if (dec.colorType === 0 && s) ch = { R: s[0], G: s[0], B: s[0] };
            else if (dec.colorType === 4 && s) ch = { R: s[0], G: s[0], B: s[0], A: s[1] };
            if (ch) artifacts.push({
              name: `png-extra-image-${dec.width}x${h2}`, image: { width: dec.width, height: h2, bitDepth: dec.bitDepth, colorType: dec.colorType, channels: ch, error: null },
              note: `多余扫描行按原宽反滤波 = ${dec.width}x${h2}`, kind: 'image'
            });
          }
        }
      } else if (dec.extraRaw && dec.extraRaw.length === 0 && dec.z && dec.z.consumed < dec.idatData.length &&
                 !findings.some(f => f.type === 'second_stream' || f.type === 'unused_data' || f.type === 'independent_idat')) {
        findings.push(finding('L2', 'unused_data', 'IDAT 的 zlib 流解压完后仍有剩余字节', {
          confidence: 0.9, offset: idatOffsetToFile(idatChunks, dec.z.consumed),
          declared: `${dec.z.consumed} 字节`, actual: `${dec.idatData.length - dec.z.consumed} 字节未消费`,
          preview: ascii(dec.idatData.subarray(dec.z.consumed), 120)
        }));
      }
    } else if (dec.ihdr) {
      // 结构上可读但画面解不出来：把已知事实报出来
      if (dec.expected !== undefined) {
        findings.push(finding('L1', 'decode', 'PNG 解码失败', {
          confidence: 0.9, offset: 8, declared: `${dec.expected} 字节`, actual: `${dec.actual !== undefined ? dec.actual : '?'} 字节`,
          detail: dec.error
        }));
      } else {
        findings.push(finding('L1', 'decode', 'PNG 无法解码：' + (dec.error || '未知原因'), {
          confidence: 0.85, offset: 8,
          detail: '结构审计已执行，但像素解码/LSB 扫描未进行。若是 Adam7 隔行扫描，本工具暂不支持；请用其他工具或先转非隔行。'
        }));
      }
      if (dec.extraRaw && dec.extraRaw.length) {
        artifacts.push(artifact('png-extra-raw.bin', dec.extraRaw, '解码后可提取的额外数据'));
      }
    }

    // 过滤器字节分布（顺手）
    if (dec.raw && !dec.error) {
      const rb = rowBytesOf(dec.width, dec.colorType, dec.bitDepth) + 1;
      const dist = [0, 0, 0, 0, 0];
      for (let y = 0; y < dec.height; y++) dist[dec.raw[y * rb]]++;
      const odd = dist[4] === 0 && dist[0] === 0 && dist[1] === 0;
      if (odd) findings.push(finding('L1', 'filters', 'PNG 行过滤器分布异常', { confidence: 0.3, detail: `0:${dist[0]} 1:${dist[1]} 2:${dist[2]} 3:${dist[3]} 4:${dist[4]}` }));
    }

    // APNG：逐帧解码（每帧独立 zlib 流）
    const apngImages = [];
    try {
      const apng = parseAPNG(parsed, ihdr);
      if (apng) {
        findings.push(finding('L1', 'apng', `APNG 动画：${apng.numFrames} 帧 / 播放 ${apng.numPlays} 次`, {
          confidence: 0.5, offset: ihdrChunk ? ihdrChunk.offset : 0,
          declared: `${apng.numFrames} 帧`, actual: `解出 ${apng.frames.filter(f => f.image).length} 帧`,
          detail: 'APNG 的每帧是独立 zlib 流（IDAT 或 fdAT），已逐帧解码并加入 LSB 扫描队列。'
        }));
        apng.frames.forEach((f, i) => {
          const m = f.meta;
          if (f.image) {
            apngImages.push({
              name: `apng-frame-${i}`, image: f.image,
              note: `APNG 第 ${i} 帧 ${m.width}x${m.height} @(${m.x},${m.y})`
            });
            findings.push(finding('L4', 'apng_frame', `APNG 第 ${i} 帧可解码：${m.width}x${m.height}`, {
              confidence: 0.5, offset: m.offset,
              declared: `${m.width}x${m.height} @(${m.x},${m.y}) 延迟 ${m.delayNum}/${m.delayDen}`,
              actual: `dispose=${m.dispose} blend=${m.blend}`,
              recipe: '已加入递归队列，自动做位平面/LSB 扫描'
            }));
          } else {
            findings.push(finding('L4', 'apng_frame', `APNG 第 ${i} 帧解码失败`, {
              confidence: 0.6, declared: `${m.width}x${m.height}`, actual: f.error
            }));
          }
        });
      }
    } catch (e) {
      findings.push(finding('L1', 'apng', 'APNG 解析失败', { confidence: 0.6, detail: String(e && e.message || e) }));
    }

    return { findings, artifacts, image, images: apngImages, parsed, ihdr, decode: dec };
  }

  Object.assign(MDZ, {
    isPNG, parseChunks, parseIHDR, decodePNG, rowBytesOf, unfilter, samplesFromRaw,
    decodeTextChunk, recoverDims, repairPNG, buildPNG, auditPNG, crcMatchesIHDR, ihdrBytes,
    parseAPNG, decodeAdam7, buildChannels, ADAM7
  });
})(typeof globalThis !== 'undefined' ? globalThis : this);
