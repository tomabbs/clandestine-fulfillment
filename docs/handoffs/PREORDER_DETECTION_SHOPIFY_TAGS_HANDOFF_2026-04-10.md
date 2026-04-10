# Pre-order detection, Shopify tags, and fulfillment — execution handoff

**Project:** `clandestine-fulfillment`  
**Purpose:** Enable an external engineer to understand, test, and execute the combined plan: **(A)** fix Bandcamp-driven preorder detection (`street_date`, `is_preorder`, mapping fields) and **(B)** confirm **Shopify `Pre-Orders` tag** add/remove behavior (already mostly implemented).  
**Note:** [`src/trigger/tasks/bandcamp-sync.ts`](../../src/trigger/tasks/bandcamp-sync.ts) is **~1,877 lines**. This handoff embeds **complete source** for all small/medium preorder-related modules and **verbatim excerpts** for `bandcamp-sync` preorder paths. For a byte-identical copy of the full monolith file, use the repository checkout.

**Related workstreams** bundled for operators: **§16** (preorder execution + integrated review), **§17** (inventory rollback/scoping/backfill, title integrity, preorder refinements, CI guardrails), **§18** (Shopify release date in `descriptionHtml` + Bandcamp health “last catalog scan” / new items count), **§19** (triple-check vs codebase + local tests; live Shopify/Trigger not run here), **§20** (bulletproof preorder: test gap, Shopify API research, pattern options), **§21** (**tags-only** operator model vs selling plans / checkout).

---

## 1. Scope summary

| Area | Intent |
|------|--------|
| **Detection** | When Bandcamp (API + scraper) indicates a future release / preorder, `warehouse_product_variants` should get correct `street_date` and `is_preorder`, and `preorder-setup` should run. |
| **Shopify promo** | On setup: create selling plan group + add tags **`Pre-Orders`** and **`New Releases`** on the Shopify product. |
| **Release day** | Remove **`Pre-Orders`** when `street_date <= today` and `preorder-fulfillment` processes the variant; optional reconciliation via `tag-cleanup-backfill`. **Recommended:** run fulfillment **≥2×/day** (see §16) for faster tag/selling-plan cleanup after release. |
| **Planned code fixes** (from preorder audit todos) | Matched-SKU + scraper detection logic **fully specified in §16.4**; selling plan ID storage + delete (**§16.2 CRIT-1**); `preorder-setup` observability (**§16.2 HIGH-1**); `manualRelease` fix (**§16.2 HIGH-3**); shared date helpers (**§16.6**); `catalog.preorder_missed` (**§16.5**); backfill + tests (**§16.5–16.7**). |
| **Failsafes / tracking** | Review queue on setup failure, sensors, optional reconciliation sweep, structured logging — **§16.3**. |

---

## 2. Evidence / research / assumptions

### 2.1 Verified facts (code)

- **`bandcamp-sync-cron`** runs **`*/30 * * * *`** (every **30 minutes**) and triggers `bandcamp-sync` per workspace with Bandcamp credentials — this is the primary **new-release / merch detection** loop and already exceeds “twice a day.” Source: [`src/trigger/tasks/bandcamp-sync.ts`](../../src/trigger/tasks/bandcamp-sync.ts) (`bandcampSyncSchedule`, ~L1855+).
- **`preorder-setup`** adds Shopify tags `Pre-Orders` and `New Releases` via `tagsAdd` after `sellingPlanGroupCreate`. Source: [`src/trigger/tasks/preorder-setup.ts`](../../src/trigger/tasks/preorder-setup.ts).
- **`preorder-fulfillment`** runs **daily 6:00 America/New_York**; for variants with `is_preorder = true` and `street_date <= today`, it calls `tagsRemove(..., ["Pre-Orders"])` then sets `is_preorder = false`. Source: [`src/trigger/tasks/preorder-fulfillment.ts`](../../src/trigger/tasks/preorder-fulfillment.ts). **Gap:** release-side cadence is once daily unless changed (§16.1).
- **`tag-cleanup-backfill`** (manual task): if `street_date > today` → ensure `Pre-Orders` (+ `New Releases`); if `street_date <= today` → remove `Pre-Orders`. Source: [`src/trigger/tasks/tag-cleanup-backfill.ts`](../../src/trigger/tasks/tag-cleanup-backfill.ts).
- **New product path in `bandcamp-sync`:** If `merchItem.new_date` is in the future, `tags` array gets `Pre-Orders`/`New Releases` before `productSetCreate` and DB insert; `is_preorder` on new variant mirrors `tags.includes("Pre-Orders")`; `preorder-setup` triggered if pre-order tags present.

### 2.2 Assumptions / risks

- **Shopify client:** `tagsAdd` / `tagsRemove` / `sellingPlanGroupCreate` use the **Clandestine Shopify** credentials wired in [`src/lib/clients/shopify-client.ts`](../../src/lib/clients/shopify-client.ts) (env-based). External party must confirm which connection is active in their environment.
- **`preorder-setup` swallows Shopify errors** (empty `catch` after selling plan + tags). Failures can leave **no** selling plan and **no** tags with **no** surfaced error.
- **`preorder-setup` does not update** `warehouse_products.tags` in Postgres; DB tags update when sync/backfill pulls from Shopify or when `tag-cleanup-backfill` runs.
- **Selling plan removal:** Comment in `releaseVariant` references removing selling plan groups, but implementation only calls **`tagsRemove`** — **selling plan groups may persist** on Shopify until manually cleaned or future code stores `selling_plan_group_id` and calls `sellingPlanGroupDelete`.
- **`manualRelease` Server Action** triggers **entire** `preorder-fulfillment` run (`tasks.trigger("preorder-fulfillment", {})`), not a single variant — see [`src/actions/preorders.ts`](../../src/actions/preorders.ts).
- **Date comparisons** in Bandcamp paths mix `new Date()` (with time) vs date-only strings — edge cases at timezone boundaries are possible.
- **Matched-SKU path** (existing variant): uses `merchItem.new_date` for `street_date` when `authority_status === 'bandcamp_initial'`; does **not** currently use `bandcamp_is_preorder` from mapping for flagging. Scraper writes `bandcamp_release_date` / `bandcamp_is_preorder` to `bandcamp_product_mappings` but variant `street_date` update from scraper only runs when `!variant.street_date`. These are the **main detection gaps** the separate implementation todos address.

---

## 3. Supabase database architecture (relevant)

### 3.1 Core tables (migration `20260316000002_products.sql`)

```sql
-- Migration 002: Products and variants
-- Rule #31: SKU uniqueness per workspace via UNIQUE(workspace_id, sku)

CREATE TABLE warehouse_products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  org_id uuid NOT NULL REFERENCES organizations(id),
  shopify_product_id text,
  title text NOT NULL,
  vendor text,
  product_type text,
  status text DEFAULT 'active' CHECK (status IN ('active', 'draft', 'archived')),
  tags text[] DEFAULT '{}',
  shopify_handle text,
  images jsonb DEFAULT '[]',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  synced_at timestamptz
);
CREATE INDEX idx_warehouse_products_org ON warehouse_products(org_id);
CREATE INDEX idx_warehouse_products_workspace ON warehouse_products(workspace_id);
CREATE INDEX idx_warehouse_products_shopify_id ON warehouse_products(shopify_product_id);

CREATE TABLE warehouse_product_variants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL REFERENCES warehouse_products(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  sku text NOT NULL,
  shopify_variant_id text,
  title text,
  price numeric,
  compare_at_price numeric,
  barcode text,
  weight numeric,
  weight_unit text DEFAULT 'lb',
  option1_name text,
  option1_value text,
  format_name text,
  street_date date,
  is_preorder boolean DEFAULT false,
  bandcamp_url text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(workspace_id, sku)
);
CREATE INDEX idx_variants_product ON warehouse_product_variants(product_id);
CREATE INDEX idx_variants_sku ON warehouse_product_variants(workspace_id, sku);
CREATE INDEX idx_variants_shopify ON warehouse_product_variants(shopify_variant_id);
CREATE INDEX idx_variants_barcode ON warehouse_product_variants(barcode);
```

**Later migrations** add Bandcamp columns to `warehouse_products` (e.g. `bandcamp_upc`, `image_url`) and expand `bandcamp_product_mappings` — search `supabase/migrations/*.sql` for `ALTER TABLE warehouse_products` / `bandcamp_product_mappings`.

### 3.2 `bandcamp_product_mappings` scraper columns (`20260329000000_bandcamp_scraper_prereqs.sql`)

```sql
-- Migration: Bandcamp scraper pre-requisites
-- ...

ALTER TABLE bandcamp_product_mappings
  ADD COLUMN IF NOT EXISTS bandcamp_url_source text
  CHECK (bandcamp_url_source IN ('orders_api', 'constructed', 'manual', 'scraper_verified'));

ALTER TABLE bandcamp_product_mappings
  ADD COLUMN IF NOT EXISTS bandcamp_image_url text;

ALTER TABLE bandcamp_product_mappings
  ADD COLUMN IF NOT EXISTS bandcamp_release_date  timestamptz,
  ADD COLUMN IF NOT EXISTS bandcamp_is_preorder   boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS bandcamp_art_url       text;

NOTIFY pgrst, 'reload schema';
```

### 3.3 Ad-hoc SQL checks (operator)

```sql
-- Pre-order variants (warehouse)
SELECT id, sku, street_date, is_preorder, product_id
FROM warehouse_product_variants
WHERE is_preorder = true
ORDER BY street_date NULLS LAST
LIMIT 50;

-- Mapping preorder signals
SELECT variant_id, bandcamp_release_date, bandcamp_is_preorder, bandcamp_new_date, authority_status
FROM bandcamp_product_mappings
WHERE bandcamp_is_preorder = true OR bandcamp_release_date IS NOT NULL
LIMIT 50;

-- Products with Pre-Orders in local tags array (may lag Shopify)
SELECT id, title, shopify_product_id, tags
FROM warehouse_products
WHERE tags @> ARRAY['Pre-Orders']::text[]
LIMIT 50;
```

---

## 4. Trigger.dev configuration

- **Config file:** [`trigger.config.ts`](../../trigger.config.ts) — `dirs: ["src/trigger/tasks"]`, env sync from `.env.local` / `.env.production`.
- **Task registry:** [`src/trigger/tasks/index.ts`](../../src/trigger/tasks/index.ts) exports `preorderSetupTask`, `preorderFulfillmentTask`, `tagCleanupBackfillTask`, etc.

---

## 5. Full code — `preorder-setup.ts`

```typescript
/**
 * Pre-order setup — event trigger.
 *
 * Called when bandcamp-sync or inbound-product-create detects a future street_date.
 * Creates selling plan on Shopify, adds tags, sets is_preorder = true.
 *
 * Rule #7: Uses createServiceRoleClient().
 * Rule #12: Task payload is IDs only.
 */

import { task } from "@trigger.dev/sdk";
import { sellingPlanGroupCreate, tagsAdd } from "@/lib/clients/shopify-client";
import { createServiceRoleClient } from "@/lib/server/supabase-server";

export const preorderSetupTask = task({
  id: "preorder-setup",
  maxDuration: 60,
  run: async (payload: { variant_id: string; workspace_id: string }) => {
    const supabase = createServiceRoleClient();

    // Fetch variant + product
    const { data: variant } = await supabase
      .from("warehouse_product_variants")
      .select("id, sku, product_id, street_date, is_preorder")
      .eq("id", payload.variant_id)
      .single();

    if (!variant) throw new Error(`Variant ${payload.variant_id} not found`);
    if (variant.is_preorder) return { alreadySetUp: true };

    const { data: product } = await supabase
      .from("warehouse_products")
      .select("shopify_product_id")
      .eq("id", variant.product_id)
      .single();

    // Create selling plan group on Shopify
    if (product?.shopify_product_id) {
      try {
        await sellingPlanGroupCreate({
          name: `Pre-Order: ${variant.sku}`,
          merchantCode: "pre-order",
          options: ["Pre-Order"],
          sellingPlansToCreate: [
            {
              name: "Pre-Order",
              options: ["Pre-Order"],
              category: "PRE_ORDER",
              billingPolicy: {
                fixed: {
                  remainingBalanceChargeTrigger: "NO_REMAINING_BALANCE",
                },
              },
              deliveryPolicy: {
                fixed: {
                  fulfillmentTrigger: "UNKNOWN",
                },
              },
            },
          ],
          resourcesIds: {
            productIds: [product.shopify_product_id],
          },
        });

        // Add tags
        await tagsAdd(product.shopify_product_id, ["Pre-Orders", "New Releases"]);
      } catch {
        // Log but don't fail — Shopify may not have this product yet
      }
    }

    // Set is_preorder = true
    await supabase
      .from("warehouse_product_variants")
      .update({ is_preorder: true, updated_at: new Date().toISOString() })
      .eq("id", variant.id);

    return { variantId: variant.id, sku: variant.sku };
  },
});
```

