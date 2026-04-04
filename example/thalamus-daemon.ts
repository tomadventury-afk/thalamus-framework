#!/usr/bin/env bun
/**
 * Thalamus Daemon — Layer 4b Shared State Bus
 * Version 3 — Namespaces, Registry, Transport-Abstraktion
 *
 * V2: Autonomes Agent-Waking via `claude --print`
 * V3: Namespace-Routing, Agent Registry, Rate-Limiting, Transport-Interface
 *
 * PM2: pm2 restart thalamus
 */

import { createServer, Socket }       from "net";
import { watch, writeFileSync, appendFileSync,
         readFileSync, existsSync, readdirSync, unlinkSync,
         chmodSync }                   from "fs";
import { join }                        from "path";
import { spawn }                       from "child_process";
import { createHmac }                  from "crypto";
import { createHealthChecker }         from "./health-check.ts";
import { createDegradationManager }    from "./degradation.ts";
import { createDeadLetterQueue }       from "./dead-letter-queue.ts";
import { iceResponse }                 from "./ice/response.ts";

const SECRETS_DIR = "/srv/agentbus/secrets";

function verifyEscalationSignature(esc: any): "ok" | "missing" | "invalid" {
  const keyFile = `${SECRETS_DIR}/${esc.from}.key`;
  if (!esc.signature) return "missing";
  try {
    const secret = readFileSync(keyFile, "utf-8").trim();
    const payload = `${esc.from}|${esc.to}|${esc.subject}|${esc.created_at}`;
    const expected = createHmac("sha256", secret).update(payload).digest("hex");
    return esc.signature === expected ? "ok" : "invalid";
  } catch {
    // Secret nicht lesbar → als fehlend behandeln (Übergangsphase)
    return "missing";
  }
}

