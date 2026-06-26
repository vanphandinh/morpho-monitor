#!/bin/sh
set -e

echo "╔══════════════════════════════════════════════════════════╗"
echo "║   Morpho Blue — Docker Container                       ║"
echo "╚══════════════════════════════════════════════════════════╝"
echo ""
echo "  Starting monitor + webapp + proxy (self-healing)..."
echo ""

# ──────────────────────────────────────────────
# Helper: start a service and track its PID
# ──────────────────────────────────────────────
start_service() {
  local name="$1"
  local script="$2"
  node --env-file=/app/.env "$script" &
  local pid=$!
  eval "${name}_PID=$pid"
  echo "[entrypoint] Started $name (PID $pid)"
}

# ──────────────────────────────────────────────
# Start all three services
# ──────────────────────────────────────────────
start_service "MONITOR" "monitor.mjs"
start_service "WEBAPP" "webapp-server.mjs"
start_service "PROXY" "proxy-rpc.mjs"

# ──────────────────────────────────────────────
# Forward SIGTERM/SIGINT to all children
# ──────────────────────────────────────────────
trap 'echo "[entrypoint] Shutting down all services..."; kill $MONITOR_PID $WEBAPP_PID $PROXY_PID 2>/dev/null || true; wait; exit 0' TERM INT

# ──────────────────────────────────────────────
# Supervisor loop: auto-restart crashed services
# ──────────────────────────────────────────────
echo "[entrypoint] Supervisor active — will restart any crashed service"
while true; do
  # wait -n returns when ANY child exits
  wait -n $MONITOR_PID $WEBAPP_PID $PROXY_PID 2>/dev/null
  EXIT_CODE=$?

  # Small delay to avoid tight crash loops
  sleep 2

  # Detect which service died and restart it
  if ! kill -0 $MONITOR_PID 2>/dev/null; then
    echo "[entrypoint] ⚠️  monitor crashed (exit $EXIT_CODE), restarting..."
    start_service "MONITOR" "monitor.mjs"
  fi

  if ! kill -0 $WEBAPP_PID 2>/dev/null; then
    echo "[entrypoint] ⚠️  webapp crashed (exit $EXIT_CODE), restarting..."
    start_service "WEBAPP" "webapp-server.mjs"
  fi

  if ! kill -0 $PROXY_PID 2>/dev/null; then
    echo "[entrypoint] ⚠️  proxy crashed (exit $EXIT_CODE), restarting..."
    start_service "PROXY" "proxy-rpc.mjs"
  fi

  echo "[entrypoint] All services running: monitor=$MONITOR_PID webapp=$WEBAPP_PID proxy=$PROXY_PID"
done
