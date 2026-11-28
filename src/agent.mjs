import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(__dirname, "..");
export const ROLES_DIR = path.join(REPO_ROOT, "roles");
export const LOCAL_OPS_DIR = path.join(REPO_ROOT, "ops", "local");

export const DEFAULT_BASE_URL = process.env.INKLING_BASE_URL || "http://localhost:1235/v1";
export const DEFAULT_MODEL = process.env.INKLING_MODEL || "inkling-2-mini@q2_k_xl";
export const DEFAULT_API_KEY = process.env.INKLING_API_KEY || "lm-studio";
export const DEFAULT_ROLE = process.env.INKLING_ROLE || "implementer";

// Layer 6: Internal Model Aliases (swap providers/quants via config, never code rewrites)
export const MODEL_ALIASES = {
  worker: process.env.INKLING_ALIAS_WORKER || DEFAULT_MODEL,
  fast: process.env.INKLING_ALIAS_FAST || "inkling-2-mini@iq3_xxs",
  quality: process.env.INKLING_ALIAS_QUALITY || "inkling-2-mini@q3_k_xl",
  judge: process.env.INKLING_ALIAS_JUDGE || "inkling-2-mini@q3_k_xl",
  alt: process.env.INKLING_ALIAS_ALT || "ornith-1.5-9b-mlx@4bit",
};

export function resolveModelAlias(modelOrAlias) {
  const key = (modelOrAlias || "worker").trim();
  return MODEL_ALIASES[key] || key;
}

export const STATE_DIR = process.env.INKLING_STATE_DIR || path.join(os.homedir(), ".inkling-workforce");
export const JOBS_DIR = process.env.INKLING_JOBS_DIR || path.join(STATE_DIR, "jobs");
export const DB_FILE = path.join(STATE_DIR, "state.db");
export const THERMAL_FILE = path.join(STATE_DIR, "thermal.json");
export const LOCK_FILE = path.join(STATE_DIR, "inference.lock");

// Thermal & anti-burnout pacing defaults (20m work / 10m break = 20m rest/hr + hardware sensor)
export const WORK_WINDOW_MINUTES = Number(process.env.INKLING_WORK_MINUTES ?? 20);
export const BREAK_MINUTES = Number(process.env.INKLING_BREAK_MINUTES ?? 10);
export const IDLE_RESET_MINUTES = Number(process.env.INKLING_IDLE_RESET_MINUTES ?? 10);
export const STEP_COOLDOWN_MS = Number(process.env.INKLING_STEP_COOLDOWN_MS ?? 8000);
export const WARM_STEP_COOLDOWN_MS = Number(process.env.INKLING_WARM_STEP_COOLDOWN_MS ?? 18000);
export const TASK_COOLDOWN_SEC = Number(process.env.INKLING_TASK_COOLDOWN_SEC ?? 60);
export const HTTP_TIMEOUT_MS = Number(process.env.INKLING_HTTP_TIMEOUT_MS ?? 1200_000); // 20 min (eliminates Node fetch 300s headersTimeout)

const THERMAL_LABELS = ["nominal", "fair", "serious", "critical"];
const IGNORED_DIRS = new Set([".git", "node_modules", ".venv", "__pycache__", ".pytest_cache", "dist", "build"]);

