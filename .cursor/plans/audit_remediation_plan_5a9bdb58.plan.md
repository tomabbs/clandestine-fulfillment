---
name: Audit Remediation Plan
overview: Remediate all 19 RED and YELLOW issues found in the full-repo audit of 2026-04-04. Organized as 8 discrete tasks grouped by priority (P0 through P2), each with full code context, proposed patches, and verification steps.
todos:
  - id: t1-backfill-fix
    content: "Task 1 (P0): Fix sales backfill counter bug (upsert reset) and throughput (1-connection-per-run bottleneck) in bandcamp-sales-backfill.ts"
    status: completed
  - id: t2-gdpr-dedup
    content: "Task 2 (P0): Add webhook_events dedup INSERT to 4 GDPR route handlers to pass ci-webhook-dedup-guard"
    status: completed
  - id: t3-neg-inventory
    content: "Task 3 (P0): Query and fix the 4 negative inventory levels in warehouse_inventory_levels"
    status: completed
  - id: t4-stale-tests
    content: "Task 4 (P1): Update 33 stale unit tests in bandcamp.test.ts, store-sync-client.test.ts, bandcamp-scraper.test.ts + remaining"
    status: completed
  - id: t5-portal-pages
    content: "Task 5 (P1): Fix 4 failing portal page Playwright expectations (releases redirect, orders redirect, sales errors, catalog hydration)"
    status: completed
  - id: t6-silent-errors
    content: "Task 6 (P1): Replace 7 silent .then(() => {}, () => {}) patterns with logger.warn in 4 task files"
    status: completed
  - id: t7-index-docs
    content: "Task 7 (P1): Add tag-cleanup-backfill to index.ts + update all 4 stale truth docs"
    status: completed
  - id: t8-lint-console
    content: "Task 8 (P2): Run pnpm check:fix for Biome lint + migrate console.log to logger in 4 task files"
    status: completed
isProject: false
---

# Audit Remediation Plan (v2 -- Review-Integrated)

# Feature
Remediate all RED (critical) and YELLOW (degraded) issues identified in `reports/full-repo-audit-2026-04-04.md`.

# Goal
Bring the release gate to PASS across all automated checks (`pnpm check`, `pnpm typecheck`, `pnpm test`, `pnpm build`, CI guards, Playwright full-site audit) and resolve all data-integrity and operational issues. Treat `bandcamp_sales_backfill_state` as a derived checkpoint (not truth) and ensure chunk processing is idempotent and observable.

# Context
The audit on 2026-04-04 found 4 RED critical issues, 15 YELLOW degraded issues, and 15 GREEN working items across the entire codebase. This plan addresses every RED and YELLOW issue with precise, minimal patches. No rewrites -- all fixes are surgical.

Two independent technical reviews were integrated into this v2. Key changes: explicit error-code checking on GDPR dedup, root-cause investigation before inventory correction, one-off reconciliation script for backfill state, standardized silent-error logging fields, and reordered execution (silent errors before queue tuning).

# Requirements

**Functional:**
- Sales backfill must process all 17 connections to completion
- All webhook routes must pass the dedup guard CI check
- All 638 unit tests must pass
- All 47 Playwright-audited portal/admin/public routes must PASS
- Negative inventory levels must be investigated and corrected
- Silent error patterns must be replaced with observable logging
- Task registry must include all tasks invoked by server actions
- Truth docs must reflect current state

**Non-functional:**
- No changes to database schema (no new migrations needed)
- All fixes must be backward-compatible
- Release gate (`pnpm release:gate`) must exit 0 after remediation
- Biome lint must exit 0 after auto-fix

# Constraints

**Technical:**
- Trigger.dev v4: `dirs: ["src/trigger/tasks"]` auto-discovers tasks, but `index.ts` exports are the canonical registry. Any task callable from app code must be explicitly exported.
- Supabase `upsert` without specifying a column sets it to the column default; must include all columns that should be preserved
- Playwright `page.goto()` follows HTTP redirects (Next.js `redirect()` returns 307); the test asserts `<h1>` on the final destination page, not the redirect source
- `channel_sync_log.status` CHECK constraint allows `started|completed|partial|failed` -- NOT `running`. Code and queries must use these values only.
- `webhook_events` dedup uses `UNIQUE(platform, external_webhook_id)` -- Postgres error code `23505` on violation
- `bandcamp_sales` chunk inserts use `upsert` with `ignoreDuplicates: true` on `(workspace_id, bandcamp_transaction_id, bandcamp_transaction_item_id)` -- chunks are already replay-safe
- Backfill task is NOT on `bandcampQueue` (concurrency 1) -- it runs on the Trigger default queue, already isolated from sync tasks
- `crossReferenceAlbumUrls` matches by `subdomain + album_title` and only copies URLs from `item_type = 'album'` sales; physical merch without corresponding album sales will not get URLs this way

