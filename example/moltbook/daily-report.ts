#!/usr/bin/env bun
/**
 * Moltbook Daily Report
 * Cron: 0 20 * * * /root/.bun/bin/bun /srv/agentbus/moltbook/daily-report.ts >> /var/log/moltbook-daily.log 2>&1
 *
 * Sendet täglich um 20:00 UTC (22:00 CET) eine Zusammenfassung an Tom per Telegram.
 * Daten: getStatus() API + swarm_knowledge (finding, moltbook) + moltbook-state.json
 */

import { readFileSync, writeFileSync } from "fs";
import { spawnSync } from "child_process";
import { getStatus } from "./client.ts";

const STATE_FILE = "/srv/agentbus/state/levbot/moltbook-state.json";
const REPORT_STATE_FILE = "/srv/agentbus/state/levbot/moltbook-report-state.json";
const ENV_PATH = "/home/levbot/.brain.env";
const BUN_PATH = "/root/.bun/bin/bun";
const TELEGRAM_SCRIPT = "/home/levbot/send-telegram.sh";

// ── Env ────────────────────────────────────────────────────────────────────

function loadEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  try {
    for (const line of readFileSync(ENV_PATH, "utf-8").split("\n")) {
      const m = line.match(/^([^#=]+)=(.*)$/);
      if (m) env[m[1].trim()] = m[2].trim();
    }
  } catch {}
  return env;
}

// ── Report State (Snapshot vom Vortag) ─────────────────────────────────────

interface ReportState {
  date: string; // YYYY-MM-DD
  karma: number;
  followers: number;
}

function loadReportState(): ReportState {
  try {
    return JSON.parse(readFileSync(REPORT_STATE_FILE, "utf-8")) as ReportState;
  } catch {
    return { date: "", karma: 0, followers: 0 };
  }
}

function saveReportState(state: ReportState): void {
  writeFileSync(REPORT_STATE_FILE, JSON.stringify(state, null, 2));
}

// ── Moltbook State ─────────────────────────────────────────────────────────

interface MoltbookState {
  seenPostIds: string[];
  interactions: Array<{ ts: number }>;
  commentsWritten?: number;
}

function loadMoltbookState(): MoltbookState {
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf-8")) as MoltbookState;
  } catch {
    return { seenPostIds: [], interactions: [] };
  }
}

// ── swarm_knowledge abfragen ───────────────────────────────────────────────

interface KnowledgeEntry {
  title: string;
  content: string;
  tags: string[];
  created_at: string;
}

async function queryTodaysMoltbookFindings(): Promise<KnowledgeEntry[]> {
  const brainEnv = loadEnv();
  const supabaseUrl = brainEnv.SUPABASE_URL || "https://jfypocxjggmahasrrixp.supabase.co";
  const supabaseKey = brainEnv.SUPABASE_SERVICE_KEY || brainEnv.SUPABASE_ANON_KEY || "";

  if (!supabaseKey) {
    console.error("[daily-report] Kein Supabase-Key");
    return [];
  }

  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  const params = new URLSearchParams({
    category: "eq.finding",
    created_by: "eq.levbot",
    created_at: `gte.${todayStart.toISOString()}`,
    order: "created_at.desc",
    limit: "100",
  });

  try {
    const res = await fetch(
      `${supabaseUrl}/rest/v1/swarm_knowledge?${params.toString()}`,
      {
        headers: {
          Authorization: `Bearer ${supabaseKey}`,
          apikey: supabaseKey,
        },
      }
    );
    if (!res.ok) return [];
    const data = (await res.json()) as KnowledgeEntry[];
    return data.filter(e => Array.isArray(e.tags) && e.tags.includes("moltbook"));
  } catch {
    return [];
  }
}

// ── Telegram ───────────────────────────────────────────────────────────────

function sendTelegram(msg: string): void {
  const result = spawnSync(TELEGRAM_SCRIPT, [msg], { timeout: 10000 });
  if (result.status !== 0) {
    console.error("[daily-report] Telegram fehlgeschlagen:", result.stderr?.toString());
  } else {
    console.log("[daily-report] Telegram gesendet");
  }
}

// ── Main ───────────────────────────────────────────────────────────────────

(async () => {
  console.log(`[daily-report] Start: ${new Date().toISOString()}`);

  const today = new Date().toISOString().split("T")[0];
  const prevState = loadReportState();
  const moltbookState = loadMoltbookState();

  // Account-Status von Moltbook API
  let statusData: Record<string, unknown> = {};
  try {
    statusData = (await getStatus()) as Record<string, unknown>;
    console.log("[daily-report] Status:", JSON.stringify(statusData).slice(0, 300));
  } catch (err) {
    console.error("[daily-report] getStatus fehlgeschlagen:", err);
  }

  // Werte extrahieren (flexible API-Struktur)
  const user = (statusData.user ?? statusData) as Record<string, unknown>;
  const karma = Number(user.karma ?? user.score ?? user.points ?? statusData.karma ?? 0);
  const followers = Number(
    user.followers ?? user.follower_count ?? user.followers_count ??
    statusData.followers ?? statusData.follower_count ?? 0
  );
  const commentsReceived = Number(
    user.comments_received ?? user.comment_count ?? statusData.comments_received ?? 0
  );
  const upvotesOnPosts = Number(
    user.upvotes ?? user.upvote_count ?? user.post_upvotes ??
    statusData.upvotes ?? statusData.post_upvotes ?? 0
  );

  // Tagesdelta (nur wenn Snapshot vom Vortag vorhanden)
  const isFirstRun = !prevState.date || prevState.date === today;
  const karmaChange = isFirstRun ? 0 : karma - prevState.karma;
  const followerChange = isFirstRun ? 0 : followers - prevState.followers;

  // Interaktionen heute
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const upvotesToday = (moltbookState.interactions || []).filter(
    i => i.ts > todayStart.getTime()
  ).length;

  // swarm_knowledge: heutige Findings
  const allFindings = await queryTodaysMoltbookFindings();
  const serviceRequests = allFindings.filter(
    e => Array.isArray(e.tags) && e.tags.includes("service-request")
  );
  const interestingPosts = allFindings.filter(
    e => !(Array.isArray(e.tags) && e.tags.includes("service-request"))
  );

  // Report zusammenstellen
  const delta = (n: number) => (n === 0 ? "" : n > 0 ? ` (+${n})` : ` (${n})`);

  const lines: string[] = [
    `Moltbook Daily — ${today}`,
    ``,
    `Karma: ${karma}${delta(karmaChange)}`,
    `Follower: ${followers}${delta(followerChange)}`,
    `Upvotes auf Posts: ${upvotesOnPosts}`,
    `Kommentare erhalten: ${commentsReceived}`,
    `Kommentare geschrieben: ${moltbookState.commentsWritten ?? 0}`,
    `Upvotes gegeben heute: ${upvotesToday}`,
    ``,
    `Interessante Posts heute: ${interestingPosts.length}`,
    `Service-Anfragen heute: ${serviceRequests.length}`,
  ];

  if (serviceRequests.length > 0) {
    lines.push(``);
    lines.push(`Service-Anfragen:`);
    for (const sr of serviceRequests.slice(0, 3)) {
      lines.push(`  - ${sr.title.slice(0, 80)}`);
    }
  }

  if (interestingPosts.length > 0) {
    lines.push(``);
    lines.push(`Top-Posts:`);
    for (const p of interestingPosts.slice(0, 3)) {
      lines.push(`  - ${p.title.slice(0, 80)}`);
    }
  }

  const msg = lines.join("\n");
  console.log("[daily-report]\n" + msg);
  sendTelegram(msg);

  // Snapshot für morgen speichern
  saveReportState({ date: today, karma, followers });

  console.log("[daily-report] Fertig.");
})();
