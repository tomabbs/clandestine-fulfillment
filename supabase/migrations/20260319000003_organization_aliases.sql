-- Organization aliases for client name matching across import sources
-- (Pirate Ship, ShipStation store names, etc.)

CREATE TABLE organization_aliases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  alias_name TEXT NOT NULL,
  source TEXT, -- e.g. 'pirate_ship', 'shipstation', 'manual'
  workspace_id UUID REFERENCES workspaces(id),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Unique alias name per workspace (no two orgs can share the same alias)
CREATE UNIQUE INDEX idx_organization_aliases_name_ws
  ON organization_aliases (LOWER(alias_name), workspace_id);

-- Fast lookup by org
CREATE INDEX idx_organization_aliases_org_id
  ON organization_aliases (org_id);

-- RLS
ALTER TABLE organization_aliases ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Staff can manage aliases"
  ON organization_aliases
  FOR ALL
  USING (is_staff_user());

CREATE POLICY "Service role bypass"
  ON organization_aliases
  FOR ALL
  USING (auth.role() = 'service_role');
