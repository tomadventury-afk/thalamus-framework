# Thalamus Framework — AI Infrastructure Modeled After the Human Brain

> We didn't follow software patterns. We followed the brain.

---

## The Story

One entrepreneur. One AI assistant. A €30/month server.

What started as a Telegram bot became a fully autonomous multi-agent system
that plans, builds, tests, and reviews software — without human intervention.

Four AI agents coordinate in real-time via binary signals. A nightly "dream routine"
consolidates memory. An "amygdala" prevents repeating past mistakes.
A swarm of ephemeral workers autonomously rebuilds entire services.

This repository explains how it works, why it's modeled after the human brain,
and provides a simplified reference implementation you can run yourself.

---

## The Brain Architecture (8 Layers)

```
NEST (Layer 8) ─────────────────────────────────────────
  │
  ├── Agent A ────── Agent B ────── Agent C
  │          ↘          ↓          ↙
  │           [  THALAMUS (Layer 4b)  ]
  │                     │
  │          ┌──────────┴──────────┐
  │     Hippocampus          Neocortex
  │     (Layer 2)            (Layer 3)
  │     Short-term DB        Long-term DB
  │
  ├── Failsafe (Layer 5) — no work ever lost
  ├── Amygdala (Layer 6) — no mistake repeated
  └── Dream Routine (Layer 7) — runs every night at 3am
```

| Layer | Name | Human Brain | Our System |
|-------|------|-------------|------------|
| 1 | **Context Window** | Working Memory | Session state, identity, rules — rebuilt every morning |
| 2 | **Hippocampus** | Short-term Memory | Cloud database: today's conversations, recent facts, goals |
| 3 | **Neocortex** | Long-term Memory | Relational database: consolidated knowledge that survives months |
| 4b | **Thalamus** | Signal Routing | IPC daemon: zero-overhead coordination between agents |
| 5 | **Failsafe** | Survival Instinct | Task contracts, crash recovery, git checkpoints |
| 6 | **Amygdala** | Fear Memory | Error database — checked before every risky action |
| 7 | **Dream Routine** | Sleep Consolidation | Nightly cron: compress, deduplicate, self-review |
| 8 | **NEST** | Neural Network | Multi-agent enterprise OS (14-16 specialized agents) |

Each layer solves a specific problem that humans face too.
The naming isn't decoration — it's a design philosophy:
**build AI infrastructure the way evolution built intelligence.**

→ [Full architecture explanation](docs/brain-architecture.md)

---

## Why Thalamus Changes Everything

Every major multi-agent framework — LangGraph, CrewAI, AutoGen —
coordinates agents via API calls. That costs tokens, adds latency, and breaks under load.

Thalamus coordinates via **local IPC**: binary signals over Unix sockets.
Zero tokens. Microsecond latency. Agents wake autonomously.

| | Thalamus | LangGraph | CrewAI | AutoGen | Google A2A |
|---|----------|-----------|--------|---------|------------|
| Communication | **IPC (binary)** | API calls | API calls | API calls | HTTP/SSE |
| Token cost | **0** | $$ | $$ | $$ | $ |
| Latency | **<1ms** | 100ms+ | 100ms+ | 100ms+ | 50ms+ |
| Autonomous waking | **Yes** | No | No | No | No |
| Loop detection | **Yes** | No | No | No | No |
| Circuit breaker | **Yes** | No | No | No | No |
| Graceful degradation | **Yes** | No | No | No | No |
| Crash recovery | **Yes** | No | No | Partial | No |

→ [Detailed comparison](docs/comparison.md) | [Thalamus deep dive](docs/thalamus-deep-dive.md)

---

## Micro-Agent Swarm

The real power: **ephemeral worker agents** with specialized roles that autonomously
develop software through a complete pipeline.

**Pipeline:** `Planner → Builder → Tester → Reviewer → Fix Loop`

**8 Roles:** Planner · Frontend · Backend · Database · Infra · Reviewer · Tester · Debugger

Each worker gets a custom context composed at spawn time:
`quality standards + tech stack + role definition + project context + task = specialized agent`

### Real Result (Anonymized)

An HTTP mail service — rebuilt from scratch by 8 autonomous workers:

