# Trigger Task Catalog

Canonical Trigger.dev task map for planning/build/audit.

## Runtime Baseline

- Config: `trigger.config.ts`
- Task root: `src/trigger/tasks`
- Registry: `src/trigger/tasks/index.ts`

## Queues and Concurrency

| Queue | File | Concurrency |
|---|---|---|
| `bandcamp-api` | `src/trigger/lib/bandcamp-queue.ts` | `1` |
| `bandcamp-sweep` | `src/trigger/lib/bandcamp-sweep-queue.ts` | `1` |
| `bandcamp-scrape` | `src/trigger/lib/bandcamp-scrape-queue.ts` | `5` |
| `shipstation` | `src/trigger/lib/shipstation-queue.ts` | `1` |

`bandcamp-scrape-page` (`bandcamp-sync.ts`): HTML fetch capped at **15s** in client; task `maxDuration` **60s** (parse, DB, optional Shopify description push).

> ShipStation integration restored in bridge period (2026-03-30) for transition until Shopify app approval. Shipment poll runs every 30 min, deduplicates via `shipstation_shipment_id`.

## Scheduled Tasks (Cron)

| Task ID | File | Schedule |
|---|---|---|
| `support-escalation` | `src/trigger/tasks/support-escalation.ts` | `*/5 * * * *` |
| `shopify-sync` | `src/trigger/tasks/shopify-sync.ts` | `*/15 * * * *` |
| `shopify-order-sync` | `src/trigger/tasks/shopify-order-sync.ts` | `*/30 * * * *` |
| `bandcamp-sale-poll` | `src/trigger/tasks/bandcamp-sale-poll.ts` | `*/5 * * * *` |
| `bandcamp-inventory-push` | `src/trigger/tasks/bandcamp-inventory-push.ts` | `*/5 * * * *` |
| `bandcamp-scrape-sweep` | `src/trigger/tasks/bandcamp-scrape-sweep.ts` | `*/10 * * * *` |
| `bandcamp-sync-cron` | `src/trigger/tasks/bandcamp-sync.ts` | `*/30 * * * *` |
| `bandcamp-order-sync-cron` | `src/trigger/tasks/bandcamp-order-sync.ts` | `0 */6 * * *` |
| `bandcamp-mark-shipped-cron` | `src/trigger/tasks/bandcamp-mark-shipped.ts` | `*/15 * * * *` |
| `client-store-order-detect` | `src/trigger/tasks/client-store-order-detect.ts` | `*/10 * * * *` |
| `multi-store-inventory-push` | `src/trigger/tasks/multi-store-inventory-push.ts` | `*/5 * * * *` |
| `sensor-check` | `src/trigger/tasks/sensor-check.ts` | `*/5 * * * *` |
| `preorder-fulfillment` | `src/trigger/tasks/preorder-fulfillment.ts` | `0 6 * * *` (America/New_York) |
| `monthly-billing` | `src/trigger/tasks/monthly-billing.ts` | `0 2 1 * *` (America/New_York) |
| `storage-calc` | `src/trigger/tasks/storage-calc.ts` | `0 1 1 * *` (America/New_York) |
| `redis-backfill` | `src/trigger/tasks/redis-backfill.ts` | `0 3 * * 2` (America/New_York) |
| `daily-scan-form` | `src/trigger/tasks/generate-daily-scan-form.ts` | `0 17 * * 1-6` (America/New_York) |
| `oauth-state-cleanup` | `src/trigger/tasks/oauth-state-cleanup.ts` | `0 3 * * *` |
| `discogs-listing-replenish` | `src/trigger/tasks/discogs-listing-replenish.ts` | `0 * * * *` (hourly) |
| `discogs-mailorder-sync` | `src/trigger/tasks/discogs-mailorder-sync.ts` | `*/10 * * * *` |
| `discogs-client-order-sync` | `src/trigger/tasks/discogs-client-order-sync.ts` | `*/10 * * * *` |
| `discogs-message-poll` | `src/trigger/tasks/discogs-message-poll.ts` | `*/5 * * * *` |
| `shipstation-poll` | `src/trigger/tasks/shipstation-poll.ts` | `*/30 * * * *` — **hardened 2026-04-02**: upsert ON CONFLICT `(workspace_id, shipstation_shipment_id)`, pre-fetches `/orders` for `shippingAmount` → `customer_shipping_charged`, two-phase order auto-link (exact normalized order number → auto-assign; probabilistic → review queue only), ghost item pruning, `label_source='shipstation'` |
| `bundle-availability-sweep` | `src/trigger/tasks/bundle-availability-sweep.ts` | `0 6 * * *` (daily 6am UTC) |
| `catalog-stats-refresh` | `src/trigger/tasks/catalog-stats-refresh.ts` | `0 4 * * *` (daily 4am UTC) |
| `bandcamp-sales-sync` | `src/trigger/tasks/bandcamp-sales-sync.ts` | `0 5 * * *` (daily 5am UTC) |
| `bandcamp-sales-backfill-cron` | `src/trigger/tasks/bandcamp-sales-backfill.ts` | `*/10 * * * *` — self-healing monitor: detects stale running connections (>2h), retries up to 3 failed chunks per run using sync sales_report API, reads bandcamp_sales_backfill_log for gap detection |