// .env laden fuer Telegram-Alerts
try {
  const envFile = readFileSync("/root/claude-telegram-relay/.env", "utf-8");
  for (const line of envFile.split("\n")) {
    const m = line.match(/^([^#=]+)=(.*)$/);
    if (m && m[1].trim()) process.env[m[1].trim()] = m[2].trim();
  }
} catch {}

const BUS         = "/srv/agentbus";
const SOCKET_PATH = `${BUS}/signals/thalamus.sock`;
const LOG_FILE    = `${BUS}/signals/signal.log`;
const ESC_DIR     = `${BUS}/escalation`;
const CLAUDE_BIN  = "/root/.local/bin/claude";

// ── Agent-Konfiguration ────────────────────────────────────────────────────

interface AgentConfig {
  cwd: string; id: number; uid: number; gid: number; home: string; bin: string;
  namespace: string; role: string; maxEscPerMin: number; timeoutMs: number;
}

// Fallback-Config (wird beim Start von Registry überschrieben wenn verfügbar)
const AGENT_CONFIGS: Record<string, AgentConfig> = {
  lev:      { cwd: "/root/claude-telegram-relay", id: 0, uid: 0,    gid: 0,    home: "/root",          bin: "/root/.local/bin/claude",  namespace: "core", role: "orchestrator", maxEscPerMin: 10, timeoutMs: 180_000 },
  patricia: { cwd: "/home/patricia",              id: 1, uid: 1003, gid: 1003, home: "/home/patricia", bin: "/usr/bin/claude",          namespace: "core", role: "specialist",   maxEscPerMin: 5,  timeoutMs: 180_000 },
  nestdev:  { cwd: "/home/nestdev/projects/nest", id: 2, uid: 1002, gid: 1002, home: "/home/nestdev",  bin: "/usr/bin/claude",          namespace: "dev",  role: "developer",    maxEscPerMin: 5,  timeoutMs: 28_800_000 },  // 8h für CRM-Pilot Dev-Sessions
  levbot:   { cwd: "/home/levbot/workspace",      id: 3, uid: 1004, gid: 1004, home: "/home/levbot",   bin: "/usr/bin/claude",          namespace: "core", role: "executor",     maxEscPerMin: 10, timeoutMs: 14_400_000 },  // 4h für CRM-Pilot Executor-Sessions
};

const AGENT_NAMES: Record<number, string> = { 0: "lev", 1: "patricia", 2: "nestdev", 3: "levbot", 255: "broadcast" };
const AGENT_IDS:   Record<string, number> = { lev: 0, patricia: 1, nestdev: 2, levbot: 3 };

// ── Namespace-Routing ─────────────────────────────────────────────────────
// Agents im gleichen Namespace können frei kommunizieren.
// Cross-Namespace-Escalations gehen immer über den Orchestrator (lev).

const NAMESPACE_REGISTRY_FILE = `${BUS}/registry.json`;

function getNamespace(agent: string): string {
  return AGENT_CONFIGS[agent]?.namespace ?? "default";
}

function canDirectRoute(from: string, to: string): boolean {
  // Orchestrator kann immer direkt routen
  if (AGENT_CONFIGS[from]?.role === "orchestrator") return true;
  if (AGENT_CONFIGS[to]?.role === "orchestrator") return true;
  // Gleicher Namespace → direkt
  return getNamespace(from) === getNamespace(to);
}

function findOrchestrator(namespace: string): string | null {
  for (const [name, cfg] of Object.entries(AGENT_CONFIGS)) {
    if (cfg.role === "orchestrator") return name;
  }
  return "lev"; // Fallback
}

// Registry von Disk laden (wird beim Startup von Supabase geschrieben)
function loadRegistryFromDisk(): void {
  try {
    const data = JSON.parse(readFileSync(NAMESPACE_REGISTRY_FILE, "utf-8"));
    for (const agent of data) {
      if (AGENT_CONFIGS[agent.agent_name]) {
        AGENT_CONFIGS[agent.agent_name].namespace = agent.namespace || "default";
        AGENT_CONFIGS[agent.agent_name].role = agent.role || "worker";
        AGENT_CONFIGS[agent.agent_name].maxEscPerMin = agent.max_escalations_per_min || 5;
        if (agent.work_dir) AGENT_CONFIGS[agent.agent_name].cwd = agent.work_dir;
        if (agent.claude_bin) AGENT_CONFIGS[agent.agent_name].bin = agent.claude_bin;
      }
    }
    log(`Registry geladen: ${data.length} Agents aus ${NAMESPACE_REGISTRY_FILE}`);
  } catch {
    log("Registry nicht gefunden — verwende Fallback-Config");
  }
}

const SIG_TYPES: Record<number, string> = {
  0x01: "STATE_CHANGED", 0x02: "NEED_INPUT",  0x03: "TASK_DONE",
  0x04: "BLOCKED",       0x05: "ERROR",        0x06: "HEARTBEAT",
  0xFF: "ESCALATE",
};

// ── Locks & State ──────────────────────────────────────────────────────────

const connectedAgents      = new Map<string, Socket>();
const heartbeats           = new Map<string, number>();
const runningAgents        = new Set<string>();      // Claude-Prozess läuft
const processedEscalations = new Map<string, number>(); // id → timestamp (TTL 24h)

// TTL-Cleanup alle 30 Minuten — verhindert unbegrenztes Wachsen
setInterval(() => {
  const cutoff = Date.now() - 24 * 3600_000;
  for (const [id, ts] of processedEscalations) {
    if (ts < cutoff) processedEscalations.delete(id);
  }
}, 30 * 60_000);
const HEARTBEAT_TTL        = 90_000;

// ── Graceful Degradation ────────────────────────────────────────────────
const healthChecker = createHealthChecker(process.env.ANTHROPIC_API_KEY || "");
const degradation   = createDegradationManager();
const dlq           = createDeadLetterQueue();

// ── Circuit Breaker ───────────────────────────────────────────────────────
// Nach 3 consecutive Failures → Agent 30min suspendieren + Alert
const CIRCUIT_BREAKER_THRESHOLD = 3;
const CIRCUIT_BREAKER_COOLDOWN  = 30 * 60_000; // 30 Minuten
const failureCounters = new Map<string, number>();    // agent → consecutive failures
const suspendedAgents = new Map<string, number>();    // agent → suspended_until timestamp

function recordAgentResult(agent: string, success: boolean): void {
  if (success) {
    const prev = failureCounters.get(agent) || 0;
    if (prev > 0) log(`CIRCUIT-BREAKER: ${agent} recovered (${prev} failures reset)`);
    failureCounters.set(agent, 0);
    return;
  }
  // Interne Agents (in AGENT_CONFIGS definiert) werden nie vom Circuit Breaker suspendiert
  if (AGENT_CONFIGS[agent]) {
    log(`CIRCUIT-BREAKER: ${agent} failure (internal agent — no suspension)`);
    return;
  }
  const count = (failureCounters.get(agent) || 0) + 1;
  failureCounters.set(agent, count);
  log(`CIRCUIT-BREAKER: ${agent} failure ${count}/${CIRCUIT_BREAKER_THRESHOLD}`);

  if (count >= CIRCUIT_BREAKER_THRESHOLD) {
    const until = Date.now() + CIRCUIT_BREAKER_COOLDOWN;
    suspendedAgents.set(agent, until);
    failureCounters.set(agent, 0);
    log(`CIRCUIT-BREAKER: ${agent} SUSPENDED until ${new Date(until).toISOString()}`);
    sendTelegramAlert("critical", `CIRCUIT BREAKER: Agent *${agent}* nach ${count} Failures fuer 30min suspendiert.`);
  }
}

function isAgentSuspended(agent: string): boolean {
  // Interne Agents (in AGENT_CONFIGS definiert) werden nie suspendiert
  if (AGENT_CONFIGS[agent]) return false;

  const until = suspendedAgents.get(agent);
  if (!until) return false;
  if (Date.now() >= until) {
    suspendedAgents.delete(agent);
    log(`CIRCUIT-BREAKER: ${agent} cooldown abgelaufen — wieder aktiv`);
    return false;
  }
  return true;
}

// ── Notification Hierarchy ───────────────────────────────────────────────
// Critical → Telegram sofort, Warning → gesammelt, Info → nur Log
type NotifyLevel = "critical" | "warning" | "info";
const pendingWarnings: string[] = [];

async function sendTelegramAlert(level: NotifyLevel, message: string): Promise<void> {
  if (level === "info") { log(`[INFO] ${message}`); return; }
  if (level === "warning") { pendingWarnings.push(message); log(`[WARNING] ${message}`); return; }

  // Critical → sofort senden
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_USER_ID;
  if (!token || !chatId) { log(`[CRITICAL-NO-TG] ${message}`); return; }

  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: `🔴 ${message}`, parse_mode: "Markdown" }),
      signal: AbortSignal.timeout(10_000),
    });
    log(`[CRITICAL-SENT] ${message}`);
  } catch (e) { log(`[CRITICAL-FAIL] ${message} — ${e}`); }
}

