-- Support Inbox 2.0 additive substrate.
-- Adds ticket-engine metadata, delivery ledger, staff-only collaboration tables,
-- duplicate candidate review, and DB-owned SLA pause accounting.

ALTER TABLE support_conversations
  ADD COLUMN IF NOT EXISTS source_channel text NOT NULL DEFAULT 'app',
  ADD COLUMN IF NOT EXISTS category text,
  ADD COLUMN IF NOT EXISTS tags text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS snoozed_until timestamptz,
  ADD COLUMN IF NOT EXISTS first_response_due_at timestamptz,
  ADD COLUMN IF NOT EXISTS first_responded_at timestamptz,
  ADD COLUMN IF NOT EXISTS next_response_due_at timestamptz,
  ADD COLUMN IF NOT EXISTS resolution_due_at timestamptz,
  ADD COLUMN IF NOT EXISTS sla_policy_id uuid,
  ADD COLUMN IF NOT EXISTS sla_breached_at timestamptz,
  ADD COLUMN IF NOT EXISTS sla_paused boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS sla_paused_at timestamptz,
  ADD COLUMN IF NOT EXISTS sla_pause_reason text,
  ADD COLUMN IF NOT EXISTS sla_accumulated_pause_duration interval NOT NULL DEFAULT '0 seconds',
  ADD COLUMN IF NOT EXISTS resolved_at timestamptz,
  ADD COLUMN IF NOT EXISTS resolved_by uuid REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS resolution_code text,
  ADD COLUMN IF NOT EXISTS resolution_summary text,
  ADD COLUMN IF NOT EXISTS external_thread_id text,
  ADD COLUMN IF NOT EXISTS external_order_id text,
  ADD COLUMN IF NOT EXISTS external_customer_handle text;

