# 验收记录 — misc大手子 v0.10.0（2026-11-09，含 v0.2–v0.9.0 记录）

本文件是夜间自动开发的验收台账：做了什么、怎么验的、多 agent 抓出的问题与修复。

## 交付物

| 文件 | 说明 |
|---|---|
| `misc-dashouzi.html` | 单文件成品，双击即用；默认零网络，连接本机 companion 时才走回环 |
| `src/` | 按加载顺序拆分的源码（00 util → 80 UI） |
| `build.py` | 生成 fixture + 内联单文件 |
| `companion.py` | 可选本地工具桥（stdlib；仅回环 + token + 动作白名单） |
| `tests/run.js` | Node 回归（212 项；58 个 fixture） |
| `tests/cdp-smoke.js` | 浏览器流程冒烟（Edge CDP；自检/上传/缩放/批量/对比/零尺寸/上限/音频/pcap + v0.9 面板与节点连线） |
| `tests/test_companion.py` | companion 单元 + HTTP + 真实 exiftool（14 项） |
| `tests/companion-smoke.js` | 外部工具桥浏览器端到端（fake tools + Edge） |
| `demo/school-123.md` | 三道真实隐写题的演示报告 |
| `README.md` | 使用说明与能力边界 |

## 验证矩阵

| 验证 | 命令 | 结果 |
|---|---|---|
| Node 回归 | `node tests/run.js` | **156 通过 / 0 失败**（57 个 fixture） |
| 浏览器自检 | `misc-dashouzi.html?selftest=1` | **67 通过 / 0 失败** |
| 浏览器流程冒烟 | `node tests/cdp-smoke.js` | PASS（含批量/对比/缩放/零尺寸/上限/音频/pcap） |
| 音频/pcap 视图 | cdp-smoke 媒体段 | WAV 波形+频谱峰值 ~797Hz；PCAP 表格/HTTP/DNS/TTL；PCAPNG 旗标 |
| 真实题 UI 端到端 | `FIX=.../3/3.png EXPECT=flag{LSB_is_so_easy} node tests/cdp-smoke.js` | PASS（2.png / 3.png / 1.png 全过） |
| companion Python | `python -m unittest tests.test_companion -v` | **14 通过 / 0 失败**（含真实 exiftool、超时清理、CORS） |
| companion 浏览器 | `node tests/companion-smoke.js` | PASS：5 工具 / 9 动作 / 产物 / 非回环拒绝 |
| 本地语料 | 80 个挑战文件（含 ZIP），maxScanPixels=200k | 0 异常；平均 412ms |
| 单文件检查 | grep 外链/网络调用 | 外链仅 `127.0.0.1/localhost`；`fetch` 1 处且受回环白名单保护 |

## 多 agent 验收发现与修复

6 个只读代理并行验收：inflate 对拍、PNG 像素对拍（Pillow）、JPEG/EXIF 对拍（exiftool）、fuzz/性能、UI 接线（CDP 实测）、范围差距。

### inflate（`src/10-inflate.js`）

| 问题 | 处理 |
|---|---|
| 截断 stored block 时 `out[olen++] = br.bits(8)` 求值顺序导致多一个 0x00 幻影字节（1034 例中 178 例） | 改成先读后写；回归用例验证部分输出必为原文前缀 |
| gzip 不校验 CRC32/ISIZE；zlib adler 只记标志不入 error | 两者都并入 error；新增篡改用例 |
| FDICT 流被当成普通 zlib，从错误偏移解码 | 明确拒绝并返回 `FDICT 预设字典流暂不支持` |

### JPEG（`src/30-jpeg.js`）

| 问题 | 处理 |
|---|---|
| APPn 可疑字符串检测的 filter 恒为 false（死代码） | 修正谓词 |
| JFIF APP0 用 `ascii()` 比对 `JFIF\0`，永假 | 改逐字节比对 |
| EXIF ASCII 取值不受 count 约束，会吞后续标签 | 以 `valOff+n` 为上限 |
| 无 EOI 的截断 JPEG 零告警 | 新增结构 finding |
| 段前有填充 0xFF 时 offset 偏 1 | 记录填充前位置 |

### PNG（`src/20-png.js`）

| 问题 | 处理 |
|---|---|
| **blocker**：1/2/4-bit 图忽略逐行字节对齐，第二行起全错（真实 1-bit 题 4437/9128 样本错） | 逐行按 `ceil(width*bitDepth/8)` 推进；与 Pillow 对拍 1-bit 真实文件 SHA 完全一致 |
| 多 IDAT 时 `unused_data` 偏移按拼接偏移硬加，位置错 | 新增 `idatOffsetToFile` 映射 |
| Adam7 隔行 PNG 静默跳过（0 发现） | 新增解码失败 finding，明确提示不支持 |
| 改高度并重算 IHDR CRC 时尺寸恢复失效 | 新增 `IDAT 实际行数对应其它尺寸`；修复面板同时展示 CRC 与 IDAT 候选，并排除当前假尺寸 |
| 修复副本丢弃 IEND 后载荷 | `buildPNG` 保留 trailing；缺 IEND 时补一个 |
| unused_data 重复报告 | 已有 second_stream 时不再重复 |

### BMP / 格式（`src/40-bmp.js`、`src/50-formats.js`）

| 问题 | 处理 |
|---|---|
| **major**：`colorsUsed` 未校验，58 字节文件可逼出 12GB 调色板分配 | 收敛到 256 项且不超过文件容量；新增异常 finding 与回归 |
| ZIP 只提取 stored 条目 | 增加 deflate 条目解压提取 |

### 分析流水线（`src/70-analyze.js`）

| 问题 | 处理 |
|---|---|
| **major**：压缩流路径绕过 maxDepth（实测到 depth 5） | 统一按 `item.depth+1 <= maxDepth` 入队，丢弃计数并在发现里提示 |
| **major**：跨文件流去重键只用 `kind@offset`，同布局第二份文件被跳过 | 键加入文件 SHA-256 |
| flag 只在产物里时报告漏掉 | `flags()` 同时扫描 artifacts 与 finding payload |
| JPEG 熵编码数据产生 1800+ 假 zlib 头，单文件 3.3s | JPEG 不做全局流扫描（走段/尾部产物递归）；大文件扫描限流 64 次 / 8MB |
| 有损容器提示每层重复 | 全分析只保留一条 |
| 16-bit 高字节平面未扫描 | 增加 `Rhi/Ghi/Bhi/Ahi/RGBhi/RGBAhi` 组合 |
| 前导注释的 SVG 被识别为 TEXT | `detectType` 剥离 XML 声明/注释/DOCTYPE 后再判 `<svg>` |

### UI（`src/80-ui.js`、`src/index.html`）

| 问题 | 处理 |
|---|---|
| **major**：自检用 `innerHTML` 覆盖内容区，`#empty/#result` 节点被销毁，之后再上传报 `null.style` | 新增独立 `#selftest` 面板，不再动结果节点 |
| 分析中仍能点到上一份文件的修复按钮（会对新文件套旧尺寸） | 分析开始即清空旧结果、`busy` 门禁、加载序号/分析序号防竞态 |
| 换文件读取期间点旧查看器 → `state.result.images` 空指针 | `imagesNow()` 空值保护；读取期间收起旧面板 |
| 层过滤芯片在新分析后仍生效，导致结果列表空白 | 新分析重置为「全部」 |
| 产物 blob URL 泄漏 | 每次渲染前 revoke |
| 同一文件再次选择不触发分析 | 选择后立即清空 `input.value`，允许重选/重试 |
| 文件读取失败永久停在“读取文件…” | `arrayBuffer()` try/catch + `unhandledrejection` 钩子，恢复按钮状态 |
| 请求失败无提示 | 状态栏与空态面板同时显示原因 |
| 分析完成后对已脱离 DOM 的旧按钮程序化 click 仍可能生成错尺寸副本 | 所有结果区事件绑定渲染代际 `renderSeq`，旧世代按钮一律失效；CDP 探针验证 detached click 无下载、无状态变化 |

