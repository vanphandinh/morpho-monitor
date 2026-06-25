#!/bin/sh
set -e

echo "╔══════════════════════════════════════════════════════════╗"
echo "║   Morpho Blue — Docker Container                       ║"
echo "╚══════════════════════════════════════════════════════════╝"
echo ""
echo "  Starting monitor + webapp + proxy..."
echo ""

# Run all three services in parallel, wait for any to exit
node --env-file=/app/.env monitor.mjs &
MONITOR_PID=$!

node --env-file=/app/.env webapp-server.mjs &
WEBAPP_PID=$!

node --env-file=/app/.env proxy-rpc.mjs &
PROXY_PID=$!

# Forward SIGTERM to all children
trap "kill $MONITOR_PID $WEBAPP_PID $PROXY_PID 2>/dev/null; exit 0" TERM INT

# Wait for any (if one dies, kill the others and exit)
wait -n $MONITOR_PID $WEBAPP_PID $PROXY_PID
EXIT_CODE=$?
kill $MONITOR_PID $WEBAPP_PID $PROXY_PID 2>/dev/null
wait
exit $EXIT_CODE
