-- Migration 011: Client store connections and SKU mappings
-- Rule #19: Client credential submission uses service_role (bypasses RLS)
-- Rule #28: Store connection health columns (last_webhook_at, last_poll_at, last_error_at, last_error)
-- Rule #44: last_pushed_quantity / last_pushed_at for WooCommerce drift tracking
-- Rule #53: do_not_fanout flag + connection_status for circuit breakers

CREATE TABLE client_store_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  org_id uuid NOT NULL REFERENCES organizations(id),
  platform text NOT NULL CHECK (platform IN ('shopify', 'woocommerce', 'squarespace', 'bigcommerce')),
  store_url text NOT NULL,
  api_key text,
  api_secret text,
  webhook_url text,
  webhook_secret text,
  connection_status text NOT NULL DEFAULT 'pending' CHECK (connection_status IN ('pending', 'active', 'disabled_auth_failure', 'error')),
  last_webhook_at timestamptz,
  last_poll_at timestamptz,
  last_error_at timestamptz,
  last_error text,
  do_not_fanout boolean DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_store_connections_org ON client_store_connections(org_id);

CREATE TABLE client_store_sku_mappings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  connection_id uuid NOT NULL REFERENCES client_store_connections(id) ON DELETE CASCADE,
  variant_id uuid NOT NULL REFERENCES warehouse_product_variants(id),
  remote_product_id text,
  remote_variant_id text,
  remote_sku text,
  last_pushed_quantity integer,
  last_pushed_at timestamptz,
  is_active boolean DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_sku_mappings_connection ON client_store_sku_mappings(connection_id);
CREATE INDEX idx_sku_mappings_variant ON client_store_sku_mappings(variant_id);

-- RLS: client_store_connections
-- Staff: full CRUD
-- Clients: SELECT own org only (service_role handles credential writes per Rule #19)
ALTER TABLE client_store_connections ENABLE ROW LEVEL SECURITY;
CREATE POLICY staff_all ON client_store_connections FOR ALL TO authenticated USING (is_staff_user()) WITH CHECK (is_staff_user());
CREATE POLICY client_select ON client_store_connections FOR SELECT TO authenticated USING (org_id = get_user_org_id());

-- RLS: client_store_sku_mappings
-- Staff: full CRUD
-- Clients: SELECT where connection.org_id matches their org (join-based)
ALTER TABLE client_store_sku_mappings ENABLE ROW LEVEL SECURITY;
CREATE POLICY staff_all ON client_store_sku_mappings FOR ALL TO authenticated USING (is_staff_user()) WITH CHECK (is_staff_user());
CREATE POLICY client_select ON client_store_sku_mappings FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM client_store_connections csc
    WHERE csc.id = client_store_sku_mappings.connection_id
    AND csc.org_id = get_user_org_id()
  ));
