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

echo Checking for stale bot server on port 8000...
call :CleanupPort 8000 index.js

start "Core Server (RAG + Transcription + TTS)" cmd /k "%PYTHON_EXE% server\core_server.py"

echo Waiting for core server to initialize (loads whisper/sentence-transformers/Kokoro - can take a while on a cold cache)...
call :WaitForPort 8766 180
if errorlevel 1 (
    echo WARNING: core server did not come up within 180 seconds - continuing anyway, but TTS/RAG may not be ready yet.
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
