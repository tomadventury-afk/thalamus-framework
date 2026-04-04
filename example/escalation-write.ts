#!/usr/bin/env bun
/**
 * Thalamus Escalation Writer
 * Erstellt eine strukturierte Escalation und sendet Signal 0xFF an den Thalamus.
 *
 * Nutzung (interaktiv):
 *   bun /srv/agentbus/escalation-write.ts <from> <to> <type> <subject> [need] [budget] [--chain <json>]
 *
 * Nutzung (JSON direkt):
 *   bun /srv/agentbus/escalation-write.ts --json '{"from":"lev","to":"nestdev",...}'
 *
 * Typen: conflict | question | decision | blocker | info | task
 * Felder "need": resolution | answer | approval | acknowledgment
 *
 * Beispiele:
 *   bun /srv/agentbus/escalation-write.ts lev nestdev conflict \
 *     "auth.token_rotation vs session_ttl" resolution 150
 *
 *   bun /srv/agentbus/escalation-write.ts patricia lev question \
 *     "Welches Modell für Kastner-Reporting?" answer 100
 *
 *   bun /srv/agentbus/escalation-write.ts levbot nestdev task \
 *     "Deploy service" answer 200 --chain '["lev","levbot"]'
 */

import { writeFileSync, existsSync, readFileSync, readdirSync, renameSync, mkdirSync } from "fs";
import { join } from "path";
import { createConnection } from "net";
import { randomBytes, createHmac } from "crypto";

const SECRETS_DIR = "/srv/agentbus/secrets";

function signEscalation(from: string, to: string, subject: string, created_at: string): string | null {
  const keyFile = `${SECRETS_DIR}/${from}.key`;
  try {
    const secret = readFileSync(keyFile, "utf-8").trim();
    const payload = `${from}|${to}|${subject}|${created_at}`;
    return createHmac("sha256", secret).update(payload).digest("hex");
  } catch {
    console.error(`[escalation-write] WARN: Secret für ${from} nicht lesbar — Escalation wird ohne Signatur gesendet`);
    return null;
  }
}

const BUS        = "/srv/agentbus";
const SOCKET     = `${BUS}/signals/thalamus.sock`;
const ESC_DIR    = `${BUS}/escalation`;
const POLICY_FILE = `${BUS}/peer-policy.json`;
const AGENT_IDS: Record<string, number> = { lev: 0, patricia: 1, nestdev: 2, levbot: 3, all: 255 };

// ── Peer-Policy laden ─────────────────────────────────────────────────────

interface PeerPolicy {
  version: number;
  max_chain_depth: number;
  cooldown_ms: number;
  hourly_budgets: Record<string, number>;
  allowed_routes: Record<string, string[]>;
}

let policy: PeerPolicy = {
  version: 1,
  max_chain_depth: 3,
  cooldown_ms: 30000,
  hourly_budgets: { lev: 20, levbot: 10, nestdev: 5, patricia: 5 },
  allowed_routes: {
    lev: ["levbot", "nestdev", "patricia"],
    levbot: ["lev", "nestdev", "patricia"],
    nestdev: ["lev", "levbot"],
    patricia: ["lev", "levbot"],
  },
};

try {
  policy = JSON.parse(readFileSync(POLICY_FILE, "utf-8"));
} catch {
  console.error(`[escalation-write] WARN: peer-policy.json nicht lesbar — verwende Defaults`);
}

// ── Interface ─────────────────────────────────────────────────────────────

interface Escalation {
  id:             string;
  type:           "conflict" | "question" | "decision" | "blocker" | "info" | "task";
  from:           string;
  to:             string;
  subject:        string;
  evidence:       string[];
  need:           "resolution" | "answer" | "approval" | "acknowledgment";
  context_budget: number;
  status:         "pending" | "resolved";
  created_at:     string;
  resolved_at?:   string;
  resolution?:    string;
  chain?:         string[];
  chain_depth?:   number;
  signature?:     string;
}

function usage() {
  console.log(`Usage:
  bun escalation-write.ts <from> <to> <type> <subject> [need] [budget] [--chain <json>]
  bun escalation-write.ts --json '<json>'

  from/to:  lev | patricia | nestdev | levbot
  type:     conflict | question | decision | blocker | info | task
  need:     resolution | answer | approval | acknowledgment
  budget:   max tokens für Context (default: 150)
  --chain:  JSON-Array der bisherigen Chain, z.B. '["lev","levbot"]'`);
  process.exit(1);
}

// ── Args parsen ───────────────────────────────────────────────────────────

let esc: Partial<Escalation> = {};
let chainArg: string[] = [];

