# misc大手子 v1.0.0

[English](README.md) · **中文**

本地、单文件、默认零网络的 CTF Misc 分析工具（可选启动本机工具桥）。已把 `CRC_CHECK/image-crc.html` 的校验/修复与 `crc_crack.py` 的短串反查合并进来。

打开方式：双击 `misc-dashouzi.html`，把文件拖进去。

- 自检：`misc-dashouzi.html?selftest=1`
- 内置演示：`misc-dashouzi.html?demo=1`（`demo=N` 选第 N 个内置样本）

> 仓库里这份是**无壁纸构建**（不内联任何第三方图片）；想在本机用带壁纸的版本，见文末「开发」。

## 它解决什么问题

从我们做过的 misc 题里归纳出的六层藏点，逐层做自动审计：

| 层 | 藏点 | 工具动作 |
|---|---|---|
| L0 身份 | 扩展名骗人、容器套娃 | 魔数识别、真身/扩展名比对 |
| L1 容器结构 | IEND/EOI 后附加、声明量撒谎、chunk/段重复、BMP 调色板夹缝 | 逐块/逐段解析，`declared vs actual` 对账 |
| L2 压缩流 | 双 zlib、`unused_data`、垫层、多 IDAT | 全文件扫流签名 + 精确 `consumed` 解压 |
| L3 元数据 | EXIF XP 字段、APP13 第二块 EXIF、缩略图、tEXt/iTXt/XMP、COM | 全段解析，不只读第一块 |
| L4 像素 | RGB/通道/位/顺序/打包/白底子集 LSB | 多维扫描 + 打分排序 + 位平面查看器 |
| L5 视觉 | 图里文字、代码雨、符号密码 | 位平面/产物预览，人工兜底 |

贯穿全部层的硬判据：**声明的量 ≠ 实际的量**。

## 当前图像预览（右栏）

分析台和节点编辑器右侧常驻一块「当前图像」，随修改实时重画：

- 分析完成 → 显示当前文件的图；
- 改 PNG/JPEG/BMP 的「自定义宽高」→ 输入时就把改过文件头的字节丢给浏览器解码，直接看画面（不用先下载再拖回来）；
- 节点编辑器里改参数/连线 → 显示输出节点的结果；
- 点面板上的 `⇥` 收起。窄窗口（<980px）自动隐藏。

## 版本说明页

顶栏第三个标签「版本说明」是独立页面：上面是当前能力总表（图像 / 压缩与容器 / 音频与流量 / 通用），
下面是逐版本更新记录，每版分「新增」与「修复」两栏，当前版本会高亮。内容来自 `src/76-changelog.js`。

## 文件头被削 / 开头多字节修复

出题人常把魔数第一个字节删掉（`89 50 4E 47…` → `50 4E 47…`），文件就认不出来了。现在：

- 未知格式会先试「补回前 1~3 字节」和「删掉前 1~3 字节」，用 `detectType` 复核，再做结构自检
  （PNG 看 IHDR、ZIP 看压缩方法与文件名长度、BMP 看 DIB 尺寸与 bfSize、JPEG 看 SOF、SQLite 看页大小…），
  避免两三个字节的巧合误报
- 支持 PNG 整个 8 字节签名被删（文件直接以 IHDR 的长度开头）
- 魔数里**只有一个字节被改错**（改文件头那一类题）也能识别：指出第几个字节、应该是多少
- 发现卡片上直接给「修复并分析」：补好的字节会下载一份，同时立刻放回分析台重新分析

## 内置替代了哪些外部工具

`companion.py` 是可选的本地工具桥，**不启动也能用**。对外部工具的取舍：

