#!/usr/bin/env bun
/**
 * Moltbook Feed Reader
 * Cron: SLASH15 7-22 * * * /root/.bun/bin/bun /srv/agentbus/moltbook/feed-reader.ts
 *
 * - GET /api/v1/home alle 15min
 * - Neue Posts erkennen und relevante in swarm_knowledge speichern
 * - Service-Anfragen via service-handler.ts prüfen
 * - 1-2 gute Posts upvoten (max 5 Interaktionen/Stunde)
 * - Alles durch outbound-filter.ts
 */

import { readFileSync, writeFileSync } from "fs";
import { spawnSync } from "child_process";
import { getHome, vote } from "./client.ts";
import { checkServiceRequest } from "./service-handler.ts";

const TELEGRAM_SCRIPT = "/home/levbot/send-telegram.sh";
const LEV_HANDLE = "levless26";

// Geldthemen die sofort-alert auslösen
const MONEY_KEYWORDS = [
  "pay", "paid", "hire", "price", "pricing", "cost", "rate", "quote",
  "invoice", "budget", "how much", "charge", "contract", "freelance",
  "bezahlen", "preis", "kosten", "angebot", "honorar",
];

function sendTelegramAlert(msg: string): void {
  const result = spawnSync(TELEGRAM_SCRIPT, [msg], { timeout: 10000 });
  if (result.status !== 0) {
    console.error(`[feed-reader] Telegram-Alert fehlgeschlagen: ${result.stderr?.toString()}`);
  } else {
    console.log(`[feed-reader] Telegram-Alert gesendet`);
  }
}

function hasMentionOfLev(text: string): boolean {
  return text.toLowerCase().includes(LEV_HANDLE.toLowerCase());
}

function hasMoneyKeyword(text: string): boolean {
  const lower = text.toLowerCase();
  return MONEY_KEYWORDS.some(kw => lower.includes(kw));
}

function isDMPost(post: Post): boolean {
  return (
    String(post.type ?? "").toLowerCase().includes("dm") ||
    String(post.type ?? "").toLowerCase().includes("direct") ||
    String(post.type ?? "").toLowerCase().includes("message") ||
    String((post as any).is_dm ?? "").toLowerCase() === "true" ||
    (post as any).is_dm === true
  );
}

const STATE_FILE = "/srv/agentbus/state/levbot/moltbook-state.json";
const ENV_PATH = "/home/levbot/.brain.env";
const BUN_PATH = "/root/.bun/bin/bun";
const MAX_INTERACTIONS_PER_HOUR = 5;
const MAX_SEEN_IDS = 500;

// ── Types ──────────────────────────────────────────────────────────────────

interface Post {
  id: string;
  title?: string;
  content?: string;
  body?: string;
  score?: number;
  upvotes?: number;
  vote_count?: number;
  replies?: number;
  comments?: number;
  submolt?: string;
  created_at?: string;
  type?: string;
  author?: string;
  username?: string;
}

interface MoltbookState {
  seenPostIds: string[];
  interactions: Array<{ ts: number }>;
}

// ── State ──────────────────────────────────────────────────────────────────

function loadState(): MoltbookState {
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf-8")) as MoltbookState;
  } catch {
    return { seenPostIds: [], interactions: [] };
  }
}

