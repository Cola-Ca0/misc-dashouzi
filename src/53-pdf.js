/* misc大手子 — 53 PDF 结构审计
 * 不做完整渲染，只做 Misc 题真正用的部分：
 *   对象表 / 增量更新（多个 %%EOF）/ 流过滤器（Flate·ASCIIHex·ASCII85·DCT）
 *   内嵌文件（/EmbeddedFile）/ JavaScript（/JS）/ XObject 图片（DCT 直接当 JPEG，Flate 拼回 PNG）
 */
(function (root) {
  'use strict';
  const MDZ = root.MDZ = root.MDZ || {};
  const { toU8, ascii, finding, artifact } = MDZ;

  function isPDF(input) {
    const b = toU8(input);
    return b.length > 8 && ascii(b, 5) === '%PDF-';
  }

  function pdfLiteral(s) {
    return s.replace(/\\([nrtbf()\\]|[0-7]{1,3})/g, (m, g) => {
      switch (g) {
        case 'n': return '\n';
        case 'r': return '\r';
        case 't': return '\t';
        case 'b': return '\b';
        case 'f': return '\f';
        case '(': return '(';
        case ')': return ')';
        case '\\': return '\\';
        default: return String.fromCharCode(parseInt(g, 8));
      }
    });
  }

  function hexString(h) {
    let s = '';
    for (let i = 0; i + 1 < h.length; i += 2) s += String.fromCharCode(parseInt(h.substr(i, 2), 16));
    return s;
  }

  function parseFilters(dict) {
    const m = /\/Filter\s*(\[[^\]]*\]|\/[A-Za-z0-9]+)/.exec(dict);
    if (!m) return [];
    return m[1].replace(/[[\]]/g, ' ').split(/[\s/]+/).filter(Boolean);
  }

  function decodeStream(data, filters) {
    let cur = data;
    for (const f of filters) {
      const name = String(f).replace(/^\/+/, '');
      if (name === 'FlateDecode' || name === 'Fl') {
        const z = MDZ.inflateZlib(cur, 0);
        if (!z.out || !z.out.length) return { error: 'FlateDecode 解压失败' };
        cur = z.out;
      } else if (name === 'ASCIIHexDecode' || name === 'AHx') {
        const h = ascii(cur, cur.length).replace(/>.*$/, '').replace(/[^0-9a-fA-F]/g, '');
        if (h.length < 2) return { error: 'ASCIIHex 为空' };
        cur = Uint8Array.from(hexString(h), c => c.charCodeAt(0));
      } else if (name === 'ASCII85Decode' || name === 'A85') {
        // 只截到第一个 ~> 为止。不要用 /^[\s\S]*?<~?/ 去剥 '<~' 前缀：
        // ASCII85 字母表本身就含 '<'（码位 60），那样会把第一个 '<' 之前的整段数据删掉。
        let s = ascii(cur, cur.length);
        const cut = s.indexOf('~>');
        if (cut >= 0) s = s.slice(0, cut);
        const r = MDZ.a85decode(s);
        if (!r || !r.length) return { error: 'ASCII85 解码失败' };
        cur = r;
      } else if (name === 'DCTDecode' || name === 'DCT') {
        return { data: cur, jpeg: true };
      } else {
        return { error: '未支持的过滤器 ' + name };
      }
    }
    return { data: cur };
  }

  // 只做 stored（不压缩）的 zlib 封装：浏览器照样能解，省掉一个压缩器
  function zlibStored(data) {
    const nBlocks = Math.max(1, Math.ceil(data.length / 65535));
    const out = new Uint8Array(2 + nBlocks * 5 + data.length + 4);
    let o = 0;
    out[o++] = 0x78; out[o++] = 0x01;
    let p = 0;
    if (!data.length) {
      out[o++] = 1; out[o++] = 0; out[o++] = 0; out[o++] = 0xFF; out[o++] = 0xFF;
    }
    while (p < data.length) {
      const n = Math.min(65535, data.length - p);
      const last = p + n >= data.length ? 1 : 0;
      out[o++] = last;
      out[o++] = n & 255; out[o++] = (n >> 8) & 255;
      out[o++] = (~n) & 255; out[o++] = ((~n) >> 8) & 255;
      out.set(data.subarray(p, p + n), o);
      o += n;
      p += n;
    }
    const a = MDZ.adler32(data) >>> 0;
    out[o++] = (a >>> 24) & 255; out[o++] = (a >>> 16) & 255; out[o++] = (a >>> 8) & 255; out[o++] = a & 255;
    return out.subarray(0, o);
  }

  // PNG 系 predictor（10..15）：每行前面有一个 filter 类型字节
  function unfilterPNG(data, rowLen, bpp, h) {
    if (data.length < (rowLen + 1) * h) return null;
    const out = new Uint8Array(rowLen * h);
    let prev = new Uint8Array(rowLen);
    for (let y = 0; y < h; y++) {
      const ft = data[y * (rowLen + 1)];
      const row = data.subarray(y * (rowLen + 1) + 1, y * (rowLen + 1) + 1 + rowLen);
      const cur = new Uint8Array(rowLen);
      for (let i = 0; i < rowLen; i++) {
        const a = i >= bpp ? cur[i - bpp] : 0;
        const b = prev[i];
        const c = i >= bpp ? prev[i - bpp] : 0;
        let v = row[i];
        if (ft === 1) v += a;
        else if (ft === 2) v += b;
        else if (ft === 3) v += (a + b) >> 1;
        else if (ft === 4) {
          const pp = a + b - c;
          const pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c);
          v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
        }
        cur[i] = v & 255;
      }
      out.set(cur, y * rowLen);
      prev = cur;
    }
    return out;
  }

  // 8-bit 灰度/RGB 的原始像素拼成 PNG（不做 predictor）
  function rawToPNG(w, h, comps, data) {
    if (!(w > 0 && h > 0) || w * h > 40 * 1000000) return null;
    const colorType = comps === 1 ? 0 : comps === 3 ? 2 : 0;
    if (comps !== 1 && comps !== 3) return null;
    const rowBytes = w * comps;
    if (data.length < rowBytes * h) return null;
    const raw = new Uint8Array((rowBytes + 1) * h);
    for (let y = 0; y < h; y++) {
      raw[y * (rowBytes + 1)] = 0;
      raw.set(data.subarray(y * rowBytes, y * rowBytes + rowBytes), y * (rowBytes + 1) + 1);
    }
    const zd = zlibStored(raw);
    if (!zd) return null;
    const chunk = (type, payload) => {
      const out = new Uint8Array(12 + payload.length);
      const dv = new DataView(out.buffer);
      dv.setUint32(0, payload.length);
      for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
      out.set(payload, 8);
      const crc = MDZ.crc32(out.subarray(4, 8 + payload.length));
      dv.setUint32(8 + payload.length, crc >>> 0);
      return out;
    };
    const ihdr = new Uint8Array(13);
    const dv = new DataView(ihdr.buffer);
    dv.setUint32(0, w); dv.setUint32(4, h);
    ihdr[8] = 8; ihdr[9] = colorType; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
    const parts = [new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), chunk('IHDR', ihdr), chunk('IDAT', zd), chunk('IEND', new Uint8Array(0))];
    let total = 0;
    for (const p of parts) total += p.length;
    const out = new Uint8Array(total);
    let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
  }

  function auditPDF(input, name) {
    const b = toU8(input);
    const findings = [], artifacts = [];
    const cap = Math.min(b.length, 64 * 1024 * 1024);
    const s = ascii(b, cap);

    const eofs = (s.match(/%%EOF/g) || []).length;
    if (eofs > 1) {
      findings.push(finding('L1', 'pdf', `PDF 有 ${eofs} 个 %%EOF：${eofs - 1} 次增量更新`, {
        confidence: 0.9, offset: 0,
        declared: `${eofs} 段`, actual: '后一段覆盖前一段',
        detail: '增量更新会把旧对象留在文件里：用 qpdf --qdf 或直接按 obj 号取最后一份，能翻出被"删除"的内容。',
        recipe: 'qpdf --qdf --object-streams=disable in.pdf out.pdf'
      }));
    }

    const re = /(\d+)\s+(\d+)\s+obj\b/g;
    // 增量更新会把旧对象留在文件里，PDF 语义是「后面的覆盖前面的」；
    // 以前按对象号只留第一份，正好和提示里说的「取最后一份」相反。
    const lastAt = new Map();
    {
      const rr = /(\d+)\s+(\d+)\s+obj\b/g;
      let mm, n = 0;
      while ((mm = rr.exec(s)) && n++ < 8192) lastAt.set(mm[1], mm.index);
    }
    let m, objects = 0, embedded = 0, images = 0, jsHits = 0;
    while ((m = re.exec(s)) && objects < 4096) {
      objects++;
      const objNum = m[1];
      if (lastAt.get(objNum) !== m.index) continue;
      const start = m.index + m[0].length;
      let end = s.indexOf('endobj', start);
      if (end < 0) end = Math.min(s.length, start + 2 * 1024 * 1024);
      const body = s.slice(start, end);
      const streamAt = body.indexOf('stream');
      const dict = streamAt >= 0 ? body.slice(0, streamAt) : body;

      // JavaScript / 自动动作
      if (/\/JS\b|\/JavaScript\b/.test(dict) && jsHits < 5) {
        jsHits++;
        const jsIdx = body.search(/\/JS\s*(\(|<)/);
        let snippet = '';
        if (jsIdx >= 0) {
          const after = body.slice(jsIdx, jsIdx + 400);
          const lit = /\/JS\s*\(([\s\S]{0,300}?)\)\s*[\/>]/.exec(after);
          const hx = /\/JS\s*<([0-9a-fA-F\s]+)>/.exec(after);
          if (lit) snippet = pdfLiteral(lit[1]);
          else if (hx) snippet = hexString(hx[1].replace(/\s+/g, ''));
        }
        findings.push(finding('L3', 'pdf_js', `PDF 里有 JavaScript（对象 ${objNum}）`, {
          confidence: 0.85, offset: m.index,
          declared: 'PDF 内嵌 JS', actual: snippet.slice(0, 160) || '（见载荷）',
          preview: snippet.slice(0, 160),
          detail: 'PDF 的 /JS 可以被自动执行；misc 题常把提示或口令放在这里。',
          recipe: 'qpdf --qdf 后搜 /JS'
        }));
      }

      if (streamAt < 0) continue;
      // 取流数据：优先 /Length，其次找 endstream
      let dataStart = body.indexOf('stream', streamAt) + 6;
      if (body[dataStart] === '\r') dataStart++;
      if (body[dataStart] === '\n') dataStart++;
      const lenM = /\/Length\s+(\d+)/.exec(dict);
      let dataEnd = -1;
      if (lenM) {
        const n = parseInt(lenM[1], 10);
        const cand = dataStart + n;
        if (cand <= body.length && /^\s*endstream/.test(body.slice(cand, cand + 20))) dataEnd = cand;
      }
      if (dataEnd < 0) dataEnd = body.indexOf('endstream', dataStart);
      if (dataEnd < 0) continue;
      const raw = b.subarray(start + dataStart, start + dataEnd);
      if (!raw.length) continue;

      const filters = parseFilters(dict);
      const isImage = /\/Subtype\s*\/Image/.test(dict);
      const isEmbedded = /\/Type\s*\/EmbeddedFile/.test(dict) || /\/EmbeddedFiles/.test(dict);

      if (isEmbedded) {
        embedded++;
        const dec = decodeStream(raw, filters);
        if (dec.data && dec.data.length) {
          artifacts.push(artifact(`pdf-embedded-${objNum}.bin`, dec.data, 'PDF 内嵌文件'));
          findings.push(finding('L3', 'pdf_embedded', `PDF 内嵌文件（对象 ${objNum}）`, {
            confidence: 0.95, offset: m.index,
            declared: `${raw.length} 字节`, actual: `${dec.data.length} 字节`,
            preview: ascii(dec.data, 200),
            detail: 'PDF 的 /EmbeddedFile 是完整附件，已作为产物取出并会继续递归分析。',
            recipe: 'qpdf --qdf 或 pdfdetach -saveall'
          }));
        }
      } else if (isImage) {
        images++;
        const dec = decodeStream(raw, filters);
        if (dec.jpeg) {
          artifacts.push(artifact(`pdf-image-${objNum}.jpg`, raw, 'PDF 里的 JPEG'));
        } else if (dec.data) {
          const wm = /\/Width\s+(\d+)/.exec(dict);
          const hm = /\/Height\s+(\d+)/.exec(dict);
          const bpc = /\/BitsPerComponent\s+(\d+)/.exec(dict);
          const predictor = /\/Predictor\s+(\d+)/.exec(dict);
          const cs = /\/ColorSpace\s*(\/[A-Za-z0-9]+|\[[^\]]*\])/.exec(dict);
          const csName = cs ? cs[1] : '';
          const comps = /DeviceRGB|CalRGB/.test(csName) ? 3 : (/DeviceGray|CalGray/.test(csName) ? 1 : 0);
          const wN = wm ? parseInt(wm[1], 10) : 0, hN = hm ? parseInt(hm[1], 10) : 0;
          const pred = predictor ? parseInt(predictor[1], 10) : 1;
          let px = dec.data;
          if (pred >= 10 && wN > 0 && hN > 0) {
            const un = unfilterPNG(px, wN * comps, comps, hN);
            if (un) px = un;
          }
          if (wm && hm && (!bpc || bpc[1] === '8') && comps && (pred === 1 || pred >= 10)) {
            const png = rawToPNG(wN, hN, comps, px);
            if (png) artifacts.push(artifact(`pdf-image-${objNum}.png`, png, 'PDF 里的位图（已拼成 PNG）'));
            else artifacts.push(artifact(`pdf-image-${objNum}.bin`, dec.data, 'PDF 图像裸数据'));
          } else {
            artifacts.push(artifact(`pdf-image-${objNum}.bin`, dec.data, 'PDF 图像流（已解压）'));
          }
        }
      } else if (filters.length) {
        const dec = decodeStream(raw, filters);
        if (dec.data && dec.data.length >= 32) {
          // 内容流/元数据流：只留前 4MB 作为产物，避免爆内存
          artifacts.push(artifact(`pdf-stream-${objNum}.bin`, dec.data.subarray(0, 4 * 1024 * 1024), 'PDF 解码后的流'));
        }
      }
    }

    findings.push(finding('L1', 'pdf', `PDF 结构：${objects} 个对象`, {
      confidence: 0.7, offset: 0,
      declared: `${objects} 个 obj${eofs > 1 ? ` / ${eofs} 段增量` : ''}`,
      actual: `内嵌文件 ${embedded} · 图片 ${images} · JS ${jsHits}`,
      detail: '只做结构级提取：内嵌文件、图片（DCT 原样 / Flate 拼回 PNG）、JS 片段。不渲染页面。',
      recipe: 'qpdf --qdf / pdftotext / pdfimages'
    }));
    return { findings, artifacts, image: null, parsed: { objects, eofs, embedded, images, jsHits } };
  }

  Object.assign(MDZ, { isPDF, auditPDF });
})(typeof globalThis !== 'undefined' ? globalThis : this);
