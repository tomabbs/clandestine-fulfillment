# Full Shipping + Billing System Audit Report

**Date:** 2026-04-12
**Scope:** Every file touching shipping, orders, billing, and client/org isolation in `clandestine-fulfillment`
**Evidence:** Full source reads of 50+ files, 10 migrations, 7 scripts, 7 test files

---

## Executive Summary

The shipping and billing systems are **architecturally sound** with well-designed data flows, proper org isolation (RLS + app-level), and safe matching logic. However, the audit uncovered **3 red issues**, **6 yellow issues**, and confirmed **18 green areas**. The most critical finding is a potential **storage fee double-count** between `storage-calc` and the billing calculator.

---

## PART 1: SHIPPING SYSTEM VERDICTS

### Trigger Tasks (8 files)

| File | Verdict | Key Findings |
|------|---------|-------------|
| `shipstation-poll.ts` | **YELLOW** | Two-step upsert is solid; `org_id`/`order_id` immutability correctly enforced; ghost-item pruning works. **Issue:** reads `warehouse_orders.shipping_cost` on line 312 — no migration creates this column (see RED-1). |
| `create-shipping-label.ts` | **GREEN** | Correctly sets `label_source: 'easypost'`, copies `bandcamp_payment_id` from order, triggers `aftership-register` + `mark-platform-fulfilled`, inserts `easypost_labels` row. XOR check via `order_id`/`mailorder_id` is correct. |
| `aftership-register.ts` | **GREEN** | Joins `warehouse_orders!order_id(customer_email, customer_name)`, passes `emails` array to `createTracking`. V6 C3 finding is **resolved** — emails are passed on line 45. |
| `bandcamp-mark-shipped.ts` | **GREEN** | Correct query: `bandcamp_payment_id NOT NULL`, `tracking_number NOT NULL`, `bandcamp_synced_at IS NULL`. Sets `bandcamp_synced_at` after success. Uses `bandcampQueue` for serialization. |
| `pirate-ship-import.ts` | **GREEN** | Org matching via `matchOrgByPirateShipName`, creates `warehouse_shipments` + `warehouse_shipment_items`, unmatched go to review queue. Missing: does not set `label_source` (defaults to migration default `'manual'` if hardening migration applied, otherwise NULL). |
| `generate-daily-scan-form.ts` | **GREEN** | Finds unbatched `easypost_labels`, creates SCAN form, marks labels as batched, updates shipment status to `'manifested'`. |
| `mark-platform-fulfilled.ts` | **GREEN** | Correctly skips `bandcamp` and `manual` sources. Reads `metadata.platform_order_id` — requires V6 migration to have added `metadata` column. Implementations for Shopify, WooCommerce, Squarespace, Discogs all present. |
| `monthly-billing.ts` | **GREEN** | Marks included shipments `billed = true` after snapshot persist. Stripe invoice creation is non-blocking (catch). Consignment payouts handled separately. |

### Client Libraries (5 files)

| File | Verdict | Key Findings |
|------|---------|-------------|
| `shipstation.ts` | **GREEN** | Zod schemas for shipments, orders, stores. Rate limiter with 429 retry. `verifyShipStationSignature`/`parseShipNotifyPayload` exist but no webhook route uses them (intentional: poll-only model). |
| `easypost-client.ts` | **GREEN** | `createShipment`, `buyLabel`, `selectBestRate`, `createScanForm`, `verifyAddress`. Media Mail via `special_rates_eligibility`. Asendia carrier account for international. Default parcel dimensions for LP mailers. |
| `easypost-service-map.ts` | **GREEN** | Service normalization and priority mapping for rate selection. |
| `aftership-client.ts` | **GREEN** | `createTracking` correctly includes `emails` in request body when provided (line 104). Uses 2024-07 API with `as-api-key` header. `normalizeCarrierSlug` maps stamps_com/pirateship to USPS. |
| `pirate-ship-parser.ts` | **GREEN** | XLSX parse with `matchOrgByPirateShipName` querying `organizations.pirate_ship_name`. |

### Trigger Lib Helpers (3 files)

