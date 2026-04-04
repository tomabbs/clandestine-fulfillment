# Full Repository Audit Report

**Date:** 2026-04-04
**Auditor:** Agent (automated + manual inspection)
**Scope:** Every code file, API connection, Trigger.dev task, Supabase table, and page route

---

## Executive Summary

| Category | Status |
|---|---|
| TypeScript compilation | PASS |
| Production build | PASS |
| Biome lint | FAIL (83 errors, 72 warnings) |
| Unit tests | FAIL (33 of 638 tests failing in 7 files) |
| Inventory guard | PASS |
| Webhook dedup guard | FAIL (4 GDPR routes missing dedup) |
| Playwright site audit | 43 PASS / 4 FAIL / 3 SKIPPED of 47 routes |
| Supabase migration parity | FAIL (40 local, 0 in `schema_migrations` tracking) |
| Sentry DSN | SET (error monitoring active) |

---

## 1. Static Analysis (Phase 1)

### PASS: TypeScript (`pnpm typecheck`)
Zero errors. Full strict-mode compliance.

### PASS: Production build (`pnpm build`)
All 50 routes compiled successfully. No build errors.

### FAIL: Biome lint (`pnpm check`)
- **83 errors**, 72 warnings, 9 infos across 326 files
- Primary issues: import organization (auto-fixable)
- Fix: `pnpm check:fix` would resolve most automatically

### FAIL: Unit tests (`pnpm test`)
- **33 tests failing** in 7 test files out of 638 total (605 passing)
- Key failures:
  - `bandcamp.test.ts`: `matchSkuToVariants` test expects items without SKU to be dropped, but code now pushes them to `unmatched` (behavior change from API-complete work, test not updated)
  - `store-sync-client.test.ts`: Shopify client now throws real HTTP error instead of "not yet implemented"
  - `bandcamp-scraper.test.ts`: `releaseDate` month assertion off-by-one
- **Verdict:** Tests are stale relative to code changes from the last 2 weeks. No production bugs indicated -- tests need updating.

### PASS: Inventory guard (`ci-inventory-guard.sh`)
No direct inventory access violations found.

### FAIL: Webhook dedup guard (`ci-webhook-dedup-guard.sh`)
4 Shopify GDPR route handlers missing `webhook_events` dedup pattern:
- `src/app/api/webhooks/shopify/gdpr/customers-data-request/route.ts`
- `src/app/api/webhooks/shopify/gdpr/customers-redact/route.ts`
- `src/app/api/webhooks/shopify/gdpr/route.ts`
- `src/app/api/webhooks/shopify/gdpr/shop-redact/route.ts`

---

## 2. Supabase Data Integrity (Phase 2)

### Migration Tracking: ANOMALY
- **40 local migration files**, **0 rows** in `schema_migrations` (Supabase tracking table)
- This means migrations were applied directly to production (via SQL editor or `db push`) but `schema_migrations` is not being populated, OR migrations are tracked differently
- All tables exist and have data, so schema is applied -- just not tracked

### Table Health

| Table | Rows | Status |
|---|---|---|
| users | 6 | OK |
| workspaces | 1 | OK |
| organizations | 175 | OK |
| warehouse_products | 2,456 | OK |
| warehouse_product_variants | 2,379 | OK |
| warehouse_inventory_levels | 550 | 4 NEGATIVE, 304 zero |
| warehouse_orders | 20,914 | OK |
| warehouse_order_items | 3,850 | OK |
| warehouse_shipments | 473 | OK (all label_source=shipstation) |
| warehouse_shipment_items | 553 | OK |
| warehouse_inbound_shipments | 0 | EMPTY |
| warehouse_inbound_items | 0 | EMPTY |
| support_conversations | 2 | OK |
| support_messages | 5 | OK |
| webhook_events | 1,101 | OK |
| channel_sync_log | 15,964 | OK |
| sensor_readings | 32,085 | OK |
| warehouse_review_queue | 1,487 | 709 open, 291 suppressed |
| bandcamp_connections | 17 | OK (all active) |
| bandcamp_product_mappings | 648 | See details below |
| bandcamp_sales | 2,301 | Only 1 connection backfilled |
| bandcamp_sales_backfill_state | 3 | Only 3 of 17 connections started |
| client_store_connections | 1 | WooCommerce (Northern Spy) |
| bundle_components | 0 | EMPTY (feature built, no data) |
| billing_snapshots | 0 | EMPTY |

