---
name: Full Repo Code Audit
overview: A systematic audit of the entire clandestine-fulfillment codebase covering static analysis, every page route, every Trigger.dev task, every API connection, live Supabase data integrity, and a plan-vs-reality assessment against the last 14 days of planning docs. The audit produces evidence-backed verdicts on what works, what is broken, and what is silently failing.
todos:
  - id: phase1-static
    content: "Phase 1: Run full static analysis gate (pnpm check, typecheck, test, build, CI guards) and capture results"
    status: completed
  - id: phase2-supabase
    content: "Phase 2: Write and run Supabase data integrity audit script (migrations, RLS, data spot checks, webhook health)"
    status: completed
  - id: phase3-trigger
    content: "Phase 3: Audit all Trigger.dev tasks -- registration, run history, stuck tasks, silent errors, counter bugs"
    status: completed
  - id: phase4-playwright
    content: "Phase 4: Expand full-site-audit.spec.ts to cover all 50 pages, run expanded audit, analyze report"
    status: completed
  - id: phase5-api
    content: "Phase 5: Verify all external API connections (Bandcamp, Shopify, ShipStation, Discogs, EasyPost, etc.)"
    status: completed
  - id: phase6-plans
    content: "Phase 6: Plan-vs-reality assessment -- cross-reference 22 planning docs against live code and data"
    status: completed
  - id: phase7-report
    content: "Phase 7: Produce final audit report with green/yellow/red verdicts and actionable findings"
    status: completed
isProject: false
---

# Full Repository Code Audit

## 1. Scope Summary

This audit covers every layer of the `clandestine-fulfillment` system:

- **Static analysis**: typecheck, lint, unit tests, build, CI guards
- **Database**: migration parity, live data integrity, backfill state, RLS coverage
- **Trigger.dev runtime**: all 55 registered tasks -- cron health, run history, silent failures
- **API connections**: Bandcamp, Shopify, ShipStation, Discogs, EasyPost, AfterShip, Stripe, Resend, Squarespace, WooCommerce
- **Playwright E2E**: expanded full-site audit covering all 50 page routes (currently only 33 are tested)
- **Plan-vs-reality**: assessment of all 22 planning docs from the last 14 days

## 2. Evidence Sources

- Truth docs: `TRUTH_LAYER.md`, `docs/system_map/INDEX.md`, `API_CATALOG.md`, `TRIGGER_TASK_CATALOG.md`
- State docs: `project_state/engineering_map.yaml`, `project_state/journeys.yaml`
- Quality: `docs/RELEASE_GATE_CRITERIA.md`, `docs/RUNBOOK.md`
- SQL checks: `scripts/sql/prod_parity_checks.sql`, `scripts/sql/webhook_health_snapshot.sql`
- 22 planning docs from `/Users/tomabbs/.cursor/plans/`
- Live Supabase data (via service role client)
- Trigger.dev dashboard / API
- Codebase: 46 task files, 33 action files, 15 API routes, 21 client libs, 40 migrations, 50 page routes, 77 test files

## 3. API Boundaries Impacted

All boundaries in `API_CATALOG.md` are in scope:
- 15 API route handlers (`src/app/api/**/route.ts`)
- 33 server action files (`src/actions/*.ts`)
- Webhook ingress: Shopify, AfterShip, Stripe, Resend inbound, client-store
- OAuth flows: Shopify, WooCommerce, Squarespace, Discogs

## 4. Trigger Touchpoint Check

All 55 registered exports from `src/trigger/tasks/index.ts` are in scope. Two task files exist on disk but are NOT registered:
- `debug-env.ts` (intentional -- diagnostics only)
- `tag-cleanup-backfill.ts` (referenced in `API_CATALOG.md` but missing from index -- potential silent issue)

Queues in scope: `bandcamp-api` (concurrency 1), `bandcamp-sweep` (1), `bandcamp-scrape` (5), `shipstation` (1), `client-store-order` (in lib but not in catalog)

## 5. Proposed Implementation Steps

### Phase 1: Static Analysis Gate (automated, no code changes)

Run the full release gate and capture results:

