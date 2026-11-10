#!/usr/bin/env python3
"""misc大手子 本地工具桥（可选）

只监听回环地址，token 鉴权；只执行白名单动作。
浏览器把当前文件 POST 到这里，工具在临时目录里跑，产物以 base64 返回。

用法：
    python companion.py
    python companion.py --port 8765 --token <固定token>
    python companion.py --fake-tools          # 测试用：不调用真实工具

不启动本脚本时，HTML 里的手写命令仍然可用。
"""
from __future__ import annotations

import argparse
import base64
import hmac
import ipaddress
import json
import lzma
import os
import platform
import secrets
import shlex
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

VERSION = "0.6.0"
MAX_BODY = 64 * 1024 * 1024
MAX_RAW = 48 * 1024 * 1024
MAX_OUTPUT = 4 * 1024 * 1024
MAX_ERR = 1024 * 1024
MAX_ARTIFACT_TOTAL = 32 * 1024 * 1024
MAX_ARTIFACT_FILES = 64
MAX_PASSWORD = 256
DEFAULT_TIMEOUT = 60

TOOL_NAMES = ("zsteg", "binwalk", "exiftool", "steghide", "bkcrack", "zbarimg")
ZSTEG_EXPRS = (
    "b1,rgb,lsb,xy",
    "b1,bgr,lsb,xy",
    "b1,rgba,lsb,xy",
    "b1,rgb,msb,xy",
    "b2,rgb,lsb,xy",
)
EXIF_TAGS = ("ThumbnailImage", "PreviewImage")

ACTIONS = {
    "zsteg.scan": {"tool": "zsteg", "mode": "text", "label": "zsteg 全扫"},
    "zsteg.extract": {"tool": "zsteg", "mode": "binary", "label": "zsteg 按表达式提取"},
    "binwalk.scan": {"tool": "binwalk", "mode": "text", "label": "binwalk 签名扫描"},
    "binwalk.extract": {"tool": "binwalk", "mode": "files", "label": "binwalk 自动提取"},
    "exiftool.meta": {"tool": "exiftool", "mode": "text", "label": "exiftool 全部元数据"},
    "exiftool.thumb": {"tool": "exiftool", "mode": "binary", "label": "exiftool 缩略图"},
    "steghide.info": {"tool": "steghide", "mode": "text", "label": "steghide 查看信息"},
    "steghide.extract": {"tool": "steghide", "mode": "files", "label": "steghide 提取"},
    "bkcrack.list": {"tool": "bkcrack", "mode": "text", "label": "bkcrack 列出 ZIP 条目"},
    "qr.decode": {"tool": "zbarimg", "mode": "text", "label": "zbarimg 二维码/条码"},
    # 内置动作：不依赖任何外部程序，纯 Python 完成
    "lzma.decompress": {"tool": "builtin", "mode": "text", "label": "LZMA 解压（内置）"},
}

PASSWORD_FIELD = {
    "name": "password",
    "label": "口令",
    "type": "password",
    "default": "",
    "max": MAX_PASSWORD,
}


def action_specs() -> list[dict]:
    specs = []
    for action_id, meta in ACTIONS.items():
        fields = []
        if action_id == "zsteg.extract":
            fields = [{
                "name": "expr", "label": "表达式", "type": "select",
                "options": list(ZSTEG_EXPRS), "default": ZSTEG_EXPRS[0],
            }]
        elif action_id.startswith("steghide."):
            fields = [dict(PASSWORD_FIELD)]
        elif action_id == "exiftool.thumb":
            fields = [{
                "name": "tag", "label": "标签", "type": "select",
                "options": list(EXIF_TAGS), "default": EXIF_TAGS[0],
            }]
        elif action_id == "lzma.decompress":
            fields = [{
                "name": "offset", "label": "偏移", "type": "text",
                "default": "", "max": 24,
            }]
        specs.append({
            "id": action_id, "tool": meta["tool"], "label": meta["label"],
            "mode": meta["mode"], "fields": fields,
        })
    return specs


