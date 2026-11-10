#!/usr/bin/env node
/* misc大手子 回归测试：单元向量 + fixture 端到端 + 真实样本 + 畸形输入 */
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
// 模块清单的唯一真理源是 build.py 的 CORE_MODULES，构建时导出成 modules.json。
// 以前这里和 build.py 各写一份，新增模块漏改一处就静默不一致。
const MODULES = (() => {
  const p = path.join(__dirname, 'modules.json');
  if (!fs.existsSync(p)) throw new Error('缺少 tests/modules.json，请先跑 python build.py');
  return JSON.parse(fs.readFileSync(p, 'utf8')).core.map(n => n.replace(/\.js$/, ''));
})();
for (const f of MODULES) {
  require(path.join(ROOT, 'src', f + '.js'));
}
const M = globalThis.MDZ;

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) { pass++; console.log('  PASS', name); }
  else { fail++; failures.push(name + (detail ? ' — ' + detail : '')); console.log('  FAIL', name, detail || ''); }
}
function eq(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
function findingText(r) {
  return r.findings.map(f => [f.title, f.detail, f.preview, f.actual, f.declared, f.recipe].join('\n')).join('\n')
    + '\n' + M.flags(r).join('\n');
}

console.log('\n== 单元向量 ==');
check('crc32("123456789")', M.crc32(Buffer.from('123456789')).toString(16) === 'cbf43926');
check('sha256("abc")', M.sha256(Buffer.from('abc')) === 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
check('b64encode("abc")', M.b64encode(Buffer.from('abc')) === 'YWJj');
check('b64encode 边界', M.b64encode(Buffer.from([0, 1, 2, 253, 254, 255])) === 'AAEC/f7/');
check('companion 只允许回环', M.companionUrlAllowed('http://127.0.0.1:8765') && M.companionUrlAllowed('http://localhost:1') && !M.companionUrlAllowed('http://example.com') && !M.companionUrlAllowed('http://127.0.0.1:8765/api'));
{
  const cmds = M.manualCommands();
  check('手动命令含 zsteg/binwalk/steghide/bkcrack', ['zsteg -a', 'binwalk -e', 'steghide extract', 'bkcrack -C'].every(x => cmds.some(c => c.cmd.indexOf(x) >= 0)));
}

console.log('\n== inflate 对拍 Node zlib ==');
let infOk = 0, infFail = 0;
const cases = [Buffer.alloc(0), Buffer.from('x'), crypto.randomBytes(37), crypto.randomBytes(4096), Buffer.from('A'.repeat(200000))];
for (const d of cases) {
  for (const lvl of [0, 1, 6, 9]) {
    const c = zlib.deflateSync(d, { level: lvl });
    const r = M.inflateZlib(c, 0);
    if (r.error || !eq(Buffer.from(r.out), d) || r.consumed !== c.length) { infFail++; console.log('   mismatch', d.length, lvl, r.error, r.consumed, c.length); }
    else infOk++;
  }
}
// 拼接流
const a = zlib.deflateSync(Buffer.from('first-'.repeat(100)));
const b = zlib.deflateSync(crypto.randomBytes(2000));
const cat = Buffer.concat([a, b]);
const r1 = M.inflateZlib(cat, 0);
const r2 = M.inflateZlib(cat, r1.consumed);
check('inflate 单流', infFail === 0, `${infOk} ok / ${infFail} fail`);
check('拼接流 consumed = 首流长度', r1.consumed === a.length, `${r1.consumed} vs ${a.length}`);
check('拼接流第二段可解', !!r2.out && r2.out.length === 2000 && !r2.error);

console.log('\n== 截断/校验边界 ==');
{
  // 1) stored block 截断：部分输出必须是原文前缀（不能有幻影字节）
  const orig = Buffer.from('A'.repeat(300));
  const comp = zlib.deflateSync(orig, { level: 0 });
  let bad = 0;
  for (let cut = 3; cut < comp.length; cut += 7) {
    const r = M.inflateZlib(comp.subarray(0, cut), 0);
    const out = Buffer.from(r.out || []);
    if (!orig.subarray(0, out.length).equals(out)) bad++;
    if (out.length > orig.length) bad++;
  }
  check('截断 stored block 无幻影字节', bad === 0, bad + ' 例非前缀');

  // 2) zlib adler 被改：必须报错
  const z = Buffer.from(zlib.deflateSync(Buffer.from('checksum-test'.repeat(20))));
  z[z.length - 1] ^= 0xFF;
  const rz = M.inflateZlib(z, 0);
  check('zlib adler 篡改被拒绝', !!rz.error, String(rz.error));

  // 3) gzip 数据被改：必须报错
  const g = Buffer.from(zlib.gzipSync(Buffer.from('checksum-test'.repeat(20))));
  g[Math.floor(g.length / 2)] ^= 0xFF;
  const rg = M.inflateGzip(g, 0);
  check('gzip CRC/数据篡改被拒绝', !!rg.error, String(rg.error));

  // 4) FDICT 流：明确拒绝，不能走错偏移
  const dict = Buffer.from('dictionary-words');
  const zd = Buffer.from(zlib.deflateSync(Buffer.from('hello dictionary'), { dictionary: dict }));
  const rd = M.inflateZlib(zd, 0);
  check('FDICT 流明确拒绝', !!rd.error && /FDICT/.test(rd.error), String(rd.error));
}

{
  // LZMA 单独格式没有魔数：props(1) + 字典大小(4 LE) + 原长(8 LE)
  const mk = (props, dict, lo, hi) => {
    const a = new Uint8Array(16);
    a[0] = props;
    [dict, lo, hi].forEach((v, k) => {
      const base = 1 + k * 4;
      a[base] = v & 0xff; a[base + 1] = (v >>> 8) & 0xff;
      a[base + 2] = (v >>> 16) & 0xff; a[base + 3] = (v >>> 24) & 0xff;
    });
    return a;
  };
  check('LZMA 头识别（原长未知）', M.isLzmaAlone(mk(0x5D, 1 << 23, 0xFFFFFFFF, 0xFFFFFFFF), 0));
  check('LZMA 头识别（原长已知）', M.isLzmaAlone(mk(0x5D, 1 << 23, 40, 0), 0));
  check('LZMA 字典 1.5*2^n 也算', M.isLzmaAlone(mk(0x5D, (1 << 23) + (1 << 22), 40, 0), 0));
  check('LZMA props 越界拒绝', !M.isLzmaAlone(mk(0xE1, 1 << 23, 0, 0), 0));
  check('LZMA 字典大小不合理拒绝', !M.isLzmaAlone(mk(0x5D, 0x12345, 0, 0), 0));
  check('LZMA 原长字段不合理拒绝', !M.isLzmaAlone(mk(0x5D, 1 << 23, 0, 1), 0));
  const lz = fs.readFileSync(path.join(__dirname, 'fixtures', 'lzma_rest.png'));
  const hits = M.findStreamSignatures(lz, 0, lz.length);
  check('PNG 里的 LZMA 被扫到', hits.some(h => h.kind === 'lzma'), `命中 ${hits.length} 条`);
  check('仍能扫到 PNG 自身的 zlib', hits.some(h => h.kind === 'zlib'));
  {
    const lzHit = hits.find(h => h.kind === 'lzma');
    const dec = lzHit ? M.lzmaDecompressAlone(lz.subarray(lzHit.offset), { maxOut: 1 << 20 }) : null;
    check('LZMA 内置解压出原文', !!(dec && dec.out) && Buffer.from(dec.out).toString('latin1').indexOf('flag{lzma_rest}') >= 0, dec && dec.error);
    const bad = M.lzmaDecompressAlone(new Uint8Array([0xE1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]), {});
    check('LZMA 属性非法时明确报错', !!bad.error && !bad.out);
  }
  for (const name of ['qr_flag.png', 'qr_flag_rot.png']) {
    const r = M.analyze(fs.readFileSync(path.join(__dirname, 'fixtures', name)), name, {});
    const f = r.findings.find(x => x.type === 'qr');
    check('内置二维码解码（' + name + '）', !!f && f.preview.indexOf('flag{qr_builtin}') >= 0, f && f.preview);
    check('二维码 flag 被收录（' + name + '）', M.flags(r).indexOf('flag{qr_builtin}') >= 0, M.flags(r).join(','));
  }
  {
    const noise = { width: 64, height: 64, data: new Uint8ClampedArray(64 * 64 * 4) };
    for (let i = 0; i < noise.data.length; i++) noise.data[i] = (i * 2654435761 >>> 24) & 255;
    check('随机噪声不误报二维码', M.qrDecodeImageData(noise).length === 0);
  }
}

console.log('\n== 文件头修复 ==');
{
  const png = fs.readFileSync(path.join(__dirname, 'fixtures', 'text_chunk.png'));
  const cut = M.detectDamagedHeader(png.subarray(1));
  const best = cut[0];
  check('PNG 缺首字节 → 疑似 PNG', !!best && best.format === 'PNG' && best.mode === 'prepend' && best.extra.length === 1,
    JSON.stringify(best && { f: best.format, m: best.mode, e: best.extra }));
  check('PNG 修复副本能再次识别', !!best && M.detectType(best.fixed, '').format === 'PNG');
  check('PNG 修复副本 CRC 全通过', !!best && M.parseChunks(best.fixed).chunks.every(c => c.crcOk));

  const rep = M.analyze(png.subarray(1), 'cut.png', {});
  const f = rep.findings.find(x => x.type === 'damaged_header');
  check('分析时报告文件头被削', !!f && /PNG/.test(f.title), f && f.title);
  check('发现里带可一键修复的字节', !!(f && f.repair && f.repair.bytes && f.repair.bytes[0] === 0x89));

  const jpg = fs.readFileSync(path.join(__dirname, 'fixtures', 'jpeg_multi_exif.jpg'));
  check('JPEG 缺首字节 → 疑似 JPEG', M.detectDamagedHeader(jpg.subarray(1)).some(c => c.format === 'JPEG' && c.mode === 'prepend'));

  const bmp = fs.readFileSync(path.join(__dirname, 'fixtures', 'bmp_1bit_lsb.bmp'));
  check('BMP 缺首字节 → 疑似 BMP', M.detectDamagedHeader(bmp.subarray(1)).some(c => c.format === 'BMP' && c.mode === 'prepend'));

  const pref = Buffer.concat([Buffer.from([0x41]), png]);
  check('开头多一字节 → 建议裁掉', M.detectDamagedHeader(pref).some(c => c.format === 'PNG' && c.mode === 'strip' && c.extra.length === 1));

  check('PNG 整个签名被删也能认出', M.detectDamagedHeader(png.subarray(8)).some(c => c.format === 'PNG' && c.mode === 'prepend' && c.extra.length === 8));

  const noise = Buffer.alloc(256);
  for (let i = 0; i < noise.length; i++) noise[i] = (i * 2654435761 >>> 24) & 255;
  check('随机字节不乱报文件头损坏', M.detectDamagedHeader(noise).length === 0);
}

console.log('\n== 第二批审计修复 ==');
{
  const rd = n => fs.readFileSync(path.join(__dirname, 'fixtures', n));
  const carve = M.analyze(rd('carve_embedded.bin'), 'carve_embedded.bin', {});
  check('内嵌 PNG 被雕刻', carve.findings.some(f => f.type === 'carve'));
  check('雕刻出的 PNG 递归分析', carve.files.some(f => /carved-0x40\.png/.test(f.name) && f.format === 'PNG'));
  const usb = M.analyze(rd('pcap_usb.pcap'), 'pcap_usb.pcap', {});
  check('USB HID 键盘还原', M.flags(usb).indexOf('flag{usb_hid}') >= 0, M.flags(usb).join(','));
  const icmp = M.analyze(rd('pcap_icmp.pcap'), 'pcap_icmp.pcap', {});
  check('ICMP 载荷被提取', M.flags(icmp).indexOf('flag{icmp_payload}') >= 0, M.flags(icmp).join(','));
}


console.log('\n== 归档 / PDF / MP3 ==');
{
  const rd = n => fs.readFileSync(path.join(__dirname, 'fixtures', n));
  const tar = M.analyze(rd('tar_members.tar'), 'tar_members.tar', {});
  check('TAR 成员被提取', tar.artifacts.some(a => /tar-a\.txt/.test(a.name)), tar.artifacts.map(a => a.name).join(','));
  check('TAR 内嵌 PNG 递归分析', tar.files.some(f => f.name === 'tar-inner.png' && f.format === 'PNG'));
  check('TAR 里的 flag 被收录', M.flags(tar).indexOf('flag{tar_member}') >= 0);

  const rar = M.analyze(rd('rar4_stored.rar'), 'rar4_stored.rar', {});
  check('RAR4 stored 成员被提取', rar.artifacts.some(a => /rar-flag\.txt/.test(a.name)), rar.artifacts.map(a => a.name).join(','));
  check('RAR4 里的 flag 被收录', M.flags(rar).indexOf('flag{rar_stored}') >= 0);

  const sz = M.analyze(rd('seven_plain.7z'), 'seven_plain.7z', {});
  check('7Z 文件表解析出名字', sz.findings.some(f => /7Z：2 个文件/.test(f.title)), sz.findings.map(f => f.title).join(' | '));

  const mp3 = M.analyze(rd('mp3_frames.mp3'), 'mp3_frames.mp3', {});
  check('MP3 帧表解析', mp3.findings.some(f => f.type === 'mp3_frames'));
  check('MP3 帧头 private 位还原 flag', M.flags(mp3).indexOf('flag{mp3bits}') >= 0, M.flags(mp3).join(','));

  const pdf = M.analyze(rd('pdf_objects.pdf'), 'pdf_objects.pdf', {});
  check('PDF 内嵌文件被提取', pdf.artifacts.some(a => /pdf-embedded/.test(a.name)));
  check('PDF 图片拼成可解码 PNG', pdf.artifacts.some(a => /\.png$/.test(a.name) && M.decodePNG(a.bytes).width === 2));
  check('PDF 的 JS 被点名', pdf.findings.some(f => f.type === 'pdf_js'));
  check('PDF 两个 flag 都收录', M.flags(pdf).indexOf('flag{pdf_embedded}') >= 0 && M.flags(pdf).indexOf('flag{pdf_js}') >= 0);
}

console.log('\n== 一维条码 / HTTP 对象 / 编码载荷 ==');
{
  const rd = n => fs.readFileSync(path.join(__dirname, 'fixtures', n));
  const BI = M.barInternals;

  check('Code128 表：107 项、除 stop 外都是 11 模块、无重复',
    BI.C128.length === 107 && BI.C128.slice(0, 106).every(s => s.split('').reduce((a, c) => a + +c, 0) === 11)
    && BI.C128[106] === '2331112' && new Set(BI.C128).size === 107,
    BI.C128.length + '/' + new Set(BI.C128).size);
  check('Code128 起始符图样正确', BI.C128[103] === '211412' && BI.C128[104] === '211214' && BI.C128[105] === '211232');
  check('Code39 表：44 个图样、每个正好 3 宽',
    Object.keys(BI.C39).length === 44 && Object.values(BI.C39).every(s => s.split('').filter(c => c === '1').length === 3));

  const imgOf = (bits, module, height) => {
    const quiet = 10 * module, W = bits.length * module + quiet * 2, H = height || 60;
    const data = new Uint8ClampedArray(W * H * 4);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const di = (y * W + x) * 4;
        const mx = x - quiet;
        const on = mx >= 0 && mx < bits.length * module && bits[(mx / module) | 0] === '1';
        data[di] = data[di + 1] = data[di + 2] = on ? 0 : 255;
        data[di + 3] = 255;
      }
    }
    return { width: W, height: H, data };
  };
  const c128bits = text => {
    const vals = [104];
    for (const ch of text) vals.push(ch.charCodeAt(0) - 32);
    let sum = vals[0];
    for (let k = 1; k < vals.length; k++) sum += k * vals[k];
    vals.push(sum % 103);
    let bits = '';
    for (const v of vals) bits += BI.bitsOf(BI.C128[v].split('').map(Number));
    return bits + BI.bitsOf(BI.C128[106].split('').map(Number));
  };
  const c39bits = text => {
    const all = '*' + text + '*';
    let bits = '';
    for (let i = 0; i < all.length; i++) {
      const p = BI.C39[all[i]];
      for (let k = 0; k < 9; k++) bits += (k % 2 === 0 ? '1' : '0').repeat(p[k] === '1' ? 3 : 1);
      if (i < all.length - 1) bits += '0';
    }
    return bits;
  };

  const b1 = M.barDecodeRGBA(imgOf(c128bits('FLAG{1d}'), 3));
  check('Code128 从合成图解出文本', b1.length === 1 && b1[0].text === 'FLAG{1d}' && b1[0].symbology === 'Code128', JSON.stringify(b1));
  const b2 = M.barDecodeRGBA(imgOf(c39bits('FLAG39'), 2));
  check('Code39 从合成图解出文本', b2.length === 1 && b2[0].text === 'FLAG39', JSON.stringify(b2));
  const b3 = M.barDecodeRGBA(imgOf(c128bits('FLAG{1d}'), 2));
  check('Code128 1px/模块也能解', b3.length === 1 && b3[0].text === 'FLAG{1d}', JSON.stringify(b3));
  const blank = M.barDecodeRGBA({ width: 200, height: 80, data: new Uint8ClampedArray(200 * 80 * 4).fill(255) });
  check('空白图不误报条码', blank.length === 0);

  const eanPng = M.decodePNG(rd('barcode_ean13.png'));
  const eanBar = eanPng ? M.barDecodeRGBA(M.renderImage(eanPng, 0)) : [];
  check('EAN-13 从真实 PNG 解出 5901234123457', eanBar.length === 1 && eanBar[0].text === '5901234123457', JSON.stringify(eanBar));
  const rBar = M.analyze(rd('barcode_ean13.png'), 'barcode_ean13.png', {});
  check('条码发现进入分析结果', rBar.findings.some(f => f.type === 'barcode' && /EAN-13/.test(f.title)));

  const rHttp = M.analyze(rd('pcap_http_obj.pcap'), 'pcap_http_obj.pcap', {});
  const names = rHttp.artifacts.map(a => a.name);
  check('HTTP chunked 响应对象被切出', names.indexOf('http-got.png') >= 0 && rHttp.artifacts.find(a => a.name === 'http-got.png').bytes.length > 40, names.join(','));
  check('HTTP multipart 上传按 filename 命名', names.indexOf('http-up.txt') >= 0, names.join(','));
  check('multipart 里的 flag 被收录', M.flags(rHttp).indexOf('flag{http_multipart}') >= 0, M.flags(rHttp).join(','));
  check('HTTP 对象发现入结果', rHttp.findings.filter(f => f.type === 'http_object').length >= 2);

  const rB64 = M.analyze(rd('b64_png.txt'), 'b64_png.txt', {});
  check('base64 解出的二进制载荷被切成产物', rB64.artifacts.some(a => /^decoded-base64-\d+\.png$/.test(a.name)), rB64.artifacts.map(a => a.name).join(','));
  check('base64 载荷继续递归成 PNG', rB64.files.some(f => f.format === 'PNG' && f.depth === 1), JSON.stringify(rB64.files.map(f => f.name + ':' + f.format)));
}


