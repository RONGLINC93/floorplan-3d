"""户型装修设计 · 飞牛 fnOS 原生应用打包脚本（.fpk）

参照已验证可安装运行的 fnmonitorpro 模式：**原生应用**（无 Docker），
飞牛系统自带 python3 直接运行 app.py，由 cmd/main 用 PID 文件管理启停。
用官方 fnpack 分别打包 x86 / arm 两个架构。

用法：python pack_fpk.py [版本号]
产物：floorplan3d-<版本>-fnos-x86.fpk / floorplan3d-<版本>-fnos-arm.fpk
安装：fnOS 应用中心 → 手动安装 → 按 NAS 架构选择 .fpk
"""
import hashlib
import json
import re
import shutil
import stat
import struct
import subprocess
import sys
import tarfile
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parent
APPNAME = "floorplan3d"
DISPLAY_NAME = "户型装修设计"
PORT = 8765
FNPACK = ROOT / "tools" / "bin" / "fnpack.exe"      # 官方打包工具（Windows 版）

WWW_FILES = ["index.html", "libs", "LICENSE", "README.md"]
EXCLUDE = {".env", ".git", "__pycache__", ".playwright-cli", "plans",
           "server.log", ".codebuddy", "node_modules", ".idea", ".vscode"}


# ---------------------------------------------------------------- PNG 图标生成（纯 Python）
def make_icon_png(size: int) -> bytes:
    bg, fg = (40, 90, 180), (245, 248, 255)
    px = [[bg] * size for _ in range(size)]

    def fill(x0, y0, x1, y1, c):
        for y in range(max(0, y0), min(size, y1)):
            for x in range(max(0, x0), min(size, x1)):
                px[y][x] = c

    u = size / 64.0
    fill(int(14 * u), int(26 * u), int(50 * u), int(50 * u), fg)
    cx = size / 2
    top = int(8 * u)
    for y in range(top, int(28 * u)):
        w = int(26 * u * (y - top) / max(1, int(20 * u))) + 1
        fill(int(cx - w), y, int(cx + w), y + 1, fg)
    fill(int(27 * u), int(36 * u), int(37 * u), int(50 * u), bg)
    raw = b"".join(b"\x00" + bytes(v for p in row for v in p) for row in px)

    def chunk(tag, data):
        c = struct.pack(">I", len(data)) + tag + data
        return c + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    return (b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b""))


# ---------------------------------------------------------------- fnpack 工程文件内容
def manifest_text(version: str, platform: str) -> str:
    """fnOS manifest：key=value 紧凑格式（checksum 由 fnpack 构建时写入）。"""
    return (f"appname={APPNAME}\n"
            f"version={version}\n"
            f"display_name={DISPLAY_NAME}\n"
            f"desc=纯前端的户型装修设计工具：2D 平面图摆放家具、拆改墙体、测量尺寸，"
            f"一键切换 Three.js 3D 场景鸟瞰或第一人称漫游，支持方案保存到服务器。仅供学习交流使用。\n"
            f"source=thirdparty\n"
            f"platform={platform}\n"
            f"maintainer=RONGLINC93\n"
            f"maintainer_url=https://github.com/RONGLINC93/floorplan-3d\n"
            f"distributor=RONGLINC93\n"
            f"distributor_url=https://github.com/RONGLINC93/floorplan-3d\n"
            f"os_min_version=0.9.0\n"
            f"desktop_uidir=ui\n"
            f"desktop_applaunchname={APPNAME}.Application\n"
            f"service_port={PORT}\n"
            f"checkport=true\n"
            f"ctl_stop=true\n"
            f"disable_authorization_path=false\n"
            f"changelog={version} 新增指北针 / 电梯与楼板 / 女儿墙 / 雨棚等建筑构件，"
            f"左右侧栏改为选项夹，服务器支持 IPv4/IPv6 双栈。\n")


SHEBANG = "#!/bin/bash\n"