class CompanionError(Exception):
    def __init__(self, message: str, code: int = 400):
        super().__init__(message)
        self.message = message
        self.code = code


def sanitize_name(name: str | None) -> str:
    base = os.path.basename(str(name or "upload.bin"))
    # 只留字母/数字/下划线/点/短横/空格/Unicode 字母；避免 .bat 工具被 cmd 解释 & ; % 等
    base = "".join(ch for ch in base if ch.isalnum() or ch in "._- " or ord(ch) >= 128)
    base = base.strip(" .")
    if base.startswith("-"):
        base = "_" + base
    if base.split(".", 1)[0].upper() in {
        "CON", "PRN", "AUX", "NUL",
        "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
        "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
    }:
        base = "_" + base
    if not base or base in (".", ".."):
        base = "upload.bin"
    return base[:120]


def _is_loopback(host: str) -> bool:
    h = (host or "").strip().lower()
    return h in ("127.0.0.1", "localhost", "::1", "[::1]")


def _origin_allowed(origin: str | None) -> bool:
    """只允许无 Origin（curl/Node）、file://（null）和本机页面。"""
    if not origin:
        return True
    if origin == "null" or origin.startswith("file://"):
        return True
    try:
        u = urlparse(origin)
        if u.scheme not in ("http", "https"):
            return False
        h = (u.hostname or "").lower()
        return h in ("127.0.0.1", "localhost", "::1")
    except Exception:
        return False


def _kill_tree(proc: subprocess.Popen) -> None:
    """超时后连子进程一起杀；Windows 用 taskkill /T，POSIX 用新会话进程组。"""
    try:
        if os.name == "nt":
            subprocess.run(
                ["taskkill", "/F", "/T", "/PID", str(proc.pid)],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=5,
                creationflags=0x08000000,
            )
        else:
            os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
    except Exception:
        try:
            proc.kill()
        except Exception:
            pass


def _cleanup_temp(td: str) -> None:
    """清理临时目录；Windows 上句柄刚释放时可能短暂占用，重试但不覆盖工具结果。"""
    for _ in range(10):
        try:
            shutil.rmtree(td)
            return
        except FileNotFoundError:
            return
        except OSError:
            time.sleep(0.1)
    shutil.rmtree(td, ignore_errors=True)


def resolve_tool(name: str, fake: bool = False) -> list[str] | None:
    if fake:
        return [sys.executable, os.path.abspath(__file__), "--fake-tool", name]
    path = shutil.which(name)
    return [path] if path else None


def tool_status(fake: bool = False, tool_dir: str | None = None) -> dict:
    path_prefix = None
    if tool_dir:
        path_prefix = os.environ.get("PATH", "")
        os.environ["PATH"] = tool_dir + os.pathsep + path_prefix
    try:
        out = {}
        for name in TOOL_NAMES:
            cmd = resolve_tool(name, fake)
            out[name] = {"ok": bool(cmd), "path": os.path.basename(cmd[0]) if cmd else None}
        return out
    finally:
        if tool_dir and path_prefix is not None:
            os.environ["PATH"] = path_prefix


def _field(fields: dict, name: str, default: str = "") -> str:
    val = fields.get(name, default)
    if val is None:
        val = default
    if not isinstance(val, str):
        raise CompanionError(f"字段 {name} 必须是字符串")
    if len(val) > MAX_PASSWORD:
        raise CompanionError(f"字段 {name} 太长")
    if "\x00" in val:
        raise CompanionError(f"字段 {name} 含 NUL")
    return val


