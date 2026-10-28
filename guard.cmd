@echo off
rem ---------------------------------------------------------------------------
rem qq-bridge autostart entry point (ASCII-only name on purpose: Task Scheduler
rem handles it without code-page ambiguity). The real launcher, which the user
rem double-clicks by hand, stays 启动桥接.cmd; this file is that same logic.
rem
rem This machine has no system-wide Node, so qq-bridge uses the portable
rem a portable Node next to the repo, otherwise node from PATH.
rem System32 is prepended explicitly so the state ACL hardening step can find
rem icacls even when started with a minimal PATH.
rem _tools\ffmpeg is prepended so qq-bridge can find ffprobe/ffmpeg by bare name:
rem its own duration check spawns "ffprobe" and fails soft (warning + no length
rem validation) when the binary is not on PATH. Do not remove that directory.
rem Guard mode: restart 5 seconds after a crash. Closing the window stops it.
rem ---------------------------------------------------------------------------
chcp 65001 >nul
cd /d "%~dp0"
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
rem DSH desktop app picks a random listen port on every start (no --port flag,
rem no runtime file). config.dsh.baseUrl is static, so the bridge loses DSH
rem whenever the port changes (6 times between 2026-10-19 and 10-26).
rem This runs before every bridge start and rewrites the URL to the real port.
rem Comments kept ASCII-only on purpose: non-ASCII in a batch rem line can break
rem parsing under some code pages (2026-10-27: guard exited silently -> no bridge).
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
