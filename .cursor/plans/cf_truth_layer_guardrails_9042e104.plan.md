---
name: CF Truth Layer Guardrails
overview: Establish a hard-block truth-layer workflow in clandestine-fulfillment by extending existing docs, adding canonical state files, and enforcing pre-plan/build reads through Cursor rules and prompt packs.
todos:
  - id: truth-entrypoint
    content: Create TRUTH_LAYER.md and define required read-first sources + ownership boundaries.
    status: pending
  - id: state-files
    content: Create/normalize project_state files (README, engineering_map.yaml, journeys.yaml) from existing docs and current architecture.
    status: pending
  - id: truth-commands
    content: Add documented truth/status command flow in scripts/docs using existing release-gate and audit artifacts.
    status: pending
  - id: cursor-hard-block-rules
    content: Add .cursor/rules/*.mdc enforcing hard-block preflight before PLAN/BUILD.
    status: pending
  - id: prompt-packs
    content: Create PLAN/IMPLEMENT/REVIEW prompt packs that require references to canonical truth docs.
    status: pending
  - id: verify-flow
    content: Run dry verification checklist and document ongoing update cadence for keeping truth layer current.
    status: pending
isProject: false
---

# Clandestine Fulfillment Truth-Layer Prompt System

## Goal

Make planning/build steps strictly depend on canonical, continuously updated repo docs so the AI must read truth sources before producing plans or implementation.

## What I Will Add

- **Canonical truth entrypoint** at `[TRUTH_LAYER.md](TRUTH_LAYER.md)` that defines system architecture ownership, invariants, and required preflight checks.
- **State registry folder** at `[project_state/](project_state/)` with:
  - `[project_state/README.md](project_state/README.md)` (layout + update cadence)
  - `[project_state/engineering_map.yaml](project_state/engineering_map.yaml)` (component inventory and owners)
  - `[project_state/journeys.yaml](project_state/journeys.yaml)` (critical user/system journeys + health status)
- **Command wrappers/docs** to mirror your other repo pattern using existing CF checks:
  - map and status scripts in `[scripts/](scripts/)` that aggregate current health sources (`release-gate`, SQL checks, full-site audit reports)
  - usage section in `[docs/RUNBOOK.md](docs/RUNBOOK.md)` and `[docs/RELEASE_GATE_CRITERIA.md](docs/RELEASE_GATE_CRITERIA.md)`.
- **Hard-block Cursor rules** in `[.cursor/rules/](.cursor/rules/)` so the agent must:
  - read required truth docs first,
  - run truth/status commands first,
  - refuse PLAN/BUILD when required truth inputs are missing.
- **Prompt packs** in `[docs/prompt-packs/](docs/prompt-packs/)` for PLAN / IMPLEMENT / REVIEW that force references to required docs and include your architecture gates (cache, auth, RLS, webhooks, Trigger, release gate).

## Reuse Existing Docs (as requested)

I will wire current docs as first-class truth inputs instead of replacing them:

- `[docs/RELEASE_GATE_CRITERIA.md](docs/RELEASE_GATE_CRITERIA.md)`
- `[docs/PROD_MIGRATION_RLS_PARITY_CHECKLIST.md](docs/PROD_MIGRATION_RLS_PARITY_CHECKLIST.md)`
- `[docs/INTEGRATION_REGISTRATION_MATRIX.md](docs/INTEGRATION_REGISTRATION_MATRIX.md)`
- `[docs/TRIGGER_SMOKE_CHECKLIST.md](docs/TRIGGER_SMOKE_CHECKLIST.md)`
- `[PLAN_VS_CURRENT_STATE_GAP_ASSESSMENT_2026-03-20.md](PLAN_VS_CURRENT_STATE_GAP_ASSESSMENT_2026-03-20.md)`

## Enforcement Model (Hard-Block)

- PLAN/BUILD prompts must include a **Read-First manifest** listing required files and command outputs.
- Missing truth inputs => agent returns **blocked state** with exact missing artifacts.
- BUILD prompts require PLAN prompt outputs and latest truth status references.

## Verification

- Add a lightweight truth verification command (script alias) and document expected pass/fail behavior.
- Validate by dry-running PLAN and IMPLEMENT prompt templates against current repo state.
- Confirm the rule set forces doc references before actionable output.