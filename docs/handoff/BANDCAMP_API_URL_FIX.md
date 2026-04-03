# Bandcamp API URL Coverage Fix

# Feature
Bandcamp API Complete — all merch item data captured from API, URLs stored on every mapping, scraper reduced to enrichment-only.

# Goal
Get URL coverage from 22% (122/550) to ~100% by ensuring the deployed Trigger.dev code writes `bandcamp_url` from `merchItem.url` (API-provided) on every sync cycle. Additionally verify that sales backfill, SKU auto-generation, inventory seeding, and authority lifecycle are all functioning.

# Context
The `bandcamp_api_complete` plan was implemented across multiple commits on 2026-04-02:
- Migration `20260402210000` added 12 new columns to `bandcamp_product_mappings`, created `bandcamp_sales` and `bandcamp_sales_backfill_state` tables
- `merchItemSchema` expanded with `subdomain`, `options[]`, `origin_quantities[]`, `is_set_price`
- `bandcamp-sync.ts` rewritten to store ALL API fields, respect `authority_status`, seed inventory, overwrite SKUs
- `bandcamp-sales-backfill.ts` and `bandcamp-sales-sync.ts` created
- `bandcamp-scrape-sweep.ts` simplified (Group 2 URL construction removed)
- `triggerScrapeIfNeeded` simplified (URL construction removed, API URL only)

**ROOT CAUSE CONFIRMED:** The `.upsert()` on the matched item path uses `onConflict: "variant_id"` but `variant_id` only has an INDEX, not a UNIQUE constraint, on `bandcamp_product_mappings`. Supabase returns `"there is no unique or exclusion constraint matching the ON CONFLICT specification"` and the upsert silently fails. The new fields never get written to existing mappings. This has been the case since the original table creation — matched item updates via upsert have **never worked**. The 122 URLs that do exist came from `.insert()` (unmatched path) or `.update()` (scraper/order-sync paths).

---

# Requirements

## Functional:
- Every `bandcamp_product_mappings` row must have `bandcamp_url` populated from API `merchItem.url` after one sync cycle
- `raw_api_data` jsonb must be populated on every mapping (proves new code ran)
- `bandcamp_subdomain` and `bandcamp_album_title` must be populated from API
- Sales backfill tasks must complete and populate `bandcamp_sales`
- SKU auto-generation must work for items without SKUs
- Inventory seeding must work for items where warehouse is 0 and Bandcamp has stock

## Non-functional:
- Sync must complete within 30 min (current `maxDuration: 1800`)
- No data loss during deployment transition
- Dashboard must reflect accurate counts immediately after sync

---

# Constraints

## Technical:
- Trigger.dev cron schedules may cache deployment versions
- `bandcamp-api` queue has concurrency 1 — tasks serialize
- Migration already applied (columns exist in DB)

## Product:
- 550 existing mappings must be updated in-place, not recreated
- Authority lifecycle must default to `bandcamp_initial` for all existing items

## External:
- Bandcamp API rate limits are undocumented — one connection at a time
- Sales Report API v4 returns `bandcamp_transaction_item_id` (required NOT NULL)
- `get_merch_details` returns `url` field (undocumented but confirmed stable)

---

# Affected files

| File | Lines | Role | Status |
|------|-------|------|--------|
| `src/trigger/tasks/bandcamp-sync.ts` | 1606 | Main sync — stores all API fields, authority lifecycle, SKU overwrite, inventory seeding | Code correct, **not executing in production** |
| `src/lib/clients/bandcamp.ts` | 646 | API client — expanded schemas, Sales API, `updateSku`, option-level matching | Code correct, deployed |
| `src/trigger/tasks/bandcamp-sales-backfill.ts` | 240 | All-time sales backfill in yearly chunks | Created, **tasks queued but not completing** |
| `src/trigger/tasks/bandcamp-sales-sync.ts` | 134 | Daily sales sync cron | Created, not yet due (cron 5am UTC) |
| `src/trigger/tasks/bandcamp-scrape-sweep.ts` | ~120 | Sweep — Group 2 removed, enrichment only | Code correct |
| `src/actions/bandcamp.ts` | 606 | Server actions — scraper health, sales overview, full item data | Code correct, reads from DB |
| `src/app/admin/settings/bandcamp/page.tsx` | ~660 | Admin UI — 3 tabs (Accounts, Health, Sales) | Code correct, displays what DB has |
| `supabase/migrations/20260402210000_bandcamp_api_complete.sql` | 159 | Schema — new columns, tables, indexes, RLS | **Applied successfully** |
| `src/trigger/tasks/index.ts` | ~90 | Task exports | Exports `bandcampSalesBackfillTask`, `bandcampSalesSyncSchedule` |