def build_command(action: str, file_path: str, fields: dict) -> tuple[list[str], str, str]:
    """返回 (argv[不含工具], mode, 展示用动作)。字段全部在服务端白名单校验。"""
    meta = ACTIONS.get(action)
    if not meta:
        raise CompanionError("未知动作：" + str(action))
    mode = meta["mode"]
    if not isinstance(fields, dict):
        raise CompanionError("fields 必须是对象")
    if action == "zsteg.scan":
        return ["-a", file_path], mode, action
    if action == "zsteg.extract":
        expr = _field(fields, "expr", ZSTEG_EXPRS[0])
        if expr not in ZSTEG_EXPRS:
            raise CompanionError("不允许的 zsteg 表达式")
        return ["-E", expr, file_path], mode, action
    if action == "binwalk.scan":
        return [file_path], mode, action
    if action == "binwalk.extract":
        return ["-e", file_path], mode, action
    if action == "exiftool.meta":
        return ["-a", "-G1", "-s", file_path], mode, action
    if action == "exiftool.thumb":
        tag = _field(fields, "tag", EXIF_TAGS[0])
        if tag not in EXIF_TAGS:
            raise CompanionError("不允许的 EXIF 标签")
        return ["-b", "-" + tag, file_path], mode, action
    if action == "steghide.info":
        return ["info", "-p", _field(fields, "password"), file_path], mode, action
    if action == "steghide.extract":
        return ["extract", "-sf", file_path, "-p", _field(fields, "password"), "-f"], mode, action
    if action == "bkcrack.list":
        return ["-L", file_path], mode, action
    if action == "qr.decode":
        return ["-q", "--raw", file_path], mode, action
    raise CompanionError("未知动作：" + str(action))


def _run_limited(argv: list[str], cwd: str, timeout: int) -> tuple[int, bytes, bytes, bool, bool]:
    """运行并限制捕获量；超出部分继续排空但不保存。"""
    kwargs = {
        "cwd": cwd,
        "stdin": subprocess.DEVNULL,
        "stdout": subprocess.PIPE,
        "stderr": subprocess.PIPE,
    }
    if os.name == "nt":
        kwargs["creationflags"] = 0x08000000  # CREATE_NO_WINDOW
    else:
        kwargs["start_new_session"] = True
    proc = subprocess.Popen(argv, **kwargs)
    out = bytearray()
    err = bytearray()
    truncated = [False, False]

    def drain(pipe, buf, cap, idx):
        try:
            while True:
                try:
                    chunk = pipe.read(65536)
                except Exception:
                    break
                if not chunk:
                    break
                if len(buf) < cap:
                    buf.extend(chunk[:cap - len(buf)])
                else:
                    truncated[idx] = True
        finally:
            try:
                pipe.close()
            except Exception:
                pass

    threads = [
        threading.Thread(target=drain, args=(proc.stdout, out, MAX_OUTPUT, 0), daemon=True),
        threading.Thread(target=drain, args=(proc.stderr, err, MAX_ERR, 1), daemon=True),
    ]
    for t in threads:
        t.start()
    try:
        code = proc.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        _kill_tree(proc)
        try:
            proc.wait(timeout=5)
        except Exception:
            pass
        for t in threads:
            t.join(timeout=1)
        raise CompanionError(f"工具超时（>{timeout}s）", 504)
    for t in threads:
        t.join(timeout=1)
    return code, bytes(out), bytes(err), truncated[0], truncated[1]


def _collect_artifacts(workdir: str, input_name: str) -> tuple[list[dict], list[str]]:
    artifacts = []
    skipped = []
    total = 0
    for root, dirs, files in os.walk(workdir):
        dirs[:] = [d for d in dirs if not os.path.islink(os.path.join(root, d))]
        for fn in files:
            full = os.path.join(root, fn)
            if os.path.islink(full):
                continue
            rel = os.path.relpath(full, workdir).replace(os.sep, "/")
            if rel == input_name:
                continue
            try:
                size = os.path.getsize(full)
            except OSError:
                continue
            if len(artifacts) >= MAX_ARTIFACT_FILES:
                skipped.append(rel + "（超过文件数上限）")
                continue
            if total + size > MAX_ARTIFACT_TOTAL:
                skipped.append(rel + "（超过总大小上限）")
                continue
            try:
                with open(full, "rb") as fh:
                    data = fh.read()
            except OSError as e:
                skipped.append(rel + "（读取失败：" + str(e) + "）")
                continue
            total += len(data)
            artifacts.append({
                "name": rel,
                "size": len(data),
                "b64": base64.b64encode(data).decode("ascii"),
            })
    return artifacts, skipped


