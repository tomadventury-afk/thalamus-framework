/**
 * Moltbook API Client
 * Agent: levless26
 * API-Key: /srv/agentbus/secrets/moltbook.key
 */

import { readFileSync } from "fs";
import { filterOutbound } from "./outbound-filter.ts";

const BASE_URL = "https://www.moltbook.com/api/v1";

function getApiKey(): string {
  const key = readFileSync("/srv/agentbus/secrets/moltbook.key", "utf-8").trim();
  return key;
}

async function apiRequest(
  method: string,
  path: string,
  body?: Record<string, unknown>
): Promise<unknown> {
  const apiKey = getApiKey();
  const url = `${BASE_URL}${path}`;

  const headers: Record<string, string> = {
    "Authorization": `Bearer ${apiKey}`,
    "Content-Type": "application/json",
    "Accept": "application/json",
  };

  const options: RequestInit = {
    method,
    headers,
  };

  if (body) {
    options.body = JSON.stringify(body);
  }

  const response = await fetch(url, options);
  const text = await response.text();

  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }

  if (!response.ok) {
    throw new Error(`Moltbook API ${method} ${path} → ${response.status}: ${text}`);
  }

  return data;
}

/** Erstellt einen neuen Post */
export async function post(title: string, content: string, submolt: string): Promise<unknown> {
  const filteredTitle = filterOutbound(title);
  const filteredContent = filterOutbound(content);
  if (!filteredTitle || !filteredContent) {
    throw new Error("[client] Post blockiert durch outbound-filter");
  }
  return apiRequest("POST", "/posts", { title: filteredTitle, content: filteredContent, submolt });
}

/** Löst eine Verification Challenge */
export async function verify(code: string, answer: string): Promise<unknown> {
  return apiRequest("POST", "/verify", { code, answer });
}

/** Kommentiert einen Post */
export async function comment(postId: string, content: string): Promise<unknown> {
  const filtered = filterOutbound(content);
  if (!filtered) throw new Error("[client] Kommentar blockiert durch outbound-filter");
  return apiRequest("POST", `/posts/${postId}/comments`, { content: filtered });
}

/** Votet für einen Post */
export async function vote(postId: string, direction: "up" | "down"): Promise<unknown> {
  return apiRequest("POST", `/posts/${postId}/vote`, { direction });
}

/** Sucht Posts */
export async function search(query: string): Promise<unknown> {
  const encoded = encodeURIComponent(query);
  return apiRequest("GET", `/search?q=${encoded}`);
}

/** Holt den Home-Feed */
export async function getHome(): Promise<unknown> {
  return apiRequest("GET", "/home");
}

/** Holt den Account-Status */
export async function getStatus(): Promise<unknown> {
  return apiRequest("GET", "/status");
}
