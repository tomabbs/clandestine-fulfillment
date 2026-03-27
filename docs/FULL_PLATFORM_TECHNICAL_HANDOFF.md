# Clandestine Distribution — Full Platform Technical Handoff

**Date:** 2026-03-24  
**Version:** Based on Implementation Plan V3 + full codebase audit  
**Purpose:** Comprehensive technical reference for all AI reviewers and implementers. Pass-through-ready for multiple review cycles.

**Scope:** Full site function audit + V3 plan gap analysis + ShipStation removal impact + integration theory for EasyPost + store auth.

---

## PART 1: EXISTING SITE — FULL FUNCTIONAL INVENTORY

### 1.1 System Overview

```
BANDCAMP (all clients have this)
  → scraper fetches merch/album data
  → products created in CLANDESTINE SHOPIFY (master catalog)
  → warehouse_products / warehouse_product_variants created in DB
  → warehouse_inventory_levels seeded
  → REDIS updated as truth for real-time inventory

ORDERS FLOW IN:
  ← Bandcamp (via Merch Orders API, poll every 6h)
  ← Shopify client stores (webhook or poll every 10min)
  ← WooCommerce client stores (webhook or poll every 10min)
  ← Squarespace client stores (webhook or poll every 10min)
  [← ShipStation — REMOVING]

FULFILLMENT (changing):
  [ShipStation creates labels externally → webhook → warehouse_shipments] REMOVING
  → EasyPost creates labels IN APP → warehouse_shipments
  → AfterShip registers tracking → customer email notification
  → Bandcamp mark-shipped pushed (already built)
  → Connected store fulfillment marked (new build)

INVENTORY FANOUT:
  Central: warehouse_inventory_levels (DB) + Redis
  → multi-store-inventory-push (every 5min) → all active client_store_connections
  → bandcamp-inventory-push (every 15min) → Bandcamp quantity_available
```

---

### 1.2 Staff Portal — All Routes (Existing, All Passing)

| Route | Purpose | Key Actions Called |
|---|---|---|
| `/admin` | Dashboard: stats, sensor health, preorder controls | `getDashboardStats`, `getPreorderProducts`, `manualRelease` |
| `/admin/scan` | Barcode scanner hub: lookup, cycle count, receiving check-in | `lookupBarcode`, `lookupLocation`, `recordReceivingScan`, `submitCount` |
| `/admin/inventory` | Full inventory table + per-SKU adjustment | `getInventoryLevels`, `adjustInventory`, `updateVariantFormat` |
| `/admin/inbound` | Inbound shipment list + status tabs | `getInboundShipments` |
| `/admin/inbound/[id]` | Arrive → check-in line items → complete workflow | `getInboundDetail`, `markArrived`, `beginCheckIn`, `checkInItem`, `completeCheckIn` |
| `/admin/orders` | **ALL orders** (Shopify/Bandcamp/WooCommerce/Squarespace/manual). Expanded row: line items + shipments + tracking timeline | `getOrders`, `getOrderDetail`, `getTrackingEvents` |
| `/admin/catalog` | Product grid, inline editing | `getCatalogStats`, `getProducts`, `updateProduct` |
| `/admin/catalog/[id]` | Product detail, variants, images, collaborative editing | `getProductDetail`, `updateVariants` |
| `/admin/clients` | Client org list with presence/activity | `getClients`, `getClientPresenceSummary`, `createClient` |
| `/admin/clients/[id]` | Deep CRM: billing, sales, products, stores, users, support, onboarding, merge | Many from `clients`, `organizations`, `users`, `support` |
| `/admin/shipping` | Shipment list + recipient + tracking + Bandcamp sync | `getShipments`, `getShipmentsSummary`, `getShipmentDetail`, `setBandcampPaymentId`, `triggerBandcampMarkShipped` |
| `/admin/shipping/pirate-ship` | Upload Pirate Ship XLSX, import CSV | `getImportHistory`, `initiateImport` |
| `/admin/billing` | Snapshots, rules, format costs, client overrides, adjustments | Full billing action suite |
| `/admin/reports/top-sellers` | Top sellers report by org | `getTopSellers`, `getTopSellersSummary` |
| `/admin/review-queue` | Review queue: assign, resolve, suppress, bulk ops | `getReviewQueueItems`, `resolveReviewItem`, etc. |
| `/admin/support` | Staff support inbox + conversations | `getConversations`, `sendMessage`, `assignConversation` |
| `/admin/channels` | Shopify/Bandcamp sync triggers + tag cleanup | `triggerShopifySync`, `triggerBandcampSync`, `getShopifySyncStatus` |
| `/admin/settings` | Read-only workspace info | `getGeneralSettings` |
| `/admin/settings/users` | Staff users: invite, roles, deactivate | `getUsers`, `inviteUser`, `updateUserRole` |
| `/admin/settings/bandcamp` | Bandcamp connection per org + sync trigger | `getBandcampAccounts`, `createBandcampConnection`, `triggerBandcampSync` |
| `/admin/settings/store-connections` | Shopify/WooCommerce/Squarespace/BigCommerce client store connections | `getStoreConnections`, `createStoreConnection`, `testStoreConnection`, `disableStoreConnection` |
| `/admin/settings/store-mapping` | Map ShipStation stores → orgs (still needed for existing mappings) | `getStoreMappings`, `syncStoresFromShipStation`, `autoMatchStores` |
| `/admin/settings/integrations` | Integration status cards | `getIntegrationStatus` |
| `/admin/settings/health` | System sensor health + manual check | `getHealthData`, `triggerSensorCheck` |

**Admin sidebar nav items (exact current list):** Dashboard → Scan → Inventory → Inbound → Orders → Catalog → Clients → Shipping → Billing → Top Sellers → Review Q → Support → [Settings dropdown: General, Users, Bandcamp Accounts, Store Connections, Store Mapping, Channels, Integrations, Health]

**⚠️ IMPORTANT:** `/admin/fulfillment/orders` does NOT exist and is NOT in the nav. V3 correctly places label creation in the existing `/admin/orders` expanded row.

---

### 1.3 Client Portal — All Routes (Existing, All Passing)

| Route | What Clients See | Key Actions | ShipStation-dependent? |
|---|---|---|---|
| `/portal` | Home: stats + "Getting Started" onboarding checklist | `getPortalDashboard` | No |
| `/portal/inventory` | Read-only inventory levels, per-SKU detail, recent activity | `getInventoryLevels`, `getInventoryDetail` | No |
| `/portal/releases` | Upcoming preorders + recent releases grid | `getClientReleases` | No |
| `/portal/inbound` | Their inbound shipment list | `getInboundShipments` | No |
| `/portal/inbound/new` | Create inbound: SKU search + line items | `searchProductVariants`, `createInbound` | No |
| `/portal/orders` | All their orders (RLS-scoped). Line items, tracking timeline | `getOrders`, `getOrderDetail`, `getTrackingEvents` | No |
| `/portal/shipping` | Their outbound shipments + tracking timeline | `getClientShipments`, `getShipmentItems`, `getTrackingEvents` | **Indirect** — reads `warehouse_shipments` |
| `/portal/sales` | Sales summary + chart | `getSalesData` | No |
| `/portal/billing` | Billing snapshots + Stripe invoice links | `getBillingSnapshots`, `getBillingSnapshotDetail` | **Indirect** — billing reads `warehouse_shipments` |
| `/portal/support` | Support threads with staff | `getConversations`, `sendMessage` | No |
| `/portal/settings` | Org profile, notifications, **store credential submission for pending connections** | `getPortalSettings`, `submitClientStoreCredentials` | No |

