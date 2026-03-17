-- Migration 009: Row Level Security policies for all tables
-- Staff: full CRUD via is_staff_user()
-- Clients: SELECT own org via get_user_org_id()
-- Tables without org_id: workspace-scoped staff-only
-- Tables with org_id via join: client policies join to parent

-- ============================================================
-- Helper functions
-- ============================================================

CREATE OR REPLACE FUNCTION get_user_org_id() RETURNS uuid AS $$
  SELECT org_id FROM users WHERE auth_user_id = auth.uid()
$$ LANGUAGE sql SECURITY DEFINER STABLE;

CREATE OR REPLACE FUNCTION is_staff_user() RETURNS boolean AS $$
  SELECT EXISTS (
    SELECT 1 FROM users
    WHERE auth_user_id = auth.uid()
    AND role IN ('admin', 'super_admin', 'label_staff', 'label_management', 'warehouse_manager')
  )
$$ LANGUAGE sql SECURITY DEFINER STABLE;

-- ============================================================
-- Macro: org-scoped tables (have org_id column directly)
-- Staff: full CRUD
-- Client: SELECT own org
-- ============================================================

-- organizations
ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
CREATE POLICY staff_all ON organizations FOR ALL TO authenticated USING (is_staff_user()) WITH CHECK (is_staff_user());
CREATE POLICY client_select ON organizations FOR SELECT TO authenticated USING (id = get_user_org_id());

-- warehouse_products
ALTER TABLE warehouse_products ENABLE ROW LEVEL SECURITY;
CREATE POLICY staff_all ON warehouse_products FOR ALL TO authenticated USING (is_staff_user()) WITH CHECK (is_staff_user());
CREATE POLICY client_select ON warehouse_products FOR SELECT TO authenticated USING (org_id = get_user_org_id());

-- warehouse_product_variants (org_id via product join)
ALTER TABLE warehouse_product_variants ENABLE ROW LEVEL SECURITY;
CREATE POLICY staff_all ON warehouse_product_variants FOR ALL TO authenticated USING (is_staff_user()) WITH CHECK (is_staff_user());
CREATE POLICY client_select ON warehouse_product_variants FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM warehouse_products wp
    WHERE wp.id = warehouse_product_variants.product_id
    AND wp.org_id = get_user_org_id()
  ));

-- warehouse_inventory_levels
ALTER TABLE warehouse_inventory_levels ENABLE ROW LEVEL SECURITY;
CREATE POLICY staff_all ON warehouse_inventory_levels FOR ALL TO authenticated USING (is_staff_user()) WITH CHECK (is_staff_user());
CREATE POLICY client_select ON warehouse_inventory_levels FOR SELECT TO authenticated USING (org_id = get_user_org_id());

-- warehouse_orders
ALTER TABLE warehouse_orders ENABLE ROW LEVEL SECURITY;
CREATE POLICY staff_all ON warehouse_orders FOR ALL TO authenticated USING (is_staff_user()) WITH CHECK (is_staff_user());
CREATE POLICY client_select ON warehouse_orders FOR SELECT TO authenticated USING (org_id = get_user_org_id());

-- warehouse_shipments
ALTER TABLE warehouse_shipments ENABLE ROW LEVEL SECURITY;
CREATE POLICY staff_all ON warehouse_shipments FOR ALL TO authenticated USING (is_staff_user()) WITH CHECK (is_staff_user());
CREATE POLICY client_select ON warehouse_shipments FOR SELECT TO authenticated USING (org_id = get_user_org_id());

-- warehouse_tracking_events (org_id via shipment join)
ALTER TABLE warehouse_tracking_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY staff_all ON warehouse_tracking_events FOR ALL TO authenticated USING (is_staff_user()) WITH CHECK (is_staff_user());
CREATE POLICY client_select ON warehouse_tracking_events FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM warehouse_shipments ws
    WHERE ws.id = warehouse_tracking_events.shipment_id
    AND ws.org_id = get_user_org_id()
  ));

-- warehouse_billing_snapshots
ALTER TABLE warehouse_billing_snapshots ENABLE ROW LEVEL SECURITY;
CREATE POLICY staff_all ON warehouse_billing_snapshots FOR ALL TO authenticated USING (is_staff_user()) WITH CHECK (is_staff_user());
CREATE POLICY client_select ON warehouse_billing_snapshots FOR SELECT TO authenticated USING (org_id = get_user_org_id());

