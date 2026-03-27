# V6 Implementation Plan — Full Integration Audit + Handoff

**Date:** 2026-03-24  
**Evidence sources:** TRUTH_LAYER.md, API_CATALOG.md, TRIGGER_TASK_CATALOG.md, engineering_map.yaml, journeys.yaml, latest Playwright audit (2026-03-20, 36 routes all passing), deep codebase reads  
**Purpose:** Multi-AI-review-ready handoff — all findings, guardrails, and doc sync requirements in one document

---

## PREFACE: WHAT'S ACTUALLY WORKING (DO NOT BREAK)

### Playwright Audit Status: All 36 Routes Pass ✅

Every single admin and portal route returns 200 with zero page errors as of 2026-03-20. These must continue to pass after V6 implementation:

**Staff portal (all passing):** `/admin`, `/admin/inventory`, `/admin/inbound`, `/admin/orders`, `/admin/catalog`, `/admin/clients`, `/admin/shipping`, `/admin/shipping/pirate-ship`, `/admin/billing`, `/admin/channels`, `/admin/review-queue`, `/admin/support`, `/admin/scan`, `/admin/settings` + all settings sub-pages, `/admin/reports/top-sellers`

**Client portal (all passing):** `/portal`, `/portal/inventory`, `/portal/releases`, `/portal/inbound`, `/portal/inbound/new`, `/portal/orders`, `/portal/shipping`, `/portal/sales`, `/portal/billing`, `/portal/support`, `/portal/settings`

### Active Journeys (All Green — Must Remain Green)

| Journey | Status | Key Paths |
|---|---|---|
| `staff_client_invite` | ✅ green | `/admin/clients/[id]`, `inviteUser`, resend magic link |
| `client_support_flow` | ✅ green | support launcher, escalation, resend-inbound routing |
| `client_inbound_submission` | ✅ green | `/portal/inbound/new`, inbound-product-create, inbound-checkin-complete |
| `inventory_adjust_and_visibility` | ✅ green | single write path, redis parity |
| `release_health_gate` | ✅ green | release-gate.sh, full-site audit |
| `webhook_and_trigger_pipeline` | ✅ green | webhook ingress → trigger tasks |

### Protected Features (Guardrail — Touch Nothing Here Without Explicit Scope)

| Feature | Why Protected | Key Files |
|---|---|---|
| Bandcamp → Shopify catalog sync | Master catalog source | `bandcamp-sync.ts`, `shopify-client.ts` |
| Bandcamp order ingestion | Active order source | `bandcamp-order-sync.ts` |
| Bandcamp mark-shipped | Existing fulfillment push | `bandcamp-mark-shipped.ts` |
| Inventory write path | Atomic RPC + Redis | `record-inventory-change.ts`, Redis Lua |
| Billing calculator | Monthly billing | `billing-calculator.ts`, `monthly-billing.ts` |
| Support system | Client communication | `support.ts`, `support-escalation.ts`, resend-inbound |
| Preorder system | Release management | `preorder-fulfillment.ts`, `preorder-setup.ts` |
| Barcode scanning | Warehouse operations | `scanning.ts`, `admin/scan/page.tsx` |

---

## PART 1: FINDINGS BY SEVERITY

---

### 🔴 CRITICAL — Will Cause Immediate Runtime Failure

---

**C1: `metadata.platform_order_id` column doesn't exist on `warehouse_orders`**

| Field | Detail |
|---|---|
| Symptom | Any code reading/writing `order.metadata.platform_order_id` returns null or crashes |
| API boundary | `getOrders`, `getOrderDetail` from `src/actions/orders.ts` |
| Trigger touchpoint | `mark-platform-fulfilled` (planned), `bandcamp-order-sync` |
| Data/policy touchpoint | `warehouse_orders` — `supabase/migrations/20260316000004_orders.sql` — confirmed NO `metadata` column |
| Root cause confidence | High |
| Recommended fix | Add to V6 migration: `ALTER TABLE warehouse_orders ADD COLUMN IF NOT EXISTS metadata jsonb DEFAULT '{}';` and add `CREATE INDEX idx_orders_metadata ON warehouse_orders USING gin(metadata);` |

V6's entire `metadata.platform_order_id` contract is built on a column that doesn't exist. The `bandcamp-order-sync` task also doesn't set `metadata` on inserts — that must also be fixed. WooCommerce, Squarespace, and Discogs order ingestion tasks must set `metadata.platform_order_id` at insertion time.

---

**C2: `inventory-fanout.ts` Bandcamp branch always evaluates to false**

| Field | Detail |
|---|---|
| Symptom | `bandcamp-inventory-push` never fires automatically after inventory changes; Bandcamp quantity stays stale until cron |
| API boundary | `adjustInventory` from `src/actions/inventory.ts` |
| Trigger touchpoint | `bandcamp-inventory-push` (never triggered via fanout) |
| Data/policy touchpoint | `bandcamp_product_mappings` — missing `variant_id` in SELECT |
| Root cause confidence | High |
| Recommended fix | In `inventory-fanout.ts`: change `.select("id")` to `.select("id, variant_id")` when querying `bandcamp_product_mappings`. Pre-existing bug, not introduced by V6, but V6 doesn't fix it and its absence makes inventory sync unreliable. |

