/* misc大手子 — 40 BMP
 * 重点：调色板尾 ↔ bfOffBits 的夹缝、bfSize 少报、像素数据后的附加
 */
(function (root) {
  'use strict';
  const MDZ = root.MDZ = root.MDZ || {};
  const { toU8, hex, ascii, finding, artifact } = MDZ;

  function le16(b, o) { return b[o] | (b[o + 1] << 8); }
  function le32(b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0; }
  function isBMP(input) {
    const b = toU8(input);
    return b.length >= 14 && b[0] === 0x42 && b[1] === 0x4D;
  }

  function parseBMP(input) {
    const b = toU8(input);
    if (!isBMP(b)) return { error: 'not BMP' };
    if (b.length < 26) return { error: '文件太短' };
    const bfSize = le32(b, 2);
    const bfOffBits = le32(b, 10);
    const dibSize = le32(b, 14);
    let width, height, planes, bpp, compression = 0, colorsUsed = 0, paletteEntry = 4, paletteStart = 14 + dibSize;
    if (dibSize === 12) {
      width = le16(b, 18); height = le16(b, 20); planes = le16(b, 22); bpp = le16(b, 24);
      paletteEntry = 3;
    } else if (dibSize >= 40) {
      width = le32(b, 18) | 0; height = le32(b, 22) | 0; planes = le16(b, 26); bpp = le16(b, 28);
      compression = le32(b, 30); colorsUsed = le32(b, 46);
    } else {
      return { error: '未知 DIB 头大小 ' + dibSize };
    }
    const topDown = height < 0;
    const absH = Math.abs(height);
    const rowSize = Math.floor((bpp * width + 31) / 32) * 4;
    const paletteDeclared = bpp <= 8 ? (colorsUsed || (1 << bpp)) : 0;
    // 上限：BMP 调色板最多 256 项；文件里实际能容纳的项数也要卡死，防止 colorsUsed 撑爆内存
    const paletteMaxByFile = paletteStart <= b.length
      ? Math.floor((b.length - paletteStart) / paletteEntry) : 0;
    const paletteCount = Math.min(paletteDeclared, 256, paletteMaxByFile);
    const paletteClamped = paletteCount < paletteDeclared;
    const paletteEnd = paletteStart + paletteCount * paletteEntry;
    const pixelEnd = bfOffBits + rowSize * absH;
    return {
      error: null, bfSize, bfOffBits, dibSize, width, height, absH, topDown,
      planes, bpp, compression, colorsUsed, paletteStart, paletteEnd, paletteCount,
      paletteDeclared, paletteClamped, paletteMaxByFile,
      paletteEntry, rowSize, pixelEnd, size: b.length
    };
  }

  function decodeBMP(b, info) {
    if (info.compression !== 0) return { error: '压缩方式 ' + info.compression + ' 暂不支持' };
    if (![1, 4, 8, 24, 32].includes(info.bpp)) return { error: 'bpp=' + info.bpp + ' 暂不支持' };
    if (!(info.width > 0) || !(info.absH > 0)) return { error: `宽高为 0（width=${info.width}, height=${info.absH}）` };
    if (info.bfOffBits + info.rowSize * info.absH > b.length) return { error: '像素数据被截断' };
    const n = info.width * info.absH;
    const R = new Uint8Array(n), G = new Uint8Array(n), B = new Uint8Array(n), A = new Uint8Array(n);
    A.fill(255);
    let palette = null;
    if (info.bpp <= 8) {
      palette = new Uint8Array(info.paletteCount * 3);
      for (let i = 0; i < info.paletteCount; i++) {
        const p = info.paletteStart + i * info.paletteEntry;
        if (p + 2 >= b.length) break;
        palette[i * 3] = b[p + 2];     // BGR -> RGB
        palette[i * 3 + 1] = b[p + 1];
        palette[i * 3 + 2] = b[p];
      }
    }
    for (let y = 0; y < info.absH; y++) {
      const srcRow = info.topDown ? y : (info.absH - 1 - y);
      const rowOff = info.bfOffBits + srcRow * info.rowSize;
      for (let x = 0; x < info.width; x++) {
        const di = y * info.width + x;
        if (info.bpp === 24) {
          const p = rowOff + x * 3;
          B[di] = b[p]; G[di] = b[p + 1]; R[di] = b[p + 2];
        } else if (info.bpp === 32) {
          const p = rowOff + x * 4;
          B[di] = b[p]; G[di] = b[p + 1]; R[di] = b[p + 2]; A[di] = b[p + 3];
        } else {
          const bitPos = x * info.bpp;
          const byte = b[rowOff + (bitPos >> 3)];
          const shift = 8 - info.bpp - (bitPos & 7);
          const idx = (byte >> shift) & ((1 << info.bpp) - 1);
          if (palette && idx * 3 + 2 < palette.length) {
            R[di] = palette[idx * 3]; G[di] = palette[idx * 3 + 1]; B[di] = palette[idx * 3 + 2];
          }
        }
      }
    }
    return { width: info.width, height: info.absH, bitDepth: info.bpp, colorType: 'BMP', channels: { R, G, B, A }, error: null, palette };
  }

  function auditBMP(input, name) {
    const b = toU8(input);
    const findings = [], artifacts = [];
    const info = parseBMP(b);
    if (info.error) return { findings: [finding('L0', 'format', '不是 BMP', { detail: info.error })], artifacts, image: null, info };

    if (info.paletteClamped) {
      findings.push(finding('L1', 'palette_count', '调色板声明数量异常（已按文件容量收敛）', {
        confidence: 0.9, offset: info.paletteStart,
        declared: info.paletteDeclared + ' 项',
        actual: info.paletteCount + ' 项（文件最多容纳 ' + info.paletteMaxByFile + ' 项）',
        detail: 'colorsUsed 可能被改过或伪造；不收敛会导致超大内存分配。'
      }));
    }

    // bfSize vs 实际
    if (info.bfSize !== b.length) {
      findings.push(finding('L1', 'bfSize', 'bfSize 声明与文件大小不符', {
        confidence: 0.9, offset: 2,
        declared: info.bfSize + ' 字节', actual: b.length + ' 字节（差 ' + (b.length - info.bfSize) + '）',
        detail: '声明的量 ≠ 实际的量：少报的那段往往就是夹带区。'
      }));
    }

    // 调色板尾 → bfOffBits 夹缝
    if (info.bfOffBits > info.paletteEnd) {
      const gap = b.subarray(info.paletteEnd, info.bfOffBits);
      const nz = gap.some(x => x !== 0);
      findings.push(finding('L1', 'palette_gap', '调色板与像素数组之间有夹缝', {
        confidence: nz ? 0.99 : 0.7,
        offset: info.paletteEnd,
        declared: `paletteEnd=0x${hex(info.paletteEnd)}`, actual: `bfOffBits=0x${hex(info.bfOffBits)}（${gap.length} 字节）`,
        detail: '规范里这段未定义，解析器读完调色板会直接跳到 bfOffBits，谁都不读。' + (nz ? ' 夹缝内有非零字节。' : ' 夹缝全零。'),
        preview: ascii(gap, 160),
        recipe: `从 0x${hex(info.paletteEnd)} 读 ${gap.length} 字节`,
        payload: { name: 'bmp-palette-gap.bin', bytes: gap.slice(0) }
      }));
      artifacts.push(artifact('bmp-palette-gap.bin', gap, '调色板与像素数组之间的夹缝'));
    }

    // 像素数据之后
    if (info.pixelEnd < b.length) {
      const tr = b.subarray(info.pixelEnd);
      const nz = tr.some(x => x !== 0);
      const tiny = tr.length < 8 && !nz;
      findings.push(finding('L1', 'trailer', '像素数据之后还有数据', {
        confidence: tiny ? 0.15 : 0.9, offset: info.pixelEnd,
        declared: `pixelEnd=0x${hex(info.pixelEnd)}`, actual: `${tr.length} 字节`,
        detail: tiny ? '不足 8 字节且全零，可能只是对齐填充。' : '',
        preview: ascii(tr, 120),
        recipe: `从 0x${hex(info.pixelEnd)} 切出`,
        payload: { name: 'bmp-trailer.bin', bytes: tr.slice(0) }
      }));
      if (!tiny) artifacts.push(artifact('bmp-trailer.bin', tr, '像素数组之后的数据'));
    } else if (info.pixelEnd > b.length) {
      findings.push(finding('L1', 'truncated', '像素数据不足（文件截断或尺寸/bfOffBits 被改）', {
        confidence: 0.9, offset: info.bfOffBits,
        declared: info.pixelEnd + ' 字节', actual: b.length + ' 字节'
      }));
    }

    // 调色板本身
    if (info.paletteCount) {
      artifacts.push(artifact('bmp-palette.bin', b.subarray(info.paletteStart, Math.min(info.paletteEnd, b.length)), '调色板'));
    }

    const image = decodeBMP(b, info);
    if (image.error) {
      findings.push(finding('L4', 'decode', 'BMP 像素解码失败', { confidence: 0.6, detail: image.error }));
    }
    return { findings, artifacts, image: image.error ? null : image, info };
  }

  // 只改文件头里的宽高字段；像素数组原样保留（拉高露出藏起来的行，或让解析器读歪）
  function editBMPDims(input, width, height) {
    const b = toU8(input);
    const info = parseBMP(b);
    if (info.error) return { error: info.error };
    const w = Math.round(Number(width)), h = Math.round(Number(height));
    if (!(w >= 1 && w <= 0x7FFFFFFF && h >= 1 && h <= 0x7FFFFFFF)) return { error: '宽高必须 ≥ 1' };
    const out = new Uint8Array(b);
    if (info.dibSize === 12) {
      if (w > 65535 || h > 65535) return { error: '12 字节 DIB 头的宽高上限是 65535' };
      out[18] = w & 255; out[19] = (w >> 8) & 255;
      out[20] = h & 255; out[21] = (h >> 8) & 255;
    } else {
      const dv = new DataView(out.buffer, out.byteOffset, out.byteLength);
      dv.setInt32(18, w, true);
      dv.setInt32(22, info.topDown ? -h : h, true);   // 保留自下而上的方向
    }
    return { bytes: out, width: w, height: h };
  }

  // 从「文件实际像素区长度」反推宽高：rowSize = 4 字节对齐，height = dataBytes / rowSize。
  // 用于 bfSize/宽高被改小、底下还压着画面的 BMP（misc24/30/31 这类）。
  function recoverBMPDims(input, opts) {
    const b = toU8(input);
    const info = parseBMP(b);
    if (info.error) return { error: info.error };
    if (info.compression !== 0 || ![1, 4, 8, 24, 32].includes(info.bpp)) {
      return { error: `压缩方式 ${info.compression} / ${info.bpp} bpp 暂不支持反推` };
    }
    const o = opts || {};
    const dataBytes = b.length - info.bfOffBits;
    if (dataBytes <= 0) return { error: 'bfOffBits 之后没有像素数据' };
    const maxW = Math.min(o.maxWidth || 4096, 20000);
    const maxH = o.maxHeight || 20000;
    const cands = [];
    for (let w = 1; w <= maxW; w++) {
      const rowSize = Math.floor((info.bpp * w + 31) / 32) * 4;
      if (!rowSize) continue;
      const rows = Math.floor(dataBytes / rowSize);
      if (rows < 1 || rows > maxH) continue;
      const rem = dataBytes - rows * rowSize;
      if (rem > 8) continue;                 // 只接受 BMP 行尾/文件尾的对齐余量
      if (w === info.width && rows === info.absH) continue;
      if (w / rows < 0.05 || w / rows > 20) continue;
      cands.push({
        width: w, height: rows, rowSize, remainder: rem,
        how: `${dataBytes} 字节像素区 ÷ 行字节 ${rowSize} = ${rows} 行（余 ${rem}）`
      });
    }
    cands.sort((a, b) =>
      a.remainder - b.remainder ||
      Math.abs(a.width - info.width) - Math.abs(b.width - info.width) ||
      b.height - a.height);
    // 两类最常见的改法分开列：只改宽度（高度声明是对的）/ 只改高度（宽度声明是对的）
    const widthFixed = cands.filter(c => c.width === info.width)
      .sort((a, b) => a.remainder - b.remainder || Math.abs(a.height - info.absH) - Math.abs(b.height - info.absH));
    const heightFixed = cands.filter(c => c.height === info.absH)
      .sort((a, b) => a.remainder - b.remainder || Math.abs(a.width - info.width) - Math.abs(b.width - info.width));
    const other = cands.filter(c => c.width !== info.width && c.height !== info.absH);
    return {
      candidates: cands.slice(0, o.limit || 12),
      widthFixed: widthFixed.slice(0, 8),
      heightFixed: heightFixed.slice(0, 8),
      other: other.slice(0, 8),
      declared: { width: info.width, height: info.absH, bpp: info.bpp, rowSize: info.rowSize, dataBytes },
      info
    };
  }

  // 最小 24-bit BMP 编码：给"只存在于内存里的图"（画字掩码、频谱）一个可下载的实体
  function encodeBMP(image) {
    if (!image || !(image.width > 0) || !(image.height > 0) || !image.channels) return null;
    const w = image.width, h = image.height;
    const rowSize = Math.ceil(w * 3 / 4) * 4;
    const dataSize = rowSize * h;
    const fileSize = 54 + dataSize;
    const out = new Uint8Array(fileSize);
    const dv = new DataView(out.buffer);
    out[0] = 0x42; out[1] = 0x4D;
    dv.setUint32(2, fileSize, true);
    dv.setUint32(10, 54, true);
    dv.setUint32(14, 40, true);
    dv.setInt32(18, w, true); dv.setInt32(22, h, true);
    dv.setUint16(26, 1, true); dv.setUint16(28, 24, true);
    dv.setUint32(34, dataSize, true);
    const R = image.channels.R, G = image.channels.G, B = image.channels.B;
    for (let y = 0; y < h; y++) {
      const sy = h - 1 - y;                     // BMP 自下而上
      for (let x = 0; x < w; x++) {
        const si = sy * w + x, di = 54 + y * rowSize + x * 3;
        out[di] = B ? B[si] : 0;
        out[di + 1] = G ? G[si] : 0;
        out[di + 2] = R ? R[si] : 0;
      }
    }
    return out;
  }

  Object.assign(MDZ, { isBMP, parseBMP, decodeBMP, auditBMP, encodeBMP, editBMPDims, recoverBMPDims });
})(typeof globalThis !== 'undefined' ? globalThis : this);
