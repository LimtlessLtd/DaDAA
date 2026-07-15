@echo off
setlocal enabledelayedexpansion
REM Run this file by double-clicking it in File Explorer, or from Command Prompt with: run_bot.bat
REM Make sure your .env file contains DISCORD_BOT_TOKEN and BOT_OWNER_ID before launching.
cd /d "%~dp0"

set "PYTHON_EXE=%~dp0.venv\Scripts\python.exe"
if not exist "%PYTHON_EXE%" set "PYTHON_EXE=python"

where node >nul 2>&1
if errorlevel 1 (
    echo ERROR: Node.js was not found in PATH. Install Node.js or add it to PATH.
    pause
    exit /b 1
)

echo Checking for stale transcription server on port 8765...
call :CleanupPort 8765 server.py

echo Checking for stale bot server on port 8000...
call :CleanupPort 8000 index.js

start "Transcription Server" cmd /k "%PYTHON_EXE% server.py"

echo Waiting for transcription server to initialize...
timeout /t 5 >nul

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