---

# Audit findings

## CRITICAL: Missing UNIQUE constraint on variant_id causes silent upsert failure

**Root cause (confirmed via live test):**

The matched item upsert at `bandcamp-sync.ts:844` uses:
```typescript
await supabase.from("bandcamp_product_mappings").upsert(
  upsertPayload,
  { onConflict: "variant_id" },
);
```

But `variant_id` on `bandcamp_product_mappings` has only an INDEX (`idx_bandcamp_mappings_variant`), **not a UNIQUE constraint**. Supabase returns:
```
"there is no unique or exclusion constraint matching the ON CONFLICT specification"
```

The upsert **silently fails** — no error thrown to the caller, no data written. This means:
- The new code IS running (Trigger deployment is fine)
- But every upsert on an existing mapping is a no-op
- Only `.insert()` (unmatched path) and `.update()` (scraper/order-sync) have ever worked

**Evidence:**
```
raw_api_data populated:     0 / 550 (upsert never writes to existing rows)
bandcamp_subdomain:         0 / 550
bandcamp_album_title:       0 / 550
URL source 'orders_api':    0 (new upsert path)
URL source 'constructed':   62 (old .update() path from scraper)
URL source 'scraper_verified': 60 (old .update() path from scrape task)
URL source null:            428
```

**Original migration (20260316000007):**
```sql
CREATE TABLE bandcamp_product_mappings (
  ...
  variant_id uuid NOT NULL REFERENCES warehouse_product_variants(id) ON DELETE CASCADE,
  ...
);
CREATE INDEX idx_bandcamp_mappings_variant ON bandcamp_product_mappings(variant_id);
-- NOTE: INDEX, not UNIQUE constraint
```

**Fix:** Add `UNIQUE` constraint on `variant_id` (or change upsert to select + update pattern).

**Initial assessment of "deployment version mismatch" was WRONG.** The code is running; the database constraint is missing.

## HIGH: Sales backfill not completing

**Evidence:**
```
bandcamp_sales rows:              0
bandcamp_sales_backfill_state:    0 rows (empty table)
```

Two backfill tasks were triggered (NS + SUSS) with run IDs `run_cmnhtid6q92vt0imspnmz8un8` and `run_cmnhtidaz9afr0on3n6st7cfn`. Both showed `QUEUED` status. They may have failed silently or are blocked behind the API queue.

## MEDIUM: `matchSkuToVariants` drops zero-SKU items silently

Items with NO SKU and NO option SKUs are not added to either `matched` or `unmatched`. They vanish from the pipeline. Approximately 33 items are affected. The `generateSku` auto-generation code handles items in `unmatched` that lack SKUs, but items that never reach `unmatched` are lost.

## LOW: Bug in `getBandcampFullItemData`

Line 567 in `src/actions/bandcamp.ts`:
```typescript
.eq("sku", mapping.bandcamp_item_id ? undefined : undefined)
```
This always passes `undefined`, making the first sales query ineffective. The meaningful path is the `variant.sku` branch below it.

---

# Preflight results (verified 2026-04-03)

```
Duplicate variant_id rows:          0 (safe to add UNIQUE)
Sales backfill run status:          EXPIRED (TTL 10m — queue was busy, not an error)
bandcamp_sales UNIQUE constraint:   OK (works correctly)
```

---

# Proposed implementation (ordered, minimal blast radius)

## Step 0: Preflight (DONE)
- Duplicate `variant_id` check: **0 duplicates** — safe to proceed
- `bandcamp_sales` UNIQUE: **works** — backfill upserts will succeed
- Backfill runs: **EXPIRED** — need longer TTL or dedicated queue

## Step 1: Migration — add UNIQUE constraint on variant_id

```sql
-- Fix: variant_id needs UNIQUE constraint for upsert ON CONFLICT to work.
-- Preflight confirmed 0 duplicate rows — safe to apply.
DROP INDEX IF EXISTS idx_bandcamp_mappings_variant;
ALTER TABLE bandcamp_product_mappings
  ADD CONSTRAINT uq_bandcamp_mappings_variant_id UNIQUE (variant_id);
```

