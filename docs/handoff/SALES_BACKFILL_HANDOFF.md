# Sales Backfill System — Full Handoff Document

**Date:** 2026-04-05
**Session:** Full audit + remediation of Bandcamp sales data pipeline
**Status:** PARTIALLY WORKING — 48,067 of ~200K+ expected sales captured (estimated 20-25% complete)

---

## 1. Executive Summary

The Bandcamp sales backfill system is designed to pull all historical sales data from the Bandcamp Sales Report API (v4) and store it in the `bandcamp_sales` table. Over a 2-day debugging session, we identified and fixed 4 distinct bugs, but the system is still not capturing complete data for most connections. The root causes are now understood and documented here.

**Key numbers (as of 2026-04-05):**
- Expected: ~200K+ total sales across 17 connections (Northern Spy alone has 41,831)
- Actual in DB: 48,067
- Northern Spy: 3,000 of 41,831 (7% coverage)
- LEAVING RECORDS: 27,810 (best coverage)
- True Panther: 9,087
- 7 connections still at 0 or single-digit sales

---

## 2. Bugs Found and Fixed (Chronological)

### Bug 1: Backfill state counter reset (FIXED)
- **Symptom:** `total_transactions` in `bandcamp_sales_backfill_state` always showed 0
- **Root cause:** `supabase.upsert()` without specifying `total_transactions` reset it to the column default (0) on every run
- **Fix:** Split into `insert` (new rows) + `update` (existing rows) to preserve the counter
- **Commit:** Part of `87350e2`
- **File:** `src/trigger/tasks/bandcamp-sales-backfill.ts` lines 132-150

### Bug 2: Backfill cron processes only 1 connection per run (FIXED)
- **Symptom:** With 17 connections and 10-min cron interval, full backfill would take 45+ hours
- **Root cause:** `return { processed, band }` at line 289 exits after ONE connection
- **Fix:** Removed early return, added 240s time guard to process multiple connections per run
- **Commit:** Part of `87350e2`
- **File:** `src/trigger/tasks/bandcamp-sales-backfill.ts` lines 275-310

### Bug 3: OAuth token refreshed on every API call (FIXED)
- **Symptom:** Bandcamp returning 429 (rate limit) on token refresh endpoint
- **Root cause:** `refreshBandcampToken()` always hit the OAuth endpoint, never checked if the existing token was still valid. 7 tasks calling it = ~16 refreshes/hour, but token is valid for 1 hour.
- **Fix:** Added check for `token_expires_at` — returns cached token if still valid (5-min buffer)
- **Commit:** `6a63a2a`
- **File:** `src/lib/clients/bandcamp.ts` lines 126-150
- **Impact:** Reduced OAuth calls from ~16/hour to ~1/hour

### Bug 4: Non-numeric transaction IDs crash entire batch (FIXED)
- **Symptom:** Bandcamp payout/transfer records have transaction IDs with a "t" prefix (e.g. `t878373461`) which fail to parse as `bigint`, causing the entire upsert batch to fail silently
- **Root cause:** `bandcamp_transaction_id` column is `bigint NOT NULL`. One bad row in a batch of 100 causes the whole upsert to fail. The error was swallowed by `ignoreDuplicates: true`.
- **Fix:** Added `safeBigint()` function that filters out non-numeric IDs. Applied to both Trigger.dev task and backfill script.
- **Commit:** `8fb74f2`
- **Files:** `src/trigger/tasks/bandcamp-sales-backfill.ts`, `scripts/run-sales-backfill.mjs`

### Bug 5: Daily sales sync doesn't update backfill counter (FIXED)
- **Symptom:** Counter drift — state says 0 but actual rows exist
- **Root cause:** `bandcamp-sales-sync.ts` inserts new daily sales but doesn't update `bandcamp_sales_backfill_state.total_transactions`
- **Fix:** Added counter update after successful daily insert
- **Commit:** `72baacc`
- **File:** `src/trigger/tasks/bandcamp-sales-sync.ts`

