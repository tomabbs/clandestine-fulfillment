-- Migration 005: Supporting tables (billing, inventory activity, images, shipment/order items, sync state, imports)
-- Rule #32: Every inventory delta must have a correlation_id — enforced by UNIQUE(sku, correlation_id)
-- Rule #34: Billing snapshots are immutable — adjustments go to warehouse_billing_adjustments only

CREATE TABLE warehouse_billing_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  rule_name text NOT NULL,
  rule_type text NOT NULL CHECK (rule_type IN ('per_shipment', 'per_item', 'storage', 'material', 'adjustment')),
  amount numeric NOT NULL,
  description text,
  is_active boolean DEFAULT true,
  effective_from date DEFAULT CURRENT_DATE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE warehouse_format_costs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  format_name text NOT NULL,
  pick_pack_cost numeric NOT NULL,
  material_cost numeric NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(workspace_id, format_name)
);

CREATE TABLE warehouse_format_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  format_pattern text NOT NULL,
  format_name text NOT NULL,
  priority integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE warehouse_billing_adjustments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  org_id uuid NOT NULL REFERENCES organizations(id),
  billing_period text NOT NULL,
  amount numeric NOT NULL,
  reason text,
  created_by uuid REFERENCES users(id),
  snapshot_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Rule #32: UNIQUE(sku, correlation_id) prevents double-writes from retries
CREATE TABLE warehouse_inventory_activity (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  sku text NOT NULL,
  delta integer NOT NULL,
  source text NOT NULL CHECK (source IN ('shopify', 'bandcamp', 'squarespace', 'woocommerce', 'shipstation', 'manual', 'inbound', 'preorder', 'backfill')),
  correlation_id text NOT NULL,
  previous_quantity integer,
  new_quantity integer,
  metadata jsonb DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(sku, correlation_id)
);
CREATE INDEX idx_activity_sku ON warehouse_inventory_activity(sku);
CREATE INDEX idx_activity_created ON warehouse_inventory_activity(created_at DESC);

CREATE TABLE warehouse_product_images (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL REFERENCES warehouse_products(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  position integer DEFAULT 0,
  src text NOT NULL,
  alt text,
  shopify_image_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE warehouse_shipment_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shipment_id uuid NOT NULL REFERENCES warehouse_shipments(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  sku text NOT NULL,
  quantity integer NOT NULL,
  product_title text,
  variant_title text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE warehouse_order_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES warehouse_orders(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  sku text NOT NULL,
  quantity integer NOT NULL,
  price numeric,
  title text,
  variant_title text,
  shopify_line_item_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE warehouse_shipstation_stores (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  org_id uuid REFERENCES organizations(id),
  store_id integer NOT NULL,
  store_name text,
  marketplace_name text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(workspace_id, store_id)
);

CREATE TABLE warehouse_pirate_ship_imports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  file_name text NOT NULL,
  storage_path text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
  row_count integer,
  processed_count integer DEFAULT 0,
  error_count integer DEFAULT 0,
  errors jsonb DEFAULT '[]',
  uploaded_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE TABLE warehouse_sync_state (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  sync_type text NOT NULL,
  last_sync_cursor text,
  last_sync_wall_clock timestamptz,
  last_full_sync_at timestamptz,
  metadata jsonb DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(workspace_id, sync_type)
);