---

## 6. Full code — `preorder-fulfillment.ts`

See current file: [`src/trigger/tasks/preorder-fulfillment.ts`](../../src/trigger/tasks/preorder-fulfillment.ts) — **239 lines**, included in full below.

```typescript
/**
 * Pre-order fulfillment — runs daily at 6 AM EST.
 *
 * Rule #69: FIFO allocation. ORDER BY warehouse_orders.created_at ASC.
 * When available stock hits 0, remaining orders stay pending and a
 * short_shipment review queue item is created (severity: critical).
 *
 * Rule #7: Uses createServiceRoleClient().
 * Rule #12: Task payload is IDs only.
 */

import { schedules } from "@trigger.dev/sdk";
import { tagsRemove } from "@/lib/clients/shopify-client";
import { getAllWorkspaceIds } from "@/lib/server/auth-context";
import { createServiceRoleClient } from "@/lib/server/supabase-server";
import { allocatePreorders } from "@/trigger/lib/preorder-allocation";

export const preorderFulfillmentTask = schedules.task({
  id: "preorder-fulfillment",
  cron: {
    pattern: "0 6 * * *",
    timezone: "America/New_York",
  },
  maxDuration: 300,
  run: async (_payload, { ctx }) => {
    const supabase = createServiceRoleClient();
    const workspaceIds = await getAllWorkspaceIds(supabase);
    const today = new Date().toISOString().split("T")[0];

    let variantsReleased = 0;
    let ordersAllocated = 0;
    let shortShipments = 0;

    for (const workspaceId of workspaceIds) {
      // Find all pre-order variants past their street date
      const { data: variants } = await supabase
        .from("warehouse_product_variants")
        .select("id, sku, product_id, street_date")
        .eq("workspace_id", workspaceId)
        .eq("is_preorder", true)
        .lte("street_date", today);

      if (!variants || variants.length === 0) continue;

      for (const variant of variants) {
        const result = await releaseVariant(supabase, variant, workspaceId, ctx.run.id);
        variantsReleased++;
        ordersAllocated += result.ordersAllocated;
        if (result.isShortShipment) shortShipments++;
      }

      // Log to channel_sync_log
      await supabase.from("channel_sync_log").insert({
        workspace_id: workspaceId,
        channel: "preorder",
        sync_type: "fulfillment",
        status: shortShipments > 0 ? "partial" : "completed",
        items_processed: variantsReleased,
        items_failed: shortShipments,
        started_at: new Date().toISOString(),
        completed_at: new Date().toISOString(),
      });
    }

    // --- "New Releases" tag cleanup (45 days after street_date) ---
    let newReleasesRemoved = 0;
    const cutoff45 = new Date();
    cutoff45.setDate(cutoff45.getDate() - 45);
    const cutoff45Str = cutoff45.toISOString().split("T")[0];

    for (const workspaceId of workspaceIds) {
      const { data: staleProducts } = await supabase
        .from("warehouse_product_variants")
        .select("product_id")
        .eq("workspace_id", workspaceId)
        .not("street_date", "is", null)
        .lte("street_date", cutoff45Str);

      if (!staleProducts || staleProducts.length === 0) continue;

      const productIds = Array.from(new Set(staleProducts.map((v) => v.product_id)));

      const { data: products } = await supabase
        .from("warehouse_products")
        .select("id, shopify_product_id, tags")
        .in("id", productIds)
        .contains("tags", ["New Releases"]);

      for (const product of products ?? []) {
        const tags = (product.tags as string[]) ?? [];
        const updatedTags = tags.filter((t) => t !== "New Releases");

        if (product.shopify_product_id) {
          try {
            await tagsRemove(product.shopify_product_id, ["New Releases"]);
          } catch {
            // Best-effort — don't fail the run
          }
        }

        await supabase
          .from("warehouse_products")
          .update({ tags: updatedTags, updated_at: new Date().toISOString() })
          .eq("id", product.id);

        newReleasesRemoved++;
      }
    }

    return { variantsReleased, ordersAllocated, shortShipments, newReleasesRemoved };
  },
});

async function releaseVariant(
  supabase: ReturnType<typeof createServiceRoleClient>,
  variant: { id: string; sku: string; product_id: string; street_date: string | null },
  workspaceId: string,
  runId: string,
) {
  // Get Shopify product ID for tag/selling plan operations
  const { data: product } = await supabase
    .from("warehouse_products")
    .select("shopify_product_id")
    .eq("id", variant.product_id)
    .single();

  // Remove selling plan from Shopify (best-effort — don't crash if Shopify errors)
  if (product?.shopify_product_id) {
    try {
      // Look for selling plan groups associated with this product
      // In practice you'd store the selling_plan_group_id on the variant or product
      await tagsRemove(product.shopify_product_id, ["Pre-Orders"]);
    } catch {
      // Log but don't fail the whole run
    }
  }

  // Set is_preorder = false on the variant
  await supabase
    .from("warehouse_product_variants")
    .update({ is_preorder: false, updated_at: new Date().toISOString() })
    .eq("id", variant.id);

  // Get available inventory for this SKU
  const { data: inventoryLevel } = await supabase
    .from("warehouse_inventory_levels")
    .select("available")
    .eq("workspace_id", workspaceId)
    .eq("sku", variant.sku)
    .single();

  const availableStock = inventoryLevel?.available ?? 0;

  // Find pending pre-orders for this variant's SKU, ordered by created_at ASC (FIFO)
  const { data: pendingOrders } = await supabase
    .from("warehouse_orders")
    .select("id, created_at")
    .eq("workspace_id", workspaceId)
    .eq("is_preorder", true)
    .lte("street_date", variant.street_date ?? new Date().toISOString().split("T")[0])
    .is("fulfillment_status", null)
    .order("created_at", { ascending: true });

  if (!pendingOrders || pendingOrders.length === 0) {
    return { ordersAllocated: 0, isShortShipment: false };
  }

  // Get order item quantities for each order matching this SKU
  const orderIds = pendingOrders.map((o) => o.id);
  const { data: orderItems } = await supabase
    .from("warehouse_order_items")
    .select("order_id, quantity")
    .in("order_id", orderIds)
    .eq("sku", variant.sku);

  const quantityByOrder = new Map<string, number>();
  for (const item of orderItems ?? []) {
    quantityByOrder.set(item.order_id, (quantityByOrder.get(item.order_id) ?? 0) + item.quantity);
  }

  // Find already-allocated orders (idempotency — don't double-allocate on re-run)
  const { data: alreadyAllocated } = await supabase
    .from("warehouse_orders")
    .select("id")
    .in("id", orderIds)
    .eq("fulfillment_status", "ready_to_ship");

  const alreadyAllocatedIds = new Set((alreadyAllocated ?? []).map((o) => o.id));

  // Build allocation input
  const allocationInput = pendingOrders.map((order) => ({
    id: order.id,
    created_at: order.created_at,
    quantity: quantityByOrder.get(order.id) ?? 1,
  }));

  // FIFO allocation (Rule #69)
  const allocation = allocatePreorders(allocationInput, availableStock, alreadyAllocatedIds);

  // Update allocated orders to ready_to_ship
  if (allocation.allocated.length > 0) {
    const allocatedIds = allocation.allocated.map((a) => a.orderId);
    await supabase
      .from("warehouse_orders")
      .update({
        fulfillment_status: "ready_to_ship",
        updated_at: new Date().toISOString(),
      })
      .in("id", allocatedIds);
  }

  // Create review queue item for short shipment
  if (allocation.isShortShipment) {
    await supabase.from("warehouse_review_queue").insert({
      workspace_id: workspaceId,
      category: "short_shipment",
      severity: "critical",
      title: `Short shipment: ${variant.sku}`,
      description: `Pre-order release for ${variant.sku} (street date: ${variant.street_date}). ${allocation.totalAllocated} units allocated to ${allocation.allocated.length} orders. ${allocation.totalUnallocated} units short across ${allocation.unallocated.length} orders.`,
      metadata: {
        sku: variant.sku,
        variant_id: variant.id,
        available_stock: availableStock,
        allocated_count: allocation.allocated.length,
        unallocated_count: allocation.unallocated.length,
        total_allocated: allocation.totalAllocated,
        total_unallocated: allocation.totalUnallocated,
        run_id: runId,
      },
      group_key: `short_shipment:${variant.sku}`,
      status: "open",
    });
  }

  return {
    ordersAllocated: allocation.allocated.length,
    isShortShipment: allocation.isShortShipment,
  };
}

/**
 * Release a single variant manually (called by manualRelease server action).
 * Exported for use by the server action via tasks.trigger.
 */
export { releaseVariant as _releaseVariantForTesting };
```

---

## 7. Full code — `tag-cleanup-backfill.ts`

```typescript
/**
 * Tag cleanup backfill — manual trigger only.
 *
 * Scans the entire catalog and fixes Pre-Orders / New Releases tags
 * based on current dates and street_date.
 *
 * Tag rules:
 *   street_date > today             → Pre-Orders YES, New Releases YES
 *   street_date <= today             → Pre-Orders NO
 *   street_date + 45 days <= today   → New Releases NO
 *   street_date + 45 days > today    → New Releases leave as-is
 */

import { logger, task } from "@trigger.dev/sdk";
import { tagsAdd, tagsRemove } from "@/lib/clients/shopify-client";
import { createServiceRoleClient } from "@/lib/server/supabase-server";

export const tagCleanupBackfillTask = task({
  id: "tag-cleanup-backfill",
  maxDuration: 600,
  run: async (payload: { workspace_id: string }) => {
    const supabase = createServiceRoleClient();
    const { workspace_id: workspaceId } = payload;
    const today = new Date().toISOString().split("T")[0];
    const cutoff45 = new Date();
    cutoff45.setDate(cutoff45.getDate() - 45);
    const cutoff45Str = cutoff45.toISOString().split("T")[0];

    let preorderAdded = 0;
    let preorderRemoved = 0;
    let newReleaseRemoved = 0;

    // Get all variants with street_date
    const allVariants: Array<{ product_id: string; street_date: string }> = [];
    let offset = 0;
    while (true) {
      const { data } = await supabase
        .from("warehouse_product_variants")
        .select("product_id, street_date")
        .eq("workspace_id", workspaceId)
        .not("street_date", "is", null)
        .range(offset, offset + 999);
      if (!data || data.length === 0) break;
      allVariants.push(...(data as Array<{ product_id: string; street_date: string }>));
      offset += data.length;
      if (data.length < 1000) break;
    }

    // Group by product, pick earliest street_date per product
    const productStreetDates = new Map<string, string>();
    for (const v of allVariants) {
      const existing = productStreetDates.get(v.product_id);
      if (!existing || v.street_date < existing) {
        productStreetDates.set(v.product_id, v.street_date);
      }
    }

    const productIds = Array.from(productStreetDates.keys());
    if (productIds.length === 0) {
      return { preorderAdded, preorderRemoved, newReleaseRemoved, totalScanned: 0 };
    }

    // Fetch products in batches
    for (let i = 0; i < productIds.length; i += 100) {
      const batch = productIds.slice(i, i + 100);
      const { data: products } = await supabase
        .from("warehouse_products")
        .select("id, shopify_product_id, tags")
        .in("id", batch);

      for (const product of products ?? []) {
        const streetDate = productStreetDates.get(product.id);
        if (!streetDate) continue;

        const tags = (product.tags as string[]) ?? [];
        const hasPO = tags.includes("Pre-Orders");
        const hasNR = tags.includes("New Releases");
        const isFuture = streetDate > today;
        const isPast45 = streetDate <= cutoff45Str;

        const tagsToAdd: string[] = [];
        const tagsToRemoveList: string[] = [];

        // Pre-Orders: should have if future, should NOT have if past
        if (isFuture && !hasPO) tagsToAdd.push("Pre-Orders");
        if (!isFuture && hasPO) tagsToRemoveList.push("Pre-Orders");

        // New Releases: should NOT have if 45+ days past street_date
        if (isPast45 && hasNR) tagsToRemoveList.push("New Releases");

        // Future products should have New Releases
        if (isFuture && !hasNR) tagsToAdd.push("New Releases");

        if (tagsToAdd.length === 0 && tagsToRemoveList.length === 0) continue;

        // Update Shopify
        if (product.shopify_product_id) {
          try {
            if (tagsToAdd.length > 0) await tagsAdd(product.shopify_product_id, tagsToAdd);
            if (tagsToRemoveList.length > 0)
              await tagsRemove(product.shopify_product_id, tagsToRemoveList);
          } catch (e) {
            logger.warn("Shopify tag update failed", {
              productId: product.id,
              error: String(e),
            });
          }
        }

        // Update local DB
        let updatedTags = [...tags];
        for (const t of tagsToAdd) {
          if (!updatedTags.includes(t)) updatedTags.push(t);
        }
        updatedTags = updatedTags.filter((t) => !tagsToRemoveList.includes(t));

        await supabase
          .from("warehouse_products")
          .update({ tags: updatedTags, updated_at: new Date().toISOString() })
          .eq("id", product.id);

        if (tagsToAdd.includes("Pre-Orders")) preorderAdded++;
        if (tagsToRemoveList.includes("Pre-Orders")) preorderRemoved++;
        if (tagsToRemoveList.includes("New Releases")) newReleaseRemoved++;
      }
    }

    logger.info("Tag cleanup complete", {
      preorderAdded,
      preorderRemoved,
      newReleaseRemoved,
      totalScanned: productIds.length,
    });

    return {
      preorderAdded,
      preorderRemoved,
      newReleaseRemoved,
      totalScanned: productIds.length,
    };
  },
});
```