def cmd_main_text() -> str:
    # 与 fnmonitorpro 的 cmd/main 同款：PID 文件管理 python3 进程
    return SHEBANG + """# 户型装修设计 生命周期主脚本
APP_NAME="${TRIM_APPNAME:-floorplan3d}"
PID_FILE="${TRIM_PKGVAR}/app.pid"
LOG_FILE="${TRIM_PKGVAR}/app.log"
APP_DIR="${TRIM_APPDEST}"
PORT="${TRIM_SERVICE_PORT:-8765}"
SERVICE_CMD="python3 $APP_DIR/app.py --port $PORT --data-dir $TRIM_PKGVAR/plans"

is_running() {
    [ -f "$PID_FILE" ] || return 1
    local pid
    pid=$(tr -d '[:space:]' < "$PID_FILE")
    [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null
}

start() {
    if is_running; then
        echo "$APP_NAME is already running"
        exit 0
    fi
    mkdir -p "${TRIM_PKGVAR}/plans" 2>/dev/null || true
    if [ ! -f "$APP_DIR/app.py" ]; then
        echo "错误：未找到 app.py（$APP_DIR/app.py）" > "$TRIM_TEMP_LOGFILE"
        exit 1
    fi
    if ! command -v python3 >/dev/null 2>&1; then
        echo "错误：系统中未找到 python3，无法启动" > "$TRIM_TEMP_LOGFILE"
        exit 1
    fi
    cd "$APP_DIR" || { echo "错误：无法进入应用目录 $APP_DIR" > "$TRIM_TEMP_LOGFILE"; exit 1; }
    nohup $SERVICE_CMD >> "$LOG_FILE" 2>&1 &
    echo $! > "$PID_FILE"
    sleep 1.5
    if is_running; then
        echo "$APP_NAME started (pid $(tr -d '[:space:]' < "$PID_FILE"))"
        exit 0
    fi
    echo "错误：$APP_NAME 启动失败，请查看日志 $LOG_FILE" > "$TRIM_TEMP_LOGFILE"
    tail -n 20 "$LOG_FILE" >> "$TRIM_TEMP_LOGFILE" 2>/dev/null
    rm -f "$PID_FILE"
    exit 1
}

stop() {
    if [ -f "$PID_FILE" ]; then
        local pid
        pid=$(tr -d '[:space:]' < "$PID_FILE")
        if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
            kill -TERM "$pid" 2>/dev/null
            local i=0
            while kill -0 "$pid" 2>/dev/null && [ $i -lt 20 ]; do
                sleep 0.5
                i=$((i + 1))
            done
            if kill -0 "$pid" 2>/dev/null; then
                kill -KILL "$pid" 2>/dev/null
            fi
        fi
        rm -f "$PID_FILE"
    fi
    echo "$APP_NAME stopped"
    exit 0
}

status() {
    if is_running; then
        echo "$APP_NAME is running"
        exit 0
    fi
    rm -f "$PID_FILE"
    echo "$APP_NAME is not running"
    exit 3
}

log() {
    if [ -f "$LOG_FILE" ]; then
        tail -n "${2:-100}" "$LOG_FILE"
    else
        echo "暂无日志"
    fi
    exit 0
}

case "$1" in
    start)   start ;;
    stop)    stop ;;
    restart) stop; sleep 1; start ;;
    status)  status ;;
    log)     log "$@" ;;
    *)       echo "用法: $0 {start|stop|restart|status|log}"; exit 1 ;;
esac
"""


def cmd_scripts() -> dict:
    stub = SHEBANG + "# 系统会先调用 main stop / start，此处无需额外操作\nexit 0\n"
    install_init = SHEBANG + """# 安装前检查：系统 python3 是否可用
if ! command -v python3 >/dev/null 2>&1; then
    echo "错误：系统中未找到 python3，无法安装""" + DISPLAY_NAME + """。" > "$TRIM_TEMP_LOGFILE"
    exit 1
fi
echo "python3 环境检查通过: $(command -v python3)"
exit 0
"""
    # 卸载向导的 wizard_delete_data=true 时清空应用数据目录（装修方案）；false 则保留
    uninstall_callback = SHEBANG + """# 卸载后处理：按用户在卸载向导中的选择决定是否删除装修方案数据
if [ "${wizard_delete_data}" = "true" ]; then
    if [ -d "${TRIM_PKGVAR}/plans" ]; then
        find "${TRIM_PKGVAR}/plans" -mindepth 1 -delete 2>/dev/null || true
    fi
    echo "已删除所有装修方案数据"
else
    echo "已保留装修方案数据（重新安装同版本后可继续使用）"
fi
exit 0
"""
    return {"main": cmd_main_text(),
            "install_init": install_init, "install_callback": stub,
            "upgrade_init": stub, "upgrade_callback": stub,
            "uninstall_init": stub, "uninstall_callback": uninstall_callback,
            "config_init": stub, "config_callback": stub}


def wizard_json(title: str, tips: list) -> str:
    return json.dumps([{"stepTitle": title,
                        "items": [{"type": "tips", "helpText": t} for t in tips]}],
                       ensure_ascii=False, indent=2) + "\n"


