/* misc大手子 — 80 UI */
(function () {
  'use strict';
  const M = globalThis.MDZ;
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));

  // companion 连接参数持久化：token 粘一次，刷新页面不用再粘
  const CP_STORE = 'miscDashouzi.companion';
  function loadCompanionPrefs() {
    try {
      const o = JSON.parse(localStorage.getItem(CP_STORE) || 'null');
      return o && typeof o === 'object' ? o : {};
    } catch (e) { return {}; }
  }
  function saveCompanionPrefs() {
    try {
      localStorage.setItem(CP_STORE, JSON.stringify({ url: state.companion.url, token: state.companion.token }));
    } catch (e) { /* 无痕模式或配额满：静默放弃 */ }
  }
  const cpPrefs = loadCompanionPrefs();

  const state = {
    items: [], activeIdx: -1, file: null, bytes: null, result: null, layer: 'all', viewerIdx: 0, urls: [], busy: false, ignored: 0,
    companion: { url: cpPrefs.url || M.COMPANION_DEFAULT_URL || 'http://127.0.0.1:8765', token: cpPrefs.token || '', status: null, last: null, busy: false, error: '' }
  };
  // 启动脚本用 URL 片段注入 token：不经过网络、不进服务器日志，读完立刻从地址栏抹掉
  let pendingAutoConnect = false;
  (function takeTokenFromHash() {
    const m = /(?:^#|&)t=([^&]*)/.exec(location.hash || '');
    if (!m) return;
    let tok = '';
    try { tok = decodeURIComponent(m[1]); } catch (e) { return; }
    if (!tok) return;
    state.companion.token = tok;
    saveCompanionPrefs();
    pendingAutoConnect = true;
    try { history.replaceState(null, '', location.pathname + location.search); } catch (e) { /* file:// 下可能被拒，忽略 */ }
  })();

  // 页面活着就一直给 companion 发心跳；页面一关就告别，服务跟着收摊。
  // 心跳 20s 一次；后台标签页会被浏览器节流到约 1 次/分，所以服务端空闲阈值要留够。
  let hbTimer = null;
  function startHeartbeat() {
    if (hbTimer || !state.companion.token) return;
    hbTimer = setInterval(() => {
      const c = state.companion;
      if (!c || !c.token) return;
      M.companionStatus(c.url, c.token).catch(() => {});
    }, 20000);
  }
  window.addEventListener('pagehide', () => {
    const c = state.companion;
    if (!c || !c.token) return;
    try { M.companionBye(c.url, c.token).catch(() => {}); } catch (e) { /* unload 阶段失败无所谓 */ }
  });

  if (state.companion.token) startHeartbeat();

  const MAX_BATCH = 50;
  let loadSeq = 0, analyzeSeq = 0, renderSeq = 0;

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
  function fmtSize(n) {
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1024 / 1024).toFixed(2) + ' MB';
  }
  function safeName(name) {
    return String(name || 'artifact.bin').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 160);
  }
  function dl(name, bytes, mime) {
    try {
      const blob = bytes instanceof Blob ? bytes : new Blob([bytes], { type: mime || 'application/octet-stream' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = safeName(name);
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
      return true;
    } catch (e) {
      setStatus('<span style="color:var(--danger)">下载失败：' + esc(e && e.message || e) + '</span>');
      return false;
    }
  }
  function dlCanvas(canvas, name) {
    if (!canvas || !canvas.toBlob) return;
    canvas.toBlob(blob => { if (blob) dl(name, blob, 'image/png'); }, 'image/png');
  }
  function canvasFromImage(image) {
    if (!image || !(image.width > 0) || !(image.height > 0)) return null;
    const R = M.renderImage(image, 0);
    if (!R) return null;
    const c = document.createElement('canvas');
    c.width = R.width; c.height = R.height;
    c.getContext('2d').putImageData(new ImageData(R.data, R.width, R.height), 0, 0);
    return c;
  }
  function setStatus(html) { $('#status').innerHTML = html; }

  // ---------- 当前图像预览（右栏常驻，随修改实时重画） ----------
  const pv = { seq: 0, url: null, source: '' };
  function pvSetFoot(text) { const el = $('#pv-foot'); if (el) el.textContent = text || ''; }

  function pvBlit(src, sw, sh, label, metaText) {
    const cv = $('#pv-canvas');
    if (!cv || !(sw > 0) || !(sh > 0)) return;
    const paneW = cv.parentElement ? Math.max(80, cv.parentElement.clientWidth - 20) : 280;
    const scale = Math.min(4, paneW / sw);   // 小图放大到看清像素，大图缩到栏宽
    cv.width = Math.max(1, Math.round(sw * scale));
    cv.height = Math.max(1, Math.round(sh * scale));
    const ctx = cv.getContext('2d');
    ctx.clearRect(0, 0, cv.width, cv.height);
    ctx.imageSmoothingEnabled = scale < 1;
    ctx.drawImage(src, 0, 0, cv.width, cv.height);
    cv.style.display = 'block';
    const empty = $('#pv-empty'); if (empty) empty.style.display = 'none';
    const meta = $('#pv-meta');
    if (meta) meta.textContent = metaText || (sw + '×' + sh);
    pvSetFoot(label || '');
  }

  function pvShowImage(image, label) {
    if (!image || !(image.width > 0) || !(image.height > 0)) return;
    const R = M.renderImage(image, 1400);
    if (!R) return;
    const c = document.createElement('canvas');
    c.width = R.width; c.height = R.height;
    c.getContext('2d').putImageData(new ImageData(R.data, R.width, R.height), 0, 0);
    pv.source = label || '';
    pvBlit(c, R.width, R.height, label, image.width + '×' + image.height);
  }

  function pvShowBytes(bytes, mime, label) {
    if (!bytes || !bytes.length) return;
    if (!$('#pv-canvas')) return;
    const token = ++pv.seq;
    try { if (pv.url) URL.revokeObjectURL(pv.url); } catch (e) { /* ignore */ }
    pv.url = URL.createObjectURL(new Blob([bytes], { type: mime || 'application/octet-stream' }));
    const im = new Image();
    im.onload = () => {
      if (token !== pv.seq) return;
      pv.source = label || '';
      pvBlit(im, im.naturalWidth, im.naturalHeight, label);
    };
    im.onerror = () => { if (token === pv.seq) pvSetFoot((label || '') + ' · 浏览器解不开这组字节'); };
    im.src = pv.url;
  }

  function pvShowResult(r) {
    if (!r || !Array.isArray(r.images) || !r.images.length) return;
    const first = r.images.find(x => x && x.image && x.image.width > 0);
    if (first) pvShowImage(first.image, (first.name || r.name || '') + ' · 分析结果');
  }

  // 尺寸输入框改了就直接重算预览：不用先下载再重新拖进来
  let pvDimTimer = null;
  function pvPreviewDims(fmt) {
    if (!state.bytes) return;
    clearTimeout(pvDimTimer);
    pvDimTimer = setTimeout(() => {
      const num = id => { const el = $('#' + id); return el ? parseInt(el.value, 10) : NaN; };
      let w, h, res;
      try {
        if (fmt === 'png') {
          w = num('png-w'); h = num('png-h');
          if (!(w > 0 && h > 0)) return;
          res = M.repairPNG(state.bytes, { width: w, height: h });
        } else if (fmt === 'jpeg') {
          w = num('jpeg-w'); h = num('jpeg-h');
          if (!(w > 0 && h > 0)) return;
          res = M.editJPEGDims(state.bytes, w, h);
        } else {
          w = num('bmp-w'); h = num('bmp-h');
          if (!(w > 0 && h > 0)) return;
          res = M.editBMPDims(state.bytes, w, h);
        }
      } catch (e) { return; }
      if (!res || res.error || !res.bytes) { pvSetFoot('这个宽高做不到：' + ((res && res.error) || '未知')); return; }
      const mime = fmt === 'png' ? 'image/png' : fmt === 'jpeg' ? 'image/jpeg' : 'image/bmp';
      pvShowBytes(res.bytes, mime, '实时预览 · 改成 ' + w + '×' + h + '（还没写盘）');
    }, 200);
  }
  function bindDimPreview() {
    const map = { 'png-w': 'png', 'png-h': 'png', 'jpeg-w': 'jpeg', 'jpeg-h': 'jpeg', 'bmp-w': 'bmp', 'bmp-h': 'bmp' };
    for (const id of Object.keys(map)) {
      const el = $('#' + id);
      if (el) el.addEventListener('input', () => pvPreviewDims(map[id]));
    }
  }

  // ---------- 文件 ----------
  function bindDrop() {
    const drop = $('#drop'), input = $('#file');
    drop.addEventListener('click', () => input.click());
    drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('over'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('over'));
    drop.addEventListener('drop', e => {
      e.preventDefault(); drop.classList.remove('over');
      const files = Array.from(e.dataTransfer.files || []);
      if (files.length) loadFiles(files);
    });
    input.addEventListener('change', () => {
      const files = Array.from(input.files || []);
      input.value = '';           // 允许再次选择同一个文件
      if (files.length) loadFiles(files);
    });
  }

  function showEmpty(html) {
    const empty = $('#empty');
    if (!empty) return;
    empty.style.display = '';
    empty.innerHTML = html;
  }

  async function loadFiles(files) {
    const list = Array.from(files || []);
    if (!list.length) return;
    const my = ++loadSeq;
    analyzeSeq++;                           // 取消还在跑的旧分析
    renderSeq++;                            // 旧结果区的事件绑带立刻失效
    const use = list.slice(0, MAX_BATCH);
    state.ignored = list.length - use.length;
    state.items = use.map(f => ({ file: f, name: f.name || 'input', bytes: null, result: null, status: '待读取', error: null }));
    state.activeIdx = -1;
    state.result = null;
    state.bytes = null;
    state.file = null;
    state.busy = false;
    state.companion.last = null;
    state.companion.error = '';
    state.layer = 'all';
    $$('#filters .chip').forEach(x => x.classList.toggle('on', x.dataset.layer === 'all'));
    $('#filters').style.display = 'none';
    const old = $('#result'); if (old) old.style.display = 'none';
    const st = $('#selftest'); if (st) st.style.display = 'none';
    const content = $('#content'); if (content) content.scrollTop = 0;
    const batch = $('#batch'); if (batch) { batch.style.display = 'none'; batch.innerHTML = ''; }
    $('#report').disabled = true;
    $('#analyze').disabled = true;
    const info = $('#fileinfo');
    info.classList.add('show');
    if (state.items.length === 1) {
      info.innerHTML = `<b>${esc(state.items[0].name)}</b><br>读取中…`;
      showEmpty('<div class="g">◌</div><div><span class="spinner"></span>读取文件…</div><div style="font-size:12px">' + esc(state.items[0].name) + '</div>');
    } else {
      const total = state.items.reduce((a, x) => a + (x.file.size || 0), 0);
      info.innerHTML = `<b>${state.items.length} 个文件（批量）</b><br>${fmtSize(total)}` +
        (state.ignored ? `<br><span style="color:var(--warn)">已忽略 ${state.ignored} 个（上限 ${MAX_BATCH}）</span>` : '');
      $('#empty').style.display = 'none';
      renderBatch();
      if (state.ignored) setStatus(`一次最多 ${MAX_BATCH} 个文件，已忽略 ${state.ignored} 个`);
    }
    if (state.items.length === 1) {
      const it = state.items[0];
      let buf;
      try {
        buf = await it.file.arrayBuffer();
      } catch (e) {
        if (my !== loadSeq) return;
        it.status = '失败'; it.error = String(e && e.message || e);
        setStatus('<span style="color:var(--danger)">读取失败：' + esc(it.error) + '</span>');
        showEmpty('<div class="g">⚠</div><div>读取文件失败</div><div style="font-size:12px">' + esc(it.error) + '</div>');
        $('#analyze').disabled = true;
        return;
      }
      if (my !== loadSeq) return;              // 期间又拖入了新文件
      it.bytes = new Uint8Array(buf);
      it.status = '待分析';
      state.bytes = it.bytes;
      state.file = it.file;
      info.innerHTML = `<b>${esc(it.name)}</b><br>${fmtSize(it.bytes.length)}`;
      $('#analyze').disabled = false;
      runAnalysis();
      return;
    }
    await runBatchAnalysis();
  }

  // ---------- 分析 ----------
  const FLAGFMT_KEY = 'mdz.flagfmt';
  function refreshFlagHint() {
    const el = $('#flagfmt'), hint = $('#flagfmt-hint');
    if (!el || !hint) return;
    const v = el.value.trim();
    // 没写 {} 就只会按字面量匹配，直接把说明标红提醒
    hint.classList.toggle('bad', !!v && v.indexOf('{}') < 0 && v.toLowerCase() !== 'default');
  }
  function applyFlagFormat() {
    const el = $('#flagfmt');
    const fmt = M.setFlagFormat(el ? el.value : '');
    try { localStorage.setItem(FLAGFMT_KEY, fmt); } catch (e) { /* 隐私模式写不进去，忽略 */ }
    refreshFlagHint();
    return fmt;
  }

  // ---------- 分析执行器：Worker 优先，建不起来就退回主线程 ----------
  // 分析是同步的重活（20MB 要 1.8 秒、深度扫描更久），放在 Worker 里页面才不会假死。
  let worker = null, workerDead = false, jobSeq = 0;
  const jobs = new Map();

  function coreSource() {
    const el = document.getElementById('core-src');
    return window.MDZ_CORE_SRC || (el && el.textContent) || '';
  }

  function ensureWorker() {
    if (worker || workerDead) return worker;
    try {
      // 函数没法结构化克隆（pcm.value），Worker 里先剔掉再回传，主线程按同样的规则重建
      const boot = [
        'function strip(o,d){if(!o||typeof o!=="object"||d>6)return o;',
        'if(ArrayBuffer.isView(o)||o instanceof ArrayBuffer)return o;',
        'for(var k in o){var v=o[k];if(typeof v==="function"){delete o[k];continue;}',
        'if(v&&typeof v==="object")strip(v,d+1);}return o;}',
        'self.onmessage=function(e){var d=e.data;',
        'try{var r=MDZ.analyze(d.bytes,d.name,d.opts);self.postMessage({id:d.id,ok:true,result:strip(r,0)});}',
        'catch(err){self.postMessage({id:d.id,ok:false,error:String(err&&err.message||err)});}};'
      ].join('');
      const url = URL.createObjectURL(new Blob([coreSource(), '\n;\n', boot], { type: 'text/javascript' }));
      worker = new Worker(url);
      worker.onmessage = (e) => {
        const d = e.data || {};
        const job = jobs.get(d.id);
        if (!job) return;
        jobs.delete(d.id);
        if (d.ok) job.resolve(d.result); else job.reject(new Error(d.error || 'Worker 分析失败'));
      };
      worker.onerror = () => {
        workerDead = true;
        worker = null;
        globalThis.MDZ_DIAG = globalThis.MDZ_DIAG || {};
        globalThis.MDZ_DIAG.worker = 'dead';
        for (const [, job] of jobs) job.reject(new Error('Worker 异常退出'));
        jobs.clear();
      };
    } catch (e) {
      workerDead = true;
      worker = null;
    }
    return worker;
  }

  function cancelAnalysis() {
    analyzeSeq++;
    if (worker) { try { worker.terminate(); } catch (_) { /* ignore */ } worker = null; }
    for (const [, job] of jobs) job.reject(new Error('已取消'));
    jobs.clear();
    state.busy = false;
    const btn = $('#analyze'); if (btn) btn.disabled = !state.bytes;
    const c = $('#cancel'); if (c) c.style.display = 'none';
    const empty = $('#empty');
    if (empty) { empty.style.display = ''; empty.innerHTML = '<div class="g">◌</div><div>已取消</div><div style="font-size:12px">改完设置再点「开始分析」</div>'; }
    setStatus('已取消');
  }

  function analyzeAsync(bytes, name, opts) {
    const w = ensureWorker();
    // 给冒烟测试看的：Worker 到底有没有真的跑起来
    globalThis.MDZ_DIAG = globalThis.MDZ_DIAG || {};
    globalThis.MDZ_DIAG.worker = w ? 'on' : 'off';
    if (!w) return Promise.resolve(M.analyze(bytes, name, opts));
    return new Promise((resolve, reject) => {
      const id = ++jobSeq;
      jobs.set(id, { resolve, reject });
      try {
        w.postMessage({ id, bytes, name, opts });
      } catch (e) {
        jobs.delete(id);
        resolve(M.analyze(bytes, name, opts));    // 传不过去就退回主线程
      }
    }).then((r) => {
      // Worker 回来后 pcm.value 已被剔掉，这里补回来（和主线程同一套规则）
      if (r && r.audio && r.audio.pcm && !r.audio.pcm.value && M.audioPCMValue) {
        r.audio.pcm.value = M.audioPCMValue(r.audio.pcm);
      }
      return r;
    });
  }

  // 把修复副本直接放回分析台，省去「下载 → 再拖进来」一步
  function analyzeBytes(bytes, name) {
    if (!bytes || !bytes.length) return;
    const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    state.bytes = b;
    state.file = { name: name || 'fixed.bin' };
    state.items = [{ file: null, name: name || 'fixed.bin', bytes: b, result: null, status: '待分析', error: null }];
    state.activeIdx = 0;
    state.busy = false;
    state.layer = 'all';
    const info = $('#fileinfo');
    if (info) {
      info.classList.add('show');
      info.innerHTML = `<b>${esc(state.file.name)}</b><br>${fmtSize(b.length)} <span style="color:var(--muted)">（修复副本）</span>`;
    }
    runAnalysis();
  }

  function runAnalysis() {
    if (!state.bytes) return;
    applyFlagFormat();
    const my = ++analyzeSeq;
    const deep = $('#deep').checked;
    const maxScanPixels = parseInt($('#maxpx').value, 10) || 6000000;
    state.busy = true;
    state.result = null;
    // 新文件重置层过滤，否则会出现“芯片选着 L4、结果全是 L1→列表空白”
    state.layer = 'all';
    $$('#filters .chip').forEach(x => x.classList.toggle('on', x.dataset.layer === 'all'));
    $('#analyze').disabled = true;
    $('#report').disabled = true;
    $('#filters').style.display = 'none';
    const st = $('#selftest'); if (st) st.style.display = 'none';
    // 立刻清掉上一份结果，避免分析期间点到旧面板
    $('#result').style.display = 'none';
    const empty = $('#empty');
    if (empty) {
      empty.style.display = '';
      empty.innerHTML = '<div class="g">◌</div><div><span class="spinner"></span>分析中…</div><div style="font-size:12px">' + esc(state.file ? state.file.name : '') + '</div>';
    }
    setStatus('<span class="spinner"></span>分析中…');
    const cbtn = $('#cancel'); if (cbtn) cbtn.style.display = '';
    $('#content').scrollTop = 0;
    setTimeout(async () => {
      try {
        const r = await analyzeAsync(state.bytes, state.file ? state.file.name : 'input', { deep, maxScanPixels });
        if (my !== analyzeSeq) return;
        state.result = r;
        if (state.items.length === 1) { state.items[0].result = r; state.items[0].status = '完成'; state.items[0].flagCount = M.flags(r).length; }
        render(r);
        setStatus(`完成：${r.findings.length} 条发现 · ${r.artifacts.length} 个产物 · ${r.stats.elapsed} ms`);
        $('#report').disabled = false;
        $('#filters').style.display = '';
      } catch (e) {
        if (my !== analyzeSeq) return;
        if (state.items.length === 1) { state.items[0].status = '失败'; state.items[0].error = String(e && e.message || e); }
        $('#result').style.display = 'none';
        setStatus('<span style="color:var(--danger)">分析失败：' + esc(e && e.message || e) + '</span>');
        if (empty) empty.innerHTML = '<div class="g">⚠</div><div>分析失败</div><div style="font-size:12px">' + esc(e && e.message || e) + '</div>';
      } finally {
        if (my === analyzeSeq) {
          state.busy = false;
          $('#analyze').disabled = false;
          const c = $('#cancel'); if (c) c.style.display = 'none';
        }
      }
    }, 30);
  }

  function now() { return (typeof performance !== 'undefined' ? performance.now() : Date.now()); }

  async function runBatchAnalysis() {
    if (state.items.length < 2) return;
    applyFlagFormat();
    const my = ++analyzeSeq;
    const deep = $('#deep').checked;
    const maxScanPixels = parseInt($('#maxpx').value, 10) || 6000000;
    state.busy = true;
    state.result = null;
    state.activeIdx = -1;
    state.layer = 'all';
    $$('#filters .chip').forEach(x => x.classList.toggle('on', x.dataset.layer === 'all'));
    $('#analyze').disabled = true;
    $('#report').disabled = true;
    $('#filters').style.display = 'none';
    $('#result').style.display = 'none';
    $('#empty').style.display = 'none';
    const content = $('#content'); if (content) content.scrollTop = 0;
    const st = $('#selftest'); if (st) st.style.display = 'none';
    for (const it of state.items) {
      it.result = null;
      it.flagCount = 0;
      it.status = it.bytes ? '待分析' : '待读取';
      it.error = null;
    }
    renderBatch();
    const t0 = now();
    let firstShown = false;
    for (let i = 0; i < state.items.length; i++) {
      if (my !== analyzeSeq) return;
      const it = state.items[i];
      if (!it.bytes) {
        it.status = '读取中'; renderBatch();
        setStatus(`<span class="spinner"></span>批量读取 ${i + 1}/${state.items.length}：${esc(it.name)}`);
        try {
          const buf = await it.file.arrayBuffer();
          if (my !== analyzeSeq) return;
          it.bytes = new Uint8Array(buf);
        } catch (e) {
          if (my !== analyzeSeq) return;
          it.status = '失败'; it.error = String(e && e.message || e);
          renderBatch();
          continue;
        }
      }
      it.status = '分析中'; renderBatch();
      setStatus(`<span class="spinner"></span>批量分析 ${i + 1}/${state.items.length}：${esc(it.name)}`);
      await new Promise(r => setTimeout(r, 12));
      if (my !== analyzeSeq) return;
      try {
        it.result = await analyzeAsync(it.bytes, it.name, { deep, maxScanPixels });
        it.flagCount = M.flags(it.result).length;
        it.status = '完成';
      } catch (e) {
        it.status = '失败'; it.error = String(e && e.message || e);
      }
      if (my !== analyzeSeq) return;
      renderBatch();
      if (!firstShown && it.result) { firstShown = true; activate(i); }
    }
    if (my !== analyzeSeq) return;
    state.busy = false;
    $('#analyze').disabled = false;
    const done = state.items.filter(x => x.result);
    const failed = state.items.filter(x => x.status === '失败').length;
    const total = done.reduce((a, x) => a + x.result.findings.length, 0);
    $('#report').disabled = !done.length;
    $('#filters').style.display = done.length ? '' : 'none';
    renderBatch();
    if (state.activeIdx >= 0 && state.items[state.activeIdx] && state.items[state.activeIdx].result) activate(state.activeIdx);
    setStatus(`批量完成：${done.length} 个文件 · ${total} 条发现 · ${Math.round(now() - t0)} ms` + (failed ? ` · ${failed} 个失败` : ''));
  }

  function renderBatch() {
    const box = $('#batch');
    if (!box) return;
    if (state.items.length < 2) { box.style.display = 'none'; box.innerHTML = ''; return; }
    box.style.display = '';
    const done = state.items.filter(x => x.result).length;
    const total = state.items.reduce((a, x) => a + (x.result ? x.result.findings.length : 0), 0);
    const flagCount = state.items.reduce((a, x) => a + (x.flagCount || 0), 0);
    const rows = state.items.map((it, i) => {
      const r = it.result;
      const t = r && r.type;
      const fl = r ? (it.flagCount || 0) : 0;
      const bad = it.status === '失败';
      return `<button class="batch-row${i === state.activeIdx ? ' on' : ''}${r ? ' done' : ''}" data-batch="${i}" ${r ? '' : 'disabled'} title="${esc(it.error || it.name)}">
        <span class="bi">${i + 1}</span>
        <span class="bn">${esc(it.name)}</span>
        <span class="bf">${t ? esc(t.format) : '—'}</span>
        <span class="bs">${it.bytes ? fmtSize(it.bytes.length) : (it.file && it.file.size ? fmtSize(it.file.size) : '—')}</span>
        <span class="bc">${r ? r.findings.length : '·'}</span>
        <span class="bfl">${fl || ''}</span>
        <span class="bst${bad ? ' bad' : ''}">${esc(bad ? '失败' : it.status)}</span>
      </button>`;
    }).join('');
    // 失败原因不能只藏在 disabled 按钮的 title 里（鼠标移上去才有，键盘还够不着）
    const errs = state.items.map((it, i) => it.error ? `<div class="batch-err"><b>${i + 1}. ${esc(it.name)}</b>：${esc(it.error)}</div>` : '').join('');
    box.innerHTML = `<div class="batch-head"><b>批量</b><span>${state.items.length} 个文件 · ${done} 完成 · ${total} 条发现${flagCount ? ' · ' + flagCount + ' 个 flag' : ''}${state.ignored ? ` · 已忽略 ${state.ignored} 个（上限 ${MAX_BATCH}）` : ''}</span></div><div class="batch-list">${rows}</div>${errs ? `<div class="batch-errs">${errs}</div>` : ''}`;
    $$('[data-batch]', box).forEach(el => el.addEventListener('click', () => {
      if (el.disabled) return;
      activate(parseInt(el.dataset.batch, 10));
    }));
  }

  function activate(i) {
    const it = state.items[i];
    if (!it || !it.result) return;
    state.activeIdx = i;
    state.result = it.result;
    state.bytes = it.bytes;
    state.file = it.file;
    state.companion.last = null;
    state.companion.error = '';
    state.layer = 'all';
    $$('#filters .chip').forEach(x => x.classList.toggle('on', x.dataset.layer === 'all'));
    $('#filters').style.display = '';
    $('#report').disabled = false;
    let rendered = true;
    try {
      render(it.result);
    } catch (e) {
      rendered = false;
      $('#result').style.display = 'none';
      setStatus('<span style="color:var(--danger)">结果渲染失败：' + esc(e && e.message || e) + '</span>');
    }
    renderBatch();
    if (rendered) setStatus(`查看：${esc(it.name)} · ${it.result.findings.length} 条发现 · ${it.result.stats.elapsed} ms`);
  }

  // ---------- 渲染 ----------
  function render(r) {
    for (const u of state.urls) { try { URL.revokeObjectURL(u); } catch (_) { /* ignore */ } }
    state.urls = [];
    const st = $('#selftest'); if (st) st.style.display = 'none';
    $('#empty').style.display = 'none';
    const root = $('#result');
    root.style.display = '';
    root.innerHTML = renderSummary(r) + renderRepair(r) + renderFormatPanels(r) + renderTree(r) + renderAudio(r) + renderPCAP(r) + renderFindings(r) + renderArtifacts(r) + renderViewer(r) + renderDiff() + renderTools();
    bindResultEvents(++renderSeq);
    applyFilter();
    pvShowResult(r);
    bindDimPreview();
  }

  function renderSummary(r) {
    const t = r.type || {};
    const flags = M.flags(r);
    const mism = t.extMismatch ? `<span class="badge warn">扩展名 .${esc(t.ext)} ≠ 真身</span>` : '';
    return `
      <div class="summary">
        <h2>${esc(r.name)} <span class="badge">${esc(t.format || '未知')}</span>${mism}</h2>
        <div class="kv">
          <div class="k">大小</div><div class="v">${r.size} 字节（${fmtSize(r.size)}）</div>
          <div class="k">SHA-256</div><div class="v">${esc(r.sha256)}</div>
          <div class="k">真身</div><div class="v">${esc(t.mime || '')}</div>
          <div class="k">规模</div><div class="v">${r.stats.files} 个文件 · ${r.stats.scanned} 张图扫描 · ${r.stats.findings} 条发现 · ${r.stats.elapsed} ms</div>
        </div>
        ${flags.length ? `<div class="flags">${flags.map(f => `<div class="flagbox">${esc(f)}</div>`).join('')}</div>` : ''}
      </div>`;
  }

  // ---------- 校验 / 修复 / 格式面板 ----------
  function hex8(n) { return '0x' + (n >>> 0).toString(16).padStart(8, '0'); }
  function hexPad(n, w) { return (n >>> 0).toString(16).padStart(w || 2, '0'); }

  function pngChunkTable(bytes) {
    let p;
    try { p = M.parseChunks(bytes); } catch (e) { return ''; }
    if (!p.ok) return '';
    const bad = p.chunks.filter(c => !c.crcOk);
    const show = (bad.length ? bad : p.chunks.slice(0, 16));
    if (!show.length) return '';
    const rows = show.map(c => `<tr class="${c.crcOk ? '' : 'bad'}">
      <td>${esc(c.type)}</td><td>0x${hexPad(c.offset, 6)}</td><td>${c.length}</td>
      <td>${hex8(c.crcStored)}</td><td>${hex8(c.crcCalc)}</td><td>${c.crcOk ? '✓' : '✗ 不匹配'}</td>
    </tr>`).join('');
    const more = !bad.length && p.chunks.length > show.length
      ? `<div class="cp-note">只显示前 ${show.length} 块，共 ${p.chunks.length} 块</div>` : '';
    return `<div class="crctable"><table>
      <tr><th>类型</th><th>偏移</th><th>数据长度</th><th>文件中的 CRC</th><th>应为</th><th>结果</th></tr>
      ${rows}</table></div>${more}`;
  }

  function renderPNGRepair(rep) {
    const all = rep.candidates || [];
    const cur = rep.ihdr ? (rep.ihdr.width + 'x' + rep.ihdr.height) : '';
    const notCurrent = c => (c.width + 'x' + c.height) !== cur;
    const verified = all.filter(c => (c.crcOk || /CRC/.test(c.how || '')) && notCurrent(c));
    const byIdat = all.filter(c => c.plausible && !c.crcOk && notCurrent(c));
    let cands = verified.concat(byIdat).slice(0, 8);
    if (!cands.length) cands = all.filter(c => c.plausible).slice(0, 8);
    const list = cands.map(c => {
      const rec = /CRC/.test(c.how || '') || c.crcOk;
      return `<button class="mini" data-fix-dims="${c.width},${c.height}" title="${esc(c.how || '')}">${rec ? '★ ' : ''}${c.width}x${c.height}${rec ? '（CRC 验证）' : ''}</button>`;
    }).join(' ');
    const w = rep.ihdr ? rep.ihdr.width : 1;
    const h = rep.ihdr ? rep.ihdr.height : 1;
    const table = state.bytes ? pngChunkTable(state.bytes) : '';
    const badCount = state.bytes ? M.parseChunks(state.bytes).chunks.filter(c => !c.crcOk).length : 0;
    return `<div class="section"><h3>校验 · 修复 · PNG</h3>
      <div class="crcbox">
        <div class="kv">
          <div class="k">IHDR</div><div class="v">${rep.ihdr ? `${rep.ihdr.width} × ${rep.ihdr.height} · 位深 ${rep.ihdr.bitDepth} · 色彩类型 ${rep.ihdr.colorType}${rep.ihdr.interlace ? ' · 隔行' : ''}` : '—'}</div>
          <div class="k">CRC</div><div class="v">${badCount ? `<span style="color:var(--danger)">${badCount} 块不匹配</span>` : (table ? '全部通过' : '—')}</div>
        </div>
        <div class="cp-note">「重算 CRC」只让文件变合法；若宽高被改过，画面仍是残缺的，优先用 ★ 尺寸候选或自定义宽高。</div>
        <div class="row">
          <button class="mini" data-fix-crc="1">重算 CRC（保持尺寸）</button>
          ${list || '<span style="color:var(--muted);font-size:12px">没有可用的尺寸候选</span>'}
        </div>
        <div class="dims">
          <span>自定义宽高</span>
          <input id="png-w" type="number" min="1" max="1000000" value="${w}"> ×
          <input id="png-h" type="number" min="1" max="1000000" value="${h}">
          <button class="mini" data-fix-custom="png">应用并分析</button>
          <span>只改 IHDR 并重算 CRC，IDAT 原样保留（拉高可露出被藏起来的行）</span>
        </div>
        ${table}
      </div>
    </div>`;
  }

  function renderJPEGRepair(bytes) {
    let p = null, ent = null, rec = null;
    try { p = M.parseSegments(bytes); ent = M.analyzeJPEGEntropy(bytes); rec = M.recoverJPEGDims(bytes); } catch (e) { /* ignore */ }
    if (!p || !p.ok) return '';
    const sof = p.segs.find(s => s.marker >= 0xC0 && s.marker <= 0xCF &&
      s.marker !== 0xC4 && s.marker !== 0xC8 && s.marker !== 0xCC && s.data && s.data.length >= 5);
    const dims = sof ? { w: (sof.data[3] << 8) | sof.data[4], h: (sof.data[1] << 8) | sof.data[2] } : null;
    let verdict = '';
    let fixBtn = '';
    if (!ent || !ent.supported) {
      verdict = `<div class="cp-note">熵数据自检：跳过（${esc((ent && ent.reason) || '数据不足')}）</div>`;
    } else if (!ent.ok) {
      verdict = `<div class="cp-note" style="color:var(--danger)">熵数据自检：${esc(ent.reason)}</div>`;
    } else if (ent.leftover > 8) {
      if (ent.extraErr) {
        verdict = `<div class="cp-note" style="color:var(--warn)">扫描数据比声明的 ${ent.declaredW}×${ent.declaredH} 多出 ${ent.leftover} 字节，但多出来的不是合法图像数据——可能是追加载荷。</div>`;
      } else {
        verdict = `<div class="cp-note" style="color:var(--danger)">扫描数据比声明的 ${ent.declaredW}×${ent.declaredH} 多出 ${ent.leftover} 字节（足够再解 ${ent.extra} 个 MCU）。宽或高被改小过，被裁掉的画面还在文件里。</div>`;
        if (ent.suggestedH > ent.declaredH) {
          fixBtn = `<button class="mini" data-jpeg-h="${ent.suggestedH}">把高度改为 ${ent.suggestedH} 并分析</button>`;
        }
      }
    } else {
      verdict = `<div class="cp-note">熵数据自检通过：${ent.declared} 个 MCU 恰好用完扫描数据（剩余 ${ent.leftover} 字节）</div>`;
    }
    let cands = '';
    if (rec && !rec.error && rec.candidates && rec.candidates.length) {
      cands = `<div class="cp-note" style="margin-top:8px">按 ${esc(rec.source)}（${rec.total} 个 MCU）反推的候选尺寸，点一个直接分析修复图：</div>
        <div class="row">${rec.candidates.map(c =>
          `<button class="mini" data-jpeg-cand="${c.width},${c.height}" title="${esc(c.how)}">${c.width}×${c.height}</button>`).join(' ')}</div>
        <div class="cp-note">末行可能是部分 MCU，真实高度可能比候选小 1~${Math.max(0, rec.mcuH - 1)} 像素；可用下面的自定义宽高微调。</div>`;
    }
    const segRows = p.segs.slice(0, 40).map(s => `<tr><td>0x${hexPad(s.offset, 6)}</td><td>${esc(M.jpegMarkerName(s.marker))}</td><td>${s.length || 0}</td></tr>`).join('');
    return `<div class="section"><h3>校验 · 修复 · JPEG</h3>
      <div class="crcbox">
        <div class="kv">
          <div class="k">结构</div><div class="v">${p.eoi >= 0 ? 'SOI → EOI 完整' : '缺少 EOI（可能被截断）'} · ${p.segs.length} 段${p.errors.length ? ` · ${p.errors.length} 处异常` : ''}</div>
          <div class="k">尺寸</div><div class="v">${dims ? dims.w + ' × ' + dims.h : '—'}</div>
        </div>
        <div class="cp-note">JPEG 没有 CRC 字段，用「熵数据 MCU 计数」当校验：按声明尺寸解完所有 MCU 后，扫描数据应当正好用完。</div>
        ${verdict}
        <div class="row">${fixBtn}</div>
        ${cands}
        <div class="dims">
          <span>自定义宽高</span>
          <input id="jpeg-w" type="number" min="1" max="65535" value="${dims ? dims.w : 1}"> ×
          <input id="jpeg-h" type="number" min="1" max="65535" value="${dims ? dims.h : 1}">
          <button class="mini" data-jpeg-custom="1">应用并分析</button>
          <span>只改 SOF 字段，不重编码像素</span>
        </div>
        <details style="margin-top:8px"><summary class="cp-note">全部 ${p.segs.length} 段</summary>
          <div class="crctable"><table><tr><th>偏移</th><th>标记</th><th>长度</th></tr>${segRows}</table></div>
        </details>
        ${p.trailer && p.trailer.length ? `<div class="cp-note">EOI 之后还有 ${p.trailer.length} 字节（见产物/尾挂发现）</div>` : ''}
      </div>
    </div>`;
  }

  function renderRepair(r) {
    const rep = r.repair;
    if (!rep) return '';
    if (rep.format === 'JPEG') return renderJPEGRepair(state.bytes);
    return renderPNGRepair(rep);
  }

  function renderBMPPanel(r) {
    if (!state.bytes || !r || !r.type || r.type.format !== 'BMP') return '';
    let info;
    try { info = M.parseBMP(state.bytes); } catch (e) { return ''; }
    if (!info || info.error) return '';
    const b = state.bytes;
    let palette = '';
    if (info.paletteCount) {
      const sw = [];
      const n = Math.min(info.paletteCount, 256);
      for (let i = 0; i < n; i++) {
        const p = info.paletteStart + i * info.paletteEntry;
        if (p + 2 >= b.length) break;
        const R = b[p + 2], G = b[p + 1], B = b[p];
        sw.push(`<span class="sw" title="#${i} rgb(${R},${G},${B})" style="background:rgb(${R},${G},${B})"></span>`);
      }
      palette = `<div class="k">调色板</div><div class="v">${info.paletteCount} 项${info.paletteClamped ? '（声明越界，已收敛）' : ''}<div class="swatches">${sw.join('')}</div></div>`;
    }
    const gap = info.bfOffBits - info.paletteEnd;
    const tail = b.length - info.pixelEnd;
    let cands = '';
    try {
      const rec = M.recoverBMPDims(b);
      if (rec && !rec.error) {
        const group = (title, list) => list.length
          ? `<div class="cp-note" style="margin-top:8px">${title}</div><div class="row">${list.map(c =>
              `<button class="mini" data-bmp-cand="${c.width},${c.height}" title="${esc(c.how)}">${c.width}×${c.height}</button>`).join(' ')}</div>`
          : '';
        const groups = group('只改高度（宽度声明可信）', rec.widthFixed) +
          group('只改宽度（高度声明可信）', rec.heightFixed) +
          group('宽高都可能被改', rec.other);
        if (groups) cands = `<div class="cp-note" style="margin-top:10px">按像素区实际长度反推的候选尺寸（点一个直接分析修复图）：</div>${groups}`;
      }
    } catch (e) { /* ignore */ }
    return `<div class="section"><h3>BMP 处理</h3><div class="crcbox">
      <div class="kv">
        <div class="k">文件头</div><div class="v">bfSize ${info.bfSize} / 实际 ${b.length}${info.bfSize !== b.length ? '（不符）' : ''} · bfOffBits ${info.bfOffBits}</div>
        <div class="k">DIB 头</div><div class="v">${info.dibSize} 字节 · ${info.width} × ${info.absH}${info.topDown ? '（高度为负，自下而上）' : ''} · ${info.bpp} bpp · 压缩 ${info.compression}</div>
        <div class="k">像素</div><div class="v">行字节 ${info.rowSize} · 像素区 0x${hexPad(info.bfOffBits, 6)}–0x${hexPad(info.pixelEnd, 6)} · 尾挂 ${tail > 0 ? tail + ' 字节' : '无'}</div>
        <div class="k">夹缝</div><div class="v">调色板尾 → bfOffBits：${gap > 0 ? gap + ' 字节' : '无'}</div>
        ${palette}
      </div>
      ${cands}
      <div class="dims">
        <span>自定义宽高</span>
        <input id="bmp-w" type="number" min="1" value="${info.width}"> ×
        <input id="bmp-h" type="number" min="1" value="${info.absH}">
        <button class="mini" data-bmp-custom="1">改文件头并分析</button>
        <span>只改 biWidth / biHeight，像素数组原样保留</span>
      </div>
      <div class="row"><button class="mini" data-bmp-export="1">把解码像素导出为 24-bit BMP</button></div>
    </div></div>`;
  }

  function renderGIFPanel(r) {
    const g = r.gif;
    if (!g) return '';
    const rows = g.frames.map(f => {
      const delay = f.delay * 10;
      const disp = ['未指定', '保留', '恢复背景', '恢复上一帧'][f.disposal] || ('#' + f.disposal);
      const thumb = f.image ? `<canvas class="thum" data-gif-thumb="${f.i}"></canvas>` : '<span class="cp-note">未解码</span>';
      const extra = f.extraRows > 0 ? `<span style="color:var(--warn)"> +${f.extraRows} 行</span>` : '';
      return `<tr>
        <td>${f.i}</td>
        <td>${thumb}</td>
        <td>0x${hexPad(f.offset, 6)}</td>
        <td>${f.width}×${f.height}${extra} @(${f.left},${f.top})${f.interlace ? ' · 隔行' : ''}</td>
        <td>${delay} ms</td>
        <td>${disp}</td>
        <td>${f.transparent ? '索引 ' + f.transparentIndex : '—'}</td>
        <td>${f.localPalette ? '本地' : '全局'}</td>
        <td><div class="gact">
          <button class="mini" data-gif-view="${f.i}" ${f.image ? '' : 'disabled'}>查看</button>
          ${f.extraRows > 0 ? `<button class="mini" data-gif-full="${f.i}">完整帧</button>` : ''}
          <button class="mini" data-gif-png="${f.i}" ${f.image ? '' : 'disabled'}>PNG</button>
          <button class="mini" data-gif-bmp="${f.i}" ${f.image ? '' : 'disabled'}>BMP</button>
          <button class="mini" data-gif-lsb="${f.i}" ${f.image ? '' : 'disabled'}>LSB</button>
        </div></td>
      </tr>`;
    }).join('');
    return `<div class="section"><h3>GIF 逐帧分析</h3><div class="crcbox">
      <div class="kv">
        <div class="k">画布</div><div class="v">${g.width} × ${g.height} · ${g.frames.length} 帧</div>
        <div class="k">调色板</div><div class="v">${g.hasGCT ? `全局 ${Math.floor(g.gctSize / 3)} 色` : '无全局调色板'}</div>
      </div>
      <div class="cp-note">每帧已自动进入 LSB 扫描队列；「LSB」按钮对单帧做一次快速扫描。带「+N 行」的帧表示 LZW 里还压着下面的画面，点「完整帧」会修复 GIF 并直接分析。</div>
      <div class="giftable"><table>
        <tr><th>帧</th><th>缩略图</th><th>偏移</th><th>位置 · 尺寸</th><th>延时</th><th>处置</th><th>透明</th><th>调色板</th><th>操作</th></tr>
        ${rows}
      </table></div>
      <div class="gifscan" id="gif-scan"></div>
    </div></div>`;
  }

  function renderCRCUtil(r) {
    const fileCrc = state.bytes ? hex8(M.crc32(state.bytes)) : '—';
    return `<div class="section"><h3>CRC32 工具</h3><div class="crcbox">
      <div class="row">
        <span>当前文件</span><code class="mono">${fileCrc}</code>
        <span style="color:var(--muted)">（按字节算，同 zlib.crc32）</span>
      </div>
      <div class="row">
        <span>文本 → CRC32</span>
        <input id="crc-text" type="text" placeholder="要计算的文本" style="min-width:200px">
        <button class="mini" data-crc-calc="1">计算</button>
        <code class="mono" id="crc-text-out"></code>
      </div>
      <div class="row">
        <span>CRC 反查</span>
        <input id="crc-target" type="text" placeholder="0x1a2b3c4d 或十进制" style="width:150px">
        <span>长度 ≤</span>
        <select id="crc-len"><option>1</option><option>2</option><option>3</option><option selected>4</option></select>
        <input id="crc-charset" type="text" value="abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ!-@_{}" style="min-width:260px" title="候选字符集">
        <button class="mini" data-crc-brute="1">爆破</button>
        <span class="cp-note" id="crc-brute-note"></span>
      </div>
      <div class="cp-note">反查默认最多 4 位、15 秒上限；字符集越短越快。5 位以上的全量枚举会非常慢。</div>
      <div class="mono" id="crc-brute-out" style="margin-top:6px"></div>
    </div></div>`;
  }

  function renderFormatPanels(r) {
    return renderBMPPanel(r) + renderGIFPanel(r) + renderCRCUtil(r);
  }


  function renderTree(r) {
    const files = (r.files || []).slice();
    if (files.length < 2) return '';
    const ids = new Set(files.map(f => f.id));
    const byParent = new Map();
    for (const f of files) {
      const p = f.parentId === null || f.parentId === undefined || !ids.has(f.parentId) ? 'root' : f.parentId;
      if (!byParent.has(p)) byParent.set(p, []);
      byParent.get(p).push(f);
    }
    const lines = [];
    const seen = new Set();
    function walk(f, prefix, last) {
      if (seen.has(f.id)) return;
      seen.add(f.id);
      lines.push(prefix + (last ? '└─ ' : '├─ ') + `${f.name}  [${f.format || '?'}] ${fmtSize(f.size)}`);
      const kids = (byParent.get(f.id) || []).filter(k => !seen.has(k.id));
      kids.forEach((k, i) => walk(k, prefix + (last ? '   ' : '│  '), i === kids.length - 1));
    }
    const roots = byParent.get('root') || [];
    roots.forEach((f, i) => walk(f, '', i === roots.length - 1));
    for (const f of files) if (!seen.has(f.id)) walk(f, '', false);
    const maxDepth = Math.max(...files.map(f => f.depth || 0));
    return `<div class="section"><h3>递归树 · ${files.length} 个文件 · 最大深度 ${maxDepth}</h3><pre class="tree">${esc(lines.join('\n'))}</pre></div>`;
  }

  function renderAudio(r) {
    const a = r.audio;
    if (!a) return '';
    if (a.format === 'WAV') {
      const f = a.parsed && a.parsed.fmt;
      const info = (a.parsed && a.parsed.info) || [];
      const morse = a.morse && a.morse.text ? `<div class="flagbox">Morse: ${esc(a.morse.text)}</div>` : '';
      return `<div class="section"><h3>音频 · WAV</h3><div class="audio">
        <div class="kv">
          <div class="k">PCM</div><div class="v">${f ? `${f.channels} ch · ${f.sampleRate} Hz · ${f.bits} bit` : '无法解码'}</div>
          <div class="k">时长</div><div class="v">${a.duration ? a.duration.toFixed(3) + ' s' : '—'}</div>
          <div class="k">chunks</div><div class="v">${a.parsed ? a.parsed.chunks.length : 0} 个 · data ${a.parsed ? a.parsed.dataChunks.length : 0} 个${a.parsed && a.parsed.trailing ? ' · 有尾挂' : ''}</div>
          ${info.length ? `<div class="k">INFO</div><div class="v">${esc(info.slice(0, 8).map(x => x.id + '=' + x.text).join(' · '))}</div>` : ''}
        </div>
        ${morse}
        <div class="row"><audio id="a-play" controls preload="none"></audio><span class="cp-note">原文件播放（本地 Blob）</span></div>
        ${a.pcm ? `<div class="row" style="margin-top:8px">
          <span>频谱 FFT</span><select id="a-fft"><option value="512">512</option><option value="1024" selected>1024</option><option value="2048">2048</option></select>
          <button class="mini" id="a-redraw">重绘</button><button class="mini" id="a-spec-dl">下载频谱 PNG</button><span id="a-spec-note" class="mono" style="margin-left:auto"></span>
        </div><canvas id="a-wave" class="wave" width="1200" height="120"></canvas>
        <canvas id="a-spec" class="spec" width="1" height="1"></canvas>` : '<div class="cp-note">当前格式只解析元数据，不做波形/频谱。</div>'}
      </div></div>`;
    }
    if (a.format === 'MP3') {
      const tags = (a.tags || []).slice(0, 16);
      const v1 = a.id3v1;
      const rows = tags.map(t => `<div class="kv"><div class="k">${esc(t.id)}</div><div class="v">${esc([t.desc, t.value].filter(Boolean).join(' / '))}</div></div>`).join('');
      const apic = (a.tag && a.tag.frames ? a.tag.frames.filter(f => f.id === 'APIC').length : 0);
      return `<div class="section"><h3>音频 · MP3</h3><div class="audio">
        <div class="kv">
          <div class="k">ID3</div><div class="v">${a.tag ? `v2.${a.tag.version} · ${a.tag.frames.length} 帧 · APIC ${apic}` : '无 ID3v2'}</div>
          <div class="k">数据区</div><div class="v">${a.audioBytes} 字节</div>
        </div>
        <div class="row"><audio id="a-play" controls preload="none"></audio><span class="cp-note">原文件播放（本地 Blob）</span></div>
        ${a.frames ? `<div class="kv"><div class="k">帧表</div><div class="v">${a.frames} 帧${a.xing && a.xing.encoder ? ' · ' + esc(a.xing.encoder) : ''}</div></div>` : ''}
        <div class="row" style="margin-top:8px">
          <span>频谱 FFT</span><select id="a-fft"><option value="512">512</option><option value="1024" selected>1024</option><option value="2048">2048</option></select>
          <button class="mini" id="a-redraw">重绘</button><button class="mini" id="a-spec-dl">下载频谱 PNG</button><span id="a-spec-note" class="mono" style="margin-left:auto">浏览器解码中…</span>
        </div>
        <canvas id="a-wave" class="wave" width="1200" height="120"></canvas>
        <canvas id="a-spec" class="spec" width="1" height="1"></canvas>
        ${rows}
        ${v1 ? `<div class="kv"><div class="k">ID3v1</div><div class="v">${esc([v1.title, v1.artist, v1.album, v1.year, v1.comment].filter(Boolean).join(' · '))}</div></div>` : ''}
      </div></div>`;
    }
    return '';
  }

  function renderPCAP(r) {
    const p = r.pcap;
    if (!p) return '';
    const streams = (p.streams || []).slice(0, 20);
    const rows = streams.map(s => {
      const mark = [s.flag ? 'FLAG' : '', s.http ? 'HTTP' : ''].filter(Boolean).join(' ');
      return `<tr>
        <td class="mono">${esc(s.src)}:${s.sport} → ${esc(s.dst)}:${s.dport}</td>
        <td>${s.bytes}</td><td>${s.packets}</td>
        <td class="mono">${s.ttlMin == null ? '' : s.ttlMin + (s.ttlMax !== s.ttlMin ? '..' + s.ttlMax : '')}</td>
        <td>${mark ? `<span class="badge ${s.flag ? 'warn' : ''}">${mark}</span>` : ''}${s.gaps ? ' gaps' : ''}</td>
        <td class="mono">${esc((s.preview || '').slice(0, 120))}</td>
      </tr>`;
    }).join('');
    const udpRows = (p.udp || []).slice(0, 20).map(u => `<tr>
      <td class="mono">${esc(u.src)}:${u.sport} → ${esc(u.dst)}:${u.dport}</td>
      <td>${u.bytes}</td>
      <td>${u.flag ? '<span class="badge warn">FLAG</span>' : ''}</td>
      <td class="mono">${esc((u.preview || '').slice(0, 120))}</td>
    </tr>`).join('');
    const ttl = (p.ttlAnomalies || []).slice(0, 12).map(x => `<tr><td class="mono">${esc(x.flow)}</td><td>${x.min}</td><td>${x.max}</td><td>${x.count}</td><td class="mono">${esc((x.values || []).join('/'))}</td></tr>`).join('');
    const dns = (p.dns || []).slice(0, 30).map(x => `<div><code>${esc(x.name)}</code> <span class="cp-note">type ${x.type} · ${x.proto}</span></div>`).join('');
    const http = (p.http || []).slice(0, 30).map(x => `<div><code>${esc(x.kind === 'request' ? x.method + ' ' + x.path : 'HTTP ' + x.status)}</code> <span class="cp-note">${esc(x.host || x.src + ':' + x.sport + ' → ' + x.dst + ':' + x.dport)}</span></div>`).join('');
    const conv = (p.conversations || []).slice(0, 12).map(x => `<div><code>${esc(x.a)} ↔ ${esc(x.b)}</code> <span class="cp-note">${x.packets} 包 · ${x.bytes} 字节 · TTL ${x.ttlMin == null ? '—' : x.ttlMin + '..' + x.ttlMax}</span></div>`).join('');
    return `<div class="section"><h3>PCAP · ${esc((p.format || '').toUpperCase())}</h3><div class="pcap">
      <div class="kv">
        <div class="k">包/字节</div><div class="v">${p.packets} 包 · ${p.bytes} 字节 · linktype ${esc((p.linkTypes || []).join(','))}</div>
        <div class="k">TCP/其他</div><div class="v">${(p.streams || []).length} 条流 · ${(p.dns || []).length} DNS · ${(p.http || []).length} HTTP · ${(p.ttlAnomalies || []).length} TTL 异常</div>
        ${p.trailer ? `<div class="k">尾挂</div><div class="v">${p.trailer} 字节</div>` : ''}
      </div>
      ${rows ? `<div class="pcap-table"><table><thead><tr><th>TCP 流</th><th>字节</th><th>包</th><th>TTL</th><th>标记</th><th>预览</th></tr></thead><tbody>${rows}</tbody></table></div>` : '<div class="cp-note">没有可展示的 TCP 载荷。</div>'}
      ${udpRows ? `<div class="pcap-sub"><b>UDP 载荷（Top 20）</b><div class="pcap-table"><table><thead><tr><th>UDP</th><th>字节</th><th>标记</th><th>预览</th></tr></thead><tbody>${udpRows}</tbody></table></div></div>` : ''}
      ${ttl ? `<div class="pcap-sub"><b>TTL 异常</b><div class="pcap-table"><table><thead><tr><th>方向</th><th>min</th><th>max</th><th>包</th><th>值</th></tr></thead><tbody>${ttl}</tbody></table></div></div>` : ''}
      ${dns ? `<div class="pcap-sub"><b>DNS 查询</b>${dns}</div>` : ''}
      ${http ? `<div class="pcap-sub"><b>HTTP</b>${http}</div>` : ''}
      ${conv ? `<details class="pcap-sub"><summary>会话（Top 12）</summary>${conv}</details>` : ''}
      ${(p.warnings || []).length ? `<details class="pcap-sub"><summary>解析告警</summary><pre class="cp-stdout">${esc(p.warnings.join('\n'))}</pre></details>` : ''}
    </div></div>`;
  }

  function layerName(l) {
    return { L0: 'L0 身份', L1: 'L1 结构', L2: 'L2 压缩流', L3: 'L3 元数据', L4: 'L4 像素', L5: 'L5 视觉' }[l] || l;
  }

  function renderFindings(r) {
    if (!r.findings.length) {
      return `<div class="section"><h3>发现</h3><div class="finding"><div class="detail">没有发现明显异常。试试勾选“深度扫描”，或人工看位平面。</div></div></div>`;
    }
    const items = r.findings.map((f, i) => {
      const cls = f.confidence >= 0.85 ? 'hi' : f.confidence >= 0.5 ? 'mid' : '';
      const off = f.offset === null || f.offset === undefined ? '' : `<span>偏移 <code>0x${f.offset.toString(16)}</code></span>`;
      const decl = f.declared ? `<span>声明 <code>${esc(f.declared)}</code></span>` : '';
      const act = f.actual ? `<span>实际 <code>${esc(f.actual)}</code></span>` : '';
      const file = f.file && f.depth ? `<span>来源 <code>${esc(f.file)}</code></span>` : '';
      const payloadBtn = f.payload && f.payload.bytes
        ? `<button class="mini" data-dl="${i}">下载载荷</button>` : '';
      const repairBtn = f.repair && f.repair.bytes
        ? `<button class="mini primary" data-repair="${i}">修复并分析</button>` : '';
      const prev = f.preview ? `<pre>${esc(f.preview)}</pre>` : '';
      const detail = f.detail ? `<div class="detail">${esc(f.detail)}</div>` : '';
      const recipe = f.recipe ? `<pre>复现：${esc(f.recipe)}</pre>` : '';
      return `<div class="finding ${cls}" data-layer="${f.layer}" data-confidence="${f.confidence}">
        <div class="head">
          <span class="badge">${layerName(f.layer)}</span>
          <span class="t">${esc(f.title)}</span>
          <span class="conf">置信度 ${(f.confidence * 100).toFixed(0)}%</span>
        </div>
        <div class="meta">${off}${decl}${act}${file}</div>
        ${detail}${prev}${recipe}
        ${payloadBtn || repairBtn ? `<div class="actions">${payloadBtn}${repairBtn}</div>` : ''}
      </div>`;
    }).join('');
    return `<div class="section"><h3>发现 · ${r.findings.length}</h3>${items}</div>`;
  }

  function renderArtifacts(r) {
    if (!r.artifacts.length) return '';
    const cards = r.artifacts.map((a, i) => {
      let thumb = '<div style="color:var(--muted);font-size:12px">无预览</div>';
      if (a.image) thumb = `<canvas data-art="${i}" width="1" height="1"></canvas>`;
      else if (a.bytes && isImageBytes(a.bytes)) thumb = `<img data-art="${i}" alt="">`;
      return `<div class="art">
        <div class="thumb">${thumb}</div>
        <div class="body">
          <div class="n">${esc(a.name)}</div>
          <div class="m">${a.bytes ? fmtSize(a.bytes.length) : ''} ${esc(a.note || '')}</div>
          <div class="actions" style="margin-top:6px">
            ${a.bytes ? `<button class="mini" data-adl="${i}">下载</button>` : ''}
          </div>
        </div>
      </div>`;
    }).join('');
    return `<div class="section"><h3>产物 · ${r.artifacts.length}</h3><div class="artifacts">${cards}</div></div>`;
  }

  function isImageBytes(b) {
    if (!b || b.length < 4) return false;
    return (b[0] === 0x89 && b[1] === 0x50) || (b[0] === 0xFF && b[1] === 0xD8) || (b[0] === 0x47 && b[1] === 0x49) || (b[0] === 0x42 && b[1] === 0x4D);
  }

  function renderViewer(r) {
    const imgs = (r.images || []).filter(x => x.image && x.image.channels && x.image.width > 0 && x.image.height > 0);
    if (!imgs.length) return '';
    const opts = imgs.map((x, i) => `<option value="${i}">${esc(x.name)} · ${x.image.width}x${x.image.height}</option>`).join('');
    return `<div class="section"><h3>位平面查看器</h3>
      <div class="viewer">
        <div class="row">
          <span>图</span><select id="v-img">${opts}</select>
          <span>通道</span><select id="v-ch"></select>
          <span>位</span><select id="v-bit"></select>
          <label class="opt"><input type="checkbox" id="v-inv"> 反色</label>
          <button class="mini" id="v-ref">重绘</button>
        </div>
        <div class="row" style="margin-top:8px">
          <button class="mini" id="v-zout">−</button><span id="v-zoom" class="mono">100%</span><button class="mini" id="v-zin">+</button>
          <button class="mini" id="v-fit">适应</button><button class="mini" id="v-1">1:1</button>
          <span id="v-px" class="mono" style="margin-left:auto"></span>
        </div>
        <div class="vp" id="v-vp"><canvas id="v-canvas"></canvas></div>
      </div>
    </div>`;
  }

  function imagePool() {
    const pool = [], seen = new Set();
    const push = (im, label) => {
      if (!im || !im.image || !im.image.channels || !(im.image.width > 0) || !(im.image.height > 0) || seen.has(im.image)) return;
      seen.add(im.image);
      pool.push({ label, image: im.image });
    };
    for (const it of state.items) {
      if (!it.result) continue;
      for (const im of it.result.images || []) push(im, `${it.name} · ${im.name}`);
    }
    if (state.result) for (const im of state.result.images || []) push(im, im.name);
    return pool;
  }

  function renderDiff() {
    const pool = imagePool();
    if (pool.length < 2) return '';
    // 默认挑一对同尺寸的图；没有就交给用户在面板里看到尺寸不符的提示
    let defA = 0, defB = 1;
    outer: for (let i = 0; i < pool.length; i++) {
      for (let j = i + 1; j < pool.length; j++) {
        if (pool[i].image.width === pool[j].image.width && pool[i].image.height === pool[j].image.height) {
          defA = i; defB = j; break outer;
        }
      }
    }
    const make = sel => pool.map((p, i) => `<option value="${i}"${i === sel ? ' selected' : ''}>${esc(p.label)} · ${p.image.width}x${p.image.height}</option>`).join('');
    const modes = Object.keys(M.DIFF_MODES || {}).map(k => `<option value="${k}">${esc(M.DIFF_MODES[k].label)}</option>`).join('');
    return `<div class="section"><h3>双图对比</h3>
      <div class="diff">
        <div class="row">
          <select id="d-a">${make(defA)}</select><span>vs</span><select id="d-b">${make(defB)}</select>
          <select id="d-mode">${modes}</select>
          <button class="mini" id="d-save">下载 PNG</button>
          <span id="d-note" class="diff-note"></span>
        </div>
        <div class="vp"><canvas id="d-canvas"></canvas></div>
      </div>
    </div>`;
  }

  function renderTools() {
    const c = state.companion;
    const connected = !!c.status;
    const tools = connected && c.status.tools && typeof c.status.tools === 'object' ? Object.values(c.status.tools) : [];
    const ok = tools.filter(x => x && x.ok).length;
    return `<div class="section"><h3>外部工具</h3>
      <div class="tools">
        <div class="cp-head">
          <span class="cp-dot${connected ? ' on' : ''}"></span>
          <span id="cp-state">${connected ? `已连接 · v${esc(c.status.version || '?')} · ${ok}/${tools.length} 工具` : '未连接（可选）'}</span>
          <input id="cp-url" class="cp-in" value="${esc(c.url)}" placeholder="http://127.0.0.1:8765" autocomplete="off" spellcheck="false">
          <input id="cp-token" class="cp-in" type="password" value="${esc(c.token)}" placeholder="companion token" autocomplete="off" spellcheck="false">
          <button class="mini" id="cp-connect">${connected ? '重新连接' : '连接'}</button>
          <button class="mini" id="cp-disconnect" style="${connected ? '' : 'display:none'}">断开</button>
        </div>
        <div id="cp-body">${renderCompanionBody()}</div>
      </div>
    </div>`;
  }

  function renderCompanionBody() {
    const c = state.companion;
    const err = c.error ? `<div class="cp-error">${esc(c.error)}</div>` : '';
    if (!c.status) return err + renderManualCommands(false);
    const st = c.status;
    const toolMap = st.tools && typeof st.tools === 'object' ? st.tools : {};
    const chips = Object.entries(toolMap).map(([name, v]) =>
      `<span class="cp-chip ${v && v.ok ? 'ok' : 'bad'}" title="${esc(v && v.path || '')}">${esc(name)} ${v && v.ok ? '✓' : '✗'}</span>`).join('');
    const actions = (Array.isArray(st.actions) ? st.actions : []).map(renderToolAction).join('');
    return `${err}<div class="cp-tools">${chips}</div><div class="cp-actions">${actions}</div><div id="cp-output">${renderCompanionOutput()}</div>${renderManualCommands(true)}`;
  }

  function renderToolAction(a) {
    a = a || {};
    const st = state.companion.status || {};
    const toolMap = st.tools && typeof st.tools === 'object' ? st.tools : {};
    const tool = toolMap[a.tool] || {};
    // builtin = companion 自带的纯 Python 动作，不依赖外部程序，永远可用
    const toolOk = a.tool === 'builtin' ? true : !!tool.ok;
    const disabled = !toolOk || state.companion.busy;
    const fields = (Array.isArray(a.fields) ? a.fields : []).map(f => {
      f = f || {};
      if (f.type === 'select') {
        const opts = (Array.isArray(f.options) ? f.options : []).map(o => `<option value="${esc(o)}"${o === f.default ? ' selected' : ''}>${esc(o)}</option>`).join('');
        return `<label class="cp-field">${esc(f.label)} <select data-cp-field="${esc(f.name)}">${opts}</select></label>`;
      }
      const max = Number(f.max);
      return `<label class="cp-field">${esc(f.label)} <input data-cp-field="${esc(f.name)}" type="${f.type === 'password' ? 'password' : 'text'}" value="${esc(f.default || '')}"${Number.isFinite(max) && max > 0 ? ` maxlength="${Math.floor(max)}"` : ''}></label>`;
    }).join('');
    const mode = a.mode === 'binary' ? ' · 二进制' : a.mode === 'files' ? ' · 产物' : '';
    return `<div class="cp-action" data-action="${esc(a.id)}">
      <div class="cp-at"><b>${esc(a.label)}</b><span class="cp-tool">${esc(a.tool)}${toolOk ? '' : ' · 未安装'}${mode}</span></div>
      <div class="cp-ar">${fields}<button class="mini" data-cp-run="${esc(a.id)}"${disabled ? ' disabled' : ''}>运行</button></div>
    </div>`;
  }

  function renderCompanionOutput() {
    const last = state.companion.last;
    if (!last) return '<div class="cp-empty">连接后在这里运行；不启动 companion 也可以复制手动命令。</div>';
    const arts = (Array.isArray(last.artifacts) ? last.artifacts : []).map((a, i) => {
      a = a || {};
      return `<div class="cp-art" data-cp-art="${i}">
      <div class="n">${esc(a.name)}</div><div class="m">${fmtSize(Number(a.size) || 0)}</div>
      <div class="actions"><button class="mini" data-cp-dl="${i}">下载</button><button class="mini" data-cp-analyze="${i}">分析</button></div>
      <div class="cp-inline" data-cp-inline="${i}"></div></div>`;
    }).join('');
    const outText = String(last.stdout == null ? '' : last.stdout).slice(0, 200000);
    const errText = String(last.stderr == null ? '' : last.stderr).slice(0, 50000);
    const skipped = Array.isArray(last.skipped) ? last.skipped : [];
    return `<div class="cp-out">
      <div class="cp-oh"><span class="badge">${esc(last.label || last.action)}</span><span>exit ${esc(last.exit)} · ${esc(last.duration_ms)} ms</span><code class="cp-cmd">${esc(last.command || '')}</code></div>
      ${outText ? `<pre class="cp-stdout">${esc(outText)}</pre>` : ''}
      ${errText ? `<pre class="cp-stderr">${esc(errText)}</pre>` : ''}
      ${arts ? `<div class="cp-arts">${arts}</div>` : (last.mode === 'binary' || last.mode === 'files' ? '<div class="cp-note">没有捕获到产物。</div>' : '')}
      ${skipped.length ? `<div class="cp-note">跳过：${esc(skipped.join('；'))}</div>` : ''}
      ${last.truncated && (last.truncated.stdout || last.truncated.stderr) ? '<div class="cp-note">输出已截断</div>' : ''}
    </div>`;
  }

  function renderManualCommands(compact) {
    const cmds = M.manualCommands();
    const groups = [];
    const by = new Map();
    cmds.forEach((x, i) => {
      if (!by.has(x.group)) { by.set(x.group, []); groups.push(x.group); }
      by.get(x.group).push(Object.assign({ i }, x));
    });
    const body = groups.map(g => `<div class="cp-manual-group"><div class="cp-mg">${esc(g)}</div>${by.get(g).map(x =>
      `<div class="cp-cmd-row"><div class="cp-cl">${esc(x.label)}${x.note ? `<span class="cp-note">${esc(x.note)}</span>` : ''}</div><pre>${esc(x.cmd)}</pre><button class="mini" data-cp-copy="${x.i}">复制</button></div>`).join('')}</div>`).join('');
    const hint = '<div class="cp-note">只有 <b>steghide</b> 和 <b>bkcrack</b> 必须靠外部程序；位平面/LSB、流签名递归、元数据、ZIP 结构、LZMA 解压、二维码识别都已内置，不连 companion 也能用。手动命令里的 <code>&lt;FILE&gt;</code> 换成实际路径。</div>';
    if (compact) return `<details class="cp-manual"><summary>手动命令（不连接也能用）</summary>${hint}${body}</details>`;
    return `<div class="cp-manual">${hint}${body}</div>`;
  }

  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); return true; } catch (_) { /* fallback */ }
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (_) { ok = false; }
    ta.remove();
    return ok;
  }

  function paintCompanion(gen) {
    if (gen !== renderSeq) return;
    const body = $('#cp-body');
    if (body) {
      body.innerHTML = renderCompanionBody();
      bindCompanionBody(gen);
    }
    const c = state.companion;
    const st = c.status;
    const stateEl = $('#cp-state');
    if (stateEl) {
      if (c.busy) stateEl.textContent = '运行外部工具…';
      else if (st) {
        const tools = Object.values(st.tools || {});
        stateEl.textContent = `已连接 · v${st.version || '?'} · ${tools.filter(x => x.ok).length}/${tools.length} 工具`;
      } else stateEl.textContent = '未连接（可选）';
    }
    const dot = $('.cp-dot');
    if (dot) dot.classList.toggle('on', !!st);
    const disc = $('#cp-disconnect'); if (disc) disc.style.display = st ? '' : 'none';
    const conn = $('#cp-connect'); if (conn) { conn.disabled = false; conn.textContent = st ? '重新连接' : '连接'; }
  }

  // 启动脚本刚拉起 companion 时页面可能抢在前面：重试几次再放弃
  async function autoConnect(gen) {
    const c = state.companion;
    if (!c || !c.token) return;
    for (let i = 0; i < 6; i++) {
      if (gen !== renderSeq || c.status) return;
      try {
        c.status = await M.companionStatus(c.url, c.token);
        c.last = null;
        c.error = '';
        paintCompanion(gen);
        return;
      } catch (e) {
        if (i === 5) {
          c.error = '自动连接失败（companion 可能还没启动）：' + String(e && e.message || e);
          paintCompanion(gen);
          return;
        }
        await new Promise(r => setTimeout(r, 500));
      }
    }
  }

  function bindCompanion(gen) {
    const connect = $('#cp-connect');
    if (!connect) return;
    const urlEl = $('#cp-url'), tokenEl = $('#cp-token');
    if (urlEl) urlEl.addEventListener('input', () => { state.companion.url = urlEl.value; saveCompanionPrefs(); });
    if (tokenEl) tokenEl.addEventListener('input', () => { state.companion.token = tokenEl.value; saveCompanionPrefs(); });
    connect.addEventListener('click', async () => {
      if (gen !== renderSeq || state.companion.busy) return;
      const c = state.companion;
      c.url = (($('#cp-url') || {}).value || c.url).trim();
      c.token = (($('#cp-token') || {}).value || '').trim();
      startHeartbeat();
      c.error = '';
      c.status = null;
      connect.disabled = true;
      const stateEl = $('#cp-state'); if (stateEl) stateEl.textContent = '连接中…';
      try {
        const status = await M.companionStatus(c.url, c.token);
        if (gen !== renderSeq) return;
        c.status = status;
        c.last = null;
      } catch (e) {
        if (gen !== renderSeq) return;
        c.error = String(e && e.message || e);
      } finally {
        if (gen === renderSeq) paintCompanion(gen);
      }
    });
    const disc = $('#cp-disconnect');
    if (disc) disc.addEventListener('click', () => {
      if (gen !== renderSeq || state.companion.busy) return;
      state.companion.status = null;
      state.companion.last = null;
      state.companion.error = '';
      paintCompanion(gen);
    });
    bindCompanionBody(gen);
    if (pendingAutoConnect) { pendingAutoConnect = false; autoConnect(gen); }
  }

  function bindCompanionBody(gen) {
    $$('[data-cp-copy]').forEach(b => b.addEventListener('click', async () => {
      if (gen !== renderSeq) return;
      const x = M.manualCommands()[parseInt(b.dataset.cpCopy, 10)];
      if (!x) return;
      const ok = await copyText(x.cmd);
      b.textContent = ok ? '已复制' : '复制失败';
      setTimeout(() => { if (b.isConnected) b.textContent = '复制'; }, 1200);
    }));
    $$('[data-cp-run]').forEach(b => b.addEventListener('click', () => runCompanionAction(b, gen)));
    $$('[data-cp-dl]').forEach(b => b.addEventListener('click', () => {
      if (gen !== renderSeq) return;
      const arts = (state.companion.last && state.companion.last.artifacts) || [];
      const a = arts[parseInt(b.dataset.cpDl, 10)];
      if (a && a.bytes) dl(a.name || 'tool-artifact.bin', a.bytes);
    }));
    $$('[data-cp-analyze]').forEach(b => b.addEventListener('click', () => {
      if (gen !== renderSeq) return;
      analyzeToolArtifact(parseInt(b.dataset.cpAnalyze, 10));
    }));
  }

  function analyzeToolArtifact(i) {
    const arts = (state.companion.last && state.companion.last.artifacts) || [];
    const a = arts[i];
    const box = document.querySelector(`[data-cp-inline="${i}"]`);
    if (!a || !a.bytes || !box) return;
    try {
      const r = M.analyze(a.bytes, a.name, { maxScanPixels: 6000000 });
      const fl = M.flags(r);
      const top = r.findings.slice(0, 4).map(f => `<li>[${(f.confidence * 100).toFixed(0)}%] ${esc(f.title)}</li>`).join('');
      box.innerHTML = `<div class="cp-inline-in">${fl.length ? `<div class="flagbox">${esc(fl[0])}</div>` : ''}<div>${esc((r.type || {}).format || '?')} · ${r.findings.length} 条发现 · ${r.artifacts.length} 个产物</div><ul>${top}</ul></div>`;
    } catch (e) {
      box.innerHTML = `<div class="cp-error">${esc(e && e.message || e)}</div>`;
    }
  }

  async function runCompanionAction(button, gen) {
    const c = state.companion;
    if (c.busy || gen !== renderSeq || !c.status) return;
    const spec = (Array.isArray(c.status.actions) ? c.status.actions : []).find(a => a && a.id === button.dataset.cpRun);
    if (!spec) return;
    const fileBytes = state.bytes;
    const fileName = state.file ? state.file.name : 'upload.bin';
    if (!fileBytes) { c.error = '没有可发送的文件'; paintCompanion(gen); return; }
    if (fileBytes.length > M.MAX_COMPANION_UPLOAD) {
      c.error = '文件超过 32MB，请改用手动命令';
      paintCompanion(gen);
      return;
    }
    const box = button.closest('.cp-action');
    const fields = {};
    if (box) $$('[data-cp-field]', box).forEach(el => { fields[el.dataset.cpField] = el.value; });
    c.busy = true;
    c.error = '';
    $$('[data-cp-run]').forEach(b => { b.disabled = true; });
    const stateEl = $('#cp-state'); if (stateEl) stateEl.textContent = `运行 ${spec.tool}…`;
    button.textContent = '运行中…';
    try {
      await new Promise(r => setTimeout(r, 20));
      if (gen !== renderSeq) return;
      const data_b64 = await M.b64encodeAsync(fileBytes, p => {
        if (gen !== renderSeq) return;
        const el = $('#cp-state');
        if (el) el.textContent = `编码 ${Math.round(p * 100)}%…`;
      }, () => gen !== renderSeq);
      if (data_b64 === null || gen !== renderSeq) return;
      const res = await M.companionRun(c.url, c.token, {
        tool: spec.tool,
        action: spec.id,
        name: fileName,
        data_b64,
        fields
      });
      if (gen !== renderSeq) return;
      for (const a of res.artifacts || []) {
        try { a.bytes = M.b64decode(a.b64 || ''); } catch (_) { a.bytes = null; }
        delete a.b64;
      }
      c.last = res;
    } catch (e) {
      if (gen !== renderSeq) return;
      c.error = String(e && e.message || e);
    } finally {
      c.busy = false;
      if (gen === renderSeq) paintCompanion(gen);
      else if ($('#cp-body')) paintCompanion(renderSeq);
    }
  }

  function heatColor(t) {
    t = Math.max(0, Math.min(1, t));
    const stops = [
      [0, [16, 37, 43]], [0.25, [31, 79, 90]], [0.5, [63, 138, 138]],
      [0.75, [209, 138, 106]], [1, [255, 233, 201]]
    ];
    for (let i = 1; i < stops.length; i++) {
      if (t <= stops[i][0]) {
        const p = stops[i - 1], q = stops[i];
        const k = (t - p[0]) / (q[0] - p[0] || 1);
        return [0, 1, 2].map(j => Math.round(p[1][j] + (q[1][j] - p[1][j]) * k));
      }
    }
    return stops[stops.length - 1][1];
  }

  function drawWaveform(canvas, pcm) {
    const wf = M.waveform(pcm, 1200);
    const W = Math.max(16, wf.count), H = 120;
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#17252a'; ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = 'rgba(184,74,90,.28)'; ctx.beginPath();
    ctx.moveTo(0, H / 2); ctx.lineTo(W, H / 2); ctx.stroke();
    ctx.strokeStyle = '#c65a68'; ctx.beginPath();
    for (let x = 0; x < W; x++) {
      const lo = wf.mins[x] == null ? 0 : wf.mins[x];
      const hi = wf.maxs[x] == null ? 0 : wf.maxs[x];
      const y1 = H / 2 - hi * (H / 2 - 4);
      const y2 = H / 2 - lo * (H / 2 - 4);
      ctx.moveTo(x + 0.5, y1); ctx.lineTo(x + 0.5, y2);
    }
    ctx.stroke();
  }

  function drawSpectrogram(canvas, sp) {
    if (!sp || !sp.width || !sp.height) {
      canvas.width = 1; canvas.height = 1;
      return { peak: 0, width: 0, height: 0 };
    }
    const W = sp.width, H = sp.height;
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext('2d');
    const img = ctx.createImageData(W, H);
    const span = Math.max(1, sp.maxDb - sp.minDb);
    let best = -Infinity, bestK = 0;
    const sums = new Float64Array(H);
    for (let f = 0; f < W; f++) {
      for (let k = 0; k < H; k++) {
        const db = sp.data[f * H + k];
        sums[k] += db;
        const t = (db - sp.minDb) / span;
        const c = heatColor(t);
        const y = H - 1 - k;
        const p = (y * W + f) * 4;
        img.data[p] = c[0]; img.data[p + 1] = c[1]; img.data[p + 2] = c[2]; img.data[p + 3] = 255;
      }
    }
    for (let k = 0; k < H; k++) if (sums[k] > best) { best = sums[k]; bestK = k; }
    ctx.putImageData(img, 0, 0);
    return { peak: bestK * sp.sampleRate / sp.fftSize, width: W, height: H };
  }

  // MP3 的 PCM 交给浏览器解（AudioContext 原生支持 MP3），解出来复用 WAV 的波形/频谱
  function decodeMP3PCM(bytes) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC || !bytes) return Promise.resolve(null);
    let ctx = null;
    try { ctx = new AC(); } catch (e) { return Promise.resolve(null); }
    const ab = new Uint8Array(bytes).buffer;
    return ctx.decodeAudioData(ab).then(buf => {
      const ch = Math.min(2, buf.numberOfChannels);
      const frames = Math.min(buf.length, 5000000);
      const raw = [];
      for (let c = 0; c < ch; c++) raw.push(buf.getChannelData(c).subarray(0, frames));
      return {
        error: null, format: 3, bits: 32, channels: ch, sampleRate: buf.sampleRate,
        frames, totalFrames: buf.length, blockAlign: ch * 4, raw, data: new Uint8Array(0),
        value: (c, i) => raw[c][i]
      };
    }).catch(() => null).finally(() => { try { ctx.close(); } catch (e) { /* ignore */ } });
  }

  function bindAudio(gen) {
    const r = state.result;
    if (!r || !r.audio) return;
    const a = r.audio;
    const play = $('#a-play');
    if (play && state.bytes) {
      try {
        const u = URL.createObjectURL(new Blob([state.bytes], { type: a.format === 'MP3' ? 'audio/mpeg' : 'audio/wav' }));
        state.urls.push(u);
        play.src = u;
      } catch (_) { /* ignore */ }
    }
    const paintAudio = (pcm) => {
    const wave = $('#a-wave');
    if (wave && pcm) {
      try { drawWaveform(wave, pcm); } catch (_) { /* ignore */ }
    }
    const spec = $('#a-spec'), sel = $('#a-fft'), note = $('#a-spec-note');
    if (spec) {
      const draw = () => {
        if (gen !== renderSeq) return;
        try {
          const sp = M.spectrogram(a.pcm, { fftSize: parseInt(sel.value, 10) || 1024 });
          const info = drawSpectrogram(spec, sp);
          if (note) note.textContent = info.width ? `${info.width}×${info.height} · 峰值 ~${Math.round(info.peak)} Hz` : '样本不足';
        } catch (e) {
          if (note) note.textContent = '频谱失败：' + (e && e.message || e);
        }
      };
      sel.addEventListener('change', draw);
      const redraw = $('#a-redraw');
      if (redraw) redraw.addEventListener('click', draw);
      const specDl = $('#a-spec-dl');
      if (specDl) specDl.addEventListener('click', () => {
        if (gen !== renderSeq) return;
        try {
          const sp = M.spectrogram(a.pcm, { fftSize: parseInt(sel.value, 10) || 1024 });
          const tmp = document.createElement('canvas');
          drawSpectrogram(tmp, sp);
          if (!tmp.width) { setStatus('样本不足，无法导出频谱'); return; }
          dlCanvas(tmp, (state.file ? state.file.name.replace(/\.[^.]+$/, '') : 'audio') + '-spectrum.png');
          setStatus(`已导出频谱 ${tmp.width}×${tmp.height}`);
        } catch (e) { setStatus('<span style="color:var(--danger)">频谱导出失败：' + esc(e && e.message || e) + '</span>'); }
      });
      draw();
    }
    };
    if (a.pcm) paintAudio(a.pcm);
    else if (a.format === 'MP3' && state.bytes) {
      const note0 = $('#a-spec-note');
      decodeMP3PCM(state.bytes).then(pcm => {
        if (gen !== renderSeq) return;
        if (!pcm) { const n = $('#a-spec-note'); if (n) n.textContent = '浏览器解不开这段 MP3'; return; }
        a.pcm = pcm;
        paintAudio(pcm);
      }).catch(() => { const n = $('#a-spec-note'); if (n) n.textContent = '浏览器解不开这段 MP3'; });
    }
  }

  function bindResultEvents(gen) {
    const r = state.result;
    if (!r) return;
    $$('[data-dl]').forEach(b => b.addEventListener('click', () => {
      if (state.busy || gen !== renderSeq) return;
      const f = r.findings[parseInt(b.dataset.dl, 10)];
      if (f && f.payload && f.payload.bytes) dl(f.payload.name || 'payload.bin', f.payload.bytes);
    }));
    // 通用「修复并分析」：文件头补齐/跳过、以及任何带 repair 字节的发现
    $$('[data-repair]').forEach(b => b.addEventListener('click', () => {
      if (state.busy || gen !== renderSeq) return;
      const f = r.findings[parseInt(b.dataset.repair, 10)];
      if (!f || !f.repair || !f.repair.bytes) return;
      const name = f.repair.name || 'fixed.bin';
      dl(name, f.repair.bytes);
      analyzeBytes(f.repair.bytes, name);
      setStatus(`已修复并重新分析：${esc(name)}`);
    }));
    $$('[data-adl]').forEach(b => b.addEventListener('click', () => {
      if (state.busy || gen !== renderSeq) return;
      const a = r.artifacts[parseInt(b.dataset.adl, 10)];
      if (!a || !a.bytes) return;
      dl(a.name || 'artifact.bin', a.bytes);
    }));
    // PNG 修复
    $$('[data-fix-crc]').forEach(b => b.addEventListener('click', () => {
      if (state.busy || !state.bytes || gen !== renderSeq) return;
      try {
        const rep = M.repairPNG(state.bytes, {});
        if (rep.error) throw new Error(rep.error);
        dl('fixed-' + (state.file ? state.file.name : 'image.png'), rep.bytes);
        analyzeBytes(rep.bytes, 'fixed-' + (state.file ? state.file.name : 'image.png'));
        setStatus('已生成 CRC 修复副本并重新分析');
      } catch (e) { setStatus('<span style="color:var(--danger)">修复失败：' + esc(e.message || e) + '</span>'); }
    }));
    $$('[data-fix-dims]').forEach(b => b.addEventListener('click', () => {
      if (state.busy || !state.bytes || gen !== renderSeq) return;
      try {
        const [w, h] = b.dataset.fixDims.split(',').map(Number);
        const rep = M.repairPNG(state.bytes, { width: w, height: h });
        if (rep.error) throw new Error(rep.error);
        dl(`fixed-${w}x${h}-` + (state.file ? state.file.name : 'image.png'), rep.bytes);
        analyzeBytes(rep.bytes, `fixed-${w}x${h}-` + (state.file ? state.file.name : 'image.png'));
        setStatus(`已按 ${w}x${h} 生成修复副本并重新分析`);
      } catch (e) { setStatus('<span style="color:var(--danger)">修复失败：' + esc(e.message || e) + '</span>'); }
    }));
    function dimsFrom(a, b) {
      const w = parseInt($(a) && $(a).value, 10);
      const h = parseInt($(b) && $(b).value, 10);
      if (!(w > 0 && h > 0)) throw new Error('宽高必须是正整数');
      return [w, h];
    }
    $$('[data-fix-custom]').forEach(b => b.addEventListener('click', () => {
      if (state.busy || !state.bytes || gen !== renderSeq) return;
      try {
        const [w, h] = dimsFrom('#png-w', '#png-h');
        const rep = M.repairPNG(state.bytes, { width: w, height: h });
        if (rep.error) throw new Error(rep.error);
        dl(`fixed-${w}x${h}-` + (state.file ? state.file.name : 'image.png'), rep.bytes);
        analyzeBytes(rep.bytes, `fixed-${w}x${h}-` + (state.file ? state.file.name : 'image.png'));
        setStatus(`已按自定义 ${w}x${h} 改写 IHDR（CRC 已重算）并重新分析`);
      } catch (e) { setStatus('<span style="color:var(--danger)">改写失败：' + esc(e.message || e) + '</span>'); }
    }));
    // JPEG
    $$('[data-jpeg-h]').forEach(b => b.addEventListener('click', () => {
      if (state.busy || !state.bytes || gen !== renderSeq) return;
      try {
        const w = parseInt($('#jpeg-w') && $('#jpeg-w').value, 10);
        const h = parseInt(b.dataset.jpegH, 10);
        const r2 = M.editJPEGDims(state.bytes, w > 0 ? w : 1, h);
        if (r2.error) throw new Error(r2.error);
        dl(`fixed-h${h}-` + (state.file ? state.file.name : 'image.jpg'), r2.bytes);
        analyzeBytes(r2.bytes, `fixed-h${h}-` + (state.file ? state.file.name : 'image.jpg'));
        setStatus(`已把 JPEG 高度改为 ${h} 并重新分析`);
      } catch (e) { setStatus('<span style="color:var(--danger)">改写失败：' + esc(e.message || e) + '</span>'); }
    }));
    $$('[data-jpeg-cand]').forEach(b => b.addEventListener('click', () => {
      if (state.busy || !state.bytes || gen !== renderSeq) return;
      try {
        const [w, h] = b.dataset.jpegCand.split(',').map(Number);
        const r2 = M.editJPEGDims(state.bytes, w, h);
        if (r2.error) throw new Error(r2.error);
        dl(`fixed-${w}x${h}-` + (state.file ? state.file.name : 'image.jpg'), r2.bytes);
        analyzeBytes(r2.bytes, `fixed-${w}x${h}-` + (state.file ? state.file.name : 'image.jpg'));
        setStatus(`已按候选 ${w}x${h} 改写 JPEG 并重新分析`);
      } catch (e) { setStatus('<span style="color:var(--danger)">改写失败：' + esc(e.message || e) + '</span>'); }
    }));
    $$('[data-jpeg-custom]').forEach(b => b.addEventListener('click', () => {
      if (state.busy || !state.bytes || gen !== renderSeq) return;
      try {
        const [w, h] = dimsFrom('#jpeg-w', '#jpeg-h');
        const r2 = M.editJPEGDims(state.bytes, w, h);
        if (r2.error) throw new Error(r2.error);
        dl(`fixed-${w}x${h}-` + (state.file ? state.file.name : 'image.jpg'), r2.bytes);
        analyzeBytes(r2.bytes, `fixed-${w}x${h}-` + (state.file ? state.file.name : 'image.jpg'));
        setStatus(`已按自定义 ${w}x${h} 改写 JPEG SOF 并重新分析`);
      } catch (e) { setStatus('<span style="color:var(--danger)">改写失败：' + esc(e.message || e) + '</span>'); }
    }));
    // BMP
    $$('[data-bmp-custom]').forEach(b => b.addEventListener('click', () => {
      if (state.busy || !state.bytes || gen !== renderSeq) return;
      try {
        const [w, h] = dimsFrom('#bmp-w', '#bmp-h');
        const r2 = M.editBMPDims(state.bytes, w, h);
        if (r2.error) throw new Error(r2.error);
        dl(`fixed-${w}x${h}-` + (state.file ? state.file.name : 'image.bmp'), r2.bytes);
        analyzeBytes(r2.bytes, `fixed-${w}x${h}-` + (state.file ? state.file.name : 'image.bmp'));
        setStatus(`已按自定义 ${w}x${h} 改写 BMP 文件头并重新分析`);
      } catch (e) { setStatus('<span style="color:var(--danger)">改写失败：' + esc(e.message || e) + '</span>'); }
    }));
    $$('[data-bmp-cand]').forEach(b => b.addEventListener('click', () => {
      if (state.busy || !state.bytes || gen !== renderSeq) return;
      try {
        const [w, h] = b.dataset.bmpCand.split(',').map(Number);
        const r2 = M.editBMPDims(state.bytes, w, h);
        if (r2.error) throw new Error(r2.error);
        dl(`fixed-${w}x${h}-` + (state.file ? state.file.name : 'image.bmp'), r2.bytes);
        analyzeBytes(r2.bytes, `fixed-${w}x${h}-` + (state.file ? state.file.name : 'image.bmp'));
        setStatus(`已按候选 ${w}x${h} 改写 BMP 并重新分析`);
      } catch (e) { setStatus('<span style="color:var(--danger)">改写失败：' + esc(e.message || e) + '</span>'); }
    }));
    $$('[data-bmp-export]').forEach(b => b.addEventListener('click', () => {
      if (state.busy || !state.bytes || gen !== renderSeq) return;
      try {
        const info = M.parseBMP(state.bytes);
        const img = M.decodeBMP(state.bytes, info);
        if (img.error) throw new Error(img.error);
        const out = M.encodeBMP(img);
        if (!out) throw new Error('编码失败');
        dl((state.file ? state.file.name.replace(/\.[^.]+$/, '') : 'image') + '-24bit.bmp', out);
        setStatus('已导出 24-bit BMP');
      } catch (e) { setStatus('<span style="color:var(--danger)">导出失败：' + esc(e.message || e) + '</span>'); }
    }));
    // GIF 逐帧
    const gif = r.gif;
    if (gif) {
      gif.frames.forEach(f => {
        const cv = document.querySelector(`canvas[data-gif-thumb="${f.i}"]`);
        if (cv && f.image) {
          const R = M.renderImage(f.image, 96);
          if (R) {
            cv.width = R.width; cv.height = R.height;
            cv.getContext('2d').putImageData(new ImageData(R.data, R.width, R.height), 0, 0);
          }
        }
      });
      const frame = i => (gif.frames || []).find(f => f.i === i);
      $$('[data-gif-view]').forEach(b => b.addEventListener('click', () => {
        if (state.busy || gen !== renderSeq) return;
        const i = parseInt(b.dataset.gifView, 10);
        const sel = $('#v-img');
        if (!sel) return;
        const imgs = (r.images || []).filter(x => x.image && x.image.channels && x.image.width > 0);
        const idx = imgs.findIndex(x => x.name === 'gif-frame-' + i);
        if (idx < 0) { setStatus('这一帧没有进入查看器（尺寸过大或解码失败）'); return; }
        sel.value = String(idx);
        sel.dispatchEvent(new Event('change'));
        const viewer = $('.viewer');
        if (viewer) viewer.scrollIntoView({ block: 'center', behavior: 'smooth' });
        setStatus(`位平面查看器：GIF 第 ${i} 帧`);
      }));
      $$('[data-gif-png]').forEach(b => b.addEventListener('click', () => {
        if (state.busy || gen !== renderSeq) return;
        const f = frame(parseInt(b.dataset.gifPng, 10));
        const cv = f && canvasFromImage(f.image);
        if (!cv) { setStatus('这一帧无法导出'); return; }
        dlCanvas(cv, `gif-frame-${f.i}.png`);
        setStatus(`已导出第 ${f.i} 帧 PNG`);
      }));
      $$('[data-gif-bmp]').forEach(b => b.addEventListener('click', () => {
        if (state.busy || gen !== renderSeq) return;
        const f = frame(parseInt(b.dataset.gifBmp, 10));
        const out = f && f.image && M.encodeBMP(f.image);
        if (!out) { setStatus('这一帧无法导出'); return; }
        dl(`gif-frame-${f.i}.bmp`, out);
        setStatus(`已导出第 ${f.i} 帧 BMP`);
      }));
      $$('[data-gif-lsb]').forEach(b => b.addEventListener('click', () => {
        if (state.busy || gen !== renderSeq) return;
        const f = frame(parseInt(b.dataset.gifLsb, 10));
        const out = $('#gif-scan');
        if (!f || !f.image) return;
        if (out) out.textContent = `第 ${f.i} 帧扫描中…`;
        setTimeout(() => {
          if (gen !== renderSeq) return;
          try {
            const scan = M.scanImage(f.image, { deep: false, top: 20 });
            const flags = M.flags({ findings: scan.findings, artifacts: scan.artifacts });
            const titles = scan.findings.slice(0, 6).map(x => `· [${(x.confidence * 100).toFixed(0)}%] ${x.title}`).join('\n');
            if (out) out.textContent = `第 ${f.i} 帧：${scan.findings.length} 条发现${flags.length ? ' · flag：' + flags.join(' / ') : ''}\n${titles || '无显著发现'}`;
          } catch (e) {
            if (out) out.textContent = '扫描失败：' + (e && e.message || e);
          }
        }, 20);
      }));
      $$('[data-gif-full]').forEach(b => b.addEventListener('click', () => {
        if (state.busy || !state.bytes || gen !== renderSeq) return;
        try {
          const i = parseInt(b.dataset.gifFull, 10);
          const f = frame(i);
          if (!f || !f.fullHeight) return;
          const ed = M.editGIFDims(state.bytes, i, f.fullHeight);
          if (ed.error) throw new Error(ed.error);
          const name = `fixed-gif-frame${i}-${f.width}x${f.fullHeight}.gif`;
          dl(name, ed.bytes);
          analyzeBytes(ed.bytes, name);
          setStatus(`已按完整帧 ${f.width}x${f.fullHeight} 修复 GIF 并重新分析`);
        } catch (e) { setStatus('<span style="color:var(--danger)">GIF 修复失败：' + esc(e.message || e) + '</span>'); }
      }));
    }
    $$('[data-crc-calc]').forEach(b => b.addEventListener('click', () => {
      if (gen !== renderSeq) return;
      const t = $('#crc-text');
      const out = $('#crc-text-out');
      if (!t || !out) return;
      out.textContent = hex8(M.crc32(new TextEncoder().encode(t.value)));
    }));
    $$('[data-crc-brute]').forEach(b => b.addEventListener('click', () => {
      if (gen !== renderSeq) return;
      const raw = ($('#crc-target') && $('#crc-target').value || '').trim();
      const note = $('#crc-brute-note'), out = $('#crc-brute-out');
      const target = /^0x/i.test(raw) ? parseInt(raw, 16) : parseInt(raw, 10);
      if (!isFinite(target)) { if (note) note.textContent = '目标 CRC 不合法'; return; }
      const maxLen = parseInt($('#crc-len').value, 10) || 4;
      const charset = $('#crc-charset').value || 'abcdefghijklmnopqrstuvwxyz0123456789';
      if (note) note.textContent = '枚举中…';
      if (out) out.textContent = '';
      setTimeout(() => {
        if (gen !== renderSeq) return;
        try {
          const res = M.crc32Brute(target >>> 0, { charset, maxLen, limitMs: 15000 });
          if (note) note.textContent = `${res.tried} 个候选 · ${res.elapsed} ms${res.truncated ? ' · 已到时间上限，结果可能不全' : ''}`;
          if (out) out.textContent = res.hits.length ? res.hits.map(x => `命中：${x}`).join('\n') : '未命中';
        } catch (e) {
          if (note) note.textContent = '爆破失败：' + (e && e.message || e);
        }
      }, 20);
    }));
    // 产物缩略图
    r.artifacts.forEach((a, i) => {
      const canvas = document.querySelector(`canvas[data-art="${i}"]`);
      const img = document.querySelector(`img[data-art="${i}"]`);
      if (canvas && a.image) {
        const R = M.renderImage(a.image, 360);
        if (!R) return;
        canvas.width = R.width; canvas.height = R.height;
        canvas.getContext('2d').putImageData(new ImageData(R.data, R.width, R.height), 0, 0);
      } else if (img && a.bytes) {
        const u = URL.createObjectURL(new Blob([a.bytes]));
        state.urls.push(u);
        img.src = u;
      }
    });
    // 位平面：缩放 / 平移 / 像素读数
    const selImg = $('#v-img');
    if (selImg) {
      const selCh = $('#v-ch'), selBit = $('#v-bit'), inv = $('#v-inv'), cv = $('#v-canvas');
      const vp = $('#v-vp'), zoomLabel = $('#v-zoom'), pxLabel = $('#v-px');
      let zoom = 1;
      function imagesNow() {
        const rr = state.result;
        return (rr && rr.images ? rr.images : []).filter(x => x.image && x.image.channels);
      }
      function fillChannels() {
        if (gen !== renderSeq) return;
        const im = imagesNow()[parseInt(selImg.value, 10)];
        if (!im) return;
        const keys = Object.keys(im.image.channels);
        if (im.image.bitDepth === 16) keys.push(...keys.filter(k => !k.endsWith('hi')).map(k => k + 'hi'));
        selCh.innerHTML = keys.map(k => `<option value="${k}">${k}</option>`).join('');
        selBit.innerHTML = Array.from({ length: 8 }, (_, i) => `<option value="${i}">bit ${i}</option>`).join('');
      }
      function fitZoom() {
        const w = cv.width || 1, h = cv.height || 1;
        const availW = vp.clientWidth || 640;
        return Math.max(0.05, Math.min(1, availW / w, 520 / h));
      }
      function applyZoom() {
        cv.style.width = Math.max(1, Math.round(cv.width * zoom)) + 'px';
        cv.style.height = Math.max(1, Math.round(cv.height * zoom)) + 'px';
        zoomLabel.textContent = Math.round(zoom * 100) + '%';
      }
      function redraw(resetView) {
        if (gen !== renderSeq) return;
        const im = imagesNow()[parseInt(selImg.value, 10)];
        if (!im) return;
        const R = M.renderPlane(im.image, selCh.value || 'R', parseInt(selBit.value, 10) || 0, { invert: inv.checked });
        if (!R) return;
        cv.width = R.width; cv.height = R.height;
        cv.getContext('2d').putImageData(new ImageData(R.data, R.width, R.height), 0, 0);
        if (resetView) zoom = fitZoom();
        applyZoom();
        pxLabel.textContent = '';
      }
      selImg.addEventListener('change', () => { fillChannels(); redraw(true); });
      selCh.addEventListener('change', () => redraw(false));
      selBit.addEventListener('change', () => redraw(false));
      inv.addEventListener('change', () => redraw(false));
      $('#v-ref').addEventListener('click', () => redraw(false));
      $('#v-zin').addEventListener('click', () => { if (gen === renderSeq) { zoom = Math.min(16, zoom * 1.5); applyZoom(); } });
      $('#v-zout').addEventListener('click', () => { if (gen === renderSeq) { zoom = Math.max(0.05, zoom / 1.5); applyZoom(); } });
      $('#v-fit').addEventListener('click', () => { if (gen === renderSeq) { zoom = fitZoom(); applyZoom(); } });
      $('#v-1').addEventListener('click', () => { if (gen === renderSeq) { zoom = 1; applyZoom(); } });
      vp.addEventListener('wheel', e => {
        if (!e.ctrlKey || gen !== renderSeq) return;
        e.preventDefault();
        zoom = Math.max(0.05, Math.min(16, zoom * (e.deltaY < 0 ? 1.2 : 1 / 1.2)));
        applyZoom();
      }, { passive: false });
      vp.addEventListener('mousemove', e => {
        if (gen !== renderSeq) return;
        const im = imagesNow()[parseInt(selImg.value, 10)];
        if (!im) return;
        const rect = cv.getBoundingClientRect();
        if (!rect.width || !rect.height) return;
        const x = Math.floor((e.clientX - rect.left) / rect.width * im.image.width);
        const y = Math.floor((e.clientY - rect.top) / rect.height * im.image.height);
        if (x < 0 || y < 0 || x >= im.image.width || y >= im.image.height) { pxLabel.textContent = ''; return; }
        const chans = im.image._chans || (im.image._chans = M.channelBytes(im.image));
        const arr = chans[selCh.value];
        const v = arr ? arr[y * im.image.width + x] : '?';
        pxLabel.textContent = `(${x}, ${y}) · ${selCh.value}=${v} · bit${selBit.value}=${arr ? ((v >> parseInt(selBit.value, 10)) & 1) : '?'}`;
      });
      vp.addEventListener('mouseleave', () => { pxLabel.textContent = ''; });
      let drag = null;
      vp.addEventListener('pointerdown', e => {
        if (e.button !== 0) return;
        drag = { x: e.clientX, y: e.clientY, sl: vp.scrollLeft, st: vp.scrollTop };
        try { vp.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
        vp.classList.add('drag');
      });
      vp.addEventListener('pointermove', e => {
        if (!drag) return;
        vp.scrollLeft = drag.sl - (e.clientX - drag.x);
        vp.scrollTop = drag.st - (e.clientY - drag.y);
      });
      const endDrag = () => { drag = null; vp.classList.remove('drag'); };
      vp.addEventListener('pointerup', endDrag);
      vp.addEventListener('pointercancel', endDrag);
      fillChannels(); redraw(true);
    }

    // 双图对比
    const dA = $('#d-a');
    if (dA) {
      const dB = $('#d-b'), dMode = $('#d-mode'), dCv = $('#d-canvas'), dNote = $('#d-note');
      let last = null;
      const drawDiff = () => {
        if (gen !== renderSeq) return;
        const pool = imagePool();
        const a = pool[parseInt(dA.value, 10)];
        const b = pool[parseInt(dB.value, 10)];
        if (!a || !b) return;
        const res = M.diffImages(a.image, b.image, { mode: dMode.value });
        if (res.error) {
          last = null; dCv.width = dCv.height = 1;
          dNote.textContent = res.error;
          return;
        }
        dCv.width = res.width; dCv.height = res.height;
        dCv.getContext('2d').putImageData(new ImageData(res.data, res.width, res.height), 0, 0);
        const st = res.stats;
        dNote.textContent = `${(M.DIFF_MODES[res.mode] || {}).label || res.mode} · ${res.width}x${res.height} · 变化 ${st.changed} 像素（${(st.changedRatio * 100).toFixed(1)}%）· 最大差 ${st.maxDiff}`;
        last = res;
      };
      dA.addEventListener('change', drawDiff);
      dB.addEventListener('change', drawDiff);
      dMode.addEventListener('change', drawDiff);
      $('#d-save').addEventListener('click', () => {
        if (state.busy || gen !== renderSeq || !last) return;
        dCv.toBlob(blob => { if (blob) dl(`diff-${last.mode}.png`, blob, 'image/png'); }, 'image/png');
      });
      drawDiff();
    }

    bindAudio(gen);
    bindCompanion(gen);
  }

  // ---------- 过滤 ----------
  function applyFilter() {
    $$('.finding[data-layer]').forEach(el => {
      el.style.display = (state.layer === 'all' || el.dataset.layer === state.layer) ? '' : 'none';
    });
  }
  function bindFilters() {
    $$('#filters .chip').forEach(c => c.addEventListener('click', () => {
      $$('#filters .chip').forEach(x => x.classList.remove('on'));
      c.classList.add('on');
      state.layer = c.dataset.layer;
      applyFilter();
    }));
  }

  // ---------- 自检 ----------
  function runSelftest() {
    M.setFlagFormat('flag{}');   // 自检按默认格式跑，不受侧栏设置影响
    const S = globalThis.SELFTEST || { units: [], fixtures: [] };
    const lines = [];
    let pass = 0, fail = 0;
    function check(name, ok, detail) {
      if (ok) { pass++; lines.push(`<span class="ok">PASS</span> ${name}`); }
      else { fail++; lines.push(`<span class="bad">FAIL</span> ${name}${detail ? ' — ' + esc(detail) : ''}`); }
    }
    // 单元向量
    check('crc32("123456789") = cbf43926', M.crc32(new TextEncoder().encode('123456789')).toString(16) === 'cbf43926');
    check('sha256("abc") 已知向量', M.sha256(new TextEncoder().encode('abc')) === 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    check('b64encode("abc")', M.b64encode(new TextEncoder().encode('abc')) === 'YWJj');
    check('companion 只允许回环地址', M.companionUrlAllowed('http://127.0.0.1:8765') && M.companionUrlAllowed('http://localhost:1') && !M.companionUrlAllowed('http://example.com'));
    check('手动命令含 zsteg', M.manualCommands().some(x => x.cmd.indexOf('zsteg -a') >= 0));
    {
      const mk = vals => ({ width: vals.length, height: 1, channels: { R: Uint8Array.from(vals) } });
      const d = M.diffImages(mk([0, 255, 7]), mk([255, 255, 2]), { mode: 'xor' });
      check('双图 XOR', !d.error && d.data[0] === 255 && d.data[4] === 0 && d.data[8] === 5 && d.stats.changed === 2, d.error || JSON.stringify(d.stats));
      check('双图尺寸不符拒绝', !!M.diffImages(mk([0]), mk([0, 1]), {}).error);
      const fake = { name: 't.png', size: 3, sha256: 'x', type: { format: 'PNG', mime: 'image/png' }, findings: [], artifacts: [], files: [], stats: { files: 1, findings: 0, artifacts: 0, elapsed: 0 } };
      check('报告模板区分', M.buildReport(fake, { template: 'brief' }).indexOf('速报') >= 0 && M.buildReport(fake, { template: 'wp' }).indexOf('## 二、分析过程') >= 0 && M.buildReport(fake).indexOf('## 发现') >= 0);
      check('批量报告', M.buildBatchReport([fake, fake]).indexOf('## 汇总') >= 0);
    }
    {
      const src = { width: 4, height: 1, channels: {
        R: Uint8Array.from([0, 10, 20, 30]),
        G: Uint8Array.from([0, 20, 40, 60]),
        B: Uint8Array.from([0, 30, 60, 90]),
        A: Uint8Array.from([255, 255, 255, 255])
      } };
      const ch = M.applyNodeOp('channel', { ch: 'R' }, [src]).image;
      check('节点通道提取', ch.channels.R[1] === 10 && ch.channels.G[1] === 10);
      const g = M.evalNodeGraph(
        [{ id: 1, type: 'source' }, { id: 2, type: 'invert', params: {} }, { id: 3, type: 'output' }],
        [{ from: 1, to: 2, port: 0 }, { from: 2, to: 3, port: 0 }], { 1: src });
      check('节点图链式求值', g.images[3] && g.images[3].channels.R[1] === 245);
      const brute = M.crc32Brute(M.crc32(new TextEncoder().encode('abc')), { charset: 'abc', maxLen: 3 });
      check('CRC 短串反查', brute.hits.indexOf('abc') >= 0, JSON.stringify(brute));
      const tiny = { width: 2, height: 1, channels: { R: Uint8Array.from([1, 2]), G: Uint8Array.from([3, 4]), B: Uint8Array.from([5, 6]), A: Uint8Array.from([255, 255]) } };
      const bmp = M.encodeBMP(tiny);
      const ed = M.editBMPDims(bmp, 7, 9);
      const back = M.parseBMP(ed.bytes);
      check('BMP 自定义宽高', !ed.error && back.width === 7 && back.absH === 9);
      // 尺寸反推：2x1 BMP 尾部再压 3 行 → 应得 2x4
      const big = new Uint8Array(bmp.length + 24);
      big.set(bmp);
      const brec = M.recoverBMPDims(big);
      check('BMP 尺寸反推', brec.widthFixed.some(c => c.width === 2 && c.height === 4), JSON.stringify(brec.widthFixed.slice(0, 3)));
      // JPEG 候选
      const jfx = (S.fixtures || []).find(f => /\.jpe?g$/i.test(f.name));
      if (jfx) {
        const jrec = M.recoverJPEGDims(M.b64decode(jfx.b64));
        check('JPEG 尺寸反推', !jrec.error && jrec.candidates.length > 0, jrec.error || '');
      }
      // GIF 多余行：把帧高度改小 4 行，LZW 里仍有多余像素
      const gfx = (S.fixtures || []).find(f => /gif_lzw/.test(f.name));
      if (gfx) {
        const gb = M.b64decode(gfx.b64);
        const gp = M.parseGIF(gb);
        const gf = gp.frames[0];
        const shr = gb.slice();
        shr[gf.offset + 7] = Math.max(2, gf.height - 4) & 255;
        shr[gf.offset + 8] = (Math.max(2, gf.height - 4) >> 8) & 255;
        const rg = M.analyze(shr, 'gif-shrunk.gif', {});
        check('GIF 多余行反推', !!rg.findings.find(x => x.type === 'gif_extra_rows'));
      }
    }
    for (const u of S.units || []) {
      if (u.kind === 'inflate') {
        const comp = M.b64decode(u.comp);
        const z = M.inflateZlib(comp, 0);
        check(`inflate ${u.name}`, !!z.out && !z.error && M.sha256(z.out) === u.sha256, z.error || '长度 ' + (z.out && z.out.length));
      }
    }
    // 文件头修复：拿第一张 PNG 削掉首字节，应当能猜回 PNG
    {
      const f = (S.fixtures || []).find(x => x && /\.png$/i.test(x.name || ''));
      if (f) {
        const b = M.b64decode(f.b64);
        const cands = M.detectDamagedHeader(b.subarray(1));
        check('文件头被削能认出格式', cands.some(c => c.format === 'PNG' && c.mode === 'prepend'));
        const fixed = cands.find(c => c.format === 'PNG' && c.mode === 'prepend');
        check('文件头修复后能再识别', !!fixed && M.detectType(fixed.fixed, '').format === 'PNG');
      }
      check('版本说明含当前版本', (M.CHANGELOG || []).some(v => v.version === M.VERSION));
    }
    // fixture 端到端
    for (const fx of S.fixtures || []) {
      try {
        const bytes = M.b64decode(fx.b64);
        const r = M.analyze(bytes, fx.name, { maxScanPixels: 6000000 });
        const text = r.findings.map(f => [f.title, f.detail, f.preview, f.actual, f.declared, f.recipe].join('\n')).join('\n') + '\n' + M.flags(r).join('\n');
        const missing = (fx.expect || []).filter(x => text.indexOf(x) < 0);
        check(`fixture ${fx.name}`, missing.length === 0, missing.length ? '缺少 ' + missing.join(' / ') : '');
        if (r.findings.length) lines.push('  ' + r.findings.slice(0, 4).map(f => f.title).join(' | '));
      } catch (e) {
        check(`fixture ${fx.name}`, false, e && e.message || e);
      }
    }
    const panel = $('#selftest');
    panel.style.display = '';
    panel.innerHTML = `<b>自检</b> — ${pass} 通过 / ${fail} 失败\n\n${lines.join('\n')}`;
    $('#empty').style.display = 'none';
    $('#result').style.display = 'none';
    setStatus(fail ? `<span style="color:var(--danger)">自检失败 ${fail} 项</span>` : `自检通过 ${pass} 项`);
  }

  // ---------- 节点编辑器 ----------
  const nodeState = {
    nodes: [], links: [], seq: 1,
    sources: {},        // nodeId -> image
    uploads: [],        // { label, image }
    pendingSource: 0,
    drag: null,
    pending: null,      // { from, x, y }
    last: null
  };

  function nodePool() {
    const pool = [], seen = new Set();
    const push = (label, image) => {
      if (!image || !image.channels || !(image.width > 0) || !(image.height > 0) || seen.has(image)) return;
      seen.add(image);
      pool.push({ label, image });
    };
    for (const u of nodeState.uploads) push(u.label, u.image);
    for (const it of state.items) {
      if (!it.result) continue;
      for (const im of it.result.images || []) push(`${it.name} · ${im.name}`, im.image);
    }
    if (state.result) for (const im of state.result.images || []) push(im.name, im.image);
    return pool;
  }

  function nodeById(id) { return nodeState.nodes.find(n => n.id === id); }

  function nodeAdd(type, x, y) {
    const def = M.NODE_OPS[type];
    if (!def) return null;
    const n = {
      id: nodeState.seq++, type, x: Math.round(x), y: Math.round(y),
      params: M.nodeDefaultParams(type)
    };
    nodeState.nodes.push(n);
    return n;
  }

  function nodeEnsureGraph() {
    if (nodeState.nodes.length) {
      const pool = nodePool();
      if (pool.length) {
        for (const n of nodeState.nodes) {
          if (n.type === 'source' && !nodeState.sources[n.id]) nodeState.sources[n.id] = pool[0].image;
        }
      }
      paintNodes();
      return;
    }
    const src = nodeAdd('source', 60, 70);
    const out = nodeAdd('output', 430, 70);
    nodeState.links.push({ from: src.id, to: out.id, port: 0 });
    const pool = nodePool();
    if (pool.length) nodeState.sources[src.id] = pool[0].image;
    paintNodes();
  }

  function nodeParamHTML(n, f) {
    const v = n.params[f.key];
    if (f.type === 'select') {
      const opts = (f.options || []).map(o => `<option value="${esc(o)}"${String(v) === String(o) ? ' selected' : ''}>${esc(o)}</option>`).join('');
      return `<div class="grow"><label>${esc(f.label)}</label><select data-param="${esc(f.key)}" data-node="${n.id}">${opts}</select></div>`;
    }
    if (f.type === 'check') {
      return `<div class="grow"><label>${esc(f.label)}</label><input type="checkbox" data-param="${esc(f.key)}" data-node="${n.id}" ${v ? 'checked' : ''}></div>`;
    }
    const min = f.min === undefined ? '' : ` min="${f.min}"`;
    const max = f.max === undefined ? '' : ` max="${f.max}"`;
    return `<div class="grow"><label>${esc(f.label)}</label><input type="number" data-param="${esc(f.key)}" data-node="${n.id}" value="${esc(v)}"${min}${max}></div>`;
  }

  function nodeHTML(n) {
    const def = M.NODE_OPS[n.type] || { label: n.type, inputs: 1, params: [] };
    const isOut = n.type === 'output';
    let body = '';
    if (n.type === 'source') {
      const pool = nodePool();
      const cur = nodeState.sources[n.id];
      const opts = pool.map((p, i) => `<option value="${i}"${p.image === cur ? ' selected' : ''}>${esc(p.label)}</option>`).join('');
      body += `<div class="grow"><select data-src-select="${n.id}" style="width:100%">${opts || '<option value="">（先分析或载入图片）</option>'}</select></div>
        <div class="grow btns"><button class="gbtn" data-src-file="${n.id}">载入图片…</button><span class="gmeta">${cur ? cur.width + '×' + cur.height : '—'}</span></div>`;
    } else {
      for (let i = 0; i < (def.inputs || 1); i++) {
        body += `<div class="gport-row"><span class="gport in" data-in="${i}" data-node="${n.id}"></span><span class="gl">输入 ${i + 1}</span></div>`;
      }
      for (const f of def.params || []) body += nodeParamHTML(n, f);
      if (isOut) {
        body += `<canvas class="gout-canvas" data-out-canvas="${n.id}" width="1" height="1"></canvas>
          <div class="gerr" data-out-err="${n.id}"></div>
          <div class="grow btns"><button class="gbtn" data-out-png="${n.id}">下载 PNG</button><button class="gbtn" data-out-bmp="${n.id}">下载 BMP</button></div>
          <div class="gmeta" data-out-meta="${n.id}"></div>`;
      }
    }
    const outPort = !isOut
      ? `<span class="gport out" data-out="1" data-node="${n.id}"></span>` : '';
    return `<div class="gnode${n.type === 'source' ? ' source' : ''}${isOut ? ' outnode' : ''}" data-node="${n.id}" style="left:${n.x}px;top:${n.y}px">
      <div class="gnode-head"><span class="gn">${esc(def.label)}</span><button class="gx" data-del="${n.id}" title="删除">×</button></div>
      <div class="gnode-body">${body}</div>${outPort}
    </div>`;
  }

  function paintNodes() {
    const world = $('#node-world');
    if (!world) return;
    for (const el of Array.from(world.querySelectorAll('.gnode'))) el.remove();
    for (const n of nodeState.nodes) world.insertAdjacentHTML('beforeend', nodeHTML(n));
    redrawWires();
  }

  function nodeSocketPos(el) {
    const world = $('#node-world');
    if (!el || !world) return null;
    const r = el.getBoundingClientRect(), w = world.getBoundingClientRect();
    return { x: r.left - w.left + r.width / 2, y: r.top - w.top + r.height / 2 };
  }

  function redrawWires() {
    const svg = $('#node-wires');
    if (!svg) return;
    const parts = [];
    for (const l of nodeState.links) {
      const from = nodeSocketPos(document.querySelector(`.gnode[data-node="${l.from}"] .gport.out`));
      const to = nodeSocketPos(document.querySelector(`.gnode[data-node="${l.to}"] [data-in="${l.port}"]`));
      if (!from || !to) continue;
      const dx = Math.max(40, Math.abs(to.x - from.x) * 0.5);
      parts.push(`<path d="M ${from.x} ${from.y} C ${from.x + dx} ${from.y}, ${to.x - dx} ${to.y}, ${to.x} ${to.y}"/>`);
    }
    if (nodeState.pending) {
      const from = nodeSocketPos(document.querySelector(`.gnode[data-node="${nodeState.pending.from}"] .gport.out`));
      if (from) {
        const dx = Math.max(40, Math.abs(nodeState.pending.x - from.x) * 0.5);
        parts.push(`<path class="pending" d="M ${from.x} ${from.y} C ${from.x + dx} ${from.y}, ${nodeState.pending.x - dx} ${nodeState.pending.y}, ${nodeState.pending.x} ${nodeState.pending.y}"/>`);
      }
    }
    svg.innerHTML = parts.join('');
  }

  function nodeEval() {
    const res = M.evalNodeGraph(nodeState.nodes, nodeState.links, nodeState.sources);
    nodeState.last = res;
    for (const n of nodeState.nodes) {
      if (n.type !== 'output') continue;
      const canvas = document.querySelector(`canvas[data-out-canvas="${n.id}"]`);
      const err = document.querySelector(`[data-out-err="${n.id}"]`);
      const meta = document.querySelector(`[data-out-meta="${n.id}"]`);
      const img = res.images[n.id];
      if (err) err.textContent = res.errors[n.id] || '';
      if (canvas) {
        if (img) {
          const R = M.renderImage(img, 260);
          if (R) {
            canvas.width = R.width; canvas.height = R.height;
            canvas.style.display = '';
            canvas.getContext('2d').putImageData(new ImageData(R.data, R.width, R.height), 0, 0);
          }
        } else {
          canvas.width = 1; canvas.height = 1;
          canvas.style.display = 'none';
        }
      }
      if (meta) meta.textContent = img ? `${img.width} × ${img.height}` : '';
    }
    const shown = nodeState.nodes.find(n => n.type === 'output' && res.images[n.id])
      || nodeState.nodes.find(n => n.type === 'source' && nodeState.sources[n.id]);
    if (shown) {
      const img = res.images[shown.id] || nodeState.sources[shown.id];
      const label = shown.type === 'output' ? '节点输出 #' + shown.id : '节点输入';
      pvShowImage(img, label);
    }
  }

  function nodeConnect(from, to, port) {
    if (from === to) return;
    nodeState.links = nodeState.links.filter(l => !(l.to === to && l.port === port));
    nodeState.links.push({ from, to, port });
    nodeEval();
    redrawWires();
  }

  function nodeDelete(id) {
    nodeState.nodes = nodeState.nodes.filter(n => n.id !== id);
    nodeState.links = nodeState.links.filter(l => l.from !== id && l.to !== id);
    delete nodeState.sources[id];
    paintNodes();
    nodeEval();
  }

  function nodeClear() {
    nodeState.nodes = [];
    nodeState.links = [];
    nodeState.sources = {};
    nodeState.seq = 1;
    nodeState.last = null;
    paintNodes();
    nodeEval();
  }

  function nodeWorldPoint(e) {
    const w = $('#node-world').getBoundingClientRect();
    return { x: e.clientX - w.left, y: e.clientY - w.top };
  }

  function bindNodeEditor() {
    const sel = $('#node-add');
    if (!sel) return;
    sel.innerHTML = Object.keys(M.NODE_OPS).map(k => `<option value="${k}">${esc(M.NODE_OPS[k].label)}</option>`).join('');
    const world = $('#node-world');
    const wrap = $('#node-wrap');

    $('#node-add-btn').addEventListener('click', () => {
      const p = { x: (wrap ? wrap.scrollLeft : 0) + 80, y: (wrap ? wrap.scrollTop : 0) + 60 + (nodeState.nodes.length % 6) * 18 };
      const n = nodeAdd(sel.value, p.x, p.y);
      if (!n) return;
      paintNodes();
      nodeEval();
    });
    $('#node-clear').addEventListener('click', () => nodeClear());

    $('#node-file').addEventListener('change', async (e) => {
      const file = e.target.files && e.target.files[0];
      e.target.value = '';
      if (!file) return;
      const nodeId = nodeState.pendingSource;
      try {
        let bmp;
        try { bmp = await createImageBitmap(file); }
        catch (_) {
          const img = new Image();
          const url = URL.createObjectURL(file);
          try { await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = url; }); }
          finally { setTimeout(() => URL.revokeObjectURL(url), 1000); }
          bmp = img;
        }
        const W = bmp.width || bmp.naturalWidth, H = bmp.height || bmp.naturalHeight;
        if (!W || !H) throw new Error('图片尺寸为 0');
        const cv = document.createElement('canvas');
        cv.width = W; cv.height = H;
        const ctx = cv.getContext('2d');
        ctx.drawImage(bmp, 0, 0);
        const d = ctx.getImageData(0, 0, W, H).data;
        const n = W * H;
        const R = new Uint8Array(n), G = new Uint8Array(n), B = new Uint8Array(n), A = new Uint8Array(n);
        for (let i = 0; i < n; i++) {
          R[i] = d[i * 4]; G[i] = d[i * 4 + 1]; B[i] = d[i * 4 + 2]; A[i] = d[i * 4 + 3];
        }
        const image = { width: W, height: H, bitDepth: 8, colorType: 'RGBA', channels: { R, G, B, A }, error: null };
        nodeState.uploads.push({ label: file.name, image });
        if (nodeId) nodeState.sources[nodeId] = image;
        paintNodes();
        nodeEval();
        setStatus(`已载入节点图像：${file.name}（${W}×${H}）`);
      } catch (err) {
        setStatus('<span style="color:var(--danger)">载入图片失败：' + esc(err && err.message || err) + '</span>');
      }
    });

    world.addEventListener('pointerdown', (e) => {
      const del = e.target.closest('[data-del]');
      if (del) { e.preventDefault(); nodeDelete(parseInt(del.dataset.del, 10)); return; }
      const inPort = e.target.closest('.gport.in');
      if (inPort) {
        e.preventDefault();
        const to = parseInt(inPort.dataset.node, 10), port = parseInt(inPort.dataset.in, 10);
        nodeState.links = nodeState.links.filter(l => !(l.to === to && l.port === port));
        redrawWires();
        nodeEval();
        return;
      }
      const outPort = e.target.closest('.gport.out');
      if (outPort) {
        e.preventDefault();
        nodeState.pending = { from: parseInt(outPort.dataset.node, 10), x: 0, y: 0 };
        const p = nodeWorldPoint(e);
        nodeState.pending.x = p.x; nodeState.pending.y = p.y;
        redrawWires();
        return;
      }
      const head = e.target.closest('.gnode-head');
      if (head) {
        e.preventDefault();
        const el = head.closest('.gnode');
        const id = parseInt(el.dataset.node, 10);
        const n = nodeById(id);
        if (!n) return;
        const p = nodeWorldPoint(e);
        nodeState.drag = { id, dx: p.x - n.x, dy: p.y - n.y };
        el.classList.add('active');
        document.querySelectorAll('.gnode.active').forEach(x => { if (x !== el) x.classList.remove('active'); });
      }
    });

    document.addEventListener('pointermove', (e) => {
      if (nodeState.pending) {
        const p = nodeWorldPoint(e);
        nodeState.pending.x = p.x;
        nodeState.pending.y = p.y;
        redrawWires();
      } else if (nodeState.drag) {
        const n = nodeById(nodeState.drag.id);
        if (!n) return;
        const p = nodeWorldPoint(e);
        n.x = Math.max(0, Math.round(p.x - nodeState.drag.dx));
        n.y = Math.max(0, Math.round(p.y - nodeState.drag.dy));
        const el = document.querySelector(`.gnode[data-node="${n.id}"]`);
        if (el) { el.style.left = n.x + 'px'; el.style.top = n.y + 'px'; }
        redrawWires();
      }
    });

    document.addEventListener('pointerup', (e) => {
      if (nodeState.pending) {
        const el = document.elementFromPoint(e.clientX, e.clientY);
        const target = el && el.closest ? el.closest('.gport.in') : null;
        const pending = nodeState.pending;
        nodeState.pending = null;
        if (target) {
          nodeConnect(pending.from, parseInt(target.dataset.node, 10), parseInt(target.dataset.in, 10));
        }
        redrawWires();
      }
      if (nodeState.drag) {
        nodeState.drag = null;
        document.querySelectorAll('.gnode.active').forEach(x => x.classList.remove('active'));
      }
    });

    world.addEventListener('change', (e) => {
      const t = e.target;
      if (t.matches('[data-src-select]')) {
        const id = parseInt(t.dataset.srcSelect, 10);
        const pool = nodePool();
        const p = pool[parseInt(t.value, 10)];
        if (p) nodeState.sources[id] = p.image;
        else delete nodeState.sources[id];
        paintNodes();
        nodeEval();
        return;
      }
      if (t.matches('[data-param]')) {
        const n = nodeById(parseInt(t.dataset.node, 10));
        if (!n) return;
        const v = t.type === 'checkbox' ? t.checked : (t.type === 'number' ? t.value : t.value);
        n.params[t.dataset.param] = v;
        nodeEval();
      }
    });
    world.addEventListener('input', (e) => {
      const t = e.target;
      if (t.matches('[data-param]') && t.type === 'number') {
        const n = nodeById(parseInt(t.dataset.node, 10));
        if (n) n.params[t.dataset.param] = t.value;
        nodeEval();
      }
    });
    world.addEventListener('click', (e) => {
      const srcFile = e.target.closest('[data-src-file]');
      if (srcFile) {
        nodeState.pendingSource = parseInt(srcFile.dataset.srcFile, 10);
        $('#node-file').click();
        return;
      }
      const png = e.target.closest('[data-out-png]');
      if (png) {
        const n = nodeById(parseInt(png.dataset.outPng, 10));
        const img = n && nodeState.last && nodeState.last.images[n.id];
        const cv = img && canvasFromImage(img);
        if (cv) dlCanvas(cv, `node-output-${img.width}x${img.height}.png`);
        return;
      }
      const bmp = e.target.closest('[data-out-bmp]');
      if (bmp) {
        const n = nodeById(parseInt(bmp.dataset.outBmp, 10));
        const img = n && nodeState.last && nodeState.last.images[n.id];
        const out = img && M.encodeBMP(img);
        if (out) dl(`node-output-${img.width}x${img.height}.bmp`, out);
      }
    });
  }

  function bindViews() {
    $$('#viewtabs .vtab').forEach(b => b.addEventListener('click', () => {
      const view = b.dataset.view || 'analysis';
      $$('#viewtabs .vtab').forEach(x => x.classList.toggle('on', x === b));
      $('#content').style.display = view === 'analysis' ? '' : 'none';
      $('#pane-nodes').style.display = view === 'nodes' ? 'flex' : 'none';
      $('#pane-about').style.display = view === 'about' ? 'block' : 'none';
      $('#pv').style.display = view === 'about' ? 'none' : '';
      $('#filters').style.display = (view === 'analysis' && state.items.some(x => x.result)) ? '' : 'none';
      if (view === 'nodes') {
        nodeEnsureGraph();
        nodeEval();
      } else if (view === 'about') {
        renderAbout();
      } else if (state.result) {
        pvShowResult(state.result);
      }
    }));
    const pvToggle = $('#pv-toggle');
    if (pvToggle) pvToggle.addEventListener('click', () => {
      const pane = $('#pv');
      if (!pane) return;
      pane.classList.toggle('collapsed');
      pvToggle.textContent = pane.classList.contains('collapsed') ? '⇤' : '⇥';
      if (!pane.classList.contains('collapsed') && pv.source) {
        // 展开后按新宽度重画
        const r = state.result;
        if (r && $('#pane-nodes') && $('#pane-nodes').style.display !== 'none') nodeEval();
        else if (r) pvShowResult(r);
      }
    });
  }

  // ---------- 版本说明 ----------
  function renderAbout() {
    const box = $('#pane-about');
    if (!box) return;
    const caps = M.CAPABILITIES || [];
    const log = M.CHANGELOG || [];
    const capHTML = caps.map(c => `<section class="capbox"><h3>${esc(c.group)}</h3><ul>${(c.items || []).map(x => `<li>${esc(x)}</li>`).join('')}</ul></section>`).join('');
    const logHTML = log.map(v => {
      const cur = v.version === M.VERSION;
      const fixed = (v.fixed || []).length
        ? `<div class="vcol fix"><h4>修复</h4><ul>${v.fixed.map(x => `<li>${esc(x)}</li>`).join('')}</ul></div>` : '';
      return `<div class="vercard${cur ? ' cur' : ''}">
        <div class="vhead"><b>v${esc(v.version)}</b><span>${esc(v.date)}</span><em>${esc(v.title || '')}${cur ? '（当前版本）' : ''}</em></div>
        <div class="vbody${fixed ? '' : ' one'}">
          <div class="vcol"><h4>新增 / 包含</h4><ul>${(v.added || []).map(x => `<li>${esc(x)}</li>`).join('')}</ul></div>
          ${fixed}
        </div>
      </div>`;
    }).join('');
    box.innerHTML = `<div class="about">
      <h1>misc大手子 v${esc(M.VERSION)}</h1>
      <div class="sub">本地单文件 CTF Misc 分析工具 · 所有分析都在本地完成，不上传任何数据 · 双击 misc-dashouzi.html 即可使用</div>
      <h2>当前包含的能力</h2>
      <div class="capgrid">${capHTML}</div>
      <h2>更新记录</h2>
      ${logHTML}
    </div>`;
  }

  // ---------- 启动 ----------
  window.addEventListener('error', (e) => {
    try { setStatus('<span style="color:var(--danger)">JS 错误：' + esc(e.message) + '</span>'); } catch (_) { /* ignore */ }
  });
  window.addEventListener('unhandledrejection', (e) => {
    try { setStatus('<span style="color:var(--danger)">异步错误：' + esc(String(e.reason && e.reason.message || e.reason)) + '</span>'); } catch (_) { /* ignore */ }
  });
  document.addEventListener('DOMContentLoaded', () => {
    $('#ver').textContent = 'v' + (M.VERSION || '0.1.0');
    bindDrop();
    // 改了「深度扫描 / 像素上限」要重跑，否则界面还是上一轮的结论
    const rerun = () => { if (state.bytes && state.items.some(x => x.result) && !state.busy) runAnalysis(); };
    if ($('#deep')) $('#deep').addEventListener('change', rerun);
    if ($('#maxpx')) $('#maxpx').addEventListener('change', rerun);
    // 文件拖到页面别处时别让浏览器直接导航走（会把当前会话整个清掉）
    document.addEventListener('dragover', e => { e.preventDefault(); });
    document.addEventListener('drop', e => { e.preventDefault(); });
    bindFilters();
    bindViews();
    bindNodeEditor();
    $('#analyze').addEventListener('click', () => {
      if (state.busy) return;
      if (state.items.length > 1) runBatchAnalysis();
      else runAnalysis();
    });
    if ($('#cancel')) $('#cancel').addEventListener('click', cancelAnalysis);
    // flag 格式：恢复上次选择，改动即生效
    try {
      const saved = localStorage.getItem(FLAGFMT_KEY);
      if (saved && $('#flagfmt')) $('#flagfmt').value = saved;
    } catch (e) { /* ignore */ }
    M.setFlagFormat($('#flagfmt') ? $('#flagfmt').value : '');
    refreshFlagHint();
    if ($('#flagfmt')) {
      $('#flagfmt').addEventListener('input', refreshFlagHint);
      $('#flagfmt').addEventListener('change', () => {
        applyFlagFormat();
        // 改了 flag 模板，已有结果要按新模板重算，否则屏幕还停在旧结论
        if (state.result && !state.busy) { try { render(state.result); } catch (e) { /* ignore */ } }
      });
    }
    $('#report').addEventListener('click', () => {
      const done = state.items.filter(x => x.result);
      const tpl = ($('#report-tpl') || {}).value || 'full';
      if (state.items.length > 1 && done.length) {
        // 批量也要认「报告模板」：选速报就出速报，不能永远吐完整报告
        const md = tpl === 'full'
          ? M.buildBatchReport(done.map(x => x.result))
          : ['# misc大手子 批量报告（' + (tpl === 'brief' ? '速报' : 'WP 框架') + '）', '']
              .concat(done.map(r => M.buildReport(r, { template: tpl })))
              .join('\n\n---\n\n');
        dl('batch-misc-report.md', new TextEncoder().encode(md), 'text/markdown');
        return;
      }
      const r = state.result || (done[0] && done[0].result);
      if (!r) return;
      const md = M.buildReport(r, { template: tpl });
      dl((r.name || 'report') + '.misc-report.md', new TextEncoder().encode(md), 'text/markdown');
    });
    if (/[?&]selftest=1/.test(location.search)) runSelftest();
    const dm = location.search.match(/[?&]demo(?:=(\d+))?/);
    if (dm && globalThis.SELFTEST && SELFTEST.fixtures && SELFTEST.fixtures.length) {
      const idx = Math.max(0, Math.min(SELFTEST.fixtures.length - 1, (dm[1] ? parseInt(dm[1], 10) : 1) - 1));
      const fx = SELFTEST.fixtures[idx];
      state.bytes = M.b64decode(fx.b64);
      state.file = { name: fx.name };
      const info = $('#fileinfo');
      info.classList.add('show');
      info.innerHTML = `<b>${esc(fx.name)}</b><br>${fmtSize(state.bytes.length)} <span style="color:var(--muted)">（内置演示）</span>`;
      $('#analyze').disabled = false;
      runAnalysis();
    }
  });
})();
