/**
 * HRD-09.2 — per-connection Shopify webhook subscription auto-register helper.
 *
 * Wraps the Shopify Admin GraphQL `webhookSubscriptionCreate` mutation for the
 * four topics the direct-Shopify cutover requires:
 *
 *   - inventory_levels/update
 *   - orders/create
 *   - orders/cancelled
 *   - refunds/create
 *
 * Idempotent: before creating, queries existing subscriptions for the same
 * (topic, callbackUrl) and reuses the row instead of duplicating. Returns the
 * `apiVersion.handle` Shopify pins per subscription so the caller can persist
 * it on `client_store_connections.metadata.webhook_subscriptions[]` and the
 * deferred `shopify-webhook-health-check` task can detect drift between the
 * pinned subscription version and the configured app version (HRD-09.2 drift
 * sensor).
 *
 * NEVER reads env-singleton state — all Shopify calls go through
 * `connectionShopifyGraphQL` with an explicit per-connection token.
 *
 * Surface errors loudly: a failed userErrors block on a single topic does NOT
 * abort the others (we want to know which ones succeeded), but any GraphQL-
 * level failure (auth/scope) bubbles up via the underlying transport.
 */

import {
  type ConnectionShopifyContext,
  connectionShopifyGraphQL,
} from "@/lib/server/shopify-connection-graphql";

/**
 * The four Shopify webhook topics the direct-Shopify cutover depends on.
 *
 * Topic values use the GraphQL enum spelling (UPPER_SNAKE_CASE), not the REST
 * dotted spelling. Conversion happens at the call boundary; the rest of our
 * code uses the dotted REST form everywhere else for grep parity with Shopify
 * docs + headers.
 */
export const SHOPIFY_REQUIRED_WEBHOOK_TOPICS = [
  "INVENTORY_LEVELS_UPDATE",
  "ORDERS_CREATE",
  "ORDERS_CANCELLED",
  "REFUNDS_CREATE",
] as const;

export type ShopifyWebhookTopicEnum = (typeof SHOPIFY_REQUIRED_WEBHOOK_TOPICS)[number];

/** Map the GraphQL enum back to the REST/header dotted form. */
export function topicEnumToRest(topic: ShopifyWebhookTopicEnum): string {
  switch (topic) {
    case "INVENTORY_LEVELS_UPDATE":
      return "inventory_levels/update";
    case "ORDERS_CREATE":
      return "orders/create";
    case "ORDERS_CANCELLED":
      return "orders/cancelled";
    case "REFUNDS_CREATE":
      return "refunds/create";
  }
}

export interface WebhookSubscriptionRecord {
  /** GraphQL gid, e.g. `gid://shopify/WebhookSubscription/12345` */
  id: string;
  /** REST-style dotted form, e.g. `orders/create` (matches X-Shopify-Topic header) */
  topic: string;
  /** Shopify's API version pinned for THIS subscription (e.g. `2026-01`). */
  apiVersion: string;
  callbackUrl: string;
  /** Whether we created the row in this call, or it already existed and we reused it. */
  reused: boolean;
}

export interface WebhookSubscriptionFailure {
  topic: string;
  callbackUrl: string;
  error: string;
}

export interface RegisterWebhookSubscriptionsResult {
  registered: WebhookSubscriptionRecord[];
  failed: WebhookSubscriptionFailure[];
}

const LIST_QUERY = `
  query ListWebhookSubscriptions($first: Int!) {
    webhookSubscriptions(first: $first) {
      edges {
        node {
          id
          topic
          apiVersion { handle }
          endpoint {
            __typename
            ... on WebhookHttpEndpoint { callbackUrl }
          }
        }
      }
    }
  }
`;

const CREATE_MUTATION = `
  mutation CreateWebhookSubscription($topic: WebhookSubscriptionTopic!, $webhookSubscription: WebhookSubscriptionInput!) {
    webhookSubscriptionCreate(topic: $topic, webhookSubscription: $webhookSubscription) {
      webhookSubscription {
        id
        topic
        apiVersion { handle }
        endpoint {
          __typename
          ... on WebhookHttpEndpoint { callbackUrl }
        }
      }
      userErrors { field message }
    }
  }
`;

interface ListResponse {
  webhookSubscriptions: {
    edges: Array<{
      node: {
        id: string;
        topic: string;
        apiVersion: { handle: string };
        endpoint: { __typename: string; callbackUrl?: string };
      };
    }>;
  };
}

