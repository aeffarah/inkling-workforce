# Concierge — Sprint 1 Product Plan & Executable Backlog

_Authored by CEO + Product Manager | Status: **Draft awaiting Founder Sign-Off** (Zero changes made to `concierge` yet)_

---

## 1. Current State Diagnosis (Why `concierge` Needs Sprint 1)

`concierge` currently has a clean, minimal **walking skeleton** (`models.py`, `store.py`, `planner.py`, `web.py`, `cli.py`, `static/index.html`, and **16 passing `pytest` tests**).

However, **dogfooding hit an immediate wall** (`docs/STATUS.md`):
1. **Every captured phrase ties at `2.0` and triggers false "Rest Days":**
   - `static/index.html` currently posts `{ "title": "..." }` directly to `POST /api/tasks`.
   - With no AI parser yet, every task defaults to `deadline=None`, `urgency="normal"`, `effort="medium"`.
   - In `planner.py`, `score()` gives `0.0 + 2.0 + 0.0 = 2.0` to all of them, and `plan_today()` filters out tasks without due dates on `low` energy (due ≤ 1d) and only includes `quick` tasks on `okay` energy — so typing `"Doctors appointment"`, `"Dentist appointment"`, `"deposit cash at bank"`, or `"schedule eye exam"` tells you `"Nothing needs you today. Rest is the plan."` on both Low and Okay days!
2. **Missing MVP Loops (`docs/product/MVP_SPEC.md`):**
   - **C1 / Eval-Gated Capture:** No eval dataset/scorer yet (`evals/capture/` only has 4 raw phrases) and no swappable AI parser (`prompts/` + local LM Studio / cloud Haiku `CaptureProvider`) turning messy phrases into structured `TaskDraft`s (e.g. `"Doctors appointment"` → `"Book doctor's appointment"`, `effort="quick"`).
   - **C2 / T2 / A1 Controls:** Web UI & API cannot yet edit parsed fields (`PATCH /api/tasks/{id}`), delete (`DELETE /api/tasks/{id}`), or pull/push tasks onto/off Today.
   - **C3 / Installable Offline PWA:** `static/index.html` has no `manifest.webmanifest`, app icons, service worker, or offline capture queue that syncs when connectivity returns.

---

## 2. Sequenced Sprint 1 Backlog (Ready for `cli.mjs loop`)

Ordered strictly by dependency (**Evals → Capture Engine → API & Store → Offline PWA → QA Gatekeeper**). Nothing pushes to GitHub per [`BIBLE.md`](../../BIBLE.md).

- [ ] [role:eval-capture-engineer] Build the deterministic Capture Eval Harness in `evals/capture/`: expand `cases.jsonl` to 30 realistic messy phrases (incorporating the 4 seeds in `raw_phrases.txt`) with expected `TaskDraft` fields (`title`, `effort`, `urgency`, relative `deadline_offset_days`, `deadline_kind`, `recurrence`) and create `src/concierge/eval_capture.py` + `tests/test_eval_capture.py` scoring field accuracy without requiring an API key. Verified by `.venv/bin/pytest -q`.
- [ ] [role:eval-capture-engineer] Implement swappable `CaptureProvider` (`src/concierge/capture.py`) + versioned prompt (`prompts/capture_v1.txt`) supporting both **Local OpenAI-compatible LM Studio** (`CONCIERGE_LLM_PROVIDER=local`, `http://localhost:1235/v1`) and **Anthropic Haiku** (`CONCIERGE_LLM_PROVIDER=anthropic`) with deterministic fallback if offline/unconfigured, plus unit tests in `tests/test_capture.py` and baseline eval score against local LM Studio (`≥90%` schema validity).
- [ ] [role:backend-platform-engineer] Extend `TaskStore` (`src/concierge/store.py`) and FastAPI (`src/concierge/web.py`) with `POST /api/capture` (plain text → `CaptureProvider` → saved `Task` + full fields), `PATCH /api/tasks/{task_id}` (one-tap edits to `title`, `urgency`, `effort`, `deadline`, `deadline_kind`, `status`/`snoozed`), and `DELETE /api/tasks/{task_id}`, returning full task metadata alongside `score` and `reason`. Add full `TestClient` coverage in `tests/test_web.py`.
- [ ] [role:pwa-frontend-engineer] Upgrade `src/concierge/static/index.html` (preserving the exact warm minimalist light/dark aesthetic) to call `/api/capture`, display a subtle 1-line parsed-field pill strip under newly captured/listed tasks for C2 one-tap corrections (`quick/medium/big`, `low/normal/high`, due date, delete), and persist selected daily energy in `localStorage` for today's date (D1).
- [ ] [role:pwa-frontend-engineer] Turn `src/concierge` into an installable Offline-First PWA (C3): serve `/manifest.webmanifest`, `/sw.js`, and SVG/PNG icons from `src/concierge/static/` + `web.py`; cache the app shell for offline startup; queue offline task captures in `localStorage`/`IndexedDB` with an unobtrusive `"Queued offline — will sync"` badge and auto-flush to `/api/capture` on `online` / load. Add endpoint tests for manifest & service worker headers.
- [ ] [role:backend-platform-engineer] Implement MVP Time Rules (`R1`–`R3`) in pure testable functions (`src/concierge/rules.py` + `store.py` support + `tests/test_rules.py`): basic recurrence regeneration on completion/rollover (`daily`, `weekdays`, `weekly` / `every <weekday>`, `monthly`), gentle overdue flagging in `planner.explain()`, and CLI command `concierge rollover` ready to wrap in Prefect in Sprint 2.
- [ ] [role:qa-gatekeeper] Run full local verification suite (`.venv/bin/pytest -q`, capture eval runner, `git status`, `git diff --stat`, secret & `CLAUDE.md` IP hygiene check), update `docs/STATUS.md` locally, and generate the **Sprint 1 Local Build Summary** for Founder Andrew's sign-off before any GitHub branch/PR action.
