/**
 * Shopify GraphQL fulfillment helper — B-2 / HRD-28.
 *
 * Replaces the legacy REST flow (GET `/orders/{id}/fulfillment_orders.json`
 * + POST `/fulfillments.json`) with a single `fulfillmentCreate` mutation
 * over the connection's Admin GraphQL endpoint. Pinned to the same API
 * version as `connectionShopifyGraphQL` (`SHOPIFY_CLIENT_API_VERSION` —
 * currently 2026-04) per HRD-09.2.
 *
 * Why this is its own module:
 *   - Fulfillment-order selection is a tricky pure decision (open vs in
 *     progress vs ambiguous) — we extract it so it stays unit-testable
 *     without HTTP mocks.
 *   - The GraphQL error envelope has TWO failure surfaces (top-level
 *     `errors[]` AND mutation-scoped `userErrors[]`) that must BOTH be
 *     treated as hard failures. We centralize that so every fulfill
 *     caller gets it right.
 *   - CLAUDE.md Rule #1 ("never use productSet for edits, full-shape
 *     builder required") does NOT apply here — `fulfillmentCreate` is
 *     a fulfillment mutation, not a list-field product mutation.
 */

import {
  type ConnectionShopifyContext,
  connectionShopifyGraphQL,
} from "./shopify-connection-graphql";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ShopifyFulfillmentOrderLineItem {
  /** GID, e.g. `gid://shopify/FulfillmentOrderLineItem/123` */
  id: string;
  /** SKU as Shopify reports it; can be null for catch-alls */
  sku: string | null;
  remainingQuantity: number;
}

export interface ShopifyFulfillmentOrderNode {
  /** GID, e.g. `gid://shopify/FulfillmentOrder/456` */
  id: string;
  /** OPEN, IN_PROGRESS, CLOSED, CANCELLED, etc. */
  status: string;
  lineItems: ShopifyFulfillmentOrderLineItem[];
}

export type SelectFulfillmentOrderResult =
  | {
      kind: "selected";
      fulfillmentOrder: ShopifyFulfillmentOrderNode;
      ambiguous: boolean;
      tieBreakerReason?: "oldest_id";
    }
  | { kind: "none_match"; reason: "no_actionable_status" | "no_sku_coverage" };

export type FulfillmentCreateResult =
  | { kind: "ok"; fulfillmentId: string }
  | {
      kind: "user_errors";
      userErrors: Array<{ field?: string[] | null; message: string }>;
      partialFulfillmentId: string | null;
    };

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Coerce a Shopify order id (numeric string or already-formed GID) to GID
 * form. Webhooks deliver numeric ids; some persisted metadata may already
 * have GIDs. Idempotent.
 */
export function toShopifyOrderGid(numericOrGid: string): string {
  if (numericOrGid.startsWith("gid://shopify/Order/")) return numericOrGid;
  return `gid://shopify/Order/${numericOrGid}`;
}

/**
 * Pure fulfillment-order selection logic.
 *
 * REST's `status === 'open'` filter was too narrow — partial fulfillments hit
 * `IN_PROGRESS`. We accept both. If multiple FOs match, we prefer the one
 * whose `lineItems[].sku` set covers every required SKU at >= the required
 * quantity. If still ambiguous, we tie-break on the oldest GID lexicographically
 * (Shopify GIDs are monotonically increasing, so oldest = smallest numeric
 * suffix) and flag `ambiguous: true` so the caller can emit a sensor warning.
 *
 * If no FO is OPEN/IN_PROGRESS, returns `none_match: no_actionable_status`.
 * If FOs exist but none cover the required SKUs, returns
 * `none_match: no_sku_coverage` so the caller can fail to review queue
 * (per plan: no implicit fallback).
 */
export function selectFulfillmentOrder(args: {
  fulfillmentOrders: ShopifyFulfillmentOrderNode[];
  requiredSkus: Map<string, number>;
}): SelectFulfillmentOrderResult {
  const actionable = args.fulfillmentOrders.filter(
    (fo) => fo.status === "OPEN" || fo.status === "IN_PROGRESS",
  );
  if (actionable.length === 0) {
    return { kind: "none_match", reason: "no_actionable_status" };
  }

  if (actionable.length === 1) {
    return { kind: "selected", fulfillmentOrder: actionable[0]!, ambiguous: false };
  }

  // Multiple actionable FOs (e.g. multi-location split). Prefer the one whose
  // SKU coverage matches the required SKUs at >= the required quantity.
  const covering = actionable.filter((fo) => {
    if (args.requiredSkus.size === 0) return true; // caller didn't tell us what to filter on
    for (const [sku, requiredQty] of args.requiredSkus) {
      const li = fo.lineItems.find((l) => l.sku === sku);
      if (!li || li.remainingQuantity < requiredQty) return false;
    }
    return true;
  });

  const candidates = covering.length > 0 ? covering : actionable;

  if (candidates.length === 0) {
    return { kind: "none_match", reason: "no_sku_coverage" };
  }

  if (candidates.length === 1) {
    return {
      kind: "selected",
      fulfillmentOrder: candidates[0]!,
      ambiguous: covering.length === 0,
    };
  }

  // Still ambiguous → pick lexicographically smallest GID (= oldest by
  // Shopify's monotonically-increasing id space).
  const sorted = [...candidates].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return {
    kind: "selected",
    fulfillmentOrder: sorted[0]!,
    ambiguous: true,
    tieBreakerReason: "oldest_id",
  };
}