interface CreateResponse {
  webhookSubscriptionCreate: {
    webhookSubscription: {
      id: string;
      topic: string;
      apiVersion: { handle: string };
      endpoint: { __typename: string; callbackUrl?: string };
    } | null;
    userErrors: Array<{ field: string[]; message: string }>;
  };
}

/**
 * List existing webhook subscriptions on the connected store. Returns the
 * subset that targets `callbackUrl` (or all of them if no filter supplied).
 *
 * Bounded to 250 subscriptions per connection — Shopify's documented cap is
 * 100 per topic but in practice the per-store list stays well under 50.
 */
export async function listWebhookSubscriptions(
  ctx: ConnectionShopifyContext,
  filter?: { callbackUrl?: string },
): Promise<WebhookSubscriptionRecord[]> {
  const data = await connectionShopifyGraphQL<ListResponse>(ctx, LIST_QUERY, { first: 100 });
  const out: WebhookSubscriptionRecord[] = [];
  for (const { node } of data.webhookSubscriptions.edges) {
    const callbackUrl = node.endpoint?.callbackUrl;
    if (!callbackUrl) continue;
    if (filter?.callbackUrl && callbackUrl !== filter.callbackUrl) continue;
    out.push({
      id: node.id,
      topic: graphqlTopicToRest(node.topic),
      apiVersion: node.apiVersion.handle,
      callbackUrl,
      reused: false,
    });
  }
  return out;
}

/**
 * Idempotently register the four required webhook topics for a connection.
 * Behavior per topic:
 *   - If a subscription with the same (topic, callbackUrl) already exists →
 *     return it with `reused: true`.
 *   - Otherwise create a fresh subscription via webhookSubscriptionCreate.
 *   - On `userErrors`, push to `failed[]` and continue with the remaining
 *     topics (we want partial-success visibility).
 *
 * Throws only on transport-level failures (auth, scope, network). Per-topic
 * failures land in `failed[]`.
 */
export async function registerWebhookSubscriptions(
  ctx: ConnectionShopifyContext,
  callbackUrl: string,
): Promise<RegisterWebhookSubscriptionsResult> {
  const existing = await listWebhookSubscriptions(ctx, { callbackUrl });
  const existingByTopic = new Map<string, WebhookSubscriptionRecord>();
  for (const sub of existing) existingByTopic.set(sub.topic, sub);

  const registered: WebhookSubscriptionRecord[] = [];
  const failed: WebhookSubscriptionFailure[] = [];

  for (const topicEnum of SHOPIFY_REQUIRED_WEBHOOK_TOPICS) {
    const restTopic = topicEnumToRest(topicEnum);
    const prior = existingByTopic.get(restTopic);
    if (prior) {
      registered.push({ ...prior, reused: true });
      continue;
    }

    try {
      const data = await connectionShopifyGraphQL<CreateResponse>(ctx, CREATE_MUTATION, {
        topic: topicEnum,
        webhookSubscription: { callbackUrl, format: "JSON" },
      });
      const userErrors = data.webhookSubscriptionCreate.userErrors;
      if (userErrors.length > 0) {
        failed.push({
          topic: restTopic,
          callbackUrl,
          error: userErrors.map((e) => e.message).join("; "),
        });
        continue;
      }
      const sub = data.webhookSubscriptionCreate.webhookSubscription;
      if (!sub) {
        failed.push({ topic: restTopic, callbackUrl, error: "Empty subscription response" });
        continue;
      }
      registered.push({
        id: sub.id,
        topic: graphqlTopicToRest(sub.topic),
        apiVersion: sub.apiVersion.handle,
        callbackUrl: sub.endpoint?.callbackUrl ?? callbackUrl,
        reused: false,
      });
    } catch (err) {
      failed.push({
        topic: restTopic,
        callbackUrl,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { registered, failed };
}

/**
 * Convert Shopify's GraphQL topic enum back to the dotted REST form. Shopify
 * sometimes returns the topic with the dotted form already (when read back
 * from `webhookSubscriptions` query) and sometimes as the GraphQL enum (when
 * mirrored straight from the input). This normalizes both.
 */
export function graphqlTopicToRest(topic: string): string {
  if (topic.includes("/")) return topic.toLowerCase();
  const lower = topic.toLowerCase();
  const idx = lower.lastIndexOf("_");
  return idx === -1 ? lower : `${lower.slice(0, idx)}/${lower.slice(idx + 1)}`;
}
