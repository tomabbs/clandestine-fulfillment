# Clandestine Fulfillment - Full Technical Handoff Master Document

Date: 2026-03-18  
Repo: `clandestine-fulfillment`  
Audience: Engineering, Operations, Product, QA  
Purpose: Exhaustive handoff snapshot of the implemented system for side-by-side comparison against the old warehouse manager app and planning docs.

---

## 1) Scope and Method

This document consolidates:
- full route/page inventory
- UI field inventory (forms/inputs/selects discovered in app code)
- full API surface (HTTP handlers, Server Actions, Trigger tasks, external clients)
- full data model inventory (tables, columns, constraints, RLS helpers, RPCs/triggers)
- old warehouse manager -> new app mapping (from planning docs vs implementation)
- drift/gap analysis and handoff checklist

Validation inputs:
- codebase inspection under `src/`, `supabase/migrations/`, `tests/`, `scripts/`
- planning docs:
  - `CLANDESTINE_FULFILLMENT_PART1_FINAL.md`
  - `CLANDESTINE_FULFILLMENT_PART2_FINAL.md`
  - `CLANDESTINE_FULFILLMENT_BUILD_GUIDE.md`
  - `CLANDESTINE_FULFILLMENT_SETUP_GUIDE.md`
- executed quality/test gates already captured in:
  - `TECHNICAL_HANDOFF_REPORT_2026-03-18.md`

---

## 2) High-Level Architecture Map

## Runtime stack
- Next.js App Router + React + TypeScript
- Supabase (Postgres, Auth, RLS)
- Trigger.dev v4 (async jobs + cron)
- Upstash Redis (inventory projection)
- Server Actions as primary app API
- Route Handlers only for health/auth callback/webhooks

## Layer map
- UI routes/pages: `src/app/`
- Domain mutations/queries: `src/actions/`
- External platform clients: `src/lib/clients/`
- Server-only logic: `src/lib/server/`
- Shared types/constants/env: `src/lib/shared/`
- Background orchestration: `src/trigger/tasks/`
- DB truth layer: `supabase/migrations/`

---

## 3) Complete Route and Page Inventory

## Root and auth
- `/` -> `src/app/page.tsx`
- `/login` -> `src/app/(auth)/login/page.tsx`
- `/auth/callback` -> `src/app/(auth)/auth/callback/route.ts`

## Admin routes (`/admin/*`)
- `/admin` -> `src/app/admin/page.tsx`
- `/admin/billing` -> `src/app/admin/billing/page.tsx`
- `/admin/catalog` -> `src/app/admin/catalog/page.tsx`
- `/admin/catalog/[id]` -> `src/app/admin/catalog/[id]/page.tsx`
- `/admin/channels` -> `src/app/admin/channels/page.tsx`
- `/admin/clients` -> `src/app/admin/clients/page.tsx`
- `/admin/clients/[id]` -> `src/app/admin/clients/[id]/page.tsx`
- `/admin/inbound` -> `src/app/admin/inbound/page.tsx`
- `/admin/inbound/[id]` -> `src/app/admin/inbound/[id]/page.tsx`
- `/admin/inventory` -> `src/app/admin/inventory/page.tsx`
- `/admin/orders` -> `src/app/admin/orders/page.tsx`
- `/admin/review-queue` -> `src/app/admin/review-queue/page.tsx`
- `/admin/scan` -> `src/app/admin/scan/page.tsx`
- `/admin/settings` -> `src/app/admin/settings/page.tsx`
- `/admin/settings/bandcamp` -> `src/app/admin/settings/bandcamp/page.tsx`
- `/admin/settings/health` -> `src/app/admin/settings/health/page.tsx`
- `/admin/settings/integrations` -> `src/app/admin/settings/integrations/page.tsx`
- `/admin/settings/store-connections` -> `src/app/admin/settings/store-connections/page.tsx`
- `/admin/settings/store-mapping` -> `src/app/admin/settings/store-mapping/page.tsx`
- `/admin/shipping` -> `src/app/admin/shipping/page.tsx`
- `/admin/shipping/pirate-ship` -> `src/app/admin/shipping/pirate-ship/page.tsx`
- `/admin/support` -> `src/app/admin/support/page.tsx`

