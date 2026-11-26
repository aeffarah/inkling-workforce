#!/opt/homebrew/opt/node@24/bin/node
import fs from "node:fs";
import path from "node:path";
import {
  DEFAULT_BASE_URL,
  DEFAULT_MODEL,
  DEFAULT_ROLE,
  listJobs,
  listModels,
  listRoles,
  loadJobMeta,
  runAgent,
  tailJobLog,
} from "./agent.mjs";

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (!next || next.startsWith("--")) {
        flags[key] = true;
      } else {
        flags[key] = next;
        i++;
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function printHelp() {
  console.log(`Inkling Workforce CLI (LM Studio: ${DEFAULT_BASE_URL} | default model: ${DEFAULT_MODEL})

Commands:
  run "<task>"          Run a single autonomous Inkling worker task
    --cwd <dir>         Target project directory (default: current directory)
    --role <name>       Worker role from roles/ (default: ${DEFAULT_ROLE})
    --model <id>        LM Studio model ID (default: ${DEFAULT_MODEL})
    --max-steps <n>     Max tool-calling steps (default: role's max_steps)
    --read-only         Force read-only mode
    --job-id <id>       Optional explicit job ID

  loop <backlog.md>     24/7 unattended worker: polls a Markdown checklist for "- [ ] ..." tasks
                        Tip: prefix items with "[role:test-writer]" to pick a role per task!
    --cwd <dir>         Target project directory (default: current directory)
    --role <name>       Default worker role (default: ${DEFAULT_ROLE})
    --model <id>        LM Studio model ID (default: ${DEFAULT_MODEL})
    --max-steps <n>     Optional max steps override
    --interval <sec>    Poll interval when queue is empty (default: 30)

  roles                 List defined worker roles in roles/
  models                List models currently available on LM Studio
  status [job_id]       Show recent jobs or inspect a specific job + tail log
`);
}

async function runBacklogLoop(backlogPath, { cwd, defaultRole, model, maxSteps, intervalSec }) {
  const resolvedBacklog = path.resolve(backlogPath);
  if (!fs.existsSync(resolvedBacklog)) {
    console.error(`Backlog file not found: ${resolvedBacklog}`);
    process.exit(1);
  }

  console.log(`[loop] Watching ${resolvedBacklog}`);
  console.log(`[loop] cwd=${path.resolve(cwd)} | defaultRole=${defaultRole} | model=${model} | interval=${intervalSec}s`);

  while (true) {
    const content = fs.readFileSync(resolvedBacklog, "utf8");
    const lines = content.split("\n");
    const idx = lines.findIndex((l) => /^\s*-\s*\[\s\]\s+/.test(l));

    if (idx === -1) {
      await sleep(intervalSec * 1000);
      continue;
    }

    const rawLine = lines[idx];
    let taskText = rawLine.replace(/^\s*-\s*\[\s\]\s+/, "").trim();
    let taskRole = defaultRole;

    const roleTag = taskText.match(/^\[role:([a-z0-9_-]+)\]\s*/i);
    if (roleTag) {
      taskRole = roleTag[1];
      taskText = taskText.slice(roleTag[0].length).trim();
    }

    console.log(`\n[loop] Picked task (role=${taskRole}): ${taskText}`);

    lines[idx] = rawLine.replace("- [ ]", "- [~]");
    fs.writeFileSync(resolvedBacklog, lines.join("\n"), "utf8");

    const job = await runAgent({
      task: taskText,
      cwd,
      role: taskRole,
      model,
      maxSteps,
      onLog: (m) => console.log(`  ${m}`),
    });

    const latestLines = fs.readFileSync(resolvedBacklog, "utf8").split("\n");
    const currentIdx = latestLines.findIndex((l) => l.includes(taskText) && l.includes("- [~]"));
    const targetIdx = currentIdx !== -1 ? currentIdx : idx;

    if (job.status === "completed") {
      latestLines[targetIdx] = latestLines[targetIdx].replace("- [~]", "- [x]") + ` _(role: ${taskRole}, job: ${job.id})_`;
      console.log(`[loop] Task completed (${job.id}).`);
    } else {
      latestLines[targetIdx] =
        latestLines[targetIdx].replace("- [~]", "- [!]") + ` _(failed: ${job.error || "see log"} | job: ${job.id})_`;
      console.log(`[loop] Task failed (${job.id}): ${job.error}`);
    }
    fs.writeFileSync(resolvedBacklog, latestLines.join("\n"), "utf8");
  }
}

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const cmd = positional[0];

  if (!cmd || cmd === "help" || flags.help) {
    printHelp();
    return;
  }

  if (cmd === "roles") {
    for (const r of listRoles()) {
      console.log(`${r.name.padEnd(14)} | ${r.readOnly ? "read-only " : "read-write"} | maxSteps=${String(r.maxSteps).padEnd(3)} | ${r.description}`);
    }
    return;
  }

  if (cmd === "models") {
    const models = await listModels(flags["base-url"] || DEFAULT_BASE_URL);
    console.log(models.join("\n"));
    return;
  }

  if (cmd === "status") {
    const jobId = positional[1];
    if (jobId) {
      const job = loadJobMeta(jobId);
      if (!job) {
        console.error(`Job not found: ${jobId}`);
        process.exit(1);
      }
      console.log(JSON.stringify(job, null, 2));
      console.log("\n--- Recent Log ---");
      console.log(tailJobLog(jobId, 30));
    } else {
      const jobs = listJobs(15);
      if (!jobs.length) {
        console.log("No jobs yet.");
        return;
      }
      for (const j of jobs) {
        console.log(`${j.id} | ${j.status.padEnd(9)} | ${(j.role || "-").padEnd(12)} | step ${j.step}/${j.maxSteps} | ${j.task.slice(0, 60)}`);
      }
    }
    return;
  }

  if (cmd === "run") {
    const task = positional.slice(1).join(" ").trim();
    if (!task) {
      console.error("Error: missing task description.");
      process.exit(1);
    }
    const job = await runAgent({
      task,
      cwd: flags.cwd || process.cwd(),
      role: flags.role || DEFAULT_ROLE,
      model: flags.model || DEFAULT_MODEL,
      baseUrl: flags["base-url"] || DEFAULT_BASE_URL,
      maxSteps: flags["max-steps"] ? Number(flags["max-steps"]) : null,
      readOnly: flags["read-only"] ? true : null,
      jobId: flags["job-id"] || null,
      onLog: (m) => console.error(m),
    });
    console.log(JSON.stringify(job, null, 2));
    if (job.status !== "completed") process.exit(1);
    return;
  }

  if (cmd === "loop") {
    const backlogPath = positional[1];
    if (!backlogPath) {
      console.error("Error: provide a path to a Markdown backlog file (e.g. BACKLOG.md).");
      process.exit(1);
    }
    await runBacklogLoop(backlogPath, {
      cwd: flags.cwd || process.cwd(),
      defaultRole: flags.role || DEFAULT_ROLE,
      model: flags.model || DEFAULT_MODEL,
      maxSteps: flags["max-steps"] ? Number(flags["max-steps"]) : null,
      intervalSec: Number(flags.interval) || 30,
    });
    return;
  }

  console.error(`Unknown command: ${cmd}`);
  printHelp();
  process.exit(1);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