// Warning-Digest alle 2 Stunden (wenn welche da sind)
setInterval(async () => {
  if (pendingWarnings.length === 0) return;
  const digest = pendingWarnings.splice(0).join("\n");
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_USER_ID;
  if (!token || !chatId) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: `🟡 *Warning Digest*\n\n${digest}`, parse_mode: "Markdown" }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {}
}, 2 * 3600_000);

// ── Rate-Limiting ─────────────────────────────────────────────────────────
// Max N Escalations pro Agent-Paar pro Minute → verhindert Escalation-Floods
const RATE_LIMIT_WINDOW = 60_000;  // 1 Minute
const RATE_LIMIT_MAX    = 30;
const escalationRates   = new Map<string, number[]>(); // "from→to" → timestamps[]

function isRateLimited(from: string, to: string): boolean {
  // Orchestrator wird nie gedrosselt
  if (AGENT_CONFIGS[from]?.role === "orchestrator") return false;

  const key = `${from}→${to}`;
  const now = Date.now();
  const timestamps = escalationRates.get(key) || [];
  // Alte Einträge entfernen
  const recent = timestamps.filter(t => now - t < RATE_LIMIT_WINDOW);
  escalationRates.set(key, recent);
  const limit = AGENT_CONFIGS[to]?.maxEscPerMin ?? 30;
  if (recent.length >= limit) return true;
  recent.push(now);
  return false;
}

// Rate-Limit Cleanup alle 5 Minuten
setInterval(() => {
  const now = Date.now();
  for (const [key, timestamps] of escalationRates) {
    const recent = timestamps.filter(t => now - t < RATE_LIMIT_WINDOW);
    if (recent.length === 0) escalationRates.delete(key);
    else escalationRates.set(key, recent);
  }
}, 5 * 60_000);

// ── Logging ───────────────────────────────────────────────────────────────

function log(msg: string) {
  const ts   = new Date().toISOString().slice(0, 19);
  const line = `[${ts}] ${msg}`;
  console.log(line);
  try { appendFileSync(LOG_FILE, line + "\n"); } catch {}
}

// ── Signal-Handling ────────────────────────────────────────────────────────

interface Signal { from: number; to: number; type: number; priority: number; ref: number; raw: Buffer; }

function parseSignal(buf: Buffer): Signal | null {
  if (buf.length < 8) return null;
  return { from: buf[0], to: buf[1], type: buf[2], priority: buf[3],
           ref: buf.readUInt32LE(4), raw: buf.slice(0, 8) };
}

function buildSignal(from: number, to: number, type: number, priority: number, ref: number): Buffer {
  const buf = Buffer.alloc(8);
  buf[0] = from; buf[1] = to; buf[2] = type; buf[3] = priority;
  buf.writeUInt32LE(ref, 4);
  return buf;
}

function logSignal(sig: Signal, action: string) {
  const from = AGENT_NAMES[sig.from] ?? `#${sig.from}`;
  const to   = AGENT_NAMES[sig.to]   ?? `#${sig.to}`;
  const type = SIG_TYPES[sig.type]   ?? `0x${sig.type.toString(16)}`;
  log(`SIG ${from}→${to} [${type}] pri=${sig.priority} — ${action}`);
}

// ── Watchlist ─────────────────────────────────────────────────────────────

function loadWatchers(): Record<string, { watches: string[]; ignores: string[] }> {
  try { return JSON.parse(readFileSync(`${BUS}/watchers.json`, "utf-8")); } catch { return {}; }
}

function matchGlob(pattern: string, path: string): boolean {
  const re = new RegExp("^" + pattern.replace(/\./g, "\\.").replace(/\*/g, "[^.]*") + "$");
  return re.test(path);
}

