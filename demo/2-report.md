# misc大手子 分析报告

- 文件：`2.png`
- 大小：60774 字节
- SHA-256：`412f2134de7b40c0ae5f102e36d3e7f8254745cc7b2050ec868d1a76c30656f8`
- 真身：JPEG / image/jpeg（扩展名 .png 与真身不符）
- 分析：2 个文件，6 条发现，1 个产物，5 ms

## 发现

| 层 | 置信度 | 标题 | 偏移 | 依据 |
|---|---|---|---|---|
| L1 | 98% | JPEG EOI 之后还有数据 | 0xeca1 | 尾部以 ZIP 签名开头 |
| L3 | 98% | XPComment = “this_is_password” | 0x10ca | Windows XP 标签常被出题人当备用信道/口令。 |
| L2 | 90% | ZIP 条目：flag.txt | 0x00 | 需要口令。可尝试 bkcrack（已知明文）或 john/hashcat（爆破）。 |
| L3 | 70% | EXIF 元数据（APP1） | 0x14 | IFD0/XPComment: this_is_password |
| L4 | 50% | 有损容器：不要直接扫 LSB |  | JPEG 的 DCT 量化会揉碎最低位。优先检查尾部附加、EXIF、APPn、缩略图；像素隐写走 steghide / outguess / F5。 |
| L3 | 30% | JFIF 头 | 0x02 | 密度/单位字段一般不是藏点，记录备查。 |

## 产物

- `jpeg-trailer.bin` — EOI 之后的数据（197 字节）

## 复现路径

- **JPEG EOI 之后还有数据**：从 0xeca1 切开
- **XPComment = “this_is_password”**：读取 EXIF XPComment (0x9c9c)
- **ZIP 条目：flag.txt**：bkcrack -C file.zip -c <已知条目>
- **EXIF 元数据（APP1）**：逐标签查看；XP* 为 UTF-16LE 字符串，常被用作口令
- **有损容器：不要直接扫 LSB**：steghide extract -sf file.jpg；或 stegseek 爆破

---
由 misc大手子生成；所有分析均在本地完成。