| 外部工具 | 现在 |
|---|---|
| zsteg | 位平面 / LSB 穷举扫描已内置 |
| binwalk | 流签名扫描 + 递归拆产物已内置 |
| exiftool | 元数据面板、EXIF 缩略图产物已内置 |
| zbarimg | **二维码解码已内置**（Otsu → 寻像图形 → 仿射采样 → 去掩码 → 拆交织 → 读段；不做 RS 纠错）；**一维条码也已内置** |
| xz / lzma | **LZMA 单独格式解压已内置**，扫描到就自动解压并递归分析 |
| steghide | 仍需外部程序（算法本身没法用 LSB 穷举代替） |
| bkcrack | 仍需外部程序（ZIP 条目列表已内置） |

## 能力清单

**PNG（深挖）**
- chunk 遍历、CRC 校验、结构错误定位
- IHDR 尺寸恢复：IHDR CRC 反推 + IDAT 解压长度约束
- 双 zlib / 多 IDAT / `unused_data` / 垫层偏移
- IDAT 多余扫描行（高度被改小、底下压着第二张图）
- tEXt / zTXt / iTXt 解码，值里的 hex / base58 / base64 二次编码自动解开
- 非标准 chunk 类型点名（`tXEt` 这类一字之差的伪块），连同块内明文一起报
- 坏 CRC 的 4 字节按 ASCII 拼读（`H1de_h3xd47a_1n_chunk_CRC` 型夹带）
- IEND 后附加数据提取
- PLTE 调色板：未使用颜色、重复颜色、PLTE 字节内明文
- Adam7 隔行 PNG：7 个 pass 逐段反滤波后重组，像素照常参与 LSB
- APNG：acTL/fcTL/fdAT 逐帧解码，每帧独立进扫描队列
- 修复副本：重算 CRC、按候选宽高重建 IHDR（不改原文件）

**JPEG（基础）**
- 段遍历、EOI 后附加、COM 注释、APPn 可疑字符串
- EXIF 全段：XP* UTF-16 标签、UserComment、GPS、IFD1 缩略图
- APP1/APP13/APPn 中的多块 EXIF 识别
- 明确提示：有损容器不要直接扫 LSB
- 尺寸自检（熵数据 MCU 计数）与自定义宽高

**BMP / GIF / ICO / SVG / ZIP（基础）**
- BMP：`bfSize` 对比、调色板→`bfOffBits` 夹缝、像素后附加；1/4/8-bit 调色板逐像素解码
- GIF：LZW 全解码、逐帧 LSB、隔行帧、注释/应用扩展、0x3B 后附加
- ICO：多帧拆分，PNG 帧递归分析并做 LSB
- SVG：内嵌 base64 图提取并递归分析、注释/文本节点
- ZIP：条目列表、加密标记、stored + deflate 条目提取，中央目录优先（数据描述符、method 14 LZMA）

**TIFF / WebP / 其它格式（基础）**
- TIFF：IFD/ExifIFD/GPS/IFD1 标签、内嵌 JPEG 提取、原始字符串兜底
- WebP：RIFF chunk 遍历、VP8X 画布、EXIF/XMP、ANIM/ANMF、RIFF 后附加
- TAR / RAR / 7Z / PDF：成员遍历与提取、RAR4/RAR5 文件表、7Z 未压缩文件表、PDF 对象/增量更新/内嵌文件/图片/JS
- 字体（sfnt 表）、SQLite（页结构）、ELF/PE（节表与 overlay）

**流水线**
- 递归分析（深度 ≤3，按 SHA-256 去重，产物上限可调）；LSB 提取出来的 ZIP/PNG 等容器也会自动接上拆包（位平面 → zip → 文本一条链走完）
- 内嵌容器雕刻：文件中间/尾部拼接的 zip/png/jpeg 切出来继续递归
- 每个发现附偏移、声明/实际、证据、复现步骤、可下载载荷
- 报告导出 Markdown（完整 / 速报 / WP 框架），批量也认模板