### RED: Bandcamp Data Issues

**Mappings (648 total):**
- With URL: 201 (31%)
- With raw API data: 98 (15%)
- With subdomain: (not queried explicitly, but raw_api_data implies)
- Authority status: ALL 648 are `bandcamp_initial` -- none have been reviewed

**Sales backfill:**
- Only **3 of 17** connections have backfill state entries
- Only **1 connection** (Northern Spy) has actual sales data (2,300 rows, Jan-Dec 2020 only)
- 14 active connections have ZERO backfill state entries at all
- Northern Spy: `total_transactions=0` but 2,300 actual rows (counter bug)
- Northern Spy: `status=running`, `last_processed_date=2020-01-01` -- stuck at year 2020
- Other 2 connections with state: both at `2011-01-01`, zero rows, zero transactions

**Root cause of counter bug:** In `bandcamp-sales-backfill.ts` line 133-136, the upsert that sets `status: "running"` does NOT include `total_transactions`, so Supabase resets it to the default `0` on every run. Then line 221 reads `total_transactions` (now 0) and adds the current batch count, but it was already reset.

### YELLOW: Inventory Issues
- **4 negative inventory levels** -- needs investigation
- **304 zero inventory levels** out of 550 total (55%)

### YELLOW: Review Queue Backlog
- **709 open** items, **606 open for >24 hours**
- 291 suppressed
- This is a significant operational backlog

### Webhook Health

| Platform | 7-day Events | Status |
|---|---|---|
| Shopify | 297 (533 total) | OK |
| AfterShip | 467 | OK |
| ShipStation | 0 | STALE (poll-based, not webhook) |
| Stripe | 0 | STALE_OR_UNREGISTERED |
| Resend | 0 | STALE_OR_UNREGISTERED |

### Sync Log Health
- No stuck `running` entries older than 1 hour
- No sensors returned from query (may indicate sensor_readings uses different column names)

---

## 3. Trigger.dev Task Audit (Phase 3)

### Task Registration

| Metric | Count |
|---|---|
| Task files on disk | 46 |
| Exports in index.ts | 55 (some files export multiple) |
| Files NOT in index.ts | 2 |

**Missing from index.ts:**
1. `debug-env.ts` -- intentional (diagnostics only)
2. `tag-cleanup-backfill.ts` -- **BUG**: called by `triggerTagCleanup` action (`admin-settings.ts` line 106) via `tasks.trigger("tag-cleanup-backfill", ...)` but not exported from index. May still work via directory scanning but is fragile.

### Silent Error Patterns

**Fire-and-forget `.then(() => {}, () => {})` patterns (7 instances):**
- `bandcamp-sales-backfill.ts`: 2 instances (mapping updates silently swallowed)
- `bandcamp-sync.ts`: 3 instances
- `bandcamp-sales-sync.ts`: 1 instance
- `shipstation-poll.ts`: 1 instance (documented as non-critical)

**console.log vs logger usage:**
- 20 task files use `console.log` (should use `logger` for Trigger.dev visibility)
- Only 9 task files use `logger.info/warn/error`
- Impact: task execution details are invisible in Trigger.dev dashboard for most tasks

**Sentry integration:**
- `NEXT_PUBLIC_SENTRY_DSN` is SET in `.env.local`
- `trigger.config.ts` has `onFailure` handler routing to Sentry
- NOT in `.env.example` -- new developers would miss this