function ensureDirs() {
  fs.mkdirSync(JOBS_DIR, { recursive: true });
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function isPidAlive(pid) {
  if (!pid || typeof pid !== "number") return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// ─── Layer 2 & Layer 6: SQLite State Store (Checkpoints, Traces, Exceptions) ─

let _db = null;
export function getStateDb() {
  if (_db) return _db;
  ensureDirs();
  _db = new DatabaseSync(DB_FILE);
  _db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS job_checkpoints (
      job_id TEXT PRIMARY KEY,
      role TEXT NOT NULL,
      cwd TEXT NOT NULL,
      task TEXT NOT NULL,
      step INTEGER NOT NULL,
      messages_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS llm_traces (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL,
      job_id TEXT,
      step INTEGER,
      requested_model TEXT,
      resolved_model TEXT NOT NULL,
      latency_ms INTEGER NOT NULL,
      prompt_tokens INTEGER DEFAULT 0,
      completion_tokens INTEGER DEFAULT 0,
      reasoning_tokens INTEGER DEFAULT 0,
      finish_reason TEXT,
      error TEXT
    );
    CREATE TABLE IF NOT EXISTS exceptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL,
      job_id TEXT,
      role TEXT,
      cwd TEXT,
      task TEXT,
      reason TEXT NOT NULL,
      resolved INTEGER DEFAULT 0
    );
  `);
  return _db;
}

export function saveCheckpoint({ jobId, role, cwd, task, step, messages }) {
  try {
    const db = getStateDb();
    db.prepare(
      `INSERT INTO job_checkpoints (job_id, role, cwd, task, step, messages_json, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(job_id) DO UPDATE SET
         step = excluded.step,
         messages_json = excluded.messages_json,
         updated_at = excluded.updated_at`
    ).run(jobId, role, cwd, task, step, JSON.stringify(messages), new Date().toISOString());
  } catch {
    // non-fatal
  }
}

export function loadCheckpoint(jobId) {
  try {
    const row = getStateDb().prepare("SELECT * FROM job_checkpoints WHERE job_id = ?").get(jobId);
    if (!row) return null;
    return { ...row, messages: JSON.parse(row.messages_json) };
  } catch {
    return null;
  }
}

export function recordTrace(trace) {
  try {
    getStateDb()
      .prepare(
        `INSERT INTO llm_traces
         (created_at, job_id, step, requested_model, resolved_model, latency_ms, prompt_tokens, completion_tokens, reasoning_tokens, finish_reason, error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        new Date().toISOString(),
        trace.jobId || null,
        trace.step ?? null,
        trace.requestedModel || null,
        trace.resolvedModel,
        trace.latencyMs,
        trace.promptTokens || 0,
        trace.completionTokens || 0,
        trace.reasoningTokens || 0,
        trace.finishReason || null,
        trace.error || null
      );
  } catch {
    // non-fatal
  }
}

export function recordException({ jobId, role, cwd, task, reason }) {
  try {
    getStateDb()
      .prepare(
        `INSERT INTO exceptions (created_at, job_id, role, cwd, task, reason, resolved)
         VALUES (?, ?, ?, ?, ?, ?, 0)`
      )
      .run(new Date().toISOString(), jobId || null, role || null, cwd || null, task || null, String(reason));
  } catch {
    // non-fatal
  }
}

export function listOpenExceptions(limit = 20) {
  try {
    return getStateDb()
      .prepare("SELECT * FROM exceptions WHERE resolved = 0 ORDER BY id DESC LIMIT ?")
      .all(limit);
  } catch {
    return [];
  }
}

export function clearExceptions() {
  try {
    getStateDb().exec("UPDATE exceptions SET resolved = 1 WHERE resolved = 0");
  } catch {
    // ignore
  }
}

// ─── Thermal Duty-Cycle, Hardware Sensor & Single-Flight GPU Guard ──────────

export function getMacHardwareThermal() {
  if (process.platform !== "darwin") return { level: 0, label: "nominal" };
  try {
    const raw = execFileSync(
      "/usr/bin/osascript",
      ["-l", "JavaScript", "-e", 'ObjC.import("Foundation"); $.NSProcessInfo.processInfo.thermalState'],
      { encoding: "utf8", timeout: 3000, stdio: ["ignore", "pipe", "ignore"] }
    ).trim();
    const level = Number(raw);
    if (Number.isInteger(level) && level >= 0 && level <= 3) {
      return { level, label: THERMAL_LABELS[level] };
    }
  } catch {
    // fallback if osascript unavailable
  }
  return { level: 0, label: "nominal" };
}

export function readThermalState() {
  ensureDirs();
  try {
    if (fs.existsSync(THERMAL_FILE)) {
      return JSON.parse(fs.readFileSync(THERMAL_FILE, "utf8"));
    }
  } catch {
    // ignore corrupt state
  }
  return { windowStartedAt: null, lastCallAt: null, cooldownUntil: null };
}

export function writeThermalState(state) {
  ensureDirs();
  fs.writeFileSync(THERMAL_FILE, JSON.stringify(state, null, 2), "utf8");
}

export function triggerThermalBreak(minutes = BREAK_MINUTES) {
  const now = Date.now();
  const cooldownUntil = now + minutes * 60_000;
  writeThermalState({ windowStartedAt: null, lastCallAt: now, cooldownUntil });
  return getThermalStatus();
}

export function resetThermalState() {
  writeThermalState({ windowStartedAt: null, lastCallAt: null, cooldownUntil: null });
  return getThermalStatus();
}

export function getThermalStatus() {
  const now = Date.now();
  const s = readThermalState();
  const workMs = WORK_WINDOW_MINUTES * 60_000;
  const idleResetMs = IDLE_RESET_MINUTES * 60_000;
  const hw = getMacHardwareThermal();

  let lockHolderPid = null;
  try {
    if (fs.existsSync(LOCK_FILE)) {
      const lock = JSON.parse(fs.readFileSync(LOCK_FILE, "utf8"));
      if (isPidAlive(lock.pid)) lockHolderPid = lock.pid;
    }
  } catch {
    // ignore
  }

  const policy = `${WORK_WINDOW_MINUTES}m work / ${BREAK_MINUTES}m break | step breather ${STEP_COOLDOWN_MS}ms (${WARM_STEP_COOLDOWN_MS}ms if warm)`;

  if (s.cooldownUntil && now < s.cooldownUntil) {
    return {
      mode: "cooling_down",
      macThermal: `${hw.label} (${hw.level}/3)`,
      remainingBreakSec: Math.ceil((s.cooldownUntil - now) / 1000),
      resumesAt: new Date(s.cooldownUntil).toISOString(),
      policy,
      activeInferencePid: lockHolderPid,
    };
  }

  const idleTooLong = !s.lastCallAt || now - s.lastCallAt >= idleResetMs;
  const activeElapsedMs = idleTooLong || !s.windowStartedAt ? 0 : Math.max(0, now - s.windowStartedAt);
  const remainingWorkMin = Math.max(0, Math.round((workMs - activeElapsedMs) / 60_000));

  return {
    mode: hw.level >= 2 ? "hardware_hot_pause" : lockHolderPid ? "inferring" : "ready",
    macThermal: `${hw.label} (${hw.level}/3)`,
    activeWindowElapsedMin: Math.round(activeElapsedMs / 60_000),
    nextBreakInMin: remainingWorkMin,
    policy,
    activeInferencePid: lockHolderPid,
  };
}

export async function enforceThermalPolicy(onLog = null) {
  let hw = getMacHardwareThermal();
  while (hw.level >= 2) {
    const emergencyBreakMs = BREAK_MINUTES * 60_000;
    const cooldownUntil = Date.now() + emergencyBreakMs;
    writeThermalState({ windowStartedAt: null, lastCallAt: Date.now(), cooldownUntil });
    if (onLog) {
      onLog(
        `🔥 macOS thermal sensor reports ${hw.label.toUpperCase()} (${hw.level}/3) — taking immediate ${BREAK_MINUTES}m anti-burnout break!`
      );
    }
    await sleep(emergencyBreakMs);
    hw = getMacHardwareThermal();
  }

  if (WORK_WINDOW_MINUTES <= 0 || BREAK_MINUTES <= 0) return;

  const workMs = WORK_WINDOW_MINUTES * 60_000;
  const breakMs = BREAK_MINUTES * 60_000;
  const idleResetMs = IDLE_RESET_MINUTES * 60_000;

  let state = readThermalState();
  let now = Date.now();

  if (state.cooldownUntil && now < state.cooldownUntil) {
    const waitMs = state.cooldownUntil - now;
    if (onLog) {
      onLog(
        `🌡️ Thermal break active — resting Mac for ${(waitMs / 60_000).toFixed(1)}m (until ${new Date(state.cooldownUntil).toISOString()})`
      );
    }
    await sleep(waitMs);
    now = Date.now();
    writeThermalState({ windowStartedAt: now, lastCallAt: now, cooldownUntil: null });
    return;
  }

  if (!state.windowStartedAt || !state.lastCallAt || now - state.lastCallAt >= idleResetMs) {
    writeThermalState({ windowStartedAt: now, lastCallAt: now, cooldownUntil: null });
    return;
  }

  if (now - state.windowStartedAt >= workMs) {
    const cooldownUntil = now + breakMs;
    writeThermalState({ windowStartedAt: null, lastCallAt: now, cooldownUntil });
    if (onLog) {
      onLog(
        `🌡️ Reached ${WORK_WINDOW_MINUTES}m active sprint — taking ${BREAK_MINUTES}m employee cooldown break until ${new Date(cooldownUntil).toISOString()}`
      );
    }
    await sleep(breakMs);
    const resumed = Date.now();
    writeThermalState({ windowStartedAt: resumed, lastCallAt: resumed, cooldownUntil: null });
    if (onLog) onLog(`🌡️ Break complete — resuming work with a fresh ${WORK_WINDOW_MINUTES}m sprint.`);
    return;
  }

  state.lastCallAt = now;
  writeThermalState(state);
}

async function withSingleFlightLock(fn, onLog = null) {
  ensureDirs();
  let loggedWait = false;
  while (true) {
    try {
      const fd = fs.openSync(LOCK_FILE, "wx");
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() }));
      fs.closeSync(fd);
      break;
    } catch {
      try {
        const existing = JSON.parse(fs.readFileSync(LOCK_FILE, "utf8"));
        if (!isPidAlive(existing.pid)) {
          fs.unlinkSync(LOCK_FILE);
          continue;
        }
      } catch {
        try { fs.unlinkSync(LOCK_FILE); } catch { /* ignore */ }
        continue;
      }
      if (!loggedWait && onLog) {
        onLog("⏳ Waiting for single-flight LM Studio GPU lock...");
        loggedWait = true;
      }
      await sleep(2000);
    }
  }

  try {
    return await fn();
  } finally {
    try {
      const cur = JSON.parse(fs.readFileSync(LOCK_FILE, "utf8"));
      if (cur.pid === process.pid) fs.unlinkSync(LOCK_FILE);
    } catch {
      // ignore
    }
  }
}