### 构建与收尾（`build.py`）

| 问题 | 处理 |
|---|---|
| 占位符漏替换会静默产出无交互页面 | 替换后断言四个占位符全部消失，并检查核心/自检注入 |
| ZIP fixture 写入当前时间，连续构建哈希不同 | ZipInfo 固定 `date_time=(2026,1,1)`，gzip `mtime=0`；连续两次构建字节完全一致 |
| CSS 未检查 `</style>` | 构建前检查 |
| JPEG APP1 的 XMP 未扫描（只认 EXIF） | 非 EXIF 的 APP1 也走字符串扫描；新增 `jpeg_xmp.jpg` fixture |

## 第二轮复验（针对修复）

| 代理 | 结论 |
|---|---|
| PNG 低位深复验 | pass：gray4_padding 65/65 样本正确；两个真实 1-bit PNG 与 Pillow SHA 完全一致；Adam7 产生明确 finding；palette 无回归 |
| 流水线修复复验 | pass：maxDepth 生效且有丢弃提示；跨文件同偏移 gzip 两条都出 flag；CRC 重算尺寸仍能还原 32x48 且修复副本全 CRC 通过；BMP palette 收敛到 3B、内存增量 <1KB；修复保留尾部 |
| UI 竞态 | 由本机 CDP 补测（同文件重选、读取失败、旧修复按钮不串文件、层过滤重置）全部 PASS；成品与临时副本 SHA-256 一致 |

## 已知边界（未做）

- JPEG DCT 隐写（steghide/outguess/F5）与口令爆破：只给外部命令建议。
- GIF LZW 逐帧像素扫描：只做结构/注释/尾部审计。
- Adam7 隔行 PNG：明确拒绝并告警，不解码。
- 超大文件：默认像素上限 6M（可调 20M），超过只做结构审计与位平面查看。
- 中文文件名在部分下载场景可能被浏览器改名；`dl()` 已做非法字符替换。

## 复现

```bash
cd Z:/laragon/ctf/tools/Misc/misc_dashouzi
python build.py
node tests/run.js
node tests/cdp-smoke.js
```


## v0.2.0 容器与像素深挖（2026-10-27）

| 功能 | 验证证据 |
|---|---|
| GIF LZW | 2 帧 fixture 逐索引对拍（与 Pillow 读回一致）；隔行帧逐索引 0 差异；帧内 LSB 直出 `flag{gif_lzw}` / `flag{gif_interlace}` |
| Adam7 PNG | RGB8 64x32 与 RGBA8 48x24 三/四通道 SHA-256 与 Pillow 完全一致；帧内 LSB 直出 flag |
| PLTE | 16 项调色板仅用 4 项，未使用项里的 `flag{plte_unused}` 被直接读出 |
| BMP 1/4-bit | 索引逐像素对拍 0 差异；LSB 直出 `flag{bmp_1bit}` / `flag{bmp_4bit}` |
| APNG | acTL/fcTL/fdAT 解出 2 帧，第二帧 LSB 直出 `flag{apng_lsb}` |
| TIFF | IFD ImageDescription 里的 `flag{tiff_tag}` 被读出 |
| WebP | EXIF chunk（TIFF 结构）里的 `flag{webp_exif}` 被读出；RIFF chunk 遍历正常 |
| 回归 | `node tests/run.js` 81/81；fixture 42 个；真实 3 题断言仍全过 |
| 独立验收 | 3 个只读代理全 pass：GIF LZW/隔行与 Pillow 逐像素 0 diff；Adam7 RGB/RGBA 7 通道 0 diff，另构造 Adam7+PLTE+bit4 非零填充 851 索引 0 diff；BMP 1/4-bit 256 像素 0 diff；PLTE 未使用色与 flag 读取；TIFF/WebP exiftool 对拍；UI 45/45；360+ 截断 0 异常 |

---

## v0.3.0 分析与交互（2026-10-27）

| 功能 | 实现 | 验证证据 |
|---|---|---|
| 批量分析 | 多选/多拖，最多 50 个；逐个读取+分析，行内状态；点行切换单项；单项失败不阻塞整批 | CDP 上传 2 个文件：`.batch-row` 2 行、高亮 1 行、状态「批量完成：2 个文件」；点击第 2 行后标题变为 `deep_lsb.png` |
| 递归树 | 队列条目带 `id/parentId`，结果 `files` 记录父子链；UI 渲染树形文本 | Node：nested_png 全文件有 id、父节点可解析、深度与父节点自洽 |
| 双图对比 | `65-diff.js`：XOR / 绝对差 / 差值；逐像素 RGB，灰度回退；统计变化像素、最大通道差、平均差；canvas 下载 PNG | Node：3 种模式逐像素与统计断言、尺寸不符拒绝、灰度三通道回退；CDP：64x32 对比 `变化 52 像素（2.5%）· 最大差 1`，切换模式后文本变为「绝对差」 |
| 位平面缩放/平移 | 适应 / 1:1 / ± 按钮、Ctrl+滚轮、拖拽平移；鼠标读数（坐标/通道值/位值） | CDP：点击 `+` 后 canvas 宽度 64→96px、缩放标签 150%；真实 3.png 570→855px；1.png 1850px 宽图适应后 52% |
| 报告模板 | `buildReport(r,{template})`：完整 / 速报 / WP 框架；`buildBatchReport` 汇总表 + flag 汇总 + 每文件详情 | Node：三种模板各自标记齐全、速报含 flag、批量报告含两个文件名/flag 且汇总表恰 2 行 |
| 回归 | 42 fixture、3 个真实题、fuzz、修复、递归、零尺寸 | `node tests/run.js` **104/104**；浏览器自检 **49/49** |
| 零尺寸 | 两个 54 字节零宽 BMP 批量 | 2/2 完成、`#analyze` 可用、结果区正常；不再出现 `ImageData` 异常/整批卡死 |
| 批量上限 | 51 个文件 | 只分析 50 个；文件信息与批量头部均显示「已忽略 1 个（上限 50）」 |
| 本地语料 | 80 个挑战文件（含 ZIP），maxScanPixels=200k | 0 异常；平均 412ms，最慢 `1.zip` 6.8s |
| 打包 | 单文件零外链；两次构建 SHA-256 一致 | `5ea10d07…`（355850 字节）；`https?://`/`fetch`/`XHR`/`WebSocket` 全 0 |

真实题端到端（Edge CDP，单文件 + 批量 + 对比 + 缩放）：

| 样本 | 结果 |
|---|---|
| `school/123/misc/3/3.png` | PASS：`flag{LSB_is_so_easy}`；批量 2 文件 591ms；对比 570x512 |
| `school/123/misc/2/2.png` | PASS：`this_is_password`；JPEG 无像素图时仍完成批量与行切换，另用内置 fixture 验对比 |
| `school/123/misc/1.png` | PASS：尺寸恢复提示；批量 1849ms；不同尺寸对比给出明确提示而不是静默坏掉 |

本轮新增测试：双图 8 项、报告模板/批量 6 项、零尺寸 6 项、递归树 3 项；浏览器自检新增 4 项。

