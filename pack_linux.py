"""户型装修设计 · Linux 版打包脚本

把网页 + 服务器打成 Linux 直接运行的 tar.gz 包（无需安装任何第三方依赖）。
产物：floorplan3d-<版本>-linux.tar.gz
  ├─ app.py            纯标准库服务器（python3 app.py 即启动）
  ├─ start.sh          启动脚本（需系统装有 python3，自动打开浏览器）
  ├─ index.html + libs 网页与本地依赖库
  └─ README-linux.md   Linux 版使用说明

用法：python pack_linux.py [版本号]
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
# 户型装修设计 · Linux 启动脚本（需系统装有 python3）
cd "$(dirname "$0")"
command -v python3 >/dev/null 2>&1 || {
    echo "[x] 未找到 python3，请先安装：apt install python3 / dnf install python3"
    exit 1
}
python3 app.py --port 8765
"""

README_TEXT = """# 户型装修设计 · Linux 版

## 运行
```bash
tar xzf floorplan3d-*-linux.tar.gz
cd floorplan3d-*-linux
chmod +x start.sh && ./start.sh
# 或手动执行：python3 app.py --port 8765
```
浏览器打开 http://localhost:8765（无桌面环境时用其它机器访问 http://服务器IP:8765）

## 说明
- 本版为纯 Python 标准库实现，只需系统装有 python3，无需 pip 安装任何第三方依赖
- 保存的方案存放在程序目录下的 `plans/` 文件夹（JSON 格式，可直接备份）
- 服务器监听 0.0.0.0，局域网/外网机器均可访问；生产环境建议配合 systemd 或
  nginx 反代使用（fnOS 原生应用版 pack_fpk.py 已含完整生命周期管理）
- ⚠️ 本程序基于开源项目二次开发，仅供学习交流使用
"""


def pack_linux(version: str) -> None:
    out = ROOT / f"floorplan3d-{version}-linux.tar.gz"
    with tarfile.open(out, "w:gz") as z:
        for name, text, mode in (("start.sh", SH_TEXT, 0o755),
                                 ("README-linux.md", README_TEXT, 0o644)):
            data = text.encode("utf-8")
            ti = tarfile.TarInfo(f"floorplan3d-{version}-linux/{name}")
            ti.size = len(data)
            ti.mode = mode
            ti.mtime = 0
            z.addfile(ti, io.BytesIO(data))
        add_file(z, ROOT / "app.py", f"floorplan3d-{version}-linux/app.py")
        for item in WWW_FILES:
            src = ROOT / item
            if src.is_file():
                add_file(z, src, f"floorplan3d-{version}-linux/{item}")
            elif src.is_dir():
                for f in sorted(src.rglob("*")):
                    if f.is_file() and not any(p in EXCLUDE for p in f.relative_to(src).parts) \
                            and f.suffix.lower() != ".pyc":
                        add_file(z, f,
                                 f"floorplan3d-{version}-linux/{item}/{f.relative_to(src)}")
    print(f"[ok] 已生成 {out.name}（{out.stat().st_size / 1024 / 1024:.1f} MB）")
    print("[i] Linux 用户解压后执行 ./start.sh 即可运行（需装有 python3）")


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
    pack_linux(sys.argv[1] if len(sys.argv) > 1 else read_manifest_version())


if __name__ == "__main__":
    main()
