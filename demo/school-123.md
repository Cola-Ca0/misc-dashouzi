# 演示：school/123 三道隐写题

工具版本 v0.1.0 · 2026-10-26 · 三份原始报告见同级目录 `1-report.md` / `2-report.md` / `3-report.md`。

## 结论一览

| 题 | 真身 | 工具自动发现 | 人工判定 | flag |
|---|---|---|---|---|
| 隐写1 | PNG | IHDR CRC 不匹配；IDAT 解压数据比声明多 745 行；尺寸候选 1587x2245 | 高度被改小，修高度后底部露出 flag | `LitCTF{Fl4g_0fcourse!}` |
| 隐写2 | JPEG（扩展名 .png） | EOI 后附加数据；XPComment=`this_is_password`；附加 ZIP 内 `flag.txt` 加密 | 用 XPComment 当口令解 ZIP | `flag{ab32056rfanla12380asf13gpnsan}` |
| 隐写3 | PNG | IDAT 内有第二条 zlib 流；递归解出第二张图；第二图 LSB 命中 flag | 双流 + 隐藏图 LSB 两层 | `flag{LSB_is_so_easy}` |

## 隐写1：PNG 高度截断

工具输出（节选）：

```
L1 99%  IHDR chunk CRC 不匹配
L1 99%  IDAT 解压出的数据比 IHDR 声明的多
L1 98%  IHDR 宽高可能被改过 → 1587x2245（IDAT 长度 + IHDR CRC）
```

`1.png` 声明 1587x1500，实际 IDAT 解压出 2245 行。把 IHDR 高度改回 2245 后，底部露出签到 flag。修复后的底部就是 flag（题目原图不便随仓库分发，截图从略）。

## 隐写2：JPEG 尾挂 ZIP + EXIF 口令

工具输出（节选）：

```
L1 98%  JPEG EOI 之后还有数据（197 字节，以 ZIP 签名开头）
L3 98%  XPComment = “this_is_password”
L2 90%  ZIP 条目：flag.txt（ZipCrypto 加密）
```

这是典型的「三层误导」：扩展名是 .png、真身是 JPEG、真正的载荷在 EOI 之后；而 EXIF 的 XPComment 不是提示语，它就是口令。另外两个 XP 字段里的 `fanla12380` / `ab32056r` 是诱饵碎片。

## 隐写3：IDAT 双 zlib + 隐藏图 LSB

工具输出（节选）：

```
L2 99%  IDAT 内发现第二条 zlib 流 @0x29
        首流消费 222946 字节；第二流产出 876032 字节
L4 99%  LSB 候选：RGB bit0 row/msb/all（105 分）
        flag{LSB_is_so_easy}
```

PNG 解码器只读第一条 zlib 流，所以看图软件完全正常。工具用精确 `consumed` 找到第二条流，按 570x512 反滤波得到隐藏图，再对隐藏图做 RGB bit0 扫描，直接命中明文 flag。

## 复现

```bash
node tests/run.js
```

其中 `real 3.png` / `real 2.png` / `real 1.png` 三项就是本目录三道题的回归断言。
