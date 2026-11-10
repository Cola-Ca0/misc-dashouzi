/* misc大手子 — 62 音频
 * WAV：RIFF/chunk、PCM、LSB、波形、频谱、Morse；MP3：ID3v2/ID3v1。
 */
(function (root) {
  'use strict';
  const MDZ = root.MDZ = root.MDZ || {};
  const { toU8, hex, ascii, utf8, finding, artifact, scoreStream, FLAG_RE, printableRatio } = MDZ;

  function le16(b, o) { return (b[o] | (b[o + 1] << 8)) & 0xffff; }
  function le32(b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0; }
  function be16(b, o) { return ((b[o] << 8) | b[o + 1]) & 0xffff; }
  function be32(b, o) { return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0; }
  function synchsafe(b, o) {
    return ((b[o] & 0x7f) << 21) | ((b[o + 1] & 0x7f) << 14) | ((b[o + 2] & 0x7f) << 7) | (b[o + 3] & 0x7f);
  }
  function fourcc(b, o) {
    if (o + 4 > b.length) return '';
    return String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
  }
  function trimNul(s) { return String(s).replace(/\x00+$/g, ''); }

  // ---------- WAV ----------
  function parseWAV(input) {
    const b = toU8(input);
    if (b.length < 12 || fourcc(b, 0) !== 'RIFF' || fourcc(b, 8) !== 'WAVE') {
      return { error: '不是 RIFF/WAVE' };
    }
    const riffSize = le32(b, 4);
    const declared = riffSize + 8;
    const chunks = [];
    let pos = 12;
    let truncatedChunk = null;
    while (pos + 8 <= b.length) {
      const id = fourcc(b, pos);
      const size = le32(b, pos + 4);
      const start = pos + 8;
      const end = Math.min(start + size, b.length);
      const truncated = end < start + size;
      chunks.push({ id, size, offset: pos, start, end, truncated });
      if (truncated) { truncatedChunk = id; break; }
      pos = end + (size & 1);
      if (pos > b.length) break;
    }
    const fmtChunk = chunks.find(c => c.id === 'fmt ' && c.end - c.start >= 16);
    let fmt = null;
    if (fmtChunk) {
      const o = fmtChunk.start;
      const formatTag = le16(b, o);
      const channels = le16(b, o + 2);
      const sampleRate = le32(b, o + 4);
      const byteRate = le32(b, o + 8);
      const blockAlign = le16(b, o + 12);
      const bits = le16(b, o + 14);
      let validBits = bits;
      let format = formatTag;
      if (formatTag === 0xfffe && fmtChunk.end - fmtChunk.start >= 40) {
        validBits = le16(b, o + 18);
        const sub = le16(b, o + 24); // GUID 的第一个 16-bit = SubFormat
        if (sub === 1 || sub === 3) format = sub;
      }
      fmt = { format, formatTag, channels, sampleRate, byteRate, blockAlign, bits, validBits, size: fmtChunk.size };
    }
    const dataChunks = chunks.filter(c => c.id === 'data');
    const dataLen = dataChunks.reduce((a, c) => a + (c.end - c.start), 0);
    const info = [];
    for (const c of chunks) {
      if (c.id === 'LIST' && c.end - c.start >= 4 && fourcc(b, c.start) === 'INFO') {
        let p = c.start + 4;
        while (p + 8 <= c.end) {
          const id = fourcc(b, p);
          const sz = le32(b, p + 4);
          const s = p + 8, e = Math.min(s + sz, c.end);
          if (e > s) info.push({ id, text: trimNul(ascii(b.subarray(s, e), e - s)).trim() });
          p = e + (sz & 1);
        }
      } else if (c.id === 'bext' && c.end - c.start >= 288) {
        info.push({ id: 'bext.description', text: trimNul(ascii(b.subarray(c.start, c.start + 256), 256)).trim() });
        info.push({ id: 'bext.originator', text: trimNul(ascii(b.subarray(c.start + 256, c.start + 288), 32)).trim() });
      } else if (c.id === 'iXML') {
        info.push({ id: 'iXML', text: trimNul(ascii(b.subarray(c.start, c.end), Math.min(c.end - c.start, 4096))).trim() });
      } else if (c.id === 'id3 ') {
        info.push({ id: 'id3-chunk', text: trimNul(ascii(b.subarray(c.start, c.end), Math.min(c.end - c.start, 4096))).trim() });
      }
    }
    const trailing = declared < b.length ? b.subarray(declared) : null;
    const unknown = chunks.filter(c => !['RIFF', 'fmt ', 'data', 'LIST', 'bext', 'iXML', 'id3 ', 'fact', 'cue ', 'smpl', 'inst'].includes(c.id));
    return {
      error: null, chunks, fmt, dataChunks, dataLen, riffSize, declared, trailing,
      truncatedChunk, unknown, info, size: b.length,
      declaredMismatch: declared !== b.length
    };
  }

  function concatRanges(b, chunks, max) {
    let total = chunks.reduce((a, c) => a + (c.end - c.start), 0);
    if (max !== undefined) total = Math.min(total, max);
    const out = new Uint8Array(total);
    let p = 0;
    for (const c of chunks) {
      if (p >= total) break;
      const n = Math.min(c.end - c.start, total - p);
      out.set(b.subarray(c.start, c.start + n), p);
      p += n;
    }
    return out;
  }

  function decodeWAVPCM(parsed, input) {
    const b = toU8(input);
    if (!parsed || !parsed.fmt) return { error: '缺少 fmt chunk' };
    const f = parsed.fmt;
    if (f.format !== 1 && f.format !== 3) return { error: '压缩格式 ' + f.format + ' 暂不解码' };
    if (![8, 16, 24, 32].includes(f.bits)) return { error: '位深 ' + f.bits + ' 暂不支持' };
    if (!f.channels || f.channels > 8 || !f.sampleRate) return { error: 'fmt 参数异常' };
    const bytesPer = f.bits / 8;
    const blockAlign = f.blockAlign || f.channels * bytesPer;
    if (blockAlign < f.channels * bytesPer) return { error: 'blockAlign 小于声道×位深' };
    const totalBytes = parsed.dataChunks.reduce((a, c) => a + (c.end - c.start), 0);
    const frames = Math.floor(totalBytes / blockAlign);
    if (!frames) return { error: '没有可解码的采样' };
    const cap = Math.min(frames, 5000000);
    // 只拼要用的前 cap 帧：100MB 的 WAV 以前会先整块复制一遍再裁掉九成
    const allData = concatRanges(b, parsed.dataChunks, cap * blockAlign);
    const data = allData;
    const Ctor = f.bits <= 8 ? Uint8Array : f.bits <= 16 ? Uint16Array : Uint32Array;
    const raw = [];
    for (let ch = 0; ch < f.channels; ch++) raw.push(new Ctor(cap));
    for (let i = 0; i < cap; i++) {
      const off = i * blockAlign;
      for (let ch = 0; ch < f.channels; ch++) {
        const p = off + ch * bytesPer;
        if (p + bytesPer > data.length) break;
        let v = 0;
        if (bytesPer === 1) v = data[p];
        else if (bytesPer === 2) v = data[p] | (data[p + 1] << 8);
        else if (bytesPer === 3) v = data[p] | (data[p + 1] << 8) | (data[p + 2] << 16);
        else v = (data[p] | (data[p + 1] << 8) | (data[p + 2] << 16) | (data[p + 3] << 24)) >>> 0;
        raw[ch][i] = v >>> 0;
      }
    }
    // value() 是函数，结构化克隆会丢掉它；单独抽出来，Worker 回来的 pcm 能原地重建
    const pcm = {
      error: null, format: f.format, bits: f.bits, channels: f.channels,
      sampleRate: f.sampleRate, frames: cap, totalFrames: frames, blockAlign,
      raw, data, truncatedSamples: frames > cap
    };
    pcm.value = audioPCMValue(pcm);
    return pcm;
  }

  // 由 pcm 的 format/bits/raw 重建取样函数（主线程与 Worker 共用同一套规则）
  function audioPCMValue(pcm) {
    const raw = pcm.raw;
    const format = pcm.format, bits = pcm.bits;
    const fdv = new DataView(new ArrayBuffer(4));
    return function value(ch, i) {
      const v = raw[ch][i];
      if (format === 3 && bits === 32) { fdv.setUint32(0, v, true); return fdv.getFloat32(0, true); }
      if (bits === 8) return (v - 128) / 128;
      if (bits === 16) return ((v << 16) >> 16) / 32768;
      if (bits === 24) return ((v << 8) >> 8) / 8388608;
      return (v | 0) / 2147483648;
    };
  }

  // ---------- 音频 LSB ----------
  function audioChannelSets(channels) {
    if (channels <= 1) return [{ label: 'ch0', list: [0] }];
    if (channels === 2) return [
      { label: 'ch0', list: [0] }, { label: 'ch1', list: [1] },
      { label: 'ch0+1', list: [0, 1] }
    ];
    return [
      { label: 'ch0', list: [0] }, { label: 'ch1', list: [1] },
      { label: 'all', list: Array.from({ length: channels }, (_, i) => i) }
    ];
  }

  function extractAudioBits(pcm, opts) {
    const chans = opts.channels;
    const bit = opts.bit;
    const packing = opts.packing;
    const frames = Math.min(pcm.frames, opts.frames || pcm.frames);
    const list = opts.source === 'bytes' ? null : chans;
    const data = opts.source === 'bytes' ? pcm.data.subarray(0, opts.bytesLimit || pcm.data.length) : null;
    const totalBits = opts.source === 'bytes' ? data.length : frames * list.length;
    const byteLen = Math.floor(totalBits / 8);
    if (byteLen < 4) return null;
    const out = new Uint8Array(byteLen);
    let acc = 0, nb = 0, oi = 0;
    function push(v) {
      if (packing === 'msb') acc = ((acc << 1) | v) & 255;
      else acc = (acc | (v << nb)) & 255;
      nb++;
      if (nb === 8) { out[oi++] = acc; acc = 0; nb = 0; }
    }
    if (opts.source === 'bytes') {
      for (let i = 0; i < data.length; i++) push((data[i] >> bit) & 1);
    } else {
      for (let i = 0; i < frames; i++) {
        for (let k = 0; k < list.length; k++) push((pcm.raw[list[k]][i] >> bit) & 1);
      }
    }
    return out;
  }

  function scanAudioLSB(pcm) {
    const findings = [], artifacts = [];
    if (!pcm || pcm.error) return { findings, artifacts, best: null };
    const seen = new Set();
    const results = [];
    const scanFrames = Math.min(pcm.frames, 4000000);
    const truncated = pcm.frames > scanFrames;
    const add = (bytes, meta) => {
      if (!bytes || bytes.length < 8) return;
      // 先去重再打分是错的：开头 4KB 全是静音时，bit0 的全零流会先把哈希占住，
      // bit1 的真正载荷被当成重复直接丢掉。改成先打分、只对入选的做 首尾+长度 去重。
      const s = scoreStream(bytes, meta);
      if (!(s.score >= 30 && s.strong)) return;
      const len = bytes.length;
      const head = bytes.subarray(0, Math.min(len, 4096));
      const tail = len > 4096 ? bytes.subarray(len - 4096) : head;
      const h = MDZ.fnv1a(head).toString(16) + '-' + MDZ.fnv1a(tail).toString(16) + '-' + len;
      if (seen.has(h)) return;
      seen.add(h);
      results.push({ bytes, meta, s });
    };
    for (const set of audioChannelSets(pcm.channels)) {
      for (let bit = 0; bit <= Math.min(2, pcm.bits - 1); bit++) {
        for (const packing of ['msb', 'lsb']) {
          add(extractAudioBits(pcm, { source: 'sample', channels: set.list, bit, packing, frames: scanFrames }), {
            sets: set.label, bit, order: 'frame', packing, subset: 'all'
          });
        }
      }
    }
    for (let bit = 0; bit <= 1; bit++) {
      for (const packing of ['msb', 'lsb']) {
        add(extractAudioBits(pcm, { source: 'bytes', bit, packing, bytesLimit: 16 * 1024 * 1024 }), {
          sets: 'data-byte', bit, order: 'seq', packing, subset: 'all'
        });
      }
    }
    results.sort((a, b) => b.s.score - a.s.score);
    for (const r of results.slice(0, 8)) {
      const label = `${r.meta.sets} bit${r.meta.bit} ${r.meta.packing}`;
      findings.push(finding('L4', 'audio_lsb', `音频 LSB 候选：${label}（${r.s.score} 分）`, {
        confidence: Math.min(0.99, r.s.score / 100),
        actual: `${r.bytes.length} 字节`,
        detail: '证据：' + r.s.reasons.join('；'),
        preview: ascii(r.bytes, 160),
        recipe: `从 ${r.meta.sets} 的 bit${r.meta.bit} 按 ${r.meta.packing} 提取`,
        payload: { name: `audio-lsb-${r.meta.sets.replace(/[^\w]+/g, '-')}-b${r.meta.bit}-${r.meta.packing}.bin`, bytes: r.bytes }
      }));
      artifacts.push(artifact(`audio-lsb-${r.meta.sets.replace(/[^\w]+/g, '-')}-b${r.meta.bit}-${r.meta.packing}.bin`, r.bytes, `音频 LSB（${r.s.score} 分）`, 'lsb'));
    }
    if (truncated) {
      findings.push(finding('L4', 'audio_scan_limit', '音频 LSB 扫描按前 400 万采样裁剪', {
        confidence: 0.6, detail: `总采样 ${pcm.frames}，只扫描前 ${scanFrames}。后面的数据需要手工分块。`
      }));
    }
    return { findings, artifacts, best: results[0] || null, truncated };
  }

  // ---------- 波形 / 频谱 ----------
  function mixSamples(pcm) {
    const n = pcm.frames;
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      let s = 0;
      for (let ch = 0; ch < pcm.channels; ch++) s += pcm.value(ch, i);
      out[i] = s / pcm.channels;
    }
    return out;
  }

  function waveform(pcm, buckets) {
    const mix = mixSamples(pcm);
    const count = Math.max(16, Math.min(buckets || 1200, 4000));
    const step = Math.max(1, Math.floor(mix.length / count));
    const mins = [], maxs = [];
    for (let i = 0; i < mix.length; i += step) {
      let lo = 1, hi = -1;
      const end = Math.min(mix.length, i + step);
      for (let j = i; j < end; j++) { const v = mix[j]; if (v < lo) lo = v; if (v > hi) hi = v; }
      mins.push(lo); maxs.push(hi);
    }
    return { mins, maxs, count: mins.length };
  }

  function fft(re, im) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) { const t = re[i]; re[i] = re[j]; re[j] = t; const u = im[i]; im[i] = im[j]; im[j] = u; }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const ang = -2 * Math.PI / len;
      const wr = Math.cos(ang), wi = Math.sin(ang);
      for (let i = 0; i < n; i += len) {
        let cr = 1, ci = 0;
        for (let k = 0; k < len / 2; k++) {
          const ur = re[i + k], ui = im[i + k];
          const vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
          const vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
          re[i + k] = ur + vr; im[i + k] = ui + vi;
          re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
          const ncr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = ncr;
        }
      }
    }
  }

  function spectrogram(pcm, opts) {
    const o = opts || {};
    let fftSize = o.fftSize || 1024;
    if (!(fftSize >= 128 && fftSize <= 8192 && (fftSize & (fftSize - 1)) === 0)) fftSize = 1024;
    const mix = mixSamples(pcm);
    let hop = o.hop || Math.floor(fftSize / 2);
    const maxFrames = o.maxFrames || 1024;
    const available = Math.max(0, Math.floor((mix.length - fftSize) / hop) + 1);
    if (available > maxFrames) hop = Math.ceil((mix.length - fftSize) / maxFrames);
    const frames = Math.max(0, Math.floor((mix.length - fftSize) / hop) + 1);
    const bins = fftSize >> 1;
    const data = new Float32Array(frames * bins);
    const win = new Float32Array(fftSize);
    for (let i = 0; i < fftSize; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (fftSize - 1));
    let maxDb = -200;
    const re = new Float32Array(fftSize), im = new Float32Array(fftSize);
    for (let f = 0; f < frames; f++) {
      const start = f * hop;
      for (let i = 0; i < fftSize; i++) { re[i] = (mix[start + i] || 0) * win[i]; im[i] = 0; }
      fft(re, im);
      for (let k = 0; k < bins; k++) {
        const mag = Math.hypot(re[k], im[k]);
        const db = 20 * Math.log10(mag + 1e-12);
        data[f * bins + k] = db;
        if (db > maxDb) maxDb = db;
      }
    }
    const minDb = maxDb - 80;
    return {
      width: frames, height: bins, fftSize, hop, bins, frames,
      data, minDb, maxDb, sampleRate: pcm.sampleRate,
      duration: pcm.frames / pcm.sampleRate
    };
  }

  // ---------- Morse ----------
  const MORSE = {
    '.-': 'A', '-...': 'B', '-.-.': 'C', '-..': 'D', '.': 'E', '..-.': 'F', '--.': 'G',
    '....': 'H', '..': 'I', '.---': 'J', '-.-': 'K', '.-..': 'L', '--': 'M', '-.': 'N',
    '---': 'O', '.--.': 'P', '--.-': 'Q', '.-.': 'R', '...': 'S', '-': 'T', '..-': 'U',
    '...-': 'V', '.--': 'W', '-..-': 'X', '-.--': 'Y', '--..': 'Z',
    '-----': '0', '.----': '1', '..---': '2', '...--': '3', '....-': '4',
    '.....': '5', '-....': '6', '--...': '7', '---..': '8', '----.': '9',
    '.-.-.-': '.', '--..--': ',', '..--..': '?', '-..-.': '/', '-....-': '-',
    '.----.': "'", '-.--.': '(', '-.--.-': ')', '.-..-.': '"', '---...': ':',
    '-.-.-.': ';', '..--.-': '_', '...-..-': '$', '.--.-.': '@'
  };

  function morseDecode(pcm, opts) {
    const o = opts || {};
    const mix = mixSamples(pcm);
    const sr = pcm.sampleRate;
    const win = Math.max(1, Math.floor(sr * (o.window || 0.005)));
    const env = [];
    for (let i = 0; i + win <= mix.length; i += win) {
      let sum = 0;
      for (let j = 0; j < win; j++) sum += mix[i + j] * mix[i + j];
      env.push(Math.sqrt(sum / win));
    }
    let max = 0;
    for (const v of env) if (v > max) max = v;
    if (max < 1e-4) return { text: '', code: '', unit: 0, elements: 0 };
    const threshold = max * (o.threshold || 0.25);
    const runs = [];
    let on = env[0] > threshold, len = 1;
    for (let i = 1; i < env.length; i++) {
      const v = env[i] > threshold;
      if (v === on) len++;
      else { runs.push({ on, len }); on = v; len = 1; }
    }
    runs.push({ on, len });
    const onLens = runs.filter(r => r.on).map(r => r.len);
    if (!onLens.length) return { text: '', code: '', unit: 0, elements: 0 };
    onLens.sort((a, b) => a - b);
    const unit = onLens[0];
    if (unit < 1) return { text: '', code: '', unit: 0, elements: 0 };
    let code = '', text = '', elements = 0;
    for (const r of runs) {
      const units = r.len / unit;
      if (r.on) {
        if (units < 0.5) continue;
        code += units < 2 ? '.' : '-';
        elements++;
      } else {
        if (!code) continue;
        if (units >= 5) { text += (MORSE[code] || '') + ' '; code = ''; }
        else if (units >= 2) { text += (MORSE[code] || ''); code = ''; }
      }
    }
    if (code) text += MORSE[code] || '';
    return { text: text.replace(/\s+/g, ' ').trim(), code, unit, elements, threshold, max };
  }

  // ---------- ID3 ----------
  function latin1(b) {
    let s = '';
    for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
    return s;
  }
  function utf16be(b) {
    let s = '';
    for (let i = 0; i + 1 < b.length; i += 2) {
      const c = (b[i] << 8) | b[i + 1];
      if (c === 0) break;
      s += String.fromCharCode(c);
    }
    return s;
  }
  function decodeID3Text(data, enc) {
    const b = data;
    if (!b || !b.length) return '';
    let s = '';
    if (enc === 0) s = latin1(b);
    else if (enc === 3) s = utf8(b) || latin1(b);
    else if (enc === 2) s = utf16be(b);
    else if (enc === 1) {
      if (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe) s = MDZ.utf16le(b.subarray(2));
      else if (b.length >= 2 && b[0] === 0xfe && b[1] === 0xff) s = utf16be(b.subarray(2));
      else s = MDZ.utf16le(b);
    } else s = latin1(b);
    return trimNul(s).replace(/\x00/g, ' ').trim();
  }
  function splitID3Text(data, enc, start) {
    const b = data;
    let i = start || 0;
    if (enc === 1 || enc === 2) {
      for (; i + 1 < b.length; i += 2) if (b[i] === 0 && b[i + 1] === 0) break;
      const end = Math.min(i, b.length);
      return { text: decodeID3Text(b.subarray(start || 0, end), enc), next: Math.min(b.length, end + 2) };
    }
    for (; i < b.length; i++) if (b[i] === 0) break;
    return { text: decodeID3Text(b.subarray(start || 0, i), enc), next: Math.min(b.length, i + 1) };
  }

  function deunsyncBytes(b) {
    const out = new Uint8Array(b.length);
    let n = 0;
    for (let i = 0; i < b.length; i++) {
      out[n++] = b[i];
      if (b[i] === 0xff && b[i + 1] === 0x00) i++;
    }
    return out.subarray(0, n);
  }

  function parseID3v2(input, offset) {
    const b = toU8(input);
    const o = offset || 0;
    if (o + 10 > b.length || b[o] !== 0x49 || b[o + 1] !== 0x44 || b[o + 2] !== 0x33) return null;
    const version = b[o + 3], revision = b[o + 4], flags = b[o + 5];
    const size = synchsafe(b, o + 6);
    const end = Math.min(b.length, o + 10 + size);
    const tag = { offset: o, version, revision, flags, size, end, truncated: o + 10 + size > b.length, frames: [] };
    let body = b.subarray(o + 10, end);
    if (flags & 0x80) body = deunsyncBytes(body);
    let pos = 0;
    if (flags & 0x40 && version >= 3 && body.length >= 4) {
      const ext = version === 4 ? synchsafe(body, 0) : be32(body, 0);
      pos = Math.min(body.length, version === 4 ? ext : ext + 4);
    }
    const headerLen = version === 2 ? 6 : 10;
    while (pos + headerLen <= body.length) {
      let id, fsize, frameFlags = 0, dataStart, dataEnd;
      if (version === 2) {
        id = String.fromCharCode(body[pos], body[pos + 1], body[pos + 2]);
        if (!/^[A-Z0-9]{3}$/.test(id)) break;
        fsize = (body[pos + 3] << 16) | (body[pos + 4] << 8) | body[pos + 5];
        dataStart = pos + 6;
      } else {
        id = fourcc(body, pos);
        if (!/^[A-Z0-9]{4}$/.test(id)) break;
        fsize = version === 4 ? synchsafe(body, pos + 4) : be32(body, pos + 4);
        frameFlags = be16(body, pos + 8);
        dataStart = pos + 10;
      }
      dataEnd = dataStart + fsize;
      if (dataEnd > body.length) { tag.truncatedFrame = id; break; }
      let fdata = body.subarray(dataStart, dataEnd);
      // v2.4 帧级 flags：DLI(0x1) / unsync(0x2) / compression(0x8) / encryption(0x4) / grouping(0x40)
      if (version === 4) {
        if (frameFlags & 0x0001 && fdata.length >= 4) fdata = fdata.subarray(4);
        if (frameFlags & 0x0002) fdata = deunsyncBytes(fdata);
        if (frameFlags & 0x0008) {
          const z = MDZ.inflateRaw(fdata, 0, 8 * 1024 * 1024);
          if (z.out && !z.error) fdata = z.out;
        }
        if (frameFlags & 0x0040 && fdata.length) fdata = fdata.subarray(1);
        if (frameFlags & 0x0004) { tag.encryptedFrames = (tag.encryptedFrames || 0) + 1; pos = dataEnd; continue; }
      } else if (version === 3) {
        if (frameFlags & 0x0080) {
          const z = MDZ.inflateRaw(fdata, 0, 8 * 1024 * 1024);
          if (z.out && !z.error) fdata = z.out;
        }
        if (frameFlags & 0x0020 && fdata.length) fdata = fdata.subarray(1);
        if (frameFlags & 0x0040) { tag.encryptedFrames = (tag.encryptedFrames || 0) + 1; pos = dataEnd; continue; }
      }
      const frame = { id, size: fsize, flags: frameFlags, data: fdata };
      tag.frames.push(frame);
      pos = dataEnd;
    }
    return tag;
  }

  function frameInfo(frame) {
    const d = frame.data;
    if (!d || !d.length) return null;
    const enc = d[0];
    const id = frame.id;
    if (id[0] === 'T' && id !== 'TXXX' && d.length > 1) {
      return { id, kind: 'text', value: decodeID3Text(d.subarray(1), enc) };
    }
    if (id === 'TXXX') {
      const a = splitID3Text(d, enc, 1);
      return { id, kind: 'text', desc: a.text, value: decodeID3Text(d.subarray(a.next), enc) };
    }
    if (id === 'COMM' || id === 'USLT') {
      if (d.length < 4) return null;
      const lang = String.fromCharCode(d[1], d[2], d[3]);
      const a = splitID3Text(d, enc, 4);
      return { id, kind: 'text', lang, desc: a.text, value: decodeID3Text(d.subarray(a.next), enc) };
    }
    if (id === 'WXXX') {
      const a = splitID3Text(d, enc, 1);
      return { id, kind: 'text', desc: a.text, value: latin1(d.subarray(a.next)).replace(/\x00/g, '') };
    }
    if (id === 'APIC') {
      let p = 1;
      const mimeEnd = d.indexOf(0, p);
      if (mimeEnd < 0) return null;
      const mime = latin1(d.subarray(p, mimeEnd));
      p = mimeEnd + 1;
      if (p >= d.length) return null;
      const picType = d[p++];
      const desc = splitID3Text(d, enc, p);
      p = desc.next;
      return { id, kind: 'apic', mime, picType, desc: desc.text, data: d.subarray(p) };
    }
    if (id === 'PIC') {
      if (d.length < 6) return null;
      const fmt = latin1(d.subarray(1, 4)).toUpperCase();
      const picType = d[4];
      const desc = splitID3Text(d, enc, 5);
      const mime = fmt === 'PNG' ? 'image/png' : fmt === 'JPG' || fmt === 'JPEG' ? 'image/jpeg' : 'image/' + fmt.toLowerCase();
      return { id, kind: 'apic', mime, picType, desc: desc.text, data: d.subarray(desc.next) };
    }
    if (id === 'PRIV') {
      const z = d.indexOf(0);
      if (z < 0) return { id, kind: 'binary', data: d };
      return { id, kind: 'binary', owner: latin1(d.subarray(0, z)), data: d.subarray(z + 1) };
    }
    return { id, kind: 'binary', data: d };
  }

  function parseID3v1(input) {
    const b = toU8(input);
    if (b.length < 128) return null;
    const o = b.length - 128;
    if (b[o] !== 0x54 || b[o + 1] !== 0x41 || b[o + 2] !== 0x47) return null;
    const str = (a, n) => trimNul(latin1(b.subarray(o + a, o + a + n))).trim();
    return {
      title: str(3, 30), artist: str(33, 30), album: str(63, 30),
      year: str(93, 4), comment: str(97, 30), genre: b[o + 127]
    };
  }

  // MPEG Layer III 帧表（只认 Layer III；I/II 直接跳过）
  const MP3_BR1 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0];
  const MP3_BR2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0];
  const MP3_SR1 = [44100, 48000, 32000, 0];
  const MP3_SR2 = [22050, 24000, 16000, 0];
  const MP3_SR25 = [11025, 12000, 8000, 0];

  function parseMP3Frames(b, start) {
    const frames = [];
    let p = Math.max(0, start), bad = 0;
    while (p + 4 <= b.length && frames.length < 200000) {
      if (b[p] !== 0xFF || (b[p + 1] & 0xE0) !== 0xE0) {
        p++;
        if (++bad > 65536 && !frames.length) break;
        continue;
      }
      const verBits = (b[p + 1] >> 3) & 3;
      const layerBits = (b[p + 1] >> 1) & 3;
      const brIdx = (b[p + 2] >> 4) & 0xF;
      const srIdx = (b[p + 2] >> 2) & 3;
      const padding = (b[p + 2] >> 1) & 1;
      const priv = b[p + 2] & 1;
      const mode = (b[p + 3] >> 6) & 3;
      const copyright = (b[p + 3] >> 3) & 1;
      const original = (b[p + 3] >> 2) & 1;
      if (verBits === 1 || layerBits !== 1 || brIdx === 0 || brIdx === 15 || srIdx === 3) { p++; continue; }
      const mpeg1 = verBits === 3;
      const br = mpeg1 ? MP3_BR1[brIdx] : MP3_BR2[brIdx];
      const sr = mpeg1 ? MP3_SR1[srIdx] : (verBits === 2 ? MP3_SR2[srIdx] : MP3_SR25[srIdx]);
      if (!br || !sr) { p++; continue; }
      const len = Math.floor((mpeg1 ? 144 : 72) * br * 1000 / sr) + padding;
      if (len < 24 || p + len > b.length) { p++; continue; }
      frames.push({ offset: p, len, bitrate: br, sr, padding, priv, copyright, original, mode, mpeg1 });
      p += len;
      bad = 0;
    }
    return frames;
  }

  function auditMP3(input, name) {
    const b = toU8(input);
    const findings = [], artifacts = [];
    const tags = [];
    let tagEnd = 0;
    let tag = null;
    if (b.length >= 10 && b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) {
      tag = parseID3v2(b, 0);
      if (tag) {
        tagEnd = tag.end;
        findings.push(finding('L3', 'id3', `ID3v2.${tag.version} 标签`, {
          confidence: 0.5, offset: 0, declared: `${tag.size} 字节`, actual: `${tag.frames.length} 个帧`,
          detail: tag.truncated ? '标签声明长度超过文件。' : '文本帧与图片会被展开。'
        }));
        let apic = 0;
        for (const frame of tag.frames) {
          const info = frameInfo(frame);
          if (!info) continue;
          if (info.kind === 'apic') {
            const ext = info.mime.indexOf('png') >= 0 ? 'png' : info.mime.indexOf('jpeg') >= 0 || info.mime.indexOf('jpg') >= 0 ? 'jpg' : 'bin';
            if (apic < 8 && info.data && info.data.length > 8) {
              const name = `id3-apic-${apic++}.${ext}`;
              artifacts.push(artifact(name, info.data, `ID3 APIC（${info.mime}）`, 'metadata'));
              findings.push(finding('L3', 'id3_apic', 'ID3 APIC 图片', {
                confidence: 0.7, offset: tag.offset,
                declared: `${info.mime || '?'} / type ${info.picType}`,
                actual: `${info.data.length} 字节`,
                detail: info.desc ? '描述：' + info.desc : '',
                recipe: `提取 ${name}`
              }));
            }
            continue;
          }
          if (info.kind === 'text' || info.kind === 'binary') {
            const value = info.value !== undefined ? info.value : info.desc !== undefined ? info.desc : '';
            const rec = { id: info.id, desc: info.desc, value, lang: info.lang };
            tags.push(rec);
            const text = [info.desc, info.value, info.owner].filter(Boolean).join(' | ');
            if (text && (FLAG_RE.test(text) || /pass(word)?|secret|hint/i.test(text))) {
              findings.push(finding('L3', 'id3_text', `ID3 ${info.id} 命中文本`, {
                confidence: FLAG_RE.test(text) ? 0.95 : 0.65,
                offset: tag.offset, preview: text.slice(0, 500),
                recipe: `解析 ID3v2 ${info.id}`
              }));
            }
          }
        }
        const joined = tags.map(t => [t.id, t.desc, t.value].filter(Boolean).join('=')).join('\n');
        if (joined) findings.push(finding('L3', 'id3_meta', 'ID3 文本帧', {
          confidence: 0.5, preview: joined.slice(0, 1200), detail: `${tags.length} 个文本帧`
        }));
      }
    }
    // 后续 ID3（常见于拼接/尾部）
    let next = b.indexOf(0x49, Math.min(tagEnd, b.length - 2));
    while (next >= 0 && next + 10 <= b.length) {
      if (b[next] === 0x49 && b[next + 1] === 0x44 && b[next + 2] === 0x33) {
        const extra = parseID3v2(b, next);
        if (extra && extra.frames.length) {
          findings.push(finding('L3', 'id3_extra', `文件内第 ${tags.length ? 2 : 1} 个 ID3 标签 @ 0x${hex(next)}`, {
            confidence: 0.8, offset: next, actual: `${extra.frames.length} 个帧`,
            preview: extra.frames.map(fr => fr.id).join(' ')
          }));
          for (const frame of extra.frames) {
            const info = frameInfo(frame);
            if (info && info.kind === 'text') tags.push({ id: info.id, desc: info.desc, value: info.value });
          }
          break;
        }
      }
      next = b.indexOf(0x49, next + 1);
    }
    const v1 = parseID3v1(b);
    if (v1) {
      findings.push(finding('L3', 'id3v1', 'ID3v1 标签', {
        confidence: 0.5, offset: b.length - 128,
        preview: [v1.title, v1.artist, v1.album, v1.year, v1.comment].filter(Boolean).join(' | ')
      }));
      const text = [v1.title, v1.artist, v1.album, v1.comment].join(' ');
      if (FLAG_RE.test(text)) findings.push(finding('L3', 'id3v1_flag', 'ID3v1 命中 flag', { confidence: 0.95, preview: text }));
    }
    const tail = b.subarray(Math.max(tagEnd, 0));
    const tailText = ascii(tail, Math.min(tail.length, 4096));
    const strings = MDZ.strings(tail, 6).concat(MDZ.utf16strings(tail, 6));
    const hits = strings.filter(s => FLAG_RE.test(s) || /pass(word)?|secret|hint/i.test(s));
    if (hits.length) {
      findings.push(finding('L3', 'mp3_strings', 'MP3 数据区可疑字符串', {
        confidence: hits.some(s => FLAG_RE.test(s)) ? 0.9 : 0.55,
        preview: hits.slice(0, 20).join('\n'), actual: hits.slice(0, 8).join(' | ')
      }));
    }
    if (tail.length && FLAG_RE.test(tailText) && !hits.length) {
      findings.push(finding('L3', 'mp3_tail_flag', 'MP3 数据区命中 flag 正则', {
        confidence: 0.8, preview: tailText.slice(0, 500)
      }));
    }
    if (tail.length && tail.length < 2048 && tail.some(x => x !== 0)) {
      artifacts.push(artifact('mp3-tail.bin', tail, 'ID3 之后的数据'));
    }
    // ---------- 帧表 / Xing / 帧头比特信道 ----------
    const frames = parseMP3Frames(b, tagEnd);
    if (frames.length) {
      const first = frames[0];
      let totalBytes = 0;
      for (const f of frames) totalBytes += f.len;
      const duration = totalBytes * 8 / (first.bitrate * 1000);
      const side = first.mpeg1 ? (first.mode === 3 ? 17 : 32) : (first.mode === 3 ? 9 : 17);
      const xOff = first.offset + 4 + side;
      let xing = null;
      if (xOff + 8 <= b.length) {
        const tag4 = ascii(b.subarray(xOff, xOff + 4), 4);
        if (tag4 === 'Xing' || tag4 === 'Info') {
          const flags = (b[xOff + 4] << 24) | (b[xOff + 5] << 16) | (b[xOff + 6] << 8) | b[xOff + 7];
          let q = xOff + 8, framesCount = null, bytesCount = null;
          if (flags & 1) { framesCount = (b[q] << 24) | (b[q + 1] << 16) | (b[q + 2] << 8) | b[q + 3]; q += 4; }
          if (flags & 2) { bytesCount = (b[q] << 24) | (b[q + 1] << 16) | (b[q + 2] << 8) | b[q + 3]; q += 4; }
          xing = { tag: tag4, framesCount, bytesCount };
          const win = ascii(b.subarray(xOff, Math.min(b.length, xOff + 200)), Math.min(200, b.length - xOff));
          const lameAt = win.indexOf('LAME');
          if (lameAt >= 0) xing.encoder = win.slice(lameAt, lameAt + 9).replace(/[^ -~]/g, '');
        }
      }
      findings.push(finding('L1', 'mp3_frames', `MP3 帧：${frames.length} 帧，约 ${duration.toFixed(1)} 秒`, {
        confidence: 0.85, offset: first.offset,
        declared: `${first.mpeg1 ? 'MPEG-1' : 'MPEG-2'} Layer III · ${first.bitrate} kbps · ${first.sr} Hz · ${first.mode === 3 ? '单声道' : '立体声'}`,
        actual: xing ? [xing.tag, xing.framesCount != null ? xing.framesCount + ' 帧' : '', xing.encoder || ''].filter(Boolean).join(' · ') : '无 Xing/Info',
        detail: '帧表能看出时长/码率异常；帧头里的 private / copyright / original / padding 位也可能被当信道。',
        recipe: 'ffprobe -show_packets'
      }));
      if (frames.length >= 16) {
        for (const item of [['private', f => f.priv], ['copyright', f => f.copyright], ['original', f => f.original], ['padding', f => f.padding]]) {
          const label = item[0], getter = item[1];
          const bits = frames.map(getter).join('');
          let done = false;
          for (const order of ['msb', 'lsb']) {
            if (done) break;
            const seq = order === 'msb' ? bits : Array.from(bits).reverse().join('');
            const out = [];
            for (let i = 0; i + 8 <= seq.length; i += 8) out.push(parseInt(seq.slice(i, i + 8), 2));
            if (out.length < 4) continue;
            const u8 = Uint8Array.from(out);
            if (MDZ.printableRatio(u8.subarray(0, Math.min(4096, u8.length))) < 0.9) continue;
            const txt = ascii(u8, u8.length);
            findings.push(finding('L4', 'mp3_header_bits', `MP3 帧头 ${label} 位像文本（${order}）`, {
              confidence: 0.8,
              declared: `${frames.length} 帧的 ${label} 位`,
              actual: txt.slice(0, 120),
              preview: txt,
              detail: '逐帧取帧头里的这一位拼成比特流，能解出可打印文本，多半是出题人埋的信道。',
              recipe: `按帧取 ${label} 位，${order} 顺序每 8 位一组`,
              payload: { name: 'mp3-header-bits.bin', bytes: u8.slice(0) }
            }));
            artifacts.push(artifact('mp3-header-bits.bin', u8, 'MP3 帧头比特还原'));
            done = true;
          }
        }
      }
    }
    const audio = { format: 'MP3', tag, tags, id3v1: v1, audioStart: tagEnd, audioBytes: Math.max(0, b.length - tagEnd), frames: frames.length, xing: frames.length ? null : undefined };

    return { findings, artifacts, image: null, audio };
  }

  // ---------- WAV 审计 ----------
  function auditWAV(input, name) {
    const b = toU8(input);
    const findings = [], artifacts = [];
    const parsed = parseWAV(b);
    if (parsed.error) {
      return { findings: [finding('L0', 'format', '不是 WAV', { detail: parsed.error })], artifacts, image: null, audio: null };
    }
    if (parsed.declaredMismatch) {
      findings.push(finding('L1', 'riff_size', 'RIFF 声明大小与文件大小不符', {
        confidence: 0.8, offset: 4,
        declared: `${parsed.declared} 字节`, actual: `${parsed.size} 字节`,
        detail: parsed.declared < parsed.size ? 'RIFF 之后有尾挂数据。' : '文件被截断或尺寸被改。'
      }));
    }
    if (parsed.trailing && parsed.trailing.length) {
      findings.push(finding('L1', 'wav_trailer', 'RIFF 结束之后还有数据', {
        confidence: 0.9, offset: parsed.declared, actual: `${parsed.trailing.length} 字节`,
        preview: ascii(parsed.trailing, 160), recipe: `从 0x${hex(parsed.declared)} 切出`,
        payload: { name: 'wav-trailer.bin', bytes: parsed.trailing.slice(0) }
      }));
      artifacts.push(artifact('wav-trailer.bin', parsed.trailing, 'RIFF 之后的数据'));
    }
    if (parsed.truncatedChunk) {
      findings.push(finding('L1', 'wav_truncated', `chunk ${parsed.truncatedChunk} 被截断`, {
        confidence: 0.8, actual: parsed.size + ' 字节'
      }));
    }
    if (!parsed.fmt) {
      findings.push(finding('L1', 'wav_nofmt', '缺少 fmt chunk', { confidence: 0.9 }));
    } else {
      const f = parsed.fmt;
      if (f.formatTag === 0xfffe) {
        findings.push(finding('L1', 'wav_extensible', 'WAVE_FORMAT_EXTENSIBLE', {
          confidence: 0.6, actual: `SubFormat=${f.format} / validBits=${f.validBits}`,
          detail: '已按 SubFormat 解析 PCM/float；validBits 与容器位深可能不同。'
        }));
      }
      if (f.channels < 1 || f.channels > 8) findings.push(finding('L1', 'wav_channels', '声道数异常', { confidence: 0.8, actual: String(f.channels) }));
      if (!f.sampleRate || f.sampleRate > 768000) findings.push(finding('L1', 'wav_rate', '采样率异常', { confidence: 0.8, actual: String(f.sampleRate) }));
      if (![1, 3].includes(f.format)) findings.push(finding('L1', 'wav_format', '非 PCM/float WAV', { confidence: 0.7, actual: 'format=' + f.format }));
      if (![8, 16, 24, 32].includes(f.bits)) findings.push(finding('L1', 'wav_bits', '非常见位深', { confidence: 0.7, actual: f.bits + ' bit' }));
      if (f.blockAlign && f.channels && f.bits && f.blockAlign < f.channels * f.bits / 8) {
        findings.push(finding('L1', 'wav_blockalign', 'blockAlign 小于声道×位深', { confidence: 0.7 }));
      }
    }
    if (parsed.dataChunks.length > 1) {
      findings.push(finding('L1', 'wav_multidata', `发现 ${parsed.dataChunks.length} 个 data chunk`, {
        confidence: 0.75, detail: '多个 data 按顺序拼接后解码；夹在中间的 chunk 也值得看。'
      }));
    }
    if (parsed.info.length) {
      const text = parsed.info.map(x => `${x.id}=${x.text}`).join('\n');
      findings.push(finding('L3', 'wav_info', 'WAV 元数据文本', {
        confidence: 0.5, preview: text.slice(0, 1200), actual: `${parsed.info.length} 项`
      }));
      for (const x of parsed.info) {
        if (FLAG_RE.test(x.text) || /pass(word)?|secret|hint/i.test(x.text)) {
          findings.push(finding('L3', 'wav_info_hit', `WAV ${x.id} 命中文本`, {
            confidence: FLAG_RE.test(x.text) ? 0.95 : 0.65, preview: x.text.slice(0, 500)
          }));
        }
      }
    }
    // 未知 chunk 的字符串兜底
    for (const c of parsed.unknown) {
      const chunk = b.subarray(c.start, c.end);
      const hits = MDZ.strings(chunk, 6).filter(s => FLAG_RE.test(s) || /pass(word)?|secret|hint/i.test(s));
      if (hits.length) {
        findings.push(finding('L3', 'wav_chunk_strings', `WAV chunk ${c.id} 内可疑字符串`, {
          confidence: 0.7, offset: c.start, preview: hits.slice(0, 10).join('\n')
        }));
      }
    }
    const pcm = decodeWAVPCM(parsed, b);
    if (pcm.error) {
      findings.push(finding('L4', 'wav_decode', 'WAV PCM 解码失败', { confidence: 0.6, detail: pcm.error }));
    }
    const audio = {
      format: 'WAV', parsed, pcm: pcm.error ? null : pcm,
      sampleRate: parsed.fmt && parsed.fmt.sampleRate, channels: parsed.fmt && parsed.fmt.channels,
      bits: parsed.fmt && parsed.fmt.bits, duration: pcm.error ? 0 : pcm.totalFrames / pcm.sampleRate,
      morse: null
    };
    if (!pcm.error && pcm.truncatedSamples) {
      findings.push(finding('L4', 'wav_limit', 'WAV 采样按 500 万帧裁剪', {
        confidence: 0.6, actual: `总 ${pcm.totalFrames} 帧`, detail: '只解码/扫描前 500 万帧；后面的采样需手工分块。'
      }));
    }
    if (!pcm.error) {
      const lsb = scanAudioLSB(pcm);
      findings.push(...lsb.findings);
      artifacts.push(...lsb.artifacts);
      const m = morseDecode(pcm, {});
      audio.morse = m;
      if (m.text && m.text.replace(/[^A-Z0-9]/g, '').length >= 2) {
        findings.push(finding('L4', 'morse', `Morse 解码：${m.text}`, {
          confidence: 0.75, preview: m.text,
          detail: `单位 ${m.unit} 窗，${m.elements} 个符号`,
          recipe: '按包络阈值解码点划', payload: { name: 'morse.txt', bytes: Uint8Array.from(Array.from(m.text).map(c => c.charCodeAt(0))) }
        }));
        artifacts.push(artifact('morse.txt', Uint8Array.from(Array.from(m.text).map(c => c.charCodeAt(0))), 'Morse 解码文本'));
      }
    }
    return { findings, artifacts, image: null, audio };
  }

  Object.assign(MDZ, {
    parseWAV, decodeWAVPCM, audioPCMValue, extractAudioBits, scanAudioLSB, waveform, fft, spectrogram,
    morseDecode, parseID3v2, parseID3v1, decodeID3Text, auditWAV, auditMP3
  });
})(typeof globalThis !== 'undefined' ? globalThis : this);
