#!/bin/bash
# Thalamus Mini — Interactive Demo
#
# Run this to see the full cycle:
# 1. Start the daemon
# 2. Send an escalation
# 3. Watch the agent wake up and complete the task

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Clean previous state
rm -rf data/

echo "╔══════════════════════════════════════════════╗"
echo "║  Thalamus Mini — Live Demo                   ║"
echo "╚══════════════════════════════════════════════╝"
echo

# Start daemon in background
echo "→ Starting Thalamus daemon..."
bun run thalamus-mini.ts &
DAEMON_PID=$!
sleep 2

echo
echo "→ Sending escalation: boss → worker1"
echo "  Task: 'Review the authentication module for security issues'"
echo
bun run escalation.ts boss worker1 "Review the authentication module for security issues"

echo
echo "→ Waiting for worker to complete..."
sleep 5

echo
echo "→ Checking agent states:"
for agent in boss worker1 worker2; do
  if [ -f "data/state/$agent.json" ]; then
    STATUS=$(cat "data/state/$agent.json" | grep -o '"status":"[^"]*"' | cut -d'"' -f4)
    echo "  $agent: $STATUS"
  fi
done

echo
echo "→ Checking escalation results:"
for f in data/escalations/*.json; do
  if [ -f "$f" ]; then
    STATUS=$(cat "$f" | grep -o '"status":"[^"]*"' | head -1 | cut -d'"' -f4)
    RESOLUTION=$(cat "$f" | grep -o '"resolution":"[^"]*"' | cut -d'"' -f4)
    if [ "$STATUS" = "resolved" ]; then
      echo "  ✓ Resolved: $RESOLUTION"
    fi
  fi
done

echo
echo "→ Demo complete. Stopping daemon..."
kill $DAEMON_PID 2>/dev/null
echo "Done."