| File | Verdict | Key Findings |
|------|---------|-------------|
| `match-shipment-org.ts` | **YELLOW** | 3-tier logic is correct. **Issue:** Tier 1.5 (alias match) requires `storeName` + `workspaceId` params, but `shipstation-poll.ts` calls with only 3 args (`supabase, storeId, itemSkus`), so alias matching is dead code in the poll path. See YELLOW-1. |
| `shipstation-queue.ts` | **GREEN** | Dedicated concurrency-limited queue, separate from bandcampQueue. |
| `format-detection.ts` | **GREEN** | `detectFormat` used by billing calculator for format-based cost lookup. |

### Server Actions (6 files)

| File | Verdict | Key Findings |
|------|---------|-------------|
| `shipping.ts` | **GREEN** | `getShipments` select string includes all hardened columns (`ss_order_number`, `customer_shipping_charged`, `total_units`, `label_source`, `bandcamp_payment_id`, `bandcamp_synced_at`). `getShippingRates` supports Asendia for international. `createOrderLabel` delegates to Trigger task. |
| `shipstation-orders.ts` | **GREEN** | Live ShipStation API read, no DB write, `requireStaff` auth. |
| `orders.ts` | **GREEN** | `getClientShipments` has explicit `org_id` filter via `users.org_id` lookup (defense-in-depth). `getClientOrders`/`getClientOrderDetail` use `requireClient()` + `.eq("org_id", orgId)`. Bandcamp line_items JSONB fallback works correctly when `warehouse_order_items` is empty. |
| `bandcamp-shipping.ts` | **GREEN** | `setBandcampPaymentId` correctly nulls `bandcamp_synced_at` when clearing. `triggerBandcampMarkShipped` validates payment ID and tracking before trigger. Both use `requireStaff`. |
| `pirate-ship.ts` | **GREEN** | `initiateImport`, `getImportHistory`, `getImportDetail` — standard CRUD. |
| `store-mapping.ts` | **GREEN** | `syncStoresFromShipStation`, `autoMatchStores` (with aliases), `reprocessUnmatchedShipments` (SKU majority vote). Uses `requireAuth`. |

### API Routes

| Route | Verdict | Key Findings |
|-------|---------|-------------|
| `webhooks/aftership/route.ts` | **GREEN** | HMAC verification, dedup via `webhook_events`, upserts `warehouse_tracking_events`, updates shipment status. |
| ShipStation webhook route | **N/A** | Intentionally absent. Poll-only model via `shipstation-poll` cron. `verifyShipStationSignature` is available if a webhook route is ever needed. |

---

## PART 2: ORDER-TO-SHIPMENT CONNECTIONS

### Order Sources (5 pipelines)

| Source | Task | `org_id` Resolution | `source` Value | Dedup Key | Verdict |
|--------|------|---------------------|----------------|-----------|---------|
| Bandcamp | `bandcamp-order-sync.ts` | `bandcamp_connections.org_id`, overridden by SKU->product org | `"bandcamp"` | `workspace_id + bandcamp_payment_id` | **GREEN** |
| Shopify (master) | `shopify-order-sync.ts` | SKU->variant->product org; splits multi-org orders | `"shopify"` | `workspace_id + external_order_id` | **GREEN** |
| Client stores (poll) | `client-store-order-detect.ts` | `connection.org_id` | `connection.platform` | `workspace_id + external_order_id + source` | **GREEN** |
| Client stores (webhook) | `process-client-store-webhook.ts` | `connection_id -> client_store_connections.org_id` | `event.platform` | `external_order_id` dedup check | **GREEN** |
| Discogs | `discogs-client-order-sync.ts` | `connection.org_id` | `"discogs"` | `external_order_id` | **GREEN** |

### ShipStation-to-Bandcamp Bridge

```
Bandcamp API
  └─ bandcamp-order-sync ──► warehouse_orders (source=bandcamp, order_number=BC-{paymentId}, bandcamp_payment_id)
                                     ▲
                                     │ order_id FK (auto-linked)
                                     │
ShipStation API                      │
  └─ shipstation-poll ────► warehouse_shipments (shipstation_shipment_id, ss_order_number)
                               │
                               ├─ matchShipmentToOrder Phase 1: normalizeOrderNumber exact match → auto-link
                               ├─ matchShipmentToOrder Phase 2: scoring >= 50 → review queue only
                               │
                               └─ If linked to Bandcamp order: DO NOT auto-mark fulfilled
                                  (bandcamp-order-sync would overwrite back to "unfulfilled")

EasyPost label
  └─ create-shipping-label ─► warehouse_shipments (order_id set directly, bandcamp_payment_id copied)
                               │
                               ├─ aftership-register (tracking + customer email)
                               └─ mark-platform-fulfilled (skips bandcamp, handled by separate cron)

bandcamp-mark-shipped cron
  └─ SELECT WHERE bandcamp_payment_id NOT NULL AND tracking_number NOT NULL AND bandcamp_synced_at IS NULL
  └─ updateShipped API → sets bandcamp_synced_at on success
```

