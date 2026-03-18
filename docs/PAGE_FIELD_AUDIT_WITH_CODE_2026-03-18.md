# Page Field-by-Field Audit (With Code)

Date: 2026-03-18  
Repo: `clandestine-fulfillment`  
Scope: Actual current implementation for requested pages.

This document reports for each page:
1. Displayed fields/columns
2. Editable vs read-only
3. Filter/search options
4. Action buttons
5. Top summary stats/cards
6. Export options
7. Images/thumbnails
8. TanStack Query usage
9. Supabase Realtime usage
10. Loading/skeleton states

---

## Global Data-Fetching/Realtime Baseline

- `useAppQuery` / `useAppMutation` wraps TanStack Query in `src/lib/hooks/use-app-query.ts`.
- Cache tiers in `src/lib/shared/query-tiers.ts`:
  - `REALTIME`: `staleTime 30s`, `refetchInterval 30s`
  - `SESSION`: `staleTime 5m`
  - `STABLE`: `staleTime 30m`
- No direct Supabase Realtime subscription code was found (`supabase.channel`, `postgres_changes`, `.subscribe()` not present in `src`).

```tsx
// src/lib/hooks/use-app-query.ts
export function useAppQuery<TData = unknown, TError = DefaultError>(
  options: UseQueryOptions<TData, TError> & { tier: CacheTier },
) {
  const { tier, ...queryOptions } = options;
  return useQuery<TData, TError>({
    ...tier,
    ...queryOptions,
  });
}
```

```ts
// src/lib/shared/query-tiers.ts
export const CACHE_TIERS = {
  REALTIME: { staleTime: 30_000, refetchInterval: 30_000 },
  SESSION: { staleTime: 5 * 60_000 },
  STABLE: { staleTime: 30 * 60_000 },
} as const;
```

---

## `/admin` (Dashboard)

**File:** `src/app/admin/page.tsx`

### Audit
- **Displayed:** stat cards (`Products`, `Orders (month)`, `Shipments (month)`, `Critical Items`, `Pending Inbound`), integration health dots, upcoming releases (title/street date/order count/available/short flag), recent activity feed.
- **Editable:** none inline; manual release action for preorder rows.
- **Filters/search:** none.
- **Actions:** release button per preorder row.
- **Top cards:** yes (5).
- **Export:** none.
- **Images:** none.
- **TanStack Query:** yes (`REALTIME` for dashboard stats, `SESSION` for preorder list).
- **Supabase Realtime:** none.
- **Loading:** spinner in upcoming releases section; empty-state text.

```tsx
// src/app/admin/page.tsx (excerpt)
const { data: stats } = useAppQuery({
  queryKey: ["admin", "dashboard-stats"],
  queryFn: () => getDashboardStats(),
  tier: CACHE_TIERS.REALTIME,
});

<div className="grid grid-cols-2 md:grid-cols-5 gap-4">
  <StatCard label="Products" value={s?.totalProducts ?? 0} />
  <StatCard label="Orders (month)" value={s?.monthOrders ?? 0} />
  <StatCard label="Shipments (month)" value={s?.monthShipments ?? 0} />
  <StatCard label="Critical Items" value={s?.criticalReviewItems ?? 0} />
  <StatCard label="Pending Inbound" value={s?.pendingInbound ?? 0} />
</div>
```

---

## `/admin/catalog` (Product List)

**File:** `src/app/admin/catalog/page.tsx`

### Audit
- **Displayed columns:** thumbnail, title, label, variant count, format, status, updated date.
- **Editable:** read-only list.
- **Filters/search:** search title/SKU, org ID, format, status; pagination + rows/page.
- **Actions:** row click to detail, prev/next pagination.
- **Top cards:** none.
- **Export:** none.
- **Images:** yes (thumbnail or placeholder icon).
- **TanStack Query:** yes (`SESSION`).
- **Supabase Realtime:** none.
- **Loading:** inline skeleton rows; route `loading.tsx` present.

```tsx
// src/app/admin/catalog/page.tsx (excerpt)
<Input placeholder="Search by title or SKU..." ... />
<Input placeholder="Filter by org ID..." ... />
<Input placeholder="Filter by format..." ... />
<select value={filters.status}>...</select>

<TableHead>Title</TableHead>
<TableHead>Label</TableHead>
<TableHead>Variants</TableHead>
<TableHead>Format</TableHead>
<TableHead>Status</TableHead>
<TableHead>Updated</TableHead>
```

