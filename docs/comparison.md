# Comparison — Thalamus vs. Existing Frameworks

## The Landscape (as of 2026)

Multi-agent AI frameworks are everywhere. But they all share the same architectural
assumption: agents communicate via API calls.

Thalamus challenges that assumption.

---

## Feature Comparison

| Feature | Thalamus | LangGraph | CrewAI | AutoGen | Google A2A | Anthropic MCP |
|---------|----------|-----------|--------|---------|------------|---------------|
| **Communication** | Binary IPC | API calls | API calls | API calls | HTTP/SSE | JSON-RPC |
| **Token cost for coordination** | **0** | High | High | High | Medium | Low |
| **Coordination latency** | **<1ms** | 100ms+ | 100ms+ | 100ms+ | 50ms+ | 10ms+ |
| **Autonomous agent waking** | **Yes** | No | No | No | No | No |
| **Loop detection** | **Yes** | No | No | No | No | No |
| **Circuit breaker** | **Yes** | No | No | No | No | No |
| **Graceful degradation** | **Yes** | No | No | No | No | No |
| **Dead letter queue** | **Yes** | No | No | No | No | No |
| **OS-level isolation** | **Yes** | No | No | No | No | No |
| **Crash recovery** | **Yes** | No | No | Partial | No | No |
| **Namespace routing** | **Yes** | No | No | No | Partial | No |
| **Memory system** | **8-layer brain** | External | External | External | External | External |
| **Worker spawning** | **Ephemeral swarm** | Fixed graph | Fixed crew | Fixed group | Agent cards | Tools |

---

## What Each Framework Does Well

**LangGraph:** Great for defining fixed workflows as directed graphs. Strong typing, good debugging tools. Best when you know the exact flow in advance.

**CrewAI:** Easy to set up role-based agents. Good abstraction for "team" metaphor. Best for simple delegation patterns.

**AutoGen:** Microsoft-backed, good for conversational agent patterns. Supports human-in-the-loop. Best for research and experimentation.

**Google A2A:** Standard protocol for agent discovery and communication. Good interoperability vision. Best for cross-organization agent networks.

**Anthropic MCP:** Excellent for connecting AI to external tools (databases, APIs, file systems). Not an agent coordination framework — complementary to Thalamus.

---

## Where Thalamus Is Different

### 1. No API Calls for Coordination

Every other framework: Agent A calls the AI API to format a message, sends it to Agent B, which calls the AI API to parse it. Two API calls burned just to pass a message.

Thalamus: A binary signal (a few bytes) over a Unix socket. The AI API is only called when an agent actually needs to *think* — never for coordination overhead.

### 2. Agents Sleep Until Needed

In other frameworks, agents must be running to receive messages.
In Thalamus, agents can be completely stopped. The daemon watches for work items
and spawns agents on demand — like waking someone up when their expertise is needed.

### 3. The System Survives Failures

API goes down? Thalamus buffers work to a dead letter queue and replays it when the API returns.
Agent crashes? Pending work is recovered on restart.
Agent stuck in a loop? Circuit breaker suspends it after 3 failures.

No other framework provides all three.

### 4. Memory Is Built In

Other frameworks treat memory as an external concern ("just add a vector database").
Thalamus comes with 8 layers of memory — from session context to nightly consolidation —
modeled after the human brain.

---

## When to Use What

| Use case | Best choice |
|----------|-------------|
| Fixed workflow with known steps | LangGraph |
| Quick prototype with role-based agents | CrewAI |
| Research / conversational agents | AutoGen |
| Cross-organization agent networking | Google A2A |
| Connecting AI to external tools | Anthropic MCP |
| **Autonomous multi-agent system on a single server** | **Thalamus** |
| **Production system that must not go down** | **Thalamus** |
| **10+ agents coordinating in real-time** | **Thalamus** |

---

## The Honest Limitations

Thalamus is **not** a cloud-native distributed system. It runs on a single server.
If you need agents across multiple machines or cloud regions, Thalamus alone won't do it
(though it can serve as the local coordinator within each node).

Thalamus is **not** model-agnostic in the same way LangGraph is.
It's built around Claude Code / Anthropic's API. Adapting it to other models is possible
but not the primary design goal.

Thalamus is **not** a simple pip install. It requires a Linux server, Unix users,
and understanding of process management. It's infrastructure, not a library.

---

*Research conducted March 2026, comparing framework capabilities as documented.*
*Built by [KI Force](https://ki-force.de) — Thomas Less, Munich, Germany*
