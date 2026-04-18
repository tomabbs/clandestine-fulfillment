-- Phase 4 — bidirectional bridge defaults.
--
-- Background fanout tasks (`shipstation-v2-decrement`, future SHIP_NOTIFY
-- echo cancellers, etc.) need a per-workspace default
-- (inventory_warehouse_id, inventory_location_id) pair to address the v2
-- inventory API. The Phase 3 admin /shipstation-seed page already prompts
-- the operator for these values; we now persist the values on the
-- workspace so background tasks can look them up without re-prompting.
--
-- Both columns are nullable: when either is NULL, the
-- `shipstation-v2-decrement` task short-circuits and logs a structured
-- skip (no v2 wired yet). This matches the Phase 4 ramp posture: every
-- workspace starts at fanout_rollout_percent = 0 and is opted in only
-- after the operator confirms the v2 warehouse + location selection on
-- the Channels page.

ALTER TABLE workspaces
  ADD COLUMN IF NOT EXISTS shipstation_v2_inventory_warehouse_id text,
  ADD COLUMN IF NOT EXISTS shipstation_v2_inventory_location_id text;

COMMENT ON COLUMN workspaces.shipstation_v2_inventory_warehouse_id IS
  'Phase 4: default ShipStation v2 inventory warehouse used by background fanout tasks (sale-poll → ssv2 decrement). NULL ⇒ no v2 wired for this workspace yet; fanout tasks short-circuit. Populated by the admin /shipstation-seed page after the operator selects the canonical warehouse.';

COMMENT ON COLUMN workspaces.shipstation_v2_inventory_location_id IS
  'Phase 4: default ShipStation v2 inventory location (paired with shipstation_v2_inventory_warehouse_id above). NULL ⇒ no v2 wired; background fanout tasks short-circuit.';
