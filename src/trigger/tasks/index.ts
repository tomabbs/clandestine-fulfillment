// Task registry — all task names exported from one place (Rule #58)

export { bandcampScrapePageTask, bandcampSyncSchedule, bandcampSyncTask } from "./bandcamp-sync";
export { inboundCheckinComplete } from "./inbound-checkin-complete";
export { inboundProductCreate } from "./inbound-product-create";
export { pirateShipImportTask } from "./pirate-ship-import";
export { shipmentIngestTask } from "./shipment-ingest";
export { shipstationPollTask } from "./shipstation-poll";
export { shopifyFullBackfillTask } from "./shopify-full-backfill";
export { shopifySyncTask } from "./shopify-sync";
export { supportEscalationTask } from "./support-escalation";
