#!/bin/bash
set -euo pipefail

LOG="/srv/agentbus/state/heartbeat/heartbeat.log"
LOCKFILE="/tmp/heartbeat-wake.lock"
BUN="/root/.bun/bin/bun"
CHECK="/srv/agentbus/heartbeat-check.ts"
MAX_LOG=10000

# Lock: kein Overlap
if [ -f "$LOCKFILE" ]; then
  PID=$(cat "$LOCKFILE" 2>/dev/null)
  if kill -0 "$PID" 2>/dev/null; then
    echo "[$(date -u +%FT%T)] SKIP overlap (PID $PID)" >> "$LOG"
    exit 0
  fi
  rm -f "$LOCKFILE"
fi
echo $$ > "$LOCKFILE"
trap 'rm -f "$LOCKFILE"' EXIT

# Log-Rotation (simpel)
[ -f "$LOG" ] && [ $(wc -l < "$LOG") -gt $MAX_LOG ] && tail -2000 "$LOG" > "${LOG}.tmp" && mv "${LOG}.tmp" "$LOG"

echo "[$(date -u +%FT%T)] START" >> "$LOG"
"$BUN" "$CHECK" >> "$LOG" 2>&1 || true
EXIT_CODE=$?
echo "[$(date -u +%FT%T)] END (exit $EXIT_CODE)" >> "$LOG"