-- warehouse_billing_adjustments
ALTER TABLE warehouse_billing_adjustments ENABLE ROW LEVEL SECURITY;
CREATE POLICY staff_all ON warehouse_billing_adjustments FOR ALL TO authenticated USING (is_staff_user()) WITH CHECK (is_staff_user());
CREATE POLICY client_select ON warehouse_billing_adjustments FOR SELECT TO authenticated USING (org_id = get_user_org_id());

-- warehouse_inbound_shipments
ALTER TABLE warehouse_inbound_shipments ENABLE ROW LEVEL SECURITY;
CREATE POLICY staff_all ON warehouse_inbound_shipments FOR ALL TO authenticated USING (is_staff_user()) WITH CHECK (is_staff_user());
CREATE POLICY client_select ON warehouse_inbound_shipments FOR SELECT TO authenticated USING (org_id = get_user_org_id());

-- warehouse_inbound_items (org_id via inbound_shipment join)
ALTER TABLE warehouse_inbound_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY staff_all ON warehouse_inbound_items FOR ALL TO authenticated USING (is_staff_user()) WITH CHECK (is_staff_user());
CREATE POLICY client_select ON warehouse_inbound_items FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM warehouse_inbound_shipments wis
    WHERE wis.id = warehouse_inbound_items.inbound_shipment_id
    AND wis.org_id = get_user_org_id()
  ));

-- warehouse_review_queue
ALTER TABLE warehouse_review_queue ENABLE ROW LEVEL SECURITY;
CREATE POLICY staff_all ON warehouse_review_queue FOR ALL TO authenticated USING (is_staff_user()) WITH CHECK (is_staff_user());
CREATE POLICY client_select ON warehouse_review_queue FOR SELECT TO authenticated USING (org_id = get_user_org_id());

-- bandcamp_connections
ALTER TABLE bandcamp_connections ENABLE ROW LEVEL SECURITY;
CREATE POLICY staff_all ON bandcamp_connections FOR ALL TO authenticated USING (is_staff_user()) WITH CHECK (is_staff_user());
CREATE POLICY client_select ON bandcamp_connections FOR SELECT TO authenticated USING (org_id = get_user_org_id());

-- bandcamp_product_mappings (org_id via variant -> product join)
ALTER TABLE bandcamp_product_mappings ENABLE ROW LEVEL SECURITY;
CREATE POLICY staff_all ON bandcamp_product_mappings FOR ALL TO authenticated USING (is_staff_user()) WITH CHECK (is_staff_user());
CREATE POLICY client_select ON bandcamp_product_mappings FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM warehouse_product_variants wpv
    JOIN warehouse_products wp ON wp.id = wpv.product_id
    WHERE wpv.id = bandcamp_product_mappings.variant_id
    AND wp.org_id = get_user_org_id()
  ));

-- warehouse_shipstation_stores
ALTER TABLE warehouse_shipstation_stores ENABLE ROW LEVEL SECURITY;
CREATE POLICY staff_all ON warehouse_shipstation_stores FOR ALL TO authenticated USING (is_staff_user()) WITH CHECK (is_staff_user());
CREATE POLICY client_select ON warehouse_shipstation_stores FOR SELECT TO authenticated USING (org_id = get_user_org_id());

-- warehouse_pirate_ship_imports (staff only — no org_id-based client access needed)
ALTER TABLE warehouse_pirate_ship_imports ENABLE ROW LEVEL SECURITY;
CREATE POLICY staff_all ON warehouse_pirate_ship_imports FOR ALL TO authenticated USING (is_staff_user()) WITH CHECK (is_staff_user());

-- channel_sync_log (staff only — operational data)
ALTER TABLE channel_sync_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY staff_all ON channel_sync_log FOR ALL TO authenticated USING (is_staff_user()) WITH CHECK (is_staff_user());

-- sensor_readings (staff only — operational data)
ALTER TABLE sensor_readings ENABLE ROW LEVEL SECURITY;
CREATE POLICY staff_all ON sensor_readings FOR ALL TO authenticated USING (is_staff_user()) WITH CHECK (is_staff_user());

-- portal_admin_settings
ALTER TABLE portal_admin_settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY staff_all ON portal_admin_settings FOR ALL TO authenticated USING (is_staff_user()) WITH CHECK (is_staff_user());
CREATE POLICY client_select ON portal_admin_settings FOR SELECT TO authenticated USING (org_id = get_user_org_id());

