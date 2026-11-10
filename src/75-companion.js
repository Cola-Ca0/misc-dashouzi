/* misc大手子 — 75 外部工具桥
 * 浏览器侧：只连本机 companion（127.0.0.1/localhost），不上传到外部。
 * 不启动 companion 时，手写命令仍然可用。
 */
(function (root) {
  'use strict';
  const MDZ = root.MDZ = root.MDZ || {};

  const COMPANION_DEFAULT_URL = 'http://127.0.0.1:8765';
  const MAX_COMPANION_UPLOAD = 32 * 1024 * 1024;
  const REQUEST_TIMEOUT = 90000;

  const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

  function b64encode(input) {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    let out = '';
    for (let i = 0; i < bytes.length; i += 3) {
      const b0 = bytes[i];
      const has1 = i + 1 < bytes.length, has2 = i + 2 < bytes.length;
      const b1 = has1 ? bytes[i + 1] : 0;
      const b2 = has2 ? bytes[i + 2] : 0;
      out += B64[b0 >> 2];
      out += B64[((b0 & 3) << 4) | (b1 >> 4)];
      out += has1 ? B64[((b1 & 15) << 2) | (b2 >> 6)] : '=';
      out += has2 ? B64[b2 & 63] : '=';
    }
    return out;
  }

  async function b64encodeAsync(input, onProgress, isCancelled) {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    if (!bytes.length) return '';
    const parts = [];
    // 3 字节对齐，保证分块拼接后的 base64 与整段编码一致；每块让出主线程
    const chunk = 3 * 64 * 1024;
    for (let i = 0; i < bytes.length; i += chunk) {
      if (isCancelled && isCancelled()) return null;
      parts.push(b64encode(bytes.subarray(i, Math.min(i + chunk, bytes.length))));
      if (onProgress) {
        try { onProgress(Math.min(1, (i + chunk) / bytes.length)); } catch (_) { /* ignore */ }
      }
      await new Promise(r => setTimeout(r, 0));
    }
    if (isCancelled && isCancelled()) return null;
    return parts.join('');
  }

  function normalizeUrl(raw) {
    return String(raw == null ? '' : raw).trim().replace(/\/+$/, '');
  }

  function companionUrlAllowed(raw) {
    try {
      const u = new URL(normalizeUrl(raw));
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
      if (u.username || u.password) return false;
      if (u.pathname && u.pathname !== '/') return false;
      if (u.search || u.hash) return false;
      const h = u.hostname.toLowerCase();
      return h === '127.0.0.1' || h === 'localhost' || h === '::1' || h === '[::1]';
    } catch (_) {
      return false;
    }
  }

  async function request(base, token, path, init, timeoutMs) {
    const url = normalizeUrl(base);
    if (!companionUrlAllowed(url)) throw new Error('只允许连接本机 127.0.0.1 / localhost 的 companion');
    if (!token) throw new Error('请先填写 companion token');
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs || REQUEST_TIMEOUT);
    let res, text;
    try {
      res = await fetch(url + path, Object.assign({}, init, { signal: ctl.signal, cache: 'no-store' }));
      text = await res.text();
    } catch (e) {
      if (e && e.name === 'AbortError') throw new Error('companion 请求超时');
      throw new Error('连不上 companion：' + (e && e.message || e));
    } finally {
      clearTimeout(timer);
    }
    let data;
    try {
      data = JSON.parse(text);
    } catch (_) {
      throw new Error('companion 返回非 JSON（HTTP ' + res.status + '）：' + text.slice(0, 160));
    }
    if (!res.ok || !data.ok) throw new Error(data.error || ('companion HTTP ' + res.status));
    return data;
  }

  function companionStatus(base, token) {
    return request(base, token, '/api/status', {
      method: 'GET',
      headers: { 'X-MDZ-Token': token }
    });
  }

  function companionRun(base, token, payload) {
    if (!payload || !payload.tool || !payload.action) throw new Error('缺少 tool/action');
    if (payload.data_b64 && payload.data_b64.length > Math.ceil(MAX_COMPANION_UPLOAD * 4 / 3) + 8) {
      throw new Error('文件超过 32MB，请改用左侧手写命令');
    }
    return request(base, token, '/api/run', {
      method: 'POST',
      headers: { 'X-MDZ-Token': token, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }, 120000);
  }

  // 页面关闭时告诉 companion 收摊；keepalive 让它能在 unload 阶段发出去
  function companionBye(base, token) {
    return request(base, token, '/api/bye', {
      method: 'POST',
      keepalive: true,
      headers: { 'X-MDZ-Token': token, 'Content-Type': 'application/json' },
      body: '{}'
    }, 3000);
  }

  const BUILTIN = '工具内已内置，这条只作备用：';
  const MANUAL = [
    { group: 'zsteg', label: '全扫', cmd: 'zsteg -a "<FILE>"', note: BUILTIN + '位平面 / LSB 穷举扫描' },
    { group: 'zsteg', label: 'RGB LSB 提取', cmd: 'zsteg -E "b1,rgb,lsb,xy" "<FILE>" > out.bin', note: BUILTIN + '同上' },
    { group: 'zsteg', label: 'BGR LSB 提取', cmd: 'zsteg -E "b1,bgr,lsb,xy" "<FILE>" > out.bin', note: BUILTIN + '同上' },
    { group: 'binwalk', label: '签名扫描', cmd: 'binwalk "<FILE>"', note: BUILTIN + '压缩流签名扫描' },
    { group: 'binwalk', label: '自动提取', cmd: 'binwalk -e "<FILE>"', note: BUILTIN + '递归拆产物' },
    { group: 'exiftool', label: '全部元数据', cmd: 'exiftool -a -G1 -s "<FILE>"', note: BUILTIN + '元数据面板' },
    { group: 'exiftool', label: '缩略图', cmd: 'exiftool -b -ThumbnailImage "<FILE>" > thumb.jpg', note: BUILTIN + '缩略图直接进产物' },
    { group: 'steghide', label: '查看信息', cmd: 'steghide info -p "" "<FILE>"' },
    { group: 'steghide', label: '提取（带口令）', cmd: 'steghide extract -sf "<FILE>" -p "<PASSWORD>" -f', note: 'steghide 的算法只能靠外部程序；工具内做的是 LSB 穷举。' },
    { group: 'bkcrack', label: '列出 ZIP 条目', cmd: 'bkcrack -L "<FILE>"', note: BUILTIN + 'ZIP 结构面板' },
    { group: 'zbarimg', label: '二维码/条码', cmd: 'zbarimg -q --raw "<FILE>"', note: BUILTIN + '分析时自动识别二维码与一维条码（EAN/Code128/Code39）' },
    {
      group: 'bkcrack', label: '已知明文攻击',
      cmd: 'bkcrack -C "<CIPHER.zip>" -c "<CIPHER_ENTRY>" -P "<PLAIN.zip>" -p "<PLAIN_ENTRY>" -o <OFFSET>',
      note: '需要密文 ZIP + 已知明文 ZIP；先把 <...> 替换成实际值。'
    },
    {
      group: 'lzma', label: '从偏移切出并解压',
      cmd: 'dd if="<FILE>" bs=1 skip=<OFFSET> 2>/dev/null | xz --format=lzma -dc',
      note: BUILTIN + 'LZMA 流会自动解压并递归分析'
    },
    { group: 'lzma', label: '直接解（文件本身就是 .lzma）', cmd: 'xz --format=lzma -dc "<FILE>"', note: BUILTIN + '同上' }
  ];

  function manualCommands() {
    return MANUAL.map(x => Object.assign({}, x));
  }

  Object.assign(MDZ, {
    COMPANION_DEFAULT_URL, MAX_COMPANION_UPLOAD,
    b64encode, b64encodeAsync, normalizeUrl, companionUrlAllowed, companionStatus, companionRun, companionBye, manualCommands
  });
})(typeof globalThis !== 'undefined' ? globalThis : this);
