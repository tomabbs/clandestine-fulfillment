-- Order Pages Transition Phase 4a — canonical preorder-pending unified view.
--
-- Today, "is this order awaiting a preorder release?" is computed in two
-- places using two different vocabularies:
--
--   Direct  (warehouse_orders):   is_preorder = true AND fulfillment_status IS NULL
--   Mirror  (shipstation_orders): preorder_state IN ('preorder', 'ready')
--                                 AND order_status NOT IN ('shipped', 'cancelled')
--
-- The plan's reviewer flagged that the two predicates drift over time —
-- Mirror added the `'ready'` state in Phase 5.1 and Direct never caught
-- up. The unified view lets every read surface (Direct Orders cockpit,
-- Mirror cockpit, Phase-4a /admin/preorders refresh, parity diagnostics)
-- consume one canonical predicate.
--
-- The view is intentionally LIVE (no materialized refresh) so date
-- boundaries flip in real time. A CI guard
-- (`scripts/ci-checks/preorder-predicate-drift.sh`) hashes this view's
-- definition and the inline predicates in `src/lib/shared/order-preorder.ts`
-- so two writers cannot diverge without the build catching it.

CREATE OR REPLACE VIEW preorder_pending_orders AS
  SELECT
    'direct'::text                 AS surface,
    wo.id                           AS order_id,
    wo.workspace_id,
    wo.org_id,
    wo.order_number,
    wo.customer_email,
    wo.customer_name,
    wo.created_at                   AS order_created_at,
    wo.street_date                  AS preorder_release_date,
    NULL::text                      AS preorder_state,
    wo.is_preorder                  AS direct_is_preorder,
    wo.fulfillment_status,
    NULL::text                      AS shipstation_order_status
  FROM warehouse_orders wo
  WHERE wo.is_preorder = true
    AND (wo.fulfillment_status IS NULL OR wo.fulfillment_status NOT IN ('fulfilled', 'cancelled'))
  UNION ALL
  SELECT
    'shipstation_mirror'::text      AS surface,
    so.id                           AS order_id,
    so.workspace_id,
    so.org_id,
    so.order_number,
    so.customer_email,
    so.customer_name,
    so.created_at                   AS order_created_at,
    so.preorder_release_date        AS preorder_release_date,
    so.preorder_state               AS preorder_state,
    NULL::boolean                   AS direct_is_preorder,
    NULL::text                      AS fulfillment_status,
    so.order_status                 AS shipstation_order_status
  FROM shipstation_orders so
  WHERE so.preorder_state IN ('preorder', 'ready')
    AND so.order_status NOT IN ('shipped', 'cancelled');

COMMENT ON VIEW preorder_pending_orders IS
  'Order Pages Transition Phase 4a — canonical preorder-pending unified view across Direct (warehouse_orders) and ShipStation Mirror (shipstation_orders). Read by /admin/preorders + parity diagnostics. CI guard: scripts/ci-checks/preorder-predicate-drift.sh hashes this view body so the predicates cannot drift across surfaces.';
