@echo off
setlocal enabledelayedexpansion
REM Run this file by double-clicking it in File Explorer, or from Command Prompt with: run_bot.bat
REM Make sure your .env file contains DISCORD_BOT_TOKEN and BOT_OWNER_ID before launching.
cd /d "%~dp0.."

set "PYTHON_EXE=%~dp0..\.venv\Scripts\python.exe"
if not exist "%PYTHON_EXE%" set "PYTHON_EXE=python"

where node >nul 2>&1
if errorlevel 1 (
    echo ERROR: Node.js was not found in PATH. Install Node.js or add it to PATH.
    pause
    exit /b 1
)

echo Checking for stale core server (RAG + transcription + TTS) on port 8766...
call :CleanupPort 8766 server\core_server.py

echo Checking for stale core server (RAG + transcription + TTS) on port 8765...
call :CleanupPort 8765 server\core_server.py

echo Checking for stale core server (RAG + transcription + TTS) on port 8767...
call :CleanupPort 8767 server\core_server.py

echo Checking for stale core server (image generation) on port 8768...
call :CleanupPort 8768 server\core_server.py

echo Checking for stale bot server on port 8000...
call :CleanupPort 8000 index.js

REM Image generation (Stable Diffusion) shares the same GPU as Ollama - on a card small enough
REM that the LLM doesn't comfortably fit alongside it (see CLAUDE.md's numCtx/model-size notes),
REM leaving Stable Diffusion on GPU measurably slows every single LLM turn, not just image jobs.
REM Image posts are already fire-and-forget/rate-limited and never block conversation, so forcing
REM this to CPU trades slower (but still working) portraits/event images for full GPU throughput
REM on the turn-critical LLM path. Remove this line (or set it to "cuda") to put images back on GPU.
set "IMAGEGEN_DEVICE=cpu"

start "Core Server (RAG + Transcription + TTS)" cmd /k "%PYTHON_EXE% server\core_server.py"

echo Waiting for core server to initialize (loads whisper/sentence-transformers/Kokoro - can take a while on a cold cache)...
call :WaitForPort 8766 180
if errorlevel 1 (
    echo WARNING: core server did not come up within 180 seconds - continuing anyway, but TTS/RAG may not be ready yet.
)

REM Advisory only - image generation (Stable Diffusion) loads last, after RAG/transcription/TTS
REM are already up and unaffected, so nothing here blocks the rest of startup. A first-run model
REM download can take several minutes; the bot's image queue already tolerates this port not
REM being ready yet (a failed request is just logged and retried later), so this is purely to
REM avoid the console looking "done starting" while a large download is silently still happening.
echo Waiting for image generation server to initialize (may involve a large one-time model download)...
call :WaitForPort 8768 600
if errorlevel 1 (
    echo NOTE: image generation server is not ready yet - portraits/event images will simply queue until it is.
)

echo Starting DaDAA Bot...
start "DaDAA Bot" cmd /k "node index.js"

echo Waiting for dashboard server to initialize...
timeout /t 5 >nul

start "" "http://localhost:8000/dashboard.html"
exit /b 0

:CleanupPort
setlocal
set "port=%1"
set "match=%2"
powershell -nologo -command "$port=%port%; $match='%match%'; Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -Expand OwningProcess -Unique | ForEach-Object { try { $proc = Get-CimInstance Win32_Process -Filter \"ProcessId=$_\" -ErrorAction Stop; if ($proc.CommandLine -match $match) { Stop-Process -Id $_ -Force; Write-Host 'Stopped stale process on port' $port 'PID' $_ } } catch {} }"
endlocal
exit /b 0

REM Polls a port until something accepts a TCP connection on it, instead of guessing a fixed
REM delay - core_server.py's first-ever startup can take much longer than a warm one (model
REM weight + voice tensor downloads), so a blind `timeout` either wastes time or isn't long enough.
REM No setlocal here - this subroutine's exit code must reach the caller unmangled.
:WaitForPort
set "port=%1"
set "maxwait=%2"
powershell -nologo -command "$port=%port%; $deadline=(Get-Date).AddSeconds(%maxwait%); while ($true) { try { $c = New-Object System.Net.Sockets.TcpClient; $c.Connect('127.0.0.1', $port); $c.Close(); exit 0 } catch { if ((Get-Date) -ge $deadline) { exit 1 }; Start-Sleep -Seconds 2 } }"
exit /b %errorlevel%