```
pnpm check          # Biome lint
pnpm typecheck      # TypeScript strict
pnpm test           # Unit + contract tests (77 files)
pnpm build          # Next.js production build
bash scripts/ci-inventory-guard.sh
bash scripts/ci-webhook-dedup-guard.sh
```

Capture exit codes and any failures. This is the baseline.

### Phase 2: Supabase Data Integrity Audit (read-only queries)

Write a single `scripts/audit-supabase.mjs` script that queries (read-only, service role) and produces a JSON report:

**2a. Migration parity**
- Compare `supabase_migrations.schema_migrations` against the 40 local migration files
- Flag any that are local-only (not applied) or remote-only (orphaned)

**2b. Table + RLS check**
- Run the logic from `scripts/sql/prod_parity_checks.sql` programmatically
- For every table with data: confirm RLS is enabled and at least one policy exists
- Flag tables with RLS disabled or zero policies

**2c. Data integrity spot checks**
- `bandcamp_product_mappings`: count by `authority_status`, count with/without `bandcamp_url`, count with/without `raw_api_data`, count with/without `bandcamp_subdomain`
- `bandcamp_sales`: total rows, per-connection breakdown (count, min/max date), cross-check against `bandcamp_sales_backfill_state`
- `bandcamp_sales_backfill_state`: status per connection, `total_transactions` vs actual row counts (known mismatch for Northern Spy: state says 0, actual is 2300)
- `warehouse_inventory_levels`: count negative `available`, count zero `available`
- `warehouse_shipments`: count by `label_source`, check for duplicates on `shipstation_shipment_id`
- `webhook_events`: count by platform/status in last 7 days
- `channel_sync_log`: latest entry per `sync_type`, check for stuck `running` entries older than 1 hour
- `sensor_readings`: latest reading per sensor name, flag any `critical` status
- `warehouse_review_queue`: count by status, count open items older than 24 hours

**2d. Webhook health snapshot**
- Run `scripts/sql/webhook_health_snapshot.sql` logic: check for stale/unregistered integrations

### Phase 3: Trigger.dev Task Audit

**3a. Index registration audit**
- Compare the 46 task files on disk against the 55 exports in `index.ts`
- Flag: `tag-cleanup-backfill.ts` is on disk but not exported (called by `triggerTagCleanup` action)
- Verify trigger.config.ts `dirs: ["src/trigger/tasks"]` means Trigger discovers by directory scan (so un-exported tasks may still run)

**3b. Live run history audit (via Trigger.dev API or dashboard)**
- For each of the ~30 cron tasks: check last successful run time, last failure, current status
- Flag tasks that have not run in >2x their cron interval
- Flag tasks with >10% failure rate in last 24 hours

**3c. Known stuck/broken tasks (from conversation history)**
- `bandcamp-sales-backfill-cron`: verify it is actually running every 10 min and processing chunks
- `bandcamp-sales-backfill`: verify it completes when called via `triggerAndWait` (not stuck QUEUED)
- Northern Spy backfill: `total_transactions=0` but 2300 rows exist -- diagnose the counter bug
- Check if any connections besides Northern Spy have sales data at all

**3d. Silent error detection**
- Grep all task files for error handling patterns: `catch` blocks that swallow errors without logging
- Grep for `.then(() => {}, () => {})` patterns (known silent swallowing in `bandcamp-sales-backfill.ts` lines 190-209)
- Check `onFailure` in `trigger.config.ts` routes to Sentry -- verify Sentry DSN is configured
- Grep for `console.log` vs `logger.info` usage (Trigger tasks should use `logger`)

### Phase 4: Expanded Playwright Full-Site Audit

**4a. Gap analysis** -- pages missing from current audit spec (`full-site-audit.spec.ts`):

Staff routes currently tested: 21 + 3 dynamic detail = 24
Staff routes missing (7):
- `/admin/mail-order`
- `/admin/shipstation-orders`
- `/admin/discogs`
- `/admin/discogs/credentials`
- `/admin/discogs/matching`
- `/admin/catalog/[id]` -- only attempted dynamically, needs guaranteed test

