#!/bin/bash
# Let the live bot play N more matches (default 5) and then stop cleanly:
# after N-1 match ends the STOP flag is set, so the Nth match is the last.
N=${1:-5}
LOGS="$(cd "$(dirname "$0")/../../logs" && pwd)"
LOG="$LOGS/live-${BOT_NAME:-astronaut}.log"
tail -n0 -F "$LOG" | grep --line-buffered "ended: place" | head -n $((N-1)) >/dev/null
touch "$LOGS/STOP"
while pgrep -f "tsx src/index.ts" >/dev/null || pgrep -f run-live.sh >/dev/null; do sleep 2; done
echo "cycle done: stopped at $(date -u +%T)"
grep "ended: place" "$LOG" | tail -n $N
