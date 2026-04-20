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
export { bandcampShippingVerifyTask } from "./bandcamp-shipping-verify";
// Phase 9.1 — bulk label buy orchestrator + nightly print_batch_jobs purge.
export { bulkBuyLabelsTask } from "./bulk-buy-labels";
export { printBatchJobsPurgeTask } from "./print-batch-jobs-purge";
// Phase 10.2 — EasyPost tracker registration (DUAL-MODE alongside aftership-register
// until the Phase 10.5 sunset gate. Both tasks fire on every label.)
export { easypostRegisterTrackerTask } from "./easypost-register-tracker";
// Phase 10.5 prep — daily parity check between AfterShip and EasyPost trackers.
// Diagnostic only; gates the eventual AfterShip sunset.
export { trackerParitySensorTask } from "./tracker-parity-sensor";
// Phase 12 — Unified customer-facing email pipeline (Resend). Single task
// driven by post-label-purchase (shipped) + EP webhook (OOD/Delivered/exception).
// Strategy-gated; safe to deploy pre-cutover.
export { sendTrackingEmailTask } from "./send-tracking-email";
// Phase 12 — Daily reconciliation: catches the 3.8% silent webhook failure
// rate documented for EP at peak load. Re-fires send-tracking-email for any
// shipment whose status warranted an email but no notification_sends row exists.
export { sendTrackingEmailReconCronTask } from "./send-tracking-email-recon";
export {
  bandcampOrderSyncSchedule,
  bandcampOrderSyncTask,
} from "./bandcamp-order-sync";
export { bandcampPushOnSkuTask } from "./bandcamp-push-on-sku";
export { bandcampSalePollTask } from "./bandcamp-sale-poll";
export { bandcampScrapePageTask, bandcampSyncSchedule, bandcampSyncTask } from "./bandcamp-sync";
// Phase 0.7 — Distro discriminator (creates warehouse_products with org_id=NULL
// for Clandestine Shopify products without a Bandcamp upstream)
export { clandestineShopifySyncTask } from "./clandestine-shopify-sync";
export { clientStoreOrderDetectTask } from "./client-store-order-detect";
export { inboundCheckinComplete } from "./inbound-checkin-complete";
export { inboundProductCreate } from "./inbound-product-create";
export { monthlyBillingTask } from "./monthly-billing";
export { multiStoreInventoryPushTask } from "./multi-store-inventory-push";
export { pirateShipImportTask } from "./pirate-ship-import";
export { preorderFulfillmentTask, preorderReleaseVariantTask } from "./preorder-fulfillment";
export { preorderSetupTask } from "./preorder-setup";
export { processClientStoreWebhookTask } from "./process-client-store-webhook";
// Phase 2 — SHIP_NOTIFY processor (decrements via recordInventoryChange)
export { processShipstationShipmentTask } from "./process-shipstation-shipment";
export { processShopifyWebhookTask } from "./process-shopify-webhook";
export { redisBackfillTask } from "./redis-backfill";
export { sensorCheckTask } from "./sensor-check";
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
export { shopifySyncTask } from "./shopify-sync";
export { storageCalcTask } from "./storage-calc";
export { supportEscalationTask } from "./support-escalation";

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
// ── SKU rectify infrastructure (Phase 0.5) ────────────────────────────────────
export { skuRectifyViaAliasTask } from "./sku-rectify-via-alias";
export { skuSyncAuditTask } from "./sku-sync-audit";
// ── Tag cleanup (admin settings) ──────────────────────────────────────────────
export { tagCleanupBackfillTask } from "./tag-cleanup-backfill";
// Tier 1 hardening #8 — weekly Supabase backup verification probe
export { weeklyBackupVerifySchedule, weeklyBackupVerifyTask } from "./weekly-backup-verify";
