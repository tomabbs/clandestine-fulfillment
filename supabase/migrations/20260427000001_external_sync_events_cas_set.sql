-- Phase 1 §9.2 D5 — admit `cas_set` action on external_sync_events.
--
-- The Shopify CAS hot-path (setShopifyInventoryWithCompare + retry loop)
-- writes a single ledger row per logical adjustment with action = 'cas_set'
-- and accumulates per-attempt history in response_body.attempts[]. We
-- segment cas_set vs the existing 'set' verb so analytics on the ledger
-- can:
--   1. Measure CAS mismatch frequency (response_body.attempts[].outcome
--      = 'compare_mismatch') without filtering by metadata.
--   2. Compare cas_set p99 latency to the legacy 'modify'/'adjust' paths
--      to confirm CAS does NOT meaningfully tax write latency.
--   3. Track per-platform CAS exhaustion rate (status='error' AND
--      action='cas_set') as a release-gate signal.
--
-- Idempotent: drops the existing constraint by name (IF EXISTS) and
-- re-adds with the wider set. Reversible by removing 'cas_set' from the
-- list and re-running, but only safe once no in-flight cas_set rows
-- remain.
--
-- Plan reference:
--   docs/.cursor/plans/bandcamp_shopify_enterprise_sync_a448cf6a.plan.md,
--   §9.2 D5 — Hot-path inline CAS retry loop (3 attempts, 50/150/400ms,
--   :retryN idempotency suffix, cas_attempt-style activity rows,
--   cas_exhausted review item).

ALTER TABLE external_sync_events
  DROP CONSTRAINT IF EXISTS external_sync_events_action_check;

ALTER TABLE external_sync_events
  ADD CONSTRAINT external_sync_events_action_check
  CHECK (action IN (
    'increment',
    'decrement',
    'adjust',
    'modify',
    'set',
    'cas_set',
    'alias_add',
    'alias_remove',
    'sku_rename'
  ));

NOTIFY pgrst, 'reload schema';

COMMENT ON CONSTRAINT external_sync_events_action_check ON external_sync_events IS
  'Phase 1 §9.2 D5 — added `cas_set` for Shopify Compare-And-Set absolute writes via inventorySetQuantities. Per-attempt history lives in response_body.attempts[]; the ledger row is one per logical adjustment, regardless of retry count.';