## Event/On-Demand Tasks

| Task ID | File | Typical Invoker(s) |
|---|---|---|
| `process-shopify-webhook` | `src/trigger/tasks/process-shopify-webhook.ts` | `/api/webhooks/shopify` |
| `process-client-store-webhook` | `src/trigger/tasks/process-client-store-webhook.ts` | `/api/webhooks/client-store` |
| `aftership-register` | `src/trigger/tasks/aftership-register.ts` | `create-shipping-label` |
| `shopify-full-backfill` | `src/trigger/tasks/shopify-full-backfill.ts` | `src/actions/shopify.ts` |
| `bandcamp-sync` | `src/trigger/tasks/bandcamp-sync.ts` | `src/actions/bandcamp.ts`, `bandcamp-sync-cron` |
| `bandcamp-scrape-page` | `src/trigger/tasks/bandcamp-sync.ts` | `bandcamp-sync` |
| `bandcamp-order-sync` | `src/trigger/tasks/bandcamp-order-sync.ts` | `bandcamp-order-sync-cron` |
| `bandcamp-mark-shipped` | `src/trigger/tasks/bandcamp-mark-shipped.ts` | `src/actions/bandcamp-shipping.ts`, `bandcamp-mark-shipped-cron` |
| `pirate-ship-import` | `src/trigger/tasks/pirate-ship-import.ts` | `src/actions/pirate-ship.ts` |
| `inbound-product-create` | `src/trigger/tasks/inbound-product-create.ts` | `src/actions/inbound.ts` |
| `inbound-checkin-complete` | `src/trigger/tasks/inbound-checkin-complete.ts` | `src/actions/inbound.ts` |
| `tag-cleanup-backfill` | `src/trigger/tasks/tag-cleanup-backfill.ts` | `src/actions/admin-settings.ts` |
| `preorder-setup` | `src/trigger/tasks/preorder-setup.ts` | `bandcamp-sync` / scraper paths |
| `debug-env` | `src/trigger/tasks/debug-env.ts` | manual diagnostics |
| `create-shipping-label` | `src/trigger/tasks/create-shipping-label.ts` | `src/actions/shipping.ts` (createOrderLabel) |
| `mark-platform-fulfilled` | `src/trigger/tasks/mark-platform-fulfilled.ts` | `create-shipping-label` |
| `mark-mailorder-fulfilled` | `src/trigger/tasks/mark-mailorder-fulfilled.ts` | `create-shipping-label` |
| `discogs-catalog-match` | `src/trigger/tasks/discogs-catalog-match.ts` | `src/actions/discogs-admin.ts` |
| `discogs-initial-listing` | `src/trigger/tasks/discogs-initial-listing.ts` | `src/actions/discogs-admin.ts` (confirmMapping) |
| `discogs-message-send` | `src/trigger/tasks/discogs-message-send.ts` | Support UI / staff |
| `catalog-stats-refresh-demand` | `src/trigger/tasks/catalog-stats-refresh.ts` | Staff admin UI (on-demand) |
| `bandcamp-sales-backfill` | `src/trigger/tasks/bandcamp-sales-backfill.ts` | Staff admin UI (on-demand); self-triggers in yearly chunks (DEPRECATED — use scripts/run-sales-backfill.mjs) |
| `bundle-component-fanout` | `src/trigger/tasks/bundle-component-fanout.ts` | `bandcamp-sale-poll` (when bundle variant sold) |
| `bandcamp-tag-backfill` | `src/trigger/tasks/bandcamp-tag-backfill.ts` | Staff admin UI (on-demand); scrapes album HTML for `<a class="tag">` genre tags |