// ── Socket-Notifications ───────────────────────────────────────────────────

function notifyAgent(agentName: string, signal: Signal): void {
  const socket = connectedAgents.get(agentName);
  if (!socket || socket.destroyed) return;
  try { socket.write(signal.raw); } catch { connectedAgents.delete(agentName); }
}

function broadcastExcept(fromId: number, signal: Signal): void {
  for (const [name] of connectedAgents) {
    if (AGENT_IDS[name] !== fromId) notifyAgent(name, signal);
  }
}

// ── Routing ───────────────────────────────────────────────────────────────

function route(signal: Signal): void {
  logSignal(signal, "routing");

  if (signal.type === 0x06) {
    const name = AGENT_NAMES[signal.from];
    if (name) { heartbeats.set(name, Date.now()); log(`HEARTBEAT ${name} — alive`); }
    return;
  }

  if (signal.type === 0xFF) {
    // Escalation: wird über File Watcher verarbeitet (escalation-write schreibt JSON)
    // Hier nur Socket-Notification an Ziel
    const toName = AGENT_NAMES[signal.to] ?? "lev";
    notifyAgent(toName, signal);
    if (toName !== "lev") notifyAgent("lev", signal);
    return;
  }

  if (signal.to === 255) broadcastExcept(signal.from, signal);
  else { const n = AGENT_NAMES[signal.to]; if (n) notifyAgent(n, signal); }
}

// ── Autonomes Agent-Waking ─────────────────────────────────────────────────

function sanitizePromptField(value: unknown, maxLen = 500): string {
  return String(value ?? "").replace(/[\r\n]+/g, " ").slice(0, maxLen);
}

function buildPrompt(esc: any): string {
  const evidence = (esc.evidence || []).map((e: string) => `  · ${sanitizePromptField(e)}`).join("\n") || "  · (keine Evidence)";

  // Peer-Policy laden für allowed_routes
  let peerRoutesSection = "";
  try {
    const policyRaw = readFileSync(`${BUS}/peer-policy.json`, "utf-8");
    const policy = JSON.parse(policyRaw);
    const agentName = sanitizePromptField(esc.to, 64);
    const allowedTargets: string[] = policy.allowed_routes?.[agentName] ?? [];
    if (allowedTargets.length > 0) {
      // Chain für Weitergabe aufbauen
      const currentChain: string[] = Array.isArray(esc.chain) ? [...esc.chain] : [];
      if (!currentChain.includes(agentName)) currentChain.push(agentName);
      const chainJson = JSON.stringify(currentChain);
      const routeLines = allowedTargets.map((target: string) =>
        `  bun /srv/agentbus/escalation-write.ts ${agentName} ${target} <type> "<subject>" <need> <budget> --chain '${chainJson}'`
      ).join("\n");
      peerRoutesSection = `\nPeer-Escalations (falls nötig — du darfst eskalieren an: ${allowedTargets.join(", ")}):\n${routeLines}\n  type: conflict|question|decision|blocker|info|task | need: resolution|answer|approval|acknowledgment\n  WICHTIG: --chain muss weitergegeben werden. Cycle- und Depth-Limits werden automatisch geprüft.\n`;
    }
  } catch { /* peer-policy nicht verfügbar — kein Problem */ }

  // Chain-Info für Kontext
  const chainInfo = Array.isArray(esc.chain) && esc.chain.length > 0
    ? `\nEscalation-Chain: [${esc.chain.join(" → ")}] → ${sanitizePromptField(esc.to, 64)} (depth=${esc.chain_depth ?? esc.chain.length})`
    : "";

  return `THALAMUS — Autonomer Aufruf. Kein Mensch aktiv. Handle selbständig.

Escalation von "${sanitizePromptField(esc.from, 64)}":
  Typ:    ${sanitizePromptField(esc.type, 64)}
  Thema:  "${sanitizePromptField(esc.subject, 200)}"
  Bedarf: ${sanitizePromptField(esc.need, 200)}
  Budget: max ${sanitizePromptField(esc.context_budget, 20)} Tokens für deine Antwort
  ID:     ${sanitizePromptField(esc.id, 64)}${chainInfo}

Evidence (aktueller State der beteiligten Agents):
${evidence}
${peerRoutesSection}
Deine Aufgabe — exakt diese 2 Befehle ausführen:
1. bun /srv/agentbus/escalation-read.ts ${sanitizePromptField(esc.to, 64)} --resolve ${sanitizePromptField(esc.id, 64)} "<deine präzise antwort>"
2. bun /srv/agentbus/state-write.ts ${sanitizePromptField(esc.to, 64)} idle

Keine langen Erklärungen. Direkt handeln.`;
}