### 独立复核修复（只读 agent，2026-10-27）

| 复核发现 | 处理 |
|---|---|
| **MAJOR**：54 字节零宽 BMP 能通过 `decodeBMP`，`new ImageData(data,0,1)` 抛异常；单文件显示「分析失败」，两个文件批量时 `activate()` 在 try 外，`state.busy` 永久卡死 | `decodeBMP` 拒绝宽高 ≤0；`renderImage/renderPlane/renderViewer/imagePool/diffImages` 全链路拒绝或跳过零尺寸；`activate()` 渲染异常兜底并隐藏半个结果区。CDP 用两个零宽 BMP 回归：2/2 完成、按钮可用、结果区正常 |
| CDP 对比断言假阳性：canvas 默认 300×150，`diffW>=2` 与空提示都能过；50 文件上限无测试 | 默认 fixture 强制断言 canvas `64×32` + `XOR · 64x32 · 变化…`；新增 51 文件上限子测试与零宽 BMP 批量子测试 |
| 递归树测试对 `parentId=null` 放行，父节点缺失时跳过深度检查 | 非根文件必须 `typeof parentId === 'number'` 且可见；深度严格等于父深度 +1 |
| `diffImages` 通道数组过短时统计 NaN / 少算 | 逐通道校验长度必须等于 `width*height`，否则返回错误；新增 Node 回归 |
| WP 模板文件名含 `\|` 会撑坏表格 | 文件名做 Markdown 表格转义；新增 Node 回归 |
| 51 文件上限提示被后续状态覆盖 | 批量头部与左侧文件信息两处常驻显示忽略数量；CDP 断言两处都在 |
| 16-bit 对比用低字节、缩略图用高字节 | 保留低字节比较（能看见 LSB 差异），README 已明确标注；8-bit 题不受影响 |

已知边界：批量结果驻留内存（50 文件上限）；双图对比要求同尺寸、16-bit 只比低字节；报告模板是结构化骨架，不代替人工分析。

---

## v0.4.0 外部工具编排（2026-10-27）

| 功能 | 实现 | 验证证据 |
|---|---|---|
| 手写命令 | 面板内置 10 条 zsteg/binwalk/exiftool/steghide/bkcrack 命令，带复制按钮；含 bkcrack 已知明文攻击模板 | Node/selftest 断言命令齐全；浏览器未连接时面板出现 `zsteg -a` |
| companion 鉴权 | 默认随机 token（≥8 字符），每次请求校验 `X-MDZ-Token`；CORS 只回显 file:///本机 Origin + PNA 预检 | Python：错误 token / 非 ASCII token 均 401；非本机 Origin 无 ACAO；浏览器连接成功 |
| 回环限制 | 服务端拒绝非回环 `--host`，绑定后再校验实际地址；浏览器 `companionUrlAllowed` 只放行 127.0.0.1/localhost/::1 | Python `make_server('0.0.0.0')`、`make_server('::1')` 均抛 SystemExit；浏览器输入 `http://example.com` 显示「只允许连接本机」 |
| 动作白名单 | 9 个固定动作；工具/动作必须匹配；表达式、EXIF 标签、口令长度服务端校验；无 shell 拼接；文件名白名单净化 | Python：错误动作、非法 base64、工具动作错配均 400；steghide 命令展示 `<PASSWORD>` 不回显口令；`a&b;c.png`/`CON.png` 净化通过 |
| 工具执行 | 临时目录写入上传文件；子进程列表参数；60s 超时；超时杀进程树（Windows taskkill /T、POSIX killpg）并重试清理；stdout/stderr/产物限额；产物 base64 返回 | Python：fake 工具产物、真实 exiftool 输出；1s 超时返回 504 而非 500，耗时 <6s，`mdz-*` 无残留；64MB+ body 返回 413 |
| UI 编排 | 连接/断开、工具芯片、9 个动作按钮、字段输入、输出控制台、产物下载 + 面板内递归分析；base64 分块编码让出主线程；切换文件后旧请求结果丢弃 | CDP：5 个工具芯片、9 个动作；依次跑 zsteg 全扫、zsteg 提取（`zsteg-extract.bin`）、binwalk 提取（`payload.txt`）、steghide 提取（`steghide-output.txt`）、exiftool 元数据；产物分析出现 inline 结果；重新分析后已输入的 URL/token 仍在 |
| 回归 | v0.3 全部能力 | Node **108/108**；自检 **52/52**；真实 3.png/2.png/1.png 仍 PASS |
| 打包 | 单文件零外链；两次构建 SHA-256 一致 | `7e5b1964…`（379657 字节）；外链字面量仅回环/安全断言，`fetch` 1 处且先过白名单 |

上限说明：32MB 上传、4MB stdout、32MB 产物总量、64 个产物文件、60s 超时均由代码写死；超时/清理与 64MB body 拒绝有回归，未做满 32MB 压测。

已知边界：companion 需要用户手动启动；工具本身未安装时只能复制命令；bkcrack 已知明文攻击只提供手动模板；真实 zsteg/binwalk/steghide 未在本机安装，编排路径用内置假工具回归，真实 exiftool 已实测。

---

## v0.5.0 相邻载体（2026-10-27）

| 能力 | 实现 | 验证证据 |
|---|---|---|
| WAV | RIFF/fmt/data、PCM 8/16/24/32-bit、WAVE_FORMAT_EXTENSIBLE、逐采样/逐字节 LSB、波形、FFT 频谱、Morse、LIST/INFO、尾挂、多 data | Node：fmt/data/帧数、单/立体声 LSB flag、extensible SubFormat/validBits 解码、Morse `SOS`、频谱峰值 ~797Hz；浏览器：波形 canvas 1274px、频谱 31×512、note `峰值 ~797 Hz` |
| MP3 / ID3 | ID3v2.2/2.3/2.4 文本帧、TXXX/COMM、APIC/PIC、v2.4 DLI/unsync/压缩、ID3v1、数据区字符串/尾部 | Node：ID3v2.3、v2.2 PIC、v2.4 unsync/DLI、`flag{id3_txxx}`、`ID3 APIC`、ID3v1；57 个 fixture |
| PCAP | 经典 pcap 四种 magic、包数上限、尾挂、Ethernet/raw/SLL/NULL、IPv4/IPv6、IPv4 分片、TCP 乱序/wrap/重传/空洞、UDP、DNS、HTTP、TTL 异常、TCP/UDP 产物 | Node：6 包 HTTP flag、乱序 flag、TCP wrap 48B、DNS、TTL、IPv6、BE pcap、尾挂；真实 SUSCTF `花好月圆.pcapng` 30213 包全量解析、尾挂 0，前导 5 个 UDP 小包被列出 |
| PCAPNG | SHB/IDB/EPB/SPB、LE/BE BOM、接口 linktype、SPB 去填充、尾挂 | Node：LE/BE/SPB 各 1 包 flag；浏览器 PCAPNG 视图通过 |
| UI | 音频播放器、波形、频谱热力图、FFT 选择、Morse 文本；PCAP TCP/UDP 表/DNS/HTTP/TTL/会话/告警 | CDP：WAV 视图、PCAP 表格 4 行 + flag/DNS/TTL、PCAPNG flag 均 PASS |
| 回归 | v0.4 全部能力 | Node **156/156**；自检 **67/67**；companion Python **14/14**；companion 浏览器 PASS；真实 `3.png`/`2.png`/`1.png` 全 PASS |
| 打包 | 单文件零外链；两次构建 SHA-256 一致 | `27385a55…`（522280 字节）；外链字面量仅回环/安全断言，`fetch` 1 处且先过白名单 |