function saveState(state: MoltbookState): void {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function countRecentInteractions(state: MoltbookState): number {
  const oneHourAgo = Date.now() - 60 * 60 * 1000;
  return state.interactions.filter(i => i.ts > oneHourAgo).length;
}

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

// ── Knowledge Write ────────────────────────────────────────────────────────

function saveKnowledge(title: string, content: string, tags: string): void {
  const brainEnv = loadEnv();
  const childEnv = {
    ...process.env,
    SUPABASE_URL: brainEnv.SUPABASE_URL || "https://jfypocxjggmahasrrixp.supabase.co",
    SUPABASE_ANON_KEY: brainEnv.SUPABASE_ANON_KEY || "",
    SUPABASE_SERVICE_KEY: brainEnv.SUPABASE_SERVICE_KEY || brainEnv.SUPABASE_ANON_KEY || "",
  };

  const result = spawnSync(
    BUN_PATH,
    [
      "/srv/agentbus/knowledge-write.ts",
      "levbot",
      "finding",
      title.slice(0, 200),
      content.slice(0, 800),
      "--tags",
      tags,
    ],
    { env: childEnv, timeout: 15000 }
  );

  if (result.status !== 0) {
    console.error(`[feed-reader] knowledge-write fehlgeschlagen: ${result.stderr?.toString()}`);
  } else {
    console.log(`[feed-reader] Knowledge gespeichert: "${title.slice(0, 60)}"`);
  }
}

// ── Relevanz-Check ─────────────────────────────────────────────────────────

const RELEVANT_KEYWORDS = [
  "ai", "llm", "claude", "gpt", "openai", "anthropic",
  "agent", "automation", "software", "code", "develop",
  "startup", "saas", "api", "tech", "engineering",
  "ki ", "künstliche intelligenz", "programmier",
  "machine learning", "neural", "model", "inference",
];

function isRelevantPost(post: Post): boolean {
  const text = `${post.title || ""} ${post.content || post.body || ""}`.toLowerCase();
  return RELEVANT_KEYWORDS.some(kw => text.includes(kw));
}

function getPostScore(post: Post): number {
  return post.score ?? post.upvotes ?? post.vote_count ?? 0;
}

function isGoodPost(post: Post): boolean {
  return getPostScore(post) >= 2 || (post.replies ?? post.comments ?? 0) >= 1;
}

// ── Main ───────────────────────────────────────────────────────────────────

(async () => {
  console.log(`[feed-reader] Start: ${new Date().toISOString()}`);

  const state = loadState();

  // Alte Interaktionen bereinigen (>2h)
  state.interactions = state.interactions.filter(
    i => i.ts > Date.now() - 2 * 60 * 60 * 1000
  );

  let interactionCount = countRecentInteractions(state);
  console.log(`[feed-reader] Interaktionen letzte Stunde: ${interactionCount}/${MAX_INTERACTIONS_PER_HOUR}`);

  // Feed holen
  let feedData: unknown;
  try {
    feedData = await getHome();
  } catch (err) {
    console.error("[feed-reader] getHome fehlgeschlagen:", err);
    process.exit(1);
  }

  // Posts extrahieren (flexible API response)
  const raw = feedData as Record<string, unknown>;
  const posts: Post[] = (
    Array.isArray(raw) ? (raw as Post[]) :
    Array.isArray(raw.posts) ? (raw.posts as Post[]) :
    Array.isArray(raw.data) ? (raw.data as Post[]) :
    Array.isArray(raw.items) ? (raw.items as Post[]) :
    []
  );

  console.log(`[feed-reader] ${posts.length} Posts im Feed`);

  // Neue Posts erkennen
  const newPosts = posts.filter(p => p.id && !state.seenPostIds.includes(String(p.id)));
  console.log(`[feed-reader] ${newPosts.length} neue Posts`);

  for (const post of newPosts) {
    // Sofort-Alerts prüfen
    const postText = `${post.title || ""} ${post.content || post.body || ""}`;
    const postId = String(post.id);
    const postShort = (post.title || postId).slice(0, 80);
    const author = String(post.author ?? post.username ?? "unbekannt");

    if (isDMPost(post)) {
      const alertMsg =
        `MOLTBOOK DM-ALERT\n` +
        `Von: ${author}\n` +
        `Inhalt: ${postText.slice(0, 120)}`;
      sendTelegramAlert(alertMsg);
      console.log(`[feed-reader] DM-Alert gesendet (Post: ${postId})`);
    } else if (hasMentionOfLev(postText)) {
      const alertMsg =
        `MOLTBOOK MENTION-ALERT\n` +
        `${LEV_HANDLE} erwaehnt von: ${author}\n` +
        `"${postShort}"`;
      sendTelegramAlert(alertMsg);
      console.log(`[feed-reader] Mention-Alert gesendet (Post: ${postId})`);
    } else if (hasMoneyKeyword(postText)) {
      const alertMsg =
        `MOLTBOOK GELD-ALERT\n` +
        `Bezahl-Intent erkannt\n` +
        `"${postShort}"`;
      sendTelegramAlert(alertMsg);
      console.log(`[feed-reader] Geld-Alert gesendet (Post: ${postId})`);
    }

    // Relevante Posts in swarm_knowledge speichern
    if (isRelevantPost(post)) {
      const title = (post.title || postId).slice(0, 150);
      const body = (post.content || post.body || "").slice(0, 400);
      const content =
        `[Moltbook/${post.submolt || "feed"}] Score: ${getPostScore(post)} | ${body}`;
      saveKnowledge(title, content, "moltbook,finding");
    }

    // Service-Anfragen prüfen
    await checkServiceRequest(post as Record<string, unknown>);

    // Als gesehen markieren
    state.seenPostIds.push(postId);
  }

  // seenPostIds auf MAX_SEEN_IDS beschränken
  if (state.seenPostIds.length > MAX_SEEN_IDS) {
    state.seenPostIds = state.seenPostIds.slice(-MAX_SEEN_IDS);
  }

  // 1-2 gute Posts upvoten (rate-limited)
  if (interactionCount < MAX_INTERACTIONS_PER_HOUR) {
    const goodPosts = posts
      .filter(p => p.id && isGoodPost(p))
      .sort((a, b) => getPostScore(b) - getPostScore(a))
      .slice(0, 2);

    let votesThisRun = 0;

    for (const post of goodPosts) {
      if (interactionCount >= MAX_INTERACTIONS_PER_HOUR || votesThisRun >= 2) break;
      try {
        await vote(String(post.id), "up");
        state.interactions.push({ ts: Date.now() });
        interactionCount++;
        votesThisRun++;
        console.log(`[feed-reader] Upvote: ${post.id} (Score: ${getPostScore(post)})`);
      } catch (err) {
        console.error(`[feed-reader] Vote fehlgeschlagen (${post.id}):`, err);
      }
    }
  } else {
    console.log("[feed-reader] Rate-Limit erreicht, kein Upvote diese Runde");
  }

  saveState(state);
  console.log(
    `[feed-reader] Fertig. Neue Posts: ${newPosts.length}, ` +
    `Interaktionen/Std: ${interactionCount}`
  );
})();