---

## 8. Full code — `preorder-allocation.ts`

```typescript
/**
 * FIFO pre-order allocation logic (Rule #69).
 *
 * When a pressing plant short-ships (300 received vs 450 pre-orders),
 * which orders get released matters. Allocate via ORDER BY created_at ASC.
 * When available stock hits 0, remaining orders stay pending and a
 * short_shipment review queue item is created.
 */

export interface PreorderOrder {
  id: string;
  created_at: string;
  quantity: number;
}

export interface AllocationResult {
  allocated: Array<{ orderId: string; quantity: number }>;
  unallocated: Array<{ orderId: string; quantity: number }>;
  totalAllocated: number;
  totalUnallocated: number;
  isShortShipment: boolean;
}

/**
 * Allocates available inventory to pre-orders in FIFO order (oldest first).
 * Pure function — no side effects, fully testable.
 *
 * @param orders - Pre-orders sorted by created_at ASC (FIFO)
 * @param availableStock - Current available inventory for the SKU
 * @param alreadyAllocatedOrderIds - Set of order IDs that were already allocated (for idempotency)
 */
export function allocatePreorders(
  orders: PreorderOrder[],
  availableStock: number,
  alreadyAllocatedOrderIds: Set<string> = new Set(),
): AllocationResult {
  const allocated: Array<{ orderId: string; quantity: number }> = [];
  const unallocated: Array<{ orderId: string; quantity: number }> = [];
  let remaining = availableStock;

  // Sort by created_at ASC to enforce FIFO
  const sorted = [...orders].sort(
    (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
  );

  for (const order of sorted) {
    // Skip already-allocated orders (idempotency)
    if (alreadyAllocatedOrderIds.has(order.id)) {
      continue;
    }

    if (remaining >= order.quantity) {
      allocated.push({ orderId: order.id, quantity: order.quantity });
      remaining -= order.quantity;
    } else {
      unallocated.push({ orderId: order.id, quantity: order.quantity });
    }
  }

  const totalAllocated = allocated.reduce((sum, a) => sum + a.quantity, 0);
  const totalUnallocated = unallocated.reduce((sum, u) => sum + u.quantity, 0);

  return {
    allocated,
    unallocated,
    totalAllocated,
    totalUnallocated,
    isShortShipment: unallocated.length > 0,
  };
}
```

---

## 9. Shopify client — tags + selling plans (excerpt)

**File:** [`src/lib/clients/shopify-client.ts`](../../src/lib/clients/shopify-client.ts) (lines 493–552 at time of handoff)

```typescript
export async function tagsAdd(resourceId: string, tags: string[]): Promise<void> {
  const mutation = `
    mutation TagsAdd($id: ID!, $tags: [String!]!) {
      tagsAdd(id: $id, tags: $tags) {
        userErrors { field message }
      }
    }
  `;
  await shopifyGraphQL(mutation, { id: resourceId, tags });
}

export async function tagsRemove(resourceId: string, tags: string[]): Promise<void> {
  const mutation = `
    mutation TagsRemove($id: ID!, $tags: [String!]!) {
      tagsRemove(id: $id, tags: $tags) {
        userErrors { field message }
      }
    }
  `;
  await shopifyGraphQL(mutation, { id: resourceId, tags });
}

export async function sellingPlanGroupCreate(input: Record<string, unknown>): Promise<string> {
  const mutation = `
    mutation SellingPlanGroupCreate($input: SellingPlanGroupInput!) {
      sellingPlanGroupCreate(input: $input) {
        sellingPlanGroup { id }
        userErrors { field message }
      }
    }
  `;
  const data = await shopifyGraphQL<{
    sellingPlanGroupCreate: {
      sellingPlanGroup: { id: string } | null;
      userErrors: Array<{ field: string[]; message: string }>;
    };
  }>(mutation, { input });

  if (data.sellingPlanGroupCreate.userErrors.length > 0) {
    throw new Error(
      `sellingPlanGroupCreate errors: ${data.sellingPlanGroupCreate.userErrors.map((e) => e.message).join(", ")}`,
    );
  }
  return data.sellingPlanGroupCreate.sellingPlanGroup?.id ?? "";
}

export async function sellingPlanGroupDelete(id: string): Promise<void> {
  const mutation = `
    mutation SellingPlanGroupDelete($id: ID!) {
      sellingPlanGroupDelete(id: $id) {
        userErrors { field message }
      }
    }
  `;
  await shopifyGraphQL(mutation, { id });
}
```

**Note:** `resourceId` for product tags must be Shopify **Product GID** format expected by Admin API (same as stored in `warehouse_products.shopify_product_id`).

---

## 10. Server actions — `preorders.ts` (excerpt)

**File:** [`src/actions/preorders.ts`](../../src/actions/preorders.ts)

```typescript
"use server";

import { tasks } from "@trigger.dev/sdk";
import { createServerSupabaseClient } from "@/lib/server/supabase-server";
import { allocatePreorders } from "@/trigger/lib/preorder-allocation";

export async function getPreorderProducts(filters?: { page?: number; pageSize?: number }) {
  const supabase = await createServerSupabaseClient();
  // ... lists variants with is_preorder = true ...
}

export async function manualRelease(variantId: string) {
  const handle = await tasks.trigger("preorder-fulfillment", {});
  return { runId: handle.id, variantId };
}
```

**Quirk:** `variantId` is accepted but **not passed** to the task; the run processes **all** eligible workspaces/variants.

---

## 11. `bandcamp-sync.ts` — verbatim excerpts (preorder-related)

**Imports (top of file include):** `import { preorderSetupTask } from "@/trigger/tasks/preorder-setup";`

### 11.1 Scraper path → mapping update + variant propagation (lines ~251–317)

```typescript
      const { error: updateErr } = await supabase
        .from("bandcamp_product_mappings")
        .update({
          scrape_failure_count: 0,
          bandcamp_url: payload.url,
          bandcamp_url_source: "scraper_verified",
          bandcamp_type_name: scraped.packages[0]?.typeName ?? null,
          bandcamp_new_date: scraped.releaseDate
            ? scraped.releaseDate.toISOString().slice(0, 10)
            : null,
          bandcamp_release_date: scraped.releaseDate?.toISOString() ?? null,
          bandcamp_is_preorder: scraped.isPreorder,
          bandcamp_art_url: scraped.albumArtUrl,
          // ... more fields ...
        })
        .eq("id", payload.mappingId);

      // Propagate to linked variant
      const { data: mapping } = await supabase
        .from("bandcamp_product_mappings")
        .select("variant_id")
        .eq("id", payload.mappingId)
        .single();

      if (mapping?.variant_id) {
        const { data: variant } = await supabase
          .from("warehouse_product_variants")
          .select("id, street_date, is_preorder, product_id, title")
          .eq("id", mapping.variant_id)
          .single();

        if (variant) {
          const updates: Record<string, unknown> = {};

          if (scraped.releaseDate && !variant.street_date) {
            updates.street_date = scraped.releaseDate.toISOString().slice(0, 10);
          }
          if (scraped.isPreorder && !variant.is_preorder) {
            updates.is_preorder = true;
          }

          if (Object.keys(updates).length > 0) {
            updates.updated_at = new Date().toISOString();
            await supabase.from("warehouse_product_variants").update(updates).eq("id", variant.id);

            if (updates.is_preorder === true) {
              await preorderSetupTask.trigger({
                variant_id: variant.id,
                workspace_id: payload.workspaceId,
              });
              logger.info("Triggered preorder-setup from scraper", {
                variantId: variant.id,
                releaseDate: scraped.releaseDate,
              });
            }
          }
          // ...
        }
      }
```

**Gap (planned fix):** `street_date` only set when `!variant.street_date` — scraper will not refresh an incorrect existing date.

### 11.2 Matched-SKU / `bandcamp_initial` path (lines ~1018–1045)

```typescript
            // Street date — always set from API during bandcamp_initial
            if (merchItem.new_date) {
              updates.street_date = merchItem.new_date;
            }

            // Pre-order flag
            const effectiveDate =
              (updates.street_date as string | undefined) ?? existingVar.street_date;
            if (effectiveDate && new Date(effectiveDate) > new Date()) {
              updates.is_preorder = true;
            } else if (
              existingVar.is_preorder &&
              effectiveDate &&
              new Date(effectiveDate) <= new Date()
            ) {
              updates.is_preorder = false;
            }

            if (Object.keys(updates).length > 0) {
              updates.updated_at = new Date().toISOString();
              await supabase.from("warehouse_product_variants").update(updates).eq("id", variantId);

              if (updates.is_preorder === true) {
                await preorderSetupTask.trigger({
                  variant_id: variantId,
                  workspace_id: workspaceId,
                });
              }
            }
```

**Gap (planned fix):** Uses `merchItem.new_date` (item-added style date from API) rather than authoritative `bandcamp_release_date` / `bandcamp_is_preorder` on mapping when available.

### 11.3 New variant from Bandcamp — tags + `preorder-setup` (lines ~1180–1437)

```typescript
          const tags: string[] = [];
          if (merchItem.new_date && new Date(merchItem.new_date) > new Date()) {
            tags.push("Pre-Orders", "New Releases");
          }
          // ... productSetCreate({ ..., tags, ... }) ...
          const { data: newVariant } = await supabase
            .from("warehouse_product_variants")
            .insert({
              // ...
              street_date: merchItem.new_date,
              is_preorder: tags.includes("Pre-Orders"),
            })
            // ...

            if (tags.includes("Pre-Orders")) {
              await preorderSetupTask.trigger({
                variant_id: newVariant.id,
                workspace_id: workspaceId,
              });
            }
```

---

## 12. Files this plan touches (implementation checklist)

| File | Role |
|------|------|
| [`src/trigger/tasks/bandcamp-sync.ts`](../../src/trigger/tasks/bandcamp-sync.ts) | Fix date/preorder logic (matched SKU + scraper propagation); primary detection ingress |
| [`src/trigger/tasks/sensor-check.ts`](../../src/trigger/tasks/sensor-check.ts) | Add `catalog.preorder_missed` (or equivalent) sensor |
| [`src/trigger/tasks/preorder-setup.ts`](../../src/trigger/tasks/preorder-setup.ts) | Optional hardening: logging, review queue on Shopify failure, DB `tags` sync |
| [`src/trigger/tasks/preorder-fulfillment.ts`](../../src/trigger/tasks/preorder-fulfillment.ts) | Optional: selling plan deletion if IDs stored; stricter cron |
| [`tests/unit/`](../../tests/unit/) | Tests for allocation + any new Bandcamp preorder helpers |
| [`docs/system_map/TRIGGER_TASK_CATALOG.md`](../../docs/system_map/TRIGGER_TASK_CATALOG.md) | Doc sync: tag lifecycle + task IDs |
| [`project_state/journeys.yaml`](../../project_state/journeys.yaml) | If client-facing journey changes |

