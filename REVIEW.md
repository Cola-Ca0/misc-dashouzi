# misc大手子 代码审查（2026-11-10 · v0.15.0）
> 方法：4 个镜头并行初审（正确性 / 性能 / 架构 / 交互），再**换镜头**交叉对抗复核（复核者的任务是尽量否掉别人的发现）。
> 规模：8 个 agent、54.5 万 token、初审 47 条 → **确认 29 · 部分成立 17 · 否掉 1**。
> 定级：P0 = 卡死或结论错误；P1 = 明显漏检/丢数据；P2 = 性能或体验损耗；P3 = 可维护性。

标记 ✔ 的条目由我在复核之后另行读码或实测验证过；C2 用 5 秒超时实测复现（exit=124）。

## 确认（29 条）

交叉复核认为问题真实存在、影响属实。

### C1 P0 `src/55-archives.js:306`

**7Z 未压缩头的 kName 长度不校验：64 字节文件就能让 audit7Z 死循环**  ✔ 已复核

- 类型：hang ｜ 工作量：S（3 行边界检查）
- 主张：parse7zNames 用 kName 属性声明的 sz.value 直接算 end，从不与 hdr.length 比较；9 字节 vint 可把 end 撑到 2^63，内层名称循环对着越界的 undefined 字节无限跑，audit7Z 永不返回。
- 证据：src/55-archives.js:306 `const end = bodyStart + sz.value;`，307–316 的 `while (q + 1 < end)` 循环；sz 来自 `sevenVint(hdr, p)`，全程没有 `bodyStart + sz.value <= hdr.length` 检查。复现：构造 64 字节文件（7z 签名 + nextSize=32 的未压缩头，kHeader/kFilesInfo/kName，size vint = FF×8 后接 7F），`MDZ.audit7Z()` 8 秒超时；插桩显示 q 每次 +2、end=9223372036854776000 持续循环。
- 影响：打开一个手工构造或头部被改坏的 7z，会让页面主线程永久卡死（分析在 setTimeout 里同步执行，没有 worker），只能强杀标签页；Node 批量分析/回归也挂死，且没有任何错误输出。
- 修法：在 kName 前加 `if (sz.value > hdr.length - bodyStart) return names;`，并令 `const end = Math.min(bodyStart + sz.value, hdr.length);`；内层 while 同时用 `q < hdr.length` 夹取，kFilesInfo 内其它按 sz.value 前进的属性也统一按 hdr.length 截断。

### C2 P0 `src/62-audio.js:490`

**ID3v2 加密帧标志的 continue 不推进 pos：parseID3v2 死循环**  ✔ 已复核

- 类型：hang ｜ 工作量：S（2 处各加 1 行）
- 主张：v2.3 帧 flags 0x0040（以及 v2.4 的 0x0004）分支在 `continue` 前没有执行 `pos = dataEnd`，while 循环反复读同一个帧，auditMP3 永不返回。
- 证据：src/62-audio.js:490 `if (frameFlags & 0x0040) { tag.encryptedFrames = (tag.encryptedFrames || 0) + 1; continue; }`（v2.4 同型在 483 行），真正推进的 `pos = dataEnd;` 在 494 行，被 continue 跳过。复现：最小 20 字节 ID3v2.3（TIT2、size=0、flags=0x40）调用 auditMP3，plain 版 1ms 返回，加密标志版 8 秒超时；把 fixtures/mp3_id3.mp3 改 1 字节得到帧 flags=0xD9（含 0x40）同样复现。
- 影响：MP3 只要某个帧的 flags 字节被改到 0x40/0x04（改 1 字节即可），页面就会卡死；而 misc 题目里 MP3 被改字节非常常见，代价是整份分析（含此前所有结果）无法完成。
- 修法：两个加密分支 continue 前补 `pos = dataEnd;`，或把 `pos = dataEnd;` 移到 flags 处理之前统一推进（v2.4/v2.3/v2.2 各分支都要保证推进）。

### C3 P1 `src/70-analyze.js:179`

**流签名尝试上限按命中数计数：>1MB 文件后半段的 zlib/LZMA/内嵌容器永远不试**  ✔ 已复核

- 类型：data-loss ｜ 工作量：S（改计数方式/去掉统一 break）
- 主张：`if (tried++ > maxTries) break;` 对 >1MB 文件只给 64 次机会，而 findStreamSignatures 会把随机数据里大量 0x78 zlib 假头算作命中（约每 8KB 一个），真实流/内嵌 ZIP/PNG/JPEG 位于文件后半段时根本轮不到。
- 证据：src/70-analyze.js:174–179 `const big = bytes.length > 1024 * 1024; const maxOut = big ? 8 * 1024 * 1024 : 64 * 1024 * 1024; const maxTries = big ? 64 : 256; ... if (tried++ > maxTries) break;`。实测：1.2MB 随机载体 + 1.1MB 处 zlib(flag) → flags=[]、无 stream finding；同数据放 300KB 处则命中。5MB 载体 + 4.5MB 处 zlib → 同样 miss；1.5MB 随机数据 + 尾部 PNG 签名 → 无 carve finding、0 产物。900KB 文件因 budget=256，800KB 处的流仍能命中。
- 影响：日志/镜像/大图/大 pcap 尾部的压缩流与内嵌容器会被静默跳过，直接漏 flag；工具不会提示「后面还有签名没试」。
- 修法：分两遍处理 hits：先处理 zip/png/jpeg carve，再处理 zlib/gzip/lzma；按 kind 分别计数，zlib 先用前 16 字节做廉价 inflate 探测再计入预算。顺带修正 `tried++` 的 off-by-one（当前上限是 maxTries+1）。

### C4 P1 `src/53-pdf.js:57`

**PDF ASCII85 解码前删掉第一个 '<' 之前的全部数据：含 '<' 的合法流全解不出**  ✔ 已复核

- 类型：data-loss ｜ 工作量：S（1 行）
- 主张：`replace(/^[\s\S]*?<~?/, '')` 本意只去掉可选 `<~` 前缀，但 ASCII85 字母表本身包含 '<'（码位 60），流里任意一个 '<' 都会把它之前的全部数据删掉，a85decode 得到错误/过短字节。
- 证据：src/53-pdf.js:57 `MDZ.a85decode(ascii(cur, cur.length).replace(/^[\s\S]*?<~?/, '').replace(/~>[\s\S]*$/, ''))`。实测：120 字节 payload 编成 ASCII85（首 '<' 在索引 2），嵌入 `/Type /EmbeddedFile /Filter /ASCII85Decode` 的 PDF → auditPDF 的 artifacts 为 0（decodeStream 失败后 isEmbedded 分支静默跳过）；同样 80 字节 'A' payload（无 '<'）正常解出 80 字节。
- 影响：PDF 里 ASCII85 编码的内嵌文件/图片/JS 流只要数据出现 '<'（较长流几乎必然），要么整段丢失，要么后续 FlateDecode 链失败，且没有任何失败提示。
- 修法：直接调用 `MDZ.a85decode(ascii(cur, cur.length))`（a85decode 已 trim 并剥 `^<~` / `~>$`）；若保留预处理，用 `/^\s*<~/` 而不是贪婪前缀匹配，不要删掉数据中的 '<'。

### C7 P1 `src/62-audio.js:203`

**音频 LSB 候选按前 4096 字节哈希去重：长静默前缀会让后面真正携带数据的 bit/声道被提前丢掉**

- 类型：data-loss ｜ 工作量：S（改哈希范围/调整顺序）
- 主张：add() 在打分之前用 `fnv1a(bytes.subarray(0, 4096))` 去重；WAV 开头有 >32768 个静音采样时，bit0/ch0 的全零流先占住哈希，bit1 或 ch1 的载荷流因为前 4096 字节同样全零而被 return，永远进不了 scoreStream。
- 证据：src/62-audio.js:203–208 `const h = MDZ.fnv1a(bytes.subarray(0, Math.min(4096, bytes.length))); if (seen.has(h)) return; ... if (s.score >= 30 && s.strong) results.push(...)`。实测：40000 采样静音后用 bit1 MSB 装 60000 字节可打印载荷，extractAudioBits 出的流 scoreStream=36 分/strong=true，但 scanAudioLSB(pcm) 返回 findings=[]、artifacts=0。同型「先取前缀哈希再比较」还在 src/60-scan.js:272 与 src/70-analyze.js:320/336（图像/帧去重）。
- 影响：音频里换一个 bit 或声道、图像里换一个帧去藏数据时，只要前缀是长静默/纯色，工具会静默漏掉本来已列入扫描的候选；用户以为扫过了全部组合。
- 修法：去重键改为 `fnv1a(完整 bytes)` 或 `fnv1a(首 4KB + 尾 4KB + length)`，并放到 scoreStream 之后只对入选结果去重；60-scan.js:272 与 imageSig 的首 8KB 前缀哈希同样改为全字节或首尾哈希。

### C8 P1 `src/70-analyze.js:468`

**已知格式解析失败时没有 generic 兜底：一个坏 BMP 头就把明文 flag 全部吞掉**  ✔ 已复核

- 类型：data-loss ｜ 工作量：S（加一次 fallback 调用）
- 主张：dispatch 只按检测到的 format 调一个 audit；当该 audit 因结构损坏提前返回（如 BMP 的 DIB 头大小非法），analyze 不会退到 auditGeneric（strings/编码链/零宽），文件里的明文内容一条都不报。
- 证据：src/70-analyze.js:466–473 `let audit = ...; try { audit = dispatch(item.bytes, item.name, type, o); } catch ...`，之后直接消费 audit.findings，没有 fallback。src/40-bmp.js:30–31 `else return { error: '未知 DIB 头大小 ' + dibSize }`，auditBMP 在 99–100 行把它变成单条「不是 BMP」。实测：fixtures/bmp_1bit_lsb.bmp 把 offset 14 的 DIB size 改成 20（BM 魔数仍合法）并在尾部追加 `flag{bmp_bad_dib}` → findings 只有 `format:不是 BMP`，flags=[]，artifacts=0；同样明文放在未知格式文件里会被 strings 命中。
- 影响：misc 里「头被改坏」是常见题型；格式魔数还在但结构字段被改时，工具只报「不是 X」，随后所有 strings/编码/零宽线索都看不到，直接漏 flag 并给出误导性结论（BMP 的 2 字节魔数 0x42 0x4D 还会把以 "BM" 开头的文本路由到这里）。
- 修法：dispatch 后若 audit 只有 format/error 类 finding（或 audit.info/audit.parsed 带 error），再跑 auditGeneric 并合并 findings/artifacts；BMP 的错误在 `audit.info.error` 而非 parsed，判断时要用对应字段。

