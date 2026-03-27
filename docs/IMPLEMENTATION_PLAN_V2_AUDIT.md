# Implementation Plan V2 — Full Codebase Audit + Context Supplement

**Date:** 2026-03-24  
**Auditor:** Cursor AI with full codebase + Playwright audit access  
**Input:** `CLANDESTINE_IMPLEMENTATION_PLAN_V2.md`  
**Purpose:** Give the next implementing Claude complete site context + all V2 gaps, issues, and resolutions before a single line of code is written.

---

## PART A: COMPLETE SITE CONTEXT (Read First — Claude Won't Have This)

### Staff Portal — Every Existing Route

The staff portal lives at `src/app/admin/**`. All routes pass 200 in the latest Playwright audit (2026-03-20). Navigation is defined in `src/components/admin/admin-sidebar.tsx`.

| Route | What It Does | Key Actions Used |
|---|---|---|
| `/admin` | Dashboard: monthly stats, sensor health, preorder controls | `getDashboardStats`, `getPreorderProducts`, `manualRelease` |
| `/admin/scan` | Barcode scanning hub: lookup, cycle count, receiving | `lookupBarcode`, `lookupLocation`, `recordReceivingScan`, `submitCount` |
| `/admin/inventory` | Paginated inventory; adjust stock; edit variant format | `getInventoryLevels`, `adjustInventory`, `updateVariantFormat` |
| `/admin/inbound` | Inbound shipment list by status | `getInboundShipments` |
| `/admin/inbound/[id]` | Single inbound workflow: arrive → check-in → complete | `getInboundDetail`, `markArrived`, `beginCheckIn`, `checkInItem`, `completeCheckIn` |
| `/admin/orders` | **ALL orders from ALL platforms** — Shopify/Bandcamp/WooCommerce/Squarespace/manual. Filters: source, fulfillment status. Expanded row shows line items + shipment tracking. | `getOrders`, `getOrderDetail`, `getTrackingEvents` |
| `/admin/catalog` | Product grid, inline edits | `getCatalogStats`, `getProducts`, `updateProduct` |
| `/admin/catalog/[id]` | Product detail, variants, images | `getProductDetail`, `updateVariants` |
| `/admin/clients` | Client org list with presence/activity indicators, create client | `getClients`, `getClientPresenceSummary`, `createClient` |
| `/admin/clients/[id]` | Deep client CRM: billing history, sales, products, stores, users, support threads, onboarding steps, org merge/aliases | Multiple actions from `clients`, `organizations`, `users`, `support` |
| `/admin/shipping` | **EXISTING shipment list + label/Bandcamp sync.** Shows ALL warehouse_shipments. Columns: ship date, order #, recipient (from `label_data.shipTo`), tracking, items, status (+ Bandcamp badge), cost. Expanded row: full detail, Bandcamp sync UI, line items, cost breakdown, tracking timeline. | `getShipments`, `getShipmentsSummary`, `getShipmentDetail`, `setBandcampPaymentId`, `triggerBandcampMarkShipped` |
| `/admin/shipping/pirate-ship` | Upload Pirate Ship XLSX, import history | `getImportHistory`, `initiateImport` |
| `/admin/billing` | Billing snapshots, rules, format costs, client overrides | `getBillingSnapshots`, `getBillingRules`, `getFormatCosts`, etc. |
| `/admin/reports/top-sellers` | Top sellers report | `getTopSellers` |
| `/admin/review-queue` | Review queue: assign, resolve, suppress items | `getReviewQueueItems`, `resolveReviewItem`, etc. |
| `/admin/support` | Staff support inbox + conversations | `getConversations`, `sendMessage`, `assignConversation` |
| `/admin/channels` | Shopify + Bandcamp sync controls | `triggerShopifySync`, `triggerBandcampSync`, `getShopifySyncStatus` |
| `/admin/settings` | Read-only workspace info | `getGeneralSettings` |
| `/admin/settings/users` | Staff users: invite, roles, deactivate | `getUsers`, `inviteUser`, `updateUserRole` |
| `/admin/settings/bandcamp` | Bandcamp account connections per org | `getBandcampAccounts`, `createBandcampConnection` |
| `/admin/settings/store-connections` | **Shopify/WooCommerce/Squarespace/BigCommerce connections**: create, test, disable. Currently credential-entry model (no OAuth flows). | `getStoreConnections`, `createStoreConnection`, `testStoreConnection` |
| `/admin/settings/store-mapping` | Map ShipStation stores → orgs | `getStoreMappings`, `syncStoresFromShipStation`, `autoMatchStores` |
| `/admin/settings/integrations` | Integration status cards | `getIntegrationStatus` |
| `/admin/settings/health` | System sensor health | `getHealthData`, `triggerSensorCheck` |

