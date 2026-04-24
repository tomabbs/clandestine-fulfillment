-- Phase 5 §9.6 D1 — ATP layer substrate.
--
-- Adds the `inventory_commitments` ledger + the denormalized
-- `warehouse_inventory_levels.committed_quantity` counter, kept in
-- lockstep by a Postgres trigger inside the same transaction as each
-- ledger row mutation.
--
-- Why both a ledger AND a counter (per plan §9.6 D1):
--   * Hot fanout path (`computeEffectiveSellable` on every push) needs
--     O(1) read of "currently committed" — a SUM() over an ever-growing
--     append-only ledger would degrade under drop load.
--   * The ledger is the source of truth for audit ("where did this
--     commit come from") and supports non-order commit sources (cart
--     reservations, transfers, manual holds).
--
-- The trigger keeps both in sync. Application code NEVER writes to
-- `warehouse_inventory_levels.committed_quantity` directly — it inserts
-- ledger rows + flips `released_at`. Rule #20 ("single inventory write
-- path") explicitly exempts the counter column because it is only
-- written by the DB trigger, never by application code.
--
-- Backwards-compat note: the existing
-- `warehouse_inventory_levels.committed integer` column (Phase 0
-- placeholder, never written non-zero anywhere in the codebase as of
-- 2026-04-24 audit) is left in place. It will be removed in a future
-- migration once we are confident no read path treats it as
-- meaningful.
--
-- Idempotency: a UNIQUE partial index on
-- `(workspace_id, source, source_id, sku) WHERE released_at IS NULL`
-- prevents the same logical commitment from being inserted twice
-- (e.g., webhook retry of `orders/create`). Application code uses
-- `INSERT ... ON CONFLICT DO NOTHING` so retries are safe no-ops.

BEGIN;

-- ─────────────────────────────────────────────────────────────────────
-- 1) Counter column on warehouse_inventory_levels
-- ─────────────────────────────────────────────────────────────────────

ALTER TABLE warehouse_inventory_levels
  ADD COLUMN IF NOT EXISTS committed_quantity integer NOT NULL DEFAULT 0
    CHECK (committed_quantity >= 0);

COMMENT ON COLUMN warehouse_inventory_levels.committed_quantity IS
  'Phase 5 §9.6 D1. Denormalized counter of currently-open inventory_commitments rows, kept in lockstep by the inventory_commitments_sync trigger inside the same transaction as each ledger mutation. NEVER written directly by application code — Rule #20 exempts this column because the DB trigger is the only writer. Read by computeEffectiveSellable() to compute MAX(0, available - committed_quantity - safety_stock) without scanning the ledger. CHECK >= 0 + GREATEST() in trigger guarantees the counter cannot go negative even if a release fires before the commit row''s INSERT trigger has flushed (ordering safeguard against pathological transaction nesting).';

-- ─────────────────────────────────────────────────────────────────────
-- 2) Ledger table
-- ─────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS inventory_commitments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  sku             text NOT NULL,
  source          text NOT NULL CHECK (source IN ('order','cart','transfer','manual')),
  source_id       text NOT NULL,
  qty             integer NOT NULL CHECK (qty > 0),
  committed_at    timestamptz NOT NULL DEFAULT now(),
  released_at     timestamptz,
  release_reason  text,
  metadata        jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE inventory_commitments IS
  'Phase 5 §9.6 D1. Append-mostly ledger of inventory commitments. Open rows (released_at IS NULL) sum to warehouse_inventory_levels.committed_quantity per (workspace_id, sku) — invariant maintained by the inventory_commitments_sync trigger. Source taxonomy: order = warehouse_orders.id (or external order ref); cart = future cart-reservation feature; transfer = inter-location moves; manual = staff hold for damage/QC. Idempotency: UNIQUE partial index on (workspace_id, source, source_id, sku) WHERE released_at IS NULL — at most one open commitment per logical source per SKU.';

COMMENT ON COLUMN inventory_commitments.source_id IS
  'External identifier scoped to source. For source=order: warehouse_orders.id. For source=cart: cart session id. For source=transfer: transfer batch id. For source=manual: staff-supplied identifier (e.g., damage report id).';

COMMENT ON COLUMN inventory_commitments.released_at IS
  'When NULL, the commitment is OPEN and counts against committed_quantity. When non-NULL, the commitment is RELEASED — released by fulfillment, cancellation, refund, or manual override (release_reason carries the cause). Setting released_at fires the lockstep trigger to decrement the counter.';

COMMENT ON COLUMN inventory_commitments.qty IS
  'Quantity of this single commitment row in absolute units. Must be > 0. Phase 5 substrate uses one row per (warehouse_order_items.id) at full quantity. Partial-fulfillment splitting is a deferred follow-up — until then, fulfillment releases the entire row even if the actual fulfillment was partial. The cron-based reconciliation sync corrects any short-term drift within minutes.';