### P2 P1 `src/70-analyze.js:320`

**图像去重只哈希每通道前 8192 个采样：同尺寸、上半相同的帧被静默跳过，不扫描也不进查看器**

- 类型：correctness ｜ 工作量：S
- 主张：`imageSig()` 只对每个通道 `Math.min(len, 8192)` 个采样做 fnv1a；两张同宽高、前 8192 个像素相同的图签名相同，`scanImageOnce()` 在 :336 直接 return —— 既不跑 scanImage/detectDrawn/频谱，也不 `result.images.push`，位平面查看器和双图对比都看不到它。
- 证据：复现：构造 4757 字节的 2 帧 APNG（300×300 全画布，两帧只在第 28 行以下不同），`M.analyze` 结果 `images=1, stats.scanned=1`，但两条 `apng_frame` 发现都写着「已加入递归队列，自动做位平面/LSB 扫描」。代码 70-analyze.js:318-322 `const n = Math.min(c[k].length, 8192); s += MDZ.fnv1a(c[k].subarray(0, n))…`；:336 `if (sig && scannedSigs.has(sig)) return;`。300 宽的图 8192 像素≈前 27 行，上静止下变化的 GIF/APNG 正好撞上。
- 影响：直接漏掉后续帧里的 LSB/位平面隐写，得出「没有发现」的错误结论——这是会产生错误结论的一类，且 GIF/APNG 多帧正是 misc 常考。
- 修法：签名改为对每通道全长做 fnv1a（O(n) 远小于后续扫描开销），或把帧序号/解码字节数/首尾采样一起纳入 sig；更省事的是 gif/apng 帧图不做跨帧去重，只对同一 image 对象的重复入队去重。

### P4 P1 `src/50-formats.js:284`

**GIF/APNG 逐帧全解码+全量扫描+全部驻留：100 帧 400×400 用 13 秒、314MB，且没有帧数上限**

- 类型：perf ｜ 工作量：M
- 主张：`auditGIF()` 对每一帧调 `gifFrameImage(f, g.gct, { full: true })`（还会多解 4096 行），返回的 `images` 全部进 `scanImageOnce`（scanImage + detectDrawn + 频谱 + 二维码/条码），帧图再全部保留在 `result.images` 和 `result.gif.frames[].image`。`parseGIF` 的 while 循环与 `parseAPNG` 的 for 循环都没有帧数上限，`maxFiles` 也只限制字节文件、不限制图像条目。
- 证据：实测 100 帧 400×400 GIF（21MB）：`analyze` 13035ms、RSS 314MB、images=100、scanned=100、artifacts=104。单帧 400×400 分项：detectDrawn 45ms、auditSpectrum 18ms、qrDecodeImageData 24ms、barDecodeRGBA 3ms、scanImage 35ms ≈ 125ms/帧。APNG 走同一条路（20-png.js:483-505 每帧 inflate 上限 64MB + unfilter + buildChannels，同样无帧数上限）。
- 影响：动图题一拖进来就冻结十几秒，内存按帧数线性上涨；几百帧或大画布（如 2000×2000 × 50 帧）直接 1GB+ 甚至 OOM。
- 修法：parseGIF/parseAPNG 与两个 audit 函数加帧数上限（如 60–100 帧，超出记 finding）；full:true 只在 LZW 实际行数 > 声明高度时启用；除首帧外跳过 detectDrawn/auditSpectrum/qrDecodeImageData（或按总像素预算抽样）；扫描后 delete image._masks。

### P5 P1 `src/20-png.js:266`

**PNG 声明尺寸炸弹：260KB 文件 → 1.07GB 峰值内存、2.1 秒**

- 类型：memory ｜ 工作量：M
- 主张：`decodePNG()` 在检查像素数之前就按 256MB 上限解压 IDAT；`inflateRaw` 扩容到上限后还在返回前 `out.slice(0, olen)` 复制一份（10-inflate.js:205）。同一 IDAT 在 `auditPNG`（:708）和 `decodePNG`（:266）各解一次，加上 depth 0 的 `recoverDims`（:384）实际解三次，峰值 ≈ 2–3 × 256MB。声明 20000×20000 的 PNG 只需要几百字节 IDAT。
- 证据：实测：IHDR 20000×20000 + deflate(256MB 零) 的 260,979 字节 PNG，`M.analyze` 2144ms、进程峰值 RSS 1072MB（heapUsed 仅 5MB，全是外部内存）。cap 见 10-inflate.js:154-166（`maxOut || 256MB`），`out.slice(0, olen)` 见 :205。正常 12000×8000 手机照片也会撞 288MB > 256MB 上限，同样走这条路径。
- 影响：打开一张尺寸被改/超大的 PNG 就把标签页内存打到 1GB 以上；低内存机器或手机直接崩溃。
- 修法：decodePNG 先用 IHDR 算 height*(rowBytes+1)，超过 maxScanPixels/硬上限（如 64M 像素）只做结构审计并返回 error；inflate 的 maxOut 用预期 raw 长度而非固定 256MB；inflateRaw 返回 `olen * 2 >= out.length ? out.subarray(0, olen) : out.slice(0, olen)`，避免大拷贝又不在常态下驻留双倍缓冲。

### C9 P2 `src/50-formats.js:738`

**ZIP deflate 条目解压出错但仍有部分输出时被当成成功，静默产出截断/错乱文件**

- 类型：data-loss ｜ 工作量：S（2 行 + 一条 finding）
- 主张：inflateRaw 在流被截断时会返回「部分 out + error」；unzipEntry 只看 out 是否非空就把 error 置 null，auditZIP 又把 method 8 的错误排除在报告之外，于是条目 artifact 是残缺内容且没有任何提示。
- 证据：src/50-formats.js:737–738 `const z = MDZ.inflateRaw(b, e.dataStart, 64 * 1024 * 1024); return { data: z.out && z.out.length ? z.out : null, error: z.out ? null : (z.error || 'deflate 解压失败') };`；802 行只对 `e.method !== 0 && e.method !== 8` 报告错误。实测：声明 usize=8800 的 deflate 条目把压缩流截到 60%，auditZIP 仍产出 `zip-payload.txt`（仅 32 字节），findings 只有「ZIP 条目…未加密」，没有截断/CRC 提示。
- 影响：坏 ZIP（CTF 常见的「修复压缩包」题）里被截断/改坏的条目会以看似正常的产物出现，用户会把残缺内容当真实内容，也可能因此错过「数据在别处」的判断。
- 修法：`error` 改成 `z.error || null`；auditZIP 对任何 entry 的 r.error（含 method 8）发 finding，并用 `e.usize` 与 `z.out.length` 对比报长度不符；空输出 + error 也要报（当前空 Uint8Array 为真值，连 error 都会被清掉）。

### C10 P2 `src/70-analyze.js:570`

**flag 汇总只读 finding 的截断字段：SVG 注释/ID3 文本/WAV INFO 里靠后的 flag 会丢**

- 类型：data-loss ｜ 工作量：S/M（每个载体加一个 artifact，或让 flags 扫源字节）
- 主张：flags() 从 f.preview/f.actual/f.detail/f.title 里找 flag，而这些字段在生成时已被 slice 到 120–1200 字符；没有 artifact 的文本载体（SVG 注释/text、ID3 文本帧、WAV INFO/iXML）尾巴上的 flag 因此永远进不了汇总。
- 证据：src/70-analyze.js:570 `const text = [f.preview, f.actual, f.detail, f.title].join('\n');`。src/50-formats.js:607 的 svg_comment finding `actual: c.slice(0, 200), preview: c.slice(0, 300)`；src/62-audio.js:649 id3_meta `preview: joined.slice(0, 1200)`。实测：`<svg><!--` + 400 个 'A' + `flag{svg_comment_late}` + `-->` → 只产出 svg_comment finding，flags=[]；padding≤100 时能命中。
- 影响：长注释/长元数据里把 flag 放在末尾（常见出题写法）时，工具明明已定位到该字段却不报 flag，用户会以为没有。
- 修法：让这些 finding 带完整文本 payload 或 artifact（SVG 全 text、ID3 文本帧、WAV INFO/iXML），或让 flags() 直接扫描原始文件字节；注意 flags() 对 artifact 只扫前 64KB，超长字段仍需 payload。

### C11 P2 `src/64-pcap.js:364`

**TCP 重组静默截断到 8MB：streams 视图不暴露 truncated，尾部数据直接消失**

- 类型：data-loss ｜ 工作量：S（透传字段 + 一条 finding）
- 主张：reassembleTCP 在累计 >= MAX_STREAM（8MB）时 break 并 subarray(0, 8MB)；结果对象虽然带 truncated 标记，但 auditPCAP 的 streamView 映射没有带上它，也没有 finding，用户无法知道流被截断。
- 证据：src/64-pcap.js:29–32 `const MAX_STREAM = 8 * 1024 * 1024;`；361 行 `if (bytes >= MAX_STREAM) break;`；364 行 `concat(chunks).subarray(0, MAX_STREAM)`；372 行 `truncated: bytes >= MAX_STREAM`；819–824 行 streamView 的字段列表没有 truncated，也没有对应 finding。
- 影响：单个 TCP 流 >8MB（大文件传输/日志回传）时，8MB 之后的 HTTP body/flag 不会进入任何 artifact；面板显示流字节数=8MB，看起来像完整流，容易误判。
- 修法：streamView 加 `truncated: s.truncated`，并在 auditPCAP 加一条 L1 finding（如「TCP 流截断到 8MB」）；对应 artifact 的 note 同步标注。

