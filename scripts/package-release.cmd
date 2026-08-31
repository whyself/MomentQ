@echo off
setlocal enabledelayedexpansion
rem Build MomentQ and package the Windows release zip.
rem Output: .release\momentq-<version>.zip
set "ROOT=%~dp0.."
if not exist "%OUT%" mkdir "%OUT%"
set "OUT=%ROOT%\.release"
set "VERSION="
set "BUNDLE_VERSION="

for /f "usebackq tokens=*" %%v in (`node -p "require('./extension/public/manifest.json').version"`) do set "VERSION=%%v"
if "%VERSION%"=="" (
  echo [ERROR] Cannot read the extension version.
  exit /b 1
)
for /f "usebackq tokens=*" %%v in (`node -p "require('./dsh/packages/bundle/package.json').version"`) do set "BUNDLE_VERSION=%%v"
if "%BUNDLE_VERSION%"=="" (
  echo [ERROR] Cannot read the bundle version.
  exit /b 1
)
echo Packaging MomentQ v%VERSION% (bundle v%BUNDLE_VERSION%) ...

rem ------------------------------------------------------------------
pushd "%ROOT%\extension"
call npm run build
if errorlevel 1 (popd & exit /b 1)
popd

rem ------------------------------------------------------------------
pushd "%ROOT%\companion"
call npm run build
if errorlevel 1 (popd & exit /b 1)
if not exist "node_modules\ws\package.json" (
  call npm install --omit=dev --no-audit --no-fund
  if errorlevel 1 (popd & exit /b 1)
)
popd

rem ------------------------------------------------------------------
pushd "%ROOT%\dsh\packages\bundle"
call npm run build
if errorlevel 1 (popd & exit /b 1)
call npm pack --pack-destination "%OUT%"
if errorlevel 1 (popd & exit /b 1)
popd

rem ------------------------------------------------------------------
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

rem The exact bundle version only: never sweep older tgks from .release.
if not exist "%OUT%\momentq-dsh-bundle-%BUNDLE_VERSION%.tgz" (
  echo [ERROR] Bundle package missing: %OUT%\momentq-dsh-bundle-%BUNDLE_VERSION%.tgz
  exit /b 1
)
copy /y "%OUT%\momentq-dsh-bundle-%BUNDLE_VERSION%.tgz" "%STAGE%\bundles\" >nul

rem ws must be a REAL directory in the stage: the companion requires it at
rem runtime and symlinked pnpm stores break once the zip leaves this machine.
if not exist "%STAGE%\companion\node_modules\ws\package.json" (
  echo [ERROR] Staged companion is missing the ws dependency ^(symlink was not dereferenced by xcopy^).
  exit /b 1
)

rem ------------------------------------------------------------------
if exist "%OUT%\momentq-%VERSION%.zip" del "%OUT%\momentq-%VERSION%.zip"
powershell -NoProfile -Command "Compress-Archive -Path '%STAGE%\*' -DestinationPath '%OUT%\momentq-%VERSION%.zip' -Force"
if errorlevel 1 (
  echo [ERROR] Compression failed.
  exit /b 1
)
echo.
echo Release zip: %OUT%\momentq-%VERSION%.zip
endlocal
