#!/usr/bin/env bun
/**
 * heartbeat-check.ts
 * Heartbeat-Monitor für das LevBot Schwarm-System.
 * Keine Claude-API-Calls. Keine externen Kosten.
 * Exit 0 = Aktion ausgeführt | 1 = Alles OK | 2 = Fehler
 */

import { createHash } from "crypto";
import { readFileSync, writeFileSync, existsSync, statSync, readdirSync } from "fs";
import { spawnSync } from "child_process";
import { runPatrol } from "/srv/agentbus/ice/patrol.ts";

const DRY_RUN = process.argv.includes("--dry-run");
const BUN = "/root/.bun/bin/bun";
const STATE_WRITE = "/srv/agentbus/state-write.ts";
const LAWS_FILE = "/srv/agentbus/laws.json";
const LAWS_HASH_FILE = "/srv/agentbus/state/heartbeat/last-laws-hash.txt";
const REPORT_FILE = "/srv/agentbus/state/heartbeat/last-check.json";
const ESCALATION_DIR = "/srv/agentbus/escalation";
const THALAMUS_STATUS = "/srv/agentbus/signals/thalamus-status.json";
const SIGNAL_LOG = "/srv/agentbus/signals/signal.log";
const THALAMUS_SOCK = "/srv/agentbus/signals/thalamus.sock";
const ICE_EVENTS_FILE = "/srv/agentbus/ice/events.json";

// Stuck-Schwellen in ms
const AGENT_CONFIGS: Record<string, { timeoutMs: number }> = {
  lev: { timeoutMs: 3_600_000 },      // 60min
  levbot: { timeoutMs: 28_800_000 },  // 8h
  nestdev: { timeoutMs: 57_600_000 }, // 16h
  patricia: { timeoutMs: 3_600_000 }, // 60min
};

const MAX_RECOVERY_PER_RUN = 3;

// 1. Selbst-Timeout
const selfTimeout = setTimeout(() => {
  log("ERROR: Selbst-Timeout nach 30s");
  process.exit(2);
}, 30_000);

let actionTaken = false;
const logs: string[] = [];

function log(msg: string) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  logs.push(line);
}

function sendTelegram(msg: string) {
  if (DRY_RUN) { log(`DRY-RUN TELEGRAM: ${msg}`); return; }
  spawnSync("/home/levbot/send-telegram.sh", [msg], { timeout: 10_000 });
}

// 2. laws.json Integrität
let lawsHash = "";
let lawsChanged = false;
try {
  const lawsContent = readFileSync(LAWS_FILE, "utf-8");
  lawsHash = createHash("sha256").update(lawsContent).digest("hex");
  const prevHash = existsSync(LAWS_HASH_FILE) ? readFileSync(LAWS_HASH_FILE, "utf-8").trim() : "";
  if (prevHash && prevHash !== lawsHash) {
    lawsChanged = true;
    log(`ALERT: laws.json HASH GEÄNDERT! Vorher: ${prevHash.slice(0, 8)}... Jetzt: ${lawsHash.slice(0, 8)}...`);
    sendTelegram(`HEARTBEAT ALERT: laws.json wurde verändert! Hash-Mismatch. Sofort prüfen.`);
    actionTaken = true;
  }
  if (!DRY_RUN) writeFileSync(LAWS_HASH_FILE, lawsHash);
  else log(`DRY-RUN: würde laws-hash schreiben: ${lawsHash.slice(0, 8)}...`);
} catch (e: any) {
  if (e.code === "ENOENT") {
    log(`WARNING: laws.json nicht gefunden — überspringe Hash-Check`);
  } else {
    log(`ERROR laws.json: ${e.message}`);
  }
}

// 3. Agent-States prüfen
const now = Date.now();
const agentResults: Record<string, { status: string; stuck: boolean; reset: boolean; stale: boolean; durationMs?: number }> = {};
const agentIdle: Record<string, boolean> = {};

