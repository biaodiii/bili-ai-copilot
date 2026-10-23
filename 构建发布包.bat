@echo off
chcp 65001 >nul
title 打发布包
cd /d "%~dp0"

echo ============================================
echo   打一个「发布 / 分享版」文件夹
echo   产物默认在：项目上一层的 发布包\直播AI搭档-版本-win64
echo ============================================
echo.

if not exist "node_modules\electron\dist\electron.exe" (
  echo [X] 还没装依赖：先双击「安装依赖.bat」，装完再打发布包。
  echo.
  pause
  exit /b 1
)

node "%~dp0scripts\build-release.js" %*
set BUILD_EXIT=%errorlevel%
echo.
if "%BUILD_EXIT%"=="0" (
  echo [OK] 发布包打好了，路径见上面的「产物：」那一行。
) else (
  echo [X] 打包失败（退出码 %BUILD_EXIT%），原因见上面的 [X] 行。
)
echo.
pause
exit /b %BUILD_EXIT%
