// Task registry — all task names exported from one place (Rule #58)

// ── Existing tasks (alphabetical) ────────────────────────────────────────────

export { aftershipRegisterTask } from "./aftership-register";
// Phase 1 — Bandcamp baseline anomaly + multi-origin push_mode audit
export { bandcampBaselineAuditTask } from "./bandcamp-baseline-audit";
export { bandcampInventoryPushTask } from "./bandcamp-inventory-push";
// Phase 6.5 — `bandcampMarkShippedSchedule` (the 15-min direct-push cron) was
// removed; the new `bandcamp-shipping-verify` cron (also exported below) does
// verify-then-fallback at 30-min intervals. The bandcampMarkShippedTask itself
// remains for the manual "Sync to Bandcamp" force-push button on the shipping log.
export { bandcampMarkShippedTask } from "./bandcamp-mark-shipped";
export {
  bandcampOrderSyncSchedule,
  bandcampOrderSyncTask,
} from "./bandcamp-order-sync";
export { bandcampPushOnSkuTask } from "./bandcamp-push-on-sku";
export { bandcampSalePollTask } from "./bandcamp-sale-poll";
// Phase 2 §9.3 D3 — event-driven per-connection sale poll. Fired by
// `routeInboundEmail()` when an order email's recipient address matches
// exactly one `bandcamp_connections.inbound_forwarding_address`. Pinned to
// `bandcampQueue` so it serializes against the cron `bandcamp-sale-poll`.
export { bandcampSalePollPerConnectionTask } from "./bandcamp-sale-poll-per-connection";
export { bandcampShippingVerifyTask } from "./bandcamp-shipping-verify";
export { bandcampScrapePageTask, bandcampSyncSchedule, bandcampSyncTask } from "./bandcamp-sync";
// Phase 9.1 — bulk label buy orchestrator + nightly print_batch_jobs purge.
export { bulkBuyLabelsTask } from "./bulk-buy-labels";
// Phase 1 §9.2 D2 — per-SKU Clandestine Shopify push. Replaces the inline
// `inventoryAdjustQuantities` block in inventory-fanout.ts. Pinned to its
// own queue (`clandestine-shopify-push`) — distinct from the per-client
// queue because the auth surfaces are unrelated (env-singleton token vs
// per-connection offline tokens) and a runaway Clandestine push must not
// starve client pushes (or vice versa).
export { clandestineShopifyPushOnSkuTask } from "./clandestine-shopify-push-on-sku";
// Phase 0.7 — Distro discriminator (creates warehouse_products with org_id=NULL
// for Clandestine Shopify products without a Bandcamp upstream)
export { clandestineShopifySyncTask } from "./clandestine-shopify-sync";
export { clientStoreOrderDetectTask } from "./client-store-order-detect";
// Phase 1 §9.2 D1 — per-(connection_id, sku) client-store push. Replaces
// the empty-payload `multi-store-inventory-push` enqueue from the
// focused-push side of inventory-fanout.ts. The 5-min cron stays alive as
// a drift safety net (X-2 audit). Pinned to a single shared
// `client-store-push` queue (concurrency 15) for Pass 1; Pass 2 splits
// into per-platform queues if isolation is observed to be the bottleneck.
export { clientStorePushOnSkuTask } from "./client-store-push-on-sku";
// Phase 10.2 — EasyPost tracker registration (DUAL-MODE alongside aftership-register
// until the Phase 10.5 sunset gate. Both tasks fire on every label.)
export { easypostRegisterTrackerTask } from "./easypost-register-tracker";
export { inboundCheckinComplete } from "./inbound-checkin-complete";
export { inboundProductCreate } from "./inbound-product-create";
// Phase 5 §9.6 D1.c — daily counter↔ledger reconciliation for the
// inventory commitments substrate (migration 20260424000004). Runs
// 04:15 UTC, surfaces drift as warehouse_review_queue items + a
// sensor_readings summary row. Independent of
// `workspaces.atp_committed_active` — recon ALWAYS runs because
// trigger correctness is independent of consumer-side math.
export { inventoryCommittedCounterReconTask } from "./inventory-committed-counter-recon";
export { monthlyBillingTask } from "./monthly-billing";
export { multiStoreInventoryPushTask } from "./multi-store-inventory-push";
// Slice 4 — every-15-min sensor for stuck pending sends, provider failures,
// and webhook signature spikes. Writes sensor_readings rows + escalates
// to Sentry/Slack when signature failure thresholds are exceeded.
export { notificationFailureSensorTask } from "./notification-failure-sensor";
export { pirateShipImportTask } from "./pirate-ship-import";
export { preorderFulfillmentTask, preorderReleaseVariantTask } from "./preorder-fulfillment";
export { preorderSetupTask } from "./preorder-setup";
export { printBatchJobsPurgeTask } from "./print-batch-jobs-purge";
export { processClientStoreWebhookTask } from "./process-client-store-webhook";
// Phase 2 — SHIP_NOTIFY processor (decrements via recordInventoryChange)
export { processShipstationShipmentTask } from "./process-shipstation-shipment";
export { processShopifyWebhookTask } from "./process-shopify-webhook";
export { redisBackfillTask } from "./redis-backfill";
// Phase 3.C (autonomous SKU matcher) — client alert dispatcher for
// non-warehouse order holds. Idempotent on (workspace_id, order_id,
// hold_cycle_id) via partial unique index. Flag-gated on
// non_warehouse_order_client_alerts_enabled; integrates with
// shouldSuppressBulkHold (SKU-AUTO-31) to collapse catalog-outage storms
// to one ops alert per window instead of spamming the client.
export { sendNonWarehouseOrderHoldAlertTask } from "./send-non-warehouse-order-hold-alert";
// Phase 12 — Unified customer-facing email pipeline (Resend). Single task
// driven by post-label-purchase (shipped) + EP webhook (OOD/Delivered/exception).
// Strategy-gated; safe to deploy pre-cutover.
export { sendTrackingEmailTask } from "./send-tracking-email";
// Phase 12 — Daily reconciliation: catches the 3.8% silent webhook failure
// rate documented for EP at peak load. Re-fires send-tracking-email for any
// shipment whose status warranted an email but no notification_sends row exists.
export { sendTrackingEmailReconCronTask } from "./send-tracking-email-recon";
export { sensorCheckTask } from "./sensor-check";
// Phase 3 Pass 2 — shadow-mode comparison task. Fired with a delay by
//   recordShadowPush() when a connection is in cutover_state='shadow'.
//   Reads ShipStation v2 inventory and persists match/drift back to the
//   originating connection_shadow_log row. Pinned to shipstationQueue
//   (concurrencyLimit: 1) so it shares the v2 60 req/min budget with seed,
//   reconcile, SHIP_NOTIFY, and the focused adjust task.
export { shadowModeComparisonTask } from "./shadow-mode-comparison";
// Phase 5 — tiered ShipStation v2 ↔ DB reconcile sensor.
//          Three schedules (hot 5m / warm 30m / cold 6h) call the same
//          inner runner. Drift thresholds: |drift|<=1 silent fix, 2-5
//          low-severity review, >5 high-severity review. ALWAYS adjusts
//          our DB to match v2 via recordInventoryChange(source:'reconcile').
export {
  shipstationBandcampReconcileColdSchedule,
  shipstationBandcampReconcileHotSchedule,
  shipstationBandcampReconcileTask,
  shipstationBandcampReconcileWarmSchedule,
} from "./shipstation-bandcamp-reconcile";
// Phase 3 — ShipStation v2 inventory seed (one-shot per workspace)
export { shipstationSeedInventoryTask } from "./shipstation-seed-inventory";
// Phase 3 — ShipStation v1 manual store refresh (stub honoring Open Q #2)
export { shipstationStoreRefreshTask } from "./shipstation-store-refresh";
// Saturday Workstream 2 (2026-04-18) — manual-count → ShipStation v2 sync
//   bridge. Sibling of shipstation-v2-decrement; handles BOTH directions of
//   delta (manual writes can go up or down). Pinned to shipstationQueue,
//   ledger-gated via external_sync_events, fanout-guard aware.
export { shipstationV2AdjustOnSkuTask } from "./shipstation-v2-adjust-on-sku";
// Phase 4 — bidirectional bridge: sale-poll → ShipStation v2 decrement
//                                  SHIP_NOTIFY → Bandcamp focused push
//          Both are ledger-gated via `external_sync_events` and respect
//          fanout-guard kill switches + per-workspace rollout bucket.
export { shipstationV2DecrementTask } from "./shipstation-v2-decrement";
export { shopifyFullBackfillTask } from "./shopify-full-backfill";
export { shopifyImageBackfillTask } from "./shopify-image-backfill";
export { shopifyOrderSyncTask } from "./shopify-order-sync";
// Phase 0 §9.1 D2 — daily AUTHORITATIVE audit of Shopify variant
// inventoryPolicy. Persists last_inventory_policy + last_policy_check_at on
// client_store_sku_mappings; surfaces drift as `policy_drift` Channels health
// state + critical review queue item (group_key dedup per connection).
export { shopifyPolicyAuditTask } from "./shopify-policy-audit";
// Phase 0 §9.1 D3 — staff-triggered remediation companion. Flips drifted
// SKUs (CONTINUE + !preorder_whitelist) back to DENY via
// productVariantsBulkUpdate. Enqueued by `auditShopifyPolicy({fixMode:'fix_drift'})`.
export { shopifyPolicyFixTask } from "./shopify-policy-fix";
export { shopifySyncTask } from "./shopify-sync";
export { skuMatchingMonitorTask } from "./sku-matching-monitor";
export { storageCalcTask } from "./storage-calc";
export { supportEscalationTask } from "./support-escalation";
export {
  supportDeliveryRecoveryTask,
  supportMessageDeliveryTask,
} from "./support-message-delivery";
// Phase 10.5 prep — daily parity check between AfterShip and EasyPost trackers.
// Diagnostic only; gates the eventual AfterShip sunset.
export { trackerParitySensorTask } from "./tracker-parity-sensor";
// Phase 7.1 — hourly health metrics for the unified-shipping pipeline.
export { unifiedShippingSensorsTask } from "./unified-shipping-sensors";

