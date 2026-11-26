# inkling-workforce

Zero-dependency **Local Agent Swarm & Antigravity MCP Plugin** powered by **Thinking Machines Lab's Inkling** (`inkling-2-mini`) running locally in LM Studio.

Built for a **Token-Efficient CEO → Local Workforce** architecture:
- **Cloud CEO (Google Antigravity):** High-level architecture, product direction, code review, 5-hour triage digests, and human-gated GitHub releases.
- **Local Workforce (Inkling via LM Studio):** 24/7 **$0-token** autonomous implementation, eval generation, testing, debugging, and codebase scouting across any repository — protected by closed-loop macOS hardware thermal management.

---

## Key Features
- **10 Versioned Specialist Roles (`roles/*.md`):**
  - *Leadership:* `chief-of-staff`, `product-manager`
  - *Engineering & QA:* `implementer`, `eval-capture-engineer`, `backend-platform-engineer`, `pwa-frontend-engineer`, `test-writer`, `bug-fixer`, `researcher` (read-only), `qa-gatekeeper`
- **Hardware-Closed-Loop Thermal Anti-Burnout (`src/agent.mjs`):**
  - Queries macOS `NSProcessInfo.thermalState` before every LLM step (`8s` breather when `nominal`, `18s` when `fair`/warm, immediate `10m` pause if `serious`/`critical`).
  - Enforces a **single-flight GPU lock** (`concurrency = 1`) and **20m work / 10m break** Pomodoro sprints so laptops never thermal-soak during 24/7 runs.
- **Hard Governance Guardrails (`BIBLE.md`):**
  - Runtime blocks `git push`, `gh pr`, and remote Git mutations inside worker shells — all work stays strictly local until verified and human-approved.
- **Benchmarked on Real Thinking-Model Workloads:** See [`ops/benchmarks/BASELINE_2026-11-26.md`](ops/benchmarks/BASELINE_2026-11-26.md).

---

## 1. Link Globally into Antigravity

```bash
mkdir -p ~/.gemini/config/plugins
ln -s ~/Projects/inkling-workforce ~/.gemini/config/plugins/inkling-workforce
```

## 2. Standalone CLI & 24/7 Backlog Loop

```bash
# List roles or inspect live macOS thermal & duty-cycle state
./src/cli.mjs roles
./src/cli.mjs thermal

# Run a single autonomous task against any target repository
./src/cli.mjs run "Summarize the database schema" --cwd ~/Projects/my-app --role researcher

# Run an unattended 24/7 backlog grinder (keep private backlogs in git-ignored ops/local/)
./src/cli.mjs loop ops/local/BACKLOG.md --cwd ~/Projects/my-app

# Generate a 5-hour Local Build & GitHub Sign-Off Digest + live telemetry benchmark
./src/cli.mjs digest --cwd ~/Projects/my-app --hours 5
./src/cli.mjs benchmark
```

Example `BACKLOG.md` checklist with per-task role routing:

```markdown
- [ ] [role:researcher] Audit src/ for missing type annotations
- [ ] [role:implementer] Add input validation to task creation endpoint
- [ ] [role:test-writer] Add unit tests covering recurring schedule edge cases
- [ ] [role:qa-gatekeeper] Run full test suite and compile Local Build Summary
```
