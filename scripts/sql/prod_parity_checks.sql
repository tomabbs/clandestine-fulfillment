-- Production parity checks for migrations + RLS critical paths
-- Run in Supabase SQL Editor for the target environment.

-- ---------------------------------------------------------------------------
-- A) Table existence checks (critical write paths)
-- ---------------------------------------------------------------------------
SELECT
  table_name,
  CASE WHEN to_regclass('public.' || table_name) IS NOT NULL THEN 'present' ELSE 'missing' END AS status
FROM (
  VALUES
    ('users'),
    ('support_conversations'),
    ('support_messages'),
    ('support_email_mappings'),
    ('warehouse_inbound_shipments'),
    ('warehouse_inbound_items'),
    ('webhook_events')
) AS t(table_name)
ORDER BY table_name;

-- ---------------------------------------------------------------------------
-- B) RLS enabled checks
-- ---------------------------------------------------------------------------
SELECT
  relname AS table_name,
  relrowsecurity AS rls_enabled
FROM pg_class
WHERE relname IN (
  'users',
  'support_conversations',
  'support_messages',
  'support_email_mappings',
  'warehouse_inbound_shipments',
  'warehouse_inbound_items'
)
ORDER BY relname;

-- ---------------------------------------------------------------------------
-- C) Policy presence checks
-- ---------------------------------------------------------------------------
SELECT
  schemaname,
  tablename,
  policyname,
  permissive,
  roles,
  cmd
FROM pg_policies
WHERE tablename IN (
  'users',
  'support_conversations',
  'support_messages',
  'warehouse_inbound_shipments',
  'warehouse_inbound_items'
)
ORDER BY tablename, policyname;

-- ---------------------------------------------------------------------------
-- D) Required policy assertions (human-readable)
-- ---------------------------------------------------------------------------
SELECT
  required_policy,
  CASE WHEN EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = split_part(required_policy, '.', 1)
      AND policyname = split_part(required_policy, '.', 2)
  )
  THEN 'present'
  ELSE 'missing'
  END AS status
FROM (
  VALUES
    ('support_conversations.staff_all'),
    ('support_conversations.client_select'),
    ('support_conversations.client_insert'),
    ('support_conversations.client_update'),
    ('support_messages.staff_all'),
    ('support_messages.client_select'),
    ('support_messages.client_insert'),
    ('warehouse_inbound_shipments.staff_all'),
    ('warehouse_inbound_shipments.client_select'),
    ('warehouse_inbound_items.staff_all'),
    ('warehouse_inbound_items.client_select'),
    ('users.staff_all'),
    ('users.client_select')
) AS req(required_policy)
ORDER BY required_policy;

-- ---------------------------------------------------------------------------
-- E) Migration history checks (best-effort)
-- Supabase stores migration versions in supabase_migrations.schema_migrations.
-- If this schema/table is inaccessible in your project role, run migration
-- verification through your deployment pipeline instead.
-- ---------------------------------------------------------------------------
SELECT
  version
FROM supabase_migrations.schema_migrations
WHERE version IN (
  '20260316000009',
  '20260316000010',
  '20260319000001',
  '20260319000004'
)
ORDER BY version;