for (const agent of Object.keys(AGENT_CONFIGS)) {
  const statusFile = `/srv/agentbus/state/${agent}/status.json`;
  let result = { status: "unknown", stuck: false, reset: false, stale: false, durationMs: undefined as number | undefined };
  try {
    const raw = JSON.parse(readFileSync(statusFile, "utf-8"));
    result.status = raw.status ?? "unknown";
    const updatedAt = raw.updated_at ? new Date(raw.updated_at).getTime() : 0;
    const durationMs = now - updatedAt;
    result.durationMs = durationMs;

    if (result.status === "working") {
      const threshold = AGENT_CONFIGS[agent].timeoutMs;
      if (durationMs > threshold) {
        result.stuck = true;
        log(`STUCK: ${agent} war ${Math.round(durationMs / 60000)}min working → reset idle`);
        if (!DRY_RUN) {
          spawnSync(BUN, [STATE_WRITE, agent, "idle", "heartbeat-reset"], { timeout: 10_000 });
          result.reset = true;
        } else {
          log(`DRY-RUN: würde ${agent} → idle resetten`);
        }
        actionTaken = true;
      }
    }

    // Stale: updated_at > 48h
    if (updatedAt && durationMs > 48 * 3600_000) {
      result.stale = true;
      log(`STALE: ${agent} seit ${Math.round(durationMs / 3600000)}h nicht aktualisiert`);
    }

    agentIdle[agent] = result.status === "idle" && !result.stuck;
  } catch (e: any) {
    log(`WARNING: State für ${agent} nicht lesbar: ${e.message}`);
    agentIdle[agent] = false;
  }
  agentResults[agent] = result;
}

// 4. Overload/Queued Recovery
const recoveries: string[] = [];
try {
  const files = readdirSync(ESCALATION_DIR).filter(f => f.endsWith(".json"));
  const cutoff = now - 48 * 3600_000;

  for (const file of files) {
    if (recoveries.length >= MAX_RECOVERY_PER_RUN) break;

    // Timestamp aus Dateiname parsen (Format: YYYY-MM-DDTHH-MM-SS-mmmZ_...)
    const tsMatch = file.match(/^(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)/);
    if (tsMatch) {
      const fileTs = new Date(tsMatch[1].replace(/-(\d{2})-(\d{2})-(\d{3})Z$/, ':$1:$2.$3Z')).getTime();
      if (!isNaN(fileTs) && fileTs < cutoff) continue;
    }

    const path = `${ESCALATION_DIR}/${file}`;
    try {
      const esc = JSON.parse(readFileSync(path, "utf-8"));
      if (esc.status !== "overload" && esc.status !== "queued") continue;

      const targetAgent = esc.to;
      if (!agentIdle[targetAgent]) continue;

      // Recovery-Loop-Schutz: max 3 Recoveries pro Escalation
      const recoveryCount = (esc._heartbeat_recovery_count ?? 0) as number;
      if (recoveryCount >= 3) {
        log(`LOOP-GUARD: ${esc.id} hat bereits ${recoveryCount} Recoveries — überspringe & Alert`);
        sendTelegram(`HEARTBEAT ALERT: Escalation ${esc.id} (${targetAgent}) nach 3 Recoveries immer noch overload/queued. Manuelle Prüfung nötig!`);
        actionTaken = true;
        continue;
      }

      log(`RECOVERY: ${esc.id} für ${targetAgent} → pending (Recovery #${recoveryCount + 1})`);
      if (!DRY_RUN) {
        esc.status = "pending";
        esc._heartbeat_recovery_count = recoveryCount + 1;
        delete esc._retry_count;
        delete esc._queued_at;
        delete esc.overload_reason;
        writeFileSync(path, JSON.stringify(esc, null, 2));
      } else {
        log(`DRY-RUN: würde ${esc.id} auf pending setzen (Recovery #${recoveryCount + 1})`);
      }
      recoveries.push(esc.id ?? file);
      actionTaken = true;
    } catch (_) {}
  }
} catch (e: any) {
  log(`WARNING: Escalation-Recovery fehlgeschlagen: ${e.message}`);
}