### P8 P2 `src/20-png.js:708`

**每个 PNG 解压 3 次、SHA-256 算 2 次、固定跑尺寸恢复：12MB 图 3.2 秒**

- 类型：perf ｜ 工作量：M
- 主张：同一个 IDAT 被完整 inflate 三次：`recoverDims()`（20-png.js:384，70-analyze.js:416 对 depth 0 的 PNG 无条件调用，哪怕 IHDR CRC 正常）、`auditPNG` 的 :708、`decodePNG` 的 :266（由 :845 调用）。根文件 SHA-256 在 70-analyze.js:287 与 :406 各算一次，而 `sha256()` 还会 `new Uint8Array(len+pad)` 把整份输入拷贝一次（00-util.js:156）。
- 证据：实测 2000×2000 PNG(11.4MB)：`analyze` 3254ms，其中 sha256 调用 2 次 371ms、inflateZlib 被调用 60 次合计 649ms、findStreamSignatures 243ms、scanImage 347ms、qrDecodeImageData 312ms、auditPNG 276ms、recoverDims 132ms（后两者内部又各 inflate 一次）。3000×3000(25.8MB) 虽因 9M 像素跳过扫描，仍要 2557ms。`recoverDims` 还固定做 2×20000 次 CRC 爆破（crcMatchesIHDR 每次分配 Uint8Array）。
- 影响：PNG 是最常见输入，每张都多付 3–5 倍整文件工作；100MB PNG 单次分析约 10 秒。
- 修法：auditPNG 只 inflate 一次并缓存 z.out/consumed，传给 decodePNG 与 recoverDims（加可选 raw 参数）；recoverDims 仅在 IHDR CRC 失败或 IDAT 长度与声明尺寸不符时调用；根 sha256 只算一次存入 result.sha256，sha256 改 64KB 分块喂入避免整份复制。

### P9 P2 `src/70-analyze.js:173`

**递归每一层都对整文件跑签名扫描并把所有命中攒成数组：100MB 输入 6 秒，其中扫描 2 秒**

- 类型：perf ｜ 工作量：M
- 主张：`analyzeStreams()` 每处理一个 item 就 `findStreamSignatures(bytes, 0, bytes.length)` 全文件扫一遍；`findStreamSignatures` 对几乎每个字节调 `isLzmaAlone` 并收集所有命中，`maxTries` 只限制后续解压次数、不限制收集；每个递归出来的子产物（LSB 产物、carve、解压流）都再扫一遍。
- 证据：实测 100MB 随机二进制：`findStreamSignatures` 1970ms、命中 16,027 条（数组建完只试前 64 条）；`analyze` 总 5956ms（sha256 2 次 3138ms、strings 573ms）。12MB PNG 上 60 次投机 `inflateZlib` 花 649ms。代码 70-analyze.js:173 为全文件扫描起点，:176 `maxTries = big ? 64 : 256`，:179 才 break。
- 影响：大文件/深递归时时间按「层数 × 文件大小」叠加，100MB 单文件光扫描 2 秒，批量成倍放大。
- 修法：findStreamSignatures 增加 maxHits（只保留前 N 个候选，或大文件分段扫描）；对 >8MB 文件只扫头尾窗口；投机 inflate 前先校验 BFINAL/BTYPE 与长度字段，减少假阳性。

### P10 P2 `src/62-audio.js:115`

**WAV 先把整个 data chunk 复制一遍再裁到 500 万帧：100MB 音频 6.3 秒 / 346MB**

- 类型：perf ｜ 工作量：S
- 主张：`decodeWAVPCM()` 先 `concatRanges(b, parsed.dataChunks)` 把所有 data chunk 拷成一个新数组，然后才 `cap = Math.min(frames, 5000000)` 只取前 5M 帧；100MB WAV 的 100MB 拷贝完全没必要。`pcm.raw`（最多 5M 帧 × 声道）还会经 `result.audio` 驻留（70-analyze.js:475）。
- 证据：实测 100MB 立体声 16-bit WAV：`analyze` 6283ms、RSS 346MB；`scanAudioLSB` 在 5M 帧上 560ms；UI 每次 activate 还会重算 waveform+spectrogram（26ms+59ms）。代码 62-audio.js:115-119 `const allData = concatRanges(b, parsed.dataChunks); … const cap = Math.min(frames, 5000000);`。
- 影响：大音频题每次分析多一次整文件拷贝、多几百 MB 峰值；批量音频线性叠加。
- 修法：先算 cap*blockAlign 的字节预算，再按 dataChunks 的逻辑偏移只拷贝覆盖这段的切片（跨 chunk 时逐段 subarray 拼接），不复制整个文件；pcm.raw 可改为 UI 激活时按需生成。

### A1 P2 `src/70-analyze.js:569`

**自定义 flag 格式下，纯文本命中不进 flag 汇总（导出报告也漏）**

- 类型：correctness ｜ 工作量：30 分钟
- 主张：flags() 用一份硬编码的 12 类 finding 白名单过滤自定义格式；'strings' 等正文类发现直接被丢弃，即使文本精确匹配用户模板。
- 证据：src/70-analyze.js:564 `CUSTOM_FLAG_TRUSTED = new Set(['lsb','text_chunk','meta_decode','chunk_name','crc_ascii','trailer','filename','palette_flag','zip_entry','second_stream','independent_idat','unused_data'])`；:569 `if (custom && !CUSTOM_FLAG_TRUSTED.has(f.type)) continue;`。实测：setFlagFormat('#{}#') 后 analyze(Buffer.from('the answer is #secret_1234# ok'),'note.txt') 只产出 type='strings' 的 finding，M.flagMatch 对该文本返回 '#secret_1234#'，但 M.flags(r) 返回 []；buildReport 的「疑似 flag」段调用同一个 flags()（:598）。全仓 finding type 共 139 种，白名单只覆盖 12 种。
- 影响：UI 支持并把自定义模板持久化到 localStorage，但最常见的纯文本路径会给出「0 个 flag」的错误汇总；页面 flag 框、批量 flag 计数、导出报告的 flag 段全部为空，只有 finding 卡片的 preview 里还能看到原文。
- 修法：drop 改成 <button>（或 role=button + tabindex=0 + Enter/Space 触发 input.click()），chip 改成 <button aria-pressed>，#status 加 role=status aria-live=polite。

### A3 P2 `build.py:1285`

**build.py 与 tests/run.js 各维护一份模块清单，无任何一致性门禁**