console.log('\n== 审查修复：死循环 / 漏检 / 内存 / 门禁 ==');
{
  const rd = n => fs.readFileSync(path.join(__dirname, 'fixtures', n));
  const t0 = () => Date.now();

  // C1：7Z kName 的 size vint 不夹到 hdr.length 就会死循环
  {
    const nxt = Buffer.alloc(32, 0);
    nxt[0] = 0x01; nxt[1] = 0x05; nxt[2] = 0x01; nxt[3] = 0x11;
    nxt[4] = nxt[5] = nxt[6] = nxt[7] = nxt[8] = nxt[9] = nxt[10] = nxt[11] = 0xFF;
    nxt[12] = 0x7F;                                    // 9 字节 vint = 2^63-1
    const head = Buffer.alloc(32, 0);
    head.write("7z¼¯'\u001c", 0, 'latin1');
    head[6] = 0; head[7] = 4;
    head.writeUInt32LE(M.crc32(Buffer.concat([Buffer.alloc(20), nxt])) >>> 0, 8);
    head.writeUInt32LE(0, 12); head.writeUInt32LE(0, 16);
    head.writeUInt32LE(nxt.length, 20);
    const file = Buffer.concat([head, nxt]);
    const t = t0();
    const r = M.audit7Z(file, 'bang.7z');
    check('7Z 头被改坏不死循环（kName 长度夹到文件尾）', Date.now() - t < 1000 && !!r, Date.now() - t + 'ms');
  }

  // C2：ID3 加密帧的 continue 不推进 pos 就会死循环
  {
    const tag = Buffer.from([0x49, 0x44, 0x33, 3, 0, 0, 0, 0, 0, 10]);
    const frame = Buffer.from([0x54, 0x49, 0x54, 0x32, 0, 0, 0, 0, 0x00, 0x40]);
    const buf = Buffer.concat([tag, frame, Buffer.alloc(16)]);
    const t = t0();
    const r = M.auditMP3(buf, 'bang.mp3', {});
    check('ID3 加密帧不死循环（pos 正常推进）', Date.now() - t < 1000 && !!r, Date.now() - t + 'ms');
    const parsed = M.parseID3v2(buf, 0);
    check('ID3 加密帧被计数', !parsed || parsed.encryptedFrames === 1, JSON.stringify(parsed && parsed.encryptedFrames));
  }

  // C3：>1MB 文件的后半段也要扫到压缩流（以前按命中数只给 64 次）
  {
    const payload = zlib.deflateSync(Buffer.from('flag{beyond_budget}'));
    const big = Buffer.concat([crypto.randomBytes(1150 * 1024), payload]);
    const r = M.analyze(big, 'big.bin', {});
    check('大文件尾部的压缩流仍被解出', M.flags(r).indexOf('flag{beyond_budget}') >= 0, M.flags(r).join(','));
  }

  // C4：PDF 的 ASCII85 流里含 '<'（码位 60）不能被吃掉
  {
    const a85 = (bytes) => {
      let out = '';
      for (let i = 0; i < bytes.length; i += 4) {
        const n = Math.min(4, bytes.length - i);
        let v = 0;
        for (let k = 0; k < 4; k++) v = (v * 256 + (i + k < bytes.length ? bytes[i + k] : 0)) >>> 0;
        const d = [];
        for (let k = 0; k < 5; k++) { d.unshift((v % 85) + 33); v = Math.floor(v / 85); }
        out += String.fromCharCode.apply(null, d.slice(0, n === 4 ? 5 : n + 1));
      }
      return out;
    };
    const payload = Buffer.concat([Buffer.from([0, 0, 0, 0x1B]), Buffer.from('flag{ascii85_lt}')]);
    const enc = a85(payload) + '~>';
    check('测试用的 ASCII85 文本里真的含 <', enc.indexOf('<') >= 0, enc);
    const body = 'stream\r\n' + enc + '\r\nendstream';
    const pdf = '%PDF-1.4\n1 0 obj\n<< /Type /EmbeddedFile /Length ' + enc.length +
      ' /Filter /ASCII85Decode >>\n' + body + '\nendobj\n%%EOF\n';
    const r = M.auditPDF(Buffer.from(pdf, 'latin1'), 'a85.pdf');
    const art = r.artifacts.find(a => /pdf-embedded/.test(a.name));
    check('ASCII85 流里含 < 也能完整还原', !!art && Buffer.compare(Buffer.from(art.bytes), payload) === 0,
      art ? art.bytes.length + ' 字节' : '没有产物');
  }

  // C8：已知格式解析失败要退到通用兜底，别把明文 flag 吞掉
  {
    const bmp = Buffer.alloc(18);
    bmp.write('BM', 0);
    bmp.writeUInt32LE(20, 14);                          // 非法 DIB 头大小
    const file = Buffer.concat([bmp, Buffer.from('flag{bmp_bad_dib}')]);
    const r = M.analyze(file, 'bad.bmp', {});
    check('坏 BMP 头仍能捞到明文 flag', M.flags(r).indexOf('flag{bmp_bad_dib}') >= 0, M.flags(r).join(','));
    check('坏 BMP 头会跑通用兜底', r.findings.some(f => f.type === 'strings' || f.type === 'encoding'));
  }

  // C7：音频 LSB 去重不能只看前缀（长静默打头时会丢掉真正的载荷）
  {
    const printable = (n, seed) => {
      const b = Buffer.alloc(n);
      const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 .,;:{}_-';
      let x = seed;
      for (let i = 0; i < n; i++) { x = (x * 1103515245 + 12345) >>> 0; b[i] = chars.charCodeAt(x % chars.length); }
      return b;
    };
    const payload = printable(60000, 42);
    payload.write('flag{audio_dedupe}', 59900);
    const bits = [];
    for (const b of payload) for (let k = 7; k >= 0; k--) bits.push((b >> k) & 1);
    const silence = 40000;                              // 5000 字节静音 > 4096 的旧前缀窗口
    const raw = new Uint32Array(silence + bits.length);
    for (let i = 0; i < bits.length; i++) if (bits[i]) raw[silence + i] |= 1 << 1;
    const pcm = {
      frames: raw.length, channels: 1, bits: 16, sampleRate: 8000,
      raw: [raw], data: new Uint8Array(raw.length * 2),
      value: (c, i) => raw[i] / 65535
    };
    const r = M.scanAudioLSB(pcm);
    check('音频 LSB：长静默前缀不吞掉后面的 bit1 载荷',
      r.findings.some(f => /bit1/.test(f.title) && /msb/.test(f.title)),
      JSON.stringify(r.findings.map(f => f.title).slice(0, 4)));
  }

  // P5：PNG 声明尺寸炸弹不该把内存撑到 GB
  {
    const chunk = (type, data) => {
      const out = Buffer.alloc(12 + data.length);
      out.writeUInt32BE(data.length, 0);
      out.write(type, 4, 'latin1');
      data.copy(out, 8);
      out.writeUInt32BE(M.crc32(out.subarray(4, 8 + data.length)) >>> 0, 8 + data.length);
      return out;
    };
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(40000, 0); ihdr.writeUInt32BE(40000, 4);
    ihdr[8] = 8; ihdr[9] = 6;
    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
      chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(Buffer.alloc(64))), chunk('IEND', Buffer.alloc(0))
    ]);
    const t = t0();
    const d = M.decodePNG(png);
    check('PNG 尺寸炸弹被拒绝且很快返回', d.tooBig === true && Date.now() - t < 500, JSON.stringify({ tooBig: d.tooBig, err: d.error, ms: Date.now() - t }));
  }

  // C5：PDF 增量更新里同一个对象号，后面的覆盖前面的
  {
    const pdf = [
      '%PDF-1.4',
      '1 0 obj << /Type /EmbeddedFile /Length 13 >>', 'stream', 'old-object-x', 'endstream', 'endobj',
      '1 0 obj << /Type /EmbeddedFile /Length 18 >>', 'stream', 'flag{pdf_last_obj}', 'endstream', 'endobj',
      '%%EOF'
    ].join('\n');
    const r = M.auditPDF(Buffer.from(pdf, 'latin1'), 'inc.pdf');
    const art = r.artifacts.filter(a => /pdf-embedded/.test(a.name));
    check('PDF 增量更新取最后一份对象', art.length === 1 && /flag\{pdf_last_obj\}/.test(Buffer.from(art[0].bytes).toString('latin1')),
      art.map(a => Buffer.from(a.bytes).toString('latin1')).join(' | '));
  }

  // Worker 会剔掉函数：pcm.value 必须能从 format/bits/raw 重建
  {
    const pcm = { format: 1, bits: 16, channels: 1, raw: [Uint32Array.from([0, 32768, 65535, 65535])] };
    const f = M.audioPCMValue(pcm);
    check('audioPCMValue 重建取样函数', f(0, 0) === 0 && f(0, 1) === -1 && Math.abs(f(0, 2) + 1 / 32768) < 1e-9,
      [f(0, 0), f(0, 1), f(0, 2)].join(','));
  }

  // 门禁：模块清单与版本号只有一个真理源
  {
    const srcDir = path.join(ROOT, 'src');
    const files = fs.readdirSync(srcDir).filter(f => /^\d\d-.+\.js$/.test(f) && f !== '80-ui.js');
    const listed = MODULES.map(m => m + '.js');
    check('所有核心模块都登记在清单里', files.every(f => listed.indexOf(f) >= 0),
      files.filter(f => listed.indexOf(f) < 0).join(','));
    const buildTxt = fs.readFileSync(path.join(ROOT, 'build.py'), 'utf8');
    const cm = /CORE_MODULES = \[([\s\S]*?)\]/.exec(buildTxt);
    const fromBuild = cm ? (cm[1].match(/"([^"]+\.js)"/g) || []).map(s => s.slice(1, -1)) : [];
    check('modules.json 与 build.py 的 CORE_MODULES 一致', JSON.stringify(fromBuild) === JSON.stringify(listed),
      fromBuild.length + ' vs ' + listed.length);
    const builtPath = path.join(ROOT, 'misc-dashouzi.html');
    if (fs.existsSync(builtPath)) {
      const vm = /id="ver">v([^<]+)</.exec(fs.readFileSync(builtPath, 'utf8'));
      check('构建产物的版本号与 VERSION 一致', !!vm && vm[1] === M.VERSION, vm ? vm[1] + ' vs ' + M.VERSION : '找不到 #ver');
    }
  }
}

