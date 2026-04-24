/**
 * Phase 4c (finish-line plan v4) — Role matrix.
 *
 * `ROLE_MATRIX` is the single source of truth for staff/client role lists
 * per Rule #40 ("Define a single ROLE_MATRIX constant in code"). Existing
 * call sites continue to import `STAFF_ROLES` / `CLIENT_ROLES` directly —
 * those are now aliases for the matrix subsets to preserve back-compat
 * during the codemod cycle. New call sites should reach for `ROLE_MATRIX`
 * to avoid splitting the truth surface.
 */
export const ROLE_MATRIX = {
  staff: ["admin", "super_admin", "label_staff", "label_management", "warehouse_manager"],
  client: ["client", "client_admin"],
} as const;

export const STAFF_ROLES = ROLE_MATRIX.staff;
export type StaffRole = (typeof ROLE_MATRIX.staff)[number];

export const CLIENT_ROLES = ROLE_MATRIX.client;
export type ClientRole = (typeof ROLE_MATRIX.client)[number];

export type UserRole = StaffRole | ClientRole;

/**
 * Phase 1 Pass 2 §9.2 D4 Step A — Shopify Admin GraphQL/REST API version
 * for ALL **per-client** Custom-distribution app surfaces (OAuth callback,
 * `connectionShopifyGraphQL`, store-sync REST client, mark-platform-fulfilled,
 * mark-mailorder-fulfilled, audit task, store-connections action).
 *
 * Pinned to **2026-04** because Pass 2 introduces `inventorySetQuantities`
 * with `changeFromQuantity` + the `@idempotent(key:)` directive, both of
 * which are 2026-04+ surface. Calling them at the prior pinning (`2026-01`)
 * would surface as `Field 'changeFromQuantity' doesn't exist on type
 * 'InventorySetQuantitiesInput'` and the directive would be silently
 * ignored — failing closed at the schema is the wrong behavior for a CAS
 * primitive that the entire reconcile path depends on.
 *
 * **The ban is structural, not stylistic.** A CI guard
 * (`scripts/check-shopify-api-version.sh`) greps every `*.ts` and `*.tsx`
 * file under `src/` and `tests/` for the literal `2026-01` (and any other
 * version literal that is NOT this constant). The only legal carve-out is
 * the env-singleton path used by the main Clandestine Shopify store
 * (`SHOPIFY_API_VERSION` env var, consumed by `src/lib/clients/shopify.ts`,
 * `src/lib/clients/shopify-client.ts`, `src/trigger/tasks/inbound-product-create.ts`,
 * and `src/app/api/oauth/shopify/route.ts` for webhook-subscription
 * registration), which is bumped via env (Vercel + `.env.local`) so the
 * operator controls the runtime without a code roll.
 *
 * **NOT** a Shopify Storefront API version (those are independent and
 * pinned separately if/when we adopt Storefront API surfaces).
 */
export const SHOPIFY_CLIENT_API_VERSION = "2026-04";

// Phase 3 Pass 2 — per-connection cutover gate constants.
//
// These previously lived in `src/actions/connection-cutover.ts` but Next.js
// 14 forbids non-async exports from `"use server"` files (the build fails
// with `Only async functions are allowed to be exported in a "use server"
// file`). Moved here per Rule #58 (single owner per concern); the action
// file and the test now both import from this module.
//
// MIN_SAMPLE_COUNT_FOR_CUTOVER: minimum number of resolved
// (`observed_at IS NOT NULL`) shadow comparisons in the last 7 days before
// `runConnectionCutover` will accept a match-rate gate. Below this, the
// operator sees `eligible: false` with `gate_reason: 'insufficient_samples'`
// even if the match-rate is 100%.
export const MIN_SAMPLE_COUNT_FOR_CUTOVER = 50;

// REQUIRED_MATCH_RATE: required match rate over the rolling 7-day window.
// 0.995 = 1 drift event per 200 comparisons. Plan §9.4 D2 calibrates this
// against historical SS Inventory Sync mirror jitter (peak 0.4% drift
// events at sustained load).
export const REQUIRED_MATCH_RATE = 0.995;

// POLICY_HEALTH_DRIFT_SAMPLE_LIMIT: cap on `driftSkusSampled` returned by
// `getConnectionPolicyHealth` — operator badge tooltip, not a report.
// Previously lived in `src/actions/shopify-policy.ts`; same Next.js 14
// `"use server"` non-async-export rule forced the relocation.
export const POLICY_HEALTH_DRIFT_SAMPLE_LIMIT = 5;

// Phase 5 §9.6 D2 — Safety Stock workspace constants. Moved here from
// src/actions/safety-stock.ts because Next.js 14 forbids non-async
// exports from `"use server"` files (see commit f72f752 — same fix
// applied earlier to MIN_SAMPLE_COUNT_FOR_CUTOVER and friends).

/** Known internal safety-stock channels. The `effective-sellable` push
 *  helper enforces this set at read time; this list mirrors it so the
 *  UI picker stays in sync without a second source of truth. New
 *  channels added here MUST also be wired into `effective-sellable.ts`
 *  and the §9.6 push helpers. */
export const INTERNAL_SAFETY_STOCK_CHANNELS = ["bandcamp", "clandestine_shopify"] as const;
export type InternalSafetyStockChannel = (typeof INTERNAL_SAFETY_STOCK_CHANNELS)[number];

/** Cap on the number of edits a single bulk-update or CSV-commit can
 *  apply. Mirrors Rule #41 (Server Actions stay bounded; >200 edits
 *  should be split client-side or fired as a Trigger task). 200 SKUs
 *  * (1 update + 1 audit insert) ≈ 400 PostgREST round trips ≈ <30s
 *  comfortably. */
export const SAFETY_STOCK_MAX_BULK_EDITS = 200;

/** Smallint column upper bound enforced by Postgres on both source
 *  tables (client_store_sku_mappings.safety_stock,
 *  warehouse_safety_stock_per_channel.safety_stock). Keeping the
 *  app-layer guard tight surfaces typos like "10000000" before they
 *  hit the DB and trigger a confusing 22003 numeric_value_out_of_range
 *  error. */
export const SAFETY_STOCK_MAX_VALUE = 32_767;

/** Reason field length cap on safety_stock edits. Matches the `text`
 *  column comment-level intent — the DB itself does not enforce this
 *  so future longer notes don't require a migration cycle. */
export const SAFETY_STOCK_REASON_MAX_LENGTH = 500;