def _lzma_dict_ok(v: int) -> bool:
    """LZMA 字典大小合法值：2^n 或 2^n + 2^(n-1)。"""
    for n in range(12, 31):
        if v == (1 << n) or v == (1 << n) + (1 << (n - 1)):
            return True
    return False


def find_lzma_offsets(data: bytes, limit: int = 32) -> list[int]:
    """按 binwalk 同款判据找 LZMA 单独格式：props≤224 + 字典大小 + 原长字段。

    该格式没有魔数，只能这样认。
    """
    out: list[int] = []
    for i in range(0, max(0, len(data) - 14)):
        if data[i] > 224:
            continue
        if not _lzma_dict_ok(int.from_bytes(data[i + 1:i + 5], "little")):
            continue
        lo = int.from_bytes(data[i + 5:i + 9], "little")
        hi = int.from_bytes(data[i + 9:i + 13], "little")
        if not ((hi == 0xFFFFFFFF and lo == 0xFFFFFFFF) or (hi == 0 and lo <= 0x10000000)):
            continue
        out.append(i)
        if len(out) >= limit:
            break
    return out


def run_lzma_action(data: bytes, offset: str | None = None) -> dict:
    """内置 LZMA 解压：不起子进程，直接调 Python 的 lzma。"""
    t0 = time.time()
    want = (offset or "").strip()
    if want:
        try:
            candidates = [int(want, 0)]
        except ValueError:
            raise CompanionError("偏移要写成 0x28 或 40 这种形式")
    else:
        candidates = find_lzma_offsets(data)

    last_err = ""
    for off in candidates:
        if off < 0 or off >= len(data):
            continue
        blob = data[off:]
        for fmt, tag in ((lzma.FORMAT_ALONE, "alone"), (lzma.FORMAT_AUTO, "auto")):
            try:
                plain = lzma.decompress(blob, format=fmt)
            except Exception as exc:
                last_err = f"{type(exc).__name__}: {exc}"
                continue
            arts = []
            if plain and len(plain) <= MAX_OUTPUT:
                arts.append({
                    "name": f"lzma-0x{off:x}.bin",
                    "size": len(plain),
                    "b64": base64.b64encode(plain).decode("ascii"),
                })
            return {
                "ok": True,
                "version": VERSION,
                "tool": "builtin",
                "action": "lzma.decompress",
                "label": ACTIONS["lzma.decompress"]["label"],
                "mode": "text",
                "command": f"lzma.decompress 偏移 0x{off:x}（{tag} 格式）",
                "exit": 0,
                "duration_ms": round((time.time() - t0) * 1000),
                "stdout": plain.decode("utf-8", "replace"),
                "stderr": "",
                "truncated": {"stdout": False, "stderr": False},
                "artifacts": arts,
                "skipped": [],
            }
    if want:
        raise CompanionError("这个偏移解不开：" + (last_err or "不是有效的 LZMA 流"))
    raise CompanionError("文件里没找到可解的 LZMA 流" + ("：" + last_err if last_err else ""))


