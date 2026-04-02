# Prompt Pack — PLAN

Use this prompt when you need a change plan and want no architecture drift.

## Required Read-First (Hard Block)

Read before proposing any plan:

- `TRUTH_LAYER.md`
- `docs/system_map/INDEX.md`
- `docs/system_map/API_CATALOG.md`
- `docs/system_map/TRIGGER_TASK_CATALOG.md`
- `project_state/engineering_map.yaml`
- `project_state/journeys.yaml`
- `docs/RELEASE_GATE_CRITERIA.md`

If any are missing for the scope, return `BLOCKED`.

## Planner Instructions

You are planning the next implementation step for `clandestine-fulfillment`.

- Propose patches, not rewrites.
- One concern per task.
- Do not modify truth docs without listing required updates.
- No guessing: verify API boundaries and Trigger touchpoints first.

## Agent execution — migrations, CLI, and permissions

Plans should assume the **agent** applies schema changes: `supabase db push --yes` from the `clandestine-fulfillment` repo root after migration edits—not “user runs SQL in dashboard” unless SQL-only is explicitly requested or CLI is unavailable.

- Include migration steps as **agent-runnable**; note idempotency / drift risks if the remote may already partial-apply.
- When listing verification, include `supabase migration list --linked` where schema is in scope.

**If CLI access is lost**, the operator restores it with: install CLI → `supabase login` → `supabase link --project-ref <ref>` → confirm **●** in `supabase projects list` → `supabase db push --yes`. Agent shells may need **network/all** permissions or the user runs the same commands locally.

**Fewer Cursor permission prompts:** Cursor Settings → Agent → **Auto-run in Sandbox** or **Run everything** (not “Ask every time”); optional `~/.cursor/permissions.json` `terminalAllowlist`. Details: `BUILD.md` → *Agent execution* → *Fewer Cursor permission prompts*.

Do not imply the database was migrated without a successful push (or explicit SQL-only path).

## Required Plan Output Sections

1. Scope summary
2. Evidence sources (exact files read)
3. API boundaries impacted (from `API_CATALOG.md`)
4. Trigger touchpoint check (task IDs reviewed, if relevant)
5. Proposed implementation steps
6. Risk + rollback notes
7. Verification steps (`pnpm check`, relevant tests, gate checks)
8. Doc Sync Contract updates required

## Trigger Touchpoint Rule

If scope includes sync, webhook, inventory, orders, releases, billing, or support:

- Include a dedicated Trigger touchpoint section.
- List task IDs and ingress routes/actions.
- No final plan without this section.
