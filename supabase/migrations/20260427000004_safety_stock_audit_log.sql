-- Phase 5 §9.6 D2 — safety stock audit log.
--
-- Plan reference: bandcamp_shopify_enterprise_sync.plan §9.6 D2 (per-channel
-- safety stock UI). TRUTH_LAYER invariant F-NF-X1 (safety stock is ABSOLUTE
-- units, CHECK >= 0 enforced at the schema layer) is satisfied by the source
-- tables (`client_store_sku_mappings`, `warehouse_safety_stock_per_channel`)
-- in 20260424000001_per_channel_safety_stock.sql — this file is purely the
-- audit trail for human edits made through the new admin surface.
--
-- Why a dedicated table (not workspaces.safety_stock_audit JSONB):
--   • forensic queries — "show me every safety_stock change to SKU X over
--     the last 30 days" must be index-friendly, JSONB array-scan won't do.
--   • RLS isolation — clients can read their own safety stock in the channel
--     table (existing policy), but they MUST NOT read who-edited-when. Putting
--     audit on a separate table with staff-only RLS is the cleanest fence.
--   • per-row append — bulk edits of 200 SKUs need 200 audit rows in one
--     batch insert; a JSONB array would require read-modify-write per
--     workspace, which races under concurrent edits.
--
-- Why NOT a DB trigger that auto-mirrors:
--   • the UI surfaces a `reason` field (operator note) and a `source` field
--     (`ui_inline` | `ui_bulk` | `ui_csv`) that DB triggers cannot capture
--     because the values aren't on the source row. The audit insert MUST
--     happen alongside the safety_stock write inside the Server Action.
--   • Rule #20 (single inventory write path) does NOT apply here —
--     safety_stock is a policy column, not an inventory delta. We are NOT
--     routing through `recordInventoryChange()` and we should not.
--
-- Sections:
--   A. warehouse_safety_stock_audit_log table.
--   B. Indexes for the three query patterns the UI needs.
--   C. RLS — staff-only (forensic + edit history; clients have no read).
--   D. Comments + PostgREST schema reload.

-- ─── Section A — table ───────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS warehouse_safety_stock_audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),

  -- Channel discriminator. `storefront` = edit landed on
  -- client_store_sku_mappings; `internal` = edit landed on
  -- warehouse_safety_stock_per_channel (Bandcamp / Clandestine Shopify /
  -- future internal channels).
  channel_kind text NOT NULL CHECK (channel_kind IN ('storefront', 'internal')),

  -- Storefront edits carry connection_id (FK preserved with ON DELETE SET
  -- NULL so deleting a connection does NOT erase its edit history).
  -- Internal edits carry channel_name (open enum: 'bandcamp',
  -- 'clandestine_shopify', future channels — kept as text to mirror the
  -- channel column on warehouse_safety_stock_per_channel).
  connection_id uuid REFERENCES client_store_connections(id) ON DELETE SET NULL,
  channel_name text,

  -- Variant the edit applies to. SET NULL on variant delete so audit
  -- survives variant deletion; the denormalized `sku` column below
  -- preserves the human-readable identifier even after variant_id goes
  -- NULL. SKU is REQUIRED — no NULL audit rows.
  variant_id uuid REFERENCES warehouse_product_variants(id) ON DELETE SET NULL,
  sku text NOT NULL,

  -- Before/after values. NULL `prev_*` means "first time this row has been
  -- edited" (e.g. brand-new safety_stock_per_channel row). Both fields
  -- captured even if only one changed — keeps the diff query trivial.
  prev_safety_stock smallint,
  new_safety_stock smallint NOT NULL CHECK (new_safety_stock >= 0),
  prev_preorder_whitelist boolean,
  new_preorder_whitelist boolean,

  -- Optional operator note. Free text, capped at 500 chars by app-layer
  -- Zod validation (no DB CHECK so future longer notes don't require a
  -- migration cycle).
  reason text,

  -- Where the edit came from. Drives the "Edit source" badge in the audit
  -- log drawer. CHECK constraint enforced at DB so a malicious client
  -- bypassing the action layer cannot poison the audit trail with garbage.
  source text NOT NULL CHECK (source IN ('ui_inline', 'ui_bulk', 'ui_csv', 'system')),

  changed_by uuid REFERENCES users(id) ON DELETE SET NULL,
  changed_at timestamptz NOT NULL DEFAULT now(),

  -- Sanity guard: every row must identify ONE channel (either storefront
  -- via connection_id OR internal via channel_name — never both, never
  -- neither). Defends against a buggy action layer writing under-specified
  -- audit rows.
  CONSTRAINT safety_stock_audit_channel_xor CHECK (
    (channel_kind = 'storefront' AND connection_id IS NOT NULL AND channel_name IS NULL)
    OR
    (channel_kind = 'internal'   AND channel_name  IS NOT NULL AND connection_id IS NULL)
  )
);

