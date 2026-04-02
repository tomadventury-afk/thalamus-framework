# Thalamus Deep Dive — Zero-Overhead Agent Coordination

## The Problem with Existing Frameworks

Every major multi-agent framework — LangGraph, CrewAI, AutoGen, Google A2A —
uses the same approach for agent-to-agent communication: **API calls**.

Agent A needs something from Agent B? Make an API call. That means:
- Tokens burned on both sides (encoding + decoding the request)
- Network latency (even on localhost, HTTP adds milliseconds)
- Rate limit risk (hit the AI provider's limits)
- Fragility (API goes down → entire system stops)

This works fine for 2 agents doing a simple handoff.
It breaks at 4+ agents coordinating on complex tasks in real-time.

## The Thalamus Approach

Thalamus is a **local IPC daemon** — a permanently running process that
coordinates all agents on a single server via filesystem events and binary signals.

```
┌─────────┐     ┌─────────┐     ┌─────────┐
│  Boss   │     │ Worker1 │     │ Worker2 │
│ (uid 0) │     │(uid 1002)│    │(uid 1003)│
└────┬────┘     └────┬────┘     └────┬────┘
     │               │               │
     └───────┬───────┴───────┬───────┘
             │               │
       ╔═════╧═══════════════╧═════╗
       ║     THALAMUS DAEMON       ║
       ║  Unix Domain Socket       ║
       ║  Binary Signals           ║
       ║  File-based State         ║
       ╚═══════════════════════════╝
```

### Key Properties

**Zero API overhead:** Signals between agents are binary — a few bytes over a Unix socket.
No HTTP. No JSON serialization. No tokens.

**Autonomous waking:** Agents don't need to be running to receive tasks.
Thalamus watches the filesystem for new work items (escalations).
When one appears, it spawns the target agent, waits for completion, and delivers the result.

**OS-level isolation:** Each agent runs as a separate Unix user.
They cannot read each other's files. They cannot kill each other's processes.
The only way to communicate is through Thalamus.

**Loop detection:** If Agent A asks Agent B, and Agent B tries to ask Agent A back,
Thalamus detects the circular dependency and blocks it before it starts.

**Crash recovery:** On startup, Thalamus scans for unprocessed work items.
If the system crashed while an agent was mid-task, recovery happens automatically.

---

## How Agents Communicate

### 1. Escalations (Work Items)

An agent that needs something from another agent writes an **escalation file** — a JSON document
with subject, context, and what kind of response is needed.

```json
{
  "from": "boss",
  "to": "worker1",
  "type": "decision",
  "subject": "Analyze the authentication module and propose improvements",
  "need": "resolution",
  "status": "pending"
}
```

### 2. Signals (Notifications)

After writing the escalation, the agent sends a binary signal to the daemon.
The daemon processes it and wakes the target agent.

Signal types include: STATE_CHANGED, NEED_INPUT, TASK_DONE, BLOCKED, ERROR, HEARTBEAT, ESCALATE.

### 3. State Files (Current Status)

Each agent maintains a state file that other agents can read:

```json
{
  "agent": "worker1",
  "status": "working",
  "current_task": "Analyzing auth module",
  "updated_at": "2026-04-01T14:30:00Z"
}
```

State writes are **atomic** (write to temp file, then rename) — no torn reads, ever.

---

## Resilience Features

### Circuit Breaker
3 consecutive failures → agent suspended for 30 minutes.
Prevents cascade failures when an agent is stuck in an error loop.

### Rate Limiting
Configurable per agent pair. Default: 5 escalations per minute.
Prevents accidental flooding.

### Graceful Degradation
When the AI API goes down:
1. **FULL → DEGRADED:** New escalations buffered to a dead letter queue
2. **DEGRADED → MANUAL:** All agents stopped, human intervention needed
3. **Recovery:** DLQ replayed automatically when API returns

### Health Monitoring
- Heartbeat signals every 30 seconds (90s TTL — warning if missed)
- Telegram alerts for critical events (agent suspended, API down, system degraded)
- Status dump every 5 minutes for monitoring

---

## Namespace Routing

Agents are organized into namespaces. Agents in the same namespace can
route escalations directly. Cross-namespace escalations go through the orchestrator.

```
Namespace: core          Namespace: dev
├── Boss (orchestrator)  ├── DevAgent (developer)
├── Worker1 (executor)
├── Worker2 (specialist)
```

DevAgent can't directly escalate to Worker1.
It must go: DevAgent → Boss → Worker1.

This prevents chaos when the number of agents grows.

---

## Comparison

| Feature | Thalamus | LangGraph | CrewAI | AutoGen | Google A2A |
|---------|----------|-----------|--------|---------|------------|
| Communication | IPC (binary) | API calls | API calls | API calls | HTTP/SSE |
| Token cost for coordination | **0** | High | High | High | Medium |
| Latency | **<1ms** | 100ms+ | 100ms+ | 100ms+ | 50ms+ |
| Autonomous agent waking | **Yes** | No | No | No | No |
| Loop detection | **Yes** | No | No | No | No |
| Circuit breaker | **Yes** | No | No | No | No |
| Graceful degradation | **Yes** | No | No | No | No |
| Dead letter queue | **Yes** | No | No | No | No |
| OS-level agent isolation | **Yes** | No | No | No | No |
| Crash recovery | **Yes** | No | No | Partial | No |
| Namespace routing | **Yes** | No | No | No | Partial |

---

## What's NOT in This Repo

This repo contains a simplified reference implementation that demonstrates the core concepts.

The production system additionally includes:
- Full daemon with all resilience features
- Brain consolidation pipeline (Hippocampus → Neocortex)
- Micro-Agent Swarm orchestration engine
- 32-test certification suite
- Telegram notification system
- Multi-namespace production routing

Interested in the production version?
→ [Contact KI Force](https://ki-force.de/contact)

---

*Built by [KI Force](https://ki-force.de) — Thomas Less, Munich, Germany*