This is a pre-existing bug. V6 doesn't cause it but also doesn't fix it. Since V6 is adding more order-to-shipment flows that will trigger `recordInventoryChange`, this bug becomes more impactful. **Must fix in Phase 0.**

---

**C3: V6 `aftership-client.ts` patch required before `aftership-register.ts` patch**

| Field | Detail |
|---|---|
| Symptom | AfterShip customer emails never sent — `createTracking` ignores `emails[]` parameter |
| API boundary | `aftership-register` Trigger task |
| Trigger touchpoint | `aftership-register` (invoked by `shipment-ingest`, soon also by `create-shipping-label`) |
| Data/policy touchpoint | `aftership-client.ts` — confirmed no `emails` field in API call |
| Root cause confidence | High |
| Recommended fix | V6 Part 6 shows the correct patch. Implement `aftership-client.ts` patch FIRST, then `aftership-register.ts` patch. Both must go in Phase 0. |

---

**C4: V6 orders UI `pending_manual` snippet violates TRUTH_LAYER core invariants**

| Field | Detail |
|---|---|
| Symptom | Raw Supabase client used in client component; breaks established patterns; not type-safe |
| API boundary | Orders page — no matching server action exists for `pending_manual` filter |
| Trigger touchpoint | None |
| Data/policy touchpoint | `warehouse_shipments.status` vs `warehouse_orders.fulfillment_status` — different tables |
| Root cause confidence | High |
| Recommended fix | Add `pendingManual` filter to `getOrders` server action as a JOIN condition against `warehouse_shipments.status = 'pending_manual'`. Use `useAppQuery` calling server action — never raw Supabase in client components. |

TRUTH_LAYER invariant: "UI data access uses `useAppQuery` / `useAppMutation` with `query-tiers`." V6's snippet does neither.

Also: `shipment_status` is referenced in the V6 snippet but no such column exists on `warehouse_orders`. The filter must join to `warehouse_shipments` or check `warehouse_orders.fulfillment_status`.

---

**C5: Squarespace token refresh references `access_token` column — column is `api_key`**

| Field | Detail |
|---|---|
| Symptom | Squarespace token refresh reads/writes `access_token` but DB column is `api_key` |
| API boundary | `store-sync-client.ts` Squarespace section |
| Trigger touchpoint | `multi-store-inventory-push`, `client-store-order-detect` |
| Data/policy touchpoint | `client_store_connections.api_key` (confirmed in migration 011) |
| Root cause confidence | High |
| Recommended fix | In V6 Squarespace token refresh code, replace `access_token` with `api_key`. Also add `api_key` to the UPDATE in `refreshAccessToken`. |

---

### 🟠 HIGH — Functional Gap or Data Integrity Risk

---

**H1: `create-shipping-label.ts` Trigger task does not exist**

The task is described in V6 Part 7/8 but confirmed missing from the codebase. It must be registered in `src/trigger/tasks/index.ts` after creation. Trigger task IDs must also be added to `TRIGGER_TASK_CATALOG.md` per the Doc Sync Contract.

**H2: `bandcamp-order-sync` creates `warehouse_orders` without `metadata`**

The task does not set a `metadata` field. Once `metadata` column exists, the task must set:
```typescript
metadata: {
  platform_order_id: String(paymentId),   // Bandcamp payment_id
  platform_order_number: `BC-${paymentId}`,
}
```
However, Bandcamp fulfillment uses `bandcamp-mark-shipped` (which reads `bandcamp_payment_id` from `warehouse_shipments`), so `mark-platform-fulfilled` should skip Bandcamp orders — the task should check `order.source !== 'bandcamp'` before calling any platform fulfillment API.

**H3: `generate-daily-scan-form` SCAN batch polling may timeout**

The `createScanForm` function has two polling loops (30 × 1s each = up to 60 seconds). V6 doesn't specify `maxDuration` on the Trigger task. Must add `maxDuration: 120` (minimum) to `generate-daily-scan-form` task definition.

**H4: No `metadata` set for WooCommerce/Squarespace orders at ingestion**

`client-store-order-detect` creates `warehouse_orders` but doesn't set `metadata.platform_order_id`. The `mark-platform-fulfilled` task depends on this field. All platform order inserts in `client-store-order-detect` must be patched to include metadata with the platform's native order ID.

**H5: Admin sidebar has no SCAN Forms nav item**

V6 adds `/admin/shipping/scan-forms` page but the sidebar navigation (`src/components/admin/admin-sidebar.tsx`) is not updated. Users cannot reach the new page without a direct URL. Must add under existing "Shipping" area or as a new item.

Current nav order: Dashboard → Scan → Inventory → Inbound → Orders → Catalog → Clients → **Shipping** → Billing → Top Sellers → Review Q → Support → Settings. Add SCAN Forms as a sub-item under Shipping or as its own nav item.

**H6: Portal settings page has no "Add Connection" OAuth trigger**

