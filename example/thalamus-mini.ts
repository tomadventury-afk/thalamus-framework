#!/usr/bin/env bun
/**
 * Thalamus Mini — Simplified Reference Implementation
 *
 * Demonstrates the core concepts:
 * - File-based state management (atomic writes)
 * - Escalation system (work items between agents)
 * - File watcher that detects new escalations
 * - Agent waking (spawns a process to handle work)
 *
 * This is a teaching tool, not production code.
 * The production Thalamus includes: circuit breaker, dead letter queue,
 * graceful degradation, namespace routing, rate limiting, and more.
 *
 * Usage: bun run thalamus-mini.ts
 */

import { watch } from "fs";
import {
  existsSync, mkdirSync, readFileSync, writeFileSync,
  readdirSync, renameSync,
} from "fs";
import { join } from "path";
import { spawn } from "child_process";

// --- Configuration ---
const BASE_DIR = join(import.meta.dir, "data");
const STATE_DIR = join(BASE_DIR, "state");
const ESCALATION_DIR = join(BASE_DIR, "escalations");

// --- Types ---
interface AgentState {
  agent: string;
  status: "idle" | "working" | "blocked";
  current_task: string | null;
  updated_at: string;
}

interface Escalation {
  id: string;
  from: string;
  to: string;
  subject: string;
  status: "pending" | "resolved";
  resolution?: string;
  created_at: string;
  resolved_at?: string;
}

// --- Ensure directories exist ---
for (const dir of [STATE_DIR, ESCALATION_DIR]) {
  mkdirSync(dir, { recursive: true });
}

// --- Atomic State Write ---
// Writes to a temp file first, then renames — prevents torn reads
function writeState(agent: string, state: AgentState): void {
  const file = join(STATE_DIR, `${agent}.json`);
  const tmp = file + ".tmp";
  writeFileSync(tmp, JSON.stringify(state, null, 2), "utf-8");
  renameSync(tmp, file);
  log(`STATE: ${agent} → ${state.status}${state.current_task ? ` (${state.current_task})` : ""}`);
}

function readState(agent: string): AgentState | null {
  const file = join(STATE_DIR, `${agent}.json`);
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, "utf-8"));
}

// --- Escalation System ---
function writeEscalation(esc: Escalation): string {
  const filename = `${esc.created_at.replace(/[:.]/g, "-")}_${esc.from}-to-${esc.to}_${esc.id}.json`;
  const file = join(ESCALATION_DIR, filename);
  writeFileSync(file, JSON.stringify(esc, null, 2), "utf-8");
  log(`ESCALATION: ${esc.from} → ${esc.to}: "${esc.subject}"`);
  return filename;
}

function resolveEscalation(filename: string, resolution: string): void {
  const file = join(ESCALATION_DIR, filename);
  if (!existsSync(file)) return;
  const esc: Escalation = JSON.parse(readFileSync(file, "utf-8"));
  esc.status = "resolved";
  esc.resolution = resolution;
  esc.resolved_at = new Date().toISOString();
  writeFileSync(file, JSON.stringify(esc, null, 2), "utf-8");
  log(`RESOLVED: ${esc.id} — "${resolution.slice(0, 80)}"`);
}

function getPendingEscalations(agent: string): Array<{ filename: string; esc: Escalation }> {
  return readdirSync(ESCALATION_DIR)
    .filter(f => f.endsWith(".json"))
    .map(f => ({ filename: f, esc: JSON.parse(readFileSync(join(ESCALATION_DIR, f), "utf-8")) as Escalation }))
    .filter(({ esc }) => esc.to === agent && esc.status === "pending");
}

// --- Loop Detection ---
// Prevents A → B → A circular escalations
function wouldCreateLoop(from: string, to: string): boolean {
  const pending = getPendingEscalations(from);
  return pending.some(({ esc }) => esc.from === to);
}

// --- Agent Waking ---
// Spawns a process to handle a pending escalation
function wakeAgent(filename: string, esc: Escalation): void {
  const target = esc.to;

  // Check if target is already working
  const state = readState(target);
  if (state?.status === "working") {
    log(`SKIP: ${target} is busy — retry later`);
    return;
  }

  // Set state to working
  writeState(target, {
    agent: target,
    status: "working",
    current_task: esc.subject.slice(0, 80),
    updated_at: new Date().toISOString(),
  });

  log(`WAKE: Starting ${target} for escalation ${esc.id}`);

  // Spawn the worker — in production this is `claude --print --dangerously-skip-permissions`
  // For this example, we use a simple bash script
  const proc = spawn("bash", [join(import.meta.dir, "worker-example.sh"), esc.subject], {
    env: { ...process.env, AGENT_NAME: target, ESCALATION_ID: esc.id },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  proc.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });

  // Timeout after 30 seconds
  const timeout = setTimeout(() => {
    log(`TIMEOUT: ${target} took too long — killing`);
    proc.kill("SIGTERM");
  }, 30_000);

  proc.on("close", (code) => {
    clearTimeout(timeout);

    if (code === 0) {
      log(`DONE: ${target} completed successfully`);
      resolveEscalation(filename, stdout.trim() || "Task completed");
    } else {
      log(`FAIL: ${target} exited with code ${code}`);
      resolveEscalation(filename, `Failed with exit code ${code}`);
    }

    // Reset state to idle
    writeState(target, {
      agent: target,
      status: "idle",
      current_task: null,
      updated_at: new Date().toISOString(),
    });
  });
}

// --- File Watcher ---
// Watches the escalation directory for new files
function startWatcher(): void {
  log("Watching for new escalations...");

  watch(ESCALATION_DIR, (event, filename) => {
    if (!filename?.endsWith(".json") || event !== "rename") return;

    // Small delay to ensure file is fully written
    setTimeout(() => {
      const file = join(ESCALATION_DIR, filename);
      if (!existsSync(file)) return;

      try {
        const esc: Escalation = JSON.parse(readFileSync(file, "utf-8"));
        if (esc.status !== "pending") return;

        // Loop detection
        if (wouldCreateLoop(esc.from, esc.to)) {
          log(`LOOP BLOCKED: ${esc.from} → ${esc.to} would create circular dependency`);
          resolveEscalation(filename, "BLOCKED: Circular dependency detected");
          return;
        }

        wakeAgent(filename, esc);
      } catch {
        log(`ERROR: Failed to parse ${filename}`);
      }
    }, 500);
  });
}

// --- Startup: Process any pending escalations ---
function processPending(): void {
  for (const agent of ["boss", "worker1", "worker2"]) {
    const pending = getPendingEscalations(agent);
    if (pending.length > 0) {
      log(`STARTUP: Found ${pending.length} pending escalation(s) for ${agent}`);
      for (const { filename, esc } of pending) {
        wakeAgent(filename, esc);
      }
    }
  }
}

// --- Logging ---
function log(msg: string): void {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] ${msg}`);
}

// --- Main ---
console.log("╔══════════════════════════════════════════════╗");
console.log("║  Thalamus Mini — Reference Implementation   ║");
console.log("║  github.com/tomadventury-afk/thalamus-framework  ║");
console.log("╚══════════════════════════════════════════════╝");
console.log();

// Initialize agent states
for (const agent of ["boss", "worker1", "worker2"]) {
  writeState(agent, {
    agent,
    status: "idle",
    current_task: null,
    updated_at: new Date().toISOString(),
  });
}

// Process any leftover escalations from previous run
processPending();

// Start watching for new escalations
startWatcher();

log("Ready. Send escalations by running: bun run escalation.ts <from> <to> <subject>");
log("Press Ctrl+C to stop.");