**分析与交互**
- 批量：多选/多拖，最多 50 个文件逐个分析；表格显示格式、发现数、flag、耗时，点行查看单项
- 递归树：按真实父子链展示容器嵌套（被 SHA 去重跳过的分支会单独成根）
- 双图对比：任意两张同尺寸图 XOR / 绝对差 / 差值，显示变化像素与最大差，可下载 PNG；批量时能跨文件选图
- 位平面查看器：缩放（按钮 / Ctrl+滚轮）、拖拽平移、适应 / 1:1、像素坐标与通道值读数
- LSB 提取参数面：通道序含 AGBR/ARGB/ABGR 等 A 打头的四位序，支持 bit1+bit2 多位组合，行序/列序 × MSB/LSB 打包
- **分析跑在 Web Worker 里**：大文件不冻界面，随时可取消；Worker 建不起来会自动退回主线程

**编码侦探 / 条码 / 画字 / 频域**
- 单层解码：hex / base64 / base32 / ascii85 / base91 / uuencode / URL / HTML 实体
- 自动解码链：最多 3 层；`rot13` / `rot47` / `atbash` 作为显式变换不进自动链
- **解出来不是文本而是文件时**（base64 的 PNG、hex 的 ZIP…）切成产物并继续递归
- 一维条码：EAN-13 / EAN-8 / Code128 / Code39，横向与竖向扫描线，靠校验位 / mod-103 / 起止星号压误报
- 二维码：1–40 版、L/M/Q/H、数字/字母/字节/汉字，旋转图也能读
- 画字检测：位平面里的"少数派"像素聚类后裁成黑白图（直接读，不做 OCR）
- 频域：2D FFT 幅度谱 + 前 6 个峰值（网格水印 / 周期噪声）

**节点编辑器 / 校验工坊**
- Blender 式节点图（15 种节点、拖拽连线、输出 PNG/BMP），来源含 GIF/APNG 帧与频域图
- PNG 逐 chunk CRC 表/重算/自定义宽高；JPEG 熵数据 MCU 自检 + 自定义宽高
- CRC32 文本计算与短串反查（默认 ≤4 位、15 秒上限）
- BMP 文件头/调色板/夹缝对账、自定义宽高、导出 24-bit BMP
- GIF 逐帧表 + 缩略图 + 单帧查看/下载/快扫；频谱图一键下载 PNG

**相邻载体**
- WAV：PCM 8/16/24/32-bit、逐采样/逐字节 LSB、波形、频谱（FFT 512/1024/2048）、Morse、LIST INFO/尾挂/多 data
- MP3：ID3v2.2/2.3/2.4 文本帧、APIC、ID3v1、帧表/Xing/LAME、帧头比特信道；波形与频谱由浏览器解码 PCM 后生成
- PCAP/PCAPNG：四种 magic、SHB/IDB/EPB/SPB、Ethernet/raw-IP/SLL/NULL、IPv4/IPv6、TCP 乱序重组、UDP、DNS、HTTP、**HTTP 对象提取**（Content-Length / chunked / multipart）、USB HID 键盘流量、ICMP/ICMPv6、TTL 异常、尾挂

## 使用注意

