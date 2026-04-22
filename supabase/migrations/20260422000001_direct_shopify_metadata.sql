-- Direct Shopify + Bandcamp cutover — preparatory schema (HRD-35 foundation)
--
-- Plan reference: direct-shopify-bandcamp-cutover_8773b15b.plan.md, slug
-- `migration-direct-shopify-metadata`. Adds the schema surface required by
-- HRD-01, HRD-03, HRD-05, HRD-11, HRD-26, HRD-35, HRD-35.1. NO behavior is
-- flipped — every column is additive and new connections still default to
-- `do_not_fanout = false` (the OAuth route writes `do_not_fanout = true`
-- on insert as a separate code-side change in this same session).
--
-- Idempotent throughout (`IF NOT EXISTS` everywhere) so re-running on a
-- partial-success retry is a no-op. Reversible by dropping the columns and
-- the unique index added below.
--
-- ─── Section A — client_store_connections additions (HRD-05, HRD-35) ────────
--
-- HRD-05: default_location_id captures the staff-selected Shopify location
-- per connection. Inventory webhook events with location_id != this column
-- are persisted with status='wrong_location' instead of being applied.
--
-- HRD-35: per-connection Shopify Custom-distribution app credentials. The
-- OAuth route prefers per-connection creds (when present) over the env-var
-- fallback (Clandestine-internal app + legacy public app). Secret column is
-- named `*_encrypted` so the future encryption work (deferred slug
-- `client-store-credentials-at-rest-encryption`) is a behavior change, not a
-- column rename. Today the column carries plaintext.

ALTER TABLE client_store_connections
  ADD COLUMN IF NOT EXISTS default_location_id text;

ALTER TABLE client_store_connections
  ADD COLUMN IF NOT EXISTS shopify_app_client_id text;

ALTER TABLE client_store_connections
  ADD COLUMN IF NOT EXISTS shopify_app_client_secret_encrypted text;

COMMENT ON COLUMN client_store_connections.default_location_id IS
  'Staff-selected Shopify location for inventory ops. Inventory webhook events with location_id != this value are persisted as wrong_location and not applied.';
COMMENT ON COLUMN client_store_connections.shopify_app_client_id IS
  'Per-connection Shopify Custom-distribution app Client ID. NULL = use env fallback (legacy + Clandestine-internal app).';
COMMENT ON COLUMN client_store_connections.shopify_app_client_secret_encrypted IS
  'Per-connection Shopify Custom-distribution app Client Secret. Stored plaintext today; column name is forward-compatible with deferred encryption-at-rest work.';

-- ─── Section B — client_store_sku_mappings.remote_inventory_item_id (HRD-03) ─
--
-- Shopify inventory_levels/update webhooks carry `inventory_item_id`, not SKU.
-- We resolve to our SKU via this column. Multiple Shopify variants in the same
-- shop CAN share a SKU (apparel — color × size grid), but each variant has a
-- unique inventory_item_id. The UNIQUE(connection_id, remote_inventory_item_id)
-- catches the (rare) case where a merchant has two Shopify variants that
-- somehow point at the same inventory_item_id — a hard error surface so
-- staff investigate rather than silently double-write to the same SKU.
-- The unique constraint is partial (WHERE remote_inventory_item_id IS NOT
-- NULL) so existing rows that haven't been backfilled don't trip it.

ALTER TABLE client_store_sku_mappings
  ADD COLUMN IF NOT EXISTS remote_inventory_item_id text;

CREATE UNIQUE INDEX IF NOT EXISTS idx_sku_mappings_connection_inventory_item
  ON client_store_sku_mappings(connection_id, remote_inventory_item_id)
  WHERE remote_inventory_item_id IS NOT NULL;

COMMENT ON COLUMN client_store_sku_mappings.remote_inventory_item_id IS
  'Shopify inventory_item_id (or platform analog). Populated by autoDiscoverSkus + webhook-driven backfill. Used to resolve inventory_levels/update webhooks to our SKU without re-querying Shopify.';

-- ─── Section C — webhook_events.last_seen_at (HRD-01) ──────────────────────
--
-- Monotonic timestamp guard. The webhook ingress route sets this on every
-- successful processing keyed by (connection_id, topic, entity_id) — but
-- the lookup for the prior value happens via the existing JSONB metadata
-- column rather than a new dedicated table. last_seen_at is the dedicated
-- column for the most-recent value per webhook_events row to keep the
-- audit query cheap.