**Already sufficient for tagging (verify only):** `preorder-setup`, `preorder-fulfillment`, `tag-cleanup-backfill`, `shopify-client` tag mutations.

---

## 13. Verification steps (external party)

```bash
cd /path/to/clandestine-fulfillment
pnpm install
pnpm check
pnpm typecheck
pnpm test
pnpm release:gate
```

**Trigger.dev:** Deploy project; in dashboard trigger `preorder-setup` with `{ "variant_id": "<uuid>", "workspace_id": "<uuid>" }` for a variant whose product has `shopify_product_id` set — confirm in Shopify Admin: tags **Pre-Orders**, **New Releases**, and a pre-order selling plan group.

**Tag removal:** Set `street_date` to yesterday, `is_preorder` true, run `preorder-fulfillment` (or wait for cron) — confirm **Pre-Orders** removed from Shopify product.

**Reconciliation:** Run `tag-cleanup-backfill` with `{ "workspace_id": "<uuid>" }` after bulk data fixes.

---

## 14. API boundaries (catalog reference)

- **Server Actions:** [`src/actions/preorders.ts`](../../src/actions/preorders.ts) — `getPreorderProducts`, `manualRelease`, `getPreorderAllocationPreview` (see [`docs/system_map/API_CATALOG.md`](../system_map/API_CATALOG.md)).
- **Trigger tasks:** IDs `preorder-setup`, `preorder-fulfillment`, `tag-cleanup-backfill`, `bandcamp-sync` — see [`docs/system_map/TRIGGER_TASK_CATALOG.md`](../system_map/TRIGGER_TASK_CATALOG.md).

---

## 15. Doc sync contract

After merging code changes: update `TRIGGER_TASK_CATALOG.md`, and if behavior/user flow changes, `journeys.yaml` and `RELEASE_GATE_CRITERIA.md` per [`TRUTH_LAYER.md`](../../TRUTH_LAYER.md).

---

## 16. Integrated external review + operator requirements (2026-04-10)

This section **accepts and merges** an independent technical review of this handoff, plus **product requirements**: failsafes, backups, **trackability**, and **scan frequency** for new releases / preorder setup.

### 16.1 Schedule reality vs your “≥2×/day” ask

| Concern | Current behavior | Recommendation |
|--------|-------------------|----------------|
| **Detect new Bandcamp merch / API sync** | `bandcamp-sync-cron` **every 30 minutes** | **No change required** for detection cadence; ensure OAuth tokens healthy and queue not starved. |
| **Preorder Shopify setup** | Event-driven: `preorder-setup` triggered from `bandcamp-sync` / scraper paths when logic says preorder | After detection fixes, add **optional** scheduled task `preorder-setup-sweep` (e.g. 2×/day) that finds variants with **future `street_date`**, **`shopify_product_id` set**, **`is_preorder` false or Shopify incomplete** (see §16.3) and **re-triggers** `preorder-setup` with idempotency — **backup** if event path missed. |
| **Release-day tag + selling plan cleanup** | `preorder-fulfillment` **once** at 06:00 America/New_York | **Change cron to ≥2×/day** (e.g. `0 6,18 * * *`) or hourly for stricter SLO; document tradeoff (Shopify API load). |
| **Tag drift vs Shopify** | `tag-cleanup-backfill` manual only | **Optional** weekly schedule per workspace, or run after bulk imports. |

### 16.2 Priority backlog (reviewer + integrated decisions)

#### CRIT-1 — Selling plan groups persist after tag removal (“ghost selling plan”) (**ACCEPT**)

- **Problem:** `releaseVariant` only `tagsRemove`; **tags control badges, but selling plan groups can still drive pre-order checkout behavior** in some themes — “ghost” pre-order state after release.
- **Fix:** Migration adds `warehouse_product_variants.shopify_selling_plan_group_id text` (nullable, partial index where not null).  
  - `preorder-setup`: persist ID returned from `sellingPlanGroupCreate`.  
  - `releaseVariant`: call **`sellingPlanGroupDelete`** when ID present — **before or immediately paired with** `tagsRemove` (order documented in code comments; both must run). Then `tagsRemove(Pre-Orders)`, then **null** column in DB.  
  - **Idempotency:** With **2×/day** (or faster) fulfillment, `sellingPlanGroupDelete` must **treat 404 / already-deleted as success** so a partial prior run does not poison the next.  
- **Doc sync:** new migration file + `TRIGGER_TASK_CATALOG` + this handoff.

#### HIGH-1 — `preorder-setup` swallows Shopify errors (**ACCEPT**)

- **Fix:** Replace empty `catch` with `logger.error`, **`channel_sync_log`** row (`sync_type = 'preorder_setup'`, `status = 'failed'`, `metadata`: `variant_id`, `sku`, Shopify error string), and **`warehouse_review_queue`** (e.g. category `preorder_setup`, severity `high`, `group_key` dedupe per `variant_id`).  
- **Decision:** Still set `is_preorder = true` in DB when the **business** state is preorder even if Shopify failed — warehouse truth for ops; Shopify repaired via retry/sweep.

#### HIGH-2 — Detection fix logic was underspecified (**ACCEPT — §16.4 + §16.4.1 `deriveStreetDateAndPreorder`**)

#### HIGH-3 — `manualRelease` runs entire `preorder-fulfillment` (**ACCEPT — two acceptable patterns**)

- **Pattern A:** New task `preorder-fulfillment-manual` with payload `{ variant_id, workspace_id }` calling shared `releaseVariant`.  
- **Pattern B (alternative):** Extend scheduled `preorder-fulfillment` to accept **optional** `variant_ids: string[]` in payload; when present, **only** those variants; cron path passes empty → full workspace sweep.  
- **Server Action** `manualRelease(variantId)` must use **targeted** path; **UI copy** must state explicitly: “Releases **this** variant only” once fixed (peer checklist §16.10).  
- **Security:** `requireStaff()` (or existing admin gate) before trigger.

#### HIGH-4 — Shared `updateLocalTags(productId, add, remove)` (**ACCEPT**)

- Small helper (DB `warehouse_products.tags` array) called from **`preorder-setup`** (after successful `tagsAdd`), **`preorder-fulfillment` / `releaseVariant`** (after `tagsRemove`), aligned with **`tag-cleanup-backfill`** — reduces dashboard lag vs Shopify-only updates (complements §16.5 GAP-4).

### 16.3 Failsafes, backups, and tracking

**Failsafes**

1. **Shopify setup failure** → review queue + logs (HIGH-1).  
2. **Missed event path** → scheduled `preorder-setup-sweep` (§16.1) with caps per run.  
3. **Tag / plan drift** → `tag-cleanup-backfill` + optional weekly cron.  
4. **Past street + still preorder** → `catalog.preorder_missed` sensor (§16.5).  
5. **Short shipment** → existing `warehouse_review_queue` in `preorder-fulfillment` (unchanged).

**Backups** (operational, not DB backups)

- **Re-run** `bandcamp-sync` / scrape for a mapping; **re-trigger** `preorder-setup` from Trigger dashboard.  
- **Scripted backfill** for dates/flags (§16.5 GAP-3).  
- **Postgres** backups are org-wide infra — out of scope here.

**Tracking / observability**

| Mechanism | Purpose |
|-----------|---------|
| **`warehouse_review_queue`** | Human-visible failures (setup, drift). |
| **`sensor-check` readings** | `catalog.preorder_missed`, optional `catalog.preorder_shopify_incomplete` (e.g. `is_preorder` and `shopify_product_id` set but no stored selling plan ID after grace period). |
| **`channel_sync_log`** | Already used for preorder channel; extend `metadata` with `variant_id`, `shopify_action` (`tags_add`, `plan_create`, `plan_delete`) where useful. |
| **Trigger.dev run history** | Source of truth for task retries; link `run_id` in review metadata. |
| **Optional thin table** `warehouse_preorder_events` | If you need an audit trail without overloading `channel_sync_log`: `variant_id`, `event_type`, `payload jsonb`, `trigger_run_id`, `created_at`. **Defer** unless compliance requires it. |

### 16.4 Detection logic — **chosen specification** (resolves review “Option A vs B”)

**Matched-SKU path (`bandcamp_initial` only)** — single rule set:

1. Load mapping row: `bandcamp_release_date`, `bandcamp_is_preorder`, `bandcamp_new_date`, `bandcamp_url_source`.  
2. **Street date candidate (first match wins):**  
   - If `bandcamp_url_source === 'scraper_verified'` and `bandcamp_release_date` not null → `street_date = (bandcamp_release_date AT TIME ZONE 'UTC')::date` (or `split('T')[0]` equivalent).  
   - Else if `bandcamp_new_date` present → use as `street_date` (API column on mapping).  
   - Else if `merchItem.new_date` present → use (current behavior fallback).  
3. **Preorder flag:**  
   - If `bandcamp_is_preorder === true` → `is_preorder = true`.  
   - Else if `street_date > getPreorderToday()` (date-only, **America/New_York** — §17.3) → `is_preorder = true`.  
   - Else if `street_date <= getPreorderToday()` and variant was preorder → `is_preorder = false`.  
4. If `updates.is_preorder === true` → `preorderSetupTask.trigger` (existing).

**Scraper path** — **Option C + refresh** (authority-aware):

- If `mapping.authority_status === 'bandcamp_initial'` and `scraped.releaseDate` present:  
  - **Always set** `street_date` from scraper (overwrite API-only wrong dates).  
- If `warehouse_reviewed` / `warehouse_locked`: **do not** overwrite `street_date` from scraper (descriptive enrichment only); still update mapping columns.

**New product path** (`productSetCreate`): replace `new Date(merchItem.new_date) > new Date()` with **`isPreorderDate(merchItem.new_date)`** from §16.6, and prefer mapping-derived date once mapping exists (usually next sync).

**Staff override / human date (peer):** If staff set `street_date` ahead of scraper while mapping is still `bandcamp_initial`, **do not** let scraper **roll back** a later manual correction — §16.4 scraper overwrite applies only when improving null/wrong API-derived dates, or gate on “new date is strictly more authoritative” per product policy. Once mapping is **`warehouse_reviewed` / `warehouse_locked`**, scraper must **not** change `street_date` (already stated above).

### 16.4.1 Central helper `deriveStreetDateAndPreorder` (concrete contract)

**New module** (e.g. `src/lib/shared/bandcamp-preorder-dates.ts` or colocated tests next to `bandcamp-sync` lib folder):

```typescript
// Pseudosignature — implement with real types from Bandcamp client + DB row types
function deriveStreetDateAndPreorder(
  merchItem: { new_date?: string | null },
  mapping: {
    bandcamp_release_date?: string | null;
    bandcamp_new_date?: string | null;
    bandcamp_is_preorder?: boolean | null;
    bandcamp_url_source?: string | null;
  } | null,
  nowDate: string, // YYYY-MM-DD from getPreorderToday() / America/New_York
): { street_date: string | null; is_preorder: boolean };
```

**Rules inside helper (align with §16.4):**

1. Normalize all inputs to **date-only `YYYY-MM-DD`** (no `new Date()` comparisons inside consumers).  
2. **Street date priority:** `bandcamp_release_date` (date part) when `bandcamp_url_source === 'scraper_verified'` **or** when release date present and trusted; else `bandcamp_new_date`; else `merchItem.new_date`.  
3. **Preorder:** `bandcamp_is_preorder === true` **or** `street_date > nowDate`.  
4. Used from **matched-SKU update path** and **new-product creation path** so logic cannot diverge.

**Unit tests required:** today / tomorrow / yesterday boundaries; `bandcamp_is_preorder` true with missing release date; scraper-only vs API-only signals.

### 16.5 Technical gaps — resolutions