### Bug 6: Missing mappings for 813 Bandcamp items (FIXED)
- **Symptom:** Merch sync reports 93 matched + 461 failed = 554, but 1,367 items exist on Bandcamp
- **Root cause:** When a Bandcamp item's SKU already exists in the warehouse (from a prior run), the sync does `continue` without creating a mapping row. 813 items had SKUs that existed but no mapping.
- **Fix:** When SKU already exists, create a mapping row for the existing variant instead of skipping
- **Commit:** `8e7197d`
- **File:** `src/trigger/tasks/bandcamp-sync.ts` lines 1171-1210

### Bug 7: Legacy mappings missing subdomain/album_title/raw_api_data (FIXED)
- **Symptom:** 550 of 648 mappings had no subdomain, album_title, or raw_api_data
- **Root cause:** Mappings created before the api_complete migration never got these fields backfilled
- **Fix:** Added a loop after the main sync that updates existing mappings by `bandcamp_item_id` where `raw_api_data IS NULL`
- **Commit:** `471cfa0`
- **File:** `src/trigger/tasks/bandcamp-sync.ts` lines 1372-1395

---

## 3. Remaining Issue: Incomplete Sales Data

### What's happening
The API backfill script (`scripts/run-sales-backfill.mjs`) uses monthly chunks with the synchronous `sales_report` API. It works correctly — when called, it returns the right data (verified: SUSS 2024 returns 66 items, NS Jan 2020 returns 647 items). But:

1. **Rate limiting (429):** The script hits Bandcamp's rate limit after processing several connections. Bandcamp's undocumented limit is ~50 requests per 10 seconds. The script pauses 30 seconds on 429 but needs many months × many connections.

2. **Monthly chunks are slow:** Northern Spy has data from 2011-2026 = 180 monthly chunks. At ~10 seconds per chunk (including poll time), that's ~30 minutes for one connection. With 17 connections, full backfill takes 8+ hours.

3. **Cron interference:** The `bandcamp-sales-backfill-cron` Trigger.dev task (every 10 min) competes with the standalone script. It uses the async `generate_sales_report` path which has its own issues.

### Verification against raw CSV
Using `scripts/verify-sales-vs-csv.mjs` against the Northern Spy raw CSV export:

```
Northern Spy Records: 3,000 of 41,831 sales in DB (7%)

  CSV net revenue:    $500,472.84
  DB net revenue:     $40,033.07
  Missing revenue:    $460,439.77
  CSV units:          42,091
```

Every year from 2011-2026 has significant sales but the DB only has partial data from a few years.

---

## 4. Bandcamp Sales Report API Documentation

### Official Endpoints (documented at bandcamp.com/developer/sales)

#### Synchronous: `sales_report` (v4)
```
POST https://bandcamp.com/api/sales/4/sales_report
Authorization: Bearer {access_token}
Content-Type: application/json

{
  "band_id": 2239475326,
  "start_time": "2024-01-01 00:00:00",
  "end_time": "2024-02-01 00:00:00"
}

Response: { "report": [ {line_item}, {line_item}, ... ] }
```

**Key parameters:**
- `band_id` (required): the label or band ID
- `member_band_id` (optional): filter to a specific artist under a label
- `start_time` (required): earliest sale time (inclusive)
- `end_time` (optional): latest sale time (exclusive, defaults to now)

**Important:** The v4 response includes `bandcamp_transaction_item_id` which uniquely identifies each line item within an order. This is part of our UNIQUE constraint.

#### Asynchronous: `generate_sales_report` + `fetch_sales_report` (v4)
```
POST https://bandcamp.com/api/sales/4/generate_sales_report
→ returns { "token": "..." }

POST https://bandcamp.com/api/sales/4/fetch_sales_report
body: { "token": "..." }
→ returns { "url": "..." } when ready, or { "error_message": "Report hasn't generated yet" }

GET {url}
→ returns the full report JSON
```

