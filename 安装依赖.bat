@echo off
chcp 65001 >nul
title 安装依赖
cd /d "%~dp0"

echo === 1/3 安装 npm 依赖（跳过自动脚本，避免权限问题）===
call npm.cmd install --ignore-scripts --no-audit --no-fund
if not "%errorlevel%"=="0" (
  echo [X] npm 安装失败。若提示 EPERM，请确认当前目录可写，或用管理员身份运行。
  pause
  exit /b 1
)

echo.
echo === 2/3 下载 Electron 运行时 ===
if exist "node_modules\electron\dist\electron.exe" (
  echo [.] 已存在，跳过。
) else (
  set ELECTRON_MIRROR=https://registry.npmmirror.com/-/binary/electron/
  set ELECTRON_CACHE=%~dp0.electron-cache
  node node_modules\electron\install.js
)

echo.
echo === 3/3 检查 ===
if exist "node_modules\electron\dist\electron.exe" (
  echo [OK] 依赖齐全，可以双击 启动.bat 使用了。
) else (
  echo [X] Electron 运行时仍缺失，请检查网络（国内建议开代理或换镜像）。
)

pause
