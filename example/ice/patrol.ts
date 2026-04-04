#!/usr/bin/env bun
/**
 * ICE Patrol — Content-Scanner & Anomalie-Detektion
 * Wird von heartbeat-check.ts eingebunden.
 *
 * Checks:
 *   1. Content-Scan: gefährliche Payloads in Escalations (rm -rf, chmod 777, etc.)
 *   2. Frequenz-Anomalie: zu viele Escalations in kurzer Zeit
 *   3. Flip-Flop: Agent wechselt schnell zwischen working/idle (Zeichen für Loop)
 */

import { readFileSync, readdirSync, existsSync, writeFileSync } from "fs";
import { join } from "path";
import { iceResponse } from "./response.ts";

const ESC_DIR     = "/srv/agentbus/escalation";
const STATE_DIR   = "/srv/agentbus/state";
const PATROL_STATE = "/srv/agentbus/ice/patrol-state.json";

// Gefährliche Muster in Escalation-Subjects / Content
const DANGEROUS_PATTERNS: Array<{ pattern: RegExp; level: "white" | "grey" | "black"; label: string }> = [
  { pattern: /rm\s+-rf?\s*[\/~]/, level: "black", label: "rm -rf /" },
  { pattern: /chmod\s+777\s+\//, level: "grey", label: "chmod 777 /" },
  { pattern: /:\(\)\{.*\};/, level: "black", label: "Fork-Bomb" },
  { pattern: /dd\s+if=\/dev\/(zero|random)\s+of=\/dev\//, level: "black", label: "DD Disk-Wipe" },
  { pattern: />\s*\/etc\/passwd/, level: "black", label: "passwd-Überschreiben" },
  { pattern: /curl\s+.*\|\s*(bash|sh|bun|node)/, level: "grey", label: "Remote-Code-Execution via curl" },
  { pattern: /wget\s+.*\|\s*(bash|sh|bun|node)/, level: "grey", label: "Remote-Code-Execution via wget" },
  { pattern: /base64\s+--decode.*\|\s*(bash|sh)/, level: "grey", label: "Base64 Shell-Injection" },
  { pattern: /eval\s*\(.*atob\s*\(/, level: "grey", label: "eval(atob()) Obfuscation" },
  { pattern: /chmod\s+[0-7]*[46][0-7][0-7]\s+\/usr\/bin/, level: "grey", label: "SUID-Bit auf System-Binary" },
  { pattern: /\/etc\/cron\.d\/|crontab\s+-[er]/, level: "white", label: "Cron-Modifikation" },
  { pattern: /systemctl\s+(stop|disable|mask)\s+(ssh|sshd|thalamus|pm2)/, level: "grey", label: "Kritischen Dienst deaktivieren" },
  { pattern: /iptables\s+-F|ufw\s+disable/, level: "grey", label: "Firewall deaktivieren" },
];

// Frequenz-Schwellen (Escalations pro Agent in letzten N Sekunden)
const FREQ_WINDOW_MS  = 60_000; // 1 Minute
const FREQ_THRESHOLD  = 8;      // mehr als 8 Escalations/min von einem Agent → Anomalie

// Flip-Flop: Agent wechselt mehr als N mal in M Sekunden
const FLIPFLOP_COUNT   = 5;
const FLIPFLOP_WINDOW  = 120_000; // 2 Minuten

export interface PatrolResult {
  blocked: boolean;
  alerts: string[];
  contentScanned: number;
  anomalies: string[];
}

/**
 * runPatrol — Alle ICE-Patrol-Checks durchführen
 * @returns PatrolResult
 */
export function runPatrol(): PatrolResult {
  const result: PatrolResult = {
    blocked: false,
    alerts: [],
    contentScanned: 0,
    anomalies: [],
  };

  // ── 1. Content-Scan: aktuelle pending Escalations ──────────────────────
  try {
    const files = readdirSync(ESC_DIR).filter(f => f.endsWith(".json"));
    for (const file of files) {
      const path = join(ESC_DIR, file);
      try {
        const esc = JSON.parse(readFileSync(path, "utf-8"));
        if (esc.status === "resolved" || esc.status === "rejected") continue;

        result.contentScanned++;

        // Subject + Chain prüfen
        const scanTargets = [
          esc.subject ?? "",
          JSON.stringify(esc.evidence ?? []),
          esc.resolution ?? "",
        ].join(" ");

        for (const { pattern, level, label } of DANGEROUS_PATTERNS) {
          if (pattern.test(scanTargets)) {
            const msg = `Gefährliches Muster "${label}" in Escalation ${esc.id} (${esc.from}→${esc.to})`;
            result.anomalies.push(msg);

            const blocked = iceResponse(level, {
              escalationFile: path,
              escalationId: esc.id,
              from: esc.from,
              to: esc.to,
              reason: `PATROL: ${label} in Escalation-Content`,
            });
            if (blocked) {
              result.blocked = true;
              result.alerts.push(`[${level.toUpperCase()}] ${msg}`);
            }
            break; // Pro Escalation max. eine Reaktion
          }
        }
      } catch {}
    }
  } catch (e: any) {
    result.anomalies.push(`Content-Scan fehlgeschlagen: ${e.message}`);
  }

  // ── 2. Frequenz-Anomalie: Escalations/min pro Agent ───────────────────
  try {
    const now = Date.now();
    const files = readdirSync(ESC_DIR).filter(f => f.endsWith(".json"));
    const agentCounts: Record<string, number> = {};

    for (const file of files) {
      // Timestamp aus Dateiname parsen
      const tsMatch = file.match(/^(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)/);
      if (!tsMatch) continue;
      const ts = new Date(tsMatch[1].replace(/-(\d{2})-(\d{2})-(\d{3})Z$/, ':$1:$2.$3Z')).getTime();
      if (isNaN(ts) || now - ts > FREQ_WINDOW_MS) continue;

      // Agent aus Dateiname extrahieren (Format: ..._FROM-to-TO_ID.json)
      const agentMatch = file.match(/_([^_]+)-to-[^_]+_[^_]+\.json$/);
      if (!agentMatch) continue;
      const agent = agentMatch[1];
      agentCounts[agent] = (agentCounts[agent] ?? 0) + 1;
    }

    for (const [agent, count] of Object.entries(agentCounts)) {
      if (count >= FREQ_THRESHOLD) {
        const msg = `Frequenz-Anomalie: ${agent} hat ${count} Escalations in 60s (Schwelle: ${FREQ_THRESHOLD})`;
        result.anomalies.push(msg);
        iceResponse("white", {
          from: agent,
          reason: `PATROL: ${msg}`,
        });
        result.alerts.push(`[WHITE] ${msg}`);
      }
    }
  } catch (e: any) {
    result.anomalies.push(`Frequenz-Check fehlgeschlagen: ${e.message}`);
  }

  // ── 3. Flip-Flop-Detektion: Agent wechselt schnell working↔idle ────────
  try {
    let patrolState: Record<string, { transitions: number[]; alerted: boolean }> = {};
    if (existsSync(PATROL_STATE)) {
      try { patrolState = JSON.parse(readFileSync(PATROL_STATE, "utf-8")); } catch {}
    }

    const now = Date.now();
    const agents = ["lev", "levbot", "nestdev", "patricia"];

    for (const agent of agents) {
      const statusFile = `${STATE_DIR}/${agent}/status.json`;
      if (!existsSync(statusFile)) continue;
      try {
        const s = JSON.parse(readFileSync(statusFile, "utf-8"));
        const updatedAt = new Date(s.updated_at ?? 0).getTime();

        if (!patrolState[agent]) patrolState[agent] = { transitions: [], alerted: false };
        const st = patrolState[agent];

        // Transition-Timestamp hinzufügen wenn kürzlich geändert (<10s)
        if (now - updatedAt < 10_000) {
          st.transitions.push(now);
        }

        // Alte Timestamps bereinigen
        st.transitions = st.transitions.filter(t => now - t < FLIPFLOP_WINDOW);

        if (st.transitions.length >= FLIPFLOP_COUNT && !st.alerted) {
          const msg = `Flip-Flop: ${agent} hat ${st.transitions.length} Status-Wechsel in ${FLIPFLOP_WINDOW / 1000}s`;
          result.anomalies.push(msg);
          iceResponse("white", {
            from: agent,
            reason: `PATROL: ${msg}`,
          });
          result.alerts.push(`[WHITE] ${msg}`);
          st.alerted = true;
        }

        // Alert-Flag zurücksetzen wenn Transitions wieder unter Schwelle
        if (st.transitions.length < FLIPFLOP_COUNT) st.alerted = false;

      } catch {}
    }

    // Patrol-State speichern
    try { writeFileSync(PATROL_STATE, JSON.stringify(patrolState, null, 2)); } catch {}

  } catch (e: any) {
    result.anomalies.push(`Flip-Flop-Check fehlgeschlagen: ${e.message}`);
  }

  return result;
}

// Direkt ausführbar: bun /srv/agentbus/ice/patrol.ts
if (import.meta.main) {
  const result = runPatrol();
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.blocked ? 0 : 1);
}
