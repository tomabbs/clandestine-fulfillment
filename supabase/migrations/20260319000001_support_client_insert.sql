-- Allow clients to create and update support conversations for their own org.
-- Previously only staff_all policy existed for INSERT/UPDATE, blocking client users.
CREATE POLICY client_insert ON support_conversations FOR INSERT TO authenticated
  WITH CHECK (org_id = get_user_org_id());

CREATE POLICY client_update ON support_conversations FOR UPDATE TO authenticated
  USING (org_id = get_user_org_id())
  WITH CHECK (org_id = get_user_org_id());
