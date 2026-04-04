#!/usr/bin/env bun
/**
 * Moltbook Service Handler
 * Erkennt Service-Anfragen (code review, security audit, architecture)
 * und speichert sie in swarm_knowledge via knowledge-write.ts.
 */

import { readFileSync } from "fs";
import { spawnSync } from "child_process";

const TELEGRAM_SCRIPT = "/home/levbot/send-telegram.sh";

function sendTelegramAlert(msg: string): void {
  const result = spawnSync(TELEGRAM_SCRIPT, [msg], { timeout: 10000 });
  if (result.status !== 0) {
    console.error(`[service-handler] Telegram fehlgeschlagen: ${result.stderr?.toString()}`);
  } else {
    console.log(`[service-handler] Telegram-Alert gesendet`);
  }
}

const BUN_PATH = "/root/.bun/bin/bun";
const ENV_PATH = "/home/levbot/.brain.env";

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

// Bezahlte Service-Anfragen → Sofort-Alert
const PAID_SERVICE_KEYWORDS = [
  "pay", "paid", "hire", "hired", "freelance", "freelancer", "price", "pricing",
  "cost", "costs", "rate", "quote", "invoice", "budget", "how much", "charge",
  "contract", "consulting", "retainer",
  "bezahlen", "preis", "kosten", "angebot", "auftrag", "honorar",
];

const SERVICE_KEYWORDS: Record<string, string[]> = {
  "code_review": [
    "code review", "review my code", "check my code", "code feedback",
    "pull request", "pr review", "review this", "look at my code",
  ],
  "security_audit": [
    "security audit", "security review", "penetration test", "pentest",
    "vulnerability", "security check", "hack", "exploit", "secure my",
  ],
  "architecture": [
    "architecture", "system design", "microservices", "tech stack",
    "how to structure", "database design", "api design", "scalability",
    "best practices for", "design pattern",
  ],
};

function isPaidServiceRequest(text: string): boolean {
  const lower = text.toLowerCase();
  return PAID_SERVICE_KEYWORDS.some(kw => lower.includes(kw));
}

function detectServiceType(text: string): string | null {
  const lower = text.toLowerCase();
  for (const [serviceType, keywords] of Object.entries(SERVICE_KEYWORDS)) {
    if (keywords.some(kw => lower.includes(kw))) {
      return serviceType;
    }
  }
  return null;
}

export async function checkServiceRequest(post: Record<string, unknown>): Promise<void> {
  const title = String(post.title || "");
  const content = String(post.content || post.body || "");
  const combined = `${title} ${content}`;

  const serviceType = detectServiceType(combined);
  const isPaid = isPaidServiceRequest(combined);

  if (!serviceType && !isPaid) return;

  const postId = String(post.id || "?");
  const postTitle = title.slice(0, 100) || postId;
  const effectiveType = serviceType ?? "paid_inquiry";
  const knowledgeContent =
    `Service-Anfrage auf Moltbook erkannt: ${effectiveType}${isPaid ? " [BEZAHLT]" : ""} | ` +
    `Post-ID: ${postId} | Titel: "${postTitle}"`;

  // Sofort-Alert bei bezahlter Anfrage oder expliziter Service-Nachfrage
  if (isPaid || serviceType) {
    const alertMsg =
      `MOLTBOOK SERVICE-ALERT\n` +
      `Typ: ${effectiveType}${isPaid ? " (Bezahl-Intent)" : ""}\n` +
      `Post ${postId}: ${postTitle.slice(0, 80)}`;
    sendTelegramAlert(alertMsg);
  }

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
      `Moltbook Service-Request: ${serviceType}`,
      knowledgeContent,
      "--tags",
      `moltbook,service-request,${serviceType}`,
    ],
    { env: childEnv, timeout: 15000 }
  );

  if (result.status !== 0) {
    console.error(
      `[service-handler] knowledge-write fehlgeschlagen: ${result.stderr?.toString()}`
    );
  } else {
    console.log(`[service-handler] Service-Request gespeichert: ${serviceType} (Post: ${postId})`);
  }
}

// CLI-Modus: direkt aufrufen für Tests
if (import.meta.main) {
  const testPost = {
    id: "test-123",
    title: process.argv[2] || "Can someone do a code review of my auth service?",
    content: process.argv[3] || "",
  };
  console.log("[service-handler] Test-Post:", testPost.title);
  await checkServiceRequest(testPost);
}