def run_action(tool: str, action: str, data: bytes, name: str,
               fields: dict | None = None, fake: bool = False,
               timeout: int = DEFAULT_TIMEOUT) -> dict:
    fields = fields or {}
    # 内置动作：不需要外部程序，也不写临时文件
    if action == "lzma.decompress":
        if tool != "builtin":
            raise CompanionError("工具/动作不匹配")
        if len(data) > MAX_RAW:
            raise CompanionError("文件太大（>48MB）", 413)
        return run_lzma_action(data, fields.get("offset") if isinstance(fields, dict) else None)
    if tool not in TOOL_NAMES:
        raise CompanionError("未知工具：" + str(tool))
    if action not in ACTIONS or ACTIONS[action]["tool"] != tool:
        raise CompanionError("工具/动作不匹配")
    if len(data) > MAX_RAW:
        raise CompanionError("文件太大（>48MB）", 413)
    resolved = resolve_tool(tool, fake)
    if not resolved:
        raise CompanionError(f"{tool} 未安装或不在 PATH", 400)
    safe_name = sanitize_name(name)
    argv_tail, mode, _ = build_command(action, safe_name, fields)

    td = tempfile.mkdtemp(prefix="mdz-")
    try:
        file_path = os.path.join(td, safe_name)
        with open(file_path, "wb") as fh:
            fh.write(data)
        argv = resolved + argv_tail
        t0 = time.time()
        code, out, err, out_cut, err_cut = _run_limited(argv, td, timeout)
        display_tail = [x.replace(file_path, "<uploaded:" + safe_name + ">") for x in argv_tail]
        for i, arg in enumerate(display_tail):
            if arg == "-p" and i + 1 < len(display_tail):
                display_tail[i + 1] = "<PASSWORD>"
        display = " ".join(shlex.quote(x) for x in [tool] + display_tail)

        # exiftool 没有 ThumbnailImage 时再试 PreviewImage
        if action == "exiftool.thumb" and not out:
            tag = _field(fields, "tag", EXIF_TAGS[0])
            if tag == "ThumbnailImage":
                second = resolved + ["-b", "-PreviewImage", file_path]
                code2, out2, err2, cut2, err2cut = _run_limited(second, td, timeout)
                if out2:
                    out, err, out_cut, err_cut = out2, err2, cut2, err2cut
                    code = code2
                    display += " || " + " ".join(shlex.quote(x) for x in [tool, "-b", "-PreviewImage", "<uploaded:" + safe_name + ">"])

        artifacts = []
        skipped = []
        if mode == "binary" and out:
            artifacts.append({
                "name": tool + "-" + action.split(".")[-1] + ".bin",
                "size": len(out),
                "b64": base64.b64encode(out).decode("ascii"),
            })
        elif mode == "text" and out:
            pass
        # 文本动作也可能产生文件（binwalk extract / steghide extract）
        files, skipped = _collect_artifacts(td, safe_name)
        artifacts.extend(files)

        text_out = ""
        if mode in ("text", "files"):
            text_out = out.decode("utf-8", "replace")
        text_err = err.decode("utf-8", "replace")
        return {
            "ok": True,
            "version": VERSION,
            "tool": tool,
            "action": action,
            "label": ACTIONS[action]["label"],
            "mode": mode,
            "command": display,
            "exit": code,
            "duration_ms": round((time.time() - t0) * 1000),
            "stdout": text_out,
            "stderr": text_err,
            "truncated": {"stdout": out_cut, "stderr": err_cut},
            "artifacts": artifacts,
            "skipped": skipped,
        }
    finally:
        _cleanup_temp(td)


def _fake_tool_main(name: str, argv: list[str]) -> int:
    joined = " ".join(argv)
    if name == "zsteg":
        if "-E" in argv:
            sys.stdout.buffer.write(b"FAKE_ZSTEG_BINARY\n\x00\x01")
            sys.stdout.buffer.flush()
        else:
            print("FAKE zsteg scan")
            print("meta:", joined)
        return 0
    if name == "binwalk":
        print("FAKE binwalk", "extract" if "-e" in argv else "scan")
        if "-e" in argv:
            outdir = Path("_upload.extracted")
            outdir.mkdir(exist_ok=True)
            (outdir / "payload.txt").write_text("FAKE_BINWALK_PAYLOAD\n", encoding="utf-8")
        return 0
    if name == "exiftool":
        if "-b" in argv:
            sys.stdout.buffer.write(b"\xff\xd8FAKE_EXIF_THUMB\xff\xd9")
            return 0
        print("ExifTool Version Number         : FAKE")
        print("File Name                       : upload")
        print("Image Width                     : 64")
        return 0
    if name == "steghide":
        if "extract" in argv:
            Path("steghide-output.txt").write_text("FAKE_STEGHIDE_PAYLOAD\n", encoding="utf-8")
            print("FAKE steghide extract")
        else:
            print("FAKE steghide info")
        return 0
    if name == "bkcrack":
        print("FAKE bkcrack -L")
        print("Index  Encryption  Method  Size  Name")
        return 0
    print("FAKE unknown tool", name, joined)
    return 1


