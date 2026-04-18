# Prompt Pack — AUDIT


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

## Agent execution — migrations, CLI, and permissions

For findings that involve **schema, RLS, or migrations**, the agent should **verify with tooling**, not only read files: e.g. `supabase migration list --linked`, read relevant `supabase/migrations/*.sql`, and when fixing drift **run** `supabase db push --yes` (request **network** / **all** permissions as needed). Prefer fixing idempotent migrations and retrying push over instructing the user to manually reconcile unless CLI is unavailable.

**If Supabase CLI access is lost**, tell the operator: install CLI → `supabase login` → `supabase link --project-ref <ref>` → verify **●** on this project in `supabase projects list` → `supabase db push --yes`. If the agent terminal cannot use stored auth, the user runs those commands locally while the agent handles repo-side fixes.

**Fewer Cursor permission prompts:** Cursor Settings → Agent → **Auto-run in Sandbox** or **Run everything**; optional `~/.cursor/permissions.json` `terminalAllowlist`. Details: `BUILD.md` → *Agent execution* → *Fewer Cursor permission prompts*.

Do not claim “migration applied” without evidence (successful push output or confirmed operator step).

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
