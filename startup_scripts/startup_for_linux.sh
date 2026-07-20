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

echo "Checking for stale RAG server on port 8766..."
cleanup_port 8766 server/rag_server.py

echo "Checking for stale transcription server on port 8765..."
cleanup_port 8765 server/server.py

echo "Checking for stale bot server on port 8000..."
cleanup_port 8000 index.js

# Ensure logs directory exists
mkdir -p logs

echo "Starting RAG Server..."
"${PYTHON_EXE}" server/rag_server.py > logs/rag_server.log 2>&1 &
RAG_PID=$!
if command -v disown >/dev/null 2>&1; then disown ${RAG_PID} 2>/dev/null || true; fi

echo "Waiting for RAG server to initialize..."
sleep 5

echo "Starting RAG Ingestion Script..."
"${PYTHON_EXE}" server/rag_ingest.py > logs/rag_ingest.log 2>&1 &
INGEST_PID=$!
if command -v disown >/dev/null 2>&1; then disown ${INGEST_PID} 2>/dev/null || true; fi

echo "Waiting for RAG ingestion script to initialize..."
sleep 5

echo "Starting Transcription Server..."
"${PYTHON_EXE}" server/server.py > logs/transcription.log 2>&1 &
TRANS_PID=$!
if command -v disown >/dev/null 2>&1; then disown ${TRANS_PID} 2>/dev/null || true; fi

echo "Waiting for transcription server to initialize..."
sleep 5

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