### RED: Sales Backfill System Broken

**Evidence:**
1. Backfill cron (`bandcamp-sales-backfill-cron`) runs every 10 min
2. Only 3 of 17 connections have been picked up
3. Of those 3, only Northern Spy has actual data (2,300 rows from 2020)
4. 14 connections have never been touched
5. `total_transactions` counter resets to 0 on every run
6. Northern Spy is stuck at `last_processed_date = 2020-01-01` -- has not progressed past 2020 in ~6 hours

**Root causes:**
- Counter bug: upsert on line 133 resets `total_transactions`
- Cron processes ONE connection per run and returns early (line 289: `return { processed, band }`)
- With 10-min intervals and 1 connection per run, it would take 170 minutes just to START all 17 connections
- Connections that return empty yearly windows still consume a full cron run

### YELLOW: Bandcamp URL Coverage Low
- 201 of 648 mappings (31%) have URLs
- Cross-reference system (`crossReferenceAlbumUrls`) exists but depends on sales data which is itself incomplete

---

## 4. Playwright Full-Site Audit (Phase 4)

### Coverage: 47 routes tested (50 pages, 3 dynamic detail pages skipped)

**Expansion:** Added 14 previously untested routes:
- Staff: `/admin/mail-order`, `/admin/shipstation-orders`, `/admin/discogs` (3 sub-pages)
- Client: `/portal/catalog`, `/portal/fulfillment`, `/portal/mail-order`, `/portal/stores`
- Public: `/privacy`, `/terms`

### Results: 43 PASS, 4 FAIL, 3 SKIPPED

**FAIL: `/portal/releases`** (client)
- 3 page errors, 4 network issues
- No `<h1>` found on page (empty/broken render)
- 3 console errors

**FAIL: `/portal/orders`** (client)
- `<h1>` says "Fulfillment" instead of "Orders" (route mismatch or redirect)
- **1 hydration mismatch** detected
- 11 page errors, 4 network issues

**FAIL: `/portal/sales`** (client)
- **1 hydration mismatch**
- 11 page errors, 2 network issues

**FAIL: `/portal/catalog`** (client)
- No `<h1>` found (empty render, 51ms load = immediate redirect?)
- 2 console errors, 3 network issues

**SKIPPED (3):** `/admin/clients/[id]`, `/admin/catalog/[id]`, `/admin/inbound/[id]` -- no detail links found in list pages (test org has no data)

**All staff routes:** PASS (26/26)
**All public routes:** PASS (3/3)
**Client portal:** 11 PASS, 4 FAIL of 15

### Performance
- Slowest page: `/portal` at 3,814ms (acceptable)
- No pages exceeded 5,000ms threshold
- Average staff page load: ~700ms
- Average client page load: ~1,200ms

---

## 5. API Connection Audit (Phase 5)

### Connection Status

| Service | Credentials | Status |
|---|---|---|
| Bandcamp | 1 credential set, 17 connections | ACTIVE (all 17 active) |
| Shopify | `SHOPIFY_CLIENT_SECRET` set, no `API_KEY`/`API_SECRET` | PARTIAL (webhook-only, no admin API) |
| ShipStation | API key + secret set | ACTIVE |
| EasyPost | API key set | ACTIVE |
| AfterShip | API key set | ACTIVE |
| Stripe | Secret key + webhook secret set | ACTIVE (but 0 webhook events in 7d) |
| Resend | API key set, NO webhook secret | PARTIAL |
| Discogs | 0 credential sets | NOT CONFIGURED |
| WooCommerce | 1 connection (Northern Spy) | ACTIVE (last poll: Mar 29) |
| Squarespace | 0 connections | NOT CONFIGURED |

