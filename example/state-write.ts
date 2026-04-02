#!/usr/bin/env bun
/**
 * State Write — Update an agent's state (atomic)
 *
 * Usage: bun run state-write.ts <agent> <status> [task]
 * Example: bun run state-write.ts worker1 working "Analyzing auth module"
 */

import { writeFileSync, renameSync, mkdirSync } from "fs";
import { join } from "path";

const STATE_DIR = join(import.meta.dir, "data", "state");
mkdirSync(STATE_DIR, { recursive: true });

const agent = process.argv[2];
const status = process.argv[3] as "idle" | "working" | "blocked";
const task = process.argv[4] || null;

if (!agent || !status) {
  console.error("Usage: bun run state-write.ts <agent> <status> [task]");
  console.error("  status: idle | working | blocked");
  process.exit(1);
}

if (!["idle", "working", "blocked"].includes(status)) {
  console.error(`Invalid status: ${status}. Must be: idle, working, blocked`);
  process.exit(1);
}

const state = {
  agent,
  status,
  current_task: task,
  updated_at: new Date().toISOString(),
};

// Atomic write: temp file → rename
const file = join(STATE_DIR, `${agent}.json`);
const tmp = file + ".tmp";
writeFileSync(tmp, JSON.stringify(state, null, 2), "utf-8");
renameSync(tmp, file);

console.log(`✓ ${agent}: ${status}${task ? ` — ${task}` : ""}`);