class Handler(BaseHTTPRequestHandler):
    server_version = "misc-dashouzi-companion/" + VERSION
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        pass

    def _cors(self):
        origin = self.headers.get("Origin")
        if _origin_allowed(origin):
            self.send_header("Access-Control-Allow-Origin", origin or "*")
            self.send_header("Vary", "Origin")
        self.send_header("Access-Control-Allow-Headers", "content-type, x-mdz-token")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Private-Network", "true")
        self.send_header("Cache-Control", "no-store")

    def _json(self, code: int, obj: dict):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self._cors()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _auth(self) -> bool:
        token = self.headers.get("X-MDZ-Token", "")
        try:
            ok = hmac.compare_digest(token, self.server.token)
        except TypeError:
            ok = False
        if not ok:
            self.close_connection = True
            self._json(401, {"ok": False, "error": "token 不正确"})
            return False
        return True

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):
        self.server.last_seen = time.time()
        if self.path.split("?", 1)[0] != "/api/status":
            self._json(404, {"ok": False, "error": "not found"})
            return
        if not self._auth():
            return
        self._json(200, {
            "ok": True,
            "version": VERSION,
            "platform": platform.platform(),
            "tools": tool_status(self.server.fake, self.server.tool_dir),
            "actions": action_specs(),
        })

    def do_POST(self):
        self.server.last_seen = time.time()
        if self.path.split("?", 1)[0] == "/api/bye":
            # 页面关闭时发来的告别：立刻退出，跟着浏览器一起关
            if not self._auth():
                return
            self._json(200, {"ok": True, "bye": True})
            if self.server.idle_limit:
                os._exit(0)
            return
        if self.path.split("?", 1)[0] != "/api/run":
            self._json(404, {"ok": False, "error": "not found"})
            return
        if not self._auth():
            return
        length_raw = self.headers.get("Content-Length")
        try:
            length = int(length_raw or "0")
        except ValueError:
            self._json(400, {"ok": False, "error": "Content-Length 无效"})
            return
        if length <= 0 or length > MAX_BODY:
            self.close_connection = True
            self._json(413, {"ok": False, "error": "请求体为空或过大"})
            return
        body = self.rfile.read(length)
        if len(body) != length:
            self._json(400, {"ok": False, "error": "请求体不完整"})
            return
        try:
            payload = json.loads(body.decode("utf-8"))
        except Exception:
            self._json(400, {"ok": False, "error": "JSON 解析失败"})
            return
        if not isinstance(payload, dict):
            self._json(400, {"ok": False, "error": "payload 必须是对象"})
            return
        try:
            data_b64 = payload.get("data_b64") or ""
            if not isinstance(data_b64, str):
                raise CompanionError("data_b64 必须是字符串")
            try:
                data = base64.b64decode(data_b64, validate=True)
            except Exception:
                raise CompanionError("data_b64 不是合法 base64")
            if len(data) > MAX_RAW:
                raise CompanionError("文件太大（>48MB）", 413)
            fields = payload.get("fields") or {}
            if not isinstance(fields, dict):
                raise CompanionError("fields 必须是对象")
            with self.server.run_lock:
                result = run_action(
                    str(payload.get("tool") or ""),
                    str(payload.get("action") or ""),
                    data,
                    str(payload.get("name") or "upload.bin"),
                    fields,
                    fake=self.server.fake,
                    timeout=self.server.timeout,
                )
            self._json(200, result)
        except CompanionError as e:
            self._json(e.code, {"ok": False, "error": e.message})
        except Exception:
            self._json(500, {"ok": False, "error": "运行失败（内部错误）"})