- **flag 格式**：默认只认 `flag{...}` / `ctf{...}` 这类「前缀{正文}」写法；换赛场时在侧栏改模板，`{}` 代表正文（ctfshow 的 PNG 隐写赛就填 `#{}#`）。设置存 localStorage，刷新后保留；自定义格式因为噪声大，只在我们自己解出来的上下文里认。
- **只读**：分析过程不修改输入文件；修复是生成新副本。
- **不上传**：全部在浏览器本地完成。
- **不支持**：JPEG DCT 隐写（steghide/outguess/F5）、口令爆破、WebP/TIFF 像素解码、GIF 帧按处置/透明规则合成（逐帧解码已支持）、超大文件（默认像素上限 6M，可调到 20M）。
- 双图对比要求两张图尺寸完全一致；不一致只给提示，不自动裁剪。对比按 8-bit 通道计算，16-bit 图只看低字节。
- 宽或高为 0 的图会被拒绝解码/跳过渲染，不会拖垮整批分析。
- companion 是可选组件：不启动时 HTML 不会发起任何网络请求；启动后页面只会连接本机回环地址，token 必填。
- 单次上传上限 32MB（浏览器侧）；companion 单次工具超时 60 秒、单次输出/产物有上限。
- 批量最多 50 个文件，所有结果都留在内存里；一次拖入很多大图会明显吃内存。
- 音频解码最多 500 万帧、LSB 扫描前 400 万采样（超过会在发现里提示）；频谱图按 1024 帧上限抽样。
- pcap 默认最多 10 万包、单流 8MB、产物 128 个/32MB；IPv6 分片暂不重组，ID3 加密帧不解码（压缩帧会尝试 inflate）。
- LSB 扫描有误报，结果按分数排序；低分候选请结合位平面人工确认。
- 16-bit PNG 的高字节平面会以 `Rhi/Ghi/Bhi` 参与扫描与查看；低字节仍是 `R/G/B`。
- 递归默认深度 3；因深度被丢弃的产物会计数并在发现里提示，不静默截断。
- PNG 修复副本会保留 IEND 之后的原始载荷（不会把尾挂数据修没）。
- 一维条码只处理正拍/扫描件（水平或竖直 90°），倾斜、透视、严重模糊的读不出。

## 外部工具桥（可选）

需要 Python 3.10+（本机 3.14 验证）。

**一键启动（推荐）**：双击 `start-companion.bat`（**全程无控制台窗口**，它会用 `launch-hidden.vbs` 把自己重新拉起来并隐藏；输出写进 `companion.log`）。它会

1. 首次运行时生成 `companion-token.txt`（之后每次复用同一个 token）
2. 把 token 复制到剪贴板（备用）
3. 把 `..\` 和 `..\steghide\` 加到 PATH（bkcrack / steghide 就放在工具目录旁边）
4. 用 `#t=<token>` 片段打开 `misc-dashouzi.html` —— 页面自动填入并自动连接（必须用 `file:///` URL，裸路径带 `#` 会被 `start` 当成文件名）
5. 启动 companion 监听 `127.0.0.1:8765`

**不用手动粘贴**：token 走 URL 片段，不经过网络、不进任何日志，页面读到后立刻用 `history.replaceState` 从地址栏抹掉；同时写入 localStorage，下次直接刷新也能自动带上。页面若抢在 companion 启动之前，会自动重试最多 6 次（约 3 秒）。

**服务跟着页面走**：页面每 20 秒发一次心跳（后台标签页被浏览器节流到约 1 次/分也够用），关闭页面时发 `POST /api/bye` 让 companion **立刻退出**；万一 bye 没发出去，`--exit-when-idle 120` 的空闲看门狗会在 120 秒后收摊，不会留下孤儿进程。

```bash
# 手动启动（等价）
python companion.py                     # 每次随机 token
python companion.py --token-file companion-token.txt   # token 存文件，跨次稳定
python companion.py --port 8765 --token "<随机长串>"
python companion.py --fake-tools        # 没装外部工具时用假实现验证 UI
```

页面里打开「外部工具」，填 URL（默认 `http://127.0.0.1:8765`）和 token，点「连接」即可。工具缺失会标红并禁用对应动作；没有 companion 时可以直接复制手动命令。

**所有外部动作都是手动按钮触发**——分析一个文件本身不会发起任何 companion 请求，只有点具体动作按钮才会调用。

安全边界：

- 只允许监听回环地址；传 `0.0.0.0` 会拒绝启动。
- 每次请求校验 `X-MDZ-Token`；token 至少 8 字符，默认随机生成。不要复用公开示例 token。
- CORS 只回显 `file://`（Origin `null`）或本机 `localhost/127.0.0.1` 页面；其他网站无法在浏览器里驱动工具。
- 只执行预定义动作，文件名先净化，参数用列表传递，不走 shell。
- 文件写入临时目录，工具结束即清理；单次上传 32MB、工具超时 60s、输出/产物有上限。
- 口令不会回显在命令展示里（显示为 `<PASSWORD>`）。

