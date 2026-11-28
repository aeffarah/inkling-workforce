# Inkling Local Workforce — Optimization Log v0.5 (2026-11-27)

## 1. Cumulative Production Telemetry (v0.4 Run Window)
- **SQLite Gateway Traces:** `198` LLM calls across `20` tracked jobs (`11` completed, `0` cloud tokens, **$0.00** cloud API cost)
- **Local Tokens Processed:** `2,759,773` tokens on Apple Silicon (`inkling-2-mini@q2_k_xl`)
- **Average Call Latency:** `76s` per step (including prompt prefill + `<think>` reasoning + tool generation)
- **Thermal Stability:** `0` serious/critical thermal events under `20m work / 10m break` + `NSProcessInfo.thermalState` adaptive breathers (`8s` nominal / `18s` fair)

---

## 2. Empirical Step-Efficiency Findings (Why Multi-Endpoint Jobs Hit `35/35` Steps)

Comparing step utilization by role and task scope revealed a clear bimodal pattern:

| Task Shape | Typical Steps | Completion Outcome | Root Cause Observed in Job Logs |
|---|---|---|---|
| **1–2 file focused unit** (`eval`, `frontend`, `qa`) | `10–21 / 35` | **100% first-pass green** | Fits cleanly in context; edits begin by Step 4–6. |
| **Multi-concern API bundle** (4+ endpoints + schema + tests in 1 task) | `35 / 35` | **Exhausted step budget** | Spent **Steps 1–12** reading target files sequentially (`150`-line cap forced 2–3 reads per file) and **Steps 25–35** re-reading earlier files via `sed -n` as context grew, hitting `max_steps` with a 1-line signature mismatch still unfixed. |

### Key Takeaways for Local Thinking-Model Swarms
1. **Every redundant `read_file` costs ~76s + KV prefill growth:** Cutting 10 exploration/re-read steps saves ~12.5 minutes of GPU compute and keeps thermal state `nominal`.
2. **Task granularity ceiling:** Each backlog item for a quantized local thinking model should touch **at most 1–2 source files + 1 test file** (`< 300` lines per file).
3. **Late-step blindness:** Without mid-run pace checks and an automatic pre-final test run, workers do not realize `max_steps` is imminent until tools are revoked.

---

## 3. v0.5 Engine Optimizations Implemented (`src/agent.mjs`)

1. **Fast-Start Target-File Pre-Hydration (`preloadTaskFiles`):**
   - Extracts up to 3 workspace file paths referenced in backticks in the task spec (up to `11 KB` each) and injects their numbered contents directly into the initial prompt (or marks missing paths as `(create with write_file)`).
   - Eliminates the 6–12 step sequential exploration phase at job startup.
2. **Whole-Module `read_file` Window (`150 → 300` lines, `9,500` char cap):**
   - Standard modules (`150–280` lines) now load in **1 tool call** instead of 2–3 chunked reads, preventing `sed -n` pagination loops.
3. **Two-Stage Step-Budget Guard + Automatic Pre-Final Test Gate:**
   - **55% Pace Check:** Reminds the worker mid-run to apply edits and avoid re-reading files already in context.
   - **`maxSteps - 4` Live Pytest Pre-Gate:** Automatically runs `.venv/bin/pytest -q` 4 steps before `maxSteps` and injects either confirmation or the exact failure traceback while the worker still has 4 tool turns left to fix 1-line errors.
---

## 4. v0.5 Live Validation & v0.5.1 Adaptive Truncation Fix
- **Validated v0.5 Pre-Hydration Win:** First backend API task under v0.5 (`672dea`) completed cleanly on the first pass (whereas 3 prior v0.4 backend jobs had hit `35/35` steps), and capture prompt creation began on **Step 3** instead of Step 12.
- **New Bottleneck Caught (Single-File UI Rewrite > `6144` Tokens):** Rewriting a ~10 KB single-file HTML/CSS/JS template in one `write_file` call combined with `<think>` tokens exceeded `max_tokens=6144` twice consecutively.
- **v0.5.1 Fix (`src/agent.mjs`):** On `finish_reason === "length"`, automatically escalate the retry step's `maxTokens` from `6144 → 10240` and nudge the worker to keep reasoning `< 60` words or use `edit_file` patches.
