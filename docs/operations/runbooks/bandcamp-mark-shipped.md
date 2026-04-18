# `bandcamp-mark-shipped` runbook

## What this task does

Pushes shipment confirmation to Bandcamp for orders fulfilled via
ShipStation. Idempotent via `external_sync_events`.

## Schedule + invocation

- **Cron:** every 15 minutes.
- **Queue:** `bandcamp-api` (Rule #9).

## Common failure modes

### 1. Bandcamp returns 404 for sale_id

- Means: order wasn't from Bandcamp (mis-routed) or already cancelled.
- Recovery: check `warehouse_orders.source` and skip if not bandcamp.

## Last verified

- 2026-04-13 (TA) — initial Tier 1 hardening pass.