**Portal sidebar nav:** Home → Inventory → Releases → Inbound → Orders → Shipping → Sales → Billing → Support → Settings

**"Getting Started" checklist items** (from `parseOnboardingState`):
1. `login_complete` — Login complete
2. `portal_configured` — Portal features configured
3. `store_connections_submitted` — Store connections submitted
4. `sku_mappings_verified` — SKU mappings verified
5. `inbound_contact_confirmed` — Inbound contact confirmed
6. `billing_contact_confirmed` — Billing contact confirmed
7. `first_inventory_sync` — First inventory sync complete
8. `support_email_active` — Support email active

**`/portal/onboarding` does NOT yet exist.** It's a new page to build.

---

### 1.4 Bandcamp Catalog Sync — Full Pipeline

**Purpose:** Bandcamp is the source of truth for ALL client merch. ALL clients use Bandcamp. Products on Bandcamp become products in the Clandestine Shopify (master catalog) and in the warehouse DB.

**Pipeline:**

```
bandcamp-sync-cron (*/30 min)
  → bandcamp-sync task (per workspace)
  → refreshBandcampToken
  → getMyBands → bandcamp_connections per org
  → getMerchDetails per band
  → matchSkuToVariants (by SKU)
    IF MATCHED:
      → upsert bandcamp_product_mappings
      → update variant price/cost/street_date/images
      → maybe trigger preorder-setup
      → trigger bandcamp-scrape-page (HTML scrape for album art, metadata)
    IF UNMATCHED (has SKU):
      → create Shopify DRAFT product via productSetCreate GraphQL
      → create warehouse_products (draft)
      → create warehouse_product_variants
      → seed warehouse_inventory_levels from Bandcamp quantity_available
      → insert bandcamp_product_mappings
      → trigger bandcamp-scrape-page

bandcamp-sale-poll (*/5 min)
  → getMerchDetails, compare quantity_sold to last_quantity_sold
  → on increase: recordInventoryChange (negative delta = sale)
  → updates last_quantity_sold on mapping

bandcamp-order-sync-cron (every 6h)
  → getOrders (last 30 days per band)
  → inserts warehouse_orders with source: "bandcamp", bandcamp_payment_id
  → line_items mapped from API response

bandcamp-inventory-push (*/15 min)
  → reads warehouse_inventory_levels.available for mapped variants
  → calls updateQuantities → Bandcamp quantity_available + quantity_sold

bandcamp-mark-shipped-cron (*/15 min)
  → reads warehouse_shipments with bandcamp_payment_id + tracking_number + bandcamp_synced_at null
  → calls updateShipped (pushes carrier + tracking to Bandcamp order)
  → sets bandcamp_synced_at
```

**DB tables involved:** `bandcamp_credentials`, `bandcamp_connections`, `bandcamp_product_mappings`, `warehouse_products`, `warehouse_product_variants`, `warehouse_product_images`, `warehouse_inventory_levels`, `warehouse_orders`, `warehouse_shipments`, `channel_sync_log`, `warehouse_review_queue`

**⚠️ KNOWN BUG in `inventory-fanout.ts`:** The Bandcamp fanout query selects only `id` from `bandcamp_product_mappings` but then checks `variant_id` on the result. PostgREST does not add `variant_id` implicitly, so `hasBandcampMapping` is likely always false. Immediate Bandcamp fanout from `recordInventoryChange` may not fire correctly. Needs investigation before confirming fanout behavior.

**ShipStation dependency:** `bandcamp-mark-shipped` reads `warehouse_shipments.tracking_number` + `bandcamp_payment_id`. With EasyPost, these rows are still created by `create-shipping-label` task with the same columns → Bandcamp mark-shipped continues to work unchanged. ✅

---

### 1.5 Central Inventory System

**Architecture:** Redis (Upstash) as real-time truth + Postgres (`warehouse_inventory_levels`) as durable truth. All writes go through `recordInventoryChange` which atomically updates both.

```
Any inventory change (sale, adjustment, inbound, receive, etc.)
  → recordInventoryChange(sku, delta, source, correlationId)
  → Redis Lua: SETNX idempotency key, HINCRBY on inv:{sku}
  → RPC: record_inventory_change_txn (Postgres: updates inventory_levels, inserts inventory_activity)
  → fanoutInventoryChange (triggers multi-store push + bandcamp push if mappings exist)

redis-backfill (weekly Tue 3am)
  → rebuilds Redis from warehouse_inventory_levels
  → skips rows where last_redis_write_at > backfill start

multi-store-inventory-push (*/5 min)
  → active client_store_connections (do_not_fanout=false)
  → reads client_store_sku_mappings → warehouse_inventory_levels.available
  → pushInventory via createStoreSyncClient per platform
  → circuit breaker: 5 consecutive auth failures → disabled_auth_failure + review queue item
```

**Key tables:** `warehouse_inventory_levels` (SKU, available, committed), `warehouse_inventory_activity` (audit log with correlation_id for idempotency), Redis hash `inv:{sku}`

**ShipStation dependency:** None in the inventory pipeline itself. `source: "shipstation"` appears in activity log for entries that originate from ShipStation workflows. When ShipStation is removed, new entries will have `source: "easypost"` or `source: "manual"`. ✅ No code changes needed in inventory layer.

---

### 1.6 Barcode Scanning System

**Three modes:**
1. **Quick Lookup** — scan SKU/barcode → show variant, location, available inventory
2. **Count** — scan location → scan items → submit count → records discrepancy to review queue if mismatched
3. **Receiving** — scan inbound shipment items → `recordReceivingScan`

**Key files:**
- `src/app/admin/scan/page.tsx` — the scan UI
- `src/actions/scanning.ts` — `lookupLocation`, `lookupBarcode`, `submitCount`, `recordReceivingScan`
- `src/components/admin/scanner-input.tsx` — global keydown, fast-keystroke detection

**DB tables:** `warehouse_locations`, `warehouse_variant_locations`, `warehouse_inventory_levels`, `warehouse_inbound_items`, `warehouse_review_queue`

**ShipStation dependency:** None. ✅

---

### 1.7 Billing System

**How billing works:**
```
storage-calc (1st of month 1am)
  → reads warehouse_inventory_levels vs 6-month shipment history
  → inserts warehouse_billing_adjustments (storage_fee lines)

monthly-billing (1st of month 2am — AFTER storage-calc)
  → per org: calculateBillingForOrg()
  → aggregates warehouse_shipments + warehouse_shipment_items
  → applies warehouse_format_rules + warehouse_format_costs (pick/pack, materials)
  → applies warehouse_billing_rules (per_shipment, per_item, storage rates)
  → applies warehouse_billing_rule_overrides (client-specific rates)
  → applies warehouse_billing_adjustments (storage + manual)
  → RPC: persist_billing_snapshot
  → marks included warehouse_shipments as billed=true
  → creates Stripe invoice if stripe_customer_id set
```

