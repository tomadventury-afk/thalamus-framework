#!/bin/bash
# Worker Example — Simulates an agent processing a task
#
# In production, this would be:
#   claude --print --dangerously-skip-permissions "<prompt>"
#
# For this example, it just echoes the task and "completes" it.

TASK="$1"
AGENT="${AGENT_NAME:-unknown}"

echo "[$AGENT] Received task: $TASK"
echo "[$AGENT] Analyzing..."
sleep 2
echo "[$AGENT] Task completed. Result: Analyzed '$TASK' — found 3 improvements."
