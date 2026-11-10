#!/usr/bin/env python3
"""misc大手子 构建脚本：生成测试 fixture，并把 src 内联成单文件 HTML。"""
import base64
import gzip
import hashlib
import io
import zipfile
import ipaddress
import json
import lzma
import re
import struct
import sys
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SRC = ROOT / "src"
FIX = ROOT / "tests" / "fixtures"
OUT = Path(sys.argv[sys.argv.index("--out") + 1]) if "--out" in sys.argv else ROOT / "misc-dashouzi.html"

SIG = b"\x89PNG\r\n\x1a\n"


def chunk(t: bytes, data: bytes) -> bytes:
    return struct.pack(">I", len(data)) + t + data + struct.pack(">I", zlib.crc32(t + data) & 0xFFFFFFFF)


def make_png(w, h, rows, idat_data=None, extra_chunks=None):
    raw = b"".join(b"\x00" + r for r in rows)
    if idat_data is None:
        idat_data = zlib.compress(raw, 9)
    ihdr = struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)
    out = SIG + chunk(b"IHDR", ihdr) + chunk(b"IDAT", idat_data)
    for t, d in extra_chunks or []:
        out += chunk(t, d)
    return out + chunk(b"IEND", b"")


def make_png_raw(w, h, bit_depth, color_type, raw, extra_chunks=None, interlace=0):
    ihdr = struct.pack(">IIBBBBB", w, h, bit_depth, color_type, 0, 0, interlace)
    out = SIG + chunk(b"IHDR", ihdr) + chunk(b"IDAT", zlib.compress(raw, 9))
    for t, d in extra_chunks or []:
        out += chunk(t, d)
    return out + chunk(b"IEND", b"")


