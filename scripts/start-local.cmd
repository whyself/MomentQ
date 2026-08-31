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
  echo [错误] 未检测到 Node.js。请安装 Node.js 22 LTS 或更高版本：https://nodejs.org/
  pause
  exit /b 1
)
for /f "usebackq tokens=*" %%v in (`node -p "process.versions.node.split('.')[0]"`) do set "NODE_MAJOR=%%v"
if !NODE_MAJOR! LSS 22 (
  echo [错误] Node.js 版本过低（!NODE_MAJOR!.x）。需要 22 LTS 或更高版本：https://nodejs.org/
  pause
  exit /b 1
)

rem ── [1] 数据目录 ─────────────────────────────────────────────
if not exist "%MOMENTQ_DATA_ROOT%" mkdir "%MOMENTQ_DATA_ROOT%"
if not exist "%DSH_HOME%" mkdir "%DSH_HOME%"

rem ── [2] pnpm（dsh 的插件管理依赖它）─────────────────────────
where pnpm >nul 2>nul
if errorlevel 1 (
  echo [安装] 正在安装 pnpm ...
  call npm i -g pnpm --silent
  if errorlevel 1 (
    echo [错误] pnpm 安装失败，请手动执行：npm i -g pnpm
    pause
    exit /b 1
  )
)

rem ── [3] DSH 运行时（锁定与 MomentQ 组件兼容的版本）──────────
where dsh >nul 2>nul
if errorlevel 1 (
  echo [安装] 正在安装 DSH 运行时（约一分钟）...
  call npm i -g @deepseek-ai/dsh@0.1.1-rc.2 --silent
  if errorlevel 1 (
    echo [错误] DSH 安装失败，请手动执行：npm i -g @deepseek-ai/dsh@0.1.1-rc.2
    pause
    exit /b 1
  )
)

rem ── [4] MomentQ Host 组件（幂等：已装则跳过）────────────────
set "BUNDLE_TGZ="
for %%f in ("%ROOT%\bundles\momentq-dsh-bundle-*.tgz") do set "BUNDLE_TGZ=%%~ff"
for %%f in ("%ROOT%\dsh\packages\bundle\momentq-dsh-bundle-*.tgz") do if not defined BUNDLE_TGZ set "BUNDLE_TGZ=%%~ff"
if not exist "%DSH_HOME%\profiles\web\node_modules\momentq-dsh-bundle\package.json" (
  if defined BUNDLE_TGZ (
    echo [安装] 正在安装 MomentQ Host 组件...
    call dsh plugin --profile web add "!BUNDLE_TGZ!"
    if errorlevel 1 (
      echo [错误] 组件安装失败。请把本提示截图反馈。
      pause
      exit /b 1
    )
  ) else (
    echo [警告] 未找到 momentq-dsh-bundle 组件包（bundles\*.tgz），Host 将无法提供 MomentQ 接口。
  )
)

rem ── [5] companion 就绪检查（可选用件）───────────────────────
set "COMPANION_OK=1"
if not exist "%ROOT%\companion\dist\index.js" set "COMPANION_OK=0"
if not exist "%ROOT%\companion\node_modules\ws" set "COMPANION_OK=0"

rem ── [6] 端口占用检测 ─────────────────────────────────────────
set "HOST_RUNNING=0"
set "COMPANION_RUNNING=0"
netstat -ano | findstr /c(":3182") | findstr /c("LISTENING") >nul && set "HOST_RUNNING=1"
netstat -ano | findstr /c(":3090") | findstr /c("LISTENING") >nul && set "COMPANION_RUNNING=1"

rem ── [7] 启动 ─────────────────────────────────────────────────
if "%HOST_RUNNING%"=="1" (
  echo [跳过] DSH Host 已在运行（端口 3182）。
) else (
  echo [1/2] 启动 DSH Host：http://127.0.0.1:3182 ...
  start "MomentQ Host" /D "%ROOT%" cmd /k "set MOMENTQ_DATA_ROOT=%MOMENTQ_DATA_ROOT%&& set DSH_HOME=%DSH_HOME%&& dsh --profile web --no-open --port 3182"
)

if "%COMPANION_OK%"=="0" (
  echo [跳过] companion 未随包提供（百度云 ASR 为可选用件，字幕与本地语音识别不需要它）。
) else if "%COMPANION_RUNNING%"=="1" (
  echo [跳过] companion 已在运行（端口 3090）。
) else (
  echo [2/2] 启动 companion：http://127.0.0.1:3090 ...
  start "MomentQ Companion" /D "%ROOT%" cmd /k "set MOMENTQ_DATA_ROOT=%MOMENTQ_DATA_ROOT%&& node companion\dist\index.js"
)

echo.
echo 全部就绪。接下来：
echo   1. Edge 打开 edge://extensions ，开启"开发人员模式"，"加载解压缩的扩展"选择 extension\dist 目录。
echo   2. 打开任意 B 站视频，点浏览器工具栏 MomentQ 图标打开侧边栏。
echo   3. 设置内填入模型 API Key 即可提问；语音识别默认本地 Whisper，首次使用需下载模型。
echo 关闭对应的命令行窗口即可停止服务。
endlocal