**Billing depends on `warehouse_shipments`:** It reads `ship_date`, `shipping_cost`, `voided`, `is_drop_ship`, `total_units`. Does NOT reference `shipstation_shipment_id`. ✅ Billing continues to work with EasyPost-created shipments as long as they're in `warehouse_shipments` with the same columns.

**What clients see** (`/portal/billing`): Snapshot list, billing period, grand total, Stripe invoice download link if available.

**What staff see** (`/admin/billing`): Full CRUD for snapshots, billing rules, format costs, client rate overrides, manual adjustments.

---

### 1.8 Sensor Check System

The `sensor-check` task (every 5 min) monitors these sensors — **none reference ShipStation directly:**

| Sensor | What It Checks |
|---|---|
| `inv.redis_postgres_drift` | Redis vs Postgres inventory mismatch |
| `inv.propagation_lag` | Age of oldest `client_store_sku_mappings.last_pushed_at` |
| `sync.shopify_stale` | `warehouse_sync_state` for `shopify_delta` |
| `sync.bandcamp_stale` | `bandcamp_connections.last_synced_at` |
| `webhook.silence` | Active `client_store_connections` without recent webhook or poll |
| `billing.unpaid` | Overdue `warehouse_billing_snapshots` > 7 days |
| `review.critical_open` | Open critical `warehouse_review_queue` items > 1 hour |

**Post-ShipStation removal:** Add a new sensor for `client-store-order-detect` sync freshness (check `last_poll_at` on active connections is recent). This is a gap the current sensors don't cover.

---

### 1.9 Preorder System

Preorders are tied to Bandcamp → Shopify product sync. When a variant is `is_preorder=true` with a `street_date`:
- `preorder-setup` creates Shopify selling plan + tags ("Pre-Orders", "New Releases")
- `preorder-fulfillment` (daily 6am) — on street date, clears preorder flag, allocates FIFO stock to orders, marks `fulfillment_status: ready_to_ship`, creates review queue items for short shipments

**ShipStation dependency:** None. Preorder fulfillment just updates order status — actual shipping is a separate concern. ✅

---

### 1.10 ShipStation — Current Role and What Gets Removed

**ShipStation currently does:**
1. Creates physical shipping labels externally (staff logs into ShipStation)
2. Fires `SHIP_NOTIFY` webhook → `shipment-ingest` task → `warehouse_shipments` row created
3. `shipstation-poll` (every 30 min) polls ShipStation API as backup to webhook
4. Provides carrier/tracking/cost/address data via `label_data.shipTo` structure

**After removal, what needs to replace it:**
1. ✅ Label creation: EasyPost (`create-shipping-label` task)
2. ✅ `warehouse_shipments` creation: done inside `create-shipping-label` task
3. ✅ Tracking registration: `aftership-register` triggered from task
4. ⚠️ `label_data.shipTo`: EasyPost task must populate same structure (see gap below)
5. ✅ `shipstation-poll`: disable task
6. ✅ `shipment-ingest`: disable task (or keep for historical data only)
7. ✅ `/api/webhooks/shipstation`: can be disabled

**What does NOT need to change:**
- `warehouse_shipments` table structure — same table, same columns, EasyPost populates them
- Billing calculator — reads `warehouse_shipments`, not ShipStation API
- `getShipmentDetail` — reads `warehouse_shipments`, not ShipStation
- `/admin/shipping` page — reads DB, not ShipStation API
- Client portal `/portal/shipping` — reads DB, not ShipStation API
- `warehouse_shipstation_stores` table — keep for existing store→org mappings (store-mapping page still useful)
- Bandcamp mark-shipped — already reads `warehouse_shipments.tracking_number`

---

## PART 2: V3 PLAN — GAP ANALYSIS AND CORRECTIONS

---

### 2.1 CRITICAL: Wrong Import Path Throughout V3

**V3 says (Part 1):**
```typescript
// ✅ CORRECT — Service role client
import { createServiceClient } from '@/lib/supabase/server';
```

**⛔ WRONG — This path does not exist in the codebase.**

The actual file is `src/lib/server/supabase-server.ts` and it exports:
```typescript
export async function createServerSupabaseClient() { ... } // session-based (RLS-aware)
export function createServiceRoleClient() { ... }           // service role, bypasses RLS
```

**Every file in V3 that uses `createServiceClient` or `@/lib/supabase/server` must be corrected to:**
```typescript
import { createServiceRoleClient } from '@/lib/server/supabase-server';
// or for session-based:
import { createServerSupabaseClient } from '@/lib/server/supabase-server';
```

**Files affected in V3:** ALL of: `easypost/route.ts`, `aftership-register.ts`, `create-shipping-label.ts`, `fulfillment.ts`, `printing.ts`, `onboarding page`, `shopify/callback`, `woocommerce/callback`, `discogs/auth`, `discogs/callback`.

---

### 2.2 CRITICAL: `webhook_events` Table Column Names

V3's EasyPost webhook dedup (Part 7):
```typescript
// V3 uses:
.eq('source', 'easypost').eq('event_id', eventId)
// and inserts:
{ source: 'easypost', event_id: eventId, event_type: description, payload: body }
```

**⛔ WRONG — these columns don't exist.** Actual `webhook_events` columns (from all existing webhook handlers):
```typescript
{ workspace_id, platform, external_webhook_id, topic, metadata, status }
```

**Corrected dedup pattern:**
```typescript
// Check
.eq('platform', 'easypost').eq('external_webhook_id', eventId)

// Insert
{
  workspace_id: label?.workspace_id || 'unknown',  // requires lookup
  platform: 'easypost',
  external_webhook_id: eventId,
  topic: description,
  metadata: { payload: body },
}
```

**⚠️ NOTE:** `workspace_id` is required on `webhook_events`. The EasyPost webhook must look up the `workspace_id` from the `easypost_labels` row before inserting. If the label isn't found, use the workspace from the EasyPost webhook payload (EasyPost doesn't send workspace_id — it would need to come from the easypost_labels lookup).

---

### 2.3 CRITICAL: `label_data.shipTo` Not Populated by EasyPost Task

`getShipmentDetail` (in `shipping.ts`) builds the recipient from `label_data.shipTo`:
```typescript
function extractRecipient(labelData): LabelDataAddress {
  return labelData?.shipTo; // expects { name, street1, city, state, postalCode, country, phone }
}
```

V3's `create-shipping-label` task stores:
```typescript
label_data: {
  label_url: labelResult.labelUrl,
  label_zpl_url: labelResult.labelZplUrl,
}
// ⛔ MISSING: label_data.shipTo
```

**Without `label_data.shipTo`, the shipping page and CSV export show empty recipients for all EasyPost shipments.**

**Fix:** Add `shipTo` to `label_data` in the task:
```typescript
label_data: {
  label_url: labelResult.labelUrl,
  label_zpl_url: labelResult.labelZplUrl,
  shipTo: {
    name: toAddress.name,
    street1: toAddress.street1,
    street2: toAddress.street2,
    city: toAddress.city,
    state: toAddress.state,
    postalCode: toAddress.zip,
    country: toAddress.country,
    phone: toAddress.phone,
  }
}
```