Apply: `supabase db push --yes`

If migration fails (unexpected duplicates in prod): fallback to SELECT + UPDATE pattern in sync code.

## Step 2: Code fixes (before first post-fix sync)

**2a. Add error handling on upsert** — surface Supabase errors instead of swallowing:
```typescript
// bandcamp-sync.ts matched path — after the upsert call
const { error: upsertError } = await supabase
  .from("bandcamp_product_mappings")
  .upsert(upsertPayload, { onConflict: "variant_id" });

if (upsertError) {
  logger.error("Mapping upsert failed", {
    variantId, error: upsertError.message,
    payload: { url: upsertPayload.bandcamp_url, subdomain: upsertPayload.bandcamp_subdomain },
  });
  itemsFailed++;
  continue;
}
```

**2b. Fix `matchSkuToVariants` zero-SKU gap:**
```typescript
// AFTER (includes all items for auto-SKU generation):
if (!optionMatched) {
  unmatched.push(item);
}
```

**2c. Fix `getBandcampFullItemData` broken query** — remove the `.eq("sku", undefined)` query; the `variant.sku` branch handles it.

**2d. Sales backfill TTL fix** — the backfill tasks expired because they waited 10+ min in the `bandcamp-api` queue (concurrency 1). Fix by either:
- Removing `queue: bandcampQueue` from the backfill task (let it run on default queue), OR
- Setting a longer TTL on the trigger call

## Step 3: Deploy (staged)

```bash
supabase db push --yes          # Apply UNIQUE constraint
pnpm typecheck                  # Verify
npx trigger.dev@latest deploy   # Deploy code fixes
git add . && git commit && git push  # Vercel deploy
```

## Step 4: Canary run — one workspace, URLs only

Trigger manual sync. For the first run, inventory seeding and SKU overwrites will execute (authority_status = `bandcamp_initial` on all rows). Monitor:

```sql
-- Verify new fields populated
SELECT COUNT(*) FROM bandcamp_product_mappings WHERE raw_api_data IS NOT NULL;
SELECT COUNT(*) FROM bandcamp_product_mappings WHERE bandcamp_url IS NOT NULL;
SELECT COUNT(*) FROM bandcamp_product_mappings WHERE bandcamp_subdomain IS NOT NULL;

-- Check for SKU overwrites
SELECT * FROM channel_sync_log
WHERE sync_type = 'sku_overwrite' ORDER BY created_at DESC LIMIT 10;

-- Spot-check 10 updated mappings
SELECT bandcamp_url, bandcamp_subdomain, bandcamp_album_title,
       (raw_api_data->>'url') as api_url
FROM bandcamp_product_mappings
WHERE raw_api_data IS NOT NULL LIMIT 10;
```

## Step 5: Re-trigger sales backfill (after sync confirmed working)

Trigger with dedicated queue or longer TTL. Monitor `bandcamp_sales` row count and `bandcamp_sales_backfill_state`.

## Step 6: Full verification

- Dashboard URL coverage should jump from 22% toward 100% (for matched items)
- Sales History tab should show data per connection
- Sensor readings should show healthy merch_sync_log_stale

---

# Assumptions
- The code in git is correct — the issue is a missing UNIQUE constraint on `variant_id` causing silent upsert failures
- Migration `20260402210000` was successfully applied (confirmed via `supabase db push`)
- The Bandcamp API continues to return `url` on merch items (undocumented but verified)
- Adding UNIQUE on `variant_id` is safe — **verified: 0 duplicate rows** (preflight 2026-04-03)
- The `bandcamp-api` queue (concurrency 1) is not permanently blocked — backfill runs expired from TTL, not from a stuck task
- Sales backfill tasks expired (TTL 10m) because they waited behind sync tasks in the same queue — need queue separation or longer TTL

---

# Risks
- **Duplicate variant_id rows** — before adding UNIQUE, must check for duplicate `variant_id` values. If any exist, dedup first or the constraint will fail. Query: `SELECT variant_id, COUNT(*) FROM bandcamp_product_mappings GROUP BY variant_id HAVING COUNT(*) > 1`
- **Inventory seeding on first successful sync** — 152 items will get seeded from Bandcamp quantities (confirmed correct behavior, but sudden inventory changes may surprise staff). Consider using a feature flag to disable seeding on first run, verify URLs populate, then enable seeding.
- **SKU overwrites** — matched items will have warehouse SKUs overwritten with Bandcamp SKUs (logged to `channel_sync_log` for audit)
- **Sales backfill may also have constraint issues** — verify `bandcamp_sales` UNIQUE constraint exists and is correct before re-triggering
- **All 98+ matched items will be updated simultaneously** — first successful sync after the fix writes ~20 fields on ~98 rows in one run. Monitor for timeout.

