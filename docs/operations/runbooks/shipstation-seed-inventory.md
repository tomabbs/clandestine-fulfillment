# `shipstation-seed-inventory` runbook

## What this task does

Phase 3 one-shot seed. Reads every variant where (a) workspace org_id
NOT NULL, (b) NOT a bundle parent (Phase 2.5(a)), (c)
`bandcamp_product_mappings.push_mode='normal'`, (d)
`computeEffectiveBandcampAvailable() > 0`, (e)
`warehouse_inventory_levels.available > 0`. Calls
`adjustInventoryV2({ transaction_type:'increment' })` per SKU through
the `shipstation-api` queue.

## Schedule + invocation

- **On-demand:** staff UI at `/admin/settings/shipstation-seed`.
- **Queue:** `shipstation-api` (concurrencyLimit: 1).

## Common failure modes

### 1. dryRun preview shows 0 SKUs

- Means: gate cascade excluded everything; check Phase 1 audit results.
- Recovery: re-run `bandcamp-baseline-audit` to update push_mode.

### 2. v2 API returns 400 for bundle SKU

- Symptom: a bundle slipped through the gate.
- Recovery: verify `bundle_components.bundle_variant_id` row exists
  for that variant.

## Last verified

- 2026-04-13 (TA) — Phase 3 closeout reference.
