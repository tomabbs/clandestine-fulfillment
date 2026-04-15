# Shipping log hardening — final implementation plan

**Status:** Ready for implementation (pending approval)  
**Related:** Cursor plan `pirate_ship_shipping_hardening_74e8834d.plan.md` (iterative reviews 1–3 consolidated here)

---

# Feature

Unify **customer shipping paid** vs **fulfillment economics** across **ShipStation**, **EasyPost**, and **Pirate Ship** so the **admin Shipping Log list** and **expanded shipment detail** use the **same definitions** (no contradictory profitability signals). Includes: shared fulfillment cost engine, optional/upgraded customer-shipping reconciliation, list UI + summary/CSV alignment, tests and guardrails.

---

# Goal

- **Truth model:** Fix contradictory economic definitions between list and detail (not a table-only patch).
- **Single source of math:** `computeFulfillmentCostBreakdown` (or equivalent name) used by **`getShipmentDetail`** and **`getShipments`** (after batch enrich).
- **Operator trust:** Dot/column semantics match **Fulfillment difference**; unknown/partial states are explicit.
- **Upstream data:** `resolveCustomerShippingPaid` is the **only** module encoding **known / unknown / zero** for customer shipping paid (detail hydrate, Pirate Ship import, future crons).

---

# Context

- Today the list **Cost** column and dot use **postage** (`shipping_cost`) and **customer − postage**; detail uses **postage + materials + pick/pack** vs customer charged (**[`src/app/admin/shipping/page.tsx`](../../src/app/admin/shipping/page.tsx)**, **[`src/actions/shipping.ts`](../../src/actions/shipping.ts)**).
- **[`getShipments`](../../src/actions/shipping.ts)** embeds `warehouse_shipment_items(id, quantity)` — **no `sku`**, so the list cannot compute format costs.
- **[`getShipmentDetail`](../../src/actions/shipping.ts)** loads items, resolves variants by **`.in("sku", skus)`** and format costs by **`format_name`** — **does not currently filter `warehouse_product_variants` / `warehouse_format_costs` by `workspace_id`**; schema has **`UNIQUE(workspace_id, sku)`** on variants and **`UNIQUE(workspace_id, format_name)`** on format costs — **implementation must add `workspace_id` scoping** to avoid wrong costs if SKU/format strings collide across workspaces.
- Recent work: Bandcamp hydrate on detail ([`fetchBandcampShippingPaidForPayment`](../../src/lib/server/bandcamp-shipping-paid.ts)), `bandcamp-order-sync` shipping fields, item-count fallback — **do not** fix list/detail economic parity.

---

# Requirements

## Functional

- Shared **`computeFulfillmentCostBreakdown`** (name TBD) matching **all** branches of current detail logic (missing variant, missing format cost, zero qty, fallbacks to 0) plus explicit **`partial`**, **`unknownSkus`**, **`missingFormatCosts`** (or equivalent contract).
- **[`getShipments`](../../src/actions/shipping.ts):** embed **`warehouse_shipment_items(id, sku, quantity)`**; after fetch, **chunked** batched lookups (see Non-functional) + **per-`workspace_id`** variant and format-cost queries; attach **`fulfillment_total`**, **`fulfillment_margin`**, **`partial`** (and/or expose margin only when safe).
- **[`getShipmentDetail`](../../src/actions/shipping.ts):** use the same helper for breakdown totals.
- **UI:** Cost column shows fulfillment total; dot = margin only when **customer charge known** and **not partial** (or dedicated partial affordance); align tooltip/sign with detail.
- **Centralize** customer shipping resolution in **`resolveCustomerShippingPaid`**; refactor detail hydrate + **[`pirate-ship-import`](../../src/trigger/tasks/pirate-ship-import.ts)** to call it; **idempotent** (safe on Trigger retries).
- **Bandcamp cap** on import: dedupe payment IDs; **actionable** overflow (review queue + import summary / follow-up task), not log-only; optional **pending state** or cron backlog (see Deferred).
- **Summary/CSV:** Rename vs silent change — **Avg postage** vs **Avg fulfillment**; extend CSV columns as agreed.