V6's onboarding wizard adds OAuth connect flows, but `portal/settings/page.tsx` only shows credential submission forms for pending connections. After onboarding, clients need a way to add additional store connections. Options: (a) Add OAuth connect buttons to portal settings for already-onboarded clients, or (b) Allow re-visiting onboarding wizard. V6 doesn't address this post-onboarding gap.

**H7: `portal/layout.tsx` has no onboarding redirect — V6's proposed implementation has a path-check gap**

Current layout (25 lines, confirmed) has zero auth/redirect logic. V6 adds a redirect check. However, the proposed code has a placeholder `const isOnboardingPage = /* check current path */` that needs a concrete implementation. In Next.js 14 App Router server layouts, `headers()` can read `x-invoke-path`, but this isn't reliable across all deployment contexts. Recommend: check only in `/portal/page.tsx` (home) rather than the layout, or use `usePathname` in a client wrapper component.

**H8: ShipStation tasks still registered in `index.ts` — must be deregistered**

`shipstationPollTask` and `shipmentIngestTask` are both exported from `src/trigger/tasks/index.ts`. These must be removed from the export when ShipStation is ejected. Trigger will continue scheduling them until removed.

**H9: Sensor check has no `client-store-order-detect` freshness sensor**

After ShipStation removal, order ingestion depends entirely on `client-store-order-detect` (every 10 min). The sensor check (`sensor-check.ts`) has no sensor for this task's last execution. The existing `inv.propagation_lag` checks `last_pushed_at` on sku_mappings but not order polling staleness. A new sensor `sync.order_detect_stale` should be added.

---

### 🟡 MEDIUM — Integration Gaps and Missing Doc Sync

---

**M1: Bandcamp shipping_address format may differ from EasyPost expected format**

`bandcamp-order-sync` maps shipping_address from Bandcamp's API. EasyPost's `createShippingLabel` expects fields like `street1`, `province_code`, etc. Bandcamp's format uses `ship_to_street`, `ship_to_country_code`, etc. The `create-shipping-label` Trigger task reads `order.shipping_address.address1`, `province_code`, etc. — but Bandcamp orders may not have these exact fields. A normalization layer is needed.

**M2: `getOrders` source filter doesn't include `discogs`**

The orders page source filter options are: `shopify`, `bandcamp`, `woocommerce`, `squarespace`, `manual`. After Discogs is added, this list must include `discogs`.

**M3: Portal shipping page status values incomplete for V6**

