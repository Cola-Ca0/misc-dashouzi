# misc大手子 分析报告

- 文件：`3.png`
- 大小：528177 字节
- SHA-256：`b9827ece2fb13a011e02f46ce8927ad9d96deafde5fdf15a1aa8d1f415c88c9e`
- 真身：PNG / image/png
- 分析：2 个文件，3 条发现，4 个产物，564 ms

## 疑似 flag

```
flag{LSB_is_so_easy}
```

## 发现

| 层 | 置信度 | 标题 | 偏移 | 依据 |
|---|---|---|---|---|
| L2 | 99% | IDAT 内发现第二条 zlib 流 | 0x36717 | 第二条流紧贴第一条。 |
| L4 | 99% | LSB 候选：RGB bit0 row/msb/all（105 分） |  | 证据：flag 正则；熵 2.51 |
| L4 | 99% | LSB 候选：RGB bit0 row/msb/nearWhite（105 分） |  | 证据：flag 正则；熵 2.15 |

## 产物

- `png-second-stream.bin` — IDAT 内的第二条流（876032 字节）
- `png-second-stream-image-570x512` — 按原图宽 570 反滤波得到 570x512（876032 字节）
- `lsb-RGB-b0-row-msb-all.bin` — LSB 候选（105 分）（109440 字节）
- `lsb-RGB-b0-row-msb-nearWhite.bin` — LSB 候选（105 分）（71798 字节）

## 复现路径

- **IDAT 内发现第二条 zlib 流**：在 IDAT 数据 +0x366e2 处 inflate
- **LSB 候选：RGB bit0 row/msb/all（105 分）**：按 RGB 通道、bit0、row 序、msb 打包提取
- **LSB 候选：RGB bit0 row/msb/nearWhite（105 分）**：按 RGB 通道、bit0、row 序、msb 打包提取，仅取 nearWhite 像素

---
由 misc大手子生成；所有分析均在本地完成。