| | Before | After |
|---|--------|-------|
| Lines of code | 96 | 190 |
| Input validation | Existence check only | Email format + type checks |
| Error responses | Internal details exposed | Structured JSON, no leaks |
| Rate limiting | None | 10 req/min, sliding window |
| Health endpoint | None | `GET /health` with uptime |
| Logging | `console.log` | Structured JSON + PII masking |
| Retry logic | None | Exponential backoff (3 attempts) |

**8 workers · 8 minutes · Score 9/10 · 2 fix rounds · 0 human intervention**

The reviewer found a real logic bug (dead error codes in the retry system)
and the debugger fixed it — autonomously.

→ [How the swarm works](docs/swarm.md) | [Full test results](docs/results.md)

---

## Recent Extensions (2026-04)

Since the initial release, the production system has grown significantly:

| Extension | What it adds |
|-----------|-------------|
| **Queue-Fix** | Retry-limit per escalation, `queued` state instead of overload-drop, queue flush on agent exit |
| **Heartbeat System** | `heartbeat-check.ts` monitors all agents every 60s via cron, wakes stuck agents, validates `laws.json` integrity with hash |
| **Peer-to-Peer Routing** | `peer-policy.json` enforces allowed routes, chain-depth limits (max 3), per-agent hourly budgets, cooldowns between same-pair escalations |
| **ICE — Intrusion Countermeasures** | 4-level response (patrol → white → grey → black), content scanner for dangerous payloads, frequency anomaly detection, HMAC signatures on all escalations |
| **Sprites** | `memory-sprite.ts` auto-generates `SESSION_SNAPSHOT.md` if missing or stale (>2h old), integrated into heartbeat |
| **Moltbook Client** | Full API client for Moltbook social platform — post, vote, read feed, detect service requests — with outbound filter blocking PII/secrets |

All extension files are in `example/` with production-identical code (absolute paths are server-specific; adapt to your environment).

---

## Try It Yourself

The `example/` directory contains the actual production implementation, including all recent extensions.

```bash
# Prerequisites: Bun runtime (https://bun.sh)
cd example

# Run the minimal demo (no external dependencies)
bash demo.sh

# Or manually:
# Terminal 1: Start the daemon
bun run thalamus-mini.ts

# Terminal 2: Send an escalation
bun run escalation-write.ts boss worker1 task "Analyze the login endpoint" answer 150

# Heartbeat check (dry-run, no side effects)
bun run heartbeat-check.ts --dry-run
```

→ [Example documentation](example/README.md)

---

## Test Results

The production system is validated by a **32-test certification suite** across 6 categories:

| Category | Tests | Pass Rate |
|----------|-------|-----------|
| Unit | 13 | 100% |
| Integration | 5 | 100% |
| E2E | 3 | 33% (known issue, fix scheduled) |
| Performance | 3 | 100% |
| Failure handling | 4 | 100% |
| Security | 4 | 100% |
| **Total** | **32** | **93%** |

Performance: State writes 81ms, signal roundtrip 83ms, 10-escalation burst 516ms.
All coordination is **zero tokens** — binary signals over Unix sockets.

→ [Detailed test results](docs/results.md)

---

## The Team

Built by **[KI Force](https://ki-force.de)** — a European AI transformation company.

**Thomas Less** — Entrepreneur & Chief Vision Officer
Munich, Germany · Former Head of New Media at Siemens (26 countries)
Now building autonomous AI infrastructure for European mid-market companies.

[LinkedIn](https://www.linkedin.com/in/thomas-less-49263454/) · [KI Force](https://ki-force.de)

---

## Production Version

This repository contains documentation and a simplified reference implementation.

The production system includes:
- Full Thalamus daemon with circuit breaker, DLQ, and graceful degradation
- Complete 8-layer brain system with nightly consolidation
- Micro-Agent Swarm orchestration engine
- 32-test certification suite
- Telegram notification system
- Multi-namespace routing

→ **[Interested? Let's talk.](https://ki-force.de)** | [Details](COMMERCIAL.md)

---

## License

MIT — see [LICENSE](LICENSE)

The example code and documentation are freely available.
The production Thalamus system is available under a commercial license.
