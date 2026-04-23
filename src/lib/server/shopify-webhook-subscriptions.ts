// Post-audit baseline (plan: direct-shopify-cutover-finish, 2026-04-22).
// Any change here must update docs/system_map/API_CATALOG.md and re-run
// tests/unit/lib/server/shopify-webhook-subscriptions.test.ts.

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

import type { SupabaseClient } from "@supabase/supabase-js";
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
  /** Shopify's API version pinned for THIS subscription (e.g. `2026-04`). */
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

// ─── B-3 / HRD-14 — Idempotent diff helper ────────────────────────────────────

export interface WebhookSubscriptionDiff {
  /** Topics in the required set that have NO matching subscription on Shopify. */
  toCreate: string[];
  /** Existing subscriptions whose callbackUrl drifted from the canonical one. */
  toRecreate: WebhookSubscriptionRecord[];
  /** Existing subscriptions on Shopify that are NOT in the required set (stale). */
  toDelete: WebhookSubscriptionRecord[];
  /** Existing subscriptions that already match desired state. */
  inSync: WebhookSubscriptionRecord[];
}

/**
 * B-3 / HRD-14 — pure diff between Shopify's current webhook subscriptions
 * and the canonical (4 required topics × 1 callbackUrl) target state.
 *
 * Used by the "Re-register webhooks" button on the Channels page health card
 * to surface what would change BEFORE the operator confirms. The plan
 * mandates "idempotent diff, not blind recreate":
 *
 *   - Topics in the required set with no matching subscription → toCreate
 *   - Subscriptions for required topics whose callbackUrl drifted → toRecreate
 *     (caller deletes the old one + creates fresh; updateMutation does NOT
 *     exist in the WebhookSubscription Shopify API)
 *   - Subscriptions for non-required topics → toDelete (operator-confirmed)
 *   - Everything else is in sync (no churn)
 *
 * Pure function so it stays unit-testable without HTTP mocks.
 */
export function diffWebhookSubscriptions(args: {
  current: WebhookSubscriptionRecord[];
  desiredCallbackUrl: string;
}): WebhookSubscriptionDiff {
  const required = new Set<string>(SHOPIFY_REQUIRED_WEBHOOK_TOPICS.map(topicEnumToRest));
  const haveByTopic = new Map<string, WebhookSubscriptionRecord>();
  for (const sub of args.current) {
    if (!haveByTopic.has(sub.topic)) haveByTopic.set(sub.topic, sub);
  }

  const toCreate: string[] = [];
  const toRecreate: WebhookSubscriptionRecord[] = [];
  const toDelete: WebhookSubscriptionRecord[] = [];
  const inSync: WebhookSubscriptionRecord[] = [];

  for (const topic of required) {
    const have = haveByTopic.get(topic);
    if (!have) {
      toCreate.push(topic);
      continue;
    }
    if (have.callbackUrl !== args.desiredCallbackUrl) {
      toRecreate.push(have);
    } else {
      inSync.push(have);
    }
  }

  for (const sub of args.current) {
    if (!required.has(sub.topic)) toDelete.push(sub);
  }

  return { toCreate, toRecreate, toDelete, inSync };
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

export interface PersistWebhookRegistrationExtras {
  /** Comma-separated scope list returned by Shopify's token-exchange `scope` field. */
  shopifyScopes?: string[];
  /** "custom" for HRD-35 per-client Custom-distribution apps; "public" for the legacy single app. */
  appDistribution?: "custom" | "public";
  /** Override for `metadata.installed_at`; defaults to now. Useful for re-registration runs that should NOT overwrite the original install timestamp. */
  installedAt?: string | null;
}

export interface PersistWebhookRegistrationResult {
  apiVersionPinned: string | null;
  apiVersionDrift: boolean;
  registeredAt: string;
}

/**
 * Merge webhook-registration output into `client_store_connections.metadata`.
 *
 * Shared by:
 *   - `registerShopifyWebhookSubscriptions` Server Action (staff-manual button)
 *   - `/api/oauth/shopify` callback (auto-register after token capture, HRD-35 gap #3)
 *
 * Always merges (never replaces) the metadata row so unrelated keys
 * (`channel_sync_*`, do-not-fanout audit trail) survive intact. Loads the
 * current `metadata` first because PostgREST has no JSON-merge primitive that
 * is safe across drivers.
 */
export async function persistWebhookRegistrationMetadata(
  supabase: SupabaseClient,
  connectionId: string,
  result: RegisterWebhookSubscriptionsResult,
  callbackUrl: string,
  extras: PersistWebhookRegistrationExtras = {},
): Promise<PersistWebhookRegistrationResult> {
  const apiVersions = new Set(result.registered.map((r) => r.apiVersion));
  const apiVersionPinned = result.registered[0]?.apiVersion ?? null;
  const apiVersionDrift = apiVersions.size > 1;
  const registeredAt = new Date().toISOString();

  const { data: connRow, error: connErr } = await supabase
    .from("client_store_connections")
    .select("metadata")
    .eq("id", connectionId)
    .maybeSingle();
  if (connErr) {
    throw new Error(`Failed to load connection metadata for merge: ${connErr.message}`);
  }

  const existingMeta =
    connRow?.metadata && typeof connRow.metadata === "object"
      ? (connRow.metadata as Record<string, unknown>)
      : {};
  const nextMeta: Record<string, unknown> = {
    ...existingMeta,
    webhook_callback_url: callbackUrl,
    webhook_subscriptions: result.registered.map((r) => ({
      id: r.id,
      topic: r.topic,
      apiVersion: r.apiVersion,
      callbackUrl: r.callbackUrl,
      reused: r.reused,
      registeredAt,
    })),
    webhook_register_failures: result.failed.length > 0 ? result.failed : undefined,
    webhook_register_last_run_at: registeredAt,
  };

  if (extras.shopifyScopes !== undefined) {
    nextMeta.shopify_scopes = extras.shopifyScopes;
  }
  if (extras.appDistribution !== undefined) {
    nextMeta.app_distribution = extras.appDistribution;
  }
  if (extras.installedAt !== undefined) {
    if (extras.installedAt === null) {
      nextMeta.installed_at = registeredAt;
    } else {
      nextMeta.installed_at = extras.installedAt;
    }
  }

  const { error: updateErr } = await supabase
    .from("client_store_connections")
    .update({ metadata: nextMeta, updated_at: registeredAt })
    .eq("id", connectionId);
  if (updateErr) {
    throw new Error(`Failed to persist webhook subscription metadata: ${updateErr.message}`);
  }

  return { apiVersionPinned, apiVersionDrift, registeredAt };
}
