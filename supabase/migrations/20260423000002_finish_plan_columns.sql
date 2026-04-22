-- Direct-Shopify cutover finish-line plan — migration bundle.
--
-- Plan reference: direct-shopify-cutover-finish_b7e3ced6.plan.md, slug `p6-f9-health-check-schema`.
-- Bundles ALL new column additions required by the finish-line plan into ONE
-- migration so we don't churn the migrations directory across phases:
--
--   - F-1 (warehouse_order_items.fulfilled_quantity) — partial-cancel recredit
--   - F-4 (webhook_events.dedup_key)                — canonical-form dedup audit
--   - F-5 (client_store_connections.shopify_verified_domain) — HRD-10 install verify
--   - B-3 (client_store_connections.last_webhook_at)         — HRD-14 health card
--   - F-9 (client_store_connections.webhook_topic_health JSONB)
--   - F-9 (client_store_connections.webhook_subscriptions_audit_at)
--   - B-4 (megaplan_spot_check_runs.shopify_direct_available) — 5-source sampling
--
-- Idempotent (`IF NOT EXISTS` everywhere). Reversible by DROP COLUMN; no
-- backfill required (NULL or 0 default for every column means existing rows
-- behave identically to the old schema until consumer code reads them).

-- ─── Section A — warehouse_order_items.fulfilled_quantity (F-1) ─────────────
--
-- HRD-08.1 partial-cancel recredit. orders/create handler now persists this
-- column from line_items[i].fulfillment_status === 'fulfilled'; the
-- orders/cancelled handler subtracts it from the original quantity to compute
-- the remaining-unfulfilled units to recredit. Treats the DB as source of
-- truth on conflict with the cancel webhook payload (Rule #20-adjacent
-- invariant). WRITE-ONLY from webhook handlers (handleOrderCreated +
-- handleOrderCancelled telemetry path) — Server Actions, admin tools, and
-- backfill scripts must NEVER mutate this column directly. Enforced by the
-- companion CI grep-guard `scripts/check-fulfilled-quantity-writers.sh`.
--
-- Partial index for cheap "find all partially-fulfilled rows" lookups
-- (operational diagnostic queries during cutover), tiny by construction.

ALTER TABLE warehouse_order_items
  ADD COLUMN IF NOT EXISTS fulfilled_quantity integer NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_order_items_fulfillment
  ON warehouse_order_items(order_id, sku)
  WHERE fulfilled_quantity > 0;

COMMENT ON COLUMN warehouse_order_items.fulfilled_quantity IS
  'F-1 (HRD-08.1): units already fulfilled by Shopify at the time of orders/create. handleOrderCancelled subtracts this from quantity to compute remaining-unfulfilled units to recredit. Source-of-truth invariant: WRITE-ONLY from webhook handlers; all other writers blocked by scripts/check-fulfilled-quantity-writers.sh.';

-- ─── Section B — webhook_events.dedup_key (F-4) ──────────────────────────────
--
-- Canonical-form dedup key persisted alongside external_webhook_id so
-- operators can grep by the resolved key when investigating "duplicate"
-- rejections. Format: `{platform}:{sha256(canonical_body)}` for the
-- Squarespace fallback path; `{connection_id}:{external_webhook_id}` when a
-- platform header is present. NULL on rows persisted before the F-4 rollout.

ALTER TABLE webhook_events
  ADD COLUMN IF NOT EXISTS dedup_key text;

CREATE INDEX IF NOT EXISTS idx_webhook_events_dedup_key
  ON webhook_events(dedup_key)
  WHERE dedup_key IS NOT NULL;

COMMENT ON COLUMN webhook_events.dedup_key IS
  'F-4: resolved dedup key. Format `{platform}:{sha256(canonical_body)}` for Squarespace-style fallback (no platform header), or `{connection_id}:{external_webhook_id}` when a header is available. Persisted for forensics — operators can grep this column instead of recomputing the hash when investigating duplicate-rejection traces. NULL on rows from before F-4.';