- 类型：build-integrity ｜ 工作量：30 分钟
- 主张：两份 23 模块清单当前一致，但构建和测试都不校验 src/*.js 与清单的集合关系；只改一处时两边都不会报错。
- 证据：build.py:1285-1286 手写 23 个文件名；tests/run.js:10-12 手写同一份清单。build.py 只检查占位符、</script、globalThis.MDZ（1293-1305），从不 glob src/；run.js 也不列目录。新增 16-foo.js 只进 build → 281 项测试从不加载它；只进 tests → 单文件产物缺模块而测试全绿。
- 影响：「漏改一处」不以任何形式报错，最终产物静默少一个能力（被 A4 的 feature-detect 进一步掩护），而 CI 绿、自检绿。这是工程里唯一必须两处同步的清单，恰恰没有机器校验。
- 修法：run.js 直接 fs.readdirSync(path.join(ROOT,'src')).filter(f => /^[0-9][0-9]-.*\.js$/.test(f) && f !== '80-ui.js').sort() 加载，清单只剩 build.py 一份；build.py 用 sorted(SRC.glob('[0-9][0-9]-*.js')) 去掉 80-ui.js 后与内联清单做集合 assert。比生成 modules.json 少一个文件。

### A5 P2 `src/70-analyze.js:350`

**像素上限四处不同且静默：4M 关二维码/条码、1.2M 关画字，而 UI 提供 20M**

- 类型：magic-number ｜ 工作量：1 小时
- 主张：UI 的像素上限只传给 LSB 扫描；QR/条码硬编码 4,000,000，画字检测 1,200,000，超限直接返回空且不产生任何 finding。
- 证据：src/70-analyze.js:350 `const smallEnough = image.width * image.height <= 4000000;`，为 false 时 rgba=null，QR/条码整段跳过；src/61-drawn.js:10 `MAX_PX = 1200000`、:60 `if (n > MAX_PX) return { findings, artifacts };`；src/14-qr.js:465 与 src/15-bar.js:260 又各有一份 `o.maxPixels || 4000000`；UI 选项为 1M/6M/20M（src/index.html:31-33、src/80-ui.js:320）。
- 影响：手机照片（>4MP）选「20M（大图）」时，LSB 会扫到 20M，但二维码、一维条码、画字检测全部静默关闭——用户会得出「图里没有二维码」的结论。对比 LSB 超限会发 scan_skip 说明（70-analyze.js:520-527），其余三处静默是不一致的。
- 修法：阈值可以保留（20MP 全图二值化会卡），但必须补 scan_skip 类 finding，写明“跳过 QR/条码（>4MP）”“跳过画字（>1.2MP）”；qrDecodeImageData/barDecodeRGBA 已有 opts.maxPixels 入口，再决定是否把 o.maxScanPixels 传进去与 UI 对齐。

### U1 P2 `src/80-ui.js:341`

**大文件/深度扫描在 UI 线程同步跑，无进度、无取消**

- 类型：performance ｜ 工作量：M
- 主张：runAnalysis 在 setTimeout 回调里同步调用 M.analyze，深度扫描或 20M 像素选项下整页会冻结到分析结束，状态只有一句「分析中…」，没有进度也没有取消入口。
- 证据：80-ui.js:341 `const r = M.analyze(state.bytes, state.file ? state.file.name : 'input', { deep, maxScanPixels });` 完全同步；70-analyze.js:281 的 analyze() 全程同步，60-scan.js:247 的 scanImage 同步遍历 deep 候选。实测 Node 下 6M 像素单图 deep=true 的 scanImage 需 3579ms（deep=false 545ms），浏览器只会更慢；index.html:33 还允许 20M 像素。分析期间 state.busy=true 会禁用 #analyze（80-ui.js:327），但没有任何 abort 路径；80-ui.js:220 注释声称「取消还在跑的旧分析」，可是同步 analyze 期间连 drop 事件都进不来。
- 影响：用户点开始分析后页面无响应，只能等或强杀标签页；大图/深扫/多图递归时每次都是盲等，无法中止。
- 修法：给 scanImage/scanImageOnce 加取消令牌与阶段回调（每个候选检查一次），在 UI 侧把候选循环改成分片 await 让出主线程；彻底方案是把 M.analyze 放进 Worker。只加“停止”按钮而不设中断点无用。

### A1 P2 `src/index.html:19`

**文件入口与层级筛选只支持鼠标，键盘用户无法开始分析**

- 类型：accessibility ｜ 工作量：S
- 主张：拖放区是不可聚焦的 <div>，真正的 <input type=file> 是 hidden，层级筛选是 <span>；全文件没有 tabindex/keydown，键盘用户无法载入文件或切换 L1-L4。
- 证据：index.html:19-24 `<div class="drop" id="drop">` 与 `<input type="file" id="file" hidden multiple>`；80-ui.js:194 只有 `drop.addEventListener('click', () => input.click());`。index.html:66-70 是 `<span class="chip" data-layer=...>`，80-ui.js:1826 只绑 click。grep 全项目仅 index.html:12 一处 aria-label，没有 tabindex/keydown；#status 也没有 role=status/aria-live。
- 影响：完全键盘操作的用户连一个文件都加载不了，工具不可用；层级筛选无法用键盘操作，分析和错误完成状态也不会被读屏播报。
- 修法：drop 改成 <button>（或 role=button + tabindex=0 + Enter/Space 触发 input.click()），chip 改成 <button aria-pressed>，#status 加 role=status aria-live=polite。

### C12 P3 `src/55-archives.js:137`

**RAR4 LHD_LARGE 头把高 32 位尺寸当文件名读：名字错位、packSize 变垃圾值，stored 成员提不出来**

- 类型：wrong-result ｜ 工作量：S（2 行偏移）
- 主张：flags & 0x100 时 HIGH_PACK_SIZE/HIGH_UNP_SIZE 在 name 之前（p+25/p+29，name 在 p+33），代码固定 `nameStart = p + 25`，又把高 32 位从 `nameStart + nameLen` 读，导致名字含 8 字节二进制、realPack 巨大。
- 证据：src/55-archives.js:137 `const nameStart = p + 25;`；146–152 行 `const hp = nameStart + nameLen; realPack = le32(b, hp) * 4294967296 + packSize;`。实测：构造 flags=0x0100、name='payload.txt'、stored 的 RAR4 → parsed.entries[0].name = "........pay"、packSize = 7233184986180878000、artifacts=[]（stored 数据没被取出）。
- 影响：带 LHD_LARGE 的 RAR4（成员 >4GB，或打包器写了该标志）文件名和尺寸全错，未压缩成员无法提取；普通小 RAR 不受影响，触发概率低。
- 修法：`const large = !!(flags & 0x100); const nameStart = p + (large ? 33 : 25);`，large 时从 p+25/p+29 读高 32 位：`realPack = le32(b, p + 25) * 4294967296 + packSize;`；顺手删掉 150-151 行重复且被覆盖的 dataStart 赋值。

### P12 P3 `src/80-ui.js:2291`

**节点编辑器每次数字键输入都全图重算；调色板节点在 4MP 图上建 400 万项 Map（1 秒）**

- 类型：perf ｜ 工作量：M
- 主张：number 输入框的 `input` 事件直接调 `nodeEval()`，而 `nodeEval` 每次从 source 开始重跑整张图（`evalNodeGraph` 的 memo 只在单次调用内有效），再对每个 output 做 `renderImage` + `pvShowImage`；节点上传没有尺寸上限。`opPalette` 对没有 palette 的图按像素建 `Map`（颜色→次数），4MP 噪声图 ≈ 400 万项。
- 证据：4MP 图（2000×2000）实测：gray 34ms、threshold 69ms、posterize 118ms、plane 35ms → 5 节点链每次输入约 160ms；palette 1004ms。代码 80-ui.js:2291-2298 `world.addEventListener('input', … nodeEval())`、:2082 `nodeEval()`、:2184-2186 载入时 `getImageData` 再复制 4 个通道；78-nodes.js:196 `const freq = new Map()`。
- 影响：节点视图里改参数一格卡一下；palette 节点直接卡 1 秒且内存暴涨，载入噪点大图有 OOM 风险。
- 修法：number 输入改 change 或加 150–300ms debounce；opPalette 用 4096 桶直方图（或每 N 像素抽样 + 唯一色上限）代替全量 Map；节点求值只重算受影响下游，或搬进 Worker。

### A7 P3 `src/00-util.js:8`

**VERSION 在 00-util 与 index.html 各写一份，运行时覆盖让漂移不可见**

- 类型：duplication ｜ 工作量：20 分钟
- 主张：版本号有两份硬编码，UI 启动时用 00-util 的值覆盖 index.html 的静态值；build 与 cdp-smoke 都只认 00-util，改一处不会被任何检查发现。
- 证据：src/00-util.js:8 `const VERSION = '0.15.0';`；src/index.html:16 `<span class="ver" id="ver">v0.15.0</span>`；src/80-ui.js:2394 `$('#ver').textContent = 'v' + (M.VERSION || '0.1.0')`；build.py 没有 VERSION 占位符或一致性检查；tests/cdp-smoke.js:456 只从 src/00-util.js 正则读版本。README.md:1/282 还有另外两份。
- 影响：按发布流程只改 00-util 后，index.html/README 的静态版本停在旧值；因为运行时覆盖，界面看起来是对的，冒烟也绿，直到有人看源码或 JS 启动失败（#ver 显示旧版本）。
- 修法：index.html 版本写 /*__VERSION__*/，build.py 用 re.search(r"const VERSION = '([^']+)'", read('00-util.js')) 替换并 assert；README:1 的版本行同步生成（:282 属历史 release notes，保留）。

### A10 P3 `src/30-jpeg.js:93`

**死导出/死函数十余个，另有两个同名导出互相覆盖**

- 类型：dead-code ｜ 工作量：30 分钟
- 主张：多个导出从无调用者，sofInfo 整个函数体从未执行，MDZ.fft 被两个模块各导出一次（后者覆盖前者），extMap 里还有重复键。
- 证据：getFlagFormat（src/00-util.js:567/576）、SCAN_SETS（src/60-scan.js:345）、isSVG（src/50-formats.js:566/817）、isPDF（src/53-pdf.js:11/294）、isTAR/isRAR/is7Z（src/55-archives.js:42/113/254/364）、jpegSofInfo→sofInfo（src/30-jpeg.js:93/719，全仓无调用）、parseIFD 别名（src/30-jpeg.js:718）、bytesOf（src/12-encode.js:10）、wr16（src/20-png.js:19）；fft 同时导出在 src/62-audio.js:871 与 src/66-spectrum.js:177（66 后加载覆盖 62，外部无调用）；src/00-util.js:303/306 extMap 中 rar 与 '7z' 各写两次。
- 影响：公开命名空间混入 10+ 个死名字，grep「这函数谁用」时给出假信号；两个 fft 导出意味着删除 66-spectrum 会无提示换实现；重复对象键让后写的静默覆盖先写的，改第一个键不生效。
- 修法：删死导出/死函数（getFlagFormat、SCAN_SETS、jpegSofInfo、bytesOf、wr16、62-audio 的 fft 导出），extMap 去重，50-formats.js:226 死分支顺带删。isSVG/isPDF/isTAR/isRAR/is7Z/parseIFD 若想留作公开 API，加一条测试引用，否则一并删。

### A11 P3 `src/70-analyze.js:127`

**同一种格式的知识散在 7 张表/开关里，新增或改名要改 4–7 处且漏一处不报错**

- 类型：architecture ｜ 工作量：3 小时
- 主张：魔数、流签名、LSB 打分、容器判定、产物扩展名、dispatch、HTTP 扩展名各自维护一份格式清单，没有单一注册表。
- 证据：src/00-util.js:191 MAGICS；src/10-inflate.js:301 findStreamSignatures 的 if 链；src/60-scan.js:23 MAGICS；src/70-analyze.js:11 looksLikeContainer、:104 EXT、:127 dispatch switch；src/64-pcap.js:454 HTTP_EXT。
- 影响：新增一种容器要同步 4–7 处；漏 looksLikeContainer → LSB 解出的该格式只当产物保存、不再递归（用户以为没有下一层）；漏 EXT → 产物名变 .bin；漏 scan MAGICS → LSB 打分偏低被 top12 截掉。全部静默。
- 修法：全量注册表是 3 小时重构，收益偏可维护性；先加一致性测试最省：断言 00-util MAGICS 的每个 format 在 70-analyze 的 EXT 与 dispatch 都有对应项、60-scan MAGICS 的 sig 都能被 detectType 识别。真要合并，先并 EXT/HTTP_EXT 两张纯扩展名表。

### A12 P3 `src/76-changelog.js:46`

**版本说明页写「递归 64 层」，实际 maxDepth=3（64 是文件数上限）**  ✔ 已复核

- 类型：documentation ｜ 工作量：5 分钟
- 主张：应用内能力表把两个上限写串了：maxDepth 默认 3，maxFiles 默认 64；用户读到的却是「递归 64 层」。
- 证据：src/76-changelog.js:46 `'批量 50 个文件、递归 64 层、深度扫描'`；src/70-analyze.js:282 `Object.assign({ maxDepth: 3, deep: false, maxFiles: 64, ... })`；README.md:99/171 写的是「深度 ≤3」。
- 影响：用户按 64 层预期理解结果，第 4 层之后的产物被丢时只看到一条 limit finding，容易误判「深层没有东西」；能力页与 README 自相矛盾也削弱可信度。
- 修法：改成“批量 50 个文件、递归 3 层（最多 64 个文件）”；5 分钟。想防再犯就从 analyze 的默认参数插值生成这行。

### U6 P3 `src/80-ui.js:451`

**批量失败原因只放在 disabled 按钮的 title 里，用户看不到**

