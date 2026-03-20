-- Presence metadata for org/client activity visibility.

ALTER TABLE users
ADD COLUMN IF NOT EXISTS last_seen_at timestamptz,
ADD COLUMN IF NOT EXISTS last_seen_page text;

CREATE INDEX IF NOT EXISTS idx_users_org_last_seen
  ON users(org_id, last_seen_at DESC);
