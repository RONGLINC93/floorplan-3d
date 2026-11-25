"""户型装修设计 · macOS 版打包脚本

把网页 + 服务器打成 macOS 直接运行的 tar.gz 包（无需安装任何第三方依赖）。
产物：floorplan3d-<版本>-macos.tar.gz
  ├─ start.command     双击即可在 Finder 中运行（浏览器自动打开）
  ├─ start.sh          命令行启动
  ├─ app.py            纯标准库服务器（python3 app.py 即启动）
  ├─ index.html + libs 网页与本地依赖库
  └─ README-mac.md     macOS 版使用说明

用法：python pack_mac.py [版本号]
"""
import io
import os
import sys
import tarfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent
WWW_FILES = ["index.html", "favicon.ico", "libs", "LICENSE"]
EXCLUDE = {".env", ".git", "__pycache__", ".playwright-cli", "plans",
           "server.log", ".codebuddy", "node_modules", ".idea", ".vscode"}

SH_TEXT = """#!/bin/bash
# 户型装修设计 · macOS 启动脚本（需系统装有 python3，macOS 一般自带）
cd "$(dirname "$0")"
command -v python3 >/dev/null 2>&1 || {
    echo "[x] 未找到 python3，请先安装：brew install python3 或到 https://www.python.org/downloads/"
    exit 1
}
python3 app.py --port 8765
"""

README_TEXT = """# 户型装修设计 · macOS 版

## 运行
- 图形界面：解压后双击 `start.command`（首次需在「系统设置 → 隐私与安全性」允许运行）
- 命令行：`./start.sh` 或 `python3 app.py --port 8765`

浏览器自动打开 http://localhost:8765

## 说明
- 本版为纯 Python 标准库实现，无需 pip 安装任何第三方依赖（macOS 自带 python3；若无：brew install python3）
- 保存的方案存放在程序目录下的 `plans/` 文件夹（JSON 格式，可直接备份）
- Apple Silicon 与 Intel 均可用（纯 Python 脚本，无架构依赖）
- ⚠️ 本程序基于开源项目二次开发，仅供学习交流使用
"""


def pack_mac(version: str) -> None:
    top = f"floorplan3d-{version}-macos"
    out = ROOT / f"{top}.tar.gz"
    with tarfile.open(out, "w:gz") as z:
        for name, mode in (("start.command", 0o755),   # Finder 双击入口
                           ("start.sh", 0o755),
                           ("README-mac.md", 0o644)):
            data = (README_TEXT if name == "README-mac.md" else SH_TEXT).encode("utf-8")
            ti = tarfile.TarInfo(f"{top}/{name}")
            ti.size = len(data)
            ti.mode = mode
            ti.mtime = 0
            ti.uid = ti.gid = 0
            ti.uname = ti.gname = "root"
            z.addfile(ti, io.BytesIO(data))
        add_file(z, ROOT / "app.py", f"{top}/app.py")
        for item in WWW_FILES:
            src = ROOT / item
            if src.is_file():
                add_file(z, src, f"{top}/{item}")
            elif src.is_dir():
                for f in sorted(src.rglob("*")):
                    if f.is_file() and not any(p in EXCLUDE for p in f.relative_to(src).parts) \
                            and f.suffix.lower() != ".pyc":
                        add_file(z, f, f"{top}/{item}/{f.relative_to(src)}")
    print(f"[ok] 已生成 {out.name}（{out.stat().st_size / 1024 / 1024:.1f} MB）")
    print("[i] macOS 用户解压后双击 start.command 即可运行（需装有 python3）")


def add_file(z: tarfile.TarFile, path: Path, arcname: str):
    """手动构造 TarInfo：权限固定 644、uid/gid 归零（Windows 继承的 0666 在 Linux 上难看）。"""
    data = path.read_bytes()
    ti = tarfile.TarInfo(arcname)
    ti.size = len(data)
    ti.mode = 0o644
    ti.mtime = 0
    ti.uid = ti.gid = 0
    ti.uname = ti.gname = "root"
    z.addfile(ti, io.BytesIO(data))


def read_manifest_version() -> str:
    """版本号以仓库根 manifest 的 version= 为准（与 fpk 打包一致），不再硬编码。"""
    p = ROOT / "manifest"
    if not p.exists():
        sys.exit("[x] 未找到 manifest，无法确定版本号")
    for line in p.read_text(encoding="utf-8").splitlines():
        if line.startswith("version="):
            return line.split("=", 1)[1].strip()
    sys.exit("[x] manifest 中未找到 version= 行")


def main():
    pack_mac(sys.argv[1] if len(sys.argv) > 1 else read_manifest_version())


if __name__ == "__main__":
    main()
