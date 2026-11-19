/* misc大手子 — 52 其他载体
 * 字体（TTF/OTF/WOFF 目录）、SQLite（页结构 + 尾部）、ELF / PE（段表 + 覆盖数据）
 * 这些在 misc 里出现频率不低，但都只需要"看清结构 + 找夹带"，不需要完整解析。
 */
(function (root) {
  'use strict';
  const MDZ = root.MDZ = root.MDZ || {};
  const { toU8, finding, artifact, hex, ascii } = MDZ;

  const rd16 = (b, o) => (b[o] << 8) | b[o + 1];
  const rd32 = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
  const le16 = (b, o) => b[o] | (b[o + 1] << 8);
  const le32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

  const KNOWN_TABLES = new Set(['cmap', 'head', 'hhea', 'hmtx', 'maxp', 'name', 'OS/2', 'post', 'cvt ', 'fpgm', 'glyf', 'loca', 'prep', 'CFF ', 'CFF2', 'VORG', 'EBDT', 'EBLC', 'EBSC', 'gasp', 'hdmx', 'kern', 'LTSH', 'PCLT', 'VDMX', 'vhea', 'vmtx', 'BASE', 'GDEF', 'GPOS', 'GSUB', 'JSTF', 'MATH', 'CBDT', 'CBLC', 'COLR', 'CPAL', 'SVG ', 'sbix', 'STAT', 'avar', 'fvar', 'gvar', 'HVAR', 'MVAR', 'VVAR', 'DSIG', 'FFTM', 'cvar', 'meta', 'trak']);

  function tailFinding(findings, artifacts, b, end, what) {
    if (!(end > 0) || b.length <= end) return;
    const tr = b.subarray(end);
    const flag = MDZ.flagMatch(ascii(tr, Math.min(tr.length, 4096)));
    findings.push(finding('L1', 'trailer', `${what}之后还有 ${tr.length} 字节`, {
      confidence: flag ? 0.99 : 0.8,
      offset: end,
      declared: `${what}结束于 0x${hex(end)}`,
      actual: flag || ascii(tr, 120),
      detail: '结构之外的数据没人会读，是天然夹带区。已作为产物导出。',
      preview: ascii(tr, 200),
      recipe: `从 0x${hex(end)} 起切出尾部`,
      payload: { name: 'carrier-trailer.bin', bytes: tr.slice(0) }
    }));
    artifacts.push(artifact('carrier-trailer.bin', tr, `${what}之后的尾部数据`));
  }

  // ---------- 字体 ----------
  function auditFont(bytes) {
    const b = toU8(bytes);
    const findings = [], artifacts = [];
    if (b.length < 12) return { findings, artifacts };
    const version = ascii(b.subarray(0, 4), 4);
    const isCollection = version === 'ttcf';
    let sfntOff = 0;
    let numTables = rd16(b, 4);
    if (isCollection) {
      if (b.length < 16) return { findings, artifacts };
      const numFonts = rd32(b, 8);
      sfntOff = rd32(b, 12);
      numTables = rd16(b, sfntOff + 4);
      findings.push(finding('L1', 'font', `字体集合（ttcf），${numFonts} 个字体`, {
        confidence: 0.5, offset: 0, actual: `第一家表目录 @0x${hex(sfntOff)}`
      }));
    }
    const dirOff = sfntOff + 12;   // 表目录紧跟在 sfnt 头（version+numTables+3×uint16）之后
    if (numTables < 1 || numTables > 512) {
      findings.push(finding('L1', 'font', '字体目录异常', { confidence: 0.7, declared: `numTables=${numTables}` }));
      return { findings, artifacts };
    }
    const tables = [];
    let maxEnd = dirOff + numTables * 16;
    for (let i = 0; i < numTables; i++) {
      const o = dirOff + i * 16;
      if (o + 16 > b.length) break;
      const tag = ascii(b.subarray(o, o + 4), 4);
      const off = rd32(b, o + 8), len = rd32(b, o + 12);
      const ok = off + len <= b.length;
      tables.push({ tag, off, len, ok });
      if (ok) maxEnd = Math.max(maxEnd, off + len);
    }
    const bad = tables.filter(t => !t.ok);
    const unknown = tables.filter(t => !KNOWN_TABLES.has(t.tag));
    findings.push(finding('L1', 'font', `字体 ${version} · ${tables.length} 张表`, {
      confidence: 0.4, offset: 0,
      actual: tables.map(t => t.tag).join(' '),
      detail: `表目录 @0x${hex(dirOff)}；` + (unknown.length ? `非常见表：${unknown.map(t => t.tag).join(' ')}` : '全部是标准表'),
      preview: tables.map(t => `${t.tag} off=0x${hex(t.off)} len=${t.len}${t.ok ? '' : ' [越界]'}`).join('\n')
    }));
    if (bad.length) {
      findings.push(finding('L1', 'font', `${bad.length} 张表越界`, {
        confidence: 0.85, actual: bad.map(t => `${t.tag}@0x${hex(t.off)}+${t.len}`).join(' '),
        detail: '表偏移/长度超出文件，可能被裁剪或改过。'
      }));
    }
    if (unknown.length) {
      findings.push(finding('L3', 'font', `非常见表标签：${unknown.map(t => JSON.stringify(t.tag)).join(' ')}`, {
        confidence: 0.55, actual: unknown.map(t => `${t.tag} ${t.len}B`).join(' | '),
        detail: '字体解析器会跳过未知表，正好用来塞东西。'
      }));
    }
    tailFinding(findings, artifacts, b, maxEnd, '最后一张表');
    // 表里/文件里的 flag 字符串
    const all = MDZ.strings(b, 6).join('\n');
    const fm = MDZ.flagMatch(all);
    if (fm) {
      findings.push(finding('L3', 'font', `字体里出现 ${fm}`, {
        confidence: 0.99, actual: fm, preview: all.slice(0, 300), recipe: 'strings 扫整个字体文件'
      }));
    }
    return { findings, artifacts };
  }

  // ---------- SQLite ----------
  // 只看文件头 + strings 会漏掉 UTF-16 库和溢出页里的值，所以这里按 B 树叶页走一遍记录格式。
  function sqliteVarint(b, o) {
    let v = 0;
    for (let i = 0; i < 9; i++) {
      const c = b[o + i];
      if (c === undefined) return null;
      if (i === 8) return { value: v * 256 + c, next: o + 9 };
      v = v * 128 + (c & 0x7f);
      if (!(c & 0x80)) return { value: v, next: o + i + 1 };
    }
    return null;
  }

  function sqliteLocalLen(payloadLen, usable) {
    const maxLocal = usable - 35;
    const minLocal = Math.floor((usable - 12) * 32 / 255) - 23;
    if (payloadLen <= maxLocal) return payloadLen;
    const k = minLocal + ((payloadLen - minLocal) % (usable - 4));
    return k <= maxLocal ? k : minLocal;
  }

  // 记录格式：header 长度 varint + serial type 列表 + body；只取 TEXT 列
  function sqliteRecordTexts(payload, enc) {
    const out = [];
    const h = sqliteVarint(payload, 0);
    if (!h) return out;
    const headerEnd = Math.min(h.value, payload.length);
    let p = h.next;
    const types = [];
    while (p < headerEnd) {
      const t = sqliteVarint(payload, p);
      if (!t) break;
      types.push(t.value);
      p = t.next;
    }
    let body = headerEnd;
    for (const t of types) {
      if (t >= 12) {
        const len = (t - 12) >> 1;
        if (body + len > payload.length) break;
        if (t & 1) {
          let s;
          if (enc === 2) s = MDZ.utf16le(payload.subarray(body, body + len));
          else if (enc === 3) s = MDZ.utf16be(payload.subarray(body, body + len));
          else s = MDZ.utf8(payload.subarray(body, body + len));
          if (s) out.push(s);
        }
        body += len;
        continue;
      }
      const intLen = t >= 1 && t <= 7 ? [0, 1, 2, 3, 4, 6, 8, 8][t] : 0;
      body += intLen;
    }
    return out;
  }

  function sqliteScanRows(b, pageSize, enc, usable) {
    const pages = Math.min(Math.floor(b.length / pageSize), 200000);
    const res = { leaves: 0, rows: 0, texts: [], flags: [] };
    const overflows = new Set();
    for (let pg = 1; pg <= pages; pg++) {
      const base = (pg - 1) * pageSize;
      const hOff = base + (pg === 1 ? 100 : 0);
      if (hOff + 8 > b.length) break;
      const type = b[hOff];
      if (type !== 0x0D && type !== 0x0A) continue;
      res.leaves++;
      const nCells = rd16(b, hOff + 3);
      const idxLeaf = type === 0x0A;
      for (let i = 0; i < nCells && i < 8192; i++) {
        const ptr = hOff + 8 + i * 2;
        if (ptr + 2 > b.length) break;
        const cellOff = base + rd16(b, ptr);
        if (cellOff >= b.length) continue;
        const pl = sqliteVarint(b, cellOff);
        if (!pl || !(pl.value > 0) || pl.value > 16777216) continue;
        let dataStart = pl.next;
        if (!idxLeaf) {
          const rowid = sqliteVarint(b, dataStart);
          if (!rowid) continue;
          dataStart = rowid.next;
        }
        const payloadLen = pl.value;
        const local = sqliteLocalLen(payloadLen, usable);
        if (dataStart + local > b.length) continue;
        let payload;
        if (payloadLen <= local) {
          payload = b.subarray(dataStart, dataStart + payloadLen);
        } else {
          const parts = [b.subarray(dataStart, dataStart + local)];
          let need = payloadLen - local;
          let ovfl = rd32(b, dataStart + local);
          let guard = 0;
          while (ovfl && need > 0 && guard++ < 8192) {
            const off = (ovfl - 1) * pageSize;
            if (off + 4 > b.length) break;
            overflows.add(ovfl);
            const take = Math.min(need, usable - 4, b.length - off - 4);
            if (take <= 0) break;
            parts.push(b.subarray(off + 4, off + 4 + take));
            need -= take;
            ovfl = rd32(b, off);
          }
          const total = payloadLen - Math.max(0, need);
          payload = new Uint8Array(total);
          let o = 0;
          for (const part of parts) { const n = Math.min(part.length, total - o); payload.set(part.subarray(0, n), o); o += n; if (o >= total) break; }
        }
        res.rows++;
        const vals = sqliteRecordTexts(payload, enc);
        for (const v of vals) {
          if (res.texts.length >= 4000) break;
          res.texts.push(v);
          const fs = MDZ.flagFindAll(v);
          for (const f of fs) if (res.flags.indexOf(f) < 0) res.flags.push(f);
        }
        if (res.texts.length >= 4000) break;
      }
      if (res.texts.length >= 4000) break;
    }
    res.overflowPages = overflows.size;
    return res;
  }

  function auditSQLite(bytes) {
    const b = toU8(bytes);
    const findings = [], artifacts = [];
    if (b.length < 100) return { findings, artifacts };
    const psRaw = rd16(b, 16);
    const pageSize = psRaw === 1 ? 65536 : psRaw;
    const pageCount = rd32(b, 28);
    const enc = rd32(b, 56);
    const encName = { 1: 'UTF-8', 2: 'UTF-16le', 3: 'UTF-16be' }[enc] || `#${enc}`;
    const expect = pageSize * pageCount;
    findings.push(finding('L1', 'sqlite', `SQLite 页大小 ${pageSize} · 共 ${pageCount} 页 · ${encName}`, {
      confidence: 0.5, offset: 0,
      declared: `${b.length} 字节`,
      actual: `声明 ${expect} 字节（${pageSize}×${pageCount}）`,
      detail: pageCount ? '页数与文件大小不一致时，多出来的部分通常是夹带。' : '页数为 0（可能是刚建库/被改）。'
    }));
    if (pageCount && expect < b.length) tailFinding(findings, artifacts, b, expect, '数据库页');
    const text = MDZ.strings(b, 6);
    const schema = text.filter(s => /CREATE\s+(TABLE|INDEX|VIEW)|INSERT\s+INTO/i.test(s));
    if (schema.length) {
      findings.push(finding('L3', 'sqlite', `表结构字符串 ${schema.length} 条`, {
        confidence: 0.5, actual: schema.slice(0, 4).join(' | '), preview: schema.slice(0, 20).join('\n'),
        recipe: 'strings 里找 CREATE TABLE / INSERT INTO'
      }));
    }
    const fm = MDZ.flagMatch(text.join('\n'));
    if (fm) findings.push(finding('L3', 'sqlite', `数据库里出现 ${fm}`, { confidence: 0.99, actual: fm, recipe: 'strings 扫整个库' }));
    // 行级扫描：解 B 树叶页里的每条记录，溢出页也跟
    if (pageSize >= 512 && pageSize <= 65536) {
      const usable = pageSize - b[20];
      const rows = sqliteScanRows(b, pageSize, enc, usable);
      if (rows.leaves) {
        findings.push(finding('L2', 'sqlite_rows', `逐行扫描：${rows.leaves} 个叶页 · ${rows.rows} 行 · ${rows.texts.length} 条文本${rows.overflowPages ? ' · ' + rows.overflowPages + ' 个溢出页' : ''}`, {
          confidence: 0.8,
          actual: rows.texts.slice(0, 6).map(t => t.length > 80 ? t.slice(0, 80) + '…' : t).join(' | '),
          detail: '按 SQLite 记录格式（header + serial type）解出文本列；不依赖 strings，所以 UTF-16 库也能读。',
          recipe: 'sqlite3 db "select * from 表名"；或看本工具导出的 sqlite-rows.txt'
        }));
        for (const f of rows.flags.slice(0, 10)) {
          findings.push(finding('L3', 'sqlite_row_flag', `行数据里出现 ${f}`, {
            confidence: 0.99, actual: f, recipe: '逐行扫文本列'
          }));
        }
        if (rows.texts.length) {
          const txt = rows.texts.join('\n').slice(0, 1 << 20);
          const tb = typeof TextEncoder !== 'undefined'
            ? new TextEncoder().encode(txt)
            : Uint8Array.from(txt, c => c.charCodeAt(0) & 255);
          artifacts.push(artifact('sqlite-rows.txt', tb, `SQLite 行文本 ${rows.texts.length} 条`));
        }
      }
    }
    return { findings, artifacts };
  }

  // ---------- ELF ----------
  function auditELF(bytes) {
    const b = toU8(bytes);
    const findings = [], artifacts = [];
    if (b.length < 52) return { findings, artifacts };
    const is64 = b[4] === 2;
    const le = b[5] !== 2;
    const r16 = le ? le16 : rd16, r32 = le ? le32 : rd32;
    const type = r16(b, 16);
    const machine = r16(b, 18);
    const shoff = is64 ? r32(b, 40) : r32(b, 32);   // 只取低 32 位：>4GB 的 ELF 不是这个工具的菜
    const shentsize = r16(b, is64 ? 58 : 46);
    const shnum = r16(b, is64 ? 60 : 48);
    let maxEnd = 0;
    for (let i = 0; i < shnum; i++) {
      const o = shoff + i * shentsize;
      if (o + shentsize > b.length) break;
      const off = is64 ? r32(b, o + 24) : r32(b, o + 16);
      const size = is64 ? r32(b, o + 32) : r32(b, o + 20);
      if (off + size <= b.length) maxEnd = Math.max(maxEnd, off + size);
    }
    findings.push(finding('L1', 'elf', `ELF${is64 ? '64' : '32'} ${le ? 'LE' : 'BE'} · ${shnum} 个节`, {
      confidence: 0.5, offset: 0,
      actual: `type=${type} machine=${machine} sections@0x${hex(shoff)}`,
      detail: maxEnd ? `按节表算，文件有效区到 0x${hex(maxEnd)}` : '节表越界或为空'
    }));
    if (maxEnd) tailFinding(findings, artifacts, b, maxEnd, '最后一个节');
    const text = MDZ.strings(b, 6).join('\n');
    const fm = MDZ.flagMatch(text);
    if (fm) findings.push(finding('L3', 'elf', `ELF 里出现 ${fm}`, { confidence: 0.99, actual: fm, preview: text.slice(0, 300) }));
    return { findings, artifacts };
  }

  // ---------- PE ----------
  function auditPE(bytes) {
    const b = toU8(bytes);
    const findings = [], artifacts = [];
    if (b.length < 0x40) return { findings, artifacts };
    const peOff = le32(b, 0x3c);
    if (peOff + 24 > b.length || b[peOff] !== 0x50 || b[peOff + 1] !== 0x45) {
      findings.push(finding('L1', 'pe', 'MZ 头但 PE 签名不成立', { confidence: 0.6, declared: `e_lfanew=0x${hex(peOff)}` }));
      return { findings, artifacts };
    }
    const machine = le16(b, peOff + 4);
    const nsec = le16(b, peOff + 6);
    const optSize = le16(b, peOff + 20);
    const secStart = peOff + 24 + optSize;
    let maxEnd = secStart;
    const secs = [];
    for (let i = 0; i < nsec; i++) {
      const o = secStart + i * 40;
      if (o + 40 > b.length) break;
      const name = ascii(b.subarray(o, o + 8), 8).replace(/\0+$/, '');
      const rawSize = le32(b, o + 16), rawPtr = le32(b, o + 20);
      secs.push(`${name || '?'}@0x${hex(rawPtr)}+${rawSize}`);
      if (rawPtr + rawSize <= b.length) maxEnd = Math.max(maxEnd, rawPtr + rawSize);
    }
    findings.push(finding('L1', 'pe', `PE · ${nsec} 个节`, {
      confidence: 0.5, offset: peOff, actual: `machine=0x${hex(machine)}`, preview: secs.join('\n')
    }));
    tailFinding(findings, artifacts, b, maxEnd, '最后一个节');
    const text = MDZ.strings(b, 6).join('\n');
    const fm = MDZ.flagMatch(text);
    if (fm) findings.push(finding('L3', 'pe', `PE 里出现 ${fm}`, { confidence: 0.99, actual: fm, preview: text.slice(0, 300) }));
    return { findings, artifacts };
  }

  // ---------- Windows 快捷方式 (.lnk) ----------
  function lnkTime(lo, hi) {
    const v = hi * 0x100000000 + lo;
    if (!v) return '';
    const ms = v / 10000 - 11644473600000;
    const d = new Date(ms);
    return isNaN(d.getTime()) ? '' : d.toISOString().replace('T', ' ').slice(0, 19);
  }
  function lnkUtf16(b, at, chars) {
    let s = '';
    for (let i = 0; i < chars; i++) {
      const o = at + i * 2;
      if (o + 1 >= b.length) break;
      const c = b[o] | (b[o + 1] << 8);
      if (c) s += String.fromCharCode(c);
    }
    return s;
  }

  function auditLNK(input, name) {
    const b = toU8(input);
    const findings = [], artifacts = [];
    if (b.length < 76 || b[0] !== 0x4C) {
      return { findings: [finding('L0', 'format', '不是 LNK', { detail: 'HeaderSize 不是 0x4C 或长度不足' })], artifacts };
    }
    const flags = le32(b, 20);
    const fileSize = le32(b, 52);
    const iconIndex = le32(b, 56);
    const showCmd = le32(b, 60);
    const out = {
      flags, fileSize, iconIndex, showCmd,
      created: lnkTime(le32(b, 28), le32(b, 32)),
      accessed: lnkTime(le32(b, 36), le32(b, 40)),
      written: lnkTime(le32(b, 44), le32(b, 48))
    };
    let p = 76;
    try {
      if (flags & 0x01) {                 // LinkTargetIDList
        if (p + 2 > b.length) throw new Error('IDList 越界');
        const sz = le16(b, p); p += 2 + sz;
        out.idListSize = sz;
        p = Math.min(p, b.length);
      }
      if ((flags & 0x02) && !(flags & 0x100)) {   // LinkInfo
        if (p + 0x1C <= b.length) {
          const size = le32(b, p);
          const lbp = le32(b, p + 16);
          if (lbp && p + lbp < b.length) {
            let e = p + lbp;
            while (e < b.length && b[e]) e++;
            out.localBasePath = ascii(b.subarray(p + lbp, e), e - (p + lbp));
          }
          if (size >= 0x1C && p + size <= b.length) p += size;
        }
      }
      const readStr = () => {
        if (p + 2 > b.length) return '';
        const n = le16(b, p); p += 2;
        const s = lnkUtf16(b, p, n);
        p += n * 2;
        return s;
      };
      if (flags & 0x04) out.nameString = readStr();
      if (flags & 0x08) out.relativePath = readStr();
      if (flags & 0x10) out.workingDir = readStr();
      if (flags & 0x20) out.arguments = readStr();
      if (flags & 0x40) out.iconLocation = readStr();

      const extra = [];
      let guard = 0;
      while (p + 8 <= b.length && guard++ < 64) {
        const size = le32(b, p);
        const sig = le32(b, p + 4);
        if (!size || size < 8) break;
        if (p + size > b.length) { extra.push({ sig, size, truncated: true }); break; }
        // TrackerDataBlock：MachineID(16 字节 UTF-16) + Droid + DroidBirth
        if ((sig >>> 0) === 0xA0000003 && size >= 0x60) out.machineId = lnkUtf16(b, p + 16, 8);
        extra.push({ sig: '0x' + hex(sig >>> 0, 8), size, at: p });
        p += size;
      }
      out.extra = extra;
      out.consumed = p;
    } catch (e) {
      out.parseError = String(e && e.message || e);
    }

    findings.push(finding('L2', 'lnk', 'Windows 快捷方式（LNK）', {
      confidence: 0.95, offset: 0,
      declared: 'flags 0x' + hex(flags >>> 0, 8),
      actual: out.localBasePath || out.relativePath || out.nameString || '（无路径字段）',
      detail: [
        out.arguments ? '参数：' + out.arguments : '',
        out.workingDir ? '工作目录：' + out.workingDir : '',
        out.iconLocation ? '图标：' + out.iconLocation : '',
        out.machineId ? 'TrackerDataBlock 机器名：' + out.machineId : ''
      ].filter(Boolean).join('\n'),
      preview: [out.arguments, out.relativePath, out.localBasePath].filter(Boolean).join(' | ')
    }));
    if (out.arguments) {
      findings.push(finding('L3', 'lnk_args', 'LNK 命令行参数', {
        confidence: 0.9, actual: out.arguments.slice(0, 400), preview: out.arguments
      }));
    }
    if (out.machineId) {
      findings.push(finding('L3', 'lnk_machine', 'LNK 记录的原机器名：' + out.machineId, {
        confidence: 0.85, actual: out.machineId,
        detail: 'TrackerDataBlock 的 MachineID 来自创建者主机，取证题常用来定位设备。'
      }));
    }
    if (out.created || out.written) {
      findings.push(finding('L3', 'lnk_time', 'LNK 时间戳', {
        confidence: 0.6,
        declared: 'FILETIME（UTC）',
        actual: [out.created && '创建 ' + out.created, out.written && '修改 ' + out.written, out.accessed && '访问 ' + out.accessed].filter(Boolean).join(' · ')
      }));
    }
    if (out.extra && out.extra.length) {
      findings.push(finding('L3', 'lnk_extra', `ExtraData ${out.extra.length} 块`, {
        confidence: 0.5,
        actual: out.extra.map(x => x.sig + '(' + x.size + ')').join(', ')
      }));
    }
    if (out.consumed && out.consumed < b.length) {
      const tail = b.subarray(out.consumed);
      findings.push(finding('L2', 'lnk_trailer', `LNK 解析结束后还有 ${tail.length} 字节`, {
        confidence: 0.9, offset: out.consumed,
        detail: '尾部附加是 LNK 题的常见夹带位（base64/CAB/压缩包）。',
        preview: ascii(tail.subarray(0, 160), Math.min(160, tail.length))
      }));
      artifacts.push(artifact('lnk-trailer.bin', tail, 'LNK 尾部附加数据'));
    }
    return { findings, artifacts, image: null, lnk: out };
  }

  // ---------- OLE2 / CFB 复合文档 ----------
  const OLE_SIG = [0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1];
  function auditOLE(input, name) {
    const b = toU8(input);
    const findings = [], artifacts = [];
    if (b.length < 512) return { findings: [finding('L0', 'format', '不是 OLE 复合文档', { detail: '不足 512 字节' })], artifacts };
    for (let i = 0; i < 8; i++) if (b[i] !== OLE_SIG[i]) return { findings: [finding('L0', 'format', '不是 OLE 复合文档', { detail: '签名不符' })], artifacts };

    const major = le16(b, 0x1A);
    const byteOrder = le16(b, 0x1C);
    const sectorShift = le16(b, 0x1E);
    const miniShift = le16(b, 0x20);
    if (byteOrder !== 0xFFFE || (sectorShift !== 9 && sectorShift !== 12) || miniShift !== 6) {
      return { findings: [finding('L0', 'format', 'OLE 头字段非法', { detail: `byteOrder=0x${hex(byteOrder)} shift=${sectorShift}/${miniShift}` })], artifacts };
    }
    const S = 1 << sectorShift;
    const totalSectors = Math.floor(b.length / S) - 1;
    const off = sid => (sid + 1) * S;

    // FAT 扇区列表（DIFAT）
    const fatIds = [];
    for (let i = 0; i < 109; i++) {
      const sid = le32(b, 0x4C + i * 4);
      if (sid <= 0xFFFFFFFA) fatIds.push(sid);
    }
    let difat = le32(b, 0x44);
    let guard = 0;
    while (difat <= 0xFFFFFFFA && guard++ < 100000) {
      const o = off(difat);
      if (o + S > b.length) break;
      const per = S / 4 - 1;
      for (let i = 0; i < per; i++) { const sid = le32(b, o + i * 4); if (sid <= 0xFFFFFFFA) fatIds.push(sid); }
      difat = le32(b, o + per * 4);
    }
    const fat = new Uint32Array(fatIds.length * (S / 4));
    let fi = 0;
    for (const id of fatIds) {
      const o = off(id);
      for (let i = 0; i < S / 4 && o + i * 4 + 4 <= b.length; i++) fat[fi++] = le32(b, o + i * 4);
    }
    const walk = (start, table, cap) => {
      const out = [];
      let sid = start >>> 0;
      while (sid <= 0xFFFFFFFA && out.length < cap && sid < table.length) {
        out.push(sid);
        sid = table[sid] >>> 0;
      }
      return out;
    };
    const chainBuf = (start, size) => {
      const cap = Math.min(size || 0, 64 * 1024 * 1024);
      const sids = walk(start, fat, totalSectors + 1);
      const out = new Uint8Array(cap);
      let o = 0;
      for (const sid of sids) {
        if (o >= out.length) break;
        const so = off(sid);
        const n = Math.min(S, out.length - o, Math.max(0, b.length - so));
        if (n <= 0) break;
        out.set(b.subarray(so, so + n), o); o += n;
      }
      return out;
    };

    // 目录
    const dirSids = walk(le32(b, 0x30), fat, totalSectors + 1);
    const dirBuf = new Uint8Array(dirSids.length * S);
    dirSids.forEach((sid, i) => {
      const so = off(sid);
      const n = Math.max(0, Math.min(S, b.length - so));
      if (n) dirBuf.set(b.subarray(so, so + n), i * S);
    });
    const entries = [];
    for (let p = 0; p + 128 <= dirBuf.length; p += 128) {
      const nameLen = le16(dirBuf, p + 0x40);
      const type = dirBuf[p + 0x42];
      if (!nameLen || type === 0) { entries.push(null); continue; }
      let nm = '';
      for (let i = 0; i + 1 < nameLen - 2; i += 2) {
        const c = dirBuf[p + i] | (dirBuf[p + i + 1] << 8);
        if (c) nm += String.fromCharCode(c);
      }
      let size = le32(dirBuf, p + 0x78);
      if (major >= 4) size += le32(dirBuf, p + 0x7C) * 0x100000000;
      entries.push({
        name: nm, type,
        left: le32(dirBuf, p + 0x44), right: le32(dirBuf, p + 0x48), child: le32(dirBuf, p + 0x4C),
        start: le32(dirBuf, p + 0x74), size
      });
    }
    if (!entries.length || !entries[0]) {
      return { findings: [finding('L0', 'format', 'OLE 目录为空', { detail: '第一个目录项不是 root' })], artifacts };
    }
    const root = entries[0];

    // mini stream / MiniFAT
    const miniSids = walk(le32(b, 0x3C), fat, totalSectors + 1);
    const miniFat = new Uint32Array(miniSids.length * (S / 4));
    let mfi = 0;
    for (const id of miniSids) {
      const o = off(id);
      for (let i = 0; i < S / 4 && o + i * 4 + 4 <= b.length; i++) miniFat[mfi++] = le32(b, o + i * 4);
    }
    const miniBuf = root.size ? chainBuf(root.start, Math.min(root.size, 64 * 1024 * 1024)) : new Uint8Array(0);

    const readStream = e => {
      if (!e.size) return new Uint8Array(0);
      if (e.size < 0x1000 && miniBuf.length) {
        const want = Math.min(e.size, 16 * 1024 * 1024);
        const sids = walk(e.start, miniFat, Math.floor(miniBuf.length / 64) + 1);
        const out = new Uint8Array(want);
        let o = 0;
        for (const sid of sids) {
          if (o >= out.length) break;
          const n = Math.min(64, out.length - o);
          out.set(miniBuf.subarray(sid * 64, sid * 64 + n), o); o += n;
        }
        return out;
      }
      return chainBuf(e.start, Math.min(e.size, 16 * 1024 * 1024));
    };

    // 红黑树遍历
    const streams = [];
    const visited = new Set();
    const visit = (sid, path) => {
      const stack = [sid];
      while (stack.length) {
        const id = stack.pop();
        if (id > 0xFFFFFFFA || visited.has(id)) continue;
        visited.add(id);
        const e = entries[id];
        if (!e) continue;
        stack.push(e.left, e.right);
        if (e.type === 1) visit(e.child, path + e.name + '/');
        else if (e.type === 2) streams.push({ path: path + e.name, entry: e });
      }
    };
    visit(root.child, '');

    findings.push(finding('L2', 'ole', `OLE2 复合文档（v${major}，${streams.length} 个流）`, {
      confidence: 0.95, offset: 0,
      declared: `扇区 ${S} 字节 · FAT ${fatIds.length} 个扇区`,
      actual: streams.map(s => `${s.path}(${s.entry.size})`).join(', ').slice(0, 500),
      detail: '老 Office（doc/xls/ppt）、MSI、Outlook msg 都是这个容器；隐藏流和宏常在这里。'
    }));

    let extracted = 0;
    for (const s of streams) {
      if (extracted >= 32) break;
      if (!s.entry.size) continue;
      let data;
      try { data = readStream(s.entry); } catch (e) { continue; }
      if (!data || !data.length) continue;
      extracted++;
      const safe = s.path.replace(/[^\w.\-]+/g, '_').slice(0, 80);
      artifacts.push(artifact('ole-' + safe, data, `OLE 流（${s.path}，${data.length} 字节）`));
      const head = ascii(data.subarray(0, 64), Math.min(64, data.length)).replace(/[^\x20-\x7e]/g, '.');
      if (/flag|ctf|\{/i.test(head)) {
        findings.push(finding('L3', 'ole_stream', `OLE 流 ${s.path} 疑似含明文`, {
          confidence: 0.7, actual: head, preview: head
        }));
      }
    }
    if (streams.length > 32) {
      findings.push(finding('L3', 'ole_limit', `只提取了前 32 个流（共 ${streams.length} 个）`, {
        confidence: 0.6, detail: '其余流可按名称用 oletools 手工导出。'
      }));
    }
    return { findings, artifacts, image: null, ole: { major, sectorSize: S, streams: streams.map(s => ({ path: s.path, size: s.entry.size })) } };
  }

  // ---------- Git 松散对象 / packfile ----------
  // 松散对象 = zlib("<type> <size>\0" + 内容)；pack 里还要处理 OFS_DELTA。
  function gitLooseObject(input) {
    const b = toU8(input);
    if (b.length < 8 || !MDZ.isZlibHeader(b, 0)) return null;
    const z = MDZ.inflateZlib(b, 0, 64 * 1024 * 1024);
    if (!z.out || !z.out.length) return null;
    const nul = z.out.indexOf(0);
    if (nul <= 0 || nul > 32) return null;
    const head = ascii(z.out.subarray(0, nul), nul);
    const m = head.match(/^(commit|tree|blob|tag) (\d+)$/);
    if (!m) return null;
    return { type: m[1], size: parseInt(m[2], 10), data: z.out.subarray(nul + 1), z };
  }

  function auditGitObject(input, name) {
    const b = toU8(input);
    const obj = gitLooseObject(b);
    if (!obj) return null;
    const findings = [], artifacts = [];
    const text = MDZ.utf8(obj.data) || ascii(obj.data, Math.min(obj.data.length, 65536));
    findings.push(finding('L1', 'git', `Git ${obj.type} 对象 · ${obj.size} 字节`, {
      confidence: 0.95, offset: 0,
      declared: `zlib 压缩 ${b.length} 字节`,
      actual: `解出 ${obj.data.length} 字节明文`,
      detail: '松散对象 = zlib("<type> <size>\\0" + 内容)，直接解开就是原始文件/提交信息。',
      preview: text.slice(0, 400),
      recipe: `python -c "import zlib;print(zlib.decompress(open('${(name || 'obj').replace(/'/g, '')}','rb').read()))"`
    }));
    for (const f of MDZ.flagFindAll(text).slice(0, 10)) {
      findings.push(finding('L3', 'git_flag', `Git 对象里出现 ${f}`, {
        confidence: 0.99, actual: f, preview: text.slice(0, 300)
      }));
    }
    artifacts.push(artifact(`git-${obj.type}.bin`, obj.data, `Git ${obj.type} 解压内容`));
    return { findings, artifacts, image: null };
  }

  function gitPackVarint(b, p) {
    let c = b[p++];
    if (c === undefined) return null;
    let size = c & 0x0f;
    const type = (c >> 4) & 7;
    let shift = 4;
    while (c & 0x80) {
      c = b[p++];
      if (c === undefined) return null;
      size |= (c & 0x7f) << shift;
      shift += 7;
    }
    return { type, size, next: p };
  }

  function gitDeltaApply(base, delta) {
    let p = 0;
    const readV = () => {
      let v = 0, shift = 0, c;
      do { c = delta[p++]; if (c === undefined) return -1; v |= (c & 0x7f) << shift; shift += 7; } while (c & 0x80);
      return v;
    };
    const baseSize = readV(), resultSize = readV();
    if (baseSize !== base.length || resultSize < 0 || resultSize > 64 * 1024 * 1024) return null;
    const out = new Uint8Array(resultSize);
    let o = 0;
    while (p < delta.length && o < resultSize) {
      const c = delta[p++];
      if (c & 0x80) {
        let off = 0, size = 0;
        if (c & 1) off |= delta[p++];
        if (c & 2) off |= delta[p++] << 8;
        if (c & 4) off |= delta[p++] << 16;
        if (c & 8) off |= delta[p++] << 24;
        if (c & 16) size |= delta[p++];
        if (c & 32) size |= delta[p++] << 8;
        if (c & 64) size |= delta[p++] << 16;
        if (size === 0) size = 0x10000;
        if (off + size > base.length || o + size > out.length) return null;
        out.set(base.subarray(off, off + size), o);
        o += size;
      } else {
        if (c === 0) break;
        if (p + c > delta.length || o + c > out.length) return null;
        out.set(delta.subarray(p, p + c), o);
        o += c; p += c;
      }
    }
    return o === resultSize ? out : null;
  }

  function auditGitPack(input, name) {
    const b = toU8(input);
    const findings = [], artifacts = [];
    if (b.length < 12) return { findings: [finding('L0', 'git_pack', 'pack 头不完整')], artifacts };
    const version = rd32(b, 4), count = rd32(b, 8);
    findings.push(finding('L1', 'git_pack', `Git packfile v${version} · ${count} 个对象`, {
      confidence: 0.95, offset: 0,
      declared: `${count} 个对象`,
      actual: `${b.length} 字节`,
      detail: '对象按 [type+size varint][zlib 数据] 排列；OFS_DELTA 会在 pack 内部按偏移找基底。',
      recipe: 'git verify-pack -v <file.idx>；或 git cat-file --batch-all-objects'
    }));
    const TYPE = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag', 6: 'ofs-delta', 7: 'ref-delta' };
    const hist = {}, flags = [], seen = new Set();
    const byOffset = new Map();
    const limit = Math.min(count, 50000);
    let p = 12, done = 0, deltaOk = 0, deltaFail = 0, totalOut = 0, artifactsOut = 0;
    while (p < b.length && done < limit) {
      const objOff = p;
      const h = gitPackVarint(b, p);
      if (!h || !h.type) break;
      p = h.next;
      let base = null;
      if (h.type === 6) {
        let c = b[p++], off = c & 0x7f;
        while (c & 0x80) { c = b[p++]; off = ((off + 1) << 7) | (c & 0x7f); }
        base = byOffset.get(objOff - off) || null;
      } else if (h.type === 7) {
        p += 20;   // REF_DELTA：基底可能不在本 pack，按 SHA 索引超出这里的能力
      }
      const z = MDZ.inflateZlib(b, p, Math.max(Math.min(h.size * 2, 64 * 1024 * 1024), 1 << 20));
      if (!z.out || !z.consumed) { deltaFail++; break; }
      p += z.consumed;
      let data = z.out, type = TYPE[h.type] || ('type' + h.type);
      if (h.type >= 1 && h.type <= 4) {
        data = z.out.subarray(0, Math.min(h.size, z.out.length));
      } else if (h.type === 6) {
        if (!base) { deltaFail++; done++; continue; }
        const merged = gitDeltaApply(base.data, z.out);
        if (!merged) { deltaFail++; done++; continue; }
        data = merged; type = base.type; deltaOk++;
      } else if (h.type === 7) {
        // 基底可能在别的 pack；至少把 delta 里的字面量（insert 段）扫一遍
        const dtext = MDZ.utf8(z.out) || ascii(z.out, Math.min(z.out.length, 65536));
        for (const f of MDZ.flagFindAll(dtext)) {
          if (!seen.has(f)) { seen.add(f); flags.push(f); }
        }
        deltaFail++; done++; continue;
      }
      byOffset.set(objOff, { type, data });
      hist[type] = (hist[type] || 0) + 1;
      totalOut += data.length;
      if (type !== 'tree') {
        const text = MDZ.utf8(data) || ascii(data, Math.min(data.length, 65536));
        const found = MDZ.flagFindAll(text);
        for (const f of found) {
          if (!seen.has(f)) { seen.add(f); flags.push(f); }
        }
        if (artifactsOut < 24 && (type === 'commit' || type === 'tag')) {
          artifacts.push(artifact(`git-pack-${done + 1}-${type}.txt`, data.subarray(0, 262144), `Git ${type} 对象`));
          artifactsOut++;
        } else if (artifactsOut < 24 && type === 'blob') {
          const dt = MDZ.detectType(data);
          const interesting = found.length > 0 || (dt.format !== 'unknown' && dt.format !== 'TEXT');
          if (interesting) {
            artifacts.push(artifact(`git-pack-${done + 1}-blob.bin`, data.subarray(0, 4 * 1024 * 1024), 'Git blob（看起来是文件/含 flag）'));
            artifactsOut++;
          }
        }
      }
      done++;
      if (totalOut > 128 * 1024 * 1024) {
        findings.push(finding('L1', 'git_limit', '解压总量超过 128MB，提前停止', {
          confidence: 0.6, detail: '用 git verify-pack 看剩余对象。'
        }));
        break;
      }
    }
    findings.push(finding('L2', 'git_objects', `解出 ${done} 个对象${deltaOk ? '（应用 ' + deltaOk + ' 个 delta）' : ''}`, {
      confidence: 0.85,
      actual: Object.keys(hist).map(k => `${k} ${hist[k]}`).join(' · ') || '无',
      preview: Object.keys(hist).map(k => `${k}: ${hist[k]}`).join('\n')
    }));
    for (const f of flags.slice(0, 10)) {
      findings.push(finding('L3', 'git_flag', `pack 内容里出现 ${f}`, { confidence: 0.99, actual: f }));
    }
    if (deltaFail) {
      findings.push(finding('L1', 'git_delta_skip', `${deltaFail} 个 delta 没能还原`, {
        confidence: 0.7,
        detail: 'REF_DELTA 的基底在别的 pack 里时需要按 SHA 建索引；本工具只还原同 pack 内引用的 OFS_DELTA。',
        recipe: 'git cat-file --batch-all-objects --batch-check、git unpack-objects'
      }));
    }
    return { findings, artifacts };
  }

  // ---------- Java class ----------
  // 常量池 UTF-8 项里常带源码名、方法名、硬编码字符串（flag 就在这）。
  function auditJavaClass(input, name) {
    const b = toU8(input);
    const findings = [], artifacts = [];
    if (b.length < 10) return { findings: [finding('L0', 'format', 'Java class 太短')], artifacts, image: null };
    const minor = rd16(b, 4), major = rd16(b, 6), cpCount = rd16(b, 8);
    let p = 10;
    const utf8s = [];
    let broken = '';
    for (let i = 1; i < cpCount; i++) {
      const tag = b[p++];
      if (p > b.length) { broken = 'constant pool 越界'; break; }
      if (tag === 1) {
        const len = rd16(b, p); p += 2;
        if (p + len > b.length) { broken = 'UTF-8 常量越界'; break; }
        const s = MDZ.utf8(b.subarray(p, p + len)) || ascii(b.subarray(p, p + len), len);
        if (s) utf8s.push(s);
        p += len;
      } else if (tag === 3 || tag === 4) p += 4;
      else if (tag === 5 || tag === 6) { p += 8; i++; }
      else if (tag === 7 || tag === 8 || tag === 16 || tag === 19 || tag === 20) p += 2;
      else if (tag === 9 || tag === 10 || tag === 11 || tag === 12 || tag === 17 || tag === 18) p += 4;
      else if (tag === 15) p += 3;
      else { broken = '未知常量池 tag ' + tag; break; }
    }
    if (broken) {
      findings.push(finding('L1', 'java_cp', '常量池解析中断：' + broken, {
        confidence: 0.8, actual: `已读 ${utf8s.length} 条 UTF-8 常量`
      }));
    }
    const flags = MDZ.flagFindAll(utf8s.join('\n'));
    findings.push(finding('L1', 'java', `Java class · ${major}.${minor} · 常量池 ${Math.max(0, cpCount - 1)} 项 · UTF-8 ${utf8s.length} 条`, {
      confidence: 0.9, offset: 0,
      actual: flags.length ? flags.slice(0, 5).join(' | ') : utf8s.slice(0, 8).join(' | '),
      preview: utf8s.slice(0, 40).join('\n'),
      detail: '常量池 UTF-8 项包含类名、方法名、字段名与硬编码字符串；flag 经常直接躺在这里。',
      recipe: 'javap -v -p ClassName.class / jadx-gui / strings | grep flag'
    }));
    for (const f of flags.slice(0, 10)) {
      findings.push(finding('L3', 'java_flag', `常量池里出现 ${f}`, { confidence: 0.99, actual: f }));
    }
    const txt = utf8s.join('\n').slice(0, 1 << 20);
    const tb = typeof TextEncoder !== 'undefined'
      ? new TextEncoder().encode(txt)
      : Uint8Array.from(txt, c => c.charCodeAt(0) & 255);
    artifacts.push(artifact('java-strings.txt', tb, 'Java 常量池字符串'));
    return { findings, artifacts, image: null, parsed: { major, minor, cpCount, utf8s } };
  }

  Object.assign(MDZ, { auditFont, auditSQLite, auditELF, auditPE, auditLNK, auditOLE, auditGitObject, auditGitPack, auditJavaClass });
})(typeof globalThis !== 'undefined' ? globalThis : this);