-- warehouse_product_images (org_id via product join)
ALTER TABLE warehouse_product_images ENABLE ROW LEVEL SECURITY;
CREATE POLICY staff_all ON warehouse_product_images FOR ALL TO authenticated USING (is_staff_user()) WITH CHECK (is_staff_user());
CREATE POLICY client_select ON warehouse_product_images FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM warehouse_products wp
    WHERE wp.id = warehouse_product_images.product_id
    AND wp.org_id = get_user_org_id()
  ));

-- warehouse_shipment_items (org_id via shipment join)
ALTER TABLE warehouse_shipment_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY staff_all ON warehouse_shipment_items FOR ALL TO authenticated USING (is_staff_user()) WITH CHECK (is_staff_user());
CREATE POLICY client_select ON warehouse_shipment_items FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM warehouse_shipments ws
    WHERE ws.id = warehouse_shipment_items.shipment_id
    AND ws.org_id = get_user_org_id()
  ));

-- warehouse_order_items (org_id via order join)
ALTER TABLE warehouse_order_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY staff_all ON warehouse_order_items FOR ALL TO authenticated USING (is_staff_user()) WITH CHECK (is_staff_user());
CREATE POLICY client_select ON warehouse_order_items FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM warehouse_orders wo
    WHERE wo.id = warehouse_order_items.order_id
    AND wo.org_id = get_user_org_id()
  ));

-- warehouse_variant_locations (org_id via variant -> product join)
ALTER TABLE warehouse_variant_locations ENABLE ROW LEVEL SECURITY;
CREATE POLICY staff_all ON warehouse_variant_locations FOR ALL TO authenticated USING (is_staff_user()) WITH CHECK (is_staff_user());
CREATE POLICY client_select ON warehouse_variant_locations FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM warehouse_product_variants wpv
    JOIN warehouse_products wp ON wp.id = wpv.product_id
    WHERE wpv.id = warehouse_variant_locations.variant_id
    AND wp.org_id = get_user_org_id()
  ));

-- warehouse_inventory_activity (staff only — operational audit trail)
ALTER TABLE warehouse_inventory_activity ENABLE ROW LEVEL SECURITY;
CREATE POLICY staff_all ON warehouse_inventory_activity FOR ALL TO authenticated USING (is_staff_user()) WITH CHECK (is_staff_user());

-- ============================================================
-- Workspace-scoped staff-only tables (no org_id column)
-- ============================================================

-- warehouse_locations
ALTER TABLE warehouse_locations ENABLE ROW LEVEL SECURITY;
CREATE POLICY staff_all ON warehouse_locations FOR ALL TO authenticated USING (is_staff_user()) WITH CHECK (is_staff_user());

-- warehouse_sync_state
ALTER TABLE warehouse_sync_state ENABLE ROW LEVEL SECURITY;
CREATE POLICY staff_all ON warehouse_sync_state FOR ALL TO authenticated USING (is_staff_user()) WITH CHECK (is_staff_user());

-- warehouse_billing_rules
ALTER TABLE warehouse_billing_rules ENABLE ROW LEVEL SECURITY;
CREATE POLICY staff_all ON warehouse_billing_rules FOR ALL TO authenticated USING (is_staff_user()) WITH CHECK (is_staff_user());

-- warehouse_format_costs
ALTER TABLE warehouse_format_costs ENABLE ROW LEVEL SECURITY;
CREATE POLICY staff_all ON warehouse_format_costs FOR ALL TO authenticated USING (is_staff_user()) WITH CHECK (is_staff_user());

-- warehouse_format_rules
ALTER TABLE warehouse_format_rules ENABLE ROW LEVEL SECURITY;
CREATE POLICY staff_all ON warehouse_format_rules FOR ALL TO authenticated USING (is_staff_user()) WITH CHECK (is_staff_user());

-- webhook_events (staff only — operational data)
ALTER TABLE webhook_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY staff_all ON webhook_events FOR ALL TO authenticated USING (is_staff_user()) WITH CHECK (is_staff_user());

-- bandcamp_credentials (staff only — sensitive credentials)
ALTER TABLE bandcamp_credentials ENABLE ROW LEVEL SECURITY;
CREATE POLICY staff_all ON bandcamp_credentials FOR ALL TO authenticated USING (is_staff_user()) WITH CHECK (is_staff_user());

-- ============================================================
-- Special case: users table
-- Staff see all users; clients see only users in their own org
-- ============================================================

ALTER TABLE users ENABLE ROW LEVEL SECURITY;
CREATE POLICY staff_all ON users FOR ALL TO authenticated USING (is_staff_user()) WITH CHECK (is_staff_user());
CREATE POLICY client_select ON users FOR SELECT TO authenticated USING (org_id = get_user_org_id());
