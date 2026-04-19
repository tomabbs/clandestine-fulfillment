-- Phase 4.2 — Carrier code mapping with confidence + verification.
--
-- EasyPost returns carrier names like "USPS", "UPS", "FedExDefault". SS expects
-- account-specific codes like "stamps_com", "ups_walleted", "fedex_walleted".
-- These DON'T overlap by name — the mapping must be operator-verified per
-- carrier (and optionally per service) before we writeback.
--
-- Key design (Reviewer 4 + 5):
--   - Per-row mapping_confidence + last_verified_at + block_auto_writeback.
--   - block_auto_writeback default TRUE — opt in to auto-writeback by
--     setting it FALSE only after a real round-trip verification.
--   - easypost_service NULLABLE → family-level wildcard. Lookup tries
--     (carrier, service) first, falls back to (carrier, NULL) family wildcard.
--   - Family wildcards are themselves verified: ops maps "all USPS family
--     services → stamps_com" once with confidence='verified', block=false,
--     after a real test. Per-service rows can override the wildcard.
--
-- See plan Phase 4.2 for the full design rationale + carrier-family fallback rules.

CREATE TABLE IF NOT EXISTS shipstation_carrier_map (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),

  -- EP side. service NULL = family-level wildcard.
  easypost_carrier text NOT NULL,
  easypost_service text,

  -- SS side. service is optional (most callers only need carrier_code).
  shipstation_carrier_code text NOT NULL,
  shipstation_service_code text,

  -- Verification metadata (Reviewer 4 hard rule).
  mapping_confidence text NOT NULL DEFAULT 'untested'
    CHECK (mapping_confidence IN ('verified', 'inferred', 'manual', 'untested')),
  last_verified_at timestamptz,
  block_auto_writeback boolean NOT NULL DEFAULT true,

  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  -- Two rows for the same (workspace, EP carrier, EP service) would collide
  -- at lookup time. Use a partial-unique pattern for the family wildcard
  -- (NULL service) plus a separate unique on the specific service rows so
  -- ops can have one wildcard + N specific overrides per carrier.
  CONSTRAINT uq_ss_carrier_map_specific UNIQUE (workspace_id, easypost_carrier, easypost_service)
);

CREATE INDEX IF NOT EXISTS idx_ss_carrier_map_workspace
  ON shipstation_carrier_map (workspace_id);
CREATE INDEX IF NOT EXISTS idx_ss_carrier_map_carrier
  ON shipstation_carrier_map (workspace_id, easypost_carrier);

COMMENT ON TABLE shipstation_carrier_map IS
  'Phase 4.2 — EP carrier/service → SS carrier_code/service_code mapping. block_auto_writeback default true; flip to false only after a real round-trip verification per (carrier, service) or per (carrier, NULL) family wildcard.';
COMMENT ON COLUMN shipstation_carrier_map.easypost_service IS
  'Phase 4.2 — NULL = family-level wildcard. Lookup tries exact (carrier, service) match first, then falls back to (carrier, NULL).';
COMMENT ON COLUMN shipstation_carrier_map.mapping_confidence IS
  'Phase 4.2 — verified (real round-trip) | inferred (heuristic name match from listCarriers) | manual (admin UI) | untested (fresh row).';
COMMENT ON COLUMN shipstation_carrier_map.block_auto_writeback IS
  'Phase 4.2 — TRUE blocks shipstation-mark-shipped from auto-writing this carrier; staff must confirm per shipment. Default TRUE — opt-in to auto-writeback only after verification.';

-- ── RLS — staff-only (operators manage carrier mapping; clients never read) ─

ALTER TABLE shipstation_carrier_map ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS staff_all ON shipstation_carrier_map;
CREATE POLICY staff_all ON shipstation_carrier_map
  FOR ALL TO authenticated
  USING (is_staff_user())
  WITH CHECK (is_staff_user());
