@echo off
rem 切到 UTF-8 代码页：本文件是 UTF-8 编码，GBK 终端直接跑会乱码
chcp 65001 >nul
rem 双击启动 Python 服务器（方案可保存到服务器，跨平台，任何设备浏览器访问）
cd /d "%~dp0"

where python >nul 2>nul
if %errorlevel% neq 0 (
    echo 未找到 python，请先安装 Python 3.10+ 后重试。
    pause
    exit /b 1
)

python app.py
pause
