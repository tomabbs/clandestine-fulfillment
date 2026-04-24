-- Phase 3 Pass 2 — supplementary schema for connection_echo_overrides + shadow log retention scaffolding.
--
-- Plan reference: bandcamp_shopify_enterprise_sync_a448cf6a.plan.md, §9.4 Pass 2
--   D4 (`runConnectionCutover`) needs to record the diagnostics snapshot
--      that justified the cutover flip on the override row, so historical
--      forensics can replay "why did we flip this connection at this time?"
--   D6 release gates C.2.3 / C.2.6 / C.2.7 — strengthen the constraints
--      Pass 1 left soft (retention, dormancy combo, shadow_window bounds).
--
-- Strictly ADDITIVE — no row updates, no column drops. Default `metadata`
-- is `'{}'` so existing rows (currently zero in production) tolerate the
-- column add without backfill.

-- ─── Section A — connection_echo_overrides.metadata ────────────────────────
-- D4 records the operator id, diagnostics snapshot, and (when force=true)
-- the operator's force_reason here. The reason TEXT column is kept for
-- short human-readable summaries; metadata holds the structured snapshot.

ALTER TABLE connection_echo_overrides
  ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}';

COMMENT ON COLUMN connection_echo_overrides.metadata IS
  'Phase 3 Pass 2 D4: structured diagnostics snapshot at runConnectionCutover() time (counters, gate, window) + operator id + force_reason when applicable. Audit trail for why each connection was flipped to direct.';

-- ─── Section B — connection_shadow_log retention scaffolding ───────────────
-- Pass 1 declared 90-day retention in the table comment but did not
-- materialize the sweep. The actual deletion lives in a Trigger task
-- (Pass 2 follow-up), but the index that makes the sweep cheap belongs in
-- the schema. Indexed by created_at so a `DELETE WHERE created_at < now() -
-- interval '90 days'` is index-only.

CREATE INDEX IF NOT EXISTS idx_connection_shadow_log_retention
  ON connection_shadow_log (created_at)
  WHERE match IS NOT NULL OR observed_at IS NOT NULL;

-- ─── Section C — PostgREST schema reload ───────────────────────────────────
NOTIFY pgrst, 'reload schema';