**Matching Logic Audit:**
- `normalizeOrderNumber`: lowercase, strip `bc`/`bandcamp` prefix with `[-\s]*`, remove all non-alphanumeric. Correct.
- Phase 1 ILIKE prefilter + exact normalized equality. Correct — prevents false matches.
- Phase 2 scoring: postal(+30), SKU overlap(+40-55), name(+20), date proximity(+5/+10). Threshold >= 50. Never auto-links. Correct.
- `bandcamp_payment_id` propagation: set by `create-shipping-label` (from order) or manually via `setBandcampPaymentId`. **NOT** set by `shipstation-poll`. This is a known gap — if a ShipStation shipment is auto-linked to a Bandcamp order, `bandcamp_payment_id` is NOT copied to the shipment, so `bandcamp-mark-shipped` will NOT find it. Staff must manually link via `setBandcampPaymentId`. See YELLOW-2.

---

## PART 3: BILLING SYSTEM

### Billing Calculator (`billing-calculator.ts`)

| Aspect | Verdict | Detail |
|--------|---------|--------|
| Period filter | **GREEN** | `ship_date BETWEEN start AND end`, scoped by `workspace_id + org_id` |
| Exclusions | **GREEN** | `voided` -> excluded; `billed` -> excluded; `ship_date IS NULL` -> excluded (separate query) |
| Format detection | **GREEN** | `detectFormat(primaryTitle, primarySku, [], formatRules)` from first item |
| Format costs | **GREEN** | `warehouse_format_costs` by `format_name` -> `pick_pack_cost + material_cost` |
| Drop-ship | **GREEN** | `is_drop_ship`: format pick/pack forced to 0, material still applies. Cost = base + (units-1) * per_item |
| Rate overrides | **GREEN** | `getEffectiveRate` checks `warehouse_billing_rule_overrides` by `(rule_id, org_id)` with `effective_from` ordering |
| Storage | **YELLOW** | Computes inline from inventory vs 6-month shipped quantities. See RED-2 re: double-count. |
| Adjustments | **GREEN** | `warehouse_billing_adjustments` with `snapshot_id IS NULL` for period |
| Consignment | **GREEN** | `calculateConsignmentPayouts` uses `client_payout_amount`, never `total_price` |
| `warehouse_orders` | **GREEN** | NOT queried by billing calculator — billing is shipment-based, not order-based |

### Shipment Fields That Feed Billing

| Field | Usage in Calculator |
|-------|---------------------|
| `ship_date` | Period inclusion filter + exclusion tracking |
| `workspace_id`, `org_id` | Scope |
| `voided` | Exclusion flag |
| `billed` | Exclusion flag (marked true after snapshot) |
| `shipping_cost` | Pass-through to `total_shipping` |
| `is_drop_ship` | Determines pick/pack zeroing + drop-ship cost formula |
| `total_units` | Unit count for drop-ship per-item calculation |
| **NOT used:** `weight`, `dimensions`, `order_id`, `tracking_number` (in snapshot JSON for display only) |

### Monthly Billing Task (`monthly-billing.ts`)

| Aspect | Verdict | Detail |
|--------|---------|--------|
| Cron schedule | **GREEN** | `0 2 1 * *` (1st of month 2 AM ET) |
| Period calculation | **GREEN** | `getPreviousMonthPeriod` correctly handles January rollover |
| Snapshot persist | **GREEN** | Via `persist_billing_snapshot` RPC with row locking |
| Billed flag | **GREEN** | Sets `billed = true` on included shipment IDs after persist |
| Stripe integration | **GREEN** | Non-blocking (catch), `buildStripeLineItems` converts to cents correctly |
| Failure handling | **GREEN** | Per-org try/catch, review queue item on failure, continues to next org |

