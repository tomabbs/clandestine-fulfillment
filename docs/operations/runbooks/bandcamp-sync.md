# `bandcamp-sync` runbook

## What this task does

Full Bandcamp catalog sync. Pulls every `merch_details` row from Bandcamp's
Merch API for every fulfillment-client workspace, scrapes the public
album page when needed, creates Clandestine Shopify DRAFT products
keyed by SKU, and seeds `warehouse_inventory_levels.available` from
`computeBandcampSeedQuantity()` (Phase 1 follow-up #2 — origin sum, not
TOP `quantity_available`).

Reads: Bandcamp Merch API, Bandcamp public HTML, `bandcamp_product_mappings`.
Writes: `warehouse_products`, `warehouse_product_variants`,
`warehouse_inventory_levels` (via `recordInventoryChange`),
`channel_sync_log`, optional `warehouse_review_queue` (anomalies).

## Schedule + invocation

- **Cron:** `bandcampSyncSchedule` — daily 04:00 UTC.
- **Queue:** `bandcamp-api` (concurrencyLimit: 1, Rule #9).
- **Manual:** "Force Sync" on Channels page → enqueues task (Rule #48).

## Common failure modes

### 1. `duplicate_grant` from Bandcamp OAuth refresh

- Symptom: Sentry tag `bandcamp_token_error=duplicate_grant`.
- Means: a parallel task called `refreshBandcampToken()` outside the
  shared `bandcamp-api` queue. Token family is destroyed.
- Recovery: re-OAuth the affected workspace's Bandcamp connection.
  Verify Rule #9 violation — typically a new task or script bypassed
  the queue. Fix the violation; bake into `tests/unit/trigger/bandcamp-queue-rule9.test.ts`.

### 2. Scraper failure rate > 20% (Rule #35)

- Symptom: `channel_sync_log.items_failed > 0.2 * items_processed`.
- Means: Bandcamp DOM changed OR IP blocking.
- Recovery: check fixture-based scraper tests (`tests/fixtures/bandcamp/*`).
  If they pass, switch to residential proxy (Rule #30). If they fail,
  ship a new parser version (Rule #25).

### 3. Baseline anomaly inflation

- Symptom: `warehouse_review_queue.category='bandcamp.baseline_anomaly'`
  rises after a sync run.
- Means: a merchant's TOP `quantity_available` is inflated by their
  own baseline; computeBandcampSeedQuantity now correctly seeds 0
  but the mapping needs `push_mode = 'blocked_baseline'`.
- Recovery: run `bandcamp-baseline-audit`; flip mapping `push_mode`.

## Recovery cheatsheet

| Situation | Action |
|-----------|--------|
| Sync hung > 30 min | Cancel run in Trigger.dev dashboard, restart |
| Single SKU sync error | Check `channel_sync_log.error_message`, fix mapping |
| All workspaces failing | Likely Bandcamp API outage — check Bandcamp status |

## Escalation

- Owner: ops on-call → eng lead → label account manager (for client outreach if needed).
- SLO: contributes to SLO #6 (queue starvation) and SLO #10 (scraper success rate).

## Last verified

- 2026-04-13 (TA) — initial Tier 1 hardening pass.
