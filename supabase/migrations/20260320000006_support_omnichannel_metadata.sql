-- Omnichannel support metadata patch:
-- - read markers for staff/client
-- - escalation reminder timestamps
-- - message source + delivery metadata

ALTER TABLE support_conversations
ADD COLUMN IF NOT EXISTS client_last_read_at timestamptz,
ADD COLUMN IF NOT EXISTS staff_last_read_at timestamptz,
ADD COLUMN IF NOT EXISTS last_staff_escalated_at timestamptz,
ADD COLUMN IF NOT EXISTS last_client_reminded_at timestamptz;

ALTER TABLE support_messages
ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'app',
ADD COLUMN IF NOT EXISTS delivered_via_email boolean NOT NULL DEFAULT false;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'support_messages_source_check'
  ) THEN
    ALTER TABLE support_messages
      ADD CONSTRAINT support_messages_source_check
      CHECK (source IN ('app', 'email'));
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS idx_support_conversations_staff_read
  ON support_conversations(staff_last_read_at);

CREATE INDEX IF NOT EXISTS idx_support_conversations_client_read
  ON support_conversations(client_last_read_at);
