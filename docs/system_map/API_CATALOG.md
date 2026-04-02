# API Catalog

Canonical catalog of request boundaries used for planning/build/audit.

## Scope

- Next.js API route handlers in `src/app/api/**/route.ts`
- Server action boundaries in `src/actions/**/*.ts`

## API Routes (App Router)

| Method | Route | File | Purpose |
|---|---|---|---|
| `GET` | `/api/health` | `src/app/api/health/route.ts` | Runtime health endpoint |
| `POST` | `/api/webhooks/shopify` | `src/app/api/webhooks/shopify/route.ts` | Shopify webhook ingest (inventory, orders) |
| `POST` | `/api/webhooks/shopify/gdpr` | `src/app/api/webhooks/shopify/gdpr/route.ts` | Combined Shopify GDPR compliance handler (HMAC verified) |
| `POST` | `/api/webhooks/aftership` | `src/app/api/webhooks/aftership/route.ts` | AfterShip webhook ingest |
| `POST` | `/api/webhooks/stripe` | `src/app/api/webhooks/stripe/route.ts` | Stripe billing webhooks |
| `POST` | `/api/webhooks/resend-inbound` | `src/app/api/webhooks/resend-inbound/route.ts` | Resend inbound email hooks |
| `POST` | `/api/webhooks/client-store` | `src/app/api/webhooks/client-store/route.ts` | Generic client store webhook ingress |
| `GET` | `/api/oauth/shopify` | `src/app/api/oauth/shopify/route.ts` | Shopify OAuth initiation (client store connect) |
| `GET` | `/api/oauth/shopify/callback` | `src/app/api/oauth/shopify/route.ts` | Shopify OAuth callback |
| `GET` | `/api/oauth/woocommerce` | `src/app/api/oauth/woocommerce/route.ts` | WooCommerce OAuth initiation |
| `POST` | `/api/oauth/woocommerce/callback` | `src/app/api/oauth/woocommerce/callback/route.ts` | WooCommerce OAuth 1.0a key delivery |
| `GET` | `/api/oauth/squarespace` | `src/app/api/oauth/squarespace/route.ts` | Squarespace OAuth initiation |
| `GET` | `/api/oauth/discogs` | `src/app/api/oauth/discogs/route.ts` | Discogs OAuth 1.0a initiation (client store connect) |

> All `/api/oauth/*` routes are public paths (no auth middleware) — clients arrive from external OAuth providers.
> GDPR routes verified with HMAC signature using `SHOPIFY_CLIENT_SECRET`.

## Server Actions by Domain

### Auth + Identity

- File: `src/actions/auth.ts`
- Exports: `getUserContext`, `heartbeatPresence`, `sendLoginMagicLink`
  - `sendLoginMagicLink`: server-side magic link generation via `auth.admin.generateLink` + Resend delivery. Replaces client-side `signInWithOtp`.

### Admin Dashboard + Settings

- Files:
  - `src/actions/admin-dashboard.ts`
  - `src/actions/admin-settings.ts`
- Key exports:
  - `getDashboardStats`
  - `getGeneralSettings`, `getIntegrationStatus`, `getHealthData`
  - `triggerSensorCheck`, `triggerTagCleanup`

### Clients + Users + Organizations

- Files:
  - `src/actions/clients.ts`
  - `src/actions/users.ts`
  - `src/actions/organizations.ts`
- Key exports:
  - client lifecycle: `getClients`, `getClientDetail`, `createClient`, `updateClient`
  - client presence + support history: `getClientPresenceSummary`, `getClientSupportHistory`
  - user lifecycle: `getUsers`, `inviteUser`, `updateUserRole`, `deactivateUser`, `removeClientUser`
  - org lifecycle: `getOrganizations`, `createOrganization`, `mergeOrganizations`, alias management
  - `getClientStores` → returns `{ legacy: [], connections: [] }` combining legacy + `client_store_connections`
  - `getClientProducts` → returns client products sorted by title (Artist — Title — Format)

### Inventory + Catalog + Product Images

- Files:
  - `src/actions/inventory.ts`
  - `src/actions/catalog.ts`
  - `src/actions/product-images.ts`
- Key exports:
  - inventory read/write: `getInventoryLevels`, `adjustInventory`, `getInventoryDetail`, `updateVariantFormat`
  - portal inventory: `getClientInventoryLevels` — starts from `warehouse_product_variants` (LEFT JOIN `warehouse_inventory_levels`) so zero-stock items are visible. Uses service role, filters by `org_id` explicitly.
  - catalog read/write: `getProducts`, `getCatalogStats`, `getProductDetail`, `updateProduct`, `updateVariants`, `searchProductVariants`, `getClientReleases`
  - images: `uploadProductImage`, `reorderProductImages`, `deleteProductImage`, `setFeaturedImage`

### Inbound + Shipping Log + Orders + Scanning

- Files:
  - `src/actions/inbound.ts`
  - `src/actions/shipping.ts`
  - `src/actions/orders.ts`
  - `src/actions/scanning.ts`
  - `src/actions/mail-orders.ts`