async function wakeAgent(escalationFile: string): Promise<void> {
  let esc: any;
  try { esc = JSON.parse(readFileSync(escalationFile, "utf-8")); }
  catch { log(`WAKE: Datei nicht lesbar: ${escalationFile}`); return; }

  if (esc.status !== "pending") return;
  if (processedEscalations.has(esc.id)) return;

  // ── ICE Signatur-Check ─────────────────────────────────────────────────
  const sigResult = verifyEscalationSignature(esc);
  if (sigResult === "invalid") {
    log(`ICE: HMAC-Mismatch in Escalation ${esc.id} (${esc.from}→${esc.to}) — rejected`);
    iceResponse("white", {
      escalationFile,
      escalationId: esc.id,
      from: esc.from,
      to: esc.to,
      subject: esc.subject,
      reason: "HMAC-Signatur ungültig — mögliche Manipulation",
    });
    return;
  } else if (sigResult === "missing") {
    log(`ICE WARN: Escalation ${esc.id} (${esc.from}→${esc.to}) hat keine Signatur — Übergangsphase, wird akzeptiert`);
    // Übergangsphase: nur Warning, nicht blockieren
  }
  // ── Ende ICE Signatur-Check ────────────────────────────────────────────

  // Degradation-Guard: Bei API-Ausfall → DLQ statt Agent wecken
  if (degradation.tier !== "FULL") {
    log(`DLQ: ${esc.to} [${esc.id}] — System ${degradation.tier}, Escalation gepuffert`);
    dlq.enqueue(escalationFile, `System degraded: ${degradation.tier}`);
    degradation.recordDlqSize(dlq.size());
    return;
  }

  // Namespace-Check: Cross-Namespace-Routing über Orchestrator
  if (!canDirectRoute(esc.from, esc.to)) {
    const orchestrator = findOrchestrator(getNamespace(esc.from));
    if (orchestrator && orchestrator !== esc.to) {
      log(`NAMESPACE: ${esc.from}(${getNamespace(esc.from)})→${esc.to}(${getNamespace(esc.to)}) — Route via ${orchestrator}`);
      esc.routed_via = orchestrator;
      esc.original_to = esc.to;
      esc.to = orchestrator;
      try { writeFileSync(escalationFile, JSON.stringify(esc, null, 2)); } catch {}
    }
  }

  // Rate-Limiting: max per Agent-Config oder global default
  // Retries (esc._retry_count > 0) sind KEINE neuen Escalations — Rate-Limit-Check überspringen
  const agentLimit = AGENT_CONFIGS[esc.to]?.maxEscPerMin ?? RATE_LIMIT_MAX;
  if ((esc as any)._retry_count > 0) {
    log(`RATE-LIMIT-SKIP: ${esc.from}→${esc.to} ist Retry #${(esc as any)._retry_count} — Rate-Limit-Check übersprungen`);
  } else if (isRateLimited(esc.from, esc.to)) {
    log(`RATE-LIMITED: ${esc.from}→${esc.to} überschreitet ${agentLimit}/min — Escalation ${esc.id} auf queued gesetzt`);
    try {
      esc.status = "queued";
      (esc as any).queued_reason = `Rate limit exceeded: ${agentLimit} escalations/min from ${esc.from} to ${esc.to}`;
      writeFileSync(escalationFile, JSON.stringify(esc, null, 2));
    } catch {}
    return;
  }

  // trace_id: Escalation-Ketten tracken (End-to-End Debugging)
  if (!esc.trace_id) {
    esc.trace_id = `trace_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    try { writeFileSync(escalationFile, JSON.stringify(esc, null, 2)); } catch {}
  }

  const target = esc.to;
  const config = AGENT_CONFIGS[target];
  if (!config) { log(`WAKE: Unbekannter Agent: ${target}`); return; }

  // Circuit Breaker: suspendierte Agents nicht wecken
  if (isAgentSuspended(target)) {
    log(`WAKE: ${target} ist SUSPENDED (Circuit Breaker) — Escalation ${esc.id} [${esc.trace_id}] abgelehnt`);
    try {
      esc.status = "suspended";
      esc.suspend_reason = `Agent ${target} suspended by circuit breaker`;
      writeFileSync(escalationFile, JSON.stringify(esc, null, 2));
    } catch {}
    sendTelegramAlert("warning", `Escalation ${esc.id.slice(0,8)} abgelehnt: ${target} ist suspendiert`);
    return;
  }

  if (runningAgents.has(target)) {
    (esc as any)._retry_count = ((esc as any)._retry_count ?? 0) + 1;
    if ((esc as any)._retry_count > 20) {
      // Nach 20 Retries (~5min) → auf 'queued' setzen, kein Endlos-Retry
      log(`WAKE: ${target} — Escalation ${esc.id} nach ${(esc as any)._retry_count} Retries auf 'queued' gesetzt`);
      try {
        esc.status = "queued";
        (esc as any).queued_reason = `Agent ${target} busy after ${(esc as any)._retry_count} retries`;
        writeFileSync(escalationFile, JSON.stringify(esc, null, 2));
      } catch {}
      return;
    }
    log(`WAKE: ${target} läuft bereits — Escalation ${esc.id} zurückgestellt (Retry ${(esc as any)._retry_count}/20 in 15s)`);
    try { writeFileSync(escalationFile, JSON.stringify(esc, null, 2)); } catch {}
    setTimeout(() => { if (existsSync(escalationFile)) wakeAgent(escalationFile); }, 15_000);
    return;
  }

  // Loop-Guard: Wenn der Absender gerade läuft (z.B. nestdev eskaliert zu lev, lev läuft gerade)
  // → würde Deadlock oder Loop erzeugen — queuen statt sofort wecken
  // AUSNAHME: Orchestrator (lev) darf delegieren während er selbst läuft — das ist sein Job
  const fromConfig = AGENT_CONFIGS[esc.from];
  if (runningAgents.has(esc.from) && fromConfig?.role !== "orchestrator") {
    log(`WAKE LOOP-GUARD: ${esc.to} will ${esc.from} wecken, aber ${esc.from} läuft bereits — Escalation ${esc.id} zurückgestellt`);
    // Nicht als processed markieren — nach 10s erneut prüfen
    setTimeout(() => { if (existsSync(escalationFile)) wakeAgent(escalationFile); }, 10_000);
    return;
  }

  processedEscalations.set(esc.id, Date.now());
  runningAgents.add(target);

  log(`WAKE ▶ ${target} | ${esc.type}: "${esc.subject}" [${esc.id}]`);

  // State auf working setzen
  try {
    const sw = spawn("bun", ["/srv/agentbus/state-write.ts", target, "working", `Escalation ${esc.id.slice(0,8)}: ${esc.subject}`]);
    await new Promise(r => sw.on("close", r));
  } catch {}

  const prompt = buildPrompt(esc);

  await new Promise<void>((resolve) => {
    // Prompt in Temp-Datei (vermeidet Shell-Quoting-Probleme mit multiline Prompts)
    const promptFile = `/tmp/thalamus_${esc.id}.txt`;
    writeFileSync(promptFile, prompt, "utf-8");
    chmodSync(promptFile, 0o644);

    // Shell-Wrapper-Script (wird als Ziel-User ausgeführt)
    const wrapperFile = `/tmp/thalamus_wake_${esc.id}.sh`;
    writeFileSync(wrapperFile,
      `#!/bin/bash\ncd '${config.cwd}'\nexec '${config.bin}' --print --dangerously-skip-permissions "$(cat '${promptFile}')"\n`,
      "utf-8"
    );
    chmodSync(wrapperFile, 0o755);

    // Lev = root → kein su nötig; Patricia/NESTDEV → su
    const [spawnBin, spawnArgs]: [string, string[]] = config.uid === 0
      ? ["bash", [wrapperFile]]
      : ["su", ["-s", "/bin/bash", target, "-c", wrapperFile]];

    const proc = spawn(spawnBin, spawnArgs, {
      env:   { PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin", HOME: config.home, ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? "" },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
    proc.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });

    const agentTimeout = config.timeoutMs || 180_000;
    const timeout = setTimeout(() => {
      log(`WAKE: Timeout ${target} [${esc.id}] nach ${agentTimeout/1000}s — kill`);
      proc.kill("SIGTERM");
    }, agentTimeout);

    proc.on("close", (code) => {
      clearTimeout(timeout);
      runningAgents.delete(target);

      // Queue-Flush: 3s nach Agent-Ende alle 'queued' Escalations an target → 'pending' zurücksetzen (max 3)
      setTimeout(() => {
        try {
          const files = readdirSync(ESC_DIR).filter(f => f.endsWith(".json"));
          let flushed = 0;
          for (const f of files) {
            if (flushed >= 3) break;
            const fp = join(ESC_DIR, f);
            try {
              const e = JSON.parse(readFileSync(fp, "utf-8"));
              if (e.status === "queued" && e.to === target) {
                e.status = "pending";
                delete e._retry_count;
                delete e.queued_reason;
                writeFileSync(fp, JSON.stringify(e, null, 2));
                log(`QUEUE-FLUSH: ${e.id} → pending (${target} wieder frei)`);
                flushed++;
              }
            } catch {}
          }
          if (flushed > 0) log(`QUEUE-FLUSH: ${flushed} Escalation(s) an ${target} reaktiviert`);
        } catch {}
      }, 3_000);

      // Temp-Dateien aufräumen
      try { unlinkSync(promptFile); } catch {}
      try { unlinkSync(wrapperFile); } catch {}

      if (code === 0) {
        log(`WAKE ✓ ${target} [${esc.id}] trace=${esc.trace_id} — fertig (exit 0)`);
        recordAgentResult(target, true);
      } else {
        log(`WAKE ✗ ${target} [${esc.id}] trace=${esc.trace_id} — exit ${code}`);
        if (stderr) log(`WAKE stderr: ${stderr.slice(0, 200)}`);
        recordAgentResult(target, false);
        sendTelegramAlert("warning", `Agent ${target} exit ${code} bei Escalation ${esc.id.slice(0,8)}`);

        // API-Fehler in stderr → sofortigen Health-Check triggern
        if (stderr && /529|503|overloaded|rate.limit|server.error/i.test(stderr)) {
          log(`WAKE: API-Error detected in stderr → triggering health check`);
          healthChecker.check();
        }
      }

      // Fallback: State auf idle wenn Agent es vergessen hat
      setTimeout(async () => {
        try {
          const s = JSON.parse(readFileSync(`${BUS}/state/${target}/status.json`, "utf-8"));
          if (s.status === "working") {
            const sw = spawn("bun", ["/srv/agentbus/state-write.ts", target, "idle"]);
            await new Promise(r => sw.on("close", r));
            log(`WAKE fallback: ${target} → idle`);
          }
        } catch {}
      }, 5_000);

      // STATE_CHANGED an Absender schicken (Resolution verfügbar)
      const fromId = AGENT_IDS[esc.from];
      const toId   = config.id;
      if (fromId !== undefined) {
        const sig: Signal = {
          from: toId, to: fromId, type: 0x03, priority: 1,
          ref: toId, raw: buildSignal(toId, fromId, 0x03, 1, toId),
        };
        notifyAgent(esc.from, sig);
        log(`WAKE: TASK_DONE Signal → ${esc.from}`);
      }

      resolve();
    });

    proc.on("error", (e) => {
      clearTimeout(timeout);
      runningAgents.delete(target);
      log(`WAKE: Spawn-Fehler ${target}: ${e.message}`);
      resolve();
    });
  });
}

