-- Phase 1 §9.2 D1/D2 — extend external_sync_events for the new per-SKU push paths.
--
-- Plan reference: bandcamp_shopify_enterprise_sync_a448cf6a.plan.md, §9.2 D1/D2.
-- Truth-doc invariant: every external mutation MUST flow through external_sync_events
-- with a stable correlation_id (Rule #15) so retries collide on the UNIQUE
-- (system, correlation_id, sku, action) constraint and idempotency holds.
--
-- Phase 1 introduces three new per-platform per-SKU push tasks
-- (`client-store-push-on-sku` per platform) plus a per-SKU Clandestine push
-- (`clandestine-shopify-push-on-sku`). These need ledger acquisition like the
-- existing focused-push paths (`bandcamp-push-on-sku`,
-- `shipstation-v2-adjust-on-sku`). The existing CHECK constraints would reject
-- the new (system, action) tuples, so we extend both.
--
-- Idempotent throughout: drops the old CHECK constraints by name (with
-- IF EXISTS) and re-adds them with the wider allowed sets. Reversible by
-- swapping the constants back.

-- ─── Section A — extend `system` enum check ────────────────────────────────
--
-- Add three new client-store systems (one per supported storefront platform).
-- Keeping them distinct (not a single "client_store") gives us per-platform
-- analytics on `external_sync_events` without parsing metadata, and matches
-- the per-platform queue split documented in plan §9.2 D1.

ALTER TABLE external_sync_events
  DROP CONSTRAINT IF EXISTS external_sync_events_system_check;

ALTER TABLE external_sync_events
  ADD CONSTRAINT external_sync_events_system_check
  CHECK (system IN (
    'shipstation_v1',
    'shipstation_v2',
    'bandcamp',
    'clandestine_shopify',
    'client_store_shopify',
    'client_store_squarespace',
    'client_store_woocommerce'
  ));

-- ─── Section B — extend `action` enum check ────────────────────────────────
--
-- Add `set` for absolute-quantity pushes. The existing `modify` action is
-- semantically close (Bandcamp `update_quantities` uses it) but `set` is the
-- canonical verb in the storefront APIs themselves (Shopify
-- `inventory_levels/set.json`, WooCommerce `stock_quantity` PUT, Squarespace
-- `quantity` PUT). Distinct verb makes per-action analytics clearer:
-- a future `cas_set` (Phase 1 §9.2 D4 Pass 2 — Shopify CAS) can land
-- alongside without re-claiming `set`.

ALTER TABLE external_sync_events
  DROP CONSTRAINT IF EXISTS external_sync_events_action_check;

ALTER TABLE external_sync_events
  ADD CONSTRAINT external_sync_events_action_check
  CHECK (action IN (
    'increment',
    'decrement',
    'adjust',
    'modify',
    'set',
    'alias_add',
    'alias_remove',
    'sku_rename'
  ));

-- ─── Section C — PostgREST schema reload ──────────────────────────────────

NOTIFY pgrst, 'reload schema';

COMMENT ON CONSTRAINT external_sync_events_system_check ON external_sync_events IS
  'Phase 1 §9.2 — extended to admit per-platform client-store push systems for the new client-store-push-on-sku tasks. Per-platform (vs single client_store) so external_sync_events analytics segment by storefront without metadata parsing.';
COMMENT ON CONSTRAINT external_sync_events_action_check ON external_sync_events IS
  'Phase 1 §9.2 — added `set` for absolute-quantity pushes (Shopify inventory_levels/set, WooCommerce stock_quantity, Squarespace quantity). Reserved future verb `cas_set` for Phase 1 Pass 2 Shopify CAS contract.';