### Storage Calc Task (`storage-calc.ts`)

| Aspect | Verdict | Detail |
|--------|---------|--------|
| Cron schedule | **GREEN** | `0 1 1 * *` (1st of month 1 AM ET) — 1 hour before billing |
| Org skip logic | **GREEN** | Checks `storage_fee_waived` and `warehouse_grace_period_ends_at` |
| Active stock calc | **GREEN** | 6-month shipped quantities per SKU vs current inventory |
| Output | **YELLOW** | Writes `warehouse_billing_adjustments` with `reason: 'storage_fee'`. See RED-2. |

### Billing Tables (6 tables)

| Table | Migration | Verdict |
|-------|-----------|---------|
| `warehouse_billing_rules` | `20260316000005` | **GREEN** |
| `warehouse_format_costs` | `20260316000005` + `20260318000003` | **GREEN** |
| `warehouse_format_rules` | `20260316000005` | **GREEN** |
| `warehouse_billing_adjustments` | `20260316000005` + FK in `20260316000008` | **GREEN** |
| `warehouse_billing_snapshots` | `20260316000008` | **GREEN** |
| `warehouse_billing_rule_overrides` | `20260318000003` | **YELLOW** — No RLS policies (see YELLOW-3) |

### Billing Actions (`billing.ts`)

| Action | Auth | Verdict |
|--------|------|---------|
| `getBillingRules` | Implicit (user-scoped client) | **GREEN** |
| `updateBillingRule` / `createBillingRule` | Implicit (user-scoped client) | **GREEN** |
| `getFormatCosts` / `updateFormatCost` / `createFormatCost` | Implicit (user-scoped client) | **GREEN** |
| `getBillingSnapshots` / `getBillingSnapshotDetail` | Implicit (user-scoped client) | **GREEN** |
| `getClientBillingSnapshots` | `requireClient()` + `.eq("org_id", orgId)` | **GREEN** |
| `getClientBillingSnapshotDetail` | `requireClient()` + `.eq("org_id", orgId)` | **GREEN** |
| `createBillingAdjustment` | Implicit (user-scoped client) | **GREEN** |
| `getClientOverrides` / `createClientOverride` / `deleteClientOverride` | Implicit (user-scoped client) | **YELLOW** — no `requireStaff()` guard (see YELLOW-4) |

---

## PART 4: CLIENT/ORG ISOLATION

### RLS Policies

| Table | Staff | Client | Verdict |
|-------|-------|--------|---------|
| `warehouse_orders` | `FOR ALL` | `SELECT WHERE org_id = get_user_org_id()` | **GREEN** |
| `warehouse_shipments` | `FOR ALL` | `SELECT WHERE org_id = get_user_org_id()` | **GREEN** |
| `warehouse_tracking_events` | `FOR ALL` | `SELECT via shipment join` | **GREEN** |
| `warehouse_shipment_items` | `FOR ALL` | `SELECT via shipment join` | **GREEN** |
| `warehouse_order_items` | `FOR ALL` | `SELECT via order join` | **GREEN** |
| `warehouse_billing_snapshots` | `FOR ALL` | `SELECT WHERE org_id = get_user_org_id()` | **GREEN** |
| `warehouse_billing_adjustments` | `FOR ALL` | `SELECT WHERE org_id = get_user_org_id()` | **GREEN** |
| `warehouse_billing_rules` | `FOR ALL` | Staff-only (no client policy) | **GREEN** |
| `warehouse_format_costs` | `FOR ALL` | Staff-only | **GREEN** |
| `warehouse_billing_rule_overrides` | **MISSING** | **MISSING** | **YELLOW** (see YELLOW-3) |

### App-Level Org Filtering

| Portal Action | Auth | Org Filter | Verdict |
|---------------|------|------------|---------|
| `getClientOrders` | `requireClient()` | `.eq("org_id", orgId)` via service role | **GREEN** |
| `getClientOrderDetail` | `requireClient()` | `.eq("org_id", orgId)` via service role | **GREEN** |
| `getClientShipments` | User auth + users table lookup | `.eq("org_id", userRecord.org_id)` | **GREEN** |
| `getClientBillingSnapshots` | `requireClient()` | `.eq("org_id", orgId)` via service role | **GREEN** |
| `getClientBillingSnapshotDetail` | `requireClient()` | `.eq("org_id", orgId)` via service role | **GREEN** |

