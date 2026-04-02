# Thalamus Mini — Quick Start

A simplified reference implementation demonstrating the core Thalamus concepts.

## Prerequisites

- [Bun](https://bun.sh) runtime (v1.0+)
- Linux or macOS

## Run the Demo

```bash
# One command — starts daemon, sends escalation, shows result
chmod +x demo.sh worker-example.sh
bash demo.sh
```

## Manual Usage

### 1. Start the Thalamus daemon

```bash
bun run thalamus-mini.ts
```

### 2. In another terminal — send an escalation

```bash
bun run escalation.ts boss worker1 "Analyze the login endpoint for vulnerabilities"
```

### 3. Watch the daemon

The daemon detects the new escalation, wakes `worker1`, waits for completion,
and resolves the escalation with the result.

### 4. Check state

```bash
# Agent states
cat data/state/worker1.json

# Escalation results
cat data/escalations/*.json
```

## Update agent state manually

```bash
bun run state-write.ts worker1 working "Manual task"
bun run state-write.ts worker1 idle
```

## What This Demonstrates

| Concept | How it works here | Production version |
|---------|------------------|-------------------|
| Atomic state writes | temp file → rename | Same, + signal notification |
| Escalation system | JSON files in directory | Same, + binary signals |
| File watcher | Node.js `fs.watch` | Same, + debouncing |
| Agent waking | `spawn("bash", ...)` | `spawn("claude", ...)` with timeout |
| Loop detection | Checks pending escalations | Same, + rate limiting |
| Crash recovery | Scans pending on startup | Same, + dead letter queue |

## What's NOT Here

This example intentionally omits production features:
- Binary signal protocol (uses filesystem events instead)
- Circuit breaker
- Rate limiting
- Graceful degradation / dead letter queue
- Namespace routing
- Telegram alerts
- Health monitoring
- Brain memory system (8 layers)

These are part of the [production version](../COMMERCIAL.md).
