-- Phase 5 §9.6 D1.b — audit-only commits flag.
--
-- workspaces.atp_committed_active gates whether
-- effective-sellable.ts subtracts inventory_commitments.committed_quantity
-- from the push formula on a per-workspace basis.
--
-- Default FALSE so the existing decrement-at-orders/create semantic is
-- preserved unchanged for every workspace at deploy time. Phase 5 D1.b
-- can therefore land writers (commitInventory in orders/create paths,
-- releaseInventory in orders/fulfill + orders/cancel) WITHOUT changing
-- production push behavior — the commit ledger fills with audit data
-- but the push formula stays at `MAX(0, available - safety)` because
-- `committedToSubtract = atp_committed_active ? committed_quantity : 0`.
--
-- The flag flips per-workspace ONLY after the Phase 5 §9.6 D1.b.1
-- "decrement-at-fulfillment" semantic refactor lands, which moves the
-- existing decrement out of orders/create and into the fulfillment
-- path so the math stops double-counting. Until then this column is a
-- safety wrapper preventing the substrate from accidentally
-- silently underpushing inventory across every channel.
--
-- The recon task `inventory-committed-counter-recon` (D1.c) treats the
-- ledger ↔ counter invariant independently of this flag — it ALWAYS
-- runs because trigger correctness is independent of consumer-side
-- math.

ALTER TABLE workspaces
  ADD COLUMN IF NOT EXISTS atp_committed_active boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN workspaces.atp_committed_active IS
  'Phase 5 §9.6 D1.b. When TRUE, computeEffectiveSellable() subtracts inventory_commitments.committed_quantity from the push formula. When FALSE (the default), the commit ledger is populated for audit/visibility but does NOT alter the push value — preserves the existing decrement-at-orders/create semantic exactly. Flip to TRUE only after the Phase 5 §9.6 D1.b.1 decrement-at-fulfillment refactor lands per workspace; doing so before causes silent double-counting and underpush across every channel.';