// ── NEW: EasyPost / Label tasks (Phase 5A) ────────────────────────────────────

export { createShippingLabelTask } from "./create-shipping-label";
export { dailyScanFormSchedule, generateDailyScanFormTask } from "./generate-daily-scan-form";
export { markMailorderFulfilledTask } from "./mark-mailorder-fulfilled";
export { markPlatformFulfilledTask } from "./mark-platform-fulfilled";

// ── NEW: OAuth cleanup (Phase 4) ──────────────────────────────────────────────

export { oauthStateCleanupSchedule, oauthStateCleanupTask } from "./oauth-state-cleanup";

// ── NEW: Mail-order (Phase 7) ─────────────────────────────────────────────────

export { mailorderShopifySyncTask } from "./mailorder-shopify-sync";

// ── NEW: Discogs master catalog (Phase 9) ─────────────────────────────────────

export { discogsCatalogMatchTask } from "./discogs-catalog-match";
export { discogsInitialListingTask } from "./discogs-initial-listing";
export {
  discogsListingReplenishSchedule,
  discogsListingReplenishTask,
} from "./discogs-listing-replenish";
export {
  discogsMailorderSyncSchedule,
  discogsMailorderSyncTask,
} from "./discogs-mailorder-sync";
export {
  discogsMessagePollSchedule,
  discogsMessagePollTask,
} from "./discogs-message-poll";
export { discogsMessageSendTask } from "./discogs-message-send";