def fixture_gray4_padding():
    w, h = 13, 5
    rb = (w * 4 + 7) // 8
    raw = b""
    for y in range(h):
        row = bytearray(rb)
        for x in range(w):
            v = (x * 3 + y) % 16
            if x % 2 == 0:
                row[x // 2] |= v << 4
            else:
                row[x // 2] |= v
        raw += b"\x00" + bytes(row)
    return make_png_raw(w, h, 4, 0, raw)


def gradient_rows(w, h):
    rows = []
    for y in range(h):
        r = bytearray()
        for x in range(w):
            r += bytes(((x * 4) & 255, (y * 8) & 255, ((x + y) * 3) & 255))
        rows.append(bytes(r))
    return rows


def embed_lsb(rows, msg: bytes):
    bits = "".join(f"{b:08b}" for b in msg)
    idx = 0
    out = []
    for row in rows:
        r = bytearray(row)
        for i in range(len(r)):
            if idx < len(bits):
                r[i] = (r[i] & 0xFE) | int(bits[idx])
                idx += 1
        out.append(bytes(r))
    assert idx == len(bits), f"message too long: {idx}/{len(bits)}"
    return out


def fixture_second_stream():
    w, h = 64, 32
    a = gradient_rows(w, h)
    b = embed_lsb(gradient_rows(w, h), b"flag{second_stream_lsb}")
    idat = zlib.compress(b"".join(b"\x00" + r for r in a), 9) + zlib.compress(b"".join(b"\x00" + r for r in b), 9)
    return make_png(w, h, a, idat_data=idat)


def fixture_bad_crc_height():
    w, h = 32, 48
    png = bytearray(make_png(w, h, gradient_rows(w, h)))
    png[20:24] = struct.pack(">I", 24)  # 改高度，保留旧 CRC
    return bytes(png)


def fixture_crc_fixed_height():
    """改高度并把 IHDR CRC 一并重算：CRC 爆破只能得到假尺寸，必须靠 IDAT 行数。"""
    w, h = 32, 48
    png = bytearray(make_png(w, h, gradient_rows(w, h)))
    png[20:24] = struct.pack(">I", 24)
    crc = zlib.crc32(b"IHDR" + bytes(png[16:29])) & 0xFFFFFFFF
    png[29:33] = struct.pack(">I", crc)
    return bytes(png)


def fixture_height_extra():
    w, h, real_h = 32, 16, 24
    rows = gradient_rows(w, h=real_h)
    raw = b"".join(b"\x00" + r for r in rows)
    return make_png(w, h, rows[:h], idat_data=zlib.compress(raw, 9))


def _make_bmp_indexed(w, h, bpp, indices, palette_bgr):
    row_size = ((bpp * w + 31) // 32) * 4
    pixels = bytearray(row_size * h)
    for y in range(h):
        for x in range(w):
            idx = indices[y * w + x] & ((1 << bpp) - 1)
            bit_pos = x * bpp
            byte = y * row_size + (bit_pos >> 3)
            shift = 8 - bpp - (bit_pos & 7)
            pixels[byte] |= idx << shift
    palette = b"".join(bytes(c) + b"\x00" for c in palette_bgr)
    off = 14 + 40 + len(palette)
    size = off + len(pixels)
    fh = b"BM" + struct.pack("<IHHI", size, 0, 0, off)
    dib = struct.pack("<IiiHHIIiiII", 40, w, -h, 1, bpp, 0, len(pixels), 2835, 2835,
                      len(palette_bgr), 0)
    return fh + dib + palette + bytes(pixels)


def fixture_bmp_4bit_lsb():
    w = h = 16
    msg = b"flag{bmp_4bit}"
    bits = "".join(f"{b:08b}" for b in msg)
    idx = [(i * 7) % 16 for i in range(w * h)]
    for j, bit in enumerate(bits):
        idx[j] = (idx[j] & 0xFE) | int(bit)
    pal = [(i * 17, i * 17, i * 17) for i in range(16)]
    return _make_bmp_indexed(w, h, 4, idx, pal)


def fixture_bmp_1bit_lsb():
    w = h = 16
    msg = b"flag{bmp_1bit}"
    bits = "".join(f"{b:08b}" for b in msg)
    idx = [i % 2 for i in range(w * h)]
    for j, bit in enumerate(bits):
        idx[j] = (idx[j] & 0xFE) | int(bit)
    pal = [(0, 0, 0), (255, 255, 255)]
    return _make_bmp_indexed(w, h, 1, idx, pal)


def fixture_bmp_gap():
    w, h = 16, 8
    palette = bytes(1024)
    row_size = ((8 * w + 31) // 32) * 4
    pixels = b"\x00" * (row_size * h)
    gap = b"flag{bmp_gap}" + b"\x00" * 32
    palette_end = 14 + 40 + 1024
    off = palette_end + len(gap)
    size = off + len(pixels)
    fh = b"BM" + struct.pack("<IHHI", size, 0, 0, off)
    dib = struct.pack("<IiiHHIIiiII", 40, w, h, 1, 8, 0, len(pixels), 2835, 2835, 256, 0)
    return fh + dib + palette + gap + pixels


def fixture_bmp_bad_colors():
    w = h = 1
    row_size = 4
    pixels = b"\x00" * row_size
    off = 54
    dib = struct.pack("<IiiHHIIiiII", 40, w, h, 1, 8, 0, len(pixels), 2835, 2835, 0xFFFFFFFF, 0)
    fh = b"BM" + struct.pack("<IHHI", off + len(pixels), 0, 0, off)
    return fh + dib + pixels


def fixture_jpeg_exif():
    from PIL import Image
    buf = io.BytesIO()
    Image.new("RGB", (64, 64), (40, 90, 140)).save(buf, "JPEG", quality=80)
    jpg = buf.getvalue()
    # EXIF APP1
    text = "this_is_password".encode("utf-16-le") + b"\x00\x00"
    tiff = b"II" + struct.pack("<H", 42) + struct.pack("<I", 8)
    data_off = 8 + 2 + 12 + 4
    entry = struct.pack("<HHI", 0x9C9C, 1, len(text)) + struct.pack("<I", data_off)
    ifd = struct.pack("<H", 1) + entry + struct.pack("<I", 0)
    tiff = tiff + ifd + text
    payload = b"Exif\x00\x00" + tiff
    app1 = b"\xFF\xE1" + struct.pack(">H", len(payload) + 2) + payload
    jpg = jpg[:2] + app1 + jpg[2:]
    return jpg + b"\nflag{jpeg_trailer}\n"


def _tiff_xp(tag, text):
    data = text.encode("utf-16-le") + b"\x00\x00"
    header = b"II" + struct.pack("<H", 42) + struct.pack("<I", 8)
    data_off = 8 + 2 + 12 + 4
    ifd = struct.pack("<H", 1) + struct.pack("<HHI", tag, 1, len(data)) + struct.pack("<I", data_off) + struct.pack("<I", 0)
    return header + ifd + data


def _tiff_ascii(tag, text):
    data = text.encode() + b"\x00"
    header = b"II" + struct.pack("<H", 42) + struct.pack("<I", 8)
    data_off = 8 + 2 + 12 + 4
    ifd = struct.pack("<H", 1) + struct.pack("<HHI", tag, 2, len(data)) + struct.pack("<I", data_off) + struct.pack("<I", 0)
    return header + ifd + data


def _jpeg_with_segments(segments):
    from PIL import Image
    buf = io.BytesIO()
    Image.new("RGB", (48, 48), (90, 120, 60)).save(buf, "JPEG", quality=80)
    jpg = buf.getvalue()
    return jpg[:2] + b"".join(segments) + jpg[2:]


def fixture_jpeg_xmp():
    xmp = b"http://ns.adobe.com/xap/1.0/\x00<x:xmpmeta>flag{xmp}</x:xmpmeta>"
    seg = b"\xFF\xE1" + struct.pack(">H", len(xmp) + 2) + xmp
    return _jpeg_with_segments([seg])


def fixture_jpeg_multi_exif():
    t1 = _tiff_xp(0x9C9C, "first_exif")
    app1 = b"Exif\x00\x00" + t1
    seg1 = b"\xFF\xE1" + struct.pack(">H", len(app1) + 2) + app1
    t2 = _tiff_xp(0x9C9E, "second_exif")
    app13 = b"Photoshop 3.0\x00" + b"8BIM\x04\x04\x00\x00\x00\x00\x00\x00" + b"Exif\x00\x00" + t2
    seg13 = b"\xFF\xED" + struct.pack(">H", len(app13) + 2) + app13
    return _jpeg_with_segments([seg1, seg13])


def fixture_ico_lsb():
    w = h = 64
    png = make_png(w, h, embed_lsb(gradient_rows(w, h), b"flag{ico_lsb}"))
    header = struct.pack("<HHH", 0, 1, 1)
    entry = struct.pack("<BBBBHHII", 64, 64, 0, 0, 1, 32, len(png), 22)
    return header + entry + png


def fixture_svg_embedded():
    w = h = 64
    png = make_png(w, h, embed_lsb(gradient_rows(w, h), b"flag{svg_lsb}"))
    b64 = base64.b64encode(png).decode()
    svg = f'<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><!-- misc-dashouzi fixture --><image width="64" height="64" href="data:image/png;base64,{b64}"/></svg>'
    return svg.encode()


def fixture_two_idat_streams():
    w, h = 32, 16
    a = gradient_rows(w, h)
    b = [bytes((v + 37) & 255 for v in row) for row in a]
    ihdr = struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)
    return (SIG + chunk(b"IHDR", ihdr)
            + chunk(b"IDAT", zlib.compress(b"".join(b"\x00" + r for r in a), 9))
            + chunk(b"IDAT", zlib.compress(b"".join(b"\x00" + r for r in b), 9))
            + chunk(b"IEND", b""))


ADAM7_PASSES = [(0, 0, 8, 8), (4, 0, 8, 8), (0, 4, 4, 8), (2, 0, 4, 4), (0, 2, 2, 4), (1, 0, 2, 2), (0, 1, 1, 2)]


def make_adam7_png(w, h, rows, channels=3, color_type=2, extra_chunks=None):
    """8-bit Adam7 编码：按 7 个 pass 取像素，各自 filter0 后拼接。"""
    raw = b""
    for (x0, y0, dx, dy) in ADAM7_PASSES:
        y = y0
        while y < h:
            row = bytearray()
            x = x0
            while x < w:
                row += rows[y][x * channels:(x + 1) * channels]
                x += dx
            raw += b"\x00" + bytes(row)
            y += dy
    ihdr = struct.pack(">IIBBBBB", w, h, 8, color_type, 0, 0, 1)
    out = SIG + chunk(b"IHDR", ihdr)
    for t, d in extra_chunks or []:
        out += chunk(t, d)
    return out + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")


def fixture_adam7_lsb():
    w, h = 64, 32
    rows = embed_lsb(gradient_rows(w, h), b"flag{adam7_lsb}")
    return make_adam7_png(w, h, rows)


def fixture_adam7_rgba():
    w, h = 48, 24
    rows = [bytes(v for x in range(w) for v in ((x * 4) & 255, (y * 8) & 255, ((x + y) * 3) & 255, 255)) for y in range(h)]
    rows = embed_lsb_channel_bit(rows, b"flag{adam7_rgba}", channel=0, bit=0, channels=4)
    return make_adam7_png(w, h, rows, channels=4, color_type=6)


def fixture_svg_comment():
    w = h = 64
    png = make_png(w, h, embed_lsb(gradient_rows(w, h), b"flag{svg_comment}"))
    b64 = base64.b64encode(png).decode()
    svg = ('<!-- exported by fixture -->\n'
           '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64">'
           f'<image width="64" height="64" href="data:image/png;base64,{b64}"/></svg>')
    return svg.encode()


def embed_lsb_channel_bit(rows, msg, channel=1, bit=3, channels=3):
    bits = "".join(f"{b:08b}" for b in msg)
    idx = 0
    out = []
    for row in rows:
        r = bytearray(row)
        for px in range(0, len(r), channels):
            if idx < len(bits):
                i = px + channel
                r[i] = (r[i] & ~(1 << bit)) | (int(bits[idx]) << bit)
                idx += 1
        out.append(bytes(r))
    assert idx == len(bits), f"message too long: {idx}/{len(bits)}"
    return out


def fixture_deep_lsb():
    w, h = 64, 32
    rows = embed_lsb_channel_bit(gradient_rows(w, h), b"flag{deep_lsb}", channel=1, bit=3)
    return make_png(w, h, rows)


def fixture_gray16_hi():
    w, h = 64, 32
    msg = b"flag{gray16_hi}"
    bits = "".join(f"{b:08b}" for b in msg)
    raw = b""
    for y in range(h):
        row = bytearray()
        for x in range(w):
            i = y * w + x
            bit = int(bits[i]) if i < len(bits) else 0
            v = (bit << 8) | (i & 0xFF)
            row += struct.pack(">H", v)
        raw += b"\x00" + bytes(row)
    return make_png_raw(w, h, 16, 0, raw)


def fixture_zip_deflated():
    import zipfile
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        _zip_add(z, "flag.txt", b"flag{zip_deflated}", zipfile.ZIP_DEFLATED)
    return buf.getvalue()


def fixture_zip_two_streams():
    import zipfile
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        _zip_add(z, "a.bin", gzip.compress(b"flag{entry_one}", mtime=0), zipfile.ZIP_STORED)
        _zip_add(z, "b.bin", gzip.compress(b"flag{entry_two}", mtime=0), zipfile.ZIP_STORED)
    return buf.getvalue()


def fixture_iend_trailer():
    w, h = 16, 16
    return make_png(w, h, gradient_rows(w, h)) + b"flag{iend_trailer}"


def fixture_nested_png():
    layer = make_png(8, 8, gradient_rows(8, 8))
    for i in range(6):
        layer = make_png(8, 8, gradient_rows(8, 8), extra_chunks=[(b"tEXt", b"x\x00" + b"layer" + bytes([i]))]) + zlib.compress(layer, 9)
    return layer


def fixture_plte_unused():
    w = h = 16
    rb = (w * 4 + 7) // 8
    rows = []
    for y in range(h):
        row = bytearray(rb)
        for x in range(w):
            v = (x + y) % 4
            if x % 2 == 0:
                row[x // 2] |= v << 4
            else:
                row[x // 2] |= v
        rows.append(bytes(row))
    raw = b"".join(b"\x00" + r for r in rows)
    pal = bytearray(16 * 3)
    for i in range(4):
        pal[i * 3:i * 3 + 3] = bytes([i * 40, 255 - i * 40, 80 + i * 10])
    msg = b"flag{plte_unused}"
    pal[12:12 + len(msg)] = msg
    ihdr = struct.pack(">IIBBBBB", w, h, 4, 3, 0, 0, 0)
    return (SIG + chunk(b"IHDR", ihdr) + chunk(b"PLTE", bytes(pal))
            + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b""))


def fixture_apng_lsb():
    from PIL import Image
    w = h = 32
    plain = [bytes(v for x in range(w) for v in ((x * 4) & 255, (y * 8) & 255, ((x + y) * 3) & 255)) for y in range(h)]
    hidden = embed_lsb(plain, b"flag{apng_lsb}")
    f0 = Image.new("RGB", (w, h), (20, 40, 60))
    f1 = Image.frombytes("RGB", (w, h), b"".join(hidden))
    buf = io.BytesIO()
    f0.save(buf, format="PNG", save_all=True, append_images=[f1], duration=100, loop=0)
    return buf.getvalue()


def fixture_apng_palette():
    from PIL import Image
    w = h = 32
    pal = _gif_gray_palette()
    msg = b"flag{apng_pal}"
    bits = "".join(f"{b:08b}" for b in msg)
    idx = [(i * 7) % 256 for i in range(w * h)]
    for j, bit in enumerate(bits):
        idx[j] = (idx[j] & 0xFE) | int(bit)
    f0 = Image.new("P", (w, h)); f0.putpalette(pal); f0.putdata([0] * (w * h))
    f1 = Image.new("P", (w, h)); f1.putpalette(pal); f1.putdata(idx)
    buf = io.BytesIO()
    f0.save(buf, format="PNG", save_all=True, append_images=[f1], duration=100, loop=0)
    return buf.getvalue()


def fixture_apng_subframe():
    w = h = 32
    fw = fh = 16
    msg = b"flag{apng_sub}"
    bits = "".join(f"{b:08b}" for b in msg)
    idx = [(i * 7) % 256 for i in range(fw * fh)]
    for j, bit in enumerate(bits):
        idx[j] = (idx[j] & 0xFE) | int(bit)
    raw0 = b"".join(b"\x00" + bytes([0] * w) for _ in range(h))
    raw1 = b"".join(b"\x00" + bytes(idx[y * fw:(y + 1) * fw]) for y in range(fh))
    ihdr = struct.pack(">IIBBBBB", w, h, 8, 3, 0, 0, 0)
    fctl0 = struct.pack(">IIIIIHHBB", 0, w, h, 0, 0, 100, 1, 0, 0)
    fctl1 = struct.pack(">IIIIIHHBB", 1, fw, fh, 8, 8, 100, 1, 0, 0)
    return (SIG + chunk(b"IHDR", ihdr) + chunk(b"PLTE", bytes(_gif_gray_palette()))
            + chunk(b"acTL", struct.pack(">II", 2, 0))
            + chunk(b"fcTL", fctl0) + chunk(b"IDAT", zlib.compress(raw0, 9))
            + chunk(b"fcTL", fctl1)
            + chunk(b"fdAT", struct.pack(">I", 2) + zlib.compress(raw1, 9))
            + chunk(b"IEND", b""))


def fixture_tiff_tag():
    from PIL import Image
    buf = io.BytesIO()
    Image.new("RGB", (16, 16), (30, 60, 90)).save(buf, format="TIFF", tiffinfo={270: "flag{tiff_tag}"})
    return buf.getvalue()


def fixture_webp_exif():
    from PIL import Image
    buf = io.BytesIO()
    Image.new("RGB", (16, 16), (20, 40, 60)).save(
        buf, format="WEBP", exif=_tiff_ascii(270, "flag{webp_exif}"))
    return buf.getvalue()


def fixture_palette_png():
    from PIL import Image
    im = Image.new("P", (32, 32))
    im.putpalette([i % 256 for i in range(768)])
    px = im.load()
    for y in range(32):
        for x in range(32):
            px[x, y] = (x * y) % 256
    buf = io.BytesIO()
    im.save(buf, "PNG")
    return buf.getvalue()


def fixture_gray16_png():
    from PIL import Image
    import numpy as np
    a = (np.arange(64 * 64, dtype=np.uint16).reshape(64, 64) * 7) & 0xFFFF
    buf = io.BytesIO()
    Image.fromarray(a).save(buf, "PNG")
    return buf.getvalue()


def fixture_text_chunk():
    w, h = 16, 16
    return make_png(w, h, gradient_rows(w, h), extra_chunks=[(b"tEXt", b"Comment\x00flag{text_chunk}")])


def fixture_ztxt():
    data = b"Comment\x00\x00" + zlib.compress(b"flag{ztxt}", 9)
    return make_png(16, 16, gradient_rows(16, 16), extra_chunks=[(b"zTXt", data)])


def fixture_itxt():
    data = b"Comment\x00\x00\x00en\x00\x00flag{itxt}"
    return make_png(16, 16, gradient_rows(16, 16), extra_chunks=[(b"iTXt", data)])


def fixture_padded_stream():
    w, h = 48, 24
    a = gradient_rows(w, h)
    b = embed_lsb(gradient_rows(w, h), b"flag{padded_stream}")
    idat = (zlib.compress(b"".join(b"\x00" + r for r in a), 9)
            + b"PADPADPADPADPADPADPADPAD"
            + zlib.compress(b"".join(b"\x00" + r for r in b), 9)
            + b"TAIL")
    return make_png(w, h, a, idat_data=idat)


def fixture_unused_data():
    w, h = 16, 16
    raw = b"".join(b"\x00" + r for r in gradient_rows(w, h))
    idat = zlib.compress(raw, 9) + b"flag{unused_data}"
    return make_png(w, h, gradient_rows(w, h), idat_data=idat)


def fixture_lzma_rest():
    """IDAT 首流之后跟一段 LZMA 单独格式（无魔数，只能靠属性字节认）。"""
    w, h = 16, 16
    rows = gradient_rows(w, h)
    idat = zlib.compress(b"".join(b"\x00" + r for r in rows), 9) \
        + lzma.compress(b"flag{lzma_rest}", format=lzma.FORMAT_ALONE)
    return make_png(w, h, rows, idat_data=idat)


def _gif_gray_palette():
    pal = []
    for i in range(256):
        pal += [i, i, i]
    return pal


def _gif_frame(indices, w, h, palette):
    from PIL import Image
    im = Image.new("P", (w, h))
    im.putpalette(palette)
    im.putdata(indices)
    return im


def fixture_gif_lzw():
    w = h = 32
    idx0 = [(i * 7) % 256 for i in range(w * h)]
    msg = b"flag{gif_lzw}"
    bits = "".join(f"{b:08b}" for b in msg)
    idx1 = [(i * 7) % 256 for i in range(w * h)]
    for j, bit in enumerate(bits):
        idx1[j] = (idx1[j] & 0xFE) | int(bit)
    pal = _gif_gray_palette()
    buf = io.BytesIO()
    _gif_frame(idx0, w, h, pal).save(buf, format="GIF", save_all=True,
                                     append_images=[_gif_frame(idx1, w, h, pal)],
                                     optimize=False, disposal=2, loop=0)
    return buf.getvalue()


def fixture_gif_interlaced():
    w = h = 32
    msg = b"flag{gif_interlace}"
    bits = "".join(f"{b:08b}" for b in msg)
    idx = [(i * 7) % 256 for i in range(w * h)]
    for j, bit in enumerate(bits):
        idx[j] = (idx[j] & 0xFE) | int(bit)
    buf = io.BytesIO()
    _gif_frame(idx, w, h, _gif_gray_palette()).save(buf, format="GIF", interlace=True)
    return buf.getvalue()


def fixture_gif_comment():
    base = (b"GIF89a\x01\x00\x01\x00\x80\x00\x00\x00\x00\x00\xff\xff\xff")
    msg = b"flag{gif_comment}"
    comment = b"\x21\xFE" + bytes([len(msg)]) + msg + b"\x00"
    rest = (b"!\xf9\x04\x01\x00\x00\x00\x00,\x00\x00\x00\x00\x01\x00\x01\x00\x00\x02\x02D\x01\x00;")
    return base + comment + rest


def fixture_gif_trailer():
    gif = (b"GIF89a\x01\x00\x01\x00\x80\x00\x00\x00\x00\x00\xff\xff\xff!"
           b"\xf9\x04\x01\x00\x00\x00\x00,\x00\x00\x00\x00\x01\x00\x01\x00\x00\x02\x02D\x01\x00;")
    return gif + b"flag{gif_trailer}"


def _zip_add(z, name, data, method):
    """固定时间戳，保证单文件构建可复现。"""
    import zipfile
    zi = zipfile.ZipInfo(name, date_time=(2026, 1, 1, 0, 0, 0))
    zi.compress_type = method
    z.writestr(zi, data)


def fixture_zip_plain():
    import zipfile
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        _zip_add(z, "flag.txt", b"flag{zip_entry}", zipfile.ZIP_STORED)
    return buf.getvalue()


# ---------- 音频 / pcap fixtures ----------
def _wav_chunk(tag, data):
    return tag + struct.pack("<I", len(data)) + data + (b"\x00" if len(data) & 1 else b"")


def make_wav(samples, channels=1, bits=16, rate=8000, pre_chunks=None, post_chunks=None):
    """samples 为交错采样值。"""
    if bits == 8:
        data = bytes(max(0, min(255, int(v))) for v in samples)
    elif bits == 16:
        data = b"".join(struct.pack("<h", max(-32768, min(32767, int(v)))) for v in samples)
    elif bits == 24:
        data = b"".join(struct.pack("<i", max(-8388608, min(8388607, int(v))))[:3] for v in samples)
    elif bits == 32:
        data = b"".join(struct.pack("<i", max(-2147483648, min(2147483647, int(v)))) for v in samples)
    else:
        raise ValueError("bits")
    block = channels * (bits // 8)
    fmt = struct.pack("<HHIIHH", 1, channels, rate, rate * block, block, bits)
    chunks = list(pre_chunks or []) + [_wav_chunk(b"fmt ", fmt)]
    chunks.append(_wav_chunk(b"data", data))
    chunks += list(post_chunks or [])
    body = b"WAVE" + b"".join(chunks)
    return b"RIFF" + struct.pack("<I", len(body)) + body


def _embed_bits_lsb(vals, msg, channel=0, channels=1, offset=0):
    bits = "".join(f"{b:08b}" for b in msg)
    out = list(vals)
    for j, bit in enumerate(bits):
        i = offset + j
        idx = i * channels + channel
        out[idx] = (int(out[idx]) & ~1) | int(bit)
    return out


def fixture_wav_lsb():
    import math
    n = 1600
    vals = [int(7000 * math.sin(2 * math.pi * 440 * i / 8000)) for i in range(n)]
    vals = _embed_bits_lsb(vals, b"flag{wav_lsb}", 0, 1)
    return make_wav(vals, 1, 16, 8000)


def fixture_wav_extensible():
    import math
    n = 1200
    vals = [int(6000 * math.sin(2 * math.pi * 440 * i / 8000)) for i in range(n)]
    vals = _embed_bits_lsb(vals, b"flag{wav_extensible}", 0, 1)
    data = b"".join(struct.pack("<h", v) for v in vals)
    guid = bytes.fromhex("0100000000001000800000aa00389b71")
    fmt = (struct.pack("<HHIIHH", 0xfffe, 1, 8000, 16000, 2, 16)
           + struct.pack("<HHI", 22, 16, 4) + guid)
    body = b"WAVE" + _wav_chunk(b"fmt ", fmt) + _wav_chunk(b"data", data)
    return b"RIFF" + struct.pack("<I", len(body)) + body


def fixture_wav_stereo_lsb():
    import math
    n = 1200
    vals = []
    for i in range(n):
        vals += [int(5000 * math.sin(2 * math.pi * 330 * i / 8000)),
                 int(5000 * math.sin(2 * math.pi * 550 * i / 8000))]
    vals = _embed_bits_lsb(vals, b"flag{wav_stereo}", 1, 2)
    return make_wav(vals, 2, 16, 8000)


def fixture_wav_trailer():
    import math
    vals = [int(3000 * math.sin(2 * math.pi * 440 * i / 8000)) for i in range(400)]
    return make_wav(vals, 1, 16, 8000) + b"flag{wav_trailer}"


def fixture_wav_info():
    def info_item(tag, text):
        return _wav_chunk(tag, text.encode("utf-8") + b"\x00")
    info = b"INFO" + info_item(b"INAM", "misc-dashouzi") + info_item(b"ICMT", "flag{wav_info}")
    return make_wav([0] * 400, 1, 16, 8000, pre_chunks=[_wav_chunk(b"LIST", info)])


def _tone(freq, dur, rate=8000, amp=0.72):
    import math
    return [int(32767 * amp * math.sin(2 * math.pi * freq * i / rate)) for i in range(int(dur * rate))]


def _silence(dur, rate=8000):
    return [0] * int(dur * rate)


def fixture_wav_morse():
    code = {"S": "...", "O": "---", "F": "..-.", "L": ".-..", "A": ".-", "G": "--.", "T": "-", "E": "."}
    unit = 0.06
    vals = _silence(0.12)
    text = "SOS"
    for ci, ch in enumerate(text):
        for ei, sym in enumerate(code[ch]):
            vals += _tone(800, unit * (1 if sym == "." else 3))
            vals += _silence(unit)
        vals += _silence(unit * 2)  # 再加 2 units，合计 3 units letter gap
    vals += _silence(0.15)
    return make_wav(vals, 1, 16, 8000)


def _synchsafe(n):
    return bytes([(n >> 21) & 0x7f, (n >> 14) & 0x7f, (n >> 7) & 0x7f, n & 0x7f])


def _id3_frame(fid, payload):
    return fid + struct.pack(">I", len(payload)) + b"\x00\x00" + payload


def fixture_mp3_id3():
    png = make_png(8, 8, gradient_rows(8, 8))
    frames = b"".join([
        _id3_frame(b"TIT2", b"\x03" + b"misc-dashouzi"),
        _id3_frame(b"TPE1", b"\x03" + b"Cola_CaO"),
        _id3_frame(b"TXXX", b"\x03" + b"comment\x00" + b"flag{id3_txxx}"),
        _id3_frame(b"COMM", b"\x03eng\x00flag{id3_comm}"),
        _id3_frame(b"APIC", b"\x00" + b"image/png\x00" + b"\x03" + b"cover\x00" + png),
    ])
    tag = b"ID3" + b"\x03\x00\x00" + _synchsafe(len(frames)) + frames
    audio = b"\xff\xfb\x90\x00" + b"\x00" * 200
    v1 = (b"TAG" + b"ID3v1 title".ljust(30, b"\x00") + b"artist".ljust(30, b"\x00")
          + b"album".ljust(30, b"\x00") + b"2026" + b"flag{id3v1}".ljust(30, b"\x00") + b"\x00")
    return tag + audio + v1


def _id3v22_frame(fid, payload):
    return fid + struct.pack(">I", len(payload))[1:] + payload


def fixture_mp3_id3v22():
    png = make_png(8, 8, gradient_rows(8, 8))
    frames = b"".join([
        _id3v22_frame(b"TT2", b"\x00flag{id3v22}"),
        _id3v22_frame(b"PIC", b"\x00PNG\x03cover\x00" + png),
    ])
    return b"ID3" + b"\x02\x00\x00" + _synchsafe(len(frames)) + frames


def fixture_mp3_v1():
    audio = b"\xff\xfb\x90\x00" + b"\x00" * 200
    v1 = (b"TAG" + b"title".ljust(30, b"\x00") + b"artist".ljust(30, b"\x00")
          + b"album".ljust(30, b"\x00") + b"2026" + b"flag{id3v1_only}".ljust(30, b"\x00") + b"\x00")
    return audio + v1


# ---------- pcap fixtures ----------
def _csum(data):
    if len(data) & 1:
        data += b"\x00"
    s = sum(struct.unpack("!%dH" % (len(data) // 2), data))
    while s >> 16:
        s = (s & 0xffff) + (s >> 16)
    return (~s) & 0xffff


def _ipv4(src, dst, proto, payload, ttl=64, ident=1):
    total = 20 + len(payload)
    hdr = struct.pack("!BBHHHBBH4s4s", 0x45, 0, total, ident, 0, ttl, proto, 0,
                      bytes(map(int, src.split("."))), bytes(map(int, dst.split("."))))
    hdr = hdr[:10] + struct.pack("!H", _csum(hdr)) + hdr[12:]
    return hdr + payload


def _eth_ipv4(src, dst, proto, payload, ttl=64, ident=1):
    ip = _ipv4(src, dst, proto, payload, ttl, ident)
    return b"\x02\x00\x00\x00\x00\x02" + b"\x02\x00\x00\x00\x00\x01" + b"\x08\x00" + ip


def _tcp(src, dst, sport, dport, seq, payload, ttl=64, ident=1, flags=0x18):
    tcp = struct.pack("!HHIIBBHHH", sport, dport, seq, 0, 5 << 4, flags, 65535, 0, 0) + payload
    return _eth_ipv4(src, dst, 6, tcp, ttl, ident)


def _udp(src, dst, sport, dport, payload, ttl=64, ident=1):
    udp = struct.pack("!HHHH", sport, dport, 8 + len(payload), 0) + payload
    return _eth_ipv4(src, dst, 17, udp, ttl, ident)


def _dns_query(name):
    q = b"".join(bytes([len(x)]) + x.encode() for x in name.split(".")) + b"\x00"
    return struct.pack("!HHHHHH", 0x1234, 0x0100, 1, 0, 0, 0) + q + struct.pack("!HH", 1, 1)


def _pcap(packets, linktype=1):
    out = [struct.pack("<IHHIIII", 0xa1b2c3d4, 2, 4, 0, 0, 65535, linktype)]
    for i, p in enumerate(packets):
        out.append(struct.pack("<IIII", 1700000000 + i, i * 1000, len(p), len(p)) + p)
    return b"".join(out)


def _pcap_be(packets, linktype=1):
    out = [struct.pack(">IHHIIII", 0xa1b2c3d4, 2, 4, 0, 0, 65535, linktype)]
    for i, p in enumerate(packets):
        out.append(struct.pack(">IIII", 1700000000 + i, i * 1000, len(p), len(p)) + p)
    return b"".join(out)


def fixture_pcap_http():
    c, s = "10.0.0.1", "10.0.0.2"
    req = b"GET /flag HTTP/1.1\r\nHost: ctf.example\r\n\r\n"
    resp = b"HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\n\r\nflag{pcap_http}\r\n"
    packets = [
        _tcp(c, s, 12345, 80, 1000, req, 64, 1),
        _tcp(s, c, 80, 12345, 5000, resp, 64, 2),
        _tcp(c, s, 12347, 80, 106, b"pcap_order}", 64, 3),
        _tcp(c, s, 12347, 80, 100, b"flag{", 64, 4),
        _udp(c, "8.8.8.8", 5353, 53, _dns_query("flag.example.com"), 64, 5),
        _tcp(c, s, 443, 443, 1, b"", 3, 6),
    ]
    return _pcap(packets) + b"flag{pcap_trailer}"


def _ng_block(btype, body):
    pad = (-len(body)) % 4
    body = body + b"\x00" * pad
    total = 12 + len(body)
    return struct.pack("<II", btype, total) + body + struct.pack("<I", total)


def _ng_block_be(btype, body):
    pad = (-len(body)) % 4
    body = body + b"\x00" * pad
    total = 12 + len(body)
    return struct.pack(">II", btype, total) + body + struct.pack(">I", total)


def fixture_pcapng():
    shb = _ng_block(0x0A0D0D0A, b"\x4d\x3c\x2b\x1a" + struct.pack("<HHq", 1, 0, -1))
    idb = _ng_block(1, struct.pack("<HHI", 1, 0, 65535))
    pkt = _udp("10.0.0.1", "10.0.0.2", 40000, 40001, b"flag{pcapng}")
    epb_body = struct.pack("<IIIII", 0, 1, 2, len(pkt), len(pkt)) + pkt
    epb = _ng_block(6, epb_body)
    return shb + idb + epb


def fixture_pcapng_spb():
    shb = _ng_block(0x0A0D0D0A, b"\x4d\x3c\x2b\x1a" + struct.pack("<HHq", 1, 0, -1))
    idb = _ng_block(1, struct.pack("<HHI", 1, 0, 65535))
    pkt = _udp("10.0.0.1", "10.0.0.2", 44000, 44001, b"flag{pcapng_spb}")
    spb = _ng_block(3, struct.pack("<I", len(pkt)) + pkt)
    return shb + idb + spb


def fixture_pcapng_be():
    shb = _ng_block_be(0x0A0D0D0A, b"\x1a\x2b\x3c\x4d" + struct.pack(">HHq", 1, 0, -1))
    idb = _ng_block_be(1, struct.pack(">HHI", 1, 0, 65535))
    pkt = _udp("10.0.0.1", "10.0.0.2", 42000, 42001, b"flag{pcapng_be}")
    epb = _ng_block_be(6, struct.pack(">IIIII", 0, 1, 2, len(pkt), len(pkt)) + pkt)
    return shb + idb + epb


def _eth_ipv6(src, dst, next_header, payload, hop=64):
    ip6 = struct.pack("!IHBB16s16s", 6 << 28, len(payload), next_header, hop,
                      ipaddress.IPv6Address(src).packed, ipaddress.IPv6Address(dst).packed) + payload
    return b"\x02\x00\x00\x00\x00\x02" + b"\x02\x00\x00\x00\x00\x01" + b"\x86\xdd" + ip6


def fixture_pcap_ipv6():
    udp = struct.pack("!HHHH", 41000, 41001, 8 + len(b"flag{pcap_ipv6}"), 0) + b"flag{pcap_ipv6}"
    return _pcap([_eth_ipv6("2001:db8::1", "2001:db8::2", 17, udp)])


def fixture_pcap_be():
    return _pcap_be([_udp("10.0.0.1", "10.0.0.2", 43000, 43001, b"flag{pcap_be}")])


# 版本 3 / 纠错 M 的二维码模块矩阵（内容 flag{qr_builtin}）。
# 直接写死矩阵，免得 build.py 依赖 qrcode 这个第三方库。
QR_MATRIX = [
    "11111110111010011001101111111",
    "10000010010011101110101000001",
    "10111010110100111011101011101",
    "10111010011010100010001011101",
    "10111010011011110111001011101",
    "10000010100000010001001000001",
    "11111110101010101010101111111",
    "00000000011110111011100000000",
    "10100011010001100110000100101",
    "11101000100111100110011101001",
    "00101010101010010001001110001",
    "01100001101011000100000111010",
    "00000010000001011101101100011",
    "01110000011110001000101100101",
    "01001011000011101110110010001",
    "11101000011110111011110011000",
    "00001011100001100110001100000",
    "00101000010001100110001100001",
    "11101010011110010001000010101",
    "00111100111101000100001101001",
    "11111011011011011101111110001",
    "00000000110110001000100010001",
    "11111110100101101111101011001",
    "10000010010100111011100011000",
    "10111010001111100110111110111",
    "10111010010110100110110111110",
    "10111010110010110000000010011",
    "10000010000110100100011011000",
    "11111110101011111101101111001",
]


def _qr_pixels(rot=0, box=4, border=4):
    """把矩阵渲染成 0/255 灰度像素（含静区），rot=1 时逆时针转 90°。"""
    n = len(QR_MATRIX)
    dim = n + border * 2
    grid = [[1] * dim for _ in range(dim)]
    for y in range(n):
        for x in range(n):
            grid[y + border][x + border] = 0 if QR_MATRIX[y][x] == "1" else 1
    px = [[255 * grid[y // box][x // box] for x in range(dim * box)] for y in range(dim * box)]
    if rot:
        px = [list(r) for r in zip(*px[::-1])]
    return px


def fixture_zip_descriptor():
    """数据描述符（bit 3）ZIP：Java/Go/流式写出的常见形态，本地头里 csize=0。"""
    data = b"flag{zip_descriptor}"
    co = zlib.compressobj(9, zlib.DEFLATED, -15)
    cdata = co.compress(data) + co.flush()
    crc = zlib.crc32(data) & 0xFFFFFFFF
    name = b"descriptor.txt"
    out = bytearray()
    out += b"PK" + struct.pack("<HHHHHIIIHH", 20, 0x0008, 8, 0, 0, 0, 0, 0, len(name), 0)
    out += name + cdata
    out += b"PK" + struct.pack("<III", crc, len(cdata), len(data))
    cd_off = len(out)
    out += b"PK" + struct.pack("<HHHHHHIIIHHHHHII", 20, 20, 0x0008, 8, 0, 0, crc, len(cdata), len(data), len(name), 0, 0, 0, 0, 0, 0)
    out += name
    cd_size = len(out) - cd_off
    out += b"PK" + struct.pack("<HHHHIIH", 0, 0, 1, 1, cd_size, cd_off, 0)
    return bytes(out)


def fixture_zip_comment():
    """EOCD 注释里藏 flag。"""
    import zipfile
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_STORED) as z:
        z.writestr("a.txt", "hello")
        z.comment = b"flag{zip_comment}"
    return buf.getvalue()


def fixture_zip_lzma():
    """method 14（LZMA）条目。"""
    import zipfile
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_LZMA) as z:
        z.writestr("lz.txt", "flag{zip_lzma}")
    return buf.getvalue()


def fixture_zw_text():
    """零宽字符隐写：U+200B=0 / U+200C=1，拼出 ASCII。"""
    msg = b"flag{zero_width}"
    bits = "".join(format(x, "08b") for x in msg)
    zw = "".join("​" if b == "0" else "‌" for b in bits)
    return ("零宽测试 " + zw + " 结束").encode("utf-8")


def _hid_key(ch):
    if "a" <= ch <= "z":
        return 0x04 + ord(ch) - 97, 0
    if "A" <= ch <= "Z":
        return 0x04 + ord(ch) - 65, 0x02
    if "1" <= ch <= "9":
        return 0x1E + ord(ch) - 49, 0
    if ch == "0":
        return 0x27, 0
    return {"{": (0x2F, 0x02), "}": (0x30, 0x02), "_": (0x2D, 0x02),
            "-": (0x2D, 0), " ": (0x2C, 0), ".": (0x37, 0)}.get(ch, (0, 0))


def fixture_pcap_usb():
    """linktype 220：16 字节 USB 头 + 8 字节 HID 键盘报文。"""
    packets = []
    for ch in "flag{usb_hid}":
        key, mod = _hid_key(ch)
        hdr = struct.pack("<QBBBBHBB", 0, 0x53, 1, 0x81, 1, 1, 0, 0)
        packets.append(hdr + bytes([mod, 0, key, 0, 0, 0, 0, 0]))
    return _pcap(packets, linktype=220)


def fixture_pcap_icmp():
    payload = b"flag{icmp_payload}"
    icmp = bytes([8, 0, 0, 0, 0, 1, 0, 1]) + payload
    return _pcap([_eth_ipv4("10.0.0.1", "10.0.0.2", 1, icmp)])


_EAN_L = ["0001101", "0011001", "0010011", "0111101", "0100011",
          "0110001", "0101111", "0111011", "0110111", "0001011"]
_EAN_PARITY = ["000000", "001011", "001101", "001110", "010011",
               "011001", "011100", "010101", "010110", "011010"]


def fixture_barcode_ean13():
    """EAN-13 条码图（5901234123457）：验证扫描线 + 游程解码全链路。"""
    digits = "5901234123457"
    comp = ["".join("1" if c == "0" else "0" for c in w) for w in _EAN_L]
    G = [w[::-1] for w in comp]
    par = _EAN_PARITY[int(digits[0])]
    bits = "101"
    for i in range(6):
        bits += (G if par[i] == "1" else _EAN_L)[int(digits[1 + i])]
    bits += "01010"
    for i in range(6):
        bits += comp[int(digits[7 + i])]
    bits += "101"
    module, height, pad, quiet = 3, 60, 10, 30
    w = len(bits) * module + quiet * 2
    h = height + pad * 2
    rows = []
    for y in range(h):
        row = bytearray()
        for x in range(w):
            on = False
            if pad <= y < pad + height:
                mx = x - quiet
                if 0 <= mx < len(bits) * module:
                    on = bits[mx // module] == "1"
            v = 0 if on else 255
            row += bytes((v, v, v))
        rows.append(bytes(row))
    return make_png(w, h, rows)


def fixture_pcap_http_obj():
    """HTTP 对象：chunked 响应（PNG）+ multipart 上传。"""
    c, s = "10.0.0.1", "10.0.0.2"
    crlf = bytes((13, 10))
    png = make_png(2, 2, [bytes([255, 0, 0, 0, 255, 0]), bytes([0, 0, 255, 255, 255, 0])])
    half = len(png) // 2
    chunked = (("%x" % half).encode() + crlf + png[:half] + crlf
               + ("%x" % (len(png) - half)).encode() + crlf + png[half:] + crlf
               + b"0" + crlf + crlf)
    resp = (b"HTTP/1.1 200 OK" + crlf
            + b"Content-Type: image/png" + crlf
            + b'Content-Disposition: attachment; filename="got.png"' + crlf
            + b"Transfer-Encoding: chunked" + crlf + crlf + chunked)
    mp = (b"--BOUND" + crlf
          + b'Content-Disposition: form-data; name="file"; filename="up.txt"' + crlf
          + b"Content-Type: text/plain" + crlf + crlf
          + b"flag{http_multipart}" + crlf
          + b"--BOUND--" + crlf)
    req = (b"POST /upload HTTP/1.1" + crlf
           + b"Host: ctf.example" + crlf
           + b"Content-Type: multipart/form-data; boundary=BOUND" + crlf
           + b"Content-Length: " + str(len(mp)).encode() + crlf + crlf + mp)
    return _pcap([_tcp(c, s, 1111, 80, 1000, req), _tcp(s, c, 80, 1111, 2000, resp)])


def fixture_b64_png():
    """base64 编码的 PNG 藏在文本里：解出来不是文本，要当文件切出来。"""
    png = make_png(2, 2, [bytes([255, 0, 0, 0, 255, 0]), bytes([0, 0, 255, 255, 255, 0])])
    return ("hint: " + base64.b64encode(png).decode() + " :end" + chr(10)).encode()


def fixture_carve():
    """前面一段垃圾 + 一个完整 PNG：验证内嵌容器雕刻。"""
    png = make_png(2, 2, [bytes([255, 0, 0, 0, 255, 0]), bytes([0, 0, 255, 255, 255, 0])])
    return bytes(64) + png


def fixture_tar():
    import tarfile
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w") as t:
        png = make_png(2, 2, [bytes([255, 0, 0, 0, 255, 0]), bytes([0, 0, 255, 255, 255, 0])])
        for nm, data in (("a.txt", b"flag{tar_member}"), ("b.bin", bytes(range(16))), ("inner.png", png)):
            info = tarfile.TarInfo(nm)
            info.size = len(data)
            info.mtime = 0
            t.addfile(info, io.BytesIO(data))
    return buf.getvalue()


def fixture_rar4():
    """手写一个 RAR4 stored 条目：验证头解析与提取。"""
    data = b"flag{rar_stored}"
    nm = b"flag.txt"
    body = struct.pack("<II", len(data), len(data)) + bytes([0]) + struct.pack("<II", 0, 0) \
        + bytes([20, 0x30]) + struct.pack("<H", len(nm)) + struct.pack("<I", 0) + nm
    head = struct.pack("<HBHH", 0, 0x74, 0, 7 + len(body)) + body
    end = struct.pack("<HBHH", 0, 0x7B, 0x4000, 7)
    return b"Rar!\x1a\x07\x00" + head + data + end


def _vint(n):
    out = bytearray()
    while True:
        b = n & 0x7F
        n >>= 7
        if n:
            out.append(b | 0x80)
        else:
            out.append(b)
            return bytes(out)


def fixture_7z():
    """未压缩头的最小 7z：只带文件表，够验证名字解析。"""
    names = ["flag.txt", "data/a.bin"]
    name_blob = b"\x00" + b"".join(n.encode("utf-16-le") + b"\x00\x00" for n in names)
    files_info = bytes([0x05]) + _vint(len(names))
    files_info += bytes([0x11]) + _vint(len(name_blob)) + name_blob
    files_info += b"\x00"          # kEnd of FilesInfo properties
    nxt = bytes([0x01]) + files_info + b"\x00"   # kHeader ... kEnd
    sh = b"7z\xbc\xaf'\x1c" + bytes([0, 4])
    tail = struct.pack("<QQI", 0, len(nxt), zlib.crc32(nxt) & 0xFFFFFFFF)
    start_crc = zlib.crc32(tail) & 0xFFFFFFFF
    return sh + struct.pack("<I", start_crc) + tail + nxt


def fixture_mp3_frames():
    """MPEG1 Layer III 帧，private 位里藏一段 flag。"""
    msg = b"flag{mp3bits}"
    bits = "".join(format(x, "08b") for x in msg)
    out = bytearray()
    for i, bit in enumerate(bits):
        # FF FB 90/91 C0：MPEG1 LayerIII 128kbps 44100Hz 单声道
        hdr = bytes([0xFF, 0xFB, 0x90 | (1 if bit == "1" else 0), 0xC0])
        out += hdr + bytes(417 - 4)
    return bytes(out)


def fixture_pdf():
    payload = b"flag{pdf_embedded}"
    flate = zlib.compress(payload, 9)
    rgb = zlib.compress(bytes([255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 0]), 9)
    js = b'app.alert("flag{pdf_js}")'
    parts = [b"%PDF-1.4\n"]
    parts.append(b"1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n")
    parts.append(b"2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n")
    parts.append(b"3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] >> endobj\n")
    parts.append(b"4 0 obj << /Type /EmbeddedFile /Length " + str(len(flate)).encode() + b" /Filter /FlateDecode >>\nstream\n" + flate + b"\nendstream\nendobj\n")
    parts.append(b"5 0 obj << /Subtype /Image /Width 2 /Height 2 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Length " + str(len(rgb)).encode() + b" /Filter /FlateDecode >>\nstream\n" + rgb + b"\nendstream\nendobj\n")
    parts.append(b"6 0 obj << /S /JavaScript /JS (" + js + b") >> endobj\n")
    parts.append(b"trailer << /Root 1 0 R >>\n%%EOF\n")
    return b"".join(parts)


def fixture_cut_png():
    """PNG 被削掉第一个字节：魔数残缺，用来验文件头修复。"""
    return fixture_text_chunk()[1:]


def fixture_qr(rot=0):
    px = _qr_pixels(rot)
    rows = [bytes(v for p in row for v in (p, p, p)) for row in px]
    return make_png(len(px[0]), len(px), rows)


def fixture_qr_rot():
    return fixture_qr(1)

FIXTURES = [
    ("second_stream.png", fixture_second_stream, ["第二条 zlib 流", "flag{second_stream_lsb}"]),
    ("bad_crc_height.png", fixture_bad_crc_height, ["IHDR 宽高可能被改过"]),
    ("height_extra.png", fixture_height_extra, ["数据比 IHDR 声明的多"]),
    ("crc_fixed_height.png", fixture_crc_fixed_height, ["IDAT 实际行数对应其它尺寸"]),
    ("bmp_gap.bmp", fixture_bmp_gap, ["调色板与像素数组之间有夹缝", "flag{bmp_gap}"]),
    ("bmp_bad_colors.bmp", fixture_bmp_bad_colors, ["调色板声明数量异常"]),
    ("bmp_4bit_lsb.bmp", fixture_bmp_4bit_lsb, ["flag{bmp_4bit}"]),
    ("bmp_1bit_lsb.bmp", fixture_bmp_1bit_lsb, ["flag{bmp_1bit}"]),
    ("exif_xp.jpg", fixture_jpeg_exif, ["XPComment", "JPEG EOI 之后还有数据", "flag{jpeg_trailer}"]),
    ("jpeg_multi_exif.jpg", fixture_jpeg_multi_exif, ["发现 2 块 EXIF", "XPKeywords"]),
    ("jpeg_xmp.jpg", fixture_jpeg_xmp, ["APP1 段里的可疑字符串", "flag{xmp}"]),
    ("ico_lsb.ico", fixture_ico_lsb, ["ICO 含", "flag{ico_lsb}"]),
    ("svg_embedded.svg", fixture_svg_embedded, ["SVG 内嵌", "flag{svg_lsb}"]),
    ("text_chunk.png", fixture_text_chunk, ["tEXt 文本块", "flag{text_chunk}"]),
    ("unused_data.png", fixture_unused_data, ["未消费数据", "flag{unused_data}"]),
    ("lzma_rest.png", fixture_lzma_rest, ["LZMA 流"]),
    ("ztxt.png", fixture_ztxt, ["zTXt 文本块", "flag{ztxt}"]),
    ("itxt.png", fixture_itxt, ["iTXt 文本块", "flag{itxt}"]),
    ("padded_stream.png", fixture_padded_stream, ["第二条 zlib 流", "垫层", "flag{padded_stream}"]),
    ("gif_trailer.gif", fixture_gif_trailer, ["GIF 结束符", "flag{gif_trailer}"]),
    ("gif_comment.gif", fixture_gif_comment, ["GIF Comment Extension", "flag{gif_comment}"]),
    ("gif_lzw.gif", fixture_gif_lzw, ["第 1 帧可解码", "flag{gif_lzw}"]),
    ("gif_interlaced.gif", fixture_gif_interlaced, ["隔行", "flag{gif_interlace}"]),
    ("zip_plain.zip", fixture_zip_plain, ["ZIP 条目", "flag{zip_entry}"]),
    ("palette.png", fixture_palette_png, []),
    ("plte_unused.png", fixture_plte_unused, ["未使用颜色", "flag{plte_unused}"]),
    ("apng_lsb.png", fixture_apng_lsb, ["APNG 动画", "flag{apng_lsb}"]),
    ("tiff_tag.tif", fixture_tiff_tag, ["TIFF", "flag{tiff_tag}"]),
    ("apng_palette.png", fixture_apng_palette, ["APNG 动画", "flag{apng_pal}"]),
    ("apng_subframe.png", fixture_apng_subframe, ["APNG 第 1 帧可解码：16x16", "flag{apng_sub}"]),
    ("webp_exif.webp", fixture_webp_exif, ["WebP EXIF", "flag{webp_exif}"]),
    ("gray16.png", fixture_gray16_png, []),
    ("gray4_padding.png", fixture_gray4_padding, []),
    ("two_idat_streams.png", fixture_two_idat_streams, ["第 2 个 IDAT 是独立 zlib 流"]),
    ("adam7_lsb.png", fixture_adam7_lsb, ["Adam7 隔行", "flag{adam7_lsb}"]),
    ("adam7_rgba.png", fixture_adam7_rgba, ["Adam7 隔行", "flag{adam7_rgba}"]),
    ("svg_comment.svg", fixture_svg_comment, ["SVG 内嵌", "flag{svg_comment}"]),
    ("deep_lsb.png", fixture_deep_lsb, []),
    ("gray16_hi.png", fixture_gray16_hi, ["flag{gray16_hi}"]),
    ("zip_two_streams.zip", fixture_zip_two_streams, ["flag{entry_one}", "flag{entry_two}"]),
    ("zip_deflated.zip", fixture_zip_deflated, ["ZIP 条目", "flag{zip_deflated}"]),
    ("iend_trailer.png", fixture_iend_trailer, ["IEND 之后还有数据", "flag{iend_trailer}"]),
    ("nested_png.png", fixture_nested_png, []),
    ("wav_lsb.wav", fixture_wav_lsb, ["音频 LSB 候选", "flag{wav_lsb}"]),
    ("wav_extensible.wav", fixture_wav_extensible, ["WAVE_FORMAT_EXTENSIBLE", "flag{wav_extensible}"]),
    ("wav_stereo_lsb.wav", fixture_wav_stereo_lsb, ["音频 LSB 候选", "flag{wav_stereo}"]),
    ("wav_trailer.wav", fixture_wav_trailer, ["RIFF 结束之后还有数据", "flag{wav_trailer}"]),
    ("wav_info.wav", fixture_wav_info, ["WAV 元数据文本", "flag{wav_info}"]),
    ("wav_morse.wav", fixture_wav_morse, ["Morse 解码", "SOS"]),
    ("mp3_id3.mp3", fixture_mp3_id3, ["ID3v2.3 标签", "flag{id3_txxx}", "ID3 APIC", "flag{id3v1}"]),
    ("mp3_id3v22.mp3", fixture_mp3_id3v22, ["ID3v2.2 标签", "flag{id3v22}", "ID3 APIC"]),
    ("mp3_id3v1.mp3", fixture_mp3_v1, ["ID3v1 标签", "flag{id3v1_only}"]),
    ("pcap_http.pcap", fixture_pcap_http, ["HTTP", "flag{pcap_http}", "flag{pcap_order}", "DNS 查询", "TTL 异常", "pcap 结束之后还有数据", "flag{pcap_trailer}"]),
    ("pcap_ng.pcapng", fixture_pcapng, ["PCAPNG", "flag{pcapng}"]),
    ("pcap_ng_spb.pcapng", fixture_pcapng_spb, ["flag{pcapng_spb}"]),
    ("pcap_ng_be.pcapng", fixture_pcapng_be, ["flag{pcapng_be}"]),
    ("pcap_ipv6.pcap", fixture_pcap_ipv6, ["flag{pcap_ipv6}"]),
    ("pcap_be.pcap", fixture_pcap_be, ["flag{pcap_be}"]),
    ("cut_png.png", fixture_cut_png, ["文件头疑似被削"]),
    ("tar_members.tar", fixture_tar, ["TAR", "flag{tar_member}"]),
    ("pcap_usb.pcap", fixture_pcap_usb, ["USB HID", "flag{usb_hid}"]),
    ("pcap_icmp.pcap", fixture_pcap_icmp, ["flag{icmp_payload}"]),
    ("pcap_http_obj.pcap", fixture_pcap_http_obj, ["HTTP 对象", "flag{http_multipart}"]),
    ("barcode_ean13.png", fixture_barcode_ean13, ["EAN-13", "5901234123457"]),
    ("b64_png.txt", fixture_b64_png, ["base64 解出 PNG"]),
    ("carve_embedded.bin", fixture_carve, ["内嵌 PNG"]),
    ("rar4_stored.rar", fixture_rar4, ["RAR", "flag{rar_stored}"]),
    ("seven_plain.7z", fixture_7z, ["7Z", "flag.txt"]),
    ("mp3_frames.mp3", fixture_mp3_frames, ["MP3 帧", "flag{mp3bits}"]),
    ("pdf_objects.pdf", fixture_pdf, ["PDF", "flag{pdf_embedded}"]),
    ("zip_descriptor.zip", fixture_zip_descriptor, ["descriptor.txt", "flag{zip_descriptor}"]),
    ("zip_comment.zip", fixture_zip_comment, ["ZIP 注释", "flag{zip_comment}"]),
    ("zip_lzma.zip", fixture_zip_lzma, ["lz.txt"]),
    ("zero_width.txt", fixture_zw_text, ["零宽字符隐写", "flag{zero_width}"]),
    ("qr_flag.png", fixture_qr, ["二维码", "flag{qr_builtin}"]),
    ("qr_flag_rot.png", fixture_qr_rot, ["二维码", "flag{qr_builtin}"]),
]


def build_fixtures():
    FIX.mkdir(parents=True, exist_ok=True)
    entries = []
    for name, fn, expect in FIXTURES:
        data = fn()
        (FIX / name).write_bytes(data)
        entries.append({"name": name, "b64": base64.b64encode(data).decode(), "expect": expect})
    # inflate 单元
    sample = (b"misc-dashouzi inflate self-test " * 80)
    unit = {
        "kind": "inflate",
        "name": "zlib roundtrip 2.6KB",
        "comp": base64.b64encode(zlib.compress(sample, 9)).decode(),
        "sha256": hashlib.sha256(sample).hexdigest(),
    }
    (ROOT / "tests" / "fixtures.json").write_text(
        json.dumps({"fixtures": entries, "units": [unit]}, ensure_ascii=False, indent=1), encoding="utf-8")
    return entries, [unit]


def read(p):
    return (SRC / p).read_text(encoding="utf-8")


def background_css():
    """把本地参考图内联成 CSS 变量；找不到就退回纯色背景。--no-bg 强制纯色（发人用）。"""
    if "--no-bg" in sys.argv:
        return "none"
    for p in (ROOT / ".scratch" / "atri-bg.jpg", Path("E:/ANOTHER/gura/R-C.jpg")):
        if p.exists():
            data = base64.b64encode(p.read_bytes()).decode()
            return f'url("data:image/jpeg;base64,{data}")'
    return "none"


# 核心模块加载顺序的**唯一真理源**：build.py 拼单文件、tests/run.js 加载 Node 回归都读这里。
# 新增模块只改这一处（build.py 会把它写进 tests/modules.json）。
CORE_MODULES = [
    "00-util.js", "10-inflate.js", "12-encode.js", "13-lzma.js", "14-qr.js", "15-bar.js",
    "20-png.js", "30-jpeg.js", "40-bmp.js", "50-formats.js", "52-carrier.js", "53-pdf.js",
    "55-archives.js", "60-scan.js", "61-drawn.js", "62-audio.js", "64-pcap.js", "65-diff.js",
    "66-spectrum.js", "70-analyze.js", "75-companion.js", "76-changelog.js", "78-nodes.js",
]


def source_version() -> str:
    m = re.search(r"const VERSION = '([^']+)'", read("00-util.js"))
    if not m:
        raise SystemExit("00-util.js 里找不到 VERSION")
    return m.group(1)


def main():
    fixtures, units = build_fixtures()
    version = source_version()
    core = "\n\n".join(read(f) for f in CORE_MODULES)
    (ROOT / "tests" / "modules.json").write_text(
        json.dumps({"core": CORE_MODULES, "version": version}, ensure_ascii=False, indent=1) + "\n",
        encoding="utf-8")
    ui = read("80-ui.js")
    css = read("style.css").replace("--bg-image: /*__BG_IMAGE__*/none;", f"--bg-image: {background_css()};")
    html = read("index.html")
    # 无壁纸构建（发布用）给 body 打标：CSS 据此收窄侧栏头图区，不留一块空白
    if "--no-bg" in sys.argv:
        html = html.replace("<body>", '<body class="no-bg">', 1)
    # 版本号只有 00-util.js 一个真理源，构建时注入顶栏，避免三处手改漂移
    html, nver = re.subn(r'(<span class="ver" id="ver">)[^<]*(</span>)', r'\g<1>v' + version + r'\g<2>', html)
    if nver != 1:
        raise SystemExit(f"index.html 里应该正好一个版本号占位，实际 {nver} 个")
    selftest = "window.SELFTEST = " + json.dumps({"fixtures": fixtures, "units": units}, ensure_ascii=False) + ";"
    for name, text in [("core", core), ("ui", ui), ("selftest", selftest)]:
        if "</script" in text.lower():
            raise SystemExit(f"{name} 内含 </script>，需要转义")
    if "</style" in css.lower():
        raise SystemExit("CSS 内含 </style>，需要转义")
    html = html.replace("/*__STYLE__*/", css)
    html = html.replace("/*__CORE__*/", core)
    html = html.replace("/*__SELFTEST__*/", selftest)
    html = html.replace("/*__UI__*/", ui)
    leftovers = [p for p in ("/*__STYLE__*/", "/*__CORE__*/", "/*__SELFTEST__*/", "/*__UI__*/", "/*__BG_IMAGE__*/") if p in html]
    if leftovers:
        raise SystemExit("占位符未被替换：" + ", ".join(leftovers))
    if ("v" + version) not in html:
        raise SystemExit("产物里没有当前版本号")
    if "window.SELFTEST" not in html or "globalThis.MDZ" not in html:
        raise SystemExit("产物缺少核心/自检注入")
    OUT.write_text(html, encoding="utf-8")
    print(f"built {OUT} ({OUT.stat().st_size} bytes)")
    print(f"fixtures: {len(fixtures)} in {FIX}")


if __name__ == "__main__":
    main()