## Portal routes (`/portal/*`)
- `/portal` -> `src/app/portal/page.tsx`
- `/portal/billing` -> `src/app/portal/billing/page.tsx`
- `/portal/inbound` -> `src/app/portal/inbound/page.tsx`
- `/portal/inbound/new` -> `src/app/portal/inbound/new/page.tsx`
- `/portal/inventory` -> `src/app/portal/inventory/page.tsx`
- `/portal/orders` -> `src/app/portal/orders/page.tsx`
- `/portal/releases` -> `src/app/portal/releases/page.tsx`
- `/portal/sales` -> `src/app/portal/sales/page.tsx`
- `/portal/settings` -> `src/app/portal/settings/page.tsx`
- `/portal/shipping` -> `src/app/portal/shipping/page.tsx`
- `/portal/support` -> `src/app/portal/support/page.tsx`

## API routes (`/api/*`)
- `GET /api/health` -> `src/app/api/health/route.ts`
- `POST /api/webhooks/aftership` -> `src/app/api/webhooks/aftership/route.ts`
- `POST /api/webhooks/client-store` -> `src/app/api/webhooks/client-store/route.ts`
- `POST /api/webhooks/resend-inbound` -> `src/app/api/webhooks/resend-inbound/route.ts`
- `POST /api/webhooks/shipstation` -> `src/app/api/webhooks/shipstation/route.ts`
- `POST /api/webhooks/shopify` -> `src/app/api/webhooks/shopify/route.ts`
- `POST /api/webhooks/stripe` -> `src/app/api/webhooks/stripe/route.ts`

---

## 4) Page-by-Page Wiring (Server Actions + Major Data)

## Admin
- `/admin`: `getDashboardStats`, `getPreorderProducts`, `manualRelease`; shows sync health, work counters, releases, activity.
- `/admin/billing`: `getAuthWorkspaceId`, `getBillingSnapshots`, `getBillingSnapshotDetail`, `getBillingRules`, `createBillingRule`, `updateBillingRule`, `createFormatCost`, `updateFormatCost`, `createBillingAdjustment`; shows billing snapshots/rules/format costs/adjustments and snapshot details.
- `/admin/catalog`: `getProducts`; shows product list with filters.
- `/admin/catalog/[id]`: `getProductDetail`, `updateProduct`, `updateVariants`; edits product + variant attributes and displays mappings.
- `/admin/channels`: `getShopifySyncStatus`, `triggerShopifySync`, `triggerFullBackfill`; displays channel/sync state.
- `/admin/clients`: `getClients`, `createClient`; client list + onboarding entry.
- `/admin/clients/[id]`: `getClientDetail`, `updateClient`, `updateOnboardingStep`; org profile + onboarding + settings.
- `/admin/inbound`: `getInboundShipments`; inbound list with filters.
- `/admin/inbound/[id]`: `getInboundDetail`, `markArrived`, `beginCheckIn`, `checkInItem`, `completeCheckIn`; receiving workflow.
- `/admin/inventory`: `getInventoryLevels`, `getInventoryDetail`, `adjustInventory`; inventory ops view and adjustments.
- `/admin/orders`: `getOrders`, `getOrderDetail`, `getTrackingEvents`; order + shipment context.
- `/admin/review-queue`: `getReviewQueueItems`, `assignReviewItem`, `resolveReviewItem`, `suppressReviewItem`, `reopenReviewItem`, `bulkAssign`, `bulkResolve`; operational exceptions queue.
- `/admin/scan`: `lookupBarcode`, `lookupLocation`, `submitCount`, `recordReceivingScan`; scan/count/receiving hub.
- `/admin/settings`: `getGeneralSettings`; workspace summary.
- `/admin/settings/bandcamp`: `getUserContext`, `getBandcampAccounts`, `getBandcampMappings`, `getOrganizationsForWorkspace`, `createBandcampConnection`, `deleteBandcampConnection`, `triggerBandcampSync`.
- `/admin/settings/health`: `getHealthData`, `triggerSensorCheck`; sensor status board.
- `/admin/settings/integrations`: `getIntegrationStatus`; integration status board.
- `/admin/settings/store-connections`: `getStoreConnections`, `disableStoreConnection`, `testStoreConnection`; connection management.
- `/admin/settings/store-mapping`: `getUserContext`, `getStoreMappings`, `syncStoresFromShipStation`, `autoMatchStores`, `updateStoreMapping`, `unmapStore`; ShipStation store routing.
- `/admin/shipping`: `getShipments`, `getShipmentDetail`; outbound shipping operations.
- `/admin/shipping/pirate-ship`: `initiateImport`, `getImportHistory`, `getImportDetail`; Pirate Ship XLSX import operations.
- `/admin/support`: `getConversations`, `getConversationDetail`, `createConversation`, `sendMessage`, `resolveConversation`, `assignConversation`; support inbox.