-- ─── Section B — indexes ─────────────────────────────────────────────────────

-- Workspace timeline view ("recent edits across the workspace"). Most
-- common UI query; covers the audit drawer's default page.
CREATE INDEX IF NOT EXISTS idx_safety_audit_workspace_changed
  ON warehouse_safety_stock_audit_log(workspace_id, changed_at DESC);

-- Per-SKU drilldown ("show edit history for THIS SKU"). variant_id can be
-- NULL after deletion, so include sku as a fallback predicate path via a
-- composite. The `WHERE variant_id IS NOT NULL` partial keeps the index
-- small while still covering 99% of queries (live SKUs).
CREATE INDEX IF NOT EXISTS idx_safety_audit_variant_changed
  ON warehouse_safety_stock_audit_log(variant_id, changed_at DESC)
  WHERE variant_id IS NOT NULL;

-- Per-connection drilldown ("show edit history for THIS storefront
-- connection"). Used by the Connection Cutover diagnostics panel and the
-- forthcoming per-connection drift report.
CREATE INDEX IF NOT EXISTS idx_safety_audit_connection_changed
  ON warehouse_safety_stock_audit_log(connection_id, changed_at DESC)
  WHERE connection_id IS NOT NULL;

-- ─── Section C — RLS (staff only) ────────────────────────────────────────────

ALTER TABLE warehouse_safety_stock_audit_log ENABLE ROW LEVEL SECURITY;

-- Staff full CRUD. Clients have no policy at all → no read, no write.
-- This is intentional — clients see their CURRENT safety_stock via the
-- existing channel-table client_select policy (in 20260424000001), but
-- "who edited it and when" is staff-internal forensic data.
CREATE POLICY staff_all ON warehouse_safety_stock_audit_log
  FOR ALL TO authenticated
  USING (is_staff_user())
  WITH CHECK (is_staff_user());

-- ─── Section D — comments + schema reload ────────────────────────────────────

COMMENT ON TABLE warehouse_safety_stock_audit_log IS
  'Phase 5 §9.6 D2: append-only audit trail for every per-channel safety_stock or preorder_whitelist edit made through the admin Safety Stock workspace. NOT auto-populated by a DB trigger — the inserting Server Action provides the `reason` and `source` fields the UI captures from operators. RLS: staff only (clients see their CURRENT safety_stock via the source tables, never the edit history).';

COMMENT ON COLUMN warehouse_safety_stock_audit_log.channel_kind IS
  'Discriminator: `storefront` = edit landed on client_store_sku_mappings (always paired with connection_id); `internal` = edit landed on warehouse_safety_stock_per_channel (always paired with channel_name).';

COMMENT ON COLUMN warehouse_safety_stock_audit_log.source IS
  'Provenance of the edit. `ui_inline` = single-row inline edit; `ui_bulk` = multi-row bulk save; `ui_csv` = CSV import commit; `system` = automated change (reserved for future pre-order whitelist auto-grant flows). DB CHECK is the ground truth — no app-layer override.';

COMMENT ON COLUMN warehouse_safety_stock_audit_log.sku IS
  'Denormalized at insert time so the audit row stays human-readable after variant_id is set NULL by an ON DELETE cascade. Required — every audit row identifies exactly one SKU.';

NOTIFY pgrst, 'reload schema';