## Non-functional

- **Page size:** Already **`max(250)`** in Zod ([`getShipmentsSchema`](../../src/actions/shipping.ts) line 33); enforce in batching paths; log when SKU count very high.
- **PostgREST / URL limits:** Chunk **`.in('sku', …)`** (and format_name batches) into slices (~200–300 IDs) with `Promise.all` over chunks — **verified risk** for large distinct-SKU sets on one page.
- **Money math:** Today uses JS `number` and `numeric` from DB — **final review recommends integer cents or decimal library**; repo has **no** `currency.js` / `dinero` in **`package.json`** today — **decision:** either round to cents at boundaries for display + tests or add a small dep (deferred if team prefers minimal diff).
- **Instrumentation:** Counters/logs for resolution path and partial rows (optional but recommended).

---

# Constraints

## Technical

- **Patches, not rewrites** — one concern per PR where possible.
- **Workspace scoping** — all variant and format-cost reads **`eq('workspace_id', …)`** from shipment (or order) context (**codebase gap** in current detail path — fix as part of helper).
- **Trigger:** [`pirate-ship-import`](../../src/trigger/tasks/pirate-ship-import.ts) — reconciliation + cap; [`bandcamp-order-sync`](../../src/trigger/tasks/bandcamp-order-sync.ts) unchanged except if shared helper imported for consistency tests only.

## Product

- Do not **silently** redefine “Avg cost” on cards — rename/add labels.
- Address mismatch stays **soft**; **low severity** until false-positive rate known.

## External (Supabase, APIs, etc.)

- **Bandcamp `get_orders`** — rate/cap; **`member_band_id`** gaps deferred.
- Migrations (if Phase C): **`supabase db push --yes`** from repo root per project rules; idempotent policies if remote partial.

---

# Affected files (expected)

| Area | Files |
|------|--------|
| New | `src/lib/server/shipment-fulfillment-cost.ts` (or similar), optionally `src/lib/server/resolve-customer-shipping.ts` |
| Actions | [`src/actions/shipping.ts`](../../src/actions/shipping.ts) (`getShipments`, `getShipmentDetail`, `exportShipmentsCsv`, `getShipmentsSummary`) |
| UI | [`src/app/admin/shipping/page.tsx`](../../src/app/admin/shipping/page.tsx) |
| Trigger | [`src/trigger/tasks/pirate-ship-import.ts`](../../src/trigger/tasks/pirate-ship-import.ts) |
| Lib | [`src/lib/server/bandcamp-shipping-paid.ts`](../../src/lib/server/bandcamp-shipping-paid.ts) (refactor consumers to `resolveCustomerShippingPaid` or re-export) |
| Tests | `tests/unit/actions/shipping.test.ts`, new unit tests for helper, optional integration |
| Docs | `TRUTH_LAYER.md`, `project_state/journeys.yaml`, `project_state/engineering_map.yaml`, `docs/system_map/API_CATALOG.md`, `docs/system_map/TRIGGER_TASK_CATALOG.md`, `docs/RELEASE_GATE_CRITERIA.md` if verification policy changes |

---

# Proposed implementation

1. **Add `computeFulfillmentCostBreakdown`** with typed result (`partial`, arrays); **port all** logic from [`getShipmentDetail`](../../src/actions/shipping.ts); add **`workspace_id`** filters on variant + `warehouse_format_costs` queries.
2. **Refactor `getShipmentDetail`** to use helper; remove duplicate loops.
3. **Extend `getShipments` select** with `sku` on line items; collect distinct SKUs **per workspace** (shipments on a page can span orgs — group by `workspace_id` before batch queries).
4. **Chunk** `.in()` queries; aggregate per shipment; attach enriched fields on returned rows.
5. **Implement `resolveCustomerShippingPaid`**; move hydrate from detail into it; call from **`pirate-ship-import`** with dedupe + cap + actionable overflow.
6. **Update admin table** — cost, dot, tooltips, partial UX; optional union types for dot state.
7. **Summary + CSV** — labels and columns.
8. **Tests** — unit helper; contract list vs detail; cross-source fixtures where possible; idempotency test for resolver.
9. **Doc sync** — per repo contract below.

