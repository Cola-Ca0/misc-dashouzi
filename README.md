# misc-dashouzi · misc大手子 v1.1.0

**English** · [中文](README.zh-CN.md)

A single-file, zero-dependency, offline-by-default CTF **misc** analysis tool. Double-click the HTML, drop a file in. Nothing to install, no server, no telemetry.

```bash
# Get it
curl -LO https://github.com/Cola-Ca0/misc-dashouzi/releases/latest/download/misc-dashouzi.html
# or just download the asset from Releases and open it in a browser
```

- Self-test: `misc-dashouzi.html?selftest=1`
- Built-in samples: `misc-dashouzi.html?demo=1` (`demo=N` picks the N-th sample)

> The UI is in Chinese (the author's working language). The analysis output — offsets, declared vs. actual values, hex, notes — is readable regardless.

---

## The idea: six layers, one hard rule

Every misc challenge we solved fell into one of six hiding layers. The tool audits all of them in one pass:

| Layer | Where it hides | What the tool does |
|---|---|---|
| L0 identity | Lying extensions, container-in-container | Magic-number detection, real type vs. extension |
| L1 structure | Data after IEND/EOI, lying length fields, duplicate chunks, BMP palette gap | Chunk/segment walk with `declared vs actual` reconciliation |
| L2 compressed streams | Double zlib, `unused_data`, padding, multiple IDATs | Whole-file signature scan + exact-`consumed` inflate |
| L3 metadata | EXIF XP fields, second EXIF in APP13, thumbnails, tEXt/iTXt/XMP, COM | Full segment parse — not just the first block |
| L4 pixels | RGB / channel / bit / order / packing LSB | Multi-dimensional scan + scored ranking + bit-plane viewer |
| L5 visual | Text drawn in the image, code rain, symbol ciphers | Bit-plane and artifact preview, human in the loop |

One rule runs through all six: **declared quantity ≠ actual quantity**.

## What it covers

**Images** — PNG / JPEG / GIF / BMP / ICO / SVG / TIFF / WebP / TGA / PSD / PCX (baseline TIFF pixels: raw / PackBits / LZW / Deflate, predictor 2)
- PNG: chunks, CRC, dimension recovery from IHDR-CRC and IDAT length, double zlib, extra scanlines, tEXt/zTXt/iTXt (with nested hex/base58/base64), palette (PLTE) analysis, Adam7, APNG frames, fake chunk names one letter off, ASCII in broken CRC fields, data after IEND
- JPEG: segments, EXIF (all XP\* tags, UserComment, GPS, IFD1 thumbnail), multiple EXIF blocks, entropy-data MCU self-check
- BMP / GIF / ICO / SVG: header-vs-file-size reconciliation, palette gap, per-frame LZW decode, interlaced frames, embedded base64 images
- LSB: every channel order (including A-first four-channel orders), bit1+bit2 combinations, row/column order, MSB/LSB packing — scored and ranked
- Drawn-text detection and 2D FFT spectrum (grid watermarks, periodic noise, frequency-domain hiding)

**Codes** — QR (versions 1–40, L/M/Q/H, byte/numeric/alnum/kanji) and 1D barcodes (**EAN-13, EAN-8, Code128, Code39**) — decoded in-tool, no zbarimg needed. Barcode decoding is validated by check digit / mod-103 / start-stop characters, so it fails closed rather than producing garbage.

**Repairs** — the part that saves the most time
- **Damaged magic**: first byte deleted, first few bytes deleted, or one byte wrong. The tool guesses the format, verifies structurally, and offers "repair and re-analyze" — the original file is never modified
- **Lying dimensions**: BMP (pixel-region length ÷ aligned row width), JPEG (SOF sampling × DRI restart intervals → MCU count → factor pairs), PNG (IHDR CRC / IDAT length), GIF (LZW decodes more rows than declared). One click rewrites the header and re-analyzes

**Audio** — WAV (PCM 8/16/24/32-bit, per-sample and per-byte LSB, waveform, FFT spectrum, Morse, DTMF), MP3 (ID3v2.2/2.3/2.4, APIC, ID3v1, frame-header bit channels), FLAC (STREAMINFO, Vorbis comments, PICTURE, APPLICATION, non-zero PADDING)

**Traffic** — PCAP / PCAPNG: TCP reassembly across reordering and wraparound, DNS, HTTP, **HTTP object extraction** (Content-Length / chunked / multipart → separate artifacts), USB HID keyboard traffic, ICMP/ICMPv6 payloads, TTL anomalies, trailing data

**Containers** — ZIP (central directory, data descriptors, method 14 LZMA, ZIP64), TAR, RAR (RAR4/RAR5 file tables, stored extraction), 7Z (LZMA/LZMA2 members, Delta/x86 BCJ, compressed headers), bzip2, XZ (LZMA2 + Delta), MP4/MOV box trees, OLE2 compound documents (stream extraction), PDF (objects, incremental updates, embedded files, images, /JS, Flate/ASCII85/LZW filters). Embedded containers found mid-file are carved out and analyzed recursively.

**Encoding** — an in-page codec toolbox: Base16/32/36/45/58/58Check/62/64/64URL/85/85(IPv6)/Z85/91/92/100, binary/octal/decimal bytes, URL, HTML entities, quoted-printable, Unicode escapes, UUencode, ROT13/47, Atbash, Morse, Bacon, A1Z26 — encode and decode both ways. Custom Base alphabets are supported (bit-stream for 2/4/8/16/32/64-char tables, big-integer otherwise). **Encoding brute force** runs every decoder plus ROT1–25/Atbash, six common custom tables, two-layer combinations and the 3-level auto chain, then ranks by readability and flag hits. Everything runs in-page with no companion bridge.

**Everything else** — font tables (sfnt), SQLite B-tree row scanning (UTF-8/UTF-16, overflow pages, `sqlite-rows.txt`), Git loose objects and packfiles (OFS_DELTA + REF_DELTA via SHA-1 index, including bases stored later), ELF/PE/Mach-O sections and overlays, Windows shortcuts (LNK), zero-width / Unicode-Tag / variation-selector steganography, recursive analysis with SHA-256 dedup, batch of 50 files, Markdown report export (full / brief / WP template).

## UI highlights

- **Live image preview** in the right column: re-renders as you edit dimensions or rewire the node graph — no download-and-redrag
- **Node editor** (Blender-style): channel / bit-plane / grayscale / invert / threshold / quantize / reorder / crop / scale / XOR / diff / FFT / palette → PNG or BMP
- **Analysis runs in a Web Worker**: a 20 MB file doesn't freeze the tab, and there's a Cancel button; if a Worker can't be created it silently falls back to the main thread
- **Version notes page** built into the app (capability matrix + per-version changes)

## Built in, not shelled out

The optional `companion.py` bridge is **not required**. What used to need external tools:

| External tool | Status |
|---|---|
| zsteg | Bit-plane / LSB exhaustive scan — built in |
| binwalk | Stream signature scan + recursive carving — built in |
| exiftool | Metadata panel, EXIF thumbnail artifacts — built in |
| zbarimg | QR decode — built in |
| xz / lzma | LZMA-alone decompression — built in |
| steghide | Still external (its algorithm can't be replaced by LSB brute force) |
| bkcrack | Still external (ZIP entry listing is built in) |

## Usage notes

- **Flag format**: defaults to `flag{...}` / `ctf{...}` style (`prefix{body}`). Change the template in the sidebar for other competitions — `{}` is the body (`#{}#` for `#abc#`). Stored in localStorage. Custom formats are only trusted in contexts the tool itself decoded, to avoid noise.
- **Read-only**: input files are never modified; repairs produce a new copy.
- **No upload**: everything happens in the browser.
- **Limits**: 32 MB upload, 50 files per batch, recursion depth 3 (64 files), pixel cap 6M (configurable to 20M), 4M audio samples scanned, 100k packets / 8 MB per stream in PCAP. Every limit that truncates something says so in the findings — no silent cuts.
- **Not supported**: JPEG DCT steganography (steghide/outguess/F5), password cracking, WebP pixel decoding (TIFF baseline is supported), GIF frame compositing (per-frame decode is supported), skewed/perspective barcodes.

## Optional companion (steghide / bkcrack)

Requires Python 3.10+. Start with `start-companion.bat` (runs windowless, writes `companion.log`) or manually:

```bash
python companion.py                     # random token each run
python companion.py --token-file companion-token.txt
python companion.py --fake-tools        # stub tools, for UI testing
```

Security boundaries: loopback only, `X-MDZ-Token` on every request, CORS limited to `file://` and localhost pages, predefined actions only, arguments passed as lists (never through a shell), temp directory wiped afterwards.

## Development

```bash
python build.py            # inline src/ into the single HTML, regenerate fixtures
python build.py --no-bg    # release build without the wallpaper image
node tests/run.js          # 508 checks
node tests/cdp-smoke.js    # Edge CDP smoke (needs Edge)
```

Source is split by load order and inlined by `build.py`:

```
src/00-util.js      hashing, magics, Finding/Artifact types
src/10-inflate.js   CRC32/Adler32, own DEFLATE with exact `consumed`
src/12-encode.js    encoding detective and decode chain
src/13-lzma.js      LZMA-alone decompressor (pure JS)
src/14-qr.js        QR decoder
src/15-bar.js       EAN-13 / EAN-8 / Code128 / Code39
src/20-png.js       PNG chunks / decode / dimension recovery / repair
src/30-jpeg.js      JPEG segments / EXIF / thumbnails
src/40-bmp.js       BMP header / gap / pixel decode
src/50-formats.js   GIF / ICO / SVG / ZIP / TIFF / WebP / TGA / PSD / PCX
src/52-carrier.js   font / SQLite rows / Git / Java class / ELF / PE / LNK / OLE audits
src/53-pdf.js       PDF structure audit
src/55-archives.js  TAR / RAR / 7Z / bzip2 / ISO9660 / MP4
src/60-scan.js      bit-plane / LSB scanning and scoring
src/62-audio.js     WAV / MP3 / FLAC, audio LSB, Morse, DTMF, FFT
src/64-pcap.js      pcap/pcapng, TCP reassembly, DNS/HTTP/USB/ICMP
src/70-analyze.js   recursive pipeline, reports
src/80-ui.js        UI, viewer, node editor, self-test
```

## Release history

| Version | Date | Highlights |
|---|---|---|
| **1.1.0** | 2026-11-19 | Codec toolbox (custom Base alphabets, brute force), PSD/SQLite/Git/FLAC/ISO9660/MP4/Java/PCX/TIFF, XZ/LZMA2 (multi-block, Delta, x86 BCJ, CRC32/64/SHA-256), Mach-O incl. fat_arch_64 |
| **1.0.0** | 2026-11-10 | First stable release. Feature freeze; wallpaper removed from the build; MIT license |
| 0.17.0 | 2026-11-10 | Analysis moved into a Web Worker (+ cancel, auto-fallback); batch respects report template |
| 0.16.0 | 2026-11-10 | Four-lens code review fixes: two infinite loops, large-file scan starvation, memory blowups, PDF ASCII85 bug; `ascii/strings` rewritten (50 MB text: 2.3 s/1.6 GB → 11 ms/0 MB) |
| 0.15.0 | 2026-11-10 | 1D barcodes, HTTP object extraction, binary payloads from the decode chain |
| 0.14.0 | 2026-11-10 | Embedded container carving, USB HID, ICMP, PDF predictors, MP3 spectrum |
| 0.13.0 | 2026-11-10 | TAR / PDF / RAR / 7Z / MP3 |
| 0.12.x | 2026-11-10 | Damaged-header repair, zero-width steganography, ZIP central directory |
| 0.11.0 | 2026-11-09 | Built-in LZMA and QR decoding, live image preview |
| 0.10.0 | 2026-11-09 | Dimension recovery and one-click repair (BMP/JPEG/GIF/PNG) |
| 0.5–0.9 | 2026-10 | WAV / MP3 / PCAP carriers, external tool bridge, node editor, encoding chain |

The in-app **版本说明 (version notes)** page carries the full per-release changelog.

## Credits

- Bit-plane brute force inspired by [zsteg](https://github.com/zed-0xff/zsteg); this tool puts structural auditing and pixel scanning in one pipeline.
- PNG repair ideas share lineage with [PCRT](https://github.com/sherlly/PCRT); this tool adds double-zlib / `unused_data` / extra-scanline checks.
- In-browser bit-plane viewing inspired by [StegOnline](https://github.com/Ge0rg3/StegOnline); this tool is dependency-free.
- For a server-side aggregation approach, see [AperiSolve](https://www.aperisolve.com/) — this one stays local and tunable.

## License

MIT