- 类型：ux ｜ 工作量：S
- 主张：批量行只显示「失败」，具体错误 it.error 仅写入 disabled 按钮的 title 属性，触摸、键盘和截图场景都拿不到这个提示。
- 证据：80-ui.js:451 `<button class="batch-row..." ${r ? '' : 'disabled'} title="${esc(it.error || it.name)}">`；458 的 `bst` 只渲染 `失败`；runBatchAnalysis 的 catch（80-ui.js:418-420）也只写 it.error，不调用 setStatus。
- 影响：50 个文件里某个读取/解析失败时，用户只知道「失败」，不知道是权限、截断还是格式问题，只能重新单文件拖一遍。
- 修法：失败行内联显示 it.error（或加可聚焦的“详情”按钮），并在第一个失败出现时 setStatus 写明原因；最终状态行可附失败文件列表。

### U8 P3 `src/80-ui.js:1214`

**复制按钮无条件报「已复制」，下载失败也没有提示**

- 类型：feedback ｜ 工作量：S
- 主张：copyText 没有返回值，两条复制路径都失败时调用处仍然把按钮改成「已复制」；dl/dlCanvas 失败时也静默无反馈。
- 证据：80-ui.js:1110-1120 copyText 里 `try { await navigator.clipboard.writeText(text); return; } catch (_) {...}` 和 `try { document.execCommand('copy'); } catch (_) {}` 都不汇报结果；80-ui.js:1214 `await copyText(x.cmd); b.textContent = '已复制';` 无条件执行。80-ui.js:76-88 的 dl/dlCanvas 没有失败回调或状态提示。
- 影响：用户以为手动命令已进剪贴板，粘出来是旧内容；报告/载荷下载被浏览器拦截时也毫无提示。
- 修法：copyText 返回 boolean，只有成功才把按钮改成“已复制”，失败写 #status；dl/dlCanvas 至少 try/catch 并在异常时提示（浏览器静默拦截下载无法完全检测，可接受）。

### T3 P3 `tests/cdp-smoke.js:455`

**版本号、数量阈值与模块清单在多处写死，是下次改动的隐形地雷**

- 类型：maintainability ｜ 工作量：S
- 主张：版本、能力数量、状态文案断言和模块清单分散在源码与测试里，且存在两套模块清单；正常重构（删旧 changelog、格式化 VERSION、改文案、加模块）会误伤测试或让测试悄悄漏跑。
- 证据：index.html:16 静态写 `v0.15.0`（build.py 不替换，只有 80-ui.js:2394 运行时覆盖）；cdp-smoke.js:455 `extra.about.cards < 10`、`caps < 3`；456 用 `/const VERSION = '([^']+)'/` 依赖 00-util.js 的确切空格；run.js:287 `M.CAPABILITIES.length >= 3`；cdp-smoke.js:106/140/195/205 断言「批量完成：2 个文件」「已忽略 1 个」等 UI 文案。模块清单两处：run.js:10 与 build.py:1285-1286，新增模块只改一处会让 Node 测试或单文件产物静默缺模块。
- 影响：一次无意义的文案/格式调整就红；反过来，模块清单漂移时测试仍绿而产品缺功能。
- 修法：让 build.py 生成 src/modules.json，run.js 与单文件构建读同一清单；版本断言改用页面里的 M.VERSION；About 用结构断言（.vercard >= 1）替代魔法下限；状态文案断言改为行数/回调判断。

## 部分成立（17 条）

现象存在，但描述、严重度或修法被复核修正（例如严重度下调）。

### P1 P1 `src/00-util.js:103`

**strings()/utf16strings()/ascii() 逐字节拼串：100MB 文本吃 2.9GB 堆、8.8 秒，主线程全程锁死**

- 类型：memory ｜ 工作量：S
- 主张：三个字符串构造器都用 `cur += String.fromCharCode(c)` / `s += String.fromCharCode(c)` 逐字节拼；V8 下每次 += 生成一个 cons-string 节点，结果字符串被数组持有时整条中间链都活着。调用方对输入长度没有任何上限，大文本/大字体/大 SQLite 直接把标签页堆打爆。
- 证据：实测（Node v24，合成 100MB 可打印文本，每 80 字节一个换行）：`M.strings(text,6)` 2025ms / heap 2758MB / RSS 3145MB（返回 1.31M 项）；同一输入 `M.analyze` 8826ms / heap 2936MB / RSS 3237MB；20MB 文本已经 1684ms / heap 550MB；`M.ascii(100MB)` 4975ms。代码 00-util.js:103 `if (c >= 32 && c < 127) cur += String.fromCharCode(c);`（ascii 在 :40、utf16strings 在 :120 同样写法）。无截断调用点：70-analyze.js:76 `MDZ.strings(bytes, 6).concat(MDZ.utf16strings(bytes, 6))`（TEXT 与 unknown 格式都走这里）、62-audio.js:683 对整个 MP3 数据区、50-formats.js:396/490 对整个字体/SQLite；ascii 的无界调用 20-png.js:314 `ascii(r.out, r.out.length)`，而 zTXt 的 inflate 默认上限是 256MB。
- 影响：拖入 50–100MB 的日志/文本/大字体时页面冻结 5–10 秒并占用 1–3GB；实测 100MB 已是 3.2GB RSS，再大或内存偏紧的机器直接 OOM 崩溃。这正是「100MB 级输入会不会 OOM」的答案：会。
- 修法：给 strings/utf16strings 加扫描长度上限（如 4MB）与返回条数上限，调用方只传 preview 窗口；拼串改 8–32KB 分块 `String.fromCharCode.apply(null, sub)`，或 `TextDecoder('latin1')` 后按可打印区间切分；20-png.js:314 的 `ascii(r.out, r.out.length)` 改成固定 4–16KB 上限。
- 复核修正：代码属实：00-util.js:103 `if (c >= 32 && c < 127) cur += String.fromCharCode(c);`，70-analyze.js:76 对整文件调用 `MDZ.strings(bytes, 6)`，80-ui.js 没有任何文件大小门禁。本机复测 20MB 文本：strings 后 heap +547MB、RSS 710MB（与报告的 550MB 吻合），机制成立。但需 50–100MB 级输入才致命，属页签卡死/崩溃而非数据或安全问题，P0 定级过高，改 P1。

### C5 P2 `src/53-pdf.js:183`

**PDF 增量更新按 obj 号去重时保留第一份旧对象，与自身提示「取最后一份」相反**

- 类型：wrong-result ｜ 工作量：S（两遍扫或 Map 记录 last offset）
- 主张：`if (seen.has(objNum)) continue;` 让同一对象号的后续定义全部跳过；而 PDF 增量更新的语义是后者覆盖前者，代码在 172 行却提示「按 obj 号取最后一份」。
- 证据：src/53-pdf.js:183–184 `if (seen.has(objNum)) continue; seen.add(objNum);`；172 行 detail 写着「后一段覆盖前一段 ... 按 obj 号取最后一份」。实测：两段 `1 0 obj` 各含 /EmbeddedFile，第一段 OLDDATA!、第二段 NEWDATA! → auditPDF 只产出 `pdf-embedded-1.bin=OLDDATA!`，NEWDATA! 完全没解析。
- 影响：带增量更新的 PDF（题目里删改过、内嵌文件/JS 被更新覆盖）会展示旧内容，用户可能据此得出错误结论；新版对象里的 flag 直接看不到。
- 修法：第一遍收集每个 objNum 的所有出现位置，按出现顺序解析全部版本并分别命名产物（如 pdf-embedded-1-v1.bin / v2.bin）；至少同时保留旧版与新版，并把 172 行提示改成「解析全部版本：前段为历史，后段为当前」。
- 复核修正：src/53-pdf.js:183-184 是 `if (seen.has(objNum)) continue; seen.add(objNum);`，只解析第一份；172 行 detail 却写「按 obj 号取最后一份」。两段 1 0 obj 实测只产出 OLDDATA!，NEWDATA! 未解析。但该工具自称翻旧对象/被删除内容，只取最后会丢掉旧版本，原修法不完整。

### C6 P2 `src/70-analyze.js:88`

**编码侦探把 >65536 字符的候选整条排除：超长 base64 仍然全丢**

- 类型：data-loss ｜ 工作量：S（1 行过滤 + 截断）
- 主张：`strs.filter(s => s.length >= 16 && s.length <= 65536)` 对上界是「排除」而不是「截断」；一段 70KB 的 base64（约 52KB 二进制）不会进入 decodeChain/decodeOnce，v0.15 声称放宽到 65536 实际只覆盖到 48KB 二进制。
- 证据：src/70-analyze.js:88 `const cand = strs.filter(s => s.length >= 16 && s.length <= 65536).slice(0, 24);`；112–113 行只对 cand 跑 `MDZ.decodeOnce(s, { binaries: true })`。实测同一 PNG 的 base64：40000 字符 → 产出 `decoded-base64-1.png`；70000 字符 → 0 产物、0 encoding_binary finding；200000 字符同样 0。
- 影响：文本里嵌入的大文件（整段 base64 贴图、超长 hex）超过 64KB 后完全不可见，且没有「已跳过」提示；这正是该版本想修的漏解类型。
- 修法：过滤改为 `s.length >= 16`，解码前 `const t = s.slice(0, 65536)`；对超长候选加一条「候选串超 64K，已截断」finding，保留 24 条候选上限但要可见。
- 复核修正：src/70-analyze.js:88：`strs.filter(s => s.length >= 16 && s.length <= 65536).slice(0, 24);`。实测 40,000 字符 base64 产出 decoded-base64-1.png，70,000 字符 0 产物；超限静默排除属实。但 65536 是字符上限、48KB 二进制是正确换算，changelog 也写「放宽到 64K」，把它描述成 v0.15 的虚假声明偏重，P1 也偏高。

### P3 P2 `src/60-scan.js:211`

**深度扫描 1000×1000 要 11.6 秒，接近 1.5M 像素裁剪阈值时更久，全程同步锁死主线程**

