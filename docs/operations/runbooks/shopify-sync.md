# `shopify-sync` runbook

## What this task does

Incremental Clandestine Shopify sync. Uses the 2-minute overlap window
per Rule #46 to catch updates near the cursor boundary. Bulk
INSERT…ON CONFLICT (Rule #59 — bypasses single-write-path).

## Schedule + invocation

- **Cron:** every 30 minutes.
- **Queue:** none (Shopify API allows reasonable concurrency).

## Common failure modes

### 1. Cursor regression

- Symptom: same products synced repeatedly.
- Means: `last_sync_cursor` not advancing.
- Recovery: verify task writes back to `warehouse_sync_state`; manually
  bump the cursor if stuck.

### 2. Throttle/429 from Shopify

- Recovery: Trigger retries handle this. If persistent, check API
  call cost in Shopify GraphQL.

## Last verified

- 2026-04-13 (TA) — initial Tier 1 hardening pass.