console.log('\n== 版本说明 ==');
{
  check('版本说明含当前版本', (M.CHANGELOG || []).some(v => v.version === M.VERSION), M.VERSION);
  check('能力总表齐全', (M.CAPABILITIES || []).length >= 3);
  check('最新版本排在最前', (M.CHANGELOG || [])[0] && M.CHANGELOG[0].version === M.VERSION);
}

console.log('\n== fixture 端到端 ==');
const meta = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures.json'), 'utf8'));
for (const fx of meta.fixtures) {
  const bytes = Buffer.from(fx.b64, 'base64');
  const r = M.analyze(bytes, fx.name, { maxScanPixels: 6000000 });
  const text = findingText(r);
  const missing = fx.expect.filter(x => text.indexOf(x) < 0);
  check(fx.name, missing.length === 0, missing.length ? '缺少 ' + missing.join(' / ') : '');
}

console.log('\n== 格式覆盖 ==');
for (const [f, w, h, bd] of [['palette.png', 32, 32, 8], ['gray16.png', 64, 64, 16], ['gray4_padding.png', 13, 5, 4]]) {
  const p = path.join(__dirname, 'fixtures', f);
  if (!fs.existsSync(p)) { console.log('  SKIP', f); continue; }
  const d = M.decodePNG(fs.readFileSync(p), {});
  check(`decode ${f}`, !d.error && d.width === w && d.height === h && d.bitDepth === bd && !!d.channels, d.error || `${d.width}x${d.height}`);
}
{
  // 4-bit 逐行字节对齐：第二行起必须仍然正确
  const p = path.join(__dirname, 'fixtures', 'gray4_padding.png');
  if (fs.existsSync(p)) {
    const d = M.decodePNG(fs.readFileSync(p), {});
    let bad = 0;
    for (let y = 0; y < 5; y++) for (let x = 0; x < 13; x++) {
      const want = (x * 3 + y) % 16;
      if (d.channels.R[y * 13 + x] !== want) bad++;
    }
    check('4-bit 行对齐解码', bad === 0, bad + ' 个样本错误');
  }
}