- 类型：perf ｜ 工作量：M
- 主张：`deepCandidates()` 在 ≤1.5M 像素时生成 28 组通道 × 8 bit × 2 顺序 × 2 打包 × 3 子集 + 140 个多位组合 ≈ 2828 个候选；`scanImage()` 对每个候选都调用 `extract()` 把整幅图逐像素扫一遍并分配 n×通道数/8 字节缓冲。没有分片、没有 yield、没有 Worker，UI 只能干等（analyze 在 setTimeout 里同步跑完）。
- 证据：实测：256×256(65k px) 847ms；512×512(262k px) 2632ms；1000×1000(1M px) 11599ms（scanImage deep=true，随机噪声图，不含其它步骤）。裁剪条件是 60-scan.js:257 `if (px > 1500000)`，所以 1200×1200(1.44M px) 会跑满 2828 个候选，按像素线性外推 >15s。深度扫描复选框在 index.html:28，是浅扫无结果后的自然下一步。另外两处放大：`results` 数组会先攒住每个强命中候选的 bytes 再排序取 top（:276-285）；`subset` 的 mask 缓存在 image 上（:61-73）。
- 影响：勾一次深度扫描页面冻结 10–20 秒，改参数只能重来；批量时 deep 会逐文件重复，50 张 1MP 图约 10 分钟。
- 修法：按像素预算裁剪候选（如 px×候选数 ≤ 2e9）；候选循环每 N 个让出主线程（scanImage 改 async，或在 analyze 循环里 `await new Promise(r => setTimeout(r, 0))`）；results 只保留分数 top，其余候选 bytes 排序后即丢弃。
- 复核修正：60-scan.js:211 deepCandidates 生成 28×8×2×2×3+140=2828 个候选；:257 `if (px > 1500000) {` 才裁剪，:276 只把强命中塞进 results。但 8-bit 图有 6 个 *hi 通道集在 `if (!keys.every(k => chans[k])) continue;` 处被跳过，实际扫 2252 个；本机 512×512 深扫实测 6243ms，问题真实。深扫是用户显式勾选且标注“慢”，修法又需把同步 analyze 改异步，P1 偏高，改 P2。

### P6 P2 `src/70-analyze.js:269`

**压缩流扇出没有全局预算：522KB 文件解出 64 段 × 8MB，RSS 1.5GB、10.4 秒**

- 类型：memory ｜ 工作量：S
- 主张：`analyzeStreams()` 对每个命中的 zlib/gzip 流都解压，并把结果同时存两份：`payload: { bytes: z.out.slice(0) }`（整份拷贝）和 `artifact(..., z.out)`（原数组），全部挂在 `result.artifacts` 上直到会话结束。只有单流上限（<1MB 文件 64MB、大文件 8MB）和尝试次数（<1MB 256、大文件 64），没有总输出/总保留预算。
- 证据：实测：522,432 字节文件（64 段相同 zlib，每段 8KB 解出 8MB 'A'）→ `analyze` 10414ms、artifacts=64、产物合计 512MB、RSS 1502MB；8 段版本仅 65KB 文件 → RSS 628MB。代码：70-analyze.js:174-176 `const maxOut = big ? 8MB : 64MB; const maxTries = big ? 64 : 256;`，:269 `bytes: z.out.slice(0)`，:272 `artifact(..., z.out)`。
- 影响：几百 KB 的「多流拼接」题就能把内存打到 1–2GB；在批量里叠加更会直接打死标签页。
- 修法：设全局产物字节预算（如 64MB）：每解一条流先扣 z.out.length，超预算只记 finding、不保留 bytes、不入队；payload 去掉 `z.out.slice(0)`，与 artifact/queue 共用同一 Uint8Array；maxTries 同时受剩余预算约束。
- 复核修正：70-analyze.js:175-176 `const maxOut = big ? 8 * 1024 * 1024 : 64 * 1024 * 1024; const maxTries = big ? 64 : 256;` 单流有上限，但 :269 `payload: { ..., bytes: z.out.slice(0) }` 与 :272 `result.artifacts.push(artifact(..., z.out, ...))` 各持一份且全程不释放，没有汇总预算。522KB→64 段确能打出 1.5GB；但需刻意构造多流，单流已被 cap 限制，P1 偏高，改 P2。

### P7 P2 `src/80-ui.js:402`

**批量 50 个文件：原文件、全部结果、位平面 mask 都不释放，50×4MP 约 1.8GB**

- 类型：memory ｜ 工作量：M
- 主张：批量把每个文件读成 `it.bytes` 后一直保留（分析完不置空），`it.result` 里又保留解码后的 channels、`result.images`、artifacts，以及 60-scan.js:61-73 缓存在 image 上的 `_masks`（nearWhite/nonWhite 各 1 字节/像素）。`MAX_BATCH=50` 没有总字节上限。
- 证据：实测：12 × 1MP PNG 结果驻留 +105MB（8.7MB/结果）；3 × 4MP PNG（2000×2000，11.4MB/个）结果 +74MB（24.5MB/结果，其中 8MB 是两张 mask）。50 个 4MP ≈ 1.2GB 结果 + 570MB 原文件 ≈ 1.8GB。代码 80-ui.js:402 `it.bytes = new Uint8Array(buf);`、:415 `it.result = M.analyze(...)`，之后没有任何 `it.bytes = null`。README:164 已承认「所有结果都留在内存里」，但实现里没有释放或预算。
- 影响：批量照片/截图时内存持续上涨（实测每张 4MP 图 24MB 起），50 张大图可达 2GB，切行还要再渲染。
- 修法：分析完把 it.bytes 置空（activate 时按需从 it.file 重读，或只保留当前激活项的 bytes）；扫描结束清理 image._masks/_chans；批量加总字节预算（如 256MB），超出时提示并只保留 findings/summary。
- 复核修正：80-ui.js:402 `it.bytes = new Uint8Array(buf);`、:415 `it.result = M.analyze(it.bytes, ...)` 之后没有任何 `it.bytes = null`；60-scan.js:61-73 的 `image._masks[subset] = mask;` 也从不删除。50×4MP 的估算成立；但 README:164 已明示“所有结果都留在内存里”，且要一次批量 50 张大图才致命，P1 偏高，改 P2。

### P11 P2 `src/80-ui.js:588`

**JPEG 结果每渲染一次就重跑熵解码+尺寸反推：14MB 图每次 0.8 秒，重复量是分析本身的 2 倍**

- 类型：perf ｜ 工作量：S
- 主张：`renderJPEGRepair()` 在每次 `render()` 里都重新 `parseSegments` + `analyzeJPEGEntropy` + `recoverJPEGDims`，不用分析阶段已经算过的结果；`render()` 在每次批量行点击、flag 格式变更时都会整页重跑。PNG 修复面板同样每次重算 `parseChunks`（pngChunkTable，:529）。
- 证据：实测 4000×3000(14MB) JPEG：`analyzeJPEGEntropy` 371–392ms、`recoverJPEGDims` 402ms，而 `analyze` 本身只要 433ms。路径：80-ui.js:494-506 `render()` → `renderRepair` → `renderJPEGRepair`（:588 `ent = M.analyzeJPEGEntropy(bytes); rec = M.recoverJPEGDims(bytes);`）。
- 影响：批量点开 JPEG 结果时每点一行卡 0.8 秒；同一份工作被反复做，用户感知就是界面卡。
- 修法：在 auditJPEG/auditPNG 阶段把 parseSegments/analyzeJPEGEntropy/recoverJPEGDims（及 parseChunks）结果存进 result.repair，render 只读缓存；批量切换只重绘 DOM，不重算。
- 复核修正：80-ui.js:588 `try { p = M.parseSegments(bytes); ent = M.analyzeJPEGEntropy(bytes); rec = M.recoverJPEGDims(bytes); }`，:647 `if (rep.format === 'JPEG') return renderJPEGRepair(state.bytes);`，每次 render（含批量行点击、flag 格式 change）都重跑。但 30-jpeg.js:655 只在 `b.length <= 8 * 1024 * 1024` 时做熵自检，14MB 样本的 0.8s 并非“分析本身的 2 倍”，而是完全未缓存的首算；PNG 面板还在 :561-562 每次 render 解析 chunks 两遍。

### A2 P2 `src/60-scan.js:40`

**flag 前缀清单在 7 处各写一份，FLAG_RE 是过期快照**

- 类型：duplication ｜ 工作量：1 小时
- 主张：00-util 的 FLAG_PREFIXES 是唯一可编辑处，但 60-scan 导出的 FLAG_RE 与 20-png/50-formats 的 5 段内联正则各复制了同一份前缀，永不跟随 setFlagFormat 或新增前缀更新。
- 证据：src/00-util.js:515 `FLAG_PREFIXES = ['flag','ctf','litctf','susctf','qctf','ctfshow']`；src/60-scan.js:40 `const FLAG_RE = /(flag|ctf|litctf|susctf|qctf|ctfshow)\{[ -~]{1,200}\}/i;` 经 :345 导出，被 src/62-audio.js:7、src/64-pcap.js:7 解构后用于真正的 flag 判定（62:638/679/820、64:682/708/731/747/766）；另 5 段内联复制：src/20-png.js:856/877、src/50-formats.js:362/454/467。
- 影响：在唯一看起来正确的位置（FLAG_PREFIXES）加 dasctf/nssctf，只有通用 flagMatch 生效；PLTE 调色板、TIFF 标签、WebP EXIF/XMP、全部音频与 PCAP 的 flag 发现仍按旧清单，静默漏报。用户设自定义模板时这些路径也完全不认——FLAG_RE.test('#secret#') 恒为 false。
- 修法：00-util 导出动态 flagRe()/flagFindAll，音频、PCAP、PLTE 的“是不是 flag”判定改用它；固定前缀正则只留给 60-scan/70-analyze 的像素打分并注明用途。TIFF/WebP 三处只是评分，直接改调 MDZ.flagMatch 即可。
- 复核修正：重复属实：60-scan.js:40 `const FLAG_RE = /(flag|ctf|litctf|susctf|qctf|ctfshow)\{[ -~]{1,200}\}/i;` 经 :345 导出，62-audio.js:638 `if (text && (FLAG_RE.test(text) || ...))`、64-pcap.js:682 `const flag = FLAG_RE.test(text);` 用它做真判定；70-analyze.js:190/256 的打分也用它。但影响被夸大：50-formats.js:362/454/467 的内联正则只影响 tiff_tags/webp_exif 的 confidence/标题，原文仍在 preview，默认格式下 flags() 照样能捞到；真正静默漏报的是 PLTE（20-png.js:856）与音频/PCAP。

