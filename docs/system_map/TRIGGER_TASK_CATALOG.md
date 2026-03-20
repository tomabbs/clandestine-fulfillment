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
| `bandcamp-scrape` | `src/trigger/lib/bandcamp-scrape-queue.ts` | `3` |
| shipment-ingest inline queue | `src/trigger/tasks/shipment-ingest.ts` | `5` |

## Scheduled Tasks (Cron)

| Task ID | File | Schedule |
|---|---|---|
| `support-escalation` | `src/trigger/tasks/support-escalation.ts` | `*/5 * * * *` |
| `shopify-sync` | `src/trigger/tasks/shopify-sync.ts` | `*/15 * * * *` |
| `shopify-order-sync` | `src/trigger/tasks/shopify-order-sync.ts` | `*/30 * * * *` |
| `shipstation-poll` | `src/trigger/tasks/shipstation-poll.ts` | `*/30 * * * *` |
| `bandcamp-sale-poll` | `src/trigger/tasks/bandcamp-sale-poll.ts` | `*/5 * * * *` |
| `bandcamp-inventory-push` | `src/trigger/tasks/bandcamp-inventory-push.ts` | `*/15 * * * *` |
| `bandcamp-sync-cron` | `src/trigger/tasks/bandcamp-sync.ts` | `*/30 * * * *` |
| `client-store-order-detect` | `src/trigger/tasks/client-store-order-detect.ts` | `*/10 * * * *` |
| `multi-store-inventory-push` | `src/trigger/tasks/multi-store-inventory-push.ts` | `*/5 * * * *` |
| `sensor-check` | `src/trigger/tasks/sensor-check.ts` | `*/5 * * * *` |
| `preorder-fulfillment` | `src/trigger/tasks/preorder-fulfillment.ts` | `0 6 * * *` (America/New_York) |
| `monthly-billing` | `src/trigger/tasks/monthly-billing.ts` | `0 2 1 * *` (America/New_York) |
| `storage-calc` | `src/trigger/tasks/storage-calc.ts` | `0 1 1 * *` (America/New_York) |
| `redis-backfill` | `src/trigger/tasks/redis-backfill.ts` | `0 3 * * 2` (America/New_York) |

## Event/On-Demand Tasks

| Task ID | File | Typical Invoker(s) |
|---|---|---|
| `process-shopify-webhook` | `src/trigger/tasks/process-shopify-webhook.ts` | `/api/webhooks/shopify` |
| `process-client-store-webhook` | `src/trigger/tasks/process-client-store-webhook.ts` | `/api/webhooks/client-store` |
| `shipment-ingest` | `src/trigger/tasks/shipment-ingest.ts` | `/api/webhooks/shipstation` |
| `aftership-register` | `src/trigger/tasks/aftership-register.ts` | `shipment-ingest` |
| `shopify-full-backfill` | `src/trigger/tasks/shopify-full-backfill.ts` | `src/actions/shopify.ts` |
| `bandcamp-sync` | `src/trigger/tasks/bandcamp-sync.ts` | `src/actions/bandcamp.ts`, `bandcamp-sync-cron` |
| `bandcamp-scrape-page` | `src/trigger/tasks/bandcamp-sync.ts` | `bandcamp-sync` |
| `pirate-ship-import` | `src/trigger/tasks/pirate-ship-import.ts` | `src/actions/pirate-ship.ts` |
| `inbound-product-create` | `src/trigger/tasks/inbound-product-create.ts` | `src/actions/inbound.ts` |
| `inbound-checkin-complete` | `src/trigger/tasks/inbound-checkin-complete.ts` | `src/actions/inbound.ts` |
| `tag-cleanup-backfill` | `src/trigger/tasks/tag-cleanup-backfill.ts` | `src/actions/admin-settings.ts` |
| `preorder-setup` | `src/trigger/tasks/preorder-setup.ts` | `bandcamp-sync` / scraper paths |
| `debug-env` | `src/trigger/tasks/debug-env.ts` | manual diagnostics |

## Domain Touchpoints

- Inventory: `process-shopify-webhook`, `process-client-store-webhook`, `multi-store-inventory-push`, `bandcamp-inventory-push`, `redis-backfill`
- Orders/shipments: `shipstation-poll`, `shipment-ingest`, `aftership-register`, `client-store-order-detect`
- Catalog/release readiness: `bandcamp-sync`, `bandcamp-scrape-page`, `preorder-setup`, `preorder-fulfillment`
- Billing/storage: `monthly-billing`, `storage-calc`
- Support/reliability: `support-escalation`, `sensor-check`, `tag-cleanup-backfill`
  - `support-escalation` uses conversation status + read markers (`staff_last_read_at`, `client_last_read_at`) and cooldown timestamps (`last_staff_escalated_at`, `last_client_reminded_at`) to prevent reminder spam during active chat sessions

## Audit Requirement

For any issue in sync/webhooks/inventory/orders/support:

1. Identify the request boundary in `API_CATALOG.md`.
2. List all applicable task IDs from this catalog.
3. Confirm whether the issue is in route ingress, task orchestration, or downstream DB/update logic.
4. Do not finalize diagnosis without a Trigger touchpoint check section.