**Product:**
- Discogs and Squarespace integrations have zero credentials -- these are pre-production features, not broken production features. Treat as DEFERRED.
- Stripe webhook silence may be intentional (billing not yet active). Treat as DEFERRED.
- `SHOPIFY_API_KEY`/`SHOPIFY_API_SECRET` are deployment secrets that must be set by the operator, not by code changes.

**External:**
- Bandcamp Sales Report API: rate-limited, async report generation with polling
- Trigger.dev: API-triggered tasks stay QUEUED (known platform issue); cron tasks work reliably

# Affected Files

**P0 -- Critical fixes:**
- [src/trigger/tasks/bandcamp-sales-backfill.ts](src/trigger/tasks/bandcamp-sales-backfill.ts) -- counter bug + throughput
- [src/app/api/webhooks/shopify/gdpr/route.ts](src/app/api/webhooks/shopify/gdpr/route.ts) -- dedup
- [src/app/api/webhooks/shopify/gdpr/customers-data-request/route.ts](src/app/api/webhooks/shopify/gdpr/customers-data-request/route.ts) -- dedup
- [src/app/api/webhooks/shopify/gdpr/customers-redact/route.ts](src/app/api/webhooks/shopify/gdpr/customers-redact/route.ts) -- dedup
- [src/app/api/webhooks/shopify/gdpr/shop-redact/route.ts](src/app/api/webhooks/shopify/gdpr/shop-redact/route.ts) -- dedup

**P1 -- This-week fixes:**
- [tests/unit/lib/clients/bandcamp.test.ts](tests/unit/lib/clients/bandcamp.test.ts) -- stale test
- [tests/unit/lib/clients/store-sync-client.test.ts](tests/unit/lib/clients/store-sync-client.test.ts) -- stale test
- [tests/unit/lib/clients/bandcamp-scraper.test.ts](tests/unit/lib/clients/bandcamp-scraper.test.ts) -- timezone flake
- [tests/e2e/full-site-audit.spec.ts](tests/e2e/full-site-audit.spec.ts) -- heading expectations
- [src/trigger/tasks/bandcamp-sync.ts](src/trigger/tasks/bandcamp-sync.ts) -- silent errors (3 instances)
- [src/trigger/tasks/bandcamp-sales-sync.ts](src/trigger/tasks/bandcamp-sales-sync.ts) -- silent errors + console.error
- [src/trigger/tasks/bandcamp-sales-backfill.ts](src/trigger/tasks/bandcamp-sales-backfill.ts) -- silent errors (2 instances) + console.log
- [src/trigger/tasks/index.ts](src/trigger/tasks/index.ts) -- missing tag-cleanup-backfill export

**P2 -- This-sprint fixes:**
- All 326 source files (auto-fix via `pnpm check:fix`)
- [src/trigger/tasks/discogs-mailorder-sync.ts](src/trigger/tasks/discogs-mailorder-sync.ts) -- console.log -> logger
- [src/trigger/tasks/monthly-billing.ts](src/trigger/tasks/monthly-billing.ts) -- console.log -> logger
- [src/trigger/tasks/oauth-state-cleanup.ts](src/trigger/tasks/oauth-state-cleanup.ts) -- console.log -> logger
- [docs/system_map/TRIGGER_TASK_CATALOG.md](docs/system_map/TRIGGER_TASK_CATALOG.md) -- add bandcamp-sales-backfill-cron
- [docs/system_map/API_CATALOG.md](docs/system_map/API_CATALOG.md) -- add missing exports
- [project_state/engineering_map.yaml](project_state/engineering_map.yaml) -- update timestamp + Sales API
- [project_state/journeys.yaml](project_state/journeys.yaml) -- update timestamp + bandcamp_sales_data journey

# Proposed Implementation

## Task 0 (P0 -- execute FIRST): Remove silent error paths

**Rationale (from Review 2):** If errors are swallowed, you cannot trust success metrics, counters, or queue diagnosis. Fix observability BEFORE fixing the backfill logic.

This is Task 6 from the original plan, promoted to execute first. See Task 6 below for the full implementation details. Execute it before Task 1.

---

## Task 1 (P0): Fix sales backfill counter bug + throughput + state reconciliation