上限说明：音频解码最多 500 万帧、LSB 扫描 400 万采样；频谱最多 1024 帧；pcap 最多 10 万包、单流 8MB、产物 128 个/32MB。已覆盖 57 个 fixture 截断 fuzz + 包数上限 + TCP wrap + pcapng BE/SPB；未做超大音频/超大 pcap 压测。

### v0.5 复核修复（只读 agent）

| 复核发现 | 处理 |
|---|---|
| **BLOCKER**：pcapng SHB BOM 判断反了，真实 LE pcapng 全读成 BE（花好月圆 0 包） | 按规范改为 `4D 3C 2B 1A`=LE、`1A 2B 3C 4D`=BE；fixture 同步修正；真实 30213 包解析通过 |
| **MAJOR**：10 万包上限触发后剩余字节被当成尾挂 | cap 触发只留告警，不再设 trailing；100001 包回归确认无 `pcap 结束之后还有数据` |
| **MAJOR**：WAVE_FORMAT_EXTENSIBLE 被当非 PCM 拒绝 | 读 SubFormat GUID 解析为 PCM/float，validBits 入报告；新增 extensible fixture |
| TCP seq wrap 排序错误 | 找序列号环最大空档选基准，再做相对排序；32B+16B wrap 回归 48B 正确、retrans 0 |
| ID3v2.4 帧级 unsync/DLI/压缩忽略；v2.2 PIC 无 APIC | 实现帧 flags（DLI/unsync/inflate/grouping）与 PIC；新增 v2.4/v2.2 回归 |
| pcapng SPB 把 4 字节填充算进载荷 | 用 orig 长度裁剪；SPB fixture incl==orig |
| IPv6 AH/扩展头缺 bounds，可读越界/NaN | 每个扩展头检查 pos+2/pos+len；越界返回 incomplete |
| IPv4/IPv6 分片每包都告警 | 改为 incompleteFrags 集合，结束时只报一行 |
| 20M 帧 × 8ch 可能 640MB + 同步 LSB 扫描卡顿 | 解码上限 500 万帧、按位深选 Uint8/16/32、data 同步截断；LSB 400 万采样；超限 finding |

已知边界：MP3 不做 PCM 解码，因此没有 MP3 波形/频谱；IPv6 分片暂不重组；ID3 加密帧不解码；pcapng 仅基本 section；音频播放依赖浏览器自身解码。

---

## v0.5.1 UI：ATRI · 海边的旧校舍（2026-10-27）

| 项目 | 结果 |
|---|---|
| 主题 | 浅色纸面 `#fbf7ee` + ATRI 红 `#b84a5a` + 海玻璃青 `#2f6f78`；侧栏头图与全局壁纸使用本地 ATRI 参考图，构建时 base64 内联 |
| 可读性 | 数据面板 94% 不透明，侧栏 95%，顶栏 88%；壁纸只在面板间隙/空状态透出，避免干扰读数；代码块改暖砂纸色 `#f1eadc` + 深青文字 `#2b4047` |
| 字体/细节 | 品牌、顶栏、摘要标题改衬线；新增 `::selection` 与 `:focus-visible` 焦点环；侧栏头图 160% 裁切；移动端隐藏头图 |
| Canvas | 波形背景 `#17252a`、轨迹 `#c65a68`；频谱改海玻璃青→珊瑚→暖白热力 |
| 回归 | `node tests/run.js` **156/156**；浏览器自检 **67/67**；`node tests/cdp-smoke.js` PASS；companion Python **14/14** |
| 打包 | 两次构建 SHA-256 一致：`3b15693f47bc4153ffdb632d9cb00abbb0ed82534de7172e981a0b9a9826213b`（953282 字节） |
| 版权边界 | 壁纸仅本地使用；`README` 已注明不要将含该图的成品上传公开仓库或对外分发 |

## v0.6.0 LZMA 与部署（2026-10-28）

| 项目 | 结果 |
|---|---|
| LZMA 识别 | `isLzmaAlone()`：props ≤ 224 + 字典大小 ∈ {2ⁿ, 1.5×2ⁿ}（n=12..30）+ 原长字段（全 `ff` 或 ≤256MB）；并入 `findStreamSignatures`，`20-png`（IDAT 剩余数据）与 `70-analyze`（整文件扫描）两条消费路径都覆盖 |
| 内置解压 | companion 新增 `lzma.decompress`：纯 Python、不起子进程、不写临时文件；偏移留空按同判据自动定位，也接受 `0xdd4` / `3540`；返回明文 + 产物；工具/动作不匹配直接拒绝 |
| 部署 | `start-companion.bat` → `launch-hidden.vbs` 零窗口重启；token 走 `file:///...#t=<token>` 片段（不进网络/日志），`replaceState` 抹除 + localStorage 记住；`--token-file` 固定 token；自动把同目录的 bkcrack/steghide 加进 PATH |
| 生命周期 | 页面 20s 心跳；`pagehide` 发 `POST /api/bye`（keepalive）立即退出；`--exit-when-idle 120` 兜底，避免隐藏控制台后留孤儿进程 |
| 回归 | `node tests/run.js` **165/165**；`tests/test_companion.py` **15/15** |
| 实测 | 空闲阈值 3s → 退出码 0、耗时 3s；`/api/bye` → 返回 `{"ok":true,"bye":true}`、1s 退出；VBS 隐藏执行 stub 生成 marker；bat 两分支干跑 0 解析错误；真实运行后 8765 端口拒绝连接（服务已随页面退出） |
| 踩坑 | ① `pip install binwalk` 是 2015 年的空壳（只有 `__init__.py`，无 `core/`），PyPI 上没有可用的 binwalk ② bat 必须 CRLF + 纯 ASCII：LF-only 会让 cmd 错误断行，中文 `rem` 会被 GBK 双字节拆成两条命令 ③ `start` 对 `C:\path\x.html#frag` 按文件名解析会报"找不到文件"，必须用 `file:///` URL ④ `sh.Run` 里 `"\t..."` 会被 Python 转成制表符（脚本生成时需按字节拼） |

## v0.7.0 One PieNG 反哺（2026-10-29）