def ui_config_text() -> str:
    # key 必须与 manifest 的 desktop_applaunchname 一致
    return json.dumps({".url": {f"{APPNAME}.Application": {
        "title": DISPLAY_NAME,
        "icon": "images/icon-{0}.png",
        "type": "url", "protocol": "http", "port": str(PORT),
        "url": "/", "allUsers": True,
    }}}, ensure_ascii=False, indent=4) + "\n"


def sc_text() -> str:
    return (f"[{APPNAME}]\ntitle=\"{DISPLAY_NAME}\"\n"
            f"desc=\"{DISPLAY_NAME}面板\"\nport_forward=\"yes\"\n"
            f"src.ports=\"{PORT}/tcp\"\ndst.ports=\"{PORT}/tcp\"\n")


# ---------------------------------------------------------------- 组装工程目录
def build_project(version: str):
    """在仓库根生成 fnpack 工程：manifest + app/ + cmd/ + config/ + wizard/。"""
    app = ROOT / "app"
    if app.exists():
        shutil.rmtree(app)

    # www：网页 + 本地依赖库
    www = app / "www"
    for item in WWW_FILES:
        src = ROOT / item
        dst = www / item
        if src.is_file():
            dst.parent.mkdir(parents=True, exist_ok=True)
            dst.write_bytes(src.read_bytes())
        elif src.is_dir():
            for f in src.rglob("*"):
                if f.is_file() and not any(p in EXCLUDE for p in f.relative_to(src).parts) \
                        and f.suffix.lower() != ".pyc":
                    rel_dst = dst / f.relative_to(src)
                    rel_dst.parent.mkdir(parents=True, exist_ok=True)
                    rel_dst.write_bytes(f.read_bytes())

    # 服务器本体（app.tgz 解压根，与 cmd/main 的 $APP_DIR/app.py 对应）
    shutil.copy(ROOT / "app.py", app / "app.py")

    # ui：桌面入口（desktop_uidir=ui 相对 app/ 目录）
    ui = app / "ui"
    (ui / "images").mkdir(parents=True)
    (ui / "config").write_text(ui_config_text(), encoding="utf-8", newline="\n")
    for s in (64, 128, 256):
        (ui / "images" / f"icon-{s}.png").write_bytes(make_icon_png(s))

    cmd = ROOT / "cmd"
    cmd.mkdir(exist_ok=True)
    for name, content in cmd_scripts().items():
        (cmd / name).write_text(content, encoding="utf-8", newline="\n")

    cfg = ROOT / "config"
    cfg.mkdir(exist_ok=True)
    (cfg / "privilege").write_text(json.dumps(
        {"defaults": {"run-as": "package"}, "username": APPNAME, "groupname": APPNAME},
        ensure_ascii=False, indent=4) + "\n", encoding="utf-8", newline="\n")
    (cfg / "resource").write_text(json.dumps(
        {"port-config": {"protocol-file": f"{APPNAME}.sc"}}, indent=4) + "\n",
        encoding="utf-8", newline="\n")

    wiz = ROOT / "wizard"
    wiz.mkdir(exist_ok=True)
    (wiz / "install").write_text(wizard_json(f"欢迎安装{DISPLAY_NAME}", [
        f"🏠 <b>{DISPLAY_NAME}</b> 是一款纯前端的户型装修设计工具。",
        "📐 2D 平面图摆放家具、拆改墙体、测量尺寸；🏙️ 一键切换 3D 场景鸟瞰或第一人称漫游。",
        f"💾 方案可保存到 NAS 服务器端，换设备不丢失。",
        f"ℹ️ 安装完成后桌面点击「{DISPLAY_NAME}」图标，或访问 <code>http://NAS_IP:{PORT}</code>",
        "⚠️ 本程序基于开源项目二次开发，仅供学习交流使用。",
    ]), encoding="utf-8", newline="\n")
    (wiz / "config").write_text(wizard_json(f"{DISPLAY_NAME} 设置", [
        "本应用无需额外配置。方案数据保存在应用数据目录（卸载时勾选「清除本地数据」会一并删除）。",
    ]), encoding="utf-8", newline="\n")
    # 卸载向导：radio 选择数据去留（与 fnmonitorpro 同款交互）
    (wiz / "uninstall").write_text(json.dumps([{
        "stepTitle": f"卸载{DISPLAY_NAME}",
        "items": [
            {"type": "tips",
             "helpText": f"您即将卸载{DISPLAY_NAME}。请选择如何处理服务器上保存的装修方案："},
            {"type": "radio", "field": "wizard_delete_data", "label": "数据保留选项",
             "initValue": "false",
             "options": [
                 {"label": "保留数据（推荐）- 重新安装后可恢复所有方案", "value": "false"},
                 {"label": "删除所有方案数据 - 此操作不可恢复！", "value": "true"},
             ]},
            {"type": "tips",
             "helpText": "<strong>警告：</strong> 选择删除后，所有装修方案将永久丢失，"
                         "建议先在应用内导出备份。"},
        ],
    }], ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n")

    (ROOT / "manifest").write_text(manifest_text(version, "x86"),
                                   encoding="utf-8", newline="\n")
    (ROOT / f"{APPNAME}.sc").write_text(sc_text(), encoding="utf-8", newline="\n")
    (ROOT / "ICON.PNG").write_bytes(make_icon_png(64))
    (ROOT / "ICON_256.PNG").write_bytes(make_icon_png(256))


# ---------------------------------------------------------------- fnpack 构建与修补
def read_manifest_version() -> str:
    """版本号以仓库根 manifest 的 version= 为准。"""
    p = ROOT / "manifest"
    if not p.exists():
        sys.exit("[x] 未找到 manifest，无法确定版本号")
    m = re.search(r"(?m)^version=([^\s]+)", p.read_text(encoding="utf-8"))
    if not m:
        sys.exit("[x] manifest 中未找到 version= 行")
    return m.group(1).strip()


def find_fnpack() -> str:
    if FNPACK.exists() and FNPACK.stat().st_size > 100 * 1024:
        return str(FNPACK)
    which = shutil.which("fnpack")
    if which:
        return which
    sys.exit("[x] 未找到 fnpack：应已由首次打包下载到 tools/bin/fnpack.exe，或将其加入 PATH")


def patch_cmd_modes(fpk: Path):
    """fnpack 在 Windows 上把 cmd/* 写成 0666，重打包补成 0755（内容不变）。"""
    import io
    with tarfile.open(fpk, "r:gz") as zin:
        members = zin.getmembers()
        payload = {m.name: zin.extractfile(m).read() if m.isfile() else None for m in members}
    with tarfile.open(fpk, "w:gz") as zout:
        for m in members:
            if m.name.startswith("cmd/") and m.isfile():
                m.mode = 0o755
            if m.isdir():
                zout.addfile(m)
            else:
                zout.addfile(m, io.BytesIO(payload[m.name]))


def do_pack(version: str) -> None:
    fnpack = find_fnpack()
    print("[1/3] 生成 fnpack 工程目录（manifest / app / cmd / config / wizard / 图标）...")
    build_project(version)
    manifest_path = ROOT / "manifest"
    orig = manifest_path.read_text(encoding="utf-8")

    results = []
    try:
        for plat in ("x86", "arm"):
            print(f"[2/3] fnpack 打包 {plat} ...")
            manifest_path.write_text(
                re.sub(r"(?m)^platform=.*$", f"platform={plat}", orig, count=1),
                encoding="utf-8", newline="\n")
            r = subprocess.run([fnpack, "build"], cwd=str(ROOT),
                               capture_output=True, text=True,
                               encoding="utf-8", errors="replace")
            print((r.stdout or "") + (r.stderr or ""), end="")
            if r.returncode != 0:
                sys.exit(f"[x] fnpack 打包失败（{plat}），请把上面的输出发给维护者")
            src = ROOT / f"{APPNAME}.fpk"
            if not src.exists():
                sys.exit(f"[x] 未找到构建产物 {APPNAME}.fpk（{plat}）")
            out = ROOT / f"{APPNAME}-{version}-fnos-{plat}.fpk"
            shutil.move(str(src), str(out))
            patch_cmd_modes(out)
            md5 = hashlib.md5(out.read_bytes()).hexdigest()
            results.append(f"{out.name}（{out.stat().st_size / 1024 / 1024:.1f} MB，MD5 {md5[:8]}...）")
    finally:
        manifest_path.write_text(orig, encoding="utf-8", newline="\n")   # 恢复原始 manifest

    print("[3/3] 完成：")
    for line in results:
        print("   " + line)
    print("[i] 安装：fnOS 应用中心 → 手动安装 → 按 NAS 架构选择 x86 / arm 包")


def main():
    version = sys.argv[1] if len(sys.argv) > 1 else read_manifest_version()
    do_pack(version)


if __name__ == "__main__":
    main()
