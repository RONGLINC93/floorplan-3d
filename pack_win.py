"""户型装修设计 · Windows 版打包脚本

把网页 + 服务器打成 Windows 直接运行的 zip 包（无需安装任何第三方依赖）。
产物：floorplan3d-<版本>-windows.zip
  ├─ app.py            纯标准库服务器（python app.py 即启动）
  ├─ 启动服务器.bat     双击启动（需系统装有 Python，自动打开浏览器）
  ├─ index.html + libs 网页与本地依赖库
  └─ README-win.md     Windows 版使用说明

用法：python pack_win.py [版本号]
"""
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent
WWW_FILES = ["index.html", "favicon.ico", "libs", "LICENSE"]
EXCLUDE = {".env", ".git", "__pycache__", ".playwright-cli", "plans",
           "server.log", ".codebuddy", "node_modules", ".idea", ".vscode"}

BAT_TEXT = """@echo off
rem 户型装修设计 · Windows 启动脚本（需系统装有 Python 3）
cd /d "%~dp0"
where python >nul 2>nul || (
    echo [x] 未找到 python，请先安装 Python 3：https://www.python.org/downloads/
    pause & exit /b 1
)
python app.py --port 8765
pause
"""

README_TEXT = """# 户型装修设计 · Windows 版

## 运行
1. 系统需装有 [Python 3](https://www.python.org/downloads/)（安装时勾选 Add to PATH）
2. 双击 `启动服务器.bat`，浏览器会自动打开 http://localhost:8765
   （也可手动执行：`python app.py --port 8765`）

## 说明
- 本版为纯 Python 标准库实现，无需 pip 安装任何第三方依赖
- 保存的方案存放在程序目录下的 `plans/` 文件夹（JSON 格式，可直接备份）
- 仅限本机访问；如需局域网访问，服务器已监听 0.0.0.0，用 http://本机IP:8765 即可
- ⚠️ 本程序基于开源项目二次开发，仅供学习交流使用
"""


def pack_win(version: str) -> None:
    out = ROOT / f"floorplan3d-{version}-windows.zip"
    if out.exists():
        out.unlink()
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        z.writestr("启动服务器.bat", BAT_TEXT)
        z.writestr("README-win.md", README_TEXT)
        z.write(ROOT / "app.py", "app.py")
        for item in WWW_FILES:
            src = ROOT / item
            if src.is_file():
                z.write(src, item)
            elif src.is_dir():
                for f in sorted(src.rglob("*")):
                    if f.is_file() and not any(p in EXCLUDE for p in f.relative_to(src).parts) \
                            and f.suffix.lower() != ".pyc":
                        z.write(f, str(Path(item) / f.relative_to(src)))
    print(f"[ok] 已生成 {out.name}（{out.stat().st_size / 1024 / 1024:.1f} MB）")
    print("[i] Windows 用户解压后双击「启动服务器.bat」即可运行（需装有 Python 3）")


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
    pack_win(sys.argv[1] if len(sys.argv) > 1 else read_manifest_version())


if __name__ == "__main__":
    main()