Client routes currently tested: 11
Client routes missing (5):
- `/portal/catalog`
- `/portal/catalog/[id]`
- `/portal/fulfillment`
- `/portal/mail-order`
- `/portal/stores`

Public routes currently tested: 1
Public routes missing (2):
- `/privacy`
- `/terms`

**4b. Add missing routes to audit spec**
- Add all 14 missing routes to `STAFF_ROUTES`, `CLIENT_ROUTES`, `PUBLIC_ROUTES` arrays
- Total coverage: 50 page routes (100%)

**4c. Enhanced error capture**
- Current spec captures: console warnings/errors, page errors, failed requests, HTTP >= 400
- Enhancement: also capture and categorize `hydration mismatch` warnings specifically
- Enhancement: capture response timing (flag any page taking >5s to load)

**4d. Run the expanded audit**
```
pnpm test:e2e:full-audit
```
Analyze the markdown report in `reports/playwright-audit/`

### Phase 5: API Connection Audit

**5a. External API connectivity verification** (read-only probes where possible)
- **Bandcamp**: check `bandcamp_connections` for active connections, verify token refresh works, test `get_merch_details` for one connection
- **Shopify**: check if `shopify_credentials` exist, verify webhook registrations via `manage-shopify-webhooks.ts`
- **ShipStation**: check `shipstation_credentials`, verify `/orders` endpoint responds
- **Discogs**: check `discogs_credentials`, verify OAuth token validity
- **EasyPost**: check if `EASYPOST_API_KEY` is set, verify `/addresses` endpoint
- **AfterShip**: check if `AFTERSHIP_API_KEY` is set
- **Stripe**: check if `STRIPE_SECRET_KEY` is set, verify webhook endpoint registered
- **Resend**: check if `RESEND_API_KEY` is set
- **WooCommerce**: check `client_store_connections` with `platform='woocommerce'`
- **Squarespace**: check `client_store_connections` with `platform='squarespace'`

**5b. Webhook health** -- run `webhook_health_snapshot.sql` logic and flag stale platforms

### Phase 6: Plan-vs-Reality Assessment

Cross-reference all 22 planning docs against live codebase and data:

**Plans marked COMPLETED (should verify code exists and works):**
- `bandcamp_scraper_three_buckets` -- verify sweep task runs, subdomain map fix
- `bundle_component_inventory` -- verify `bundle_components` table, fanout task, sweep
- `shipstation_bridge` -- verify poll task, ShipStation Orders page, sidebar link
- `prompt_pack_+_api_trigger_catalog` -- verify catalogs exist and are current
- `full_audit_remediation` -- verify billing/users/releases 500s are fixed
- `plan_vs_reality_audit` -- verify gap matrix exists
- `files24_final_reliability_review` -- verify contract issues resolved
- `add_bandcamp_header_link` -- verify header link exists on catalog detail
- `bandcamp_metadata_fields` -- verify about/credits/upc columns, backfill status; note `idempotency-guard` todo still PENDING

**Plans marked IN-PROGRESS or PARTIALLY DONE:**
- `bandcamp_api_complete` -- THE BIG ONE: verify Sales API, authority lifecycle, SKU push, scraper simplification. Known issues: backfill stuck, total_transactions counter wrong, only 2020 data for NS
- `scraper_status_and_self-heal` -- many todos still pending per YAML
- `shipping_log_audit_fix` (f71a) -- verify dedup, poll hardening, `getClientShipments` org fix; some todos pending
- `bandcamp_scraper_fix` -- image backfill migration DEFERRED
- `cf_truth_layer_guardrails` -- all todos pending per YAML

**Plans that are STUBS (incomplete/empty):**
- `bandcamp_api-first_overhaul` (both d3eca844 and aae191f6) -- empty body
- `support_omnichannel_v2` -- empty body
- `enterprise_support_chat` -- empty body
- `support_omnichannel_upgrade` -- empty todos, phased steps in prose only
- `bandcamp_frontend_display` -- empty todos

**Plans with PENDING items that need assessment:**
- `shipping_api_+_client_auth_gap_report` -- all OAuth/EasyPost todos pending (large gap)