| 项目 | 结果 |
|---|---|
| 起因 | 用 ctfshow《One PieNG / PNG 隐写入门赛》真题（单文件 18 flag）回放工具，暴露 4 处缺口 |
| 结构层 | 坏 CRC 字段按 ASCII 拼读（`H1de_h3xd47a_1n_chunk_CRC`：9 个 IDAT 的 CRC 各藏 3 字符，首字节 0x00 丢弃）；非标准 chunk 类型点名（`tXEt` 与 `tEXt` 一字之差）；元数据 hex / base58 / base64 二次解码（XMP 的 `DocumentAncestors` 与 `City` 各解出一个 flag） |
| 像素层 | 通道序补 A 打头的四位序（AGBR/ARGB/ABGR/ABRG/ARBG/AGRB/GARB/BGRA）；支持多位组合（bit1+bit2 等，行/列 × MSB/LSB 可选）；`#…#` flag 识别带防噪声判据（长重复串、字符种类数、是否在流首部）；提取热循环去掉逐 bit 函数调用 + mask 缓存（深扫从"跑不完"到 56 s） |
| 流水线 | 文件名带 `#…#` 直接报（第 1 题就是文件名）；LSB 产物若以 ZIP/PNG/JPEG/GIF/RIFF/7z/RAR/zlib 开头自动进递归队列（真题 `LSB → ZIP → pw.txt` 一条链解出第 9 题） |
| 回归 | `node tests/run.js` **173/173**（新增 8 项：AGBR bit7 列序、RGB bit1+2 多位、CRC ASCII、伪 chunk 点名、伪 chunk 内 flag、tEXt hex 解码、默认格式不认 `#` 型、默认格式认 `flag{...}`） |
| flag 格式 | 默认只认 `flag{...}` 这类「前缀{正文}」；侧栏可改模板（`{}` 代表正文），赛题用 `#...#` 就填 `#{}#`，设置存 localStorage。自定义格式额外叠"正文得像词"的判据（alnum ≥ 80%、无 5 连重复、字符种类 ≥ 5），避免噪声拼出假 flag |
| 真题回放 | 把格式改成 `#{}#` 后：默认扫描 **3.2 s → 9 flag**，深度扫描 **54 s → 12 flag**；默认格式（`flag{...}`）在这道题上正确地**不出 flag**（它用的不是标准写法）。余下 6 个全是"画在图里的字"（可见文字、高度区两行、位平面画字、第二张图竖排字），不做 OCR，靠位平面查看器/图像预览人工读 |
| 已知噪声 | 该样本上仍报 139 条 `stream_lzma`（LZMA 无魔数，v0.6 的属性字节判据本来就偏宽），不影响 flag 汇总，但报告会比较长 |

---

## v0.8.0 画字 / 频域 / 编码链 / 新载体（2026-11-01）

| 项目 | 结果 |
|---|---|
| 画字检测 | 判据换成"把被测那一位清掉再看局部方差是否为 0"——文字只动这一位，清掉后与背景同值；JPEG 噪声（动 ≥2）自然被排除。之后瓦片聚类 → 行投影取文字带 → 连通块数/列覆盖率/密度过滤，把候选裁成黑白图（同时给 BMP 实体可下载）。One PieNG 真题上 460 ms 定位到 `#You_st3gs0lved_me!!!#` 并裁出可读图 |
| 频域 | 亮度 → 不超过 min(w,h) 的 2 的幂（上限 256）下采样（不放大，fx 就是每源像素周期数）→ 2D FFT → 中心化 log 幅度谱 + 前 6 峰（5×5 非极大抑制、排除低频圈）。周期 8px 的正弦验证峰落在 ±0.125 |
| 编码链 | base32 / ascii85 / base91 / uuencode / URL / HTML 实体 + 原有 hex/base64/base58；自动链最多 3 层。rot13/rot47/atbash 只作显式变换，不进步自动链（否则全长这样）。uuencode 按行首长度裁剪；base32 允许宽松长度；base64 需 ≥12 字符 |
| 新载体 | 字体 sfnt 表目录（含 ttcf）/ 越界表 / 非常见表 / 表尾夹带；SQLite 页大小·页数·编码·页后尾部·CREATE TABLE；ELF / PE 节表与 overlay。四处都会把尾部数据导成产物 |
| 二维码 | companion 新增 `zbarimg` 动作与手写命令；仍是可选组件，不把 wasm 塞进单文件 |
| 回归 | `node tests/run.js` **187/187**（新增 14 项：5 个编码向量、两层链、base32 扫描、画字定位与裁剪、频域峰值、TTF/SQLite/ELF 尾部 flag、BMP 往返）；浏览器自检无 FAIL |
| 真题回放 | One PieNG（格式设 `#{}#`）：默认扫描 4.1 s → 9 flag + 画字候选 + 频谱；深度扫描 57 s → 12 flag。画字候选直接给出 `#You_st3gs0lved_me!!!#` 的裁剪图（不 OCR，读仍靠眼睛） |
| 踩坑 | ① 字体表目录偏移是 sfnt 头之后 +12，一开始多加了 12 导致"表越界" ② flag 正则的正文用贪婪会把 `flag{a}xx flag{b}` 连成一条，改惰性 ③ 下游脚本（tool_check.js）要自己更新模块加载清单，否则新模块未定义会变成 error 发现 |

---

## v0.9.0 节点编辑器 / CRC / BMP / GIF 逐帧（2026-11-09）

| 项目 | 结果 |
|---|---|
| 节点编辑器 | 新增 `src/78-nodes.js`（纯函数，Node 可测）：图像输入 → 通道 / 位平面 / 灰度 / 反色 / 阈值 / 量化 / 通道重排 / 裁剪 / 缩放 / XOR / 差值 / 频域 / 调色板 → 输出。图求值带记忆化与环检测；UI 在 `80-ui.js`，拖动标题移动、右侧输出圆点拖到左侧输入圆点连线、点输入圆点断开；输出节点预览 + PNG/BMP 下载。来源图像取自分析结果的 `result.images`（含 GIF/APNG 帧、频域图）或节点内单独载入 |
| CRC（PNG） | 逐 chunk 表显示文件 CRC 与应得 CRC；一键重算；自定义宽高写 IHDR 并重算 CRC（IDAT 原样保留） |
| CRC（JPEG） | 段结构审计 + 移植 `CRC_CHECK/image-crc.html` 的熵数据 MCU 计数：合法 16×16 向量剩余 0；把高度从 16 改成 8 后报多余字节并给出 `suggestedH = 16`；自定义宽高只写 SOF 字段 |
| CRC 工具 | 文本 → CRC32；短串反查（字符集 + 长度上限 + 15 s 熔断，支持已知前后缀）。`crc32Brute('abc')` 与 `flag{abc}` 前后缀向量均命中 |
| BMP | 文件头 / DIB / 调色板 / 像素区 / 夹缝对账；调色板色块预览；`editBMPDims` 只改 biWidth/biHeight（保留 top-down 符号）；解码像素导出 24-bit BMP |
| GIF | `analyze` 把根 GIF 的帧表存入 `result.gif`；UI 显示偏移/位置/尺寸/延时/处置/透明/局部调色板 + 缩略图；单帧可送位平面查看器、下载 PNG/BMP、跑单帧 LSB 扫描。GIF 帧图像现在带 `palette`，节点编辑器可直接画调色板 |
| 音频 | 频谱图按当前 FFT 档位导出 PNG（全分辨率 canvas） |
| 回归 | `node tests/run.js` **208/208**（新增 21 项：11 个节点运算、链式求值、环检测、CRC 反查 ×2、BMP 自定义宽高、PNG 自定义宽高、GIF 帧元数据、JPEG 熵自检 ×2、JPEG 宽高、缩放修正） |
| 浏览器 | `misc-dashouzi.html?selftest=1` **72 通过 / 0 失败**；`node tests/cdp-smoke.js` PASS，额外断言：PNG CRC 面板（CRC 计算 = `0xcbf43926`）、GIF 面板 3 行/2 缩略图/单帧 LSB 有输出、BMP 面板（2 色块/导出按钮）、JPEG 面板（熵自检文案/自定义宽高）、节点编辑器（默认 2 节点 1 连线、输出 64×32、添加第 3 个节点、断开后连线数 0、重连后 2 条连线且输出像素哈希变化、拖动节点位置变化且连线保留） |
| 踩坑 | ① 节点源码里只给非 source 节点画输出口，导致 source→output 连线查询不到端口（CDP 抓出） ② UI 里误用核心模块的 `hex()`，浏览器报 `hex is not defined`（自检/单测都在 Node 侧覆盖不到，靠 CDP 上传才暴露） ③ 无头 Edge 的可视区只有 750×485，测试里节点必须横排否则端口在视口外，`elementFromPoint` 返回 null |

