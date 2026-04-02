# Prompt Pack — BUILD

Use this prompt when implementing approved changes with strict guardrails.

## Required Read-First (Hard Block)

- `TRUTH_LAYER.md`
- `docs/system_map/INDEX.md`
- `docs/system_map/API_CATALOG.md`
- `docs/system_map/TRIGGER_TASK_CATALOG.md`
- `project_state/engineering_map.yaml`
- `project_state/journeys.yaml`
- accepted PLAN output for this change

If required context is missing, return `BLOCKED`.

## Builder Instructions

Implement the approved plan with minimal, safe edits.

- Respect query/cache and auth invariants from `TRUTH_LAYER.md`.
- Preserve envelope error behavior (no new generic server-render 500s).
- Do not bypass API/action boundaries.
- For async features, verify Trigger path from ingress to task to persistence.

## Agent execution — migrations, CLI, and permissions

Do **not** treat the user as the default executor for routine devops. Prefer the agent **running** commands (requesting **network** / **all** sandbox permissions when needed) over “paste this into the Supabase dashboard” unless the user explicitly asks for SQL-only or CLI is confirmed unavailable.

### Supabase (this repo)

- **Working directory:** repository root where `supabase/config.toml` lives (`clandestine-fulfillment`).
- When migration files under `supabase/migrations/` are added or changed, **run** `supabase db push --yes` for the **linked** project. Do not end with handoff-only SQL.
- If push fails on duplicate objects (policy, constraint, table), **fix migration idempotency** and **retry** (e.g. `DROP POLICY IF EXISTS`, `IF NOT EXISTS`, `pg_constraint` checks in `DO $c$ ... END $c$;`). Use `supabase migration list --linked` to compare local vs remote.
- **Repair (rare):** `supabase migration repair <version> --status applied|reverted` only when remote state is understood; prefer idempotent migrations first.

### Other tasks the agent should run

- `pnpm` / `npm` scripts from `package.json` (lint, typecheck, tests, `pnpm check`) when validating a change.
- If a command fails only in sandbox, say so and ask for permission retry or identical command in the user’s integrated terminal—do not silently downgrade to “you do it.”

### If Supabase CLI access is missing or broken

Give the operator this **re-enable checklist** (they may need to run it locally if the agent shell has no auth):

1. **Install CLI:** [Supabase CLI](https://supabase.com/docs/guides/cli) (e.g. macOS: `brew install supabase/tap/supabase`).
2. **Login:** `supabase login` (browser or access token).
3. **Link project:** from repo root, `supabase link --project-ref <PROJECT_REF>` (Dashboard → Project Settings → General, or pick from `supabase projects list`).
4. **Verify link:** `supabase projects list` — the row for this project shows **●** under LINKED.
5. **Push migrations:** `supabase db push --yes`.
6. **Cursor/agent:** If tool runs stay blocked, approve **network** (or **all**) for the agent shell, or run steps 2–5 in your own terminal; the agent should still edit migrations and report exact errors.

### Fewer Cursor permission prompts (operator)

Cursor only uses command allowlists when **auto-run** is enabled (not “Ask every time”). Configure:

1. **Cursor Settings → Agent** (or search **Auto-run**): choose **Auto-run in Sandbox** (safer) or **Run everything** (fewest prompts; higher trust).
2. Enable options such as **auto-approve network** / **git writes without approval** if your Cursor version exposes them.
3. Optional global allowlist: `~/.cursor/permissions.json` with `terminalAllowlist` — prefix rules (e.g. `pnpm`, `supabase`, `git`) so matching commands skip repeated approval. See [Cursor permissions.json](https://cursor.com/docs/reference/permissions.md). If that file defines `terminalAllowlist`, it **replaces** the in-app terminal allowlist (not merged); edit the file to add commands.

### Honesty

- If `supabase db push` did not complete successfully, **do not** imply the remote database was updated—state what ran, what failed, and the next command.

## Required Build Output Sections

1. Files changed
2. Behavior changed
3. API boundaries touched
4. Trigger tasks touched/verified
5. Tests/checks run
6. Remaining risks
7. Doc Sync Contract updates completed

## Mandatory Doc Sync

When code changes:

- Architecture shift -> update `TRUTH_LAYER.md` + `engineering_map.yaml`
- Journey behavior shift -> update `journeys.yaml`
- API boundary shift -> update `API_CATALOG.md`
- Trigger wiring shift -> update `TRIGGER_TASK_CATALOG.md`
- Verification rules shift -> update release gate docs

Work is incomplete if these updates are missing.
