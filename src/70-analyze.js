/* misc大手子 — 70 分析流水线
 * 身份 → 结构审计 → 载荷提取 → 像素扫描 → 递归 → 报告
 */
(function (root) {
  'use strict';
  const MDZ = root.MDZ = root.MDZ || {};
  const { toU8, hex, ascii, finding, artifact, sha256, detectType, findStreamSignatures, inflateZlib, inflateGzip } = MDZ;

  const LAYER_ORDER = { L0: 0, L1: 1, L2: 2, L3: 3, L4: 4, L5: 5 };

  // 解压结果「以」某个魔数开头（偏移 0）。比 looksLikeContainer 严得多，
  // 专门用来判断一次完整解压值不值得做。
  function startsWithMagic(b) {
    if (!b || b.length < 4) return false;
    const m = (s) => { for (let i = 0; i < s.length; i++) if (b[i] !== s[i]) return false; return true; };
    return m([0x89, 0x50, 0x4E, 0x47]) || m([0xFF, 0xD8, 0xFF]) || m([0x47, 0x49, 0x46, 0x38]) ||
      m([0x50, 0x4B, 0x03, 0x04]) || m([0x37, 0x7A, 0xBC, 0xAF]) || m([0x52, 0x61, 0x72, 0x21]) ||
      m([0x1F, 0x8B]) || m([0xFD, 0x37, 0x7A, 0x58, 0x5A, 0x00]) || m([0x42, 0x5A, 0x68]) ||
      m([0x52, 0x49, 0x46, 0x46]) || m([0x7F, 0x45, 0x4C, 0x46]) || m([0x4D, 0x5A]);
  }

  // 切出来的容器是不是真的：随机数据里 0xFFD8FF 这种 3 字节魔数并不罕见，
  // 假命中会切出一个几 MB 的产物再被递归分析一遍（实测 20MB 随机数据因此多花 4 秒）。
  function carveLooksValid(kind, b) {
    if (!b || b.length < 32) return false;
    if (kind === 'png') return ascii(b.subarray(12, 16), 4) === 'IHDR';
    if (kind === 'zip') {
      const ver = b[4] | (b[5] << 8), method = b[8] | (b[9] << 8);
      const nameLen = b[26] | (b[27] << 8);
      return ver <= 63 && [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 14, 18, 19, 93, 95, 96, 97, 98, 99].indexOf(method) >= 0
        && nameLen > 0 && nameLen < 1024 && 30 + nameLen <= b.length;
    }
    if (kind === 'jpeg') {
      // SOI 之后必须是一串自洽的段（长度字段真实），否则就是噪声里的假 SOI
      let p = 2;
      for (let k = 0; k < 8; k++) {
        if (b[p] !== 0xFF) return false;
        const m = b[p + 1];
        if (m === 0xD8 || m === 0x01 || (m >= 0xD0 && m <= 0xD7)) { p += 2; continue; }
        if (m === 0xDA) return true;
        if (p + 4 > b.length) return false;
        const len = (b[p + 2] << 8) | b[p + 3];
        if (len < 2 || p + 2 + len > b.length) return false;
        p += 2 + len;
      }
      return true;
    }
    return true;
  }

  // LSB 提取出来的东西是不是一个还能继续拆的容器
  function looksLikeContainer(b) {
    if (!b || b.length < 4) return false;
    const m = (s, o) => { for (let i = 0; i < s.length; i++) if (b[(o || 0) + i] !== s[i]) return false; return true; };
    if (b.length >= 262 && String.fromCharCode(b[257], b[258], b[259], b[260], b[261]) === 'ustar') return true;
    return m([0x50, 0x4B, 0x03, 0x04]) || m([0x89, 0x50, 0x4E, 0x47]) || m([0xFF, 0xD8, 0xFF]) ||
      m([0x47, 0x49, 0x46, 0x38]) || m([0x52, 0x49, 0x46, 0x46]) || m([0x37, 0x7A, 0xBC, 0xAF]) ||
      m([0x52, 0x61, 0x72, 0x21]) || m([0x1F, 0x8B]) || m([0xFD, 0x37, 0x7A, 0x58, 0x5A, 0x00]) ||
      m([0x42, 0x5A, 0x68]) ||
      (b[0] === 0x78 && [0x01, 0x5E, 0x9C, 0xDA].indexOf(b[1]) >= 0);
  }

  // 零宽字符隐写：U+200B/200C/200D/2060 被当成比特流。常见于文本/文档题
  const ZERO_WIDTH = '​‌‍⁠᠎﻿';
  function zeroWidthAudit(bytes) {
    const findings = [], artifacts = [];
    let s;
    try { s = MDZ.utf8(bytes); } catch (e) { return { findings, artifacts }; }
    if (!s) return { findings, artifacts };
    let cur = '', best = '';
    for (const ch of s) {
      if (ZERO_WIDTH.indexOf(ch) >= 0) cur += ch;
      else { if (cur.length > best.length) best = cur; cur = ''; }
    }
    if (cur.length > best.length) best = cur;
    if (best.length < 16) return { findings, artifacts };
    const maps = [
      { '​': '0', '‌': '1' },
      { '​': '0', '‍': '1' },
      { '‌': '0', '‍': '1' },
      { '‍': '0', '​': '1' },
      { '⁠': '0', '​': '1' },
      { '﻿': '0', '​': '1' }
    ];
    for (const map of maps) {
      let bits = '';
      for (const ch of best) { const v = map[ch]; if (v !== undefined) bits += v; }
      if (bits.length < 8) continue;
      const out = [];
      for (let i = 0; i + 8 <= bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8), 2));
      if (!out.length) continue;
      const u8 = Uint8Array.from(out);
      const pr = MDZ.printableRatio(u8.subarray(0, Math.min(4096, u8.length)));
      if (pr < 0.85) continue;
      const txt = ascii(u8, u8.length);
      const key = Object.keys(map).map(k => 'U+' + k.codePointAt(0).toString(16)).join('/');
      findings.push(finding('L4', 'zero_width', `零宽字符隐写（${best.length} 个不可见字符 → ${u8.length} 字节）`, {
        confidence: 0.9,
        declared: `${best.length} 个零宽字符（${key}）`,
        actual: txt.slice(0, 160),
        detail: '文本里的零宽字符被当作 0/1 比特流。这里按常见映射还原；若乱码可换其它映射（U+200B/U+200C/U+200D 两两组合）。',
        preview: txt,
        recipe: '把零宽字符按映射换成 0/1，再每 8 位一组转字节',
        payload: { name: 'zero-width.bin', bytes: u8.slice(0) }
      }));
      artifacts.push(artifact('zero-width.bin', u8, '零宽字符还原'));
      break;
    }
    return { findings, artifacts };
  }

  function auditGeneric(bytes, name) {
    const findings = [];
    const zw = zeroWidthAudit(bytes);
    for (const f of zw.findings) findings.push(f);
    const strs = MDZ.strings(bytes, 6).concat(MDZ.utf16strings(bytes, 6));
    const hits = strs.filter(s => MDZ.flagMatch(s) || /pass(word)?|secret|hint/i.test(s));
    if (hits.length) {
      findings.push(finding('L3', 'strings', '可打印字符串命中', {
        confidence: hits.some(s => MDZ.flagMatch(s)) ? 0.9 : 0.5,
        actual: hits.slice(0, 8).join(' | '),
        preview: hits.slice(0, 20).join('\n'),
        recipe: 'strings / UTF-16LE strings'
      }));
    }
    // 编码侦探：对像编码的长串跑自动解码链（hex/base64/base32/base85/base91/uu/url/html）
    const encHits = [];
    const cand = strs.filter(s => s.length >= 16 && s.length <= 65536).slice(0, 24);
    for (const s of cand) {
      for (const r of MDZ.decodeChain(s, 3)) {
        encHits.push(r);
        if (encHits.length >= 8) break;
      }
      if (encHits.length >= 8) break;
    }
    if (encHits.length) {
      const seen = new Set();
      const uniq = encHits.filter(r => (seen.has(r.text) ? false : (seen.add(r.text), true)));
      findings.push(finding('L3', 'encoding', `编码链解出 ${uniq.length} 条候选`, {
        confidence: 0.6,
        declared: `${cand.length} 个长字符串`,
        actual: uniq.slice(0, 4).map(r => `${r.path.join('→')}: ${r.text.slice(0, 60)}`).join(' | '),
        detail: '自动尝试 hex / base64 / base32 / base85 / base91 / uuencode / URL / HTML 实体，最多 3 层。',
        preview: uniq.slice(0, 8).map(r => `[${r.path.join('→')}] ${r.text.slice(0, 160)}`).join('\n'),
        recipe: '按 path 里的顺序逐层解码'
      }));
    }
    // 解出来不是文本而是真文件（base64 的 PNG / hex 的 ZIP…）：切出来当产物，流水线会自动递归
    const binArtifacts = [];
    const binSeen = new Set();
    const EXT = { PNG: 'png', JPEG: 'jpg', GIF: 'gif', BMP: 'bmp', ICO: 'ico', TIFF: 'tif', WEBP: 'webp', ZIP: 'zip', RAR: 'rar', '7Z': '7z', GZIP: 'gz', TAR: 'tar', PDF: 'pdf', ELF: 'elf', PE: 'exe', SQLITE: 'db', WAV: 'wav', PCAP: 'pcap', PCAPNG: 'pcapng' };
    for (const s of cand) {
      for (const r of MDZ.decodeOnce(s, { binaries: true })) {
        if (!r.binary || binSeen.size >= 4) continue;
        const key = MDZ.fnv1a(r.bytes).toString(16) + ':' + r.bytes.length;
        if (binSeen.has(key)) continue;
        binSeen.add(key);
        const t = MDZ.detectType(r.bytes);
        const fname = `decoded-${r.kind}-${binSeen.size}.${EXT[t.format] || 'bin'}`;
        binArtifacts.push(artifact(fname, r.bytes, `${r.kind} 解出的 ${t.format}`));
        findings.push(finding('L3', 'encoding_binary', `${r.kind} 解出 ${t.format} 文件（${r.bytes.length} 字节）`, {
          confidence: 0.85,
          declared: `${s.length} 字符的 ${r.kind}`,
          actual: `${t.format} · ${r.bytes.length} 字节`,
          detail: '这段编码解出来不是文本，而是一个带魔数的文件；已作为产物切出，会自动继续递归分析。',
          preview: s.slice(0, 80) + (s.length > 80 ? '…' : ''),
          recipe: `把这段 ${r.kind} 解出来存成 ${fname}`,
          payload: { name: fname, bytes: r.bytes }
        }));
      }
      if (binSeen.size >= 4) break;
    }
    return { findings, artifacts: zw.artifacts.concat(binArtifacts), image: null };
  }

  function dispatch(bytes, name, type, opts) {
    switch (type.format) {
      case 'PNG': return MDZ.auditPNG(bytes, name, opts);
      case 'JPEG': return MDZ.auditJPEG(bytes, name, opts);
      case 'BMP': return MDZ.auditBMP(bytes, name, opts);
      case 'GIF': return MDZ.auditGIF(bytes, name, opts);
      case 'ICO': return MDZ.auditICO(bytes, name, opts);
      case 'SVG': return MDZ.auditSVG(bytes, name, opts);
      case 'ZIP': return MDZ.auditZIP(bytes, name, opts);
      case 'TIFF': return MDZ.auditTIFF(bytes, name, opts);
      case 'WEBP': return MDZ.auditWEBP(bytes, name, opts);
      case 'WAV': return MDZ.auditWAV(bytes, name, opts);
      case 'MP3': return MDZ.auditMP3(bytes, name, opts);
      case 'PDF': return MDZ.auditPDF(bytes, name, opts);
      case 'TAR': return MDZ.auditTAR(bytes, name, opts);
      case 'RAR': return MDZ.auditRAR(bytes, name, opts);
      case '7Z': return MDZ.audit7Z(bytes, name, opts);
      case 'PCAP': return MDZ.auditPCAP(bytes, name, opts);
      case 'PCAPNG': return MDZ.auditPCAP(bytes, name, opts);
      case 'TTF': case 'OTF': case 'WOFF': case 'WOFF2': return MDZ.auditFont(bytes);
      case 'SQLITE': return MDZ.auditSQLite(bytes);
      case 'ELF': return MDZ.auditELF(bytes);
      case 'PE': return MDZ.auditPE(bytes);
      case 'TEXT': return auditGeneric(bytes, name);
      default: return auditGeneric(bytes, name);
    }
  }

  function looksLikeImage(bytes) {
    if (bytes.length < 8) return false;
    return (bytes[0] === 0x89 && bytes[1] === 0x50) ||
      (bytes[0] === 0xFF && bytes[1] === 0xD8) ||
      (bytes[0] === 0x47 && bytes[1] === 0x49) ||
      (bytes[0] === 0x42 && bytes[1] === 0x4D);
  }

  function analyzeStreams(bytes, result, seenOffsets, item, o) {
    const hits = findStreamSignatures(bytes, 0, bytes.length);
    const big = bytes.length > 1024 * 1024;
    const maxOut = big ? 8 * 1024 * 1024 : 64 * 1024 * 1024;
    // 预算按「解出的字节数」算，不按命中数算：随机数据里假 zlib 头每 16KB 就有一个，
    // 按命中计数会把大文件后半段整段饿死（真实载荷在后面就永远轮不到）。
    // 内嵌容器（zip/png/jpeg）不吃这个预算，预算花光了也继续处理。
    const budget = { tries: 3000, out: 64 * 1024 * 1024, ms: 1200, t0: Date.now() };
    // 整次分析共用一个「压缩流尝试」的截止时间：每层递归各自计时的话，
    // 十个产物就是十份预算，随机数据能把总耗时放大到十几秒。
    if (!result._streamDeadline) result._streamDeadline = Date.now() + 1500;
    for (const h of hits) {
      if (h.kind !== 'zip' && h.kind !== 'png' && h.kind !== 'jpeg') {
        if (budget.out <= 0 || budget.tries <= 0) continue;
        if (Date.now() > result._streamDeadline) continue;
        budget.tries--;
      }
      if (h.kind === 'lzma') {
        const key = item.hash + '@lzma@' + h.offset;
        if (seenOffsets.has(key)) continue;
        seenOffsets.add(key);
        const tail = bytes.subarray(h.offset);
        const zl = MDZ.lzmaDecompressAlone ? MDZ.lzmaDecompressAlone(tail, { maxOut }) : null;
        const lout = zl && zl.out;
        if (lout && lout.length) {
          budget.out -= lout.length;
          const head = lout.subarray(0, Math.min(4096, lout.length));
          const lpr = MDZ.printableRatio(head);
          const lflag = MDZ.FLAG_RE.test(ascii(head, head.length));
          const limg = looksLikeImage(lout);
          if (lflag || limg || (lout.length >= 32 && lpr >= 0.8)) {
            result.findings.push(finding('L2', 'stream', `文件内发现 LZMA 流 @ 0x${hex(h.offset)}（已解压）`, {
              confidence: limg || lflag ? 0.95 : 0.78,
              offset: h.offset,
              declared: 'LZMA 单独格式（无魔数）', actual: `解出 ${lout.length} 字节`,
              detail: `可打印率 ${(lpr * 100).toFixed(0)}%${limg ? '；产物像图片' : ''}${lflag ? '；命中 flag 正则' : ''}${zl.partial ? '；流被截断，只解出前段' : ''}`,
              preview: ascii(lout, 120),
              recipe: `在 0x${hex(h.offset)} 处 LZMA 解压`,
              payload: { name: `stream-lzma-${h.offset}.bin`, bytes: lout.slice(0) },
              file: item.name, depth: item.depth
            }));
            result.artifacts.push(artifact(`stream-lzma-0x${hex(h.offset)}.bin`, lout, 'LZMA 解压产物'));
            if (item.depth + 1 <= o.maxDepth) {
              result.queue.push({ bytes: lout, name: `stream-lzma-${h.offset}.bin`, depth: item.depth + 1, id: result._nextId++, parentId: item.id });
            } else {
              result.dropped = (result.dropped || 0) + 1;
            }
            continue;
          }
        }
        if (h.offset === 0) result.findings.push(finding('L2', 'stream_lzma', `文件内发现 LZMA 流 @ 0x${hex(h.offset)}`, {
          confidence: 0.85, offset: h.offset,
          declared: 'LZMA 单独格式特征（无魔数）', actual: `${tail.length} 字节待解`,
          detail: '按属性字节 + 字典大小识别，与 binwalk 同判据；内置解压没解出可读内容，下载载荷后可用 xz --format=lzma -dc 再试。',
          preview: ascii(tail, 120),
          recipe: '下载后用 xz --format=lzma -dc 解',
          payload: { name: `stream-lzma-0x${hex(h.offset)}.lzma`, bytes: tail.slice(0) },
          file: item.name, depth: item.depth
        }));
        if (h.offset === 0) result.artifacts.push(artifact(`stream-lzma-0x${hex(h.offset)}.lzma`, tail, 'LZMA 流（未解压）'));
        continue;
      }
      // 内嵌/拼接的 zip/png/jpeg：签名已经算出来了，直接切出来当产物（会自动递归分析）
      if (h.kind === 'zip' || h.kind === 'png' || h.kind === 'jpeg') {
        if (h.offset === 0) continue;                 // 文件本身就是这个格式，别自切
        const key = item.hash + '@carve@' + h.kind + '@' + h.offset;
        if (seenOffsets.has(key)) continue;
        if ((result._carved = (result._carved || 0) + 1) > 12) continue;
        seenOffsets.add(key);
        const cap = Math.min(bytes.length, h.offset + 32 * 1024 * 1024);
        const tail = bytes.subarray(h.offset, cap);
        if (tail.length < 16) continue;
        if (!carveLooksValid(h.kind, tail)) continue;   // 随机噪声里的假魔数，别切
        const ext = h.kind === 'jpeg' ? 'jpg' : h.kind;
        result.findings.push(finding('L2', 'carve', `文件内发现内嵌 ${h.kind.toUpperCase()} @ 0x${hex(h.offset)}`, {
          confidence: 0.85, offset: h.offset,
          declared: `${h.kind} 魔数`, actual: `切出 ${tail.length} 字节`,
          detail: '文件中间/尾部拼接的容器；已作为产物切出，会自动继续递归分析。',
          recipe: `dd if=<file> bs=1 skip=${h.offset} of=carved.${ext}`,
          payload: { name: `carved-0x${hex(h.offset)}.${ext}`, bytes: tail.slice(0) }
        }));
        result.artifacts.push(artifact(`carved-0x${hex(h.offset)}.${ext}`, tail, `内嵌 ${h.kind}`));
        if (item.depth + 1 <= o.maxDepth) {
          result.queue.push({ bytes: tail, name: `carved-0x${hex(h.offset)}.${ext}`, depth: item.depth + 1, id: result._nextId++, parentId: item.id });
        } else result.dropped = (result.dropped || 0) + 1;
        continue;
      }
      if (h.kind !== 'zlib' && h.kind !== 'gzip') continue;
      // 去重键必须带文件哈希：不同文件里同偏移的流是两条不同的流
      const key = item.hash + '@' + h.kind + '@' + h.offset;
      if (seenOffsets.has(key)) continue;
      // 先用 64KB 的探针试一把：假头的解压通常几十微秒就结束，而完整解一次要 3–25ms。
      // 只有探针打满上限、且结果看起来像真载荷时，才值得再完整解一次。
      // 判据要严（魔数必须落在偏移 0）：随机数据的解压结果里「某处出现魔数」每千次就有一次，
      // 放宽会解出一堆几 MB 的垃圾再递归分析，实测 20MB 随机数据因此多花 4 秒。
      const probeCap = 64 * 1024;
      let z = h.kind === 'zlib' ? inflateZlib(bytes, h.offset, probeCap) : inflateGzip(bytes, h.offset, probeCap);
      if (z.out && z.out.length >= probeCap) {
        const ph = z.out.subarray(0, Math.min(4096, z.out.length));
        const pFlag = MDZ.FLAG_RE.test(ascii(ph, ph.length));
        // 纯文本阈值取 0.9：随机数据的假流也常能解出 0.82–0.88 的「像文本」碎片，
        // 按 0.8 判会让每个几 MB 的垃圾流都完整解一遍（实测 20MB 随机数据多花 1.4 秒）。
        if (pFlag || startsWithMagic(z.out) || looksLikeImage(z.out) || MDZ.printableRatio(ph) >= 0.9) {
          z = h.kind === 'zlib' ? inflateZlib(bytes, h.offset, maxOut) : inflateGzip(bytes, h.offset, maxOut);
        }
      }
      if (!z.out || !z.out.length) continue;   // 校验失败也留明文：CRC 被改/截断的流里往往就是 flag
      budget.out -= z.out.length;
      const head = z.out.subarray(0, Math.min(4096, z.out.length));
      const pr = MDZ.printableRatio(head);
      const flag = MDZ.FLAG_RE.test(ascii(head, head.length));
      const img = looksLikeImage(z.out);
      const container = looksLikeContainer(z.out);
      const topStream = h.offset === 0;
      if (!flag && !img && !container && !topStream && (z.out.length < 32 || pr < 0.8)) continue;
      seenOffsets.add(key);
      result.findings.push(finding('L2', 'stream', `文件内发现可解压 ${h.kind} 流 @ 0x${hex(h.offset)}`, {
        confidence: img || flag ? 0.95 : 0.75,
        offset: h.offset,
        declared: `${h.kind} 头`, actual: `产出 ${z.out.length} 字节`,
        detail: `可打印率 ${(pr * 100).toFixed(0)}%${img ? '；产物像图片' : ''}${flag ? '；命中 flag 正则' : ''}${container ? '；产物是容器' : ''}${z.error ? '；' + z.error : ''}`,
        preview: ascii(z.out, 120),
        recipe: `在 0x${hex(h.offset)} 处 inflate`,
        payload: { name: `stream-${h.kind}-${h.offset}.bin`, bytes: z.out.slice(0) },
        file: item.name, depth: item.depth
      }));
      result.artifacts.push(artifact(`stream-${h.kind}-0x${hex(h.offset)}.bin`, z.out, `${h.kind} 流解压产物`));
      // 只有解出容器/图片才值得再递归拆一遍。纯文本流再分析一次只是把同样的
      // SHA-256 / strings / 签名扫描重跑一遍（8MB 一次约 0.4 秒），收益接近零。
      if (container || img) {
        if (item.depth + 1 <= o.maxDepth) {
          result.queue.push({ bytes: z.out, name: `stream-${h.offset}.bin`, depth: item.depth + 1, id: result._nextId++, parentId: item.id });
        } else {
          result.dropped = (result.dropped || 0) + 1;
        }
      }
    }
  }

  function analyze(input, name, opts) {
    const o = Object.assign({ maxDepth: 3, deep: false, maxFiles: 64, maxScanPixels: 6000000, top: 12 }, opts || {});
    const bytes = toU8(input);
    const result = {
      name: name || 'input',
      size: bytes.length,
      sha256: sha256(bytes),
      type: null,
      findings: [],
      artifacts: [],
      files: [],
      images: [],
      queue: [],
      _nextId: 1,
      _depth: 0,
      stats: { files: 0, findings: 0, artifacts: 0, scanned: 0, elapsed: 0 }
    };
    // 文件名本身可能是 flag（ctfshow 一类题的第一步）
    const nameFlag = MDZ.flagMatch(result.name);
    if (nameFlag) {
      result.findings.push(finding('L0', 'filename', '文件名里带 flag', {
        confidence: 0.9,
        declared: result.name,
        actual: nameFlag,
        detail: '出题人常把第一个 flag 直接写进文件名；无需打开文件即可确认。',
        preview: nameFlag,
        recipe: '读文件名'
      }));
    }
    const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    const seen = new Set();
    const seenStreamOffsets = new Set();
    const scannedSigs = new Set();
    function imageSig(image) {
      if (!image || !image.channels) return null;
      const c = image._chans || (image._chans = MDZ.channelBytes(image));
      let s = image.width + 'x' + image.height + ':';
      for (const k of ['R', 'G', 'B', 'A']) {
        if (!c[k]) continue;
        // 只哈希开头会把「上半张完全相同、下半张不同」的帧判成重复（GIF/APNG 常见），
        // 改成 首 8K + 尾 8K + 长度，既便宜又不会漏。
        const a = c[k], len = a.length;
        const head = a.subarray(0, Math.min(len, 8192));
        const tail = len > 8192 ? a.subarray(len - 8192) : head;
        s += MDZ.fnv1a(head).toString(16) + '-' + MDZ.fnv1a(tail).toString(16) + '-' + len + '.';
      }
      return s;
    }
    function scanImageOnce(image, item, displayName) {
      if (!image || !image.channels) return;
      if (!(image.width > 0) || !(image.height > 0)) {
        result.findings.push(finding('L4', 'decode', '跳过零尺寸图像', {
          confidence: 0.6, file: item.name, depth: item.depth,
          actual: `${image.width}x${image.height}`,
          detail: '宽或高为 0，无法生成位平面或参与 LSB 扫描。'
        }));
        return;
      }
      const sig = imageSig(image);
      if (sig && scannedSigs.has(sig)) return;
      if (sig) scannedSigs.add(sig);
      result.images.push({ name: displayName || item.name, image, depth: item.depth });
      result.stats.scanned++;
      const scan = MDZ.scanImage(image, { deep: o.deep, top: o.top });
      // 画在平坦背景上的字：LSB 扫描解不出字节流，但位平面上能看出来
      const drawn = MDZ.detectDrawn ? MDZ.detectDrawn(image) : { findings: [], artifacts: [] };
      for (const f of drawn.findings) { f.file = item.name; f.depth = item.depth; scan.findings.push(f); }
      for (const a of drawn.artifacts) { a.file = item.name; a.depth = item.depth; scan.artifacts.push(a); }
      // 频域：网格水印/周期噪声/频域隐写
      const spec = MDZ.auditSpectrum ? MDZ.auditSpectrum(image) : { findings: [], artifacts: [] };
      for (const f of spec.findings) { f.file = item.name; f.depth = item.depth; scan.findings.push(f); }
      for (const a of spec.artifacts) { a.file = item.name; a.depth = item.depth; scan.artifacts.push(a); }
      // 二维码：内置解码，不依赖 zbarimg。解出的文本直接进发现与产物，flag 会被自动捞出
      const smallEnough = image.width * image.height <= 4000000;
      const rgba = (MDZ.qrDecodeImageData || MDZ.barDecodeRGBA) && smallEnough ? MDZ.renderImage(image, 0) : null;
      if (MDZ.qrDecodeImageData && rgba) {
        for (const q of MDZ.qrDecodeImageData(rgba)) {
          scan.findings.push(finding('L4', 'qr', `二维码解出文本（版本 ${q.version} · ${q.ec} 级）`, {
            confidence: 0.95,
            declared: `检测到 ${q.dim}×${q.dim} 模块的二维码`,
            actual: q.text.slice(0, 200),
            detail: '内置 QR 解码：Otsu 二值化 → 三个寻像图形定仿射 → 采样 → 去掩码 → 拆交织 → 读段。不做 RS 纠错，清晰截图即可。',
            preview: q.text,
            recipe: '直接读取这段文本',
            payload: { name: 'qr-text.txt', bytes: new TextEncoder().encode(q.text) }
          }));
          scan.artifacts.push(artifact('qr-text.txt', new TextEncoder().encode(q.text), '二维码解出的文本'));
        }
      }
      // 一维条码：EAN-13/EAN-8/Code128/Code39，靠校验位/mod-103 排除误报
      if (MDZ.barDecodeRGBA && rgba) {
        for (const r of MDZ.barDecodeRGBA(rgba)) {
          const enc = new TextEncoder().encode(r.text);
          scan.findings.push(finding('L4', 'barcode', `一维条码（${r.symbology}）解出 ${r.text.length} 字符`, {
            confidence: 0.95,
            declared: `${r.symbology} · 扫描线 y=${r.at}（${r.axis === 'v' ? '竖向' : '横向'}）`,
            actual: r.text.slice(0, 200),
            detail: '灰度扫描线 → Otsu 二值化 → 游程量化 → 符号表查表。三种码都过了各自的强校验（EAN 校验位 / Code128 mod-103 / Code39 起止星号）。',
            preview: r.text,
            recipe: '直接读取这段文本（zbarimg 可交叉验证）',
            payload: { name: `barcode-${r.symbology}.txt`, bytes: enc }
          }));
          scan.artifacts.push(artifact(`barcode-${r.symbology}.txt`, enc, `一维条码解出的文本（${r.symbology}）`));
        }
      }
      for (const f of scan.findings) { f.file = item.name; f.depth = item.depth; result.findings.push(f); }
      for (const a of scan.artifacts) {
        a.file = item.name; a.depth = item.depth; result.artifacts.push(a);
        if (a.image && (a.kind === 'drawn' || a.kind === 'spectrum')) result.images.push({ name: a.name, image: a.image, depth: item.depth });
        // LSB 里解出来的可能是 ZIP/PNG 之类的容器（ctfshow 常见：位平面 -> zip -> 文本），接着拆
        const b = a.bytes;
        if (b && b.length > 8 && b.length < 64 * 1024 * 1024 && looksLikeContainer(b) && item.depth <= o.maxDepth) {
          // 图像本身不占 files 槽位，父链要挂到图像所属的那个文件上
          result.queue.push({ bytes: b, name: a.name, depth: item.depth, id: result._nextId++, parentId: item.parentId == null ? 0 : item.parentId });
        }
      }
    }
    result.queue.push({ bytes, name: result.name, depth: 0, id: 0, parentId: null });

    let fileCount = 0;
    while (result.queue.length && fileCount < o.maxFiles) {
      const item = result.queue.shift();
      if (!item) continue;
      if (item.image) {
        if (item.image.width * item.image.height <= o.maxScanPixels) scanImageOnce(item.image, item, item.name);
        else result.images.push({ name: item.name, image: item.image, depth: item.depth });
        continue;
      }
      if (!item.bytes || !item.bytes.length) continue;
      const h = sha256(item.bytes);
      if (seen.has(h)) continue;
      seen.add(h);
      item.hash = h;
      fileCount++;
      const type = detectType(item.bytes, item.name);
      if (item.depth === 0) {
        result.type = type;
        if (type.format === 'PNG') {
          try {
            const rec = MDZ.recoverDims(item.bytes, { limit: 20000 });
            result.repair = { format: 'PNG', candidates: rec.candidates || [], ihdr: rec.ihdr || null };
          } catch (e) { result.repair = { format: 'PNG', candidates: [], error: String(e && e.message || e) }; }
        } else if (type.format === 'JPEG') {
          result.repair = { format: 'JPEG', note: 'JPEG 尺寸/缩略图修复请用原 CRC 工具：tools/Misc/CRC_CHECK/image-crc.html' };
        }
      }
      result.files.push({ id: item.id, parentId: item.parentId === undefined ? null : item.parentId, name: item.name, size: item.bytes.length, depth: item.depth, sha256: h, format: type.format });
      result._depth = item.depth;

      // 魔数被削掉/开头多出字节：猜格式并给一键修复
      if (type.format === 'unknown') {
        try {
          const cands = MDZ.detectDamagedHeader(item.bytes);
          if (cands.length) {
            const c = cands[0];
            const desc = x => x.mode === 'patch'
              ? `${x.format}（第 ${x.extra[0]} 字节 0x${hex(x.extra[2])} 应为 0x${hex(x.extra[1])}）`
              : `${x.format}（${x.mode === 'prepend' ? '缺 ' : '多 '}${x.extra.length} 字节）`;
            const others = cands.slice(1, 4).map(desc).join('、');
            let title, declared, how;
            if (c.mode === 'patch') {
              title = `魔数有 1 字节不对：疑似 ${c.format}（0x${hex(c.extra[2])} 应为 0x${hex(c.extra[1])}）`;
              declared = `第 ${c.extra[0]} 字节应为 0x${hex(c.extra[1])}，实际 0x${hex(c.extra[2])}`;
              how = '把魔数里错的那一字节改回去';
            } else if (c.mode === 'prepend') {
              const extraHex = Array.from(c.extra).map(x => hex(x)).join(' ');
              title = `文件头疑似被削：像 ${c.format}（缺 ${c.extra.length} 字节 ${extraHex}）`;
              declared = `开头缺少 ${c.extra.length} 字节：${extraHex}`;
              how = '在前面补回缺失的魔数字节';
            } else {
              const extraHex = Array.from(c.extra).map(x => hex(x)).join(' ');
              title = `文件头多出 ${c.extra.length} 字节：跳过才是 ${c.format}`;
              declared = `开头多出 ${c.extra.length} 字节：${extraHex}`;
              how = '删掉开头多出的字节';
            }
            result.findings.push(finding('L0', 'damaged_header', title, {
              confidence: c.score,
              declared,
              actual: `实际开头：${MDZ.bytesToHex(item.bytes.subarray(0, 16), 16)}`,
              detail: `按 ${c.format} 的魔数${how}之后能通过格式自检（匹配 ${c.matched}/${c.total} 字节）。点「修复并分析」会直接对修复副本重新分析，原文件不动。`
                + (others ? `\n其它可能：${others}` : ''),
              recipe: how,
              repair: { name: 'fixed-header-' + (item.name || 'file'), bytes: c.fixed },
              file: item.name, depth: item.depth
            }));
          }
        } catch (e) { /* 预检失败不影响主流程 */ }
      }

      let audit = { findings: [], artifacts: [], image: null };
      try {
        audit = dispatch(item.bytes, item.name, type, o);
      } catch (e) {
        result.findings.push(finding('L0', 'error', `分析 ${item.name} 时出错`, {
          confidence: 1, detail: String(e && e.message || e)
        }));
      }
      // 已知格式解析失败时不能就此打住：头被改坏的题很常见，
      // 至少要把 strings / 编码链 / 零宽这些通用线索跑一遍，否则明文 flag 会直接消失。
      if (type.format !== 'TEXT' && type.format !== 'unknown') {
        const af = audit.findings || [];
        const failed = af.length === 0 || af.every(f => f.type === 'format' || f.type === 'error');
        if (failed) {
          try {
            const g = auditGeneric(item.bytes, item.name);
            audit.findings = af.concat(g.findings);
            audit.artifacts = (audit.artifacts || []).concat(g.artifacts);
          } catch (e) { /* 兜底失败不影响主流程 */ }
        }
      }

      if (audit.audio && !result.audio) result.audio = audit.audio;
      if (audit.pcap && !result.pcap) result.pcap = audit.pcap;
      if (item.depth === 0 && type.format === 'GIF' && audit.parsed && audit.parsed.frames) {
        result.gif = {
          width: audit.parsed.lsd.width, height: audit.parsed.lsd.height,
          hasGCT: audit.parsed.hasGCT, gctSize: audit.parsed.gctSize,
          frames: audit.parsed.frames.map((f, i) => ({
            i, offset: f.offset, left: f.left, top: f.top, width: f.width, height: f.height,
            fullHeight: f.fullHeight || f.height, extraRows: f.extraRows || 0,
            delay: f.delay || 0, disposal: f.disposal || 0, interlace: !!f.interlace,
            transparent: !!f.transparent, transparentIndex: f.transparentIndex,
            localPalette: !!f.palette, image: f.image || null,
            error: f.image ? null : '未解码'
          }))
        };
      }
      for (const f of audit.findings || []) {
        f.file = item.name;
        f.depth = item.depth;
        result.findings.push(f);
      }
      for (const a of audit.artifacts || []) {
        a.depth = item.depth;
        a.file = item.name;
        result.artifacts.push(a);
        if (a.bytes && a.bytes.length > 8 && a.bytes.length < 64 * 1024 * 1024) {
          if (item.depth + 1 <= o.maxDepth) result.queue.push({ bytes: a.bytes, name: a.name, depth: item.depth + 1, id: result._nextId++, parentId: item.id });
          else result.dropped = (result.dropped || 0) + 1;
        }
        if (a.image) {
          if (item.depth + 1 <= o.maxDepth) result.queue.push({ image: a.image, name: a.name, depth: item.depth + 1, id: result._nextId++, parentId: item.id });
          else result.dropped = (result.dropped || 0) + 1;
        }
      }

      // 容器内全局压缩流扫描（JPEG 熵编码数据会产生大量假 zlib 头，靠段/尾部产物递归即可）
      if (type.format !== 'JPEG') {
        try { analyzeStreams(item.bytes, result, seenStreamOffsets, item, o); } catch (e) { /* ignore */ }
      }

      // 像素扫描
      const images = [];
      if (audit.image && audit.image.channels) images.push({ image: audit.image, name: item.name });
      if (audit.images) for (const x of audit.images) if (x.image) images.push({ image: x.image, name: x.name });
      for (const im of images) {
        if (im.image.width * im.image.height > o.maxScanPixels) {
          result.images.push({ name: item.name, image: im.image, depth: item.depth });
          result.findings.push(finding('L4', 'scan_skip', `跳过 LSB 扫描：${im.image.width}x${im.image.height} 太大`, {
            confidence: 0.5, file: item.name, depth: item.depth,
            detail: `像素数超过上限 ${o.maxScanPixels}；可手动用位平面视图查看。`
          }));
          continue;
        }
        scanImageOnce(im.image, item, im.name);
      }
    }

    // 去重：同类型 + 同偏移 + 同标题，保留置信度最高者
    {
      const best = new Map();
      for (const f of result.findings) {
        const key = f.type === 'lossy' ? 'lossy' : [f.file, f.type, f.offset, f.title].join('|');
        const prev = best.get(key);
        if (!prev || f.confidence > prev.confidence) best.set(key, f);
      }
      result.findings = Array.from(best.values());
    }

    if (result.queue.length || result.dropped) {
      result.findings.push(finding('L2', 'limit', '递归未完全展开', {
        confidence: 0.6,
        detail: `未处理队列 ${result.queue.length} 条；因深度上限丢弃 ${result.dropped || 0} 条（maxFiles=${o.maxFiles}, maxDepth=${o.maxDepth}）。需要更深请调大参数。`
      }));
    }

    // 排序：置信度降序，同层按层
    result.findings.sort((a, b) => {
      if (b.confidence !== a.confidence) return b.confidence - a.confidence;
      return (LAYER_ORDER[a.layer] || 9) - (LAYER_ORDER[b.layer] || 9);
    });
    result.stats.files = fileCount;
    result.stats.findings = result.findings.length;
    result.stats.artifacts = result.artifacts.length;
    result.stats.elapsed = Math.round(((typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0));
    return result;
  }

  // 高置信度 flag 汇总（格式由 MDZ 的全局 flag 格式决定，默认 flag{...}）
  // 自定义格式（#...# 之类）在噪声里容易误中：只认"我们自己解出来的上下文"
  const CUSTOM_FLAG_TRUSTED = new Set(['lsb', 'text_chunk', 'meta_decode', 'chunk_name', 'crc_ascii', 'trailer', 'filename', 'palette_flag', 'zip_entry', 'second_stream', 'independent_idat', 'unused_data']);
  function flags(result) {
    const out = new Set();
    const custom = MDZ.isFlagFormatCustom();
    for (const f of result.findings) {
      if (custom && !CUSTOM_FLAG_TRUSTED.has(f.type)) continue;
      const text = [f.preview, f.actual, f.detail, f.title].join('\n');
      MDZ.flagFindAll(text).forEach(x => out.add(x));
    }
    // 有些 flag 只在产物里（preview 被截断时尤其常见），也要捞出来
    const scan = (bytes) => {
      if (!bytes || !bytes.length) return;
      const head = bytes.subarray(0, Math.min(bytes.length, 65536));
      // 自定义格式只扫纯文本产物（zip 里的 pw.txt 这种），二进制产物全是噪声
      if (custom && MDZ.printableRatio(head) <= 0.9) return;
      MDZ.flagFindAll(ascii(head, head.length)).forEach(x => out.add(x));
    };
    for (const a of result.artifacts || []) scan(a.bytes);
    for (const f of result.findings) if (f.payload) scan(f.payload.bytes);
    return Array.from(out);
  }

  function reportMeta(result) {
    const t = result.type;
    return [
      `- 文件：\`${result.name}\``,
      `- 大小：${result.size} 字节`,
      `- SHA-256：\`${result.sha256}\``,
      `- 真身：${t ? t.format + ' / ' + t.mime : '未知'}${t && t.extMismatch ? `（扩展名 .${t.ext} 与真身不符）` : ''}`,
      `- 分析：${result.stats.files} 个文件，${result.stats.findings} 条发现，${result.stats.artifacts} 个产物，${result.stats.elapsed} ms`
    ];
  }

  function reportFlagLines(result, lines) {
    const fl = flags(result);
    if (!fl.length) return;
    lines.push('## 疑似 flag');
    lines.push('');
    for (const x of fl) lines.push('```\n' + x + '\n```');
    lines.push('');
  }

  function reportBrief(result) {
    const lines = [`# ${result.name} — misc 速报`, ''];
    lines.push(...reportMeta(result));
    lines.push('');
    reportFlagLines(result, lines);
    lines.push('## 关键发现');
    lines.push('');
    for (const f of result.findings.slice(0, 12)) {
      const off = f.offset === null || f.offset === undefined ? '' : ` @ 0x${hex(f.offset)}`;
      const detail = (f.detail || '').split('\n')[0].slice(0, 110);
      lines.push(`- [${(f.confidence * 100).toFixed(0)}%] **${f.title}**${off}${detail ? ' — ' + detail : ''}`);
    }
    if (!result.findings.length) lines.push('- 无');
    lines.push('');
    if (result.artifacts.length) {
      lines.push('## 产物');
      lines.push('');
      for (const a of result.artifacts) lines.push(`- \`${a.name}\`${a.note ? ' — ' + a.note : ''}${a.bytes ? `（${a.bytes.length} 字节）` : ''}`);
      lines.push('');
    }
    lines.push('---');
    lines.push('由 misc大手子生成；所有分析均在本地完成。');
    return lines.join('\n');
  }

  function reportWP(result) {
    const t = result.type || {};
    const lines = [`# ${result.name}`, ''];
    lines.push('## 一、题目信息');
    lines.push('');
    lines.push('| 项 | 值 |');
    lines.push('|---|---|');
    lines.push(`| 文件名 | \`${String(result.name).replace(/\|/g, '\\|')}\` |`);
    lines.push(`| 大小 | ${result.size} 字节 |`);
    lines.push(`| SHA-256 | \`${result.sha256}\` |`);
    lines.push(`| 真身 | ${t.format || '未知'} / ${t.mime || ''}${t.extMismatch ? `（扩展名 .${t.ext} 不符）` : ''} |`);
    lines.push('');
    lines.push('## 二、分析过程');
    lines.push('');
    const fs = result.findings.slice(0, 16);
    if (!fs.length) lines.push('（自动分析未发现明显异常；需要人工看位平面或补充已知线索。）');
    fs.forEach((f, i) => {
      lines.push(`### ${i + 1}. ${f.title}`);
      lines.push('');
      if (f.offset !== null && f.offset !== undefined) lines.push(`- 位置：\`0x${hex(f.offset)}\``);
      if (f.declared || f.actual) lines.push(`- 声明/实际：\`${f.declared || '?'}\` / \`${f.actual || '?'}\``);
      if (f.detail) lines.push(`- 依据：${f.detail}`);
      if (f.preview) lines.push(`- 片段：\n\n\`\`\`\n${f.preview.slice(0, 400)}\n\`\`\``);
      if (f.recipe) lines.push(`- 复现：${f.recipe}`);
      lines.push(`- 置信度：${(f.confidence * 100).toFixed(0)}%`);
      lines.push('');
    });
    lines.push('## 三、flag');
    lines.push('');
    const fl = flags(result);
    if (fl.length) for (const x of fl) lines.push('```\n' + x + '\n```');
    else lines.push('（未自动命中，需人工复核。）');
    lines.push('');
    lines.push('## 四、复现步骤');
    lines.push('');
    let step = 1;
    for (const f of result.findings.filter(x => x.recipe).slice(0, 20)) {
      lines.push(`${step++}. **${f.title}**：${f.recipe}`);
    }
    if (result.artifacts.length) {
      lines.push(`${step++}. 检查产物：${result.artifacts.map(a => `\`${a.name}\``).join('、')}`);
    }
    if (step === 1) lines.push('1. （无自动复现步骤）');
    lines.push('');
    lines.push('---');
    lines.push('由 misc大手子生成；所有分析均在本地完成。');
    return lines.join('\n');
  }

  function buildReport(result, opts) {
    const tpl = (opts && opts.template) || 'full';
    if (tpl === 'brief') return reportBrief(result);
    if (tpl === 'wp') return reportWP(result);
    const lines = [];
    lines.push(`# misc大手子 分析报告`);
    lines.push('');
    lines.push(...reportMeta(result));
    lines.push('');
    reportFlagLines(result, lines);
    lines.push('## 发现');
    lines.push('');
    lines.push('| 层 | 置信度 | 标题 | 偏移 | 依据 |');
    lines.push('|---|---|---|---|---|');
    for (const f of result.findings) {
      const off = f.offset === null || f.offset === undefined ? '' : '0x' + hex(f.offset);
      const title = String(f.title).replace(/\|/g, '\\|');
      lines.push(`| ${f.layer} | ${(f.confidence * 100).toFixed(0)}% | ${title} | ${off} | ${(f.detail || '').split('\n')[0].replace(/\|/g, '\\|').slice(0, 120)} |`);
    }
    lines.push('');
    if (result.artifacts.length) {
      lines.push('## 产物');
      lines.push('');
      for (const a of result.artifacts) {
        lines.push(`- \`${a.name}\`${a.note ? ' — ' + a.note : ''}${a.bytes ? `（${a.bytes.length} 字节）` : ''}`);
      }
      lines.push('');
    }
    lines.push('## 复现路径');
    lines.push('');
    for (const f of result.findings.filter(x => x.recipe).slice(0, 20)) {
      lines.push(`- **${f.title}**：${f.recipe}`);
    }
    lines.push('');
    lines.push('---');
    lines.push('由 misc大手子生成；所有分析均在本地完成。');
    return lines.join('\n');
  }

  function buildBatchReport(results) {
    const list = (results || []).filter(Boolean);
    const lines = [`# misc大手子 批量分析报告`, ''];
    const totalFindings = list.reduce((a, r) => a + r.findings.length, 0);
    const totalArtifacts = list.reduce((a, r) => a + r.artifacts.length, 0);
    lines.push(`- 文件数：${list.length}`);
    lines.push(`- 发现：${totalFindings} 条；产物：${totalArtifacts} 个`);
    lines.push('');
    lines.push('## 汇总');
    lines.push('');
    lines.push('| # | 文件 | 真身 | 大小 | 发现 | 产物 | flag | 用时 |');
    lines.push('|---|---|---|---|---|---|---|---|');
    list.forEach((r, i) => {
      const t = r.type || {};
      const fl = flags(r);
      lines.push(`| ${i + 1} | ${String(r.name).replace(/\|/g, '\\|')} | ${t.format || '?'} | ${r.size} | ${r.findings.length} | ${r.artifacts.length} | ${fl.length ? fl.map(x => '`' + x.replace(/\|/g, '\\|') + '`').join('<br>') : ''} | ${r.stats.elapsed} ms |`);
    });
    lines.push('');
    const allFlags = [];
    for (const r of list) for (const f of flags(r)) allFlags.push({ file: r.name, flag: f });
    if (allFlags.length) {
      lines.push('## flag 汇总');
      lines.push('');
      for (const x of allFlags) lines.push(`- \`${x.file}\`：\`${x.flag}\``);
      lines.push('');
    }
    lines.push('## 文件详情');
    lines.push('');
    for (const r of list) {
      const t = r.type || {};
      lines.push(`### ${r.name}`);
      lines.push('');
      lines.push(`- 真身：${t.format || '未知'}；大小：${r.size} 字节；SHA-256：\`${r.sha256}\``);
      const fl = flags(r);
      lines.push(`- flag：${fl.length ? fl.join(' / ') : '未命中'}`);
      const top = r.findings.slice(0, 5);
      lines.push(`- 主要发现：${top.length ? top.map(f => `${f.title}（${(f.confidence * 100).toFixed(0)}%）`).join('；') : '无'}`);
      if (r.artifacts.length) lines.push(`- 产物：${r.artifacts.map(a => `\`${a.name}\``).join('、')}`);
      lines.push('');
    }
    lines.push('---');
    lines.push('由 misc大手子生成；所有分析均在本地完成。');
    return lines.join('\n');
  }

  Object.assign(MDZ, { analyze, flags, buildReport, buildBatchReport, dispatch });
})(typeof globalThis !== 'undefined' ? globalThis : this);
