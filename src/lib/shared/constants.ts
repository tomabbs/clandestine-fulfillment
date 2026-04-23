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
