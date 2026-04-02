# Micro-Agent Swarm — Autonomous Software Development

## The Concept

What if you could tell an AI system "rebuild this service" and walk away?

The Micro-Agent Swarm does exactly that. Instead of one AI trying to do everything —
plan, code, test, review — we split the work into specialized roles.
Each role is an ephemeral worker: it spawns, does one job, writes a result, and dies.

An orchestrator manages the pipeline. No human in the loop until the final review.

---

## Architecture

```
LAYER 1 — PERSISTENT
├── Orchestrator Agent — decides WHAT gets built
├── Build State (JSON) — single source of truth for all jobs
└── Git — version control, feature branches

LAYER 2 — BRIDGE
├── Job specs (JSON) — orchestrator writes, workers read
├── Spawn script — starts workers, collects results
└── Result files (JSON) — workers write, orchestrator reads

LAYER 3 — EPHEMERAL WORKERS
├── Specialized Claude Code sessions
├── Dedicated OS user with --dangerously-skip-permissions
├── Role + Context composed into CLAUDE.md at spawn time
└── Dies after completing task
```

---

## The 8 Roles

### Quality Gates (steer, don't write production code)

| Role | What it does | When it's called |
|------|-------------|-----------------|
| **Planner** | Reads spec + existing code, creates work packages with deliverables, identifies risks | Always first on every new build |
| **Reviewer** | Code review against standards — types, error handling, patterns, consistency | After every build, before merge |
| **Tester** | Writes tests (unit, integration, E2E), checks edge cases | Before or parallel to build (TDD) |
| **Debugger** | Analyzes failures, finds root cause, applies targeted fix | Only when something breaks |

### Builders (write actual code)

| Role | Specialization | Typical job |
|------|---------------|------------|
| **Frontend** | React, Next.js, Tailwind, components | UI components, admin dashboards |
| **Backend** | API routes, middleware, auth, business logic | Endpoints, mail queues, analyzers |
| **Database** | Schema design, migrations, queries, RLS | Schema design, query optimization |
| **Infra** | Process management, reverse proxy, deployment | New services, port management |

---

## How Context Composition Works

Each worker gets a custom CLAUDE.md assembled at spawn time:

```
Worker's CLAUDE.md = 
    shared/quality-standards.md    (always)
  + shared/stack.md                (always)
  + shared/server.md               (always)
  + roles/{role}.md                (worker's specialization)
  + contexts/{project}.md          (project knowledge)
  + job instructions               (specific task)
```

This means:
- The **same Frontend role** + different project context = different specialized worker
- No monolithic config that knows everything
- Each worker gets only what it needs — no noise, no wasted tokens

---

## The Pipeline

```
1. PLAN    — Planner analyzes the spec, produces ordered work packages
2. BUILD   — Builder(s) execute each package sequentially
3. TEST    — Tester runs smoke tests against the build
4. REVIEW  — Reviewer scores the code (1-10) against quality standards
5. FIX     — If not approved: Debugger fixes issues, back to REVIEW
6. DONE    — Orchestrator archives results, notifies human
```

The fix loop runs up to 3 times. If the code still doesn't pass after 3 rounds,
the orchestrator escalates to a human.

---

## Real Result (Anonymized)

**Task:** Rebuild an HTTP mail service from scratch

**Before (original):**
- 96 lines of code
- No input validation
- No error handling details hidden from client
- No rate limiting
- No health endpoint
- No structured logging
- No retry logic

**After (built by 8 autonomous workers):**
- 190 lines of code
- Email format validation
- Structured JSON error responses (no internal details leaked)
- Rate limiting (10 requests/minute, sliding window)
- Health endpoint (`GET /health`)
- Structured JSON logging with PII masking
- Retry with exponential backoff for transient failures
- Configurable CORS origin

**Metrics:**

| Metric | Value |
|--------|-------|
| Total workers | 8 |
| Pipeline | Planner → Infra → Backend → Tester → Reviewer → Fix → Reviewer |
| Duration | 8 minutes |
| Final score | 9/10 |
| Fix rounds | 2 |
| Human intervention | 0 (during build) |

The reviewer found a logic bug in the retry system (dead error codes that never matched)
and a PII concern (email addresses in logs). Both were fixed autonomously by the debugger.

---

## Why Not Domain-Specific Agents?

We don't build separate agents per project (no "CRM Agent", no "Website Agent").
Instead, we use **Project Context Files** — one markdown file per project
that gets composed with the worker's role at spawn time.

The same Frontend Builder + CRM context = a worker that builds CRM frontend.
The same Frontend Builder + Website context = a worker that builds website frontend.

Specialization comes from **Role + Context**, not from separate agents.

---

## Scaling

| Tier | Server | Workers | Parallelism |
|------|--------|---------|------------|
| **Tier 1** (current) | 8 cores, 16 GB | 1 serial | None — strict sequential |
| **Tier 2** | 16 cores, 64 GB | 3 parallel | Frontend + Backend can work simultaneously |
| **Tier 3** | 48 cores, 192 GB | 8-12 parallel | Full pipelines — reviewer checks last build while builder starts next |

What changes between tiers: **one number** (`worker_slots.max`).
Everything else — protocol, roles, contexts, state — stays identical.

---

*Built by [KI Force](https://ki-force.de) — Thomas Less, Munich, Germany*
