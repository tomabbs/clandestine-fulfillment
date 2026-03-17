-- Migration 006: Inbound shipments and items

CREATE TABLE warehouse_inbound_shipments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  org_id uuid NOT NULL REFERENCES organizations(id),
  tracking_number text,
  carrier text,
  expected_date date,
  actual_arrival_date date,
  status text NOT NULL DEFAULT 'expected' CHECK (status IN ('expected', 'arrived', 'checking_in', 'checked_in', 'issue')),
  notes text,
  submitted_by uuid REFERENCES users(id),
  checked_in_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_inbound_org ON warehouse_inbound_shipments(org_id);
CREATE INDEX idx_inbound_status ON warehouse_inbound_shipments(status);

CREATE TABLE warehouse_inbound_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  inbound_shipment_id uuid NOT NULL REFERENCES warehouse_inbound_shipments(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  sku text NOT NULL,
  expected_quantity integer NOT NULL DEFAULT 0,
  received_quantity integer DEFAULT 0,
  condition_notes text,
  location_id uuid REFERENCES warehouse_locations(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
