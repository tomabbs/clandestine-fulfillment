-- Migration 003: Inventory levels, locations, variant locations
-- Rule #21: org_id auto-derived by DB trigger from variant -> product -> org

CREATE TABLE warehouse_inventory_levels (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  variant_id uuid NOT NULL UNIQUE REFERENCES warehouse_product_variants(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  org_id uuid REFERENCES organizations(id),
  sku text NOT NULL,
  available integer NOT NULL DEFAULT 0,
  committed integer NOT NULL DEFAULT 0,
  incoming integer NOT NULL DEFAULT 0,
  last_redis_write_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_inventory_levels_sku ON warehouse_inventory_levels(workspace_id, sku);
CREATE INDEX idx_inventory_levels_org ON warehouse_inventory_levels(org_id);

-- Auto-derive org_id from variant -> product -> org (Rule #21)
CREATE OR REPLACE FUNCTION derive_inventory_org_id()
RETURNS TRIGGER AS $$
BEGIN
  SELECT wp.org_id INTO NEW.org_id
  FROM warehouse_product_variants wpv
  JOIN warehouse_products wp ON wp.id = wpv.product_id
  WHERE wpv.id = NEW.variant_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_derive_inventory_org_id
  BEFORE INSERT OR UPDATE ON warehouse_inventory_levels
  FOR EACH ROW
  EXECUTE FUNCTION derive_inventory_org_id();

CREATE TABLE warehouse_locations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  name text NOT NULL,
  barcode text,
  location_type text NOT NULL CHECK (location_type IN ('shelf', 'bin', 'floor', 'staging')),
  is_active boolean DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(workspace_id, name)
);

CREATE TABLE warehouse_variant_locations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  variant_id uuid NOT NULL REFERENCES warehouse_product_variants(id) ON DELETE CASCADE,
  location_id uuid NOT NULL REFERENCES warehouse_locations(id),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  quantity integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(variant_id, location_id)
);