---

# Assumptions

- Staff-only Shipping Log; **`requireStaff`** on detail remains.
- **Single workspace per shipment** for line items — true in schema; batching groups by `shipment.workspace_id`.
- **Review queue** table **`warehouse_review_queue`** exists and is appropriate for cap overflow ([`src/actions/review-queue.ts`](../../src/actions/review-queue.ts)).
- PostgREST/Supabase JS may batch large `.in()` — **chunking is defense in depth**.

---

# Risks

| Risk | Mitigation |
|------|------------|
| List query slower | Chunk SKUs; cap page size; Phase C optional snapshot if needed |
| Review queue flood if cap too low | Actionable import summary + deferred cron row; tune cap |
| Floating-point drift | Round to cents at boundaries or add decimal lib (see Open questions) |
| Phase C retroactive margin change | Reviewer note: snapshots **freeze** history when format costs change — **defer** Phase C vs **prioritize** for finance immutability (see Rejected / Deferred) |
| Trigger retry double-writes | Idempotent `resolveCustomerShippingPaid` |

---

# Validation plan

```bash
pnpm check
pnpm typecheck
pnpm test
pnpm build
```

- Targeted: shipping unit tests + new helper tests + contract test.
- **`pnpm release:gate`** per [`docs/RELEASE_GATE_CRITERIA.md`](../RELEASE_GATE_CRITERIA.md).
- Schema: **`supabase migration list --linked`** after any migration.
- Manual: one SS, one EP, one PS row — list margin sign matches detail.

---

# Rollback plan

- **Code-only phases (A/B/UI):** Revert PR(s); no migration dependency.
- **If migration added (Phase C):** Down migration drops new columns **or** leave columns unused after revert (prefer down migration in same PR for clean rollback).
- **Feature flag (optional):** Env or flag to show old “postage-only” column — only if team wants instant kill-switch.

---

# Rejected alternatives

- **Patch only `page.tsx`** — rejected; drift returns without shared engine.
- **Log-only on Bandcamp cap** — rejected; must be actionable.
- **Making Phase C mandatory in v1** — **deferred** by default to ship A+B faster; **rejected as forced v1** unless product mandates immutable margin history immediately — then schedule C + backfill in same release train.

---

# Open questions

1. **Integer cents vs decimal library** — add dependency vs round at UI?
2. **Phase C timing** — ship after A+B stable, or parallel if finance requires frozen historical margin?
3. **Pending reconciliation column vs cron-only** — if cap hit often, add `customer_shipping_reconcile_status` or similar?
4. **`member_band_id`** for Bandcamp — when to prioritize?

---

# Deferred items

- **`member_band_id`** / multi-band `get_orders` expansion.
- **Full `normalizeAddressForCompare`** library — start conservative.
- **Phase C** persisted `fulfillment_cost_total` / margin on `warehouse_shipments` + backfill — **product call** (perf vs immutable history).
- **Optional:** `currency.js` / `dinero` if float issues appear in production metrics.

---

# Revision history

| Date | Change |
|------|--------|
| 2026-04-13 | Final template: codebase verification (workspace_id on variants/format costs, pageSize max 250, no currency lib in package.json), reviews 1–3 + final review (chunking, cents, cap backlog, Phase C tradeoff, UI union types) |

---

## Scope summary

Implement shared fulfillment cost computation + workspace-safe queries; align Shipping Log list with detail; centralize customer shipping resolution and harden Pirate Ship import; update docs and tests.

---

## Evidence sources (exact files read)