// ── NEW: Discogs client connections (Phase 10) ────────────────────────────────

// ── Bandcamp sales (backfill + daily sync) ────────────────────────────────────
export { bandcampSalesBackfillCron, bandcampSalesBackfillTask } from "./bandcamp-sales-backfill";
export { bandcampSalesSyncSchedule } from "./bandcamp-sales-sync";
// ── Bandcamp scrape sweep (independent queue, avoids bandcamp-api congestion) ──
export { bandcampScrapeSweepTask } from "./bandcamp-scrape-sweep";
// ── Bandcamp genre tag backfill (on-demand) ──────────────────────────────────
export { bandcampTagBackfillTask } from "./bandcamp-tag-backfill";
// Saturday Workstream 3 (2026-04-18) — bulk warehouse location creator.
//   Pinned to shipstationQueue (concurrencyLimit: 1). Routes from
//   createLocationRange() Server Action when range size > 30 (Vercel Server
//   Action timeout fallback per plan §15.3 / Appendix C.17).
export { bulkCreateLocationsTask } from "./bulk-create-locations";
// Phase 3 (finish-line plan v4) — Trigger task variant of
//   submitManualInventoryCounts for very large bulk Avail edits.
//   Same per-row contract; offload path for Rule #41 compliance.
export { bulkUpdateAvailableTask } from "./bulk-update-available";
export { bundleAvailabilitySweepTask } from "./bundle-availability-sweep";
// ── Bundle component tracking (inventory hardening) ───────────────────────────
export { bundleComponentFanoutTask } from "./bundle-component-fanout";
// Phase 2.5(c) — Bundle derived-drift sensor (compares v2 vs computed)
export {
  bundleDerivedDriftSensorSchedule,
  bundleDerivedDriftSensorTask,
} from "./bundle-derived-drift";
// ── Catalog stats snapshot refresh (nightly + on-demand) ──────────────────────
export { catalogStatsRefreshSchedule, catalogStatsRefreshTask } from "./catalog-stats-refresh";
// Tier 1 hardening #11 — daily reconciliation summary (email + log)
export { dailyReconSummarySchedule, dailyReconSummaryTask } from "./daily-recon-summary";
// Phase 6 closeout — daily reminder cron parsing docs/DEFERRED_FOLLOWUPS.md
// and upserting a warehouse_review_queue item per workspace for every entry
// whose due_date <= today. Idempotent via group_key UNIQUE.
export { deferredFollowupsReminderTask } from "./deferred-followups-reminder";
export {
  discogsClientOrderSyncSchedule,
  discogsClientOrderSyncTask,
} from "./discogs-client-order-sync";
// Tier 1 hardening #14 — external_sync_events retention sweep (Patch D3)
export {
  externalSyncEventsRetentionSchedule,
  externalSyncEventsRetentionTask,
} from "./external-sync-events-retention";
// Phase 6 closeout — automated cross-system inventory verification (hourly during
// ramp, daily after Tuesday). Persists artifacts to megaplan_spot_check_runs
// and creates a review queue item only when drift_major persists across two
// consecutive runs (review pass v4 §5.3).
export { megaplanSpotCheckTask } from "./megaplan-spot-check";
// Phase 6 (finish-line plan v4) — ramp-halt-criteria-sensor.
//   Cron every 2 minutes during ramp (tightened to */15 post-ramp per
//   Phase 8e). Reads sensor_readings within last 1h, evaluates §31 halt
//   criteria via the pure evaluator in src/trigger/lib/ramp-halt-evaluator.ts,
//   and on halt calls setFanoutRolloutPercentInternal(0) with actor=sensor.
//   Persists §5.3 two-consecutive-runs state on workspaces.ramp_sensor_state.
export { rampHaltCriteriaSensorTask } from "./ramp-halt-criteria-sensor";
// ── Bandcamp scraper reconciliation (every 6h, dead URL probes, auto-resolve) ──
export { scraperReconcileSchedule } from "./scraper-reconcile";
// ── RESTORED: ShipStation poll (bridge period until Shopify app approval) ────
export { shipstationPollTask } from "./shipstation-poll";
// Phase 5.C (autonomous SKU matcher) — hold recovery recheck.
//   */30 cadence. Scans warehouse_orders held with reason
//   `fetch_incomplete_at_match` in the last 24h. For each order:
//   (1) re-fetches the platform catalog; (2) re-runs the hold
//   evaluator; (3) releases with resolution_code
//   `fetch_recovered_evaluator_passed` when both signals clear.
//   Emergency-pause aware per workspace. NOT pinned to bandcamp-api.
export {
  skuHoldRecoveryRecheckManualTask,
  skuHoldRecoveryRecheckScheduledTask,
} from "./sku-hold-recovery-recheck";
// Phase 5.D (autonomous SKU matcher) — holdout stop-condition sweep.
//   Daily sweep that retires `auto_holdout_for_evidence` identity
//   matches meeting either stop condition (evaluation_count >= 10
//   OR age_days >= 90) to the terminal `auto_reject_non_match`
//   state via applyOutcomeTransition() with
//   trigger='periodic_revaluation'. Emergency-pause aware. NOT
//   pinned to bandcamp-api.
export {
  skuHoldoutStopConditionSweepManualTask,
  skuHoldoutStopConditionSweepScheduledTask,
} from "./sku-holdout-stop-condition-sweep";
// ── SKU rectify infrastructure (Phase 0.5) ────────────────────────────────────
export { skuRectifyViaAliasTask } from "./sku-rectify-via-alias";
// Phase 5.B (autonomous SKU matcher) — shadow-to-live promotion scheduler.
//   Daily at 02:30 UTC. Scans idx_identity_matches_promotion_candidates
//   per workspace, evaluates Promotion Paths A + B via the pure
//   `shouldPromoteShadow()` policy, and delegates actual promotion to
//   the `promoteIdentityMatchToAlias()` wrapper (which enforces
//   emergency-pause, autonomy-flag, and stock-stability gates). Path C
//   is human-driven; this task never simulates it. Writes one run row
//   per workspace and one decision row per candidate evaluated.
export {
  skuShadowPromotionManualTask,
  skuShadowPromotionScheduledTask,
} from "./sku-shadow-promotion";
export { skuSyncAuditTask } from "./sku-sync-audit";
// Phase 5.A (autonomous SKU matcher) — stock-stability sampler.
//   */15 cadence, warehouse-only readings for every variant referenced by
//   client_store_product_identity_matches (non-terminal) OR
//   client_store_sku_mappings. Observed_at is floored to the 15-minute
//   boundary so ON CONFLICT DO NOTHING silently dedupes Trigger.dev
//   double-deliveries. Emergency-pause aware per-workspace. Nightly purge
//   sibling task at 03:15 UTC enforces the 30-day retention contract.
export {
  stockStabilityReadingsPurgeManualTask,
  stockStabilityReadingsPurgeScheduledTask,
  stockStabilitySamplerManualTask,
  stockStabilitySamplerScheduledTask,
} from "./stock-stability-sampler";
// ── Tag cleanup (admin settings) ──────────────────────────────────────────────
export { tagCleanupBackfillTask } from "./tag-cleanup-backfill";
// HRD-17.1 — recovery sweeper for webhook_events rows that never made it past
// tasks.trigger() in the client-store route handler. Belt-and-braces: the
// route handler now updates status to 'enqueued' / 'enqueue_failed', and this
// sweeper picks up anything left in 'received' or 'enqueue_failed' >2 min old.
// Idempotency-key-protected (HRD-29 global scope) so it can't double-fire.
export {
  webhookEventsRecoverySweepSchedule,
  webhookEventsRecoverySweepTask,
} from "./webhook-events-recovery-sweep";
// Tier 1 hardening #8 — weekly Supabase backup verification probe
export { weeklyBackupVerifySchedule, weeklyBackupVerifyTask } from "./weekly-backup-verify";