---

### 2.4 HIGH: Wrong Trigger.dev SDK Import Path

V3's `create-shipping-label.ts`:
```typescript
import { task } from '@trigger.dev/sdk/v3';
import { tasks } from '@trigger.dev/sdk/v3';
```

**Existing codebase uses:**
```typescript
import { task } from "@trigger.dev/sdk";
import { tasks } from "@trigger.dev/sdk";
```

Verify in `trigger.config.ts` and existing task files before implementing.

---

### 2.5 HIGH: `requireAuth()` Return Shape Mismatch

V3's `fulfillment.ts`:
```typescript
const { userRecord } = await requireAuth();
if (!userRecord.is_staff) throw new Error("Staff only");
```

**Actual `requireAuth()` return shape:**
```typescript
{ supabase, authUserId, userRecord: { id, workspace_id, org_id, role, email, name }, isStaff }
```

`isStaff` is a top-level property, NOT `userRecord.is_staff`. Fix:
```typescript
const { userRecord, isStaff } = await requireAuth();
if (!isStaff) throw new Error("Staff only");
```

---

### 2.6 HIGH: `portal/layout.tsx` Cannot Check Current Path Directly

V3's onboarding redirect in `portal/layout.tsx`:
```typescript
const isOnboardingPage = /* check current path */;  // placeholder - no implementation
```

Server component layouts in Next.js 14 App Router do NOT have access to the current URL pathname directly. **Fix options:**

**Option A (Recommended):** Do NOT redirect in layout. Instead, redirect from `/portal/page.tsx` (home page) only:
```typescript
// portal/page.tsx
export default async function PortalHome() {
  const supabase = await createServerSupabaseClient();
  const { data: { user } } = await supabase.auth.getUser();
  const { data: userData } = await supabase
    .from('users')
    .select('org_id, organizations(onboarding_completed_at)')
    .eq('auth_user_id', user.id)
    .single();
  
  if (!userData?.organizations?.onboarding_completed_at) {
    redirect('/portal/onboarding');
  }
  // ... render home
}
```

**Option B:** Use Next.js `headers()` to read the request URL:
```typescript
import { headers } from 'next/headers';
const headersList = await headers();
const pathname = headersList.get('x-invoke-path') ?? '';
const isOnboardingPage = pathname.startsWith('/portal/onboarding');
```
(Not guaranteed across all Next.js deployments — Option A is cleaner.)

---

### 2.7 HIGH: `delivery_date` Column Type

V3's EasyPost webhook status update:
```typescript
delivery_date: tracker.status === 'delivered' ? new Date().toISOString() : null
```

But `warehouse_shipments.delivery_date` is a **DATE type** (not timestamptz):
```sql
delivery_date date,  -- from migration 20260316000004_orders.sql
```

**Fix:**
```typescript
delivery_date: tracker.status === 'delivered' ? new Date().toISOString().split('T')[0] : null
```

---

### 2.8 HIGH: `last_sync_at` Column Doesn't Exist

V3's Shopify OAuth callback:
```typescript
await supabase.from('client_store_connections').update({
  api_key: access_token,
  store_url: shop,
  connection_status: 'active',
  last_sync_at: new Date().toISOString(),  // ⛔ Column doesn't exist
})
```

The `client_store_connections` health columns are: `last_webhook_at`, `last_poll_at`, `last_error_at`, `last_error`. Use `updated_at` or omit.

---

### 2.9 HIGH: `oauth_states` — Staff-Only RLS Doesn't Work for OAuth Callbacks

V3's `oauth_states` RLS:
```sql
CREATE POLICY "Staff can manage oauth states" ON oauth_states FOR ALL USING (is_staff_user());
```

