#!/usr/bin/env bash
# Frees the app's dev port before boot. Guards against orphaned `nest start --watch`
# processes surviving a killed terminal/IDE crash and squatting on the port forever,
# which otherwise surfaces as EADDRINUSE on the next `npm run start:dev`.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${SCRIPT_DIR}/../.env"

if [ -z "${PORT:-}" ] && [ -f "${ENV_FILE}" ]; then
  PORT="$(grep -E '^PORT=' "${ENV_FILE}" | tail -n1 | cut -d'=' -f2- | tr -d '[:space:]"'"'"'')"
fi

PORT="${PORT:-3000}"

PIDS=$(lsof -ti "tcp:${PORT}" 2>/dev/null || true)

if [ -n "${PIDS}" ]; then
  echo "[free-port] Port ${PORT} is in use by PID(s): ${PIDS} — killing before starting."
  echo "${PIDS}" | xargs kill -9 2>/dev/null || true
fi
