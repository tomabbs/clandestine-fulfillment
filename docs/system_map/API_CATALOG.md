# API Catalog

Canonical catalog of request boundaries used for planning/build/audit.

## Scope

- Next.js API route handlers in `src/app/api/**/route.ts`
- Server action boundaries in `src/actions/**/*.ts`

## API Routes (App Router)

| Method | Route | File | Purpose |
|---|---|---|---|
| `GET` | `/api/health` | `src/app/api/health/route.ts` | Runtime health endpoint |
| `POST` | `/api/webhooks/shopify` | `src/app/api/webhooks/shopify/route.ts` | Shopify webhook ingest |
| `POST` | `/api/webhooks/shipstation` | `src/app/api/webhooks/shipstation/route.ts` | ShipStation webhook ingest |
| `POST` | `/api/webhooks/aftership` | `src/app/api/webhooks/aftership/route.ts` | AfterShip webhook ingest |
| `POST` | `/api/webhooks/stripe` | `src/app/api/webhooks/stripe/route.ts` | Stripe billing webhooks |
| `POST` | `/api/webhooks/resend-inbound` | `src/app/api/webhooks/resend-inbound/route.ts` | Resend inbound email hooks |
| `POST` | `/api/webhooks/client-store` | `src/app/api/webhooks/client-store/route.ts` | Generic client store webhook ingress |

## Server Actions by Domain

### Auth + Identity

- File: `src/actions/auth.ts`
- Exports: `getUserContext`, `heartbeatPresence`

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
  - client presence: `getClientPresenceSummary`
  - user lifecycle: `getUsers`, `inviteUser`, `updateUserRole`, `deactivateUser`, `removeClientUser`
  - org lifecycle: `getOrganizations`, `createOrganization`, `mergeOrganizations`, alias management

### Inventory + Catalog + Product Images

- Files:
  - `src/actions/inventory.ts`
  - `src/actions/catalog.ts`
  - `src/actions/product-images.ts`
- Key exports:
  - inventory read/write: `getInventoryLevels`, `adjustInventory`, `getInventoryDetail`, `updateVariantFormat`
  - catalog read/write: `getProducts`, `getCatalogStats`, `getProductDetail`, `updateProduct`, `updateVariants`, `searchProductVariants`, `getClientReleases`
  - images: `uploadProductImage`, `reorderProductImages`, `deleteProductImage`, `setFeaturedImage`

### Inbound + Shipping + Orders + Scanning

- Files:
  - `src/actions/inbound.ts`
  - `src/actions/shipping.ts`
  - `src/actions/orders.ts`
  - `src/actions/scanning.ts`
- Key exports:
  - inbound: `getInboundShipments`, `getInboundDetail`, `createInbound`, `markArrived`, `beginCheckIn`, `checkInItem`, `completeCheckIn`
  - shipping: `getShipments`, `getShipmentsSummary`, `getShipmentDetail`, `exportShipmentsCsv`
  - orders: `getOrders`, `getOrderDetail`, `getTrackingEvents`, `getClientShipments`, `getShipmentItems`
  - scan: `lookupLocation`, `lookupBarcode`, `submitCount`, `recordReceivingScan`

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
  - `src/actions/support.ts`
- Key exports:
  - `getPortalDashboard`, `getSalesData`, `getPortalSettings`, `updateNotificationPreferences`
  - support: `getConversations`, `getConversationDetail`, `getSupportViewerContext`, `createConversation`, `sendMessage`, `markConversationRead`, `resolveConversation`, `assignConversation`, `suggestSupportReply`

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
  - trigger kickoffs/status: `triggerShopifySync`, `triggerFullBackfill`, `getShopifySyncStatus`, `triggerBandcampSync`, `getBandcampSyncStatus`
  - store connections and mappings: connection CRUD/test + mapping and reprocess ops
  - pirate ship imports: `initiateImport`, `getImportHistory`, `getImportDetail`
  - preorder tools: `getPreorderProducts`, `manualRelease`, `getPreorderAllocationPreview`

## Audit Requirement

Any diagnosis or fix plan touching sync/webhooks/inventory/orders/support must cite:

1. relevant entries in this file, and
2. matching tasks in `docs/system_map/TRIGGER_TASK_CATALOG.md`.
