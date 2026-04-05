---
name: ShipStation Bridge + Shipping Log
overview: "Three coordinated changes for the ShipStation bridge period: rename the Shipping page to \"Shipping Log\", restore the ShipStation shipment sync so new labels auto-populate the log, and create a live \"ShipStation Orders\" page the team will work from until EasyPost takes over."
todos:
  - id: pre-step-0
    content: "BLOCKING: grep findOrgByNameOrAlias in src/actions/organizations.ts — if missing, strip Tier 1.5 from match-shipment-org before proceeding"
    status: completed
  - id: rename-shipping-log
    content: Rename Shipping → Shipping Log in sidebar + h1; add Import Pirate Ship button to Shipping Log header linking to /admin/shipping/pirate-ship
    status: completed
  - id: restore-ss-client
    content: Restore src/lib/clients/shipstation.ts from git dd45db1^, add fetchOrders + ShipStationOrder schema with advancedOptions?.storeId normalization
    status: completed
  - id: restore-match-shipment-org
    content: Restore src/trigger/lib/match-shipment-org.ts from git dd45db1^ (strip Tier 1.5 if findOrgByNameOrAlias missing)
    status: completed
  - id: new-shipstation-queue
    content: Create src/trigger/lib/shipstation-queue.ts with dedicated concurrencyLimit (separate from bandcampQueue)
    status: completed
  - id: restore-ss-poll
    content: Restore src/trigger/tasks/shipstation-poll.ts from git dd45db1^, update queue to shipstationQueue (grep + replace old queue ref), re-add to index.ts exports
    status: completed
  - id: new-ss-orders-action
    content: Create src/actions/shipstation-orders.ts with getShipStationOrders (live API, requireStaff)
    status: completed
  - id: new-ss-orders-page
    content: Create src/app/admin/shipstation-orders/page.tsx showing live ShipStation order queue
    status: completed
  - id: sidebar-ss-orders
    content: Add ShipStation Orders nav entry to admin sidebar
    status: completed
  - id: trigger-deploy
    content: Deploy Trigger.dev to register shipstation-poll schedule
    status: completed
  - id: doc-sync
    content: Update TRIGGER_TASK_CATALOG.md and API_CATALOG.md
    status: completed
isProject: false
---

# ShipStation Bridge Implementation Plan

## 1. Scope Summary

Three tasks, in order of dependency:

1. **Rename Shipping → Shipping Log** — label-only change, route stays `/admin/shipping`
2. **Restore ShipStation shipment sync** — restores 3 deleted files from `git show dd45db1^:...`, re-wires Trigger task export, ensures new ShipStation labels auto-appear in the Shipping Log
3. **New "ShipStation Orders" page** — live read-only view of the ShipStation order queue (calls ShipStation `/orders` API directly, no DB sync), added to admin sidebar so the team uses it as the working order page during the bridge period

No database migrations required. No client portal changes.

**Pirate Ship import:** Already fully built (`src/app/admin/shipping/pirate-ship/page.tsx`, `src/actions/pirate-ship.ts`, `src/lib/clients/pirate-ship-parser.ts`, `src/trigger/tasks/pirate-ship-import.ts`). Only change needed is surfacing it from the Shipping Log page — no new code.

---

## 2. Evidence Sources

- `[src/components/admin/admin-sidebar.tsx](src/components/admin/admin-sidebar.tsx)` — current nav item: `{ title: "Shipping", href: "/admin/shipping" }`
- `[src/app/admin/shipping/page.tsx](src/app/admin/shipping/page.tsx)` line 152 — `<h1>Shipping</h1>`
- `[src/actions/shipping.ts](src/actions/shipping.ts)` lines 72–83 — `getShipments` queries `warehouse_shipments`, already handles `shipstation_shipment_id` column
- `git show dd45db1^:src/lib/clients/shipstation.ts` — full client with rate limiter, Zod schemas, `fetchShipments`, `verifyShipStationSignature`, `ShipStationShipment` type
- `git show dd45db1^:src/trigger/tasks/shipstation-poll.ts` — `shipstation-poll` cron task (30 min), uses `matchShipmentOrg`, inserts to `warehouse_shipments` and `warehouse_shipment_items`
- `git show dd45db1^:src/trigger/lib/match-shipment-org.ts` — **3-tier fallback confirmed**: Tier 1 = `warehouse_shipstation_stores` lookup, Tier 1.5 = alias matching via `findOrgByNameOrAlias`, Tier 2 = SKU→product→org
- `[src/lib/shared/env.ts](src/lib/shared/env.ts)` lines 31–33 — `SHIPSTATION_API_KEY`, `SHIPSTATION_API_SECRET`, `SHIPSTATION_WEBHOOK_SECRET` already in schema with `.default("")`
- `.env.local` / `.env.production` — both have real credentials: `SHIPSTATION_API_KEY=43a24ded...`, `SHIPSTATION_API_SECRET=ac6819a1...`
- **Credentials verified live** — `GET /shipments?pageSize=1` returns `total: 685` confirming API key is still valid
- `warehouse_shipstation_stores` — **table EXISTS** in production with data (verified via live Supabase query); no migration needed
- `findOrgByNameOrAlias` (Tier 1.5 dependency) — must verify still exported from `src/actions/organizations.ts` at implementation time

