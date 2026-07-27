#!/usr/bin/env bash
set -euo pipefail

# run_bot.sh - Linux/Unix equivalent to run_bot.bat

cd "$(dirname "$0")/.."

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

# Polls a port until something accepts a TCP connection on it, instead of guessing a fixed
# delay - core_server.py's first-ever startup can take much longer than a warm one (model
# weight + voice tensor downloads), so a blind `sleep` either wastes time or isn't long enough.
# Returns 1 silently on timeout (no built-in message) so each call site can print its own
# contextual warning - matches startup_for_windows.bat's :WaitForPort, which leaves messaging
# to the caller the same way.
wait_for_port() {
  local port="$1"
  local max_wait="${2:-180}"
  local waited=0
  while ! (exec 3<>"/dev/tcp/127.0.0.1/${port}") 2>/dev/null; do
    sleep 2
    waited=$((waited + 2))
    if [ "${waited}" -ge "${max_wait}" ]; then
      return 1
    fi
  done
  exec 3>&- 3<&- 2>/dev/null || true
  return 0
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

echo "Checking for stale core server (RAG + transcription + TTS) on port 8766..."
cleanup_port 8766 server/core_server.py

echo "Checking for stale core server (RAG + transcription + TTS) on port 8765..."
cleanup_port 8765 server/core_server.py

echo "Checking for stale core server (RAG + transcription + TTS) on port 8767..."
cleanup_port 8767 server/core_server.py

echo "Checking for stale core server (image generation) on port 8768..."
cleanup_port 8768 server/core_server.py

echo "Checking for stale bot server on port 8000..."
cleanup_port 8000 index.js

# Ensure logs directory exists
mkdir -p logs

echo "Starting Core Server (RAG + Transcription + TTS)..."
"${PYTHON_EXE}" server/core_server.py > logs/core_server.log 2>&1 &
CORE_PID=$!
if command -v disown >/dev/null 2>&1; then disown ${CORE_PID} 2>/dev/null || true; fi

echo "Waiting for core server to initialize (loads whisper/sentence-transformers/Kokoro - can take a while on a cold cache)..."
wait_for_port 8766 180 || echo "WARNING: core server did not come up within 180s - continuing anyway, but TTS/RAG may not be ready yet."

# Advisory only - image generation (Stable Diffusion) loads last, after RAG/transcription/TTS
# are already up and unaffected, so nothing here blocks the rest of startup. A first-run model
# download can take several minutes; the bot's image queue already tolerates this port not being
# ready yet (a failed request is just logged), so this is purely to avoid the console looking
# "done starting" while a large download is silently still happening.
echo "Waiting for image generation server to initialize (may involve a large one-time model download)..."
wait_for_port 8768 600 || echo "NOTE: image generation server is not ready yet - portraits/event images will simply queue until it is."

echo "Starting DaDAA Bot..."
node index.js > logs/bot.log 2>&1 &
BOT_PID=$!
if command -v disown >/dev/null 2>&1; then disown ${BOT_PID} 2>/dev/null || true; fi

echo "Waiting for dashboard server to initialize..."
sleep 5

DASH_URL="http://localhost:8000/dashboard.html"
if command -v xdg-open >/dev/null 2>&1; then
  xdg-open "${DASH_URL}" >/dev/null 2>&1 || true
elif command -v gnome-open >/dev/null 2>&1; then
  gnome-open "${DASH_URL}" >/dev/null 2>&1 || true
else
  echo "Open the dashboard in your browser: ${DASH_URL}"
fi

exit 0