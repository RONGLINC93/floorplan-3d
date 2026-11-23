# 户型装修方案 · 本地服务器（纯 Python 标准库，无第三方依赖）
# 功能：托管网页界面（index.html + libs/）；方案存取 API（JSON，原子写入防损坏）
# 启动：python app.py [--port 8765] [--data-dir plans]
#       飞牛 fnOS 原生应用由 cmd/main 传入 --port 与 --data-dir（应用数据目录）
"""Floor-plan app: stdlib-only server hosting the web UI and plan storage API."""
import argparse, gzip, json, socket, sys, threading, time, webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import quote, unquote, urlsplit

BASE = Path(__file__).resolve().parent
# 网页目录：脚本同级有 index.html 就用同级（本地直接运行），否则用 www/ 子目录（fnOS 应用包）
WWW = BASE if (BASE / "index.html").exists() else BASE / "www"
LIBS = WWW / "libs"
DATA_DIR = BASE / "plans"          # 可被 --data-dir 覆盖

CTYPES = {".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
          ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
          ".json": "application/json; charset=utf-8", ".png": "image/png",
          ".jpg": "image/jpeg", ".svg": "image/svg+xml", ".ico": "image/x-icon",
          ".wasm": "application/wasm", ".woff2": "font/woff2", ".txt": "text/plain; charset=utf-8"}


_WINDOWS_RESERVED = {"con", "prn", "aux", "nul"} | {f"com{i}" for i in range(1, 10)} | {f"lpt{i}" for i in range(1, 10)}


def plan_path(name: str) -> Path:
    """校验方案名（防路径穿越），返回对应的 JSON 文件路径。"""
    name = name.strip()
    # 拦 / \ ..、Windows 盘符冒号（PureWindowsPath 遇 'C:x' 会整体换盘符逃出数据目录）、
    # 控制字符与 Windows 保留设备名（con / nul / com1 …）
    if (not name or len(name) > 80 or "/" in name or "\\" in name or ":" in name
            or name in {".", ".."} or any(ord(c) < 32 for c in name)
            or name.split(".")[0].lower() in _WINDOWS_RESERVED):
        raise ValueError("方案名不合法")
    return DATA_DIR / (name + ".json")


_PLAN_LOCKS = {}                     # 方案写入锁：同名方案并发保存互斥（固定 .tmp 文件名下必须串行）
_PLAN_LOCKS_GUARD = threading.Lock()


def _plan_lock(path: Path) -> threading.Lock:
    with _PLAN_LOCKS_GUARD:
        lk = _PLAN_LOCKS.get(path)
        if lk is None:
            lk = _PLAN_LOCKS[path] = threading.Lock()
        return lk


