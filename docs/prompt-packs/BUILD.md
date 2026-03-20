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
