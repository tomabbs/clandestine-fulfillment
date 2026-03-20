-- Repair migration: ensure client write policies exist on support_conversations.
-- Safe for repeated runs (checks pg_policies first).

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'support_conversations'
      AND policyname = 'client_insert'
  ) THEN
    EXECUTE $policy$
      CREATE POLICY client_insert ON support_conversations FOR INSERT TO authenticated
        WITH CHECK (org_id = get_user_org_id())
    $policy$;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'support_conversations'
      AND policyname = 'client_update'
  ) THEN
    EXECUTE $policy$
      CREATE POLICY client_update ON support_conversations FOR UPDATE TO authenticated
        USING (org_id = get_user_org_id())
        WITH CHECK (org_id = get_user_org_id())
    $policy$;
  END IF;
END
$$;