---

## v0.10.0 尺寸反推 / 一键修复 / misc24–35 回放（2026-11-09）

| 项目 | 结果 |
|---|---|
| BMP 反推 | `recoverBMPDims`：扫宽 1..4096，按 `rowSize=4 字节对齐(bpp*w)` 求 `rows=floor(dataBytes/rowSize)`，只收余量 ≤8 的候选；分成 `widthFixed`（只改高度）、`heightFixed`（只改宽度）、`other` 三组。misc24 → 900×250；misc30 → 950×150；misc31 → 1082×150 |
| JPEG 反推 | `recoverJPEGDims`：SOF 采样因子求 mcuW/mcuH；DRI>0 时 `total=(重启标记数+1)*DRI`，否则用熵数据 `declared+extra`；分解 `total=mcusX*mcusY` 得候选，保留声明宽度优先、其次 `width≥声明` 升序。misc27 → 900×256；misc35 → 1000×504（真实 1000×500，末行部分 MCU） |
| GIF 多余行 | `gifFrameImage(..., {full:true})`：LZW 解到 `w*(h+4096)` 上限，按 `decoded/w` 得真实高度；`auditGIF` 报 `gif_extra_rows`（0.99），`result.gif.frames[i]` 带 `fullHeight/extraRows`；`editGIFDims` 改 LSD 与帧描述符高度。misc28 帧 0、misc29 帧 7 均为 900×150 → 900×250（+100 行） |
| 一键修复 | PNG/BMP/JPEG/GIF 的尺寸修复按钮统一 `下载 + analyzeBytes()`：直接把修复副本放回分析台重新分析，不用再拖一次 |
| 回归 | `node tests/run.js` **212/212**（新增 4 项：JPEG 候选含 16×16、BMP 候选含 3×5、GIF 多余扫描行、GIF 帧高/画布高度）；浏览器自检 75/75；普通 CDP 冒烟 PASS |
| 真实题 CDP | `CHALLENGE_DIR=C:/Users/yu/Downloads node tests/cdp-smoke.js` PASS：misc24 点 `[data-bmp-cand="900,250"]` → 重新分析为 `fixed-900x250-misc24.bmp`；misc25 点 `[data-fix-dims="900,250"]`；misc28 点 `[data-gif-full="0"]` → `fixed-gif-frame0-900x250.gif`；misc35 点 `[data-jpeg-cand="1000,504"]` → `fixed-1000x504-misc35.jpg` |
| 12 题结论 | 24/25/26/27/28/29/30/31/32/33/34/35 全部通过「声明尺寸 ≠ 实际数据」定位并修复出图；flag 以像素/OCR 读出，详见对话记录，不写入仓库 |
| 踩坑 | ① Node 的 `Buffer.slice()` 是共享视图，`editBMPDims/editJPEGDims/editGIFDims` 会改到输入；改成 `new Uint8Array(b)`（浏览器 Uint8Array.slice 是拷贝，单测才暴露） ② JPEG 候选宽度直接用 `mcusX*8` 会把 900 写成 904；声明宽度落在末个 MCU 内时要保留声明值 ③ GIF 的 LZW 解码原先按 `w*h` 截断，多余行永远看不到；必须用 full 模式多解一段 |

---

## v0.11.0 内置 LZMA / 二维码 + 当前图像预览（2026-11-09）

| 项目 | 结果 |
|---|---|
| 起因 | 用户那边 companion 连不上（`Failed to fetch`，8765 没监听——服务是「页面关了就退出」的设计）。先确认外部工具里哪些本来就能内置 |
| LZMA 解压 | 新增 `src/13-lzma.js`：`.lzma` 单独格式（属性字节 + 字典 + 原长 + 范围编码），literal/match/rep 三种分支、概率表塞进一个 Uint16Array；原长未知时靠结束标记（distance=0xFFFFFFFF）收尾 |
| LZMA 接线 | `70-analyze` 扫到 LZMA 流先尝试解压，可打印率 ≥80% / 命中 flag / 产物像图就报「已解压」并入递归队列；解不出才回落到「下载后用 xz」。`20-png` 的 IDAT 剩余数据同样处理 |
| 二维码 | 新增 `src/14-qr.js`：Otsu 二值化 → 逐行扫 1:1:3:1:1 找候选，**先做竖直方向同比例校验再聚类**（防假寻像图形把簇均值拖偏）→ 3 点定仿射（斜边对顶点为左上，叉积定右上/左下）→ 采样 → 读格式信息（两份副本 + BCH(15,5) 校验）→ 去掩码 → 之字形读码字 → 按版本/纠错拆交织 → 数字/字母/字节/汉字段。`RS_BLOCK_TABLE` 160 项从 Python `qrcode` 的表导出后写死 |
| 二维码接线 | `scanImageOnce` 里对 ≤4M 像素的图解一次，解出的文本进发现 + 产物 `qr-text.txt`，flag 自动收录 |
| 预览面板 | `index.html` 加 `.mainrow` + `#pv`，`style.css` 加 300px 右栏（<980px 隐藏）。`pvShowResult/pvShowImage/pvShowBytes` 三个入口；`render()` 出结果时画、`nodeEval()` 画节点输出、宽高输入框 `input` 防抖 200ms 调 `repairPNG/editJPEGDims/editBMPDims` 后直接丢给浏览器解码 |
| 回归 | `node tests/run.js` **221/221**（新增 9 项：LZMA 解压出原文、属性非法报错、两个二维码 fixture 的解码与 flag 收录、噪声不误报）；浏览器自检 **77/77**；`node tests/cdp-smoke.js` PASS（新增预览断言：BMP 改宽后 canvas 64→88 且脚注出现「实时预览」） |
| 二维码单元 | 额外用 Python `qrcode` 生成 v1/v2/v3/v8 × 原图/旋转 共 8 张，全部解出正确原文（含 90° 旋转的 v3/v8） |
| 误报 | 42 张 fixture 图 + 随机噪声，二维码 0 误报 |
| 踩坑 | ① JS 的 `<<` 返回有符号 32 位，LZMA 距离到 30 位会变负数，必须 `>>> 0` ② `.lzma` 原长未知时要认结束标记，否则会多解 2–3 字节 ③ 二维码竖直校验里「上下两条浅色」合起来是 2 个单元，写成 1 个单元会把所有真寻像图形筛掉 ④ `RS_TABLE[version][ec]` 的 `[1]` 是**每块**总码字，符号总码字要 `块数1×总1 + 块数2×总2` ⑤ 分析流水线里的 `image` 是 `{channels}`，不是 RGBA `{data}`，要先 `renderImage()` ⑥ CDP 默认视口 750×485 会命中右栏的窄屏隐藏规则，测试里固定成 1280×900 |

## v0.12.0 文件头修复 + 版本说明页（2026-11-10）