```tsx
// thumbnail excerpt
{primaryImage ? (
  <Image src={primaryImage.src} alt={primaryImage.alt ?? product.title} width={32} height={32} />
) : (
  <Package className="text-muted-foreground h-4 w-4" />
)}
```

---

## `/admin/catalog/[id]` (Product Detail/Edit)

**File:** `src/app/admin/catalog/[id]/page.tsx`

### Audit
- **Displayed:** header + status + Shopify link; tabs for `Variants`, `Images`, `Inventory`, `Bandcamp`.
- **Editable:** product title/type/tags; variant price/compare-at/weight.
- **Filters/search:** none.
- **Actions:** back, edit product, save/cancel, edit/save/cancel variant.
- **Top cards:** none (tabs/cards, not KPI stats).
- **Export:** none.
- **Images:** yes (images tab).
- **TanStack Query:** yes (`STABLE` detail).
- **Supabase Realtime:** none.
- **Loading:** text loading + route `loading.tsx`.

```tsx
// src/app/admin/catalog/[id]/page.tsx (editable product fields)
<Input id="edit-title" value={editTitle} onChange={(e) => setEditTitle(e.currentTarget.value)} />
<Input id="edit-type" value={editProductType} ... />
<Input id="edit-tags" value={editTags} ... />
```

```tsx
// variant table columns excerpt
<TableHead>SKU</TableHead>
<TableHead>Title</TableHead>
<TableHead>Price</TableHead>
<TableHead>Compare At</TableHead>
<TableHead>Barcode</TableHead>
<TableHead>Weight</TableHead>
<TableHead>Format</TableHead>
<TableHead>Pre-Order</TableHead>
<TableHead>Street Date</TableHead>
```

---

## `/admin/clients` (Client List)

**File:** `src/app/admin/clients/page.tsx`

### Audit
- **Displayed columns:** name, slug, products, connections, onboarding, created.
- **Editable:** add-client dialog fields (`name`, `slug`, `billingEmail`).
- **Filters/search:** search by name.
- **Actions:** add client, create client, row click to detail.
- **Top cards:** none.
- **Export:** none.
- **Images:** none.
- **TanStack Query:** yes (`SESSION`).
- **Supabase Realtime:** none.
- **Loading:** spinner; no route-level loading file.

```tsx
// src/app/admin/clients/page.tsx (table headers)
<TableHead>Name</TableHead>
<TableHead>Slug</TableHead>
<TableHead className="text-right">Products</TableHead>
<TableHead className="text-right">Connections</TableHead>
<TableHead>Onboarding</TableHead>
<TableHead>Created</TableHead>
```

---

## `/admin/clients/[id]` (Client Detail)

**File:** `src/app/admin/clients/[id]/page.tsx`

### Audit
- **Displayed:** org identity + billing email; overview cards (products/connections/billing snapshots/support tickets); onboarding checklist; store connections; settings form.
- **Editable:** onboarding steps, billing email, pirate ship name, storage fee waived.
- **Filters/search:** none.
- **Actions:** back button; toggle checklist step.
- **Top cards:** yes (4 overview cards).
- **Export:** none.
- **Images:** none.
- **TanStack Query:** yes (`SESSION`).
- **Supabase Realtime:** none.
- **Loading:** spinner text; route-level `loading.tsx` present.

```tsx
// src/app/admin/clients/[id]/page.tsx (overview cards)
<p className="text-xs text-muted-foreground">Products</p>
<p className="text-xs text-muted-foreground">Store Connections</p>
<p className="text-xs text-muted-foreground">Billing Snapshots</p>
<p className="text-xs text-muted-foreground">Support Tickets</p>
```

```tsx
// editable settings fields
<Input id="billing-email" defaultValue={(org.billing_email as string) ?? ""} ... />
<Input id="pirate-ship" defaultValue={(org.pirate_ship_name as string) ?? ""} ... />
<input type="checkbox" checked={(org.storage_fee_waived as boolean) ?? false} ... />
```

---

## `/admin/shipping` (Shipments List + Detail Expand)

**File:** `src/app/admin/shipping/page.tsx`

### Audit
- **Displayed columns:** tracking number, carrier, service, ship date, organization, status, cost.
- **Detail view:** inline expanded (not separate route): shipment items and tracking timeline.
- **Editable:** read-only.
- **Filters/search:** org ID, from/to date, carrier, status.
- **Actions:** row expand/collapse, pagination prev/next.
- **Top cards:** none.
- **Export:** none.
- **Images:** none.
- **TanStack Query:** yes (`SESSION`) for list and expanded detail.
- **Supabase Realtime:** none.
- **Loading:** skeleton rows + detail skeleton; no route `loading.tsx`.

