# TRUTH_LAYER

Project: `clandestine-fulfillment`
Root: `/Users/Shared/WorkShared/Project/clandestine-fulfillment`

## Purpose

This is the canonical source of architecture truth for planning, building, and auditing.
If this file conflicts with ad-hoc notes, this file and linked truth docs win.

## Required Read-First Set (Hard Block)

Before producing PLAN, BUILD, or AUDIT output, read:

1. `TRUTH_LAYER.md`
2. `docs/system_map/INDEX.md`
3. `docs/system_map/API_CATALOG.md`
4. `docs/system_map/TRIGGER_TASK_CATALOG.md`
5. `project_state/engineering_map.yaml`
6. `project_state/journeys.yaml`
7. `docs/RELEASE_GATE_CRITERIA.md`
8. `docs/RUNBOOK.md`

If any required file is missing or stale for the requested scope, return `BLOCKED` and list what must be updated.

## Core System Invariants

- UI data access uses `useAppQuery` / `useAppMutation` with `query-tiers`.
- Server-side auth context comes from `requireAuth()` and validated role checks.
- Org/workspace sensitive writes are protected by RLS or service-role actions with explicit authorization checks.
- Trigger.dev handles background and asynchronous workflows; debugging must include related tasks.
- Webhook handlers must preserve idempotency and bounded retries.
- Release confidence is enforced by `release-gate` checks and full-site audit criteria.
- Bundle inventory uses component-level tracking via `bundle_components` table. When a bundle sells (any channel), `bundle-component-fanout` decrements each component SKU. Inventory pushes compute MIN(bundle_stock, floor(component_stock/qty)) for effective availability. `bundles_enabled` flag is advisory; `bundle_components` row existence is the source of truth.
- Bandcamp follows an **authority lifecycle**: Bandcamp API is authoritative for **initial ingest** (new titles, SKU/quantity/date/price bootstrap). After staff review or physical count, the warehouse app becomes authoritative for **operational fields** (SKU, quantity, price, dates). Bandcamp remains authoritative for **descriptive/external fields** (URL, subdomain, album_title, options, sales data) permanently. Governed by `authority_status` on `bandcamp_product_mappings` (`bandcamp_initial` → `warehouse_reviewed` → `warehouse_locked`). HTML scraping (`data-tralbum`) is **enrichment only** (about, credits, tracks, package photos). Automation is **bounded** (caps, DLQ to `warehouse_review_queue`, no unbounded retry).
- **Bandcamp orders → shipping margin:** `bandcamp-order-sync` writes `warehouse_orders.shipping_cost` and per-line `shipping` inside `line_items` JSON; admin shipment reads merge `customer_shipping_charged` from the order (column or inferred from `line_items`), and **on staff shipment detail** may call Bandcamp `get_orders` once to hydrate missing shipping paid when `bandcamp_payment_id` is linked, then persist—so fulfillment difference vs label cost is computable.
- **Shopify image sync invariants:**
  - `productSetCreate` MUST use `files: [FileSetInput!]` (NOT `media`) when attaching images during product creation. Shopify's `ProductSetInput` (2024-10+, including 2026-01) silently ignores the `media` field — passing it causes products to be created without images.
  - `storeScrapedImages` in `bandcamp-sync` calls `productCreateMedia` for newly-inserted Bandcamp/scraped image rows. This is the correct API for adding images after creation.
  - `upsertImagesBulk` in `shopify-sync` populates `warehouse_product_images` table during Shopify → DB delta sync. Images from Shopify are stored with `shopify_image_id` (numeric part of GID) for deduplication.
  - The `warehouse_products.images` JSONB column is a denormalised cache of the primary image URL only (for legacy compatibility). The `warehouse_product_images` table is the authoritative multi-image store.
  - The `shopify-image-backfill` task (`src/trigger/tasks/shopify-image-backfill.ts`) is a manual-trigger-only task that fixes two historical data gaps: (1) backfills `warehouse_product_images` rows from `images` JSONB for products synced before the table was properly hydrated, (2) pushes `bandcamp_art_url` via `productCreateMedia` for products with no images anywhere (`images = '[]'`).

- **Shipping log list/detail parity invariant:** `getShipments` and `getShipmentDetail` MUST use the same fulfillment cost model (postage + materials + pick/pack), computed via `src/lib/server/shipment-fulfillment-cost.ts`. The list enriches each row with `fulfillment_total` and `fulfillment_partial`; the detail returns `costBreakdown.total` and `costBreakdown.partial`. All variant and format-cost queries MUST scope by `workspace_id`. No direct SQL to `warehouse_product_variants` or `warehouse_format_costs` for cost computation outside this module. The admin Shipping Log cost column and profitability dot show the fulfillment total (not postage-only). The dot is amber when `partial=true`; green/red when customer shipping is known and costs are complete.
- **Format resolution fallback chain:** When `warehouse_product_variants.format_name` is NULL, `batchBuildFormatCostMaps` falls back to `warehouse_products.product_type` via FK join (zero extra query). `product_type` is normalized through `PRODUCT_TYPE_ALIASES` (e.g. `"12\" Vinyl"` → `"LP"`) before lookup. If both are NULL or the normalized value has no cost row, the SKU is added to `unknownSkus` and `partial: true` is returned (amber dot). Migration `20260415000001_backfill_variant_format_names.sql` backfilled existing null rows: Tier 1 = SKU prefix patterns; Tier 2 = product_type alias map. Post-migration result: 418 genuinely ambiguous variants remain NULL (correctly → amber). `T-Shirt` and `Other` format rows are missing from `warehouse_format_costs` and need to be added in admin for those 4 variants to show green/red.

## Preflight Commands

Run these before substantive planning/building:

```bash
pnpm check
pnpm typecheck
pnpm release:gate
pnpm test:e2e:full-audit
```

For production parity/ops checks, also use:

- `scripts/sql/prod_parity_checks.sql`
- `scripts/sql/webhook_health_snapshot.sql`

## Doc Sync Contract (Mandatory)

Any session that changes behavior must update truth docs in the same session.

- Architecture or ownership changed -> update `TRUTH_LAYER.md` and `project_state/engineering_map.yaml`
- User/system flow changed -> update `project_state/journeys.yaml`
- API route/action boundary changed -> update `docs/system_map/API_CATALOG.md`
- Trigger task/event/cron wiring changed -> update `docs/system_map/TRIGGER_TASK_CATALOG.md`
- Release or verification rules changed -> update `docs/RELEASE_GATE_CRITERIA.md`

Session completion must include:

1. Code changes summary
2. Truth docs updated list
3. Journey updates list
4. API/Trigger catalog updates list

## Ownership

- Architecture truth: engineering lead + primary maintainer
- API catalog: backend/app-router owners
- Trigger catalog: integrations/ops owners
- Journeys: product + engineering
