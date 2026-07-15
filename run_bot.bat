@echo off
setlocal
REM Run this file by double-clicking it in File Explorer, or from Command Prompt with: run_bot.bat
REM Make sure your .env file contains DISCORD_BOT_TOKEN and BOT_OWNER_ID before launching.
set PYTHON_EXE=%~dp0.venv\Scripts\python.exe
start "Transcription Server" "%PYTHON_EXE%" "%~dp0server.py"
start "Dashboard" http://localhost:8000/dashboard.html
node "%~dp0index.js"