# `process-shipstation-shipment` runbook

## What this task does

Phase 2 SHIP_NOTIFY processor. Reads payload from a webhook event,
calls `recordInventoryChange()` to decrement, fanouts via Rule #43.
Idempotent via `external_sync_events.correlation_id = shipment_id`.

## Schedule + invocation

- **Triggered:** by `/api/webhooks/shipstation` Route Handler.

## Common failure modes

### 1. Duplicate decrement on retry

- Symptom: inventory drops by 2x expected.
- Recovery: check `external_sync_events` for duplicate
  `(system, correlation_id, sku, action)` tuples — should never insert
  twice due to UNIQUE constraint. If it does, schema bug.

### 2. SKU not in our DB

- Recovery: write to review queue (Rule #39); do not crash.

## Last verified

- 2026-04-13 (TA) — Phase 2 closeout reference.
