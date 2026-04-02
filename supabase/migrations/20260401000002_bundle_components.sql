-- ============================================================
-- Bundle/kit component tracking
-- 2026-04-01
-- ============================================================

-- Feature flag — must be enabled per-workspace before bundle MIN logic activates.
-- Prevents bundle calculations from affecting unconfigured workspaces.
ALTER TABLE workspaces
  ADD COLUMN IF NOT EXISTS bundles_enabled boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS bundle_components (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  bundle_variant_id uuid NOT NULL REFERENCES warehouse_product_variants(id) ON DELETE CASCADE,
  component_variant_id uuid NOT NULL REFERENCES warehouse_product_variants(id) ON DELETE CASCADE,
  quantity integer NOT NULL DEFAULT 1 CHECK (quantity > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(bundle_variant_id, component_variant_id),
  -- Prevent direct self-reference (A as component of A)
  CHECK (bundle_variant_id != component_variant_id)
);

CREATE INDEX IF NOT EXISTS idx_bundle_components_bundle
  ON bundle_components(bundle_variant_id);
CREATE INDEX IF NOT EXISTS idx_bundle_components_component
  ON bundle_components(component_variant_id);
CREATE INDEX IF NOT EXISTS idx_bundle_components_workspace
  ON bundle_components(workspace_id);

ALTER TABLE bundle_components ENABLE ROW LEVEL SECURITY;

-- Idempotent: remote may already have this policy from a partial / manual apply.
DROP POLICY IF EXISTS bundle_components_workspace ON bundle_components;

CREATE POLICY bundle_components_workspace ON bundle_components
  USING (workspace_id = (
    SELECT workspace_id FROM users WHERE auth_user_id = auth.uid() LIMIT 1
  ));
