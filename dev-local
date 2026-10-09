#!/usr/bin/env sh
# dev-local.sh — run Katnor locally without Docker: server + worker + web.
#
# Usage: ./dev-local.sh (Ctrl+C stops all three)
# Reads .env from repo root. Respects SERVER_PORT / WEB_PORT /
# PUBLIC_SERVER_URL when set, else defaults to 3010 / 3011 /
# http://localhost:3010.
set -eu

ROOT=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
cd "$ROOT"
LOG_DIR="${TMPDIR:-/tmp}/katnor-logs"
mkdir -p "$LOG_DIR" /tmp/katnor-artifacts /tmp/katnor-workspaces /tmp/katnor-wiki

if [ ! -f ./.env ]; then
  echo "missing ./.env — copy .env.example to .env first" >&2
  exit 1
fi
set -a
# shellcheck disable=SC1091
. ./.env
set +a

if [ -s "$HOME/.nvm/nvm.sh" ]; then
  # shellcheck disable=SC1091
  . "$HOME/.nvm/nvm.sh"
  nvm use --delete-prefix 24 >/dev/null 2>&1 || nvm install 24
fi
command -v node >/dev/null || { echo "node not found" >&2; exit 1; }
command -v pnpm >/dev/null || { echo "pnpm not found" >&2; exit 1; }
NODE_MAJOR=$(node -p "process.versions.node.split('.')[0]")
if [ "$NODE_MAJOR" -lt 22 ]; then
  echo "node >=22 required, found $(node --version)" >&2
  exit 1
fi
if [ -z "${DATABASE_URL:-}" ]; then
  echo "DATABASE_URL empty — check ./.env sourced from repo root" >&2
  exit 1
fi

SERVER_PORT="${SERVER_PORT:-3010}"
WEB_PORT="${WEB_PORT:-3011}"
PUBLIC_SERVER_URL="${PUBLIC_SERVER_URL:-http://localhost:$SERVER_PORT}"
export SERVER_PORT WEB_PORT PUBLIC_SERVER_URL

port_busy() {
  node -e "require('net').connect($1,'127.0.0.1').on('connect',()=>process.exit(0)).on('error',()=>process.exit(1))"
}
for p in "$SERVER_PORT" "$WEB_PORT"; do
  if port_busy "$p"; then
    echo "port $p busy — stop occupier or change SERVER_PORT/WEB_PORT in .env" >&2
    exit 1
  fi
done
if command -v pg_isready >/dev/null; then
  pg_isready -h localhost -p "${PGPORT:-54322}" >/dev/null || {
    echo "postgres unreachable — start local postgres first" >&2
    exit 1
  }
fi

pnpm --filter @katnor/server dev > "$LOG_DIR/server.log" 2>&1 &
SERVER_PID=$!

TRIES=0
until curl -sf "http://localhost:$SERVER_PORT/health" >/dev/null 2>&1; do
  TRIES=$((TRIES + 1))
  if [ "$TRIES" -ge 30 ]; then
    echo "server unhealthy after 30s — see $LOG_DIR/server.log" >&2
    kill "$SERVER_PID" 2>/dev/null || true
    exit 1
  fi
  sleep 1
done
echo "server up: http://localhost:$SERVER_PORT"

pnpm --filter @katnor/worker dev > "$LOG_DIR/worker.log" 2>&1 &
WORKER_PID=$!
pnpm --filter @katnor/web dev -- --port "$WEB_PORT" > "$LOG_DIR/web.log" 2>&1 &
WEB_PID=$!
echo "worker pid $WORKER_PID (log $LOG_DIR/worker.log)"
echo "web up: http://localhost:$WEB_PORT (log $LOG_DIR/web.log)"

trap 'kill "$SERVER_PID" "$WORKER_PID" "$WEB_PID" 2>/dev/null' INT TERM
wait