- Key exports:
  - inbound: `getInboundShipments`, `getInboundDetail`, `createInbound`, `markArrived`, `beginCheckIn`, `checkInItem`, `completeCheckIn`
  - shipping log (renamed from "Shipping", route `/admin/shipping`): `getShipments`, `getShipmentsSummary`, `getShipmentDetail`, `exportShipmentsCsv`, `getShippingRates`, `createOrderLabel`, `getLabelTaskStatus`
    - `getShipments` select now includes: `ss_order_number`, `customer_shipping_charged`, `total_units`, `label_source`, `warehouse_orders(order_number)`
  - orders: `getOrders`, `getOrderDetail`, `getTrackingEvents`, `getClientShipments`, `getShipmentItems`
    - `getClientShipments` **hardened 2026-04-02**: explicit `org_id` filter (resolves from authenticated user), includes `warehouse_orders(order_number)` join; no longer returns cross-org shipments
    - `getOrderDetail` shipments now auto-populated via `order_id` FK set by `shipstation-poll` auto-link
  - scan: `lookupLocation`, `lookupBarcode`, `submitCount`, `recordReceivingScan`
  - mail orders: `getMailOrders` (admin), `getClientMailOrders` (portal), `getMailOrderPayoutSummary`

### ShipStation Bridge (active during Shopify app approval period)

- File: `src/actions/shipstation-orders.ts`
- Key exports:
  - `getShipStationOrders({ status?, page?, pageSize? })` — live read from ShipStation `/orders` API, no DB write; staff-only
- Admin page: `/admin/shipstation-orders` — team's working order queue during bridge period
- Pirate Ship import surfaced from Shipping Log header → `/admin/shipping/pirate-ship`

### Billing + Reports + Review Queue

- Files:
  - `src/actions/billing.ts`
  - `src/actions/reports.ts`
  - `src/actions/review-queue.ts`
- Key exports:
  - billing: `getAuthWorkspaceId`, `getBillingRules`, `createBillingRule`, `updateBillingRule`, `getFormatCosts`, `updateFormatCost`, `createFormatCost`, snapshot + adjustments + overrides APIs
  - reports: `getTopSellers`, `getTopSellersSummary`
  - review queue: `getReviewQueueItems`, `assignReviewItem`, `resolveReviewItem`, `suppressReviewItem`, `reopenReviewItem`, bulk ops

### Portal Experience

- Files:
  - `src/actions/portal-dashboard.ts`
  - `src/actions/portal-sales.ts`
  - `src/actions/portal-settings.ts`
  - `src/actions/portal-stores.ts`
  - `src/actions/support.ts`
- Key exports:
  - `getPortalDashboard`, `getSalesData`, `getPortalSettings`, `updateNotificationPreferences`
  - portal stores: `getMyStoreConnections`, `getWooCommerceAuthUrl`, `deleteStoreConnection`
  - support: `getConversations`, `getConversationDetail`, `getSupportViewerContext`, `createConversation`, `sendMessage`, `markConversationRead`, `resolveConversation`, `assignConversation`, `suggestSupportReply`

### Discogs Master Catalog (Admin)

- File: `src/actions/discogs-admin.ts`
- Key exports: `getDiscogsOverview`, `getDiscogsCredentials`, `saveDiscogsCredentials`, `getProductMappings`, `confirmMapping`, `rejectMapping`
- All require `requireStaff()`.

### Integrations + Store Mapping

- Files:
  - `src/actions/shopify.ts`
  - `src/actions/bandcamp.ts`
  - `src/actions/store-connections.ts`
  - `src/actions/store-mapping.ts`
  - `src/actions/client-store-credentials.ts`
  - `src/actions/pirate-ship.ts`
  - `src/actions/preorders.ts`
- Key exports:
  - trigger kickoffs/status: `triggerShopifySync`, `triggerFullBackfill`, `getShopifySyncStatus`, `triggerBandcampSync`, `getBandcampSyncStatus`, `triggerBandcampConnectionBackfill`
  - Bandcamp connection management: `createBandcampConnection`, `deleteBandcampConnection`, `getBandcampAccounts`, `getBandcampMappings`, `getOrganizationsForWorkspace`
  - scraper observability: `getBandcampScraperHealth` (log-backed activity, catalog completeness, sensor readings, block rate, review queue)
  - Sales Report API: `salesReport`, `generateSalesReport`, `fetchSalesReport` (v4, all-time transaction history with catalog_number/upc/isrc)
  - SKU management: `updateSku` (push SKUs to Bandcamp, behind feature flag)
  - store connections and mappings: connection CRUD/test + mapping and reprocess ops
  - pirate ship imports: `initiateImport`, `getImportHistory`, `getImportDetail`
  - preorder tools: `getPreorderProducts`, `manualRelease`, `getPreorderAllocationPreview`

## Audit Requirement

Any diagnosis or fix plan touching sync/webhooks/inventory/orders/support must cite:

1. relevant entries in this file, and
2. matching tasks in `docs/system_map/TRIGGER_TASK_CATALOG.md`.