---

## RED ISSUES (3)

### RED-1: `warehouse_orders.shipping_cost` column may not exist

**File:** `shipstation-poll.ts` line 312
**Code:** `.select("shipping_cost, fulfillment_status, source")` from `warehouse_orders`
**Problem:** No migration in the repo creates a `shipping_cost` column on `warehouse_orders`. The base migration (`20260316000004`) has `shipping_cost` on `warehouse_shipments`, not `warehouse_orders`. If this column doesn't exist in the live DB, the select will silently return `null` (PostgREST behavior), which is **functionally safe** (falls back to `ssShippingCharged`), but the code comments suggest Bandcamp's shipping cost should take precedence. If the column DOES exist, it was added via manual SQL.
**Impact:** Medium — billing is not affected (calculator reads `warehouse_shipments.shipping_cost`). Display of `customer_shipping_charged` may be incorrect for auto-linked Bandcamp orders.
**Recommended fix:** Either add the column via migration (`ALTER TABLE warehouse_orders ADD COLUMN shipping_cost numeric;`) or remove the read from `shipstation-poll.ts` and always use `ssShippingCharged`.

### RED-2: Storage fee double-counting risk

**Files:** `storage-calc.ts` + `billing-calculator.ts`
**Problem:** Both compute storage fees using the same methodology (6-month sales vs inventory), but they output to different places:
- `storage-calc.ts` writes `warehouse_billing_adjustments` with `reason: 'storage_fee'`
- `billing-calculator.ts` computes `total_storage` inline and adds it to `grand_total`

The calculator ALSO reads `warehouse_billing_adjustments` (with `snapshot_id IS NULL`) and adds them to `total_adjustments`. If `storage-calc` runs before `monthly-billing` (which it does — 1 AM vs 2 AM), storage is counted **twice**: once in `total_storage` from the calculator's inline computation, and once in `total_adjustments` from the `storage_fee` adjustment row.
**Impact:** HIGH — every client could be double-billed for storage every month.
**Recommended fix:** Either:
  1. Remove the inline storage calculation from `billing-calculator.ts` (let `storage-calc` handle it via adjustments), OR
  2. Filter out `reason = 'storage_fee'` adjustments in the calculator's adjustment query, OR
  3. Remove `storage-calc.ts` entirely and rely on the calculator's inline computation

### RED-3: `shipment_items` query over-fetches in billing calculator

