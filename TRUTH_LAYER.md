# TRUTH_LAYER

Project: `clandestine-fulfillment`
Root: `/Users/Shared/WorkShared/Project/clandestine-fulfillment`

## Purpose

This is the canonical source of architecture truth for planning, building, and auditing.
If this file conflicts with ad-hoc notes, this file and linked truth docs win.

## Required Read-First Set (Hard Block)

Before producing PLAN, BUILD, or AUDIT output, read:

1. `TRUTH_LAYER.md`
2. `docs/system_map/INDEX.md`
3. `docs/system_map/API_CATALOG.md`
4. `docs/system_map/TRIGGER_TASK_CATALOG.md`
5. `project_state/engineering_map.yaml`
6. `project_state/journeys.yaml`
7. `docs/RELEASE_GATE_CRITERIA.md`
8. `docs/RUNBOOK.md`

If any required file is missing or stale for the requested scope, return `BLOCKED` and list what must be updated.

## Core System Invariants

- UI data access uses `useAppQuery` / `useAppMutation` with `query-tiers`.
- Server-side auth context comes from `requireAuth()` and validated role checks.
- Org/workspace sensitive writes are protected by RLS or service-role actions with explicit authorization checks.
- Trigger.dev handles background and asynchronous workflows; debugging must include related tasks.
- Webhook handlers must preserve idempotency and bounded retries.
- Release confidence is enforced by `release-gate` checks and full-site audit criteria.
- Bandcamp follows an **authority lifecycle**: Bandcamp API is authoritative for **initial ingest** (new titles, SKU/quantity/date/price bootstrap). After staff review or physical count, the warehouse app becomes authoritative for **operational fields** (SKU, quantity, price, dates). Bandcamp remains authoritative for **descriptive/external fields** (URL, subdomain, album_title, options, sales data) permanently. Governed by `authority_status` on `bandcamp_product_mappings` (`bandcamp_initial` → `warehouse_reviewed` → `warehouse_locked`). HTML scraping (`data-tralbum`) is **enrichment only** (about, credits, tracks, package photos). Automation is **bounded** (caps, DLQ to `warehouse_review_queue`, no unbounded retry).

## Preflight Commands

Run these before substantive planning/building:

```bash
pnpm check
pnpm typecheck
pnpm release:gate
pnpm test:e2e:full-audit
```

For production parity/ops checks, also use:

- `scripts/sql/prod_parity_checks.sql`
- `scripts/sql/webhook_health_snapshot.sql`

## Doc Sync Contract (Mandatory)

Any session that changes behavior must update truth docs in the same session.

- Architecture or ownership changed -> update `TRUTH_LAYER.md` and `project_state/engineering_map.yaml`
- User/system flow changed -> update `project_state/journeys.yaml`
- API route/action boundary changed -> update `docs/system_map/API_CATALOG.md`
- Trigger task/event/cron wiring changed -> update `docs/system_map/TRIGGER_TASK_CATALOG.md`
- Release or verification rules changed -> update `docs/RELEASE_GATE_CRITERIA.md`

Session completion must include:

1. Code changes summary
2. Truth docs updated list
3. Journey updates list
4. API/Trigger catalog updates list

## Ownership

- Architecture truth: engineering lead + primary maintainer
- API catalog: backend/app-router owners
- Trigger catalog: integrations/ops owners
- Journeys: product + engineering