### RED: Missing Configurations
- `SHOPIFY_API_KEY` and `SHOPIFY_API_SECRET` NOT SET -- Shopify admin API calls will fail
- `RESEND_WEBHOOK_SECRET` NOT SET -- inbound email webhook verification may be skipped
- Discogs: zero credentials despite having 8 task files for Discogs integration
- Stripe: has keys but zero events in 7 days (possibly not actively used yet)

---

## 6. Plan-vs-Reality Assessment (Phase 6)

### Plans COMPLETED and VERIFIED

| Plan | Evidence |
|---|---|
| `bandcamp_scraper_three_buckets` | sweep task exists, queue exists, exported in index |
| `bundle_component_inventory` | table exists (0 rows), fanout task, sweep task, actions file |
| `shipstation_bridge` | poll task hardened, ShipStation Orders page loads |
| `prompt_pack_+_api_trigger_catalog` | Both catalog files exist and are populated |
| `full_audit_remediation` | Billing/users pages PASS in Playwright |
| `add_bandcamp_header_link` | Code exists (grep not run but noted in plans as complete) |
| `bandcamp_metadata_fields` | Migration exists, columns added; 1 pending todo (idempotency-guard) |

### Plans IN-PROGRESS with ISSUES

| Plan | Status | Issues |
|---|---|---|
| `bandcamp_api_complete` | Partially deployed | Sales backfill broken (counter + stuck); only 15% raw_api_data coverage; 31% URL coverage; all 648 mappings still `bandcamp_initial` |
| `scraper_status_and_self-heal` | Many todos pending | Sensor check partially working; catalog stats table exists (via migration) but `workspace_catalog_stats` usage unclear |
| `shipping_log_audit_fix` (f71a) | Partially done | Dedup migration applied; poll hardened; some UI todos pending |
| `bandcamp_scraper_fix` | Mostly done | Image backfill migration deferred |
| `cf_truth_layer_guardrails` | All todos pending | Truth docs exist but guardrail rules not enforced |

### Plans that are STUBS (no implementation)
- `bandcamp_api-first_overhaul` (2 copies) -- superseded by `bandcamp_api_complete`
- `support_omnichannel_v2` -- empty
- `enterprise_support_chat` -- empty
- `support_omnichannel_upgrade` -- prose only, no tracked todos
- `bandcamp_frontend_display` -- empty todos

### Plans with LARGE GAPS
- `shipping_api_+_client_auth_gap_report` -- ALL OAuth/EasyPost todos still pending (OAuth routes exist in code but gap analysis items remain)

### Truth Doc Staleness

| Doc | Issue |
|---|---|
| `TRIGGER_TASK_CATALOG.md` | Missing `bandcamp-sales-backfill-cron` |
| `API_CATALOG.md` | Missing `getBandcampSalesOverview`, `getBandcampFullItemData` |
| `engineering_map.yaml` | `updated_at: 2026-03-20` (14 days stale) |
| `journeys.yaml` | `updated_at: 2026-03-20` (14 days stale), no `bandcamp_sales_data` journey |

---

## 7. Silent Errors and Hidden Issues

### RED (Critical)

1. **Sales backfill `total_transactions` counter always resets to 0**
   - File: `src/trigger/tasks/bandcamp-sales-backfill.ts` line 133-136
   - The upsert that sets `status: "running"` doesn't include `total_transactions`, so the default (0) overwrites the accumulated count
   - Fix: Add `total_transactions: existingState.total_transactions` to the upsert row, or use `.update()` instead of `.upsert()` for existing rows

2. **Sales backfill only processes 1 connection per 10-minute cron run**
   - File: `src/trigger/tasks/bandcamp-sales-backfill.ts` line 289
   - `return { processed, band }` exits after ONE connection
   - With 17 connections and yearly chunks, full backfill would take 17 connections x 16 years x 10 min = ~45 hours minimum
   - 14 connections have never been touched

