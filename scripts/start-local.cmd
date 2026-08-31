@echo off
rem MomentQ local stack: DSH Host (3182) + ASR companion (3090).
rem Credentials come from %USERPROFILE%\.momentq-companion.json (saved via
rem the extension settings page) or BAIDU_ASR_* environment variables.

rem Data root follows the user profile: no hardcoded drive, spaces are safe.
set "MOMENTQ_DATA_ROOT=%LOCALAPPDATA%\MomentQ"
set "DSH_HOME=%LOCALAPPDATA%\MomentQ\dsh-home"
if not exist "%MOMENTQ_DATA_ROOT%" mkdir "%MOMENTQ_DATA_ROOT%"
if not exist "%DSH_HOME%" mkdir "%DSH_HOME%"

if not exist "%~dp0..\companion\dist\index.js" (
  echo [错误] companion 未构建：请先在仓库根目录执行 pnpm install 和 pnpm -r build
  pause
  exit /b 1
)

echo [1/2] Starting DSH Host on http://127.0.0.1:3182 ...
start "MomentQ Host" /D "%~dp0.." cmd /k "set MOMENTQ_DATA_ROOT=%MOMENTQ_DATA_ROOT%&& set DSH_HOME=%DSH_HOME%&& dsh --profile web --no-open --port 3182"

echo [2/2] Starting companion on http://127.0.0.1:3090 ...
start "MomentQ Companion" /D "%~dp0.." cmd /k "set MOMENTQ_DATA_ROOT=%MOMENTQ_DATA_ROOT%&& node companion\dist\index.js"

echo Both services launched in their own windows. Close those windows to stop them.
