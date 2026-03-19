-- Organization hierarchy: parent/child relationships + merge support

ALTER TABLE organizations ADD COLUMN IF NOT EXISTS parent_org_id uuid REFERENCES organizations(id);
CREATE INDEX IF NOT EXISTS idx_organizations_parent ON organizations(parent_org_id);