---

# Validation plan
1. After redeploy + manual sync: `raw_api_data IS NOT NULL` count > 0
2. `bandcamp_url IS NOT NULL` count > 122 (ideally ~550 for matched + newly created)
3. `bandcamp_subdomain IS NOT NULL` count > 0
4. `channel_sync_log` latest `merch_sync` shows `matchRate` and `metadata` with `totalMerchItems`
5. `bandcamp_sales` has rows after backfill completes
6. Dashboard Scraper & Catalog Health tab shows increased URL coverage
7. Dashboard Sales History tab shows per-connection data

---

# Rollback plan
- Redeploy previous Trigger version if new sync causes errors
- SKU changes recoverable from `channel_sync_log` (`sync_type: "sku_overwrite"`)
- Inventory seeds are idempotent (correlation ID prevents double-seeding)
- `authority_status` can be reset to `bandcamp_initial` if needed
- New columns/tables are additive — no data loss from reverting code

---

# Rejected alternatives
- **Change upsert to SELECT + UPDATE pattern**: Would work without the constraint but adds N+1 queries per sync cycle. Adding UNIQUE is cleaner and `variant_id` should be unique anyway.
- **Delete and recreate all mappings**: Destructive; would lose scraper data (about, credits, tracks, art URLs)
- **Run SQL to backfill URLs directly from the API call**: Possible as a one-time patch but doesn't fix the underlying upsert issue — every future sync would still fail to update
- **Wait for next cron cycle**: Cron IS running but upserts fail; waiting won't help

---

# Open questions
1. **~~Why is Trigger.dev running old code?~~** RESOLVED — Trigger IS running new code. The upsert fails silently due to missing UNIQUE constraint.
2. **~~Are there duplicate `variant_id` values?~~** RESOLVED — 0 duplicates. Safe to add UNIQUE.
3. **~~Did the sales backfill tasks fail?~~** RESOLVED — EXPIRED (TTL 10 min). Queue was busy with sync tasks. Need longer TTL or separate queue.
4. **Should the backfill task use a different queue?** Currently on `bandcamp-api` (concurrency 1) which is shared with sync/sale-poll. A dedicated queue or no queue (default) would let backfills run without competing.
5. **Should inventory seeding be staged?** First successful sync will seed 152+ items. User directive says yes (Bandcamp is truth for initial stock), but could stage URL-only first, seeding second if cautious.

---

# Deferred items
- **Catalog page Bandcamp data panel**: Depends on sync writing data first; build after URLs are confirmed populating
- **SKU reconciliation tool**: Needs catalog_number from sales data; build after sales backfill completes
- **Scraper simplification verification**: Group 2 removal is deployed but untestable until URLs come from API
- **`updateSku` auto-push for zero-SKU items**: Feature flag is enabled but `matchSkuToVariants` drops zero-SKU items before they reach the auto-gen code (Step 4 above fixes this)

---

# Revision history
- **2026-04-03 14:30 EDT**: Integrated second technical review. All preflight checks passed: 0 duplicate variant_ids, backfill EXPIRED (TTL not error), bandcamp_sales UNIQUE works. Updated implementation to staged rollout: migration → code fixes (error handling, zero-SKU gap, backfill TTL) → canary sync → sales backfill. Added observability requirements, upsert error surfacing, backfill queue separation.
- **2026-04-03 14:00 EDT**: Root cause confirmed — missing UNIQUE constraint on `variant_id` causes silent upsert failure (tested via live Supabase query). Updated all sections. Previous "Trigger.dev deployment mismatch" diagnosis was WRONG. Integrated first technical review: alternative root causes verified, duplicate check risk, inventory seeding staging.
- **2026-04-03 13:30 EDT**: Initial audit — discovered zero new-format writes despite multiple deploys. Incorrectly attributed to Trigger.dev deployment version caching.
- **2026-04-02**: Plan implemented across commits `b932300` (API complete), `ad851dc` (scraper simplification), `eb63a66` (SKU auto-gen), `c2568aa` (sales UI), `a6419aa` (email filter), `45ff0b1` (support emails)
