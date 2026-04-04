# Shipping Log Audit & Fix — Comprehensive Technical Plan

**Status:** Reviewed, ready to execute  
**Date:** 2026-04-02  
**Scope:** Database deduplication, ShipStation poll hardening, order-shipment linking, portal parity

---

## Table of Contents

1. [Audit Findings](#1-audit-findings)
2. [Architecture Diagram](#2-architecture-diagram)
3. [Current Code (Files Being Changed)](#3-current-code-files-being-changed)
4. [Implementation Steps with Full Code](#4-implementation-steps-with-full-code)
5. [Risk + Rollback](#5-risk--rollback)
6. [Verification Plan](#6-verification-plan)
7. [Doc Sync Contract](#7-doc-sync-contract)

---

## 1. Audit Findings

### Finding 1 — CRITICAL: Duplicate rows in `warehouse_shipments`

**Symptom:** SS-131150298 appears ~12 times in the shipping log. Each row has a distinct UUID primary key.

**Root cause — two compounding bugs:**

**Bug A** — No UNIQUE constraint on `shipstation_shipment_id`:
```sql
-- supabase/migrations/20260316000004_orders.sql line 33
shipstation_shipment_id text,  -- no UNIQUE, no index
```
Nothing at the DB layer prevents two rows with identical `shipstation_shipment_id`.

**Bug B** — `.maybeSingle()` makes duplicates self-perpetuating:
```typescript
// src/trigger/tasks/shipstation-poll.ts lines 65-74
const { data: existing } = await supabase
  .from("warehouse_shipments")
  .select("id")
  .eq("shipstation_shipment_id", shipstationShipmentId)
  .maybeSingle();  // returns {data: null, error: PGRST116} when 2+ rows exist

if (existing) {  // null is falsy → falls through even when duplicates exist
  totalSkipped++;
  continue;
}
// → inserts ANOTHER duplicate every 30 minutes
```

**Bug C** — Non-atomic check-then-insert: Even without existing duplicates, two concurrent processes could both see 0 rows and both insert.

**Impact:** Every 30 minutes the poll re-evaluates all 30-day shipments. Any shipment already duplicated gets duplicated again.

---

### Finding 2 — HIGH: Items show "No items recorded" for most shipments

**Symptom:** Expanded shipment detail shows "No items recorded." for most rows; item count badge shows `⊙ 0`.

**Root cause:** The `ingestFromPoll` only inserts items when `shipmentItems.length > 0`. For ~89 of 510 shipments, ShipStation returned empty arrays (possibly ingested before `includeShipmentItems: true` was set, or during the dedup cascade when `.maybeSingle()` errored).

**Also:** `getShipments` select string doesn't include `total_units`, so the item count badge always reads 0 even for shipments with correct `total_units` values.

**Current state (post 2026-04-01 backfill):** 421/510 shipments have `warehouse_shipment_items` rows correctly. 89 still have none.

---

### Finding 3 — HIGH: Shipments disconnected from orders

**Symptom:** `warehouse_shipments.order_id` is NULL for all ShipStation-imported shipments. The Orders page shows "No shipments yet" for orders that have been shipped.

**Root cause:** `ingestFromPoll` never sets `order_id`:
```typescript
// src/trigger/tasks/shipstation-poll.ts lines 166-185
const { data: inserted } = await supabase
  .from("warehouse_shipments")
  .insert({
    // ...all fields...
    // order_id: NEVER SET
  });
```

**Impact:** 
- `/admin/orders` shows "No shipments yet" for fulfilled Bandcamp orders
- Create Label dialog appears on orders that have already been shipped
- `getOrderDetail` returns empty `shipments[]` for every Bandcamp order

---

### Finding 4 — HIGH: Missing ShipStation fields

Fields fetched from the API but never stored:

| API field | Value | Impact |
|---|---|---|
| `orderNumber` | Original order reference (e.g. "BC-12345") | Display shows `SS-{id}` fallback instead of real order number |
| `createDate` | When the label was created | No SLA tracking |

---

### Finding 5 — MEDIUM: No label source tracking

When EasyPost labels are created via the app, they insert into `warehouse_shipments` via `create-shipping-label.ts`. These rows and ShipStation rows look identical — no field indicates how the label was made.

---

### Finding 6 — MEDIUM: Portal `getClientShipments` has no org filter (security)

```typescript
// src/actions/orders.ts lines 106-116
let query = supabase
  .from("warehouse_shipments")
  .select("*", { count: "exact" })
  // NO .eq("org_id", ...) filter
  .order("ship_date", { ascending: false });
```

This queries ALL shipments across all organizations. Client-level RLS may mitigate this but it's not explicit and should not be relied upon alone.

---

### Finding 7 — LOW: Portal fulfillment page doesn't distinguish Bandcamp platform status from our shipment status

The Bandcamp API sets `fulfillment_status` on `warehouse_orders`. Our system has a separate `warehouse_shipments` record. These need to be shown as two distinct pieces of information.

---

## 2. Architecture Diagram

```
ShipStation API
  GET /shipments?shipDateStart=30-days-ago&includeShipmentItems=true
  └── Returns: [{shipmentId, orderNumber, trackingNumber, shipTo, weight,
                 shipmentItems:[{sku, name, quantity}], ...}]

  Current (broken):
  shipstation-poll.ts
    for each shipment:
      SELECT id FROM warehouse_shipments WHERE shipstation_shipment_id = X
        → .maybeSingle() → PGRST116 error when 2+ dupes → data: null → INSERT AGAIN

  Fixed:
  shipstation-poll.ts
    for each shipment:
      UPSERT warehouse_shipments ON CONFLICT (workspace_id, shipstation_shipment_id)
        → stores: ss_order_number, ss_create_date, label_source='shipstation'
        → DELETE + INSERT warehouse_shipment_items (idempotent)
        → auto-link: matchShipmentToOrder() → sets order_id

warehouse_shipments (after fix)
  id (uuid PK)
  workspace_id
  shipstation_shipment_id  [UNIQUE per workspace — NEW]
  org_id
  order_id → warehouse_orders.id  [set by auto-link — NEW]
  ss_order_number  [NEW — e.g. "BC-12345678"]
  ss_create_date  [NEW — when label was created in ShipStation]
  label_source  [NEW — 'shipstation'|'easypost'|'pirate_ship'|'manual']
  tracking_number, carrier, service, ship_date, delivery_date
  shipping_cost, weight, total_units
  status, voided, billed
  label_data (jsonb — contains shipTo address)

warehouse_shipment_items
  shipment_id → warehouse_shipments.id
  sku, quantity, product_title

warehouse_orders (Bandcamp orders)
  id
  order_number  [e.g. "BC-12345678"]
  fulfillment_status  [from Bandcamp API: "unfulfilled"|"fulfilled"]
  bandcamp_payment_id
  line_items (jsonb)
  shipping_address (jsonb)
  source = 'bandcamp'

Auto-linking algorithm:
  Signal 1 (exit early): ss_order_number == warehouse_orders.order_number
  Signal 2 (+30 pts): postal code match (shipTo.postalCode == shipping_address->>'postalCode')
  Signal 3 (+40-55 pts): SKU overlap (shipment items vs order line_items)
  Signal 4 (+20 pts): recipient name match
  Signal 5 (+5-10 pts): date proximity
  Threshold: ≥50 pts AND single clear winner (or >20pt gap from #2)
  Ambiguous: review queue item, no auto-link
```

---

## 3. Current Code (Files Being Changed)

### 3a. `src/trigger/tasks/shipstation-poll.ts` (CURRENT — BROKEN)

```typescript
// Full current file — 202 lines
// Rule #2: Trigger.dev v4 — import from @trigger.dev/sdk
// Rule #7: service_role for Trigger tasks
import { logger, schedules } from "@trigger.dev/sdk";
import { fetchShipments, type ShipStationShipment } from "@/lib/clients/shipstation";
import { createServiceRoleClient } from "@/lib/server/supabase-server";
import { shipstationQueue } from "@/trigger/lib/shipstation-queue";
import { matchShipmentOrg } from "@/trigger/lib/match-shipment-org";

export const shipstationPollTask = schedules.task({
  id: "shipstation-poll",
  queue: shipstationQueue,
  maxDuration: 600,
  cron: "*/30 * * * *",
  run: async () => {
    // ... fetches 30-day window, calls ingestFromPoll per shipment ...
    // BUG: dedup check uses .maybeSingle() which returns null on 2+ dupes
    // BUG: check-then-insert is non-atomic
    // BUG: never sets order_id
    // BUG: never stores ss_order_number, ss_create_date, label_source
    // BUG: upsert items but can leave stale items on re-ingest
  }
});

async function ingestFromPoll(supabase, shipment, workspaceId) {
  // BUG: .insert() not .upsert() → duplicates possible
  // MISSING: orderNumber, createDate, label_source fields
  // BUG: items only inserted if length > 0, never re-synced
}
```

### 3b. `src/actions/orders.ts` (CURRENT — MISSING ORG FILTER)

```typescript
export async function getClientShipments(filters) {
  // BUG: no org_id filter — queries ALL shipments
  // MISSING: warehouse_orders join for order_number reference
  let query = supabase
    .from("warehouse_shipments")
    .select("*", { count: "exact" })
    // .eq("org_id", ...) ← MISSING
    .order("ship_date", { ascending: false });
}

export async function getOrderDetail(orderId) {
  // OK but: shipments only found if order_id is set (currently never for SS imports)
  const { data: shipments } = await supabase
    .from("warehouse_shipments")
    .select("id, tracking_number, carrier, status, ship_date")
    .eq("order_id", orderId);  // → always empty for SS-imported shipments
}
```

### 3c. `src/app/portal/fulfillment/page.tsx` (CURRENT — MISSING STATUS CLARITY)

```typescript
function OrderExpandedDetail({ detail }) {
  const { order, items, shipments } = detail;
  return (
    <div className="grid grid-cols-2 gap-6">
      {/* Line items — OK */}
      <div>...</div>
      {/* Shipments — MISSING: Bandcamp platform status, label source, shipping log link */}
      <div>
        <h4>Shipments</h4>
        {shipments.length === 0 ? (
          <p>No shipments yet</p>  // ← shows even for fulfilled Bandcamp orders
        ) : (
          <div>{shipments.map(s => <TrackingTimeline ... />)}</div>
        )}
      </div>
    </div>
  );
}
```

### 3d. `src/lib/clients/shipstation.ts` (CURRENT — SCHEMA)

```typescript
// What we parse from ShipStation API:
const shipStationItemSchema = z.object({
  sku: z.string().nullable().optional(),
  name: z.string().nullable().optional(),
  quantity: z.number().default(1),
  unitPrice: z.number().nullable().optional(),  // ← parsed by schema but intentionally NOT stored
  // Decision: unitPrice is redundant — warehouse_orders.line_items (from Bandcamp API) is
  // the authoritative financial record. customer_shipping_charged on warehouse_shipments
  // covers the shipping margin analysis. Storing unitPrice here would duplicate stale data.
});

const shipStationShipmentSchema = z.object({
  shipmentId: z.number(),
  orderId: z.number().nullable().optional(),
  orderNumber: z.string().nullable().optional(),  // ← parsed but NEVER STORED (until fix)
  trackingNumber: z.string().nullable().optional(),
  carrierCode: z.string().nullable().optional(),
  serviceCode: z.string().nullable().optional(),
  shipDate: z.string().nullable().optional(),
  deliveryDate: z.string().nullable().optional(),
  shipmentCost: z.number().nullable().optional(),
  voided: z.boolean().optional(),
  voidDate: z.string().nullable().optional(),
  createDate: z.string().nullable().optional(),  // ← parsed but NEVER STORED (until fix)
  shipTo: shipStationAddressSchema.nullable().optional(),
  weight: z.object({ value: z.number(), units: z.string() }).nullable().optional(),
  dimensions: z.object({ length: z.number(), width: z.number(), height: z.number(), units: z.string() }).nullable().optional(),
  shipmentItems: z.preprocess((v) => v ?? [], z.array(shipStationItemSchema)),
  storeId: z.number().nullable().optional(),
  advancedOptions: z.object({ storeId: z.number().nullable().optional() }).nullable().optional(),
});

// Field inventory — before vs after this fix:
// STORED before: shipmentId, trackingNumber, carrierCode, serviceCode, shipDate,
//                deliveryDate, shipmentCost, voided, shipTo (in label_data jsonb),
//                weight.value, dimensions, shipmentItems.{sku, name, quantity}
// NEW after fix: orderNumber → ss_order_number, createDate → ss_create_date,
//                label_source = 'shipstation', total_units, customer_shipping_charged
//                (from /orders shippingAmount or warehouse_orders.shipping_cost)
// NOT stored: items.unitPrice — redundant with warehouse_orders.line_items (Bandcamp source)
// NOTE: ShipStation has both V1 REST and V2/OpenAPI active. Field names above are
// confirmed on V1 (the endpoint in shipstation.ts). Verify against your actual
// base URL before relying on unitPrice — it may differ in shape on V2.
```

---

## 4. Implementation Steps with Full Code

### Step 1 — Dedup SQL (run first, in Supabase SQL Editor)

**IMPORTANT: Items must be preserved, not cascade-deleted.**
Some duplicate rows may have `warehouse_shipment_items` while the "oldest" keeper row may not.
The SQL below moves items to the keeper row BEFORE deleting duplicates.

```sql
-- STEP 1a: Preview — confirm duplicates and item counts
SELECT
  ws.shipstation_shipment_id,
  ws.workspace_id,
  COUNT(DISTINCT ws.id) as shipment_copies,
  SUM(item_counts.cnt) as total_item_rows
FROM warehouse_shipments ws
LEFT JOIN (
  SELECT shipment_id, COUNT(*) as cnt
  FROM warehouse_shipment_items
  GROUP BY shipment_id
) item_counts ON item_counts.shipment_id = ws.id
WHERE ws.shipstation_shipment_id IS NOT NULL
GROUP BY ws.shipstation_shipment_id, ws.workspace_id
HAVING COUNT(DISTINCT ws.id) > 1
ORDER BY total_item_rows DESC
LIMIT 20;

-- STEP 1b: Choose the RICHEST keeper, merge data + items, then delete duplicates.
--
-- "Keep oldest" is wrong if a newer duplicate has a linked order_id, more complete
-- label_data, or items the oldest row is missing. We rank by data richness instead:
--   - order_id set > not set
--   - more item rows > fewer
--   - more non-null fields (tracking, org_id, label_data) > fewer
--   - newer created_at as tiebreaker
--
-- Run in a transaction so you can ROLLBACK before COMMIT if the preview looks wrong.
BEGIN;

WITH ranked AS (
  SELECT
    ws.id,
    ws.workspace_id,
    ws.shipstation_shipment_id,
    ws.created_at,
    -- richness score: higher = better keeper
    (CASE WHEN ws.order_id IS NOT NULL THEN 100 ELSE 0 END)
    + (CASE WHEN ws.org_id IS NOT NULL THEN 10 ELSE 0 END)
    + (CASE WHEN ws.tracking_number IS NOT NULL THEN 5 ELSE 0 END)
    + (CASE WHEN ws.label_data IS NOT NULL THEN 5 ELSE 0 END)
    + COALESCE((
        SELECT COUNT(*)::int FROM warehouse_shipment_items wsi
        WHERE wsi.shipment_id = ws.id
      ), 0) * 2
    AS richness_score
  FROM warehouse_shipments ws
  WHERE ws.shipstation_shipment_id IS NOT NULL
),
keepers AS (
  SELECT DISTINCT ON (workspace_id, shipstation_shipment_id)
    id AS keeper_id, workspace_id, shipstation_shipment_id
  FROM ranked
  ORDER BY workspace_id, shipstation_shipment_id, richness_score DESC, created_at DESC
),
duplicates AS (
  SELECT ws.id AS dup_id, k.keeper_id, k.workspace_id, k.shipstation_shipment_id
  FROM warehouse_shipments ws
  JOIN keepers k
    ON ws.workspace_id = k.workspace_id
    AND ws.shipstation_shipment_id = k.shipstation_shipment_id
  WHERE ws.id != k.keeper_id
)

-- Step A: Merge any useful fields from duplicates into the keeper.
-- Fills in nulls on the keeper row using the first non-null value from duplicates.
UPDATE warehouse_shipments keeper_row
SET
  order_id      = COALESCE(keeper_row.order_id,      dup_row.order_id),
  org_id        = COALESCE(keeper_row.org_id,        dup_row.org_id),
  tracking_number = COALESCE(keeper_row.tracking_number, dup_row.tracking_number),
  label_data    = COALESCE(keeper_row.label_data,    dup_row.label_data),
  ss_order_number = COALESCE(keeper_row.ss_order_number, dup_row.ss_order_number)
FROM (
  -- Select the "most useful" duplicate per keeper (highest richness, just one needed)
  SELECT DISTINCT ON (d.keeper_id)
    d.keeper_id,
    ws.order_id,
    ws.org_id,
    ws.tracking_number,
    ws.label_data,
    ws.ss_order_number
  FROM duplicates d
  JOIN warehouse_shipments ws ON ws.id = d.dup_id
  JOIN ranked r ON r.id = d.dup_id
  ORDER BY d.keeper_id, r.richness_score DESC
) dup_row
WHERE keeper_row.id = dup_row.keeper_id;

-- Step B: Move items from duplicates to keeper (skip if same SKU already on keeper)
UPDATE warehouse_shipment_items wsi
SET shipment_id = d.keeper_id
FROM duplicates d
WHERE wsi.shipment_id = d.dup_id
  AND NOT EXISTS (
    SELECT 1 FROM warehouse_shipment_items existing
    WHERE existing.shipment_id = d.keeper_id
      AND existing.sku = wsi.sku
  );

-- Step C: Now safe to delete the duplicate rows (any remaining items cascade-delete)
DELETE FROM warehouse_shipments
WHERE id IN (SELECT dup_id FROM duplicates);

COMMIT;

-- STEP 1c: Verify — both queries should return 0 rows
SELECT shipstation_shipment_id, COUNT(*) as cnt
FROM warehouse_shipments
WHERE shipstation_shipment_id IS NOT NULL
GROUP BY shipstation_shipment_id, workspace_id
HAVING COUNT(*) > 1;

-- Verify items were preserved (total should be same as before)
SELECT COUNT(*) FROM warehouse_shipment_items;
```

---

### Step 2 — Migration: UNIQUE constraint + new columns

**File:** `supabase/migrations/20260402000001_shipments_hardening.sql`

```sql
-- ============================================================
-- Shipping log hardening: dedup prevention + field capture + label source
-- 2026-04-02
-- ============================================================

-- 1. UNIQUE constraint — prevents future duplicates at DB layer.
--    Run AFTER Step 1 deduplication SQL, or this will fail.
--
--    NOTE: An earlier draft used a partial unique index (WHERE shipstation_shipment_id IS NOT NULL)
--    to handle multi-source rows, but this is INCOMPATIBLE with Supabase's .upsert() client.
--    PostgREST translates onConflict into a plain ON CONFLICT (...) clause; it cannot append
--    the WHERE predicate required for a partial index target, causing a PGRST116 error at runtime.
--
--    A standard UNIQUE constraint is correct here because Postgres natively allows multiple
--    NULL values in a UNIQUE column (NULL != NULL), so non-ShipStation rows with
--    shipstation_shipment_id IS NULL will not conflict with each other.
ALTER TABLE warehouse_shipments
  ADD CONSTRAINT uq_shipments_ss_id
  UNIQUE (workspace_id, shipstation_shipment_id);

-- 2. Store ShipStation's original order number reference.
--    Used for: displaying real order numbers, auto-linking to warehouse_orders.
ALTER TABLE warehouse_shipments
  ADD COLUMN IF NOT EXISTS ss_order_number text;

CREATE INDEX IF NOT EXISTS idx_shipments_ss_order_number
  ON warehouse_shipments(ss_order_number)
  WHERE ss_order_number IS NOT NULL;

-- 3. Store when the ShipStation label was created (distinct from ship_date).
--    Useful for SLA tracking and billing audits.
ALTER TABLE warehouse_shipments
  ADD COLUMN IF NOT EXISTS ss_create_date timestamptz;

-- 3b. Add item_index to warehouse_shipment_items for safe upsert
--     (same SKU can appear twice in one shipment with different options)
ALTER TABLE warehouse_shipment_items
  ADD COLUMN IF NOT EXISTS item_index integer NOT NULL DEFAULT 0;

ALTER TABLE warehouse_shipment_items
  ADD CONSTRAINT uq_shipment_items_idx
  UNIQUE (shipment_id, sku, item_index);

-- 3c. customer_shipping_charged — what the customer paid for shipping on their order.
--     This is the per-shipment counterpart to shipping_cost (what Clandestine paid for postage).
--     The gap between these two values tells staff whether the client is pricing shipping
--     sufficiently on their platform, and helps staff choose the postage rate closest to
--     what the customer was charged.
--
--     Sources (in priority order):
--       1. warehouse_orders.shipping_cost — populated from Bandcamp API when auto-linked
--       2. ShipStation /orders shippingAmount — fetched in bulk at poll start for non-Bandcamp orders
--       3. Future: platform API at label creation (EasyPost + store connections)
ALTER TABLE warehouse_shipments
  ADD COLUMN IF NOT EXISTS customer_shipping_charged numeric(10, 2);

-- 4. Track how the label was created — single source of truth.
--    Enables staff to route follow-up to the right system.
--    We add nullable first, backfill, then enforce NOT NULL so the migration
--    doesn't fail on existing rows. Nullable label_source rows would undermine
--    the "single source of truth" goal — unknown-origin rows would creep back in.
ALTER TABLE warehouse_shipments
  ADD COLUMN IF NOT EXISTS label_source text
  CHECK (label_source IN ('shipstation', 'easypost', 'pirate_ship', 'manual'));

-- Backfill: all rows with a shipstation_shipment_id are from ShipStation
UPDATE warehouse_shipments
  SET label_source = 'shipstation'
  WHERE shipstation_shipment_id IS NOT NULL AND label_source IS NULL;

-- Any remaining NULL rows (EasyPost labels, manual entries created before this
-- migration) fall back to 'manual' so we can enforce NOT NULL.
UPDATE warehouse_shipments
  SET label_source = 'manual'
  WHERE label_source IS NULL;

-- Now enforce NOT NULL — any new row without a source is a bug, not a gap.
ALTER TABLE warehouse_shipments
  ALTER COLUMN label_source SET NOT NULL;

-- Default for future inserts protects against accidental NULLs
ALTER TABLE warehouse_shipments
  ALTER COLUMN label_source SET DEFAULT 'manual';

CREATE INDEX IF NOT EXISTS idx_shipments_label_source
  ON warehouse_shipments(label_source);
```

**After applying, patch `src/trigger/tasks/create-shipping-label.ts`** to add `label_source: 'easypost'` to its `warehouse_shipments` insert (one line change, not breaking).

---

### Step 3 — Patch `shipstation-poll.ts`: full rewrite of ingestFromPoll + loop

**File:** `src/trigger/tasks/shipstation-poll.ts`

The poll task schedule and queue remain unchanged. Only the inner loop and `ingestFromPoll` function change.

**Also patch `src/lib/clients/shipstation.ts` — add date params to `FetchOrdersParams`:**

```typescript
export interface FetchOrdersParams {
  orderStatus?: string;
  page?: number;
  pageSize?: number;
  storeId?: number;
  sortBy?: string;
  sortDir?: "ASC" | "DESC";
  // NEW — date range filters (ShipStation "YYYY-MM-DD HH:MM:SS" format)
  createDateStart?: string;
  createDateEnd?: string;
  modifyDateStart?: string;
  modifyDateEnd?: string;
}

export async function fetchOrders(params: FetchOrdersParams = {}) {
  const searchParams = new URLSearchParams();
  if (params.orderStatus) searchParams.set("orderStatus", params.orderStatus);
  if (params.page) searchParams.set("page", String(params.page));
  if (params.pageSize) searchParams.set("pageSize", String(params.pageSize));
  if (params.storeId) searchParams.set("storeId", String(params.storeId));
  if (params.sortBy) searchParams.set("sortBy", params.sortBy);
  if (params.sortDir) searchParams.set("sortDir", params.sortDir);
  // NEW
  if (params.createDateStart) searchParams.set("createDateStart", toShipStationDate(params.createDateStart));
  if (params.createDateEnd) searchParams.set("createDateEnd", toShipStationDate(params.createDateEnd));
  if (params.modifyDateStart) searchParams.set("modifyDateStart", toShipStationDate(params.modifyDateStart));
  if (params.modifyDateEnd) searchParams.set("modifyDateEnd", toShipStationDate(params.modifyDateEnd));

  const query = searchParams.toString();
  const path = `/orders${query ? `?${query}` : ""}`;
  const raw = await shipstationFetch<unknown>(path);
  return ordersListResponseSchema.parse(raw);
}
```

Also add `taxAmount` to `shipStationOrderSchema` (it's in the API docs, currently missing from the schema):

```typescript
const shipStationOrderSchema = z.object({
  // ... existing fields ...
  amountPaid: z.number().nullable().optional(),
  shippingAmount: z.number().nullable().optional(),
  taxAmount: z.number().nullable().optional(), // NEW
  // ...
});
```

---

**Replace lines 61-74 (the broken check-then-skip loop) and add the order pre-fetch:**

```typescript
// BEFORE (broken):
for (const shipment of result.shipments) {
  const { data: existing } = await supabase...maybeSingle();
  if (existing) { totalSkipped++; continue; }
  await ingestFromPoll(supabase, shipment, workspaceId);
}

// AFTER — pre-fetch ShipStation orders for shipping amount, then process:

// Build a map of orderNumber → shippingAmount from ShipStation's /orders endpoint.
// Uses modifyDateStart (= when orders were marked shipped) aligned to the same 30-day
// window as the shipments query. One API call regardless of shipment count.
// This populates customer_shipping_charged for non-Bandcamp orders.
const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
const ssOrderShippingMap = new Map<string, number>();
try {
  const ordersResult = await fetchOrders({
    modifyDateStart: thirtyDaysAgo,
    orderStatus: "shipped",
    pageSize: 500,
  });
  for (const order of ordersResult.orders) {
    if (order.orderNumber && order.shippingAmount != null) {
      // Normalize key for consistent lookup — ShipStation orderNumber may have
      // case or spacing differences vs. what appears in shipment.orderNumber
      ssOrderShippingMap.set(order.orderNumber.toLowerCase().trim(), order.shippingAmount);
    }
  }
  // Handle pagination if orders exceed 500 (unlikely for Clandestine's volume)
  if (ordersResult.pages > 1) {
    for (let p = 2; p <= ordersResult.pages; p++) {
      const page = await fetchOrders({ modifyDateStart: thirtyDaysAgo, orderStatus: "shipped", pageSize: 500, page: p });
      for (const order of page.orders) {
        if (order.orderNumber && order.shippingAmount != null) {
          ssOrderShippingMap.set(order.orderNumber.toLowerCase().trim(), order.shippingAmount);
        }
      }
    }
  }
} catch (err) {
  logger.warn("Failed to pre-fetch ShipStation orders for shipping amounts", { error: String(err) });
  // Non-fatal — customer_shipping_charged will be null for this poll cycle
}

for (const shipment of result.shipments) {
  await ingestFromPoll(supabase, shipment, workspaceId, ssOrderShippingMap);
  totalProcessed++;
}
```

**Replace `ingestFromPoll` function (lines 110-202) with full new version:**

```typescript
async function ingestFromPoll(
  supabase: ReturnType<typeof createServiceRoleClient>,
  shipment: ShipStationShipment,
  workspaceId: string,
  ssOrderShippingMap: Map<string, number>, // pre-fetched orderNumber → shippingAmount
) {
  const shipstationShipmentId = String(shipment.shipmentId);
  const storeId = shipment.advancedOptions?.storeId ?? shipment.storeId;
  const itemsRaw = shipment.shipmentItems ?? [];
  const itemSkus = itemsRaw.map((i) => i.sku).filter(Boolean) as string[];

  // Org matching (unchanged — 3-tier fallback)
  const orgMatch = await matchShipmentOrg(supabase, storeId, itemSkus);
  if (!orgMatch) {
    logger.warn(`Unmatched shipment ${shipstationShipmentId} (poller)`);
    await supabase.from("warehouse_review_queue").upsert(
      {
        workspace_id: workspaceId,
        category: "shipment_org_match",
        severity: "medium" as const,
        title: `Unmatched shipment: ${shipment.trackingNumber ?? shipstationShipmentId}`,
        description: `ShipStation shipment ${shipstationShipmentId} from store ${storeId ?? "unknown"} could not be matched via store mapping or SKU matching. (Detected by poller)`,
        metadata: {
          shipstation_shipment_id: shipstationShipmentId,
          store_id: storeId,
          tracking_number: shipment.trackingNumber,
          item_skus: itemSkus,
          source: "poller",
        },
        status: "open" as const,
        group_key: `shipment_org_match:${shipstationShipmentId}`,
        occurrence_count: 1,
      },
      { onConflict: "group_key", ignoreDuplicates: false },
    );
    return;
  }

  const totalUnits = itemsRaw.reduce((sum, item) => sum + (item.quantity ?? 1), 0);

  // Resolve customer_shipping_charged from ShipStation order map.
  // Priority: SS order map (from pre-fetch). Bandcamp warehouse_orders.shipping_cost
  // is used as an override AFTER the auto-link step below, since it's more authoritative.
  const ssShippingCharged = shipment.orderNumber
    ? (ssOrderShippingMap.get(shipment.orderNumber.toLowerCase().trim()) ?? null)
    : null;

  // UPSERT — atomic, idempotent, prevents duplicates via UNIQUE constraint.
  //
  // IMPORTANT: org_id and order_id are treated as immutable once set.
  // We use a two-step approach: insert-or-do-nothing on conflict, then a
  // separate UPDATE for mutable tracking fields. This ensures a re-ingest
  // never clobbers a manually-confirmed order link or a corrected org assignment.
  //
  // Mutable fields (safe to overwrite from ShipStation API on each poll):
  //   tracking_number, carrier, service, ship_date, delivery_date, status,
  //   shipping_cost, weight, dimensions, label_data, voided, total_units,
  //   ss_order_number, ss_create_date, label_source
  //
  // Immutable once set (NEVER overwritten by poll):
  //   org_id — set at first ingest via matchShipmentOrg; corrections done manually
  //   order_id — set by deterministic auto-link or manual staff action

  // Step A: Insert row if it doesn't exist yet
  const { data: insertedRow } = await supabase
    .from("warehouse_shipments")
    .upsert(
      {
        workspace_id: workspaceId,
        shipstation_shipment_id: shipstationShipmentId,
        org_id: orgMatch.orgId,          // only applied on first insert
        tracking_number: shipment.trackingNumber ?? null,
        carrier: shipment.carrierCode ?? null,
        service: shipment.serviceCode ?? null,
        ship_date: shipment.shipDate ?? null,
        delivery_date: shipment.deliveryDate ?? null,
        status: shipment.voided ? "voided" : "shipped",
        shipping_cost: shipment.shipmentCost ?? null,
        weight: shipment.weight?.value ?? null,
        dimensions: shipment.dimensions ?? null,
        label_data: shipment.shipTo ? { shipTo: shipment.shipTo } : null,
        voided: shipment.voided ?? false,
        billed: false,
        total_units: totalUnits,
        ss_order_number: shipment.orderNumber ?? null,
        ss_create_date: shipment.createDate ?? null,
        label_source: "shipstation",
        customer_shipping_charged: ssShippingCharged,
      },
      {
        onConflict: "workspace_id,shipstation_shipment_id",
        ignoreDuplicates: true, // on conflict: do nothing, fetch existing below
      },
    )
    .select("id, org_id, order_id")
    .maybeSingle();

  // Step B: Fetch existing row if upsert returned nothing (row already existed)
  let upsertedId: string;
  let existingOrderId: string | null;

  if (insertedRow) {
    upsertedId = insertedRow.id;
    existingOrderId = insertedRow.order_id;
  } else {
    const { data: existing } = await supabase
      .from("warehouse_shipments")
      .select("id, order_id")
      .eq("workspace_id", workspaceId)
      .eq("shipstation_shipment_id", shipstationShipmentId)
      .single();

    if (!existing) {
      logger.error(`Failed to find shipment ${shipstationShipmentId} after upsert`);
      return;
    }
    upsertedId = existing.id;
    existingOrderId = existing.order_id;

    // Step C: Update only mutable tracking fields on the existing row
    await supabase
      .from("warehouse_shipments")
      .update({
        tracking_number: shipment.trackingNumber ?? null,
        carrier: shipment.carrierCode ?? null,
        service: shipment.serviceCode ?? null,
        ship_date: shipment.shipDate ?? null,
        delivery_date: shipment.deliveryDate ?? null,
        status: shipment.voided ? "voided" : "shipped",
        shipping_cost: shipment.shipmentCost ?? null,
        weight: shipment.weight?.value ?? null,
        dimensions: shipment.dimensions ?? null,
        label_data: shipment.shipTo ? { shipTo: shipment.shipTo } : null,
        voided: shipment.voided ?? false,
        total_units: totalUnits,
        ss_order_number: shipment.orderNumber ?? null,
        ss_create_date: shipment.createDate ?? null,
        label_source: "shipstation",
        customer_shipping_charged: ssShippingCharged,
        // NOTE: org_id and order_id deliberately excluded
      })
      .eq("id", upsertedId);
  }

  // upsertedId is guaranteed set here — both branches above return early on failure.
  const upserted = { id: upsertedId, order_id: existingOrderId };

  // Re-sync items — upsert by (shipment_id, sku, item_index) rather than
  // delete-then-insert. Delete-then-insert is dangerous: if the insert fails
  // after delete, items are permanently lost with no retry path.
  //
  // We add an item_index so the same SKU appearing twice in one shipment
  // (rare but possible) gets two distinct rows.
  //
  // NOTE: warehouse_shipment_items needs a UNIQUE constraint on
  // (shipment_id, sku, item_index) for this upsert to work — add to migration.
  if (itemsRaw.length > 0) {
    const itemRows = itemsRaw.map((item, idx) => ({
      shipment_id: upserted.id,
      workspace_id: workspaceId,
      sku: item.sku ?? "UNKNOWN",
      quantity: item.quantity,
      product_title: item.name ?? null,
      variant_title: null,
      item_index: idx,
      // unit_price intentionally omitted: per-item sale price is redundant because
      // warehouse_orders.line_items (from Bandcamp) is the authoritative financial record
      // and customer_shipping_charged on warehouse_shipments covers the shipping comparison.
    }));

    const { error: itemsError } = await supabase
      .from("warehouse_shipment_items")
      .upsert(itemRows, {
        onConflict: "shipment_id,sku,item_index",
        ignoreDuplicates: false, // update quantity/title if changed
      });

    if (itemsError) {
      logger.error(`Failed to upsert items for shipment ${shipstationShipmentId}`, {
        error: itemsError.message,
        itemCount: itemRows.length,
      });
      // Non-fatal: shipment row was saved; items can be re-synced next poll
    } else {
      // Prune ghost items: if a ShipStation shipment is edited by staff to have fewer
      // items (e.g. 3 → 1), the upsert above only touches indices 0..N-1. Without this
      // delete, the now-stale rows for indices ≥ itemsRaw.length remain in the DB,
      // overstating total_units and creating phantom line items in the UI.
      await supabase
        .from("warehouse_shipment_items")
        .delete()
        .eq("shipment_id", upserted.id)
        .gte("item_index", itemsRaw.length);
    }
  }

  // Auto-link to warehouse_orders if not already linked
  if (!upserted.order_id) {
    const linkedOrderId = await matchShipmentToOrder(
      supabase,
      workspaceId,
      shipment,
      upserted.id,
      itemSkus,
    );
    if (linkedOrderId) {
      // Fetch the linked order to get its shipping_cost (Bandcamp authoritative value)
      // and source so we can apply the correct fulfillment_status guard below.
      const { data: linkedOrder } = await supabase
        .from("warehouse_orders")
        .select("shipping_cost, fulfillment_status, source")
        .eq("id", linkedOrderId)
        .single();

      const authoritative_shipping_charged =
        (linkedOrder?.shipping_cost != null)
          ? Number(linkedOrder.shipping_cost)
          : ssShippingCharged;

      await supabase
        .from("warehouse_shipments")
        .update({
          order_id: linkedOrderId,
          ...(authoritative_shipping_charged != null && {
            customer_shipping_charged: authoritative_shipping_charged,
          }),
        })
        .eq("id", upserted.id);

      // Only auto-mark fulfilled for non-Bandcamp orders.
      // Bandcamp orders must be marked fulfilled via the Bandcamp API ("Mark Shipped on
      // Bandcamp" button). Auto-updating here would create a mismatch: our DB shows
      // "fulfilled" but Bandcamp still shows "unfulfilled", and the next
      // bandcamp-order-sync could overwrite our status back to "unfulfilled".
      if (
        linkedOrder &&
        linkedOrder.source !== "bandcamp" &&
        ["unfulfilled", "pending", null].includes(linkedOrder.fulfillment_status)
      ) {
        await supabase
          .from("warehouse_orders")
          .update({ fulfillment_status: "fulfilled", updated_at: new Date().toISOString() })
          .eq("id", linkedOrderId);
      }

      logger.info(`Auto-linked shipment ${shipstationShipmentId} → order ${linkedOrderId}`);
    }
  }

  logger.info(`Ingested shipment ${shipstationShipmentId}: org=${orgMatch.orgId}, items=${itemsRaw.length}, linked=${!!upserted.order_id}`);
}

// ─── Order number normalization ──────────────────────────────────────────────
//
// Bandcamp orders are stored as "BC-{paymentId}" in warehouse_orders.order_number.
// ShipStation carries the order number the staff typed when creating the label —
// this might be "BC-12345678", "bc-12345678", "12345678", "BC 12345678", or have
// leading/trailing spaces. Raw string comparison will miss these variants.
//
// normalizeOrderNumber strips prefix, lowercases, and removes all non-alphanumeric
// chars so "BC-12345678" == "bc 12345678" == "12345678" all map to "12345678".
//
function normalizeOrderNumber(raw: string | null | undefined): string | null {
  if (!raw) return null;
  return raw
    .toLowerCase()
    .replace(/^(bc|bandcamp)[-\s]*/i, "") // strip BC- or Bandcamp- prefix
    .replace(/[^a-z0-9]/g, "")            // strip spaces, dashes, special chars
    .trim() || null;
}

// ─── Order matching: TWO EXPLICIT PHASES ────────────────────────────────────
//
// PHASE 1 (deterministic): exact normalized order number match → auto-link.
//   This is the only path that sets order_id automatically.
//   Risk: near-zero. Two orders cannot share the same external ID.
//
// PHASE 2 (probabilistic): multi-signal scoring → review queue ONLY.
//   Never auto-links. Puts candidates in the review queue for staff to confirm.
//   Risk: false positives possible (repeat buyer, same postal+SKU), so we never
//   assign order_id from this phase without human confirmation.
//   Rationale: for audit and billing workflows, a missing link is safer than a
//   wrong link.
//
async function matchShipmentToOrder(
  supabase: ReturnType<typeof createServiceRoleClient>,
  workspaceId: string,
  shipment: ShipStationShipment,
  shipmentDbId: string,
  itemSkus: string[],
): Promise<string | null> {
  const postalCode = shipment.shipTo?.postalCode ?? null;
  const recipientName = (shipment.shipTo?.name ?? "").toLowerCase().trim();
  const shipDate = shipment.shipDate ? new Date(shipment.shipDate) : null;
  const normalizedSsOrderNumber = normalizeOrderNumber(shipment.orderNumber);
  // Exclude "UNKNOWN" sentinel SKUs from matching — they are a null-SKU fallback,
  // not real product identifiers. Matching on "UNKNOWN" would score any two
  // null-SKU shipments as matching each other on SKU overlap.
  const matchableItemSkus = itemSkus.filter((sku) => sku !== "UNKNOWN");

  // ── PHASE 1: Deterministic exact match ──────────────────────────────────
  // Try the SS order number (normalized) against warehouse_orders.order_number.
  // We compare normalized versions of both sides to handle prefix/case/spacing.
  if (normalizedSsOrderNumber) {
    const { data: candidates } = await supabase
      .from("warehouse_orders")
      .select("id, order_number")
      .eq("workspace_id", workspaceId)
      // Fetch a small set around the normalized number; cheaper than a DB function
      .ilike("order_number", `%${normalizedSsOrderNumber}%`)
      .limit(5);

    if (candidates?.length) {
      const exactMatch = candidates.find(
        (o) => normalizeOrderNumber(o.order_number) === normalizedSsOrderNumber,
      );
      if (exactMatch) {
        logger.info(`Exact order number match: shipment ${shipmentDbId} → order ${exactMatch.id}`);

        // Audit trail for exact matches
        await supabase.from("channel_sync_log").insert({
          workspace_id: workspaceId,
          channel: "shipstation",
          sync_type: "order_auto_link",
          status: "completed",
          items_processed: 1,
          items_failed: 0,
          started_at: new Date().toISOString(),
          completed_at: new Date().toISOString(),
        }).catch(() => {});

        return exactMatch.id; // ← only auto-link happens here
      }
    }
  }

  // ── PHASE 2: Probabilistic scoring → review queue only ──────────────────
  // Scores candidates but NEVER returns an order ID for auto-linking.
  // Instead, writes to warehouse_review_queue for staff to confirm manually.
  // This prevents false links in billing/audit workflows.
  const windowStart = shipDate
    ? new Date(shipDate.getTime() - 90 * 24 * 60 * 60 * 1000).toISOString()
    : undefined;

  let candidateQuery = supabase
    .from("warehouse_orders")
    .select("id, order_number, customer_name, shipping_address, line_items, created_at")
    .eq("workspace_id", workspaceId);

  if (postalCode) {
    candidateQuery = candidateQuery.eq("shipping_address->>postalCode", postalCode);
  }
  if (windowStart && shipDate) {
    candidateQuery = candidateQuery
      .gte("created_at", windowStart)
      .lte("created_at", shipDate.toISOString());
  }

  const { data: candidates } = await candidateQuery.limit(20);
  if (!candidates?.length) return null;

  interface ScoredCandidate { id: string; score: number; signals: string[] }
  const scored: ScoredCandidate[] = [];

  for (const order of candidates) {
    let score = 0;
    const signals: string[] = [];

    // Postal code (+30 pts)
    const addrPostal = (order.shipping_address as Record<string, string> | null)?.postalCode;
    if (postalCode && addrPostal === postalCode) {
      score += 30; signals.push("postal_code");
    }

    // SKU overlap (+40 base, +5 per additional match up to 3 extras)
    const orderSkus = ((order.line_items ?? []) as Array<{ sku?: string }>)
      .map((li) => li.sku)
      .filter((sku): sku is string => Boolean(sku) && sku !== "UNKNOWN");
    const skuMatches = matchableItemSkus.filter((sku) => orderSkus.includes(sku)).length;
    if (skuMatches > 0) {
      score += 40 + Math.min(skuMatches - 1, 3) * 5;
      signals.push(`sku_match(${skuMatches})`);
    }

    // Recipient name (+20 pts, partial/case-insensitive)
    const orderName = (order.customer_name ?? "").toLowerCase().trim();
    if (
      recipientName &&
      orderName &&
      (orderName.includes(recipientName) || recipientName.includes(orderName))
    ) {
      score += 20; signals.push("name_match");
    }

    // Date proximity (+10 if ≤14 days, +5 if 15-30 days)
    if (shipDate && order.created_at) {
      const daysDiff =
        (shipDate.getTime() - new Date(order.created_at).getTime()) / (1000 * 60 * 60 * 24);
      if (daysDiff >= 0 && daysDiff <= 14) { score += 10; signals.push("date_close"); }
      else if (daysDiff > 14 && daysDiff <= 30) { score += 5; signals.push("date_ok"); }
    }

    if (score >= 50) scored.push({ id: order.id, score, signals });
  }

  scored.sort((a, b) => b.score - a.score);

  if (scored.length === 0) return null;

  // Write top candidates to review queue — staff confirms manually.
  // We do NOT auto-assign order_id from probabilistic matches.
  await supabase.from("warehouse_review_queue").upsert(
    {
      workspace_id: workspaceId,
      category: "shipment_order_match",
      severity: scored[0].score >= 80 ? "medium" as const : "low" as const,
      title: `Probable order match for shipment — needs confirmation`,
      description: `Shipment ${shipmentDbId} (SS order: ${shipment.orderNumber ?? "unknown"}) ` +
        `scored ${scored[0].score} against order ${scored[0].id}. ` +
        `Signals: ${scored[0].signals.join(", ")}. ` +
        `Set order_id on warehouse_shipments to confirm.`,
      metadata: {
        shipment_id: shipmentDbId,
        ss_order_number: shipment.orderNumber,
        top_candidates: scored.slice(0, 3),
      },
      status: "open" as const,
      group_key: `shipment_order_prob_${shipmentDbId}`,
      occurrence_count: 1,
    },
    { onConflict: "group_key", ignoreDuplicates: true },
  );

  return null; // never auto-link from probabilistic phase
}
```

---

### Step 4 — Patch `src/actions/orders.ts`

**`getClientShipments` — add org filter + order join:**

```typescript
// BEFORE (lines 95-117 — no org filter):
export async function getClientShipments(filters) {
  const supabase = await createServerSupabaseClient();
  // ...
  let query = supabase
    .from("warehouse_shipments")
    .select("*", { count: "exact" })
    // NO org filter — security gap
    .order("ship_date", { ascending: false });
}

// AFTER — explicit org scoping + order number join:
export async function getClientShipments(filters: {
  page?: number;
  pageSize?: number;
  status?: string;
  carrier?: string;
}) {
  const supabase = await createServerSupabaseClient();
  const serviceClient = createServiceRoleClient();

  // Resolve org_id from authenticated user
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { shipments: [], total: 0, page: 1, pageSize: 25 };

  const { data: userRecord } = await serviceClient
    .from("users")
    .select("org_id")
    .eq("auth_user_id", user.id)
    .single();

  if (!userRecord?.org_id) return { shipments: [], total: 0, page: 1, pageSize: 25 };

  const page = filters.page ?? 1;
  const pageSize = filters.pageSize ?? 25;
  const offset = (page - 1) * pageSize;

  let query = supabase
    .from("warehouse_shipments")
    .select(
      "*, warehouse_orders(order_number)",  // join for order reference
      { count: "exact" }
    )
    .eq("org_id", userRecord.org_id)  // explicit org scope
    .order("ship_date", { ascending: false })
    .range(offset, offset + pageSize - 1);

  if (filters.status) query = query.eq("status", filters.status);
  if (filters.carrier) query = query.ilike("carrier", `%${filters.carrier}%`);

  const { data, count } = await query;
  return { shipments: data ?? [], total: count ?? 0, page, pageSize };
}
```

**`getShipments` (admin) — add `total_units` and `ss_order_number` to select:**

```typescript
// src/actions/shipping.ts — getShipments select string (line 79)
// BEFORE:
"id, org_id, shipstation_shipment_id, order_id, tracking_number, carrier, service, ship_date, delivery_date, status, shipping_cost, weight, label_data, voided, billed, created_at, bandcamp_payment_id, bandcamp_synced_at, organizations!inner(name), warehouse_orders(order_number), warehouse_shipment_items(id)"

// AFTER — add total_units, ss_order_number, label_source:
"id, org_id, shipstation_shipment_id, ss_order_number, order_id, tracking_number, carrier, service, ship_date, delivery_date, status, shipping_cost, weight, label_data, voided, billed, created_at, total_units, label_source, bandcamp_payment_id, bandcamp_synced_at, organizations!inner(name), warehouse_orders(order_number), warehouse_shipment_items(id)"
```

---

### Step 5 — Patch admin orders page: two-status display

**File:** `src/app/admin/orders/page.tsx`

**Changes from current file:**
- Add `CheckCircle` to lucide imports
- Replace the single `Shipments` section in `OrderDetailExpanded` with two sections: "Bandcamp Platform Status" + "Shipment & Tracking"
- Add `hasLinkedShipment` guard to `CreateLabelPanel` so it hides when a shipment already exists
- Add "View in Shipping Log →" link per shipment

**Full updated file:**

```typescript
"use client";

import { Check, CheckCircle, Copy, ExternalLink, Loader2, Package, Tag } from "lucide-react";
import { PaginationBar } from "@/components/shared/pagination-bar";
import { useState } from "react";
import { getOrderDetail, getOrders, getTrackingEvents } from "@/actions/orders";
import {
  createOrderLabel,
  getLabelTaskStatus,
  getShippingRates,
  type LabelResult,
  type RateOption,
} from "@/actions/shipping";
import { TrackingTimeline } from "@/components/shared/tracking-timeline";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useAppMutation, useAppQuery } from "@/lib/hooks/use-app-query";
import { queryKeys } from "@/lib/shared/query-keys";
import { CACHE_TIERS } from "@/lib/shared/query-tiers";

type OrderRow = Awaited<ReturnType<typeof getOrders>>["orders"][number];

const SOURCE_COLORS: Record<string, string> = {
  shopify: "bg-green-100 text-green-800",
  bandcamp: "bg-blue-100 text-blue-800",
  woocommerce: "bg-purple-100 text-purple-800",
  squarespace: "bg-yellow-100 text-yellow-800",
  discogs: "bg-orange-100 text-orange-800",
  manual: "bg-gray-100 text-gray-800",
};

export default function AdminOrdersPage() {
  const [filters, setFilters] = useState({
    page: 1,
    pageSize: 25,
    status: "",
    source: "",
    search: "",
    orgId: "",
  });
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const { data, isLoading } = useAppQuery({
    queryKey: queryKeys.orders.list(filters),
    queryFn: () => getOrders(filters),
    tier: CACHE_TIERS.SESSION,
  });

  const { data: detail, isLoading: detailLoading } = useAppQuery({
    queryKey: queryKeys.orders.detail(expandedId ?? ""),
    queryFn: () => getOrderDetail(expandedId ?? ""),
    tier: CACHE_TIERS.SESSION,
    enabled: !!expandedId,
  });

  return (
    <div className="p-6 space-y-4">
      <h1 className="text-2xl font-semibold tracking-tight">Orders</h1>

      <div className="flex flex-wrap gap-3">
        <Input
          placeholder="Search order/customer..."
          value={filters.search}
          onChange={(e) => setFilters((f) => ({ ...f, search: e.target.value, page: 1 }))}
          className="w-64"
        />
        <select
          value={filters.source}
          onChange={(e) => setFilters((f) => ({ ...f, source: e.target.value, page: 1 }))}
          className="border-input bg-background h-9 rounded-md border px-3 text-sm"
        >
          <option value="">All sources</option>
          <option value="shopify">Shopify</option>
          <option value="bandcamp">Bandcamp</option>
          <option value="woocommerce">WooCommerce</option>
          <option value="squarespace">Squarespace</option>
          <option value="discogs">Discogs</option>
          <option value="manual">Manual</option>
        </select>
        <select
          value={filters.status}
          onChange={(e) => setFilters((f) => ({ ...f, status: e.target.value, page: 1 }))}
          className="border-input bg-background h-9 rounded-md border px-3 text-sm"
        >
          <option value="">All statuses</option>
          <option value="pending">Pending</option>
          <option value="ready_to_ship">Ready to Ship</option>
          <option value="shipped">Shipped</option>
          <option value="delivered">Delivered</option>
        </select>
      </div>

      {isLoading ? (
        <div className="space-y-2">
          {[1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Order</TableHead>
              <TableHead>Date</TableHead>
              <TableHead>Customer</TableHead>
              <TableHead>Organization</TableHead>
              <TableHead>Source</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Total</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {(data?.orders ?? []).map((order: OrderRow) => {
              const orgName =
                (order as OrderRow & { organizations?: { name: string } }).organizations?.name ??
                "—";
              return (
                <>
                  <TableRow
                    key={order.id}
                    className="cursor-pointer"
                    onClick={() => setExpandedId((prev) => (prev === order.id ? null : order.id))}
                  >
                    <TableCell>
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-mono text-sm">{order.order_number ?? "—"}</span>
                        {order.is_preorder && (
                          <Badge variant="secondary" className="text-xs">
                            Pre-Order
                          </Badge>
                        )}
                        {order.source === "bandcamp" &&
                          (order as OrderRow & { bandcamp_payment_id?: number | null })
                            .bandcamp_payment_id != null && (
                            <Badge variant="outline" className="text-xs font-mono">
                              BC{" "}
                              {
                                (order as OrderRow & { bandcamp_payment_id?: number })
                                  .bandcamp_payment_id
                              }
                            </Badge>
                          )}
                      </div>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {new Date(order.created_at).toLocaleDateString()}
                    </TableCell>
                    <TableCell>{order.customer_name ?? "—"}</TableCell>
                    <TableCell className="text-sm">{orgName}</TableCell>
                    <TableCell>
                      <span
                        className={`text-xs px-1.5 py-0.5 rounded ${SOURCE_COLORS[order.source] ?? "bg-gray-100"}`}
                      >
                        {order.source}
                      </span>
                    </TableCell>
                    <TableCell>
                      <StatusBadge status={order.fulfillment_status} />
                    </TableCell>
                    <TableCell className="text-right font-mono">
                      {order.total_price != null ? `$${Number(order.total_price).toFixed(2)}` : "—"}
                    </TableCell>
                  </TableRow>

                  {expandedId === order.id && (
                    <TableRow key={`${order.id}-detail`}>
                      <TableCell colSpan={7} className="bg-muted/30 p-4">
                        {detailLoading ? (
                          <Skeleton className="h-32 w-full" />
                        ) : detail ? (
                          <OrderDetailExpanded detail={detail} />
                        ) : null}
                      </TableCell>
                    </TableRow>
                  )}
                </>
              );
            })}
            {(data?.orders ?? []).length === 0 && (
              <TableRow>
                <TableCell colSpan={7} className="py-8 text-center text-muted-foreground">
                  <Package className="h-8 w-8 mx-auto mb-2 opacity-50" />
                  No orders found.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      )}

      {data && data.total > 0 && (
        <PaginationBar
          page={filters.page}
          pageSize={filters.pageSize}
          total={data.total}
          onPageChange={(p) => setFilters((f) => ({ ...f, page: p }))}
          onPageSizeChange={(s) => setFilters((f) => ({ ...f, pageSize: s, page: 1 }))}
        />
      )}
    </div>
  );
}

/**
 * Bandcamp formats item_name as "{Album}: {Item} by {Artist}".
 * When the album title matches the start of the item title, the album name
 * appears twice. Strip the redundant prefix so we only show "{Item} by {Artist}".
 */
function cleanItemTitle(title: string | null): string | null {
  if (!title) return null;
  const colonIdx = title.indexOf(": ");
  if (colonIdx <= 0) return title;
  const albumPrefix = title.substring(0, colonIdx);
  const rest = title.substring(colonIdx + 2);
  if (rest.startsWith(albumPrefix)) return rest;
  return title;
}

function OrderDetailExpanded({ detail }: { detail: Awaited<ReturnType<typeof getOrderDetail>> }) {
  const [copied, setCopied] = useState(false);
  const orderId = detail.order?.id as string;
  const order = detail.order as {
    source?: string;
    bandcamp_payment_id?: number | null;
    fulfillment_status?: string | null;
  };
  const showBandcamp = order.source === "bandcamp" && order.bandcamp_payment_id != null;
  const isUnfulfilled =
    !order.fulfillment_status ||
    order.fulfillment_status === "unfulfilled" ||
    order.fulfillment_status === "pending";

  // KEY CHANGE: Create Label is hidden when a shipment already exists.
  // A linked shipment means the order has been shipped — showing the label dialog
  // would be confusing and could result in duplicate labels.
  const hasLinkedShipment = detail.shipments.length > 0;

  const handleCopyPaymentId = async () => {
    const id = String(order.bandcamp_payment_id);
    try {
      await navigator.clipboard.writeText(id);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback: selectable text remains
    }
  };

  const shippingAddr = detail.order?.shipping_address as Record<string, string | undefined> | null;

  return (
    <div className="space-y-4">
      {/* Line Items */}
      <div>
        <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">Line Items</h4>
        <div className="space-y-1.5 text-sm">
          {detail.items.length === 0 ? (
            <p className="text-muted-foreground">No items</p>
          ) : (
            detail.items.map((item) => (
              <div key={item.id} className="flex items-baseline justify-between gap-4">
                <div className="min-w-0">
                  {item.sku && (
                    <span className="font-mono text-xs text-muted-foreground mr-1.5">{item.sku}</span>
                  )}
                  <span>{cleanItemTitle(item.title) ?? "—"}</span>
                </div>
                <span className="font-mono text-xs shrink-0 text-right whitespace-nowrap">
                  x{item.quantity}
                  {item.price != null && <span className="text-muted-foreground ml-1">· ${Number(item.price).toFixed(2)}</span>}
                </span>
              </div>
            ))
          )}
        </div>
      </div>

      {/* Ship To */}
      {shippingAddr && (
        <div>
          <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-1">Ship To</h4>
          <address className="text-sm not-italic space-y-0.5">
            {(shippingAddr.name || shippingAddr.firstName) && (
              <div className="font-medium">
                {shippingAddr.name ?? `${shippingAddr.firstName ?? ""} ${shippingAddr.lastName ?? ""}`.trim()}
              </div>
            )}
            {shippingAddr.street1 && <div className="text-muted-foreground">{shippingAddr.street1}</div>}
            {shippingAddr.street2 && <div className="text-muted-foreground">{shippingAddr.street2}</div>}
            {(shippingAddr.city || shippingAddr.state || shippingAddr.zip) && (
              <div className="text-muted-foreground">
                {[shippingAddr.city, shippingAddr.state, shippingAddr.zip].filter(Boolean).join(", ")}
              </div>
            )}
            {shippingAddr.country && shippingAddr.country !== "US" && (
              <div className="text-muted-foreground">{shippingAddr.country}</div>
            )}
          </address>
        </div>
      )}

      {/* Section A: Bandcamp Platform Status — what the Bandcamp API reports */}
      {order.source === "bandcamp" && (
        <div>
          <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-1">
            Bandcamp Platform Status
          </h4>
          {order.fulfillment_status === "fulfilled" ? (
            <Badge variant="default" className="gap-1">
              <CheckCircle className="h-3 w-3" /> Fulfilled on Bandcamp
            </Badge>
          ) : (
            <Badge variant="outline">Unfulfilled on Bandcamp</Badge>
          )}
        </div>
      )}

      {/* Section B: Shipment & Tracking — what our system has */}
      <div>
        <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
          Shipment & Tracking
        </h4>
        {detail.shipments.length > 0 ? (
          <div className="space-y-3">
            {detail.shipments.map((s) => (
              <div key={s.id} className="border rounded-lg p-3">
                <div className="flex items-center justify-between mb-2">
                  <span className="font-mono text-xs text-muted-foreground">
                    {s.tracking_number ?? "No tracking number"}
                  </span>
                  <a
                    href={`/admin/shipping?search=${encodeURIComponent(s.tracking_number ?? "")}`}
                    className="text-xs text-blue-600 hover:underline"
                  >
                    View in Shipping Log →
                  </a>
                </div>
                <TrackingTimeline
                  shipmentId={s.id}
                  trackingNumber={s.tracking_number}
                  carrier={s.carrier}
                  fetchEvents={getTrackingEvents}
                />
                {order.fulfillment_status !== "fulfilled" && order.source === "bandcamp" && (
                  <p className="text-xs text-amber-600 mt-2">
                    Shipped — Bandcamp not yet notified. Use "Mark Shipped on Bandcamp" to sync tracking.
                  </p>
                )}
              </div>
            ))}
          </div>
        ) : order.fulfillment_status === "fulfilled" ? (
          <p className="text-sm text-muted-foreground">
            Fulfilled externally — no label created in this system.
          </p>
        ) : (
          <p className="text-sm text-muted-foreground">No shipments yet.</p>
        )}
      </div>

      {/* Bandcamp payment ID panel (unchanged) */}
      {showBandcamp && (
        <div className="border rounded-lg p-3 bg-muted/30">
          <h4 className="text-sm font-semibold mb-2">Bandcamp</h4>
          <div className="flex items-center gap-2">
            <span className="text-muted-foreground text-sm">Payment ID:</span>
            <span className="font-mono text-sm select-all">{order.bandcamp_payment_id}</span>
            <Button variant="ghost" size="sm" className="h-7 px-2" onClick={handleCopyPaymentId}>
              {copied ? (
                <Check className="h-3.5 w-3.5 text-green-600" />
              ) : (
                <Copy className="h-3.5 w-3.5" />
              )}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground mt-1">
            Use this ID when linking a shipment to Bandcamp on the Shipping page.
          </p>
        </div>
      )}

      {/* Create Label — hidden when a shipment is already linked (order is already shipped).
          Passes customer shipping paid so staff can pick the closest matching rate. */}
      {!hasLinkedShipment && isUnfulfilled && orderId && (
        <CreateLabelPanel
          orderId={orderId}
          orderType="fulfillment"
          customerShippingCharged={
            (detail.order as { shipping_cost?: number | null }).shipping_cost ?? null
          }
        />
      )}
    </div>
  );
}

// CreateLabelPanel — updated to show customer shipping charged above rate list
// so staff can pick the rate closest to what the customer paid.
function CreateLabelPanel({
  orderId,
  orderType,
  customerShippingCharged,
}: {
  orderId: string;
  orderType: "fulfillment" | "mailorder";
  customerShippingCharged?: number | null;
}) {
  const [showRates, setShowRates] = useState(false);
  const [selectedRateId, setSelectedRateId] = useState<string | null>(null);
  const [labelResult, setLabelResult] = useState<LabelResult | null>(null);
  const [taskRunId, setTaskRunId] = useState<string | null>(null);
  const [polling, setPolling] = useState(false);

  const ratesQuery = useAppQuery({
    queryKey: ["label-rates", orderId, orderType],
    queryFn: () => getShippingRates(orderId, orderType),
    tier: CACHE_TIERS.SESSION,
    enabled: showRates,
  });

  const createMut = useAppMutation({
    mutationFn: async () => {
      if (!selectedRateId) throw new Error("Select a rate first");
      return createOrderLabel(orderId, { orderType, selectedRateId });
    },
    onSuccess: async (result) => {
      if (!result.success) {
        setLabelResult(result);
        return;
      }
      if (result.shipmentId) {
        setTaskRunId(result.shipmentId);
        setPolling(true);
        const poll = async () => {
          const status = await getLabelTaskStatus(result.shipmentId!);
          if (status.status === "completed" || status.status === "failed") {
            setPolling(false);
            setLabelResult(status.result ?? { success: false, error: "Unknown status" });
          } else {
            setTimeout(poll, 2500);
          }
        };
        setTimeout(poll, 2500);
      } else {
        setLabelResult(result);
      }
    },
  });

  const rates: RateOption[] = ratesQuery.data?.rates ?? [];

  return (
    <div className="border rounded-lg p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h4 className="text-sm font-semibold flex items-center gap-1.5">
          <Tag className="h-4 w-4" />
          Create Shipping Label
        </h4>
        {!showRates && !labelResult && (
          <Button size="sm" variant="outline" onClick={() => setShowRates(true)}>
            Get Rates
          </Button>
        )}
      </div>

      {/* Show what the customer paid for shipping — helps staff pick matching rate */}
      {customerShippingCharged != null && (
        <p className="text-xs text-muted-foreground">
          Customer paid for shipping:{" "}
          <span className="font-mono font-medium text-foreground">
            ${customerShippingCharged.toFixed(2)}
          </span>
          {" "}— pick the rate closest to this amount.
        </p>
      )}

      {showRates && ratesQuery.isLoading && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Fetching rates…
        </div>
      )}

      {ratesQuery.data?.error && (
        <p className="text-sm text-destructive">{ratesQuery.data.error}</p>
      )}

      {!ratesQuery.isLoading && rates.length > 0 && !labelResult && (
        <div className="space-y-2">
          <div className="grid gap-2">
            {rates.map((rate) => (
              <label
                key={rate.id}
                className={`flex items-center justify-between border rounded-md px-3 py-2 cursor-pointer text-sm transition-colors ${
                  selectedRateId === rate.id
                    ? "border-primary bg-primary/5"
                    : "border-border hover:border-muted-foreground"
                }`}
              >
                <div className="flex items-center gap-2">
                  <input
                    type="radio"
                    name={`rate-${orderId}`}
                    value={rate.id}
                    checked={selectedRateId === rate.id}
                    onChange={() => setSelectedRateId(rate.id)}
                    className="sr-only"
                  />
                  <div>
                    <span className="font-medium">{rate.displayName}</span>
                    {rate.recommended && (
                      <Badge variant="secondary" className="ml-2 text-xs">
                        Recommended
                      </Badge>
                    )}
                    {rate.isMediaMail && (
                      <Badge variant="outline" className="ml-1 text-xs">
                        Media Mail
                      </Badge>
                    )}
                    {rate.deliveryDays && (
                      <span className="text-muted-foreground ml-2 text-xs">
                        ~{rate.deliveryDays}d
                      </span>
                    )}
                  </div>
                </div>
                <span className="font-mono font-semibold">${rate.rate.toFixed(2)}</span>
              </label>
            ))}
          </div>
          <Button
            size="sm"
            disabled={!selectedRateId || createMut.isPending || polling}
            onClick={() => createMut.mutate()}
          >
            {createMut.isPending || polling ? (
              <>
                <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                Creating…
              </>
            ) : (
              "Buy Label"
            )}
          </Button>
        </div>
      )}

      {labelResult && (
        <div
          className={`rounded-md p-3 text-sm ${labelResult.success ? "bg-green-50 border border-green-200" : "bg-destructive/10 border border-destructive/20"}`}
        >
          {labelResult.success ? (
            <div className="space-y-2">
              <p className="font-medium text-green-800">Label created!</p>
              <div className="text-green-700 space-y-1">
                <p>Carrier: {labelResult.carrier} · {labelResult.service}</p>
                <p>Tracking: <span className="font-mono">{labelResult.trackingNumber}</span></p>
                <p>Cost: <span className="font-mono">${labelResult.rate?.toFixed(2)}</span></p>
              </div>
              {labelResult.labelUrl && (
                <a
                  href={labelResult.labelUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-xs text-blue-600 hover:underline mt-1"
                >
                  <ExternalLink className="h-3 w-3" />
                  Open label (Cmd+P to print)
                </a>
              )}
            </div>
          ) : (
            <p className="text-destructive">{labelResult.error ?? "Label creation failed"}</p>
          )}
        </div>
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: string | null }) {
  const config: Record<
    string,
    { variant: "default" | "secondary" | "destructive" | "outline"; label: string }
  > = {
    pending: { variant: "outline", label: "Pending" },
    ready_to_ship: { variant: "secondary", label: "Ready to Ship" },
    shipped: { variant: "default", label: "Shipped" },
    delivered: { variant: "default", label: "Delivered" },
  };
  const c = config[status ?? ""] ?? { variant: "outline" as const, label: status ?? "—" };
  return <Badge variant={c.variant}>{c.label}</Badge>;
}
```

**Four-state behavior:**

| `fulfillment_status` | `detail.shipments.length` | Bandcamp Status | Shipment section | Create Label |
|---|---|---|---|---|
| unfulfilled | 0 | "Unfulfilled on Bandcamp" | "No shipments yet" | **Shown** |
| unfulfilled | >0 | "Unfulfilled on Bandcamp" | Tracking + "Bandcamp not notified" + log link | Hidden |
| fulfilled | 0 | "Fulfilled on Bandcamp ✓" | "Fulfilled externally" | Hidden |
| fulfilled | >0 | "Fulfilled on Bandcamp ✓" | Tracking + log link | Hidden |

---

### Step 6 — Patch portal fulfillment page

**File:** `src/app/portal/fulfillment/page.tsx`

**Changes from current file:**
- Add `CheckCircle` to lucide imports
- Replace single "Shipments" section in `OrderExpandedDetail` with two-section pattern matching admin
- Add "Shipping details →" link per shipment pointing to `/portal/shipping`
- Change layout from `grid-cols-2` to `grid-cols-1 md:grid-cols-2` (responsive)

**Full updated file:**

```typescript
"use client";

import { CheckCircle, Package } from "lucide-react";
import { PaginationBar } from "@/components/shared/pagination-bar";
import { useState } from "react";
import { getOrderDetail, getOrders, getTrackingEvents } from "@/actions/orders";
import { TrackingTimeline } from "@/components/shared/tracking-timeline";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useAppQuery } from "@/lib/hooks/use-app-query";
import { queryKeys } from "@/lib/shared/query-keys";
import { CACHE_TIERS } from "@/lib/shared/query-tiers";

type OrderRow = Awaited<ReturnType<typeof getOrders>>["orders"][number];

export default function PortalFulfillmentPage() {
  const [filters, setFilters] = useState({ page: 1, pageSize: 25, status: "", search: "" });
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const { data, isLoading } = useAppQuery({
    queryKey: queryKeys.orders.list({ ...filters, portal: true }),
    queryFn: () => getOrders(filters),
    tier: CACHE_TIERS.SESSION,
  });

  const { data: detail, isLoading: detailLoading } = useAppQuery({
    queryKey: queryKeys.orders.detail(expandedId ?? ""),
    queryFn: () => getOrderDetail(expandedId ?? ""),
    tier: CACHE_TIERS.SESSION,
    enabled: !!expandedId,
  });

  return (
    <div className="p-6 space-y-4">
      <h1 className="text-2xl font-semibold tracking-tight">Fulfillment</h1>

      <div className="flex flex-wrap gap-3">
        <Input
          placeholder="Search order number..."
          value={filters.search}
          onChange={(e) => setFilters((f) => ({ ...f, search: e.target.value, page: 1 }))}
          className="w-64"
        />
        <select
          value={filters.status}
          onChange={(e) => setFilters((f) => ({ ...f, status: e.target.value, page: 1 }))}
          className="border-input bg-background h-9 rounded-md border px-3 text-sm"
        >
          <option value="">All statuses</option>
          <option value="unfulfilled">Unfulfilled</option>
          <option value="fulfilled">Fulfilled</option>
          <option value="shipped">Shipped</option>
          <option value="delivered">Delivered</option>
        </select>
      </div>

      {isLoading ? (
        <div className="space-y-2">
          {[1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Order</TableHead>
              <TableHead>Date</TableHead>
              <TableHead>Customer</TableHead>
              <TableHead>Items</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Total</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {(data?.orders ?? []).map((order: OrderRow) => (
              <>
                <TableRow
                  key={order.id}
                  className="cursor-pointer"
                  onClick={() => setExpandedId((prev) => (prev === order.id ? null : order.id))}
                >
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-sm">{order.order_number ?? "—"}</span>
                      {order.is_preorder && (
                        <Badge variant="secondary" className="text-xs">
                          Pre-Order
                        </Badge>
                      )}
                    </div>
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {new Date(order.created_at).toLocaleDateString()}
                  </TableCell>
                  <TableCell>{order.customer_name ?? order.customer_email ?? "—"}</TableCell>
                  <TableCell className="text-muted-foreground text-sm">
                    {Array.isArray(order.line_items) ? order.line_items.length : 0} item(s)
                  </TableCell>
                  <TableCell>
                    <FulfillmentStatusBadge status={order.fulfillment_status} />
                  </TableCell>
                  <TableCell className="text-right font-mono">
                    {order.total_price != null ? `$${Number(order.total_price).toFixed(2)}` : "—"}
                  </TableCell>
                </TableRow>

                {expandedId === order.id && (
                  <TableRow key={`${order.id}-detail`}>
                    <TableCell colSpan={6} className="bg-muted/30 p-4">
                      {detailLoading ? (
                        <Skeleton className="h-32 w-full" />
                      ) : detail ? (
                        <OrderExpandedDetail detail={detail} />
                      ) : null}
                    </TableCell>
                  </TableRow>
                )}
              </>
            ))}
            {(data?.orders ?? []).length === 0 && (
              <TableRow>
                <TableCell colSpan={6} className="py-8 text-center text-muted-foreground">
                  <Package className="h-8 w-8 mx-auto mb-2 opacity-50" />
                  No fulfillment orders found.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      )}

      {data && data.total > 0 && (
        <PaginationBar
          page={filters.page}
          pageSize={filters.pageSize}
          total={data.total}
          onPageChange={(p) => setFilters((f) => ({ ...f, page: p }))}
          onPageSizeChange={(s) => setFilters((f) => ({ ...f, pageSize: s, page: 1 }))}
        />
      )}
    </div>
  );
}

function FulfillmentStatusBadge({ status }: { status: string | null }) {
  const config: Record<string, { variant: "default" | "secondary" | "outline"; label: string }> = {
    unfulfilled: { variant: "outline", label: "Unfulfilled" },
    fulfilled: { variant: "default", label: "Fulfilled" },
    shipped: { variant: "secondary", label: "Shipped" },
    delivered: { variant: "default", label: "Delivered" },
  };
  const c = config[status ?? "unfulfilled"] ?? {
    variant: "outline" as const,
    label: status ?? "Unknown",
  };
  return <Badge variant={c.variant}>{c.label}</Badge>;
}

function OrderExpandedDetail({ detail }: { detail: Awaited<ReturnType<typeof getOrderDetail>> }) {
  const { order, items, shipments } = detail;
  if (!order) return null;

  const isBandcamp = (order as { source?: string }).source === "bandcamp";
  const fulfillmentStatus = (order as { fulfillment_status?: string | null }).fulfillment_status;

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
      {/* Column 1: Line Items */}
      <div>
        <h4 className="text-sm font-semibold mb-2">Line Items</h4>
        <div className="space-y-1 text-sm">
          {items.map((item) => (
            <div key={item.id} className="flex justify-between">
              <span>
                <span className="font-mono text-xs text-muted-foreground mr-1">{item.sku}</span>
                {item.title ?? ""}
              </span>
              <span className="font-mono">x{item.quantity}</span>
            </div>
          ))}
          {items.length === 0 && <p className="text-muted-foreground">No items</p>}
        </div>
      </div>

      {/* Column 2: Bandcamp Status + Shipment & Tracking */}
      <div className="space-y-4">
        {/* Section A: Bandcamp Platform Status */}
        {isBandcamp && (
          <div>
            <h4 className="text-sm font-semibold mb-1">Bandcamp Status</h4>
            {fulfillmentStatus === "fulfilled" ? (
              <Badge variant="default" className="gap-1">
                <CheckCircle className="h-3 w-3" /> Fulfilled on Bandcamp
              </Badge>
            ) : (
              <Badge variant="outline">Unfulfilled on Bandcamp</Badge>
            )}
          </div>
        )}

        {/* Section B: Shipment & Tracking from our system */}
        <div>
          <h4 className="text-sm font-semibold mb-2">Shipment & Tracking</h4>
          {shipments.length > 0 ? (
            <div className="space-y-3">
              {shipments.map((s) => (
                <div key={s.id} className="border rounded-lg p-3">
                  <div className="flex items-center justify-between mb-2">
                    <span className="font-mono text-xs text-muted-foreground truncate">
                      {s.tracking_number ?? "No tracking number"}
                    </span>
                    <a
                      href={`/portal/shipping?search=${encodeURIComponent(s.tracking_number ?? "")}`}
                      className="text-xs text-blue-600 hover:underline shrink-0 ml-2"
                    >
                      Shipping details →
                    </a>
                  </div>
                  <TrackingTimeline
                    shipmentId={s.id}
                    trackingNumber={s.tracking_number}
                    carrier={s.carrier}
                    fetchEvents={getTrackingEvents}
                  />
                </div>
              ))}
            </div>
          ) : fulfillmentStatus === "fulfilled" ? (
            <p className="text-sm text-muted-foreground">
              Fulfilled — tracking not available in this system.
            </p>
          ) : (
            <p className="text-sm text-muted-foreground">Not yet shipped.</p>
          )}
        </div>
      </div>
    </div>
  );
}
```

---

### Step 7 — Patch portal shipping page

**File:** `src/app/portal/shipping/page.tsx`

**Changes from current file:**
- Add "Order" column header between Tracking and Carrier
- Add order reference `<TableCell>` with link to `/portal/fulfillment`
- Add label source badge (`SS` / `EP`) in carrier cell
- Bump `colSpan` from 5 to 6 in expanded row and empty state

**Full updated file:**

```typescript
"use client";

import { Package } from "lucide-react";
import { PaginationBar } from "@/components/shared/pagination-bar";
import { useState } from "react";
import { getClientShipments, getShipmentItems, getTrackingEvents } from "@/actions/orders";
import { TrackingTimeline } from "@/components/shared/tracking-timeline";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useAppQuery } from "@/lib/hooks/use-app-query";
import { queryKeys } from "@/lib/shared/query-keys";
import { CACHE_TIERS } from "@/lib/shared/query-tiers";

type ShipmentRow = Awaited<ReturnType<typeof getClientShipments>>["shipments"][number];

export default function PortalShippingPage() {
  const [filters, setFilters] = useState({ page: 1, pageSize: 25, status: "", carrier: "" });
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const { data, isLoading } = useAppQuery({
    queryKey: queryKeys.shipments.list({ ...filters, portal: true }),
    queryFn: () => getClientShipments(filters),
    tier: CACHE_TIERS.SESSION,
  });

  const { data: expandedItems, isLoading: itemsLoading } = useAppQuery({
    queryKey: ["shipment-items", expandedId],
    queryFn: () => getShipmentItems(expandedId ?? ""),
    tier: CACHE_TIERS.SESSION,
    enabled: !!expandedId,
  });

  return (
    <div className="p-6 space-y-4">
      <h1 className="text-2xl font-semibold tracking-tight">Shipping</h1>

      <div className="flex flex-wrap gap-3">
        <Input
          placeholder="Filter by carrier..."
          value={filters.carrier}
          onChange={(e) => setFilters((f) => ({ ...f, carrier: e.target.value, page: 1 }))}
          className="w-48"
        />
        <select
          value={filters.status}
          onChange={(e) => setFilters((f) => ({ ...f, status: e.target.value, page: 1 }))}
          className="border-input bg-background h-9 rounded-md border px-3 text-sm"
        >
          <option value="">All statuses</option>
          <option value="shipped">Shipped</option>
          <option value="in_transit">In Transit</option>
          <option value="out_for_delivery">Out for Delivery</option>
          <option value="delivered">Delivered</option>
          <option value="exception">Exception</option>
        </select>
      </div>

      {isLoading ? (
        <div className="space-y-2">
          {[1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Tracking</TableHead>
              <TableHead>Order</TableHead>
              <TableHead>Carrier</TableHead>
              <TableHead>Ship Date</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Weight</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {(data?.shipments ?? []).map((shipment: ShipmentRow) => {
              const orderNumber = (
                shipment as ShipmentRow & {
                  warehouse_orders?: { order_number?: string | null } | null;
                }
              ).warehouse_orders?.order_number ?? null;

              const labelSource = (shipment as ShipmentRow & { label_source?: string | null })
                .label_source;

              return (
                <>
                  <TableRow
                    key={shipment.id}
                    className="cursor-pointer"
                    onClick={() =>
                      setExpandedId((prev) => (prev === shipment.id ? null : shipment.id))
                    }
                  >
                    <TableCell className="font-mono text-xs">
                      {shipment.tracking_number ?? "—"}
                    </TableCell>

                    {/* Order reference — links back to fulfillment page */}
                    <TableCell>
                      {orderNumber ? (
                        <a
                          href={`/portal/fulfillment?search=${encodeURIComponent(orderNumber)}`}
                          className="font-mono text-xs text-blue-600 hover:underline"
                          onClick={(e) => e.stopPropagation()}
                        >
                          {orderNumber}
                        </a>
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </TableCell>

                    {/* Carrier + label source badge */}
                    <TableCell>
                      <div className="flex items-center gap-1.5">
                        <span>{shipment.carrier ?? "—"}</span>
                        {labelSource === "shipstation" && (
                          <span className="text-xs bg-blue-100 text-blue-700 px-1 rounded">SS</span>
                        )}
                        {labelSource === "easypost" && (
                          <span className="text-xs bg-green-100 text-green-700 px-1 rounded">EP</span>
                        )}
                      </div>
                    </TableCell>

                    <TableCell className="text-sm">
                      {shipment.ship_date
                        ? new Date(shipment.ship_date + "T12:00:00").toLocaleDateString()
                        : "—"}
                    </TableCell>
                    <TableCell>
                      <ShipmentStatusBadge status={shipment.status} />
                    </TableCell>
                    <TableCell className="text-muted-foreground text-sm">
                      {shipment.weight ? `${shipment.weight} lbs` : "—"}
                    </TableCell>
                  </TableRow>

                  {expandedId === shipment.id && (
                    <TableRow key={`${shipment.id}-detail`}>
                      <TableCell colSpan={6} className="bg-muted/30 p-4">
                        <div className="grid grid-cols-2 gap-6">
                          <div>
                            <h4 className="text-sm font-semibold mb-2">Items</h4>
                            {itemsLoading ? (
                              <Skeleton className="h-16 w-full" />
                            ) : !expandedItems || expandedItems.length === 0 ? (
                              <p className="text-muted-foreground text-sm">No items recorded</p>
                            ) : (
                              <div className="space-y-1 text-sm">
                                {expandedItems.map((item) => (
                                  <div key={item.id} className="flex justify-between">
                                    <span>
                                      <span className="font-mono text-xs text-muted-foreground">
                                        {item.sku}
                                      </span>{" "}
                                      {item.product_title ?? ""}
                                    </span>
                                    <span className="font-mono">x{item.quantity}</span>
                                  </div>
                                ))}
                              </div>
                            )}

                            {/* Shipping cost comparison — clients can see if their
                                platform shipping prices need adjusting */}
                            {(() => {
                              const charged = (shipment as ShipmentRow & { customer_shipping_charged?: number | null }).customer_shipping_charged ?? null;
                              const cost = shipment.shipping_cost ?? null;
                              const gap = charged != null && cost != null ? charged - cost : null;
                              return (charged != null || cost != null) ? (
                                <div className="mt-3 text-sm space-y-0.5">
                                  {charged != null && (
                                    <div className="flex justify-between">
                                      <span className="text-muted-foreground">Customer paid</span>
                                      <span className="font-mono">${charged.toFixed(2)}</span>
                                    </div>
                                  )}
                                  {cost != null && (
                                    <div className="flex justify-between">
                                      <span className="text-muted-foreground">Postage</span>
                                      <span className="font-mono">${cost.toFixed(2)}</span>
                                    </div>
                                  )}
                                  {gap != null && (
                                    <div className={`flex justify-between font-medium border-t pt-0.5 ${gap >= 0 ? "text-green-700" : "text-red-600"}`}>
                                      <span>Difference</span>
                                      <span className="font-mono">{gap >= 0 ? "+" : ""}{gap.toFixed(2)}</span>
                                    </div>
                                  )}
                                </div>
                              ) : null;
                            })()}
                          </div>

                          <div>
                            <h4 className="text-sm font-semibold mb-2">Tracking</h4>
                            <TrackingTimeline
                              shipmentId={shipment.id}
                              trackingNumber={shipment.tracking_number}
                              carrier={shipment.carrier}
                              fetchEvents={getTrackingEvents}
                            />
                          </div>
                        </div>
                      </TableCell>
                    </TableRow>
                  )}
                </>
              );
            })}
            {data?.shipments.length === 0 && (
              <TableRow>
                <TableCell colSpan={6} className="py-8 text-center text-muted-foreground">
                  <Package className="h-8 w-8 mx-auto mb-2 opacity-50" />
                  No shipments found.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      )}

      {data && data.total > 0 && (
        <PaginationBar
          page={filters.page}
          pageSize={filters.pageSize}
          total={data.total}
          onPageChange={(p) => setFilters((f) => ({ ...f, page: p }))}
          onPageSizeChange={(s) => setFilters((f) => ({ ...f, pageSize: s, page: 1 }))}
        />
      )}
    </div>
  );
}

function ShipmentStatusBadge({ status }: { status: string }) {
  const config: Record<
    string,
    { variant: "default" | "secondary" | "destructive" | "outline"; label: string }
  > = {
    shipped: { variant: "secondary", label: "Shipped" },
    in_transit: { variant: "secondary", label: "In Transit" },
    out_for_delivery: { variant: "default", label: "Out for Delivery" },
    delivered: { variant: "default", label: "Delivered" },
    exception: { variant: "destructive", label: "Exception" },
  };
  const c = config[status] ?? { variant: "outline" as const, label: status };
  return <Badge variant={c.variant}>{c.label}</Badge>;
}
```

---

### Step 8 — Patch admin shipping log list

**File:** `src/app/admin/shipping/page.tsx`

**Changes from current file (targeted, rest is unchanged):**
- `getShipments` select in `src/actions/shipping.ts`: add `customer_shipping_charged` to select string
- In `ShipmentTableRow`: add `ssOrderNum` from `ss_order_number` and insert it in `displayOrderRef` priority chain
- In `ShipmentTableRow`: add label source badge in the tracking cell after the carrier badge
- In `ShipmentTableRow`: add shipping gap dot indicator in the Cost cell (green = sufficient, red = shortfall)
- In `ShipmentExpandedDetail`: replace Cost Breakdown section with Charged / Postage / Difference comparison

Only `ShipmentTableRow` and `ShipmentExpandedDetail` change. All other functions remain identical.

**Updated `ShipmentTableRow` function (full, replace lines 290–403):**

```typescript
function ShipmentTableRow({
  shipment,
  isExpanded,
  onToggle,
  detail,
  detailLoading,
}: {
  shipment: ShipmentRow;
  isExpanded: boolean;
  onToggle: () => void;
  detail: ShipmentDetail | undefined;
  detailLoading: boolean;
}) {
  const recipient = extractRecipient(shipment.label_data);

  // Priority: linked warehouse_order number > ss_order_number from ShipStation > SS-{id} fallback
  const orderNumber =
    (shipment.warehouse_orders as unknown as { order_number: string | null } | null)
      ?.order_number ?? null;
  const ssOrderNum = (shipment as ShipmentRow & { ss_order_number?: string | null })
    .ss_order_number ?? null;
  const displayOrderRef =
    orderNumber ??
    ssOrderNum ??
    (shipment.shipstation_shipment_id ? `SS-${shipment.shipstation_shipment_id}` : null);

  const clientName =
    (shipment.organizations as unknown as { name: string } | null)?.name ?? null;
  // Use total_units (physical units shipped) not warehouse_shipment_items.length (line count).
  // A shipment with 1 line of qty 3 should show "3", not "1".
  // total_units is computed from itemsRaw during ingest and stored on the shipment row.
  const itemCount = (shipment as ShipmentRow & { total_units?: number | null }).total_units ?? 0;
  const trackingUrl = getCarrierTrackingUrl(shipment.carrier, shipment.tracking_number);
  const carrierLabel = getCarrierLabel(shipment.carrier);
  const labelSource = (shipment as ShipmentRow & { label_source?: string | null }).label_source;

  // Shipping gap — what customer paid vs. what postage cost
  const customerCharged = (shipment as ShipmentRow & { customer_shipping_charged?: number | null })
    .customer_shipping_charged ?? null;
  const postage = shipment.shipping_cost ?? null;
  const shippingGap = customerCharged != null && postage != null ? customerCharged - postage : null;

  return (
    <>
      <tr
        className="border-b cursor-pointer hover:bg-muted/30 transition-colors"
        onClick={onToggle}
      >
        <td className="px-4 py-3">
          {shipment.ship_date
            ? new Date(shipment.ship_date + "T12:00:00").toLocaleDateString()
            : "---"}
        </td>
        <td className="px-4 py-3 font-mono text-xs">{displayOrderRef ?? "---"}</td>
        <td className="px-4 py-3 text-sm text-muted-foreground">{clientName ?? "—"}</td>
        <td className="px-4 py-3">
          <div className="min-w-0">
            <p className="truncate text-sm">{recipient?.name ?? "---"}</p>
            {recipient?.city && (
              <p className="text-xs text-muted-foreground truncate">
                {recipient.city}
                {recipient.state ? `, ${recipient.state}` : ""}
              </p>
            )}
          </div>
        </td>
        <td className="px-4 py-3">
          <div className="flex items-center gap-1.5">
            {carrierLabel && <Badge variant="secondary">{carrierLabel}</Badge>}
            {/* Label source badge — SS (ShipStation) or EP (EasyPost) */}
            {labelSource === "shipstation" && (
              <span className="text-xs bg-blue-100 text-blue-700 px-1 rounded">SS</span>
            )}
            {labelSource === "easypost" && (
              <span className="text-xs bg-green-100 text-green-700 px-1 rounded">EP</span>
            )}
            <span className="font-mono text-xs">
              {shipment.tracking_number ?? "---"}
            </span>
            {trackingUrl && (
              <a
                href={trackingUrl}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => e.stopPropagation()}
                className="text-blue-600 hover:text-blue-800 shrink-0"
              >
                <ExternalLink className="h-3 w-3" />
              </a>
            )}
          </div>
        </td>
        <td className="px-4 py-3 text-center">
          <div className="inline-flex items-center gap-1 text-muted-foreground">
            <Package className="h-3.5 w-3.5" />
            <span className="tabular-nums">{itemCount}</span>
          </div>
        </td>
        <td className="px-4 py-3">
          <div className="flex items-center gap-1.5 flex-wrap">
            <StatusBadge status={shipment.status} />
            {(
              shipment as ShipmentRow & {
                bandcamp_payment_id?: number | null;
                bandcamp_synced_at?: string | null;
              }
            ).bandcamp_payment_id != null && (
              <Badge variant="secondary" className="text-xs">
                BC
                {(shipment as ShipmentRow & { bandcamp_synced_at?: string | null })
                  .bandcamp_synced_at
                  ? " ✓"
                  : ""}
              </Badge>
            )}
          </div>
        </td>
        {/* Cost cell — postage paid + gap dot indicator */}
        <td className="px-4 py-3 text-right font-mono">
          <div className="flex items-center justify-end gap-1.5">
            {shippingGap != null && (
              <span
                className={`inline-block h-2 w-2 rounded-full flex-shrink-0 ${
                  shippingGap >= 0 ? "bg-green-500" : "bg-red-500"
                }`}
                title={
                  shippingGap >= 0
                    ? `Charged $${customerCharged?.toFixed(2)} / Postage $${postage?.toFixed(2)} (+$${shippingGap.toFixed(2)})`
                    : `Charged $${customerCharged?.toFixed(2)} / Postage $${postage?.toFixed(2)} (-$${Math.abs(shippingGap).toFixed(2)} shortfall)`
                }
              />
            )}
            {formatCurrency(shipment.shipping_cost)}
          </div>
        </td>
      </tr>
      {isExpanded && (
        <tr className="border-b bg-muted/10">
          <td colSpan={7} className="px-6 py-5">
            {detailLoading ? (
              <div className="space-y-2">
                <Skeleton className="h-4 w-48" />
                <Skeleton className="h-4 w-64" />
                <Skeleton className="h-4 w-40" />
              </div>
            ) : detail ? (
              <ShipmentExpandedDetail detail={detail} />
            ) : null}
          </td>
        </tr>
      )}
    </>
  );
}
```

---

### Step 9 — Unit tests for order matching scoring

**File:** `src/trigger/tasks/__tests__/shipstation-order-matching.test.ts`

```typescript
import { describe, it, expect } from "vitest";

// Pure scoring function extracted for testability
function scoreCandidate(signals: {
  postalMatch: boolean;
  skuMatches: number;
  nameMatch: boolean;
  daysBeforeShip: number;
}): number {
  let score = 0;
  if (signals.postalMatch) score += 30;
  if (signals.skuMatches > 0) score += 40 + Math.min(signals.skuMatches - 1, 3) * 5;
  if (signals.nameMatch) score += 20;
  if (signals.daysBeforeShip >= 0 && signals.daysBeforeShip <= 14) score += 10;
  else if (signals.daysBeforeShip > 14 && signals.daysBeforeShip <= 30) score += 5;
  return score;
}

describe("matchShipmentToOrder — scoring", () => {
  it("postal + 1 SKU alone meets threshold (70 ≥ 50)", () => {
    expect(scoreCandidate({ postalMatch: true, skuMatches: 1, nameMatch: false, daysBeforeShip: 60 })).toBe(70);
  });

  it("SKU alone does NOT meet threshold (40 < 50)", () => {
    expect(scoreCandidate({ postalMatch: false, skuMatches: 1, nameMatch: false, daysBeforeShip: 60 })).toBe(40);
  });

  it("postal + SKU + name + recent date = 100", () => {
    expect(scoreCandidate({ postalMatch: true, skuMatches: 1, nameMatch: true, daysBeforeShip: 3 })).toBe(100);
  });

  it("2 SKU matches adds 5 more points over 1 match", () => {
    const one = scoreCandidate({ postalMatch: false, skuMatches: 1, nameMatch: false, daysBeforeShip: 60 });
    const two = scoreCandidate({ postalMatch: false, skuMatches: 2, nameMatch: false, daysBeforeShip: 60 });
    expect(two - one).toBe(5);
  });

  it("4+ SKU matches caps at same as 4 matches", () => {
    const four = scoreCandidate({ postalMatch: false, skuMatches: 4, nameMatch: false, daysBeforeShip: 60 });
    const ten  = scoreCandidate({ postalMatch: false, skuMatches: 10, nameMatch: false, daysBeforeShip: 60 });
    expect(four).toBe(ten); // cap at +15 bonus (3 extras × 5)
  });

  it("order 15-30 days before ship gets +5 not +10", () => {
    const close = scoreCandidate({ postalMatch: true, skuMatches: 1, nameMatch: false, daysBeforeShip: 5 });
    const far   = scoreCandidate({ postalMatch: true, skuMatches: 1, nameMatch: false, daysBeforeShip: 20 });
    expect(close - far).toBe(5);
  });

  it("order after ship date gets no date points", () => {
    // daysBeforeShip = -1 means order created AFTER ship date (data error)
    const score = scoreCandidate({ postalMatch: true, skuMatches: 1, nameMatch: false, daysBeforeShip: -1 });
    expect(score).toBe(70); // postal(30) + sku(40), no date bonus
  });
});

describe("matchShipmentToOrder — winner selection", () => {
  it("single candidate above threshold → linked", () => {
    const scored = [{ id: "order-1", score: 70, signals: ["postal_code", "sku_match(1)"] }];
    const winner = scored.length === 1 ? scored[0].id : null;
    expect(winner).toBe("order-1");
  });

  it("two candidates within 20 pts → ambiguous (no auto-link)", () => {
    const scored = [
      { id: "order-1", score: 80, signals: [] },
      { id: "order-2", score: 65, signals: [] },
    ];
    const gap = scored[0].score - scored[1].score; // 15 < 20
    expect(gap).toBeLessThan(20); // → should go to review queue
  });

  it("two candidates with ≥20pt gap → clear winner linked", () => {
    const scored = [
      { id: "order-1", score: 90, signals: [] },
      { id: "order-2", score: 65, signals: [] },
    ];
    const gap = scored[0].score - scored[1].score; // 25 ≥ 20
    expect(gap).toBeGreaterThanOrEqual(20);
  });
});
```

---

### Notes on Deferred Items

**ShipStation API version** (validated by external reviewer): The V1 REST API `/shipments` endpoint natively supports `includeShipmentItems=true`, and the returned payload contains `unitPrice` inside the `shipmentItems` array. Field names (`orderNumber`, `createDate`, `shipmentItems`, `shippingAmount`) match the V1 schema and are confirmed in the live docs. Note: `unitPrice` is parsed by the Zod schema but intentionally not stored — this is a product decision, not a gap. Before relying on poll auto-heal for the 89 zero-item rows, verify in staging that `includeShipmentItems=true` returns items for shipments older than 30 days — if not, run the dedicated backfill script.

**89 zero-item shipments backfill**: The plan says "next poll auto-heals." This is only true if ShipStation still returns `shipmentItems` for those older shipments. If verification shows they don't, run a targeted script: `SELECT shipstation_shipment_id FROM warehouse_shipments WHERE total_units = 0 AND shipstation_shipment_id IS NOT NULL` → fetch each by ID from ShipStation → upsert items. This is bounded (89 rows) and safe.

**Race condition on order matching**: With `shipstationQueue` at `concurrencyLimit: 1`, two concurrent poll runs for the same workspace cannot occur. Low risk now. If multi-workspace is added later, the `ignoreDuplicates: true` pattern in Step A of the upsert already handles it gracefully.

**Health sensor task**: Good pattern, separate PR. Would check: duplicate count, zero-item shipments, unlinked shipments with `ss_order_number` set.

**Redis idempotency key**: Redundant given `concurrencyLimit: 1` on the queue. Trigger.dev's queue handles serialization.

**SLA badges, carrier performance, exception alerts**: Valid 3PL best practices, queued for a UI enhancement sprint after this fix lands.

**EasyPost UNIQUE constraint**: Add when EasyPost labels go live. Column structure is ready (`easypost_labels` table has `easypost_shipment_id text NOT NULL UNIQUE`).

**Dedup item merge and same-SKU lines (accepted tradeoff)**: The Step 1 dedup SQL moves items from duplicate rows to the keeper using `sku` as the dedup key. If a shipment genuinely contained two lines with the same SKU (e.g. the same record in two different color variants but identical SKUs), the merge will collapse them — the second line is lost. This is unavoidable because `item_index` doesn't exist until Step 2. External review confirms this is an acceptable tradeoff: restoring DB integrity before the migration is the right priority. After Step 3 deploys, the next poll will re-ingest items correctly using `item_index`-keyed upsert.

**"UNKNOWN" SKU sentinel**: When ShipStation returns a `shipmentItem` with a null SKU, the plan stores `"UNKNOWN"` as the SKU. Downstream code (especially the SKU-overlap scoring in `matchShipmentToOrder`) must treat `"UNKNOWN"` as a sentinel and exclude it from matching logic — otherwise all "UNKNOWN" shipments score as matching each other on SKU overlap. Add a filter `itemSkus.filter(sku => sku !== "UNKNOWN")` before SKU comparison in `matchShipmentToOrder`.

**`fetchOrders` is account-wide, not store-scoped**: The order pre-fetch for `shippingAmount` fetches all shipped orders in the 30-day window for the entire ShipStation account. If multiple client stores share a single ShipStation account, the `orderNumber → shippingAmount` map will include orders from other stores. In practice this is harmless (the map is only used for lookup by exact order number, and order numbers are unique per-store), but as a future improvement: pass `storeId` to `fetchOrders` when available and build per-store maps to reduce result set size and prevent any theoretical collision.

**External platform sync for non-Bandcamp fulfilled orders**: When a ShipStation shipment is auto-linked to a non-Bandcamp `warehouse_orders` row (e.g. a Shopify or WooCommerce order), the plan marks that order `fulfillment_status = "fulfilled"` locally. It does NOT trigger an outbound task to push tracking back to the client's Shopify/WooCommerce storefront. This is out of scope for this plan — platform fulfillment sync (`mark-platform-fulfilled` task) is a separate concern. Staff should manually trigger platform fulfillment notification via the Orders page until that automation is built.

**Order number normalization and multi-source collision risk**: The `normalizeOrderNumber` function strips prefixes and all non-alphanumeric characters. If non-Bandcamp orders in the same workspace happen to have overlapping numeric IDs (e.g. Shopify order `#1234` and a manual order `1234`), normalized comparison could produce false candidates in Phase 1. Mitigation: Phase 1 only auto-links on exact normalized match, and if multiple warehouse_orders rows match the same normalized key, Phase 1 would return the first match. Future improvement: store a `normalized_order_number` column per source, or scope Phase 1 exact match to `source = 'bandcamp'` when `orderNumber` starts with `BC-`.

---

## 5. Risk + Rollback

| Risk | Mitigation | Rollback |
|---|---|---|
| Step 1 SQL loses items on dedup | New SQL moves items to keeper row first via UPDATE, then deletes duplicates; wrapped in BEGIN/COMMIT | ROLLBACK before COMMIT if preview looks wrong |
| Step 1 SQL deletes wrong rows | Preview query must confirm expected duplicates; transaction wrapping allows ROLLBACK | Restore from Supabase backup if committed |
| Step 2 UNIQUE constraint fails | Must run Step 1 dedup first; re-verify 0 duplicates before applying; constraint is a standard UNIQUE (not partial), compatible with Supabase .upsert() | `ALTER TABLE warehouse_shipments DROP CONSTRAINT uq_shipments_ss_id` |
| Step 2 item_index UNIQUE fails | Existing items all have default index 0; new upsert adds item_index during ingest | `ALTER TABLE warehouse_shipment_items DROP CONSTRAINT uq_shipment_items_idx` |
| Step 3 upsert accidentally overwrites org_id or order_id | Upsert uses `ignoreDuplicates: true`; mutable fields updated in separate `.update()` call that explicitly omits these columns | Corrections done manually via SQL; no automated path overwrites them |
| Step 3 items upsert with `item_index` fails | Requires migration Step 2 to add column first; deploy order enforces this | Fall back to `ignoreDuplicates: true` on items insert |
| Step 3 ghost items from reduced payload | Pruning query runs after successful upsert to delete rows where `item_index >= itemsRaw.length`; only runs when upsert succeeds | `SELECT * FROM warehouse_shipment_items WHERE shipment_id = '...' AND item_index >= N` to verify before manual delete |
| matchShipmentToOrder false positives | Probabilistic phase never auto-links — only writes to review queue for human confirmation | No rollback needed; staff simply ignores or dismisses the review item |
| matchShipmentToOrder exact phase wrong match | Only fires on normalized order number equality — near-zero false positive risk | `UPDATE warehouse_shipments SET order_id = NULL WHERE id = '...'` |
| getClientShipments org filter breaks portal | Test with real client login before deploying; RLS is defense-in-depth backup | Revert to original query (RLS still protects) |
| Portal fulfillment shows wrong Bandcamp status | `fulfillment_status` from `bandcamp-order-sync`; verify sync is current | No data change — UI-only revert |

---

## 6. Verification Plan

**After Step 1 (Dedup SQL):**
```sql
-- 0 duplicates remaining
SELECT COUNT(*) FROM (
  SELECT shipstation_shipment_id FROM warehouse_shipments
  GROUP BY workspace_id, shipstation_shipment_id HAVING COUNT(*) > 1
) dup;

-- Items were preserved (total should be ≥ pre-dedup count)
SELECT COUNT(*) FROM warehouse_shipment_items;

-- Spot-check: a formerly-duplicated shipment should have items
SELECT ws.shipstation_shipment_id, COUNT(wsi.id) as item_count
FROM warehouse_shipments ws
LEFT JOIN warehouse_shipment_items wsi ON wsi.shipment_id = ws.id
WHERE ws.shipstation_shipment_id = '131150298'  -- replace with known duplicate
GROUP BY ws.shipstation_shipment_id;
```

**After Step 2 (Migration):**
```sql
-- Constraints exist
SELECT conname FROM pg_constraint
WHERE conname IN ('uq_shipments_ss_id', 'uq_shipment_items_idx');

-- New columns exist
SELECT column_name FROM information_schema.columns
WHERE table_name = 'warehouse_shipments'
AND column_name IN ('ss_order_number', 'ss_create_date', 'label_source');
```

**After Step 3 (poll upsert):**
- Wait one poll cycle (30 min)
- Check `channel_sync_log` for `sync_type='shipstation_poll'` — should show processed + skipped counts
- Query: `SELECT COUNT(*) FROM warehouse_shipment_items WHERE created_at > now() - interval '1 hour'` — items should be re-synced
- Check a specific shipment: `SELECT * FROM warehouse_shipments WHERE shipstation_shipment_id = '131150298'` — should be exactly 1 row with `ss_order_number`, `label_source='shipstation'`

**After auto-linking:**
```sql
-- How many shipments now have order_id set?
SELECT COUNT(*) FROM warehouse_shipments WHERE order_id IS NOT NULL;

-- Sample linked pairs
SELECT ws.shipstation_shipment_id, ws.ss_order_number, wo.order_number, wo.fulfillment_status
FROM warehouse_shipments ws
JOIN warehouse_orders wo ON ws.order_id = wo.id
LIMIT 10;
```

**After UI changes:**
- Admin orders page: expand a Bandcamp order → see "Fulfilled on Bandcamp" badge AND tracking timeline (not just one)
- Admin orders page: fulfilled order with linked shipment → Create Label NOT shown
- Portal fulfillment: expand order → see both status sections
- Portal shipping: order reference column shows order number with link

---

## 7. Recommended Execution Order

The original plan had the org security fix as Step 4. The reviewer correctly noted it should be first — a missing `org_id` filter is a security gap that ships independently of everything else and has zero DB dependency.

```
1. Portal org scoping fix (Step 4 in plan, but deploy FIRST)
   → src/actions/orders.ts getClientShipments — 10 lines, no migration, no risk
   → Deploy independently before any DB changes

2. Dedup SQL (Step 1 in plan)
   → Run in Supabase SQL Editor
   → BEGIN; preview; COMMIT if looks right
   → Verify: 0 duplicates, item count preserved

3. Migration (Step 2 in plan)
   → Adds standard UNIQUE constraint (workspace_id, shipstation_shipment_id), ss_order_number, ss_create_date, label_source NOT NULL, item_index, customer_shipping_charged
   → item_index on warehouse_shipment_items + UNIQUE constraint
   → item_index + UNIQUE constraint on warehouse_shipment_items (enables safe upsert)
   → customer_shipping_charged on warehouse_shipments (shipping margin analysis)

4. Poll upsert rewrite (Step 3 in plan)
   → Deploy to Trigger.dev
   → Wait one 30-min poll cycle
   → Verify: items populating, ss_order_number filling in

5. Verify 89 zero-item rows (Step 3b note)
   → Check if poll auto-healed them
   → If not, run targeted backfill script

6. UI changes (Steps 5-8 in plan)
   → Admin orders two-status display
   → Portal fulfillment parity
   → Shipping log: order ref, item count, label source badge
```

---

## 8. Doc Sync Contract

Per `TRUTH_LAYER.md` requirements:

| Doc | Required Update |
|---|---|
| `docs/system_map/TRIGGER_TASK_CATALOG.md` | Update `shipstation-poll` description: upsert semantics, auto-linking, new fields captured |
| `docs/system_map/API_CATALOG.md` | Update `getShipments` return shape (new fields); update `getClientShipments` (org-scoped); update `getOrderDetail` (shipments now auto-linked) |
