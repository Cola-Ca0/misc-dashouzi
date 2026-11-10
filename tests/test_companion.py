#!/usr/bin/env python3
"""companion.py 回归测试：命令白名单、鉴权、假装工具、真实 exiftool（可选）。"""
import base64
import http.client
import json
import shutil
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
import companion  # noqa: E402

TOKEN = "testtoken123"


class CompanionUnit(unittest.TestCase):
    def test_sanitize_name(self):
        self.assertEqual(companion.sanitize_name("../../etc/passwd"), "passwd")
        self.assertEqual(companion.sanitize_name("a<b>?.png"), "ab.png")
        self.assertEqual(companion.sanitize_name("a&b;c.png"), "abc.png")
        self.assertEqual(companion.sanitize_name("-rf.jpg"), "_-rf.jpg")
        self.assertEqual(companion.sanitize_name("CON.png"), "_CON.png")
        self.assertEqual(companion.sanitize_name(""), "upload.bin")
        self.assertEqual(companion.sanitize_name(".."), "upload.bin")

    def test_build_zsteg_extract(self):
        argv, mode, _ = companion.build_command("zsteg.extract", "a.png", {"expr": "b1,rgb,lsb,xy"})
        self.assertEqual(mode, "binary")
        self.assertIn("-E", argv)
        self.assertIn("b1,rgb,lsb,xy", argv)
        with self.assertRaises(companion.CompanionError):
            companion.build_command("zsteg.extract", "a.png", {"expr": "b1,rgb,lsb,xy; rm -rf /"})

    def test_build_steghide_and_action_mismatch(self):
        argv, mode, _ = companion.build_command("steghide.extract", "a.jpg", {"password": "pw"})
        self.assertEqual(mode, "files")
        self.assertIn("-sf", argv)
        self.assertIn("pw", argv)
        with self.assertRaises(companion.CompanionError):
            companion.run_action("zsteg", "steghide.extract", b"x", "a.jpg", {}, fake=True)

    def test_server_rejects_remote_bind(self):
        with self.assertRaises(SystemExit):
            companion.make_server("0.0.0.0", 0, TOKEN, fake=True)
        with self.assertRaises(SystemExit):
            companion.make_server("::1", 0, TOKEN, fake=True)

    def test_timeout_kills_tree_and_cleans(self):
        before = set(Path(tempfile.gettempdir()).glob("mdz-*"))
        sleep_cmd = [sys.executable, "-c", "import time; time.sleep(10)"]
        t0 = time.time()
        with mock.patch.object(companion, "resolve_tool", return_value=sleep_cmd):
            with self.assertRaises(companion.CompanionError) as cm:
                companion.run_action("zsteg", "zsteg.scan", b"x", "a.png", fake=False, timeout=1)
        self.assertEqual(cm.exception.code, 504)
        self.assertLess(time.time() - t0, 6)
        after = set(Path(tempfile.gettempdir()).glob("mdz-*"))
        self.assertEqual(after, before, "超时后临时目录未清理：" + repr(after - before))

    def test_action_specs_unique(self):
        specs = companion.action_specs()
        ids = [x["id"] for x in specs]
        self.assertEqual(len(ids), len(set(ids)))
        self.assertEqual(len(specs), len(companion.ACTIONS))

    def test_lzma_decompress_builtin(self):
        blob = companion.lzma.compress(b"flag{lzma_builtin}", format=companion.lzma.FORMAT_ALONE)
        payload = b"\x00" * 37 + blob
        # 自动定位
        r = companion.run_action("builtin", "lzma.decompress", payload, "x.bin", {})
        self.assertIn("flag{lzma_builtin}", r["stdout"])
        self.assertEqual(r["tool"], "builtin")
        self.assertTrue(r["artifacts"], "解出的明文应当作为产物返回")
        # 显式偏移（0x25 = 37），十进制写法也要认
        r2 = companion.run_action("builtin", "lzma.decompress", payload, "x.bin", {"offset": "0x25"})
        self.assertIn("flag{lzma_builtin}", r2["stdout"])
        r3 = companion.run_action("builtin", "lzma.decompress", payload, "x.bin", {"offset": "37"})
        self.assertIn("flag{lzma_builtin}", r3["stdout"])
        # 没有 LZMA 时必须明确报错，不能静默成功
        with self.assertRaises(companion.CompanionError):
            companion.run_action("builtin", "lzma.decompress", b"no lzma here " * 8, "x.bin", {})
        # 工具/动作不匹配要拒绝
        with self.assertRaises(companion.CompanionError):
            companion.run_action("zsteg", "lzma.decompress", payload, "x.bin", {})


