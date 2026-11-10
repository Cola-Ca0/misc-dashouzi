#!/usr/bin/env node
/* 外部工具桥冒烟：Python companion(fake tools) + Edge 页面连接/运行/产物分析。 */
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const ROOT = path.resolve(__dirname, '..');
const EDGE = process.env.EDGE || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PY = process.env.PYTHON || 'python';
const CDP_PORT = parseInt(process.env.CDP_PORT || '9368', 10);
const TOKEN = 'testtoken123';
const PAGE = pathToFileURL(path.join(ROOT, 'misc-dashouzi.html')).href;
const FIX = process.env.FIX || path.join(ROOT, 'tests', 'fixtures', 'second_stream.png');
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'mdz-cp-cdp-'));
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function waitCompanion(cp) {
  let out = '';
  cp.stdout.on('data', d => { out += d.toString(); });
  cp.stderr.on('data', d => { out += d.toString(); });
  for (let i = 0; i < 100; i++) {
    const m = out.match(/PORT=(\d+)/);
    if (m) return { port: parseInt(m[1], 10), out };
    if (cp.exitCode !== null) throw new Error('companion 提前退出：' + out.slice(0, 400));
    await sleep(100);
  }
  throw new Error('companion 未启动：' + out.slice(0, 400));
}

(async () => {
  if (!fs.existsSync(EDGE)) throw new Error('找不到 Edge：' + EDGE);
  if (!fs.existsSync(PAGE.replace('file:///', ''))) throw new Error('缺少成品，请先 python build.py');
  if (!fs.existsSync(FIX)) throw new Error('缺少 fixture：' + FIX);
  const cp = spawn(PY, ['-u', path.join(ROOT, 'companion.py'), '--port', '0', '--token', TOKEN, '--fake-tools'],
    { stdio: ['ignore', 'pipe', 'pipe'] });
  let edge = null;
  try {
    const { port } = await waitCompanion(cp);
    // companion 就绪
    let ready = false;
    for (let i = 0; i < 50; i++) {
      try {
        const r = await fetch(`http://127.0.0.1:${port}/api/status`, { headers: { 'X-MDZ-Token': TOKEN } });
        if (r.ok) { ready = true; break; }
      } catch (_) { /* wait */ }
      await sleep(100);
    }
    if (!ready) throw new Error('companion 状态接口未就绪');

    edge = spawn(EDGE, ['--headless=new', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${PROFILE}`,
      '--no-first-run', '--no-default-browser-check', '--disable-extensions', 'about:blank'], { stdio: 'ignore' });
    let ver = null;
    for (let i = 0; i < 120; i++) {
      try { ver = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).json(); break; } catch (_) { await sleep(150); }
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
    const ev = async (expression) => {
      const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, S);
      if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text);
      return r.result.value;
    };
    const waitFor = async (expr, timeout = 20000) => {
      const t = Date.now();
      while (Date.now() - t < timeout) { if (await ev(`!!(${expr})`)) return true; await sleep(100); }
      return false;
    };

    await send('Page.navigate', { url: PAGE }, S);
    await sleep(700);
    const { root } = await send('DOM.getDocument', {}, S);
    const { nodeId } = await send('DOM.querySelector', { nodeId: root.nodeId, selector: '#file' }, S);
    await send('DOM.setFileInputFiles', { files: [FIX], nodeId }, S);
    if (!await waitFor(`document.querySelector('#status').textContent.includes('完成')`)) {
      throw new Error('文件分析未完成：' + await ev(`document.querySelector('#status').textContent`));
    }
    if (!await waitFor(`document.querySelector('#tools-section, .tools')`)) throw new Error('没有外部工具面板');
    const manual = await ev(`document.querySelector('.cp-manual') ? document.querySelector('.cp-manual').innerText : ''`);
    if (manual.indexOf('zsteg -a') < 0) throw new Error('未连接时没有手写命令：' + manual.slice(0, 200));

    // 先输入 URL/token，再触发一次重新分析；输入应不被结果重渲染清掉
    await ev(`(() => {
      const u = document.querySelector('#cp-url');
      const t = document.querySelector('#cp-token');
      u.value = 'http://127.0.0.1:${port}'; u.dispatchEvent(new Event('input', { bubbles: true }));
      t.value = '${TOKEN}'; t.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#status').textContent = '';
      document.querySelector('#analyze').click();
    })()`);
    if (!await waitFor(`document.querySelector('#status').textContent.includes('完成')`)) {
      throw new Error('重新分析未完成');
    }
    const kept = await ev(`({ url: document.querySelector('#cp-url').value, token: document.querySelector('#cp-token').value })`);
    if (kept.url !== 'http://127.0.0.1:' + port || kept.token !== TOKEN) {
      throw new Error('输入在重渲染后丢失：' + JSON.stringify(kept));
    }

    // 连接
    await ev(`document.querySelector('#cp-connect').click()`);
    if (!await waitFor(`document.querySelector('#cp-state') && document.querySelector('#cp-state').textContent.includes('已连接')`)) {
      throw new Error('连接失败：' + await ev(`document.querySelector('#cp-body').innerText.slice(0,300)`));
    }
    const connected = await ev(`({
      chips: document.querySelectorAll('.cp-chip.ok').length,
      actions: document.querySelectorAll('[data-cp-run]').length,
      state: document.querySelector('#cp-state').textContent
    })`);
    if (connected.chips !== 5 || connected.actions < 9) throw new Error('工具/动作列表异常：' + JSON.stringify(connected));

    // zsteg 全扫
    await ev(`document.querySelector('[data-cp-run="zsteg.scan"]').click()`);
    if (!await waitFor(`document.querySelector('#cp-output') && document.querySelector('#cp-output').innerText.includes('FAKE zsteg scan')`)) {
      throw new Error('zsteg 全扫输出异常：' + await ev(`document.querySelector('#cp-body').innerText.slice(0,400)`));
    }

    // zsteg 提取 → 产物 → 分析
    await ev(`document.querySelector('[data-cp-run="zsteg.extract"]').click()`);
    if (!await waitFor(`document.querySelector('.cp-art') && document.querySelector('.cp-art').innerText.includes('zsteg-extract.bin')`)) {
      throw new Error('zsteg 提取产物异常：' + await ev(`document.querySelector('#cp-body').innerText.slice(0,400)`));
    }
    await ev(`document.querySelector('[data-cp-analyze="0"]').click()`);
    if (!await waitFor(`document.querySelector('.cp-inline-in')`)) throw new Error('产物分析没有输出');
    const seen = {};
    seen.zstegArtifact = await ev(`document.querySelector('.cp-art .n').textContent`);
    seen.zstegInline = await ev(`document.querySelector('.cp-inline-in').innerText`);

    // binwalk 提取
    await ev(`document.querySelector('[data-cp-run="binwalk.extract"]').click()`);
    if (!await waitFor(`document.querySelector('#cp-output') && document.querySelector('#cp-output').innerText.includes('FAKE binwalk extract')`)) {
      throw new Error('binwalk 提取异常：' + await ev(`document.querySelector('#cp-body').innerText.slice(0,400)`));
    }
    if (!await waitFor(`document.querySelector('.cp-art') && document.querySelector('.cp-art').innerText.includes('payload.txt')`)) {
      throw new Error('binwalk 产物异常');
    }

    // steghide 提取（带口令）
    await ev(`(() => {
      const box = document.querySelector('[data-action="steghide.extract"]');
      box.querySelector('[data-cp-field="password"]').value = 'pw';
      box.querySelector('[data-cp-run]').click();
    })()`);
    if (!await waitFor(`document.querySelector('.cp-art') && document.querySelector('.cp-art').innerText.includes('steghide-output.txt')`)) {
      throw new Error('steghide 提取产物异常：' + await ev(`document.querySelector('#cp-body').innerText.slice(0,400)`));
    }
    seen.steghideArtifact = await ev(`document.querySelector('.cp-art .n').textContent`);

    // exiftool 元数据
    await ev(`document.querySelector('[data-cp-run="exiftool.meta"]').click()`);
    if (!await waitFor(`document.querySelector('#cp-output') && document.querySelector('#cp-output').innerText.includes('ExifTool Version Number')`)) {
      throw new Error('exiftool 输出异常');
    }
    seen.exiftool = (await ev(`document.querySelector('#cp-output').innerText`)).slice(0, 80);

    const before = await ev(`({
      artifacts: document.querySelectorAll('.cp-art').length,
      inline: document.querySelectorAll('.cp-inline-in').length,
      errors: document.querySelectorAll('.cp-body .cp-error, #cp-body .cp-error').length,
      output: document.querySelector('#cp-output') ? document.querySelector('#cp-output').innerText.slice(0, 100) : ''
    })`);
    if (before.errors) throw new Error('工具运行期间出现错误：' + JSON.stringify(before));

    // 非回环地址必须拒绝
    await ev(`(() => {
      document.querySelector('#cp-url').value = 'http://example.com';
      document.querySelector('#cp-connect').click();
    })()`);
    if (!await waitFor(`document.querySelector('.cp-error') && document.querySelector('.cp-error').innerText.includes('只允许连接本机')`)) {
      throw new Error('没有拒绝非回环 companion：' + await ev(`document.querySelector('#cp-body').innerText.slice(0,300)`));
    }

    const diag = await ev(`({
      connected: ${connected.chips},
      actionCount: ${connected.actions},
      error: document.querySelector('.cp-error') ? document.querySelector('.cp-error').innerText : '',
      status: document.querySelector('#status').textContent
    })`);
    console.log('PASS companion-smoke:', JSON.stringify({ port, ...diag, seen, before }));
  } finally {
    if (edge) edge.kill();
    cp.kill();
  }
  process.exit(0);
})().catch(e => { console.error('FAIL companion-smoke:', e.message); process.exit(1); });
