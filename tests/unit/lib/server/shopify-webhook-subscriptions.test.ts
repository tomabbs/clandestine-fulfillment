/**
 * HRD-09.2 — unit tests for the per-connection Shopify webhook subscription
 * registrar.
 *
 * Mocks the GraphQL transport (`connectionShopifyGraphQL`) and asserts:
 *   - the four required topics are all attempted
 *   - already-existing (topic, callbackUrl) tuples are reused, not re-created
 *   - `userErrors[]` on a single topic does NOT abort remaining topics
 *   - transport-level throws on a single topic are captured into `failed[]`
 *   - the GraphQL → REST topic name conversion is round-trip safe
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/server/shopify-connection-graphql", () => ({
  connectionShopifyGraphQL: vi.fn(),
}));

import { connectionShopifyGraphQL } from "@/lib/server/shopify-connection-graphql";
import {
  diffWebhookSubscriptions,
  graphqlTopicToRest,
  listWebhookSubscriptions,
  persistWebhookRegistrationMetadata,
  type RegisterWebhookSubscriptionsResult,
  registerWebhookSubscriptions,
  SHOPIFY_REQUIRED_WEBHOOK_TOPICS,
  topicEnumToRest,
  type WebhookSubscriptionRecord,
} from "@/lib/server/shopify-webhook-subscriptions";

const mockedGraphQL = vi.mocked(connectionShopifyGraphQL);

const CTX = {
  storeUrl: "https://test-shop.myshopify.com",
  accessToken: "shpat_test_token",
};
const CALLBACK =
  "https://app.example.com/api/webhooks/client-store?connection_id=conn-1&platform=shopify";

beforeEach(() => {
  mockedGraphQL.mockReset();
});

// ─── topic conversion ────────────────────────────────────────────────────────

describe("topicEnumToRest", () => {
  it("maps every required topic to its dotted REST form", () => {
    expect(topicEnumToRest("INVENTORY_LEVELS_UPDATE")).toBe("inventory_levels/update");
    expect(topicEnumToRest("ORDERS_CREATE")).toBe("orders/create");
    expect(topicEnumToRest("ORDERS_CANCELLED")).toBe("orders/cancelled");
    expect(topicEnumToRest("REFUNDS_CREATE")).toBe("refunds/create");
  });
});

describe("graphqlTopicToRest", () => {
  it("passes through dotted REST form unchanged (lowercased)", () => {
    expect(graphqlTopicToRest("orders/create")).toBe("orders/create");
    expect(graphqlTopicToRest("ORDERS/CREATE")).toBe("orders/create");
  });

  it("converts UPPER_SNAKE_CASE to dotted form", () => {
    expect(graphqlTopicToRest("INVENTORY_LEVELS_UPDATE")).toBe("inventory_levels/update");
    expect(graphqlTopicToRest("ORDERS_CANCELLED")).toBe("orders/cancelled");
    expect(graphqlTopicToRest("REFUNDS_CREATE")).toBe("refunds/create");
  });
});

// ─── listWebhookSubscriptions ────────────────────────────────────────────────

describe("listWebhookSubscriptions", () => {
  it("returns subscriptions filtered to the supplied callbackUrl", async () => {
    mockedGraphQL.mockResolvedValueOnce({
      webhookSubscriptions: {
        edges: [
          {
            node: {
              id: "gid://shopify/WebhookSubscription/1",
              topic: "ORDERS_CREATE",
              apiVersion: { handle: "2026-01" },
              endpoint: { __typename: "WebhookHttpEndpoint", callbackUrl: CALLBACK },
            },
          },
          {
            node: {
              id: "gid://shopify/WebhookSubscription/2",
              topic: "ORDERS_CANCELLED",
              apiVersion: { handle: "2026-01" },
              endpoint: {
                __typename: "WebhookHttpEndpoint",
                callbackUrl: "https://other.example.com/wh",
              },
            },
          },
        ],
      },
    });

    const result = await listWebhookSubscriptions(CTX, { callbackUrl: CALLBACK });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      id: "gid://shopify/WebhookSubscription/1",
      topic: "orders/create",
      apiVersion: "2026-01",
      callbackUrl: CALLBACK,
    });
  });

  it("skips non-HTTP endpoints (no callbackUrl field)", async () => {
    mockedGraphQL.mockResolvedValueOnce({
      webhookSubscriptions: {
        edges: [
          {
            node: {
              id: "gid://shopify/WebhookSubscription/9",
              topic: "ORDERS_CREATE",
              apiVersion: { handle: "2026-01" },
              endpoint: { __typename: "WebhookEventBridgeEndpoint" },
            },
          },
        ],
      },
    });

    const result = await listWebhookSubscriptions(CTX);
    expect(result).toHaveLength(0);
  });
});

// ─── registerWebhookSubscriptions ────────────────────────────────────────────

describe("registerWebhookSubscriptions", () => {
  it("creates all four topics when none exist on the store", async () => {
    // First call = list (returns empty)
    mockedGraphQL.mockResolvedValueOnce({
      webhookSubscriptions: { edges: [] },
    });
    // Then 4 sequential creates — each returns a fresh subscription
    for (const topic of SHOPIFY_REQUIRED_WEBHOOK_TOPICS) {
      mockedGraphQL.mockResolvedValueOnce({
        webhookSubscriptionCreate: {
          webhookSubscription: {
            id: `gid://shopify/WebhookSubscription/${topic}`,
            topic,
            apiVersion: { handle: "2026-01" },
            endpoint: { __typename: "WebhookHttpEndpoint", callbackUrl: CALLBACK },
          },
          userErrors: [],
        },
      });
    }

    const result = await registerWebhookSubscriptions(CTX, CALLBACK);

    expect(result.failed).toHaveLength(0);
    expect(result.registered).toHaveLength(4);
    expect(result.registered.map((r) => r.topic).sort()).toEqual(
      ["inventory_levels/update", "orders/cancelled", "orders/create", "refunds/create"].sort(),
    );
    expect(result.registered.every((r) => r.reused === false)).toBe(true);
    // 1 list + 4 creates
    expect(mockedGraphQL).toHaveBeenCalledTimes(5);
  });

  it("reuses pre-existing subscriptions and only creates the missing ones", async () => {
    // Pre-existing: orders/create + inventory_levels/update at SAME callbackUrl
    mockedGraphQL.mockResolvedValueOnce({
      webhookSubscriptions: {
        edges: [
          {
            node: {
              id: "gid://shopify/WebhookSubscription/existing-1",
              topic: "ORDERS_CREATE",
              apiVersion: { handle: "2026-01" },
              endpoint: { __typename: "WebhookHttpEndpoint", callbackUrl: CALLBACK },
            },
          },
          {
            node: {
              id: "gid://shopify/WebhookSubscription/existing-2",
              topic: "INVENTORY_LEVELS_UPDATE",
              apiVersion: { handle: "2026-01" },
              endpoint: { __typename: "WebhookHttpEndpoint", callbackUrl: CALLBACK },
            },
          },
        ],
      },
    });
    // Only ORDERS_CANCELLED + REFUNDS_CREATE will be created
    mockedGraphQL.mockResolvedValueOnce({
      webhookSubscriptionCreate: {
        webhookSubscription: {
          id: "gid://shopify/WebhookSubscription/new-cancelled",
          topic: "ORDERS_CANCELLED",
          apiVersion: { handle: "2026-01" },
          endpoint: { __typename: "WebhookHttpEndpoint", callbackUrl: CALLBACK },
        },
        userErrors: [],
      },
    });
    mockedGraphQL.mockResolvedValueOnce({
      webhookSubscriptionCreate: {
        webhookSubscription: {
          id: "gid://shopify/WebhookSubscription/new-refunds",
          topic: "REFUNDS_CREATE",
          apiVersion: { handle: "2026-01" },
          endpoint: { __typename: "WebhookHttpEndpoint", callbackUrl: CALLBACK },
        },
        userErrors: [],
      },
    });

    const result = await registerWebhookSubscriptions(CTX, CALLBACK);

    expect(result.failed).toHaveLength(0);
    expect(result.registered).toHaveLength(4);
    const reusedMap = Object.fromEntries(result.registered.map((r) => [r.topic, r.reused]));
    expect(reusedMap["orders/create"]).toBe(true);
    expect(reusedMap["inventory_levels/update"]).toBe(true);
    expect(reusedMap["orders/cancelled"]).toBe(false);
    expect(reusedMap["refunds/create"]).toBe(false);
    // 1 list + 2 creates (the other 2 reused, no GraphQL call)
    expect(mockedGraphQL).toHaveBeenCalledTimes(3);
  });

  it("captures userErrors into failed[] without aborting later topics", async () => {
    mockedGraphQL.mockResolvedValueOnce({
      webhookSubscriptions: { edges: [] },
    });
    // First topic fails with userErrors
    mockedGraphQL.mockResolvedValueOnce({
      webhookSubscriptionCreate: {
        webhookSubscription: null,
        userErrors: [
          {
            field: ["webhookSubscription", "callbackUrl"],
            message: "URL is invalid for this topic",
          },
        ],
      },
    });
    // Remaining 3 succeed
    for (const topic of ["ORDERS_CREATE", "ORDERS_CANCELLED", "REFUNDS_CREATE"] as const) {
      mockedGraphQL.mockResolvedValueOnce({
        webhookSubscriptionCreate: {
          webhookSubscription: {
            id: `gid://shopify/WebhookSubscription/${topic}`,
            topic,
            apiVersion: { handle: "2026-01" },
            endpoint: { __typename: "WebhookHttpEndpoint", callbackUrl: CALLBACK },
          },
          userErrors: [],
        },
      });
    }

    const result = await registerWebhookSubscriptions(CTX, CALLBACK);

    expect(result.registered).toHaveLength(3);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]).toMatchObject({
      topic: "inventory_levels/update",
      callbackUrl: CALLBACK,
    });
    expect(result.failed[0].error).toContain("URL is invalid for this topic");
  });

  it("captures transport throws on a single topic into failed[] without aborting", async () => {
    mockedGraphQL.mockResolvedValueOnce({
      webhookSubscriptions: { edges: [] },
    });
    mockedGraphQL.mockResolvedValueOnce({
      webhookSubscriptionCreate: {
        webhookSubscription: {
          id: "gid://shopify/WebhookSubscription/inv",
          topic: "INVENTORY_LEVELS_UPDATE",
          apiVersion: { handle: "2026-01" },
          endpoint: { __typename: "WebhookHttpEndpoint", callbackUrl: CALLBACK },
        },
        userErrors: [],
      },
    });
    // ORDERS_CREATE throws
    mockedGraphQL.mockRejectedValueOnce(new Error("Network blip"));
    // remaining 2 succeed
    for (const topic of ["ORDERS_CANCELLED", "REFUNDS_CREATE"] as const) {
      mockedGraphQL.mockResolvedValueOnce({
        webhookSubscriptionCreate: {
          webhookSubscription: {
            id: `gid://shopify/WebhookSubscription/${topic}`,
            topic,
            apiVersion: { handle: "2026-01" },
            endpoint: { __typename: "WebhookHttpEndpoint", callbackUrl: CALLBACK },
          },
          userErrors: [],
        },
      });
    }

    const result = await registerWebhookSubscriptions(CTX, CALLBACK);

    expect(result.registered).toHaveLength(3);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]).toMatchObject({
      topic: "orders/create",
      callbackUrl: CALLBACK,
    });
    expect(result.failed[0].error).toContain("Network blip");
  });

  it("ignores existing subscriptions targeting a different callbackUrl", async () => {
    // Pre-existing orders/create lives at a stale URL, so we must create a
    // fresh subscription at the new callbackUrl. (This is the
    // post-NEXT_PUBLIC_APP_URL-rotation case.)
    mockedGraphQL.mockResolvedValueOnce({
      webhookSubscriptions: {
        edges: [
          {
            node: {
              id: "gid://shopify/WebhookSubscription/stale",
              topic: "ORDERS_CREATE",
              apiVersion: { handle: "2026-01" },
              endpoint: {
                __typename: "WebhookHttpEndpoint",
                callbackUrl: "https://stale.example.com/wh",
              },
            },
          },
        ],
      },
    });
    for (const topic of SHOPIFY_REQUIRED_WEBHOOK_TOPICS) {
      mockedGraphQL.mockResolvedValueOnce({
        webhookSubscriptionCreate: {
          webhookSubscription: {
            id: `gid://shopify/WebhookSubscription/${topic}-fresh`,
            topic,
            apiVersion: { handle: "2026-01" },
            endpoint: { __typename: "WebhookHttpEndpoint", callbackUrl: CALLBACK },
          },
          userErrors: [],
        },
      });
    }

    const result = await registerWebhookSubscriptions(CTX, CALLBACK);

    expect(result.registered).toHaveLength(4);
    expect(result.registered.every((r) => r.reused === false)).toBe(true);
    expect(result.failed).toHaveLength(0);
  });
});

// ─── persistWebhookRegistrationMetadata ──────────────────────────────────────
//
// Verifies the shared metadata-merge helper used by both the staff-manual
// "Register webhooks" Server Action and the /api/oauth/shopify auto-register
// hook. The two entry points MUST persist identical shapes.

describe("persistWebhookRegistrationMetadata", () => {
  type Captured = { table: string; values: Record<string, unknown>; eqArgs: [string, unknown] };

  function makeMockSupabase(initialMetadata: unknown) {
    const captured: { update?: Captured } = {};
    const supabase = {
      from(table: string) {
        return {
          select() {
            return {
              eq() {
                return {
                  maybeSingle: async () => ({
                    data: { metadata: initialMetadata },
                    error: null,
                  }),
                };
              },
            };
          },
          update(values: Record<string, unknown>) {
            return {
              eq(col: string, value: unknown) {
                captured.update = { table, values, eqArgs: [col, value] };
                return Promise.resolve({ error: null });
              },
            };
          },
        };
      },
    };
    return { supabase: supabase as never, captured };
  }

  function buildResult(): RegisterWebhookSubscriptionsResult {
    return {
      registered: [
        {
          id: "gid://shopify/WebhookSubscription/1",
          topic: "orders/create",
          apiVersion: "2026-01",
          callbackUrl: CALLBACK,
          reused: false,
        },
        {
          id: "gid://shopify/WebhookSubscription/2",
          topic: "orders/cancelled",
          apiVersion: "2026-01",
          callbackUrl: CALLBACK,
          reused: true,
        },
      ],
      failed: [],
    };
  }

  it("merges into existing metadata without clobbering unrelated keys", async () => {
    const { supabase, captured } = makeMockSupabase({
      channel_sync_state: { last_run: "2026-04-19T00:00:00.000Z" },
      do_not_fanout_audit: ["staff_user_1"],
    });

    const out = await persistWebhookRegistrationMetadata(
      supabase,
      "conn-1",
      buildResult(),
      CALLBACK,
    );

    expect(out.apiVersionPinned).toBe("2026-01");
    expect(out.apiVersionDrift).toBe(false);
    expect(captured.update).toBeDefined();
    expect(captured.update?.table).toBe("client_store_connections");
    expect(captured.update?.eqArgs).toEqual(["id", "conn-1"]);
    const meta = captured.update?.values.metadata as Record<string, unknown>;
    expect(meta.channel_sync_state).toEqual({ last_run: "2026-04-19T00:00:00.000Z" });
    expect(meta.do_not_fanout_audit).toEqual(["staff_user_1"]);
    expect(meta.webhook_callback_url).toBe(CALLBACK);
    expect(Array.isArray(meta.webhook_subscriptions)).toBe(true);
    expect(meta.webhook_register_failures).toBeUndefined();
  });

  it("flags apiVersionDrift when subscriptions disagree on apiVersion", async () => {
    const { supabase } = makeMockSupabase(null);
    const result: RegisterWebhookSubscriptionsResult = {
      registered: [
        {
          id: "1",
          topic: "orders/create",
          apiVersion: "2026-01",
          callbackUrl: CALLBACK,
          reused: false,
        },
        {
          id: "2",
          topic: "orders/cancelled",
          apiVersion: "2025-10",
          callbackUrl: CALLBACK,
          reused: false,
        },
      ],
      failed: [],
    };

    const out = await persistWebhookRegistrationMetadata(supabase, "conn-1", result, CALLBACK);

    expect(out.apiVersionDrift).toBe(true);
    expect(out.apiVersionPinned).toBe("2026-01");
  });

  it("persists shopifyScopes + appDistribution + installedAt extras", async () => {
    const { supabase, captured } = makeMockSupabase(null);

    await persistWebhookRegistrationMetadata(supabase, "conn-1", buildResult(), CALLBACK, {
      shopifyScopes: ["read_inventory", "write_inventory"],
      appDistribution: "custom",
      installedAt: null,
    });

    const meta = captured.update?.values.metadata as Record<string, unknown>;
    expect(meta.shopify_scopes).toEqual(["read_inventory", "write_inventory"]);
    expect(meta.app_distribution).toBe("custom");
    expect(typeof meta.installed_at).toBe("string");
  });

  it("B-3 / HRD-14 — diffWebhookSubscriptions classifies create / recreate / delete / in-sync", () => {
    const desired = "https://app.example.com/api/webhooks/shopify/orders";
    const stale = "https://old.example.com/hooks/orders";
    const current: WebhookSubscriptionRecord[] = [
      // exact match → in-sync
      {
        id: "gid://1",
        topic: "orders/create",
        apiVersion: "2026-01",
        callbackUrl: desired,
        reused: true,
      },
      // required topic, callback drift → recreate
      {
        id: "gid://2",
        topic: "orders/cancelled",
        apiVersion: "2026-01",
        callbackUrl: stale,
        reused: true,
      },
      // not in required set → delete
      {
        id: "gid://3",
        topic: "products/update",
        apiVersion: "2026-01",
        callbackUrl: desired,
        reused: true,
      },
      // also matches → in-sync
      {
        id: "gid://4",
        topic: "refunds/create",
        apiVersion: "2026-01",
        callbackUrl: desired,
        reused: true,
      },
      // inventory_levels/update is missing entirely → toCreate
    ];

    const diff = diffWebhookSubscriptions({ current, desiredCallbackUrl: desired });

    expect(diff.toCreate).toEqual(["inventory_levels/update"]);
    expect(diff.toRecreate.map((r) => r.id)).toEqual(["gid://2"]);
    expect(diff.toDelete.map((r) => r.id)).toEqual(["gid://3"]);
    expect(diff.inSync.map((r) => r.id).sort()).toEqual(["gid://1", "gid://4"]);
  });

  it("B-3 — diffWebhookSubscriptions on empty current list creates all 4 required topics", () => {
    const desired = "https://app.example.com/api/webhooks/shopify/orders";
    const diff = diffWebhookSubscriptions({ current: [], desiredCallbackUrl: desired });

    expect(diff.toCreate).toHaveLength(4);
    expect(diff.toCreate).toContain("inventory_levels/update");
    expect(diff.toCreate).toContain("orders/create");
    expect(diff.toCreate).toContain("orders/cancelled");
    expect(diff.toCreate).toContain("refunds/create");
    expect(diff.toRecreate).toEqual([]);
    expect(diff.toDelete).toEqual([]);
    expect(diff.inSync).toEqual([]);
  });

  it("B-3 — diffWebhookSubscriptions on perfectly-aligned set produces zero churn", () => {
    const desired = "https://app.example.com/api/webhooks/shopify/orders";
    const current: WebhookSubscriptionRecord[] = SHOPIFY_REQUIRED_WEBHOOK_TOPICS.map((t, i) => ({
      id: `gid://${i}`,
      topic: topicEnumToRest(t),
      apiVersion: "2026-01",
      callbackUrl: desired,
      reused: true,
    }));

    const diff = diffWebhookSubscriptions({ current, desiredCallbackUrl: desired });

    expect(diff.toCreate).toEqual([]);
    expect(diff.toRecreate).toEqual([]);
    expect(diff.toDelete).toEqual([]);
    expect(diff.inSync).toHaveLength(4);
  });

  it("includes webhook_register_failures when failed[] non-empty", async () => {
    const { supabase, captured } = makeMockSupabase(null);
    const result: RegisterWebhookSubscriptionsResult = {
      registered: buildResult().registered,
      failed: [
        {
          topic: "refunds/create",
          callbackUrl: CALLBACK,
          error: "URL invalid for this topic",
        },
      ],
    };

    await persistWebhookRegistrationMetadata(supabase, "conn-1", result, CALLBACK);

    const meta = captured.update?.values.metadata as Record<string, unknown>;
    expect(meta.webhook_register_failures).toEqual([
      { topic: "refunds/create", callbackUrl: CALLBACK, error: "URL invalid for this topic" },
    ]);
  });
});