- [`TRUTH_LAYER.md`](../../TRUTH_LAYER.md)
- [`docs/system_map/INDEX.md`](../system_map/INDEX.md)
- [`docs/system_map/API_CATALOG.md`](../system_map/API_CATALOG.md) (shipping section)
- [`docs/system_map/TRIGGER_TASK_CATALOG.md`](../system_map/TRIGGER_TASK_CATALOG.md) (`pirate-ship-import`, `bandcamp-order-sync`)
- [`docs/RELEASE_GATE_CRITERIA.md`](../RELEASE_GATE_CRITERIA.md)
- [`src/actions/shipping.ts`](../../src/actions/shipping.ts) (`getShipmentsSchema`, `getShipments`, `getShipmentDetail` cost block)
- [`supabase/migrations/20260316000002_products.sql`](../../supabase/migrations/20260316000002_products.sql) — `warehouse_product_variants` `UNIQUE(workspace_id, sku)`
- [`supabase/migrations/20260316000005_supporting.sql`](../../supabase/migrations/20260316000005_supporting.sql) — `warehouse_format_costs` `UNIQUE(workspace_id, format_name)`
- [`package.json`](../../package.json) — no dedicated currency library
- [`src/actions/review-queue.ts`](../../src/actions/review-queue.ts) — `warehouse_review_queue` usage

---

## API boundaries impacted (from API_CATALOG)

- [`getShipments`](../../src/actions/shipping.ts), [`getShipmentDetail`](../../src/actions/shipping.ts), [`getShipmentsSummary`](../../src/actions/shipping.ts), [`exportShipmentsCsv`](../../src/actions/shipping.ts) — update shapes/descriptions in [`docs/system_map/API_CATALOG.md`](../system_map/API_CATALOG.md) after implementation.

---

## Trigger touchpoint check

| Task ID | Role |
|---------|------|
| [`pirate-ship-import`](../../src/trigger/tasks/pirate-ship-import.ts) | Post-insert `resolveCustomerShippingPaid`, cap, dedupe, optional review queue / import errors |
| [`bandcamp-order-sync`](../../src/trigger/tasks/bandcamp-order-sync.ts) | Unchanged behavior; continues populating `warehouse_orders.shipping_cost` |
| Ingress | [`src/actions/pirate-ship.ts`](../../src/actions/pirate-ship.ts) enqueues import |

---

## Doc Sync Contract updates required

- [`TRUTH_LAYER.md`](../../TRUTH_LAYER.md) — shipping margin / list-detail parity invariant
- [`project_state/journeys.yaml`](../../project_state/journeys.yaml) — `pirate_ship_import` checks
- [`project_state/engineering_map.yaml`](../../project_state/engineering_map.yaml) — new modules
- [`docs/system_map/API_CATALOG.md`](../system_map/API_CATALOG.md) — return shapes
- [`docs/system_map/TRIGGER_TASK_CATALOG.md`](../system_map/TRIGGER_TASK_CATALOG.md) — `pirate-ship-import` reconciliation
- [`docs/RELEASE_GATE_CRITERIA.md`](../RELEASE_GATE_CRITERIA.md) — only if gate steps change

---

## Assumption test (codebase verification)

| Assumption | Result |
|------------|--------|
| Page size capped | **Yes** — `getShipmentsSchema` `pageSize.max(250)` |
| SKU batch can be large | **Yes** — chunk `.in()` lists |
| `warehouse_format_costs` is workspace-scoped | **Yes** — `(workspace_id, format_name)` |
| Current detail query scopes by workspace | **No** — variant/format queries lack `workspace_id`; **must add** in helper |
| Currency library present | **No** — plan cents/rounding or add dep |
| Review queue exists | **Yes** — `warehouse_review_queue` |

---

## Risks + rollback notes

See **Risks** and **Rollback plan** sections above.

---

## Verification steps

- `pnpm check`, `pnpm typecheck`, `pnpm test`, `pnpm build`
- `bash scripts/ci-inventory-guard.sh` / webhook guards if touched
- `supabase migration list --linked` when migrations ship
- Contract: list `fulfillment_total` === detail `costBreakdown.total` for same id

---

## Squarespace / unmapped-SKU title fallback (2026-04-14)

### Problem