console.log('\n== 真实样本 ==');
const real = [
  ['Z:/laragon/ctf/challenges/school/123/misc/3/3.png', ['第二条 zlib 流', 'flag{LSB_is_so_easy}']],
  ['Z:/laragon/ctf/challenges/school/123/misc/2/2.png', ['JPEG EOI 之后还有数据', 'this_is_password']],
  ['Z:/laragon/ctf/challenges/school/123/misc/1.png', ['IHDR 宽高可能被改过']],
];
for (const [p, expect] of real) {
  if (!fs.existsSync(p)) { console.log('  SKIP', p); continue; }
  const bytes = fs.readFileSync(p);
  const r = M.analyze(bytes, path.basename(p), { maxScanPixels: 6000000 });
  const text = findingText(r);
  const missing = expect.filter(x => text.indexOf(x) < 0);
  check('real ' + path.basename(p), missing.length === 0, missing.length ? '缺少 ' + missing.join(' / ') : '');
}
{
  const p = 'Z:/laragon/ctf/challenges/susctf/花好月圆/花好月圆.pcapng';
  if (!fs.existsSync(p)) console.log('  SKIP 花好月圆.pcapng');
  else {
    const r = M.analyze(fs.readFileSync(p), '花好月圆.pcapng', { maxScanPixels: 6000000 });
    check('real pcapng 全量包数', !!r.pcap && r.pcap.packets > 30000 && !(r.pcap.warnings || []).some(x => x.indexOf('包数超过上限') >= 0), r.pcap ? JSON.stringify({ packets: r.pcap.packets, warnings: r.pcap.warnings }) : 'no pcap');
    check('real pcapng 诱饵流识别', M.flags(r).some(x => x.indexOf('wrong_flow_') >= 0), M.flags(r).slice(0, 3).join(' / '));
    check('real pcapng 前导 UDP 小包', r.findings.filter(f => f.title.indexOf('UDP 可打印载荷') >= 0).length >= 5, String(r.findings.filter(f => f.title.indexOf('UDP 可打印载荷') >= 0).length));
    check('real pcapng 无解析错误', !r.findings.some(f => f.title.indexOf('不是 pcap') >= 0) && (r.pcap.streams || []).length > 0, r.findings.map(f => f.title).slice(0, 3).join(' / '));
  }
}

console.log('\n== GIF LZW 对拍 ==');
{
  const cases = [
    ['gif_lzw.gif', 'flag{gif_lzw}', 1],
    ['gif_interlaced.gif', 'flag{gif_interlace}', 0]
  ];
  for (const [file, msg, frameIdx] of cases) {
    const p = path.join(__dirname, 'fixtures', file);
    if (!fs.existsSync(p)) { console.log('  SKIP', file); continue; }
    const g = M.parseGIF(fs.readFileSync(p));
    check(`${file} 帧数`, g.frames.length >= frameIdx + 1, 'frames=' + g.frames.length);
    const r = M.gifFrameImage(g.frames[frameIdx], g.gct);
    const w = g.frames[frameIdx].width, h = g.frames[frameIdx].height;
    const bits = Array.from(Buffer.from(msg)).map(b => b.toString(2).padStart(8, '0')).join('');
    let bad = 0;
    for (let i = 0; i < w * h; i++) {
      let want = (i * 7) % 256;
      if (i < bits.length) want = (want & 0xFE) | parseInt(bits[i], 10);
      if (r.indices[i] !== want) bad++;
    }
    check(`${file} 索引逐像素`, !r.error && bad === 0, r.error || bad + ' 个不一致');
    check(`${file} 隔行标志`, g.frames[frameIdx].interlace === (file.indexOf('interlaced') >= 0));
  }
}

console.log('\n== 低位深 BMP 对拍 ==');
{
  const cases = [
    ['bmp_4bit_lsb.bmp', 4, 'flag{bmp_4bit}', (i) => (i * 7) % 16, (v) => v / 17],
    ['bmp_1bit_lsb.bmp', 1, 'flag{bmp_1bit}', (i) => i % 2, (v) => v / 255]
  ];
  for (const [file, bpp, msg, base, unscale] of cases) {
    const p = path.join(__dirname, 'fixtures', file);
    if (!fs.existsSync(p)) { console.log('  SKIP', file); continue; }
    const b = fs.readFileSync(p);
    const info = M.parseBMP(b);
    const img = M.decodeBMP(b, info);
    const bits = Array.from(Buffer.from(msg)).map(x => x.toString(2).padStart(8, '0')).join('');
    let bad = 0;
    for (let i = 0; i < info.width * info.absH; i++) {
      let want = base(i);
      if (i < bits.length) want = (want & 0xFE) | parseInt(bits[i], 10);
      const got = Math.round(unscale(img.channels.R[i]));
      if (got !== want) bad++;
    }
    check(`${file} 索引逐像素`, !img.error && bad === 0 && info.bpp === bpp, img.error || `${bad} 个不一致`);
  }
}

console.log('\n== 递归 / 位平面边界 ==');
{
  const p = path.join(__dirname, 'fixtures', 'nested_png.png');
  if (fs.existsSync(p)) {
    const r = M.analyze(fs.readFileSync(p), 'nested_png.png', { maxDepth: 3 });
    const maxD = Math.max(...r.files.map(f => f.depth));
    check('递归深度不超过 maxDepth', maxD <= 3, 'max depth=' + maxD);
    check('递归上限有提示', r.findings.some(f => f.title.indexOf('递归未完全展开') >= 0));
  }
  const dp = path.join(__dirname, 'fixtures', 'deep_lsb.png');
  if (fs.existsSync(dp)) {
    const d = M.decodePNG(fs.readFileSync(dp), {});
    const scan = M.scanImage({ width: d.width, height: d.height, bitDepth: d.bitDepth, colorType: d.colorType, channels: d.channels }, { deep: true, maxBit: 3 });
    const text = scan.findings.map(f => [f.title, f.preview, f.detail].join('\n')).join('\n');
    check('深度扫描能命中 bit3', text.indexOf('flag{deep_lsb}') >= 0);
  }
  const tp = path.join(__dirname, 'fixtures', 'iend_trailer.png');
  if (fs.existsSync(tp)) {
    const b = fs.readFileSync(tp);
    const rep = M.repairPNG(b, {});
    check('修复副本保留 IEND 后载荷', !rep.error && Buffer.from(rep.bytes).toString('latin1').indexOf('flag{iend_trailer}') >= 0);
  }
}

console.log('\n== 内存边界 ==');
{
  const p = path.join(__dirname, 'fixtures', 'bmp_bad_colors.bmp');
  if (fs.existsSync(p)) {
    const r = M.analyze(fs.readFileSync(p), 'bmp_bad_colors.bmp', {});
    const imgs = r.images.filter(x => x.image && x.image.palette);
    const maxPal = imgs.reduce((m, x) => Math.max(m, x.image.palette.length), 0);
    check('BMP colorsUsed 被收敛（palette <= 768B）', maxPal <= 768, 'palette=' + maxPal);
    check('BMP colorsUsed 异常已报告', r.findings.some(f => f.title.indexOf('调色板声明数量异常') >= 0));
  }
}

console.log('\n== 修复 ==');
{
  const cf = path.join(__dirname, 'fixtures', 'crc_fixed_height.png');
  if (fs.existsSync(cf)) {
    const b = fs.readFileSync(cf);
    const rec = M.recoverDims(b, { limit: 4000 });
    check('CRC 被重算后仍能靠 IDAT 还原 32x48', rec.candidates.some(c => c.width === 32 && c.height === 48));
  }
  const p = 'Z:/laragon/ctf/challenges/school/123/misc/1.png';
  if (fs.existsSync(p)) {
    const b = fs.readFileSync(p);
    const rec = M.recoverDims(b, { limit: 4000 });
    check('尺寸恢复首选 1587x2245', rec.candidates.length > 0 && rec.candidates[0].width === 1587 && rec.candidates[0].height === 2245 && rec.candidates[0].crcOk,
      JSON.stringify(rec.candidates[0] || {}));
    const rep = M.repairPNG(b, { width: 1587, height: 2245 });
    check('修复副本可重新解析', !rep.error && rep.bytes.length > 0);
    const parsed = M.parseChunks(rep.bytes);
    const ihdr = M.parseIHDR(parsed.chunks.find(c => c.type === 'IHDR'));
    check('修复后 IHDR 尺寸正确', ihdr.width === 1587 && ihdr.height === 2245);
    check('修复后 IHDR CRC 通过', parsed.chunks.find(c => c.type === 'IHDR').crcOk);
    check('修复后所有 chunk CRC 通过', parsed.chunks.every(c => c.crcOk));
  } else console.log('  SKIP 1.png');
}

