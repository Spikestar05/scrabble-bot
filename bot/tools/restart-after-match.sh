#!/bin/bash
# Restart the live bot right after its current match ends (run-live.sh
# relaunches it with the current code).
LOG="$(dirname "$0")/../../logs/live-${BOT_NAME:-astronaut}.log"
tail -n0 -F "$LOG" | grep -m1 "ended: place" >/dev/null
pkill -f "tsx src/index.ts"
echo "restarted at $(date -u +%T)"