ALTER TABLE support_messages
  ADD COLUMN IF NOT EXISTS client_mutation_id text,
  ADD COLUMN IF NOT EXISTS source_channel text,
  ADD COLUMN IF NOT EXISTS direction text,
  ADD COLUMN IF NOT EXISTS external_message_id text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'support_conversations_source_channel_check'
  ) THEN
    ALTER TABLE support_conversations
      ADD CONSTRAINT support_conversations_source_channel_check
      CHECK (source_channel IN ('app', 'email', 'discogs', 'bandcamp_fan', 'system'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'support_conversations_category_check'
  ) THEN
    ALTER TABLE support_conversations
      ADD CONSTRAINT support_conversations_category_check
      CHECK (
        category IS NULL OR category IN (
          'order',
          'shipping_address',
          'inventory_sku',
          'inbound',
          'billing',
          'store_connection',
          'bandcamp_fan',
          'discogs_buyer',
          'technical_issue',
          'other'
        )
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'support_conversations_resolution_code_check'
  ) THEN
    ALTER TABLE support_conversations
      ADD CONSTRAINT support_conversations_resolution_code_check
      CHECK (
        resolution_code IS NULL OR resolution_code IN (
          'answered',
          'fixed',
          'duplicate',
          'not_actionable',
          'external',
          'client_no_response',
          'spam_or_noise'
        )
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'support_messages_direction_check'
  ) THEN
    ALTER TABLE support_messages
      ADD CONSTRAINT support_messages_direction_check
      CHECK (direction IS NULL OR direction IN ('inbound', 'outbound', 'internal'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'support_messages_source_channel_check'
  ) THEN
    ALTER TABLE support_messages
      ADD CONSTRAINT support_messages_source_channel_check
      CHECK (
        source_channel IS NULL OR source_channel IN ('app', 'email', 'discogs', 'bandcamp_fan', 'system')
      );
  END IF;
END
$$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_support_messages_client_mutation
  ON support_messages(workspace_id, conversation_id, client_mutation_id)
  WHERE client_mutation_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_support_conversations_active_queue
  ON support_conversations (workspace_id, status, assigned_to, priority, updated_at DESC)
  WHERE status NOT IN ('resolved', 'closed');

CREATE INDEX IF NOT EXISTS idx_support_conversations_sla
  ON support_conversations (workspace_id, next_response_due_at)
  WHERE status NOT IN ('resolved', 'closed');

CREATE INDEX IF NOT EXISTS idx_support_conversations_snoozed
  ON support_conversations (workspace_id, snoozed_until)
  WHERE snoozed_until IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_support_conversations_source_category
  ON support_conversations (workspace_id, source_channel, category);

CREATE TABLE IF NOT EXISTS support_sla_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  name text NOT NULL,
  priority text NOT NULL CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  category text,
  source_channel text,
  first_response_minutes int NOT NULL CHECK (first_response_minutes > 0),
  next_response_minutes int NOT NULL CHECK (next_response_minutes > 0),
  resolution_minutes int CHECK (resolution_minutes IS NULL OR resolution_minutes > 0),
  business_hours_only boolean NOT NULL DEFAULT false,
  escalate_before_breach_minutes int NOT NULL DEFAULT 30 CHECK (escalate_before_breach_minutes >= 0),
  escalation_email_to text[] NOT NULL DEFAULT '{}',
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS support_internal_notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  conversation_id uuid NOT NULL REFERENCES support_conversations(id) ON DELETE CASCADE,
  author_id uuid REFERENCES users(id),
  body text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS support_saved_replies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  title text NOT NULL,
  body text NOT NULL,
  category text,
  tags text[] NOT NULL DEFAULT '{}',
  is_active boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS support_conversation_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  conversation_id uuid NOT NULL REFERENCES support_conversations(id) ON DELETE CASCADE,
  actor_id uuid REFERENCES users(id),
  event_type text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS support_message_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  conversation_id uuid NOT NULL REFERENCES support_conversations(id) ON DELETE CASCADE,
  message_id uuid NOT NULL REFERENCES support_messages(id) ON DELETE CASCADE,
  channel text NOT NULL CHECK (channel IN ('app', 'email', 'discogs', 'bandcamp', 'system')),
  recipient text,
  provider text,
  provider_message_id text,
  provider_thread_id text,
  status text NOT NULL DEFAULT 'pending' CHECK (
    status IN ('pending', 'queued', 'sent', 'delivered', 'failed', 'skipped')
  ),
  attempt_count int NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  last_attempt_at timestamptz,
  next_retry_at timestamptz,
  error_code text,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (message_id, channel)
);

CREATE TABLE IF NOT EXISTS support_duplicate_candidates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  conversation_id uuid NOT NULL REFERENCES support_conversations(id) ON DELETE CASCADE,
  duplicate_of_conversation_id uuid NOT NULL REFERENCES support_conversations(id) ON DELETE CASCADE,
  confidence numeric NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  match_reason text NOT NULL,
  reviewed boolean NOT NULL DEFAULT false,
  review_decision text CHECK (
    review_decision IS NULL OR review_decision IN ('merge', 'keep_separate', 'ignore')
  ),
  reviewed_by uuid REFERENCES users(id),
  reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (conversation_id, duplicate_of_conversation_id)
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'support_conversation_events_type_check'
  ) THEN
    ALTER TABLE support_conversation_events
      ADD CONSTRAINT support_conversation_events_type_check
      CHECK (
        event_type IN (
          'conversation_created',
          'message_created',
          'assignment_changed',
          'priority_changed',
          'category_changed',
          'tags_changed',
          'status_changed',
          'snoozed',
          'reopened',
          'resolved',
          'internal_note_created',
          'delivery_queued',
          'delivery_sent',
          'delivery_failed',
          'sla_breached',
          'collision_detected',
          'duplicate_candidate_created'
        )
      );
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS idx_support_notes_conversation
  ON support_internal_notes(workspace_id, conversation_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_support_saved_replies_active
  ON support_saved_replies(workspace_id, is_active, title);

CREATE UNIQUE INDEX IF NOT EXISTS uq_support_sla_policies_scope
  ON support_sla_policies(
    workspace_id,
    priority,
    coalesce(category, ''),
    coalesce(source_channel, '')
  );

CREATE INDEX IF NOT EXISTS idx_support_events_conversation
  ON support_conversation_events(workspace_id, conversation_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_support_deliveries_pending
  ON support_message_deliveries(workspace_id, status, next_retry_at)
  WHERE status IN ('pending', 'failed');

CREATE UNIQUE INDEX IF NOT EXISTS uq_support_delivery_provider_message
  ON support_message_deliveries(provider, provider_message_id)
  WHERE provider IS NOT NULL AND provider_message_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_support_duplicate_candidates_conversation
  ON support_duplicate_candidates(workspace_id, conversation_id, reviewed, created_at DESC);

ALTER TABLE support_sla_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE support_internal_notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE support_saved_replies ENABLE ROW LEVEL SECURITY;
ALTER TABLE support_conversation_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE support_message_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE support_duplicate_candidates ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS staff_all_support_sla_policies ON support_sla_policies;
CREATE POLICY staff_all_support_sla_policies
  ON support_sla_policies FOR ALL TO authenticated
  USING (is_staff_user()) WITH CHECK (is_staff_user());

DROP POLICY IF EXISTS staff_all_support_internal_notes ON support_internal_notes;
CREATE POLICY staff_all_support_internal_notes
  ON support_internal_notes FOR ALL TO authenticated
  USING (is_staff_user()) WITH CHECK (is_staff_user());

DROP POLICY IF EXISTS staff_all_support_saved_replies ON support_saved_replies;
CREATE POLICY staff_all_support_saved_replies
  ON support_saved_replies FOR ALL TO authenticated
  USING (is_staff_user()) WITH CHECK (is_staff_user());

DROP POLICY IF EXISTS staff_all_support_events ON support_conversation_events;
CREATE POLICY staff_all_support_events
  ON support_conversation_events FOR ALL TO authenticated
  USING (is_staff_user()) WITH CHECK (is_staff_user());

DROP POLICY IF EXISTS client_select_support_events ON support_conversation_events;
CREATE POLICY client_select_support_events
  ON support_conversation_events FOR SELECT TO authenticated
  USING (
    event_type IN ('conversation_created', 'message_created', 'resolved', 'reopened')
    AND EXISTS (
      SELECT 1
      FROM support_conversations sc
      WHERE sc.id = support_conversation_events.conversation_id
        AND sc.org_id = get_user_org_id()
    )
  );

DROP POLICY IF EXISTS staff_all_support_message_deliveries ON support_message_deliveries;
CREATE POLICY staff_all_support_message_deliveries
  ON support_message_deliveries FOR ALL TO authenticated
  USING (is_staff_user()) WITH CHECK (is_staff_user());

DROP POLICY IF EXISTS staff_all_support_duplicate_candidates ON support_duplicate_candidates;
CREATE POLICY staff_all_support_duplicate_candidates
  ON support_duplicate_candidates FOR ALL TO authenticated
  USING (is_staff_user()) WITH CHECK (is_staff_user());

CREATE OR REPLACE FUNCTION support_sla_pause_on_status_change()
RETURNS trigger AS $$
BEGIN
  IF NEW.status = 'waiting_on_client' AND OLD.status IS DISTINCT FROM 'waiting_on_client' THEN
    NEW.sla_paused := true;
    NEW.sla_paused_at := coalesce(NEW.sla_paused_at, now());
    NEW.sla_pause_reason := 'waiting_on_client';
  ELSIF OLD.status = 'waiting_on_client' AND NEW.status IS DISTINCT FROM 'waiting_on_client' THEN
    IF OLD.sla_paused_at IS NOT NULL THEN
      NEW.sla_accumulated_pause_duration :=
        coalesce(OLD.sla_accumulated_pause_duration, interval '0 seconds') + (now() - OLD.sla_paused_at);
    END IF;
    NEW.sla_paused := false;
    NEW.sla_paused_at := null;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_support_sla_pause_on_status_change ON support_conversations;
CREATE TRIGGER trg_support_sla_pause_on_status_change
  BEFORE UPDATE ON support_conversations
  FOR EACH ROW
  WHEN (OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION support_sla_pause_on_status_change();

INSERT INTO support_sla_policies (
  workspace_id,
  name,
  priority,
  first_response_minutes,
  next_response_minutes,
  resolution_minutes,
  business_hours_only
)
SELECT w.id, defaults.name, defaults.priority, defaults.first_response_minutes, defaults.next_response_minutes, defaults.resolution_minutes, false
FROM workspaces w
CROSS JOIN (
  VALUES
    ('Urgent', 'urgent', 60, 60, 1440),
    ('High', 'high', 240, 240, 2880),
    ('Normal', 'normal', 1440, 1440, 7200),
    ('Low', 'low', 2880, 2880, NULL::int)
) AS defaults(name, priority, first_response_minutes, next_response_minutes, resolution_minutes)
WHERE NOT EXISTS (
  SELECT 1
  FROM support_sla_policies existing
  WHERE existing.workspace_id = w.id
    AND existing.priority = defaults.priority
    AND existing.category IS NULL
    AND existing.source_channel IS NULL
);