console.log('\n== 音频 ==');
{
  const wav = fs.readFileSync(path.join(__dirname, 'fixtures', 'wav_lsb.wav'));
  const p = M.parseWAV(wav);
  const pcm = M.decodeWAVPCM(p, wav);
  check('WAV fmt/data 解析', !p.error && p.fmt.channels === 1 && p.fmt.sampleRate === 8000 && p.fmt.bits === 16 && p.dataChunks.length === 1, p.error || JSON.stringify(p.fmt));
  check('WAV PCM 帧数', !pcm.error && pcm.frames === 1600 && pcm.channels === 1, pcm.error || String(pcm.frames));
  const r = M.analyze(wav, 'wav_lsb.wav', {});
  const text = findingText(r);
  check('WAV LSB flag', text.indexOf('flag{wav_lsb}') >= 0);
  check('WAV 音频对象', !!r.audio && r.audio.format === 'WAV' && r.audio.pcm && r.audio.pcm.frames === 1600);

  const morseWav = fs.readFileSync(path.join(__dirname, 'fixtures', 'wav_morse.wav'));
  const mp = M.decodeWAVPCM(M.parseWAV(morseWav), morseWav);
  const m = M.morseDecode(mp);
  check('Morse SOS', m.text === 'SOS' && m.elements >= 6, JSON.stringify(m));
  const sp = M.spectrogram(mp, { fftSize: 1024 });
  let best = -1e9, bestK = 0;
  for (let k = 0; k < sp.height; k++) {
    let sum = 0;
    for (let f = 0; f < sp.width; f++) sum += sp.data[f * sp.height + k];
    if (sum > best) { best = sum; bestK = k; }
  }
  const peakFreq = bestK * sp.sampleRate / sp.fftSize;
  check('频谱峰值 ~800Hz', sp.width > 10 && Math.abs(peakFreq - 800) < 40, `peak=${peakFreq.toFixed(1)}Hz frames=${sp.width}`);

  const stereo = fs.readFileSync(path.join(__dirname, 'fixtures', 'wav_stereo_lsb.wav'));
  const sr = M.analyze(stereo, 'wav_stereo_lsb.wav', {});
  check('WAV 立体声 LSB flag', findingText(sr).indexOf('flag{wav_stereo}') >= 0);

  const ext = fs.readFileSync(path.join(__dirname, 'fixtures', 'wav_extensible.wav'));
  const er = M.analyze(ext, 'wav_extensible.wav', {});
  check('WAVE_FORMAT_EXTENSIBLE 解码', findingText(er).indexOf('flag{wav_extensible}') >= 0 && !findingText(er).includes('非 PCM/float WAV'));

  const mp3 = fs.readFileSync(path.join(__dirname, 'fixtures', 'mp3_id3.mp3'));
  const tag = M.parseID3v2(mp3, 0);
  check('ID3v2 帧解析', !!tag && tag.version === 3 && tag.frames.some(f => f.id === 'TXXX') && tag.frames.some(f => f.id === 'APIC'), tag ? tag.frames.map(f => f.id).join(',') : 'null');
  const mr = M.analyze(mp3, 'mp3_id3.mp3', {});
  const mt = findingText(mr);
  check('ID3 文本/APIC 命中', mt.indexOf('flag{id3_txxx}') >= 0 && mt.indexOf('ID3 APIC') >= 0);
  const v1 = M.parseID3v1(fs.readFileSync(path.join(__dirname, 'fixtures', 'mp3_id3v1.mp3')));
  check('ID3v1 解析', !!v1 && v1.comment.indexOf('flag{id3v1_only}') >= 0, JSON.stringify(v1));
  const v22 = M.analyze(fs.readFileSync(path.join(__dirname, 'fixtures', 'mp3_id3v22.mp3')), 'mp3_id3v22.mp3', {});
  check('ID3v2.2 PIC', findingText(v22).indexOf('flag{id3v22}') >= 0 && findingText(v22).indexOf('ID3 APIC') >= 0);

  {
    const ss = n => Uint8Array.from([(n >> 21) & 127, (n >> 14) & 127, (n >> 7) & 127, n & 127]);
    const cat = arr => { const n = arr.reduce((a, x) => a + x.length, 0), o = new Uint8Array(n); let p = 0; for (const x of arr) { o.set(x, p); p += x.length; } return o; };
    const frame = (id, payload, flags) => cat([Buffer.from(id), ss(payload.length), Uint8Array.from([(flags >> 8) & 255, flags & 255]), payload]);
    const tagOf = frameData => cat([Uint8Array.from([73, 68, 51, 4, 0, 0]), ss(frameData.length), frameData]);
    const unsync = frame('TIT2', Uint8Array.from([0, 65, 0xff, 0, 66]), 0x0002);
    const t4 = M.parseID3v2(tagOf(unsync), 0);
    check('ID3v2.4 帧 unsync', !!t4 && Array.from(t4.frames[0].data).join(',') === '0,65,255,66' && M.decodeID3Text(t4.frames[0].data.subarray(1), 0) === 'AÿB', t4 ? Array.from(t4.frames[0].data).join(',') : 'null');
    const dliPayload = cat([ss(3), Uint8Array.from([0, 65, 66])]);
    const dli = frame('TIT2', dliPayload, 0x0001);
    const td = M.parseID3v2(tagOf(dli), 0);
    check('ID3v2.4 帧 DLI', !!td && M.decodeID3Text(td.frames[0].data.subarray(1), 0) === 'AB', td ? Array.from(td.frames[0].data).join(',') : 'null');
  }
}

console.log('\n== PCAP ==');
{
  const pb = fs.readFileSync(path.join(__dirname, 'fixtures', 'pcap_http.pcap'));
  const p = M.parsePCAP(pb);
  check('pcap 全局头/包数', !p.error && p.format === 'pcap' && p.linkTypes[0] === 1 && p.packets.length === 6, p.error || JSON.stringify({ n: p.packets.length, lt: p.linkTypes }));
  check('pcap 尾挂识别', !!p.trailing && p.trailing.length === 18, p.trailing && String(p.trailing.length));
  const r = M.analyze(pb, 'pcap_http.pcap', {});
  const text = findingText(r);
  check('PCAP HTTP flag', text.indexOf('flag{pcap_http}') >= 0);
  check('PCAP 乱序 TCP 重组', text.indexOf('flag{pcap_order}') >= 0);
  check('PCAP DNS 查询', !!r.pcap && r.pcap.dns.some(x => x.name === 'flag.example.com'), r.pcap ? JSON.stringify(r.pcap.dns) : 'no pcap');
  check('PCAP TTL 异常', !!r.pcap && r.pcap.ttlAnomalies.some(x => x.min <= 3 && x.max >= 64), r.pcap ? JSON.stringify(r.pcap.ttlAnomalies) : 'no pcap');
  check('PCAP HTTP 请求', !!r.pcap && r.pcap.http.some(x => x.kind === 'request' && x.path === '/flag'), r.pcap ? JSON.stringify(r.pcap.http) : 'no pcap');
  const st = r.pcap && r.pcap.streams.find(s => s.sport === 12347);
  check('PCAP 流 TTL 可见', !!st && st.ttlMin === 64, st ? JSON.stringify(st) : 'no stream');

  const ng = fs.readFileSync(path.join(__dirname, 'fixtures', 'pcap_ng.pcapng'));
  const np = M.parsePCAP(ng);
  check('pcapng 解析', !np.error && np.format === 'pcapng' && np.packets.length === 1 && np.linkTypes[0] === 1, np.error || JSON.stringify({ n: np.packets.length, lt: np.linkTypes }));
  const nr = M.analyze(ng, 'pcap_ng.pcapng', {});
  check('pcapng flag', findingText(nr).indexOf('flag{pcapng}') >= 0);

  const ip6 = fs.readFileSync(path.join(__dirname, 'fixtures', 'pcap_ipv6.pcap'));
  const ir = M.analyze(ip6, 'pcap_ipv6.pcap', {});
  check('IPv6 UDP flag', findingText(ir).indexOf('flag{pcap_ipv6}') >= 0);
  const nbe = M.parsePCAP(fs.readFileSync(path.join(__dirname, 'fixtures', 'pcap_ng_be.pcapng')));
  check('pcapng 大端解析', !nbe.error && nbe.packets.length === 1 && nbe.linkTypes[0] === 1, nbe.error || JSON.stringify({ n: nbe.packets.length }));
  const spb = M.parsePCAP(fs.readFileSync(path.join(__dirname, 'fixtures', 'pcap_ng_spb.pcapng')));
  check('pcapng SPB 去填充', !spb.error && spb.packets.length === 1 && spb.packets[0].inclLen === spb.packets[0].origLen && spb.packets[0].inclLen % 4 !== 0, spb.error || JSON.stringify(spb.packets[0] && { incl: spb.packets[0].inclLen, orig: spb.packets[0].origLen }));

  const wrap = M.reassembleTCP([
    { src: 'a', dst: 'b', sport: 1, dport: 2, seq: 0xfffffff0, payload: Buffer.from('A'.repeat(32)), ttl: 64 },
    { src: 'a', dst: 'b', sport: 1, dport: 2, seq: 0x10, payload: Buffer.from('B'.repeat(16)), ttl: 64 }
  ]);
  check('TCP seq wrap 重组', wrap.length === 1 && Buffer.from(wrap[0].payload).toString() === 'A'.repeat(32) + 'B'.repeat(16) && wrap[0].retrans === 0, wrap[0] ? `${wrap[0].bytes}B retrans=${wrap[0].retrans}` : 'none');

  {
    const n = 100001;
    const capBuf = Buffer.alloc(24 + n * 16);
    capBuf.writeUInt32LE(0xa1b2c3d4, 0); capBuf.writeUInt16LE(2, 4); capBuf.writeUInt16LE(4, 6);
    capBuf.writeUInt32LE(65535, 16); capBuf.writeUInt32LE(1, 20);
    for (let i = 0; i < n; i++) capBuf.writeUInt32LE(1, 24 + i * 16);
    const cp = M.parsePCAP(capBuf);
    check('pcap 包数上限不误判尾挂', cp.packets.length === 100000 && cp.trailing === null && cp.warnings.some(x => x.indexOf('包数超过上限') >= 0), JSON.stringify({ n: cp.packets.length, tail: cp.trailing && cp.trailing.length, w: cp.warnings }));
  }
}

