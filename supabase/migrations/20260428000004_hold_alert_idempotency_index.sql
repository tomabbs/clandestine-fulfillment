-- Autonomous SKU matcher — Phase 3.C DB-level idempotency belt for
-- `send-non-warehouse-order-hold-alert` (SKU-AUTO-16).
--
-- Plan: autonomous_sku_matching_da557209.plan.md §"Alert idempotency"
--       (Required uniqueness key:
--        `alert_type='non_warehouse_order_hold'`,
--        `workspace_id`, `order_id`, `hold_cycle_id`).
--
-- The `send-non-warehouse-order-hold-alert` Trigger task writes a
-- `hold_alert_sent` row into `order_fulfillment_hold_events` on every
-- successful send. That row is the authoritative "did we email the
-- client about this hold cycle?" record — the three-layer dedup
-- contract in the task is:
--
--   1. Application pre-check: `find_prior_hold_alert_sent()` before
--      sending.
--   2. **DB partial unique index (this migration)**: races where two
--      task runs both passed the pre-check collide on INSERT; the
--      loser handles the 23505 as a successful-idempotent outcome.
--   3. Resend `Idempotency-Key` header on the outbound send:
--      `non-warehouse-order-hold/{workspace}/{order}/{cycle}`.
--
-- Scoping notes:
--   * The uniqueness key is `(workspace_id, order_id, hold_cycle_id)`.
--     `event_type` is intentionally NOT part of the key — we only
--     trap `hold_alert_sent`, so the partial predicate narrows the
--     index. `hold_alert_resent` (staff "re-send alert" action) is a
--     distinct event type and does not collide.
--   * `hold_cycle_id` is `NOT NULL` on the table, so the partial
--     index covers every hold_alert_sent row.
--   * Idempotent (`CREATE UNIQUE INDEX IF NOT EXISTS`) and safe to
--     re-apply alongside the existing `order_fulfillment_hold_events`
--     table. Adding the index to an already-populated table is safe
--     because Phase 3 has not yet shipped any `hold_alert_sent`
--     rows — the enqueue path does not exist until Phase 3.C lands.
--
-- Release gate: SKU-AUTO-16. The test harness reruns the alert task
-- twice per cycle and asserts exactly one `hold_alert_sent` row
-- (plus exactly one outbound email); this index is the reason that
-- assertion holds across retry storms and concurrent dispatch.

BEGIN;

CREATE UNIQUE INDEX IF NOT EXISTS uq_hold_alert_sent_per_cycle
  ON order_fulfillment_hold_events (workspace_id, order_id, hold_cycle_id)
  WHERE event_type = 'hold_alert_sent';

COMMENT ON INDEX uq_hold_alert_sent_per_cycle IS
  'Phase 3.C SKU-AUTO-16. At most one hold_alert_sent row per (workspace_id, order_id, hold_cycle_id). Defense-in-depth against race windows in send-non-warehouse-order-hold-alert; the pre-check + Resend Idempotency-Key form the other two dedup layers. Partial predicate scopes the constraint so hold_alert_resent / hold_applied / hold_released / hold_cancelled are unaffected.';

COMMIT;