class Handler(BaseHTTPRequestHandler):
    server_version = "FloorPlanServer/1.0"

    def log_message(self, fmt, *args):
        sys.stderr.write("[%s] %s\n" % (self.log_date_time_string(), fmt % args))

    def _reply(self, code, body, ctype="application/json; charset=utf-8"):
        if isinstance(body, (dict, list)):
            body = json.dumps(body, ensure_ascii=False).encode("utf-8")
        elif isinstance(body, str):
            body = body.encode("utf-8")
        self.send_response(code)
        # 文本类响应超 1.4KB 时 gzip 压缩：index.html 有 1.6MB，局域网手机 / 弱网首次加载明显提速（压缩比约 5:1）
        if (len(body) > 1400 and "gzip" in (self.headers.get("Accept-Encoding") or "").lower()
                and (ctype.startswith("text/") or "json" in ctype or ctype == "image/svg+xml")):
            body = gzip.compress(body, 6)
            self.send_header("Content-Encoding", "gzip")
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _serve_file(self, path: Path):
        try:
            body = path.read_bytes()
        except OSError:
            self._reply(404, {"detail": "文件不存在"})
            return
        self._reply(200, body, CTYPES.get(path.suffix.lower(), "application/octet-stream"))

    def _static(self, url_path: str):
        if url_path == "/":
            self._serve_file(WWW / "index.html")
            return True
        if url_path.startswith("/libs/"):
            f = (LIBS / unquote(url_path[len("/libs/"):])).resolve()
            if LIBS.resolve() not in f.parents and f != LIBS.resolve():
                self._reply(403, {"detail": "路径不合法"})
            elif f.is_file():
                self._serve_file(f)
            else:
                self._reply(404, {"detail": "文件不存在"})
            return True
        # 站点根目录下的图标（favicon / manifest 图标等）：只放行单层文件名 + 图片类扩展名，防止读到别的东西
        name = url_path.lstrip("/")
        if name and "/" not in name and Path(name).suffix.lower() in (".png", ".jpg", ".jpeg", ".ico", ".svg", ".webmanifest", ".txt"):
            f = (WWW / name).resolve()
            if f.parent == WWW.resolve() and f.is_file():
                self._serve_file(f)
                return True
        return False

    def _plan_name(self, thumbnail=False):
        name = urlsplit(self.path).path[len("/api/plans/"):]
        if thumbnail:
            name = name[:-len("/thumbnail")]
        return plan_path(unquote(name))

    def do_GET(self):
        path = urlsplit(self.path).path
        if self._static(path):
            return
        if path == "/api/plans":
            DATA_DIR.mkdir(parents=True, exist_ok=True)
            items = []
            for f in DATA_DIR.glob("*.json"):
                try:
                    st = f.stat()
                except OSError:
                    continue
                item = {"name": f.stem, "size": st.st_size, "mtime": st.st_mtime}
                try:
                    thumb = f.with_suffix(".png")
                    if thumb.is_file():
                        item["thumbnail"] = "/api/plans/" + quote(f.stem, safe="") + "/thumbnail?v=" + str(thumb.stat().st_mtime_ns)
                except OSError:
                    pass
                items.append(item)
            items.sort(key=lambda x: -x["mtime"])
            self._reply(200, items)
        elif path.startswith("/api/plans/") and path.endswith("/thumbnail"):
            try:
                p = self._plan_name(True).with_suffix(".png")
            except ValueError as e:
                self._reply(400, {"detail": str(e)}); return
            self._serve_file(p)
        elif path.startswith("/api/plans/"):
            try:
                p = self._plan_name()
            except ValueError as e:
                self._reply(400, {"detail": str(e)}); return
            if not p.exists():
                self._reply(404, {"detail": "方案不存在"})
            else:
                self._serve_file(p)
        else:
            self._reply(404, {"detail": "接口不存在"})

    def do_PUT(self):
        path = urlsplit(self.path).path
        if not path.startswith("/api/plans/"):
            self._reply(404, {"detail": "接口不存在"}); return
        thumbnail = path.endswith("/thumbnail")
        try:
            p = self._plan_name(thumbnail)
        except ValueError as e:
            self._reply(400, {"detail": str(e)}); return
        try:
            n = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            n = 0
        if n <= 0 or n > (2 * 1024 * 1024 if thumbnail else 64 * 1024 * 1024):
            self._reply(400, {"detail": "请求体大小异常"}); return
        if thumbnail:
            if self.headers.get("Content-Type", "").split(";", 1)[0].strip().lower() != "image/png":
                self._reply(400, {"detail": "缩略图必须是 PNG"}); return
            data = self.rfile.read(n)
            if not data.startswith(b"\x89PNG\r\n\x1a\n"):
                self._reply(400, {"detail": "缩略图不是合法 PNG"}); return
            if not p.is_file():
                self._reply(404, {"detail": "方案不存在"}); return
            DATA_DIR.mkdir(parents=True, exist_ok=True)
            try:
                with _plan_lock(p):
                    thumb = p.with_suffix(".png")
                    tmp = thumb.with_suffix(".png.tmp")
                    tmp.write_bytes(data)
                    tmp.replace(thumb)
            except OSError:
                self._reply(500, {"detail": "缩略图写入失败（磁盘 / 权限）"}); return
            self._reply(200, {"ok": True}); return
        try:
            data = json.loads(self.rfile.read(n).decode("utf-8"))
        except Exception:
            self._reply(400, {"detail": "请求体不是合法 JSON"}); return
        if not isinstance(data, dict) or not isinstance(data.get("furniture"), list):
            self._reply(400, {"detail": "方案数据不完整"}); return
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        try:
            with _plan_lock(p):
                tmp = p.with_suffix(".json.tmp")    # 先写临时文件再原子替换，避免写一半损坏（同名并发由 _plan_lock 串行化）
                tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
                tmp.replace(p)
        except OSError:
            self._reply(500, {"detail": "方案写入失败（磁盘 / 权限）"}); return
        try:
            p.with_suffix(".png").unlink()   # 覆盖方案后清除旧图，等待本次保存上传新缩略图
        except OSError:
            pass
        self._reply(200, {"ok": True})

    def do_DELETE(self):
        if not urlsplit(self.path).path.startswith("/api/plans/"):
            self._reply(404, {"detail": "接口不存在"}); return
        try:
            p = self._plan_name()
        except ValueError as e:
            self._reply(400, {"detail": str(e)}); return
        try:
            if p.exists():
                p.unlink()
            p.with_suffix(".png").unlink()
        except OSError:
            pass
        self._reply(200, {"ok": True})


class DualStackServer(ThreadingHTTPServer):
    """:: 监听并关闭 IPV6_V6ONLY，同一端口同时接受 IPv4 与 IPv6（双栈）。"""
    address_family = socket.AF_INET6

    def server_bind(self):
        try:
            self.socket.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 0)
        except OSError:
            pass
        super().server_bind()


def main():
    ap = argparse.ArgumentParser(description="户型装修方案服务器")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--data-dir", default=str(BASE / "plans"))
    ap.add_argument("--no-browser", action="store_true")
    args = ap.parse_args()
    global DATA_DIR
    DATA_DIR = Path(args.data_dir)
    if not args.no_browser:
        threading.Thread(target=lambda: (time.sleep(1.2), webbrowser.open(
            "http://localhost:%d/" % args.port)), daemon=True).start()
    try:
        srv = DualStackServer(("::", args.port), Handler)
        print("户型装修方案服务器: http://0.0.0.0:%d（IPv4/IPv6 双栈）  (网页目录 %s, 方案目录 %s)"
              % (args.port, WWW, DATA_DIR), flush=True)
    except OSError as e:
        srv = ThreadingHTTPServer(("0.0.0.0", args.port), Handler)
        print("户型装修方案服务器: http://0.0.0.0:%d（仅 IPv4，IPv6 不可用：%s）  (网页目录 %s, 方案目录 %s)"
              % (args.port, e, WWW, DATA_DIR), flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    main()
