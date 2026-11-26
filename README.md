# inkling-workforce

Reusable local **Inkling** agent workforce & **Antigravity Plugin** backed by LM Studio (`http://localhost:1235/v1`).

Designed for a **CEO → Local Workforce** architecture:
- **Antigravity (CEO):** High-level architecture, spec writing, code review, and tricky debugging.
- **Inkling (Local Workers):** 24/7 zero-token implementation, test generation, bug fixing, and codebase scouting across *any* project repository.

## 1. Link Globally into Antigravity (One-Time Setup)

Symlink this repo into Antigravity's global plugins folder so both the MCP server (`inkling-workforce-mcp`) and the `ceo-delegation` skill load automatically in every workspace:

```bash
mkdir -p ~/.gemini/config/plugins
ln -s /Users/andreweffarah/Projects/inkling-workforce ~/.gemini/config/plugins/inkling-workforce
```

Optional — link the `inkling` CLI onto your `PATH`:

```bash
cd /Users/andreweffarah/Projects/inkling-workforce && /opt/homebrew/opt/node@24/bin/npm link
```

## 2. Worker Roles (`roles/*.md`)

Add or customize worker personas simply by editing Markdown files in `roles/`:
- `implementer` — Full-access coder that edits files and runs tests/linters.
- `test-writer` — QA agent that writes unit/edge-case tests and runs the test suite.
- `bug-fixer` — Reproduces failures first, applies minimal fixes, verifies green tests.
- `researcher` — Strictly read-only scout (`read_only: true`).

## 3. Standalone CLI & 24/7 Backlog Loop

Run a single task against any repository:

```bash
./src/cli.mjs run "Summarize the database schema" --cwd ~/Projects/concierge --role researcher
```

Run an unattended 24/7 backlog grinder against any repository:

```bash
./src/cli.mjs loop ~/Projects/concierge/BACKLOG.md --cwd ~/Projects/concierge
```

Example `BACKLOG.md` items (supports per-task role tags!):

```markdown
- [ ] [role:researcher] Audit src/ for missing type annotations and write findings to docs/type-audit.md
- [ ] [role:implementer] Add input validation for empty task titles in src/concierge/models.py
- [ ] [role:test-writer] Add unit tests covering recurring task edge cases
```