console.log('\n== 畸形输入（不得抛异常/挂死）==');
let fuzzFail = 0;
const t0 = Date.now();
for (const fx of meta.fixtures) {
  const bytes = Buffer.from(fx.b64, 'base64');
  const cuts = [0, 1, 2, 3, 5, 8, 10, 16, 32, 64, 100, 200, 500, Math.floor(bytes.length / 2), bytes.length - 1];
  for (const n of cuts) {
    if (n < 0 || n > bytes.length) continue;
    try {
      const r = M.analyze(bytes.subarray(0, n), 'cut-' + n, { maxScanPixels: 200000 });
      if (!r || !Array.isArray(r.findings)) throw new Error('bad result');
    } catch (e) { fuzzFail++; console.log('   throw', fx.name, n, e && e.message); }
  }
}
for (let i = 0; i < 60; i++) {
  const n = 1 + (i * 37) % 4096;
  const buf = crypto.randomBytes(n);
  try {
    const r = M.analyze(buf, 'rand-' + i, { maxScanPixels: 200000 });
    if (!r || !Array.isArray(r.findings)) throw new Error('bad result');
  } catch (e) { fuzzFail++; console.log('   throw random', n, e && e.message); }
}
check('畸形输入零异常', fuzzFail === 0, fuzzFail + ' 次异常');
check('畸形输入未挂死（<20s）', Date.now() - t0 < 20000, (Date.now() - t0) + 'ms');

console.log('\n== 报告生成 ==');
{
  const bytes = fs.readFileSync(path.join(__dirname, 'fixtures', 'second_stream.png'));
  const r = M.analyze(bytes, 'second_stream.png', {});
  const md = M.buildReport(r);
  check('报告含 find/产物/复现', md.indexOf('# misc大手子') >= 0 && md.indexOf('## 发现') >= 0 && md.indexOf('## 复现路径') >= 0);
}

console.log('\n== 双图对比 ==');
{
  const mk = vals => ({ width: vals.length, height: 1, channels: { R: Uint8Array.from(vals) } });
  const d = M.diffImages(mk([0, 255, 7]), mk([255, 255, 2]), { mode: 'xor' });
  check('XOR 逐像素', !d.error && d.data[0] === 255 && d.data[4] === 0 && d.data[8] === 5 && d.data[3] === 255, d.error || Array.from(d.data).join(','));
  check('XOR 统计', d.stats.changed === 2 && d.stats.pixels === 3 && d.stats.maxDiff === 255 && Math.abs(d.stats.meanDiff - 260 / 3) < 1e-9, JSON.stringify(d.stats));
  const ab = M.diffImages(mk([255, 10]), mk([0, 30]), { mode: 'abs' });
  check('绝对差', ab.data[0] === 255 && ab.data[4] === 20, Array.from(ab.data).join(','));
  const sb = M.diffImages(mk([0, 5]), mk([1, 7]), { mode: 'sub' });
  check('差值 a-b 取模', sb.data[0] === 255 && sb.data[4] === ((5 - 7) & 255), Array.from(sb.data).join(','));
  const mm = M.diffImages(mk([1, 2]), mk([1]), {});
  check('尺寸不符拒绝', !!mm.error && /尺寸不同/.test(mm.error), mm.error);
  const g = M.diffImages({ width: 1, height: 1, channels: { R: Uint8Array.from([3]) } }, { width: 1, height: 1, channels: { R: Uint8Array.from([1]) } }, { mode: 'xor' });
  check('灰度图三通道回退', g.data[0] === 2 && g.data[1] === 2 && g.data[2] === 2, Array.from(g.data).join(','));
  const short = M.diffImages({ width: 2, height: 2, channels: { R: Uint8Array.from([1, 2, 3, 4]) } }, { width: 2, height: 2, channels: { R: Uint8Array.from([1, 2]) } }, {});
  check('通道长度不符拒绝', !!short.error && /通道长度/.test(short.error), short.error);
  const zero = M.diffImages({ width: 0, height: 1, channels: { R: new Uint8Array(0) } }, { width: 0, height: 1, channels: { R: new Uint8Array(0) } }, {});
  check('零尺寸对比拒绝', !!zero.error, zero.error);
}

console.log('\n== 报告模板 / 批量报告 ==');
{
  const r = M.analyze(fs.readFileSync(path.join(__dirname, 'fixtures', 'second_stream.png')), 'second_stream.png', {});
  const full = M.buildReport(r);
  const brief = M.buildReport(r, { template: 'brief' });
  const wp = M.buildReport(r, { template: 'wp' });
  check('完整报告', full.indexOf('## 发现') >= 0 && full.indexOf('## 复现路径') >= 0);
  check('速报', brief.indexOf('速报') >= 0 && brief.indexOf('## 关键发现') >= 0 && brief.indexOf('flag{second_stream_lsb}') >= 0);
  check('WP 框架', wp.indexOf('## 一、题目信息') >= 0 && wp.indexOf('## 二、分析过程') >= 0 && wp.indexOf('## 三、flag') >= 0);
  const other = M.analyze(fs.readFileSync(path.join(__dirname, 'fixtures', 'bmp_gap.bmp')), 'bmp_gap.bmp', {});
  const batch = M.buildBatchReport([r, other]);
  check('批量报告含两个文件与 flag', batch.indexOf('second_stream.png') >= 0 && batch.indexOf('bmp_gap.bmp') >= 0 && batch.indexOf('## 汇总') >= 0 && batch.indexOf('flag{second_stream_lsb}') >= 0);
  check('批量报告表行数', (batch.match(/^\| \d+ \|/gm) || []).length === 2, String((batch.match(/^\| \d+ \|/gm) || []).length));
  const pipe = M.analyze(fs.readFileSync(path.join(__dirname, 'fixtures', 'second_stream.png')), 'a|b.png', {});
  check('WP 表格转义竖线', M.buildReport(pipe, { template: 'wp' }).indexOf('a\\|b.png') >= 0);
}

console.log('\n== 零尺寸图 ==');
{
  const b = Buffer.alloc(54);
  b.write('BM', 0);
  b.writeUInt32LE(54, 2);
  b.writeUInt32LE(54, 10);
  b.writeUInt32LE(40, 14);
  b.writeInt32LE(0, 18);
  b.writeInt32LE(1, 22);
  b.writeUInt16LE(1, 26);
  b.writeUInt16LE(24, 28);
  const info = M.parseBMP(b);
  const img = M.decodeBMP(b, info);
  check('零宽 BMP 解码拒绝', !!img.error && /宽高为 0/.test(img.error), img.error);
  check('零尺寸位平面返回 null', M.renderPlane({ width: 0, height: 1, channels: { R: new Uint8Array(0) } }, 'R', 0) === null);
  check('零尺寸缩略图返回 null', M.renderImage({ width: 0, height: 1, channels: { R: new Uint8Array(0) } }, 100) === null);
  let threw = false, r = null;
  try { r = M.analyze(b, 'zero-width.bmp', {}); } catch (e) { threw = true; }
  check('零宽 BMP 分析不抛异常', !threw && !!r, threw ? 'threw' : 'ok');
  check('零宽 BMP 有解码/跳过提示', !!r && r.findings.some(f => f.title.indexOf('BMP 像素解码失败') >= 0 || f.title.indexOf('跳过零尺寸') >= 0), r ? r.findings.map(f => f.title).join(' / ') : '');
  check('零宽 BMP 不进入图像列表', !!r && !(r.images || []).some(x => x.image && (x.image.width <= 0 || x.image.height <= 0)));
}

console.log('\n== 递归树父子链 ==');
{
  const r = M.analyze(fs.readFileSync(path.join(__dirname, 'fixtures', 'nested_png.png')), 'nested_png.png', { maxDepth: 3 });
  check('每个文件都有 id', r.files.length > 1 && r.files.every(f => typeof f.id === 'number'), JSON.stringify(r.files.map(f => f.id)));
  const ids = new Set(r.files.map(f => f.id));
  check('父节点全部可解析', r.files.filter(f => f.id !== 0).every(f => typeof f.parentId === 'number' && ids.has(f.parentId)), JSON.stringify(r.files.map(f => [f.id, f.parentId])));
  const depths = new Map(r.files.map(f => [f.id, f.depth]));
  check('深度与父节点自洽', r.files.every(f => f.id === 0 ? f.depth === 0 : f.depth === depths.get(f.parentId) + 1), JSON.stringify(r.files.map(f => [f.id, f.parentId, f.depth])));
}

