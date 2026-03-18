-- Migration: Add client billing overrides table and format_costs display columns
-- Client overrides allow per-org rate overrides for specific billing rules

CREATE TABLE warehouse_billing_rule_overrides (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  org_id uuid NOT NULL REFERENCES organizations(id),
  rule_id uuid NOT NULL REFERENCES warehouse_billing_rules(id),
  override_amount numeric NOT NULL,
  effective_from date DEFAULT CURRENT_DATE,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(workspace_id, org_id, rule_id)
);

CREATE INDEX idx_billing_overrides_org ON warehouse_billing_rule_overrides(org_id);

-- Add display columns to format_costs for old app layout compatibility
ALTER TABLE warehouse_format_costs
  ADD COLUMN IF NOT EXISTS format_key text,
  ADD COLUMN IF NOT EXISTS display_name text,
  ADD COLUMN IF NOT EXISTS cost_breakdown jsonb DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS sort_order integer DEFAULT 0;

-- Backfill format_key from format_name (lowercase, underscored)
UPDATE warehouse_format_costs
  SET format_key = LOWER(REPLACE(format_name, ' ', '_')),
      display_name = format_name,
      cost_breakdown = jsonb_build_object('pick_pack', pick_pack_cost, 'material', material_cost)
  WHERE format_key IS NULL;
