# THE BIBLE — Swarm Governance, Thermal Protection & Release Law

This document is the supreme operating law for the CEO (Antigravity), Chief of Staff, Product Manager, and every Inkling worker agent.

## 1. Zero Unapproved GitHub Updates (Absolute Rule)
- **NOTHING ever updates to GitHub (`git push`, `gh pr create`, `gh pr merge`, `gh repo`, `gh release`, remote tag/branch mutations) while the swarm is active without notifying Andrew and receiving explicit sign-off.**
- Only **production-ready, locally verified, founder-approved** work enters GitHub — across both application repos (`concierge`) and infrastructure repos (`inkling-workforce`).
- The Inkling runtime (`src/agent.mjs`) enforces this at the code level by hard-blocking remote Git/GitHub mutation commands.

## 2. Thermal Protection & Anti-Burnout Law (Mac Hardware Health)
To prevent sustained GPU/CPU overheating during 24/7 autonomous runs, the runtime enforces:
- **Closed-Loop macOS Thermal Sensor (`NSProcessInfo.thermalState`):** Checked before every step. If macOS reports `serious` (`2/3`) or `critical` (`3/3`) heat, all workers pause immediately for a 10-minute cooldown break until hardware temp drops. If `fair` (`1/3`, warm), inter-step breathers automatically stretch from **8s → 18s**.
- **Strict Single-Flight Lock (`max concurrency = 1`):** Only **one** LLM inference request may hit LM Studio at a time across the entire machine (`~/.inkling-workforce/inference.lock`).
- **20m Work / 10m Break Pomodoro Duty Cycle (20m rest/hr):** After every **20 minutes** of active runtime (`INKLING_WORK_MINUTES=20`), workers automatically pause for a **10-minute cooldown break** (`INKLING_BREAK_MINUTES=10`) so heat soak never builds up.
- **Generous Breathers:** **8 seconds** (`INKLING_STEP_COOLDOWN_MS=8000`) between every LLM step and **60 seconds** (`INKLING_TASK_COOLDOWN_SEC=60`) between backlog tasks, plus `nice -n 15` background scheduling priority.

## 3. Every 4–6 Hours: CEO Triage & GitHub Sign-Off Gate
Every ~5 hours while autonomous work is running (`cli.mjs digest` + standing CEO schedule):
1. **Build & Verify Locally:** Workers implement changes locally and run test suites (`.venv/bin/pytest -q`) and evals (`evals/`).
2. **5-Hour CEO Digest:** The CEO audits completed jobs, runs `qa-gatekeeper` / `cli.mjs digest`, and presents Andrew with a structured **GitHub Triage Summary**:
   - **Completed & Verified (Candidates for GitHub PR/Push):** Plain-English summary, files touched (`git diff --stat`), exact test & eval pass/fail counts.
   - **In-Progress / Hold Local:** Incomplete, failing, or experimental work that stays strictly local.
3. **Founder Sign-Off:** Andrew decides item-by-item what gets pushed/PR'd to GitHub and what stays local.

## 4. Product & Engineering Tenets (for `concierge`)
- **State lives in SQLite, never chat history.**
- **AI parses and explains; deterministic Python code decides priority ordering.**
- **Capture speed is sacred** (≤ 3s user effort) and tone is **kind, not naggy** (rest is a first-class plan).
- **Prompts are code** (`prompts/`) and **evals gate changes** (`evals/`).
- **Strict IP & Secret Hygiene:** Personal project only — never copy external employer code/patterns; never commit secrets (`.env` stays git-ignored).