// ─── Layer 4: Scoped Trusted Context Catalog ────────────────────────────────

export function loadContextCatalog(cwd) {
  const repoName = path.basename(path.resolve(cwd));
  const candidates = [
    path.join(path.resolve(cwd), ".context.json"),
    path.join(LOCAL_OPS_DIR, repoName, "CONTEXT_CATALOG.json"),
  ];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) {
        return JSON.parse(fs.readFileSync(p, "utf8"));
      }
    } catch {
      // ignore
    }
  }
  return null;
}

// ─── Workspace, Roles & Tool Execution (Layer 3: Deterministic Boundaries) ──

function resolveInside(cwd, targetPath) {
  const resolvedCwd = path.resolve(cwd);
  const resolved = path.resolve(resolvedCwd, targetPath || ".");
  if (resolved !== resolvedCwd && !resolved.startsWith(resolvedCwd + path.sep)) {
    throw new Error(`Path escapes workspace: ${targetPath}`);
  }
  return resolved;
}

// Keep tool outputs compact (4500 chars default) so context never balloons into 5+ minute prefills
function truncate(str, maxLen = 4500) {
  if (!str) return "";
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen) + `\n... [truncated ${str.length - maxLen} chars; request a specific line range if needed]`;
}

export function loadRole(roleName = DEFAULT_ROLE) {
  const filePath = path.join(ROLES_DIR, `${roleName}.md`);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Unknown role '${roleName}'. Available roles: ${listRoles().map((r) => r.name).join(", ")}`);
  }
  const raw = fs.readFileSync(filePath, "utf8");
  const meta = { name: roleName, description: "", readOnly: false, maxSteps: 30, instructions: raw.trim() };

  const fmMatch = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (fmMatch) {
    const fm = fmMatch[1];
    meta.instructions = fmMatch[2].trim();
    for (const line of fm.split("\n")) {
      const idx = line.indexOf(":");
      if (idx === -1) continue;
      const k = line.slice(0, idx).trim();
      const v = line.slice(idx + 1).trim();
      if (k === "name" && v) meta.name = v;
      if (k === "description") meta.description = v;
      if (k === "read_only") meta.readOnly = v === "true";
      if (k === "max_steps" && Number(v)) meta.maxSteps = Number(v);
    }
  }
  return meta;
}

export function listRoles() {
  if (!fs.existsSync(ROLES_DIR)) return [];
  return fs
    .readdirSync(ROLES_DIR)
    .filter((f) => f.endsWith(".md"))
    .sort()
    .map((f) => loadRole(path.basename(f, ".md")));
}

export const AGENT_TOOLS = [
  {
    type: "function",
    function: {
      name: "query_context_catalog",
      description: "Query the scoped domain context catalog for exact module contracts, routes, schemas, or test commands (faster than reading whole docs).",
      parameters: {
        type: "object",
        properties: {
          topic: { type: "string", description: "Topic key (or 'index' to list available topics)" },
        },
        required: ["topic"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_dir",
      description: "List files and directories at a path relative to the workspace root.",
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "Relative path (default '.')" } },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read a text file in the workspace with optional 1-based line range.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Relative path to the file" },
          start_line: { type: "integer", description: "1-based start line (optional)" },
          end_line: { type: "integer", description: "1-based end line inclusive (optional)" },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "Create or overwrite a file in the workspace.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Relative path to the file" },
          content: { type: "string", description: "Full file contents" },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "edit_file",
      description: "Replace an exact text snippet in an existing file.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Relative path to the file" },
          old_text: { type: "string", description: "Exact existing text to replace" },
          new_text: { type: "string", description: "Replacement text" },
        },
        required: ["path", "old_text", "new_text"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_files",
      description: "Search for a text or regex pattern across files in the workspace.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Search pattern" },
          path: { type: "string", description: "Subdirectory relative to workspace (default '.')" },
        },
        required: ["pattern"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_command",
      description: "Run a shell command in the workspace directory (e.g. tests, git, linters).",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "Shell command to run" },
          timeout_ms: { type: "integer", description: "Timeout in milliseconds (default 60000, max 300000)" },
        },
        required: ["command"],
      },
    },
  },
];

export const READ_ONLY_TOOLS = AGENT_TOOLS.filter((t) =>
  ["query_context_catalog", "list_dir", "read_file", "search_files"].includes(t.function.name)
);

const BLOCKED_REMOTE_PATTERNS = [
  /\bgit\s+push\b/i,
  /\bgit\s+remote\s+(add|set-url|remove|rm|rename)\b/i,
  /\bgh\s+(pr|repo|release|gist|issue)\s+(create|merge|close|reopen|edit|delete|sync|fork|comment)\b/i,
  /\bgh\s+api\b.*(-X|--method)\s*(POST|PUT|PATCH|DELETE)/i,
];

export function checkCommandGovernance(cmd) {
  for (const pat of BLOCKED_REMOTE_PATTERNS) {
    if (pat.test(cmd)) {
      return (
        "BLOCKED BY GOVERNANCE BIBLE: Inkling agents may NEVER push to GitHub or create/mutate PRs or remotes. " +
        "Keep all work local, run local tests/evals, and return a Local Build Summary for CEO & founder sign-off."
      );
    }
  }
  return null;
}

async function executeTool(name, args, { cwd, readOnly }) {
  if (readOnly && !["query_context_catalog", "list_dir", "read_file", "search_files"].includes(name)) {
    return `Error: Tool '${name}' is disabled in read-only mode.`;
  }

  try {
    switch (name) {
      case "query_context_catalog": {
        const catalog = loadContextCatalog(cwd);
        if (!catalog) return "No scoped context catalog configured for this repository. Use list_dir / read_file directly.";
        const topic = String(args.topic || "index").toLowerCase();
        if (topic === "index" || !catalog.topics?.[topic]) {
          return JSON.stringify(
            {
              summary: catalog.summary,
              available_topics: Object.keys(catalog.topics || {}),
              hint: "Call query_context_catalog with any topic name above.",
            },
            null,
            2
          );
        }
        return JSON.stringify(catalog.topics[topic], null, 2);
      }

      case "list_dir": {
        const target = resolveInside(cwd, args.path || ".");
        const entries = fs.readdirSync(target, { withFileTypes: true });
        const lines = entries
          .filter((e) => !IGNORED_DIRS.has(e.name))
          .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
          .map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
        return lines.length ? lines.join("\n") : "(empty directory)";
      }

      case "read_file": {
        const target = resolveInside(cwd, args.path);
        const content = fs.readFileSync(target, "utf8");
        const lines = content.split("\n");
        const start = Math.max(1, Number(args.start_line) || 1);
        const end = Math.min(lines.length, Number(args.end_line) || Math.min(lines.length, start + 299));
        const slice = lines.slice(start - 1, end).map((line, i) => `${start + i}: ${line}`).join("\n");
        return truncate(`Showing lines ${start}-${end} of ${lines.length}:\n${slice}`, 9500);
      }

      case "write_file": {
        const target = resolveInside(cwd, args.path);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, String(args.content ?? ""), "utf8");
        return `Wrote ${args.path} (${String(args.content ?? "").length} bytes).`;
      }

      case "edit_file": {
        const target = resolveInside(cwd, args.path);
        const content = fs.readFileSync(target, "utf8");
        const oldText = String(args.old_text ?? "");
        const newText = String(args.new_text ?? "");
        if (!oldText || !content.includes(oldText)) {
          return `Error: old_text not found in ${args.path}. Read the file first and match exact whitespace.`;
        }
        const updated = content.replaceAll(oldText, newText);
        fs.writeFileSync(target, updated, "utf8");
        return `Updated ${args.path}.`;
      }

      case "search_files": {
        const target = resolveInside(cwd, args.path || ".");
        try {
          const out = execFileSync(
            "grep",
            ["-rnE", "--exclude-dir=.git", "--exclude-dir=node_modules", "--exclude-dir=.venv", "--exclude-dir=__pycache__", String(args.pattern), target],
            { encoding: "utf8", maxBuffer: 2 * 1024 * 1024 }
          );
          return truncate(out.replaceAll(path.resolve(cwd) + path.sep, ""), 4500) || "(no matches)";
        } catch (err) {
          if (err.status === 1) return "(no matches)";
          throw err;
        }
      }

      case "run_command": {
        const cmdStr = String(args.command || "");
        const violation = checkCommandGovernance(cmdStr);
        if (violation) return violation;
        const timeout = Math.min(Math.max(Number(args.timeout_ms) || 60000, 1000), 300000);
        return await new Promise((resolve) => {
          const child = spawn("/bin/zsh", ["-lc", `setopt NO_EQUALS 2>/dev/null; ${cmdStr}`], {
            cwd: path.resolve(cwd),
            env: process.env,
          });
          let out = "";
          let killed = false;
          const timer = setTimeout(() => {
            killed = true;
            child.kill("SIGTERM");
          }, timeout);

          child.stdout.on("data", (d) => { out += d.toString(); });
          child.stderr.on("data", (d) => { out += d.toString(); });
          child.on("close", (code) => {
            clearTimeout(timer);
            const prefix = killed ? `Command timed out after ${timeout}ms.\n` : `Exit code: ${code}\n`;
            resolve(truncate(prefix + out, 4500));
          });
          child.on("error", (err) => {
            clearTimeout(timer);
            resolve(`Command error: ${err.message}`);
          });
        });
      }

      default:
        return `Error: Unknown tool '${name}'.`;
    }
  } catch (err) {
    return `Error executing ${name}: ${err.message}`;
  }
}

// ─── Layer 6: Resilient LLM Gateway (node:http + 20m timeout + retries + traces) ─

function httpJsonRequest(urlString, { method = "GET", headers = {}, body = null, timeoutMs = HTTP_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlString);
    const lib = u.protocol === "https:" ? https : http;
    const payload = body ? Buffer.from(JSON.stringify(body), "utf8") : null;

    const req = lib.request(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || (u.protocol === "https:" ? 443 : 80),
        path: u.pathname + u.search,
        method,
        headers: {
          ...headers,
          ...(payload ? { "Content-Length": payload.length } : {}),
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          if (res.statusCode < 200 || res.statusCode >= 300) {
            return reject(new Error(`HTTP ${res.statusCode}: ${raw.slice(0, 500)}`));
          }
          try {
            resolve(JSON.parse(raw));
          } catch (err) {
            reject(new Error(`Invalid JSON from LLM gateway: ${err.message}`));
          }
        });
      }
    );

    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`LLM gateway socket timeout after ${Math.round(timeoutMs / 1000)}s`));
    });
    req.on("error", (err) => reject(err));
    if (payload) req.write(payload);
    req.end();
  });
}

export async function listModels(baseUrl = DEFAULT_BASE_URL) {
  const data = await httpJsonRequest(`${baseUrl.replace(/\/$/, "")}/models`, {
    headers: { Authorization: `Bearer ${DEFAULT_API_KEY}` },
    timeoutMs: 15_000,
  });
  return (data.data || []).map((m) => m.id);
}

export async function chatCompletion({
  messages,
  tools,
  model = "worker",
  baseUrl = DEFAULT_BASE_URL,
  temperature = 0.2,
  maxTokens = 6144,
  jobId = null,
  step = null,
  onLog = null,
}) {
  const resolvedModel = resolveModelAlias(model);
  await enforceThermalPolicy(onLog);

  return await withSingleFlightLock(async () => {
    const body = {
      model: resolvedModel,
      messages,
      temperature,
      max_tokens: maxTokens,
    };
    if (tools && tools.length > 0) {
      body.tools = tools;
      body.tool_choice = "auto";
    }

    const endpoint = `${baseUrl.replace(/\/$/, "")}/chat/completions`;
    let lastErr = null;

    for (let attempt = 1; attempt <= 3; attempt++) {
      const t0 = Date.now();
      try {
        const data = await httpJsonRequest(endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${DEFAULT_API_KEY}`,
          },
          body,
          timeoutMs: HTTP_TIMEOUT_MS,
        });
        const latencyMs = Date.now() - t0;
        const usage = data.usage || {};
        recordTrace({
          jobId,
          step,
          requestedModel: model,
          resolvedModel,
          latencyMs,
          promptTokens: usage.prompt_tokens || 0,
          completionTokens: usage.completion_tokens || 0,
          reasoningTokens: usage.completion_tokens_details?.reasoning_tokens || 0,
          finishReason: data.choices?.[0]?.finish_reason || null,
        });
        return data;
      } catch (err) {
        lastErr = err;
        const latencyMs = Date.now() - t0;
        recordTrace({
          jobId,
          step,
          requestedModel: model,
          resolvedModel,
          latencyMs,
          error: err.message,
        });
        if (attempt < 3) {
          const backoffSec = attempt * 10;
          if (onLog) onLog(`⚠️ LLM gateway transient error (${err.message}); retrying in ${backoffSec}s (attempt ${attempt + 1}/3)...`);
          await sleep(backoffSec * 1000);
        }
      }
    }
    throw lastErr;
  }, onLog);
}