// ── File Watcher — Escalation-Verzeichnis ─────────────────────────────────

watch(ESC_DIR, (event, filename) => {
  if (!filename || !filename.endsWith(".json")) return;
  const filepath = join(ESC_DIR, filename);
  // 500ms warten damit der Write sicher abgeschlossen ist
  setTimeout(() => {
    if (existsSync(filepath)) wakeAgent(filepath);
  }, 500);
});

// Fallback-Scanner: fs.watch kann unter Last inotify-Events verlieren.
// Alle 15s ESC_DIR nach unverarbeiteten pending Escalations scannen.
setInterval(() => {
  try {
    const files = readdirSync(ESC_DIR).filter(f => f.endsWith(".json"));
    for (const f of files) {
      const filepath = join(ESC_DIR, f);
      try {
        const esc = JSON.parse(readFileSync(filepath, "utf-8"));
        if (esc.status === "pending" && !processedEscalations.has(esc.id)) {
          log(`WATCHER-FALLBACK: Verpasste Escalation aufgeholt: ${f}`);
          wakeAgent(filepath);
        } else if (esc.status === "queued" && !runningAgents.has(esc.to)) {
          // Queued Escalation und Agent ist frei → reaktivieren
          log(`WATCHER-FALLBACK: Queued Escalation reaktiviert (${esc.to} frei): ${f}`);
          esc.status = "pending";
          delete esc._retry_count;
          delete esc.queued_reason;
          writeFileSync(filepath, JSON.stringify(esc, null, 2));
          wakeAgent(filepath);
        }
      } catch {}
    }
  } catch {}
}, 15_000);

