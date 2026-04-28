-- SKU matching manual review suppression.
--
-- Operators sometimes see the same remote Shopify candidate ranked against many
-- canonical rows. This table records human "not a match" decisions so the
-- review workspace can suppress that remote candidate from automated ranking
-- without touching the live alias table.

CREATE TABLE IF NOT EXISTS sku_match_candidate_rejections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  connection_id uuid NOT NULL REFERENCES client_store_connections(id) ON DELETE CASCADE,
  variant_id uuid REFERENCES warehouse_product_variants(id) ON DELETE CASCADE,
  scope text NOT NULL DEFAULT 'connection' CHECK (scope IN ('connection', 'variant')),
  remote_key text NOT NULL,
  remote_product_id text,
  remote_variant_id text,
  remote_inventory_item_id text,
  remote_sku text,
  remote_title text,
  reason text NOT NULL DEFAULT 'manual_not_match',
  notes text,
  rejected_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_sku_match_rejections_remote_scope
  ON sku_match_candidate_rejections(
    workspace_id,
    connection_id,
    scope,
    COALESCE(variant_id, '00000000-0000-0000-0000-000000000000'::uuid),
    remote_key
  );

CREATE INDEX IF NOT EXISTS idx_sku_match_rejections_connection
  ON sku_match_candidate_rejections(workspace_id, connection_id, scope, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_sku_match_rejections_variant
  ON sku_match_candidate_rejections(workspace_id, connection_id, variant_id)
  WHERE variant_id IS NOT NULL;

ALTER TABLE sku_match_candidate_rejections ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS staff_all_sku_match_candidate_rejections
  ON sku_match_candidate_rejections;
CREATE POLICY staff_all_sku_match_candidate_rejections
  ON sku_match_candidate_rejections FOR ALL TO authenticated
  USING (is_staff_user()) WITH CHECK (is_staff_user());

COMMENT ON TABLE sku_match_candidate_rejections IS
  'Staff-authored negative evidence for SKU matching review. Connection-scoped rows suppress a remote candidate from automated ranking across the connection; variant-scoped rows are available for future row-only rejection. Does not feed inventory fanout and does not mutate client_store_sku_mappings.';

COMMENT ON COLUMN sku_match_candidate_rejections.remote_key IS
  'Stable remote identity key chosen in inventory_item -> variant -> product -> normalized SKU order by the SKU matching action layer.';

NOTIFY pgrst, 'reload schema';