if (process.argv[2] === "--json") {
  try { esc = JSON.parse(process.argv[3]); }
  catch { console.error("Ungültiges JSON"); process.exit(1); }
  if (esc.chain) chainArg = esc.chain;
} else {
  // --chain Argument extrahieren
  const args = [...process.argv.slice(2)];
  const chainIdx = args.indexOf("--chain");
  if (chainIdx !== -1) {
    try { chainArg = JSON.parse(args[chainIdx + 1]); }
    catch { console.error("[escalation-write] Ungültiges --chain JSON"); process.exit(1); }
    args.splice(chainIdx, 2);
  }

  const [from, to, type, subject, need, budget] = args;
  if (!from || !to || !type || !subject) usage();
  esc = {
    from,
    to,
    type:           type as Escalation["type"],
    subject,
    need:           (need as Escalation["need"]) || "resolution",
    context_budget: parseInt(budget || "150"),
    evidence:       [],
  };
}

// ── Policy-Checks ─────────────────────────────────────────────────────────

const fromAgent = esc.from || "lev";
const toAgent   = esc.to   || "lev";

// 1. Allowed-Routes prüfen
const allowedTargets = policy.allowed_routes[fromAgent] ?? [];
if (!allowedTargets.includes(toAgent)) {
  console.error(`[escalation-write] POLICY VIOLATION: ${fromAgent} darf nicht an ${toAgent} eskalieren (allowed: ${allowedTargets.join(", ") || "keine"})`);
  process.exit(3);
}

// 2. Chain aufbauen
const chain: string[] = chainArg.length > 0 ? [...chainArg] : [];
const chain_depth = chain.length;

// 3. Cycle-Detection: wenn toAgent bereits in chain → Exit 2
if (chain.includes(toAgent)) {
  console.error(`[escalation-write] CYCLE DETECTED: ${toAgent} ist bereits in chain [${chain.join(" → ")}] — Abbruch`);
  process.exit(2);
}

// 4. Depth-Check: wenn chain_depth >= max_chain_depth → ablehnen
if (chain_depth >= policy.max_chain_depth) {
  console.error(`[escalation-write] DEPTH LIMIT: chain_depth=${chain_depth} >= max_chain_depth=${policy.max_chain_depth} — Escalation ${fromAgent}→${toAgent} abgelehnt`);
  // Summary an lev senden wenn wir nicht selbst lev sind
  if (fromAgent !== "lev") {
    try {
      const summaryEsc: Partial<Escalation> = {
        from: fromAgent,
        to: "lev",
        type: "info",
        subject: `Chain-Depth-Limit erreicht: ${fromAgent}→${toAgent} blockiert (depth=${chain_depth}/${policy.max_chain_depth})`,
        need: "acknowledgment",
        context_budget: 100,
        evidence: [`chain: [${chain.join(" → ")}]`, `attempted: ${fromAgent}→${toAgent}`],
      };
      const summaryId = randomBytes(4).toString("hex");
      const now = new Date().toISOString();
      const summaryFilename = `${ESC_DIR}/${now.replace(/[:.]/g, "-")}_${fromAgent}-to-lev_${summaryId}.json`;
      const fullSummary = { ...summaryEsc, id: summaryId, status: "pending", created_at: now };
      writeFileSync(summaryFilename, JSON.stringify(fullSummary, null, 2), "utf-8");
      console.error(`[escalation-write] Depth-Limit-Summary an lev gesendet: ${summaryId}`);
    } catch (e) {
      console.error(`[escalation-write] Summary-Schreiben fehlgeschlagen: ${e}`);
    }
  }
  process.exit(4);
}

// 5. Hourly-Budget prüfen
const hourlyBudget = policy.hourly_budgets[fromAgent] ?? 5;
try {
  const oneHourAgo = Date.now() - 3_600_000;
  const files = readdirSync(ESC_DIR).filter(f => f.endsWith(".json") && f.includes(`_${fromAgent}-to-`));
  let count = 0;
  for (const f of files) {
    try {
      const e = JSON.parse(readFileSync(join(ESC_DIR, f), "utf-8"));
      if (new Date(e.created_at).getTime() > oneHourAgo) count++;
    } catch {}
  }
  if (count >= hourlyBudget) {
    console.error(`[escalation-write] BUDGET EXCEEDED: ${fromAgent} hat ${count}/${hourlyBudget} Escalations in der letzten Stunde — abgelehnt`);
    process.exit(5);
  }
} catch { /* Budget-Check optional */ }

// 6. Cooldown prüfen
const cooldownFile = `${BUS}/state/${fromAgent}/last_escalation_at`;
try {
  if (existsSync(cooldownFile)) {
    const lastTs = parseInt(readFileSync(cooldownFile, "utf-8").trim(), 10);
    const elapsed = Date.now() - lastTs;
    if (elapsed < policy.cooldown_ms) {
      const remaining = Math.ceil((policy.cooldown_ms - elapsed) / 1000);
      console.error(`[escalation-write] COOLDOWN: ${fromAgent} muss noch ${remaining}s warten (cooldown=${policy.cooldown_ms}ms)`);
      process.exit(6);
    }
  }
} catch { /* Cooldown-Check optional */ }