// ── File Watcher — State-Änderungen ───────────────────────────────────────

watch(`${BUS}/state`, { recursive: true }, (event, filename) => {
  if (!filename || !filename.endsWith("status.json") || filename.includes(".tmp")) return;
  const agentName = filename.split("/")[0];
  const agentId   = AGENT_IDS[agentName];
  if (agentId === undefined) return;

  const sig: Signal = {
    from: agentId, to: 255, type: 0x01, priority: 1,
    ref: agentId * 1000 + (Date.now() % 1000),
    raw: buildSignal(agentId, 255, 0x01, 1, agentId * 1000),
  };
  logSignal(sig, `file-watch (${filename})`);
  broadcastExcept(agentId, sig);
});

// ── Unix Domain Socket ─────────────────────────────────────────────────────

if (existsSync(SOCKET_PATH)) { try { unlinkSync(SOCKET_PATH); } catch {} }

const server = createServer((conn) => {
  let agentName: string | null = null;

  conn.on("data", (buf) => {
    if (buf[0] === 0xAA && buf.length >= 9) {
      const id = buf[1];
      agentName = AGENT_NAMES[id] ?? null;
      if (agentName) { connectedAgents.set(agentName, conn); log(`CONNECTED: ${agentName}`); }
      return;
    }
    const signal = parseSignal(buf);
    if (signal) route(signal);
  });

  conn.on("close", () => { if (agentName) { connectedAgents.delete(agentName); log(`DISC: ${agentName}`); } });
  conn.on("error", () => {});
});

