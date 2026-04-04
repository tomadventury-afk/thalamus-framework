#!/usr/bin/env bun
/**
 * memory-sprite.ts
 * Phase 5 — Sprite-Infrastruktur
 *
 * Prüft ob SESSION_SNAPSHOT.md existiert und aktuell ist (<2h).
 * Wenn veraltet oder fehlend: schreibt neuen Snapshot.
 * Wird von heartbeat-check.ts aufgerufen.
 *
 * Exit 0 = Snapshot geschrieben | 1 = Snapshot aktuell | 2 = Fehler
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from "fs";

const DRY_RUN = process.argv.includes("--dry-run");
const SNAPSHOT_PATH = "/root/.claude/projects/-root/memory/active/SESSION_SNAPSHOT.md";
const SNAPSHOT_DIR = "/root/.claude/projects/-root/memory/active";
const TASK_CONTRACT_PATH = "/root/shared-brain/TASK_CONTRACT.md";
const ESCALATION_DIR = "/srv/agentbus/escalation";
const MAX_AGE_MS = 2 * 60 * 60 * 1000; // 2 Stunden

function log(msg: string) {
  console.log(`[memory-sprite] ${msg}`);
}

// Prüfe ob Snapshot existiert und aktuell ist
let needsUpdate = true;

if (existsSync(SNAPSHOT_PATH)) {
  try {
    const stat = statSync(SNAPSHOT_PATH);
    const ageMs = Date.now() - stat.mtimeMs;
    if (ageMs < MAX_AGE_MS) {
      const ageMins = Math.round(ageMs / 60000);
      log(`Snapshot aktuell (${ageMins}min alt) — kein Update nötig`);
      needsUpdate = false;
    } else {
      const ageH = (ageMs / 3600000).toFixed(1);
      log(`Snapshot veraltet (${ageH}h alt) — Update nötig`);
    }
  } catch (e: any) {
    log(`WARNING: Snapshot stat fehlgeschlagen: ${e.message} — schreibe neu`);
  }
} else {
  log("Snapshot fehlt — erstelle neu");
}

if (!needsUpdate) {
  process.exit(1);
}

// Aktuelle Arbeit aus TASK_CONTRACT.md lesen
let currentWork = "Nicht verfügbar (TASK_CONTRACT.md fehlt)";
try {
  if (existsSync(TASK_CONTRACT_PATH)) {
    const content = readFileSync(TASK_CONTRACT_PATH, "utf-8");
    // Erste nicht-leere Zeile nach einem Header als Zusammenfassung
    const lines = content.split("\n").filter(l => l.trim() && !l.startsWith("#"));
    if (lines.length > 0) {
      currentWork = lines.slice(0, 3).join(" | ").slice(0, 200);
    }
  }
} catch (e: any) {
  log(`WARNING: TASK_CONTRACT.md nicht lesbar: ${e.message}`);
}

// Offene Fäden aus Escalation-Status lesen
const openThreads: string[] = [];
try {
  if (existsSync(ESCALATION_DIR)) {
    const files = readdirSync(ESCALATION_DIR).filter(f => f.endsWith(".json"));
    for (const file of files) {
      try {
        const esc = JSON.parse(readFileSync(`${ESCALATION_DIR}/${file}`, "utf-8"));
        if (esc.status === "pending" || esc.status === "queued" || esc.status === "overload") {
          const id = esc.id ?? file.replace(".json", "").slice(-8);
          const to = esc.to ?? "unknown";
          const topic = (esc.topic ?? esc.subject ?? "—").slice(0, 80);
          openThreads.push(`- ESC-${id.slice(0, 8)} → ${to}: ${topic} [${esc.status}]`);
        }
      } catch (_) {}
    }
  }
} catch (e: any) {
  log(`WARNING: Escalation-Scan fehlgeschlagen: ${e.message}`);
}

// Letzten Heartbeat-Report lesen für nächsten Schritt
let nextStep = "Heartbeat-Zyklus abwarten";
try {
  const reportPath = "/srv/agentbus/state/heartbeat/last-check.json";
  if (existsSync(reportPath)) {
    const report = JSON.parse(readFileSync(reportPath, "utf-8"));
    const stuckAgents = Object.entries(report.agents ?? {})
      .filter(([, v]: [string, any]) => v.stuck)
      .map(([k]) => k);
    if (stuckAgents.length > 0) {
      nextStep = `Stuck-Agents prüfen: ${stuckAgents.join(", ")}`;
    } else if ((report.recoveries ?? []).length > 0) {
      nextStep = `Escalation-Recoveries verfolgen: ${report.recoveries.join(", ")}`;
    }
  }
} catch (_) {}

// Snapshot generieren
const timestamp = new Date().toISOString();
const snapshot = `# SESSION_SNAPSHOT
> Generiert von memory-sprite.ts | ${timestamp}
> Automatisch — nicht manuell bearbeiten

## Timestamp
${timestamp}

## Woran arbeite ich
${currentWork}

## Offene Fäden (Escalation-Status)
${openThreads.length > 0 ? openThreads.join("\n") : "Keine offenen Escalations"}

## Nächster Schritt
${nextStep}
`;

if (DRY_RUN) {
  log("DRY-RUN: würde Snapshot schreiben nach " + SNAPSHOT_PATH);
  log("--- SNAPSHOT INHALT ---");
  console.log(snapshot);
  log("--- ENDE ---");
  process.exit(0);
}

// Verzeichnis erstellen falls nötig
try {
  if (!existsSync(SNAPSHOT_DIR)) {
    mkdirSync(SNAPSHOT_DIR, { recursive: true });
    log(`Verzeichnis erstellt: ${SNAPSHOT_DIR}`);
  }
} catch (e: any) {
  log(`ERROR: Verzeichnis erstellen fehlgeschlagen: ${e.message}`);
  process.exit(2);
}

// Snapshot schreiben
try {
  writeFileSync(SNAPSHOT_PATH, snapshot, "utf-8");
  log(`Snapshot geschrieben: ${SNAPSHOT_PATH}`);
  process.exit(0);
} catch (e: any) {
  log(`ERROR: Snapshot schreiben fehlgeschlagen: ${e.message}`);
  process.exit(2);
}