// ─── GraphQL queries ──────────────────────────────────────────────────────────

const FULFILLMENT_ORDERS_QUERY = `
  query OrderFulfillmentOrders($id: ID!) {
    order(id: $id) {
      id
      fulfillmentOrders(first: 20) {
        edges {
          node {
            id
            status
            lineItems(first: 50) {
              edges {
                node {
                  id
                  sku
                  remainingQuantity
                }
              }
            }
          }
        }
      }
    }
  }
`;

const FULFILLMENT_CREATE_MUTATION = `
  mutation B2FulfillmentCreate($fulfillment: FulfillmentInput!) {
    fulfillmentCreate(fulfillment: $fulfillment) {
      fulfillment {
        id
        status
      }
      userErrors {
        field
        message
      }
    }
  }
`;

interface FulfillmentOrdersResponse {
  order: {
    id: string;
    fulfillmentOrders: {
      edges: Array<{
        node: {
          id: string;
          status: string;
          lineItems: {
            edges: Array<{
              node: { id: string; sku: string | null; remainingQuantity: number };
            }>;
          };
        };
      }>;
    };
  } | null;
}

interface FulfillmentCreateResponse {
  fulfillmentCreate: {
    fulfillment: { id: string; status: string } | null;
    userErrors: Array<{ field?: string[] | null; message: string }>;
  };
}

// ─── HTTP-doing entry point ───────────────────────────────────────────────────

/**
 * Fetch the actionable fulfillment orders for a Shopify order GID. Caller
 * passes the result to `selectFulfillmentOrder()`.
 */
export async function fetchFulfillmentOrdersForOrder(
  ctx: ConnectionShopifyContext,
  orderGid: string,
): Promise<ShopifyFulfillmentOrderNode[]> {
  const data = await connectionShopifyGraphQL<FulfillmentOrdersResponse>(
    ctx,
    FULFILLMENT_ORDERS_QUERY,
    { id: orderGid },
  );

  if (!data.order) {
    throw new Error(`Shopify order not found: ${orderGid}`);
  }

  return data.order.fulfillmentOrders.edges.map(({ node }) => ({
    id: node.id,
    status: node.status,
    lineItems: node.lineItems.edges.map(({ node: li }) => ({
      id: li.id,
      sku: li.sku,
      remainingQuantity: li.remainingQuantity,
    })),
  }));
}

/**
 * Run the `fulfillmentCreate` mutation against the chosen fulfillment order.
 * Returns a typed `FulfillmentCreateResult`:
 *   - `ok` → fulfillment id committed by Shopify
 *   - `user_errors` → mutation rejected; caller MUST treat as failure even
 *     if `partialFulfillmentId` is non-null (Shopify can return both)
 *
 * Top-level GraphQL `errors[]` are surfaced as throws by
 * `connectionShopifyGraphQL` itself (transport-level failures retry there
 * with backoff; final failure throws).
 */
export async function runFulfillmentCreateMutation(args: {
  ctx: ConnectionShopifyContext;
  fulfillmentOrderId: string;
  trackingNumber: string;
  carrier: string;
  notifyCustomer: boolean;
}): Promise<FulfillmentCreateResult> {
  const data = await connectionShopifyGraphQL<FulfillmentCreateResponse>(
    args.ctx,
    FULFILLMENT_CREATE_MUTATION,
    {
      fulfillment: {
        lineItemsByFulfillmentOrder: [{ fulfillmentOrderId: args.fulfillmentOrderId }],
        trackingInfo: { number: args.trackingNumber, company: args.carrier },
        notifyCustomer: args.notifyCustomer,
      },
    },
  );

  const userErrors = data.fulfillmentCreate.userErrors ?? [];
  const fulfillmentId = data.fulfillmentCreate.fulfillment?.id ?? null;

  if (userErrors.length > 0) {
    return { kind: "user_errors", userErrors, partialFulfillmentId: fulfillmentId };
  }

  if (!fulfillmentId) {
    return {
      kind: "user_errors",
      userErrors: [{ message: "Shopify returned no fulfillment id and no userErrors" }],
      partialFulfillmentId: null,
    };
  }

  return { kind: "ok", fulfillmentId };
}
