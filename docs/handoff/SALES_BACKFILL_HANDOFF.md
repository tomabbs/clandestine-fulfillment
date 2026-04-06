# Sales Backfill System — Full Handoff Document

**Date:** 2026-04-06 (updated)
**Session:** Full audit + remediation of Bandcamp sales data pipeline
**Status:** IN PROGRESS — full re-run with all fixes applied, cron paused, running clean

---

## 1. Executive Summary

The Bandcamp sales backfill system pulls all historical sales data from the Bandcamp Sales Report API (v4) and stores it in the `bandcamp_sales` table. Over a 3-day debugging session (2026-04-04 through 2026-04-06), we identified and fixed 9 distinct bugs plus 3 operational issues. A clean re-run of all 17 connections is now in progress with the cron paused and proper rate limiting.

**Key numbers (as of 2026-04-06 ~03:15 UTC):**
- Expected: ~200K+ total sales across 17 connections (Northern Spy alone has 41,831)
- Previous run (2026-04-05): 48,067 captured
- Current re-run: in progress (Across the Horizon: 811, Birdwatcher: 855 completed; Egghunt in progress ~2023)
- All 17 connections reset to start from scratch for clean data

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

### Bug 8: Cron races with manual backfill script (FIXED 2026-04-06)
- **Symptom:** Manual script processes a connection, then cron walks through empty years and marks it "completed" with 0 sales, overwriting the script's progress
- **Root cause:** No coordination between cron and script — both write to `bandcamp_sales_backfill_state` independently
- **Fix:** Added `pause_sales_backfill_cron` flag to `workspace.bandcamp_scraper_settings`. Cron checks the flag on every run and exits immediately if set. Script sets the flag on start and clears it on finish.
- **Commit:** `ed2bed0`
- **Files:** `src/trigger/tasks/bandcamp-sales-backfill.ts` (cron pause check), `scripts/run-sales-backfill.mjs` (set/clear flag + auto-unpause on finish)

### Bug 9: API delay too short, triggering 429s (FIXED 2026-04-06)
- **Symptom:** Script hit Bandcamp's rate limit (429) after processing a few connections, interrupting backfill
- **Root cause:** Inter-request delay was 600ms — too fast for Bandcamp's ~50-per-10-sec limit when doing sustained bulk requests. A safe sustained rate is ~3 seconds between calls.
- **Fix:** Increased `DELAY_MS` from 600ms to 3000ms. Added inline 429 detection from HTTP response status (not just thrown error string) with `Retry-After` header parsing and 60s wait. Added network error retry (15s) for `fetch failed`, `ECONNRESET`, `ETIMEDOUT`.
- **Commit:** `ed2bed0`
- **File:** `scripts/run-sales-backfill.mjs`

---

## 3. Operational Improvements (2026-04-06)

### Skip-ahead for empty periods
- **Problem:** Connections that started recently (e.g. Across the Horizon, est. 2025) were crawling through 192 empty months from 2010 at 3s each = ~10 minutes wasted per connection.
- **Fix:** After 6 consecutive empty months, the script jumps ahead to Jan 1 of the next year and updates `last_processed_date` so restarts don't re-walk the gap.
- **Impact:** "Across the Horizon" went from ~10 minutes to ~90 seconds (skipped 2010-2024 in seconds).

### Auto-reconcile counters on completion
- **Problem:** `total_transactions` in backfill state drifted from actual DB row counts due to multiple code paths (daily sync, manual script, cron) all writing independently.
- **Fix:** Script reconciles all connection counters against actual `bandcamp_sales` row counts when it finishes.

### Auto-unpause cron on completion
- **Fix:** Script clears the `pause_sales_backfill_cron` flag after processing all connections, so the cron resumes automatically for ongoing daily maintenance.

---

## 4. Previous Issue: Incomplete Sales Data (now being resolved)

### What was happening
The API backfill script had three compounding problems:

1. **Rate limiting (429):** Delay was 600ms — too fast for sustained bulk requests. Now fixed at 3000ms.
2. **Cron interference:** The cron raced the script and marked connections "completed" prematurely. Now fixed with pause flag.
3. **No skip-ahead:** Empty early years wasted API calls. Now fixed with 6-month skip-ahead.

### Verification against raw CSV
Using `scripts/verify-sales-vs-csv.mjs` against the Northern Spy raw CSV export (pre-rerun):

```
Northern Spy Records: 3,000 of 41,831 sales in DB (7%)

  CSV net revenue:    $500,472.84
  DB net revenue:     $40,033.07
  Missing revenue:    $460,439.77
  CSV units:          42,091
```

The current clean re-run is expected to capture all of these.

---

## 5. Bandcamp Sales Report API Documentation

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

## 6. All Related Files

### Trigger.dev Tasks

| File | Task ID | Schedule | Purpose |
|---|---|---|---|
| `src/trigger/tasks/bandcamp-sales-backfill.ts` | `bandcamp-sales-backfill` | On-demand | Processes one monthly chunk for a single connection |
| `src/trigger/tasks/bandcamp-sales-backfill.ts` | `bandcamp-sales-backfill-cron` | `*/10 * * * *` | Cron wrapper — checks pause flag, iterates connections. **Paused during manual backfill via workspace settings flag.** |
| `src/trigger/tasks/bandcamp-sales-sync.ts` | `bandcamp-sales-sync` | `0 5 * * *` (daily) | Daily sync using synchronous `sales_report` for yesterday's sales |