## Portal
- `/portal`: `getPortalDashboard`; client dashboard summary.
- `/portal/billing`: `getBillingSnapshots`, `getBillingSnapshotDetail`; client billing visibility.
- `/portal/inbound`: `getInboundShipments`; client inbound visibility.
- `/portal/inbound/new`: `createInbound`; inbound submission form.
- `/portal/inventory`: `getInventoryLevels`, `getInventoryDetail`; client inventory view.
- `/portal/orders`: `getOrders`, `getOrderDetail`, `getTrackingEvents`; client orders.
- `/portal/releases`: `getClientReleases`; pre-order/new release view.
- `/portal/sales`: `getSalesData`; client sales reporting.
- `/portal/settings`: `getPortalSettings`, `submitClientStoreCredentials`, `updateNotificationPreferences`; account + integration settings.
- `/portal/shipping`: `getClientShipments`, `getShipmentItems`, `getTrackingEvents`; client shipping detail.
- `/portal/support`: `getConversations`, `getConversationDetail`, `createConversation`, `sendMessage`; client support threading.

---

## 5) UI Field Catalog (Inputs/Selectors/Editable Fields)

This section captures all major user-entered fields found in app pages/components.

## Admin field inventory
- Client creation: `name`, `slug`, `billingEmail`.
- Client detail: `billing_email`, `pirate_ship_name`, `storage_fee_waived`.
- Inventory filters: `search`, `orgId`, `format`, `status`.
- Inventory adjustment: `delta`, `reason`.
- Inbound filters: `org filter`, `from date`, `to date`.
- Inbound check-in: `received quantity`, `condition notes`.
- Orders filters: `search`, `status`, `source`, `org`.
- Review queue ops: `category/status/severity filters`, assignment target, resolve notes, suppress duration.
- Catalog filters: `search`, `org`, `format`, `status`.
- Catalog edit: product `title`, `product_type`, `tags`; variant `price`, `compare_at_price`, `weight`.
- Billing rules: `rule_name`, `rule_type`, `amount`, `effective_from`, `description`.
- Billing format costs: `format_name`, `pick_pack_cost`, `material_cost`.
- Billing adjustments: `org_id`, `billing_period`, `amount`, `reason`.
- Bandcamp settings: `orgId`, `bandId`, `bandName`, `bandUrl`.
- Store-connections filters: `search`, `platform`, `status`.
- Shipping filters: `org`, `from`, `to`, `carrier`, `status`.
- Support: new conversation `orgId`, `subject`, `body`; detail `assignUserId`, `replyBody`.
- Scan: barcode/location/scanned values via scanner capture + count/receiving controls.

## Portal field inventory
- Settings store credentials: `apiKey`, `apiSecret`.
- Settings notifications: email notification toggle/preferences.
- Inbound submission: `trackingNumber`, `carrier`, `expectedDate`, `notes`.
- Inbound item rows: `sku`, `title`, `format`, `expected_quantity`.
- Inventory filters: `search`, `format`.
- Orders filters: `search`, `status`.
- Shipping filters: `carrier`, `status`.
- Support: `subject`, `body`, `replyBody`.
- Login (auth): `email` (magic link).

---

## 6) Full API Surface

## A) HTTP route handlers
- Health and callback:
  - `GET /api/health`
  - `GET /auth/callback`