// ── Evidence aus State laden ───────────────────────────────────────────────

function readEvidence(from: string, to: string): string[] {
  const evidence: string[] = [];
  for (const agent of [from, to]) {
    const stateFile = `${BUS}/state/${agent}/status.json`;
    if (!existsSync(stateFile)) continue;
    try {
      const s = JSON.parse(readFileSync(stateFile, "utf-8"));
      if (s.current_task) evidence.push(`state:${agent}.current_task="${s.current_task}"`);
      if (s.status)       evidence.push(`state:${agent}.status="${s.status}"`);
    } catch {}
  }
  return evidence;
}

// ── Escalation finalisieren ───────────────────────────────────────────────

const id = randomBytes(4).toString("hex");
const created_at = new Date().toISOString();
const escalation: Escalation = {
  id,
  type:           (esc.type || "question") as Escalation["type"],
  from:           fromAgent,
  to:             toAgent,
  subject:        esc.subject || "",
  evidence:       esc.evidence?.length ? esc.evidence : readEvidence(fromAgent, toAgent),
  need:           (esc.need || "resolution") as Escalation["need"],
  context_budget: esc.context_budget || 150,
  status:         "pending",
  created_at,
  chain:          chain,
  chain_depth:    chain_depth,
};

// HMAC-Signatur hinzufügen (ICE Phase 4)
const sig = signEscalation(fromAgent, toAgent, escalation.subject, created_at);
if (sig) {
  escalation.signature = sig;
  console.log(`[escalation-write] HMAC-Signatur gesetzt (${sig.slice(0, 8)}...)`);
}

// ── Legacy Loop-Detection (A→B→A ohne Chain) ─────────────────────────────

try {
  const existing = readdirSync(ESC_DIR).filter(f => f.endsWith(".json"));
  for (const f of existing) {
    const e = JSON.parse(readFileSync(join(ESC_DIR, f), "utf-8"));
    if (e.status === "pending" && e.from === escalation.to && e.to === escalation.from) {
      console.error(`[escalation-write] LOOP DETECTED: ${escalation.from}→${escalation.to} würde Loop mit Escalation ${e.id} (${e.from}→${e.to}) bilden`);
      process.exit(2);
    }
  }
} catch { /* Loop-Check optional — nie blockieren wenn ESC_DIR unlesbar */ }

// ── In Datei schreiben (atomar: tmp → rename) ─────────────────────────────

const filename = `${ESC_DIR}/${escalation.created_at.replace(/[:.]/g, "-")}_${escalation.from}-to-${escalation.to}_${id}.json`;
const tmpFile = `${filename}.tmp`;
writeFileSync(tmpFile, JSON.stringify(escalation, null, 2), "utf-8");
renameSync(tmpFile, filename);
console.log(`[escalation-write] ${escalation.from} → ${escalation.to} | ${escalation.type}: "${escalation.subject}"`);
console.log(`[escalation-write] ID: ${id} | Budget: ${escalation.context_budget} Tokens | Chain: [${chain.join(" → ")}] (depth=${chain_depth})`);
console.log(`[escalation-write] File: ${filename}`);

// ── Cooldown-Timestamp schreiben ──────────────────────────────────────────

try {
  const stateDir = `${BUS}/state/${fromAgent}`;
  if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true });
  writeFileSync(cooldownFile, String(Date.now()), "utf-8");
} catch { /* Non-critical */ }

// ── Signal 0xFF an Thalamus ───────────────────────────────────────────────

if (existsSync(SOCKET)) {
  try {
    const fromId = AGENT_IDS[escalation.from] ?? 0;
    const toId   = AGENT_IDS[escalation.to]   ?? 255;
    const ref    = Buffer.alloc(4);
    ref.writeUInt32LE(fromId * 100 + Date.now() % 100, 0);

    const signal = Buffer.alloc(8);
    signal[0] = fromId;
    signal[1] = toId;
    signal[2] = 0xFF;  // ESCALATE
    signal[3] = 2;     // high priority
    ref.copy(signal, 4);

    const conn = createConnection(SOCKET);
    conn.on("connect", () => { conn.write(signal); conn.end(); });
    conn.on("error", () => {});
    console.log(`[escalation-write] Signal 0xFF gesendet`);
  } catch {}
}

// ── Warnung wenn System degradiert ist ───────────────────────────────────

try {
  const status = JSON.parse(readFileSync(`${BUS}/signals/thalamus-status.json`, "utf-8"));
  if (status.degradation_tier && status.degradation_tier !== "FULL") {
    console.log(`⚠️ [escalation-write] System ist ${status.degradation_tier} — Escalation wird gepuffert, nicht sofort verarbeitet`);
  }
} catch {}
