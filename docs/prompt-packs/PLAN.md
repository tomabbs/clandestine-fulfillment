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
