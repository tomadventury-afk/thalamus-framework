#!/usr/bin/env bun
/**
 * ICE — Intrusion Countermeasures Electronics
 * ice/response.ts — 4-Stufen ICE-Response-System (Shadowrun-Stil)
 *
 * Stufen:
 *   patrol — Passive Überwachung, Log-Eintrag
 *   white   — Aktive Warnung, Telegram-Alert, Escalation blockiert
 *   grey    — Escalation als rejected markiert, Agent temporär gesperrt
 *   black   — Sofort-Alert an Tom, Agent suspendiert, Lev eskaliert
 */

import { writeFileSync, existsSync, readFileSync } from "fs";
import { spawnSync } from "child_process";

export type IceLevel = "patrol" | "white" | "grey" | "black";

const ICE_LOG = "/srv/agentbus/ice/ice.log";
const ICE_EVENTS = "/srv/agentbus/ice/events.json";
const TELEGRAM = "/home/levbot/send-telegram.sh";
const MAX_EVENTS = 1000;

function appendIceEvent(level: IceLevel, id: string, from: string, to: string, reason: string) {
  try {
    let events: any[] = [];
    if (existsSync(ICE_EVENTS)) {
      try { events = JSON.parse(readFileSync(ICE_EVENTS, "utf-8")); } catch {}
    }
    events.push({
      timestamp: new Date().toISOString(),
      level,
      escalation_id: id,
      from,
      to,
      reason,
      resolved: false,
    });
    if (events.length > MAX_EVENTS) events = events.slice(events.length - MAX_EVENTS);
    writeFileSync(ICE_EVENTS, JSON.stringify(events, null, 2));
  } catch {}
}

function log(msg: string) {
  const line = `[${new Date().toISOString()}] ICE ${msg}\n`;
  process.stderr.write(line);
  try {
    writeFileSync(ICE_LOG, line, { flag: "a" });
  } catch {}
}

function sendTelegram(msg: string) {
  try {
    spawnSync(TELEGRAM, [msg], { timeout: 10_000 });
  } catch {}
}

export interface IceContext {
  escalationFile?: string;
  escalationId?: string;
  from?: string;
  to?: string;
  subject?: string;
  reason: string;
}

/**
 * iceResponse — Führt ICE-Gegenmassnahme aus
 * @param level  ICE-Stufe: patrol | white | grey | black
 * @param ctx    Kontext der Escalation
 * @returns      true wenn Escalation blockiert werden soll
 */
export function iceResponse(level: IceLevel, ctx: IceContext): boolean {
  const id = ctx.escalationId ?? "unknown";
  const from = ctx.from ?? "?";
  const to = ctx.to ?? "?";
  const reason = ctx.reason;

  switch (level) {
    case "patrol":
      log(`PATROL | ${from}→${to} [${id}] — ${reason}`);
      appendIceEvent(level, id, from, to, reason);
      return false;

    case "white":
      log(`WHITE  | ${from}→${to} [${id}] — ${reason} — WARNING gesendet`);
      appendIceEvent(level, id, from, to, reason);
      sendTelegram(`ICE WHITE: Signatur-Warnung ${from}→${to} [${id.slice(0,8)}] — ${reason}`);
      if (ctx.escalationFile && existsSync(ctx.escalationFile)) {
        try {
          const esc = JSON.parse(readFileSync(ctx.escalationFile, "utf-8"));
          esc.status = "rejected";
          esc.ice_level = "white";
          esc.ice_reason = reason;
          esc.ice_at = new Date().toISOString();
          writeFileSync(ctx.escalationFile, JSON.stringify(esc, null, 2));
        } catch (e: any) {
          log(`WHITE: File-Update fehlgeschlagen: ${e.message}`);
        }
      }
      return true;

    case "grey":
      log(`GREY   | ${from}→${to} [${id}] — ${reason} — Agent temporär gesperrt`);
      appendIceEvent(level, id, from, to, reason);
      sendTelegram(`ICE GREY: Signatur-Fehler ${from}→${to} [${id.slice(0,8)}] — ${reason}. Agent ${from} temporär gesperrt.`);
      if (ctx.escalationFile && existsSync(ctx.escalationFile)) {
        try {
          const esc = JSON.parse(readFileSync(ctx.escalationFile, "utf-8"));
          esc.status = "rejected";
          esc.ice_level = "grey";
          esc.ice_reason = reason;
          esc.ice_at = new Date().toISOString();
          writeFileSync(ctx.escalationFile, JSON.stringify(esc, null, 2));
        } catch {}
      }
      return true;

    case "black":
      log(`BLACK  | ${from}→${to} [${id}] — ${reason} — KRITISCH, Sofort-Alert`);
      appendIceEvent(level, id, from, to, reason);
      sendTelegram(
        `🚨 ICE BLACK: KRITISCHER EINGRIFF ${from}→${to} [${id.slice(0,8)}]\n` +
        `Grund: ${reason}\n` +
        `Agent ${from} sofort suspendiert. Lev informiert.`
      );
      if (ctx.escalationFile && existsSync(ctx.escalationFile)) {
        try {
          const esc = JSON.parse(readFileSync(ctx.escalationFile, "utf-8"));
          esc.status = "rejected";
          esc.ice_level = "black";
          esc.ice_reason = reason;
          esc.ice_at = new Date().toISOString();
          writeFileSync(ctx.escalationFile, JSON.stringify(esc, null, 2));
        } catch {}
      }
      return true;

    default:
      log(`UNKNOWN level: ${level} — fallback patrol`);
      return false;
  }
}