-- ─── Section C — client_store_connections HRD-10 + HRD-14 + F-9 columns ────
--
-- shopify_verified_domain (F-5/HRD-10): the Shopify-canonical
-- `shop.myshopifyDomain` value captured at install time, normalized
-- (lowercase + .myshopify.com suffix). The OAuth callback rejects installs
-- where the verified domain doesn't match the `shop` query param to prevent
-- token-reuse-across-shops attacks. Persisted so future re-checks (e.g.,
-- staff-initiated re-verification button) can compare against truth without
-- re-querying Shopify.
--
-- last_webhook_at (B-3/HRD-14): canonical "last successfully-handled webhook
-- for this connection" — the SOLE source of truth for the Channels page
-- webhook-health card. Updated by process-client-store-webhook on every
-- successful event completion. NOT joined with webhook_events.last_seen_at
-- in the health card to prevent two-source drift.
--
-- webhook_topic_health (F-9): SNAPSHOT (not history) of per-topic
-- subscription state. Shape: `{ "<topic>": { last_seen_at, subscription_id,
-- api_version, callback_url } }`. Overwritten on every health-check run + on
-- every successful re-register diff. If history is later required, that's a
-- separate `webhook_topic_health_runs` table.
--
-- webhook_subscriptions_audit_at (F-9): wall-clock of the last time the
-- registered topics were diffed against Shopify's view of truth (either by
-- the deferred shopify-webhook-health-check task or by an operator hitting
-- the "Re-register webhooks" button on the Channels page).

ALTER TABLE client_store_connections
  ADD COLUMN IF NOT EXISTS shopify_verified_domain text;

ALTER TABLE client_store_connections
  ADD COLUMN IF NOT EXISTS last_webhook_at timestamptz;

ALTER TABLE client_store_connections
  ADD COLUMN IF NOT EXISTS webhook_topic_health jsonb;

ALTER TABLE client_store_connections
  ADD COLUMN IF NOT EXISTS webhook_subscriptions_audit_at timestamptz;

COMMENT ON COLUMN client_store_connections.shopify_verified_domain IS
  'F-5/HRD-10: Shopify-canonical shop.myshopifyDomain captured at install (normalized lowercase + .myshopify.com suffix). OAuth callback rejects mismatched installs to prevent token-reuse-across-shops. NULL on connections installed before HRD-10 rollout.';

COMMENT ON COLUMN client_store_connections.last_webhook_at IS
  'B-3/HRD-14: canonical "last successfully-handled webhook for this connection". Updated by process-client-store-webhook on every successful event completion. SOLE source of truth for the Channels page webhook-health card; do NOT join with webhook_events.last_seen_at.';

COMMENT ON COLUMN client_store_connections.webhook_topic_health IS
  'F-9: snapshot (not history) of per-topic Shopify webhook subscription state. Shape: { "<topic>": { last_seen_at, subscription_id, api_version, callback_url } }. Overwritten on every health-check + on every successful re-register diff.';

COMMENT ON COLUMN client_store_connections.webhook_subscriptions_audit_at IS
  'F-9: wall-clock of the last time the registered topics were diffed against Shopify''s view of truth (shopify-webhook-health-check task OR operator-driven Re-register button).';

-- ─── Section D — megaplan_spot_check_runs.shopify_direct_available (B-4) ───
--
-- HRD-15: 5th source for cross-system inventory verification. The existing
-- megaplan-spot-check task samples DB / Redis / ShipStation v2 / Bandcamp;
-- this column captures the per-SKU `inventoryLevel.available` returned by a
-- direct Shopify Admin GraphQL query at the connection's `default_location_id`.
-- NULL when the SKU has no client_store_sku_mappings row for shopify, or when
-- the GraphQL probe failed (the artifact still persists, with the failure
-- mode in the error column).
--
-- The artifact rows live for 90 days (existing retention policy on
-- megaplan_spot_check_runs); no separate retention pass needed for this
-- column.

ALTER TABLE megaplan_spot_check_runs
  ADD COLUMN IF NOT EXISTS shopify_direct_available integer;

COMMENT ON COLUMN megaplan_spot_check_runs.shopify_direct_available IS
  'B-4/HRD-15: per-SKU `available` from a direct Shopify Admin GraphQL inventoryLevel probe at the connection''s default_location_id. NULL when no shopify mapping exists, or when the GraphQL probe failed.';

-- ─── Section E — PostgREST schema reload ────────────────────────────────────
NOTIFY pgrst, 'reload schema';