---

## 3. API Boundaries Impacted

From `API_CATALOG.md`:

- **Shipping** (`src/actions/shipping.ts`) — `getShipments`, `getShipmentsSummary`, `getShipmentDetail`, `exportShipmentsCsv` — **unchanged**. The rename is display-only.
- **New action boundary**: `src/actions/shipstation-orders.ts` — new file exposing `getShipStationOrders()` (staff-only, calls external API, not DB)
- Admin sidebar — add new nav entry for "ShipStation Orders"

---

## 4. Trigger Touchpoint Check


| Task ID                 | Status               | File                                    | Action                      |
| ----------------------- | -------------------- | --------------------------------------- | --------------------------- |
| `shipstation-poll`      | Deleted in `dd45db1` | `src/trigger/tasks/shipstation-poll.ts` | Restore from git            |
| `shipstation-poll` cron | Deleted              | same file                               | Restore — runs every 30 min |


`match-shipment-org` helper (`src/trigger/lib/match-shipment-org.ts`) was also deleted — required by `shipstation-poll`. Must be restored.

`src/trigger/tasks/index.ts` — re-add exports for `shipstationPollTask` and `shipstationPollSchedule`.

No webhook route needed for the bridge period — the cron poller is sufficient and the webhook route was rightfully removed (Shopify GDPR now uses that path pattern).

---

## 5. Proposed Implementation Steps

### Pre-Step 0 — Verify `findOrgByNameOrAlias` before touching any Trigger files (BLOCKING)

Trigger.dev loads all exported tasks on deploy. If any task file imports a missing symbol, **the entire task bundle fails to register** — unrelated tasks (Bandcamp, Discogs, etc.) will also stop running.

Before restoring `match-shipment-org.ts` or `shipstation-poll.ts`:

```bash
grep -n "findOrgByNameOrAlias" src/actions/organizations.ts
```

**If found:** proceed normally — full 3-tier restore.

**If missing:** strip Tier 1.5 from the restored `match-shipment-org.ts` before wiring the poller. Tiers 1 (store mapping) and 2 (SKU matching) are sufficient for the bridge period.

This check runs first, before any file is written.

---

### Step 1 — Rename "Shipping" to "Shipping Log" + surface Pirate Ship import

**Pirate Ship import status:** Fully built and working at `src/app/admin/shipping/pirate-ship/page.tsx`. The full upload → parse → background import flow is complete. The only gap is that the page has no sidebar link and no entry point from the Shipping Log — it is currently invisible to users.

**Workflow context:** International ShipStation orders are shipped via Pirate Ship (cheaper rates). Staff export the Pirate Ship shipping log as XLSX, import it here — this marks orders as shipped and populates the Shipping Log for client billing.

`**[src/components/admin/admin-sidebar.tsx](src/components/admin/admin-sidebar.tsx)`** — two changes:

```typescript
// 1. Rename the Shipping entry
{ title: "Shipping Log", href: "/admin/shipping", icon: Truck },
```

`**[src/app/admin/shipping/page.tsx](src/app/admin/shipping/page.tsx)**` — three changes:

```typescript
// 1. Rename h1 (line 152)
<h1 className="text-2xl font-semibold tracking-tight">Shipping Log</h1>

// 2. Add import Link at top of file
import Link from "next/link";

// 3. Add "Import from Pirate Ship" button to the page header, alongside the existing Export CSV button
<Link href="/admin/shipping/pirate-ship">
  <Button variant="outline" size="sm">
    <Upload className="h-4 w-4 mr-1.5" />
    Import Pirate Ship
  </Button>
</Link>
```

The button sits in the existing `flex items-center justify-between` header row, next to "Export CSV". No new pages or actions — just a link to the existing sub-page.

Route `/admin/shipping` and `/admin/shipping/pirate-ship` both unchanged.

---

### Step 2 — Restore ShipStation shipment sync (3 files restored, 1 file updated)

**2a. Restore `src/lib/clients/shipstation.ts`** — full restore from `git show dd45db1^:src/lib/clients/shipstation.ts`. The file contains:

- Rate limiter (40 req/min)
- `fetchShipments({ shipDateStart, page, pageSize, sortBy, sortDir })` — used by poll task
- `ShipStationShipment` Zod-validated type
- `verifyShipStationSignature`

