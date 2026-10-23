@echo off
chcp 65001 >nul
title 自检诊断（不开界面，只体检）
cd /d "%~dp0"

echo ============================================
echo   自检诊断：不开界面，只把环境体检一遍
echo   结果直接打在这屏幕上，可以框选复制
echo ============================================
echo.

if not exist "node_modules\electron\dist\electron.exe" (
  echo [X] 还没装依赖：先双击「安装依赖.bat」，装完再跑这个。
  echo.
  pause
  exit /b 1
)

echo [.] 正在跑启动自检（大约 5~15 秒）...
echo.
"node_modules\electron\dist\electron.exe" . --smoke-test
set SMOKE_EXIT=%errorlevel%
echo.

echo --------------------------------------------
if "%SMOKE_EXIT%"=="0" (
  echo [OK] 自检全部通过（退出码 0）。
) else (
  echo [!] 自检有项目需要处理（退出码 %SMOKE_EXIT%）。
  echo     上面标 [FAIL] 的行就是原因，每行后面都写了「怎么修」；
  echo     标 [WARN] 的只是环境提醒（比如远程桌面读不到屏幕），不影响使用。
)
echo --------------------------------------------
echo 程序目录：%~dp0
echo.
echo 需要的话把上面整段复制下来发出去（或者按任意键关闭）。
pause >nul
if "%SMOKE_EXIT%"=="0" (exit /b 0) else (exit /b 1)
