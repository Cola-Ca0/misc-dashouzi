/* misc大手子 — 55 归档：TAR / RAR / 7Z
 * 目标不是完整解压（RAR 压缩算法、7z 的 LZMA2 都不现实），而是：
 *   TAR：成员遍历 + 全部成员直接取出（tar 本身不压缩）
 *   RAR：RAR4/RAR5 头解析改名 + 加密检测 + stored 成员取出
 *   7Z ：头部解析、文件表（未压缩头）、加密检测；压缩头给出明确提示
 */
(function (root) {
  'use strict';
  const MDZ = root.MDZ = root.MDZ || {};
  const { toU8, ascii, cstr, hex, finding, artifact } = MDZ;

  const le16 = (b, o) => b[o] | (b[o + 1] << 8);
  const le32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
  const u64 = (b, o) => le32(b, o) + le32(b, o + 4) * 4294967296;
  const be32 = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;

  // ---------- TAR ----------
  function tarChecksumOk(h) {
    const want = tarNum(h.subarray(148, 156));
    if (want === null) return false;
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += (i >= 148 && i < 156) ? 32 : h[i];
    return sum === want;
  }

  // tar 的数字字段：八进制（前后空格/NUL），或 GNU base-256
  function tarNum(buf) {
    if (buf[0] & 0x80) {
      let v = buf[0] & 0x7f;
      for (let i = 1; i < buf.length; i++) v = v * 256 + buf[i];
      return v;
    }
    let s = '';
    for (let i = 0; i < buf.length; i++) {
      const c = buf[i];
      if (c === 0 || c === 32) { if (s) break; continue; }
      if (c < 48 || c > 55) return null;
      s += String.fromCharCode(c);
    }
    return s ? parseInt(s, 8) : 0;
  }

  function isTAR(input) {
    const b = toU8(input);
    if (b.length < 512) return false;
    if (ascii(b.subarray(257, 262), 5) === 'ustar') return true;
    // 旧 tar 没有 ustar：用头校验和兜底
    return tarChecksumOk(b.subarray(0, 512));
  }

  function auditTAR(input, name) {
    const b = toU8(input);
    const findings = [], artifacts = [];
    const entries = [];
    let off = 0, guard = 0, longName = null, totalOut = 0;
    while (off + 512 <= b.length && guard++ < 4096) {
      const h = b.subarray(off, off + 512);
      let zero = true;
      for (let i = 0; i < 512; i++) if (h[i]) { zero = false; break; }
      if (zero) { off += 512; continue; }
      if (!tarChecksumOk(h)) {
        findings.push(finding('L1', 'tar', 'TAR 头校验和不符，停止解析', {
          confidence: 0.8, offset: off,
          detail: '可能不是 TAR，或中间被截断/拼接。后面的数据仍会走通用扫描。'
        }));
        break;
      }
      const nameB = h.subarray(0, 100);
      const size = tarNum(h.subarray(124, 136)) || 0;
      const type = h[156] ? String.fromCharCode(h[156]) : '0';
      const magic = ascii(h.subarray(257, 262), 5);
      const prefix = magic === 'ustar' ? cstr(h.subarray(345, 500)) : '';
      const localName = cstr(nameB) || ascii(nameB, nameB.length);
      const fullName = (prefix ? prefix.replace(/\/$/, '') + '/' : '') + localName;
      const ds = off + 512;
      const dl = Math.max(0, Math.min(size, b.length - ds));
      if (type === 'L') {
        longName = cstr(b.subarray(ds, ds + dl));
      } else if (type === 'x') {
        const m = /(?:^|\n)\d+ path=([^\n]+)/.exec(ascii(b.subarray(ds, ds + dl), dl));
        if (m) longName = m[1];
      } else if (type === '5') {
        entries.push({ name: fullName + '/', size: 0, type: 'dir' });
      } else if (type === '2') {
        entries.push({ name: fullName, size: 0, type: 'symlink', link: cstr(h.subarray(157, 257)) });
      } else if (type === '0' || type === '7' || type === '\u0000') {
        const nm = longName || fullName;
        longName = null;
        entries.push({ name: nm, size, type: 'file' });
        if (dl > 0 && totalOut + dl <= 32 * 1024 * 1024) {
          artifacts.push(artifact('tar-' + (nm.split('/').pop() || 'entry'), b.subarray(ds, ds + dl), 'TAR 成员'));
          totalOut += dl;
        }
      }
      off = ds + Math.ceil(size / 512) * 512;
    }
    if (!entries.length) {
      findings.push(finding('L1', 'tar', 'TAR 里没有解析出成员', { confidence: 0.5, detail: '可能是空包或头已损坏。' }));
    } else {
      const dirs = entries.filter(e => e.type === 'dir').length;
      findings.push(finding('L1', 'tar', `TAR：${entries.length} 个成员`, {
        confidence: 0.9, offset: 0,
        declared: `${entries.length - dirs} 个文件 / ${dirs} 个目录`,
        actual: entries.slice(0, 10).map(e => e.name).join(' | '),
        detail: 'TAR 不压缩，成员已经作为产物取出；嵌套容器会继续递归分析。',
        preview: entries.map(e => `${e.name}${e.size ? ' (' + e.size + 'B)' : ''}`).join('\n'),
        recipe: 'tar -tvf <file>'
      }));
    }
    return { findings, artifacts, image: null, parsed: { entries } };
  }

  // ---------- RAR ----------
  function isRAR(input) {
    const b = toU8(input);
    if (b.length < 7) return false;
    return b[0] === 0x52 && b[1] === 0x61 && b[2] === 0x72 && b[3] === 0x21 && b[4] === 0x1A && b[5] === 0x07;
  }

  const rar4Method = m => (m === 0x30 ? 'stored' : 'rar');

  function auditRAR4(b, findings, artifacts) {
    let off = 7, guard = 0;
    const entries = [];
    let totalOut = 0;
    while (off + 7 <= b.length && guard++ < 4096) {
      const type = b[off + 2];
      const flags = le16(b, off + 3);
      const headSize = le16(b, off + 5);
      if (headSize < 7 || off + headSize > b.length) break;
      if (type === 0x74) {                      // 文件头
        const p = off + 7;
        if (p + 25 > b.length) break;
        const packSize = le32(b, p);
        const unpSize = le32(b, p + 4);
        const method = b[p + 18];
        const nameLen = le16(b, p + 19);
        const nameStart = p + 25;
        if (nameStart + nameLen > b.length) break;
        let nameB = b.subarray(nameStart, nameStart + nameLen);
        // 0x200 = unicode：名字里有压缩编码，先按 latin1 兜底
        const name = cstr(nameB) || ascii(nameB, nameB.length);
        const encrypted = !!(flags & 0x01);
        const isDir = !!(flags & 0x08);
        let dataStart = off + headSize;
        let realPack = packSize;
        if (flags & 0x100) {                    // 大文件：HIGH_PACK_SIZE 在名字之后
          const hp = nameStart + nameLen;
          if (hp + 8 <= b.length) {
            realPack = le32(b, hp) * 4294967296 + packSize;
            dataStart = off + headSize + 4;      // 头部多两对 4 字节
            dataStart = off + headSize;
          }
        }
        entries.push({ name, size: unpSize, packSize: realPack, method: rar4Method(method), encrypted, dir: isDir });
        if (!encrypted && !isDir && method === 0x30 && realPack > 0 && dataStart + realPack <= b.length && totalOut + realPack <= 32 * 1024 * 1024) {
          artifacts.push(artifact('rar-' + (name.split('/').pop() || 'entry'), b.subarray(dataStart, dataStart + realPack), 'RAR stored 成员'));
          totalOut += realPack;
        }
        off = off + headSize + realPack;
        continue;
      }
      if (type === 0x7B) break;                 // 结束块
      let add = 0;
      if (flags & 0x8000) { if (off + 11 > b.length) break; add = le32(b, off + 7); }
      off += headSize + add;
    }
    return entries;
  }

  // RAR5 的 vint（7 位一组，最高位继续）
  function rar5Vint(b, p) {
    let v = 0, shift = 0, n = 0;
    while (p + n < b.length && n < 10) {
      const c = b[p + n++];
      v += (c & 0x7F) * Math.pow(2, shift);
      shift += 7;
      if (!(c & 0x80)) return { value: v, size: n };
    }
    return null;
  }

  function auditRAR5(b, findings, artifacts) {
    const entries = [];
    let off = 8, guard = 0;
    let encryptedHeader = false;
    while (off + 6 <= b.length && guard++ < 4096) {
      const headSize = rar5Vint(b, off + 4);
      if (!headSize) break;
      const bodyStart = off + 4 + headSize.size;
      const bodyEnd = bodyStart + headSize.value;
      if (bodyEnd > b.length) break;
      let q = bodyStart;
      const type = rar5Vint(b, q); if (!type) break; q += type.size;
      const flags = rar5Vint(b, q); if (!flags) break; q += flags.size;
      let extraSize = 0, dataSize = 0;
      if (flags.value & 0x0001) { const x = rar5Vint(b, q); if (!x) break; extraSize = x.value; q += x.size; }
      if (flags.value & 0x0002) { const x = rar5Vint(b, q); if (!x) break; dataSize = x.value; q += x.size; }
      if (type.value === 4) encryptedHeader = true;       // 加密头块
      if (type.value === 2) {                              // 文件头
        const fflags = rar5Vint(b, q); if (!fflags) break; q += fflags.size;
        const unp = rar5Vint(b, q); if (!unp) break; q += unp.size;
        const attr = rar5Vint(b, q); if (!attr) break; q += attr.size;
        if (fflags.value & 0x0002) q += 4;                 // mtime
        if (fflags.value & 0x0004) q += 4;                 // crc32
        const comp = rar5Vint(b, q); if (!comp) break; q += comp.size;
        const host = rar5Vint(b, q); if (!host) break; q += host.size;
        const nameLen = rar5Vint(b, q); if (!nameLen) break; q += nameLen.size;
        if (q + nameLen.value > b.length) break;
        const nameB = b.subarray(q, q + nameLen.value);
        const name = MDZ.utf8(nameB) || ascii(nameB, nameB.length);
        const method = comp.value & 0x3F;
        entries.push({ name, size: unp.value, packSize: dataSize, method: method === 0 ? 'stored' : 'rar5', encrypted: encryptedHeader, dir: !!(fflags.value & 0x0001) });
        if (method === 0 && dataSize > 0 && bodyEnd + dataSize <= b.length && name) {
          artifacts.push(artifact('rar-' + (name.split('/').pop() || 'entry'), b.subarray(bodyEnd, bodyEnd + dataSize), 'RAR5 stored 成员'));
        }
      }
      off = bodyEnd + dataSize;
    }
    return { entries, encryptedHeader };
  }

  function auditRAR(input, name) {
    const b = toU8(input);
    const findings = [], artifacts = [];
    const isV5 = b.length >= 8 && b[6] === 0x01 && b[7] === 0x00;
    let entries = [], encryptedHeader = false;
    try {
      if (isV5) { const r = auditRAR5(b, findings, artifacts); entries = r.entries; encryptedHeader = r.encryptedHeader; }
      else entries = auditRAR4(b, findings, artifacts);
    } catch (e) {
      findings.push(finding('L1', 'rar', 'RAR 头解析中断', { confidence: 0.6, detail: String(e && e.message || e) }));
    }
    if (!entries.length) {
      findings.push(finding('L1', 'rar', 'RAR 容器（未解析出成员）', {
        confidence: 0.6,
        detail: (isV5 ? 'RAR5' : 'RAR4') + ' 头解析没有拿到文件表；可能用了加密头或非标准分卷。可以试 unrar l。',
        recipe: 'unrar l <file.rar>'
      }));
    } else {
      const enc = entries.filter(e => e.encrypted).length;
      findings.push(finding('L1', 'rar', `RAR${isV5 ? '5' : ''}：${entries.length} 个成员${enc ? '（' + enc + ' 个加密）' : ''}`, {
        confidence: 0.9, offset: 0,
        declared: entries.map(e => e.name).slice(0, 8).join(' | '),
        actual: encryptedHeader ? '加密头（连文件名都看不到）' : '文件表可读',
        detail: 'RAR 的压缩算法不实现；stored（不压缩）成员会直接取出来。加密包可试 john/hashcat 或 ARCHPR。',
        preview: entries.map(e => `${e.name}  ${e.size}B  ${e.method}${e.encrypted ? '  [enc]' : ''}`).join('\n'),
        recipe: 'unrar x <file.rar>'
      }));
    }
    return { findings, artifacts, image: null, parsed: { entries, v5: isV5 } };
  }

  // ---------- 7Z ----------
  function is7Z(input) {
    const b = toU8(input);
    return b.length >= 6 && b[0] === 0x37 && b[1] === 0x7A && b[2] === 0xBC && b[3] === 0xAF && b[4] === 0x27 && b[5] === 0x1C;
  }

  function sevenVint(b, p) {
    let v = 0, shift = 0, n = 0;
    while (p + n < b.length && n < 9) {
      const c = b[p + n++];
      v += (c & 0x7F) * Math.pow(2, shift);
      shift += 7;
      if (!(c & 0x80)) return { value: v, size: n };
    }
    return null;
  }

  function sevenU64(b, p) { return le32(b, p) + le32(b, p + 4) * 4294967296; }

  // 只认未压缩的 kHeader：kFilesInfo 里取文件名（UTF-16LE）
  function parse7zNames(hdr, start) {
    const names = [];
    let p = start;
    if (hdr[p] !== 0x01) return null;                 // kHeader
    p++;
    let guard = 0;
    while (p < hdr.length && guard++ < 64) {
      const id = hdr[p++];
      if (id === 0x00) break;                          // kEnd
      if (id === 0x02) {                               // kArchiveProperties
        while (p < hdr.length) {
          const t = hdr[p++];
          if (t === 0x00) break;
          const sz = sevenVint(hdr, p); if (!sz) return names;
          p += sz.size + sz.value;
        }
      } else if (id === 0x04 || id === 0x03) {         // kMainStreamsInfo / kAdditionalStreamsInfo
        const sz = sevenVint(hdr, p); if (!sz) break;
        p += sz.size + sz.value;
      } else if (id === 0x05) {                         // kFilesInfo
        const num = sevenVint(hdr, p); if (!num) break;
        p += num.size;
        let guard2 = 0;
        while (p < hdr.length && guard2++ < 64) {
          const prop = hdr[p++];
          if (prop === 0x00) break;
          const sz = sevenVint(hdr, p); if (!sz) return names;
          p += sz.size;
          const bodyStart = p;
          if (prop === 0x11) {                          // kName
            const external = hdr[bodyStart];
            if (!external) {
              // sz.value 是文件里声明的长度，头部被改坏时能到 2^63：
              // 不夹到 hdr.length 的话，内层循环对着越界字节转上几十亿次，直接卡死。
              let q = bodyStart + 1;
              const end = Math.min(bodyStart + sz.value, hdr.length);
              while (q + 1 < end) {
                let s = '';
                while (q + 1 < end) {
                  const ch = hdr[q] | (hdr[q + 1] << 8);
                  q += 2;
                  if (!ch) break;
                  s += String.fromCharCode(ch);
                }
                if (s) names.push(s);
              }
            }
          }
          p = Math.min(bodyStart + sz.value, hdr.length);
        }
      } else {
        const sz = sevenVint(hdr, p);
        if (!sz) break;
        p += sz.size + sz.value;
      }
    }
    return names;
  }

  function audit7Z(input, name) {
    const b = toU8(input);
    const findings = [], artifacts = [];
    if (b.length < 32) return { findings: [finding('L0', 'format', '不是 7Z', { detail: '头太短' })], artifacts, image: null };
    const nextOff = sevenU64(b, 12);
    const nextSize = sevenU64(b, 20);
    const hdrStart = 32 + nextOff;
    let names = null, encoded = false;
    if (hdrStart + nextSize <= b.length && nextSize < 64 * 1024 * 1024) {
      const hdr = b.subarray(hdrStart, hdrStart + nextSize);
      if (hdr[0] === 0x17) encoded = true;            // kEncodedHeader（压缩过的头）
      else names = parse7zNames(hdr, 0);
    }
    if (names && names.length) {
      findings.push(finding('L1', '7z', `7Z：${names.length} 个文件`, {
        confidence: 0.9, offset: 0,
        declared: names.slice(0, 8).join(' | '),
        actual: `${nextSize} 字节的未压缩文件表`,
        detail: '7z 的压缩算法（LZMA2/BCJ）暂不实现；文件表已经解出来，内容可用 7z x 展开。',
        preview: names.join('\n'),
        recipe: '7z l <file.7z>'
      }));
    } else {
      findings.push(finding('L1', '7z', encoded ? '7Z 容器（头部被压缩）' : '7Z 容器（未解析出文件表）', {
        confidence: 0.7, offset: 0,
        declared: `${b.length} 字节`,
        actual: encoded ? 'kEncodedHeader（LZMA2 压缩头）' : '未知布局',
        detail: '7z 的文件表通常被 LZMA2 压缩，工具暂不实现该解码器；至少可以确认容器身份与是否加密。',
        recipe: '7z l <file.7z>'
      }));
    }
    return { findings, artifacts, image: null, parsed: { names, encoded } };
  }

  // ---------- bzip2 ----------
  function auditBzip2(input, name) {
    const b = toU8(input);
    const z = MDZ.inflateBzip2(b, 0, 64 * 1024 * 1024);
    const findings = [], artifacts = [];
    if (!z.out || !z.out.length) {
      findings.push(finding('L0', 'bzip2', 'bzip2 解压失败', {
        confidence: 0.9, detail: z.error || '没有产出'
      }));
      return { findings, artifacts, image: null, parsed: z };
    }
    const out = z.out;
    findings.push(finding('L1', 'bzip2', `bzip2 解压（${z.blocks} 块，${out.length} 字节）`, {
      confidence: 0.85,
      declared: `块大小 ${b[3] - 48}00k`,
      actual: `${out.length} 字节`,
      detail: (z.crcOk ? '块 CRC 校验通过。' : '块 CRC 不匹配：数据可能被改过。')
        + (z.error ? ' 解码在中途停止：' + z.error : ''),
      preview: ascii(out, 120)
    }));
    artifacts.push(artifact('bzip2-out.bin', out, 'bzip2 解压产物' + (z.error ? ' · 部分' : '')));
    return { findings, artifacts, image: null, parsed: z };
  }

  // ---------- ISO9660 ----------
  // 主卷描述符在扇区 16；目录记录里 ext attr 之后的 extent 就是文件数据。
  // Joliet 用 supplementary volume descriptor 的 UTF-16BE 文件名。
  function isoRecord(b, off, end) {
    if (off + 33 > end || off + 33 > b.length) return null;
    const len = b[off];
    if (len < 34 || off + len > end || off + len > b.length) return null;
    const nameLen = b[off + 32];
    if (33 + nameLen > len) return null;
    return {
      len,
      lba: le32(b, off + 2) + b[off + 1],
      size: le32(b, off + 10),
      flags: b[off + 25],
      nameBytes: b.subarray(off + 33, off + 33 + nameLen)
    };
  }

  function isoName(rec, joliet) {
    const n = rec.nameBytes;
    if (n.length === 1 && n[0] === 0) return '.';
    if (n.length === 1 && n[0] === 1) return '..';
    let s;
    if (joliet) {
      s = '';
      for (let i = 0; i + 1 < n.length; i += 2) s += String.fromCharCode((n[i] << 8) | n[i + 1]);
    } else {
      s = ascii(n, n.length);
    }
    return s.replace(/;1$/, '').replace(/\.$/, '');
  }

  function isoWalk(b, blockSize, lba, size, prefix, out, depth, seen, joliet) {
    if (depth > 12 || out.length >= 2000) return;
    const key = lba + ':' + size;
    if (seen.has(key)) return;
    seen.add(key);
    const start = lba * blockSize;
    const end = Math.min(start + size, b.length);
    let p = start;
    while (p + 33 <= end && out.length < 2000) {
      const len = b[p];
      if (len === 0) { p = (Math.floor(p / blockSize) + 1) * blockSize; continue; }
      if (len < 34 || p + len > end) break;
      const rec = isoRecord(b, p, end);
      if (!rec) break;
      const nm = isoName(rec, joliet);
      if (nm && nm !== '.' && nm !== '..') {
        const path = prefix ? prefix + '/' + nm : nm;
        if (rec.flags & 0x02) isoWalk(b, blockSize, rec.lba, rec.size, path, out, depth + 1, seen, joliet);
        else out.push({ path, lba: rec.lba, size: rec.size });
      }
      p += len;
    }
  }

  function auditISO(input, name) {
    const b = toU8(input);
    const findings = [], artifacts = [];
    if (b.length < 17 * 2048) return { findings: [finding('L0', 'format', 'ISO 不足 17 个扇区')], artifacts, image: null };
    let pvd = -1, svd = -1;
    for (let sec = 16; sec < 48 && sec * 2048 + 7 <= b.length; sec++) {
      const off = sec * 2048;
      if (ascii(b.subarray(off + 1, off + 6), 5) !== 'CD001') continue;
      if (b[off] === 1 && pvd < 0) pvd = off;
      else if (b[off] === 2 && svd < 0) svd = off;
      else if (b[off] === 255) break;
    }
    if (pvd < 0) return { findings: [finding('L0', 'format', '找不到 ISO 主卷描述符')], artifacts, image: null };
    const blockSize = le16(b, pvd + 128) || 2048;
    const volBlocks = le32(b, pvd + 80);
    const volId = ascii(b.subarray(pvd + 40, pvd + 72), 32).replace(/\s+$/, '');
    const sysId = ascii(b.subarray(pvd + 8, pvd + 40), 32).replace(/\s+$/, '');
    const joliet = svd >= 0 && ascii(b.subarray(svd + 88, svd + 90), 2) === '%/';
    const rootOff = (joliet ? svd : pvd) + 156;
    const root = isoRecord(b, rootOff, rootOff + 4096);
    if (!root) return { findings: [finding('L0', 'format', 'ISO 根目录记录无效')], artifacts, image: null };
    const files = [];
    isoWalk(b, blockSize, root.lba, root.size, '', files, 0, new Set(), joliet);
    findings.push(finding('L1', 'iso', `ISO9660 · ${volId || '(无卷标)'} · ${blockSize} 字节/块 · ${volBlocks} 块 · ${files.length} 个文件`, {
      confidence: 0.95, offset: 16 * 2048,
      declared: `卷空间 ${volBlocks} 块（${volBlocks * blockSize} 字节）`,
      actual: `文件 ${files.length} 个${joliet ? '，Joliet UTF-16 文件名' : ''}`,
      detail: `System ID: ${sysId || '(空)'}；主卷描述符 @ 0x${hex(pvd)}${svd >= 0 ? '，补充卷 @ 0x' + hex(svd) : ''}`,
      recipe: '7z l image.iso / isoinfo -l -i image.iso'
    }));
    if (files.length) {
      findings.push(finding('L2', 'iso_files', `ISO 文件列表（${files.length} 个）`, {
        confidence: 0.7,
        actual: files.slice(0, 6).map(f => `${f.path} (${f.size})`).join(' | '),
        preview: files.slice(0, 40).map(f => `${f.path}  ${f.size} 字节  LBA ${f.lba}`).join('\n'),
        detail: '文件数据按目录记录里的 LBA 直接切出，小文件已作为产物导出。'
      }));
    }
    const seenFlags = new Set();
    const addFlag = (f, where) => {
      if (!f || seenFlags.has(f)) return;
      seenFlags.add(f);
      findings.push(finding('L3', 'iso_flag', `${where}出现 ${f}`, { confidence: 0.99, actual: f }));
    };
    for (const f of MDZ.flagFindAll(volId + '\n' + sysId + '\n' + files.map(x => x.path).join('\n'))) addFlag(f, '卷标/文件名');
    let exported = 0;
    for (const rec of files) {
      if (exported >= 40 || rec.size > 8 * 1024 * 1024) continue;
      const off = rec.lba * blockSize;
      if (off + rec.size > b.length) continue;
      const data = b.subarray(off, off + rec.size);
      const safe = rec.path.replace(/[^\w.\-\/]+/g, '_').replace(/\//g, '_').slice(0, 80);
      artifacts.push(artifact('iso-' + (safe || 'file'), data, `ISO 文件 ${rec.path}（${rec.size} 字节）`));
      exported++;
      const text = MDZ.utf8(data) || ascii(data.subarray(0, Math.min(data.length, 65536)), Math.min(data.length, 65536));
      for (const f of MDZ.flagFindAll(text)) addFlag(f, `文件 ${rec.path} `);
    }
    if (files.length > exported) {
      findings.push(finding('L3', 'iso_limit', `只导出了 ${exported}/${files.length} 个文件`, {
        confidence: 0.5, detail: '其余文件超过 8MB 或数量上限；可用 7z/bsdtar 按目录记录手工取。'
      }));
    }
    if (volBlocks && volBlocks * blockSize < b.length) {
      const tr = b.subarray(volBlocks * blockSize);
      findings.push(finding('L1', 'iso_trailer', `卷空间之后还有 ${tr.length} 字节`, {
        confidence: tr.some(x => x !== 0) ? 0.95 : 0.6,
        offset: volBlocks * blockSize,
        preview: ascii(tr.subarray(0, 120), Math.min(120, tr.length)),
        detail: 'ISO 之外的附加区，常见于多会话盘或直接夹带。'
      }));
      artifacts.push(artifact('iso-trailer.bin', tr, 'ISO 卷空间之后的尾部数据'));
    }
    return { findings, artifacts, image: null, parsed: { volId, blockSize, volBlocks, joliet, files } };
  }

  // ---------- MP4 / MOV ----------
  // box 树：size + type；size=1 时用 64 位 largesize，size=0 表示到文件尾。
  // 只解元数据与 free/skip/mdat 结构，不解码音视频。
  const MP4_CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'udta', 'meta', 'edts', 'dinf', 'mvex', 'moof', 'traf', 'mfra']);
  const MP4_NAMES = { '©nam': 'title', '©cmt': 'comment', '©too': 'encoder', '©day': 'date', '©ART': 'artist', '©alb': 'album', '©gen': 'genre', desc: 'description', '----': 'custom' };

  function auditMP4(input, name) {
    const b = toU8(input);
    const findings = [], artifacts = [];
    if (b.length < 12) return { findings: [finding('L0', 'format', 'MP4 太短')], artifacts, image: null };
    const boxes = [], meta = [], flags = [];
    let mdatBytes = 0, metaOff = -1, tailAt = -1;
    const addFlag = (f, where) => {
      if (!f || flags.some(x => x.flag === f)) return;
      flags.push({ flag: f, where });
    };
    const addFlags = (text, where) => { for (const f of MDZ.flagFindAll(text)) addFlag(f, where); };
    function walk(start, end, depth, path) {
      let p = start;
      let lastEnd = start;
      while (p + 8 <= end) {
        let size = be32(b, p);
        const type = ascii(b.subarray(p + 4, p + 8), 4);
        let header = 8;
        if (size === 1) {
          if (p + 16 > end) break;
          size = be32(b, p + 8) * 4294967296 + be32(b, p + 12);
          header = 16;
        } else if (size === 0) {
          size = end - p;
        }
        if (size < header || p + size > end) {
          findings.push(finding('L1', 'mp4_box', `box ${type} 越界（声明 ${size} 字节）`, {
            confidence: 0.8, offset: p, declared: `${size} 字节`, actual: `只剩 ${end - p} 字节`
          }));
          break;
        }
        const body = p + header, bodyEnd = p + size;
        boxes.push({ type, off: p, size, path });
        if (type === 'ftyp') {
          const major = ascii(b.subarray(body, Math.min(body + 4, bodyEnd)), 4);
          findings.push(finding('L1', 'mp4_ftyp', `MP4 ftyp · 主品牌 ${major}`, {
            confidence: 0.9, offset: p,
            actual: ascii(b.subarray(body, Math.min(body + 24, bodyEnd)), Math.min(24, bodyEnd - body)).replace(/\x00/g, ' ')
          }));
        } else if (type === 'mvhd' && body + 20 <= bodyEnd) {
          const ts = be32(b, body + 12), dur = be32(b, body + 16);
          findings.push(finding('L3', 'mp4_mvhd', `时长 ${ts ? (dur / ts).toFixed(2) : '?'} 秒`, {
            confidence: 0.6, offset: p, actual: `timescale ${ts} · duration ${dur}`
          }));
        } else if (type === 'mdat') {
          mdatBytes += bodyEnd - body;
        } else if (type === 'free' || type === 'skip') {
          let nz = 0;
          for (let i = body; i < bodyEnd; i++) if (b[i]) nz++;
          if (nz) {
            findings.push(finding('L1', 'mp4_free', `${type} box 里有 ${nz} 个非零字节`, {
              confidence: 0.9, offset: body,
              declared: `${bodyEnd - body} 字节（应为空）`,
              actual: `${nz} 字节非零`,
              detail: 'free/skip 是播放器会跳过的填充区，出题人常直接写数据进去。',
              preview: ascii(b.subarray(body, Math.min(bodyEnd, body + 200)), Math.min(200, bodyEnd - body)),
              recipe: `从 0x${hex(body)} 起切 ${bodyEnd - body} 字节`
            }));
            artifacts.push(artifact(`mp4-${type}.bin`, b.subarray(body, bodyEnd), `MP4 ${type} box 数据`));
            addFlags(ascii(b.subarray(body, Math.min(bodyEnd, body + 65536)), Math.min(65536, bodyEnd - body)), 'free/skip');
          }
        } else if (type === 'meta' && metaOff < 0) {
          metaOff = p;
        } else if (type === 'ilst') {
          let ip = body;
          while (ip + 8 <= bodyEnd) {
            const isize = be32(b, ip);
            const itype = ascii(b.subarray(ip + 4, ip + 8), 4);
            if (isize < 8 || ip + isize > bodyEnd) break;
            let dp = ip + 8;
            while (dp + 8 <= ip + isize) {
              const dsize = be32(b, dp);
              const dtype = ascii(b.subarray(dp + 4, dp + 8), 4);
              if (dsize < 8 || dp + dsize > ip + isize) break;
              if (dtype === 'data' && dsize >= 16) {
                const dataType = be32(b, dp + 8);
                const payload = b.subarray(dp + 16, dp + dsize);
                let text;
                if (dataType === 2) text = MDZ.utf16be(payload);
                else text = MDZ.utf8(payload) || ascii(payload, Math.min(payload.length, 4096));
                if (text) {
                  meta.push({ key: itype, label: MP4_NAMES[itype] || itype, text });
                  addFlags(text, `元数据 ${MP4_NAMES[itype] || itype}`);
                }
              }
              dp += dsize;
            }
            ip += isize;
          }
        }
        if (MP4_CONTAINERS.has(type)) {
          walk(body + (type === 'meta' ? 4 : 0), bodyEnd, depth + 1, path.concat(type));
        }
        lastEnd = bodyEnd;
        p = bodyEnd;
      }
      if (depth === 0) tailAt = lastEnd;
    }
    walk(0, b.length, 0, []);
    if (mdatBytes) {
      findings.push(finding('L2', 'mp4_mdat', `mdat 媒体数据 ${mdatBytes} 字节（未解码）`, {
        confidence: 0.4, actual: '音视频本体；本工具只查元数据与填充区',
        recipe: 'ffmpeg -i file.mp4 / mp4box -info file.mp4'
      }));
    }
    if (meta.length) {
      findings.push(finding('L3', 'mp4_meta', `元数据 ${meta.length} 条`, {
        confidence: 0.8,
        actual: meta.slice(0, 6).map(m => `${m.label}=${m.text.slice(0, 60)}`).join(' | '),
        preview: meta.slice(0, 24).map(m => `${m.label}: ${m.text.slice(0, 300)}`).join('\n'),
        recipe: 'ffprobe -show_format -show_streams file.mp4 / exiftool file.mp4'
      }));
    }
    for (const f of flags.slice(0, 10)) {
      findings.push(finding('L3', 'mp4_flag', `${f.where}出现 ${f.flag}`, { confidence: 0.99, actual: f.flag }));
    }
    if (tailAt >= 0 && tailAt < b.length) {
      const tr = b.subarray(tailAt);
      findings.push(finding('L1', 'mp4_trailer', `最后一个 box 之后还有 ${tr.length} 字节`, {
        confidence: tr.some(x => x !== 0) ? 0.95 : 0.6,
        offset: tailAt,
        preview: ascii(tr.subarray(0, 120), Math.min(120, tr.length)),
        detail: '播放器读完最后一个 box 就停，尾部是天然夹带区。'
      }));
      artifacts.push(artifact('mp4-trailer.bin', tr, 'MP4 尾部附加数据'));
      addFlags(ascii(tr.subarray(0, 65536), Math.min(65536, tr.length)), '尾部');
    }
    findings.push(finding('L1', 'mp4', `MP4 · ${boxes.length} 个 box`, {
      confidence: 0.8, offset: 0,
      actual: boxes.slice(0, 12).map(x => x.type + '(' + x.size + ')').join(' '),
      detail: `顶层/嵌套 box 共 ${boxes.length} 个；元数据 ${meta.length} 条；mdat ${mdatBytes} 字节。`
    }));
    return { findings, artifacts, image: null, parsed: { boxes, meta, mdatBytes, tailAt } };
  }

  Object.assign(MDZ, { isTAR, auditTAR, isRAR, auditRAR, is7Z, audit7Z, auditBzip2, auditISO, auditMP4, tarNum, tarChecksumOk });
})(typeof globalThis !== 'undefined' ? globalThis : this);