// 5. Thalamus Health
let thalamusInfo = { tier: "unknown", dlq_size: -1, socket_exists: false };
try {
  const ts = JSON.parse(readFileSync(THALAMUS_STATUS, "utf-8"));
  thalamusInfo.tier = ts.degradation_tier ?? "unknown";
  thalamusInfo.dlq_size = ts.dlq_size ?? 0;
  thalamusInfo.socket_exists = existsSync(THALAMUS_SOCK);

  if (thalamusInfo.tier !== "FULL") {
    log(`ALERT: Thalamus degradation_tier = ${thalamusInfo.tier} (nicht FULL)`);
    sendTelegram(`HEARTBEAT: Thalamus nicht FULL — Tier: ${thalamusInfo.tier}. Prüfen!`);
    actionTaken = true;
  }
  if (thalamusInfo.dlq_size > 0) {
    log(`WARNING: Thalamus DLQ size = ${thalamusInfo.dlq_size}`);
  }
  if (!thalamusInfo.socket_exists) {
    log(`ALERT: Thalamus Socket fehlt! ${THALAMUS_SOCK}`);
    sendTelegram(`HEARTBEAT: Thalamus Socket fehlt — ${THALAMUS_SOCK}`);
    actionTaken = true;
  }
} catch (e: any) {
  log(`WARNING: Thalamus-Status nicht lesbar: ${e.message}`);
}

// 6. Signal-Log Größe
let signalLogMb = 0;
try {
  const stat = statSync(SIGNAL_LOG);
  signalLogMb = stat.size / (1024 * 1024);
  if (signalLogMb > 10) {
    log(`WARNING: signal.log > 10MB (${signalLogMb.toFixed(1)}MB)`);
  }
} catch (_) {}

// 7. Memory-Sprite aufrufen
const MEMORY_SPRITE = "/srv/agentbus/sprites/memory-sprite.ts";
try {
  const spriteArgs = DRY_RUN ? [MEMORY_SPRITE, "--dry-run"] : [MEMORY_SPRITE];
  const spriteResult = spawnSync(BUN, spriteArgs, { timeout: 15_000 });
  const spriteOut = spriteResult.stdout?.toString().trim() ?? "";
  const spriteExit = spriteResult.status ?? -1;
  if (spriteOut) log(`SPRITE memory: ${spriteOut.split("\n").join(" | ")}`);
  if (spriteExit === 0) {
    log("SPRITE: SESSION_SNAPSHOT.md geschrieben");
    actionTaken = true;
  } else if (spriteExit === 1) {
    log("SPRITE: SESSION_SNAPSHOT.md aktuell — kein Update");
  } else {
    log(`WARNING: memory-sprite exit=${spriteExit}`);
  }
} catch (e: any) {
  log(`WARNING: memory-sprite fehlgeschlagen: ${e.message}`);
}

// 8. ICE Patrol
try {
  const patrolResult = runPatrol();
  if (patrolResult.anomalies.length > 0) {
    for (const a of patrolResult.anomalies) log(`ICE PATROL: ${a}`);
    actionTaken = true;
  }
  if (patrolResult.alerts.length > 0) {
    for (const a of patrolResult.alerts) log(`ICE ALERT: ${a}`);
  }
  log(`ICE PATROL DONE: ${patrolResult.contentScanned} Escalations gescannt, ${patrolResult.anomalies.length} Anomalien, blocked=${patrolResult.blocked}`);
} catch (e: any) {
  log(`WARNING: ICE Patrol fehlgeschlagen: ${e.message}`);
}

// 9. ICE Events lesen
let iceEvents: any[] = [];
try {
  if (existsSync(ICE_EVENTS_FILE)) {
    iceEvents = JSON.parse(readFileSync(ICE_EVENTS_FILE, "utf-8"));
  }
} catch (e: any) {
  log(`WARNING: ice/events.json nicht lesbar: ${e.message}`);
}

// 10. Report schreiben
const exitCode = actionTaken ? 0 : 1;
const report = {
  timestamp: new Date().toISOString(),
  dry_run: DRY_RUN,
  laws_hash: lawsHash,
  laws_changed: lawsChanged,
  agents: agentResults,
  recoveries,
  thalamus: thalamusInfo,
  signal_log_mb: Math.round(signalLogMb * 100) / 100,
  ice_events: iceEvents,
  exit_code: exitCode,
};

try {
  if (!DRY_RUN) writeFileSync(REPORT_FILE, JSON.stringify(report, null, 2));
  else log(`DRY-RUN: würde Report schreiben nach ${REPORT_FILE}`);
} catch (e: any) {
  log(`ERROR: Report schreiben fehlgeschlagen: ${e.message}`);
}

log(`DONE: exit=${exitCode} | actions=${actionTaken} | recoveries=${recoveries.length} | dry_run=${DRY_RUN}`);
clearTimeout(selfTimeout);
process.exit(exitCode);