After the backfill migration resolved 2009 variants (2427 → 418 NULLs), a second audit found ~40 SKUs in `warehouse_shipment_items` that were **completely absent from `warehouse_product_variants`** — not a NULL-format issue, but SKUs that never existed in the catalog:

- **22 Squarespace placeholder IDs** (`SQ6720646`, `SQ4004064`, etc.) — ShipStation used Squarespace line-item IDs as SKUs because Squarespace never sent a real product SKU. These will never match any variant row.
- **12 real products** never synced (resolved by the shopify-full-backfill task that ran separately).
- **6 one-offs** (`UNKNOWN`, `DL-BO-LE12`, etc.) — genuinely unmatchable.

### Solution implemented

Three-tier title-based fallback added to `batchBuildFormatCostMaps` in `src/lib/server/shipment-fulfillment-cost.ts`. Runs only for SKUs absent from `warehouse_product_variants` and only when the caller provides an `itemTitleMap`.

**Tier 1 — Keyword extraction** (`extractFormatFromTitle`): Scans the item's `product_title` / `variant_title` for format keywords (LP, CD, Cassette, 7", T-Shirt etc.) using ordered regex patterns. Resolves ~10 of the 22 Squarespace items.

**Tier 2 — Fuzzy product title match**: For items where keyword extraction returns null, fetches all `warehouse_products` titles for the workspace (single query, cached for the batch) and scores each against the item title using Jaccard word-overlap with a containment check. Minimum threshold 0.6 with ≥10 char overlap guard. Resolves title-named items like "Joy Guidry - AMEN" → LP.

**Tier 3 — Unknown (amber dot)**: Items where both passes fail remain in `unknownSkus` → `partial=true` → amber dot. Correct behaviour; no silent $0 costs.

### Files changed

| File | Change |
|------|--------|
| `src/lib/server/shipment-fulfillment-cost.ts` | Added `TITLE_FORMAT_KEYWORDS`, `extractFormatFromTitle` (exported), `normalizeTitleForMatching`, `titleSimilarity`; extended `batchBuildFormatCostMaps` with optional `itemTitleMap` param + two-pass fallback; extended `ItemInput` with `product_title?`, `variant_title?`; `computeFulfillmentCostBreakdown` builds title map automatically from `ItemInput` fields |
| `src/actions/shipping.ts` | `getShipments`: adds `product_title, variant_title` to `warehouse_shipment_items` select; builds and passes `itemTitleMap` to `batchBuildFormatCostMaps`. `getShipmentDetail`: passes `product_title`/`variant_title` through `itemInputs`. `exportShipmentsCsv`: same select + title map changes as `getShipments` |
| `tests/unit/lib/server/shipment-fulfillment-cost.test.ts` | Added 13 new tests: `extractFormatFromTitle` (8 cases covering all format types, edge cases, null), `batchBuildFormatCostMaps — title-based fallback` (5 cases: keyword pass, fuzzy pass, no-title → unknown, backward compat without map, keyword-over-fuzzy priority) |

### Test results

56 tests passing (28 pre-existing + 13 new title-fallback + 15 shipping action tests). `pnpm typecheck` clean.

### Known limitations

- **Genuinely ambiguous SQ* items** (`UNKNOWN`, `DL-BO-LE12`, items with non-descriptive titles like "Merch Order") remain amber. No format information is recoverable — this is correct behaviour.
- **Fuzzy match performance**: Fetches all workspace products once per workspace per request batch. With ~1000 products and 50 shipments this is one extra query. Acceptable; can be cached in Redis if needed.
- **False-positive fuzzy risk**: Threshold 0.6 + 10-char minimum prevents short titles like "LP" from matching unrelated products. Real-world testing may reveal edge cases — adjusting the threshold is a one-line change in `titleSimilarity`.

### Follow-up

- The `shopify-full-backfill` task (triggered in the same session) will resolve the 12 "real products never synced" bucket once it completes.
- Remaining unfixable SQ* items will always show amber dot — document this in operator runbooks so staff know the signal is expected for legacy Squarespace orders.
