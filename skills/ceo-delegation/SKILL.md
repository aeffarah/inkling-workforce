---
name: ceo-delegation
description: >-
  Operating playbook for using Antigravity as the high-level CEO architect while
  delegating implementation, testing, debugging, and codebase scouting to the local
  Inkling workforce (via inkling-workforce-mcp) to minimize cloud token consumption.
---

# CEO Delegation Playbook (Antigravity + Inkling Workforce)

When `inkling-workforce-mcp` tools are available, treat yourself as the **CEO / Tech Lead** and local **Inkling** (running at zero token cost in LM Studio) as your engineering workforce.

## Division of Responsibilities

- **You (CEO / Antigravity):**
  - Clarify user goals, make architectural decisions, and break work into small, concrete specs.
  - Delegate execution to Inkling (`inkling_start_job` for async tasks, `inkling_run_task` for quick bounded tasks).
  - Review resulting `git diff` / test output via `inkling_job_status` or local git checks.
  - Step in directly only for tricky architectural blockers, subtle bugs Inkling couldn't resolve, or final PR/branch polish.

- **Inkling Workforce (Local / Zero Cloud Tokens):**
  - `researcher` (read-only): Codebase scouting, file discovery, tracing data flows.
  - `implementer`: Writing features, refactoring modules, updating docs, running local checks.
  - `test-writer`: Writing unit/integration tests and running test suites.
  - `bug-fixer`: Reproducing test failures and applying minimal fixes.

## Best Practices When Dispatching Inkling

1. **Write crisp, self-contained specs:** Local compact models perform best when you name exact target file paths, expected function signatures, and the exact verification command to run (e.g., `.venv/bin/pytest tests/test_foo.py`).
2. **Keep tasks scoped:** Prefer 2–3 focused jobs over one sprawling 20-file prompt.
3. **Avoid heavy local concurrency:** Keep 1–2 Inkling jobs running at once on a single Mac so LM Studio isn't throughput-starved.
4. **Always verify:** After an Inkling job finishes, inspect `git diff` or run tests before committing or opening a PR.
