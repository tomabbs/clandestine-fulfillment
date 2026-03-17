// Task registry — all task names exported from one place (Rule #58)

export { aftershipRegisterTask } from "./aftership-register";
export { bandcampInventoryPushTask } from "./bandcamp-inventory-push";
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
export { redisBackfillTask } from "./redis-backfill";
export { sensorCheckTask } from "./sensor-check";
export { shipmentIngestTask } from "./shipment-ingest";
export { shipstationPollTask } from "./shipstation-poll";
export { shopifyFullBackfillTask } from "./shopify-full-backfill";
export { shopifyOrderSyncTask } from "./shopify-order-sync";
export { shopifySyncTask } from "./shopify-sync";
export { storageCalcTask } from "./storage-calc";
export { supportEscalationTask } from "./support-escalation";