**The async path supports CSV format** (the sync path does not in v4).

#### OAuth Token
```
POST https://bandcamp.com/oauth_token
Content-Type: application/x-www-form-urlencoded

grant_type=refresh_token&client_id=...&client_secret=...&refresh_token=...

Response: { "access_token": "...", "refresh_token": "...", "expires_in": 3600 }
```

Token expires in 1 hour. Only needs refreshing when expired.

### Undocumented Rate Limits
- ~50 requests per 10 seconds on data endpoints (from Music Assistant implementation)
- OAuth token endpoint has a stricter limit (causes 429 at ~16 refreshes/hour)
- `Retry-After` header sometimes returned with 429 responses (typically 3 seconds)
- No official documentation on limits

### Data Format Notes
- Transaction IDs are normally numeric (e.g. `2095918850`)
- **Payout/transfer records have "t" prefix** (e.g. `t878373461`) — these are NOT valid bigints
- Item types: `track`, `album`, `package`, `bundle` (sales), plus `payout`, `refund`, `reversal`, `pending reversal`, `cancelled reversal`, `adjustment`, `pending sale` (non-sale)
- The raw CSV export from Bandcamp's web dashboard does NOT include `bandcamp_transaction_item_id` — this field is API-only (v4+)

---

## 5. All Related Files

### Trigger.dev Tasks

| File | Task ID | Schedule | Purpose |
|---|---|---|---|
| `src/trigger/tasks/bandcamp-sales-backfill.ts` | `bandcamp-sales-backfill` | On-demand | Processes one yearly chunk for a single connection |
| `src/trigger/tasks/bandcamp-sales-backfill.ts` | `bandcamp-sales-backfill-cron` | `*/10 * * * *` | Cron wrapper that iterates connections and calls the above |
| `src/trigger/tasks/bandcamp-sales-sync.ts` | `bandcamp-sales-sync` | `0 5 * * *` (daily) | Daily sync using synchronous `sales_report` for yesterday's sales |

### Scripts

| File | Purpose | Usage |
|---|---|---|
| `scripts/run-sales-backfill.mjs` | One-off backfill using synchronous API with monthly chunks | `node scripts/run-sales-backfill.mjs` |
| `scripts/reconcile-backfill-state.mjs` | Fix counter drift between state table and actual row counts | `node scripts/reconcile-backfill-state.mjs [--dry-run]` |
| `scripts/verify-sales-vs-csv.mjs` | Compare DB sales against raw Bandcamp CSV export | `node scripts/verify-sales-vs-csv.mjs <csv-file> "<band name>"` |
| `scripts/import-sales-csv.mjs` | Direct CSV import (not recommended — missing `transaction_item_id`) | `node scripts/import-sales-csv.mjs <csv-file> "<band name>"` |
| `scripts/seed-bandcamp-mappings.mjs` | Seed product mappings from SKU audit spreadsheet | `node scripts/seed-bandcamp-mappings.mjs [--dry-run]` |

### API Client

| File | Functions | Purpose |
|---|---|---|
| `src/lib/clients/bandcamp.ts` | `refreshBandcampToken`, `salesReport`, `generateSalesReport`, `fetchSalesReport` | Bandcamp API wrappers |

### Database

| Table | Purpose | Key Columns |
|---|---|---|
| `bandcamp_sales` | All sales transaction data | UNIQUE(workspace_id, bandcamp_transaction_id, bandcamp_transaction_item_id) |
| `bandcamp_sales_backfill_state` | Progress tracking per connection | connection_id (PK), status, last_processed_date, total_transactions |
| `bandcamp_connections` | Label/band connections | band_id, band_name, workspace_id |
| `bandcamp_credentials` | OAuth tokens | access_token, refresh_token, token_expires_at |

---