```tsx
// src/app/admin/shipping/page.tsx (headers)
<th>Tracking Number</th>
<th>Carrier</th>
<th>Service</th>
<th>Ship Date</th>
<th>Organization</th>
<th>Status</th>
<th className="text-right">Cost</th>
```

```tsx
// expanded detail excerpt
<h3 className="font-medium mb-2">Shipment Items</h3>
<h3 className="font-medium mb-2">Tracking Timeline</h3>
```

---

## `/admin/orders` (Orders List)

**File:** `src/app/admin/orders/page.tsx`

### Audit
- **Displayed columns:** order, date, customer, organization, source, status, total.
- **Detail expand:** line items + shipment tracking timeline.
- **Editable:** read-only.
- **Filters/search:** search order/customer, source dropdown, status dropdown.
- **Actions:** row expand/collapse, pagination controls.
- **Top cards:** none.
- **Export:** none.
- **Images:** none.
- **TanStack Query:** yes (`SESSION`).
- **Supabase Realtime:** none.
- **Loading:** skeleton rows + detail skeleton; route `loading.tsx` present.

```tsx
// src/app/admin/orders/page.tsx (filters)
<Input placeholder="Search order/customer..." ... />
<select value={filters.source}>...</select>
<select value={filters.status}>...</select>
```

---

## `/admin/billing` (All Tabs)

**File:** `src/app/admin/billing/page.tsx`

### Audit
- **Tabs:** snapshots, rules, formats, adjustments.
- **Snapshots list columns:** organization, period, status, grand total, created.
- **Snapshot detail:** top cards (Shipping, Pick & Pack, Materials, Storage, Adjustments, Grand Total), included shipments table, excluded shipments table, storage charges table, adjustments table.
- **Rules tab editable:** name, amount, active toggle, new rule fields.
- **Format costs editable:** format name, pick-pack cost, material cost.
- **Adjustments editable:** org ID, billing period, amount, reason.
- **Filters/search:** none.
- **Actions:** add/edit/save/cancel buttons, snapshot select, back.
- **Top cards:** yes (snapshot detail totals).
- **Export:** none.
- **Images:** none.
- **TanStack Query:** yes (`SESSION`).
- **Supabase Realtime:** none.
- **Loading:** text + spinner; route `loading.tsx` present.

```tsx
// src/app/admin/billing/page.tsx (top tabs)
const tabs: { key: Tab; label: string }[] = [
  { key: "snapshots", label: "Snapshots" },
  { key: "rules", label: "Rules" },
  { key: "formats", label: "Format Costs" },
  { key: "adjustments", label: "Adjustments" },
];
```

```tsx
// snapshot totals cards excerpt
{[
  { label: "Shipping", value: snapshot.total_shipping },
  { label: "Pick & Pack", value: snapshot.total_pick_pack },
  { label: "Materials", value: snapshot.total_materials },
  { label: "Storage", value: snapshot.total_storage },
  { label: "Adjustments", value: snapshot.total_adjustments },
  { label: "Grand Total", value: snapshot.grand_total },
].map(...)}
```

---

## `/admin/inventory` (Inventory Dashboard)

**File:** `src/app/admin/inventory/page.tsx`

### Audit
- **Displayed columns:** thumbnail, product/SKU, label, available, committed, incoming, format, adjust.
- **Expanded detail:** locations list, Bandcamp link, recent activity list.
- **Editable:** adjustment dialog (`delta`, `reason`) only.
- **Filters/search:** search, org ID, format, status, pagination, rows-per-page.
- **Actions:** adjust button per row, confirm adjustment, expand row, pagination.
- **Top cards:** none.
- **Export:** none.
- **Images:** yes (thumbnail/fallback icon).
- **TanStack Query:** yes (`REALTIME` polling tier).
- **Supabase Realtime:** none.
- **Loading:** skeleton rows + detail skeleton; route `loading.tsx` present.

```tsx
// src/app/admin/inventory/page.tsx (adjust dialog)
<Input id="adjust-delta" type="number" placeholder="e.g. -5 or 10" ... />
<Input id="adjust-reason" placeholder="Reason for adjustment..." ... />
```

---

## `/admin/inbound` (Inbound List)

**File:** `src/app/admin/inbound/page.tsx`