| ID | Topic | Resolution |
|----|--------|------------|
| GAP-1 | Timezone / date compare | Module: **`src/lib/shared/preorder-dates.ts`** *or* **`src/lib/dates/preorders.ts`** (team pick one path). **Canonical `todayInTz('America/New_York')` → `YYYY-MM-DD`** for all preorder/release comparisons (aligns storefront + `preorder-fulfillment` cron). Prefer **`date-fns-tz`** or **`Temporal`** (if project TS/Node allows) over naive UTC midnight to avoid **DST / midnight flip** bugs. Use in: `bandcamp-sync`, `deriveStreetDateAndPreorder`, `preorder-fulfillment`, `tag-cleanup-backfill`, sensors. |
| GAP-2 | `catalog.preorder_missed` + **detection drift** | **(a)** `is_preorder = true` AND `street_date < getPreorderToday()`. **(b)** **Mapping says preorder / future release but variant does not:** `(bandcamp_is_preorder = true OR bandcamp_release_date::date > today)` **AND** (`variant.is_preorder = false` OR `variant.street_date` null) — safety net for detection bugs. Emit counts + sample SKUs. |
| GAP-3 | Data backfill | One-time script `scripts/backfill-preorder-from-mappings.ts`: reconcile `street_date` / `is_preorder` from mappings, then **batch** `preorder-setup` triggers for newly eligible rows; then `tag-cleanup-backfill` per workspace. Run **after** code deploy. Pre-flight SQL from reviewer (§16.8). |
| GAP-4 | `warehouse_products.tags` lag | **ACCEPT** post-success update in `preorder-setup` and mirror removal in `releaseVariant` (reviewer snippet) — keeps admin SQL / UI aligned with Shopify. |
| GAP-5 | Tests | **Unit:** `deriveStreetDateAndPreorder`, `preorder-dates` / `preorders.ts`, `allocatePreorders` (existing). **Integration-style (mocked Shopify/DB):** new Bandcamp line item with **future** date → `street_date` + `is_preorder` + `preorder-setup` triggered; **release run** → `is_preorder` false, `Pre-Orders` removed, FIFO allocation path exercised; **`tag-cleanup-backfill`:** future product missing tags, past product with lingering `Pre-Orders`, ~60d-old `New Releases` removal. **Selling plan delete:** mock **404** on second delete (idempotency). |

### 16.6 Preorder state machine (documentation)

States: **NOT_PREORDER** → **PREORDER_ACTIVE** (DB `is_preorder`, Shopify tags/plan) → **RELEASED** (`is_preorder` false, tags off, plan deleted).  
Transitions: **DETECTION** (`bandcamp-sync`), **SETUP** (`preorder-setup`), **RELEASE** (`preorder-fulfillment`), **RECONCILE** (`tag-cleanup-backfill` / sweeps).  
Error: **SETUP_FAILED** (review queue), **SHORT_SHIPMENT** (review queue).

### 16.7 Implementation priority (estimated)

| Priority | Item | Notes |
|----------|------|--------|
| P0 | CRIT-1 selling plan ID + delete | Migration + setup + fulfillment |
| P0 | HIGH-1 logging + review queue | No silent failures |
| P1 | HIGH-3 manual single-variant task | UX + cost |
| P1 | Date helper module + call sites | Reduces timezone bugs |
| P1 | §16.4 detection patches in `bandcamp-sync` | Core accuracy |
| P1 | **`deriveStreetDateAndPreorder`** module + unit tests | Single source for matched-SKU + new-product paths |
| P1 | `catalog.preorder_missed` + optional **`catalog.preorder_tag_drift`** | Includes mapping-vs-variant drift (§16.5 GAP-2) |
| P2 | **`updateLocalTags` + tag_cleanup `channel_sync_log`** | §16.2 HIGH-4, §17.3 |
| P1 | `preorder-fulfillment` cron **2×/day** or **every 4–6h** | Operator requirement; **or** split: frequent lightweight **`preorder-shopify-cleanup`** (tags + selling plan only) vs less frequent full job with FIFO allocation (§17.3). |
| P2 | `preorder-setup-sweep` backup schedule | Failsafe |
| P2 | DB `tags` sync on setup/release | GAP-4 |
| P2 | Backfill script + pre-flight SQL | Data |
| P3 | Optional `warehouse_preorder_events` | Audit |
| P3 | Expanded integration tests | Regression |

### 16.8 Extended SQL verification (from review — run before/after backfill)

```sql
-- Preorders past street date still flagged
SELECT COUNT(*) FROM warehouse_product_variants
WHERE is_preorder = true AND street_date IS NOT NULL AND street_date <= CURRENT_DATE;

-- Preorder with no street date
SELECT COUNT(*) FROM warehouse_product_variants
WHERE is_preorder = true AND street_date IS NULL;

-- After CRIT-1: active preorder + Shopify product but no stored plan ID (expect 0 after grace)
-- (column name must match migration)
SELECT COUNT(*) FROM warehouse_product_variants v
JOIN warehouse_products p ON p.id = v.product_id
WHERE v.is_preorder = true AND p.shopify_product_id IS NOT NULL
  AND v.shopify_selling_plan_group_id IS NULL;

-- Scraper vs API date mismatch on mapping
SELECT COUNT(*) FROM bandcamp_product_mappings
WHERE bandcamp_release_date IS NOT NULL AND bandcamp_new_date IS NOT NULL
  AND (bandcamp_release_date::date)::text != bandcamp_new_date;
```

### 16.9 Files to touch (cumulative)

- `supabase/migrations/*_preorder_selling_plan_id.sql` — new column + index.  
- `src/trigger/tasks/preorder-setup.ts` — store plan ID, errors, tags sync, logging.  
- `src/trigger/tasks/preorder-fulfillment.ts` — delete plan, clear ID, 2× cron, tags sync, extract manual task.  
- `src/trigger/tasks/index.ts` + `trigger.config.ts` — register new tasks.  
- `src/actions/preorders.ts` — `manualRelease` payload task.  
- `src/trigger/tasks/bandcamp-sync.ts` — §16.4 + date helpers.  
- `src/trigger/tasks/sensor-check.ts` — `catalog.preorder_missed`.  
- New `src/lib/shared/preorder-dates.ts` **or** `src/lib/dates/preorders.ts` — **pick one**, delete the other name from docs after implementation.  
- New `src/lib/shared/bandcamp-preorder-dates.ts` (or similar) — `deriveStreetDateAndPreorder` + tests.  
- Shared **`updateLocalTags`** helper — e.g. `src/lib/server/product-tags.ts` (service-role safe).  
- `scripts/backfill-preorder-from-mappings.ts`.  
- Tests under `tests/unit/`.  
- Truth docs: `TRIGGER_TASK_CATALOG.md`, `API_CATALOG.md` (if new task IDs), optional `journeys.yaml`.
- **Optional:** `preorder-shopify-cleanup` task (§17.3) — tags/plan only, high cadence.
- **Refactor (debt):** peel **“merch discovery”** vs **“mapping / variant update”** out of monolithic `bandcamp-sync.ts` (~1,877 lines) when touching file anyway — reduces salvage-style debugging (§17.5).

### 16.10 Operator checklist (peer review)

| Check | Question |
|-------|----------|
| **Setup** | Does `preorder-setup` write **`channel_sync_log`** + optional **`warehouse_review_queue`** on Shopify `UserError` / thrown error? |
| **Manual release** | Does UI state **single-variant** scope (not global fulfillment)? |
| **Tags** | Is **`warehouse_products.tags`** updated immediately after successful Shopify tag mutations (`updateLocalTags` / GAP-4)? |
| **Selling plans** | Is migration **`shopify_selling_plan_group_id`** applied **before** mass preorder-setup reruns? |
| **Ghost plan** | Does release path call **`sellingPlanGroupDelete`** and handle **idempotent** missing group? |

### 16.11 Open questions (deferred product decisions)

- **Customer “release notification” when `preorder-fulfillment` completes:** Out of scope for this handoff unless specified — typically **Shopify’s native order/shipping notifications** cover post-release fulfillment; a **custom Trigger + email** (Resend) would be a separate journey (`project_state/journeys.yaml`) and template work. **Decision:** product/ops to choose Shopify-only vs Clandestine-triggered campaign.

---

## 17. Cross-cutting guardrails (inventory, titles, preorder) — additional technical notes

Third-party review notes below are **merged into this handoff** so execution teams treat inventory, catalog integrity, and preorder work as **one operational system** (shared sensors, review queue, migrations).

### 17.1 Inventory system audit — items to preserve or implement