// ─── Job Persistence & Checkpointed Agent Loop ──────────────────────────────

export function getJobPaths(jobId) {
  ensureDirs();
  return {
    meta: path.join(JOBS_DIR, `${jobId}.json`),
    log: path.join(JOBS_DIR, `${jobId}.log`),
  };
}

export function saveJobMeta(job) {
  const { meta } = getJobPaths(job.id);
  fs.writeFileSync(meta, JSON.stringify(job, null, 2), "utf8");
}

export function loadJobMeta(jobId) {
  const { meta } = getJobPaths(jobId);
  if (!fs.existsSync(meta)) return null;
  return JSON.parse(fs.readFileSync(meta, "utf8"));
}

export function appendJobLog(jobId, line) {
  const { log } = getJobPaths(jobId);
  const ts = new Date().toISOString();
  fs.appendFileSync(log, `[${ts}] ${line}\n`, "utf8");
}

export function getGitShortStatus(cwd) {
  try {
    return execFileSync("git", ["status", "--short"], { cwd, encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

export function runDeterministicTests(cwd) {
  const pytestBin = path.join(path.resolve(cwd), ".venv", "bin", "pytest");
  if (!fs.existsSync(pytestBin)) return { ran: false, ok: true, output: "(no pytest binary)" };
  try {
    const out = execFileSync(pytestBin, ["-q"], { cwd: path.resolve(cwd), encoding: "utf8", timeout: 60_000 }).trim();
    return { ran: true, ok: true, output: out };
  } catch (err) {
    return { ran: true, ok: false, output: `${err.stdout || ""}\n${err.stderr || ""}`.trim() };
  }
}

export function newJobId() {
  return `inkling-${Date.now()}-${crypto.randomBytes(3).toString("hex")}`;
}

// v0.5 Fast-Start Pre-Hydration: inline up to 3 target files named in backticks so workers edit on Step 1-2
export function preloadTaskFiles(cwd, taskText, maxFiles = 3, maxFileChars = 11000) {
  const matches = [...String(taskText || "").matchAll(/`([A-Za-z0-9_./-]+\.[A-Za-z0-9]+)`/g)].map((m) => m[1]);
  const seen = new Set();
  const blocks = [];
  for (const rel of matches) {
    if (seen.has(rel) || rel.startsWith("/") || rel.includes("..")) continue;
    seen.add(rel);
    if (blocks.length >= maxFiles) break;
    try {
      const full = resolveInside(cwd, rel);
      if (!fs.existsSync(full)) {
        blocks.push(`### \`${rel}\` (does not exist yet — create with \`write_file\`)`);
        continue;
      }
      const stat = fs.statSync(full);
      if (!stat.isFile() || stat.size > maxFileChars) continue;
      const numbered = fs
        .readFileSync(full, "utf8")
        .split("\n")
        .map((line, i) => `${i + 1}: ${line}`)
        .join("\n");
      blocks.push(`### \`${rel}\` (current full contents)\n\`\`\`\n${numbered}\n\`\`\``);
    } catch {
      // skip invalid paths
    }
  }
  if (!blocks.length) return "";
  return [
    "",
    "## Pre-Loaded Target Files (v0.5 Fast-Start — DO NOT re-read these with read_file/sed/cat; start editing directly!)",
    ...blocks,
  ].join("\n");
}

export async function runAgent({
  task,
  cwd = process.cwd(),
  role = DEFAULT_ROLE,
  model = "worker",
  baseUrl = DEFAULT_BASE_URL,
  maxSteps = null,
  readOnly = null,
  jobId = null,
  resumeJobId = null,
  onLog = null,
}) {
  const checkpoint = resumeJobId ? loadCheckpoint(resumeJobId) : null;
  const effectiveRoleName = checkpoint?.role || role;
  const roleDef = loadRole(effectiveRoleName);
  const effectiveReadOnly = readOnly !== null && readOnly !== undefined ? Boolean(readOnly) : roleDef.readOnly;
  const effectiveMaxSteps = Number(maxSteps) || roleDef.maxSteps || 30;
  const resolvedModel = resolveModelAlias(model);

  const id = resumeJobId || jobId || newJobId();
  const resolvedCwd = path.resolve(checkpoint?.cwd || cwd);
  const effectiveTask = checkpoint?.task || task;
  const startStep = checkpoint ? Number(checkpoint.step) + 1 : 1;

  const job = {
    id,
    status: "running",
    pid: process.pid,
    role: roleDef.name,
    model: resolvedModel,
    baseUrl,
    cwd: resolvedCwd,
    readOnly: effectiveReadOnly,
    task: effectiveTask,
    maxSteps: effectiveMaxSteps,
    step: checkpoint?.step || 0,
    resumedFromStep: checkpoint ? checkpoint.step : null,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    summary: null,
    error: null,
    gitStatus: "",
  };
  saveJobMeta(job);

  const log = (msg) => {
    appendJobLog(id, msg);
    if (onLog) onLog(msg);
  };

  log(
    `Started job ${id} | role=${roleDef.name} | model=${resolvedModel} | startStep=${startStep} | cwd=${resolvedCwd}`
  );

  const tools = effectiveReadOnly ? READ_ONLY_TOOLS : AGENT_TOOLS;
  const catalog = loadContextCatalog(resolvedCwd);
  const catalogBrief = catalog
    ? [
        "",
        "## Scoped Authoritative Domain Context (Layer 4 — Do NOT waste steps reading general docs!)",
        catalog.summary,
        `Available catalog topics via \`query_context_catalog\`: ${Object.keys(catalog.topics || {}).join(", ")}`,
        catalog.quick_contracts ? `\nCore Contracts:\n${catalog.quick_contracts}` : "",
      ].join("\n")
    : "";

  const systemPrompt = [
    roleDef.instructions,
    catalogBrief,
    "",
    "## Execution Efficiency Rules (v0.5)",
    "- Target files named in your task are PRE-LOADED in the user prompt. Start writing/editing on Step 1-2! NEVER waste steps re-reading pre-loaded files via `read_file`, `sed`, `head`, or `cat`.",
    "- Do NOT read general planning docs (`VISION.md`, `ROADMAP.md`, `ARCHITECTURE.md`) unless explicitly asked — rely on the Scoped Domain Context above.",
    "- Keep internal reasoning concise (<120 words), batch independent reads if needed, and write ONE file per step.",
    "",
    "## Mandatory Governance Law (THE BIBLE)",
    "- NEVER run `git push`, `gh pr create`, or any command that updates GitHub. Only local edits, local tests, and local inspection are permitted.",
    "- Every completed task MUST end with a crisp Local Build Summary (what changed, files touched, exact test/verification output, and any open questions).",
    "",
    `Target workspace directory: ${resolvedCwd}`,
  ].join("\n");

  const preloadedBlock = checkpoint ? "" : preloadTaskFiles(resolvedCwd, effectiveTask);
  const messages = checkpoint?.messages || [
    { role: "system", content: systemPrompt },
    { role: "user", content: effectiveTask + preloadedBlock },
  ];

  let nextStepMaxTokens = 6144;
  try {
    for (let step = startStep; step <= effectiveMaxSteps; step++) {
      if (step > startStep) {
        const hw = getMacHardwareThermal();
        const breatherMs = hw.level >= 1 ? WARM_STEP_COOLDOWN_MS : STEP_COOLDOWN_MS;
        if (breatherMs > 0) {
          if (hw.level >= 1) log(`🌡️ Mac warm (${hw.label}) — extending step breather to ${breatherMs / 1000}s`);
          await sleep(breatherMs);
        }
      }

      job.step = step;
      saveJobMeta(job);

      const response = await chatCompletion({
        messages,
        tools,
        model,
        baseUrl,
        maxTokens: nextStepMaxTokens,
        jobId: id,
        step,
        onLog: log,
      });
      nextStepMaxTokens = 6144;
      const choice = response.choices?.[0];
      if (!choice?.message) {
        throw new Error(`Empty response from LM Studio: ${JSON.stringify(response)}`);
      }

      const msg = choice.message;
      const cleanAssistant = { role: "assistant", content: msg.content || "" };
      if (msg.tool_calls && msg.tool_calls.length > 0) {
        cleanAssistant.tool_calls = msg.tool_calls;
      }
      messages.push(cleanAssistant);

      if (msg.content) {
        log(`Step ${step} assistant: ${truncate(msg.content.trim(), 500)}`);
      }

      const toolCalls = msg.tool_calls;
      if (!toolCalls || toolCalls.length === 0) {
        if (choice.finish_reason === "length") {
          nextStepMaxTokens = 10240;
          log(`Step ${step} hit max_tokens truncation; raising retry budget to ${nextStepMaxTokens} and prompting concise edit...`);
          messages.push({
            role: "user",
            content:
              "Your response was cut off by max_tokens before emitting a tool call. Keep reasoning under 60 words and prefer smaller edit_file patches over rewriting an entire large file in one call.",
          });
          saveCheckpoint({ jobId: id, role: roleDef.name, cwd: resolvedCwd, task: effectiveTask, step, messages });
          continue;
        }
        if (!msg.content || !msg.content.trim()) {
          throw new Error(`Model returned an empty completion (finish_reason=${choice.finish_reason || "unknown"}).`);
        }

        // Layer 5: Deterministic test verification before accepting completion on write jobs
        if (!effectiveReadOnly) {
          const testRes = runDeterministicTests(resolvedCwd);
          if (testRes.ran && !testRes.ok && step < effectiveMaxSteps - 1) {
            log(`Step ${step} deterministic pytest gate failed; feeding errors back to worker...`);
            messages.push({
              role: "user",
              content: `Deterministic test gate (\`.venv/bin/pytest -q\`) failed:\n${truncate(testRes.output, 2500)}\nFix the failing tests before finishing.`,
            });
            saveCheckpoint({ jobId: id, role: roleDef.name, cwd: resolvedCwd, task: effectiveTask, step, messages });
            continue;
          }
        }

        job.status = "completed";
        job.finishedAt = new Date().toISOString();
        job.summary = msg.content.trim();
        job.gitStatus = getGitShortStatus(resolvedCwd);
        saveJobMeta(job);
        saveCheckpoint({ jobId: id, role: roleDef.name, cwd: resolvedCwd, task: effectiveTask, step, messages });
        log(`Completed in ${step} step(s).`);
        return job;
      }

      for (const tc of toolCalls) {
        const fnName = tc.function?.name;
        let parsedArgs = {};
        try {
          parsedArgs = typeof tc.function?.arguments === "string"
            ? JSON.parse(tc.function.arguments || "{}")
            : (tc.function?.arguments || {});
        } catch (err) {
          parsedArgs = {};
          log(`Step ${step} tool arg parse error for ${fnName}: ${err.message}`);
        }

        log(`Step ${step} tool call: ${fnName}(${truncate(JSON.stringify(parsedArgs), 300)})`);
        const result = await executeTool(fnName, parsedArgs, { cwd: resolvedCwd, readOnly: effectiveReadOnly });
        log(`Step ${step} tool result (${fnName}): ${truncate(result, 300)}`);

        let budgetSuffix = "";
        const midPoint = Math.max(4, Math.floor(effectiveMaxSteps * 0.55));
        if (step === midPoint) {
          budgetSuffix = `\n\n[PACE CHECK: Step ${step}/${effectiveMaxSteps}. Apply your edits now and run tests soon — do not re-read files already in context.]`;
        } else if (!effectiveReadOnly && step === Math.max(2, effectiveMaxSteps - 4)) {
          const preGate = runDeterministicTests(resolvedCwd);
          budgetSuffix = preGate.ok
            ? `\n\n[FINAL GATE PRE-CHECK (Step ${step}/${effectiveMaxSteps}): pytest PASSED (${preGate.output.split("\n").pop()}). Wrap up and output your final summary within 2 steps.]`
            : `\n\n[FINAL GATE PRE-CHECK (Step ${step}/${effectiveMaxSteps}): pytest FAILED! STOP reading files and fix these errors immediately:\n${truncate(preGate.output, 1800)}]`;
        } else if (step >= Math.max(1, effectiveMaxSteps - 3)) {
          budgetSuffix = `\n\n[STEP BUDGET WARNING: Step ${step}/${effectiveMaxSteps}. Complete any remaining fix and output your final summary immediately.]`;
        }
        messages.push({
          role: "tool",
          tool_call_id: tc.id || `call_${step}_${fnName}`,
          content: result + budgetSuffix,
        });
      }

      // Layer 2: Checkpoint after every completed tool step in SQLite
      saveCheckpoint({ jobId: id, role: roleDef.name, cwd: resolvedCwd, task: effectiveTask, step, messages });
    }

    log(`Reached maxSteps=${effectiveMaxSteps}; requesting final tool-free synthesis...`);
    messages.push({
      role: "user",
      content: `You have reached the ${effectiveMaxSteps}-step tool limit. Without calling any tools, deliver your complete final report and Local Build Summary now.`,
    });
    const synthRes = await chatCompletion({
      messages,
      tools: null,
      model,
      baseUrl,
      jobId: id,
      step: effectiveMaxSteps + 1,
      onLog: log,
    });
    const synthText = synthRes.choices?.[0]?.message?.content?.trim();

    job.status = "completed";
    job.finishedAt = new Date().toISOString();
    job.summary = synthText || `Reached max_steps (${effectiveMaxSteps}). Check job log and git status for partial progress.`;
    job.gitStatus = getGitShortStatus(resolvedCwd);
    saveJobMeta(job);
    log(`Completed via final synthesis after maxSteps=${effectiveMaxSteps}.`);
    return job;
  } catch (err) {
    job.status = "failed";
    job.finishedAt = new Date().toISOString();
    job.error = err.message;
    job.gitStatus = getGitShortStatus(resolvedCwd);
    saveJobMeta(job);
    recordException({ jobId: id, role: roleDef.name, cwd: resolvedCwd, task: effectiveTask, reason: err.message });
    log(`Failed: ${err.message}`);
    return job;
  }
}

export function listJobs(limit = 20) {
  ensureDirs();
  return fs
    .readdirSync(JOBS_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(JOBS_DIR, f), "utf8"));
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => (b.startedAt || "").localeCompare(a.startedAt || ""))
    .slice(0, limit);
}

export function tailJobLog(jobId, lines = 40) {
  const { log } = getJobPaths(jobId);
  if (!fs.existsSync(log)) return "";
  const all = fs.readFileSync(log, "utf8").trim().split("\n");
  return all.slice(-lines).join("\n");
}

export function generateDigest({ cwd = process.cwd(), hours = 5 } = {}) {
  const resolvedCwd = path.resolve(cwd);
  const cutoff = Date.now() - hours * 3600_000;
  const recentJobs = listJobs(50).filter((j) => {
    const t = Date.parse(j.finishedAt || j.startedAt || "");
    return !Number.isNaN(t) && t >= cutoff;
  });

  let gitBranchStatus = "";
  let gitDiffStat = "";
  let unpushedCommits = "";
  try {
    gitBranchStatus = execFileSync("git", ["status", "-sb"], { cwd: resolvedCwd, encoding: "utf8" }).trim();
    gitDiffStat = execFileSync("git", ["diff", "--stat"], { cwd: resolvedCwd, encoding: "utf8" }).trim();
    unpushedCommits = execFileSync("git", ["log", "@{u}..HEAD", "--oneline"], {
      cwd: resolvedCwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    // ignore
  }

  const testRes = runDeterministicTests(resolvedCwd);
  const thermal = getThermalStatus();
  const exceptions = listOpenExceptions(10);
  const completed = recentJobs.filter((j) => j.status === "completed");
  const running = recentJobs.filter((j) => j.status === "running");
  const failed = recentJobs.filter((j) => j.status === "failed" || j.status === "cancelled");

  const lines = [
    `# ${hours}-Hour Local Build & GitHub Triage Digest`,
    `Generated: ${new Date().toISOString()}`,
    `Target Repo: ${resolvedCwd}`,
    `Thermal Status: ${thermal.mode} | Hardware: ${thermal.macThermal} (${thermal.policy})`,
    "",
    `## 1. Local Git & Deterministic Test Gate`,
    "```",
    gitBranchStatus || "(clean)",
    gitDiffStat ? `\nDiff Stat:\n${gitDiffStat}` : "",
    unpushedCommits ? `\nLocal Unpushed Commits:\n${unpushedCommits}` : "\nLocal Unpushed Commits: (none)",
    "```",
    `**Pytest Gate:** \`${testRes.output.replace(/\n/g, " | ")}\``,
    "",
    `## 2. Exception Queue (${exceptions.length} open)`,
  ];

  if (!exceptions.length) {
    lines.push("- None (queue clear).");
  } else {
    for (const ex of exceptions) {
      lines.push(`- **[#${ex.id}]** \`${ex.role}\` (${ex.job_id}): ${ex.reason}`);
    }
  }

  lines.push("", `## 3. Inkling Jobs in Last ${hours}h (${completed.length} completed, ${running.length} running, ${failed.length} failed/cancelled)`);
  if (!recentJobs.length) {
    lines.push("- No Inkling jobs ran in this window.");
  } else {
    for (const j of recentJobs) {
      const firstLine = (j.summary || j.error || "").split("\n").find((l) => l.trim()) || "";
      lines.push(
        `- **${j.id}** [${j.status.toUpperCase()}] role=\`${j.role}\` steps=${j.step}/${j.maxSteps}: ${j.task.slice(0, 90)}${j.task.length > 90 ? "…" : ""}` +
          (firstLine ? `\n  - _Outcome:_ ${firstLine.slice(0, 140)}` : "")
      );
    }
  }

  return lines.join("\n");
}

export function generateBenchmark() {
  const jobs = listJobs(100);
  const thermal = getThermalStatus();
  const completed = jobs.filter((j) => j.status === "completed");
  const failed = jobs.filter((j) => j.status === "failed");
  const cancelled = jobs.filter((j) => j.status === "cancelled");
  const running = jobs.filter((j) => j.status === "running");

  let traceStats = { calls: 0, avgLatencyMs: 0, totalTokens: 0 };
  try {
    const row = getStateDb()
      .prepare(
        "SELECT COUNT(*) AS calls, COALESCE(AVG(latency_ms), 0) AS avgLatencyMs, COALESCE(SUM(prompt_tokens + completion_tokens), 0) AS totalTokens FROM llm_traces WHERE error IS NULL"
      )
      .get();
    if (row) traceStats = row;
  } catch {
    // ignore
  }

  return [
    "# Inkling Local Workforce — 6-Layer Control Plane Telemetry",
    `- **Model Aliases:** \`worker=${MODEL_ALIASES.worker}\`, \`quality=${MODEL_ALIASES.quality}\`, \`fast=${MODEL_ALIASES.fast}\``,
    `- **Hardware Thermal State:** \`${thermal.macThermal}\` | Mode: \`${thermal.mode}\` | Policy: \`${thermal.policy}\``,
    `- **Tracked Jobs:** ${jobs.length} (${completed.length} completed, ${running.length} running, ${failed.length} failed, ${cancelled.length} cancelled)`,
    `- **SQLite Gateway Traces:** ${traceStats.calls} calls | Avg Latency: ${Math.round(traceStats.avgLatencyMs / 1000)}s | Local Tokens Processed: ${traceStats.totalTokens} ($0.00 cloud cost)`,
  ].join("\n");
}
