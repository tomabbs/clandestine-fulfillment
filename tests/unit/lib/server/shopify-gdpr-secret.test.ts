/**
 * Phase 0 / §9.1 D6 — `resolveShopifyGdprWebhookSecrets` tests.
 *
 * Pins the contract:
 *   1. Per-connection secret(s) appear FIRST in the candidate list.
 *      Env fallback appears LAST. Order matters — see resolver doc.
 *   2. RELEASE-GATE: at least one candidate is non-empty whenever
 *      either an active connection has `shopify_app_client_secret_encrypted`
 *      OR `env.SHOPIFY_CLIENT_SECRET` is set. (This is the "GDPR webhooks
 *      stay verifiable through cutover" guarantee.)
 *   3. The shop domain is normalized (lowercase, protocol stripped).
 *   4. Multiple connections for the same domain (shadow + active during
 *      Phase 5 cutover) all contribute candidates.
 *   5. Duplicate secrets are deduped.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockServiceFrom, mockEnv } = vi.hoisted(() => ({
  mockServiceFrom: vi.fn(),
  mockEnv: vi.fn(),
}));

vi.mock("@/lib/server/supabase-server", () => ({
  createServiceRoleClient: () => ({ from: mockServiceFrom }),
}));

vi.mock("@/lib/shared/env", () => ({
  env: () => mockEnv(),
}));

import { resolveShopifyGdprWebhookSecrets } from "@/lib/server/shopify-gdpr-secret";

function mockConnections(rows: Array<{ shopify_app_client_secret_encrypted: string | null }>) {
  mockServiceFrom.mockImplementation((table: string) => {
    if (table === "client_store_connections") {
      return {
        select: () => ({
          eq: () => ({
            ilike: () => Promise.resolve({ data: rows, error: null }),
          }),
        }),
      };
    }
    throw new Error(`unexpected table: ${table}`);
  });
}

function makeReq(headers: Record<string, string>) {
  return new Request("https://example.com/api/webhooks/shopify/gdpr", {
    method: "POST",
    headers,
  });
}

describe("resolveShopifyGdprWebhookSecrets", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("orders per-connection candidates BEFORE env fallback", async () => {
    mockEnv.mockReturnValue({ SHOPIFY_CLIENT_SECRET: "env_secret" });
    mockConnections([{ shopify_app_client_secret_encrypted: "per_conn_secret" }]);

    const result = await resolveShopifyGdprWebhookSecrets(
      makeReq({ "X-Shopify-Shop-Domain": "shop.myshopify.com" }),
    );
    expect(result.candidates).toEqual(["per_conn_secret", "env_secret"]);
    expect(result.sources).toEqual(["per_connection", "env_fallback"]);
  });

  it("includes multiple per-connection secrets (shadow + active during cutover)", async () => {
    mockEnv.mockReturnValue({ SHOPIFY_CLIENT_SECRET: "env_secret" });
    mockConnections([
      { shopify_app_client_secret_encrypted: "shadow_secret" },
      { shopify_app_client_secret_encrypted: "active_secret" },
    ]);

    const result = await resolveShopifyGdprWebhookSecrets(
      makeReq({ "X-Shopify-Shop-Domain": "shop.myshopify.com" }),
    );
    expect(result.candidates).toEqual(["shadow_secret", "active_secret", "env_secret"]);
  });

  it("dedupes identical secrets (legacy clone of the env secret on a connection row)", async () => {
    mockEnv.mockReturnValue({ SHOPIFY_CLIENT_SECRET: "shared_secret" });
    mockConnections([{ shopify_app_client_secret_encrypted: "shared_secret" }]);

    const result = await resolveShopifyGdprWebhookSecrets(
      makeReq({ "X-Shopify-Shop-Domain": "shop.myshopify.com" }),
    );
    expect(result.candidates).toEqual(["shared_secret"]);
  });

  it("normalizes the shop domain (lowercase, strips protocol/path)", async () => {
    mockEnv.mockReturnValue({ SHOPIFY_CLIENT_SECRET: "" });
    mockConnections([]);

    const result = await resolveShopifyGdprWebhookSecrets(
      makeReq({ "X-Shopify-Shop-Domain": "HTTPS://Shop.MyShopify.Com/admin" }),
    );
    expect(result.shopDomain).toBe("shop.myshopify.com");
  });

  it("returns env-only candidate when no shop domain header is present (legacy probes)", async () => {
    mockEnv.mockReturnValue({ SHOPIFY_CLIENT_SECRET: "env_secret" });
    mockConnections([]);

    const result = await resolveShopifyGdprWebhookSecrets(makeReq({}));
    expect(result.candidates).toEqual(["env_secret"]);
    expect(result.shopDomain).toBeNull();
  });

  it("returns ZERO candidates when env is empty AND no per-connection secret matches", async () => {
    mockEnv.mockReturnValue({ SHOPIFY_CLIENT_SECRET: "" });
    mockConnections([{ shopify_app_client_secret_encrypted: null }]);

    const result = await resolveShopifyGdprWebhookSecrets(
      makeReq({ "X-Shopify-Shop-Domain": "shop.myshopify.com" }),
    );
    expect(result.candidates).toEqual([]);
  });

  // ─── RELEASE GATE (Phase 0 / §9.1 D6) ────────────────────────────────
  // If this test fails in CI, it means a Shopify GDPR webhook for a
  // configured connection would arrive with no validatable secret — App
  // Store rejects this on next review. Block the merge.
  it("RELEASE GATE: any connection with a per-connection app secret produces ≥1 non-empty candidate", async () => {
    mockEnv.mockReturnValue({ SHOPIFY_CLIENT_SECRET: "" });
    mockConnections([{ shopify_app_client_secret_encrypted: "real_secret_xyz" }]);

    const result = await resolveShopifyGdprWebhookSecrets(
      makeReq({ "X-Shopify-Shop-Domain": "shop.myshopify.com" }),
    );
    expect(result.candidates.length).toBeGreaterThanOrEqual(1);
    expect(result.candidates[0]).not.toBe("");
  });

  it("RELEASE GATE: env secret alone is sufficient to verify (legacy path still works)", async () => {
    mockEnv.mockReturnValue({ SHOPIFY_CLIENT_SECRET: "legacy_env_secret" });
    mockConnections([]);

    const result = await resolveShopifyGdprWebhookSecrets(
      makeReq({ "X-Shopify-Shop-Domain": "shop.myshopify.com" }),
    );
    expect(result.candidates).toEqual(["legacy_env_secret"]);
  });
});