| Topic | Guidance |
|-------|-----------|
| **Redis rollback (Rules #20 / #43)** | Treat compensating `adjustInventory(..., -delta, \`${correlationId}:rollback\`)` after Postgres RPC failure as **Step 0**: closes Redis-ahead-of-Postgres window; keeps `sensor-check` as safety net. Ensure **`:rollback` suffix** is always distinct so Lua SETNX does not block. **Optional:** structured row to `channel_sync_log` when rollback path fires (detect “hot” rollback). |
| **Inbound `warehouse_inventory_levels` (CRIT-4)** | Insert level row with **`variant_id`** aligned to inbound check-in + **`workspace_id`** consistent with shipment; `derive_inventory_org_id` still sets `org_id` — mismatched `workspace_id` breaks scoped queries even if org is correct. |
| **Workspace / org scoping (CRIT-5, HIGH-1, M1)** | Keep `requireStaff()` / `requireClient()` + explicit `workspace_id` / `org_id` filters. For **`getInventoryDetail`** and future admin/debug paths: **never** reintroduce SKU-only lookups — that is where cross-org leaks recur. |
| **Redis backfill (M4+)** | Before trusting seed/backfill overwrites: compare Redis vs Postgres, treat **null vs 0** like `getInventory` normalization; on mismatch, log **sample SKUs** to `warehouse_review_queue` or `channel_sync_log`, not only counts. |
| **Shopify push connection (CRIT-3)** | Adding `client_store_connections` row is data-only; validate with **single-SKU** `recordInventoryChange` → Postgres + Redis + Shopify via `multi-store-inventory-push`. |
| **Sensor: push freshness** | If any Shopify connection exists, sensor: **last push &lt; X minutes** (or staleness flag) to catch dead credentials. |
| **Migration parity (M9)** | Before heavy backfills: **diff live DB vs migration chain**; consider one-time `schema_migrations` bootstrap so future applies are predictable — critical for `bandcamp_*`, `safety_stock`, preorder columns. |
| **Review queue overload (M10)** | With large open backlogs: severity filters/dashboards; auto-close stale low-severity items; **aggressive `group_key` dedupe** so new sensors do not drown signal. |

**Primary code touchpoints (inventory):** [`src/lib/server/record-inventory-change.ts`](../../src/lib/server/record-inventory-change.ts), [`src/trigger/tasks/inbound-product-create.ts`](../../src/trigger/tasks/inbound-product-create.ts), [`src/actions/inventory.ts`](../../src/actions/inventory.ts), [`src/trigger/tasks/redis-backfill.ts`](../../src/trigger/tasks/redis-backfill.ts) (when comparison lands), [`src/trigger/tasks/sensor-check.ts`](../../src/trigger/tasks/sensor-check.ts).

### 17.2 Product title + data integrity — items to preserve or implement

| Topic | Guidance |
|-------|-----------|
| **`assembleBandcampTitle`** | Keep **format normalization in one place** (narrow union or canonical map: e.g. Vinyl LP, Cassette, Compact Disc (CD)) so upstream strings do not produce **“Vinyl LP Vinyl LP”**. Extend **unit tests:** album title already ends with format; **merch** lines where `item_type` is null but title is “T-Shirt” / “Bundle”. |
| **Artist resolution** | `const memberBand = merchItem.member_band_id ? bandLookup.get(merchItem.member_band_id) : null`; `artistName = memberBand?.name ?? band?.name ?? connection.band_name ?? "Unknown Artist"`. **Log** when `member_band_id` is set but **missing from `bandLookup`** (~5% unresolvable without extra API) — feed **bandcamp.health-style** metric. Extract **`resolveArtistName({ merchItem, bandLookup, connection })`** for isolated tests and reuse. |
| **Authority in SQL, not only comments** | Correction script **SELECT** must filter `authority_status = 'bandcamp_initial'`. Optional extra guard: **`warehouse_products.shopify_product_id IS NULL OR product_type = 'Bandcamp'`** (or your convention for Shopify-origin rows) to avoid overwriting **Shopify-sourced** titles. |
| **Idempotency** | Update only when `newTitle !== currentTitle` or `newArtUrl !== currentArtUrl`. **`channel_sync_log`** with deterministic **`group_key`** / metadata key e.g. `product_data_correction:${product_id}` to limit review noise. |
| **Image ordering** | When fixing primary art: update **`position = 0`** row (or equivalent) only; **leave secondary images** untouched. |
| **Art mismatch guardrail** | Before overwrite: **`bandcamp_art_url` non-null**. Optional: ensure current primary **src** is not reused as primary on **another** product mapped to the **same** Bandcamp item (avoid “stealing” art in edge cases). |
| **Authority (runtime)** | Scripts/automation: only mutate when `bandcamp_initial`; **log warning** on skipped rows. |
| **Alt text** | Primary image → `bandcamp_art_url`; alt = **corrected product title**. |
| **Batching** | Batches ~50–100; **per-product transactional** grouping where supported. |

**Primary touchpoints:** [`src/lib/clients/bandcamp.ts`](../../src/lib/clients/bandcamp.ts), [`src/trigger/tasks/bandcamp-sync.ts`](../../src/trigger/tasks/bandcamp-sync.ts), [`scripts/fix-product-titles.ts`](../../scripts/fix-product-titles.ts), [`scripts/fix-product-fields.ts`](../../scripts/fix-product-fields.ts) (or consolidated script per your repo).

### 17.3 Preorder — refinements from latest notes

| Topic | Guidance |
|-------|-----------|
| **Cadence** | Detection: `bandcamp-sync-cron` **30 min** (unchanged). **Promotion/cleanup:** either increase **`preorder-fulfillment`** frequency (2×/day, 4–6h, etc.) **or** add **`preorder-shopify-cleanup`**: lightweight scheduled task that only runs **tag remove + sellingPlanGroupDelete** (when ID stored) for `street_date <= today` — **without** full FIFO allocation — then keep full job 1×/day for orders. |
| **`preorder-setup` observability** | Minimum: `channel_sync_log` row `status = failed` + Shopify error string. Better: `warehouse_review_queue` `preorder_setup_failed` (aligned with §16.2 HIGH-1). |
| **Selling plan CRIT-1** | Same as §16.2 — store ID, delete on release. Until then: themes may still show pre-order purchase options after tag removal. |
| **`manualRelease`** | Dedicated single-variant task calling shared release path (§16.2 HIGH-3); UI must show **scope = one SKU/variant**. |
| **Detection gaps** | Confirms §16.4: `bandcamp_initial` ingest uses best `street_date` signal; forward-only corrections while still `bandcamp_initial`. |
| **Tag rule ownership** | **Canonical tag math:** `tag-cleanup-backfill` + `preorder-fulfillment` / cleanup task. **`bandcamp-sync` / `preorder-setup`:** apply tags on Shopify for **create/setup** only — avoid third divergent rule set in Bandcamp product-create path where possible (document exception if theme requires tags at create). |
| **Shopify env (Clandestine store)** | Document for external engineers — from [`src/lib/shared/env.ts`](../../src/lib/shared/env.ts): **`SHOPIFY_STORE_URL`**, **`SHOPIFY_ADMIN_API_TOKEN`**, **`SHOPIFY_API_VERSION`** (plus webhook/client vars as applicable). Validate wiring with **shop ping** (read `shop { name }`) in admin or a tiny diagnostic script. |
| **Sensor: tag drift** | `is_preorder = true` but product missing **`Pre-Orders`** in `warehouse_products.tags` (after GAP-4 sync) or optional Shopify read — catches miswired env. |
| **`tag-cleanup-backfill` observability** | On run completion, insert or update **`channel_sync_log`** (`sync_type = 'tag_cleanup_backfill'`, counts: tags added/removed, products scanned) so operators see **last run** and **scope** without digging Trigger logs. |
| **Index check** | Confirm **`warehouse_product_variants (workspace_id, street_date)`** (or covering index) supports tag backfill scans; add migration if planner shows seq scans at scale. |

### 17.4 CI / guardrail checklist (future hardening)

Optional automation so assumptions do not regress silently:

1. **SQL checks** (CI or nightly): §16.8 + §17.1 migration-parity query pack; zero rows for “past street + is_preorder”, etc.  
2. **TypeScript smoke:** import `preorder-dates` tests; grep guard: no new `from("warehouse_inventory_levels").update` outside `record-inventory-change` (existing Rule #42 direction).  
3. **Trigger task list:** asserted against `src/trigger/tasks/index.ts` for required IDs (`preorder-setup`, `preorder-fulfillment`, …).  
4. **Review queue budget:** alert when `open` count &gt; N or when `critical` age &gt; SLA.  
5. **Unit:** `deriveStreetDateAndPreorder` + `resolveArtistName` + `stripClandestineReleaseBlock` (§18).

### 17.5 `bandcamp-sync.ts` maintainability (peer)

~**1,877 lines** is high-risk for preorder + catalog changes. When implementing §16 / §18, **prefer extracting** new logic into **`src/lib/shared/`** (dates, description assembly, `deriveStreetDateAndPreorder`) and leave the task file as **orchestration + I/O** only. Longer-term: split **merch discovery** from **mapping/variant mutation** into separate modules imported by the task.

---

## 18. Shopify “Release Date” in product description + Bandcamp health “last catalog scan”

### 18.1 Scope (product)

1. **Shopify listing body:** Prepend a line at the **top** of the product HTML description (the “about” area Shopify calls `descriptionHtml`): **`Release Date {formatted date}`** (exact label TBD; default below uses **“Release Date”** + human-readable date).  
2. **Bandcamp Settings → Health (Scraper Health tab):** Show **last merch catalog scan** timestamp and **how many new warehouse products/variants** were created on that run (not total items processed).

**Current state:** `street_date` / mapping dates exist in Postgres; `buildDescriptionHtml` does **not** include release text; Shopify descriptions are only about/tracklist/credits from scrape. See §18.4–18.6.

### 18.2 Files to touch

| File | Change |
|------|--------|
| [`src/lib/shared/shopify-description-release.ts`](../../src/lib/shared/shopify-description-release.ts) | **NEW** — format date + prepend/strip release paragraph (full proposed code §18.6). |
| [`src/trigger/tasks/bandcamp-sync.ts`](../../src/trigger/tasks/bandcamp-sync.ts) | Extend `buildDescriptionHtml`; pass release date from scraper/API; update DB + Shopify push; increment `newWarehouseProductsThisRun` when creating product+variant; add to `channel_sync_log.metadata` on merch_sync complete. **Monolith ~1,877 lines — §18.7 lists exact edit regions; full file stays in repo.** |
| [`src/actions/bandcamp.ts`](../../src/actions/bandcamp.ts) | Extend `getBandcampScraperHealth` return with `lastMerchCatalogScan` + `newItemsLastMerchSync` from latest completed `merch_sync` log. |
| [`src/app/admin/settings/bandcamp/page.tsx`](../../src/app/admin/settings/bandcamp/page.tsx) | `ScraperHealthTab`: two new summary cards/rows. |
| [`docs/system_map/API_CATALOG.md`](../system_map/API_CATALOG.md) | Document new `getBandcampScraperHealth` fields. |

**Unchanged but contract:** [`src/lib/clients/shopify.ts`](../../src/lib/clients/shopify.ts) — still uses `productUpdate({ descriptionHtml })`; full current file in §18.5.

### 18.3 Design decisions (lock before build)

- **Date source priority:** Align with preorder handoff §16.4: `scraped.releaseDate` → mapping `bandcamp_release_date` → variant `street_date` → `merchItem.new_date` / `bandcamp_new_date`.  
- **Overwrite policy (v1):** Prepend release block when writing description for **first fill** (`description_html` null/empty) **or** when releasing a **versioned** HTML comment marker so re-scrape can replace only that block — e.g. `<!--clandestine-release-date:2026-04-10--><p>…</p>`. **v1 minimal:** only when null/empty + optional follow-up task to refresh marker when `street_date` changes.  
- **Formatting:** Use `Intl.DateTimeFormat('en-US', { dateStyle: 'long', timeZone: 'America/New_York' })` unless product wants ISO.  
- **No theme metafield in v1** (user asked for about section); metafield can be §18.9 future.

### 18.4 `channel_sync_log.metadata` (merch_sync completion)

Add to existing update block (~L1522):

```json
{
  "new_warehouse_products": <number>,
  "last_merch_catalog_scan_at": "<ISO completed_at>"
}
```

Increment `newWarehouseProductsThisRun` only in the **new product insert** path (after successful `warehouse_products` + `warehouse_product_variants` insert for a **new** SKU — not mapping-only, not existing-variant updates).

### 18.5 Full code — current [`src/lib/clients/shopify.ts`](../../src/lib/clients/shopify.ts)

```typescript
"use server";

import { env } from "@/lib/shared/env";

// Minimal Shopify Admin API client for product mutations.
// Rule #1: NEVER use productSet for edits. Use productUpdate + productVariantsBulkUpdate.

interface ShopifyGraphQLResponse<T> {
  data?: T;
  errors?: Array<{ message: string }>;
}

async function shopifyAdmin<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
  const { SHOPIFY_STORE_URL, SHOPIFY_ADMIN_API_TOKEN, SHOPIFY_API_VERSION } = env();
  const url = `${SHOPIFY_STORE_URL}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": SHOPIFY_ADMIN_API_TOKEN,
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!res.ok) {
    throw new Error(`Shopify API error: ${res.status} ${res.statusText}`);
  }

  const json = (await res.json()) as ShopifyGraphQLResponse<T>;

  if (json.errors?.length) {
    throw new Error(`Shopify GraphQL errors: ${json.errors.map((e) => e.message).join(", ")}`);
  }

  if (!json.data) {
    throw new Error("Shopify returned no data");
  }

  return json.data;
}

// Rule #1: productUpdate for editing existing products (NOT productSet)
export async function productUpdate(input: {
  id: string;
  title?: string;
  descriptionHtml?: string;
  vendor?: string;
  productType?: string;
  tags?: string[];
  status?: "ACTIVE" | "DRAFT" | "ARCHIVED";
}) {
  const mutation = `
    mutation productUpdate($input: ProductInput!) {
      productUpdate(input: $input) {
        product {
          id
          title
          descriptionHtml
          vendor
          productType
          tags
          status
          updatedAt
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  const result = await shopifyAdmin<{
    productUpdate: {
      product: {
        id: string;
        title: string;
        productType: string;
        tags: string[];
        updatedAt: string;
      };
      userErrors: Array<{ field: string[]; message: string }>;
    };
  }>(mutation, { input });

  if (result.productUpdate.userErrors.length > 0) {
    throw new Error(
      `productUpdate errors: ${result.productUpdate.userErrors.map((e) => e.message).join(", ")}`,
    );
  }

  return result.productUpdate.product;
}

// Rule #1: productVariantsBulkUpdate for editing variants (NOT productSet)
export async function productVariantsBulkUpdate(
  productId: string,
  variants: Array<{
    id: string;
    price?: string;
    compareAtPrice?: string | null;
    weight?: number;
    barcode?: string | null;
  }>,
) {
  const mutation = `
    mutation productVariantsBulkUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
      productVariantsBulkUpdate(productId: $productId, variants: $variants) {
        productVariants {
          id
          price
          compareAtPrice
          weight
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  const result = await shopifyAdmin<{
    productVariantsBulkUpdate: {
      productVariants: Array<{
        id: string;
        price: string;
        compareAtPrice: string | null;
        weight: number;
      }>;
      userErrors: Array<{ field: string[]; message: string }>;
    };
  }>(mutation, { productId, variants });

  if (result.productVariantsBulkUpdate.userErrors.length > 0) {
    throw new Error(
      `productVariantsBulkUpdate errors: ${result.productVariantsBulkUpdate.userErrors.map((e) => e.message).join(", ")}`,
    );
  }

  return result.productVariantsBulkUpdate.productVariants;
}
```

### 18.6 Full proposed NEW file — `src/lib/shared/shopify-description-release.ts`

```typescript
/**
 * Release date line for Shopify product descriptionHtml (about section).
 * Uses a stable HTML comment prefix so future syncs can replace in place.
 */

export const RELEASE_DATE_BLOCK_PREFIX = "<!--clandestine-release-date:";

/** `dateStr` = YYYY-MM-DD */
export function formatReleaseDateLabel(dateStr: string): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  if (!y || !m || !d) return dateStr;
  const utc = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "long",
    timeZone: "America/New_York",
  }).format(utc);
}

/** One paragraph: "Release Date April 10, 2026" */
export function buildReleaseDateParagraph(dateStr: string): string {
  const label = formatReleaseDateLabel(dateStr);
  return `${RELEASE_DATE_BLOCK_PREFIX}${dateStr}--><p><strong>Release Date</strong> ${label}</p>`;
}

