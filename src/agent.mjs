import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROLES_DIR = path.resolve(__dirname, "..", "roles");

export const DEFAULT_BASE_URL = process.env.INKLING_BASE_URL || "http://localhost:1235/v1";
export const DEFAULT_MODEL = process.env.INKLING_MODEL || "inkling-2-mini@q2_k_xl";
export const DEFAULT_API_KEY = process.env.INKLING_API_KEY || "lm-studio";
export const DEFAULT_ROLE = process.env.INKLING_ROLE || "implementer";

export const STATE_DIR = process.env.INKLING_STATE_DIR || path.join(os.homedir(), ".inkling-workforce");
export const JOBS_DIR = process.env.INKLING_JOBS_DIR || path.join(STATE_DIR, "jobs");
export const THERMAL_FILE = path.join(STATE_DIR, "thermal.json");
export const LOCK_FILE = path.join(STATE_DIR, "inference.lock");

// Thermal & anti-burnout pacing defaults (20m work / 10m break = 20m rest/hr + hardware sensor)
export const WORK_WINDOW_MINUTES = Number(process.env.INKLING_WORK_MINUTES ?? 20);
export const BREAK_MINUTES = Number(process.env.INKLING_BREAK_MINUTES ?? 10);
export const IDLE_RESET_MINUTES = Number(process.env.INKLING_IDLE_RESET_MINUTES ?? 10);
export const STEP_COOLDOWN_MS = Number(process.env.INKLING_STEP_COOLDOWN_MS ?? 8000);
export const WARM_STEP_COOLDOWN_MS = Number(process.env.INKLING_WARM_STEP_COOLDOWN_MS ?? 18000);
export const TASK_COOLDOWN_SEC = Number(process.env.INKLING_TASK_COOLDOWN_SEC ?? 60);

const THERMAL_LABELS = ["nominal", "fair", "serious", "critical"];

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

// ─── Thermal Duty-Cycle & Single-Flight GPU Guard ───────────────────────────

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
  const state = { windowStartedAt: null, lastCallAt: now, cooldownUntil };
  writeThermalState(state);
  return getThermalStatus();
}