**Problem:** OAuth callback routes (`/api/shopify/callback`, etc.) run without an authenticated session (they're public routes). They use `createServiceRoleClient()` which bypasses RLS. This is fine — BUT the Discogs auth route uses `supabase` directly (a service client) while the Shopify callback also uses service client. Ensure all OAuth routes use `createServiceRoleClient()` consistently, not session-based clients.

**Also:** The `connection_id` passed to the auth route comes from query params. This means anyone who knows a valid `connection_id` could initiate OAuth. Add a check that the `user_id` param matches a valid authenticated user before creating the `oauth_states` record. In practice, these routes are triggered from the onboarding wizard (client is authenticated), so the wizard should pass the authenticated user's ID securely.

---

### 2.10 MEDIUM: Discogs Not Added to `createStoreSyncClient` Switch Statement

V3 shows `createDiscogsSync()` in `store-sync-client.ts` but doesn't show updating the main `createStoreSyncClient` switch. The existing switch:
```typescript
export function createStoreSyncClient(connection, skuMappings) {
  switch (connection.platform) {
    case "shopify": return createShopifySync(connection);
    case "squarespace": return createSquarespaceSync(connection);
    case "woocommerce": return createWooCommerceSync(connection, skuMappings);
    case "bigcommerce": throw new Error("BigCommerce not implemented");
    // ⚠️ MISSING: case "discogs"
    default: throw new Error(`Unsupported platform: ${connection.platform}`);
  }
}
```

Add: `case "discogs": return createDiscogsSync(connection);`

---

### 2.11 MEDIUM: ShipStation Tasks Not Explicitly Decommissioned

V3 doesn't mention disabling ShipStation Trigger tasks. Required steps when removing ShipStation:

**Files to disable/remove:**
- `src/trigger/tasks/shipstation-poll.ts` — remove from `index.ts` or comment out task
- `src/trigger/tasks/shipment-ingest.ts` — remove from `index.ts` or comment out task
- `src/app/api/webhooks/shipstation/route.ts` — return 200 but do nothing (or remove entirely)
- `SHIPSTATION_API_KEY`, `SHIPSTATION_API_SECRET`, `SHIPSTATION_WEBHOOK_SECRET` — remove from `.env.local` and `serverEnvSchema`

**Keep (don't remove):**
- `warehouse_shipstation_stores` table — still used by store-mapping page
- `/admin/settings/store-mapping` — still useful for existing store→org mappings
- `warehouse_shipments` table — EasyPost populates this same table

---

### 2.12 MEDIUM: `onboarding_completed_at` vs `onboarding_state`

V3 adds `organizations.onboarding_completed_at` (new column). But the existing `portal/` home page uses `parseOnboardingState(organizations.onboarding_state)` (existing JSONB column with individual step completions).

**Clarify:** Is `onboarding_completed_at` a separate migration that works alongside `onboarding_state`? The onboarding wizard should:
1. Allow clients to complete individual steps (updating `onboarding_state` JSONB as before)
2. Set `onboarding_completed_at = now()` when the wizard is explicitly finished (new column)

The portal layout redirect checks `onboarding_completed_at`. The home page checklist reads `onboarding_state`. Both coexist.

**What sets `onboarding_completed_at`?** Add to `onboarding.ts` server action:
```typescript
export async function completeOnboarding(orgId: string) {
  await requireAuth();  // ensure authenticated
  const supabase = createServiceRoleClient();
  await supabase.from('organizations')
    .update({ 
      onboarding_completed_at: new Date().toISOString(),
      onboarding_state: { ...existingState, store_connections_submitted: true }
    })
    .eq('id', orgId);
}
```

---

### 2.13 MEDIUM: `warehouse_tracking_events` Unique Constraint

V3's EasyPost webhook upserts with `onConflict: 'shipment_id,event_time,source'` but this unique constraint doesn't exist on `warehouse_tracking_events`. The AfterShip flow doesn't need it (it deduplicates at `webhook_events` level).

**Fix:** The EasyPost webhook handler should ONLY insert into `webhook_events` for dedup (already covered), then insert (not upsert) individual tracking events. If event already exists (same shipment_id + event_time + source), the insert will fail silently or can be caught.

**OR** add to migration:
```sql
ALTER TABLE warehouse_tracking_events 
ADD CONSTRAINT unique_tracking_event UNIQUE (shipment_id, event_time, source);
```

---

### 2.14 MEDIUM: Sensor Gap — No `client-store-order-detect` Freshness Check

When ShipStation is removed, the `webhook.silence` sensor on `client_store_connections` remains useful. But there's currently no sensor checking that `client-store-order-detect` is actually finding and ingesting orders successfully.

**Suggest adding** to `sensor-check.ts` post-ShipStation:
```typescript
// check warehouse_orders hasn't gone stale from any source
const { data: recentOrders } = await supabase
  .from('warehouse_orders')
  .select('created_at')
  .gt('created_at', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())
  .limit(1);
// if no orders in 24h AND connections are active → warning sensor
```

---

### 2.15 LOW: Discogs `customer_email` May Not Be Available

From the Discogs API, `buyer.email` may be restricted. V3's `normalizeDiscogsOrder` has `customerEmail: order.buyer?.email`. If null, the AfterShip customer notification won't send. Handle gracefully:
```typescript
// In aftership-register.ts
emails: shipment.order?.customer_email ? [shipment.order.customer_email] : undefined,
```
(Already in V3 — just confirming this is handled correctly.)

---

## PART 3: INTEGRATION THEORY — HOW IT ALL WORKS TOGETHER

### 3.1 Order Flow (Post-ShipStation)

```
CLIENT STORE ORDER COMES IN (Shopify/WooCommerce/Squarespace/Discogs/Bandcamp)
  ↓
client-store-order-detect (*/10 min) OR webhook via /api/webhooks/client-store
  ↓
warehouse_orders row created (customer_name, customer_email, shipping_address, line_items, source)
  ↓
Staff reviews /admin/orders — sees order with status "pending"/"ready_to_ship"
  ↓
Staff clicks "Create Label" in expanded order row
  ↓
initiateShippingLabel(orderId) server action
  ↓
tasks.trigger("create-shipping-label", { orderId, workspaceId, orgId, isInternational })
  ↓
TRIGGER TASK: create-shipping-label
  ↓ reads warehouse_orders for address, items, customer info
  ↓ calls EasyPost API (domestic → USPS Media Mail, international → Asendia)
  ↓ creates warehouse_shipments row (with label_data.shipTo populated)
  ↓ creates easypost_labels row
  ↓ updates warehouse_orders.fulfillment_status = "fulfilled"
  ↓ tasks.trigger("aftership-register", { shipment_id })
  ↓ tasks.trigger("mark-fulfilled-on-platform", { orderId, shipmentId, platform })  [NEW — see 3.3]
  ↓
TRIGGER TASK: aftership-register
  ↓ joins warehouse_shipments + warehouse_orders for customer_email
  ↓ calls createTracking with tracking_number, carrier, emails[], customer_name
  ↓ AfterShip sends branded tracking email to customer
  ↓
EasyPost tracking updates arrive at /api/webhooks/easypost
  ↓ dedup via webhook_events (platform: "easypost", external_webhook_id: eventId)
  ↓ inserts warehouse_tracking_events (description, event_time, location, source: "easypost")
  ↓ updates warehouse_shipments.status
  ↓
UI: /admin/shipping shows shipment with tracking timeline
UI: /portal/shipping shows client their shipment + tracking
UI: /admin/orders shows "Fulfilled" badge
```

### 3.2 Bandcamp Fulfillment Push (Existing, No Change)

```
After create-shipping-label creates warehouse_shipments with:
  - bandcamp_payment_id (from warehouse_orders.bandcamp_payment_id if Bandcamp order)
  - tracking_number
  - bandcamp_synced_at = null

bandcamp-mark-shipped-cron (*/15 min)
  → finds all shipments with bandcamp_payment_id + tracking_number + bandcamp_synced_at null
  → calls updateShipped (Bandcamp API)
  → sets bandcamp_synced_at
```

**⚠️ IMPORTANT:** `warehouse_orders.bandcamp_payment_id` must be copied to `warehouse_shipments.bandcamp_payment_id` when a label is created for a Bandcamp order. The `create-shipping-label` task must check `warehouse_orders.bandcamp_payment_id` and set it on the shipment row.

**Fix needed in `create-shipping-label.ts`:**
```typescript
// When inserting warehouse_shipments:
{
  ...existing fields,
  bandcamp_payment_id: order.bandcamp_payment_id || null,  // ADD THIS
}
```

### 3.3 Platform Fulfillment Push (New — Required)

After creating a label, we need to mark the order "shipped" on the source platform. This needs a new Trigger task:

```
TRIGGER TASK: mark-platform-fulfilled (NEW)
  payload: { orderId, shipmentId, platform, tracking_number, carrier }
  
  → load client_store_connections for the org + platform
  → createStoreSyncClient(connection)
  → client.markFulfilled(platformOrderId, { number: tracking_number, carrier })
  
  Platform implementations:
  - Shopify: POST /admin/api/.../orders/{id}/fulfillments.json
  - WooCommerce: PUT /orders/{id} with status: "completed" + meta_data
  - Squarespace: No API (skip, AfterShip email handles customer notification)
  - Discogs: POST /marketplace/orders/{id} with status: "Shipped"
  - Bandcamp: Already handled by bandcamp-mark-shipped-cron (skip here)
```

**⚠️ V3 includes `markFulfilled()` implementations but doesn't define the Trigger task or how it's triggered.** The `create-shipping-label` task should trigger this:
```typescript
// At end of create-shipping-label task:
if (order.source !== 'bandcamp') {  // Bandcamp has its own cron
  await tasks.trigger('mark-platform-fulfilled', {
    orderId: payload.orderId,
    shipmentId: shipment.id,
    platform: order.source,
    tracking_number: labelResult.trackingNumber,
    carrier: labelResult.carrier,
  });
}
```

### 3.4 Inventory Sync Flow (Unchanged)

```
recordInventoryChange (any source: sale, receive, adjustment, backfill)
  → Redis atomic update
  → Postgres RPC record_inventory_change_txn
  → fanoutInventoryChange
    → multi-store-inventory-push (every 5min) pushes to all client_store_connections
    → bandcamp-inventory-push (every 15min) pushes to Bandcamp

Client portal /portal/inventory reads warehouse_inventory_levels (DB-only, not Redis)
```

### 3.5 OAuth + Onboarding Flow (New)

```
Client logs in → /portal home
  → check organizations.onboarding_completed_at
  → if null → redirect to /portal/onboarding

/portal/onboarding wizard:
  Step 1: Welcome
  Step 2: Select platforms (Shopify, WooCommerce, Squarespace, Discogs, Bandcamp)
  Step 3: For each platform:
    - Shopify: enter store URL → GET /api/shopify/auth?connection_id=X&shop=Y → OAuth → callback → api_key stored
    - WooCommerce: enter site URL → GET /api/woocommerce/auth → redirect to WooCommerce → GET callback with consumer_key
    - Squarespace: GET /api/squarespace/auth → OAuth → callback → api_key + refresh_token stored
    - Discogs: GET /api/discogs/auth → request_token → authorize URL → GET callback → access_token stored
    - Bandcamp: manual instructions only (invite fulfillment@clandestinedistribution.com)
  Step 4: Done → completeOnboarding() → set onboarding_completed_at → redirect to /portal

After OAuth completes:
  → connection in client_store_connections with connection_status: "active"
  → client-store-order-detect (*/10 min) starts picking up orders
  → multi-store-inventory-push (*/5 min) starts pushing inventory
  → Staff can see connections in /admin/settings/store-connections
  → Staff can test connection with "Test" button
  → Staff can manually add connections at any time (bypassing client OAuth)
```

---

## PART 4: FULL FILE CHANGE MAP

### 4.1 New Files to Create

| File | Purpose |
|---|---|
| `src/lib/clients/easypost-client.ts` | EasyPost label creation + rate shopping |
| `src/lib/clients/discogs-client.ts` | Discogs API client + order normalization |
| `src/lib/clients/printnode-client.ts` | PrintNode thermal printing API |
| `src/lib/oauth/index.ts` | Shared OAuth state utilities (generate/verify) |
| `src/lib/oauth/discogs-oauth.ts` | OAuth 1.0a specific utilities |
| `src/app/api/shopify/auth/route.ts` | Shopify OAuth initiation (GET) |
| `src/app/api/shopify/callback/route.ts` | Shopify OAuth callback (GET) |
| `src/app/api/woocommerce/auth/route.ts` | WooCommerce OAuth initiation (GET) |
| `src/app/api/woocommerce/callback/route.ts` | WooCommerce callback (GET — not POST!) |
| `src/app/api/squarespace/auth/route.ts` | Squarespace OAuth initiation (GET) |
| `src/app/api/squarespace/callback/route.ts` | Squarespace OAuth callback (GET) |
| `src/app/api/discogs/auth/route.ts` | Discogs OAuth 1.0a initiation (GET) |
| `src/app/api/discogs/callback/route.ts` | Discogs OAuth 1.0a callback (GET) |
| `src/app/api/webhooks/easypost/route.ts` | EasyPost tracking webhook handler |
| `src/app/portal/onboarding/page.tsx` | Client onboarding wizard page |
| `src/trigger/tasks/create-shipping-label.ts` | EasyPost label creation + DB writes |
| `src/trigger/tasks/mark-platform-fulfilled.ts` | Push shipping status back to source platform |
| `src/actions/fulfillment.ts` | `initiateShippingLabel`, `getLabelCreationStatus`, `getShippingRates`, `submitManualTracking` |
| `src/actions/printing.ts` | `getAvailablePrinters`, `printShippingLabel` |
| `src/actions/onboarding.ts` | `completeOnboarding`, `getOnboardingStatus` |
| `src/components/onboarding/onboarding-wizard.tsx` | Multi-step wizard component |
| `src/components/onboarding/platform-selector.tsx` | Platform checkbox grid |
| `src/components/onboarding/shopify-connect.tsx` | Shopify connection component |
| `src/components/onboarding/woocommerce-connect.tsx` | WooCommerce connection component |
| `src/components/onboarding/squarespace-connect.tsx` | Squarespace connection component |
| `src/components/onboarding/discogs-connect.tsx` | Discogs connection component |
| `src/components/onboarding/bandcamp-instructions.tsx` | Bandcamp manual instructions |
| `src/components/fulfillment/create-label-modal.tsx` | Label creation modal for orders page |
| `src/components/fulfillment/rate-selector.tsx` | EasyPost rate selection UI |
| `src/components/fulfillment/manual-tracking-form.tsx` | Manual tracking entry (Pirate Ship bypass) |
| `src/components/fulfillment/print-button.tsx` | PrintNode print trigger button |

### 4.2 Files to Modify

| File | What Changes |
|---|---|
| `src/lib/shared/types.ts` | Add `"discogs"` to `StorePlatform` and `OrderSource` |
| `src/lib/shared/env.ts` | Add all new env vars to `serverEnvSchema` |
| `src/middleware.ts` | Add OAuth callback paths to `PUBLIC_PATHS` |
| `src/lib/clients/aftership-client.ts` | Add `emails[]` and `customer_name` to `createTracking` |
| `src/trigger/tasks/aftership-register.ts` | Join warehouse_orders, pass customer email |
| `src/lib/clients/store-sync-client.ts` | Add `createDiscogsSync()`, add `markFulfilled()` to Shopify/WooCommerce, add Squarespace token refresh, add `case "discogs"` to switch |
| `src/app/portal/layout.tsx` | Add onboarding redirect check (server component) |
| `src/app/admin/orders/page.tsx` | Add "Create Label" expanded row UI + polling UI |
| `src/trigger/tasks/index.ts` | Register new tasks: `create-shipping-label`, `mark-platform-fulfilled` |

### 4.3 Files to Disable/Remove (ShipStation)

| File | Action |
|---|---|
| `src/trigger/tasks/shipstation-poll.ts` | Remove from `index.ts` export, comment out schedule |
| `src/trigger/tasks/shipment-ingest.ts` | Remove from `index.ts` export |
| `src/app/api/webhooks/shipstation/route.ts` | Return 200 immediately, no processing |
| `src/lib/clients/shipstation.ts` | Keep but mark deprecated (used by store-mapping sync for store listing) |

### 4.4 Files to NOT Touch

| File | Reason |
|---|---|
| `src/lib/clients/shopify-client.ts` | Warehouse Shopify (master catalog) — NEVER TOUCH |
| `src/trigger/tasks/shopify-sync.ts` | Warehouse catalog sync — NEVER TOUCH |
| `src/trigger/tasks/shopify-full-backfill.ts` | Warehouse catalog — NEVER TOUCH |
| `src/actions/shipping.ts` | Read-only shipment queries — keep separate from EasyPost write actions |
| `src/lib/server/record-inventory-change.ts` | Single write path — do not modify |

---

## PART 5: DATABASE MIGRATION REQUIREMENTS

The V3 migration is mostly correct. Additional items:

```sql
-- V3 Migration (required corrections and additions)

-- 1. oauth_states (V3 correct)
CREATE TABLE IF NOT EXISTS oauth_states ( ... );

-- 2. easypost_labels (V3 mostly correct, add org_id)
CREATE TABLE IF NOT EXISTS easypost_labels (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  org_id uuid REFERENCES organizations(id),           -- ADD for billing attribution
  shipment_id uuid NOT NULL REFERENCES warehouse_shipments(id) ON DELETE CASCADE,
  easypost_shipment_id text NOT NULL UNIQUE,
  easypost_rate_id text,
  carrier text NOT NULL,
  service text NOT NULL,
  label_url text NOT NULL,
  label_zpl_url text,
  label_format text DEFAULT 'ZPL',
  rate_amount decimal(10,2),
  rate_currency text DEFAULT 'USD',
  created_at timestamptz NOT NULL DEFAULT now()
);

-- RLS (V3 correct pattern — staff only)
ALTER TABLE easypost_labels ENABLE ROW LEVEL SECURITY;
CREATE POLICY staff_all ON easypost_labels FOR ALL TO authenticated USING (is_staff_user()) WITH CHECK (is_staff_user());

-- 3. Add to client_store_connections
ALTER TABLE client_store_connections ADD COLUMN IF NOT EXISTS refresh_token text;
ALTER TABLE client_store_connections ADD COLUMN IF NOT EXISTS token_expires_at timestamptz;

-- 4. Add to organizations
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS onboarding_completed_at timestamptz;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS shipping_preferences jsonb DEFAULT '{"domestic_provider":"easypost","international_provider":"easypost","allow_pirateship_fallback":false}';

-- 5. Unique constraint for tracking event dedup
ALTER TABLE warehouse_tracking_events 
ADD CONSTRAINT unique_tracking_event UNIQUE (shipment_id, event_time, source);
-- Note: this may fail if existing data has duplicates — run dedup first

-- 6. Warehouse address in workspace settings
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS warehouse_address jsonb DEFAULT '{
  "name": "Clandestine Distribution",
  "street1": "",
  "city": "",
  "state": "",
  "zip": "",
  "country": "US",
  "phone": ""
}';
-- Required by EasyPost label creation — currently hardcoded in V3
```

---

## PART 6: ERROR WARNINGS AND EDGE CASES

### ⛔ E1: EasyPost Media Mail Eligibility

Media Mail requires media content (books, vinyl, CDs, etc.). EasyPost may reject non-eligible packages. If `mediaMailRate` is null in `createDomesticLabel`, the error `"Media Mail rate not available"` is thrown. Build a fallback to USPS Priority or First Class:

```typescript
const rate = shipment.rates.find(r => r.carrier === 'USPS' && r.service === 'MediaMail')
  ?? shipment.rates.find(r => r.carrier === 'USPS' && r.service === 'First')
  ?? shipment.rates.sort((a,b) => parseFloat(a.rate) - parseFloat(b.rate))[0];
if (!rate) throw new Error('No rates available');
```

### ⛔ E2: EasyPost ZPL Not Available for All Carriers

International (Asendia) labels may only return PDF, not ZPL. `label_zpl_url` will be null. The UI must handle null gracefully — show "Download PDF" instead of "Print ZPL".

### ⛔ E3: Squarespace OAuth Token Expiry Race Condition

Squarespace access tokens expire in 30 minutes. `multi-store-inventory-push` runs every 5 minutes. If a token expires mid-push cycle, the push fails with 401. The token refresh must happen BEFORE any API call, with a 5-minute buffer. V3 shows this pattern:
```typescript
if (connection.token_expires_at < Date.now() + 5 * 60 * 1000) {
  await refreshSquarespaceToken(connection.id);
}
```
The `refreshSquarespaceToken` function must atomically fetch a new token AND update `api_key` + `refresh_token` + `token_expires_at` on `client_store_connections`. If refresh fails, set `connection_status: "disabled_auth_failure"` (NOT `"auth_failed"` — that value doesn't exist in the type).

### ⛔ E4: WooCommerce Tracking Meta Fields Not Visible to Customers

V3's `markFulfilled` for WooCommerce stores tracking in `meta_data` with keys `_tracking_number` and `_tracking_provider`. These are invisible to customers UNLESS they have a WooCommerce Shipment Tracking plugin installed. Most clients won't. Document this limitation — AfterShip's branded tracking email is the customer notification for WooCommerce, not WooCommerce's own order status page.

### ⛔ E5: Discogs `buyer.email` Access

Discogs may not return `buyer.email` in the orders API (restricted field). If null, customer notification falls back to the AfterShip email (which also may be null). Discogs customers may not receive tracking notifications — document this.

### ⛔ E6: Warehouse Address Hardcoded

V3's `create-shipping-label` task has the from-address hardcoded:
```typescript
const fromAddress = {
  name: 'Clandestine Distribution',
  street1: '123 Warehouse St',  // ← PLACEHOLDER
  city: 'Columbus',
  state: 'OH',
  zip: '43215',
  country: 'US',
};
```
Before going live with EasyPost, the real warehouse address must be stored (suggest `workspaces.warehouse_address` jsonb column, see migration item 6 above) and loaded at runtime.

### ⛔ E7: EasyPost `create-shipping-label` Task Doesn't Handle Weight for All Order Types

V3 calculates weight from `line_items[].grams`:
```typescript
const weightOunces = order.line_items.reduce((sum, item) => 
  sum + (item.grams ? item.grams / 28.35 : 16) * item.quantity, 0
);
```
Bandcamp orders don't have `grams` on line items (the Bandcamp API doesn't provide it). WooCommerce might. This means Bandcamp orders default to 16oz (1lb) per item. Consider allowing staff to override weight in the label creation modal.

### ⛔ E8: Shopify GraphQL vs REST for Fulfillment

V3's `markFulfilled` for Shopify uses a GraphQL mutation with `shopifyClient.request(mutation, ...)`. But there's no `shopifyClient` available inside `store-sync-client.ts` for client stores — `shopify-client.ts` is for the warehouse Shopify only (DO NOT TOUCH). For client Shopify stores, use the REST API with the connection's `api_key`:

```typescript
// In createShopifySync — markFulfilled using REST (not the warehouse GraphQL client):
async markFulfilled(orderId: string, tracking: { number: string; carrier: string }) {
  const baseUrl = connection.store_url.replace(/\/$/, '');
  const headers = { 
    'X-Shopify-Access-Token': apiKey!,
    'Content-Type': 'application/json' 
  };
  // First: get fulfillment order IDs
  const foRes = await fetch(`${baseUrl}/admin/api/2024-01/orders/${orderId}/fulfillment_orders.json`, { headers });
  const { fulfillment_orders } = await foRes.json();
  // Then: create fulfillment
  await fetch(`${baseUrl}/admin/api/2024-01/fulfillments.json`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      fulfillment: {
        line_items_by_fulfillment_order: fulfillment_orders.map((fo: any) => ({
          fulfillment_order_id: fo.id,
          fulfillment_order_line_items: fo.line_items.map((li: any) => ({ id: li.id, quantity: li.fulfillable_quantity }))
        })),
        tracking_info: {
          number: tracking.number,
          company: tracking.carrier,
        },
        notify_customer: true,
      }
    })
  });
}
```

---

## PART 7: TRIGGER TASK CATALOG UPDATES REQUIRED

After implementation, update `docs/system_map/TRIGGER_TASK_CATALOG.md`:

### New Tasks to Add

| Task ID | File | Schedule/Invoker |
|---|---|---|
| `create-shipping-label` | `src/trigger/tasks/create-shipping-label.ts` | `src/actions/fulfillment.ts` → `initiateShippingLabel()` |
| `mark-platform-fulfilled` | `src/trigger/tasks/mark-platform-fulfilled.ts` | `create-shipping-label` task (at completion) |

### Existing Tasks to Update

| Task | Change |
|---|---|
| `aftership-register` | New invoker: `create-shipping-label` (in addition to `shipment-ingest`) |
| `client-store-order-detect` | Add Discogs support |
| `multi-store-inventory-push` | Add Discogs support |

### Tasks to Decommission

| Task | Action |
|---|---|
| `shipment-ingest` | Remove from index.ts (keep file for reference) |
| `shipstation-poll` | Remove from index.ts (keep file for reference) |

---

## PART 8: API CATALOG UPDATES REQUIRED

After implementation, update `docs/system_map/API_CATALOG.md`:

### New Routes to Add

```
GET  /api/shopify/auth          src/app/api/shopify/auth/route.ts
GET  /api/shopify/callback      src/app/api/shopify/callback/route.ts
GET  /api/woocommerce/auth      src/app/api/woocommerce/auth/route.ts
GET  /api/woocommerce/callback  src/app/api/woocommerce/callback/route.ts
GET  /api/squarespace/auth      src/app/api/squarespace/auth/route.ts
GET  /api/squarespace/callback  src/app/api/squarespace/callback/route.ts
GET  /api/discogs/auth          src/app/api/discogs/auth/route.ts
GET  /api/discogs/callback      src/app/api/discogs/callback/route.ts
POST /api/webhooks/easypost     src/app/api/webhooks/easypost/route.ts
```

### New Server Actions to Add

```
# src/actions/fulfillment.ts
initiateShippingLabel(params)
getLabelCreationStatus(taskId)
getShippingRates(orderId)
submitManualTracking(params)

# src/actions/printing.ts
getAvailablePrinters()
printShippingLabel(params)

# src/actions/onboarding.ts
completeOnboarding(orgId)
getOnboardingStatus(orgId)
```

---

## PART 9: VERIFICATION PLAN

### Per-Phase Verification

```bash
# Phase 0
pnpm typecheck    # catches type union errors
pnpm check        # biome lint
pnpm test         # unit tests
# Verify: aftership-register triggers AfterShip with customer email

# Phase 1 (OAuth)
# Manual: trigger Shopify OAuth from /portal/onboarding
# Verify: connection_status = "active" in client_store_connections after callback
# Verify: api_key populated with valid Shopify access token
# Verify: WooCommerce callback is GET and receives consumer_key/consumer_secret
# Verify: Discogs request_token stored in oauth_states, access_token retrieved on callback

# Phase 2 (Onboarding)
# Manual: create new client user, login → should redirect to /portal/onboarding
# Manual: complete wizard → /portal home shows checklist items
# Verify: organizations.onboarding_completed_at set on completion
# Verify: subsequent logins skip onboarding

# Phase 3 (Discogs)
# Verify: Discogs orders appear in warehouse_orders with source: "discogs"
# Verify: inventory changes propagate to Discogs listings

# Phase 4 (EasyPost)
# TEST MODE FIRST: Use EasyPost test API key (EASYPOST_TEST_API_KEY)
# Verify: create-shipping-label task creates warehouse_shipments with correct label_data.shipTo
# Verify: easypost_labels row created and linked
# Verify: aftership-register fires and creates tracking
# Verify: EasyPost test webhook fires → tracking_events inserted with correct column names
# Verify: /admin/shipping shows shipment with recipient (from label_data.shipTo)

# Phase 5 (Label UI)
pnpm test:e2e:full-audit   # full site audit
# Manual: create label from /admin/orders expanded row
# Verify: polling UI shows progress during task execution
# Verify: ZPL download button works
# Verify: PrintNode printer selected and label sent to printer

# Phase 6 (Platform fulfillment push)
# Manual: for a Shopify client order, create label → verify Shopify order shows "Fulfilled"
# Manual: for WooCommerce order, verify status changes to "completed"
# Manual: for Discogs order, verify status changes to "Shipped"
```

---

## PART 10: COMPLETE DEPENDENCY MAP (NEW FEATURES → EXISTING SYSTEMS)

```
NEW: create-shipping-label task
  READS: warehouse_orders → warehouse_orders.shipping_address (nested object, not normalized)
  READS: organizations.shipping_preferences → domestic/international routing
  CREATES: warehouse_shipments → populates all existing columns including label_data.shipTo
  CREATES: easypost_labels → new table
  TRIGGERS: aftership-register → existing task
  TRIGGERS: mark-platform-fulfilled → new task
  AFFECTS: /admin/shipping (new rows appear automatically)
  AFFECTS: /portal/shipping (client sees new shipment)
  AFFECTS: monthly-billing (new shipments are billed)
  AFFECTS: bandcamp-mark-shipped (if bandcamp_payment_id set)

NEW: mark-platform-fulfilled task
  READS: warehouse_orders.source (to route to correct platform)
  READS: client_store_connections (to get credentials)
  CALLS: store-sync-client.markFulfilled() per platform
  NO DB WRITES: side-effect only (platform API call)

NEW: OAuth routes
  READS: oauth_states (for CSRF verification)
  WRITES: client_store_connections.api_key, api_secret, refresh_token, token_expires_at
  IMMEDIATELY ENABLES: multi-store-inventory-push (picks up new active connections)
  IMMEDIATELY ENABLES: client-store-order-detect (polls new connections)

REMOVED: shipment-ingest task
  WAS: creating warehouse_shipments from ShipStation webhook
  REPLACED BY: create-shipping-label task

REMOVED: shipstation-poll task
  WAS: backup polling for ShipStation shipments
  REPLACED BY: nothing (EasyPost webhook is reliable; Pirate Ship manual entry for fallback)
```

---

## PART 11: OUTSTANDING QUESTIONS FOR OWNER

Before implementation, confirm:

1. **Warehouse address:** What is the actual street address for the from-address in EasyPost labels? This needs to be in config/DB, not hardcoded.

2. **ShipStation timeline:** Is ShipStation being removed immediately, or running in parallel during transition? If parallel, both `shipment-ingest` and `create-shipping-label` could create `warehouse_shipments` — need dedup logic.

3. **Discogs client username:** `createDiscogsSync` calls `client.user().getInventory()` but Discogs user identity requires knowing the seller's username. How is this stored? Add `discogs_username` to `client_store_connections.metadata`?

4. **Squarespace OAuth status:** Squarespace OAuth approval is still pending. Should Squarespace be deferred to a later phase, or proceed with credential entry as fallback?

5. **Billing for EasyPost labels:** The `rate_amount` from EasyPost is the postage cost. Billing already reads `warehouse_shipments.shipping_cost`. Confirm: EasyPost `rate_amount` should be stored as `warehouse_shipments.shipping_cost`? (Yes, V3 does this in the task.)

6. **PrintNode:** Is PrintNode already set up? What printer ID? This needs to be configured per workspace.

7. **International shipment flag:** V3 determines `isInternational` by checking `shipping_address.country_code !== 'US'`. Confirm this is the correct logic (some territories like PR/VI are US but use different shipping rules).