- Webhooks:
  - `POST /api/webhooks/shopify`
  - `POST /api/webhooks/shipstation`
  - `POST /api/webhooks/aftership`
  - `POST /api/webhooks/stripe`
  - `POST /api/webhooks/resend-inbound`
  - `POST /api/webhooks/client-store`

## B) Server Actions
- Action modules in `src/actions/` include:
  - `auth`, `admin-dashboard`, `admin-settings`, `bandcamp`, `billing`, `catalog`, `client-store-credentials`, `clients`, `inbound`, `inventory`, `orders`, `pirate-ship`, `portal-dashboard`, `portal-sales`, `portal-settings`, `preorders`, `review-queue`, `scanning`, `shipping`, `shopify`, `store-connections`, `store-mapping`, `support`.

## C) Trigger.dev tasks
- In `src/trigger/tasks/`:
  - `shopify-sync`, `shopify-full-backfill`, `shopify-order-sync`
  - `shipment-ingest`, `shipstation-poll`
  - `pirate-ship-import`
  - `inbound-product-create`, `inbound-checkin-complete`
  - `aftership-register`
  - `monthly-billing`, `storage-calc`
  - `bandcamp-sync`, `bandcamp-scrape-page`, `bandcamp-inventory-push`, `bandcamp-sale-poll`
  - `preorder-setup`, `preorder-fulfillment`
  - `multi-store-inventory-push`, `client-store-order-detect`
  - `process-shopify-webhook`, `process-client-store-webhook`
  - `redis-backfill`, `sensor-check`, `support-escalation`
  - plus `debug-env` helper task file.

## D) External client/service modules
- `shopify-client`, `shopify`
- `shipstation`
- `aftership-client`
- `stripe-client`
- `bandcamp`, `bandcamp-scraper`
- `store-sync-client`, `woocommerce-client`, `squarespace-client`
- `redis-inventory`
- `billing-calculator`, `format-detector`
- `pirate-ship-parser`
- `resend-client`

---

## 7) Full Data Model Inventory (Tables and Data Points)

This section lists all implemented table domains from `supabase/migrations` and their primary fields/data points.

## Core tenancy/auth
- `workspaces`: workspace identity.
- `organizations`: client org profile, billing email, onboarding JSON, storage waiver/grace period.
- `users`: auth linkage, role, workspace/org ownership.
- `portal_admin_settings`: org-level portal toggles/settings.

## Product/catalog
- `warehouse_products`: Shopify linkage, title/vendor/type/status/tags/images handle.
- `warehouse_product_variants`: SKU, barcode, price/cost/weight/options, format, preorder metadata, Bandcamp URL.
- `warehouse_product_images`: ordered image records.

## Inventory/location/activity
- `warehouse_inventory_levels`: SKU quantities (`available`, `committed`, `incoming`) + org + redis write timestamp.
- `warehouse_locations`: location names/barcodes/types.
- `warehouse_variant_locations`: per-variant location quantities.
- `warehouse_inventory_activity`: delta log + source + idempotent correlation key.

## Orders/shipping/tracking
- `warehouse_orders`: customer/order financial + fulfillment + channel source + preorder flags.
- `warehouse_order_items`: line-level SKU/qty/title.
- `warehouse_shipments`: shipment carrier/tracking/cost/billing linkage.
- `warehouse_shipment_items`: shipment line items.
- `warehouse_tracking_events`: event timeline records.
- `warehouse_shipstation_stores`: ShipStation store to org mapping.
- `warehouse_pirate_ship_imports`: XLSX processing metadata.
- `warehouse_sync_state`: sync cursors/wall-clock state/metadata.

## Billing/rules
- `warehouse_billing_rules`: rule catalog and rates.
- `warehouse_format_costs`: format pricing table.
- `warehouse_format_rules`: format detection patterns.
- `warehouse_billing_adjustments`: manual credits/debits.
- `warehouse_billing_snapshots`: period snapshot totals and Stripe status.

## Inbound receiving
- `warehouse_inbound_shipments`: inbound header (tracking, status, dates, submitter/checker).
- `warehouse_inbound_items`: expected vs received quantities and notes/location.

