-- Phase 5 — tiered ShipStation v2 ↔ DB reconcile + canonical sku_sync_status view.
--
-- Plan reference: §7.1.6.1 (tiered reconcile) + §7.1.13 (sku_sync_status view).
--
-- Two changes that must ship together so the reconcile task can write to
-- `warehouse_inventory_activity` with `source = 'reconcile'` AND admin pages
-- can read the per-SKU sync state without reconstructing it from 6+ joins.
--
-- (1) `warehouse_inventory_activity.source` CHECK constraint expands to admit
--     `'reconcile'` — the new sentinel value used by the reconcile sensor when
--     it adjusts our DB to match v2. `recordInventoryChange()` already accepts
--     an opaque `source` string at the TS layer; the only enforcement is the
--     DB CHECK plus the `InventorySource` union type. Both move in lock-step.
--
-- (2) `sku_sync_status` view — one row per `warehouse_product_variants`,
--     denormalizing across `bandcamp_product_mappings`, `bandcamp_baseline_anomalies`,
--     `sku_sync_conflicts`, `external_sync_events`, and `warehouse_inventory_levels`.
--     Read-only and idempotent. The plan §7.1.13 left a comment about
--     materializing for high-traffic admin pages — Phase 5 ships the live view
--     first per Open Question #9 (perf decision; live view is correct, materialization
--     is a cache that we add when an admin page exceeds 500ms p95).
--
-- Idempotent: CHECK swap uses DROP IF EXISTS / ADD; view uses CREATE OR REPLACE.

-- ─── (1) source CHECK extension ────────────────────────────────────────────
-- Drop and re-add the CHECK constraint to admit 'reconcile' as a valid
-- inventory-write source. Existing rows are unaffected — this is a
-- relaxation of the constraint, never a tightening.
ALTER TABLE warehouse_inventory_activity
  DROP CONSTRAINT IF EXISTS warehouse_inventory_activity_source_check;

ALTER TABLE warehouse_inventory_activity
  ADD CONSTRAINT warehouse_inventory_activity_source_check
  CHECK (source IN (
    'shopify',
    'bandcamp',
    'squarespace',
    'woocommerce',
    'shipstation',
    'manual',
    'inbound',
    'preorder',
    'backfill',
    'reconcile'
  ));

COMMENT ON CONSTRAINT warehouse_inventory_activity_source_check
  ON warehouse_inventory_activity IS
  'Phase 5: ''reconcile'' admitted for the tiered ShipStation v2 ↔ DB reconcile sensor (shipstation-bandcamp-reconcile-{hot,warm,cold}). Reconcile assumes v2 is the source of truth and writes a delta into our DB to match; the activity row is the audit trail. Other sources unchanged.';

-- ─── (2) sku_sync_status view ──────────────────────────────────────────────
-- Plan §7.1.13. One row per warehouse_product_variants. Admin pages and the
-- Phase 5 monitoring surface read this instead of reconstructing the join
-- graph per request.
--
-- Column rationale:
--   - is_distro: warehouse_products.org_id IS NULL → Clandestine-owned, no Bandcamp upstream
--   - has_bandcamp_mapping / bandcamp_push_mode / bandcamp_push_blocked: composite Bandcamp gate state
--   - baseline_anomaly_open: open row in bandcamp_baseline_anomalies for this SKU
--   - sku_conflict_open: open row in sku_sync_conflicts for this variant
--   - last_shipstation_push_at / last_bandcamp_push_at: most recent SUCCESS row in external_sync_events
--   - last_external_error: most recent error row's response_body->>message (NULL if none)
--   - available / last_internal_write_at: pulled from warehouse_inventory_levels
--
-- Notes:
--   - The view is a security-invoker view in PG 15+, but for compatibility
--     with the current Supabase Postgres baseline we leave it as the default
--     (security_definer behavior). RLS still applies through the underlying
--     tables when the caller queries via PostgREST (anon/authenticated). For
--     the admin monitoring page the caller is service_role.
--   - The correlated subqueries against external_sync_events use the
--     idx_external_sync_events_history index (sku, system, completed_at desc)
--     created in Phase 0.5's sku_rectify_infrastructure migration.
--   - Bundle parents are included (their bandcamp/v2 push state is separately
--     gated; the bundle.derived_drift sensor handles their v2 drift). The
--     view does NOT compute derived bundle availability — that lives in
--     code via computeEffectiveBundleAvailable().
CREATE OR REPLACE VIEW sku_sync_status AS
SELECT
  v.id                                                        AS variant_id,
  v.workspace_id                                              AS workspace_id,
  p.org_id                                                    AS org_id,
  v.sku                                                       AS sku,
  (p.org_id IS NULL)                                          AS is_distro,
  (bcm.id IS NOT NULL)                                        AS has_bandcamp_mapping,
  COALESCE(bcm.push_mode, 'normal'::bandcamp_push_mode)       AS bandcamp_push_mode,
  (COALESCE(bcm.push_mode, 'normal'::bandcamp_push_mode) <> 'normal'::bandcamp_push_mode)
                                                              AS bandcamp_push_blocked,
  EXISTS (
    SELECT 1
    FROM bandcamp_baseline_anomalies a
    WHERE a.workspace_id = v.workspace_id
      AND a.sku = v.sku
      AND a.resolved_at IS NULL
  )                                                           AS baseline_anomaly_open,
  EXISTS (
    SELECT 1
    FROM sku_sync_conflicts c
    WHERE c.variant_id = v.id
      AND c.status = 'open'
  )                                                           AS sku_conflict_open,
  (
    SELECT MAX(e.completed_at)
    FROM external_sync_events e
    WHERE e.sku = v.sku
      AND e.system = 'shipstation_v2'
      AND e.status = 'success'
  )                                                           AS last_shipstation_push_at,
  (
    SELECT MAX(e.completed_at)
    FROM external_sync_events e
    WHERE e.sku = v.sku
      AND e.system = 'bandcamp'
      AND e.status = 'success'
  )                                                           AS last_bandcamp_push_at,
  (
    SELECT e.response_body->>'message'
    FROM external_sync_events e
    WHERE e.sku = v.sku
      AND e.status = 'error'
    ORDER BY e.completed_at DESC
    LIMIT 1
  )                                                           AS last_external_error,
  il.available                                                AS available,
  il.last_redis_write_at                                      AS last_internal_write_at
FROM warehouse_product_variants v
LEFT JOIN warehouse_products p
  ON p.id = v.product_id
LEFT JOIN bandcamp_product_mappings bcm
  ON bcm.variant_id = v.id
LEFT JOIN warehouse_inventory_levels il
  ON il.variant_id = v.id;

COMMENT ON VIEW sku_sync_status IS
  'Phase 5: canonical per-SKU sync state. One row per warehouse_product_variants joining bandcamp_product_mappings, bandcamp_baseline_anomalies (open), sku_sync_conflicts (open), external_sync_events (last success/error), and warehouse_inventory_levels. Live view; if any admin page exceeds 500ms p95, materialize via a follow-up migration.';

-- Materialization scaffold (intentionally commented — see Open Question #9).
-- If/when an admin page exceeds 500ms p95, uncomment and add a refresh task:
--   CREATE MATERIALIZED VIEW sku_sync_status_mv AS SELECT * FROM sku_sync_status;
--   CREATE UNIQUE INDEX ON sku_sync_status_mv (variant_id);
--   -- REFRESH MATERIALIZED VIEW CONCURRENTLY sku_sync_status_mv; (every 5 min via Trigger schedule)