### Phase 7: Produce Audit Report

Generate a structured markdown report with:
- **Green** (working as intended): list with evidence
- **Yellow** (partially working / degraded): list with symptoms
- **Red** (broken / not functioning): list with root cause if known
- **Silent errors**: identified swallowed exceptions, missing logging
- **Data integrity issues**: mismatches, orphans, stale state
- **Coverage gaps**: untested pages, unregistered tasks, missing RLS

## 6. Risk + Rollback Notes

- This audit is **read-only** except for:
  - Adding missing routes to `full-site-audit.spec.ts` (low risk, additive only)
  - Creating `scripts/audit-supabase.mjs` (temporary, deletable)
- No migrations, no Trigger deploys, no data mutations
- If the Playwright audit reveals new failures, they are pre-existing (not caused by audit)

## 7. Verification Steps

- `pnpm check` -- must pass (baseline)
- `pnpm typecheck` -- must pass
- `pnpm test` -- capture pass/fail count
- `pnpm build` -- must succeed
- `pnpm test:e2e:full-audit` -- run with expanded spec, analyze report
- `bash scripts/release-gate.sh --with-e2e` -- full gate run
- Supabase audit script produces clean JSON output
- All findings documented in audit report

## 8. Doc Sync Contract

The audit itself should **not** change behavior, so no truth doc updates are required. However, findings may identify truth docs that are **stale**:
- `TRIGGER_TASK_CATALOG.md` may be missing `bandcamp-sales-backfill-cron` entry (needs verification)
- `API_CATALOG.md` may be missing new Bandcamp actions added during API-complete work
- `engineering_map.yaml` `updated_at: 2026-03-20` is 14 days old -- may need Sales API/SKU reconciliation additions
- `journeys.yaml` `updated_at: 2026-03-20` -- may need `bandcamp_sales_data` journey

## 9. Trigger Touchpoint Section

**Cron tasks to verify (26):**
`support-escalation`, `shopify-sync`, `shopify-order-sync`, `bandcamp-sale-poll`, `bandcamp-inventory-push`, `bandcamp-scrape-sweep`, `bandcamp-sync-cron`, `bandcamp-order-sync-cron`, `bandcamp-mark-shipped-cron`, `client-store-order-detect`, `multi-store-inventory-push`, `sensor-check`, `preorder-fulfillment`, `monthly-billing`, `storage-calc`, `redis-backfill`, `daily-scan-form`, `oauth-state-cleanup`, `discogs-listing-replenish`, `discogs-mailorder-sync`, `discogs-client-order-sync`, `discogs-message-poll`, `shipstation-poll`, `bundle-availability-sweep`, `catalog-stats-refresh`, `bandcamp-sales-sync`, `bandcamp-sales-backfill-cron`

**Event/on-demand tasks to verify (25):**
`process-shopify-webhook`, `process-client-store-webhook`, `aftership-register`, `shopify-full-backfill`, `bandcamp-sync`, `bandcamp-scrape-page`, `bandcamp-order-sync`, `bandcamp-mark-shipped`, `pirate-ship-import`, `inbound-product-create`, `inbound-checkin-complete`, `tag-cleanup-backfill`, `preorder-setup`, `debug-env`, `create-shipping-label`, `mark-platform-fulfilled`, `mark-mailorder-fulfilled`, `discogs-catalog-match`, `discogs-initial-listing`, `discogs-message-send`, `catalog-stats-refresh-demand`, `bandcamp-sales-backfill`, `bundle-component-fanout`, `mailorder-shopify-sync`

**Known broken/degraded (from conversation):**
- `bandcamp-sales-backfill`: API-triggered runs stay QUEUED forever (platform issue); cron wrapper works but total_transactions counter is broken
- `bandcamp-scrape-sweep`: Group 2 URL construction removed; enrichment-only now; depends on cross-reference working
- `sensor-check`: `bandcamp.merch_sync_log_stale` was fixed to accept `partial` status

**Task files NOT in index.ts (2):**
- `debug-env.ts` -- intentional (diagnostics)
- `tag-cleanup-backfill.ts` -- potentially broken registration
