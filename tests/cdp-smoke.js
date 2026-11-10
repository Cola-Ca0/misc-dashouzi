#!/usr/bin/env node
/* 浏览器冒烟：自检 → 上传 fixture → 结果面板。需要本机 Edge。 */
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const ROOT = path.resolve(__dirname, '..');
const EDGE = process.env.EDGE || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PORT = parseInt(process.env.CDP_PORT || '9366', 10);
const PAGE = pathToFileURL(process.env.PAGE_FILE || path.join(ROOT, 'misc-dashouzi.html')).href + '?selftest=1';
const FIX = process.env.FIX || path.join(ROOT, 'tests', 'fixtures', 'second_stream.png');
const EXPECT = process.env.EXPECT || '';
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'mdz-cdp-'));
const sleep = ms => new Promise(r => setTimeout(r, ms));

function zeroBmp() {
  const b = Buffer.alloc(54);
  b.write('BM', 0);
  b.writeUInt32LE(54, 2);
  b.writeUInt32LE(54, 10);
  b.writeUInt32LE(40, 14);
  b.writeInt32LE(0, 18);
  b.writeInt32LE(1, 22);
  b.writeUInt16LE(1, 26);
  b.writeUInt16LE(24, 28);
  return b;
}

(async () => {
  if (!fs.existsSync(EDGE)) throw new Error('找不到 Edge：' + EDGE);
  if (!fs.existsSync(FIX)) throw new Error('缺少 fixture，请先 python build.py');
  const proc = spawn(EDGE, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`,
    '--no-first-run', '--no-default-browser-check', '--disable-extensions', 'about:blank'], { stdio: 'ignore' });
  try {
    let ver = null;
    for (let i = 0; i < 120; i++) {
      try { ver = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); break; } catch (e) { await sleep(150); }
    }
    if (!ver) throw new Error('Edge 未启动');
    const ws = new WebSocket(ver.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    let seq = 0; const pending = new Map();
    ws.onmessage = ev => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); }
    };
    const send = (method, params = {}, sessionId) => new Promise((res, rej) => {
      const id = ++seq; pending.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params, sessionId }));
    });
    const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
    const { sessionId: S } = await send('Target.attachToTarget', { targetId, flatten: true });
    await send('Page.enable', {}, S); await send('Runtime.enable', {}, S); await send('DOM.enable', {}, S);
    // 固定成桌面视口：默认无头窗口只有 750×485，右侧「当前图像」栏会被窄屏规则隐藏
    await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false }, S);
    const ev = async (expression) => {
      const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, S);
      if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text);
      return r.result.value;
    };
    const waitFor = async (expr, timeout = 15000) => {
      const t = Date.now();
      while (Date.now() - t < timeout) { if (await ev(`!!(${expr})`)) return true; await sleep(100); }
      return false;
    };
    await send('Page.navigate', { url: PAGE }, S);
    let diagSelf = null;
    if (!await waitFor(`document.querySelector('#selftest') && document.querySelector('#selftest').textContent.includes('自检')`)) throw new Error('自检未完成');
    const st = await ev(`document.querySelector('#selftest').textContent.match(/自检 — (\\d+) 通过 \\/ (\\d+) 失败/)`);
    if (!st || st[2] !== '0') throw new Error('自检失败：' + JSON.stringify(st));
    diagSelf = { pass: +st[1], fail: +st[2] };
    const { root } = await send('DOM.getDocument', {}, S);
    const { nodeId } = await send('DOM.querySelector', { nodeId: root.nodeId, selector: '#file' }, S);
    await send('DOM.setFileInputFiles', { files: [FIX], nodeId }, S);
    if (!await waitFor(`document.querySelector('#status').textContent.includes('完成')`)) throw new Error('上传后分析未完成：' + await ev(`document.querySelector('#status').textContent`));
    const diag = await ev(`(() => ({
      status: document.querySelector('#status').textContent,
      hasResult: !!document.querySelector('#result') && document.querySelector('#result').style.display !== 'none',
      selftestHidden: document.querySelector('#selftest').style.display === 'none',
      findings: document.querySelectorAll('.finding').length,
      worker: (window.MDZ_DIAG || {}).worker || 'none',
      err: document.querySelector('#status').textContent.includes('失败')
    }))()`);
    if (diag.err || !diag.hasResult || !diag.selftestHidden || diag.findings < 1) throw new Error('UI 状态异常：' + JSON.stringify(diag));
    // Worker 是「大文件不卡死」的关键路径，必须真的跑起来（file:// 下 blob worker 可用）
    if (diag.worker !== 'on') throw new Error('分析没走 Worker：' + diag.worker);
    if (EXPECT) {
      const body = await ev(`document.querySelector('#result').innerText`);
      if (body.indexOf(EXPECT) < 0) throw new Error('结果中未找到 ' + EXPECT);
    }

    // 位平面缩放
    const zoom = await ev(`(() => {
      const b = document.querySelector('#v-zin');
      if (!b) return null;
      const cv = document.querySelector('#v-canvas');
      const before = cv.style.width;
      b.click();
      return { before, after: cv.style.width, label: document.querySelector('#v-zoom').textContent };
    })()`);
    if (zoom && zoom.after === zoom.before) throw new Error('位平面缩放未生效：' + JSON.stringify(zoom));

    // 批量：两个同尺寸图 → 批量列表 + 双图对比
    const FIX2 = process.env.FIX2 || path.join(ROOT, 'tests', 'fixtures', 'deep_lsb.png');
    if (!fs.existsSync(FIX2)) throw new Error('缺少批量 fixture：' + FIX2);
    await send('DOM.setFileInputFiles', { files: [FIX, FIX2], nodeId }, S);
    if (!await waitFor(`document.querySelectorAll('.batch-row').length === 2 && document.querySelector('#status').textContent.includes('批量完成：2 个文件')`, 30000)) {
      throw new Error('批量分析未完成：' + await ev(`document.querySelector('#status').textContent`));
    }
    const bd = await ev(`(() => ({
      rows: document.querySelectorAll('.batch-row').length,
      on: document.querySelectorAll('.batch-row.on').length,
      diff: !!document.querySelector('#d-a') && !!document.querySelector('#d-b'),
      diffW: document.querySelector('#d-canvas') ? document.querySelector('#d-canvas').width : 0,
      diffH: document.querySelector('#d-canvas') ? document.querySelector('#d-canvas').height : 0,
      diffNote: document.querySelector('#d-note') ? document.querySelector('#d-note').textContent : '',
      status: document.querySelector('#status').textContent
    }))()`);
    if (bd.rows !== 2 || bd.on !== 1) throw new Error('批量列表异常：' + JSON.stringify(bd));
    // 默认 fixture 是 64x32 同尺寸图，必须真的画出来，而不是 canvas 的默认 300x150
    if (!process.env.FIX) {
      if (!bd.diff || bd.diffW !== 64 || bd.diffH !== 32 || !/^XOR · 64x32 · 变化 \d+ 像素/.test(bd.diffNote)) {
        throw new Error('默认 fixture 双图对比异常：' + JSON.stringify(bd));
      }
    } else if (bd.diff && !(bd.diffW >= 2 || /尺寸不同/.test(bd.diffNote))) {
      // 真实样本同尺寸时可画图；尺寸不一致时必须给出明确提示
      throw new Error('双图对比异常：' + JSON.stringify(bd));
    }
    await ev(`document.querySelectorAll('.batch-row')[1].click()`);
    await sleep(200);
    const active = await ev(`({ title: document.querySelector('#result h2').textContent, on: document.querySelectorAll('.batch-row.on').length })`);
    if (active.title.indexOf(path.basename(FIX2)) < 0 || active.on !== 1) throw new Error('批量行切换异常：' + JSON.stringify(active));

    // 若当前真实样本没有可对比的图，再用两个内置同尺寸 fixture 验一次双图对比
    let diffDiag = bd;
    if (!bd.diff) {
      const A = path.join(ROOT, 'tests', 'fixtures', 'second_stream.png');
      const B = path.join(ROOT, 'tests', 'fixtures', 'deep_lsb.png');
      await ev(`document.querySelector('#status').textContent = ''`);
      await send('DOM.setFileInputFiles', { files: [A, B], nodeId }, S);
      if (!await waitFor(`document.querySelectorAll('.batch-row').length === 2 && document.querySelector('#status').textContent.includes('批量完成：2 个文件')`, 30000)) {
        throw new Error('对比用批量分析未完成：' + await ev(`document.querySelector('#status').textContent`));
      }
      diffDiag = await ev(`(() => ({
        diff: !!document.querySelector('#d-a') && !!document.querySelector('#d-b'),
        diffW: document.querySelector('#d-canvas') ? document.querySelector('#d-canvas').width : 0,
        diffH: document.querySelector('#d-canvas') ? document.querySelector('#d-canvas').height : 0,
        diffNote: document.querySelector('#d-note') ? document.querySelector('#d-note').textContent : ''
      }))()`);
      if (!diffDiag.diff || diffDiag.diffW !== 64 || diffDiag.diffH !== 32 || !/^XOR · 64x32 · 变化 \d+ 像素/.test(diffDiag.diffNote)) {
        throw new Error('双图对比异常：' + JSON.stringify(diffDiag));
      }
    }

    const diffMode = await ev(`(() => {
      const s = document.querySelector('#d-mode');
      if (!s) return null;
      s.value = 'abs';
      s.dispatchEvent(new Event('change'));
      return document.querySelector('#d-note').textContent;
    })()`);
    if (diffDiag.diff && diffDiag.diffW >= 2 && (!diffMode || diffMode.indexOf('绝对差') < 0)) throw new Error('对比模式切换异常：' + JSON.stringify(diffMode));

    // 零尺寸 BMP：单张不能崩，整批不能被一个渲染异常卡死
    const zdir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdz-zero-'));
    const z1 = path.join(zdir, 'zero-1.bmp');
    const z2 = path.join(zdir, 'zero-2.bmp');
    fs.writeFileSync(z1, zeroBmp());
    fs.writeFileSync(z2, zeroBmp());
    await ev(`document.querySelector('#status').textContent = ''`);
    await send('DOM.setFileInputFiles', { files: [z1, z2], nodeId }, S);
    if (!await waitFor(`document.querySelectorAll('.batch-row').length === 2 && document.querySelector('#status').textContent.includes('批量完成：2 个文件')`, 30000)) {
      throw new Error('零尺寸批量未完成：' + await ev(`document.querySelector('#status').textContent`));
    }
    const zd = await ev(`(() => ({
      rows: document.querySelectorAll('.batch-row').length,
      done: document.querySelectorAll('.batch-row.done').length,
      disabled: document.querySelector('#analyze').disabled,
      resultShown: document.querySelector('#result').style.display !== 'none',
      status: document.querySelector('#status').textContent
    }))()`);
    if (zd.rows !== 2 || zd.done !== 2 || zd.disabled || !zd.resultShown || /异步错误|渲染失败/.test(zd.status)) {
      throw new Error('零尺寸图把界面卡死：' + JSON.stringify(zd));
    }

    // 50 文件上限
    const cdir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdz-cap-'));
    const capFiles = [];
    for (let i = 0; i < 51; i++) {
      const p = path.join(cdir, `f${String(i).padStart(2, '0')}.txt`);
      fs.writeFileSync(p, `sample ${i}\n` + 'x'.repeat(200));
      capFiles.push(p);
    }
    await ev(`document.querySelector('#status').textContent = ''`);
    await send('DOM.setFileInputFiles', { files: capFiles, nodeId }, S);
    if (!await waitFor(`document.querySelectorAll('.batch-row').length === 50 && document.querySelector('#status').textContent.includes('批量完成：50 个文件')`, 60000)) {
      throw new Error('批量上限分析未完成：' + await ev(`document.querySelector('#status').textContent`));
    }
    const cd = await ev(`(() => ({
      rows: document.querySelectorAll('.batch-row').length,
      info: document.querySelector('#fileinfo').innerText,
      head: document.querySelector('.batch-head').innerText,
      disabled: document.querySelector('#analyze').disabled,
      status: document.querySelector('#status').textContent
    }))()`);
    if (cd.rows !== 50 || cd.disabled || !/已忽略 1 个/.test(cd.info) || !/已忽略 1 个/.test(cd.head) || !/50 个文件/.test(cd.status)) {
      throw new Error('批量上限提示异常：' + JSON.stringify(cd));
    }

    // 音频 / pcap 视图
    const media = {};
    const mediaFiles = [
      ['wav', 'wav_morse.wav'],
      ['pcap', 'pcap_http.pcap'],
      ['pcapng', 'pcap_ng.pcapng']
    ];
    for (const [key, file] of mediaFiles) {
      const p = path.join(ROOT, 'tests', 'fixtures', file);
      if (!fs.existsSync(p)) throw new Error('缺少媒体 fixture：' + p);
      await ev(`document.querySelector('#status').textContent = ''`);
      await send('DOM.setFileInputFiles', { files: [p], nodeId }, S);
      if (!await waitFor(`document.querySelector('#status').textContent.includes('完成')`, 30000)) {
        throw new Error(key + ' 分析未完成：' + await ev(`document.querySelector('#status').textContent`));
      }
      if (key === 'wav') {
        const w = await ev(`({
          waveW: document.querySelector('#a-wave') ? document.querySelector('#a-wave').width : 0,
          specW: document.querySelector('#a-spec') ? document.querySelector('#a-spec').width : 0,
          note: document.querySelector('#a-spec-note') ? document.querySelector('#a-spec-note').textContent : '',
          specDl: !!document.querySelector('#a-spec-dl'),
          text: document.querySelector('#result').innerText
        })`);
        if (!w.waveW || !w.specW || !/Hz/.test(w.note) || w.text.indexOf('Morse: SOS') < 0) throw new Error('WAV 视图异常：' + JSON.stringify(w));
        if (!w.specDl) throw new Error('WAV 缺少频谱下载按钮');
        media.wav = { waveW: w.waveW, specW: w.specW, note: w.note };
      } else if (key === 'pcap') {
        const p = await ev(`({
          rows: document.querySelectorAll('.pcap-table tbody tr').length,
          text: document.querySelector('#result').innerText
        })`);
        if (p.rows < 3 || p.text.indexOf('flag{pcap_http}') < 0 || p.text.indexOf('flag{pcap_order}') < 0 || p.text.indexOf('flag.example.com') < 0) {
          throw new Error('PCAP 视图异常：' + JSON.stringify({ rows: p.rows, text: p.text.slice(0, 300) }));
        }
        media.pcap = { rows: p.rows };
      } else {
        const t = await ev(`document.querySelector('#result').innerText`);
        if (t.indexOf('PCAPNG') < 0 || t.indexOf('flag{pcapng}') < 0) throw new Error('PCAPNG 视图异常：' + t.slice(0, 300));
        media.pcapng = true;
      }
    }

    // 新面板：PNG CRC / GIF 逐帧 / BMP / JPEG / 节点编辑器
    const extra = {};
    async function loadPath(p, label, expectText) {
      if (!fs.existsSync(p)) throw new Error('缺少文件：' + p);
      await ev(`document.querySelector('#status').textContent = ''`);
      await send('DOM.setFileInputFiles', { files: [p], nodeId }, S);
      if (!await waitFor(`document.querySelector('#status').textContent.includes('完成')`, 30000)) {
        throw new Error(label + ' 分析未完成：' + await ev(`document.querySelector('#status').textContent`));
      }
      if (expectText) {
        const body = await ev(`document.querySelector('#result').innerText`);
        if (body.indexOf(expectText) < 0) throw new Error(label + ' 结果缺少 ' + expectText);
      }
    }
    async function loadFixture(file, expectText) {
      await loadPath(path.join(ROOT, 'tests', 'fixtures', file), file, expectText);
    }

    await loadFixture('bad_crc_height.png', '校验 · 修复 · PNG');
    extra.png = await ev(`(() => {
      const t = document.querySelector('#crc-text');
      t.value = '123456789';
      document.querySelector('[data-crc-calc]').click();
      return {
        dims: !!document.querySelector('#png-w') && !!document.querySelector('#png-h'),
        custom: !!document.querySelector('[data-fix-custom]'),
        table: document.querySelectorAll('.crctable tr').length,
        crc: document.querySelector('#crc-text-out').textContent
      };
    })()`);
    if (!extra.png.dims || !extra.png.custom || extra.png.table < 2 || extra.png.crc !== '0xcbf43926') {
      throw new Error('PNG CRC 面板异常：' + JSON.stringify(extra.png));
    }

    await loadFixture('gif_lzw.gif', 'GIF 逐帧分析');
    extra.gif = await ev(`(() => ({
      rows: document.querySelectorAll('.giftable tr').length,
      thumbs: Array.from(document.querySelectorAll('canvas[data-gif-thumb]')).filter(c => c.width > 1).length,
      hasLsb: !!document.querySelector('[data-gif-lsb]'),
      hasPng: !!document.querySelector('[data-gif-png]')
    }))()`);
    if (extra.gif.rows < 3 || extra.gif.thumbs < 2 || !extra.gif.hasLsb || !extra.gif.hasPng) {
      throw new Error('GIF 逐帧面板异常：' + JSON.stringify(extra.gif));
    }
    await ev(`document.querySelector('[data-gif-lsb]').click()`);
    if (!await waitFor(`document.querySelector('#gif-scan') && /第 \\d+ 帧：/.test(document.querySelector('#gif-scan').textContent)`, 15000)) {
      throw new Error('GIF 单帧 LSB 扫描未完成：' + await ev(`document.querySelector('#gif-scan').textContent`));
    }

    await loadFixture('bmp_1bit_lsb.bmp', 'BMP 处理');
    extra.bmp = await ev(`({
      dims: !!document.querySelector('#bmp-w') && !!document.querySelector('#bmp-h'),
      swatches: document.querySelectorAll('.sw').length,
      exportBtn: !!document.querySelector('[data-bmp-export]'),
      text: document.querySelector('#result').innerText.slice(0, 400)
    })`);
    if (!extra.bmp.dims || !extra.bmp.exportBtn) throw new Error('BMP 面板异常：' + JSON.stringify(extra.bmp));

    // 当前图像预览：分析出图后显示，改宽高实时重画（BMP 改头不会破坏像素数据，解码最稳）
    extra.preview = await ev(`(async () => {
      const cv = document.querySelector('#pv-canvas');
      const snap = () => cv ? { d: getComputedStyle(cv).display, w: cv.width, h: cv.height, meta: (document.querySelector('#pv-meta') || {}).textContent } : null;
      const first = snap();
      const inp = document.querySelector('#bmp-w');
      let second = null;
      if (inp) {
        inp.value = String(Math.max(2, Number(inp.value) + 6));
        inp.dispatchEvent(new Event('input', { bubbles: true }));
        await new Promise(r => setTimeout(r, 700));
        second = snap();
      }
      return { first, second, foot: (document.querySelector('#pv-foot') || {}).textContent || '' };
    })()`);
    if (!extra.preview.first || extra.preview.first.d === 'none' || extra.preview.first.w < 2 ||
        !extra.preview.second || extra.preview.second.w === extra.preview.first.w ||
        extra.preview.foot.indexOf('实时预览') < 0) {
      throw new Error('当前图像预览异常：' + JSON.stringify(extra.preview));
    }

    await loadFixture('jpeg_multi_exif.jpg', '校验 · 修复 · JPEG');
    extra.jpeg = await ev(`({
      dims: !!document.querySelector('#jpeg-w') && !!document.querySelector('#jpeg-h'),
      custom: !!document.querySelector('[data-jpeg-custom]'),
      text: document.querySelector('#result').innerText
    })`);
    if (!extra.jpeg.dims || !extra.jpeg.custom || extra.jpeg.text.indexOf('熵数据自检') < 0) {
      throw new Error('JPEG 面板异常：' + JSON.stringify({ dims: extra.jpeg.dims, custom: extra.jpeg.custom }));
    }

    await loadFixture('deep_lsb.png', '');
    await ev(`document.querySelector('#viewtabs [data-view="nodes"]').click()`);
    await sleep(200);
    extra.nodes = await ev(`(() => {
      const pane = document.querySelector('#pane-nodes');
      const cv = document.querySelector('canvas[data-out-canvas]');
      return {
        shown: pane ? pane.style.display : '',
        count: document.querySelectorAll('.gnode').length,
        wires: document.querySelectorAll('#node-wires path').length,
        outW: cv ? cv.width : 0,
        outH: cv ? cv.height : 0,
        outBtns: document.querySelectorAll('[data-out-png], [data-out-bmp]').length
      };
    })()`);
    if (extra.nodes.shown !== 'flex' || extra.nodes.count !== 2 || extra.nodes.wires !== 1 ||
        extra.nodes.outW < 2 || extra.nodes.outBtns !== 2) {
      throw new Error('节点编辑器初始图异常：' + JSON.stringify(extra.nodes));
    }
    await ev(`(() => {
      const s = document.querySelector('#node-add');
      s.value = 'channel';
      document.querySelector('#node-add-btn').click();
    })()`);
    extra.nodes.added = await ev(`document.querySelectorAll('.gnode').length`);
    if (extra.nodes.added !== 3) throw new Error('节点添加失败：' + extra.nodes.added);
    extra.nodes.link = await ev(`(() => {
      const gn = Array.from(document.querySelectorAll('.gnode'));
      const src = document.querySelector('.gnode.source');
      const out = document.querySelector('.gnode.outnode');
      const ch = gn.find(n => n.querySelector('.gn') && n.querySelector('.gn').textContent === '通道');
      // 摆成横排，保证端口在可视区内且互不遮挡（只改 DOM，不动内部坐标）
      src.style.left = '10px'; src.style.top = '20px';
      ch.style.left = '240px'; ch.style.top = '20px';
      out.style.left = '470px'; out.style.top = '20px';
      void src.offsetWidth;
      const center = el => { const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; };
      const fire = (el, type, p) => el.dispatchEvent(new PointerEvent(type, { bubbles: true, clientX: p.x, clientY: p.y, pointerId: 1 }));
      const cv = document.querySelector('canvas[data-out-canvas]');
      const hash = () => {
        const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
        let h = 0;
        for (let i = 0; i < d.length; i += 7) h = (h * 31 + d[i]) >>> 0;
        return h;
      };
      const before = hash();
      // 断开默认的 source → output
      const outIn = out.querySelector('[data-in="0"]');
      fire(outIn, 'pointerdown', center(outIn));
      const wires0 = document.querySelectorAll('#node-wires path').length;
      // 连接 source → 通道 → output
      const so = src.querySelector('.gport.out');
      fire(so, 'pointerdown', center(so));
      const ci = ch.querySelector('[data-in="0"]');
      document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: center(ci).x, clientY: center(ci).y, pointerId: 1 }));
      const co = ch.querySelector('.gport.out');
      fire(co, 'pointerdown', center(co));
      document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: center(outIn).x, clientY: center(outIn).y, pointerId: 1 }));
      const after = hash();
      return { before, after, wires0, wires: document.querySelectorAll('#node-wires path').length, outW: cv.width };
    })()`);
    if (extra.nodes.link.wires0 !== 0 || extra.nodes.link.wires !== 2 ||
        extra.nodes.link.outW < 2 || extra.nodes.link.before === extra.nodes.link.after) {
      throw new Error('节点连线/求值异常：' + JSON.stringify(extra.nodes.link));
    }
    extra.nodes.drag = await ev(`(() => {
      const ch = Array.from(document.querySelectorAll('.gnode')).find(n => n.querySelector('.gn') && n.querySelector('.gn').textContent === '通道');
      const head = ch.querySelector('.gnode-head');
      const r = head.getBoundingClientRect();
      const x0 = ch.style.left;
      head.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: r.left + 20, clientY: r.top + 10, pointerId: 1 }));
      document.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: r.left + 90, clientY: r.top + 70, pointerId: 1 }));
      document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: r.left + 90, clientY: r.top + 70, pointerId: 1 }));
      return { x0, x1: ch.style.left, wires: document.querySelectorAll('#node-wires path').length };
    })()`);
    if (extra.nodes.drag.x0 === extra.nodes.drag.x1 || extra.nodes.drag.wires !== 2) {
      throw new Error('节点拖动异常：' + JSON.stringify(extra.nodes.drag));
    }
    await ev(`document.querySelector('#viewtabs [data-view="analysis"]').click()`);
    extra.nodes.back = await ev(`document.querySelector('#content').style.display !== 'none'`);

    // 文件头被削：发现里要有「修复并分析」，点了能识别回 PNG
    await loadFixture('cut_png.png', '文件头疑似被削');
    extra.header = await ev(`(() => ({ hasBtn: !!document.querySelector('[data-repair]') }))()`);
    if (!extra.header.hasBtn) throw new Error('文件头修复按钮缺失');
    await ev(`document.querySelector('[data-repair]').click()`);
    if (!await waitFor(`document.querySelector('#result h2') && document.querySelector('#result h2').textContent.indexOf('PNG') >= 0`, 20000)) {
      throw new Error('文件头修复后没识别成 PNG');
    }
    extra.header.fixedTitle = await ev(`document.querySelector('#result h2').textContent`);

    // MP3：浏览器解码 PCM 后应画出频谱
    await loadFixture('mp3_frames.mp3', '音频 · MP3');
    extra.mp3 = await ev(`(async () => {
      const t0 = Date.now();
      while (Date.now() - t0 < 10000) {
        const spec = document.querySelector('#a-spec');
        if (spec && spec.width > 1) return { w: spec.width, h: spec.height };
        await new Promise(r => setTimeout(r, 200));
      }
      return { w: (document.querySelector('#a-spec') || {}).width || 0, note: (document.querySelector('#a-spec-note') || {}).textContent || '' };
    })()`);
    if (!(extra.mp3.w > 1)) throw new Error('MP3 频谱没画出来：' + JSON.stringify(extra.mp3));

    // 版本说明页
    await ev(`document.querySelector('#viewtabs [data-view="about"]').click()`);
    extra.about = await ev(`(() => {
      const p = document.querySelector('#pane-about');
      return {
        shown: getComputedStyle(p).display !== 'none',
        cards: p.querySelectorAll('.vercard').length,
        caps: p.querySelectorAll('.capbox').length,
        h1: (p.querySelector('h1') || {}).textContent || ''
      };
    })()`);
    if (!extra.about.shown || extra.about.cards < 10 || extra.about.caps < 3
      || extra.about.h1.indexOf((fs.readFileSync(path.join(ROOT, 'src', '00-util.js'), 'utf8').match(/const VERSION = '([^']+)'/) || [])[1] || '?') < 0) {
      throw new Error('版本说明页异常：' + JSON.stringify(extra.about));
    }
    await ev(`document.querySelector('#viewtabs [data-view="analysis"]').click()`);

    // 可选：对真实赛题跑一遍「候选尺寸 → 修复 → 重新分析」
    const CDIR = process.env.CHALLENGE_DIR;
    if (CDIR) {
      const ch = {};
      async function clickFix(sel, expectName, expectText) {
        await ev(`document.querySelector('#status').textContent = ''`);
        const ok = await ev(`(() => { const b = document.querySelector('${sel}'); if (!b) return false; b.click(); return true; })()`);
        if (!ok) throw new Error('缺少按钮 ' + sel);
        if (!await waitFor(`document.querySelector('#status').textContent.includes('完成') && document.querySelector('#result h2') && document.querySelector('#result h2').textContent.indexOf('${expectName}') >= 0`, 30000)) {
          throw new Error('修复后分析未完成 ' + sel + '：' + await ev(`document.querySelector('#status').textContent + ' / ' + (document.querySelector('#result h2') || {}).textContent`));
        }
        const body = await ev(`document.querySelector('#result').innerText`);
        if (expectText && body.indexOf(expectText) < 0) throw new Error(sel + ' 结果缺少 ' + expectText);
      }
      await loadPath(path.join(CDIR, 'misc24', 'misc24.bmp'), 'misc24');
      await clickFix('[data-bmp-cand="900,250"]', 'fixed-900x250-', '900 × 250');
      ch.misc24 = true;
      await loadPath(path.join(CDIR, 'misc25', 'misc25.png'), 'misc25');
      await clickFix('[data-fix-dims="900,250"]', 'fixed-900x250-', '900 × 250');
      ch.misc25 = true;
      await loadPath(path.join(CDIR, 'misc28', 'misc28.gif'), 'misc28');
      await clickFix('[data-gif-full="0"]', 'fixed-gif-frame0-900x250.gif', '900×250');
      ch.misc28 = true;
      await loadPath(path.join(CDIR, 'misc35', 'misc35.jpg'), 'misc35');
      await clickFix('[data-jpeg-cand="1000,504"]', 'fixed-1000x504-', '1000 × 504');
      ch.misc35 = true;
      extra.challenge = ch;
    }

    console.log('PASS cdp-smoke:', JSON.stringify(Object.assign({}, diag, { selftest: diagSelf, zoom, batch: bd, active, diff: diffDiag, diffMode, zero: zd, cap: cd, media, extra })));

  } finally {
    proc.kill();
  }
  process.exit(0);
})().catch(e => { console.error('FAIL cdp-smoke:', e.message); process.exit(1); });