ALTER TABLE webhook_events
  ADD COLUMN IF NOT EXISTS last_seen_at timestamptz;

COMMENT ON COLUMN webhook_events.last_seen_at IS
  'Most-recent processed-event timestamp for HRD-01 monotonic guard. Set on every successful event processing.';

-- ─── Section D — workspaces.bc_verify_direct_primary (HRD-11) ──────────────
--
-- Per-workspace gate for the bandcamp-shipping-verify polarity flip. Plan
-- §HRD-11: only flip a workspace to direct-primary verification when (a)
-- shipstation_marked_shipped_at has been NULL for the last 48h AND (b)
-- workspaces.shipstation_sync_paused = true AND (c) staff explicitly toggle
-- this flag. Default false = today's behavior (ShipStation primary).

ALTER TABLE workspaces
  ADD COLUMN IF NOT EXISTS bc_verify_direct_primary boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN workspaces.bc_verify_direct_primary IS
  'HRD-11: per-workspace gate for bandcamp-shipping-verify polarity flip. False = ShipStation tracking primary (today). True = direct push primary (post-cutover).';

-- ─── Section E — warehouse_inventory_activity source enum: + inventory_activate
--
-- HRD-26: Shopify inventoryActivate calls record activity even though they
-- carry `delta = 0`, so admin can grep for "this SKU was activated at this
-- timestamp" without joining external_sync_events. Re-create the constraint
-- inside DO $$ so a partial prior re-run is idempotent.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'warehouse_inventory_activity_source_check'
  ) THEN
    ALTER TABLE warehouse_inventory_activity
      DROP CONSTRAINT warehouse_inventory_activity_source_check;
  END IF;
END $$;

ALTER TABLE warehouse_inventory_activity
  ADD CONSTRAINT warehouse_inventory_activity_source_check
  CHECK (source IN (
    'shopify','bandcamp','squarespace','woocommerce','shipstation',
    'manual','inbound','preorder','backfill','reconcile',
    'cycle_count','manual_inventory_count',
    'inventory_activate'
  ));

COMMENT ON CONSTRAINT warehouse_inventory_activity_source_check
  ON warehouse_inventory_activity IS
  'Direct-Shopify cutover: inventory_activate admitted for HRD-26 lazy Shopify location activation (delta = 0 audit row).';

-- ─── Section F — oauth_states generalization for OAuth 2.0 (HRD-35.1) ──────
--
-- The existing oauth_states table was shaped for OAuth 1.0a Discogs:
-- `request_token_secret NOT NULL`, no `connection_id`. For Shopify OAuth 2.0
-- we need a state-nonce-only flow with optional connection_id (for the
-- multi-app HRD-35 install) or org_id alone (for the legacy single-app flow).
-- This relaxes request_token_secret to NULLable and adds connection_id +
-- nonce_purpose so the same table serves both protocols safely.
--
-- Existing OAuth 1.0a callers (Discogs) keep working — they always populate
-- request_token_secret and never set nonce_purpose. The Shopify route ALWAYS
-- sets nonce_purpose='shopify_install' so we can safely partition queries.

ALTER TABLE oauth_states
  ALTER COLUMN request_token_secret DROP NOT NULL;

ALTER TABLE oauth_states
  ADD COLUMN IF NOT EXISTS connection_id uuid REFERENCES client_store_connections(id) ON DELETE CASCADE;

ALTER TABLE oauth_states
  ADD COLUMN IF NOT EXISTS nonce_purpose text;

CREATE INDEX IF NOT EXISTS idx_oauth_states_connection
  ON oauth_states(connection_id) WHERE connection_id IS NOT NULL;

COMMENT ON COLUMN oauth_states.request_token_secret IS
  'OAuth 1.0a only (Discogs). NULL for OAuth 2.0 flows (Shopify install).';
COMMENT ON COLUMN oauth_states.connection_id IS
  'HRD-35.1: optional pointer at the client_store_connections row this state is for. Populated by the per-connection Shopify install flow; NULL for legacy single-app OAuth.';
COMMENT ON COLUMN oauth_states.nonce_purpose IS
  'HRD-35.1: discriminator for nonce flows. shopify_install = Shopify OAuth 2.0 store-and-verify nonce. NULL = legacy OAuth 1.0a (Discogs).';

-- ─── Section G — PostgREST schema reload ───────────────────────────────────
NOTIFY pgrst, 'reload schema';