export function resetThermalState() {
  const state = { windowStartedAt: null, lastCallAt: null, cooldownUntil: null };
  writeThermalState(state);
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

  if (s.cooldownUntil && now < s.cooldownUntil) {
    const remainingSec = Math.ceil((s.cooldownUntil - now) / 1000);
    return {
      mode: "cooling_down",
      macThermal: `${hw.label} (${hw.level}/3)`,
      remainingBreakSec: remainingSec,
      resumesAt: new Date(s.cooldownUntil).toISOString(),
      policy: `${WORK_WINDOW_MINUTES}m work / ${BREAK_MINUTES}m break | step breather ${STEP_COOLDOWN_MS}ms (${WARM_STEP_COOLDOWN_MS}ms if warm)`,
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
    policy: `${WORK_WINDOW_MINUTES}m work / ${BREAK_MINUTES}m break | step breather ${STEP_COOLDOWN_MS}ms (${WARM_STEP_COOLDOWN_MS}ms if warm)`,
    activeInferencePid: lockHolderPid,
  };
}

export async function enforceThermalPolicy(onLog = null) {
  // 0. Hardware closed-loop guard: if macOS reports Serious (2) or Critical (3) heat, pause immediately!
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

  // 1. Respect an already-active thermal break
  if (state.cooldownUntil && now < state.cooldownUntil) {
    const waitMs = state.cooldownUntil - now;
    const mins = (waitMs / 60_000).toFixed(1);
    if (onLog) {
      onLog(`🌡️ Thermal break active — resting Mac for ${mins}m (until ${new Date(state.cooldownUntil).toISOString()})`);
    }
    await sleep(waitMs);
    now = Date.now();
    state = { windowStartedAt: now, lastCallAt: now, cooldownUntil: null };
    writeThermalState(state);
    return;
  }

  // 2. If idle for >= IDLE_RESET_MINUTES, start a fresh cool window
  if (!state.windowStartedAt || !state.lastCallAt || now - state.lastCallAt >= idleResetMs) {
    state = { windowStartedAt: now, lastCallAt: now, cooldownUntil: null };
    writeThermalState(state);
    return;
  }

  // 3. If continuous active window hit WORK_WINDOW_MINUTES, take a BREAK_MINUTES cooldown break now
  if (now - state.windowStartedAt >= workMs) {
    const cooldownUntil = now + breakMs;
    state = { windowStartedAt: null, lastCallAt: now, cooldownUntil };
    writeThermalState(state);
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

// ─── Workspace, Roles & Tool Execution ──────────────────────────────────────

function resolveInside(cwd, targetPath) {
  const resolvedCwd = path.resolve(cwd);
  const resolved = path.resolve(resolvedCwd, targetPath || ".");
  if (resolved !== resolvedCwd && !resolved.startsWith(resolvedCwd + path.sep)) {
    throw new Error(`Path escapes workspace: ${targetPath}`);
  }
  return resolved;
}

function truncate(str, maxLen = 12000) {
  if (!str) return "";
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen) + `\n... [truncated ${str.length - maxLen} chars]`;
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
  ["list_dir", "read_file", "search_files"].includes(t.function.name)
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
  if (readOnly && !["list_dir", "read_file", "search_files"].includes(name)) {
    return `Error: Tool '${name}' is disabled in read-only mode.`;
  }

  try {
    switch (name) {
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
        return truncate(`Showing lines ${start}-${end} of ${lines.length}:\n${slice}`);
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
          return truncate(out.replaceAll(path.resolve(cwd) + path.sep, ""), 10000) || "(no matches)";
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
            resolve(truncate(prefix + out, 10000));
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

export async function listModels(baseUrl = DEFAULT_BASE_URL) {
  const res = await fetch(`${baseUrl.replace(/\/$/, "")}/models`, {
    headers: { Authorization: `Bearer ${DEFAULT_API_KEY}` },
  });
  if (!res.ok) {
    throw new Error(`LM Studio returned HTTP ${res.status}: ${await res.text()}`);
  }
  const data = await res.json();
  return (data.data || []).map((m) => m.id);
}

export async function chatCompletion({
  messages,
  tools,
  model = DEFAULT_MODEL,
  baseUrl = DEFAULT_BASE_URL,
  temperature = 0.2,
  maxTokens = 2800,
  onLog = null,
}) {
  await enforceThermalPolicy(onLog);

  return await withSingleFlightLock(async () => {
    const body = {
      model,
      messages,
      temperature,
      max_tokens: maxTokens,
    };
    if (tools && tools.length > 0) {
      body.tools = tools;
      body.tool_choice = "auto";
    }

    const res = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${DEFAULT_API_KEY}`,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      throw new Error(`LM Studio chat/completions HTTP ${res.status}: ${await res.text()}`);
    }
    return await res.json();
  }, onLog);
}

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

export function newJobId() {
  return `inkling-${Date.now()}-${crypto.randomBytes(3).toString("hex")}`;
}

export async function runAgent({
  task,
  cwd = process.cwd(),
  role = DEFAULT_ROLE,
  model = DEFAULT_MODEL,
  baseUrl = DEFAULT_BASE_URL,
  maxSteps = null,
  readOnly = null,
  jobId = null,
  onLog = null,
}) {
  const roleDef = loadRole(role);
  const effectiveReadOnly = readOnly !== null && readOnly !== undefined ? Boolean(readOnly) : roleDef.readOnly;
  const effectiveMaxSteps = Number(maxSteps) || roleDef.maxSteps || 30;

  const id = jobId || newJobId();
  const resolvedCwd = path.resolve(cwd);
  const job = {
    id,
    status: "running",
    pid: process.pid,
    role: roleDef.name,
    model,
    baseUrl,
    cwd: resolvedCwd,
    readOnly: effectiveReadOnly,
    task,
    maxSteps: effectiveMaxSteps,
    step: 0,
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
    `Started job ${id} | role=${roleDef.name} | model=${model} | cwd=${resolvedCwd} | thermal=${WORK_WINDOW_MINUTES}m/${BREAK_MINUTES}m`
  );

  const tools = effectiveReadOnly ? READ_ONLY_TOOLS : AGENT_TOOLS;
  const systemPrompt = [
    roleDef.instructions,
    "",
    "## Mandatory Governance Law (THE BIBLE)",
    "- NEVER run `git push`, `gh pr create`, or any command that updates GitHub. Only local edits, local tests, and local inspection are permitted.",
    "- Every completed task MUST end with a crisp Local Build Summary (what changed, files touched, exact test/verification output, and any open questions) so the CEO can present it for founder sign-off before anything touches GitHub.",
    "",
    `Target workspace directory: ${resolvedCwd}`,
  ].join("\n");

  const messages = [
    { role: "system", content: systemPrompt },
    { role: "user", content: task },
  ];

  try {
    for (let step = 1; step <= effectiveMaxSteps; step++) {
      if (step > 1) {
        const hw = getMacHardwareThermal();
        const breatherMs = hw.level >= 1 ? WARM_STEP_COOLDOWN_MS : STEP_COOLDOWN_MS;
        if (breatherMs > 0) {
          if (hw.level >= 1) log(`🌡️ Mac warm (${hw.label}) — extending step breather to ${breatherMs / 1000}s`);
          await sleep(breatherMs);
        }
      }

      job.step = step;
      saveJobMeta(job);

      const response = await chatCompletion({ messages, tools, model, baseUrl, onLog: log });
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
        job.status = "completed";
        job.finishedAt = new Date().toISOString();
        job.summary = msg.content || "(completed with empty response)";
        job.gitStatus = getGitShortStatus(resolvedCwd);
        saveJobMeta(job);
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

        messages.push({
          role: "tool",
          tool_call_id: tc.id || `call_${step}_${fnName}`,
          content:
            step >= Math.max(1, effectiveMaxSteps - 3)
              ? `${result}\n\n[STEP BUDGET WARNING: Step ${step}/${effectiveMaxSteps}. Stop exploring immediately and complete all required file writes and your final summary now.]`
              : result,
        });
      }
    }

    log(`Reached maxSteps=${effectiveMaxSteps}; requesting final tool-free synthesis...`);
    messages.push({
      role: "user",
      content: `You have reached the ${effectiveMaxSteps}-step tool limit. Without calling any tools, deliver your complete final report and Local Build Summary now.`,
    });
    const synthRes = await chatCompletion({ messages, tools: null, model, baseUrl, onLog: log });
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
    // ignore if no upstream or not git repo
  }

  let pytestSummary = "(no .venv/bin/pytest found)";
  const pytestBin = path.join(resolvedCwd, ".venv", "bin", "pytest");
  if (fs.existsSync(pytestBin)) {
    try {
      pytestSummary = execFileSync(pytestBin, ["-q"], { cwd: resolvedCwd, encoding: "utf8" }).trim();
    } catch (err) {
      pytestSummary = `FAILED:\n${(err.stdout || "") + (err.stderr || "")}`.trim();
    }
  }

  const thermal = getThermalStatus();
  const completed = recentJobs.filter((j) => j.status === "completed");
  const running = recentJobs.filter((j) => j.status === "running");
  const failed = recentJobs.filter((j) => j.status === "failed" || j.status === "cancelled");

  const lines = [
    `# ${hours}-Hour Local Build & GitHub Triage Digest`,
    `Generated: ${new Date().toISOString()}`,
    `Target Repo: ${resolvedCwd}`,
    `Thermal Status: ${thermal.mode} (${thermal.policy})`,
    "",
    `## 1. Local Git & Test Gate`,
    "```",
    gitBranchStatus || "(clean)",
    gitDiffStat ? `\nDiff Stat:\n${gitDiffStat}` : "",
    unpushedCommits ? `\nLocal Unpushed Commits:\n${unpushedCommits}` : "\nLocal Unpushed Commits: (none)",
    "```",
    `**Local Test Suite:** \`${pytestSummary.replace(/\n/g, " | ")}\``,
    "",
    `## 2. Inkling Jobs in Last ${hours}h (${completed.length} completed, ${running.length} running, ${failed.length} failed/cancelled)`,
  ];

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