`/portal/shipping/page.tsx` filters by: `shipped`, `in_transit`, `out_for_delivery`, `delivered`, `exception`. V6 introduces `label_created`, `manifested`, and `pending_manual`. The portal shipping page will show these as raw strings with fallback styling. Consider whether clients should see `pending_manual` status (they probably shouldn't — staff is managing that internally).

**M4: `query-keys.ts` missing namespaces for V6 features**

New V6 features need new query keys registered in `src/lib/shared/query-keys.ts`:
- `scanForms` — for SCAN form list and status
- `fulfillment` — for label creation status polling
- `easypostLabels` — for label records per order

Without these, any component using `useAppQuery` for these domains must use ad-hoc string keys (fragile) or the catalog is incomplete.

**M5: V6 `pending_manual` filter queries wrong table**

V6's snippet filters `warehouse_shipments.status = 'pending_manual'` but shows this as a filter on orders. `warehouse_orders` doesn't have a `shipment_status` field. The correct approach is either: (a) Join `warehouse_orders` to `warehouse_shipments` and filter on shipment status, or (b) Add a computed field to `getOrders` action that indicates if the order has a pending_manual shipment.

**M6: EasyPost webhook route not added to middleware PUBLIC_PATHS check**

V6 middleware update only adds OAuth callback paths. The EasyPost webhook at `/api/webhooks/easypost` is already covered by the existing `pathname.startsWith("/api/webhooks/")` guard — no change needed. ✅ This is fine, but should be documented to prevent confusion.

**M7: SCAN form date filtering uses `created_at` not `ship_date`**

In `generate-daily-scan-form`, unbatched labels are queried using `created_at >= shipDateT00:00:00Z`. If labels are created just after midnight for next-day ship, they'll be missed. Should use `ship_date` from `warehouse_shipments` (join through `easypost_labels.shipment_id`) or add a `ship_date` column directly to `easypost_labels`.

---

### 🔵 INFORMATIONAL — Pattern Violations and Notes

---

**I1: V6 Shopify REST API version should match existing codebase**

V6 uses `/admin/api/2025-10/orders/...`. Existing `store-sync-client.ts` uses `2024-01`. Standardize on `2024-01` or explicitly upgrade everywhere. Mixed versions are a maintenance hazard.

**I2: Channels page should gain EasyPost status after ShipStation removal**

Current `/admin/channels` shows Shopify and Bandcamp sync status. After removing ShipStation, add EasyPost health status (account balance, label count today, last webhook received).

**I3: `bandcamp-sale-poll` and `bandcamp-inventory-push` are protected and must remain untouched**

V6 doesn't touch these, which is correct. These are the real-time Bandcamp inventory sync path. The `inventory-fanout.ts` bug (C2) means the fanout doesn't trigger `bandcamp-inventory-push` automatically, but the cron (`*/15 min`) still runs it.

**I4: Portal `/portal/releases` data comes from `getClientReleases` not Bandcamp mappings**

The releases page reads `warehouse_products` + `warehouse_inventory_levels` only — no Bandcamp API calls. Products must already be in the warehouse DB (via `bandcamp-sync`) to appear on releases page. This is correct architecture — Bandcamp sync populates the DB, the portal reads the DB.

---

## PART 2: OPEN QUESTIONS / MISSING EVIDENCE

1. **`warehouse_orders.metadata` column:** Does a later migration (post-`20260316000004_orders.sql`) add this? Need to check all migrations after `20260316000004` for `metadata` addition.

2. **`client-store-order-detect` current metadata handling:** Does the task currently set any `metadata` field when inserting `warehouse_orders`? This was not fully read in the audit.

3. **`mark-platform-fulfilled` task:** V6 refers to this task but it's not shown in detail. How does it handle Bandcamp orders (which have their own path via `bandcamp-mark-shipped`)? Does it check `order.source === 'bandcamp'` and skip?

4. **Shopify `fulfillment_orders` API:** V6's `markFulfilled` for Shopify requires fetching fulfillment order IDs first. Does the client Shopify store have the correct API permissions scoped? The OAuth scopes in V6 include `write_fulfillments` — confirm this covers the new Fulfillments API endpoint.

5. **`@lionralfs/discogs-client` package:** Is this package available on npm? Is it TypeScript-compatible? No package.json entry for this was checked.

6. **`@easypost/api` SDK types:** The EasyPost client code uses `any` types for rate and shipment objects. Will TypeScript strict mode accept this?

7. **PrintNode alternative:** V6 says "Open PNG in new tab → Cmd+P" for label printing. No PrintNode integration is actually needed per the latest decision. But V6 still includes PrintNode code in Parts 10+. Confirm this is removed or kept as optional.

---

## PART 3: PROPOSED REMEDIATION SEQUENCE

### Phase 0: Foundation (Before Any Feature Work)

**In order — each depends on the previous:**

0.1. **Fix `inventory-fanout.ts` Bandcamp branch** — change `.select("id")` to `.select("id, variant_id")` in bandcamp mapping query. (C2)

0.2. **Add `metadata` column to `warehouse_orders` migration** — `ALTER TABLE warehouse_orders ADD COLUMN IF NOT EXISTS metadata jsonb DEFAULT '{}';` (C1)

0.3. **Patch `aftership-client.ts`** — add `emails[]` and `customer_name` to `createTracking` body. (C3)

0.4. **Patch `aftership-register.ts`** — join `warehouse_orders` to get `customer_email`, pass to `createTracking`. (C3)

0.5. **Update `StorePlatform` type** — add `"discogs"` to union.

0.6. **Update `OrderSource` type** — add `"discogs"` to union.

0.7. **Update `env.ts`** — add new env vars as `.optional()`.

0.8. **Update `middleware.ts`** — add OAuth callback paths to `PUBLIC_PATHS`.

0.9. **Deregister ShipStation tasks** — remove `shipstationPollTask` and `shipmentIngestTask` from `src/trigger/tasks/index.ts`. Comment out or delete cron in task files.

0.10. **Add `client-store-order-detect` freshness sensor** — new sensor `sync.order_detect_stale` checking `warehouse_orders` recency from connected stores. (H9)

0.11. **Run database migration** (includes `oauth_states`, `scan_forms`, `easypost_labels`, `refresh_token`, `token_expires_at`, `token_refresh_locked_at`, `onboarding_completed_at`, `shipping_preferences`, `warehouse_address`, `metadata` on orders, unique constraint on tracking events).

### Phase 1: OAuth Routes (Days 2-4)

1.1. Shopify OAuth routes (`/api/shopify/auth`, `/api/shopify/callback`)  
1.2. WooCommerce OAuth routes (GET callback)  
1.3. Squarespace OAuth with atomic token refresh — fix `access_token` → `api_key` column name (C5)  
1.4. Discogs OAuth 1.0a routes  

### Phase 2: Client Onboarding (Days 5-6)

2.1. `/portal/onboarding/page.tsx` — wizard component  
2.2. Onboarding redirect in `/portal/page.tsx` (home) — not in layout (H7)  
2.3. Bandcamp manual instructions UI  
2.4. Update portal settings page to allow adding new connections post-onboarding (H6)  

### Phase 3: Discogs Sync (Days 7-8)

3.1. `discogs-client.ts` wrapper  
3.2. `createDiscogsSync()` in `store-sync-client.ts` — add `case "discogs"` to switch  
3.3. Update `client-store-order-detect` to handle Discogs + set `metadata.platform_order_id` (H4)  
3.4. Update `multi-store-inventory-push` for Discogs  

### Phase 4: EasyPost Integration (Days 9-12)

4.1. `easypost-client.ts` — as in V6 (correct)  
4.2. `create-shipping-label.ts` Trigger task — include `label_data.shipTo` population, `bandcamp_payment_id` copy, `maxDuration: 120` (H1)  
4.3. `src/actions/fulfillment.ts` server actions  
4.4. `/api/webhooks/easypost/route.ts` — use correct `webhook_events` column names: `platform` not `source`, `external_webhook_id` not `event_id`  
4.5. `mark-platform-fulfilled` Trigger task — add `source !== 'bandcamp'` guard (H2)  
4.6. Update `warehouse_orders` inserts in `bandcamp-order-sync` to include `metadata.platform_order_id`  

### Phase 5: Label Creation UI (Days 13-16)

5.1. Add "Create Label" to `/admin/orders` expanded row  
5.2. Fix `pending_manual` filter to go through server action + correct table join (C4, M5)  
5.3. Add `pending_manual` badge count query  
5.4. Update `/admin/orders` source filter to include `discogs`  

### Phase 6: SCAN Forms (Days 17-18)

6.1. `generate-daily-scan-form` Trigger task — add `maxDuration: 120` (H3)  
6.2. `src/actions/scan-forms.ts` server actions  
6.3. `/admin/shipping/scan-forms/page.tsx`  
6.4. Add "SCAN Forms" to admin sidebar (H5)  
6.5. Add `scanForms` query key namespace to `query-keys.ts` (M4)  

### Phase 7: Testing (Days 19-20)

7.1. Run `pnpm release:gate --with-e2e` — all 36 routes must still pass  
7.2. Run `pnpm test:e2e:full-audit` — zero page errors, zero 5xx  
7.3. Verify all 5 active journeys remain green  
7.4. Verify `inventory-fanout.ts` Bandcamp fanout now fires (C2 fix)  
7.5. Verify AfterShip customer emails sent (C3 fix)  
7.6. Manual: end-to-end order → label → tracking → platform fulfillment push  
7.7. Manual: SCAN form generation and print  

---

## PART 4: FULL INTEGRATION MAP

### How V6 Features Connect to Existing Systems

```
BANDCAMP (protected — do not modify)
  → bandcamp-sync (*/30 min) → productSetCreate in CLANDESTINE SHOPIFY → warehouse_products
  → bandcamp-sale-poll (*/5 min) → recordInventoryChange → Redis + Postgres
  → bandcamp-order-sync (*/6h) → warehouse_orders (source: "bandcamp", bandcamp_payment_id)
    [FIX NEEDED: add metadata.platform_order_id]
  → bandcamp-inventory-push (*/15 min) → Bandcamp quantity_available
  → bandcamp-mark-shipped (*/15 min) → Bandcamp tracking push
    [WORKS: reads warehouse_shipments.bandcamp_payment_id + tracking_number]

NEW ORDER SOURCES (V6 adds)
  → client-store-order-detect (*/10 min) → warehouse_orders for Shopify/WooCommerce/Squarespace/Discogs
    [FIX NEEDED: set metadata.platform_order_id at ingestion]

LABEL CREATION (V6 new)
  initiateShippingLabel() → create-shipping-label Trigger task
    → EasyPost API → LabelResult
    → warehouse_shipments INSERT (status: "label_created", label_data.shipTo populated)
    → easypost_labels INSERT
    → warehouse_orders UPDATE (fulfillment_status: "fulfilled")
    → bandcamp_payment_id COPY from order to shipment (if Bandcamp source)
    → aftership-register TRIGGER
    → mark-platform-fulfilled TRIGGER (if source !== "bandcamp")
    
AFTERSHIP FLOW (patched in V6)
  aftership-register → warehouse_orders JOIN for customer_email → createTracking(emails[])
  /api/webhooks/aftership → warehouse_tracking_events (existing)
  → warehouse_shipments status update
  → portal/shipping shows tracking to client

SCAN FORMS (V6 new)
  generateScanForm() → generate-daily-scan-form Trigger task
    → easypost_labels WHERE batch_id IS NULL AND today
    → EasyPost Batch.create + Batch.createScanForm
    → scan_forms INSERT
    → easypost_labels UPDATE (batch_id)
    → warehouse_shipments UPDATE (status: "manifested")

PLATFORM FULFILLMENT PUSH (V6 new — mark-platform-fulfilled task)
  For Shopify client orders → REST /fulfillments.json (notify_customer: false)
  For WooCommerce orders → PUT /orders/{id} (configurable meta keys)
  For Squarespace orders → SKIP (no API; AfterShip email handles notification)
  For Discogs orders → marketplace/orders/{id} status: "Shipped"
  For Bandcamp orders → SKIP (bandcamp-mark-shipped handles this separately)

INVENTORY FANOUT (bug fix needed)
  recordInventoryChange → inventory-fanout.ts
    → multi-store-inventory-push TRIGGER
    → bandcamp-inventory-push TRIGGER [CURRENTLY BROKEN — fix C2]

SENSORS (existing — add new sensor)
  sensor-check (*/5 min):
    inv.redis_postgres_drift, inv.propagation_lag, sync.shopify_stale, sync.bandcamp_stale
    webhook.silence, billing.unpaid, review.critical_open
    [ADD: sync.order_detect_stale — check recent warehouse_orders from connected stores]

BILLING (untouched — reads warehouse_shipments)
  monthly-billing: reads warehouse_shipments for the period — works with EasyPost shipments ✅
  storage-calc: reads inventory + shipment history — not affected by label provider ✅
```

---

## PART 5: DOC SYNC CONTRACT — REQUIRED UPDATES

Per TRUTH_LAYER.md, these must be updated in the same session as the code changes:

### `docs/system_map/API_CATALOG.md`

Add new routes:
```
GET  /api/shopify/auth           src/app/api/shopify/auth/route.ts
GET  /api/shopify/callback       src/app/api/shopify/callback/route.ts
GET  /api/woocommerce/auth       src/app/api/woocommerce/auth/route.ts
GET  /api/woocommerce/callback   src/app/api/woocommerce/callback/route.ts
GET  /api/squarespace/auth       src/app/api/squarespace/auth/route.ts
GET  /api/squarespace/callback   src/app/api/squarespace/callback/route.ts
GET  /api/discogs/auth           src/app/api/discogs/auth/route.ts
GET  /api/discogs/callback       src/app/api/discogs/callback/route.ts
POST /api/webhooks/easypost      src/app/api/webhooks/easypost/route.ts
```

Add new server action files:
- `src/actions/fulfillment.ts` — `initiateShippingLabel`, `getLabelCreationStatus`, `getShippingRates`, `submitManualTracking`
- `src/actions/scan-forms.ts` — `generateScanForm`, `getScanFormTaskStatus`, `getTodaysScanForms`, `getUnbatchedLabelCount`, `markScanFormPrinted`
- `src/actions/onboarding.ts` — `completeOnboarding`, `getOnboardingStatus`

Remove from catalog:
- `/api/webhooks/shipstation` — ShipStation ejected

### `docs/system_map/TRIGGER_TASK_CATALOG.md`

Add new tasks:
```
create-shipping-label    src/trigger/tasks/create-shipping-label.ts    src/actions/fulfillment.ts
mark-platform-fulfilled  src/trigger/tasks/mark-platform-fulfilled.ts  create-shipping-label task
generate-daily-scan-form src/trigger/tasks/generate-scan-form.ts       src/actions/scan-forms.ts
```

Update existing:
- `aftership-register` — add new invoker: `create-shipping-label` (in addition to `shipment-ingest`)
- `client-store-order-detect` — add Discogs support note
- `multi-store-inventory-push` — add Discogs support note

Remove (decommissioned):
- `shipstation-poll` — ShipStation ejected
- `shipment-ingest` — ShipStation ejected

Domain touchpoints update:
- Orders/shipments: remove `shipstation-poll`, `shipment-ingest`; add `create-shipping-label`, `mark-platform-fulfilled`

### `project_state/engineering_map.yaml`

Add new domains or update:
```yaml
- name: easypost_shipping
  paths:
    - src/lib/clients/easypost-client.ts
    - src/trigger/tasks/create-shipping-label.ts
    - src/trigger/tasks/generate-scan-form.ts
    - src/actions/fulfillment.ts
    - src/actions/scan-forms.ts
    - src/app/api/webhooks/easypost/route.ts
  responsibilities:
    - domestic and international label creation
    - SCAN form batch manifest generation
    - EasyPost webhook tracking event ingestion

- name: platform_oauth
  paths:
    - src/app/api/shopify/**
    - src/app/api/woocommerce/**
    - src/app/api/squarespace/**
    - src/app/api/discogs/**
    - src/lib/oauth/**
    - src/app/portal/onboarding/**
  responsibilities:
    - client store OAuth flows (Shopify, WooCommerce, Squarespace, Discogs)
    - oauth_states CSRF management
    - client onboarding wizard
```

Update `integrations` domain — remove ShipStation reference, add EasyPost + Discogs.

### `project_state/journeys.yaml`

Add new journeys:
```yaml
- id: client_store_onboarding
  area: portal_onboarding
  paths:
    - src/app/portal/onboarding/page.tsx
    - src/app/api/shopify/**
    - src/app/api/woocommerce/**
    - src/app/api/squarespace/**
    - src/app/api/discogs/**
    - src/actions/onboarding.ts
  status: pending_build
  checks:
    - OAuth flows complete for all platforms
    - connection_status set to active after OAuth
    - onboarding_completed_at set on wizard completion
    - client redirected to portal after completion

- id: staff_label_creation
  area: admin_fulfillment
  paths:
    - src/app/admin/orders/page.tsx
    - src/actions/fulfillment.ts
    - src/trigger/tasks/create-shipping-label.ts
    - src/trigger/tasks/aftership-register.ts
    - src/trigger/tasks/mark-platform-fulfilled.ts
  status: pending_build
  checks:
    - label created via EasyPost
    - warehouse_shipments row created with label_data.shipTo
    - easypost_labels row created
    - aftership-register fires and customer email sent
    - mark-platform-fulfilled fires (skips Bandcamp orders)
    - bandcamp-mark-shipped picks up Bandcamp-sourced shipments automatically

- id: daily_scan_form
  area: admin_shipping
  paths:
    - src/app/admin/shipping/scan-forms/page.tsx
    - src/actions/scan-forms.ts
    - src/trigger/tasks/generate-scan-form.ts
    - src/lib/clients/easypost-client.ts
  status: pending_build
  checks:
    - unbatched labels for today found
    - EasyPost Batch created and SCAN form generated
    - scan_forms DB row created
    - easypost_labels batch_id updated
    - warehouse_shipments status updated to manifested
    - form PDF URL accessible
```

### `TRUTH_LAYER.md`

No structural changes needed. But the `integrations` domain description must be updated to remove ShipStation and add EasyPost/Discogs when implementation is complete.

---

## PART 6: PROTECTED FEATURE GUARDRAILS

The following must be verified after EACH phase, not just at the end:

### Guardrail Checklist (Run After Each Phase)

```bash
# Static analysis
pnpm check         # Biome lint/format
pnpm typecheck     # TypeScript

# Unit tests
pnpm test

# Build
pnpm build

# E2E audit (must pass 36 routes, 0 page errors)
pnpm test:e2e:full-audit
```

### Feature-Specific Guardrails

| Protected Feature | Guardrail Check |
|---|---|
| Bandcamp → Shopify sync | `bandcamp-sync` task must NOT be in the modified files list. Never import `shopify-client.ts` from new V6 files. |
| Inventory write path | `record-inventory-change.ts` must be read-only — no modifications. |
| Billing | After any warehouse_shipments schema change, verify `billing-calculator.ts` still reads all required fields. |
| Support | `support-escalation.ts` must not be modified. All support actions tested via journey check. |
| Sensor check | After adding new sensor, test that `sensor-check.ts` still runs in < 60 seconds (it runs every 5 min with a 30-second timeout concern). |
| Barcode scanning | `scanning.ts` + `admin/scan/page.tsx` must not be modified. Run `/admin/scan` page check after each phase. |

---

## PART 7: V6 TECHNICAL CORRECTIONS SUMMARY

For the implementing Claude, these are the exact corrections needed in V6 before code is written:

### Correction 1: Add `metadata` to migration and fix all order inserts

```sql
-- Add to V6 Part 2 migration:
ALTER TABLE warehouse_orders ADD COLUMN IF NOT EXISTS metadata jsonb DEFAULT '{}';
CREATE INDEX IF NOT EXISTS idx_orders_metadata ON warehouse_orders USING gin(metadata);
```

Patch `bandcamp-order-sync.ts` insert to include:
```typescript
metadata: { 
  platform_order_id: String(paymentId),
  platform_order_number: `BC-${paymentId}` 
}
```

### Correction 2: Fix `inventory-fanout.ts` Bandcamp query

```typescript
// Change:
.select("id")
// To:
.select("id, variant_id")
```

### Correction 3: Fix Squarespace column name

```typescript
// Change all references in squarespace token refresh:
access_token → api_key
// In UPDATE: change field names accordingly
```

### Correction 4: EasyPost webhook uses wrong `webhook_events` columns

```typescript
// Current (wrong):
.eq('source', 'easypost').eq('event_id', eventId)
{ source: 'easypost', event_id: eventId, event_type: description, payload: body }

// Correct:
.eq('platform', 'easypost').eq('external_webhook_id', eventId)
{ platform: 'easypost', external_webhook_id: eventId, topic: description, metadata: { payload: body }, workspace_id: ... }
```

### Correction 5: Add `maxDuration` to SCAN form task

```typescript
export const generateDailyScanForm = task({
  id: 'generate-daily-scan-form',
  maxDuration: 120,  // ADD THIS
  run: async (payload) => { ... }
});
```

### Correction 6: Fix `pending_manual` filter to use server action pattern

Remove V6's raw Supabase code. Add to `src/actions/orders.ts`:
```typescript
export async function getOrdersWithPendingManual(filters: ...) {
  // JOIN warehouse_orders to warehouse_shipments WHERE status = 'pending_manual'
  // Use requireAuth() + createServiceRoleClient()
}
```

### Correction 7: Add `create-shipping-label` task to `index.ts`

```typescript
// src/trigger/tasks/index.ts — add:
export { createShippingLabelTask } from './create-shipping-label';
export { markPlatformFulfilledTask } from './mark-platform-fulfilled';
export { generateDailyScanForm } from './generate-scan-form';
```

### Correction 8: Add nav item for SCAN Forms

In `src/components/admin/admin-sidebar.tsx`, add to either `NAV_ITEMS` or as a sub-item under Shipping. Suggested approach: add to `NAV_ITEMS` between "Shipping" and "Billing":
```typescript
{ title: "SCAN Forms", href: "/admin/shipping/scan-forms", icon: QrCode }
```

### Correction 9: Add `discogs` to orders page source filter

In `src/app/admin/orders/page.tsx`, update the source filter options:
```typescript
{ label: "Discogs", value: "discogs" }
```

### Correction 10: Add new query key namespaces

In `src/lib/shared/query-keys.ts`:
```typescript
scanForms: {
  all: ["scan-forms"] as const,
  today: (workspaceId: string) => ["scan-forms", "today", workspaceId] as const,
},
fulfillment: {
  taskStatus: (taskId: string) => ["fulfillment", "task", taskId] as const,
  rates: (orderId: string) => ["fulfillment", "rates", orderId] as const,
},
easypostLabels: {
  all: ["easypost-labels"] as const,
  forOrder: (orderId: string) => ["easypost-labels", "order", orderId] as const,
},
```

---

## PART 8: COMPLETE FILE CHANGE MAP (V6 + CORRECTIONS)

### New Files

| File | Phase |
|---|---|
| `src/lib/clients/easypost-client.ts` | 4 |
| `src/lib/clients/discogs-client.ts` | 3 |
| `src/lib/oauth/index.ts` | 1 |
| `src/lib/oauth/discogs-oauth.ts` | 1 |
| `src/trigger/tasks/create-shipping-label.ts` | 4 |
| `src/trigger/tasks/mark-platform-fulfilled.ts` | 4 |
| `src/trigger/tasks/generate-scan-form.ts` | 6 |
| `src/actions/fulfillment.ts` | 4 |
| `src/actions/scan-forms.ts` | 6 |
| `src/actions/onboarding.ts` | 2 |
| `src/app/api/shopify/auth/route.ts` | 1 |
| `src/app/api/shopify/callback/route.ts` | 1 |
| `src/app/api/woocommerce/auth/route.ts` | 1 |
| `src/app/api/woocommerce/callback/route.ts` | 1 |
| `src/app/api/squarespace/auth/route.ts` | 1 |
| `src/app/api/squarespace/callback/route.ts` | 1 |
| `src/app/api/discogs/auth/route.ts` | 1 |
| `src/app/api/discogs/callback/route.ts` | 1 |
| `src/app/api/webhooks/easypost/route.ts` | 4 |
| `src/app/portal/onboarding/page.tsx` | 2 |
| `src/app/admin/shipping/scan-forms/page.tsx` | 6 |
| `src/components/onboarding/` (wizard components) | 2 |
| `src/components/fulfillment/` (label, rate, tracking components) | 5 |

### Files to Modify

| File | Change | Phase |
|---|---|---|
| `src/lib/server/inventory-fanout.ts` | Fix Bandcamp `variant_id` query | 0 |
| `src/lib/clients/aftership-client.ts` | Add `emails[]`, `customer_name` | 0 |
| `src/trigger/tasks/aftership-register.ts` | Join warehouse_orders, pass customer email | 0 |
| `src/trigger/tasks/bandcamp-order-sync.ts` | Add `metadata.platform_order_id` on insert | 0 |
| `src/trigger/tasks/index.ts` | Remove SS tasks, add new tasks | 0 |
| `src/trigger/tasks/sensor-check.ts` | Add `sync.order_detect_stale` sensor | 0 |
| `src/lib/shared/types.ts` | Add `"discogs"` to `StorePlatform`, `OrderSource` | 0 |
| `src/lib/shared/env.ts` | Add new env vars | 0 |
| `src/lib/shared/query-keys.ts` | Add new namespaces | 0 |
| `src/middleware.ts` | Add OAuth callback PUBLIC_PATHS | 0 |
| `src/lib/clients/store-sync-client.ts` | Add Discogs, markFulfilled, Squarespace refresh (fix `access_token` → `api_key`) | 3 |
| `src/trigger/tasks/client-store-order-detect.ts` | Add Discogs + `metadata.platform_order_id` | 3 |
| `src/trigger/tasks/multi-store-inventory-push.ts` | Add Discogs | 3 |
| `src/app/admin/orders/page.tsx` | Add Create Label, pending_manual filter, discogs source | 5 |
| `src/app/portal/layout.tsx` | Add onboarding redirect (via portal home page check) | 2 |
| `src/components/admin/admin-sidebar.tsx` | Add SCAN Forms nav item | 6 |
| `src/app/admin/channels/page.tsx` | Add EasyPost status | 7 |
| `docs/system_map/API_CATALOG.md` | Update routes | each phase |
| `docs/system_map/TRIGGER_TASK_CATALOG.md` | Update tasks | each phase |
| `project_state/engineering_map.yaml` | Add new domains | each phase |
| `project_state/journeys.yaml` | Add new journeys | each phase |

### Files to NOT Touch (Protected)

| File | Reason |
|---|---|
| `src/lib/clients/shopify-client.ts` | Warehouse Shopify master catalog — NEVER |
| `src/trigger/tasks/shopify-sync.ts` | Warehouse catalog sync — NEVER |
| `src/trigger/tasks/shopify-full-backfill.ts` | Warehouse catalog — NEVER |
| `src/trigger/tasks/bandcamp-sync.ts` | Bandcamp → Shopify product creation — NEVER |
| `src/trigger/tasks/bandcamp-sale-poll.ts` | Real-time inventory from Bandcamp sales — NEVER |
| `src/trigger/tasks/bandcamp-inventory-push.ts` | Bandcamp quantity push — NEVER |
| `src/lib/server/record-inventory-change.ts` | Single inventory write path — NEVER |
| `src/trigger/tasks/support-escalation.ts` | Support automation — NEVER |
| `src/trigger/tasks/preorder-fulfillment.ts` | Preorder release — NEVER |
| `src/trigger/tasks/preorder-setup.ts` | Preorder setup — NEVER |
| `src/actions/scanning.ts` | Barcode scanning — NEVER |
| `src/lib/clients/billing-calculator.ts` | Billing math — NEVER |
