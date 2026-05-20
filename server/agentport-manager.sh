#!/bin/bash
set -uo pipefail

DAEMON_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DAEMON_DIR"

LOG_DIR="$DAEMON_DIR"
LOG_FILE="$LOG_DIR/agentport.log"
AUDIT_LOG="$LOG_DIR/audit.log"
MAX_LOG_SIZE=10485760  # 10MB
MAX_LOG_COPIES=5

rotate_log() {
  local target="$1"
  [ -f "$target" ] || return 0
  local size
  size=$(stat -c%s "$target" 2>/dev/null || echo 0)
  if [ "$size" -gt "$MAX_LOG_SIZE" ]; then
    # Rotate: .log.5 -> delete, .log.4 -> .log.5, ..., .log -> .log.1
    local i
    for (( i=MAX_LOG_COPIES; i>=1; i-- )); do
      local prev=$((i-1))
      if [ "$prev" -eq 0 ]; then
        [ -f "$target" ] && mv "$target" "${target}.1"
      else
        [ -f "${target}.${prev}" ] && mv "${target}.${prev}" "${target}.${i}"
      fi
    done
  fi
}

echo "[agentport] checking runtime"
command -v node >/dev/null
command -v npm >/dev/null

echo "[agentport] installing dependencies"
npm install express cors fast-glob dotenv --no-fund --no-audit >/dev/null 2>&1

if [ ! -f "server.js" ]; then
  echo "[agentport] server.js not found, aborting"
  exit 1
fi

echo "[agentport] stopping old daemon"
# Only kill node server.js processes running from this directory
for pid in $(ss -tlnp 2>/dev/null | grep ":${PORT:-3183} " | grep -oP 'pid=\K[0-9]+'); do
  kill "$pid" 2>/dev/null || true
done
# Fallback: kill by cwd match
for pid in $(pgrep -f "node server.js" 2>/dev/null); do
  if [ "$(readlink /proc/$pid/cwd 2>/dev/null)" = "$DAEMON_DIR" ]; then
    kill "$pid" 2>/dev/null || true
  fi
done
sleep 1

# Unset runtime env vars so dotenv reads fresh .env on restart
unset PORT BIND_HOST WORKSPACE_ROOT ENABLE_DASHBOARD
unset EXEC_TIMEOUT_MS EXEC_MAX_CONCURRENCY EXEC_QUEUE_TIMEOUT_MS
unset AUDIT_LOG_PATH JOBS_DIR AUTH_TOKENS ADMIN_TOKENS

echo "[agentport] starting daemon with auto-restart guard"
while true; do
  # Rotate logs before each start if they've grown too large
  rotate_log "$LOG_FILE"
  rotate_log "$AUDIT_LOG"

  node server.js >> "$LOG_FILE" 2>&1
  EXIT_CODE=$?
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] agentport exited with code ${EXIT_CODE}, restarting in 5s..." >> "$LOG_FILE"
  sleep 5
done
