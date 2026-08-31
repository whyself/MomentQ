@echo off
setlocal enabledelayedexpansion
rem MomentQ local stack launcher (Windows). Safe to re-run: every step is
rem idempotent, missing pieces are installed automatically.
rem   - DSH Host (3182): conversation + subtitle persistence + agent
rem   - companion (3090): optional, only needed for Baidu cloud ASR
rem Data root: %LOCALAPPDATA%\MomentQ

set "ROOT=%~dp0.."
set "MOMENTQ_DATA_ROOT=%LOCALAPPDATA%\MomentQ"
set "DSH_HOME=%MOMENTQ_DATA_ROOT%\dsh-home"

rem ── [0] Node.js ──────────────────────────────────────────────
where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js not found. Install Node.js 22 LTS or newer: https://nodejs.org/
  pause
  exit /b 1
)
for /f "usebackq tokens=*" %%v in (`node -p "process.versions.node.split('.')[0]"`) do set "NODE_MAJOR=%%v"
if !NODE_MAJOR! LSS 22 (
  echo [ERROR] Node.js is too old ^(!NODE_MAJOR!.x^). Need 22 LTS or newer: https://nodejs.org/
  pause
  exit /b 1
)

rem ── [1] Data directories ─────────────────────────────────────
if not exist "%MOMENTQ_DATA_ROOT%" mkdir "%MOMENTQ_DATA_ROOT%"
if not exist "%DSH_HOME%" mkdir "%DSH_HOME%"

rem ── [2] pnpm (required by the dsh plugin manager) ────────────
where pnpm >nul 2>nul
if errorlevel 1 (
  echo [SETUP] Installing pnpm ...
  call npm i -g pnpm --silent
  if errorlevel 1 (
    echo [ERROR] Failed to install pnpm. Run manually: npm i -g pnpm
    pause
    exit /b 1
  )
)

rem ── [3] DSH runtime (version pinned for bundle compatibility) ─
where dsh >nul 2>nul
if errorlevel 1 (
  echo [SETUP] Installing the DSH runtime (about a minute) ...
  call npm i -g @deepseek-ai/dsh@0.1.1-rc.2 --silent
  if errorlevel 1 (
    echo [ERROR] Failed to install the DSH runtime. Run manually: npm i -g @deepseek-ai/dsh@0.1.1-rc.2
    pause
    exit /b 1
  )
)

rem ── [4] MomentQ Host bundle (idempotent) ─────────────────────
set "BUNDLE_TGZ="
for %%f in ("%ROOT%\bundles\momentq-dsh-bundle-*.tgz") do set "BUNDLE_TGZ=%%~ff"
for %%f in ("%ROOT%\dsh\packages\bundle\momentq-dsh-bundle-*.tgz") do if not defined BUNDLE_TGZ set "BUNDLE_TGZ=%%~ff"
if not exist "%DSH_HOME%\profiles\web\node_modules\momentq-dsh-bundle\package.json" (
  if defined BUNDLE_TGZ (
    echo [SETUP] Installing the MomentQ Host bundle ...
    call dsh plugin --profile web add "!BUNDLE_TGZ!"
    if errorlevel 1 (
      echo [ERROR] Failed to install the MomentQ Host bundle.
      pause
      exit /b 1
    )
  ) else (
    echo [WARN] momentq-dsh-bundle package not found ^(bundles\*.tgz^). The Host will not serve MomentQ APIs.
  )
)

rem ── [5] companion readiness (optional component) ─────────────
set "COMPANION_OK=1"
if not exist "%ROOT%\companion\dist\index.js" set "COMPANION_OK=0"
if not exist "%ROOT%\companion\node_modules\ws" set "COMPANION_OK=0"

rem ── [6] Port occupancy ───────────────────────────────────────
set "HOST_RUNNING=0"
set "COMPANION_RUNNING=0"
netstat -ano | findstr /c(":3182") | findstr /c("LISTENING") >nul && set "HOST_RUNNING=1"
netstat -ano | findstr /c(":3090") | findstr /c("LISTENING") >nul && set "COMPANION_RUNNING=1"

rem ── [7] Launch ───────────────────────────────────────────────
if "%HOST_RUNNING%"=="1" (
  echo [SKIP] DSH Host is already running on port 3182.
) else (
  echo [1/2] Starting DSH Host on http://127.0.0.1:3182 ...
  start "MomentQ Host" /D "%ROOT%" cmd /k "set MOMENTQ_DATA_ROOT=%MOMENTQ_DATA_ROOT%&& set DSH_HOME=%DSH_HOME%&& dsh --profile web --no-open --port 3182"
)

if "%COMPANION_OK%"=="0" (
  echo [SKIP] companion is not included in this package. It is only needed for the optional Baidu cloud ASR; subtitles and local speech recognition do not use it.
) else if "%COMPANION_RUNNING%"=="1" (
  echo [SKIP] companion is already running on port 3090.
) else (
  echo [2/2] Starting companion on http://127.0.0.1:3090 ...
  start "MomentQ Companion" /D "%ROOT%" cmd /k "set MOMENTQ_DATA_ROOT=%MOMENTQ_DATA_ROOT%&& node companion\dist\index.js"
)

echo.
echo All set. Next steps:
echo   1. Open edge://extensions in Edge, enable Developer mode, click "Load unpacked" and select the extension\dist folder.
echo   2. Open any Bilibili video and click the MomentQ toolbar icon to open the side panel.
echo   3. Enter your model API key in Settings. Speech recognition defaults to the local Whisper engine; the first run downloads the model.
echo Close the two service windows to stop the services.
endlocal