def _idle_watchdog(server) -> None:
    """页面不再发心跳就自己退，避免隐藏控制台后留下孤儿进程。"""
    while True:
        time.sleep(1.0)
        if time.time() - getattr(server, "last_seen", 0) > server.idle_limit:
            print("空闲超时，退出", flush=True)
            os._exit(0)


def make_server(host: str, port: int, token: str, fake: bool = False,
                timeout: int = DEFAULT_TIMEOUT, tool_dir: str | None = None,
                idle: int = 0) -> ThreadingHTTPServer:
    if not _is_loopback(host):
        raise SystemExit("拒绝启动：companion 只能监听回环地址（127.0.0.1/localhost）")
    if not token or len(token) < 8:
        raise SystemExit("token 至少 8 个字符")
    if tool_dir:
        os.environ["PATH"] = tool_dir + os.pathsep + os.environ.get("PATH", "")
    try:
        server = ThreadingHTTPServer((host, port), Handler)
    except OSError as e:
        raise SystemExit(f"无法监听 {host}:{port}：{e}") from e
    bound = str(server.server_address[0]).split("%", 1)[0]
    try:
        bound_loopback = ipaddress.ip_address(bound).is_loopback
    except ValueError:
        bound_loopback = False
    if not bound_loopback:
        server.server_close()
        raise SystemExit(f"拒绝启动：实际绑定地址 {bound} 不是回环地址")
    server.token = token
    server.fake = fake
    server.timeout = timeout
    server.tool_dir = tool_dir
    server.idle_limit = max(0, int(idle))
    server.last_seen = time.time()
    server.run_lock = threading.Lock()
    return server


def main(argv: list[str] | None = None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    if "--fake-tool" in argv:
        idx = argv.index("--fake-tool")
        name = argv[idx + 1] if idx + 1 < len(argv) else ""
        return _fake_tool_main(name, argv[idx + 2:])
    parser = argparse.ArgumentParser(description="misc大手子 本地工具桥")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--token", default=None)
    parser.add_argument("--token-file", default=None,
                        help="从文件读 token；文件不存在就生成并写入（一键启动用，token 保持稳定）")
    parser.add_argument("--fake-tools", action="store_true", help="测试模式：所有工具用内置假实现")
    parser.add_argument("--timeout", type=int, default=DEFAULT_TIMEOUT)
    parser.add_argument("--tool-dir", default=None, help="额外的工具目录（加到 PATH 前）")
    parser.add_argument("--exit-when-idle", type=int, default=0, metavar="SEC",
                        help="空闲超过 SEC 秒就自动退出（0=不退出）。配合网页心跳用，页面关掉后服务自己收摊")
    args = parser.parse_args(argv)

    token = args.token
    if not token and args.token_file:
        tf = Path(args.token_file)
        if tf.exists():
            token = tf.read_text(encoding="utf-8").strip()
        if not token:
            token = secrets.token_urlsafe(24)
            tf.write_text(token, encoding="utf-8")
    token = token or secrets.token_urlsafe(24)
    server = make_server(args.host, args.port, token, args.fake_tools, args.timeout,
                         args.tool_dir, args.exit_when_idle)
    if server.idle_limit:
        threading.Thread(target=_idle_watchdog, args=(server,), daemon=True).start()
    port = server.server_address[1]
    tools = tool_status(args.fake_tools, args.tool_dir)
    print(f"misc大手子 companion v{VERSION}")
    print(f"URL=http://127.0.0.1:{port}")
    print(f"PORT={port}")
    print(f"TOKEN={token}")
    print("tools: " + " ".join(f"{k}={'yes' if v['ok'] else 'no'}" for k, v in tools.items()))
    if args.fake_tools:
        print("mode: fake tools (仅测试)")
    print("只监听本机；Ctrl+C 退出")
    sys.stdout.flush()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n退出")
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