CREATE UNIQUE INDEX IF NOT EXISTS uq_commitment_open_per_source_sku
  ON inventory_commitments (workspace_id, source, source_id, sku)
  WHERE released_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_commitment_workspace_sku_open
  ON inventory_commitments (workspace_id, sku)
  WHERE released_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_commitment_source_lookup
  ON inventory_commitments (source, source_id);

CREATE INDEX IF NOT EXISTS idx_commitment_released_at
  ON inventory_commitments (released_at)
  WHERE released_at IS NOT NULL;

-- ─────────────────────────────────────────────────────────────────────
-- 3) Lockstep trigger — keeps counter in sync with open rows
-- ─────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION sync_committed_quantity() RETURNS TRIGGER AS $$
DECLARE
  rows_affected integer;
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- Only count toward the counter if the row is open at INSERT.
    -- A row inserted with released_at already non-NULL (unusual but
    -- possible for backfills) is a no-op for the counter.
    IF NEW.released_at IS NULL THEN
      UPDATE warehouse_inventory_levels
        SET committed_quantity = committed_quantity + NEW.qty,
            updated_at = now()
        WHERE workspace_id = NEW.workspace_id
          AND sku = NEW.sku;
      GET DIAGNOSTICS rows_affected = ROW_COUNT;
      IF rows_affected = 0 THEN
        -- The level row should always exist for orderable SKUs.
        -- We do NOT auto-create the level row from the trigger
        -- because the org_id-derivation trigger
        -- (derive_inventory_org_id, Rule #21) requires the variant
        -- to exist, and a missing level usually signals a SKU-data
        -- bug worth surfacing rather than papering over.
        RAISE WARNING 'inventory_commitments INSERT for sku=% workspace=% but no warehouse_inventory_levels row exists; counter not incremented (commit ledger row is still recorded). Source=%/% qty=%',
          NEW.sku, NEW.workspace_id, NEW.source, NEW.source_id, NEW.qty;
      END IF;
    END IF;
    RETURN NEW;

  ELSIF TG_OP = 'UPDATE' THEN
    -- Released → still released: no-op.
    -- Open → released: decrement counter by OLD.qty.
    -- Released → open: forbidden (no "un-release" API).
    -- Open → open with qty change: forbidden (post-commit mutation
    --   would skew the counter).
    IF OLD.released_at IS NULL AND NEW.released_at IS NOT NULL THEN
      UPDATE warehouse_inventory_levels
        SET committed_quantity = GREATEST(0, committed_quantity - OLD.qty),
            updated_at = now()
        WHERE workspace_id = OLD.workspace_id
          AND sku = OLD.sku;
    ELSIF OLD.released_at IS NOT NULL AND NEW.released_at IS NULL THEN
      RAISE EXCEPTION 'inventory_commitments rows cannot be un-released. Insert a new row instead. id=%', OLD.id;
    ELSIF OLD.released_at IS NULL AND NEW.released_at IS NULL AND OLD.qty <> NEW.qty THEN
      RAISE EXCEPTION 'inventory_commitments.qty cannot be changed on an open row. Release this row and insert a new one. id=%', OLD.id;
    END IF;
    NEW.updated_at := now();
    RETURN NEW;

  ELSIF TG_OP = 'DELETE' THEN
    -- Hard-delete an open row → decrement counter so we don't leak
    -- committed quantity. Hard-delete is rare (typically used by
    -- cleanup scripts for fully resolved data); the audit trail
    -- preference is to mark released_at + release_reason instead.
    IF OLD.released_at IS NULL THEN
      UPDATE warehouse_inventory_levels
        SET committed_quantity = GREATEST(0, committed_quantity - OLD.qty),
            updated_at = now()
        WHERE workspace_id = OLD.workspace_id
          AND sku = OLD.sku;
    END IF;
    RETURN OLD;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS inventory_commitments_sync ON inventory_commitments;
CREATE TRIGGER inventory_commitments_sync
  AFTER INSERT OR UPDATE OR DELETE ON inventory_commitments
  FOR EACH ROW EXECUTE FUNCTION sync_committed_quantity();

-- ─────────────────────────────────────────────────────────────────────
-- 4) RLS — ledger is staff-only by default; service_role bypasses
-- ─────────────────────────────────────────────────────────────────────

ALTER TABLE inventory_commitments ENABLE ROW LEVEL SECURITY;

CREATE POLICY staff_all_inventory_commitments
  ON inventory_commitments
  FOR ALL
  TO authenticated
  USING (is_staff_user())
  WITH CHECK (is_staff_user());

COMMIT;
