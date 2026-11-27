#!/opt/homebrew/opt/node@24/bin/node
import fs from "node:fs";
import path from "node:path";
import {
  BREAK_MINUTES,
  DEFAULT_BASE_URL,
  DEFAULT_MODEL,
  DEFAULT_ROLE,
  MODEL_ALIASES,
  STEP_COOLDOWN_MS,
  TASK_COOLDOWN_SEC,
  WORK_WINDOW_MINUTES,
  clearExceptions,
  enforceThermalPolicy,
  generateBenchmark,
  generateDigest,
  getGitShortStatus,
  getThermalStatus,
  listJobs,
  listModels,
  listOpenExceptions,
  listRoles,
  loadJobMeta,
  recordException,
  resetThermalState,
  runAgent,
  runDeterministicTests,
  sleep,
  tailJobLog,
  triggerThermalBreak,
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

function printHelp() {
  console.log(`Inkling Workforce CLI v0.4 (6-Layer Agentic Runtime | LM Studio: ${DEFAULT_BASE_URL})
Model Aliases: worker=${MODEL_ALIASES.worker} | quality=${MODEL_ALIASES.quality} | fast=${MODEL_ALIASES.fast}
Thermal Policy: ${WORK_WINDOW_MINUTES}m work / ${BREAK_MINUTES}m break | ${STEP_COOLDOWN_MS}ms step breather | ${TASK_COOLDOWN_SEC}s between loop tasks

Commands:
  run "<task>"          Run a single autonomous Inkling worker task (SQLite checkpointed)
    --cwd <dir>         Target project directory (default: current directory)
    --role <name>       Worker role from roles/ (default: ${DEFAULT_ROLE})
    --model <alias|id>  Model alias (worker|quality|fast|alt) or ID (default: worker)
    --max-steps <n>     Max tool-calling steps (default: role's max_steps)
    --read-only         Force read-only mode
    --resume <job_id>   Resume an interrupted job from its last SQLite checkpoint!

  loop <backlog.md>     24/7 sequential worker with SQLite auto-resume & deterministic pytest gate
    --cwd <dir>         Target project directory (default: current directory)
    --role <name>       Default worker role (default: ${DEFAULT_ROLE})
    --model <alias|id>  Model alias or ID (default: worker)
    --continue-on-error Do not pause sequential backlog when an item hits the Exception Queue

  exceptions [clear]    View (or clear) the Layer 1 Exception Queue
  thermal [action]      status (default) | break [minutes] | reset
  digest                Generate a 5h Local Build, Exception & GitHub Sign-Off Digest
  benchmark             Show SQLite LLM gateway traces & swarm telemetry
  roles                 List defined worker roles in roles/
  models                List models currently available on LM Studio
  status [job_id]       Show recent jobs or inspect a specific job + tail log
`);
}

async function runBacklogLoop(backlogPath, { cwd, defaultRole, model, maxSteps, intervalSec, continueOnError }) {
  const resolvedBacklog = path.resolve(backlogPath);
  if (!fs.existsSync(resolvedBacklog)) {
    console.error(`Backlog file not found: ${resolvedBacklog}`);
    process.exit(1);
  }

  console.log(`[loop] Watching ${resolvedBacklog}`);
  console.log(
    `[loop] cwd=${path.resolve(cwd)} | defaultRole=${defaultRole} | model=${model} | thermal=${WORK_WINDOW_MINUTES}m/${BREAK_MINUTES}m`
  );

  while (true) {
    const content = fs.readFileSync(resolvedBacklog, "utf8");
    const lines = content.split("\n");

    // Layer 2 & 5: Halt sequential pipeline if an earlier item is marked [!] (unresolved exception) unless --continue-on-error
    if (!continueOnError && lines.some((l) => /^\s*-\s*\[!\]\s+/.test(l))) {
      await sleep(intervalSec * 1000);
      continue;
    }

    const idx = lines.findIndex((l) => /^\s*-\s*\[\s\]\s+/.test(l));
    if (idx === -1) {
      await sleep(intervalSec * 1000);
      continue;
    }

    await enforceThermalPolicy((m) => console.log(`[loop] ${m}`));

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

    const beforeGit = getGitShortStatus(cwd);
    let job = await runAgent({
      task: taskText,
      cwd,
      role: taskRole,
      model,
      maxSteps,
      onLog: (m) => console.log(`  ${m}`),
    });

    // Layer 2 Auto-Resume: If interrupted at step >= 2 by a transient error, resume once from SQLite checkpoint!
    if (job.status !== "completed" && job.step >= 2) {
      console.log(`[loop] Auto-resuming interrupted job ${job.id} from SQLite checkpoint (step ${job.step})...`);
      await sleep(10_000);
      job = await runAgent({
        resumeJobId: job.id,
        cwd,
        role: taskRole,
        model,
        maxSteps,
        onLog: (m) => console.log(`  ${m}`),
      });
    }

    // Layer 5 Deterministic Verification Gate
    const testRes = runDeterministicTests(cwd);
    const afterGit = getGitShortStatus(cwd);
    let gateError = null;
    if (job.status !== "completed") {
      gateError = job.error || "job failed";
    } else if (testRes.ran && !testRes.ok) {
      gateError = "pytest suite failed post-check";
      recordException({ jobId: job.id, role: taskRole, cwd, task: taskText, reason: gateError });
    } else if (!job.readOnly && taskRole !== "qa-gatekeeper" && beforeGit === afterGit && !afterGit) {
      gateError = "no files were created or modified";
      recordException({ jobId: job.id, role: taskRole, cwd, task: taskText, reason: gateError });
    }

    const latestLines = fs.readFileSync(resolvedBacklog, "utf8").split("\n");
    const currentIdx = latestLines.findIndex((l) => l.includes(taskText.slice(0, 40)) && l.includes("- [~]"));
    const targetIdx = currentIdx !== -1 ? currentIdx : idx;

    if (!gateError) {
      latestLines[targetIdx] = latestLines[targetIdx].replace("- [~]", "- [x]") + ` _(role: ${taskRole}, job: ${job.id})_`;
      console.log(`[loop] Task verified & completed (${job.id}). Cooling ${TASK_COOLDOWN_SEC}s before next item...`);
    } else {
      latestLines[targetIdx] =
        latestLines[targetIdx].replace("- [~]", "- [!]") + ` _(blocked: ${gateError} | job: ${job.id})_`;
      console.log(`[loop] Task routed to Exception Queue (${job.id}): ${gateError}.`);
    }
    fs.writeFileSync(resolvedBacklog, latestLines.join("\n"), "utf8");

    if (TASK_COOLDOWN_SEC > 0) {
      await sleep(TASK_COOLDOWN_SEC * 1000);
    }
  }
}

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const cmd = positional[0];

  if (!cmd || cmd === "help" || flags.help) {
    printHelp();
    return;
  }

  if (cmd === "exceptions") {
    if (positional[1] === "clear") {
      clearExceptions();
      console.log("Cleared open exceptions.");
      return;
    }
    const ex = listOpenExceptions(25);
    console.log(ex.length ? JSON.stringify(ex, null, 2) : "No open exceptions.");
    return;
  }

  if (cmd === "thermal") {
    const sub = positional[1] || "status";
    if (sub === "break") {
      console.log(JSON.stringify(triggerThermalBreak(Number(positional[2]) || BREAK_MINUTES), null, 2));
    } else if (sub === "reset") {
      console.log(JSON.stringify(resetThermalState(), null, 2));
    } else {
      console.log(JSON.stringify(getThermalStatus(), null, 2));
    }
    return;
  }

  if (cmd === "digest") {
    console.log(
      generateDigest({
        cwd: flags.cwd || process.cwd(),
        hours: Number(flags.hours) || 5,
      }) +
        "\n\n" +
        generateBenchmark()
    );
    return;
  }

  if (cmd === "benchmark") {
    console.log(generateBenchmark());
    return;
  }

  if (cmd === "roles") {
    for (const r of listRoles()) {
      console.log(`${r.name.padEnd(26)} | ${r.readOnly ? "read-only " : "read-write"} | maxSteps=${String(r.maxSteps).padEnd(3)} | ${r.description}`);
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
      console.log(JSON.stringify({ ...job, thermal: getThermalStatus() }, null, 2));
      console.log("\n--- Recent Log ---");
      console.log(tailJobLog(jobId, 30));
    } else {
      console.log("Thermal:", JSON.stringify(getThermalStatus()));
      const jobs = listJobs(15);
      if (!jobs.length) {
        console.log("No jobs yet.");
        return;
      }
      for (const j of jobs) {
        console.log(`${j.id} | ${j.status.padEnd(9)} | ${(j.role || "-").padEnd(22)} | step ${j.step}/${j.maxSteps} | ${j.task.slice(0, 55)}`);
      }
    }
    return;
  }

  if (cmd === "run") {
    const task = positional.slice(1).join(" ").trim();
    if (!task && !flags.resume) {
      console.error("Error: missing task description (or --resume <job_id>).");
      process.exit(1);
    }
    const job = await runAgent({
      task,
      cwd: flags.cwd || process.cwd(),
      role: flags.role || DEFAULT_ROLE,
      model: flags.model || "worker",
      baseUrl: flags["base-url"] || DEFAULT_BASE_URL,
      maxSteps: flags["max-steps"] ? Number(flags["max-steps"]) : null,
      readOnly: flags["read-only"] ? true : null,
      jobId: flags["job-id"] || null,
      resumeJobId: flags.resume || null,
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
      model: flags.model || "worker",
      maxSteps: flags["max-steps"] ? Number(flags["max-steps"]) : null,
      intervalSec: Number(flags.interval) || 30,
      continueOnError: Boolean(flags["continue-on-error"]),
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