**Admin sidebar nav items (exact current list):** Dashboard, Scan, Inventory, Inbound, Orders, Catalog, Clients, Shipping, Billing, Top Sellers, Review Q, Support → then Settings dropdown: General, Users, Bandcamp Accounts, Store Connections, Store Mapping, Channels, Integrations, Health.

**There is NO `/admin/fulfillment/` route or nav item in the existing sidebar.**

---

### Client Portal — Every Existing Route

The client portal lives at `src/app/portal/**`. All routes pass 200. Navigation in `src/components/portal/portal-sidebar.tsx`.

| Route | What Clients See | Key Actions |
|---|---|---|
| `/portal` | Home: stat summary + "Getting Started" onboarding checklist | `getPortalDashboard` |
| `/portal/inventory` | Read-only inventory (RLS scoped to their org) | `getInventoryLevels`, `getInventoryDetail` |
| `/portal/releases` | Upcoming releases grid (products/street dates) | `getClientReleases` |
| `/portal/inbound` | Their inbound shipment list | `getInboundShipments` |
| `/portal/inbound/new` | Create inbound: SKU search + line items | `searchProductVariants`, `createInbound` |
| `/portal/orders` | Their orders from all platforms (RLS-scoped) | `getOrders`, `getOrderDetail`, `getTrackingEvents` |
| `/portal/shipping` | Their outbound shipments + tracking timeline | `getClientShipments`, `getShipmentItems`, `getTrackingEvents` |
| `/portal/sales` | Sales summary + chart | `getSalesData` |
| `/portal/billing` | Billing snapshots for their org | `getBillingSnapshots` |
| `/portal/support` | Support chat threads with staff | `getConversations`, `sendMessage` |
| `/portal/settings` | Org profile, notification prefs, **store credential submission** | `getPortalSettings`, `submitClientStoreCredentials` |

**Client sidebar nav:** Home, Inventory, Releases, Inbound, Orders, Shipping, Sales, Billing, Support, Settings.

**`/portal/onboarding` does NOT exist.** The "Getting Started" checklist is on `/portal` (home page). However, the home page doesn't redirect — it just shows checklist items. Adding `/portal/onboarding` as a dedicated route is a new addition.

**`portal/layout.tsx` has NO redirect logic.** It only wraps with sidebar + `SupportLauncher` + `PortalPresenceTracker`. Auth gating is in middleware only.

---

### Key Existing Data Shapes

**`warehouse_orders` table columns (confirmed from migrations):**
`id`, `workspace_id`, `org_id`, `shopify_order_id`, `order_number`, `customer_name`, `customer_email`, `financial_status`, `fulfillment_status`, `total_price`, `currency`, `line_items` (jsonb), `shipping_address` (jsonb), `tags`, `is_preorder`, `street_date`, `source`, `created_at`, `updated_at`, `synced_at`, `bandcamp_payment_id` (bigint, added later).

`customer_email` and `customer_name` ✅ exist — AfterShip customer email fix is technically viable.

