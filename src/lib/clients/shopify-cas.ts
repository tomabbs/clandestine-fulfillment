/**
 * Phase 1 Pass 2 §9.2 D4 Step B — Shopify Compare-And-Set (CAS) inventory primitive.
 *
 * Replaces the delta-based `inventoryAdjustQuantities` write path with an
 * absolute-with-compare write path via `inventorySetQuantities`. The
 * difference matters under concurrent webhooks:
 *
 *   - Delta (`inventoryAdjustQuantities`) is RACE-PRONE: if a Shopify-side
 *     order webhook decrements `available` by 1 between our read and our
 *     write, our `delta = +3` is applied to a value we never saw, silently
 *     overstating inventory by 1.
 *   - Absolute-with-compare (`inventorySetQuantities` with the CAS comparator)
 *     fails atomically if the actual current value is not what we expect.
 *     The hot-path retry loop in the per-SKU push task re-reads the actual
 *     value, recomputes the desired write, and retries up to 3× with
 *     50/150/400ms backoff and a `:retryN` idempotency suffix.
 *
 * Idempotency: every write carries a stable key shaped
 *   `{system}:{correlation_id}:{sku}` (with optional `:retryN` suffix
 *   appended by the caller's retry loop). Shopify's `@idempotent(key:)`
 *   directive is applied at the mutation level — duplicate keys within
 *   the directive's TTL window return the original mutation result
 *   without side-effects, so a retry of an already-applied write does
 *   NOT create a second adjustment row.
 *
 * Surface: pure transport. Re-reading Shopify's actual `available` value
 * on `compare_mismatch`, recomputing the desired write, and retrying
 * are caller responsibilities — they belong to the per-SKU push task,
 * not to this primitive (which would otherwise need to know the channel-
 * specific safety stock and ATP formula).
 *
 * Why a new file vs. extending `shopify-client.ts`:
 *   1. Both env-singleton (Clandestine Shopify) AND per-connection (per-
 *      client Custom-distribution apps) need this primitive. Putting it
 *      in `shopify-client.ts` would couple it to env-singleton state.
 *      Putting it in `shopify-connection-graphql.ts` would couple it to
 *      per-connection state. The transport selector is a constructor
 *      arg — `setShopifyInventoryWithCompare(transport, input)`.
 *   2. The CAS contract is a Pass 2 deliverable that Pass 3 reconcile
 *      will also import. A standalone module keeps the import graph
 *      shallow and the contract test's surface area minimal.
 *   3. Rule #58 (one truth per concern) — this is the single owner of
 *      Shopify CAS. `inventoryAdjustQuantities` remains for legacy
 *      callers but is being phased out as Pass 2 migrates writers.
 */

import { shopifyGraphQL } from "@/lib/clients/shopify-client";
import {
  type ConnectionShopifyContext,
  connectionShopifyGraphQL,
} from "@/lib/server/shopify-connection-graphql";

/**
 * Transport selector. The CAS helper itself is transport-agnostic — both
 * surfaces share the GraphQL contract; only the request signing differs.
 *
 * - `{ kind: "env_singleton" }` routes through `shopifyGraphQL` (env-driven
 *   Clandestine Shopify token). The env-singleton `SHOPIFY_API_VERSION`
 *   MUST be ≥ 2026-04 for CAS to work; the operator is responsible for
 *   bumping it via Vercel env.
 * - `{ kind: "per_connection", ctx }` routes through `connectionShopifyGraphQL`
 *   (per-client offline access token). Pinned to `SHOPIFY_CLIENT_API_VERSION`
 *   (currently 2026-04) via the shared constant; the CI guard
 *   (`scripts/check-shopify-api-version.sh`) enforces no other literal
 *   leaks in.
 */
export type ShopifyCasTransport =
  | { kind: "env_singleton" }
  | { kind: "per_connection"; ctx: ConnectionShopifyContext };

