# Prompt Pack — AUDIT

Use this prompt for root-cause diagnosis, reliability audits, and remediation plans.

## Required Read-First (Hard Block)

- `TRUTH_LAYER.md`
- `docs/system_map/INDEX.md`
- `docs/system_map/API_CATALOG.md`
- `docs/system_map/TRIGGER_TASK_CATALOG.md`
- `project_state/engineering_map.yaml`
- `project_state/journeys.yaml`
- most recent `reports/playwright-audit/full-site-audit-*.md` (if runtime issue)

If evidence is incomplete, return `BLOCKED`.

## Auditor Instructions

- Prioritize findings by severity and user impact.
- Trace each finding from UI/API ingress to action/task to persistence.
- For async/integration domains, verify Trigger tasks explicitly.
- Do not conclude on async bugs without a Trigger touchpoint check.

## Required Evidence Table Per Finding

| Field | Requirement |
|---|---|
| Symptom | route/action and observed behavior |
| API boundary | action/route from `API_CATALOG.md` |
| Trigger touchpoint | relevant task ID(s) from Trigger catalog |
| Data/policy touchpoint | table, RPC, RLS policy, or migration reference |
| Root cause confidence | high/medium/low |
| Recommended fix | minimal patch and risks |

## Required Audit Output Sections

1. Findings by severity
2. Open questions / missing evidence
3. Proposed remediation sequence
4. Verification plan
5. Doc Sync Contract updates required after fixes