Also add a `fetchOrders` function here for Step 3 (ShipStation `/orders` endpoint, similar pattern to `fetchShipments`).

**2b. Restore `src/trigger/lib/match-shipment-org.ts`** — full restore from `git show dd45db1^:src/trigger/lib/match-shipment-org.ts`.

Confirmed 3-tier fallback (no table creation needed — all dependencies verified live):

- Tier 1: `warehouse_shipstation_stores` lookup by `store_id → org_id` — **table exists with data**
- Tier 1.5: `findOrgByNameOrAlias(storeName, workspaceId)` — alias-based match
- Tier 2: SKU → `warehouse_product_variants` → `warehouse_products.org_id` — majority vote

At implementation time: verify `findOrgByNameOrAlias` is still exported from `src/actions/organizations.ts`. If it was removed, either restore it or strip Tier 1.5 (Tiers 1 and 2 are sufficient for the bridge period).

**2c. Restore `src/trigger/tasks/shipstation-poll.ts`** — full restore from `git show dd45db1^:src/trigger/tasks/shipstation-poll.ts`. The task:

- Runs every 30 min
- 30-day rolling lookback window
- Deduplicates via `shipstation_shipment_id`
- Inserts to `warehouse_shipments` + `warehouse_shipment_items`
- Unmatched shipments → `warehouse_review_queue`

**Queue update (required):** The git-restored file will reference whatever queue it had at `dd45db1^`. After restoring, explicitly update the queue import and reference to `shipstationQueue` (from the new `src/trigger/lib/shipstation-queue.ts`). Do not leave it pointing at `bandcampQueue` — that queue is serial and shared with all Bandcamp API tasks.

```typescript
// Confirm this line in the restored file and update if different:
import { shipstationQueue } from "@/trigger/lib/shipstation-queue";
// ...
queue: shipstationQueue,
```

**2d. Update `src/trigger/tasks/index.ts`** — add:

```typescript
export { shipstationPollTask, shipstationPollSchedule } from "./shipstation-poll";
```

After deploy, Trigger.dev will pick up `shipstation-poll` as a new scheduled task. The 422 historical rows already in the DB will be skipped (dedup guard). New ShipStation labels will appear in the Shipping Log within 30 min.

---

### Step 3 — New "ShipStation Orders" page (new action + new page + sidebar entry)

**3a. Add `fetchOrders` to `src/lib/clients/shipstation.ts`**

ShipStation `GET /orders` endpoint. Requires a **separate `ShipStationOrder` Zod schema** — do not reuse `ShipStationShipment`. Key order-level fields differ: `orderStatus`, `orderDate`, `shipTo`, `items[]` (with `lineItemKey`, `sku`, `name`, `quantity`, `unitPrice`), `orderNumber`, `storeId`, `customerUsername`.

**StoreId normalization:** ShipStation's `advancedOptions.storeId` overrides the top-level `storeId` for marketplace integrations (Amazon, eBay, etc.). All code that reads `storeId` from an order must use:

```typescript
const storeId = order.advancedOptions?.storeId ?? order.storeId ?? null;
```

This pattern already exists in the old `match-shipment-org.ts` for shipments — apply the same defensively to the orders schema and page rendering.

```typescript
// Separate schema — NOT the same shape as ShipStationShipment
const shipStationOrderSchema = z.object({
  orderId: z.number(),
  orderNumber: z.string(),
  orderStatus: z.string(),
  orderDate: z.string().nullable().optional(),
  customerUsername: z.string().nullable().optional(),
  shipTo: shipStationAddressSchema.nullable().optional(),   // null for some marketplace orders
  items: z.preprocess((v) => v ?? [], z.array(shipStationItemSchema)),
  storeId: z.number().nullable().optional(),
  advancedOptions: z.object({ storeId: z.number().nullable().optional() }).nullable().optional(),
  amountPaid: z.number().nullable().optional(),
  shippingAmount: z.number().nullable().optional(),
});
export type ShipStationOrder = z.infer<typeof shipStationOrderSchema>;

export async function fetchOrders(params: {
  orderStatus?: string;
  page?: number;
  pageSize?: number;
}): Promise<{ orders: ShipStationOrder[]; total: number; pages: number }> { ... }
```

**3b. New `src/actions/shipstation-orders.ts`**

```typescript
"use server";
import { requireStaff } from "@/lib/server/auth-context";
import { fetchOrders } from "@/lib/clients/shipstation";

export async function getShipStationOrders(filters: {
  status?: string;
  page?: number;
  pageSize?: number;
}) {
  await requireStaff();
  return fetchOrders({
    orderStatus: filters.status ?? "awaiting_shipment",
    page: filters.page ?? 1,
    pageSize: filters.pageSize ?? 500,
  });
}
```

Calls live ShipStation API — no DB read/write. Cached with `CACHE_TIERS.REALTIME` on the client.