export interface SetShopifyInventoryWithCompareInput {
  /** Shopify GID, e.g. `gid://shopify/InventoryItem/12345` */
  inventoryItemId: string;
  /** Shopify GID, e.g. `gid://shopify/Location/67890` */
  locationId: string;
  /**
   * The current `available` value we expect Shopify to have. The CAS check
   * fails if Shopify's actual value differs — surfaced as
   * `{ ok: false, reason: "compare_mismatch", actualQuantity }`.
   */
  expectedQuantity: number;
  /**
   * The new absolute `available` value we want to write. Caller computes
   * this from `effective_sellable` (per-channel) — the helper does not
   * apply any per-channel safety stock here.
   */
  desiredQuantity: number;
  /**
   * Stable idempotency key per Rule #15. Helper appends nothing — caller
   * owns the retry suffix (`:retry1`, `:retry2`, ...) so each retry attempt
   * is its own idempotency key (otherwise Shopify would silently return
   * the original CAS-failed result for every retry in the window).
   */
  idempotencyKey: string;
  /**
   * Optional `reason` enum value for the inventory adjustment ledger row.
   * Defaults to `"correction"`. Other valid Shopify enum values include
   * `"received"`, `"cycle_count_available"`, `"safety_stock"`, etc.
   */
  reason?: string;
  /**
   * Optional `referenceDocumentUri` for the adjustment row. Defaults to a
   * `clandestine://cas/{idempotencyKey}` URI so the audit trail can
   * always be reverse-mapped to a correlation_id.
   */
  referenceDocumentUri?: string;
}

export type SetShopifyInventoryWithCompareResult =
  | {
      ok: true;
      /**
       * Shopify's resulting absolute quantity. Should equal `desiredQuantity`
       * unless Shopify silently clamped (e.g. negative not allowed by policy).
       */
      newQuantity: number;
      /** Shopify's `inventoryAdjustmentGroup.id` for the audit trail. */
      adjustmentGroupId: string | null;
    }
  | {
      ok: false;
      /**
       * `compare_mismatch` — Shopify rejected because actual ≠ expected.
       * Caller's hot-path retry loop should re-read actual and recompute.
       */
      reason: "compare_mismatch";
      /**
       * Shopify's actual current quantity. Returned by the GraphQL
       * userError or, if the userError doesn't include it (Shopify's
       * shape varies by API version), set to `null` and the caller is
       * expected to fall back to a fresh read.
       */
      actualQuantity: number | null;
      /** Verbatim Shopify userError message for logs / review queue. */
      message: string;
    };

/**
 * GraphQL mutation. We use:
 *   - `inventorySetQuantities` (the absolute-write mutation)
 *   - `quantities[].compareQuantity` (the CAS comparator field — Shopify
 *     fails the entire input if any row's actual ≠ compare)
 *   - `@idempotent(key: $idempotencyKey)` (Shopify Admin API directive
 *     introduced in 2025-10+; pin assumes ≥ 2026-04)
 *
 * `referenceDocumentUri` and `reason` go on the input; both are surfaced
 * in the audit ledger so we can reverse-map a Shopify adjustment row to
 * a clandestine correlation_id without a separate join.
 *
 * NOTE: The exact userError shape for compare-mismatch is documented as
 * `code: "INVALID_COMPARE_QUANTITY"` with `message` carrying the actual
 * value. We parse defensively — if Shopify changes the code/message
 * shape, the contract test (gated on SHOPIFY_CONTRACT_TEST=1) catches
 * it before any production rollout.
 */
const INVENTORY_SET_MUTATION = `
mutation InventorySetWithCompare(
  $input: InventorySetQuantitiesInput!
  $idempotencyKey: String!
) @idempotent(key: $idempotencyKey) {
  inventorySetQuantities(input: $input) {
    inventoryAdjustmentGroup {
      id
      changes {
        name
        delta
        quantityAfterChange
      }
    }
    userErrors {
      field
      code
      message
    }
  }
}
`;

interface InventorySetQuantitiesResponse {
  inventorySetQuantities: {
    inventoryAdjustmentGroup: {
      id: string;
      changes: Array<{
        name: string;
        delta: number;
        quantityAfterChange: number;
      }>;
    } | null;
    userErrors: Array<{
      field: string[] | null;
      code: string | null;
      message: string;
    }>;
  };
}

/**
 * Detect Shopify's compare-mismatch userError. The exact `code` enum
 * value used by Shopify for this case is `INVALID_COMPARE_QUANTITY` as
 * of 2026-04 — we accept it case-insensitively and also fall back to a
 * substring match on the `message` (Shopify has historically renamed
 * codes between API versions; the message text "compare quantity" is
 * stable).
 */
function isCompareMismatchUserError(err: { code: string | null; message: string }): boolean {
  if (err.code?.toUpperCase().includes("COMPARE")) return true;
  return /compare\s+quantity/i.test(err.message);
}

/**
 * Best-effort extraction of the actual quantity from the userError
 * message. Shopify formats it as `"... actual quantity: 3 ..."` or
 * `"... but found 3"` depending on version. If we can't parse it,
 * caller is expected to do a fresh read.
 */
function extractActualQuantity(message: string): number | null {
  const match =
    message.match(/actual\s+quantity[:\s]+(-?\d+)/i) ??
    message.match(/(?:found|got|is)[:\s]+(-?\d+)/i);
  if (!match) return null;
  const n = Number(match[1]);
  return Number.isFinite(n) ? n : null;
}

