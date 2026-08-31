@echo off
rem Build MomentQ and package the Windows release zip.
rem Output: .release\momentq-<version>.zip
setlocal enabledelayedexpansion
set "ROOT=%~dp0.."
set "OUT=%ROOT%\.release"
set "VERSION="
set "BUNDLE_VERSION="

for /f "usebackq tokens=*" %%v in (`node -p "require('%ROOT:\=/%/extension/public/manifest.json').version"`) do set "VERSION=%%v"
if "%VERSION%"=="" (
  echo [错误] 无法读取版本号
  exit /b 1
)
for /f "usebackq tokens=*" %%v in (`node -p "require('%ROOT:\=/%/dsh/packages/bundle/package.json').version"`) do set "BUNDLE_VERSION=%%v"
if "%BUNDLE_VERSION%"=="" (
  echo [错误] 无法读取 bundle 版本号
  exit /b 1
)
echo Packaging MomentQ v%VERSION% (bundle v%BUNDLE_VERSION%) ...

rem ── 1) 扩展构建 ────────────────────────────────────────────────
pushd "%ROOT%\extension"
call npm run build || (popd & exit /b 1)
popd

rem ── 2) companion 构建 + 生产依赖（zip 自带 node_modules，目标机零安装）──
pushd "%ROOT%\companion"
call npm run build || (popd & exit /b 1)
if not exist "node_modules\ws" call npm install --omit=dev --no-audit --no-fund || (popd & exit /b 1)
popd

rem ── 3) DSH bundle 构建 + 打包 tgz（目标机 dsh plugin add 用）──────
pushd "%ROOT%\dsh\packages\bundle"
call npx tsdown || (popd & exit /b 1)
call npm pack --pack-destination "%OUT%" || (popd & exit /b 1)
popd

rem ── 4) 暂存目录 ───────────────────────────────────────────────
set "STAGE=%OUT%\momentq-%VERSION%"
if exist "%STAGE%" rmdir /s /q "%STAGE%"
mkdir "%STAGE%\extension"
mkdir "%STAGE%\companion\dist"
mkdir "%STAGE%\scripts"
mkdir "%STAGE%\bundles"

xcopy "%ROOT%\extension\dist" "%STAGE%\extension\dist\" /e /i /q >nul
copy /y "%ROOT%\extension\README.md" "%STAGE%\extension\" >nul
copy /y "%ROOT%\companion\dist\index.js" "%STAGE%\companion\dist\" >nul
xcopy "%ROOT%\companion\node_modules" "%STAGE%\companion\node_modules\" /e /i /q >nul
copy /y "%ROOT%\companion\package.json" "%STAGE%\companion\" >nul
copy /y "%ROOT%\scripts\start-local.cmd" "%STAGE%\scripts\" >nul
if exist "%ROOT%\README.md" copy /y "%ROOT%\README.md" "%STAGE%\" >nul
if not exist "%STAGE%\companion\node_modules\ws\package.json" (
  echo [错误] 暂存目录缺少 ws 依赖（符号链接未被解引用），发行包会无法启动 companion。
  exit /b 1
)
copy /y "%OUT%\momentq-dsh-bundle-%BUNDLE_VERSION%.tgz" "%STAGE%\bundles\" >nul

rem ── 5) 压缩 ──────────────────────────────────────────────────
if exist "%OUT%\momentq-%VERSION%.zip" del "%OUT%\momentq-%VERSION%.zip"
powershell -NoProfile -Command "Compress-Archive -Path '%STAGE%\*' -DestinationPath '%OUT%\momentq-%VERSION%.zip' -Force"
if errorlevel 1 (
  echo [错误] 压缩失败
  exit /b 1
)
echo.
echo Release zip: %OUT%\momentq-%VERSION%.zip
endlocal
