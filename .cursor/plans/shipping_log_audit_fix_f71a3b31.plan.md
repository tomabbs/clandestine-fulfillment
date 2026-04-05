---
name: Shipping Log Audit Fix
overview: Fix duplicate shipments, missing item data, disconnected orders, and portal security gap in the shipping log — via dedup SQL, DB migration, poll rewrite, and UI updates. Two rounds of external review have been integrated into `docs/SHIPPING_LOG_AUDIT_FIX.md`, which supersedes the older plan file.
todos:
  - id: org-security-fix
    content: Patch getClientShipments in src/actions/orders.ts to add explicit org_id filter and warehouse_orders join
    status: pending
  - id: dedup-sql
    content: "Run richness-ranked dedup SQL in Supabase SQL editor (BEGIN/COMMIT): merge fields to keeper, move items, delete duplicates"
    status: completed
  - id: migration
    content: "Create supabase/migrations/20260402000001_shipments_hardening.sql: partial unique index, ss_order_number, ss_create_date, label_source NOT NULL, item_index, unit_price"
    status: completed
  - id: poll-rewrite
    content: "Rewrite shipstation-poll.ts ingestFromPoll: insert-or-skip upsert, separate mutable-only update, items upsert with item_index + unit_price, matchShipmentToOrder with exact phase + probabilistic-review-queue-only phase"
    status: completed
  - id: easypost-label-source
    content: "Add label_source: 'easypost' to create-shipping-label.ts warehouse_shipments insert"
    status: completed
  - id: ui-patches
    content: Patch admin/orders, portal/fulfillment (two-status display), admin/shipping, portal/shipping (order ref column + label_source badge), actions/shipping.ts select string
    status: pending
  - id: doc-sync
    content: Update TRIGGER_TASK_CATALOG.md and API_CATALOG.md
    status: completed
isProject: false
---

# Shipping Log Audit Fix — Implementation Plan

The old plan file at `shipping_log_audit_fix_5ed7007e.plan.md` has been superseded. This reflects the fully reviewed version in `[docs/SHIPPING_LOG_AUDIT_FIX.md](Project/clandestine-fulfillment/docs/SHIPPING_LOG_AUDIT_FIX.md)`.

## Key changes from the old plan file

- **Execution order rewritten** — org security fix ships first (no migration, lowest risk)
- **Partial unique index** replaces UNIQUE constraint (clearer for multi-source ledger)
- **Dedup keeps richest row** (has `order_id`, most items) not just oldest
- **Auto-link split into two phases**: exact normalized order number → auto-link; probabilistic scoring → review queue only, never auto-assign
- `**org_id` and `order_id` protected** from being overwritten on re-ingest
- `**label_source` enforced NOT NULL** after backfill
- `**unit_price`** added to `warehouse_shipment_items`
- `**item_index`** added for safe item upsert (same SKU twice in one shipment)

## Execution Order

```
1. Org security fix  (src/actions/orders.ts — 15 lines, no migration)
2. Dedup SQL         (Supabase SQL editor, BEGIN/COMMIT transaction)
3. Migration         (supabase/migrations/20260402000001_shipments_hardening.sql)
4. Poll rewrite      (shipstation-poll.ts — deploy to Trigger.dev)
5. EasyPost patch    (create-shipping-label.ts — add label_source: 'easypost')
6. UI patches        (admin/orders, portal/fulfillment, admin/shipping, portal/shipping)
7. Doc sync          (TRIGGER_TASK_CATALOG.md, API_CATALOG.md)
```

## Step 1 — Org security fix

**File:** `[src/actions/orders.ts](Project/clandestine-fulfillment/src/actions/orders.ts)`

`getClientShipments` currently has no `org_id` filter — it queries all shipments across all orgs. Fix:

```typescript
export async function getClientShipments(filters) {
  const supabase = await createServerSupabaseClient();
  const { data: { user } } = await supabase.auth.getUser();
  const { data: userRecord } = await createServiceRoleClient()
    .from("users").select("org_id").eq("auth_user_id", user!.id).single();
  if (!userRecord?.org_id) return { shipments: [], total: 0, page: 1, pageSize: 25 };

  let query = supabase
    .from("warehouse_shipments")
    .select("*, warehouse_orders(order_number)", { count: "exact" })
    .eq("org_id", userRecord.org_id)  // ADD
    .order("ship_date", { ascending: false })
    .range(offset, offset + pageSize - 1);
}
```

## Step 2 — Dedup SQL (run in Supabase SQL editor)

Three sub-steps inside a `BEGIN/COMMIT` transaction:

- **Step A**: Rank duplicate sets by richness score (`order_id IS NOT NULL` = +100, `org_id` set = +10, `tracking_number` = +5, `label_data` = +5, +2 per item row). Merge useful fields (order_id, org_id, tracking_number, label_data, ss_order_number) from non-keepers into the keeper using `COALESCE`.
- **Step B**: Move `warehouse_shipment_items` from duplicate rows to keeper (skip if same SKU already exists on keeper).
- **Step C**: Delete duplicate rows (remaining orphaned items cascade-delete).

