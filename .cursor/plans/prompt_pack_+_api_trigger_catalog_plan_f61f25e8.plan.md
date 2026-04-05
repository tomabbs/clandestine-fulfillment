---
name: Prompt Pack + API/Trigger Catalog Plan
overview: Expand the truth-layer setup to include dedicated prompt packs for planning/building/auditing, plus a hard-required API and Trigger.dev catalog so sessions cannot skip background-task wiring during diagnosis.
todos:
  - id: add-api-catalog
    content: Create and populate API catalog of server actions/routes and ownership.
    status: completed
  - id: add-trigger-catalog
    content: Create and populate Trigger.dev task catalog with schedules/events/queues and linked domains.
    status: completed
  - id: create-three-prompt-packs
    content: Author PLAN/BUILD/AUDIT prompt packs with hard required-read and evidence sections.
    status: completed
  - id: enforce-hard-block-rules
    content: Add Cursor rules that block planning/building/auditing output until truth docs are referenced.
    status: completed
  - id: wire-doc-sync-contract
    content: Require in-session updates to truth docs whenever code/journeys/apis/triggers change.
    status: completed
  - id: validate-prompt-pack-output
    content: Run dry checks to confirm prompt packs always force API + Trigger review and citations.
    status: completed
isProject: false
---

# Prompt Pack + API/Trigger Catalog Plan

## Goal

Create a strict session system for `clandestine-fulfillment` where PLAN / BUILD / AUDIT prompts must reference living truth docs, and where API + Trigger.dev coverage is explicit so debugging never misses background task code paths.

## Scope Additions (to existing truth-layer plan)

- Add 3 prompt packs:
  - `PLAN` (discovery + change plan)
  - `BUILD` (implementation + safeguards)
  - `AUDIT` (systematic diagnosis + evidence report)
- Add mandatory catalogs:
  - API endpoint catalog (App Router/API routes + server actions boundary map)
  - Trigger catalog (all Trigger.dev tasks, schedules, event triggers, queues, and linked domain ownership)
- Add hard-block rule requiring trigger/API references before final diagnosis or fix plan.

## Files to Create/Update

- Truth + state
  - `[TRUTH_LAYER.md](TRUTH_LAYER.md)`
  - `[project_state/README.md](project_state/README.md)`
  - `[project_state/engineering_map.yaml](project_state/engineering_map.yaml)`
  - `[project_state/journeys.yaml](project_state/journeys.yaml)`
- New catalogs
  - `[docs/system_map/API_CATALOG.md](docs/system_map/API_CATALOG.md)`
  - `[docs/system_map/TRIGGER_TASK_CATALOG.md](docs/system_map/TRIGGER_TASK_CATALOG.md)`
  - `[docs/system_map/INDEX.md](docs/system_map/INDEX.md)` (top-level index and required read order)
- Prompt packs
  - `[docs/prompt-packs/PLAN.md](docs/prompt-packs/PLAN.md)`
  - `[docs/prompt-packs/BUILD.md](docs/prompt-packs/BUILD.md)`
  - `[docs/prompt-packs/AUDIT.md](docs/prompt-packs/AUDIT.md)`
- Cursor enforcement
  - `[.cursor/rules/truth-layer-hard-block.mdc](.cursor/rules/truth-layer-hard-block.mdc)`
  - `[.cursor/rules/prompt-pack-enforcement.mdc](.cursor/rules/prompt-pack-enforcement.mdc)`

## Hard Requirements to Encode

- Before any PLAN/BUILD/AUDIT output, the agent must read:
  - `TRUTH_LAYER.md`
  - `docs/system_map/INDEX.md`
  - `API_CATALOG.md`
  - `TRIGGER_TASK_CATALOG.md`
  - release gate + runbook docs
- Any issue touching sync/webhooks/inventory/orders/support must include a “Trigger touchpoint check” section listing relevant tasks reviewed.
- Session completion must include Doc Sync Contract:
  - code changes -> corresponding truth docs updated in same session
  - journey-impacting change -> `journeys.yaml` updated
  - API/task changes -> catalogs updated

## AUDIT Prompt Behavior (new)

- Requires evidence table for each finding:
  - symptom route/action
  - API action/endpoint involved
  - Trigger task(s) checked
  - DB table/policy touchpoints
  - fix recommendation + risk
- Prohibits conclusions when Trigger catalog review is missing for async-integrated features.

## Verification

- Dry-run each prompt pack against one known issue class (e.g., support/inbound/invite).
- Confirm prompts produce references to API + Trigger catalogs every time.
- Validate the rule set blocks output if required docs are not cited.
