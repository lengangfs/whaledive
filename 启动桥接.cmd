@echo off
chcp 65001 >nul
cd /d "%~dp0"
rem This machine has no system-wide Node, so qq-bridge uses the portable Node 24.18.1
rem next to the repo (portable) or from PATH.
rem System32 is prepended explicitly so state ACL hardening can find icacls even when
rem this launcher is double-clicked from Explorer with a minimal PATH.
rem _tools\ffmpeg is prepended so the bridge can find ffprobe/ffmpeg by bare name
rem (its duration check shells out to "ffprobe" and fails soft without it).
rem Guard mode: the bridge restarts 5 seconds after a crash. Close this window to stop.
set "PATH=C:\Windows\System32;C:\Windows;%PATH%"
rem Portable Node first (if present), otherwise fall back to node on PATH.
rem Public clones should just have Node >= 22.13 installed globally.
if exist "%~dp0..\_tools\node-v24.18.1-win-x64\node.exe" (
    set "NODE=%~dp0..\_tools\node-v24.18.1-win-x64\node.exe"
) else (
    set "NODE=node"
)
echo [qq-bridge] Node version:
"%NODE%" --version
echo [qq-bridge] Starting bridge (guard mode). Close this window to stop.
:loop
rem Fix DSH port before starting: the desktop app picks a random listen port on
rem every start, but config.dsh.baseUrl is static. ASCII comments only (non-ASCII
rem in a batch rem line can break parsing - 2026-10-27 guard exited silently).
"%NODE%" scripts\ensure-dsh-port.mjs
"%NODE%" src\bridge.js
set code=%errorlevel%
if "%code%"=="2" (
    echo [qq-bridge] Another instance is already running. This window will exit.
    pause
    exit /b 2
)
echo [qq-bridge] Bridge exited with code %code%; restarting in 5 seconds...
timeout /t 5 /nobreak >nul
goto loop