server.listen(SOCKET_PATH, () => log(`Thalamus V3 — Socket: ${SOCKET_PATH}`));

// ── Heartbeat Monitor ─────────────────────────────────────────────────────

setInterval(() => {
  const now = Date.now();
  for (const [name, last] of heartbeats) {
    if (now - last > HEARTBEAT_TTL) {
      log(`⚠️  DEAD: ${name} — ${Math.round((now-last)/1000)}s kein Heartbeat`);
      heartbeats.delete(name);
      const id = AGENT_IDS[name];
      if (id !== undefined) notifyAgent("lev", { from: id, to: 0, type: 0x05, priority: 3, ref: id, raw: buildSignal(id, 0, 0x05, 3, id) });
    }
  }
}, 30_000);

// ── Status Dump (alle 5 Min) ───────────────────────────────────────────────

setInterval(() => {
  try {
    writeFileSync(`${BUS}/signals/thalamus-status.json`, JSON.stringify({
      version: 3,
      updated_at: new Date().toISOString(),
      connected:  Array.from(connectedAgents.keys()),
      running:    Array.from(runningAgents),
      processed_escalations: processedEscalations.size,
      rate_limits: Object.fromEntries(Array.from(escalationRates.entries()).map(([k, v]) => [k, v.length])),
      heartbeats: Object.fromEntries(Array.from(heartbeats.entries()).map(([k, v]) => [k, new Date(v).toISOString()])),
      circuit_breaker: {
        failures: Object.fromEntries(Array.from(failureCounters.entries()).filter(([, v]) => v > 0)),
        suspended: Object.fromEntries(Array.from(suspendedAgents.entries()).map(([k, v]) => [k, new Date(v).toISOString()])),
      },
      pending_warnings: pendingWarnings.length,
      namespaces: Object.fromEntries(Object.entries(AGENT_CONFIGS).map(([name, cfg]) => [name, { namespace: cfg.namespace, role: cfg.role }])),
      degradation_tier: degradation.tier,
      dlq_size: dlq.size(),
      health_last_status: healthChecker.lastStatus,
    }, null, 2));
  } catch {}
}, 300_000);

// ── Startup: Unverarbeitete Escalations aufholen ───────────────────────────

setTimeout(async () => {
  log("Startup: Prüfe unverarbeitete Escalations...");
  try {
    const files = readdirSync(ESC_DIR).filter(f => f.endsWith(".json"));
    let pending = 0;
    for (const f of files) {
      try {
        const esc = JSON.parse(readFileSync(join(ESC_DIR, f), "utf-8"));
        if (esc.status === "pending" && !processedEscalations.has(esc.id)) {
          pending++;
          await wakeAgent(join(ESC_DIR, f));
        }
      } catch {}
    }
    log(`Startup: ${pending} unverarbeitete Escalations gefunden`);
  } catch {}
}, 3_000);

// ── Registry beim Start laden ────────────────────────────────────────────
loadRegistryFromDisk();

// ── Graceful Degradation Wiring ──────────────────────────────────────────

healthChecker.onStatusChange((status) => {
  degradation.recordHealthResult(status);
});

degradation.onTierChange(async (from, to) => {
  log(`DEGRADATION: ${from} → ${to}`);

  if (to === "DEGRADED") {
    sendTelegramAlert("critical", `⚠️ SYSTEM DEGRADED — Anthropic API nicht erreichbar. Neue Requests werden gepuffert.`);
    healthChecker.setInterval(10_000);
  } else if (to === "MANUAL") {
    sendTelegramAlert("critical", `🔴 SYSTEM MANUAL MODE — API seit >15min down. Alle Agents gestoppt. Manueller Eingriff nötig.`);
    healthChecker.setInterval(30_000);
  } else if (to === "FULL") {
    sendTelegramAlert("critical", `✅ SYSTEM RECOVERED — API wieder erreichbar. ${dlq.size()} gepufferte Requests werden replayed.`);
    healthChecker.setInterval(60_000);
    // DLQ Replay
    const replayed = await dlq.replayAll((file) => wakeAgent(file));
    if (replayed > 0) log(`DLQ REPLAY: ${replayed} Escalations verarbeitet`);
  }
});

healthChecker.start(60_000);

// DLQ Cleanup (alte Einträge archivieren) — stündlich
setInterval(() => {
  const cleaned = dlq.cleanup(24 * 3600_000);
  if (cleaned > 0) log(`DLQ CLEANUP: ${cleaned} alte Einträge archiviert`);
}, 3600_000);

log("Thalamus V3.1 — bereit. Graceful Degradation + Health-Check aktiv.");
