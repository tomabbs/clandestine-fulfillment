# `bandcamp-sale-poll` runbook

## What this task does

Backup poller for Bandcamp sales — runs every 5 min as a safety net for
the Bandcamp Sales API. Pulls sales since `last_sale_id` and writes
to `warehouse_orders`. Phase 4 will fan out each new sale through
`recordInventoryChange()` → ShipStation v2 decrement.

## Schedule + invocation

- **Cron:** every 5 minutes.
- **Queue:** `bandcamp-api` (Rule #9).
- **Manual:** Server Action enqueues for Force Sync on Channels page.

## Common failure modes

### 1. `last_sale_id` cursor stuck

- Symptom: cron runs but processes 0 new sales for hours while orders
  are visibly placed in Bandcamp dashboard.
- Means: cursor saved against a workspace doesn't match Bandcamp's
  pagination scheme.
- Recovery: manually reset `bandcamp_credentials.last_sale_id` to
  oldest unprocessed sale id, re-trigger.

### 2. Duplicate orders

- Symptom: `warehouse_orders` shows two rows with same `external_id`.
- Means: idempotency key is not stable on retry.
- Recovery: delete duplicates; verify upsert uses `(workspace_id, external_id)` unique key.

## Recovery cheatsheet

| Situation | Action |
|-----------|--------|
| Webhook silence detected (Rule #17) | Check `client_store_connections.last_webhook_at`; if stale + poller finds new orders, raise review queue alert |

## Last verified

- 2026-04-13 (TA) — initial Tier 1 hardening pass.
