#!/opt/homebrew/opt/node@24/bin/node
import { spawn } from "node:child_process";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_BASE_URL,
  DEFAULT_MODEL,
  DEFAULT_ROLE,
  chatCompletion,
  getGitShortStatus,
  listJobs,
  listModels,
  listRoles,
  loadJobMeta,
  loadRole,
  newJobId,
  runAgent,
  saveJobMeta,
  tailJobLog,
} from "./agent.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_PATH = path.join(__dirname, "cli.mjs");

const TOOLS = [
  {
    name: "inkling_list_models",
    description: "List local models currently available on LM Studio.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "inkling_list_roles",
    description: "List available Inkling worker role definitions (implementer, test-writer, bug-fixer, researcher, etc.).",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "inkling_ask",
    description: "Send a fast single-turn prompt to local Inkling (no tools, zero cloud tokens).",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "Prompt for Inkling" },
        system: { type: "string", description: "Optional system prompt" },
        model: { type: "string", description: `Model ID (default: ${DEFAULT_MODEL})` },
      },
      required: ["prompt"],
    },
  },
  {
    name: "inkling_start_job",
    description: "Launch an autonomous Inkling worker agent in the background on any workspace directory. Returns a job_id immediately.",
    inputSchema: {
      type: "object",
      properties: {
        task: { type: "string", description: "Clear, self-contained task specification for Inkling" },
        cwd: { type: "string", description: "Absolute path to the target project workspace directory" },
        role: { type: "string", description: `Worker role name from roles/ (default: ${DEFAULT_ROLE})` },
        model: { type: "string", description: `Model ID (default: ${DEFAULT_MODEL})` },
        max_steps: { type: "integer", description: "Optional override for max tool-calling steps" },
        read_only: { type: "boolean", description: "Optional override to force read-only mode" },
      },
      required: ["task", "cwd"],
    },
  },
  {
    name: "inkling_run_task",
    description: "Run an Inkling worker agent synchronously and wait for its final report (best for short tasks).",
    inputSchema: {
      type: "object",
      properties: {
        task: { type: "string", description: "Clear task specification for Inkling" },
        cwd: { type: "string", description: "Absolute path to the target project workspace directory" },
        role: { type: "string", description: `Worker role name from roles/ (default: ${DEFAULT_ROLE})` },
        model: { type: "string", description: `Model ID (default: ${DEFAULT_MODEL})` },
        max_steps: { type: "integer", description: "Optional override for max tool-calling steps" },
        read_only: { type: "boolean", description: "Optional override to force read-only mode" },
      },
      required: ["task", "cwd"],
    },
  },
  {
    name: "inkling_job_status",
    description: "Check status, recent logs, summary, and git status for an Inkling job.",
    inputSchema: {
      type: "object",
      properties: {
        job_id: { type: "string", description: "Job ID returned by inkling_start_job" },
        log_lines: { type: "integer", description: "Number of recent log lines to include (default: 30)" },
      },
      required: ["job_id"],
    },
  },
  {
    name: "inkling_list_jobs",
    description: "List recent and currently running Inkling background jobs.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "integer", description: "Max jobs to return (default: 15)" },
      },
    },
  },
  {
    name: "inkling_cancel_job",
    description: "Cancel a running Inkling background job by sending SIGTERM to its process.",
    inputSchema: {
      type: "object",
      properties: {
        job_id: { type: "string", description: "Job ID to cancel" },
      },
      required: ["job_id"],
    },
  },
];

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

function textResult(text, isError = false) {
  return { content: [{ type: "text", text: String(text) }], isError };
}

