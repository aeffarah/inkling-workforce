# Swarm Org — Concierge (Inkling Local Workforce)

## CEO → Leadership → Specialist Bench
- **CEO:** Antigravity (5-hour review digest & founder sign-off gate; owns all GitHub actions)
- **Leadership:** `chief-of-staff`, `product-manager`
- **Specialist Bench:**
  - `eval-capture-engineer` — capture dataset & scorer (`evals/capture/`), prompts (`prompts/`), swappable LM Studio + Anthropic Haiku `CaptureProvider` → validated `TaskDraft` JSON
  - `backend-platform-engineer` — FastAPI endpoints (`src/concierge/web.py`), SQLite store (`store.py`), deterministic planner/recurrence/rollover (`planner.py`), Prefect scheduled flows
  - `pwa-frontend-engineer` — zero-build offline PWA in `src/concierge/static/` (manifest, service worker, IndexedDB/localStorage queue + sync, one-tap edits)
  - `qa-gatekeeper` — `.venv/bin/pytest -q` + capture evals, `git diff` & secret/IP hygiene, `BIBLE.md` enforcement, Local Build Summary for founder sign-off

## Thermal & Concurrency Protocol (Mac Protection)
- **Single-Flight LM Studio (`concurrency = 1`):** Enforced via `~/.inkling-workforce/inference.lock` — workers never stack concurrent GPU calls.
- **Hourly Thermal Break (45m on / 15m off):** Runtime enforces 45 minutes max active work followed by a mandatory 15-minute cooldown break (`~/.inkling-workforce/thermal.json`).
- **Micro-Breathers:** 4s pause between every tool step + 30s pause between `loop` backlog items.
- **Sequential Waves:** Evals/Schemas → Capture/Backend → Offline PWA → QA Gatekeeper.

## 5-Hour CEO Digest & BIBLE.md Gate (Zero Unapproved GitHub Updates)
1. Workers build & verify strictly locally (`.venv/bin/pytest -q` + capture evals).
2. Every ~5 hours, CEO runs `cli.mjs digest` / `qa-gatekeeper` and presents Andrew with **Push-Ready vs. Hold-Local** summaries.
3. Only work explicitly signed off by Andrew is ever pushed or opened as a PR on GitHub.