支持的编排动作：

| 工具 | 动作 |
|---|---|
| zsteg | 全扫、按表达式提取（RGB/BGR/RGBA、LSB/MSB、bit1/bit2） |
| binwalk | 签名扫描、自动提取（产物可递归分析） |
| exiftool | 全部元数据、缩略图/预览图 |
| steghide | 查看信息、带口令提取 |
| bkcrack | 列出 ZIP 条目（已知明文攻击用面板里的手动命令模板） |
| zbarimg | 二维码/条码（工具内已内置，仅作备用） |

## 开发

```bash
# 构建单文件（会同时生成 tests/fixtures）
python build.py

# 发布版：不内联壁纸（仓库里的成品就是这个）
python build.py --no-bg

# 回归测试（单元向量 + 76 个 fixture + 真实样本 + fuzz + 修复 + 音频/pcap/条码 + 对比/报告/递归树）
node tests/run.js

# 浏览器自检（当前 96 项）
msedge --headless=new --dump-dom "file:///.../misc-dashouzi.html?selftest=1"

# 浏览器冒烟（需要 Edge；验证自检、上传、位平面缩放、批量、双图对比、零尺寸、50 文件上限、Worker）
node tests/cdp-smoke.js

# 外部工具桥单元/HTTP/真实 exiftool 测试
python -m unittest tests.test_companion -v
```

想在本机用带壁纸的版本：把参考图放到 `.scratch/atri-bg.jpg`，跑不带 `--no-bg` 的 `python build.py`。
**壁纸是本地素材，不要连同成品一起上传或对外分发。**

源码按加载顺序拆分，`build.py` 负责内联（模块清单的唯一真理源是 `build.py` 的 `CORE_MODULES`，构建时导出 `tests/modules.json`）：

```
src/00-util.js      哈希、魔数、Finding/Artifact 数据结构
src/10-inflate.js   CRC32/Adler32/自带 DEFLATE（精确 consumed）
src/12-encode.js    编码侦探与解码链
src/13-lzma.js      LZMA 单独格式解压（纯 JS）
src/14-qr.js        二维码解码
src/15-bar.js       EAN-13 / EAN-8 / Code128 / Code39
src/20-png.js       PNG chunk/解码/尺寸恢复/修复/审计
src/30-jpeg.js      JPEG 段/EXIF/缩略图/审计
src/40-bmp.js       BMP 头/夹缝/像素解码
src/50-formats.js   GIF/ICO/SVG/ZIP/TIFF/WebP
src/52-carrier.js   字体 / SQLite / ELF / PE 审计
src/53-pdf.js       PDF 结构审计
src/55-archives.js  TAR / RAR / 7Z
src/60-scan.js      位平面/LSB 扫描与打分、渲染
src/62-audio.js     WAV/MP3 审计、音频 LSB、Morse、FFT 频谱
src/64-pcap.js      pcap/pcapng、TCP 重组、DNS/HTTP/USB/ICMP
src/65-diff.js      双图 XOR/绝对差/差值
src/66-spectrum.js  频域审计
src/70-analyze.js   递归流水线、报告模板、批量报告
src/75-companion.js 本机工具桥客户端、手动命令
src/76-changelog.js 版本说明数据
src/78-nodes.js     节点图求值
src/80-ui.js        拖拽、结果渲染、查看器、工具面板、自检
companion.py        可选的本地工具桥（stdlib，仅回环）
```

## 与开源工具的关系

