@echo off
rem MomentQ local stack: DSH Host (3182) + ASR companion (3090).
rem Credentials come from %USERPROFILE%\.momentq-companion.json (saved via
rem the extension settings page) or BAIDU_ASR_* environment variables.
set MOMENTQ_DATA_ROOT=D:\MomentQData
set DSH_HOME=D:\MomentQData\dsh-home

echo [1/2] Starting DSH Host on http://127.0.0.1:3182 ...
start "MomentQ Host" cmd /k "cd /d %~dp0.. && dsh --profile web --no-open --port 3182"

echo [2/2] Starting companion on http://127.0.0.1:3090 ...
start "MomentQ Companion" cmd /k "cd /d %~dp0.. && node companion\dist\index.js"

echo Both services launched in their own windows. Close those windows to stop them.