| 项目 | 结果 |
|---|---|
| 起因 | 用户提出「魔数第一个字节被删掉就认不出文件」，要一个疑似格式判断 + 修复 |
| 检测 | `src/00-util.js` 新增 `detectDamagedHeader`：对每个魔数试「补回前 1–3 字节」与「删掉前 1–3 字节」，用 `detectType` 复核，再按格式做结构自检（PNG 的 IHDR、ZIP 的压缩方法+文件名长度、BMP 的 DIB 尺寸+bfSize、JPEG 的 SOF、SQLite 的页大小、WAV/WebP 的 RIFF tail…）；短匹配（<3 字节）必须有结构证据才收 |
| 特殊情形 | JPEG（3 字节魔数）与 BMP（2 字节）单独分支；PNG 整个 8 字节签名被删（文件以 `00 00 00 0D 49 48 44 52` 开头）也能补回 |
| 接线 | `70-analyze` 对每个 `unknown` 文件（含递归子文件）跑一次；`finding()` 新增通用 `repair` 字段，UI 自动渲染「修复并分析」按钮（下载 + `analyzeBytes`） |
| 版本说明页 | 新增 `src/76-changelog.js`（`CHANGELOG` + `CAPABILITIES`），顶栏第三个标签渲染成独立页面：能力总表 + 逐版本新增/修复，当前版本高亮 |
| 回归 | `node tests/run.js` **235/235**（新增 13 项：PNG/JPEG/BMP 缺首字节、开头多字节、PNG 去整签名、随机字节不误报、分析时出 `damaged_header`、repair 字节正确、版本说明 3 项）；浏览器自检 **81/81**；CDP 冒烟 PASS（上传 `cut_png.png` → 点「修复并分析」→ `#result h2` 变回 PNG；切到版本说明页断言卡片数 ≥10、能力块 ≥3、标题含 `v0.12.0`） |
| 负例 | 256 字节伪随机数据 0 候选；正常文件不会进入这条路径（只在 `detectType` 返回 unknown 时触发） |

## v0.12.1 九路审计后的第一批修复（2026-11-10）

九视角只读审计（格式覆盖 / 图像深度 / 归档 / 音频流量 / 文档可执行 / 流水线正确性 / UI / 性能测试 / CTF 题型透镜，9 个 agent、527 次工具调用）后，先修了收益最高的一批：

| 修复 | 验证 |
|---|---|
| 中文/emoji 文本被判 unknown | UTF-8 严格解码兜底；`中文 detect: TEXT`，不再误报扩展名不符 |
| 零宽字符隐写 | 新增 `zeroWidthAudit`，按 6 种常见映射还原；fixture `zero_width.txt` 出 `flag{zero_width}` |
| ZIP 只有本地头 | 改为优先读中央目录：数据描述符（bit 3）、ZIP64 布局、EOCD 注释都能处理；method 14（LZMA）可解 |
| 空 ZIP 判「不是 ZIP」 | `isZIP` 接受 PK\x05\x06 / PK\x07\x08；空包报「空 ZIP（只有中央目录）」 |
| EOCD 注释藏 flag | 新增 `zip_comment` 发现 + `zip-comment.txt` 产物；`zip_comment.zip` → `flag{zip_comment}` |
| gzip/zlib 校验失败丢明文 | 去掉 `z.error` 丢弃条件，错误写进 detail |
| 顶层 gzip 解出二进制被吞 | 容器/顶层流豁免可打印率过滤；`looksLikeContainer` 补 gzip/xz/bzip2/ustar |
| LZMA 假阳性刷屏 | 解不出可读内容时只在 offset 0 才报；实测 notepad.exe 151→0、arial.ttf 67→0，`lzma_rest.png` 仍出 flag |
| 自动扫描没有 MSB | autoCandidates 补 bit7 RGB/RGBA，大图路径也带一条 |

回归：`node tests/run.js` **239/239**（新增 4 个 fixture：`zip_descriptor.zip` / `zip_comment.zip` / `zip_lzma.zip` / `zero_width.txt`）；浏览器自检 **85/85**；CDP 冒烟 PASS。

## v0.13.0 TAR / PDF / RAR / 7Z / MP3（2026-11-10）

| 模块 | 实现 | 验证 |
|---|---|---|
| TAR（`src/55-archives.js`） | 512 字节头：八进制/base-256 数字、校验和验证、GNU `L`/PAX `x` 长文件名、目录/符号链接；成员作为产物入队递归 | `tar_members.tar`（含 `inner.png`）→ 3 个成员提取，`tar-inner.png` 被当作 PNG 二次分析 |
| RAR | RAR4 头（FILE_HEAD 字段、0x100 大文件、加密位、stored 0x30）+ RAR5（vint 块头、FILE_HEAD、加密头块） | `rar4_stored.rar` → 成员 `flag.txt` 提取出 `flag{rar_stored}` |
| 7Z | 签名头 → next header；未压缩 `kHeader` 走 `kFilesInfo` 取 UTF-16 文件名；`kEncodedHeader` 明确提示 | `seven_plain.7z` → 「7Z：2 个文件」+ 名字列表 |
| PDF（`src/53-pdf.js`） | `obj…endobj` 扫描、`/Length` 与 `endstream` 双路径、过滤器 Flate/ASCIIHex/ASCII85/DCT、`/EmbeddedFile`、`/JS`、XObject 图片（Flate 8-bit Gray/RGB 用 stored-deflate 拼回 PNG）、多个 `%%EOF`=| `pdf_objects.pdf` → 内嵌文件、2×2 PNG（可解码）、JS 片段、两个 flag |
| MP3（`src/62-audio.js`） | Layer III 帧表（码率/采样率/帧长）、Xing/Info/LAME、帧头 private/copyright/original/padding 位当信道（MSB/LSB 两种顺序，可打印率 ≥90% 才收） | `mp3_frames.mp3` → 14 帧解析 + private 位还原 `flag{mp3bits}` |

回归：`node tests/run.js` **256/256**（新增 5 个 fixture + 12 条断言）；浏览器自检 **90/90**；CDP 冒烟 PASS。

已知边界：RAR 的压缩算法、7z 的 LZMA2/BCJ 不实现（只列条目/取 stored）；PDF 不做渲染，`/Predictor` 图片只导出裸数据；MP3 不做 PCM 解码（无波形/频谱）。

## v0.14.0 S/M 批：雕刻 / USB / ICMP / PDF predictor / MP3 频谱（2026-11-10）

| 项目 | 实现 | 验证 |
|---|---|---|
| 内嵌容器雕刻 | `analyzeStreams` 消费 `findStreamSignatures` 的 zip/png/jpeg 命中（以前直接 `continue` 丢掉）：切出来当产物 + 入队递归，每个文件最多 12 个、单个 32MB | `carve_embedded.bin`（64 字节垃圾 + PNG）→ `carved-0x40.png` 被当作 PNG 二次分析 |
| USB HID 键盘 | `64-pcap.js` 对 linktype 189/220/249 在 11 个候选偏移上按 8 字节 HID 报文试解，取可打印率最高的一组；含 Shift 符号表 | `pcap_usb.pcap`（16 字节头 + HID）→ 偏移 16 解出 `flag{usb_hid}` |
| ICMP / ICMPv6 | `parseICMP` 保留 type/code/payload；可打印或命中 flag 的载荷进候选产物 | `pcap_icmp.pcap` → `icmp-*.bin` 提取，`flag{icmp_payload}` 收录 |
| PDF predictor | `unfilterPNG`（Sub/Up/Average/Paeth）后再拼 PNG；predictor 10–15 都能还原 | 代码级（fixture 用无 predictor 图） |
| MP3 波形/频谱 | UI 用 `AudioContext.decodeAudioData` 解码 MP3 → 构造与 WAV 同形的 pcm（`value(ch,i)`）→ 复用 `waveform`/`spectrogram`；失败时面板显示原因 | CDP：`mp3_frames.mp3` → `#a-spec` 253×512 |
| LSB 打分窗口 | `scoreStream` 的 head 从 4KB 放宽到 64KB | 无回归 |
| UI 状态 | 改 flag 模板→重渲染；改深度/像素上限→重跑；document 级 dragover/drop 阻止导航 | CDP 全绿（未单独断言） |

