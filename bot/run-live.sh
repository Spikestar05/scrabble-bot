#!/bin/bash
# Keeps the live bot running: restarts it whenever it exits (disconnects,
# crashes). Usage: BOT_NAME=<name> [BOT_TOKEN=<token>] ./run-live.sh
# Output goes to ../logs/live-<name>.log. The token is cached in
# .token-<name> after the first connect and never printed.
cd "$(dirname "$0")"
mkdir -p ../logs
while true; do
  npx tsx src/index.ts >> "../logs/live-${BOT_NAME:-bot}.log" 2>&1
  echo "$(date -u +%FT%TZ) bot exited with $?; restarting in 3s" >> "../logs/live-${BOT_NAME:-bot}.log"
  # after the first successful connect the cached token is used
  if [ -f ".token-${BOT_NAME:-bot}" ]; then unset BOT_TOKEN; fi
  sleep 3
done