### U2 P2 `src/80-ui.js:2397`

**批量模式下改选项/修复/改 flag 模板都不会同步批量面板，导出可能拿旧结果**

- 类型：state-sync ｜ 工作量：S
- 主张：批量结果只在 runBatchAnalysis/activate 时刷新；改「深度扫描/像素上限」只重算当前 state.bytes，修复副本会把 state.items 重置为 1 条却不清批量列表，改 flag 模板只重渲染结果而不重算批量 flag 计数。
- 证据：80-ui.js:2397 `const rerun = () => { if (state.bytes && state.items.some(x => x.result) && !state.busy) runAnalysis(); };` 在批量态下仍走单文件 runAnalysis；runAnalysis 在 80-ui.js:344 只在 `state.items.length === 1` 时写回结果，而 #report 在 80-ui.js:2430 仍按 `state.items.length > 1` 导出旧批量结果。analyzeBytes 在 80-ui.js:303 把 `state.items = [{...}]` 重置，但只有 loadFiles 会在 80-ui.js:238 清 `#batch`，analyzeBytes 不清。改 flag 模板的 handler 在 80-ui.js:2423 只 `render(state.result)`，不更新各 item 的 flagCount、不调 renderBatch。
- 影响：用户以为批量已经按新选项/修复结果重跑，实际列表、flag 数和导出的报告仍是上一轮数据；批量里点「修复并分析」还会把其他文件的会话结果直接丢掉。
- 修法：批量态（items.length>1）把 deep/maxpx 的 rerun 路由到 runBatchAnalysis()；analyzeBytes 里同步清空并隐藏 #batch，或弹确认；flag 模板变更后重算 state.items[i].flagCount 并 renderBatch()（导出本身已是最新，无需改报告逻辑）。
- 复核修正：2397 `const rerun = () => { ... runAnalysis(); }` 在批量态仍走单文件，344 只在 `state.items.length === 1` 时写回 items，2430 `M.buildBatchReport(done.map(x => x.result))` 仍用旧 items——这两点属实。但 70-analyze.js:733 `const fl = flags(r);` 在导出时按当前 FLAG_RE 现算（setFlagFormat 会重建全局正则），所以改 flag 模板后批量报告里的 flag 是新的，只有 451-458 的 per-item flagCount/批量头部是旧的；修复路径把 items 置 1 后导出走单文件分支，并非“旧批量数据”。

### A4 P3 `src/20-png.js:783`

**模块存在性靠 MDZ 上有没有函数来 feature-detect，缺失时静默降级**

- 类型：implicit-dependency ｜ 工作量：1 小时
- 主张：10 处 `MDZ.xxx ? MDZ.xxx(...) : null/fallback` 把「模块没加载」变成「能力悄悄没有」，与 A3 的清单漏改正好组成静默失败链。
- 证据：src/20-png.js:783 `const zl = MDZ.lzmaDecompressAlone ? MDZ.lzmaDecompressAlone(tail, {...}) : null;`（缺 13-lzma 时只报「有 LZMA 流」不解压）；同型：src/50-formats.js:226（concatBytes 的 else 分支，00-util 永远先加载，纯死代码）、src/61-drawn.js:238、src/66-spectrum.js:163、src/70-analyze.js:185/342/346/352/367、src/12-encode.js:180、src/20-png.js:546。
- 影响：模块清单漏一个时不会炸，只会少一段能力：PNG 的 LZMA 载荷不解、drawn/spectrum/QR/条码整块跳过、base64 元数据不提取。用户看到的是「工具说没有」，不是报错，测试也永远覆盖不到缺失路径。
- 修法：先按 A3 把模块清单收成一份，这条静默降级链就断了；顺手删 50-formats.js:226 的死 fallback。若还想兜底，所有模块加载完后一行 for (const k of ['lzmaDecompressAlone','detectDrawn','auditSpectrum','qrDecodeImageData','barDecodeRGBA']) if (typeof MDZ[k] !== 'function') throw new Error(k); 比 10 处三元更省。
- 复核修正：模式属实：20-png.js:783 `const zl = MDZ.lzmaDecompressAlone ? MDZ.lzmaDecompressAlone(tail, {...}) : null;`、70-analyze.js:342 `const drawn = MDZ.detectDrawn ? MDZ.detectDrawn(image) : { findings: [], artifacts: [] };`。但当前没有模块缺失的可达路径；50-formats.js:226 的 `MDZ.concatBytes ? ... : (() => {...})()` 确实是死分支（00-util 恒先加载），而 61/66 的 `MDZ.encodeBMP ?` 是可选的产物编码，不是“能力悄悄没有”。

### A8 P3 `src/30-jpeg.js:9`

**字节序/latin1/concat 基础函数在 8 个模块各复制一份，且已出现行为差异**

- 类型：duplication ｜ 工作量：2 小时
- 主张：le16/le32/be16/be32 被 7 个模块各自实现，latin1 有 4 种写法，concat 与 00-util.concatBytes 重复；副本间语义已不一致。
- 证据：src/30-jpeg.js:9-10、src/40-bmp.js:9-10、src/50-formats.js:9-10、src/52-carrier.js:9-10、src/55-archives.js:13-15、src/62-audio.js:9-12、src/64-pcap.js:9-12，加上 src/00-util.js:318-319 的 _le32/_be32。差异：只有 62/64 的 16 位读带 & 0xffff；latin1 见 src/62-audio.js:391（逐字符）、src/64-pcap.js:433（8KB apply）、src/55-archives.js:37、src/50-formats.js:570；concat 见 src/64-pcap.js:19 vs src/00-util.js:503。
- 影响：一次越界保护或符号修正要改 8 处，漏一处就是某个格式独有的错误读数（例如 >2GB 的 32 位长度）；latin1 的 8KB 版本在大载荷上快一个量级，但没人会想到只为 PCAP 修。
- 修法：把 le16/le32/be16/be32/concat 提到 00-util 导出、各模块解构引用（P3，可做可不做）；真要统一 latin1 只抽 62-audio.js:391 与 64-pcap.js:433 两份。& 0xffff 是防御性冗余，不必当 bug 修。
- 复核修正：副本属实：30-jpeg.js:9 `function be16(b, o) { return (b[o] << 8) | b[o + 1]; }`、62-audio.js:9 `function le16(b, o) { return (b[o] | (b[o + 1] << 8)) & 0xffff; }`，64-pcap.js:19 的 concat 与 00-util.js:503 一字不差。但 latin1 的 4 处证据错了两处：55-archives.js:37 是八进制解析 `s += String.fromCharCode(c);`，50-formats.js:570 是 isSVG 的 512 字节嗅探，不是 latin1 解码器；& 0xffff 对 Uint8Array 输入是恒等，未观测到读数差异。

### A9 P3 `src/14-qr.js:60`

**Otsu 在二维码与条码里各有一份，默认阈值已经差 1**

- 类型：duplication ｜ 工作量：20 分钟
- 主张：14-qr 的 binarize 内联了完整 Otsu（默认 thr=127），15-bar 的 otsu 是同一算法（默认 thr=128）；灰度公式也各写一遍。
- 证据：src/14-qr.js:60-84（`let sumB = 0, wB = 0, best = -1, thr = 127;` … `gray[i] = (src[i*4]*77 + src[i*4+1]*150 + src[i*4+2]*29) >> 8`）；src/15-bar.js:48-66（`best = -1, thr = 128`），:264 再写一次同样的 77/150/29 灰度。
- 影响：同一张深色/浅色边界图，QR 与条码可能得到不同二值化结果；以后调阈值只改一处，另一处继续按旧值跑，产生「二维码能读、条码不能读」的假象。
- 修法：抽 otsu(hist, n, defaultThr) + grayRGBA(data) 到 00-util 并统一默认常量（约 20 分钟）。不要承诺两边结果一致——整图 Otsu 与扫描线 Otsu 本来就不同。
- 复核修正：两份 Otsu 属实：14-qr.js:78 `let sumB = 0, wB = 0, best = -1, thr = 127;` 与 15-bar.js:50 `let wB = 0, sumB = 0, best = -1, thr = 128;`，灰度公式也各写一次（14-qr.js:66 / 15-bar.js:264）。但默认 thr 只在直方图退化（best 仍为 -1）时生效，且 QR 用整图直方图、条码用逐扫描线直方图，输入粒度不同。

### U3 P3 `src/80-ui.js:2430`

**批量导出忽略「报告模板」，选速报/WP 仍出完整报告**

- 类型：bug ｜ 工作量：S
- 主张：#report 的批量分支没有把模板传下去，buildBatchReport 也不接受模板参数，所以侧栏的「报告模板」对 2 个以上文件完全无效且无提示。
- 证据：80-ui.js:2428 `const tpl = ($('#report-tpl') || {}).value || 'full';` 只用于单文件分支；80-ui.js:2430 `const md = M.buildBatchReport(done.map(x => x.result));` 没传 tpl。70-analyze.js:719 `function buildBatchReport(results)` 只有一个参数，内部固定输出「# misc大手子 批量分析报告」。
- 影响：用户选「速报」或「WP 框架」后导出的仍是完整批量报告，交付物与 UI 选择不一致。
- 修法：让 buildBatchReport(results, opts) 接受 template 并在 brief/wp 下复用对应排版；更省事的做法是批量态隐藏或禁用 #report-tpl，避免假控件。
- 复核修正：80-ui.js:2428 `const tpl = ($('#report-tpl') || {}).value || 'full';` 只被单文件分支使用，2430 `const md = M.buildBatchReport(done.map(x => x.result));` 未传 tpl；70-analyze.js:719 `function buildBatchReport(results)` 只有一个参数——模板被忽略属实。但批量产物是独立的汇总格式（汇总表+文件详情），并不是 buildReport 的 full 报告，“仍出完整报告”的描述不准确。

