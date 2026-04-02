#!/usr/bin/env bun
/**
 * Escalation — Send a work item from one agent to another
 *
 * Usage: bun run escalation.ts <from> <to> <subject>
 * Example: bun run escalation.ts boss worker1 "Analyze the auth module and propose improvements"
 *
 * The Thalamus daemon (thalamus-mini.ts) watches for new escalations
 * and automatically wakes the target agent.
 */

import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { randomBytes } from "crypto";

const ESCALATION_DIR = join(import.meta.dir, "data", "escalations");
mkdirSync(ESCALATION_DIR, { recursive: true });

const from = process.argv[2];
const to = process.argv[3];
const subject = process.argv.slice(4).join(" ");

if (!from || !to || !subject) {
  console.error("Usage: bun run escalation.ts <from> <to> <subject>");
  console.error('Example: bun run escalation.ts boss worker1 "Analyze the auth module"');
  process.exit(1);
}

const id = randomBytes(4).toString("hex");
const now = new Date().toISOString();

const escalation = {
  id,
  from,
  to,
  subject,
  status: "pending",
  created_at: now,
};

const filename = `${now.replace(/[:.]/g, "-")}_${from}-to-${to}_${id}.json`;
writeFileSync(
  join(ESCALATION_DIR, filename),
  JSON.stringify(escalation, null, 2),
  "utf-8"
);

console.log(`✓ Escalation ${id}: ${from} → ${to}`);
console.log(`  Subject: "${subject}"`);
console.log(`  File: ${filename}`);
console.log();
console.log("The Thalamus daemon will wake the target agent automatically.");
