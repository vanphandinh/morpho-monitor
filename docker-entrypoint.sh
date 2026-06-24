#!/bin/sh
set -e

echo "╔══════════════════════════════════════════════════════════╗"
echo "║   Morpho Blue — Docker Container                       ║"
echo "╚══════════════════════════════════════════════════════════╝"
echo ""
echo "  Starting monitor + webapp..."
echo ""

# Run both services in parallel, wait for either to exit
node --env-file=/app/.env monitor.mjs &
MONITOR_PID=$!

node --env-file=/app/.env webapp-server.mjs &
WEBAPP_PID=$!

# Forward SIGTERM to both children
trap "kill $MONITOR_PID $WEBAPP_PID 2>/dev/null; exit 0" TERM INT

# Wait for both (if one dies, kill the other and exit)
wait -n $MONITOR_PID $WEBAPP_PID
EXIT_CODE=$?
kill $MONITOR_PID $WEBAPP_PID 2>/dev/null
wait
exit $EXIT_CODE