console.log('\n== One PieNG 手法回归 ==');
{
  M.setFlagFormat('#{}#');   // 这场赛题用 # 包 flag；默认是 flag{}
  const SIGP = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  const mkChunk = (type, data) => {
    const t = Buffer.from(type, 'latin1');
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(M.crc32(Buffer.concat([t, data])) >>> 0);
    return Buffer.concat([len, t, data, crc]);
  };
  const mkPng = (w, h, px, extra) => {
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
    const rowLen = w * 4 + 1;
    const raw = Buffer.alloc(rowLen * h);
    for (let y = 0; y < h; y++) {
      raw[y * rowLen] = 0;
      Buffer.from(px.buffer, y * w * 4, w * 4).copy(raw, y * rowLen + 1);
    }
    const parts = [SIGP, mkChunk('IHDR', ihdr), mkChunk('IDAT', zlib.deflateSync(raw))];
    for (const [t, d] of extra || []) parts.push(mkChunk(t, d));
    parts.push(mkChunk('IEND', Buffer.alloc(0)));
    return Buffer.concat(parts);
  };
  const W = 40, H = 40;
  const blank = () => { const p = new Uint8Array(W * H * 4); p.fill(200); return p; };
  // 按 extract() 的读取顺序写回像素：每个像素先按通道序、再按位序
  const embed = (px, text, chans, bits, col) => {
    const stream = [];
    for (const ch of text) for (let i = 7; i >= 0; i--) stream.push((ch.charCodeAt(0) >> i) & 1);
    let k = 0;
    const visit = (x, y) => {
      for (const c of chans) for (const b of bits) {
        if (k >= stream.length) return;
        const i = (y * W + x) * 4 + c;
        px[i] = (px[i] & ~(1 << b)) | (stream[k++] << b);
      }
    };
    if (col) { for (let x = 0; x < W && k < stream.length; x++) for (let y = 0; y < H && k < stream.length; y++) visit(x, y); }
    else { for (let y = 0; y < H && k < stream.length; y++) for (let x = 0; x < W && k < stream.length; x++) visit(x, y); }
  };

  const agbr = blank();
  embed(agbr, '#agbr_ok#', [3, 1, 2, 0], [7], true);          // AGBR, bit7, 列序
  const rAgbr = M.analyze(mkPng(W, H, agbr), 'agbr.png', { deep: true, maxScanPixels: 100000 });
  check('AGBR 四通道 bit7 列序能解出 # 型 flag', M.flags(rAgbr).indexOf('#agbr_ok#') >= 0, M.flags(rAgbr).join(' '));

  const multi = blank();
  embed(multi, '#multi_bit#', [0, 1, 2], [1, 2], false);      // RGB, bit1+bit2, 行序
  const rMulti = M.analyze(mkPng(W, H, multi), 'multi.png', { deep: true, maxScanPixels: 100000 });
  check('RGB bit1+2 多位组合能解出 flag', M.flags(rMulti).indexOf('#multi_bit#') >= 0, M.flags(rMulti).join(' '));

  // CRC 字段当 ASCII
  const crcPng = mkPng(W, H, blank());
  const idatPos = crcPng.indexOf(Buffer.from('IDAT'));
  const crcPos = idatPos - 4 + 8 + crcPng.readUInt32BE(idatPos - 4);
  Buffer.from('#AbC', 'latin1').copy(crcPng, crcPos);
  const rCrc = M.analyze(crcPng, 'crc.png', {});
  const crcFinding = rCrc.findings.find(f => f.type === 'crc_ascii');
  check('CRC 字段里的 ASCII 会被读出来', !!crcFinding && crcFinding.preview.indexOf('#AbC') >= 0, crcFinding ? crcFinding.preview : '无');

  // 伪 chunk
  const rFake = M.analyze(mkPng(W, H, blank(), [['tXEt', Buffer.from('x#fake_chunk#x', 'latin1')]]), 'fake.png', {});
  const fakeFinding = rFake.findings.find(f => f.type === 'chunk_name');
  check('非标准 chunk 类型被点名', !!fakeFinding && fakeFinding.title.indexOf('tXEt') >= 0, fakeFinding ? fakeFinding.title : '无');
  check('伪 chunk 里的 # 型 flag 被抓出', M.flags(rFake).indexOf('#fake_chunk#') >= 0, M.flags(rFake).join(' '));

  // 元数据 hex
  const hexPayload = Buffer.from('#meta_hex#', 'latin1').toString('hex');
  const rMeta = M.analyze(mkPng(W, H, blank(), [['tEXt', Buffer.from('Comment\0' + hexPayload, 'latin1')]]), 'meta.png', {});
  const metaFinding = rMeta.findings.find(f => f.type === 'meta_decode');
  check('tEXt 里的 hex 自动解码', !!metaFinding && metaFinding.actual.indexOf('#meta_hex#') >= 0, metaFinding ? metaFinding.actual : '无');

  // 默认格式（flag{...}）不应该把 # 型当 flag；换回自定义才认
  M.setFlagFormat('flag{}');
  const rDefault = M.analyze(mkPng(W, H, blank(), [['tXEt', Buffer.from('#fake_chunk#', 'latin1')]]), 'fake2.png', {});
  check('默认格式不认 # 型 flag', M.flags(rDefault).indexOf('#fake_chunk#') < 0, M.flags(rDefault).join(' '));
  const rFlagBraces = M.analyze(mkPng(W, H, blank(), [['tEXt', Buffer.from('K\0flag{std_fmt}', 'latin1')]]), 'std.png', {});
  check('默认格式认 flag{...}', M.flags(rFlagBraces).indexOf('flag{std_fmt}') >= 0, M.flags(rFlagBraces).join(' '));
  M.setFlagFormat('flag{}');   // 恢复默认，别影响后面的用例
}

