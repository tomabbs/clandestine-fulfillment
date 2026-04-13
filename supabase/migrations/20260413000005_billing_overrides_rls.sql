-- Phase 5: RLS on warehouse_billing_rule_overrides
-- Trigger.dev tasks use createServiceRoleClient() which bypasses RLS.
ALTER TABLE warehouse_billing_rule_overrides ENABLE ROW LEVEL SECURITY;

CREATE POLICY staff_all ON warehouse_billing_rule_overrides
  FOR ALL TO authenticated
  USING (is_staff_user())
  WITH CHECK (is_staff_user());