class CompanionHTTP(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.srv = companion.make_server("127.0.0.1", 0, TOKEN, fake=True)
        cls.port = cls.srv.server_address[1]
        cls.thread = threading.Thread(target=cls.srv.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.srv.shutdown()
        cls.srv.server_close()

    def call(self, path, body=None, token=TOKEN):
        req = urllib.request.Request(
            f"http://127.0.0.1:{self.port}{path}", data=body,
            headers={"X-MDZ-Token": token, "Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=20) as f:
                return f.status, json.loads(f.read())
        except urllib.error.HTTPError as e:
            try:
                return e.code, json.loads(e.read())
            finally:
                e.close()

    def run_payload(self, tool, action, data=b"hello", name="demo.png", fields=None):
        return json.dumps({
            "tool": tool, "action": action, "name": name,
            "data_b64": base64.b64encode(data).decode(), "fields": fields or {},
        }).encode()

    def test_status_and_auth(self):
        code, body = self.call("/api/status")
        self.assertEqual(code, 200)
        self.assertTrue(body["ok"])
        self.assertEqual(set(body["tools"]), set(companion.TOOL_NAMES))
        self.assertTrue(all(v["ok"] for v in body["tools"].values()))
        code, body = self.call("/api/status", token="wrong-token")
        self.assertEqual(code, 401)
        self.assertFalse(body["ok"])

    def test_non_ascii_token_is_401(self):
        req = urllib.request.Request(
            f"http://127.0.0.1:{self.port}/api/status",
            headers={"X-MDZ-Token": "üü"})
        with self.assertRaises(urllib.error.HTTPError) as cm:
            urllib.request.urlopen(req, timeout=10)
        self.assertEqual(cm.exception.code, 401)
        cm.exception.close()

    def test_cors_origin_allowlist(self):
        def headers_for(origin):
            h = {"X-MDZ-Token": TOKEN}
            if origin is not None:
                h["Origin"] = origin
            req = urllib.request.Request(f"http://127.0.0.1:{self.port}/api/status", headers=h)
            with urllib.request.urlopen(req, timeout=10) as f:
                return f.headers
        self.assertIsNone(headers_for("http://evil.example").get("Access-Control-Allow-Origin"))
        self.assertEqual(headers_for("null").get("Access-Control-Allow-Origin"), "null")
        self.assertEqual(headers_for("http://127.0.0.1:3000").get("Access-Control-Allow-Origin"), "http://127.0.0.1:3000")
        self.assertEqual(headers_for(None).get("Access-Control-Allow-Origin"), "*")

    def test_oversized_body_is_413(self):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        try:
            conn.putrequest("POST", "/api/run")
            conn.putheader("X-MDZ-Token", TOKEN)
            conn.putheader("Content-Type", "application/json")
            conn.putheader("Content-Length", str(companion.MAX_BODY + 1))
            conn.endheaders()
            resp = conn.getresponse()
            self.assertEqual(resp.status, 413)
            resp.read()
        finally:
            conn.close()

    def test_fake_zsteg_scan_and_extract(self):
        code, body = self.call("/api/run", self.run_payload("zsteg", "zsteg.scan"))
        self.assertEqual(code, 200)
        self.assertIn("FAKE zsteg scan", body["stdout"])
        self.assertEqual(body["exit"], 0)
        code, body = self.call("/api/run", self.run_payload("zsteg", "zsteg.extract"))
        self.assertEqual(code, 200)
        names = [a["name"] for a in body["artifacts"]]
        self.assertIn("zsteg-extract.bin", names)
        art = next(a for a in body["artifacts"] if a["name"] == "zsteg-extract.bin")
        self.assertTrue(base64.b64decode(art["b64"]).startswith(b"FAKE_ZSTEG_BINARY"))

    def test_fake_binwalk_and_steghide_artifacts(self):
        code, body = self.call("/api/run", self.run_payload("binwalk", "binwalk.extract"))
        self.assertEqual(code, 200)
        self.assertIn("FAKE binwalk extract", body["stdout"])
        self.assertTrue(any(a["name"].endswith("payload.txt") for a in body["artifacts"]))
        code, body = self.call("/api/run", self.run_payload(
            "steghide", "steghide.extract", name="demo.jpg", fields={"password": "pw"}))
        self.assertEqual(code, 200)
        self.assertTrue(any(a["name"] == "steghide-output.txt" for a in body["artifacts"]))
        self.assertIn("<PASSWORD>", body["command"])
        self.assertNotIn(" pw", body["command"])
        code, body = self.call("/api/run", self.run_payload("bkcrack", "bkcrack.list", name="demo.zip"))
        self.assertEqual(code, 200)
        self.assertIn("FAKE bkcrack", body["stdout"])

    def test_rejects_bad_requests(self):
        code, body = self.call("/api/run", self.run_payload("zsteg", "steghide.extract"))
        self.assertEqual(code, 400)
        self.assertFalse(body["ok"])
        code, body = self.call("/api/run", self.run_payload("zsteg", "nope"))
        self.assertEqual(code, 400)
        bad = json.dumps({"tool": "zsteg", "action": "zsteg.scan", "data_b64": "!!!"}).encode()
        code, body = self.call("/api/run", bad)
        self.assertEqual(code, 400)

    @unittest.skipUnless(shutil.which("exiftool"), "exiftool 未安装")
    def test_real_exiftool_meta(self):
        fixture = ROOT / "tests" / "fixtures" / "exif_xp.jpg"
        if not fixture.exists():
            self.skipTest("缺少 exif fixture")
        res = companion.run_action(
            "exiftool", "exiftool.meta", fixture.read_bytes(), fixture.name,
            {}, fake=False, timeout=30)
        self.assertEqual(res["exit"], 0)
        self.assertIn("ExifTool", res["stdout"])
        self.assertIsInstance(res["artifacts"], list)


if __name__ == "__main__":
    unittest.main(verbosity=2)