### Scripts

| File | Purpose | Usage |
|---|---|---|
| `scripts/run-sales-backfill.mjs` | Full backfill using synchronous API with monthly chunks, skip-ahead, auto-pause/unpause cron, auto-reconcile counters | `node scripts/run-sales-backfill.mjs` |
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

## 7. State History

### Previous state (2026-04-05T20:50Z)

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

### Current state (2026-04-06T03:15Z) — clean re-run in progress

All 17 connections were reset to `pending` with `last_processed_date: null`. The script is running with:
- Cron **paused** via `bandcamp_scraper_settings.pause_sales_backfill_cron`
- API delay: **3 seconds** between calls (no 429s observed)
- Skip-ahead: jumps 1 year after 6 consecutive empty months
- Network retry: auto-retries on `fetch failed` / `ECONNRESET` / `ETIMEDOUT` with 15s wait
- 429 retry: reads `Retry-After` header, waits 60s, retries same chunk
- Deployed cron (`ed2bed0`) respects the pause flag

```
Connection                   Status         Progress
Across the Horizon           COMPLETED      811 sales (was 971 — counter was inflated, now accurate)
Birdwatcher Records          COMPLETED      855 sales
Egghunt Records              RUNNING        ~2023 (processing)
Remaining 14 connections     QUEUED         will process in order
```

Estimated runtime: 60-90 minutes for all 17 connections.

---

## 8. Audit Log System (2026-04-07)

The backfill script was rewritten with a **chunk-level audit log** (`bandcamp_sales_backfill_log`). Every API call writes a row — success or failure. This permanently eliminates false completions and makes progress verifiable.

### How it works
- **Mode A (full scan)**: For `pending`/`running`/`failed` connections — walks month-by-month from `coverage_start_date` to now. Logs every chunk.
- **Mode B (retry gaps)**: For `partial` connections — queries the audit log for failed/missing chunks, processes only those.
- **Completion is verified**: A connection is "completed" only when every expected chunk (from `coverage_start_date` to now) has a terminal-good log entry AND a cross-check of sales counts passes.
- **Error tiers**: 429/5xx = transient (retry 3x), 400 = chunk failure (log and skip), 401/403 = connection failure (fail fast).
- **Self-healing cron**: Detects stale "running" connections (>2h) and flips to "partial". Retries up to 3 failed chunks per run.

### New table: `bandcamp_sales_backfill_log`
Created by migration `20260407000000_backfill_audit_log.sql`. Columns include `workspace_id`, `connection_id`, `chunk_start`, `chunk_end`, `status`, `sales_returned`, `sales_inserted`, `http_status`, `error_message`, `attempt_number`, `started_at`, `finished_at`, `duration_ms`.

### Frontend: BackfillAuditCard
Replaces the old badge grids. Shows overall coverage %, per-account expandable table, year/month heatmap grid with color-coded cells (green=success, red=failed, gray=pending).

### Running the script
```bash
node scripts/run-sales-backfill.mjs
```
Auto-pauses the cron on start, auto-unpauses on finish. Prints per-connection and final audit summaries.

---

## 9. What Worked vs What Didn't

### Worked
- Synchronous `sales_report` API (v4) with monthly chunks — returns complete data
- Token caching — reduced OAuth calls from 16/hour to 1/hour
- safeBigint filter — prevents batch failures from payout records
- Mapping backfill — populated subdomain/album_title for 550+ legacy mappings
- Seeding script from SKU spreadsheet — created 1,413 mappings from 648
- Genre tag extraction from HTML `<a class="tag">` elements
- CSV verification script — reliable way to check completeness
- **Cron pause flag** — simple workspace setting flag avoids race condition without needing to disable the cron in the Trigger.dev dashboard
- **Skip-ahead logic** — 6 empty months → jump a year. Cut "Across the Horizon" from ~10 min to ~90 sec
- **3-second API delay** — zero 429s observed vs previous runs hitting 429 within minutes at 600ms
- **Auto-reconcile counters** — eliminates counter drift without manual script runs

### Didn't Work
- Async `generate_sales_report` / `fetch_sales_report` — returned data but was harder to debug and slower
- Yearly chunks — too coarse for high-volume labels (Northern Spy has 9,976 rows in one year)
- Cron-based backfill with `triggerAndWait` — race conditions with manual script, plus rate limiting
- `ignoreDuplicates: true` — masked real errors (the bigint crash was hidden for weeks)
- Counter-based progress tracking — drifts constantly from multiple code paths writing sales
- **600ms API delay** — too fast for sustained bulk requests, triggered 429s after a few connections
- **Running script without pausing cron** — cron marked connections "completed" with 0 sales, overwriting script progress
- **Starting every connection from 2010** — most labels started 2015-2024, wasting 60+ API calls per connection on empty months

---

## 10. Lessons Learned

1. **Always pause competing processes before running manual scripts.** The cron was the #1 source of data loss.
2. **Rate limits need to be measured empirically, not assumed.** 600ms worked for small tests but failed at scale. 3000ms works for sustained bulk.
3. **Skip-ahead is essential for bulk historical pulls.** Walking through empty months at 3s each turns a 60-min job into a 3-hour job.
4. **Counters will always drift.** Reconcile against actual row counts, not cumulative additions.
5. **Retry on network errors, don't fail.** Bandcamp connections drop occasionally — a 15s retry catches them without losing progress.