## Domain Touchpoints

- **Inventory:** `process-shopify-webhook`, `process-client-store-webhook`, `multi-store-inventory-push`, `bandcamp-inventory-push`, `redis-backfill`
- **Orders/shipments:** `client-store-order-detect`, `bandcamp-order-sync`, `bandcamp-mark-shipped`, `create-shipping-label`, `mark-platform-fulfilled`, `mark-mailorder-fulfilled`, `daily-scan-form`
- **Mail-order (consignment):** `discogs-mailorder-sync`, `discogs-client-order-sync`, `mark-mailorder-fulfilled`
- **Discogs master catalog:** `discogs-catalog-match`, `discogs-initial-listing`, `discogs-listing-replenish`, `discogs-message-poll`, `discogs-message-send`
- **Catalog/release readiness:** `bandcamp-sync`, `bandcamp-scrape-page`, `preorder-setup`, `preorder-fulfillment`
- **Billing/storage:** `monthly-billing`, `storage-calc`
- **Scraper observability:** `sensor-check` now includes `bandcamp.merch_sync_log_stale`, `bandcamp.scraper_review_open`, `bandcamp.scrape_block_rate` sensors from `channel_sync_log` + `warehouse_review_queue`. Index: `idx_channel_sync_log_sensor` on `(workspace_id, sync_type, created_at DESC) WHERE status = 'completed'`. `bandcamp-scrape-page` logs per-scrape outcome (HTTP status, retryAfterSeconds) to `channel_sync_log` sync_type `scrape_page`.
- **Support/reliability:** `support-escalation`, `sensor-check`, `tag-cleanup-backfill`
  - `support-escalation` uses conversation status + read markers (`staff_last_read_at`, `client_last_read_at`) and cooldown timestamps (`last_staff_escalated_at`, `last_client_reminded_at`) to prevent reminder spam during active chat sessions
- **OAuth hygiene:** `oauth-state-cleanup`

## Design Notes

- **Bulk inventory bypass (Rule #59):** `shopify-sync` writes directly to Redis (bypasses `recordInventoryChange`) for performance during bulk pulls. Downstream fanout to client stores relies on the `multi-store-inventory-push` cron (≤5 min lag). This is intentional — not a bug.
- **Discogs client orders:** `client-store-order-detect` explicitly skips Discogs connections; `discogs-client-order-sync` handles them separately due to OAuth 1.0a auth + different SKU/fanout requirements.
- **Bandcamp sale → inventory chain:** `bandcamp-sale-poll` → `recordInventoryChange()` → Redis fanout → Postgres. Chain is fully instrumented. OQ3 verified 2026-03-28.

## Audit Requirement

For any issue in sync/webhooks/inventory/orders/support:

1. Identify the request boundary in `API_CATALOG.md`.
2. List all applicable task IDs from this catalog.
3. Confirm whether the issue is in route ingress, task orchestration, or downstream DB/update logic.
4. Do not finalize diagnosis without a Trigger touchpoint check section.
