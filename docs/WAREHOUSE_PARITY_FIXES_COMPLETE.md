# Warehouse Parity Fixes — Complete

Date: 2026-03-18
Reference: /Users/Shared/WorkShared/Projects/release-manager (old app)

## Fixes Applied

### P0 — Critical
- [x] **Shopify webhook payload bug** — `metadata` in `webhook_events` now includes full `payload` (was only storing `topic`, breaking all downstream processing)
- [x] **Billing override resolution** — `getEffectiveRate()` checks `warehouse_billing_rule_overrides` for org-specific amounts before falling back to workspace defaults
- [x] **Catalog query crash** — removed nonexistent `cost` column from `getProducts()` variant select (was returning 0 products)

### P1 — High Priority
- [x] **ShipStation storeId nested in advancedOptions** — both `shipstation-poll` and `shipment-ingest` now read `advancedOptions.storeId` (was always `undefined`)
- [x] **Missing workspace_id on shipment inserts** — added to both `shipstation-poll` and `shipment-ingest` (was causing silent insert failures)
- [x] **Concurrency limit (5) on shipment ingest** — prevents overwhelming ShipStation API or DB
- [x] **Org matching fallback chain** — 3-tier: store mapping → SKU match → review queue (ported from old app)
- [x] **ShipStation store sync** — 23 stores imported and mapped to org
- [x] **Organizations from Shopify vendors** — 174 orgs created, all 2,456 products assigned

### P2 — Medium Priority
- [x] **Format detection ported** — `src/trigger/lib/format-detection.ts` with SKU prefix rules, title keyword fallback, weight heuristic (14 tests)
- [x] **Materials cost calculation** — `src/trigger/lib/materials-cost.ts` for on-demand cost estimation; billing calculator computes authoritative costs at snapshot time
- [x] **Drop-ship detection and billing** — `is_drop_ship` flag on stores + shipments; billing calculator applies `drop_ship_base + drop_ship_per_unit` rates for Manual Orders store
- [x] **AfterShip tracking registration wired up** — `aftership-register` task now triggered from `shipment-ingest` for shipments with tracking numbers
- [x] **maxDuration aligned** — shopify-sync: 840s, shopify-full-backfill: 3600s, shopify-order-sync: 840s, shipstation-poll: 600s, storage-calc: 600s
- [x] **Image ingestion** — shopify-sync and shopify-full-backfill now upsert product images into `warehouse_product_images`
- [x] **Product editor rewrite** — full edit form with description, vendor, status, inline variant editing with barcode/weight unit

## Not Changed (Already Good)
- **Audit/observability** — `channel_sync_log` (25 tasks write to it), `sensor_readings` (7 sensors), `warehouse_review_queue` (12 tasks create items), `webhook_events` (all webhook handlers), Sentry `onFailure` hook — already stronger than old app's `agent_runs`
- **Bandcamp integration** — sync, sale-poll, inventory-push all working with shared queue serialization
- **Redis inventory projection** — weekly backfill, per-write HINCRBY via `recordInventoryChange`, drift sensor
- **Webhook dedup** — all handlers use `webhook_events` INSERT ON CONFLICT
- **Echo cancellation** — Shopify webhook handler checks `last_pushed_quantity`

## Testing Checklist
- [ ] Shopify webhook processes inventory_levels/update (verify echo cancellation)
- [ ] Shopify webhook processes orders/create
- [ ] Billing overrides apply to client-specific invoices
- [ ] ShipStation poller catches shipments from 30-day window
- [ ] Voided shipments update status correctly
- [ ] Unmatched shipments go to review queue with full metadata + match_attempts
- [ ] Drop-ship shipments (Manual Orders store) billed at drop-ship rates
- [ ] AfterShip tracking registered for new shipments with tracking numbers
- [ ] Format detection populates label_data.detectedFormat on shipments
- [ ] Product editor saves to Shopify (title, description, vendor, status, tags)
- [ ] Variant editor saves barcode and weight unit

## Files Changed

### New Files (warehouse parity)
- `src/trigger/lib/format-detection.ts` — format detection engine
- `src/trigger/lib/materials-cost.ts` — on-demand materials cost estimation
- `src/trigger/lib/match-shipment-org.ts` — 3-tier org matching
- `supabase/migrations/20260318000004_drop_ship.sql` — is_drop_ship + total_units columns
- `tests/unit/trigger/format-detection.test.ts` — 14 format detection tests
- `tests/unit/trigger/match-shipment-org.test.ts` — 7 org matching tests

### Modified Files
- `src/trigger/tasks/shipment-ingest.ts` — workspace_id, is_drop_ship, total_units, format detection, AfterShip trigger
- `src/trigger/tasks/shipstation-poll.ts` — workspace_id, advancedOptions.storeId, maxDuration 600
- `src/trigger/tasks/shopify-sync.ts` — image ingestion, maxDuration 840
- `src/trigger/tasks/shopify-full-backfill.ts` — image ingestion, maxDuration 3600
- `src/trigger/tasks/shopify-order-sync.ts` — maxDuration 840
- `src/trigger/tasks/storage-calc.ts` — maxDuration 600
- `src/trigger/tasks/monthly-billing.ts` — drop-ship line item on Stripe invoice
- `src/lib/clients/billing-calculator.ts` — drop-ship rate calculation, total_drop_ship
- `src/lib/clients/shopify.ts` — descriptionHtml, vendor, status, barcode on mutations
- `src/actions/catalog.ts` — removed nonexistent cost column, added description/vendor/status/barcode
- `src/app/admin/catalog/[id]/page.tsx` — full edit form + inline variant editing
- `src/app/api/webhooks/shopify/route.ts` — payload in metadata

## Deployment Notes
- **Migrations required**: `20260318000004_drop_ship.sql` (already applied to live DB)
- **No new env vars** required
- **Trigger.dev redeploy needed** after push: `npx trigger.dev@latest deploy`
- **Rollback**: revert commit(s), redeploy Trigger tasks
- **Manual step**: "Manual Orders" ShipStation store (ID 3097865) flagged as `is_drop_ship=true` via direct DB update