**File:** `src/trigger/tasks/bandcamp-sales-backfill.ts`

### Bug 1 -- Counter reset
Line 133 does `upsert({...status: "running"...})` without `total_transactions`, resetting it to 0 on every run.

**Fix:** Split the init logic: use `insert` only for brand-new rows (first run), then `update` for existing rows:

```typescript
// Replace lines 132-142 with:
const { data: existingState } = await supabase
  .from("bandcamp_sales_backfill_state")
  .select("status, total_transactions, last_processed_date")
  .eq("connection_id", connectionId)
  .single();

if (!existingState) {
  await supabase.from("bandcamp_sales_backfill_state").insert({
    connection_id: connectionId,
    workspace_id: workspaceId,
    status: "running",
    total_transactions: 0,
    started_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });
} else {
  await supabase.from("bandcamp_sales_backfill_state").update({
    status: "running",
    updated_at: new Date().toISOString(),
  }).eq("connection_id", connectionId);
}

// Use existingState directly instead of re-querying
const state = existingState ?? { last_processed_date: null, total_transactions: 0 };
```

### Bug 2 -- Throughput
Line 289 `return { processed, band }` exits the cron after ONE connection.

**Fix:** Remove the early return. Keep `triggerAndWait` (needed because child tasks can take up to 5 min polling Bandcamp API -- inlining would exceed the parent's `maxDuration`). Add a time guard:

```typescript
// Replace the inner loop (lines 272-294) in bandcampSalesBackfillCron:
const startTime = Date.now();
const MAX_CRON_RUNTIME_MS = 240_000; // 4 min buffer under 300s maxDuration

for (const conn of connections ?? []) {
  if (Date.now() - startTime > MAX_CRON_RUNTIME_MS) {
    logger.info("Backfill cron: time limit reached, will continue next run");
    break;
  }

  const { data: bfState } = await supabase
    .from("bandcamp_sales_backfill_state")
    .select("status")
    .eq("connection_id", conn.id)
    .single();

  if (bfState?.status === "completed") continue;

  try {
    logger.info("Backfill cron: processing chunk", {
      band: conn.band_name, connectionId: conn.id,
    });
    const result = await bandcampSalesBackfillTask.triggerAndWait(
      { connectionId: conn.id },
    );
    logger.info("Backfill cron: chunk done", { band: conn.band_name, result });
    processed++;
  } catch (err) {
    logger.error("Backfill cron: chunk failed", {
      band: conn.band_name, error: String(err),
    });
  }
}
```

**Note on `triggerAndWait` vs inline (Review 1 #1):** Inline execution was considered but rejected. The child task calls `pollForReport()` which can poll up to 60 attempts x 5s = 300s. This would consume the entire parent `maxDuration` for a single connection. `triggerAndWait` gives the child its own isolated `maxDuration: 300`. The child task is already on the default queue (not `bandcampQueue`), so it does not block sync tasks.

### New: One-off state reconciliation script (Review 2 #1)

**Rationale:** `bandcamp_sales_backfill_state` is a derived checkpoint, not truth. The counter bug has already corrupted it. Before the fixed code runs, reconcile state from the canonical `bandcamp_sales` rows.

Create `scripts/reconcile-backfill-state.mjs`:

```javascript
// For each connection with a backfill_state row:
// 1. Count actual rows in bandcamp_sales
// 2. Get min/max sale_date
// 3. Update total_transactions, earliest_sale_date, latest_sale_date
// Invariant: checkpoint counts must equal canonical counts after reconciliation
```

Run once after deploying the fix. This is NOT a migration -- it's an operational repair script.

### New: Post-backfill URL verification query (Review 1 #7)

After backfill completes, verify URL cross-reference is working:

```sql
SELECT COUNT(*) AS urls_from_sales
FROM bandcamp_product_mappings
WHERE bandcamp_url_source = 'orders_api';
```

If this is 0 after meaningful backfill progress, the `crossReferenceAlbumUrls` function needs investigation. Known limitation: only `item_type = 'album'` sales contribute URLs; physical merch without corresponding album sales will not get URLs.

**Trigger touchpoint:** Task IDs `bandcamp-sales-backfill`, `bandcamp-sales-backfill-cron`. Must deploy to Trigger.dev after code change (`npx trigger.dev deploy`).

---

## Task 2 (P0): Add webhook_events dedup to 4 GDPR routes

**Pattern to add** (from `src/app/api/webhooks/shopify/route.ts` lines 61-77):

Each GDPR route needs a `webhook_events` insert after HMAC verification. Since GDPR payloads have no `X-Shopify-Webhook-Id` header, use a SHA-256 hash of the raw body as the `external_webhook_id`. The DB has `UNIQUE(platform, external_webhook_id)` which triggers Postgres error code `23505` on duplicate.

**Updated pattern (Review 1 #2 -- explicit error-code check):**

```typescript
import { createHash } from "node:crypto";
import { createServiceRoleClient } from "@/lib/server/supabase-server";

// After HMAC verification, before the response:
const supabase = createServiceRoleClient();
const bodyHash = createHash("sha256").update(rawBody).digest("hex");
const { data: inserted, error: dedupError } = await supabase
  .from("webhook_events")
  .insert({
    platform: "shopify",
    external_webhook_id: `gdpr-${bodyHash}`,
    topic: "customers/data_request", // per-route topic
    status: "received",
  })
  .select("id")
  .single();

if (dedupError) {
  if (dedupError.code === "23505") {
    // Unique violation = duplicate webhook delivery
    return NextResponse.json({ ok: true, status: "duplicate" });
  }
  // Real DB error -- log but continue processing (GDPR compliance must not block)
  console.error("webhook_events insert failed:", dedupError);
}
```

This distinguishes duplicate deliveries (return early) from real DB errors (log and continue), avoiding silent loss of GDPR webhook processing on transient failures.

Apply this pattern to all 4 files:
- `gdpr/route.ts` (topic: `"gdpr/combined"`)
- `gdpr/customers-data-request/route.ts` (topic: `"customers/data_request"`)
- `gdpr/customers-redact/route.ts` (topic: `"customers/redact"`)
- `gdpr/shop-redact/route.ts` (topic: `"shop/redact"`)

**Trigger touchpoint:** None (webhook ingress only, no task dispatch).

---

## Task 3 (P0): Investigate root cause and fix 4 negative inventory levels

**Step 1 -- Identify the rows (read-only):**

```sql
SELECT wil.id, wpv.sku, wil.available, wil.reserved, wil.on_hand, wp.title,
       wil.variant_id, wil.workspace_id
FROM warehouse_inventory_levels wil
JOIN warehouse_product_variants wpv ON wil.variant_id = wpv.id
JOIN warehouse_products wp ON wpv.product_id = wp.id
WHERE wil.available < 0;
```

**Step 2 -- Root cause investigation (Review 1 #3, Review 2):**

For each negative variant, query the activity log to find what drove it negative:

```sql
SELECT activity_type, quantity_change, quantity_after, source, reference_id, created_at
FROM warehouse_inventory_activity
WHERE variant_id = '<variant_id>'
ORDER BY created_at DESC
LIMIT 20;
```

Possible root causes:
- **Oversell:** Sale processed before inbound stock recorded
- **Double-decrement:** Race condition in `recordInventoryChange` (unlikely -- inventory guard passes)
- **Bad seed:** Initial quantity set incorrectly during Bandcamp sync
- **Manual error:** Staff adjustment with wrong sign

**Step 3 -- Document the root cause in the commit message.**

**Step 4 -- Fix:** Use `adjustInventory` server action to set `available = 0` for each row. This goes through `recordInventoryChange` for proper audit trail and Redis fanout. If root cause is a systemic code bug, file a separate issue.

**Trigger touchpoint:** `recordInventoryChange` -> Redis fanout -> `multi-store-inventory-push` cron.

---

## Task 4 (P1): Update 33 stale unit tests (7 files)

**bandcamp.test.ts -- "skips items without SKU"** (line 196):
The test expects `unmatched.toHaveLength(0)` but the code now pushes all non-matched items to `unmatched`.

**Clarification (Review 1 #4):** The new behavior is INTENTIONAL. The `matchSkuToVariants` function was changed during the API-complete work so that items without SKUs flow to `unmatched`, where they are picked up by the `generateSku` auto-SKU-generation logic in `bandcamp-sync.ts`. The old behavior (silently dropping zero-SKU items) was the bug. The test must be updated to match the correct new behavior.

Fix: update assertion to `expect(result.unmatched).toHaveLength(2)` (both items without SKU land in `unmatched`).

**store-sync-client.test.ts -- "shopify client methods throw 'not yet implemented'"** (line 89):
The Shopify client now has a real `pushInventory`/`getRemoteQuantity` implementation using `findVariantBySku` and actual Shopify API calls (confirmed in `store-sync-client.ts` lines 95-130). The test expects the old "not yet implemented" throw.

Fix: The test should verify the Shopify client is created successfully and that its methods are callable functions. Mock the HTTP layer (or accept that the methods throw an HTTP error when no real Shopify store exists), and update the assertion to match the real error message pattern (`"Shopify variant lookup failed: HTTP..."`).

**bandcamp-scraper.test.ts -- releaseDate month off-by-one** (line 68):
`getMonth()` returns local timezone month; fixture date is `"01 Mar 2026 00:00:00 GMT"` which is Feb 28 in US timezones. Fix: change assertion to `getUTCMonth()` for timezone stability:

```typescript
expect(result?.releaseDate?.getUTCMonth()).toBe(2); // March = 2 (0-indexed, UTC)
```

**Remaining ~30 failures:** Run `pnpm test` after the above 3 fixes and identify remaining failures from the same root causes. Most are likely in the same 7 files.

---

## Task 5 (P1): Fix 4 failing portal pages in Playwright audit

**Approach (Review 2 #9):** Group page fixes by technical failure class, not by route:

### Class A: Redirect pages (releases, orders)

**`/portal/releases`** -- Server redirect via `redirect("/portal/catalog")`. Playwright follows the 307 and loads `/portal/catalog`, but the test asserts `<h1>` matches `/releases/i`. The destination page renders `<h1>Catalog</h1>`.

**`/portal/orders`** -- Server redirect via `redirect("/portal/fulfillment")`. Destination renders `<h1>Fulfillment</h1>`.

**Fix in `tests/e2e/full-site-audit.spec.ts`:** Update heading regexes to match the destination page:

```typescript
{ path: "/portal/releases", heading: /catalog/i },
{ path: "/portal/orders", heading: /fulfillment/i },
```

### Class B: Hydration gate blocking h1 (catalog)

**`/portal/catalog`** -- Uses `useState(false)` + `useEffect(() => setHydrated(true), [])` pattern. The `<h1>Catalog</h1>` is INSIDE the hydration guard (only renders when `hydrated && !isLoading`). Playwright's 10s timeout for `<h1>` should be enough after hydration, but the 51ms load time + zero data may cause the page to render the loading spinner permanently if the query never resolves.

**Fix:** Move `<h1>` above the hydration gate so it renders immediately regardless of data state. The loading spinner should appear below the heading, not instead of it.

### Class C: Data loader errors (sales, catalog)

**`/portal/sales`** -- `<h1>Sales</h1>` is present, but the page has 11 page errors. The hydration mismatch comes from `new Date(o.created_at).toLocaleDateString()` on line 113 (locale-dependent). The server renders the date in its locale (usually `en-US` / UTC), but the Playwright browser hydrates with a potentially different locale, causing React to throw a mismatch.

**Fix:** Replace `toLocaleDateString()` with a locale-agnostic formatter. Options (in order of preference):
1. Use the existing `date-fns` dependency: `format(new Date(o.created_at), "yyyy-MM-dd")`
2. Use `new Date(o.created_at).toISOString().slice(0, 10)` for a stable UTC date string
3. Wrap in a client-only guard (less ideal -- delays rendering)

Also add defensive null/empty checks in the data rendering to handle the test org having no sales data.

**`/portal/catalog`** -- also has page errors from queries failing for the test org (no catalog data seeded).

**Fix:** Ensure loading/error states render gracefully without throwing.

### Review 2 #10: Deterministic dynamic route tests

For `/admin/catalog/[id]`, `/admin/clients/[id]`, `/admin/inbound/[id]` (currently SKIPPED):

**Fix:** Enhance `createTestOrg` to also call `createTestProduct` so there is at least one record for dynamic route testing. Alternatively, test with a known-bad ID to verify 404/not-found handling.

---

## Task 6 (P1, but execute FIRST per Task 0): Replace 7 silent `.then(() => {}, () => {})` patterns

**Priority note (Review 2 #3):** This is higher priority than queue or counter fixes. If errors are swallowed, you cannot trust success metrics, counters, or queue diagnosis.

Replace each instance with structured error logging.

**Pattern -- before:**
```typescript
.then(() => {}, () => {});
```

**Pattern -- after (Review 2 #3 -- standardized logging fields):**
```typescript
.then(
  () => {},
  (err) => logger.warn("Non-critical DB write failed", {
    error: String(err),
    task: "bandcamp-sync",       // task name
    context: "channel_sync_log", // what was being written
    connectionId,                // connection context where available
  }),
);
```

**Specific instances and context:**

| File | Line | What is silenced | Risk if silent |
|------|------|-----------------|----------------|
| `bandcamp-sync.ts` | 413 | `channel_sync_log` insert (scrape success) | Scrape audit trail lost |
| `bandcamp-sync.ts` | 446 | `channel_sync_log` insert (scrape failure) | Failure audit trail lost |
| `bandcamp-sync.ts` | 900 | `channel_sync_log` insert (SKU overwrite) | SKU change audit lost |
| `bandcamp-sales-backfill.ts` | 195 | `bandcamp_product_mappings` update | Catalog number/UPC/URL enrichment silently fails |
| `bandcamp-sales-backfill.ts` | 209 | `bandcamp_product_mappings` update (via variant match) | Same -- URL backfill broken invisibly |
| `bandcamp-sales-sync.ts` | 113 | `bandcamp_product_mappings` update | Daily URL enrichment silently fails |
| `shipstation-poll.ts` | 420 | `channel_sync_log` insert (order auto-link) | Non-critical but should be visible |

Also replace `console.log` on line 218 of `bandcamp-sales-backfill.ts` with `logger.info`, and `console.error` on lines 116/120 of `bandcamp-sales-sync.ts` with `logger.error`.

---

## Task 7 (P1): Add tag-cleanup-backfill to index.ts + update truth docs

**`src/trigger/tasks/index.ts`** -- Add export:
```typescript
// ── Tag cleanup (admin settings) ──────────────────────────────────────────────
export { tagCleanupBackfillTask } from "./tag-cleanup-backfill";
```

**Verified (Review 1 #6):** The exported symbol in `src/trigger/tasks/tag-cleanup-backfill.ts` is confirmed as `tagCleanupBackfillTask` (line 18). The action `src/actions/admin-settings.ts` invokes it via `tasks.trigger("tag-cleanup-backfill", ...)` (line 106) using the string task ID, which matches the `id: "tag-cleanup-backfill"` in the task definition.

**Truth doc updates:**
- `TRIGGER_TASK_CATALOG.md`: Add row for `bandcamp-sales-backfill-cron` (cron `*/10 * * * *`) under Scheduled Tasks
- `API_CATALOG.md`: Add `getBandcampSalesOverview`, `getBandcampFullItemData` under Integrations + Store Mapping
- `engineering_map.yaml`: Update `updated_at` to `2026-04-04`, add Sales API and SKU reconciliation to integrations responsibilities
- `journeys.yaml`: Update `updated_at` to `2026-04-04`, add `bandcamp_sales_data` journey

---

## Task 8 (P2): Biome lint auto-fix + console.log migration

**Biome:** Run `pnpm check:fix` to resolve 83 import-ordering errors automatically.

**console.log -> logger migration** (4 files with `console.log`, 2 files with `console.error`):
- `bandcamp-sales-backfill.ts` line 218: `console.log` -> `logger.info`
- `discogs-mailorder-sync.ts`: find `console.log` -> `logger.info`
- `monthly-billing.ts`: find `console.log` -> `logger.info`
- `oauth-state-cleanup.ts`: find `console.log` -> `logger.info`
- `bandcamp-sales-sync.ts` lines 116, 120: `console.error` -> `logger.error`

Each file must add `import { logger } from "@trigger.dev/sdk"` if not already present.

# Assumptions

- The 4 negative inventory rows are isolated data issues (not a systemic code bug), since the inventory guard CI check passes. Root cause investigation (Task 3) will confirm or reject this assumption.
- The 33 unit test failures are all traceable to the 3 root causes identified (SKU matching behavior change, Shopify client implementation, timezone flake) -- not to undiscovered production bugs. The new `matchSkuToVariants` behavior (pushing zero-SKU items to `unmatched`) is intentional for auto-SKU generation.
- Discogs, Squarespace, and Stripe integrations are intentionally pre-production and do not need credential configuration as part of this remediation
- The `SHOPIFY_API_KEY`/`SHOPIFY_API_SECRET` env vars are deployment-time secrets that the operator will configure; they are not a code fix
- `bandcamp_sales` chunk inserts are already idempotent via `upsert` with `ignoreDuplicates: true` on a composite UNIQUE key -- no additional dedup work needed for the data layer
- The backfill task's use of `triggerAndWait` is correct for task isolation (child polling can take up to 300s); inlining was considered and rejected
- `channel_sync_log.status` uses `started|completed|partial|failed` (NOT `running`) per the CHECK constraint in migration `20260316000008`

# Risks

- **Sales backfill throughput change** could exceed `maxDuration` (300s) if many connections need processing in one cron run. Mitigated by the 240s time guard. Each `triggerAndWait` gets its own 300s `maxDuration` in the child task.
- **GDPR dedup using body hash** could collide if Shopify sends identical payloads for different events (unlikely for GDPR, which contains unique shop/customer IDs in the body).
- **GDPR dedup DB errors** (non-duplicate) now log and continue instead of silently dropping. Risk: a persistent DB issue could process the same webhook multiple times. Mitigated: GDPR endpoints are acknowledgment-only (no side effects beyond the dedup row).
- **Unit test updates** may reveal additional stale tests beyond the 3 identified root causes.
- **Biome auto-fix** could introduce formatting changes across many files, creating a large diff. Run as a standalone commit to keep it reviewable.
- **State reconciliation script** could temporarily show incorrect totals if run while backfill is actively processing. Mitigated: run during low-activity window or pause the cron first.

# Validation Plan

After all fixes:
```bash
pnpm check          # Must exit 0 (currently 83 errors)
pnpm typecheck      # Must exit 0 (currently passes)
pnpm test           # Must exit 0 (currently 33 failures)
pnpm build          # Must exit 0 (currently passes)
bash scripts/ci-inventory-guard.sh     # Must exit 0
bash scripts/ci-webhook-dedup-guard.sh # Must exit 0 (currently fails on 4 GDPR routes)
pnpm test:e2e:full-audit               # Target: 0 FAIL routes
bash scripts/release-gate.sh           # Full gate must exit 0
```

Post-deploy verification:
- Monitor `bandcamp_sales_backfill_state` -- all 17 connections should progress from 2010 forward
- `total_transactions` should accumulate correctly (not reset to 0)
- Trigger.dev dashboard: `bandcamp-sales-backfill-cron` runs should process multiple connections per run
- Negative inventory levels query should return 0 rows

# Rollback Plan

Each task is independently revertable:
- **Task 1 (backfill):** Revert the file and redeploy to Trigger.dev. Backfill will pause (not lose data -- `bandcamp_sales` rows are idempotent via UNIQUE constraint)
- **Task 2 (GDPR dedup):** Revert files. GDPR routes revert to no-dedup (acceptable -- these are compliance acknowledgments, not data-processing hooks)
- **Task 3 (negative inventory):** If adjustments are wrong, use `adjustInventory` to correct back. All changes go through `recordInventoryChange` with audit trail
- **Tasks 4-8:** Pure test/lint/doc/logging changes. Revert any commit individually with no production impact

# Rejected Alternatives

- **Rewrite the backfill as a single long-running task:** Rejected because Trigger.dev `maxDuration` is 300s and long tasks risk timeouts. The chunked cron approach is correct; it just needs to process more connections per run.
- **Inline execution instead of `triggerAndWait` (Review 1 #1):** Rejected after research. The child task calls `pollForReport()` which polls up to 60 x 5s = 300s. Inlining would consume the entire parent `maxDuration` for a single connection. `triggerAndWait` gives each child its own isolated 300s budget.
- **Fire-and-forget `.trigger()` instead of `.triggerAndWait()` (Review 1 #1 alternative):** Rejected because the cron needs to know when a chunk completes to advance to the next connection. Fire-and-forget would create orphan tasks with no coordination.
- **Remove GDPR routes entirely:** Rejected because Shopify requires these endpoints for app approval.
- **Floor negative inventory at 0 in the DB via CHECK constraint:** Rejected because this would hide the root cause. Better to investigate and fix the specific rows, then add the constraint after confirming no code path legitimately sets negative values.
- **Skip Biome fixes:** Rejected because `pnpm check` is a release-gate requirement.
- **Blindly enable RLS on all tables (Review 2 #8):** Rejected. Tables must be classified as user-facing multi-tenant (needs RLS), internal worker (service-role-only), or append-only audit (staff read / service write). Not in scope for this remediation but noted for future hardening.
- **Dedicated backfill queue (Review 2 #5):** Not needed -- research confirmed the backfill task is already NOT on `bandcampQueue`. It runs on the Trigger default queue, isolated from sync tasks by default.

# Open Questions

1. **Are the 4 negative inventory SKUs still in active use?** Need the query results to determine whether to zero them out or investigate further.
2. **Should the backfill cron frequency be increased to `*/5 * * * *` during the catch-up period?** Currently at `*/10`; the throughput fix reduces pressure but faster cron would complete backfill sooner.
3. **What `topic` value should the combined GDPR route use?** The file handles all 3 GDPR topics in one handler. Proposed: parse the topic from the request body and use it in `webhook_events`.

# Deferred Items

**Operational (require staff action, not code):**
- **Review queue triage** (issue #5, 709 items) -- staff must triage through the admin UI
- **Bandcamp `authority_status` review** (issue #6) -- all 648 mappings are `bandcamp_initial`; staff must review and promote to `warehouse_reviewed`
- **Discogs credential configuration** (issue #15) -- pre-production feature, defer until activated
- **Squarespace connection setup** -- no connections exist, defer until client onboarding
- **Stripe webhook registration** (issue #19) -- billing may not be active yet; defer until billing launch
- **WooCommerce poll staleness** (issue #13) -- `client-store-order-detect` cron handles this; may need manual connection investigation

**Env var / operator actions:**
- **`SHOPIFY_API_KEY`/`SHOPIFY_API_SECRET`** (issue #14) -- deployment secrets
- **`RESEND_WEBHOOK_SECRET`** -- deployment secret

**Auto-resolving after backfill fix:**
- **Bandcamp URL coverage** (issue #7) and **raw API data coverage** (issue #8) -- will improve as sales backfill progresses; `crossReferenceAlbumUrls` runs after each chunk. Limitation: only `item_type = 'album'` sales contribute URLs.

**Future hardening (from reviews, not in this remediation):**
- **CI check for task registration** -- lint that compares task files on disk vs exports in index.ts vs tasks referenced by actions/routes
- **Stale-run recovery for `channel_sync_log`** -- define recovery behavior for stuck `started` entries; consider heartbeat/lease model
- **Repair scripts** -- `reconcile-bandcamp-sales-state` (created in Task 1), plus future: `replay-stuck-channel-sync`, `rebuild-derived-catalog-stats`
- **Status vocabulary normalization** -- standardize lifecycle/result enums across jobs, sync logs, and health checks
- **API correctness probes** -- beyond connectivity, verify transformation correctness for Bandcamp sale normalization, ShipStation mapping, etc.
- **RLS table classification** -- distinguish user-facing, worker, and audit tables before enabling RLS broadly
- **Optimistic locking for concurrent task races** -- `processing_lock` timestamp or `UPDATE ... WHERE processing_lock IS NULL` pattern for bandcamp mapping updates
- **Sweep observability metrics** -- `sweep.items_triggered`, `sweep.items_skipped_unresolvable`, `scrape.success_rate` for scraper health dashboard
- **Bandcamp API pacing** -- global token bucket or per-queue pacing with exponential backoff on 429/403 (currently handled per-request but not globally coordinated)

# Execution Order (updated per reviews)

```
1. Task 6/0 -- Remove silent error paths (prerequisite for all other fixes)
2. Task 1   -- Fix backfill counter + throughput + reconciliation script
3. Task 3   -- Investigate negative inventory (root cause before correction)
4. Task 2   -- GDPR dedup (compliance)
5. Task 4   -- Update stale unit tests (CI green)
6. Task 5   -- Fix portal pages (Playwright green)
7. Task 7   -- Task registration + truth docs
8. Task 8   -- Biome lint + console.log migration (separate commit)
```

# Revision History

- v1 (2026-04-04): Initial remediation plan covering all 19 RED+YELLOW audit findings
- v2 (2026-04-04): Integrated technical reviews 1-2. Changes:
  - Promoted silent-error removal to execute first (Review 2 #3)
  - Added explicit `error.code === "23505"` check for GDPR dedup (Review 1 #2)
  - Added root-cause investigation step before inventory correction (Review 1 #3, Review 2)
  - Clarified SKU test behavior as intentional (Review 1 #4)
  - Added state reconciliation script for backfill (Review 2 #1)
  - Added post-backfill URL verification query (Review 1 #7)
  - Confirmed `tagCleanupBackfillTask` export name (Review 1 #6)
  - Added standardized logging fields for silent-error replacement (Review 2 #3)
  - Rejected inline backfill execution after research (Review 1 #1)
  - Rejected dedicated backfill queue after research (Review 2 #5)
  - Added future hardening items from Review 2 to Deferred section
  - Added execution order section
  - Expanded constraints with verified DB schema details
- v3 (2026-04-04): Integrated technical reviews 3-4 (validation reviews). Changes:
  - Confirmed GDPR hashing uses raw body (not re-serialized JSON) -- no change needed
  - Enhanced hydration fix for `/portal/sales` with specific `date-fns` / ISO formatter recommendation
  - Added 3 future hardening items from review 4: optimistic locking, sweep metrics, API pacing
  - Confirmed all review 4 references to older plans (three-buckets, variant_id UNIQUE) are already completed in production
