/* misc大手子 — 76 版本说明数据
 * 给「版本说明」页提供结构化更新日志：每个版本新增了什么、修复了什么；再给一份当前能力总表。
 */
(function (root) {
  'use strict';
  const MDZ = root.MDZ = root.MDZ || {};

  const CAPABILITIES = [
    {
      group: '图像',
      items: [
        'PNG / JPEG / GIF / BMP / ICO 像素解码，LSB 按位、通道、顺序、打包方式穷举',
        'PNG chunk 与 CRC、双 zlib、多余扫描行、tEXt/zTXt/iTXt、PLTE、APNG；BMP 文件头/调色板/夹缝；GIF 逐帧；JPEG 段/EXIF/缩略图',
        '声明尺寸 ≠ 实际数据：PNG/BMP/JPEG/GIF 尺寸反推 + 一键修复',
        '画字检测、频域峰值、调色板隐写、双图对比、位平面查看器',
        '二维码识别（1–40 版、L/M/Q/H、数字/字母/字节/汉字）',
        '一维条码：EAN-13 / EAN-8 / Code128 / Code39（灰度扫描线 + 游程解码，正拍或竖拍都认）',
        'Blender 式节点编辑器：通道/位平面/灰度/反色/阈值/量化/重排/裁剪/缩放/XOR/差值/频域/调色板',
        '右栏「当前图像」：分析结果、节点输出、改宽高时实时重画'
      ]
    },
    {
      group: '压缩与容器',
      items: [
        'zlib / gzip / LZMA 解压，扫到就自动解压并递归分析',
        'ZIP 条目遍历（stored / deflate）、注释、尾挂',
        '字体 sfnt 表、SQLite 页结构、ELF/PE 节表与 overlay',
        '文件头被削 / 开头多出字节的猜测与一键修复'
      ]
    },
    {
      group: '音频与流量',
      items: [
        'WAV：PCM 8/16/24/32bit、逐采样与逐字节 LSB、波形、FFT 频谱、Morse',
        'MP3：ID3v2.2/2.3/2.4 文本帧、APIC、ID3v1、数据区字符串',
        'PCAP / PCAPNG：TCP 乱序重组、DNS、HTTP、TTL 异常、流产物',
        'HTTP 对象提取：Content-Length / chunked / multipart 三种 body 都切成独立产物'
      ]
    },
    {
      group: '通用',
      items: [
        '魔数识别 + 扩展名对账（真身与扩展名不符时点名）',
        'strings / UTF-16 扫描、编码自动链（hex/base64/base32/base85/base91/uu/URL/HTML）；解出来是文件就切产物',
        'flag 模板可改、自动汇总；报告导出（完整/速报/WP）',
        '批量最多 50 个文件、递归 3 层（可在设置里调，最多 64 个文件）、深度扫描',
        '分析在 Web Worker 里跑：大文件不卡界面，随时可取消；Worker 建不起来会自动退回主线程'
      ]
    }
  ];

  const CHANGELOG = [
    {
      version: '1.0.0', date: '2026-11-10', title: '首个正式版',
      added: [
        '功能冻结：图像（PNG/JPEG/GIF/BMP/ICO/SVG）、音频（WAV/MP3）、流量（PCAP/PCAPNG）、容器（ZIP/TAR/RAR/7Z/PDF）、编码与条码，覆盖到这里为止',
        '发布版为无壁纸构建：单文件 900KB，不内联任何第三方图片素材',
        '回归：Node 296 项、浏览器自检 96 项、Edge CDP 冒烟（含 Worker 断言）'
      ],
      fixed: []
    },
    {
      version: '0.17.0', date: '2026-11-10', title: '分析搬进 Worker + 批量/导出体验',
      added: [
        '分析改在 Web Worker 里执行：20MB 文件也不再冻住标签页，状态栏旁边有「取消」随时终止',
        'Worker 建不起来（老浏览器、被 CSP 拦住）会自动退回主线程，功能不受影响',
        '核心源码在单文件里只存一份：主线程和 Worker 共用同一段文本，体积不翻倍',
        '批量分析同样走 Worker，逐个文件推进，界面全程可交互',
        '批量导出认「报告模板」：选速报/WP 就按对应模板逐份输出，不再永远吐完整报告',
        '批量失败的文件在列表下方直接列出原因，不用再靠鼠标悬停',
        '复制失败、下载失败会明说，不再无条件显示「已复制」'
      ],
      fixed: [
        'PDF 增量更新按对象号去重时保留的是第一份（旧对象），和提示里说的「取最后一份」相反'
      ]
    },
    {
      version: '0.16.0', date: '2026-11-10', title: '审查修复：两个死循环 / 大文件漏检 / 内存爆炸',
      added: [
        '大文件压缩流不再被「命中数预算」饿死：改成按解出的字节数计预算，内嵌 zip/png/jpeg 完全不占预算；1.2MB 载体里 1.1MB 处的 zlib 流以前会被跳过',
        '已知格式解析失败会退到通用兜底：BMP/PNG 头被改坏时仍会跑 strings / 编码链 / 零宽，明文 flag 不会再被吞掉',
        '音频 LSB 去重改成「先打分、再按首尾+长度去重」，长静默前缀不会再把后面真正的载荷顶掉',
        '图像帧去重同样改成首尾各 8K + 长度，同尺寸且上半张相同的帧不再被当成重复',
        '模块加载顺序与版本号各自收敛到单一真理源：build.py 的 CORE_MODULES + 00-util.js 的 VERSION，构建时注入顶栏'
      ],
      fixed: [
        '7Z 的 kName 长度不夹到文件尾 → 64 字节的构造文件就能让分析死循环',
        'ID3v2 加密帧分支不推进位置 → MP3 改一个字节就让分析死循环',
        'PDF 的 ASCII85 流里只要出现 `<`（字母表本身就有），整段数据会被当成前缀删掉',
        'PNG 声明尺寸炸弹：260KB 文件能撑到 1GB 内存，现在按像素数与像素字节数提前拒绝',
        'GIF 逐帧全解码没有上限：100 帧要 13 秒 / 314MB，现在限制 64 帧 / 3200 万像素并提示跳过了多少',
        'WAV 先把整个 data 块复制一遍再裁到 500 万帧，100MB 音频白拷贝 80MB',
        'ASCII / strings / utf16strings 逐字符拼串：50MB 文本 2.3 秒 + 1.6GB 堆，换成 TextDecoder 后 11 毫秒',
        '版本说明页写「递归 64 层」，实际默认 3 层（64 是文件数上限）',
        '假签名刷屏：gzip 头按 RFC 1952 校验、PNG 要求 8 字节全签名、JPEG 的 SOI 后要有自洽段链、切出来的容器先验结构——随机数据不再产生成串的假产物',
        '压缩流改成 64KB 探针 + 全局限时/字节预算：大文件既能扫到尾部，又不会把时间花在几千个假 zlib 头上'
      ]
    },
    {
      version: '0.15.0', date: '2026-11-10', title: '一维条码 / HTTP 对象 / 编码载荷落盘',
      added: [
        '一维条码：EAN-13 / EAN-8 / Code128 / Code39。灰度扫描线 → Otsu 二值化 → 游程量化 → 符号表查表，横向与竖向都试',
        '条码解码带强校验：EAN 校验位、Code128 mod-103、Code39 起止星号，误报基本不可能',
        '编码侦探解出二进制时不再丢弃：base64/hex 解出 PNG/ZIP/PDF 之类，自动切成产物并继续递归分析',
        'PCAP 的 HTTP 对象：按 Content-Length / Transfer-Encoding: chunked / multipart 边界切出真正的 body，文件名取 Content-Disposition'
      ],
      fixed: [
        '编码侦探只看 4096 字符以内的串，超长 base64 载荷整段漏掉（放宽到 64K）'
      ]
    },
    {
      version: '0.14.0', date: '2026-11-10', title: '雕刻 / USB / ICMP / PDF predictor / MP3 频谱',
      added: [
        '内嵌容器雕刻：文件中间或尾部拼接的 zip/png/jpeg 直接切出来，作为产物继续递归分析',
        'USB HID 键盘流量：linktype 189/220/249 自动试多个报文偏移，还原键入内容',
        'ICMP / ICMPv6 载荷：不再整包丢弃，可疑载荷进产物与 flag 汇总',
        'PDF 的 PNG 系 predictor（10–15）图片能正常还原成 PNG',
        'MP3 波形 / 频谱：用浏览器原生解码 PCM，复用 WAV 那一套（含频谱 PNG 下载）',
        'JPEG 熵数据尾部：MCU 解完之后、EOI 之前剩下的字节作为发现 + 产物'
      ],
      fixed: [
        'LSB 打分只看前 4KB → 放宽到 64KB，靠后的载荷不再漏',
        '改 flag 模板 / 深度扫描 / 像素上限后结果不重算，界面停在旧结论',
        '文件拖到页面别处会让浏览器导航走、把当前会话清空',
        '短魔数（ICO/TIFF/RAR）被零填充误判成「单字节改错」'
      ]
    },
    {
      version: '0.13.0', date: '2026-11-10', title: 'TAR / PDF / RAR / 7Z / MP3',
      added: [
        'TAR：成员遍历 + 全部成员直接取出（TAR 本身不压），GNU 长文件名 / PAX 扩展都认，内嵌容器自动递归',
        'PDF：对象扫描、增量更新（多个 %%EOF）、内嵌文件提取、图片（DCT 原样 / Flate 拼回 PNG）、/JS 片段',
        'RAR：RAR4/RAR5 头解析、文件表、加密检测；stored（不压缩）成员直接取出',
        '7Z：签名头 + 未压缩文件表解析（文件名/数量）；压缩头明确提示用 7z l',
        'MP3：帧表（码率/采样率/帧数/时长）、Xing/Info/LAME、帧头 private/copyright/original/padding 位信道还原'
      ],
      fixed: []
    },
    {
      version: '0.12.1', date: '2026-11-10', title: '九路审计后的第一批修复',
      added: [
        '默认扫描补上 MSB（bit7）组合，不再只有勾「深度扫描」才看得到',
        'ZIP 注释（EOCD comment）与空 ZIP 识别，注释直接进产物、参与 flag 汇总',
        'ZIP 改为优先读中央目录：数据描述符（bit 3）条目能正常列出与解压，method 14（LZMA）也能解',
        '零宽字符隐写识别：U+200B/200C/200D 等按常见映射还原成字节',
        '中文/emoji 文本不再被当成未知格式（按 UTF-8 严格解码判文本）'
      ],
      fixed: [
        'gzip/zlib 校验失败（CRC 被改、截断）时不再丢弃已解出的明文',
        'LZMA 启发式在 PE / 字体等二进制上刷屏：实测 notepad.exe 假发现 151→0、arial.ttf 67→0，真 LZMA 流仍照常解压',
        '顶层 gzip 解出二进制/容器时不再被可打印率过滤吞掉',
        'LSB 产物是 gzip / xz / bzip2 / tar 时也会继续递归拆'
      ]
    },
    {
      version: '0.12.0', date: '2026-11-10', title: '文件头修复 + 版本说明页',
      added: [
        '文件头被削检测：魔数首字节（或前几个字节、整个 PNG 签名）被删掉也能认出原格式，给出「修复并分析」一键补回',
        '开头多出字节也能识别：跳过杂质后判断真实格式，一键裁掉多余前缀',
        '独立的「版本说明」页：能力总表 + 逐版本新增/修复记录'
      ],
      fixed: [
        '发现卡片支持通用 repair 动作，后续任何「能修的东西」都能一键修复并重新分析'
      ]
    },
    {
      version: '0.11.0', date: '2026-11-09', title: '内置 LZMA / 二维码 + 当前图像预览',
      added: [
        '纯 JS 的 LZMA 单独格式解压：扫描到自动解压、可读就进递归队列',
        '二维码识别：Otsu 二值化 → 寻像图形 → 仿射采样 → 去掩码 → 拆交织 → 读段，旋转图也能读',
        '右栏「当前图像」常驻预览，改宽高/节点参数实时重画',
        '手动命令面板标注哪些能力已内置，只剩 steghide / bkcrack 需要 companion'
      ],
      fixed: [
        'LZMA 原长未知时靠结束标记收尾，不再多解出几个字节',
        '二维码竖直校验的单元数错误（会把真寻像图形筛掉）'
      ]
    },
    {
      version: '0.10.0', date: '2026-11-09', title: '尺寸反推与一键修复',
      added: [
        'BMP 按像素区实际长度反推宽高：只改高度 / 只改宽度 / 都改，三组候选',
        'JPEG 按 DRI 重启间隔的 MCU 总数分解宽高',
        'GIF 检出 LZW 超出声明高度的「多余行」，按完整帧修复',
        'PNG/BMP/JPEG/GIF 修复后自动下载并直接重新分析'
      ],
      fixed: [
        'Node 的 Buffer.slice() 是共享视图，会改到输入字节；统一改成 new Uint8Array',
        'JPEG 候选宽度落在末个 MCU 内时要保留声明值（900 不是 904）',
        'GIF 的 LZW 原先按 w*h 截断，多余行永远看不到'
      ]
    },
    {
      version: '0.9.0', date: '2026-11-09', title: '节点编辑器 / CRC / BMP / GIF 逐帧',
      added: [
        'Blender 式图像节点编辑器，拖拽连线、输出 PNG/BMP',
        '合并 CRC_CHECK：PNG 逐 chunk CRC 表与重算、JPEG 熵数据 MCU 自检、自定义宽高',
        'CRC32 计算与短串反查（字符集/长度/前后缀/超时熔断）',
        'BMP 面板：文件头/DIB/调色板色块/像素区/夹缝，导出 24-bit',
        'GIF 逐帧表 + 单帧查看/PNG/BMP/LSB；频谱图导出 PNG'
      ],
      fixed: [
        '节点 source 没有输出口导致默认连线查不到端点',
        'UI 误用核心模块的 hex()，浏览器报 hex is not defined'
      ]
    },
    {
      version: '0.8.0', date: '2026-11-01', title: '画字 / 频域 / 编码链 / 新载体',
      added: [
        '位平面画字自动定位并裁成可下载的图',
        '2D FFT 幅度谱与峰值定位',
        'hex/base64/base32/base85/base91/uu/URL/HTML 自动解码链（最多 3 层）',
        '字体、SQLite、ELF、PE 结构与尾部夹带审计'
      ],
      fixed: [
        '字体表目录偏移多加 12 导致「表越界」',
        'flag 正则贪婪导致两个 flag 连成一条'
      ]
    },
    {
      version: '0.7.0', date: '2026-10-29', title: 'One PieNG 反哺',
      added: [
        '坏 CRC 字段按 ASCII 拼读',
        '非标准 chunk 类型点名（tXEt 这类一字之差的伪块）',
        '元数据 hex / base58 / base64 二次解码',
        'A 开头的四位通道序、多位组合（bit1+bit2）、行/列 × MSB/LSB'
      ],
      fixed: [
        '默认 flag 格式只认 flag{...}，自定义模板下加「正文得像词」的判据防噪声'
      ]
    },
    {
      version: '0.6.0', date: '2026-10-28', title: 'LZMA 识别与 companion 部署',
      added: [
        '无魔数 LZMA 单独格式识别（属性字节 + 字典大小判据）',
        'companion 内置 lzma.decompress',
        'start-companion.bat 一键无窗口启动、token 片段注入、页面关闭即退出'
      ],
      fixed: [
        'bat 必须 CRLF + 纯 ASCII；start 对 #fragment 要 file:/// URL'
      ]
    },
    {
      version: '0.5.1', date: '2026-10-27', title: 'ATRI · 海边的旧校舍 UI',
      added: ['浅色纸面 + ATRI 红 + 海玻璃青主题，侧栏头图与壁纸'],
      fixed: []
    },
    {
      version: '0.5.0', date: '2026-10-27', title: '相邻载体：音频与流量',
      added: [
        'WAV 波形/频谱/LSB/Morse，WAVE_FORMAT_EXTENSIBLE',
        'MP3 ID3 各版本与 APIC',
        'PCAP/PCAPNG 解析与 TCP 重组'
      ],
      fixed: [
        'pcapng SHB BOM 判反导致真实 LE 文件 0 包',
        '10 万包上限触发后剩余字节被当成尾挂'
      ]
    },
    {
      version: '0.4.0', date: '2026-10-27', title: '外部工具编排',
      added: [
        '可选 companion 本地工具桥（zsteg/binwalk/exiftool/steghide/bkcrack/zbarimg）',
        '手动命令面板与一键复制'
      ],
      fixed: ['超时要杀进程树，否则清理异常会覆盖 504 并泄露路径']
    },
    {
      version: '0.3.0', date: '2026-10-27', title: '批量 / 对比 / 报告',
      added: [
        '批量 50 个文件、递归树、双图对比（XOR/绝对差/差值）、报告模板'
      ],
      fixed: [
        '零宽 BMP 让 ImageData 抛异常并卡死整批',
        '旧世代按钮在换文件后仍可点，会套用错尺寸'
      ]
    },
    {
      version: '0.2.0', date: '2026-10-27', title: '容器与像素深挖',
      added: [
        'GIF LZW 逐帧、Adam7 隔行 PNG、PLTE 未使用色、BMP 1/4bit、APNG、TIFF/WebP 元数据'
      ],
      fixed: ['1/2/4-bit PNG 忽略逐行字节对齐，第二行起全错']
    },
    {
      version: '0.1.0', date: '2026-10-26', title: '六层审计骨架',
      added: ['L0 身份 / L1 结构 / L2 压缩流 / L3 元数据 / L4 像素 / L5 视觉 的自动审计流水线'],
      fixed: []
    }
  ];

  Object.assign(MDZ, { CHANGELOG, CAPABILITIES });
})(typeof globalThis !== 'undefined' ? globalThis : this);
