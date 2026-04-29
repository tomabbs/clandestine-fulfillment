/**
 * Order Pages Transition Phase 1 — pure resolver contract tests.
 *
 * Includes the Northern Spy umbrella connection fixture (Egghunt + NNA +
 * Across) that the cross-plan dependency on the SKU Matching plan
 * explicitly references. The fixture is the canonical multi-org coverage
 * shape — one connection covering several orgs — and the test suite must
 * keep proving that identity v2 keys on connection_id, NOT org_id.
 */
import { describe, expect, it } from "vitest";
import { buildIdempotencyKeyV2, resolveOrderIdentityV2 } from "@/lib/server/order-identity-v2";

const SHOPIFY_STORE = "northern-spy.myshopify.com";

const NORTHERN_SPY_UMBRELLA_CANDIDATES = [
  // Egghunt + NNA + Across all share ONE umbrella shopify connection.
  // Identity v2 must NOT split this single row into per-org variants.
  { id: "conn-northern-spy-umbrella", storeKey: SHOPIFY_STORE, isActive: true },
];

describe("resolveOrderIdentityV2 — shopify happy path (single candidate)", () => {
  it("Northern Spy umbrella: deterministic resolution to the single connection", () => {
    const decision = resolveOrderIdentityV2({
      platform: "shopify",
      rawStoreKey: `https://${SHOPIFY_STORE.toUpperCase()}/`,
      externalOrderId: "gid://shopify/Order/1",
      candidateConnections: NORTHERN_SPY_UMBRELLA_CANDIDATES,
    });
    expect(decision.status).toBe("deterministic");
    expect(decision.connectionId).toBe("conn-northern-spy-umbrella");
    expect(decision.ingestionIdempotencyKeyV2).toBe(
      "shopify:conn-northern-spy-umbrella:gid://shopify/Order/1",
    );
    expect(decision.reviewReason).toBeUndefined();
  });
});

describe("resolveOrderIdentityV2 — multiple candidates → ambiguous", () => {
  const candidates = [
    { id: "conn-a", storeKey: SHOPIFY_STORE, isActive: true },
    { id: "conn-b", storeKey: SHOPIFY_STORE, isActive: true },
  ];

  it("returns ambiguous when no live verification provided", () => {
    const decision = resolveOrderIdentityV2({
      platform: "shopify",
      rawStoreKey: SHOPIFY_STORE,
      externalOrderId: "gid://shopify/Order/2",
      candidateConnections: candidates,
    });
    expect(decision.status).toBe("ambiguous");
    expect(decision.connectionId).toBeNull();
    expect(decision.reviewReason).toBe("multiple_candidate_connections");
    expect(decision.reviewCandidateConnectionIds?.sort()).toEqual(["conn-a", "conn-b"]);
  });

  it("narrows to deterministic when live verification confirms one", () => {
    const decision = resolveOrderIdentityV2({
      platform: "shopify",
      rawStoreKey: SHOPIFY_STORE,
      externalOrderId: "gid://shopify/Order/2",
      candidateConnections: candidates,
      liveApiVerification: {
        status: "ok",
        confirmedConnectionId: "conn-b",
      },
    });
    expect(decision.status).toBe("deterministic");
    expect(decision.connectionId).toBe("conn-b");
  });

  it("ignores confirmedConnectionId when not in candidate set (defense in depth)", () => {
    const decision = resolveOrderIdentityV2({
      platform: "shopify",
      rawStoreKey: SHOPIFY_STORE,
      externalOrderId: "gid://shopify/Order/2",
      candidateConnections: candidates,
      liveApiVerification: {
        status: "ok",
        confirmedConnectionId: "conn-not-in-candidate-set",
      },
    });
    expect(decision.status).toBe("ambiguous");
  });

  it("returns live_api_verification_failed when verifier reported failure", () => {
    const decision = resolveOrderIdentityV2({
      platform: "shopify",
      rawStoreKey: SHOPIFY_STORE,
      externalOrderId: "gid://shopify/Order/2",
      candidateConnections: candidates,
      liveApiVerification: {
        status: "failed",
        errorCode: "shopify_404",
      },
    });
    expect(decision.status).toBe("live_api_verification_failed");
    expect(decision.reviewReason).toBe("live_api_verification_failed");
    expect((decision.notes as Record<string, unknown>).errorCode).toBe("shopify_404");
  });
});

describe("resolveOrderIdentityV2 — no candidate", () => {
  it("returns unresolved with no_candidate_connection review reason", () => {
    const decision = resolveOrderIdentityV2({
      platform: "shopify",
      rawStoreKey: SHOPIFY_STORE,
      externalOrderId: "gid://shopify/Order/3",
      candidateConnections: [],
    });
    expect(decision.status).toBe("unresolved");
    expect(decision.reviewReason).toBe("no_candidate_connection");
  });
});

describe("resolveOrderIdentityV2 — bandcamp", () => {
  it("always returns bandcamp_legacy_null without writing v2 keys", () => {
    const decision = resolveOrderIdentityV2({
      platform: "bandcamp",
      rawStoreKey: "northern-spy",
      externalOrderId: "12345",
      candidateConnections: [],
    });
    expect(decision.status).toBe("bandcamp_legacy_null");
    expect(decision.connectionId).toBeNull();
    expect(decision.ingestionIdempotencyKeyV2).toBeNull();
    expect(decision.reviewReason).toBeUndefined();
  });
});

describe("resolveOrderIdentityV2 — bad store key", () => {
  it("surfaces normalization failure as platform_unsupported review reason", () => {
    const decision = resolveOrderIdentityV2({
      platform: "shopify",
      rawStoreKey: "not-a-shopify-domain.com",
      externalOrderId: "x",
      candidateConnections: [],
    });
    expect(decision.status).toBe("unresolved");
    expect(decision.reviewReason).toBe("platform_unsupported");
    expect((decision.notes as Record<string, unknown>).normalizationError).toMatch(/myshopify/);
  });
});

describe("buildIdempotencyKeyV2", () => {
  it("composes the canonical key", () => {
    expect(
      buildIdempotencyKeyV2({
        platform: "woocommerce",
        connectionId: "conn-1",
        externalOrderId: "9001",
      }),
    ).toBe("woocommerce:conn-1:9001");
  });

  it("rejects empty externalOrderId", () => {
    expect(() =>
      buildIdempotencyKeyV2({
        platform: "shopify",
        connectionId: "conn-1",
        externalOrderId: "",
      }),
    ).toThrow();
  });
});