回归：`node tests/run.js` **263/263**；浏览器自检 **93/93**；`node tests/cdp-smoke.js` PASS（新增 MP3 频谱断言）。

## v0.15.0 一维条码 / HTTP 对象 / 编码载荷落盘（2026-11-10）

| 项目 | 实现 | 验证 |
|---|---|---|
| 一维条码 | 新增 `src/15-bar.js`：灰度扫描线 → Otsu 二值化 → 游程量化（误差最大项逐格修正）→ 符号表查表。EAN-13/EAN-8 走 L/G/R + 首位奇偶表；Code128 走 107 项图样 + mod-103；Code39 走 44 项宽窄图样 + 起止 `*`。横向 17 条、竖向 11 条扫描线 | 表结构自检（Code128 107 项/除 stop 外 11 模块/无重复、Code39 每项 3 宽）；合成图 Code128/Code39 1–3 px 每模块全解；真实 PNG `barcode_ean13.png` 解出 `5901234123457`；空白图 0 误报 |
| 编码载荷落盘 | `decodeOnce` 加 `binaries` 选项：解出来不是文本但带魔数的，返回字节；`auditGeneric` 切成产物 → 流水线自动递归 | `b64_png.txt`（文本里藏 base64 PNG）→ `decoded-base64-1.png`，第 1 层被当 PNG 分析 |
| HTTP 对象 | `64-pcap.js` 新增 `httpExtract`/`dechunk`：按 Content-Length / chunked / multipart 边界切 body，文件名取 Content-Disposition | `pcap_http_obj.pcap`（chunked 响应 + multipart 上传）→ `http-got.png` / `http-up.txt`，`flag{http_multipart}` 收录 |
| 超长编码串 | 编码侦探候选串上限 4096 → 65536 字符 | 长 base64 不再整段漏 |

回归：`node tests/run.js` **281/281**；浏览器自检 **96/96**（fixture 76 个）；`node tests/cdp-smoke.js` PASS。

## v0.16.0 四维审查修复（2026-11-10）

审查方法：4 个镜头并行初审（正确性 / 性能 / 架构 / 交互），再换镜头交叉对抗复核（复核者的任务是尽量否掉）。初审 47 条 → 确认 29 · 部分成立 17 · 否掉 1。完整清单见 `REVIEW.md`。

| 项目 | 实现 | 验证 |
|---|---|---|
| 7Z 死循环 | kName 的 size vint 夹到 `hdr.length`，`p` 前进也夹 | 64 字节构造文件：以前 8 秒超时，现在毫秒返回 |
| ID3 死循环 | 加密帧两个分支 `continue` 前补 `pos = dataEnd` | 20 字节 ID3v2.3 帧 flags=0x0040：以前 5 秒超时（实测 exit=124），现在正常返回并计 `encryptedFrames` |
| 大文件漏检 | 预算从「命中数」改成「解出字节数 + 全局限时 + 每类次数」，内嵌容器不吃预算 | 1.2MB 载体里 1.15MB 处的 zlib 流能解出；20MB 载体 19MB 处的流也能（1.6 秒） |
| 通用兜底 | 已知格式 audit 全失败（只剩 `format`/`error`）时再跑 `auditGeneric` | DIB 头改坏 + 尾部 `flag{bmp_bad_dib}` → flag 收录，且出现 strings 发现 |
| PDF ASCII85 | 只在 `~>` 处截断，不再用贪婪前缀删数据 | 含 `<` 的 ASCII85 内嵌流原样还原（字节级比对） |
| 音频/图像去重 | 音频改为「先打分再按首尾+长度去重」；图像签名用首尾各 8K + 长度 | 40k 静默采样 + bit1 载荷：以前 findings=0，现在能命中 |
| PNG 尺寸炸弹 | 像素数 > 3200 万或像素数据 > 128MB 直接拒绝，解压上限按声明尺寸给 | 40000×40000 的 260KB 文件：毫秒返回 `tooBig` |
| GIF 帧上限 | 最多 64 帧 / 3200 万像素，超出保留元数据并给出「跳过了多少帧」 | 现有 GIF/APNG fixture 全绿 |
| WAV 拷贝 | `concatRanges` 支持只拼前 N 字节 | 50MB WAV 不再整块复制 |
| 字符串构造 | `ascii/strings/utf16strings` 改用 `TextDecoder`；`utf16le` 保留逐字符（孤立代理项语义） | 300 组随机等价性；50MB 文本 2319ms/1.6GB → 11ms/0MB |
| 假签名 | gzip 按 RFC 1952、PNG 要 8 字节全签名、JPEG 要自洽段链、切出的容器先验结构 | 20MB 随机数据：假产物从 8 个降到 0，总耗时 5.7 秒 → 1.8 秒 |
| 单一真理源 | `CORE_MODULES` 只写在 build.py 并导出 `tests/modules.json`；`VERSION` 只写在 00-util.js，构建时注入顶栏 | 三条门禁断言（模块清单 / 清单一致性 / 产物版本号） |

性能（定长随机数据，Node 单线程）：

| 输入 | 修复前 | 修复后 |
|---|---|---|
| 50MB 纯文本 | 5445 ms / 堆 1656 MB | 3563 ms / 堆 5 MB |
| 50MB PDF | 7776 ms | 3699 ms |
| 50MB WAV | 6.3 秒 / 346 MB（审计实测） | 3686 ms / 5 MB |
| 20MB 随机 | 1323 ms（但漏掉全部 64 个命中之后的流） | 1817 ms |
| 5MB 随机 | 731 ms | 452 ms |

回归：`node tests/run.js` **294/294**（新增 13 项）；浏览器自检 **96/96**；`node tests/cdp-smoke.js` PASS。

## v0.17.0 分析搬进 Worker + 体验（2026-11-10）

| 项目 | 实现 | 验证 |
|---|---|---|
| Web Worker | 核心源码在单文件里只存一份（`<script id="core-src" type="text/js-worker">`），主线程 `new Function` 求值，Worker 用同一段文本建 blob；建不起来自动退回主线程 | CDP：`MDZ_DIAG.worker === 'on'`（file:// 下 blob worker 可用，已单独探针确认） |
| 结构化克隆 | `pcm.value` 是函数传不过去：Worker 里递归剔除函数，主线程用 `MDZ.audioPCMValue(pcm)` 按同一规则重建 | WAV fixture：波形 1274px、频谱 31×512 全绿（走的是 Worker 返回的结果） |
| 取消 | `#cancel` 按钮 → `worker.terminate()` + 丢弃挂起任务；状态栏旁显示 | 代码级（CDP 未做时序断言） |
| 批量 | 每个文件 `await analyzeAsync(...)`，界面全程可交互 | CDP 批量 2 个文件、50 上限用例全绿 |
| 批量导出模板 | 模板非 full 时按每份 `buildReport(tpl)` 输出，不再永远吐完整报告 | 代码级 |
| 批量失败原因 | 列表下方直接列出「文件名：原因」 | 代码级 |
| 复制/下载反馈 | `copyText` 返回布尔、`dl` 包 try/catch，失败会在状态栏说明 | 代码级 |
| PDF 增量更新 | 同一对象号只处理最后一次出现（PDF 语义是后者覆盖前者） | 单元：两个 `1 0 obj`，取到的是后一份 `flag{pdf_last_obj}` |

回归：`node tests/run.js` **296/296**；浏览器自检 **96/96**；`node tests/cdp-smoke.js` PASS（新增 Worker 断言）。