async function handleToolCall(name, args = {}) {
  switch (name) {
    case "inkling_list_models": {
      const models = await listModels(DEFAULT_BASE_URL);
      return textResult(
        `LM Studio (${DEFAULT_BASE_URL}) | Default: ${DEFAULT_MODEL}\nModels:\n- ${models.join("\n- ")}`
      );
    }

    case "inkling_list_roles": {
      const roles = listRoles().map((r) => ({
        name: r.name,
        description: r.description,
        readOnly: r.readOnly,
        maxSteps: r.maxSteps,
      }));
      return textResult(JSON.stringify(roles, null, 2));
    }

    case "inkling_ask": {
      const messages = [];
      if (args.system) messages.push({ role: "system", content: String(args.system) });
      messages.push({ role: "user", content: String(args.prompt) });
      const res = await chatCompletion({
        messages,
        model: args.model || DEFAULT_MODEL,
        baseUrl: DEFAULT_BASE_URL,
      });
      const content = res.choices?.[0]?.message?.content || "(empty response)";
      return textResult(content);
    }

    case "inkling_start_job": {
      const roleDef = loadRole(args.role || DEFAULT_ROLE);
      const effectiveMaxSteps = Number(args.max_steps) || roleDef.maxSteps;
      const effectiveReadOnly = args.read_only !== undefined ? Boolean(args.read_only) : roleDef.readOnly;

      const jobId = newJobId();
      const cliArgs = [
        CLI_PATH,
        "run",
        String(args.task),
        "--cwd",
        String(args.cwd),
        "--role",
        roleDef.name,
        "--model",
        String(args.model || DEFAULT_MODEL),
        "--max-steps",
        String(effectiveMaxSteps),
        "--job-id",
        jobId,
      ];
      if (effectiveReadOnly) cliArgs.push("--read-only");

      const child = spawn(process.execPath, cliArgs, {
        detached: true,
        stdio: "ignore",
        env: process.env,
      });
      child.unref();

      saveJobMeta({
        id: jobId,
        status: "running",
        pid: child.pid,
        role: roleDef.name,
        model: args.model || DEFAULT_MODEL,
        baseUrl: DEFAULT_BASE_URL,
        cwd: path.resolve(String(args.cwd)),
        readOnly: effectiveReadOnly,
        task: String(args.task),
        maxSteps: effectiveMaxSteps,
        step: 0,
        startedAt: new Date().toISOString(),
        finishedAt: null,
        summary: null,
        error: null,
        gitStatus: "",
      });

      return textResult(
        JSON.stringify(
          {
            job_id: jobId,
            pid: child.pid,
            status: "running",
            role: roleDef.name,
            model: args.model || DEFAULT_MODEL,
            cwd: path.resolve(String(args.cwd)),
          },
          null,
          2
        )
      );
    }

    case "inkling_run_task": {
      const job = await runAgent({
        task: String(args.task),
        cwd: String(args.cwd),
        role: args.role || DEFAULT_ROLE,
        model: args.model || DEFAULT_MODEL,
        baseUrl: DEFAULT_BASE_URL,
        maxSteps: args.max_steps ? Number(args.max_steps) : null,
        readOnly: args.read_only !== undefined ? Boolean(args.read_only) : null,
      });
      return textResult(JSON.stringify(job, null, 2), job.status !== "completed");
    }

    case "inkling_job_status": {
      const job = loadJobMeta(String(args.job_id));
      if (!job) return textResult(`Job not found: ${args.job_id}`, true);
      const liveGit = job.cwd ? getGitShortStatus(job.cwd) : "";
      const recentLog = tailJobLog(job.id, Number(args.log_lines) || 30);
      return textResult(
        JSON.stringify({ ...job, liveGitStatus: liveGit }, null, 2) +
          (recentLog ? `\n\n--- Recent Log ---\n${recentLog}` : "")
      );
    }

    case "inkling_list_jobs": {
      const jobs = listJobs(Number(args.limit) || 15).map((j) => ({
        id: j.id,
        status: j.status,
        role: j.role,
        step: `${j.step}/${j.maxSteps}`,
        model: j.model,
        cwd: j.cwd,
        startedAt: j.startedAt,
        task: j.task.slice(0, 120),
      }));
      return textResult(JSON.stringify(jobs, null, 2));
    }

    case "inkling_cancel_job": {
      const job = loadJobMeta(String(args.job_id));
      if (!job) return textResult(`Job not found: ${args.job_id}`, true);
      if (job.status !== "running") {
        return textResult(`Job ${job.id} is already ${job.status}.`);
      }
      try {
        process.kill(job.pid, "SIGTERM");
      } catch {
        // Process may already have exited
      }
      job.status = "cancelled";
      job.finishedAt = new Date().toISOString();
      saveJobMeta(job);
      return textResult(`Cancelled job ${job.id} (pid ${job.pid}).`);
    }

    default:
      return textResult(`Unknown tool: ${name}`, true);
  }
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

rl.on("line", async (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;

  let req;
  try {
    req = JSON.parse(trimmed);
  } catch {
    return;
  }

  const { id, method, params } = req;
  if (id === undefined || id === null) return;

  try {
    if (method === "initialize") {
      send({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: params?.protocolVersion || "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "inkling-workforce-mcp", version: "0.1.0" },
        },
      });
    } else if (method === "ping") {
      send({ jsonrpc: "2.0", id, result: {} });
    } else if (method === "tools/list") {
      send({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
    } else if (method === "tools/call") {
      const result = await handleToolCall(params?.name, params?.arguments);
      send({ jsonrpc: "2.0", id, result });
    } else {
      send({
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: `Method not found: ${method}` },
      });
    }
  } catch (err) {
    send({
      jsonrpc: "2.0",
      id,
      error: { code: -32000, message: err.message || String(err) },
    });
  }
});
