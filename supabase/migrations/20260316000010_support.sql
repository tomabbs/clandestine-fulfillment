-- Migration 010: Support conversations, messages, email mappings
-- support_messages RLS uses join to support_conversations.org_id (no org_id on messages table)

CREATE TABLE support_conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  org_id uuid NOT NULL REFERENCES organizations(id),
  subject text NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'waiting_on_client', 'waiting_on_staff', 'resolved', 'closed')),
  priority text NOT NULL DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  assigned_to uuid REFERENCES users(id),
  inbound_email_id text,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_support_conversations_org ON support_conversations(org_id);
CREATE INDEX idx_support_conversations_status ON support_conversations(status);

CREATE TABLE support_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES support_conversations(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  sender_id uuid REFERENCES users(id),
  sender_type text NOT NULL CHECK (sender_type IN ('staff', 'client', 'system')),
  body text NOT NULL,
  email_message_id text,
  attachments jsonb DEFAULT '[]',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_support_messages_conversation ON support_messages(conversation_id);

CREATE TABLE support_email_mappings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  email_address text NOT NULL,
  org_id uuid NOT NULL REFERENCES organizations(id),
  is_active boolean DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(workspace_id, email_address)
);

-- RLS: support_conversations
ALTER TABLE support_conversations ENABLE ROW LEVEL SECURITY;
CREATE POLICY staff_all ON support_conversations FOR ALL TO authenticated USING (is_staff_user()) WITH CHECK (is_staff_user());
CREATE POLICY client_select ON support_conversations FOR SELECT TO authenticated USING (org_id = get_user_org_id());

-- RLS: support_messages (join to conversation for org_id)
ALTER TABLE support_messages ENABLE ROW LEVEL SECURITY;
CREATE POLICY staff_all ON support_messages FOR ALL TO authenticated USING (is_staff_user()) WITH CHECK (is_staff_user());
CREATE POLICY client_select ON support_messages FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM support_conversations sc
    WHERE sc.id = support_messages.conversation_id
    AND sc.org_id = get_user_org_id()
  ));
-- Clients can INSERT messages on their own conversations
CREATE POLICY client_insert ON support_messages FOR INSERT TO authenticated
  WITH CHECK (EXISTS (
    SELECT 1 FROM support_conversations sc
    WHERE sc.id = conversation_id
    AND sc.org_id = get_user_org_id()
  ));

-- RLS: support_email_mappings (staff only)
ALTER TABLE support_email_mappings ENABLE ROW LEVEL SECURITY;
CREATE POLICY staff_all ON support_email_mappings FOR ALL TO authenticated USING (is_staff_user()) WITH CHECK (is_staff_user());
