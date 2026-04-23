-- Phase 0 / §9.1 D4 — per-channel safety stock + Shopify policy audit columns.
--
-- Plan reference: bandcamp_shopify_enterprise_sync_a448cf6a.plan.md, §9.1 D4.
-- TRUTH_LAYER invariant F-NF-X1: safety stock is ABSOLUTE units (never a
-- percentage), and `CHECK (safety_stock >= 0)` is enforced at the schema layer
-- so app-side bypasses cannot poison the push formula.
--
-- This migration is purely additive — every column has a NOT NULL DEFAULT or
-- is NULLable, so existing rows continue to behave identically until consumer
-- code reads the new columns. Idempotent throughout (`IF NOT EXISTS`
-- everywhere, the constraint add is wrapped in DO $$ pg_constraint guard so
-- a partial-success retry is a no-op). Reversible by DROP COLUMN.
--
-- Sections:
--   A. client_store_sku_mappings — per-channel safety stock + Shopify
--      inventoryPolicy audit columns + pre-order whitelist toggle.
--   B. warehouse_safety_stock_per_channel — per-(workspace, variant, channel)
--      safety stock for non-storefront channels (Bandcamp, Clandestine
--      Shopify, future channels). The per-mapping column above covers
--      client storefronts; this table covers everything else under one
--      shared schema so the §9.6 D1 push formula reads from a single
--      logical surface.

-- ─── Section A — client_store_sku_mappings additions ──────────────────────

ALTER TABLE client_store_sku_mappings
  ADD COLUMN IF NOT EXISTS safety_stock smallint NOT NULL DEFAULT 0;

-- F-NF-X1: schema-level non-negative guard. Enforced inside DO $$ so re-runs
-- after a partial-success retry don't error on duplicate-constraint.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'client_store_sku_mappings_safety_stock_nonneg'
  ) THEN
    ALTER TABLE client_store_sku_mappings
      ADD CONSTRAINT client_store_sku_mappings_safety_stock_nonneg
      CHECK (safety_stock >= 0);
  END IF;
END $$;

ALTER TABLE client_store_sku_mappings
  ADD COLUMN IF NOT EXISTS preorder_whitelist boolean NOT NULL DEFAULT false;

-- D2: persisted snapshot of the most recent shopify-policy-audit observation
-- per mapping. Allowed values mirror Shopify's InventoryPolicy enum
-- (`DENY` | `CONTINUE`). NULL = never audited (legacy + brand-new mapping).
-- Enforced as a soft text column rather than an enum so future Shopify enum
-- additions don't require a migration cycle; the audit task validates the
-- value before persisting.
ALTER TABLE client_store_sku_mappings
  ADD COLUMN IF NOT EXISTS last_inventory_policy text;

ALTER TABLE client_store_sku_mappings
  ADD COLUMN IF NOT EXISTS last_policy_check_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_sku_mappings_policy_drift
  ON client_store_sku_mappings(connection_id)
  WHERE last_inventory_policy = 'CONTINUE' AND preorder_whitelist = false;

COMMENT ON COLUMN client_store_sku_mappings.safety_stock IS
  'F-NF-X1: per-channel safety stock in ABSOLUTE units (never a percentage). The §9.6 D1 push formula reduces effective sellable by this amount before pushing to the channel. CHECK >= 0 enforced at schema; F-NF-X2 lint-guard prevents app-side bypass.';
COMMENT ON COLUMN client_store_sku_mappings.preorder_whitelist IS
  'D2: per-SKU exemption from the shopify-policy-audit DENY check. SKUs with preorder_whitelist=true may legitimately have inventoryPolicy=CONTINUE on Shopify (so customers can order while we backorder). All other SKUs with CONTINUE policy fail the daily audit and open a critical review queue item.';
COMMENT ON COLUMN client_store_sku_mappings.last_inventory_policy IS
  'D2: most-recent observed Shopify variant inventoryPolicy (DENY|CONTINUE). NULL = never audited. Updated by shopify-policy-audit (cron + Server Action). Drives the policy_drift Channels health state.';
COMMENT ON COLUMN client_store_sku_mappings.last_policy_check_at IS
  'D2: wall-clock of the last shopify-policy-audit observation. NULL = never audited. Used for staleness alarms (audit ran but never wrote → likely scope/throttle failure).';

-- ─── Section B — warehouse_safety_stock_per_channel ───────────────────────
--
-- Wider per-(workspace, variant, channel) table for safety stock on
-- non-storefront channels. `channel` is open enum (text) so future channels
-- can be added without a migration cycle; the §9.6 push helper enforces the
-- known set at read time. Per-channel rows are sparse — only SKUs with a
-- non-zero reserve get a row. UNIQUE(workspace_id, variant_id, channel)
-- prevents duplicate reserves for the same (channel, SKU) pair.

CREATE TABLE IF NOT EXISTS warehouse_safety_stock_per_channel (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  variant_id uuid NOT NULL REFERENCES warehouse_product_variants(id) ON DELETE CASCADE,
  channel text NOT NULL,
  safety_stock smallint NOT NULL DEFAULT 0 CHECK (safety_stock >= 0),
  notes text,
  updated_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(workspace_id, variant_id, channel)
);

CREATE INDEX IF NOT EXISTS idx_safety_stock_variant
  ON warehouse_safety_stock_per_channel(variant_id);

-- Channel string is intentionally NOT a CHECK constraint — the §9.6 push
-- helper enforces the canonical set at read time, and the audit task fails
-- closed on unrecognized channels. New channels can land via TS-only changes.
COMMENT ON TABLE warehouse_safety_stock_per_channel IS
  'F-NF-X1 / §9.6 D1: per-(workspace, variant, channel) safety stock for non-storefront channels. Storefront channels (shopify, woocommerce, squarespace, bigcommerce) use client_store_sku_mappings.safety_stock instead. Rows are sparse — only SKUs with a non-zero reserve are persisted. UNIQUE prevents duplicate reserves per channel.';
COMMENT ON COLUMN warehouse_safety_stock_per_channel.channel IS
  'Open enum (text) — known values: bandcamp, clandestine_shopify, future channels. The §9.6 push helper enforces the canonical set at read time; new channels do NOT require a migration.';
COMMENT ON COLUMN warehouse_safety_stock_per_channel.safety_stock IS
  'F-NF-X1: per-channel safety stock in ABSOLUTE units (never a percentage). CHECK >= 0 enforced at schema.';

-- ─── RLS — staff full CRUD; clients read scoped via variant→product→org ───
ALTER TABLE warehouse_safety_stock_per_channel ENABLE ROW LEVEL SECURITY;

CREATE POLICY staff_all ON warehouse_safety_stock_per_channel
  FOR ALL TO authenticated
  USING (is_staff_user())
  WITH CHECK (is_staff_user());

CREATE POLICY client_select ON warehouse_safety_stock_per_channel
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM warehouse_product_variants v
      JOIN warehouse_products p ON p.id = v.product_id
      WHERE v.id = warehouse_safety_stock_per_channel.variant_id
        AND p.org_id = get_user_org_id()
    )
  );

-- ─── Section C — PostgREST schema reload ──────────────────────────────────
NOTIFY pgrst, 'reload schema';