### Audit
- **Displayed columns:** tracking number, carrier, organization, expected date, status, items, submitted by.
- **Editable:** read-only list.
- **Filters/search:** status tabs, search org, date range, pagination.
- **Actions:** row click to detail, status-tab selection, pagination.
- **Top cards:** none.
- **Export:** none.
- **Images:** none (icon only in empty state).
- **TanStack Query:** yes (`REALTIME` polling tier).
- **Supabase Realtime:** none.
- **Loading:** skeleton table rows; no route `loading.tsx`.

```tsx
// src/app/admin/inbound/page.tsx (status tabs)
const STATUS_TABS = ["all", "expected", "arrived", "checking_in", "checked_in", "issue"] as const;
```

---

## `/admin/inbound/[id]` (Inbound Detail/Check-in)

**File:** `src/app/admin/inbound/[id]/page.tsx`

### Audit
- **Displayed:** shipment header info, status progression bar, items table.
- **Item table columns:** SKU, Expected Qty, Received Qty, Condition Notes, Location, Action.
- **Editable:** during check-in state, received qty + condition notes + confirm action.
- **Filters/search:** none.
- **Actions:** mark arrived, begin check-in, complete check-in, per-item confirm, back.
- **Top cards:** none.
- **Export:** none.
- **Images:** none.
- **TanStack Query:** yes (`REALTIME` polling tier).
- **Supabase Realtime:** none.
- **Loading:** skeleton blocks on page load; no route `loading.tsx`.

```tsx
// src/app/admin/inbound/[id]/page.tsx (item row edit controls)
<Input type="number" min={0} value={receivedQty} ... />
<Textarea value={conditionNotes} placeholder="Condition notes..." ... />
<Button size="sm" variant="outline">Confirm</Button>
```

---

## `/admin/review-queue`

**File:** `src/app/admin/review-queue/page.tsx`

### Audit
- **Displayed columns:** checkbox, title, category, severity, SLA, count, created.
- **Expanded row:** description + metadata JSON.
- **Editable:** action-driven state changes (resolve/snooze/reopen), bulk assign/bulk resolve.
- **Filters/search:** severity tabs + category filter.
- **Actions:** resolve, snooze 4h, reopen, bulk assign, bulk resolve.
- **Top cards:** none (header item count only).
- **Export:** none.
- **Images:** none.
- **TanStack Query:** yes (`REALTIME` polling tier).
- **Supabase Realtime:** none.
- **Loading:** spinner/text; no route `loading.tsx`.

```tsx
// src/app/admin/review-queue/page.tsx (bulk controls)
{selected.size > 0 && (
  <>
    <Input placeholder="User ID" ... />
    <Button>Assign</Button>
    <Button>Resolve All</Button>
  </>
)}
```

---

## `/admin/scan`

**File:** `src/app/admin/scan/page.tsx`

### Audit
- **Modes:** Quick Lookup, Count, Receiving.
- **Quick Lookup displays:** product image/title/SKU/barcode, available/committed/incoming, locations.
- **Count displays:** session/result details for counted SKUs.
- **Receiving displays:** shipment ID and scan log (SKU with received/expected).
- **Editable:** scanner-driven interactions only; no editable grid cells.
- **Filters/search:** none (scanner input).
- **Actions:** resume/start fresh/start new count/change/complete check-in.
- **Top cards:** none.
- **Export:** none.
- **Images:** yes (quick lookup image).
- **TanStack Query:** no (direct action calls).
- **Supabase Realtime:** none.
- **Loading:** lookup text state (`Looking up...`) and workflow pending labels; no route `loading.tsx`.

```tsx
// src/app/admin/scan/page.tsx (mode tabs)
const TABS = [
  { mode: "lookup", label: "Quick Lookup" },
  { mode: "count", label: "Count" },
  { mode: "receiving", label: "Receiving" },
];
```

---

## `/admin/settings/store-mapping`

**File:** `src/app/admin/settings/store-mapping/page.tsx`

### Audit
- **Displayed columns:** store name, store ID, marketplace, mapped org, status, actions.
- **Editable:** map/unmap through action buttons/dialog.
- **Filters/search:** none.
- **Actions:** auto-match, sync from ShipStation, unmap, apply suggestion.
- **Top cards:** total stores, mapped, unmapped.
- **Export:** none.
- **Images:** none.
- **TanStack Query:** yes (`STABLE` + `SESSION`).
- **Supabase Realtime:** none.
- **Loading:** spinner; no route `loading.tsx`.

```tsx
// src/app/admin/settings/store-mapping/page.tsx (summary cards)
<CardTitle>Total Stores</CardTitle>
<CardTitle>Mapped</CardTitle>
<CardTitle>Unmapped</CardTitle>
```

---