Full SQL is in `docs/SHIPPING_LOG_AUDIT_FIX.md` Step 1.

## Step 3 — Migration

**New file:** `supabase/migrations/20260402000001_shipments_hardening.sql`

Changes to `warehouse_shipments`:

- `CREATE UNIQUE INDEX uq_shipments_ss_id ON warehouse_shipments (workspace_id, shipstation_shipment_id) WHERE shipstation_shipment_id IS NOT NULL` — partial index (not constraint) so non-SS rows with NULL don't cause ambiguity
- `ADD COLUMN ss_order_number text` + index
- `ADD COLUMN ss_create_date timestamptz`
- `ADD COLUMN label_source text CHECK (... IN ('shipstation','easypost','pirate_ship','manual'))` → backfill ShipStation rows → backfill remaining as `'manual'` → `SET NOT NULL` → `SET DEFAULT 'manual'`

Changes to `warehouse_shipment_items`:

- `ADD COLUMN item_index integer NOT NULL DEFAULT 0`
- `ADD CONSTRAINT uq_shipment_items_idx UNIQUE (shipment_id, sku, item_index)` — enables safe item upsert when same SKU appears twice in one shipment
- `ADD COLUMN unit_price numeric(10,2)` — from ShipStation `unitPrice`, used for billing reconciliation

## Step 4 — Poll rewrite

**File:** `[src/trigger/tasks/shipstation-poll.ts](Project/clandestine-fulfillment/src/trigger/tasks/shipstation-poll.ts)`

Two main changes:

**Loop**: Remove the `maybeSingle()` check-then-skip. Call `ingestFromPoll` directly for every shipment; the upsert handles idempotency.

`**ingestFromPoll` rewrite** — three-part approach to protect immutable fields:

- **Insert-or-do-nothing**: upsert with `ignoreDuplicates: true`. On first insert, sets `org_id` from `matchShipmentOrg`. All mutable tracking fields set here.
- **Fetch existing if conflict**: if upsert returned nothing (row existed), fetch it to get `id` and current `order_id`.
- **Update mutable fields only**: `.update()` call that explicitly omits `org_id` and `order_id` — these are never overwritten by the poll once set.

**Items**: upsert on `(shipment_id, sku, item_index)` — no delete-then-insert. Includes `unit_price`.

`**matchShipmentToOrder` — two explicit phases**:

Phase 1 (deterministic → auto-link):

```typescript
function normalizeOrderNumber(raw) {
  return raw?.toLowerCase().replace(/^(bc|bandcamp)[-\s]*/i, "").replace(/[^a-z0-9]/g, "") || null;
}
// Exact normalized match against warehouse_orders.order_number → returns order id
```

Phase 2 (probabilistic → review queue only, never auto-link):

- Postal code pre-filter via JSONB
- Score: postal (+30), SKU overlap (+40–55), name match (+20), date proximity (+5–10)
- Threshold ≥50: writes top candidates to `warehouse_review_queue` for staff to confirm
- Returns `null` — never sets `order_id` from this phase

## Step 5 — EasyPost label source patch

**File:** `[src/trigger/tasks/create-shipping-label.ts](Project/clandestine-fulfillment/src/trigger/tasks/create-shipping-label.ts)`

One-line addition to the `warehouse_shipments` insert: `label_source: 'easypost'`.

## Step 6 — UI patches

`**[src/actions/shipping.ts](Project/clandestine-fulfillment/src/actions/shipping.ts)`** — add `ss_order_number`, `total_units`, `label_source` to `getShipments` select string.

`**[src/app/admin/shipping/page.tsx](Project/clandestine-fulfillment/src/app/admin/shipping/page.tsx)`** — order number display prefers `ss_order_number` over `SS-{id}` fallback; add `label_source` badge.

`**[src/app/admin/orders/page.tsx](Project/clandestine-fulfillment/src/app/admin/orders/page.tsx)**` — `OrderExpandedDetail` gets two distinct sections:

- Section A: "Bandcamp Status" badge (from `order.fulfillment_status`)
- Section B: "Shipment & Tracking" (from `detail.shipments`) with 4 states (see table in doc)
- Create Label hidden when `detail.shipments.length > 0`

`**[src/app/portal/fulfillment/page.tsx](Project/clandestine-fulfillment/src/app/portal/fulfillment/page.tsx)**` — same two-section pattern as admin; add "View in shipping log →" link per shipment; add `label_source` badge.

`**[src/app/portal/shipping/page.tsx](Project/clandestine-fulfillment/src/app/portal/shipping/page.tsx)**` — add order reference column linking to `/portal/fulfillment`; add `label_source` badge.

## Step 7 — Doc sync

- `[docs/system_map/TRIGGER_TASK_CATALOG.md](Project/clandestine-fulfillment/docs/system_map/TRIGGER_TASK_CATALOG.md)` — update `shipstation-poll` description
- `[docs/system_map/API_CATALOG.md](Project/clandestine-fulfillment/docs/system_map/API_CATALOG.md)` — update `getShipments`, `getClientShipments`, `getOrderDetail` return shapes