**`warehouse_shipments` table columns:**
`id`, `workspace_id`, `org_id`, `shipstation_shipment_id` (nullable — EasyPost shipments won't have this), `order_id`, `tracking_number`, `carrier`, `service`, `ship_date`, `delivery_date`, `status`, `shipping_cost`, `weight`, `dimensions` (jsonb), `label_data` (jsonb), `voided`, `billed`, `is_drop_ship`, `total_units`, `bandcamp_payment_id`, `bandcamp_synced_at`.

**`warehouse_tracking_events` table columns:**
`id`, `shipment_id`, `workspace_id`, `status`, `description`, `location` (jsonb), `event_time` (timestamptz), `source`, `created_at`. **Note: column is `description`, NOT `message`. Column is `event_time`, NOT `event_at`.**

**`aftership-register` current invocation chain:**
`/api/webhooks/shipstation` → `shipment-ingest` Trigger task → calls `tasks.trigger("aftership-register", { shipment_id })` → `aftership-register` registers tracking.
New chain needed: EasyPost label creation server action → `tasks.trigger("aftership-register", { shipment_id })`.

**`aftership-client.ts` current `createTracking` signature:**
```typescript
createTracking(trackingNumber: string, carrier: string, metadata?: Record<string, unknown>): Promise<AfterShipTracking>
```
Metadata only supports `title` and `orderId`. Does NOT support `emails[]` or `customer_name`. **Both `aftership-register.ts` AND `aftership-client.ts` need patching.**

**Existing RLS helper functions (from migrations):**
- `is_staff_user()` — returns true if authenticated user is staff role
- `get_user_org_id()` — returns org_id for authenticated client user

These are the canonical functions for RLS policies. Raw `auth.uid()` table lookups are non-standard in this codebase.

---

## PART B: FINDINGS BY SEVERITY

---

### 🔴 CRITICAL (Will cause build or runtime failure)

---

**C1: EasyPost webhook handler uses wrong import path**

| Field | Detail |
|---|---|
| Symptom | `src/app/api/webhooks/easypost/route.ts` imports from `'@/lib/supabase/service-role'` |
| API boundary | `POST /api/webhooks/easypost` |
| Trigger touchpoint | None in webhook; `aftership-register` downstream |
| Data/policy touchpoint | `easypost_labels`, `warehouse_tracking_events` |
| Root cause confidence | High |
| Recommended fix | Change import to `'@/lib/server/supabase-server'` with `createServiceRoleClient` — same pattern as ALL other webhook handlers |

The V2 plan Part 7 webhook handler imports `createServiceRoleClient` from `'@/lib/supabase/service-role'`. This path does not exist. The correct import is:
```typescript
import { createServiceRoleClient } from '@/lib/server/supabase-server';
```

---

**C2: EasyPost webhook handler uses `request.json()` instead of raw body**

| Field | Detail |
|---|---|
| Symptom | Webhook signature verification fails at runtime |
| API boundary | `POST /api/webhooks/easypost` |
| Trigger touchpoint | None directly |
| Data/policy touchpoint | `webhook_events` dedup |
| Root cause confidence | High |
| Recommended fix | Use `readWebhookBody(request)` from `@/lib/server/webhook-body` then `JSON.parse()` — same pattern as all other webhooks |

V2 Part 7:
```typescript
const body = await request.json(); // WRONG — can't read raw body after this
```
Correct pattern (from `src/app/api/webhooks/aftership/route.ts`):
```typescript
import { readWebhookBody } from '@/lib/server/webhook-body';
const rawBody = await readWebhookBody(request);
const body = JSON.parse(rawBody);
```

---

**C3: `warehouse_tracking_events` column names are wrong in EasyPost webhook handler**

| Field | Detail |
|---|---|
| Symptom | DB insert fails with column-not-found errors at runtime |
| API boundary | `POST /api/webhooks/easypost` |
| Trigger touchpoint | None |
| Data/policy touchpoint | `warehouse_tracking_events` table |
| Root cause confidence | High |
| Recommended fix | Use correct column names: `description` not `message`, `event_time` not `event_at`, include `workspace_id` |

V2 Part 7 upserts:
```typescript
{ shipment_id, status, message, location, source, event_at }  // WRONG
```
Correct columns (from actual table schema and AfterShip webhook handler):
```typescript
{ shipment_id, workspace_id, status, description, location, event_time, source }
```
Also, the `onConflict: 'shipment_id,event_at,source'` will fail because that unique constraint **does not exist** on `warehouse_tracking_events`. The AfterShip flow deduplicates at the `webhook_events` level, not at `warehouse_tracking_events`. Fix: add a unique constraint in the migration, or query-before-insert.

---

**C4: `easypost_labels` RLS policy uses non-standard auth pattern**

| Field | Detail |
|---|---|
| Symptom | Policy may not work correctly; inconsistent with rest of codebase |
| API boundary | Any query to `easypost_labels` |
| Trigger touchpoint | None |
| Data/policy touchpoint | `easypost_labels` table RLS |
| Root cause confidence | High |
| Recommended fix | Use `is_staff_user()` pattern; client SELECT via `warehouse_shipments` join |

V2 policy:
```sql
CREATE POLICY "..." ON easypost_labels FOR SELECT USING (
  workspace_id IN (SELECT workspace_id FROM users WHERE id = auth.uid())
);
```
The `users` table uses `auth_user_id` (not `id`) to link to Supabase auth. The query should be `WHERE auth_user_id = auth.uid()`. But the idiomatic pattern in this codebase is:
```sql
CREATE POLICY staff_all ON easypost_labels FOR ALL TO authenticated 
  USING (is_staff_user()) WITH CHECK (is_staff_user());
CREATE POLICY client_select ON easypost_labels FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM warehouse_shipments ws
      WHERE ws.id = easypost_labels.shipment_id
      AND ws.org_id = get_user_org_id()
    )
  );
```

---

**C5: `aftership-client.ts` does not support `emails` or `customer_name` fields**

| Field | Detail |
|---|---|
| Symptom | Patching `aftership-register.ts` alone won't work — the client ignores these fields |
| API boundary | `aftership-register` Trigger task |
| Trigger touchpoint | `aftership-register` |
| Data/policy touchpoint | AfterShip API |
| Root cause confidence | High |
| Recommended fix | Patch both `aftership-client.ts` AND `aftership-register.ts` |

The V2 Part 10 fix only patches `aftership-register.ts`. The underlying `createTracking` function in `src/lib/clients/aftership-client.ts` accepts `metadata?: Record<string, unknown>` and only passes `title` and `order_id` to the API. To support customer email notification, `aftership-client.ts` must also be patched to accept and pass `emails: string[]` and `customer_name: string` in the AfterShip API payload.

---

### 🟠 HIGH (Functional gaps that will cause incorrect behavior)

---

**H1: New `/admin/fulfillment/orders/` page conflicts with existing `/admin/orders` and has no nav entry**

| Field | Detail |
|---|---|
| Symptom | Staff see two "orders" areas; new page is invisible (no nav link) |
| API boundary | New fulfillment actions |
| Trigger touchpoint | `aftership-register` |
| Data/policy touchpoint | `warehouse_orders`, `easypost_labels`, `warehouse_shipments` |
| Root cause confidence | High |
| Recommended fix | Add EasyPost label creation to the EXISTING `/admin/orders` page as an expanded action, not a new route |

The existing `/admin/orders` page already shows all orders from all platforms. Adding a separate `/admin/fulfillment/orders/` page would:
1. Not appear in any sidebar navigation (not in admin nav items)
2. Create confusion for staff about which "orders" page to use
3. Require duplicating order list/filter/display logic

**Better approach:** Extend the existing `/admin/orders` page's expanded row with a "Create Label" button that opens the label creation modal. This is the same pattern the Bandcamp sync UI uses in `/admin/shipping` — expand a row, get additional actions.

If a dedicated fulfillment page is desired, it should **replace** the orders page, not coexist with it, and the sidebar nav must be updated (`src/components/admin/admin-sidebar.tsx`).

---

**H2: No Trigger task created for EasyPost post-label flow**

| Field | Detail |
|---|---|
| Symptom | `aftership-register` has a new invocation path not documented in Trigger catalog |
| API boundary | New `src/actions/fulfillment.ts` |
| Trigger touchpoint | `aftership-register` |
| Data/policy touchpoint | `warehouse_shipments`, `easypost_labels` |
| Root cause confidence | High |
| Recommended fix | The `aftership-register` invocation from fulfillment action is fine architecturally. However, there should also be a consideration of whether a new `easypost-label-create` Trigger task is needed for the actual EasyPost API call (to handle retries, timeouts, etc.) or if a synchronous server action is acceptable. |

The V2 plan has label creation as a synchronous server action. EasyPost label purchase can take 2-5 seconds. This is acceptable for a staff action (not a webhook), but consider: if the server action times out (Vercel has a 60s limit for server actions), the label may have been purchased but the DB write failed. Recommend wrapping the EasyPost purchase + DB write in a Trigger task for reliability.

---

**H3: Squarespace `connection_status` value `"auth_failed"` doesn't match existing type**

| Field | Detail |
|---|---|
| Symptom | TypeScript error; DB constraint violation |
| API boundary | Squarespace token refresh logic in `store-sync-client.ts` |
| Trigger touchpoint | `multi-store-inventory-push` |
| Data/policy touchpoint | `client_store_connections.connection_status` |
| Root cause confidence | High |
| Recommended fix | Use `"disabled_auth_failure"` not `"auth_failed"` |

V2 Part 5: `connection_status: "auth_failed"`. The existing DB CHECK constraint and TypeScript type only allow: `"pending" | "active" | "disabled_auth_failure" | "error"`. The migration would need to add `"auth_failed"` OR use the existing `"disabled_auth_failure"` value.

---

**H4: `warehouse_tracking_events` needs unique constraint for EasyPost deduplication**

| Field | Detail |
|---|---|
| Symptom | EasyPost webhook fires multiple times for same event; duplicate rows inserted |
| API boundary | `POST /api/webhooks/easypost` |
| Trigger touchpoint | None |
| Data/policy touchpoint | `warehouse_tracking_events` |
| Root cause confidence | High |
| Recommended fix | Add unique constraint to migration OR use `webhook_events` dedup table (existing pattern) |

EasyPost webhooks can fire multiple times for the same tracking event (retries). The AfterShip flow deduplicates via `webhook_events` table with `UNIQUE(workspace_id, platform, external_webhook_id)`. The EasyPost webhook handler should follow the same pattern: insert into `webhook_events` first, get a dedup ID, then process. Without this, duplicate tracking events will appear in the timeline.

---

**H5: `oauth_states` table has no RLS policies — table will be locked down**

| Field | Detail |
|---|---|
| Symptom | OAuth flows fail silently — can't read/write state records |
| API boundary | All OAuth callback routes |
| Trigger touchpoint | None |
| Data/policy touchpoint | `oauth_states` |
| Root cause confidence | High |
| Recommended fix | Add policies for service-role access; OAuth routes use service-role client so they bypass RLS anyway |

V2 enables RLS on `oauth_states` but defines no policies. OAuth callback routes need to use `createServiceRoleClient()` to bypass RLS (same as all other webhook/callback handlers). The migration should also add:
```sql
-- Staff can view/manage oauth states
CREATE POLICY staff_all ON oauth_states FOR ALL TO authenticated 
  USING (is_staff_user()) WITH CHECK (is_staff_user());
```

---

**H6: No plan for adding EasyPost to admin sidebar navigation**

| Field | Detail |
|---|---|
| Symptom | New fulfillment page is inaccessible |
| API boundary | N/A |
| Trigger touchpoint | None |
| Data/policy touchpoint | None |
| Root cause confidence | High |
| Recommended fix | Update `src/components/admin/admin-sidebar.tsx` to add nav item OR integrate into existing pages |

If V2's `/admin/fulfillment/orders/` page is created, `src/components/admin/admin-sidebar.tsx` needs a new nav item. Current items: Dashboard, Scan, Inventory, Inbound, Orders, Catalog, Clients, Shipping, Billing, Top Sellers, Review Q, Support. Suggest either: (a) rename "Orders" to "Fulfillment" and make it the label creation hub, or (b) add "Fulfillment" between "Orders" and "Catalog".

---

**H7: Portal onboarding redirect has no implementation path defined**

| Field | Detail |
|---|---|
| Symptom | Clients aren't redirected to `/portal/onboarding` even after migration adds `onboarding_completed_at` |
| API boundary | `portal/layout.tsx` |
| Trigger touchpoint | None |
| Data/policy touchpoint | `organizations.onboarding_completed_at` |
| Root cause confidence | High |
| Recommended fix | Add server-side DB check in `portal/layout.tsx` (it's a server component) — OR use a portal home redirect instead |

`src/app/portal/layout.tsx` currently has **no redirect logic** — it just renders the sidebar. Adding the redirect requires:
1. Making `portal/layout.tsx` an `async` server component
2. Calling `requireAuth()` to get the org
3. Querying `organizations.onboarding_completed_at` 
4. Redirecting with `redirect('/portal/onboarding')` if null

This is safe since `portal/layout.tsx` is a server component, but it adds a DB query to every portal page render. Alternative: put the check only on `/portal` (home page) since that's the entry point.

---

### 🟡 MEDIUM (Will degrade UX or cause subtle bugs if not addressed)

---

**M1: `easypost_labels` missing `org_id` column**

V2 schema has only `workspace_id` and `shipment_id`. Since `warehouse_shipments` has `org_id`, the RLS JOIN-based policy works — but direct querying by org is harder. Consider adding `org_id` directly for billing attribution and simpler queries.

---

**M2: Discogs `@lionralfs/discogs-client` library needs verification**

The recommended library `@lionralfs/discogs-client` is a community package. Before including it, verify: Is it actively maintained? Does it support OAuth 1.0a properly? Does it have TypeScript types? Alternative: implement Discogs OAuth 1.0a directly using the `oauth-1.0a` npm package (which is well-maintained). The API calls can be made with standard `fetch`.

---

**M3: EasyPost label ZPL URL availability**

V2 requests `label_format: 'ZPL'` and stores `label_zpl_url`. However, EasyPost only returns ZPL for USPS and select carriers. USA Export (Asendia) labels may only be available in PDF or PNG. The label format should be configurable per carrier, and the `easypost_labels` table should have both `label_url` (PDF/PNG fallback) and `label_zpl_url` (nullable). The plan already includes `label_url` and `label_zpl_url` — this is correct. Just note that ZPL may be null for international labels.

---

**M4: The `discogs-client.ts` / npm library relationship is ambiguous**

The plan creates `src/lib/clients/discogs-client.ts` AND recommends `@lionralfs/discogs-client`. The file should be a thin wrapper that configures the npm package (similar to how `src/lib/clients/aftership-client.ts` wraps the AfterShip API). The plan should make this explicit.

---

**M5: `markFulfilled` for WooCommerce uses `meta_data` for tracking — non-standard**

WooCommerce doesn't have native fulfillment tracking fields. The plan stores tracking in `meta_data` arrays. For clients to see this in their WooCommerce dashboard, they need a WooCommerce plugin that reads these meta fields (e.g., WooCommerce Shipment Tracking plugin). Without that plugin, the tracking data is invisible to clients. This is an acceptable limitation but should be documented.

---

**M6: No customer email available for Discogs orders**

The Discogs API `GET /marketplace/orders` returns `buyer.email` — but Discogs may restrict this field. The AfterShip `createTracking` with customer email will fail for Discogs orders if the email isn't available. Plan should note this limitation and handle gracefully (skip email if null).

---

### 🔵 INFORMATIONAL (No code change needed, context for implementer)

---

**I1: `warehouse_orders.customer_email` and `warehouse_orders.customer_name` exist** — confirmed in migrations. The AfterShip email fix will work once both `aftership-register.ts` and `aftership-client.ts` are patched.

**I2: EasyPost shipments WILL appear in existing `/admin/shipping` page** — because that page queries all `warehouse_shipments`. No change needed there; EasyPost labels automatically appear as new shipments.

**I3: Portal onboarding checklist already exists on `/portal` home** — `getPortalDashboard()` returns onboarding steps. The new `/portal/onboarding` wizard is additive, not a replacement.

**I4: `/api/webhooks/easypost` is already public** — `middleware.ts` allows all `/api/webhooks/*` routes. No middleware change needed for the EasyPost webhook.

**I5: `aftership-register` invocation from fulfillment action is a new pattern** — currently only `shipment-ingest` triggers `aftership-register`. The new path (EasyPost server action → `tasks.trigger("aftership-register")`) should be documented in `TRIGGER_TASK_CATALOG.md` under the Invokers column.

**I6: Squarespace `markFulfilled` is not possible via API** — The plan correctly notes this. AfterShip's branded tracking email to the customer IS the Squarespace "fulfillment notification". No code needed for Squarespace fulfillment push.

---

## PART C: PROPOSED REMEDIATION SEQUENCE

Based on severity and dependency order:

### Phase 0: Fixes Before Any Feature Work (Day 1)

1. **Add `"discogs"` to `StorePlatform` and `OrderSource` types** — `src/lib/shared/types.ts`. Zero risk.

2. **Add new env vars to `serverEnvSchema`** — `src/lib/shared/env.ts`. Zero risk. Make `SHOPIFY_CLIENT_ID`, `SHOPIFY_CLIENT_SECRET` optional (`.optional()`) since they may not be in prod yet.

3. **Patch middleware** — Add OAuth callback paths to `PUBLIC_PATHS` in `middleware.ts`.

4. **Patch `aftership-client.ts`** — Add `emails?: string[]` and `customer_name?: string` to `createTracking` function's metadata handling, pass to AfterShip API payload.

5. **Patch `aftership-register.ts`** — Join to `warehouse_orders`, get `customer_email`/`customer_name`, pass to `createTracking`.

6. **Run DB migration** — `oauth_states`, `easypost_labels`, schema modifications. **Before running: fix the RLS policy pattern for both tables (see C4, H5).**

### Phase 1: OAuth Routes (Days 2-4)

7. Create `src/lib/oauth/index.ts` — shared state generation/verification against `oauth_states`.
8. Create `src/lib/oauth/discogs-oauth.ts` — OAuth 1.0a specific utilities.
9. Build Shopify OAuth routes (`/api/shopify/auth`, `/api/shopify/callback`).
10. Build WooCommerce OAuth routes (GET callback, not POST).
11. Build Squarespace OAuth routes + Squarespace token refresh in `store-sync-client.ts`. Use `"disabled_auth_failure"` not `"auth_failed"` (fix H3).

### Phase 2: Client Onboarding (Days 5-6)

12. Build `/portal/onboarding/page.tsx` — wizard component.
13. Add redirect logic to `src/app/portal/layout.tsx` (async server component, check `onboarding_completed_at`).
14. Build Bandcamp manual instruction flow component.

### Phase 3: Discogs (Days 7-8)

15. Install and evaluate `@lionralfs/discogs-client` (or use `oauth-1.0a` + raw fetch).
16. Create `src/lib/clients/discogs-client.ts` wrapper.
17. Build Discogs OAuth routes (`/api/discogs/auth`, `/api/discogs/callback`).
18. Add `createDiscogsSync()` to `store-sync-client.ts`.
19. Add Discogs to `client-store-order-detect` and `multi-store-inventory-push` tasks. **Update `TRIGGER_TASK_CATALOG.md`.**

### Phase 4: EasyPost (Days 9-12)

20. Create EasyPost account + enable carriers.
21. Install `@easypost/api`.
22. Create `src/lib/clients/easypost-client.ts` — domestic + international label functions.
23. Create `src/actions/fulfillment.ts` — `createShippingLabel`, `getRates`, `getShippingLabels`. **Do NOT put EasyPost actions in `shipping.ts`.**
24. Create `src/app/api/webhooks/easypost/route.ts` — fix import path (H1→C1), raw body handling (C2), correct column names (C3), add dedup via `webhook_events` (H4).
25. Wire EasyPost label creation → `warehouse_shipments` insert → `tasks.trigger("aftership-register", { shipment_id })`.

### Phase 5: Label Creation UI (Days 13-16)

26. **Decision point:** Add label creation to existing `/admin/orders` expanded row (recommended) OR create new `/admin/fulfillment/orders/` page and update admin sidebar.
27. Build `CreateLabelModal` component.
28. Build manual tracking entry form (for Pirate Ship fallback).
29. Build ZPL download button (simpler than PrintNode initially).

### Phase 6: Platform Fulfillment Push (Days 17-18)

30. Add `markFulfilled()` to `createShopifySync()` in `store-sync-client.ts`.
31. Add `markFulfilled()` to `createWooCommerceSync()`.
32. Add `markFulfilled()` to `createDiscogsSync()`.
33. Wire `markFulfilled` call into post-shipment flow in `fulfillment.ts`.

---

## PART D: VERIFICATION PLAN

```bash
# Phase 0 verification
pnpm typecheck      # Catches all type union changes
pnpm check          # Biome lint/format
pnpm test           # Unit tests pass

# Per-phase checks
pnpm build          # Catches missing imports (C1 would be caught here)

# AfterShip patch verification
# Trigger aftership-register manually with a known shipment_id
# Check AfterShip dashboard for customer email on new tracking

# OAuth flow verification
# Test Shopify: connect test store → OAuth flow → token stored → sync triggers
# Test WooCommerce: connect test site → GET callback → keys stored → test connection passes
# Verify oauth_states rows created + cleaned up after successful exchange

# EasyPost verification  
# Create domestic label → check easypost_labels row created
# Check warehouse_shipments row created with tracking_number
# Check aftership-register fires → AfterShip tracking registered
# Trigger EasyPost webhook → check warehouse_tracking_events row inserted with correct columns
# Full Playwright audit after each phase
pnpm test:e2e:full-audit
```

---

## PART E: DOC SYNC CONTRACT — Updates Required After Implementation

| Change | Doc to Update |
|---|---|
| New OAuth API routes (`/api/shopify/auth`, `/api/woocommerce/auth`, etc.) | `docs/system_map/API_CATALOG.md` |
| New EasyPost webhook route (`/api/webhooks/easypost`) | `docs/system_map/API_CATALOG.md` |
| New server actions (`fulfillment.ts`, `onboarding.ts`) | `docs/system_map/API_CATALOG.md` |
| `aftership-register` new invoker (EasyPost label creation action) | `docs/system_map/TRIGGER_TASK_CATALOG.md` |
| Discogs added to `client-store-order-detect` + `multi-store-inventory-push` | `docs/system_map/TRIGGER_TASK_CATALOG.md` |
| New Squarespace token refresh in `store-sync-client.ts` | `docs/system_map/TRIGGER_TASK_CATALOG.md` (notes on `multi-store-inventory-push`) |
| New `easypost_labels` table, `oauth_states` table | `project_state/engineering_map.yaml` |
| Client onboarding journey | `project_state/journeys.yaml` |
| Label creation + fulfillment push journey | `project_state/journeys.yaml` |
| New env vars added | `TRUTH_LAYER.md` (env section if it exists) |

---

## PART F: OPEN QUESTIONS FOR PLAN OWNER

Before implementation starts, resolve these:

1. **Label creation UI location:** Add to existing `/admin/orders` page OR create new `/admin/fulfillment/orders/` page? If new page, what happens to existing `/admin/orders`?

2. **EasyPost label creation: sync or async?** Synchronous server action (simpler, 60s Vercel timeout risk on slow networks) OR Trigger.dev task (reliable, needs polling UI)?

3. **Client self-onboarding priority:** Do clients NEED to connect their own stores via OAuth, or will staff always set up connections via the admin UI? This affects whether Phase 2 (onboarding wizard) is urgent or can be deferred.

4. **Discogs volume:** How many Discogs orders per month? Is Discogs a Phase 3 priority or can it be Phase 5+?

5. **Printing:** ZPL download button sufficient for now, or is PrintNode integration needed at launch?

6. **WooCommerce tracking meta:** Are clients' WooCommerce stores using the Shipment Tracking plugin? If not, `markFulfilled` tracking data is invisible to their customers.

7. **International EasyPost:**  Will all international orders use EasyPost (Asendia), or should staff be prompted to choose EasyPost vs Pirate Ship per order?