## `/portal/billing`

**File:** `src/app/portal/billing/page.tsx`

### Audit
- **Displayed list columns:** period, status, total, date, actions.
- **Detail view:** top total cards + shipments table + storage charges table.
- **Editable:** read-only.
- **Filters/search:** none.
- **Actions:** view, download (if invoice), back.
- **Top cards:** yes (detail view totals).
- **Export:** Stripe invoice download link.
- **Images:** none.
- **TanStack Query:** yes (`STABLE` user context + `SESSION` billing data).
- **Supabase Realtime:** none.
- **Loading:** text loading states; no route `loading.tsx`.

```tsx
// src/app/portal/billing/page.tsx (download action)
{s.stripe_invoice_id && (
  <a href={`https://invoice.stripe.com/i/${s.stripe_invoice_id}`} ...>
    Download
  </a>
)}
```

---

## `/portal/shipping`

**File:** `src/app/portal/shipping/page.tsx`

### Audit
- **Displayed columns:** tracking, carrier, ship date, status, weight.
- **Expanded row:** items, shipping cost, tracking timeline.
- **Editable:** read-only.
- **Filters/search:** carrier input + status dropdown.
- **Actions:** expand/collapse row, pagination.
- **Top cards:** none.
- **Export:** none.
- **Images:** none.
- **TanStack Query:** yes (`SESSION`) + child timeline query.
- **Supabase Realtime:** none.
- **Loading:** skeleton rows + detail skeleton; no route `loading.tsx`.

```tsx
// src/app/portal/shipping/page.tsx (filters)
<Input placeholder="Filter by carrier..." ... />
<select value={filters.status}>...</select>
```

---

## `/portal/inventory`

**File:** `src/app/portal/inventory/page.tsx`

### Audit
- **Displayed columns:** thumbnail, product/SKU, available, committed, incoming, format.
- **Expanded row:** locations, Bandcamp link, recent activity.
- **Editable:** read-only.
- **Filters/search:** search SKU/title + format filter + pagination/rows-per-page.
- **Actions:** expand/collapse row, pagination.
- **Top cards:** none.
- **Export:** none.
- **Images:** yes (thumbnail or fallback icon).
- **TanStack Query:** yes (`REALTIME` polling tier).
- **Supabase Realtime:** none.
- **Loading:** inline skeleton rows + detail skeleton; route `loading.tsx` present.

```tsx
// src/app/portal/inventory/page.tsx (thumbnail)
{row.imageSrc ? (
  <img src={row.imageSrc} alt={row.productTitle} className="h-8 w-8 rounded object-cover" />
) : (
  <Package className="text-muted-foreground h-4 w-4" />
)}
```

---

## `/portal/orders`

**File:** `src/app/portal/orders/page.tsx`

### Audit
- **Displayed columns:** order, date, customer, items, status, total.
- **Expanded row:** line items, shipping address, shipment tracking timeline.
- **Editable:** read-only.
- **Filters/search:** search order number + status dropdown.
- **Actions:** expand/collapse row, pagination.
- **Top cards:** none.
- **Export:** none.
- **Images:** none.
- **TanStack Query:** yes (`SESSION`) + child timeline query.
- **Supabase Realtime:** none.
- **Loading:** inline skeleton rows + detail skeleton; route `loading.tsx` present.

```tsx
// src/app/portal/orders/page.tsx (columns)
<TableHead>Order</TableHead>
<TableHead>Date</TableHead>
<TableHead>Customer</TableHead>
<TableHead>Items</TableHead>
<TableHead>Status</TableHead>
<TableHead className="text-right">Total</TableHead>
```

---

## Shared Shipment/Order Timeline Component (Used in shipping + orders)

**File:** `src/components/shared/tracking-timeline.tsx`

- Uses `useAppQuery` for tracking events (`SESSION` tier).
- Shows tracking number/carrier/external track link.
- Shows status timeline with icons and event metadata.
- Loading state uses pulse placeholders.

```tsx
// src/components/shared/tracking-timeline.tsx (query)
const { data: events, isLoading } = useAppQuery<TrackingEvent[]>({
  queryKey: ["tracking-events", shipmentId],
  queryFn: () => fetchEvents(shipmentId),
  tier: CACHE_TIERS.SESSION,
});
```

---

## Final Notes

- This is **actual code-state**, not planning-state.
- No page in this set currently offers CSV/XLS export except Stripe invoice link download in billing views.
- No direct Supabase Realtime channel subscriptions are implemented on these pages; "realtime" behavior is via TanStack polling tier.