## Bandcamp integration
- `bandcamp_credentials`: OAuth token set and expiry.
- `bandcamp_connections`: org-band account links + cached membership metadata.
- `bandcamp_product_mappings`: variant->Bandcamp link, item type, URL, quantities sold, sync timestamps.

## Monitoring and review
- `warehouse_review_queue`: severity/status/assignment/SLA/suppression/dedup group key.
- `webhook_events`: webhook dedup and processing metadata.
- `channel_sync_log`: integration sync run logging.
- `sensor_readings`: health signal stream.

## Support
- `support_conversations`: support thread headers and state.
- `support_messages`: per-message bodies, sender metadata, attachments.
- `support_email_mappings`: inbound address mapping.

## Multi-store connections
- `client_store_connections`: platform/store credentials + health/error/fanout controls.
- `client_store_sku_mappings`: remote<->local SKU mapping and push tracking.

## Data integrity/rules highlights
- role and enum constraints across many tables
- uniqueness constraints on idempotency/dedup keys (`webhook_events`, `warehouse_inventory_activity`)
- derived org trigger for inventory rows
- RLS helper functions for user/org scoping
- billing and inventory RPC support in monitoring migration pack

---

## 8) Old Warehouse Manager -> New App Comparison

Based on plan mapping in `PART2`, current implementation status is:

## Copied/adapted domains (implemented)
- query/cache helpers and invalidation wrappers are present.
- migrated platform clients exist in TS form.
- carried Trigger jobs are broadly present under `src/trigger/tasks`.
- old Netlify function responsibilities are replaced by Server Actions + webhooks.

## Written fresh (implemented)
- app router admin and portal pages.
- broad Server Action surface (expanded beyond plan baseline).
- webhook handlers, middleware, env validation, support flows, multistore flows.
- new async jobs (Bandcamp set, sensor-check, redis-backfill, multi-store orchestration, webhook processors).

## Left behind (as planned)
- non-warehouse modules from old monolith are out of scope.
- old chat/escalation patterns replaced by support conversation model.

---

## 9) Current Drift and Risk Notes

## Observed drift / deltas
- route structure is functionally aligned but flatter in places vs planned deep subroutes.
- CI workflow automation is not yet present (`.github/workflows` missing).
- E2E suite does not complete in current environment (Playwright hang).
- Trigger cloud-level verification blocked in current shell until CLI login + `TRIGGER_SECRET_KEY` env are set.
- env strictness still allows blank `SHIPSTATION_WEBHOOK_SECRET` default path.

## Positive corrections
- Shopify webhook route exists.
- `process-shopify-webhook` task exists.
- prior hardcoded workspace UUID pattern is no longer present in `src`.

---

## 10) Side-by-Side Validation Checklist (Old vs New)

Use this to compare behavior against old warehouse manager app:

1. Route parity:
- verify each old operational screen has equivalent new route/page and role gating.
2. API parity:
- verify old function behavior has equivalent Server Action or task implementation.
3. Webhook parity:
- verify platform signatures + dedup + idempotent processing path.
4. Data parity:
- compare key entity counts and sample records (products/variants/inventory/orders/shipments/billing/support).
5. Workflow parity:
- inbound receiving, scan/count, order-to-shipment, preorder lifecycle, billing cycle, support email threading.
6. Integration parity:
- Shopify, ShipStation, AfterShip, Stripe, Bandcamp, Resend, multi-store platforms.
7. Operational parity:
- sensor/health monitoring and review queue generation.
8. Security/tenant parity:
- RLS and org scoping checks for client isolation.

---

## 11) Handoff Artifacts in Repo

- `FULL_TECHNICAL_AUDIT.md`
- `PLAN_COMPARISON_REPORT.md`
- `TECHNICAL_HANDOFF_REPORT_2026-03-18.md`
- `FULL_TECHNICAL_HANDOFF_MASTER_2026-03-18.md` (this file)

---

## 12) Final Handoff Statement

This codebase is now documented with a complete technical map covering routes/pages, fields, data model, APIs/actions/tasks, and old->new migration alignment.  
Remaining blockers to fully closed handoff are operational hardening items (E2E stability, CI automation, Trigger live env/auth setup, and final env strictness cleanup).

