# `bandcamp-sales-backfill` runbook

## What this task does

Daily Sales API backfill. Pulls the previous day's full sales report and
reconciles against `warehouse_orders` to catch anything the 5-min
poller missed. **Phase 0.0 hotfix** wired this onto `bandcampQueue`
to prevent OAuth `duplicate_grant`.

## Schedule + invocation

- **Cron:** `bandcampSalesBackfillCron` — daily 02:00 UTC.
- **Queue:** `bandcamp-api` (Rule #9).
- **Manual:** `scripts/run-sales-backfill.mjs` for full historical
  backfill (sets `pause_sales_backfill_cron` first).

## Common failure modes

### 1. Cron + script collision

- Symptom: `duplicate_grant` mid-day after manual backfill.
- Means: script started without setting `pause_sales_backfill_cron`.
- Recovery: re-OAuth Bandcamp, ensure script flips the pause flag.

## Last verified

- 2026-04-13 (TA) — Phase 0.0 closeout addendum verified queue wiring.
