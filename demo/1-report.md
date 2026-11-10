# misc大手子 分析报告

- 文件：`1.png`
- 大小：2373353 字节
- SHA-256：`46915e5e7cdd6c12a71a950b4a7231b31a519f2db36ae995b6ab1682d9bdfc71`
- 真身：PNG / image/png
- 分析：3 个文件，5 条发现，3 个产物，2190 ms

## 发现

| 层 | 置信度 | 标题 | 偏移 | 依据 |
|---|---|---|---|---|
| L1 | 99% | IHDR chunk CRC 不匹配 | 0x08 | IHDR 的 CRC 通常对应原始宽高——可用「尺寸恢复」反推。 |
| L1 | 99% | IDAT 解压出的数据比 IHDR 声明的多 | 0x08 | 多出 4730005 字节。常见于：高度被改小、底下压着第二张图。 |
| L1 | 98% | IHDR 宽高可能被改过 | 0x08 | 用 IHDR 存储的 CRC 与/或 IDAT 解压长度反推出候选尺寸。 |
| L1 | 95% | IDAT 实际行数对应其它尺寸 | 0x08 | IDAT 解出 14253505 字节，按当前位深/颜色类型换算，行数不止声明的高度。即使 IHDR CRC 被重算，这里也会暴露。 |
| L3 | 60% | iTXt 文本块：XML:com.adobe.xmp | 0x53 | <?xpacket begin='﻿' id='W5M0MpCehiHzreSzNTczkc9d'?> |

## 产物

- `iTXt-XML:com.adobe.xmp.txt` — 来自 iTXt（1049 字节）
- `png-extra-scanlines.bin` — IHDR 声明之外的扫描行（4730005 字节）
- `png-extra-image-1587x745` — 多余扫描行按原宽反滤波 = 1587x745

## 复现路径

- **IHDR chunk CRC 不匹配**：重算 CRC 后另存副本
- **IDAT 解压出的数据比 IHDR 声明的多**：按原图宽度继续反滤波，或直接提取多余扫描行
- **IHDR 宽高可能被改过**：在「修复」面板选择候选尺寸，生成修复副本
- **IDAT 实际行数对应其它尺寸**：在修复面板选择 IDAT 长度推出的尺寸（可能未过 CRC）
- **iTXt 文本块：XML:com.adobe.xmp**：解析 iTXt 块

---
由 misc大手子生成；所有分析均在本地完成。