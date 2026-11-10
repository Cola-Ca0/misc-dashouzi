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

  Object.assign(MDZ, { auditFont, auditSQLite, auditELF, auditPE });
})(typeof globalThis !== 'undefined' ? globalThis : this);