## 6. Current State (2026-04-05T20:50Z)

```
Connection                   band_id      Sales   Status      Last Processed
Across the Horizon           1430196613     971   completed   2026-04-05
Birdwatcher Records          117694227      855   completed   2026-04-05
Egghunt Records              265181677    3,104   completed   2026-04-05
Good Neighbor                4256323829      67   completed   2026-04-05
In The Pines                 2807765655     170   completed   2026-04-05
LEAVING RECORDS              369182255   27,810   failed      2023-01-01 (fetch failed)
LILA                         2561454089   1,844   running     2024-03-04
Lord Spikeheart              1097102857     417   running     2025-02-04
Matt McBane                  3220891777       0   running     2011-01-01
Micah Thomas                 3416046922       0   running     2011-01-01
Nicole McCabe                2765573782       1   running     2011-01-01
NNA Tapes                    1547924804     700   pending     n/a
Northern Spy Records         2239475326   3,000   running     2011-01-01
SUSS                         3694833057       0   running     2013-01-01
True Panther                 702768315    9,087   running     2011-01-01
Whited Sepulchre Records     772423451       41   pending     n/a
Xol Meissner                 3760430981       0   running     2011-01-01

Total: 48,067 sales | Mappings: 1,413 | URLs: 1,226 | Tags: 143
```

---

## 7. Recommended Next Steps

### Priority 1: Complete the backfill
The `scripts/run-sales-backfill.mjs` script works correctly with monthly chunks and the sync API. It needs to:
1. **Run to completion** without hitting rate limits. Options:
   - Add longer delays between API calls (2-3 seconds instead of 600ms)
   - Run during off-peak hours
   - Pause the `bandcamp-sales-backfill-cron` Trigger.dev task while the script runs
2. **Re-run for connections that show "completed" with low sales** — the cron raced ahead and marked them done before data was captured

### Priority 2: Disable the cron during manual backfill
The `bandcamp-sales-backfill-cron` Trigger.dev task competes with the manual script and marks connections as "completed" prematurely. Either:
- Disable it in the Trigger.dev dashboard temporarily
- Or modify the cron to skip connections being processed by the script

### Priority 3: After backfill completes
1. Run `node scripts/reconcile-backfill-state.mjs` to fix all counters
2. Run `node scripts/verify-sales-vs-csv.mjs` against any CSV exports to verify completeness
3. Run `crossReferenceAlbumUrls` to populate bandcamp_url from sales data
4. Deploy the fixed Trigger.dev tasks (`npx trigger.dev deploy`) so ongoing daily sync works correctly

### Priority 4: Fix the Trigger.dev cron for ongoing maintenance
After the one-time backfill is complete, the cron should be updated to:
- Use the synchronous `sales_report` API (not async generate/fetch)
- Use monthly chunks (not yearly)
- Respect the token cache (already fixed)
- Filter non-numeric transaction IDs (already fixed)

---

## 8. What Worked vs What Didn't

### Worked
- Synchronous `sales_report` API (v4) with monthly chunks — returns complete data
- Token caching — reduced OAuth calls from 16/hour to 1/hour
- safeBigint filter — prevents batch failures from payout records
- Mapping backfill — populated subdomain/album_title for 550+ legacy mappings
- Seeding script from SKU spreadsheet — created 1,413 mappings from 648
- Genre tag extraction from HTML `<a class="tag">` elements
- CSV verification script — reliable way to check completeness

### Didn't Work
- Async `generate_sales_report` / `fetch_sales_report` — returned data but was harder to debug and slower
- Yearly chunks — too coarse for high-volume labels (Northern Spy has 9,976 rows in one year)
- Cron-based backfill with `triggerAndWait` — race conditions with manual script, plus rate limiting
- `ignoreDuplicates: true` — masked real errors (the bigint crash was hidden for weeks)
- Counter-based progress tracking — drifts constantly from multiple code paths writing sales