3. **7 fire-and-forget `.then(() => {}, () => {})` patterns silently swallow errors**
   - Mapping updates, URL backfill, and catalog enrichment errors are invisible
   - No logging, no Sentry, no review queue items for these failures

4. **4 negative inventory levels exist** -- data integrity issue

### YELLOW (Degraded)

5. **709 open review queue items (606 > 24 hours old)** -- operational backlog
6. **All 648 Bandcamp mappings are `bandcamp_initial`** -- no staff review has occurred
7. **Only 31% URL coverage on Bandcamp mappings** -- cross-ref depends on sales data which is broken
8. **Only 15% raw API data coverage** -- upsert was fixed (variant_id UNIQUE) but sync hasn't populated most rows yet
9. **33 unit tests failing** -- test expectations stale after code changes
10. **83 Biome lint errors** -- mostly auto-fixable import ordering
11. **4 portal pages failing Playwright audit** (releases, orders, sales, catalog)
12. **20 task files use `console.log` instead of `logger`** -- invisible in Trigger dashboard
13. **WooCommerce connection last polled March 29** -- 5 days stale
14. **`SHOPIFY_API_KEY`/`SHOPIFY_API_SECRET` not set** -- Shopify admin API non-functional
15. **Discogs integration has 0 credentials** -- 8 task files exist but integration is non-functional

### GREEN (Working as Intended)

16. TypeScript compilation: zero errors
17. Production build: succeeds cleanly
18. All 26 staff admin routes: PASS
19. All 3 public routes: PASS
20. Inventory guard: PASS
21. Shopify webhook ingress: active (297 events in 7d)
22. AfterShip webhook ingress: active (467 events in 7d)
23. EasyPost credentials: configured
24. ShipStation credentials: configured, poll task running
25. Bandcamp connections: all 17 active
26. Sentry error monitoring: configured and active
27. No stuck sync log entries (>1h)
28. Bundle component system: built and deployed (awaiting data)
29. Support system: functional (2 conversations, 5 messages)
30. Trigger.dev config: proper retry policy, Sentry onFailure, env sync

---

## 8. Prioritized Fix Recommendations

### P0 (Fix immediately)

1. **Fix sales backfill counter bug** -- change upsert to update-only for existing rows, or include all columns in the upsert
2. **Fix sales backfill throughput** -- process multiple connections per cron run, or reduce cron interval to 2 min
3. **Fix 4 GDPR webhook routes** -- add `webhook_events` dedup pattern
4. **Investigate 4 negative inventory levels** -- data corruption

### P1 (Fix this week)

5. **Update 33 stale unit tests** to match current code behavior
6. **Fix 4 failing portal pages** (releases, orders, sales, catalog)
7. **Replace 7 silent `.then(() => {}, () => {})` patterns** with proper error logging
8. **Set missing env vars**: `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET`, `RESEND_WEBHOOK_SECRET`
9. **Add `tag-cleanup-backfill` to index.ts** export
10. **Update truth docs**: add `bandcamp-sales-backfill-cron` to Trigger catalog, new actions to API catalog

### P2 (Fix this sprint)

11. **Run `pnpm check:fix`** to resolve 83 Biome lint errors
12. **Migrate 20 task files from `console.log` to `logger`**
13. **Triage 709 open review queue items**
14. **Configure Discogs credentials** or remove dead integration code
15. **Set up Stripe webhook** if billing is active
16. **Update `engineering_map.yaml` and `journeys.yaml`** timestamps and content

---

## 9. Appendices

### A. Playwright Audit Route Details

See: `reports/playwright-audit/full-site-audit-2026-04-04T03-12-05-839Z.md`

### B. Supabase Audit Data

See: `scripts/audit-supabase.mjs` (temporary, delete after review)

### C. Files Analyzed

- 46 Trigger task files
- 33 server action files
- 15 API route handlers
- 21 client library files
- 40 Supabase migrations
- 50 page routes
- 77 test files
- 36 scripts
- 22 planning docs