/**
 * Single CAS write. Caller owns the retry loop — this function returns
 * `compare_mismatch` as a typed result, never throws on it.
 *
 * Throws on transport/auth/throttle errors (those propagate up to the
 * Trigger.dev task framework which retries the whole task at the queue
 * level). CAS-failure is NOT a transport failure and must not throw —
 * the hot-path retry loop is the right layer to handle it.
 */
export async function setShopifyInventoryWithCompare(
  transport: ShopifyCasTransport,
  input: SetShopifyInventoryWithCompareInput,
): Promise<SetShopifyInventoryWithCompareResult> {
  const reason = input.reason ?? "correction";
  const referenceDocumentUri =
    input.referenceDocumentUri ?? `clandestine://cas/${input.idempotencyKey}`;

  const variables = {
    input: {
      reason,
      name: "available",
      referenceDocumentUri,
      // `ignoreCompareQuantity: false` is the default; we set it explicitly
      // so a future schema change defaulting it to `true` (which would
      // silently break CAS) shows up in code review.
      ignoreCompareQuantity: false,
      quantities: [
        {
          inventoryItemId: input.inventoryItemId,
          locationId: input.locationId,
          quantity: input.desiredQuantity,
          compareQuantity: input.expectedQuantity,
        },
      ],
    },
    idempotencyKey: input.idempotencyKey,
  };

  const data =
    transport.kind === "env_singleton"
      ? await shopifyGraphQL<InventorySetQuantitiesResponse>(INVENTORY_SET_MUTATION, variables)
      : await connectionShopifyGraphQL<InventorySetQuantitiesResponse>(
          transport.ctx,
          INVENTORY_SET_MUTATION,
          variables,
        );

  const result = data.inventorySetQuantities;
  const userErrors = result.userErrors ?? [];

  // CAS mismatch detection takes priority over generic userError surfacing.
  // A compare_mismatch IS a userError, but it's a structurally different
  // outcome from "your input was malformed" — caller wants the typed
  // discriminated result, not an exception.
  const mismatchErr = userErrors.find(isCompareMismatchUserError);
  if (mismatchErr) {
    return {
      ok: false,
      reason: "compare_mismatch",
      actualQuantity: extractActualQuantity(mismatchErr.message),
      message: mismatchErr.message,
    };
  }

  if (userErrors.length > 0) {
    // Non-CAS userErrors (e.g. invalid GID, location not active for item)
    // are programmer errors, not race conditions. Throw so the task
    // framework's catchError path captures them with full context.
    throw new Error(
      `Shopify inventorySetQuantities userErrors: ${userErrors
        .map((e) => `${e.code ?? "?"}: ${e.message}`)
        .join("; ")}`,
    );
  }

  const group = result.inventoryAdjustmentGroup;
  // The first 'available' change in the group is the one we requested.
  const change = group?.changes.find((c) => c.name === "available") ?? null;
  return {
    ok: true,
    // Fall back to desiredQuantity if Shopify's response shape doesn't
    // include `quantityAfterChange` (older API versions). The contract
    // test pins this — production should always have the field.
    newQuantity: change?.quantityAfterChange ?? input.desiredQuantity,
    adjustmentGroupId: group?.id ?? null,
  };
}

/**
 * Idempotency key shape per Rule #15 — exported as a named helper so
 * call sites and tests share the truth.
 *
 * Pattern: `{system}:{correlationId}:{sku}` (with optional `:retryN`).
 *
 *   - `system`: e.g. `clandestine_shopify`, `client_store_shopify` —
 *     namespacing prevents two unrelated systems from accidentally
 *     colliding on the same correlation_id (extremely unlikely with
 *     UUIDs, but the namespace is free insurance).
 *   - `correlationId`: the upstream event identifier (webhook id,
 *     order id, task run id) — the same correlation_id used for the
 *     `external_sync_events` ledger row.
 *   - `sku`: the SKU being adjusted.
 *   - `retrySuffix`: the caller's hot-path retry counter (`retry1`,
 *     `retry2`, `retry3`). Each retry MUST be its own idempotency key,
 *     otherwise Shopify's @idempotent directive returns the prior
 *     CAS-failed result instead of attempting the new CAS.
 */
export function makeCasIdempotencyKey(
  system: "clandestine_shopify" | "client_store_shopify",
  correlationId: string,
  sku: string,
  retryAttempt = 0,
): string {
  const base = `${system}:${correlationId}:${sku}`;
  return retryAttempt > 0 ? `${base}:retry${retryAttempt}` : base;
}
