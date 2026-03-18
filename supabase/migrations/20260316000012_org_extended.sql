-- Migration 012: Add extended org fields for client detail page
-- service_type, shopify_vendor_name, stripe_customer_id

ALTER TABLE organizations ADD COLUMN service_type text DEFAULT 'full_service'
  CHECK (service_type IN ('full_service', 'storage_only', 'drop_ship'));

ALTER TABLE organizations ADD COLUMN shopify_vendor_name text;

ALTER TABLE organizations ADD COLUMN stripe_customer_id text;
