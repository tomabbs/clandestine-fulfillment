-- Migration 002: Products and variants
-- Rule #31: SKU uniqueness per workspace via UNIQUE(workspace_id, sku)

CREATE TABLE warehouse_products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  org_id uuid NOT NULL REFERENCES organizations(id),
  shopify_product_id text,
  title text NOT NULL,
  vendor text,
  product_type text,
  status text DEFAULT 'active' CHECK (status IN ('active', 'draft', 'archived')),
  tags text[] DEFAULT '{}',
  shopify_handle text,
  images jsonb DEFAULT '[]',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  synced_at timestamptz
);
CREATE INDEX idx_warehouse_products_org ON warehouse_products(org_id);
CREATE INDEX idx_warehouse_products_workspace ON warehouse_products(workspace_id);
CREATE INDEX idx_warehouse_products_shopify_id ON warehouse_products(shopify_product_id);

CREATE TABLE warehouse_product_variants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL REFERENCES warehouse_products(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  sku text NOT NULL,
  shopify_variant_id text,
  title text,
  price numeric,
  compare_at_price numeric,
  barcode text,
  weight numeric,
  weight_unit text DEFAULT 'lb',
  option1_name text,
  option1_value text,
  format_name text,
  street_date date,
  is_preorder boolean DEFAULT false,
  bandcamp_url text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(workspace_id, sku)
);
CREATE INDEX idx_variants_product ON warehouse_product_variants(product_id);
CREATE INDEX idx_variants_sku ON warehouse_product_variants(workspace_id, sku);
CREATE INDEX idx_variants_shopify ON warehouse_product_variants(shopify_variant_id);
CREATE INDEX idx_variants_barcode ON warehouse_product_variants(barcode);