/** Strip old release block, prepend fresh one to body (about/tracklist/credits HTML). */
export function prependReleaseDateToDescription(dateStr: string, bodyHtml: string | null): string {
  const releaseBlock = buildReleaseDateParagraph(dateStr);
  const rest = stripClandestineReleaseBlock(bodyHtml ?? "").trim();
  return rest ? `${releaseBlock}\n\n${rest}` : releaseBlock;
}

export function stripClandestineReleaseBlock(html: string): string {
  // `s` (dotAll): allow newline between comment and <p> if theme/editor injects whitespace
  const re =
    /<!--clandestine-release-date:\d{4}-\d{2}-\d{2}-->\s*<p><strong>Release Date<\/strong>[^<]*<\/p>\s*/gis;
  return html.replace(re, "").trim();
}
```

**Note:** Tighten regex if copy changes; or parse comment only and remove following `<p>`.

### 18.7 `bandcamp-sync.ts` — edit regions (full file not inlined)

1. **Imports:** add `prependReleaseDateToDescription`, `buildReleaseDateParagraph` from `@/lib/shared/shopify-description-release`.  
2. **Prefer moving “body” assembly** (`buildDescriptionHtml` + any future variants) **into `shopify-description-release.ts`** (or `bandcamp-description.ts`) so `bandcamp-sync.ts` does not grow further — task file calls **one** `buildBandcampShopifyDescription({ about, tracks, credits, releaseDate })` (peer §17.5).  
3. **After body HTML exists:** if `dateStr` present, `fullHtml = prependReleaseDateToDescription(dateStr, bodyHtml)`; use `fullHtml` for DB + Shopify.  
4. **`stripClandestineReleaseBlock` regex:** use **`/s` (dotAll)** if the paragraph can span lines or if whitespace varies between comment and `<p>` (peer review).  
5. **Scraper path (~L344–390):** derive `dateStr` from `scraped.releaseDate`; store + push `fullHtml`.  
6. **New product path (~L1257–1325):** when `merchItem.new_date` present, seed `description_html` appropriately.  
7. **Main sync run:** `let newWarehouseProductsThisRun = 0`; increment per **new** product+variant create; merge into `metadata` on sync log update (~L1522).  

### 18.8 Current full `getBandcampScraperHealth` — [`src/actions/bandcamp.ts`](../../src/actions/bandcamp.ts) (L403–579 at handoff time)

```typescript
export async function getBandcampScraperHealth(workspaceId: string) {
  const supabase = createServiceRoleClient();

  // ── All mapping data for coverage calculations (paginated to avoid 1000-row cap) ──
  const mappings: Array<Record<string, unknown>> = [];
  let mappingOffset = 0;
  while (true) {
    const { data: page } = await supabase
      .from("bandcamp_product_mappings")
      .select(
        "id, bandcamp_url, bandcamp_url_source, bandcamp_subdomain, bandcamp_album_title, bandcamp_price, bandcamp_art_url, bandcamp_about, bandcamp_credits, bandcamp_tracks, bandcamp_options, bandcamp_origin_quantities, bandcamp_catalog_number, bandcamp_upc, raw_api_data, bandcamp_image_url, bandcamp_new_date",
      )
      .eq("workspace_id", workspaceId)
      .range(mappingOffset, mappingOffset + 999);
    if (!page?.length) break;
    mappings.push(...page);
    if (page.length < 1000) break;
    mappingOffset += 1000;
  }

  const t = mappings.length;

  // API data coverage
  const apiCoverage = {
    subdomain: mappings?.filter((m) => m.bandcamp_subdomain).length ?? 0,
    albumTitle: mappings?.filter((m) => m.bandcamp_album_title).length ?? 0,
    price: mappings?.filter((m) => m.bandcamp_price != null).length ?? 0,
    releaseDate: mappings?.filter((m) => m.bandcamp_new_date).length ?? 0,
    image: mappings?.filter((m) => m.bandcamp_image_url).length ?? 0,
    originQuantities: mappings?.filter((m) => m.bandcamp_origin_quantities).length ?? 0,
    rawApiData: mappings?.filter((m) => m.raw_api_data).length ?? 0,
    options: mappings?.filter((m) => m.bandcamp_options).length ?? 0,
  };

  // Scraper coverage
  const scraperCoverage = {
    artUrl: mappings?.filter((m) => m.bandcamp_art_url).length ?? 0,
    about: mappings?.filter((m) => m.bandcamp_about && m.bandcamp_about !== "").length ?? 0,
    credits: mappings?.filter((m) => m.bandcamp_credits && m.bandcamp_credits !== "").length ?? 0,
    tracks: mappings?.filter((m) => m.bandcamp_tracks).length ?? 0,
  };

  // Sales data coverage
  const salesCoverage = {
    catalogNumber: mappings?.filter((m) => m.bandcamp_catalog_number).length ?? 0,
    upc: mappings?.filter((m) => m.bandcamp_upc).length ?? 0,
  };

  // URL breakdown by source
  const urlSources = { scraper_verified: 0, constructed: 0, orders_api: 0, none: 0 };
  for (const m of mappings ?? []) {
    if (!m.bandcamp_url) urlSources.none++;
    else if (m.bandcamp_url_source === "scraper_verified") urlSources.scraper_verified++;
    else if (m.bandcamp_url_source === "constructed") urlSources.constructed++;
    else if (m.bandcamp_url_source === "orders_api") urlSources.orders_api++;
    else urlSources.orders_api++;
  }
  const totalWithUrl = t - urlSources.none;

  // ── Sync pipeline: latest per sync_type ──
  const { data: allLogs } = await supabase
    .from("channel_sync_log")
    .select("sync_type, status, items_processed, items_failed, created_at, metadata")
    .eq("workspace_id", workspaceId)
    .eq("channel", "bandcamp")
    .order("created_at", { ascending: false })
    .limit(100);

  const syncPipeline: Array<{
    syncType: string;
    status: string;
    itemsProcessed: number;
    itemsFailed: number;
    createdAt: string;
    metadata: unknown;
  }> = [];
  const seenTypes = new Set<string>();
  for (const l of allLogs ?? []) {
    if (l.sync_type === "scrape_page") continue;
    if (!seenTypes.has(l.sync_type)) {
      seenTypes.add(l.sync_type);
      syncPipeline.push({
        syncType: l.sync_type,
        status: l.status,
        itemsProcessed: l.items_processed,
        itemsFailed: l.items_failed,
        createdAt: l.created_at,
        metadata: l.metadata,
      });
    }
  }

  // Scrape page stats (last hour aggregate)
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const recentScrapes = (allLogs ?? []).filter(
    (l) => l.sync_type === "scrape_page" && l.created_at >= oneHourAgo,
  );
  const scrapeStats = {
    total: recentScrapes.length,
    success: recentScrapes.filter((l) => l.status === "completed").length,
    failed: recentScrapes.filter((l) => l.status === "failed").length,
    blocked: recentScrapes.filter((l) => {
      const hs = (l.metadata as Record<string, unknown>)?.httpStatus;
      return hs === 403 || hs === 429;
    }).length,
  };

  // ── Pre-orders ──
  const { data: preorders } = await supabase
    .from("warehouse_product_variants")
    .select("id, sku, street_date, warehouse_products!inner(id, title)")
    .eq("workspace_id", workspaceId)
    .eq("is_preorder", true)
    .order("street_date", { ascending: true });

  const preorderList = (preorders ?? []).map((p) => ({
    variantId: p.id,
    productId: (p.warehouse_products as unknown as { id: string }).id,
    title: (p.warehouse_products as unknown as { title: string }).title,
    sku: p.sku,
    streetDate: p.street_date,
  }));

  // Sales totals
  const { count: totalSales } = await supabase
    .from("bandcamp_sales")
    .select("id", { count: "exact", head: true })
    .eq("workspace_id", workspaceId);

  const { data: buyerEmails } = await supabase
    .from("bandcamp_sales")
    .select("buyer_email")
    .eq("workspace_id", workspaceId)
    .not("buyer_email", "is", null);
  const uniqueBuyers = new Set((buyerEmails ?? []).map((e) => e.buyer_email)).size;

  // ── Sensor readings ──
  const { data: sensorReadings } = await supabase
    .from("sensor_readings")
    .select("sensor_name, status, value, message, created_at")
    .eq("workspace_id", workspaceId)
    .in("sensor_name", [
      "sync.bandcamp_stale",
      "bandcamp.merch_sync_log_stale",
      "bandcamp.scraper_review_open",
      "bandcamp.scrape_block_rate",
    ])
    .order("created_at", { ascending: false })
    .limit(10);

  // ── Open issues ──
  const { data: reviewItems, count: reviewCount } = await supabase
    .from("warehouse_review_queue")
    .select("id, title, severity, group_key, metadata, created_at", { count: "exact" })
    .eq("workspace_id", workspaceId)
    .eq("category", "bandcamp_scraper")
    .eq("status", "open")
    .order("created_at", { ascending: false })
    .limit(25);

  return {
    total: t,
    apiCoverage,
    scraperCoverage,
    salesCoverage,
    urlSources,
    totalWithUrl,
    syncPipeline,
    scrapeStats,
    preorders: preorderList,
    totalSales: totalSales ?? 0,
    uniqueBuyers,
    sensorReadings: sensorReadings ?? [],
    reviewItems: reviewItems ?? [],
    reviewCount: reviewCount ?? 0,
  };
}
```

**Proposed addition** (before `return {`): query latest row where `sync_type === 'merch_sync'` AND `status IN ('completed','partial')` ordered by `completed_at` desc nulls last; read `metadata.new_warehouse_products`, `completed_at` → expose as:

```typescript
merchCatalogScan: {
  lastCompletedAt: string | null;
  newItemsLastRun: number;
  status: string | null;
} | null;
```

### 18.9 Proposed UI snippet — `ScraperHealthTab` cards

Add after the “Row 1: Key numbers” grid in [`src/app/admin/settings/bandcamp/page.tsx`](../../src/app/admin/settings/bandcamp/page.tsx):

```tsx
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Card>
          <CardHeader className="pb-1">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Last catalog scan
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-lg font-semibold tabular-nums">
              {data.merchCatalogScan?.lastCompletedAt
                ? timeAgo(data.merchCatalogScan.lastCompletedAt)
                : "—"}
            </p>
            <p className="text-xs text-muted-foreground font-mono truncate">
              {data.merchCatalogScan?.lastCompletedAt ?? "No completed merch_sync yet"}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-1">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              New items last scan
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold tabular-nums">
              {data.merchCatalogScan?.newItemsLastRun ?? 0}
            </p>
            <p className="text-xs text-muted-foreground">
              New warehouse products created on last merch sync
            </p>
          </CardContent>
        </Card>
      </div>
```

Wire `merchCatalogScan` on the `data` object from extended `getBandcampScraperHealth`.

### 18.10 Verification

- After scrape: Shopify Admin → product → description shows **Release Date** first.  
- After merch sync with new SKU: health tab shows non-zero **New items last scan** and fresh **Last catalog scan**.  
- `pnpm check`, `pnpm typecheck`, `pnpm test`; add `tests/unit/lib/shopify-description-release.test.ts` for `prependReleaseDateToDescription` / `stripClandestineReleaseBlock`.

### 18.11 Doc sync contract

- `docs/system_map/API_CATALOG.md` — `getBandcampScraperHealth` new fields.  
- Optional: `project_state/engineering_map.yaml` if new util file is listed.

---

## 19. Triple-check vs codebase + tests (2026-04-10)

This section records **evidence from the repo and local tooling** after reconciling the handoff to **actual** code. **Live** Shopify Admin API and **Trigger.dev cloud** were **not** invoked from this environment (requires operator credentials and network to production).

### 19.1 Automated checks run (local)

| Command | Result |
|---------|--------|
| `pnpm typecheck` | **Pass** |
| `pnpm vitest run tests/unit/lib/preorder-allocation.test.ts tests/unit/actions/preorders.test.ts` | **Pass** (10 tests) |

**Gap:** There are **no** unit/integration tests that mock `sellingPlanGroupCreate`, `tagsAdd`, or the `preorder-setup` task run body. `tests/unit/actions/preorders.test.ts` only asserts **shape** of preview data — it does **not** call `manualRelease` or Supabase.

### 19.2 Shopify preorder setup — verified code facts

| Handoff / plan claim | Codebase truth (verified) |
|---------------------|---------------------------|
| `preorder-setup` creates selling plan + tags | **Yes.** [`src/trigger/tasks/preorder-setup.ts`](../../src/trigger/tasks/preorder-setup.ts): `sellingPlanGroupCreate` then `tagsAdd(..., ["Pre-Orders","New Releases"])`. |
| Selling plan group ID stored for cleanup | **No.** Return value of `sellingPlanGroupCreate` is **discarded**; no `shopify_selling_plan_group_id` column in **`supabase/migrations`** (grep: no matches). **Plan-only (§16 CRIT-1).** |
| Shopify errors surfaced | **No.** Lines 68–70: **empty `catch`** — no `logger`, no `channel_sync_log`, no review queue. **Matches handoff risk; fix not yet implemented.** |
| `preorder-fulfillment` removes selling plan | **No.** [`preorder-fulfillment.ts`](../../src/trigger/tasks/preorder-fulfillment.ts) only `tagsRemove(Pre-Orders)`. **`sellingPlanGroupDelete` exists** in [`shopify-client.ts`](../../src/lib/clients/shopify-client.ts) but is **unused** in fulfillment. **Ghost-plan risk confirmed.** |
| `manualRelease` targets one variant | **No.** [`src/actions/preorders.ts`](../../src/actions/preorders.ts) L80–82: `tasks.trigger("preorder-fulfillment", {})` — **ignores `variantId`**. **Handoff HIGH-3 still open.** |
| Product GID for Shopify mutations | **Yes.** `productSetCreate` returns `product.id` from GraphQL (GID); stored as `shopify_product_id` — consistent with `tagsAdd` / `sellingPlanGroupCreate` `productIds`. |

### 19.3 Trigger.dev wiring

| Item | Verified |
|------|----------|
| Task id `preorder-setup` | Exported from [`src/trigger/tasks/index.ts`](../../src/trigger/tasks/index.ts). |
| `bandcamp-sync` triggers setup | **Three** call sites in [`bandcamp-sync.ts`](../../src/trigger/tasks/bandcamp-sync.ts) (lines ~308, ~1041, ~1433). |
| Cron `bandcamp-sync-cron` | `*/30 * * * *` in same file — detection cadence as documented. |
| `preorder-fulfillment` schedule | `0 6 * * *` America/New_York — **once daily**, not 2×/day until implemented. |

**Not run:** `npx trigger.dev@latest dev` deploy, dashboard test payload — operator-only.

### 19.4 Operator smoke test (production / staging)

When credentials are available, execute in order:

1. **Trigger** `preorder-setup` with a real `variant_id` / `workspace_id` where `warehouse_products.shopify_product_id` is set and variant `is_preorder` is false.  
2. **Shopify Admin:** product shows **Pre-Orders** + **New Releases** tags and an attached **selling plan group** (pre-order).  
3. **Trigger** `preorder-fulfillment` (or wait for cron) after setting `street_date` ≤ today and `is_preorder` true.  
4. **Shopify Admin:** **Pre-Orders** tag removed; **manually verify** whether selling plan still exists (expected **yes** until CRIT-1 ships).  
5. **DB:** variant `is_preorder` false; orders allocation per existing FIFO tests.

### 19.5 Handoff §18 (`shopify-description-release.ts`)

File **does not exist in repo yet** — only specified in this handoff. **No** automated test until implemented.

### 19.6 Assumption corrections

- **“Plan implemented”** for CRIT-1, HIGH-1, HIGH-3, `deriveStreetDateAndPreorder`, `updateLocalTags`: **False** — these remain **spec**; code matches **§19.2** above.  
- **Preorder Shopify feature “works”** in the sense the **happy path code path exists** and GraphQL helpers are present; **observability, cleanup, and manual release scope** still match **documented gaps**.

---

## 20. Bulletproof preorder setup — test reality, Shopify API research, alternatives

**Purpose:** Satisfy “run tests + research before we build” for **preorder Shopify setup**. This section is **pre-implementation**: it defines what is **proven today** vs what **must** be added.

### 20.1 What automated tests prove today

| Scope | Result |
|-------|--------|
| **Full Vitest** (`pnpm test`, 2026-04-10) | **677 tests passed** / 73 files — **none** invoke `preorder-setup`, mock `sellingPlanGroupCreate`/`tagsAdd`, or assert Shopify GraphQL payloads. |
| **Preorder-adjacent** | [`preorder-allocation.test.ts`](../../tests/unit/lib/preorder-allocation.test.ts) — **FIFO math only**. [`preorders.test.ts`](../../tests/unit/actions/preorders.test.ts) — **structural** expectations only; **no** `manualRelease` / Trigger mock. |

**Conclusion:** Tests **do not** demonstrate that preorder setup “works” against Shopify. They only prove **allocation** and **type shapes** in isolation.

### 20.2 Shopify Admin API — research summary (official docs)

- **`sellingPlanGroupCreate`** ([Shopify GraphQL Admin](https://shopify.dev/docs/api/admin-graphql/latest/mutations/sellingplangroupcreate)): creates a **purchase option** group (pre-order, subscription, TBYB, etc.). Requires appropriate **access scopes** (docs reference `write_products` plus purchase-options / subscription-related scopes — **verify** against your Custom App in Partner Dashboard).  
- **No idempotency key:** Re-running the mutation can create **duplicate** selling plan groups unless the app **queries first** (`sellingPlanGroups` with `query` / `category:PRE_ORDER`) or **stores** returned `sellingPlanGroup.id` and skips create when still attached.  
- **App ownership:** `sellingPlanGroups` query returns groups for **the app making the call** — important for cleanup and deduplication.  
- **Uninstall caveat:** Selling plan groups created by an app may be **removed after app uninstall** (48h noted in object docs) — operational backup if you rely solely on Shopify-native preorder objects.

### 20.3 Why current code is not “bulletproof”

1. **Silent failure** — empty `catch` in `preorder-setup` (§19.2).  
2. **Duplicate groups** — retries / double triggers can stack groups per product (no pre-check, ID not stored).  
3. **Ghost checkout** — tags removed on release but **selling plan not deleted** (§19.2).  
4. **Partial success** — if `sellingPlanGroupCreate` succeeds and `tagsAdd` fails (or vice versa), no compensating transaction across Shopify + DB.  
5. **DB vs Shopify drift** — `is_preorder` true in Postgres while Shopify has no plan/tags.

### 20.4 “Bulletproof” pattern options (choose + document)

| Approach | Pros | Cons |
|----------|------|------|
| **A. Harden current model** (recommended baseline) | Native preorder UX in Shopify; matches existing build. | Must implement: **store group ID**, **query-or-create**, **delete on release**, **logging/review queue**, **tags + DB sync**, **idempotent delete**. |
| **B. Tags + inventory policy only** | Simpler; no selling plan API. | **Loses** Shopify preorder purchase-option UX; relies on theme + “continue selling when OOS” / manual flows. |
| **C. Metafield `release_date` + theme/Liquid** | Clear storefront messaging; fewer Admin preorder mutations. | Theme work; does not replace purchase-option preorder **unless** theme implements it. |
| **D. Hybrid** | Selling plan for checkout behavior + metafield for display + tags for collections. | More moving parts; strongest UX if maintained. |

**Recommendation for Clandestine:** **A + elements of D** (tags for collections already used): keep `sellingPlanGroupCreate`, add **dedupe**, **persistence**, **cleanup**, **observability**, and optional **metafield** for release date (aligns with §18).

### 20.5 Required tests **before** calling the plan “verified”

**Unit (Vitest, mocked `fetch` / `shopifyGraphQL`):**

1. **`preorder-setup`**: success path persists `shopify_selling_plan_group_id` (after migration); calls `tagsAdd` with expected product GID.  
2. **Failure path**: Shopify `userErrors` → `channel_sync_log` + review row; DB `is_preorder` policy per product decision.  
3. **Dedupe**: when DB already has `shopify_selling_plan_group_id`, **skip** `sellingPlanGroupCreate` (or verify existing group still applies to product).  
4. **`releaseVariant`**: `sellingPlanGroupDelete` then `tagsRemove`; second delete **no-ops** on GraphQL error.  
5. **`deriveStreetDateAndPreorder`** (when landed): matrix of mapping/API/scraper inputs.

**Integration (staging — operator):**

1. One product: trigger `preorder-setup` → Admin UI shows **one** preorder group + tags.  
2. Double-trigger same variant → still **one** group (or acceptable idempotent behavior).  
3. Release path → group **gone**, tag **gone**, variant `is_preorder` false.  
4. Scope check: API token has **`write_purchase_options`** (or current required scope name for your API version).

### 20.6 Prerequisite checklist (before implementation PR)

- [ ] Confirm Shopify Custom App **scopes** include purchase-options / preorder mutations for your `SHOPIFY_API_VERSION`.  
- [ ] Add migration `shopify_selling_plan_group_id` + implement **CRIT-1** + **HIGH-1**.  
- [ ] Add **Vitest** coverage for §20.5 items (minimum: setup + release mocks).  
- [ ] Run §19.4 **smoke** on staging.  
- [ ] Document chosen approach **A/B/C/D** in `TRIGGER_TASK_CATALOG.md`.

---

## 21. Operator model: tags-only pre-order collections (vs selling plans)

**Canonical product decision (locked):** Clandestine **does not use Shopify selling plans** for this workflow. Success = **(1)** Bandcamp detects new/changed merch, **(2)** a **Shopify product** exists for the SKU, **(3)** the product carries the **`Pre-Orders`** tag when it is a pre-release listing. Stock and customer-facing ship timing stay on **Bandcamp + copy/theme** as today. **Checkout = normal product checkout.**

**Code gap vs decision:** [`preorder-setup.ts`](../../src/trigger/tasks/preorder-setup.ts) still calls **`sellingPlanGroupCreate`** today — that is **legacy / unused for ops**. Implementation should **remove** that call (or hard-disable behind env) and keep only **`tagsAdd`** if a path still needs tags after create; otherwise rely on **`productSetCreate` tags** + **`tag-cleanup-backfill`** / fulfillment tag removal.

### 21.1 Does the current system do “detection + Shopify product + tag”?

**New Bandcamp line (new SKU)** — in [`bandcamp-sync.ts`](../../src/trigger/tasks/bandcamp-sync.ts):

- Calls **`productSetCreate`** with `tags: ["Pre-Orders", "New Releases"]` when `merchItem.new_date` parses as **after** `new Date()` (see ~L1186–1189, L1259–1264).  
- Inserts warehouse product/variant and can trigger **`preorder-setup`** when those tags apply (~L1432+).

**So for brand-new merch with a correct future `new_date`:** **Yes** — you get a **Shopify draft product** and the **Pre-Orders** tag on create (plus **New Releases**).

**Caveats (still true):**

- **Existing SKU / matched path** and **scraper path** can **miss** `street_date` / preorder flag (handoff §16.4) — then **tags may not be applied** on create, and **`preorder-setup`** may not run when it should.  
- **`preorder-setup` does not only add tags** — it also runs **`sellingPlanGroupCreate`** (see below).

### 21.2 What is the “checkout difference” for selling plans?

A **`sellingPlanGroupCreate`** with **`category: PRE_ORDER`** attaches Shopify **purchase options** (selling plans) to the product. Many themes then show a **pre-order selector** or route the line item through **pre-order–specific checkout behavior** (policies for billing/fulfillment, etc.) — **not** identical to a plain one-time purchase.

**Tags alone** do **not** change Shopify’s checkout engine; they only drive **collections, automation, and your internal logic**. **Inventory + standard variant** = **normal add-to-cart / checkout**, assuming the variant is published, priced, and in stock per Shopify rules.

### 21.3 Implication for “bulletproof” scope (simplified)

- **In scope:** **Bandcamp detection** (`bandcamp-sync-cron` + merch API + scraper enrichment), **Shopify product create/sync** for new SKUs, **`Pre-Orders`** (and **`New Releases`** if you keep current convention) on the product, **tag removal** when no longer pre-release (`preorder-fulfillment` / `tag-cleanup-backfill`).  
- **Out of scope / remove:** **`sellingPlanGroupCreate`**, **`sellingPlanGroupDelete`**, DB column **`shopify_selling_plan_group_id`** (do not add unless you revert this decision).  
- **Still worth hardening:** **Silent Shopify errors** on tag writes (log + optional review row), **detection date bugs** (§16.4) so tags apply on **matched-SKU** paths too — that’s what makes “simple” actually reliable.

---

*Handoff generated from repository state. Re-copy affected files after local edits; line numbers may drift.*
