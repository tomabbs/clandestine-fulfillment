# `bundle-derived-drift-sensor` runbook

## What this task does

Phase 2.5(c) sensor. Hourly compares ShipStation v2's reported quantity
for bundle SKUs against `computeEffectiveBundleAvailable()`. Drift
above `BUNDLE_DRIFT_TOLERANCE` (default 2 units) opens a
`warehouse_review_queue` row keyed
`group_key='bundle.derived_drift:{workspace_id}:{sku}'`.

## Schedule + invocation

- **Cron:** hourly (`0 * * * *`).
- **Queue:** `shipstation-api` (concurrencyLimit: 1, shared).

## Common failure modes

### 1. v2 returns 404 for bundle SKU

- By design: bundles are excluded from v2 seed (Phase 2.5(a)). Sensor
  silently skips. Not a failure mode — expected behaviour.

### 2. Drift item count growing unbounded

- Symptom: same SKU's `occurrence_count` climbs every hour.
- Means: ShipStation's bundle quantity is being managed externally
  somehow.
- Recovery: investigate that specific SKU's history; may need to
  flip bundle to `do_not_push` to v2.

## Last verified

- 2026-04-13 (TA) — Phase 2.5(b)+(c) closeout reference.
