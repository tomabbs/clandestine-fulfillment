// Task registry — all task names exported from one place (Rule #58)

// ── Existing tasks (alphabetical) ────────────────────────────────────────────

export { aftershipRegisterTask } from "./aftership-register";
export { bandcampInventoryPushTask } from "./bandcamp-inventory-push";
export {
  bandcampMarkShippedSchedule,
  bandcampMarkShippedTask,
} from "./bandcamp-mark-shipped";
export {
  bandcampOrderSyncSchedule,
  bandcampOrderSyncTask,
} from "./bandcamp-order-sync";
export { bandcampSalePollTask } from "./bandcamp-sale-poll";
export { bandcampScrapePageTask, bandcampSyncSchedule, bandcampSyncTask } from "./bandcamp-sync";
export { clientStoreOrderDetectTask } from "./client-store-order-detect";
export { inboundCheckinComplete } from "./inbound-checkin-complete";
export { inboundProductCreate } from "./inbound-product-create";
export { monthlyBillingTask } from "./monthly-billing";
export { multiStoreInventoryPushTask } from "./multi-store-inventory-push";
export { pirateShipImportTask } from "./pirate-ship-import";
export { preorderFulfillmentTask } from "./preorder-fulfillment";
export { preorderSetupTask } from "./preorder-setup";
export { processClientStoreWebhookTask } from "./process-client-store-webhook";
export { processShopifyWebhookTask } from "./process-shopify-webhook";
export { redisBackfillTask } from "./redis-backfill";
export { sensorCheckTask } from "./sensor-check";
export { shopifyFullBackfillTask } from "./shopify-full-backfill";
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
export { bundleAvailabilitySweepTask } from "./bundle-availability-sweep";
// ── Bundle component tracking (inventory hardening) ───────────────────────────
export { bundleComponentFanoutTask } from "./bundle-component-fanout";
// ── Catalog stats snapshot refresh (nightly + on-demand) ──────────────────────
export { catalogStatsRefreshSchedule, catalogStatsRefreshTask } from "./catalog-stats-refresh";
export {
  discogsClientOrderSyncSchedule,
  discogsClientOrderSyncTask,
} from "./discogs-client-order-sync";
// ── RESTORED: ShipStation poll (bridge period until Shopify app approval) ────
export { shipstationPollTask } from "./shipstation-poll";
// ── Tag cleanup (admin settings) ──────────────────────────────────────────────
export { tagCleanupBackfillTask } from "./tag-cleanup-backfill";