**File:** `billing-calculator.ts` line 182
**Code:** `supabase.from("warehouse_shipment_items").select("*").eq("workspace_id", workspaceId)`
**Problem:** This fetches ALL shipment items for the ENTIRE workspace (all orgs, all time), then filters in memory by `shipment_id`. For a workspace with many orgs and historical data, this could be thousands of unnecessary rows.
**Impact:** Performance — not a correctness bug, but could cause timeouts for large workspaces or hit PostgREST row limits.
**Recommended fix:** Add `.eq("org_id", orgId)` if the column exists on `warehouse_shipment_items` (it doesn't — items inherit org from shipment), OR fetch items only for the specific shipment IDs after the shipments query completes.

---

## YELLOW ISSUES (6)

### YELLOW-1: `matchShipmentOrg` Tier 1.5 (alias matching) is dead code in poll path

**Files:** `match-shipment-org.ts` (defines 5-param signature), `shipstation-poll.ts` (calls with 3 args)
**Problem:** The poll calls `matchShipmentOrg(supabase, storeId, itemSkus)` without `storeName` or `workspaceId`, so the `if (storeName && workspaceId)` guard on line 60 always fails. Alias matching never runs from the poll.
**Impact:** Low — store mapping (Tier 1) and SKU matching (Tier 2) cover most cases. But some orgs may rely on aliases that would have matched.
**Recommended fix:** Pass `storeName` and `workspaceId` from the poll if the ShipStation store name and workspace are available.

### YELLOW-2: ShipStation auto-link does NOT copy `bandcamp_payment_id` to shipment

**File:** `shipstation-poll.ts` lines 320-328
**Problem:** When `matchShipmentToOrder` links a shipment to a Bandcamp order, it sets `order_id` and optionally `customer_shipping_charged`, but does NOT copy `bandcamp_payment_id`. The `bandcamp-mark-shipped` cron finds shipments by `bandcamp_payment_id NOT NULL` — so auto-linked ShipStation shipments for Bandcamp orders will never be pushed to Bandcamp.
**Impact:** Medium — staff must manually call `setBandcampPaymentId` for every ShipStation shipment that fulfills a Bandcamp order. This is a known workflow ("Mark Shipped on Bandcamp" button), but it's a manual step that could be forgotten.
**Recommended fix:** In `shipstation-poll.ts`, after auto-linking to a Bandcamp order, copy `order.bandcamp_payment_id` to the shipment row (same pattern as `create-shipping-label.ts` line 177).

### YELLOW-3: `warehouse_billing_rule_overrides` has no RLS policies

**File:** `20260316000009_rls.sql`
**Problem:** No `ALTER TABLE warehouse_billing_rule_overrides ENABLE ROW LEVEL SECURITY` or policies exist. The table has `workspace_id` and `org_id`, but no RLS.
**Impact:** Low — billing actions use `createServerSupabaseClient()` (user-scoped, so staff-only RLS on other tables provides indirect protection). But if any code path uses this table with a user-scoped client, it could leak cross-org data.
**Recommended fix:** Add staff-only RLS: `ALTER TABLE warehouse_billing_rule_overrides ENABLE ROW LEVEL SECURITY; CREATE POLICY staff_all ON warehouse_billing_rule_overrides FOR ALL TO authenticated USING (is_staff_user()) WITH CHECK (is_staff_user());`

### YELLOW-4: Billing override actions lack explicit `requireStaff()`

**File:** `billing.ts` — `getClientOverrides`, `createClientOverride`, `deleteClientOverride`
**Problem:** These actions use `createServerSupabaseClient()` (user-scoped), which relies on RLS for access control. Since `warehouse_billing_rule_overrides` has NO RLS (see YELLOW-3), any authenticated user could potentially read/write overrides.
**Impact:** Medium — combined with YELLOW-3, a portal client could theoretically modify their own billing rates.
**Recommended fix:** Add `await requireStaff()` to all three functions AND add RLS to the table.

### YELLOW-5: Pirate Ship import does not set `label_source`

**File:** `pirate-ship-import.ts` line 91-117
**Problem:** The `warehouse_shipments` insert does not include `label_source`. If the hardening migration sets `DEFAULT 'manual'` and `NOT NULL`, this is fine. But if the column allows NULL, these shipments will have no `label_source`.
**Impact:** Low — cosmetic issue in the shipping log display.
**Recommended fix:** Add `label_source: 'pirate_ship'` to the insert (the hardening migration CHECK allows `'pirate_ship'`).

### YELLOW-6: `getShipmentDetail` fetches `warehouse_product_variants` twice

**File:** `shipping.ts` lines 189-256
**Problem:** The function queries `warehouse_product_variants` twice — once for format cost lookup (line 189) and once for format name (line 245). These could be combined into a single query.
**Impact:** Performance only, not correctness.
**Recommended fix:** Combine into one query selecting both `format_name` and costs.

---

## GREEN CONFIRMATIONS (18)

| Area | Status |
|------|--------|
| ShipStation poll upsert idempotency | **GREEN** — `ignoreDuplicates: true` on insert, separate mutable-only update |
| org_id/order_id immutability on re-ingest | **GREEN** — explicitly excluded from Step C update |
| Bandcamp fulfillment skip rule | **GREEN** — `source !== "bandcamp"` check on line 336 prevents auto-marking |
| normalizeOrderNumber logic | **GREEN** — strips BC prefix, lowercases, removes non-alphanumeric |
| Phase 2 scoring never auto-links | **GREEN** — always returns null, only writes review queue |
| AfterShip emails param | **GREEN** — passed on line 45 of `aftership-register.ts` and line 104 of `aftership-client.ts` |
| EasyPost label_source | **GREEN** — set to `'easypost'` on line 165 of `create-shipping-label.ts` |
| Bandcamp mark-shipped query | **GREEN** — correct 3-condition filter with `bandcamp_synced_at` null check |
| Monthly billing billed flag | **GREEN** — sets `billed = true` on included shipment IDs after snapshot |
| Billing rate override resolution | **GREEN** — two-tier lookup with `effective_from` ordering |
| Drop-ship cost formula | **GREEN** — base + max(units-1, 0) * per_item, format pick/pack zeroed |
| Portal orders org isolation | **GREEN** — `requireClient()` + `.eq("org_id", orgId)` |
| Portal shipments org isolation | **GREEN** — users.org_id lookup + `.eq("org_id", userRecord.org_id)` |
| Portal billing org isolation | **GREEN** — `requireClient()` + `.eq("org_id", orgId)` |
| RLS on warehouse_orders | **GREEN** — staff all, client select by org_id |
| RLS on warehouse_shipments | **GREEN** — staff all, client select by org_id |
| RLS on warehouse_billing_snapshots | **GREEN** — staff all, client select by org_id |
| Billing snapshot immutability | **GREEN** — persist via RPC, adjustments go to separate table |

---

## FULL FILE INVENTORY

### Shipping System Files (50+)

**Trigger Tasks:** `shipstation-poll.ts`, `create-shipping-label.ts`, `aftership-register.ts`, `bandcamp-mark-shipped.ts`, `pirate-ship-import.ts`, `generate-daily-scan-form.ts`, `mark-platform-fulfilled.ts`, `monthly-billing.ts`, `storage-calc.ts`

**Trigger Lib:** `match-shipment-org.ts`, `shipstation-queue.ts`, `bandcamp-queue.ts`, `format-detection.ts`

**Client Libraries:** `shipstation.ts`, `easypost-client.ts`, `easypost-service-map.ts`, `aftership-client.ts`, `pirate-ship-parser.ts`, `billing-calculator.ts`, `stripe-client.ts`, `format-detector.ts`

**Server Actions:** `shipping.ts`, `shipstation-orders.ts`, `orders.ts`, `bandcamp-shipping.ts`, `pirate-ship.ts`, `store-mapping.ts`, `billing.ts`, `clients.ts`, `organizations.ts`, `admin-dashboard.ts`

**API Routes:** `webhooks/aftership/route.ts`

**UI Pages:** `admin/shipping/page.tsx`, `admin/shipping/pirate-ship/page.tsx`, `admin/shipstation-orders/page.tsx`, `admin/settings/store-mapping/page.tsx`, `admin/orders/page.tsx`, `admin/billing/page.tsx`, `portal/shipping/page.tsx`, `portal/fulfillment/page.tsx`, `portal/orders/page.tsx`, `portal/billing/page.tsx`

**Shared Components:** `tracking-timeline.tsx`, `admin-sidebar.tsx`, `portal-sidebar.tsx`

**Migrations (shipping/billing):** `20260316000004_orders.sql`, `20260316000005_supporting.sql`, `20260316000008_monitoring.sql`, `20260316000009_rls.sql`, `20260318000003_billing_client_overrides.sql`, `20260318000004_drop_ship.sql`, `20260319000003_organization_aliases.sql`, `20260320000008_bandcamp_shipment_tracking.sql`, `20260325000001_v72_schema_updates.sql`, `20260402000001_shipments_hardening.sql`, `20260411000000_pirate_ship_storage.sql`

**Scripts:** `backfill-shipments.ts`, `backfill-shipment-items.ts`, `backfill-bandcamp-orders.mjs`, `dedup-shipments.sql`, `trigger-sync.ts`, `poll-sync.ts`, `seed-dev-data.ts`

**Tests:** `shipping.test.ts`, `shipstation-orders.test.ts`, `bandcamp-shipping.test.ts`, `pirate-ship.test.ts`, `aftership-client.test.ts`, `pirate-ship-parser.test.ts`, `pirate-ship-sample.ts`

---

## RECOMMENDED PRIORITY ORDER

1. **RED-2** (storage double-count) — Fix immediately; affects every monthly billing run
2. **YELLOW-3 + YELLOW-4** (billing overrides RLS + auth) — Security gap, fix together
3. **RED-1** (shipping_cost column) — Verify in live DB; add migration or remove read
4. **RED-3** (items over-fetch) — Performance fix for billing calculator
5. **YELLOW-2** (auto-copy bandcamp_payment_id) — Workflow improvement
6. **YELLOW-1** (alias matching dead code) — Low priority unless orgs rely on aliases
7. **YELLOW-5** (pirate ship label_source) — Cosmetic
8. **YELLOW-6** (double variant query) — Performance optimization