- 位平面穷举的思路参考 [zsteg](https://github.com/zed-0xff/zsteg)，但本工具把结构审计与像素扫描放在同一条流水线里。
- PNG 修复思路与 [PCRT](https://github.com/sherlly/PCRT) 同源；本工具额外做双 zlib / `unused_data` / 多余扫描行。
- 浏览器内位平面查看参考 [StegOnline](https://github.com/Ge0rg3/StegOnline)，但本工具不依赖 Angular，单文件零依赖。
- 一站式对照可看 [AperiSolve](https://www.aperisolve.com/)，它是服务端聚合；本工具坚持本地与可定制判据。

## 已知边界

- JPEG DCT 隐写、ZIP/steghide 口令爆破、WebP/TIFF 像素解码、GIF 帧合成规则仍不做；GIF/APNG 只到逐帧解码。
- 双图对比要求同尺寸；不同尺寸只提示，不自动裁剪。
- 批量最多 50 个文件，全部结果驻留内存。
- 16-bit PNG 的 LSB 扫描按低字节/高字节拆成两个通道，报告里会显示 `R` / `Rhi`。
- 递归上限默认 64 个文件；超出会在发现里明确提示，不静默截断。
- 分数阈值是经验值，误报/漏报都可能在；报告保留原始偏移与证据，便于复核。
- 画在图里的明文（含位平面里画的字）不做 OCR：这类要看位平面查看器/图像预览自己读。
- 一维条码只处理正拍/扫描件（水平或竖直 90°），倾斜、透视、严重模糊的读不出；EAN-13/EAN-8/Code128/Code39 四种，其余码制（ITF、Codabar、PDF417 等）不做。

## 版本

v1.0.0（2026-11-10）— 首个正式版，功能冻结。相比 v0.17.0 没有功能变化：去掉 ATRI 壁纸（发布版不内联第三方图片）、补 LICENSE、整理文档。Node 回归 296 项、浏览器自检 96 项、CDP 冒烟全绿。
v0.17.0（2026-11-10）— 分析搬进 Web Worker（大文件不再冻住界面，可随时取消，建不起来自动退回主线程）；批量分析同样走 Worker；批量导出认报告模板；批量失败原因直接列出来；复制/下载失败会提示；PDF 增量更新改为取最后一份对象。Node 回归 296 项、浏览器自检 96 项、CDP 冒烟（含 Worker 断言）全绿。
v0.16.0（2026-11-10）— 四维审查（4 镜头初审 + 交叉对抗复核，47 条 → 确认 29）后的修复：两个死循环（7Z kName 长度、ID3 加密帧位置）、大文件后半段的压缩流不再被命中数预算饿死、已知格式解析失败退到通用兜底、PDF ASCII85 的 `<` 被当前缀删掉、音频/图像去重只看前缀、PNG 尺寸炸弹、GIF 帧数上限、WAV 整块复制、ascii/strings 逐字符拼串（50MB 文本 2.3 秒 + 1.6GB → 11 毫秒）。模块清单与版本号收敛到单一真理源并在构建时注入。Node 回归 294 项、浏览器自检 96 项、CDP 冒烟全绿。
v0.15.0（2026-11-10）— 一维条码（EAN-13/EAN-8/Code128/Code39，扫描线游程解码，横向竖向都试，靠校验位/mod-103/起止星号压误报）、PCAP 的 HTTP 对象提取（Content-Length / chunked / multipart 都切成独立产物）、编码链解出二进制时切成产物并继续递归。Node 回归 281 项、浏览器自检 96 项、CDP 冒烟全绿。
v0.14.0（2026-11-10）— 内嵌容器雕刻（zip/png/jpeg 切出来递归）、USB HID 键盘流量、ICMP 载荷、PDF predictor 图片、MP3 浏览器解码 PCM 后的波形/频谱；修 LSB 只打分前 4KB、设置改了不重算、拖放丢会话。Node 回归 263 项、浏览器自检 93 项、CDP 冒烟（含 MP3 频谱 253×512）全绿。
v0.13.0（2026-11-10）— 新格式：TAR（成员遍历+提取+递归）、PDF（对象/增量更新/内嵌文件/图片/JS）、RAR（RAR4/RAR5 文件表+stored 提取+加密检测）、7Z（未压缩文件表）、MP3（帧表/Xing/LAME/帧头比特信道）。Node 回归 256 项、浏览器自检 90 项、CDP 冒烟全绿。
v0.12.1（2026-11-10）— 九路审计后的第一批修复：默认扫描补 MSB（bit7）；ZIP 注释/空 ZIP/中央目录（数据描述符、method 14 LZMA）；零宽字符隐写；中文文本不再误判；gzip/zlib 校验失败保留明文；LZMA 启发式在 PE/字体上不再刷屏（notepad.exe 151→0、arial.ttf 67→0）。Node 回归 239 项、浏览器自检 85 项、CDP 冒烟全绿。
v0.12.0（2026-11-10）— 文件头修复 + 版本说明页：魔数首字节被删（或前几字节、整个 PNG 签名被删）也能认出原格式并一键补齐；开头多出字节也能识别并裁掉；发现卡片新增通用的「修复并分析」动作；顶栏加「版本说明」独立页面。Node 回归 235 项、浏览器自检 81 项、CDP 冒烟全绿。
v0.11.0（2026-11-09）— 不依赖 companion 的内置能力 + 当前图像预览：纯 JS 的 LZMA 单独格式解压与二维码识别；右栏常驻「当前图像」，改宽高/改节点参数时实时重画。手动命令面板标注了哪些能力已内置。Node 回归 221 项、浏览器自检 77 项、CDP 冒烟全绿。
v0.10.0（2026-11-09）— 尺寸反推与一键修复：BMP 按像素区长度反推宽高；JPEG 按 DRI 重启间隔的 MCU 总数分解宽高；GIF 检出 LZW 超出声明高度的「多余行」并按完整帧修复；PNG/BMP/JPEG/GIF 修复后自动下载并直接重新分析。CTFshow misc24–35 十二题回放全部通过。Node 回归 212 项、浏览器自检 75 项、CDP 冒烟全绿。
v0.9.0（2026-11-09）— 节点编辑器 + 校验工坊：Blender 式图像节点图（15 种节点、拖拽连线、输出 PNG/BMP）；合并 CRC_CHECK 的 PNG CRC 表/修复/自定义宽高与 JPEG 熵数据 MCU 自检；CRC32 计算与短串反查；BMP 文件头/调色板/自定义宽高/24-bit 导出；GIF 逐帧表；频谱图下载。
v0.8.0（2026-11-01）— 画字检测 / 频域 / 编码链 / 新载体：位平面画字自动定位并裁剪成图、2D FFT 幅度谱与峰值、hex·b64·b32·a85·b91·uu·url·html 自动解码链、字体/SQLite/ELF/PE 审计。
v0.7.0（2026-10-29）— PNG 隐写实战补齐：flag 格式可配；CRC 字段 ASCII 拼读、伪 chunk（`tXEt`）点名、元数据 hex/base58/base64 二次解码、LSB 通道序补 A 打头四位序与多位组合。验收用 ctfshow《One PieNG》18 flag 真题回放，见 VERIFICATION.md。
v0.6.0（2026-10-28）— LZMA 与部署：识别无魔数的 LZMA 单独格式（与 binwalk 同判据）；companion 新增内置 `lzma.decompress`；`start-companion.bat` 一键无窗口启动、token 走 URL 片段、服务随页面退出。
v0.5.1（2026-10-27）— UI：ATRI · 海边的旧校舍。浅色纸面 + ATRI 红 + 海玻璃青；功能不变。
v0.5.0（2026-10-27）— 相邻载体：WAV PCM/LSB/波形/频谱/Morse、MP3 ID3v2/ID3v1/APIC、PCAP/PCAPNG/TCP 重组/DNS/HTTP/TTL。
v0.4.0（2026-10-27）— 外部工具编排：可选本地 companion（zsteg/binwalk/exiftool/steghide/bkcrack），token + 回环地址 + 动作白名单。
v0.3.0（2026-10-27）— 分析与交互：批量分析、递归树、双图对比、位平面缩放平移与像素读数、报告模板。

## 许可证

MIT
