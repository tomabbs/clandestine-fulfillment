# `process-shopify-webhook` runbook

## What this task does

Async processor for Shopify webhooks. The Route Handler does HMAC verify,
INSERT into `webhook_events`, enqueue this task, return 200 (Rule #66).
This task does the heavy lifting: parses payload, calls
`recordInventoryChange()` for inventory updates, fans out, etc.

## Schedule + invocation

- **Triggered:** by `/api/webhooks/shopify` Route Handler.

## Common failure modes

### 1. Echo loop (Rule #65)

- Symptom: inventory spirals to 0 after Clandestine pushes to Shopify.
- Recovery: confirm `client_store_sku_mappings.last_pushed_quantity`
  comparison logic is in place; mark as `echo_cancelled` in webhook_events.

### 2. Webhook arriving before product synced

- Symptom: SKU not found in `warehouse_product_variants`.
- Recovery: write to review queue instead of crashing (Rule #39).

## Last verified

- 2026-04-13 (TA) — initial Tier 1 hardening pass.
