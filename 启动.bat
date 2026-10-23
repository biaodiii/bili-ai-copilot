@echo off
chcp 65001 >nul
title 直播AI搭档
cd /d "%~dp0"

if not exist "node_modules\electron\dist\electron.exe" (
  echo [!] 还没安装依赖，正在自动安装（首次大约 1-3 分钟）...
  call npm.cmd install --ignore-scripts --no-audit --no-fund
  rem 注意：这一行在括号块里，%errorlevel% 会被提前展开，所以必须用 if errorlevel（运行时判断）
  if errorlevel 1 (
    echo [X] npm 安装失败，请检查网络后重新运行本文件。
    pause
    exit /b 1
  )
  if not exist "node_modules\electron\dist\electron.exe" (
    echo [.] 正在下载 Electron 运行时...
    set ELECTRON_MIRROR=https://registry.npmmirror.com/-/binary/electron/
    node node_modules\electron\install.js
  )
)

if not exist "node_modules\electron\dist\electron.exe" (
  echo [X] Electron 运行时缺失，请运行 安装依赖.bat 后重试。
  pause
  exit /b 1
)

if not exist "data" mkdir "data"

echo [.] 正在做启动自检...
"node_modules\electron\dist\electron.exe" . --smoke-test > "data\smoke-test.log" 2>&1
if not "%errorlevel%"=="0" (
  echo.
  echo [!] 启动自检没全过（但界面照样会启动）。出问题的是这几项：
  findstr /C:"[FAIL]" "data\smoke-test.log"
  if errorlevel 1 echo     ^(日志里没有 [FAIL] 行：多半是 Electron 自己没起来，看下面两个文件^)
  echo.
  echo     完整日志：%~dp0data\smoke-test.log
  echo     崩溃记录：%~dp0data\crash.log
  echo     ^(自检只是体检：像「读不到屏幕信息」这种在远程桌面 / 没显示器时会报，
  echo      界面照样能用；要是弹幕或 AI 有问题再处理^)
  echo.
)

echo [.] 正在启动直播 AI 搭档...
start "" "node_modules\electron\dist\electron.exe" "%~dp0."
exit /b 0
