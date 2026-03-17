-- Migration 004: Orders, shipments, tracking events

CREATE TABLE warehouse_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  org_id uuid NOT NULL REFERENCES organizations(id),
  shopify_order_id text,
  order_number text,
  customer_name text,
  customer_email text,
  financial_status text,
  fulfillment_status text,
  total_price numeric,
  currency text DEFAULT 'USD',
  line_items jsonb DEFAULT '[]',
  shipping_address jsonb,
  tags text[] DEFAULT '{}',
  is_preorder boolean DEFAULT false,
  street_date date,
  source text DEFAULT 'shopify' CHECK (source IN ('shopify', 'bandcamp', 'woocommerce', 'squarespace', 'manual')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  synced_at timestamptz
);
CREATE INDEX idx_orders_org ON warehouse_orders(org_id);
CREATE INDEX idx_orders_shopify ON warehouse_orders(shopify_order_id);
CREATE INDEX idx_orders_created ON warehouse_orders(created_at DESC);

CREATE TABLE warehouse_shipments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  org_id uuid NOT NULL REFERENCES organizations(id),
  shipstation_shipment_id text,
  order_id uuid REFERENCES warehouse_orders(id),
  tracking_number text,
  carrier text,
  service text,
  ship_date date,
  delivery_date date,
  status text DEFAULT 'shipped',
  shipping_cost numeric,
  weight numeric,
  dimensions jsonb,
  label_data jsonb,
  voided boolean DEFAULT false,
  billed boolean DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_shipments_org ON warehouse_shipments(org_id);
CREATE INDEX idx_shipments_tracking ON warehouse_shipments(tracking_number);
CREATE INDEX idx_shipments_ship_date ON warehouse_shipments(ship_date DESC);

CREATE TABLE warehouse_tracking_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shipment_id uuid NOT NULL REFERENCES warehouse_shipments(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  status text NOT NULL,
  description text,
  location text,
  event_time timestamptz,
  source text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_tracking_shipment ON warehouse_tracking_events(shipment_id);