### U4 P3 `src/70-analyze.js:367`

**一维条码解不出时 UI 完全无提示，HTTP 对象也不在 PCAP 面板里**

- 类型：ux ｜ 工作量：S
- 主张：条码解码失败和「这张图没扫条码」在界面上是同一个结果——什么也没有；PCAP 面板也不列出被切出的 HTTP 对象，只把他们埋在页面底部的产物区。
- 证据：70-analyze.js:367-380 只有 `for (const r of MDZ.barDecodeRGBA(rgba))` 命中时才 push finding/artifact，没有 else、没有「已扫描条码」状态；15-bar.js:288 `} catch (e) { return []; }` 把解码异常也吞成空数组。80-ui.js:851-889 的 renderPCAP 只列 TCP/UDP/DNS/HTTP 文本行，v0.15 的 http-got.png、http-up.txt 只出现在 80-ui.js:926-943 的产物卡片。About 页却宣称这两项能力（76-changelog.js:17、37）。
- 影响：用户拿倾斜/模糊的条码来试，看到空结果会判断「工具不支持条码」或以为文件没被扫描；HTTP 对象在长结果里容易被漏掉。
- 修法：在图片参与条码扫描但无命中时输出一条“条码：未命中（EAN/Code128/Code39）”，并对 >4M 像素跳过扫描给出提示；PCAP 面板可加“HTTP 对象 N 个”并链接到产物，这是增强而非必须。
- 复核修正：70-analyze.js:367-368 只有 `for (const r of MDZ.barDecodeRGBA(rgba)) { ... }`，没有 else；且 350-351 的 rgba 只在 `smallEnough`（≤4M 像素）时生成，大图连扫都不扫也无提示，条码静默成立。但 HTTP 对象不只躺在产物区：64-pcap.js:692 `findings.push(finding('L3', 'http_object', ...))` 会在主发现区生成卡片，“埋在页面底部产物区”不准确；renderPCAP 不列对象则属实。

### U7 P3 `src/80-ui.js:899`

**结果面板全量渲染发现与产物，长列表没有收起/分页/定位**

- 类型：ux ｜ 工作量：M
- 主张：render 一次性拼接所有 section，renderFindings/renderArtifacts 对每条都生成 DOM（含预览 <pre> 和缩略图 canvas），没有数量上限、折叠或目录，发现区还排在 PCAP 表之后。
- 证据：80-ui.js:501 `root.innerHTML = renderSummary(r) + ... + renderFindings(r) + renderArtifacts(r) + ...`；899 `const items = r.findings.map(...)`；928 `const cards = r.artifacts.map(...)`。实测 6MB/30213 包的 pcapng（run.js:341 同类样本）M.analyze 产出 119 条发现 + 128 个产物，浏览器会一次生成约 247 张卡片；筛选 chip 只在页面顶部且只作用于 .finding，不影响产物。
- 影响：真实文件下结果页极长，找不到重点；滚动后要回顶才能切筛选，产物多时更难定位。
- 修法：每个 section 初始只渲染前 N 条（如 30）+“显示全部”，发现/产物区加 <details> 折叠与计数；如需筛产物，把 applyFilter 扩展到产物卡片。筛选条无需 sticky 改造。
- 复核修正：80-ui.js:501 一次拼接 `renderFindings(r) + renderArtifacts(r)`，899 `r.findings.map(...)`、928 `r.artifacts.map(...)` 无 slice；我在本机跑花好月圆.pcapng 得到 findings=119、artifacts=128，确实会生成 247 张卡片，applyFilter（1820-1823）又只遍历 `.finding`。但“滚动后要回顶才能切筛选”不成立：#filters 在 index.html 的 .topbar 内，而滚动的是 .content（style.css:118 overflow:auto），topbar 作为 .main 的固定高度子项始终可见。

### T1 P3 `tests/cdp-smoke.js:72`

**测试可以在覆盖静默缩水的情况下全绿**

- 类型：test-coverage ｜ 工作量：S
- 主张：浏览器自检只断言失败数为 0，不校验通过数/fixture 数；真实样本用例在文件不存在时直接 SKIP，所以换机器或 fixture 丢失后套件仍然是绿的。
- 证据：cdp-smoke.js:70-73 `const st = ...match(/自检 — (\d+) 通过 \/ (\d+) 失败/)`，`if (!st || st[2] !== '0') throw new Error(...)` 只检查失败数，diagSelf.pass 仅记录不校验；run.js:293-299 遍历 meta.fixtures 也没有最小数量断言。run.js:324-334 真实样本用绝对路径 `Z:/laragon/ctf/challenges/...`，`if (!fs.existsSync(p)) { console.log('  SKIP', p); continue; }`；337-338 的 pcapng 同样跳过；cdp-smoke.js:462-488 的 CHALLENGE_DIR 块也是可选。
- 影响：全新 checkout 或 build 少注入若干 fixture 时，「281/281 + 96/96 全绿」可能只跑了很小一部分，真实赛题、条码/HTTP 样本实际未执行。
- 修法：断言 selftest pass 的固定下限与 fixtures.length 最小值；CI 模式下把真实样本 SKIP 计为 FAIL 或非 0 退出，并打印 SKIP 数量。
- 复核修正：cdp-smoke.js:71-72 只解析 `(\d+) 通过 / (\d+) 失败` 并断言 `st[2] !== '0'`，73 的 diagSelf.pass 仅记录；run.js:329 `if (!fs.existsSync(p)) { console.log('  SKIP', p); continue; }`，292-299 对 fixtures.json 也无数量下限——缺口属实。但“fixture 丢失后套件仍然是绿的”说过头：cdp-smoke 对 FIX/媒体/loadFixture 缺失是 throw（34/104/218/254），run.js 直接 fs.readFileSync 的 fixture 缺失会崩，只有 fixtures.json 条目和真实样本能静默缩水。

### T2 P3 `tests/cdp-smoke.js:269`

**cdp-smoke 不覆盖 v0.15 新能力的渲染层与多条关键 UI 路径**

- 类型：test-coverage ｜ 工作量：M
- 主张：cdp-smoke 的 DOM 断言从不加载 barcode_ean13.png、pcap_http_obj.pcap、b64_png.txt，也从不点击筛选、导出报告、改 flag 模板、折叠预览、清空节点、CRC 爆破和 companion UI；新能力的 finding/产物卡片在浏览器里从未被渲染断言。
- 证据：cdp-smoke.js:13-15 的 PAGE/FIX 只用 second_stream.png，103 用 deep_lsb.png；211-215 的 media 只有 wav/pcap/pcapng；269-342 的 loadFixture 列表是 bad_crc_height/gif_lzw/bmp/jpeg/deep_lsb/cut_png/mp3，全文无三个 v0.15 fixture。浏览器 selftest 虽会 M.analyze 它们（80-ui.js:1923-1934），但 selftest 从不调用 render（80-ui.js:1935-1940 反而隐藏 #result），所以 renderFindings/renderArtifacts/renderPCAP 的对应分支零执行。
- 影响：条码发现的「下载载荷」、http-got.png 产物卡片、decoded-base64 缩略图等 UI 回归可以全绿通过；筛选/报告/模板这些交互也无人拦。
- 修法：增加三个 upload 用例并断言 .finding 标题与产物名；对 filters/report/flagfmt/pv-toggle/node-clear/crc-brute 各做一次点击冒烟；保留 selftest 作为逻辑覆盖。
- 复核修正：cdp-smoke.js:211-215 的媒体只有 wav/pcap/pcapng，269-342 的 loadFixture 是 bad_crc/gif/bmp/jpeg/deep_lsb，全文 grep 无 barcode_ean13/pcap_http_obj/b64_png；页面 selftest 虽在 1926 `M.analyze(bytes, fx.name, ...)` 跑它们，但 1935-1939 只写 #selftest 并隐藏 #result，从不 render——新 fixture 的 DOM 无断言属实。但“renderFindings/renderArtifacts/renderPCAP 的对应分支零执行”需收敛：这些是通用渲染器，已被其他 fixture 覆盖，真正没测的是 v0.15 数据形态与下载/筛选/模板等交互。

## 被否掉（1 条）

- **U5** PCAP 六张表静默截断，没有「共 N 条」提示 —— 截断本身存在（854/865/871-874 的 slice），但并非“静默、无法知道”：80-ui.js:878 的 kv 已显示 `(p.streams||[]).length 条流 · (p.dns||[]).length DNS · (p.http||[]).length HTTP · (p.ttlAnomalies||[]).length TTL 异常` 总数，882 写 `UDP 载荷（Top 20）`，886 写 `会话（Top 12）`。六张表都能从表头或 kv 看出还有数据。

---

## 建议批次

**批一 · v0.15.1（都是几行改动，先把「会卡死」和「会漏 flag」堵上）**

| 条 | 为什么 |
|---|---|
| C1 C2 | 两个死循环：改坏一个字节就能把标签页锁死（C2 已实测复现） |
| C3 | >1MB 文件的后半段永远不扫签名，是「明明有 flag 却没报」的头号来源 |
| C4 | PDF ASCII85 一行正则写错，含 `<` 的流全丢 |
| C8 | 坏 BMP 头把明文 flag 全吞，且给出误导性结论 |
| C7 | 去重只看前缀，长静默前缀后面的载荷被跳过 |
| A3 A7 A12 | 三处一致性门禁：模块清单、版本号、文档里的 64 层 |

**批二 · 性能（需要动结构，风险更高）**

- P1 `strings/ascii` 换 TextDecoder（我实测 50MB：2319ms/1.6GB → 11ms/0MB）
- P5 PNG 尺寸炸弹、P4 GIF 无帧数上限、P6 流扇出无全局预算、P10 WAV 整块复制
- U1 主线程同步分析 → Web Worker（唯一能根治「卡死无进度」的路）

**批三 · 体验（可选）**

- U3 批量导出忽略报告模板、U6 批量失败原因不可见、U8 复制无条件报成功、T2 新能力的界面冒烟
