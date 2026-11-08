#!/bin/bash
# Clean stop: the bot finishes its current match, does not rejoin the lobby,
# and the supervisor exits. Returns once everything is down.
LOGS="$(cd "$(dirname "$0")/../../logs" && pwd)"
touch "$LOGS/STOP"
while pgrep -f "tsx src/index.ts" >/dev/null || pgrep -f run-live.sh >/dev/null; do sleep 2; done
echo "stopped at $(date -u +%T)"
