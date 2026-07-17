#!/usr/bin/env bash
set -euo pipefail

# run_bot.sh - Linux/Unix equivalent to run_bot.bat
# - Change to the script directory
# - Prefer .venv/bin/python if present, otherwise python3 or python
# - Ensure Node.js is available
# - Kill stale processes listening on ports (matching server filenames)
# - Start transcription server (server.py) and bot (index.js) in background
# - Open dashboard URL in default browser where possible

cd "$(dirname "$0")"

# install all required NPM packages (if not already installed)
npm install

sudo apt install -y \
    espeak-ng \
    libespeak-ng1 \

# Helper: find and kill processes listening on a given port whose command line contains a match string
cleanup_port() {
  local port="$1"
  local match="$2"

  if ! command -v lsof >/dev/null 2>&1; then
    echo "lsof not found; skipping port cleanup for $port"
    return
  fi

  # Get PIDs listening on the TCP port
  local pids
  pids=$(lsof -iTCP:"${port}" -sTCP:LISTEN -t 2>/dev/null || true)
  if [ -z "${pids}" ]; then
    return
  fi

  for pid in ${pids}; do
    # Read the command line for the process (safe failure)
    local cmdline
    cmdline=$(tr '\0' ' ' < /proc/${pid}/cmdline 2>/dev/null || true)
    if [ -n "${cmdline}" ] && echo "${cmdline}" | grep -q "${match}"; then
      if kill -0 "${pid}" 2>/dev/null; then
        kill -9 "${pid}" 2>/dev/null && echo "Stopped stale process on port ${port} PID ${pid}"
      fi
    fi
  done
}

# Select Python executable
PYTHON_EXE=""
if [ -x "./.venv/bin/python" ]; then
  PYTHON_EXE="./.venv/bin/python"
elif command -v python3 >/dev/null 2>&1; then
  PYTHON_EXE="$(command -v python3)"
elif command -v python >/dev/null 2>&1; then
  PYTHON_EXE="$(command -v python)"
else
  echo "ERROR: Python not found. Install Python or create a .venv in the project root."
  exit 1
fi

# Check Node.js
if ! command -v node >/dev/null 2>&1; then
  echo "ERROR: Node.js was not found in PATH. Install Node.js or add it to PATH."
  exit 1
fi

# Warn if .env appears missing expected variables (does not source it)
if [ -f .env ]; then
  if ! grep -q '^DISCORD_BOT_TOKEN=' .env || ! grep -q '^BOT_OWNER_ID=' .env; then
    echo "WARNING: .env exists but may be missing DISCORD_BOT_TOKEN or BOT_OWNER_ID"
  fi
else
  echo "WARNING: .env not found. Ensure DISCORD_BOT_TOKEN and BOT_OWNER_ID are set (or available via your shell environment)."
fi

# Attempt to stop stale servers (matches behavior of original batch file)
echo "Checking for stale transcription server on port 8765..."
cleanup_port 8765 server.py

echo "Checking for stale bot server on port 8000..."
cleanup_port 8000 index.js

# Start servers in background and write logs
echo "Starting Transcription Server..."
"${PYTHON_EXE}" server.py > logs/transcription.log 2>&1 &
TRANS_PID=$!
# Try to disown so it survives closing the terminal
if command -v disown >/dev/null 2>&1; then
  disown ${TRANS_PID} 2>/dev/null || true
fi
sleep 1
if kill -0 ${TRANS_PID} 2>/dev/null; then
  echo "Transcription server started (PID ${TRANS_PID}), log: transcription.log"
else
  echo "Failed to start transcription server; check transcription.log"
fi

echo "Waiting for transcription server to initialize..."
sleep 5

echo "Starting DaDAA Bot..."
node index.js > logs/bot.log 2>&1 &
BOT_PID=$!
if command -v disown >/dev/null 2>&1; then
  disown ${BOT_PID} 2>/dev/null || true
fi
sleep 1
if kill -0 ${BOT_PID} 2>/dev/null; then
  echo "DaDAA Bot started (PID ${BOT_PID}), log: bot.log"
else
  echo "Failed to start DaDAA Bot; check bot.log"
fi

echo "Waiting for dashboard server to initialize..."
sleep 5

DASH_URL="http://localhost:8000/dashboard.html"
# Try to open default browser if possible
if command -v xdg-open >/dev/null 2>&1; then
  xdg-open "${DASH_URL}" >/dev/null 2>&1 || true
elif command -v gnome-open >/dev/null 2>&1; then
  gnome-open "${DASH_URL}" >/dev/null 2>&1 || true
else
  echo "Open the dashboard in your browser: ${DASH_URL}"
fi

exit 0