**3c. New `src/app/admin/shipstation-orders/page.tsx`**

Displays ShipStation orders in a table: Order #, Customer, Store/Channel, Items (SKU + qty), Ship-to address, Status, Order Date. Filters for status (awaiting shipment, shipped, all) and search.

**Pagination note:** ShipStation paginates at max 500/page. The page will show a `"Showing X of Y orders"` indicator. If `total > pageSize` (>500 active orders), add a "Load more" or page control. Start with pageSize=500 since active orders are typically far fewer; the count indicator makes any truncation visible.

**3d. Add nav entry to `[src/components/admin/admin-sidebar.tsx](src/components/admin/admin-sidebar.tsx)`**

```typescript
{ title: "ShipStation Orders", href: "/admin/shipstation-orders", icon: Package },
```

Position: above the existing "Orders" entry or below "Mail-Order" — your call.

---

## 6. Risk + Rollback Notes


| Risk                                                  | Likelihood                                                  | Mitigation                                                                              |
| ----------------------------------------------------- | ----------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| ShipStation rate limit hit during poll                | Low — 40 req/min, 685 total shipments, dedup skips existing | Rate limiter in client; first run skips 422+ existing rows                              |
| `warehouse_shipstation_stores` table missing          | **Eliminated** — table confirmed live with data             | No action needed                                                                        |
| `findOrgByNameOrAlias` removed from organizations.ts  | Low — check at implementation time                          | If missing: strip Tier 1.5 from match-shipment-org; Tiers 1+2 sufficient                |
| ShipStation orders API shape different from shipments | Confirmed — separate schema required                        | Use dedicated `ShipStationOrder` Zod schema (not reuse shipment type)                   |
| >500 active orders truncated silently                 | Very low for bridge period                                  | Show "X of Y" count; add pagination control if ever needed                              |
| `shipstationPollTask` placed on wrong queue           | **Confirmed risk** — restored file has old queue ref        | Explicitly grep + replace queue import after restore; verified by pre-deploy grep check |
| Credentials expired / rotated                         | **Eliminated** — live API test returned 685 shipments       | Credentials confirmed valid                                                             |
| Trigger.dev cron fires immediately on deploy          | Expected                                                    | First run skips all existing rows via dedup guard                                       |


**Rollback:** Remove the 3 restored files + revert `index.ts` export. Shipping Log reverts via 2-line nav/h1 change. No DB changes means no migration rollback needed.

---

## 7. Verification Steps

**Pre-deploy (already done — no action needed):**

```bash
# Credentials confirmed live:
curl -u "$SS_KEY:$SS_SECRET" "https://ssapi.shipstation.com/shipments?pageSize=1"
# → total: 685 ✓

# warehouse_shipstation_stores table confirmed present with data ✓
```

**After code changes, before deploy:**

```bash
# 1. Run Pre-Step 0 check FIRST:
grep -n "findOrgByNameOrAlias" src/actions/organizations.ts

# 2. TypeScript + lint:
pnpm typecheck   # confirm restored files + new action compile clean
pnpm check       # biome lint

# 3. Runtime import test — catches broken imports that tsc misses:
node -e "require('./src/lib/clients/shipstation')"
# Expect: no output (clean load). Any error = fix before deploy.

# 4. Confirm Trigger.dev task graph loads cleanly:
#    Run `pnpm trigger:dev` locally (or equivalent) and verify:
#    - shipstation-poll appears in the task list
#    - No "Failed to import" errors in console
#    - bandcamp-sync, discogs-*, and other tasks are unaffected
#    This catches any dynamic import failures that TypeScript won't surface.

# 5. Confirm queue name was updated in restored poller:
grep "shipstationQueue" src/trigger/tasks/shipstation-poll.ts
```

**After deploy:**

```bash
# 1. /admin/shipping → title reads "Shipping Log"
# 2. /admin/shipstation-orders → live SS orders load with correct columns
# 3. Trigger.dev dashboard → shipstation-poll appears as scheduled task
# 4. Check first run log → "skipped: ~685, processed: 0" confirms dedup working
# 5. Wait ≤30 min → any new SS label created in ShipStation appears in Shipping Log
# 6. Confirm other tasks (bandcamp-sync, discogs-*) still show healthy runs in Trigger.dev
```

---

## 8. Doc Sync Contract Updates Required

After implementation:


| Doc                                       | Update needed                                                                                                     |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `docs/system_map/TRIGGER_TASK_CATALOG.md` | Add back `shipstation-poll` to scheduled tasks table; remove the removal note                                     |
| `docs/system_map/API_CATALOG.md`          | Add `getShipStationOrders` under new "ShipStation" section; update Shipping section to note "Shipping Log" rename |
| `project_state/journeys.yaml`             | Add `shipstation_orders_bridge` journey                                                                           |


