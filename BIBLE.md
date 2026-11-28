# THE BIBLE — Swarm Governance, Thermal Protection & CEO Release Law (v2.0)

This document is the supreme operating law for the CEO (Antigravity), Chief of Staff, Product Manager, and every Inkling worker agent.

## 1. Delegated CEO Release Authority & Worker Containment
- **Workers Stay Strictly Local-Only:** Inkling worker agents (`src/agent.mjs`) remain **hard-blocked at runtime** from running `git push`, `gh pr`, or any remote Git/GitHub mutation (`BLOCKED_REMOTE_PATTERNS`). Workers build, test, and report locally only.
- **CEO Production-Ready GitHub Authority:** The Founder delegates GitHub commit, branch push, and PR release authority to the **CEO (Antigravity)** to keep all repositories clean, current, and shipping — subject to mandatory quality gates before every push:
  1. **100% Green Verification Gate:** All unit tests, integration tests, eval checks, and syntax linters (`pytest`, `unittest`, `node --check`) must pass with zero regressions.
  2. **CEO Diff Audit:** Every staged diff must be inspected for cleanliness (zero dead code, zero stray `.db`/cache/temp files, zero broken builds).
  3. **Public-Repo Stealth Gate (Non-Negotiable):** Before any push to a **public** repo, verify **0** matches for secrets (`.env`, API keys), hardcoded local user paths, or private/stealth project references.
  4. **Zero Destructive Remotes:** Never force-push (`git push --force`), delete remote branches/repos, or rewrite published history without explicit founder confirmation.
  5. **Full Transparency:** Log every GitHub push in chat and in the 5-hour executive email digest.

## 2. Thermal Protection & Anti-Burnout Law (Mac Hardware Health)
To prevent sustained GPU/CPU overheating during 24/7 autonomous runs, the runtime enforces:
- **Closed-Loop macOS Thermal Sensor (`NSProcessInfo.thermalState`):** Checked before every step. If macOS reports `serious` (`2/3`) or `critical` (`3/3`) heat, all workers pause immediately for a 10-minute cooldown break until hardware temp drops. If `fair` (`1/3`, warm), inter-step breathers automatically stretch from **8s → 18s**.
- **Strict Single-Flight Lock (`max concurrency = 1`):** Only **one** LLM inference request may hit LM Studio at a time across the entire machine (`~/.inkling-workforce/inference.lock`).
- **20m Work / 10m Break Pomodoro Duty Cycle (20m rest/hr):** After every **20 minutes** of active runtime (`INKLING_WORK_MINUTES=20`), workers automatically pause for a **10-minute cooldown break** (`INKLING_BREAK_MINUTES=10`) so heat soak never builds up.
- **Generous Breathers:** **8 seconds** (`INKLING_STEP_COOLDOWN_MS=8000`) between every LLM step and **60 seconds** (`INKLING_TASK_COOLDOWN_SEC=60`) between backlog tasks.

## 3. Continuous Executive Cadence
- **Active CEO Supervision:** Review completed worker tasks promptly, unblock stalls/truncations, and keep durable state synced in git-ignored `ops/local/CEO_STATE.md`.
- **Every 5 Hours (Executive Digest):** Run `cli.mjs digest`, audit diffs and tests, ship verified production-ready work to GitHub, hold experimental/failing work local, and email a concise executive update.
- **Every Sunday (Weekly Optimization):** Audit all repositories for code redundancy, dead imports, prompt/context efficiency, and swarm telemetry improvements.

## 4. Public Repo & Stealth Hygiene
- `inkling-workforce` is a **public** framework repository: never commit hardcoded user home paths, secrets (`.env`), or private/stealth target-project specs (store private sprint backlogs under git-ignored `ops/local/`).
