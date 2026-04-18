-- Phase 0.7 + 0.8 — Distro discriminator + Client store dormancy switch
--
-- Plan reference: §7.1.13 (filtered to Phase 0.7 / 0.8 rows only). Phase 1's
-- baseline-anomaly objects shipped in 20260417000002; Phase 5's
-- `sku_sync_status` view stays deferred. Each phase keeps its own migration so
-- rollback blast radius is contained.
--
-- ─── Phase 0.7 — Distro discriminator ────────────────────────────────────────
--
-- Background: Clandestine Shopify holds two classes of products: (a) products
-- mirrored from a fulfillment client's Bandcamp catalog (org_id = client org),
-- and (b) "distro" items the warehouse moves on behalf of partner labels with
-- no org of their own (e.g. wholesale records resold through Clandestine's
-- own Shopify storefront, no Bandcamp upstream).
--
-- The current schema makes `warehouse_products.org_id` NOT NULL, which forces
-- `shopify-sync` to silently skip distro products (lines 195-196:
-- `if (!orgId) continue;`). They never enter the catalog, never get inventory
-- tracked in our system, and never reach ShipStation through us.
--
-- Phase 0.7 fixes this by relaxing the NOT NULL so the new
-- `clandestine-shopify-sync` task can persist distro rows with `org_id = NULL`
-- (the discriminator). RLS already handles this safely: the staff policy uses
-- `is_staff_user()` (no org join), the client policy uses
-- `org_id = get_user_org_id()` (a NULL on the row never matches any user's
-- org_id, so distro rows are invisible to clients — by design).
--
-- The partial index speeds up the admin "Distro Items" listing without
-- bloating the index space for the org-scoped majority.

ALTER TABLE warehouse_products
  ALTER COLUMN org_id DROP NOT NULL;

CREATE INDEX IF NOT EXISTS idx_warehouse_products_distro
  ON warehouse_products (workspace_id)
  WHERE org_id IS NULL;

COMMENT ON COLUMN warehouse_products.org_id IS
  'Owning organization. NULL = distro item (no Bandcamp upstream, no client owner).';

-- ─── Phase 0.8 — Client store dormancy switch ────────────────────────────────
--
-- Per Part 12: ShipStation Inventory Sync becomes the canonical fanout path
-- to Shopify / WooCommerce / Squarespace. The legacy first-party connectors
-- stay in the codebase (so we can re-enable per-connection if Inventory Sync
-- doesn't cover an edge case) but must NOT push inventory by default.
--
-- This bulk update flips every existing first-party connection's
-- `do_not_fanout = true`. The single dormancy gate at
-- src/lib/server/client-store-fanout-gate.ts is the leak-proof code-side
-- enforcement (every fanout callsite consults the gate before reaching the
-- network). Discogs is intentionally untouched — mail-order still uses it.
--
-- Idempotent: re-running the migration is a no-op for already-true rows.
-- Reversible: admin "Reactivate" button (Server Action
-- `reactivateClientStoreConnection`) sets `do_not_fanout = false` per row.

UPDATE client_store_connections
   SET do_not_fanout = true,
       updated_at = now()
 WHERE platform IN ('shopify', 'woocommerce', 'squarespace')
   AND do_not_fanout = false;