console.log('\n== 编码侦探 / 画字 / 频域 / 新载体 ==');
{
  const s = b => (b ? Buffer.from(b).toString('latin1') : null);
  check('base32 "MZXW6===" → foo', s(M.b32decode('MZXW6===')) === 'foo');
  check('ascii85 → Hello World!', s(M.a85decode('<~87cURD]i,"Ebo80~>')) === 'Hello World!');
  check('base91 → Hello World!', s(M.b91decode('>OwJh>Io0Tv!8PE')) === 'Hello World!');
  check('uuencode 多行', s(M.uudecode(['begin 644 x', '#86)C', '"9&4 ', '`', 'end'].join('\n'))) === 'abcde');
  check('rot13 / rot47', M.rotN('Uryyb', 13) === 'Hello' && M.rot47('w6==@') === 'Hello');
  const nestHex = Buffer.from(Buffer.from('flag{nest}').toString('base64'), 'latin1').toString('hex');
  check('两层链 hex→base64', M.decodeChain(nestHex).some(r => r.text === 'flag{nest}'), nestHex);
  check('scanText 认出 base32', M.scanText('x MZXW6YTBOI====== y').some(r => r.text === 'foobar'));

  const W = 200, H = 24;
  const R = new Uint8Array(W * H), G = new Uint8Array(W * H), B = new Uint8Array(W * H);
  R.fill(100); G.fill(100); B.fill(100);
  const ink = (x, y) => { B[y * W + x] = 101; };
  for (let cell = 0; cell < 20; cell++) {
    const x0 = 10 + cell * 8;
    for (let y = 6; y < 14; y++) ink(x0, y);
    for (let x = x0; x < x0 + 4; x++) ink(x, 6);
  }
  const dr = M.detectDrawn({ width: W, height: H, channels: { R, G, B } });
  check('画字检测能定位到平底上的笔画', dr.findings.length >= 1, dr.findings.map(f => f.title).join(' | '));
  check('画字候选带裁剪图', !!(dr.artifacts[0] && dr.artifacts[0].image && dr.artifacts[0].image.width > 40));

  const SW = 128, SH = 128;
  const RA = new Uint8Array(SW * SH), GA = new Uint8Array(SW * SH), BA = new Uint8Array(SW * SH);
  for (let y = 0; y < SH; y++) {
    for (let x = 0; x < SW; x++) {
      const v = Math.round(128 + 60 * Math.sin(2 * Math.PI * x / 8));
      RA[y * SW + x] = GA[y * SW + x] = BA[y * SW + x] = v;
    }
  }
  const sp = M.spectrum({ width: SW, height: SH, channels: { R: RA, G: GA, B: BA } });
  check('频域峰值落在 ±0.125', sp.peaks.slice(0, 2).every(p => Math.abs(Math.abs(p.fx) - 0.125) < 1e-6 && p.fy === 0), JSON.stringify(sp.peaks.slice(0, 2)));

  const be32 = v => { const b = Buffer.alloc(4); b.writeUInt32BE(v >>> 0); return b; };
  const be16 = v => { const b = Buffer.alloc(2); b.writeUInt16BE(v & 0xffff); return b; };
  const le32 = v => { const b = Buffer.alloc(4); b.writeUInt32LE(v >>> 0); return b; };
  const le16 = v => { const b = Buffer.alloc(2); b.writeUInt16LE(v & 0xffff); return b; };
  const ttf = Buffer.concat([
    be32(0x00010000), be16(1), be16(16), be16(0), be16(0),
    Buffer.from('cmap', 'latin1'), be32(0), be32(28), be32(16),
    Buffer.from('flag{font_tail}XX', 'latin1'),
    Buffer.from('TRAILflag{after_tables}', 'latin1')
  ]);
  const rt = M.analyze(ttf, 'x.ttf', {});
  check('TTF 目录解析 + 尾部 flag', M.flags(rt).indexOf('flag{after_tables}') >= 0, M.flags(rt).join(' '));

  const db = Buffer.alloc(4096);
  Buffer.from('SQLite format 3\0', 'latin1').copy(db, 0);
  be16(4096).copy(db, 16); be32(1).copy(db, 28); be32(1).copy(db, 56);
  const sqlite = Buffer.concat([db, Buffer.from('flag{sqlite_tail}', 'latin1')]);
  const rd = M.analyze(sqlite, 'x.db', {});
  check('SQLite 页结构 + 尾部 flag', M.flags(rd).indexOf('flag{sqlite_tail}') >= 0, M.flags(rd).join(' '));

  const elf = Buffer.alloc(64);
  Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0]).copy(elf, 0);
  le16(2).copy(elf, 16); le16(0x3e).copy(elf, 18); le32(64).copy(elf, 40); le16(64).copy(elf, 58); le16(0).copy(elf, 60);
  const re = M.analyze(Buffer.concat([elf, Buffer.from('flag{elf_tail}', 'latin1')]), 'x.elf', {});
  check('ELF 头 + 尾部 flag', M.flags(re).indexOf('flag{elf_tail}') >= 0, M.flags(re).join(' '));

  const tiny = { width: 3, height: 2, channels: { R: Uint8Array.from([1, 2, 3, 4, 5, 6]), G: Uint8Array.from([7, 8, 9, 10, 11, 12]), B: Uint8Array.from([13, 14, 15, 16, 17, 18]) } };
  const bmpBytes = M.encodeBMP(tiny);
  const bmpInfo = M.parseBMP(bmpBytes);
  const bmpBack = M.decodeBMP(bmpBytes, bmpInfo);
  check('encodeBMP 往返一致', bmpInfo.width === 3 && bmpInfo.height === 2 && bmpBack && bmpBack.channels && bmpBack.channels.R[0] === 1 && bmpBack.channels.R[5] === 6 && bmpBack.channels.B[0] === 13);
}
console.log('\n== 节点编辑器 / CRC 工具 / JPEG 熵自检 / 自定义宽高 ==');
{
  const mk = (w, h, fn) => {
    const n = w * h;
    const R = new Uint8Array(n), G = new Uint8Array(n), B = new Uint8Array(n), A = new Uint8Array(n).fill(255);
    for (let i = 0; i < n; i++) {
      const o = fn(i % w, Math.floor(i / w));
      R[i] = o[0]; G[i] = o[1]; B[i] = o[2];
    }
    return { width: w, height: h, channels: { R, G, B, A } };
  };
  const src = mk(4, 1, x => [x * 10, x * 20, x * 30]);
  const op = (t, p, ins) => M.applyNodeOp(t, p, ins);

  const ch = op('channel', { ch: 'R' }, [src]).image;
  check('节点 通道提取', ch.channels.R[1] === 10 && ch.channels.G[1] === 10);
  const pl = op('plane', { ch: 'R', bit: 1 }, [src]).image;
  check('节点 位平面', pl.channels.R[1] === 255 && pl.channels.R[2] === 0);
  const inv = op('invert', {}, [src]).image;
  check('节点 反色', inv.channels.R[1] === 245 && inv.channels.R[3] === 225);
  const ord = op('order', { order: 'BGR' }, [src]).image;
  check('节点 通道重排', ord.channels.R[1] === 30 && ord.channels.B[1] === 10);
  const cr = op('crop', { x: 1, y: 0, w: 2, h: 1 }, [src]).image;
  check('节点 裁剪', cr.width === 2 && cr.channels.R[0] === 10 && cr.channels.R[1] === 20);
  const sc = op('scale', { w: 3, h: 2 }, [src]).image;
  check('节点 缩放', sc.width === 3 && sc.height === 2 && sc.channels.R[2] === 20);
  const xo = op('xor', {}, [src, src]).image;
  check('节点 XOR 自等零', xo.channels.R.every(v => v === 0));
  const df = op('diff', {}, [src, mk(4, 1, x => [x * 10, 0, 0])]).image;
  check('节点 差值', df.channels.R[2] === 0 && df.channels.G[2] === 40);
  const po = op('posterize', { bits: 1 }, [mk(1, 1, () => [130, 10, 200])]).image;
  check('节点 量化', po.channels.R[0] === 255 && po.channels.G[0] === 0 && po.channels.B[0] === 255);
  const gy = op('gray', {}, [mk(1, 1, () => [10, 20, 30])]).image;
  check('节点 灰度', gy.channels.R[0] === 18 && gy.channels.G[0] === 18);
  const pa = op('palette', {}, [src]).image;
  check('节点 调色板', pa.width === 256 && pa.height === 16);

  const graph = [
    { id: 1, type: 'source' },
    { id: 2, type: 'channel', params: { ch: 'R' } },
    { id: 3, type: 'invert', params: {} },
    { id: 4, type: 'output' }
  ];
  const links = [{ from: 1, to: 2, port: 0 }, { from: 2, to: 3, port: 0 }, { from: 3, to: 4, port: 0 }];
  const gr = M.evalNodeGraph(graph, links, { 1: src });
  check('节点图链式求值', gr.images[4] && gr.images[4].channels.R[1] === 245, JSON.stringify(gr.errors));
  const cyc = M.evalNodeGraph(
    [{ id: 1, type: 'invert', params: {} }, { id: 2, type: 'output' }],
    [{ from: 2, to: 1, port: 0 }, { from: 1, to: 2, port: 0 }], {});
  check('节点图环检测不挂死', /环/.test(cyc.errors[1] || ''), JSON.stringify(cyc.errors));

  const b1 = M.crc32Brute(M.crc32(Buffer.from('abc')), { charset: 'abc', maxLen: 3 });
  check('CRC 反查命中 abc', b1.hits.indexOf('abc') >= 0, JSON.stringify(b1));
  const b2 = M.crc32Brute(M.crc32(Buffer.from('flag{abc}')), { charset: 'abc', maxLen: 3, prefix: 'flag{', suffix: '}' });
  check('CRC 反查带前后缀', b2.hits.indexOf('abc') >= 0, JSON.stringify(b2));

  const tiny = { width: 3, height: 2, channels: { R: Uint8Array.from([1, 2, 3, 4, 5, 6]), G: Uint8Array.from([7, 8, 9, 10, 11, 12]), B: Uint8Array.from([13, 14, 15, 16, 17, 18]) } };
  const bmpBytes = M.encodeBMP(tiny);
  const ed = M.editBMPDims(bmpBytes, 9, 4);
  const edInfo = M.parseBMP(ed.bytes);
  check('BMP 自定义宽高', !ed.error && edInfo.width === 9 && edInfo.absH === 4 && ed.bytes.length === bmpBytes.length, ed.error || '');

  const pngIn = fs.readFileSync(path.join(__dirname, 'fixtures', 'bad_crc_height.png'));
  const pngOut = M.repairPNG(pngIn, { width: 17, height: 9 });
  const pp = M.parseChunks(pngOut.bytes);
  const ih = M.parseIHDR(pp.chunks.find(c => c.type === 'IHDR'));
  check('PNG 自定义宽高 + CRC 重算', !pngOut.error && ih.width === 17 && ih.height === 9 && pp.chunks.every(c => c.crcOk), pngOut.error || '');

  const gifBuf = fs.readFileSync(path.join(__dirname, 'fixtures', 'gif_lzw.gif'));
  const rg = M.analyze(gifBuf, 'gif_lzw.gif', {});
  check('GIF 逐帧元数据入结果', !!rg.gif && rg.gif.frames.length === 2 && !!rg.gif.frames[0].image && !!rg.gif.frames[0].image.palette,
    rg.gif ? JSON.stringify({ frames: rg.gif.frames.length, img: !!rg.gif.frames[0].image, pal: !!(rg.gif.frames[0].image && rg.gif.frames[0].image.palette) }) : 'no gif');

  // 16x16 灰度基线 JPEG（来自 CRC_CHECK/image-crc.html 的自检向量）
  const jpgHex = 'ffd8ffe000104a46494600010100000100010000ffdb004300080606070605080707070909080a0c140d0c0b0b0c1912130f141d1a1f1e1d1a1c1c20242e2720222c231c1c2837292c30313434341f27393d38323c2e333432ffc0000b080010001001011100ffc4001f0000010501010101010100000000000000000102030405060708090a0bffc400b5100002010303020403050504040000017d01020300041105122131410613516107227114328191a1082342b1c11552d1f02433627282090a161718191a25262728292a3435363738393a434445464748494a535455565758595a636465666768696a737475767778797a838485868788898a92939495969798999aa2a3a4a5a6a7a8a9aab2b3b4b5b6b7b8b9bac2c3c4c5c6c7c8c9cad2d3d4d5d6d7d8d9dae1e2e3e4e5e6e7e8e9eaf1f2f3f4f5f6f7f8f9faffda0008010100003f00e07c1d6dfeaf8af79f0ecb6fa669d35fde3f976b6b134d33ed276a28cb1c0e4e003d2bc7bc1d6dfeaf8af4df155ccda57c2bd72e2048d9dedc5b90e091b6575898f0473b5c91ef8ebd2bffd9';
  const jpg = Buffer.from(jpgHex, 'hex');
  const je = M.analyzeJPEGEntropy(jpg);
  check('JPEG 熵自检：合法图剩余 0', je.supported && je.ok && je.leftover === 0 && je.extra === 0, JSON.stringify(je));
  const jt = Buffer.from(jpg);
  jt[je.hOff] = 0; jt[je.hOff + 1] = 8;
  const jb = M.analyzeJPEGEntropy(jt);
  check('JPEG 熵自检：高度改小被检出', jb.ok && jb.leftover > 0 && jb.suggestedH === 16, JSON.stringify(jb));
  const jed = M.editJPEGDims(jpg, 8, 12);
  const jSegs = M.parseSegments(jed.bytes);
  const jSof = jSegs.segs.find(s => s.marker === 0xC0);
  check('JPEG 自定义宽高', !jed.error && jSof && ((jSof.data[1] << 8) | jSof.data[2]) === 12 && ((jSof.data[3] << 8) | jSof.data[4]) === 8, jed.error || '');
  const jrec = M.recoverJPEGDims(jpg);
  check('JPEG 尺寸候选含 16x16', !jrec.error && jrec.candidates.some(c => c.width === 16 && c.height === 16), jrec.error || JSON.stringify(jrec.candidates.slice(0, 4)));

  // BMP：文件末尾再压 3 行像素，头里仍写 3x2 → 应反推出 3x5
  const bmpPad = M.encodeBMP(tiny);
  const rowPad = Buffer.alloc(12);
  const bmpExtra = Buffer.concat([bmpPad, rowPad, rowPad, rowPad]);
  const brec = M.recoverBMPDims(bmpExtra);
  check('BMP 尺寸候选含 3x5', !brec.error && brec.widthFixed.some(c => c.width === 3 && c.height === 5), brec.error || JSON.stringify(brec.widthFixed.slice(0, 4)));

  // GIF：把帧高度改小 4 行，LZW 里仍有多余像素 → 应报 gif_extra_rows
  const gif0 = fs.readFileSync(path.join(__dirname, 'fixtures', 'gif_lzw.gif'));
  const gp0 = M.parseGIF(gif0);
  const f0 = gp0.frames[0];
  const shrunk = Buffer.from(gif0);
  const nh = Math.max(2, f0.height - 4);
  shrunk[f0.offset + 7] = nh & 255;
  shrunk[f0.offset + 8] = (nh >> 8) & 255;
  const rShrunk = M.analyze(shrunk, 'gif-shrunk.gif', {});
  const extraF = rShrunk.findings.find(x => x.type === 'gif_extra_rows');
  check('GIF 多余扫描行被检出', !!extraF && rShrunk.gif && rShrunk.gif.frames[0].extraRows === 4 && rShrunk.gif.frames[0].fullHeight === f0.height,
    extraF ? JSON.stringify({ extra: rShrunk.gif.frames[0].extraRows, full: rShrunk.gif.frames[0].fullHeight }) : '无 gif_extra_rows');
  const ged = M.editGIFDims(gif0, 0, f0.height + 3);
  const gp2 = M.parseGIF(ged.bytes);
  check('GIF 帧高/画布高度可改', !ged.error && gp2.frames[0].height === f0.height + 3 && gp2.lsd.height >= f0.height + 3, ged.error || JSON.stringify({ h: gp2.frames[0].height, lsd: gp2.lsd.height }));
}
console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
if (fail) { console.log('失败项：\n - ' + failures.join('\n - ')); process.exit(1); }
