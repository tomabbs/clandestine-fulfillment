# `redis-backfill` runbook

## What this task does

Rule #27. Rebuilds Redis inventory projection from Postgres truth.
Race-protected: per-SKU compares
`warehouse_inventory_levels.last_redis_write_at` against backfill
start timestamp; skips SKUs touched after backfill began.

## Schedule + invocation

- **Cron:** weekly Tuesday 03:00 EST (low-traffic window).
- **Manual:** triggered after Redis maintenance / restore.

## Common failure modes

### 1. Backfill races with active writes

- Symptom: Redis values stale immediately after backfill.
- Means: `last_redis_write_at` not being set on every
  `recordInventoryChange()` write.
- Recovery: audit `recordInventoryChange()` to confirm timestamp update.

## Last verified

- 2026-04-13 (TA) — initial Tier 1 hardening pass.
