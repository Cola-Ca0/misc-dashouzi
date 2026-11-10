/* misc大手子 — 30 JPEG
 * 段解析 / EXIF 全段 / APP13 第二块 EXIF / 缩略图 / EOI 后附加 / 注释
 */
(function (root) {
  'use strict';
  const MDZ = root.MDZ = root.MDZ || {};
  const { toU8, hex, ascii, utf8, utf16le, strings, finding, artifact } = MDZ;

  function be16(b, o) { return (b[o] << 8) | b[o + 1]; }
  function be32(b, o) { return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0; }
  function isJPEG(input) {
    const b = toU8(input);
    return b.length >= 3 && b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF;
  }

  const STANDALONE = new Set([0x01, 0xD0, 0xD1, 0xD2, 0xD3, 0xD4, 0xD5, 0xD6, 0xD7]);

  // ---------- 段 ----------
  function parseSegments(input) {
    const b = toU8(input);
    const segs = [];
    const errors = [];
    if (!isJPEG(b)) return { ok: false, error: 'not JPEG', segs, errors, eoi: -1, trailer: null };
    let pos = 2;
    let eoi = -1;
    let scanStart = -1;
    while (pos < b.length) {
      if (b[pos] !== 0xFF) {
        errors.push({ offset: pos, message: '段边界缺少 0xFF' });
        const next = findFF(b, pos + 1);
        if (next < 0) break;
        pos = next;
        continue;
      }
      const segStart = pos;              // 填充 FF 之前的位置
      while (pos < b.length && b[pos] === 0xFF) pos++;
      if (pos >= b.length) break;
      const marker = b[pos++];
      if (marker === 0xD9) { eoi = pos; break; }
      if (marker === 0xD8) { errors.push({ offset: segStart, message: '意外的 SOI' }); continue; }
      if (STANDALONE.has(marker)) {
        segs.push({ marker, offset: segStart, length: 0, dataStart: pos, dataEnd: pos, data: new Uint8Array(0) });
        continue;
      }
      if (pos + 2 > b.length) { errors.push({ offset: segStart, message: '长度字段越界' }); break; }
      const length = be16(b, pos);
      const dataStart = pos + 2;
      const dataEnd = pos + length;
      if (length < 2 || dataEnd > b.length) {
        errors.push({ offset: segStart, message: '段长度越界（可能被截断或长度被改）', declared: length, actual: b.length - dataStart });
        break;
      }
      segs.push({ marker, offset: segStart, length, dataStart, dataEnd, data: b.subarray(dataStart, dataEnd) });
      if (marker === 0xDA) {
        scanStart = dataEnd;
        const e = findFFD9(b, dataEnd);
        if (e >= 0) { eoi = e + 2; }
        break;
      }
      pos = dataEnd;
    }
    if (eoi < 0) {
      // 没找到 EOI，再全文件搜一次
      const e = findFFD9(b, scanStart >= 0 ? scanStart : 2);
      if (e >= 0) eoi = e + 2;
    }
    return {
      ok: true, segs, errors, scanStart, eoi,
      trailer: eoi >= 0 && eoi < b.length ? b.subarray(eoi) : null
    };
  }

  function findFF(b, from) {
    for (let i = from; i + 1 < b.length; i++) if (b[i] === 0xFF) return i;
    return -1;
  }
  function findFFD9(b, from) {
    for (let i = from; i + 1 < b.length; i++) if (b[i] === 0xFF && b[i + 1] === 0xD9) return i;
    return -1;
  }

  function markerName(m) {
    const m2 = {
      0xC0: 'SOF0', 0xC1: 'SOF1', 0xC2: 'SOF2', 0xC3: 'SOF3', 0xC4: 'DHT', 0xC8: 'JPG',
      0xDA: 'SOS', 0xDB: 'DQT', 0xDD: 'DRI', 0xE0: 'APP0', 0xE1: 'APP1', 0xE2: 'APP2',
      0xE3: 'APP3', 0xE4: 'APP4', 0xE5: 'APP5', 0xE6: 'APP6', 0xE7: 'APP7', 0xE8: 'APP8',
      0xE9: 'APP9', 0xEA: 'APP10', 0xEB: 'APP11', 0xEC: 'APP12', 0xED: 'APP13', 0xEE: 'APP14',
      0xEF: 'APP15', 0xFE: 'COM', 0xD9: 'EOI', 0xD8: 'SOI'
    };
    return m2[m] || ('0x' + hex(m));
  }

  function sofInfo(segOrBytes, base) {
    const d = segOrBytes;
    if (!d || d.length < 8) return null;
    return { precision: d[0], height: be16(d, 1), width: be16(d, 3), components: d[5] };
  }

  // ---------- EXIF ----------
  const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8, 13: 4 };

  const TAG_NAMES = {
    0x0100: 'ImageWidth', 0x0101: 'ImageHeight', 0x010E: 'ImageDescription', 0x010F: 'Make',
    0x0110: 'Model', 0x0112: 'Orientation', 0x011A: 'XResolution', 0x011B: 'YResolution',
    0x0128: 'ResolutionUnit', 0x0131: 'Software', 0x0132: 'DateTime', 0x013B: 'Artist',
    0x8298: 'Copyright', 0x8769: 'ExifIFD', 0x8825: 'GPSIFD', 0x9C9B: 'XPTitle',
    0x9C9C: 'XPComment', 0x9C9D: 'XPAuthor', 0x9C9E: 'XPKeywords', 0x9C9F: 'XPSubject',
    0x9286: 'UserComment', 0xA005: 'InteropIFD',
    0x0201: 'JPEGInterchangeFormat', 0x0202: 'JPEGInterchangeFormatLength',
    0x9003: 'DateTimeOriginal', 0x9004: 'DateTimeDigitized', 0x9290: 'SubSecTime',
    0x829A: 'ExposureTime', 0x829D: 'FNumber', 0x8827: 'ISOSpeedRatings',
    0x920A: 'FocalLength', 0xA002: 'PixelXDimension', 0xA003: 'PixelYDimension',
    0xA430: 'CameraOwnerName', 0xA431: 'BodySerialNumber', 0xA434: 'LensModel'
  };

  function parseEXIF(input, base) {
    const b = toU8(input);
    const off = base || 0;
    if (off + 8 > b.length) return { error: 'too short' };
    const order = String.fromCharCode(b[off], b[off + 1]);
    const little = order === 'II';
    if (!little && order !== 'MM') return { error: 'bad byte order' };
    function r16(o) { return little ? (b[o] | (b[o + 1] << 8)) : ((b[o] << 8) | b[o + 1]); }
    function r32(o) { return little ? ((b[o + 3] << 24) | (b[o + 2] << 16) | (b[o + 1] << 8) | b[o]) >>> 0 : ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0; }
    // parseIFD 采用大端读取，这里包一层
    const tiff = b;
    const tags = [];
    const magic = r16(off + 2);
    if (magic !== 42) return { error: 'bad TIFF magic' };
    const ifd0 = r32(off + 4);
    // 用一个适配器：把大小端读法注入
    parseIFDEndian(tiff, off, ifd0, tags, 0, 'IFD0', little);
    return { tags, order: little ? 'II' : 'MM' };
  }

  function parseIFDEndian(b, base, ifdOffset, out, depth, ifdName, little) {
    if (depth > 3) return;
    const o = base + ifdOffset;
    if (o + 2 > b.length) return;
    const r16 = (x) => little ? (b[x] | (b[x + 1] << 8)) : ((b[x] << 8) | b[x + 1]);
    const r32 = (x) => little
      ? ((b[x + 3] << 24) | (b[x + 2] << 16) | (b[x + 1] << 8) | b[x]) >>> 0
      : ((b[x] << 24) | (b[x + 1] << 16) | (b[x + 2] << 8) | b[x + 3]) >>> 0;
    const count = r16(o);
    if (count > 512) return;
    let p = o + 2;
    for (let i = 0; i < count; i++, p += 12) {
      if (p + 12 > b.length) break;
      const tag = r16(p);
      const type = r16(p + 2);
      const n = r32(p + 4);
      const size = (TYPE_SIZE[type] || 1) * n;
      let valOff = p + 8;
      if (size > 4) valOff = base + r32(p + 8);
      if (valOff < 0 || valOff + Math.min(size, 4096) > b.length) continue;
      const name = TAG_NAMES[tag] || ('Tag_0x' + hex(tag, 4));
      let value = null;
      try {
        if (type === 2) {
          const endLimit = Math.min(b.length, valOff + n);
          let end = valOff;
          while (end < endLimit && b[end] !== 0) end++;
          value = utf8(b.subarray(valOff, end)) || ascii(b.subarray(valOff, end), end - valOff);
        } else if (type === 1 || type === 7) {
          const raw = b.subarray(valOff, valOff + n);
          if (tag >= 0x9C9B && tag <= 0x9C9F) value = utf16le(raw);
          else if (tag === 0x9286) {
            const pre = ascii(raw, 8);
            value = /UNICODE/.test(pre) ? utf16le(raw.subarray(8)) : ascii(raw.subarray(8), Math.min(n - 8, 500));
          } else value = ascii(raw, Math.min(n, 500));
        } else if (type === 3) {
          const a = [];
          for (let k = 0; k < Math.min(n, 32); k++) a.push(r16(valOff + k * 2));
          value = a;
        } else if (type === 4 || type === 9) {
          const a = [];
          for (let k = 0; k < Math.min(n, 32); k++) a.push(r32(valOff + k * 4));
          value = a;
        } else if (type === 5 || type === 10) {
          const a = [];
          for (let k = 0; k < Math.min(n, 16); k++) a.push(r32(valOff + k * 8) + '/' + r32(valOff + k * 8 + 4));
          value = a;
        } else value = '[' + type + ' x' + n + ']';
      } catch (e) { value = '(解析失败)'; }
      out.push({ ifd: ifdName, tag, name, type, count: n, value, valueOffset: size > 4 ? valOff : null });
      if (tag === 0x8769 || tag === 0x8825 || tag === 0xA005) {
        parseIFDEndian(b, base, r32(p + 8), out, depth + 1, tag === 0x8769 ? 'ExifIFD' : tag === 0x8825 ? 'GPS' : 'Interop', little);
      }
    }
    const next = r32(p);
    if (next && depth === 0) parseIFDEndian(b, base, next, out, depth + 1, 'IFD1', little);
  }

  function findExifInSegment(seg) {
    const d = seg.data;
    if (d.length >= 6 && d[0] === 0x45 && d[1] === 0x78 && d[2] === 0x69 && d[3] === 0x66 && d[4] === 0 && d[5] === 0) {
      return { base: seg.dataStart + 6, prefix: 'Exif' };
    }
    // APP13 / 其他段里搜 Exif\0\0
    for (let i = 0; i + 6 <= d.length; i++) {
      if (d[i] === 0x45 && d[i + 1] === 0x78 && d[i + 2] === 0x69 && d[i + 3] === 0x66 && d[i + 4] === 0 && d[i + 5] === 0) {
        return { base: seg.dataStart + i + 6, prefix: 'embedded@' + i };
      }
    }
    return null;
  }

  function thumbnailInfo(b, tags, tiffBase) {
    const offTag = tags.find(t => t.tag === 0x0201 && t.ifd === 'IFD1');
    const lenTag = tags.find(t => t.tag === 0x0202 && t.ifd === 'IFD1');
    if (!offTag || !lenTag) return null;
    const off = (Array.isArray(offTag.value) ? offTag.value[0] : parseInt(offTag.value, 10)) >>> 0;
    const len = (Array.isArray(lenTag.value) ? lenTag.value[0] : parseInt(lenTag.value, 10)) >>> 0;
    if (!off || !len) return null;
    const start = tiffBase + off;
    const end = Math.min(b.length, start + len);
    if (start < 0 || start >= b.length) return null;
    const bytes = b.subarray(start, end);
    // 找 SOF
    let sof = null;
    for (let i = start; i + 8 < end; i++) {
      if (b[i] === 0xFF && (b[i + 1] === 0xC0 || b[i + 1] === 0xC1 || b[i + 1] === 0xC2)) {
        sof = { offset: i, marker: b[i + 1], precision: b[i + 4], height: be16(b, i + 5), width: be16(b, i + 7), components: b[i + 9] };
        break;
      }
    }
    return { offset: start, length: len, bytes, sof };
  }

  // ---------- 熵数据自检：数 MCU，揪出多出来的字节 ----------
  // JPEG 没有 CRC，但有个天然不变量：按声明的宽高解码完所有 MCU 后，
  // 扫描数据不该再剩下成百上千字节。宽/高被改小，剩余字节立刻暴涨。
  // 合并自 CRC_CHECK/image-crc.html。
  function buildHuffTable(bits, vals) {
    const mincode = new Int32Array(17), maxcode = new Int32Array(17).fill(-1), valptr = new Int32Array(17);
    let code = 0, k = 0;
    for (let l = 1; l <= 16; l++) {
      valptr[l] = k; mincode[l] = code;
      code += bits[l - 1]; k += bits[l - 1];
      maxcode[l] = bits[l - 1] ? code - 1 : -1;
      code <<= 1;
    }
    return { mincode, maxcode, valptr, vals };
  }

  function huffDecode(br, t) {
    let code = 0;
    for (let l = 1; l <= 16; l++) {
      code = (code << 1) | br.bit();
      if (t.maxcode[l] >= 0 && code <= t.maxcode[l]) {
        const i = t.valptr[l] + code - t.mincode[l];
        return i < t.vals.length ? t.vals[i] : -1;
      }
    }
    return -1;
  }

  function makeBitReader(u8, pos) {
    return {
      u8, pos, buf: 0, cnt: 0, marker: -1,
      bit() {
        if (this.cnt === 0) {
          if (this.pos >= this.u8.length) { this.marker = 0xD9; return 0; }
          const b = this.u8[this.pos];
          if (b === 0xFF) {
            const n = this.pos + 1 < this.u8.length ? this.u8[this.pos + 1] : 0xD9;
            if (n !== 0x00) { this.marker = n; return 0; }   // 真标记，停在 FF 上
            this.pos += 2; this.buf = 0xFF;                  // 字节填充 FF00
          } else { this.pos += 1; this.buf = b; }
          this.cnt = 8;
        }
        this.cnt--;
        return (this.buf >> this.cnt) & 1;
      },
      bits(n) { let v = 0; for (let i = 0; i < n; i++) v = (v << 1) | this.bit(); return v; },
      align() { this.cnt = 0; }
    };
  }

  function decodeBlock(br, dcT, acT) {
    const s = huffDecode(br, dcT);
    if (s < 0 || s > 11) return false;
    br.bits(s);
    let k = 1;
    while (k < 64) {
      const rs = huffDecode(br, acT);
      if (rs < 0) return false;
      const r = rs >> 4, sz = rs & 15;
      if (sz === 0) { if (r === 15) { k += 16; continue; } return true; }  // ZRL / EOB
      k += r;
      if (k > 63) return false;
      br.bits(sz);
      k++;
    }
    return true;
  }

  function parseJPEGScanInfo(u8) {
    let off = 2, sof = null, sos = null, restartInterval = 0;
    const dc = {}, ac = {};
    while (off + 1 < u8.length) {
      if (u8[off] !== 0xFF) break;
      while (off < u8.length && u8[off] === 0xFF) off++;
      if (off >= u8.length) break;
      const m = u8[off++];
      if (m === 0xD9) break;
      if (m === 0xD8 || m === 0x01 || (m >= 0xD0 && m <= 0xD7)) continue;
      if (off + 1 >= u8.length) break;
      const len = (u8[off] << 8) | u8[off + 1];
      const s = off + 2, e = off + len;
      if (len < 2 || e > u8.length) break;

      if (m >= 0xC0 && m <= 0xCF && m !== 0xC4 && m !== 0xC8 && m !== 0xCC) {
        const n = u8[s + 5], comps = [];
        for (let i = 0; i < n; i++) {
          const q = s + 6 + i * 3;
          comps.push({ id: u8[q], h: u8[q + 1] >> 4, v: u8[q + 1] & 15 });
        }
        sof = {
          progressive: m !== 0xC0 && m !== 0xC1,
          w: (u8[s + 3] << 8) | u8[s + 4], h: (u8[s + 1] << 8) | u8[s + 2],
          hOff: s + 1, comps
        };
      } else if (m === 0xC4) {
        let q = s;
        while (q < e) {
          const tc = u8[q] >> 4, th = u8[q] & 15; q++;
          const bits = u8.subarray(q, q + 16); q += 16;
          let total = 0; for (let i = 0; i < 16; i++) total += bits[i];
          const vals = u8.subarray(q, q + total); q += total;
          (tc === 0 ? dc : ac)[th] = buildHuffTable(bits, vals);
        }
      } else if (m === 0xDD) {
        restartInterval = (u8[s] << 8) | u8[s + 1];
      } else if (m === 0xDA) {
        const ns = u8[s], scan = [];
        for (let i = 0; i < ns; i++) {
          const q = s + 1 + i * 2;
          scan.push({ id: u8[q], dc: u8[q + 1] >> 4, ac: u8[q + 1] & 15 });
        }
        sos = { scan, ns, dataStart: e };
        break;
      }
      off = e;
    }
    return {
      ok: !!(sof && sos), sof, sos, dc, ac, restartInterval,
      reason: !sof ? '未找到 SOF' : !sos ? '未找到 SOS' : ''
    };
  }

  function nextMCU(br, blocks, u8, done, restartInterval) {
    if (restartInterval && done > 0 && done % restartInterval === 0) {
      br.align();
      if (!(br.pos + 1 < u8.length && u8[br.pos] === 0xFF &&
            u8[br.pos + 1] >= 0xD0 && u8[br.pos + 1] <= 0xD7)) return false;
      br.pos += 2;
    }
    for (const b of blocks) if (!decodeBlock(br, b.dc, b.ac)) return false;
    return true;
  }

  function analyzeJPEGEntropy(input) {
    const u8 = toU8(input);
    const st = parseJPEGScanInfo(u8);
    if (!st.ok) return { supported: false, reason: st.reason || '结构不完整' };
    const { sof, sos, dc, ac, restartInterval } = st;
    if (sof.progressive) return { supported: false, reason: '渐进式 JPEG（SOF2），跳过' };
    if (!sof.w || !sof.h) return { supported: false, reason: '尺寸字段为 0' };
    if (sos.ns !== sof.comps.length) return { supported: false, reason: '非交错扫描，跳过' };

    const Hmax = Math.max(...sof.comps.map(c => c.h));
    const Vmax = Math.max(...sof.comps.map(c => c.v));
    if (!Hmax || !Vmax) return { supported: false, reason: '采样因子异常' };
    const mcuW = 8 * Hmax, mcuH = 8 * Vmax;
    const mcusX = Math.ceil(sof.w / mcuW), mcusY = Math.ceil(sof.h / mcuH);
    const declared = mcusX * mcusY;

    const blocks = [];
    for (const sc of sos.scan) {
      const c = sof.comps.find(x => x.id === sc.id);
      const dt = dc[sc.dc], at = ac[sc.ac];
      if (!c || !dt || !at) return { supported: false, reason: '缺少 Huffman 表或组件定义' };
      for (let i = 0; i < c.h * c.v; i++) blocks.push({ dc: dt, ac: at });
    }

    const base = { supported: true, declaredW: sof.w, declaredH: sof.h, hOff: sof.hOff, mcusX, mcusY, declared };
    const br = makeBitReader(u8, sos.dataStart);
    let done = 0;
    while (done < declared) {
      if (br.marker >= 0) return Object.assign({}, base, { ok: false, reason: '扫描数据在声明尺寸前就结束了（文件被截断）' });
      if (!nextMCU(br, blocks, u8, done, restartInterval)) {
        return Object.assign({}, base, { ok: false, reason: '按声明尺寸解码到一半就失败（宽或高可能被改过）' });
      }
      done++;
    }

    br.align();
    let p = br.pos;
    while (p + 1 < u8.length) {
      if (u8[p] === 0xFF && u8[p + 1] !== 0x00 && !(u8[p + 1] >= 0xD0 && u8[p + 1] <= 0xD7)) break;
      p++;
    }
    const leftover = p - br.pos;
    const leftoverBytes = leftover > 0 ? u8.subarray(br.pos, p) : null;

    let extra = 0, extraErr = false;
    while (br.marker < 0 && br.pos < p && extra < 200000) {
      if (!nextMCU(br, blocks, u8, declared + extra, restartInterval)) { extraErr = true; break; }
      extra++;
    }
    const rows = Math.ceil((declared + extra) / mcusX);
    return Object.assign({}, base, {
      ok: true, leftover, leftoverBytes, extra, extraErr,
      suggestedH: Math.min(65535, rows * mcuH)
    });
  }

  // 数重启标记：DRI 决定每 125/113… 个 MCU 插一个 FF D0-D7。
  // 标记数 + 1 = 间隔数，乘以 DRI 就是完整 MCU 总数（末段可能不满，先按上界）。
  function countRestartMarkers(u8, start, end) {
    let n = 0;
    const e = Math.min(end, u8.length - 1);
    for (let i = Math.max(0, start); i < e; i++) {
      if (u8[i] === 0xFF && u8[i + 1] >= 0xD0 && u8[i + 1] <= 0xD7) { n++; i++; }
    }
    return n;
  }

  // 从 MCU 总数反推尺寸：total = mcusX * mcusY，像素 = mcusX*mcuW × mcusY*mcuH。
  // 需要 DRI + 重启标记；没有就用熵数据解码出的 MCU 总数兜底。
  function recoverJPEGDims(input, opts) {
    const b = toU8(input);
    const st = parseJPEGScanInfo(b);
    if (!st.ok) return { error: st.reason || '结构不完整' };
    const { sof, sos } = st;
    if (sof.progressive) return { error: '渐进式 JPEG（SOF2）暂不支持按 MCU 反推' };
    const Hmax = Math.max(...sof.comps.map(c => c.h));
    const Vmax = Math.max(...sof.comps.map(c => c.v));
    const mcuW = 8 * Hmax, mcuH = 8 * Vmax;
    if (!mcuW || !mcuH) return { error: '采样因子异常' };
    const declaredW = sof.w, declaredH = sof.h;
    const declaredTotal = Math.ceil(declaredW / mcuW) * Math.ceil(declaredH / mcuH);
    const dri = st.restartInterval || 0;
    const p = parseSegments(b);
    const scanStart = sos.dataStart;
    const scanEnd = p.eoi > 0 ? p.eoi : b.length;
    const markers = dri > 0 ? countRestartMarkers(b, scanStart, scanEnd) : 0;
    let total = 0, source = '';
    if (dri > 0 && markers > 0) {
      total = (markers + 1) * dri;
      source = `DRI ${dri} × ${markers + 1} 个重启间隔`;
    } else {
      const ent = analyzeJPEGEntropy(b);
      if (ent.ok) { total = ent.declared + ent.extra; source = '熵数据 MCU 计数'; }
    }
    if (!(total > 0)) return { error: '无法确定 MCU 总数（没有 DRI/重启标记，熵数据也不完整）' };

    const o = opts || {};
    const cands = [];
    const seen = new Set();
    const declaredMx = Math.ceil(declaredW / mcuW);
    const declaredMy = Math.ceil(declaredH / mcuH);
    const push = c => {
      const k = c.width + ',' + c.height;
      if (seen.has(k) || c.width < 1 || c.height < 1 || c.width > 65535 || c.height > 65535) return;
      seen.add(k);
      cands.push(c);
    };
    for (let mx = 1; mx <= total; mx++) {
      if (total % mx) continue;
      const my = total / mx;
      // 声明宽度可能落在最后一个 MCU 内（如 900 = 113×8 - 4），保留原宽度更准
      const w = mx === declaredMx ? declaredW : mx * mcuW;
      const h = my === declaredMy ? declaredH : my * mcuH;
      if (w < 1 || h < 1 || w > 65535 || h > 65535) continue;
      push({ width: w, height: h, mcusX: mx, mcusY: my, how: `${source} = ${mx} × ${my} MCU` });
      // 末行是部分 MCU 时，真实高度可能落在 (my-1)*mcuH+1 .. my*mcuH
      const minH = (my - 1) * mcuH + 1;
      if (minH < h) push({ width: w, height: minH, mcusX: mx, mcusY: my, how: `${source} = ${mx} × ${my} MCU（末行最小高度）` });
      if (declaredH > minH && declaredH < h) push({ width: w, height: declaredH, mcusX: mx, mcusY: my, how: `${source} = ${mx} × ${my} MCU（保留声明高度）` });
    }
    const rank = c => c.width === declaredW ? 0 : c.width > declaredW ? 1 : 2;
    cands.sort((a, b) => {
      const ra = rank(a), rb = rank(b);
      if (ra !== rb) return ra - rb;
      if (ra === 2) return Math.abs(a.width - declaredW) - Math.abs(b.width - declaredW) || b.height - a.height;
      return a.width - b.width || b.height - a.height;
    });
    return {
      candidates: cands.slice(0, o.limit || 12),
      total, dri, markers, mcuW, mcuH, source,
      declared: { width: declaredW, height: declaredH, total: declaredTotal }
    };
  }

  // 改 SOF 的宽高（没有 CRC 要重算，直接写字段）
  function editJPEGDims(input, width, height) {
    const b = toU8(input);
    const p = parseSegments(b);
    const sof = p.segs.find(s => s.marker >= 0xC0 && s.marker <= 0xCF &&
      s.marker !== 0xC4 && s.marker !== 0xC8 && s.marker !== 0xCC && s.data.length >= 5);
    if (!sof) return { error: '未找到 SOF 段' };
    const w = Math.max(1, Math.round(Number(width)));
    const h = Math.max(1, Math.round(Number(height)));
    if (!(w <= 65535 && h <= 65535)) return { error: '宽高必须在 1..65535' };
    const out = new Uint8Array(b);
    out[sof.dataStart + 1] = (h >> 8) & 255;
    out[sof.dataStart + 2] = h & 255;
    out[sof.dataStart + 3] = (w >> 8) & 255;
    out[sof.dataStart + 4] = w & 255;
    return { bytes: out, sof: { width: w, height: h, offset: sof.offset } };
  }

  // ---------- 审计 ----------
  function auditJPEG(input, name, opts) {
    const b = toU8(input);
    const findings = [];
    const artifacts = [];
    const p = parseSegments(b);
    if (!p.ok) return { findings: [finding('L0', 'format', '不是 JPEG', { detail: p.error })], artifacts, image: null, parsed: p };

    for (const e of p.errors) {
      findings.push(finding('L1', 'structure', 'JPEG 结构异常：' + e.message, {
        confidence: 0.9, offset: e.offset, declared: e.declared, actual: e.actual
      }));
    }
    if (p.eoi < 0) {
      findings.push(finding('L1', 'structure', '未找到 EOI（文件可能被截断）', {
        confidence: 0.9, offset: p.segs.length ? p.segs[p.segs.length - 1].offset : 0,
        detail: 'JPEG 应以 FF D9 结束；没有 EOI 说明文件被截断，或尾部数据被误删。'
      }));
    }

    let jfif = null;
    const exifBlocks = [];
    const comments = [];
    const appSegs = [];

    for (const s of p.segs) {
      const m = s.marker;
      if (m >= 0xE0 && m <= 0xEF) appSegs.push(s);
      if (m === 0xE0) {
        const d = s.data;
        if (d.length >= 12 && d[0] === 0x4A && d[1] === 0x46 && d[2] === 0x49 && d[3] === 0x46 && d[4] === 0) {
          jfif = { version: d[5] + '.' + d[6], units: d[7], xd: be16(d, 8), yd: be16(d, 10) };
        }
      }
      if (m === 0xFE) {
        const text = utf8(s.data) || ascii(s.data, Math.min(s.data.length, 500));
        comments.push({ offset: s.offset, text });
      }
    }

    // EXIF 块（可能多块）
    for (const s of p.segs) {
      if (s.marker !== 0xE1 && s.marker !== 0xED && s.marker !== 0xEE && s.marker !== 0xE2) continue;
      const found = findExifInSegment(s);
      if (!found) continue;
      const ex = parseEXIF(b, found.base);
      if (ex.error) continue;
      exifBlocks.push({ seg: s, base: found.base, tags: ex.tags, order: ex.order, prefix: found.prefix });
    }

    if (exifBlocks.length > 1) {
      findings.push(finding('L3', 'multi_exif', `发现 ${exifBlocks.length} 块 EXIF`, {
        confidence: 0.95,
        detail: exifBlocks.map((e, i) => `#${i + 1} @ 0x${hex(e.seg.offset)}（${markerName(e.seg.marker)}，${e.tags.length} 个标签）`).join('；'),
        recipe: '逐块解析，别只信第一块'
      }));
    }

    for (const ex of exifBlocks) {
      const pick = ex.tags.filter(t => t.name && !/^(Tag_0x|ExifIFD|GPSIFD|InteropIFD|JPEGInterchangeFormat)/.test(t.name));
      const interesting = pick.filter(t => {
        const v = Array.isArray(t.value) ? t.value.join(',') : String(t.value || '');
        return v.length > 0;
      });
      if (interesting.length) {
        const lines = interesting.slice(0, 40).map(t => `${t.ifd}/${t.name}: ${Array.isArray(t.value) ? t.value.join(',') : t.value}`);
        findings.push(finding('L3', 'exif', `EXIF 元数据（${markerName(ex.seg.marker)}）`, {
          confidence: 0.7, offset: ex.seg.offset,
          declared: `${ex.tags.length} 个标签`, actual: `${interesting.length} 个有值`,
          detail: lines.join('\n'),
          preview: lines.slice(0, 12).join('\n'),
          recipe: '逐标签查看；XP* 为 UTF-16LE 字符串，常被用作口令'
        }));
      }
      // XP 字段单独高亮
      for (const t of ex.tags) {
        if (t.tag < 0x9C9B || t.tag > 0x9C9F) continue;
        const v = String(t.value || '');
        if (!v) continue;
        findings.push(finding('L3', 'xp_tag', `${t.name} = “${v}”`, {
          confidence: 0.98, offset: t.valueOffset || ex.seg.offset,
          declared: `${t.count} 字节 UTF-16LE`, actual: v,
          detail: 'Windows XP 标签常被出题人当备用信道/口令。',
          preview: v,
          recipe: `读取 EXIF ${t.name} (0x${hex(t.tag, 4)})`
        }));
      }
      // 缩略图
      const th = thumbnailInfo(b, ex.tags, ex.base);
      if (th) {
        const sof = th.sof;
        const detail = sof ? `SOF${sof.marker === 0xC2 ? '2' : '0'} 声明 ${sof.width}x${sof.height}，数据 ${th.length} 字节（${(th.length / Math.max(1, sof.width * sof.height)).toFixed(2)} B/px）` : `数据 ${th.length} 字节，未找到 SOF`;
        let conf = 0.45;
        if (sof && (th.length / Math.max(1, sof.width * sof.height) > 2.5 || th.length / Math.max(1, sof.width * sof.height) < 0.02)) conf = 0.8;
        findings.push(finding('L3', 'thumbnail', 'IFD1 内嵌缩略图', {
          confidence: conf, offset: th.offset,
          declared: th.length + ' 字节', actual: sof ? `${sof.width}x${sof.height}` : '未知',
          detail: detail + '。若缩略图 SOF 高度被改小，数据里会残留被裁掉的画面。',
          preview: sof ? `SOF @0x${hex(sof.offset)} ${sof.width}x${sof.height}` : '',
          recipe: '按 SOF 尺寸检查数据量；必要时改回高度重解码'
        }));
        artifacts.push(artifact('jpeg-thumbnail.jpg', th.bytes, 'IFD1 缩略图', 'exif'));
        const inner = MDZ.parseSegments(th.bytes);
        const innerTrailer = inner.trailer;
        if (inner.ok && innerTrailer && innerTrailer.length > 8) {
          findings.push(finding('L1', 'thumbnail_trailer', '缩略图 JPEG 的 EOI 之后还有数据', {
            confidence: 0.85, offset: th.offset, declared: '缩略图应止于 EOI', actual: `${innerTrailer.length} 字节`,
            preview: ascii(innerTrailer, 96),
            recipe: '从缩略图 EOI 后切出'
          }));
          artifacts.push(artifact('jpeg-thumbnail-trailer.bin', innerTrailer, '缩略图 EOI 后数据'));
        }
      }
    }

    // 注释
    for (const c of comments) {
      findings.push(finding('L3', 'comment', 'JPEG COM 注释段', {
        confidence: /flag|ctf|pass|key/i.test(c.text) ? 0.9 : 0.5,
        offset: c.offset, actual: c.text.slice(0, 200), preview: c.text.slice(0, 300),
        recipe: '读取 COM 段'
      }));
    }

    // 其他 APP 段里的可打印串
    for (const s of appSegs) {
      // APP1 里若是 EXIF 已在上面解析；XMP 等其它 APP1 仍要扫字符串
      if (s.marker === 0xE1 && findExifInSegment(s)) continue;
      const strs = strings(s.data, 8);
      const hits = strs.filter(x => /flag|ctf|pass|key|secret|hint/i.test(x));
      if (hits.length) {
        findings.push(finding('L3', 'app_string', `${markerName(s.marker)} 段里的可疑字符串`, {
          confidence: 0.8, offset: s.offset, actual: hits.slice(0, 6).join(' | '),
          preview: hits.slice(0, 10).join('\n'), recipe: `解析 ${markerName(s.marker)}`
        }));
      }
    }

    // 尾部
    // 熵数据尾部：按声明尺寸解完 MCU 后、EOI 之前剩下的字节（常见夹带点）
    if (b.length <= 8 * 1024 * 1024 && p.segs.some(x => x.marker === 0xDA)) {
      try {
        const ent = analyzeJPEGEntropy(b);
        if (ent.ok && ent.leftover > 8 && ent.leftoverBytes) {
          findings.push(finding('L2', 'jpeg_entropy_tail', `JPEG 熵数据末尾有 ${ent.leftover} 字节未被 MCU 使用`, {
            confidence: 0.85, offset: null,
            declared: `按声明尺寸解完 ${ent.declared} 个 MCU`,
            actual: `EOI 之前还剩 ${ent.leftover} 字节`,
            detail: 'MCU 解完之后、EOI 之前还有一段数据：可能只是填充，也可能是夹带。',
            preview: ascii(ent.leftoverBytes, 160),
            recipe: '从最后一个 MCU 结束处切到 EOI 之前',
            payload: { name: 'jpeg-entropy-tail.bin', bytes: ent.leftoverBytes.slice(0) }
          }));
          artifacts.push(artifact('jpeg-entropy-tail.bin', ent.leftoverBytes, 'JPEG 熵数据尾部'));
        }
      } catch (e) { /* 自检失败不影响其它发现 */ }
    }
    if (p.trailer && p.trailer.length) {
      const tr = p.trailer;
      const kinds = [];
      if (tr[0] === 0x50 && tr[1] === 0x4B) kinds.push('ZIP');
      if (tr[0] === 0x89 && tr[1] === 0x50) kinds.push('PNG');
      if (tr[0] === 0xFF && tr[1] === 0xD8) kinds.push('JPEG');
      if (tr[0] === 0x1F && tr[1] === 0x8B) kinds.push('GZIP');
      findings.push(finding('L1', 'trailer', 'JPEG EOI 之后还有数据', {
        confidence: 0.98, offset: p.eoi,
        declared: 'EOI 应结束文件', actual: `${tr.length} 字节`,
        detail: kinds.length ? `尾部以 ${kinds.join('/')} 签名开头` : '无已知签名，已提取',
        preview: ascii(tr, 120),
        recipe: `从 0x${hex(p.eoi)} 切开`,
        payload: { name: 'jpeg-trailer.bin', bytes: tr.slice(0) }
      }));
      artifacts.push(artifact('jpeg-trailer.bin', tr, 'EOI 之后的数据'));
    }

    // SOF 尺寸
    let dims = null;
    for (const s of p.segs) {
      if (s.marker >= 0xC0 && s.marker <= 0xC3) {
        const d = s.data;
        if (d.length >= 6) dims = { width: be16(d, 3), height: be16(d, 1), components: d[5], marker: s.marker };
        break;
      }
    }

    if (jfif) {
      // JFIF 的 density 也顺手报告
      findings.push(finding('L3', 'jfif', 'JFIF 头', {
        confidence: 0.3, offset: 2, actual: `v${jfif.version} ${jfif.xd}x${jfif.yd}`, detail: '密度/单位字段一般不是藏点，记录备查。'
      }));
    }

    const lossy = finding('L4', 'lossy', '有损容器：不要直接扫 LSB', {
      confidence: 0.5,
      detail: 'JPEG 的 DCT 量化会揉碎最低位。优先检查尾部附加、EXIF、APPn、缩略图；像素隐写走 steghide / outguess / F5。',
      recipe: 'steghide extract -sf file.jpg；或 stegseek 爆破'
    });
    findings.push(lossy);

    return { findings, artifacts, image: null, parsed: p, dims, exif: exifBlocks.map(e => e.tags), jfif };
  }

  Object.assign(MDZ, {
    isJPEG, parseSegments, parseEXIF, parseIFD: parseIFDEndian, auditJPEG,
    jpegMarkerName: markerName, jpegSofInfo: sofInfo, be16, be32,
    analyzeJPEGEntropy, editJPEGDims, recoverJPEGDims
  });
})(typeof globalThis !== 'undefined' ? globalThis : this);
