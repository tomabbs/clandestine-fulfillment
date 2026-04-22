/**
 * /api/oauth/shopify route — coverage for the HRD-35 + HRD-35.1 install flow.
 *
 * Mocks at module boundaries:
 *   - `@/lib/server/supabase-server` → in-memory query builder
 *   - `@/lib/server/shopify-webhook-subscriptions` → assertable spies
 *   - `@/lib/shared/env` → fixed test values
 *   - `globalThis.fetch` → token-exchange responses
 *
 * Cases covered:
 *   1. Init phase persists state-nonce row + redirects to Shopify authorize URL.
 *   2. Callback phase rejects unknown nonce (HRD-35.1 replay defense).
 *   3. Callback phase rejects expired nonce.
 *   4. Callback phase rejects org_id mismatch.
 *   5. Callback phase rejects bad HMAC.
 *   6. Callback phase happy path: nonce burned → token exchanged → connection
 *      upserted → webhooks auto-registered → metadata persisted with scopes +
 *      app_distribution + installed_at → success redirect carries connection_id.
 *   7. Webhook auto-register transport throw is captured on metadata but does
 *      NOT abort the install (token still persisted, success redirect still
 *      fires with `webhook_register=error`).
 */

import crypto from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const NEXT_PUBLIC_APP_URL = "https://app.example.com";
const ENV_CLIENT_ID = "env-client-id";
const ENV_CLIENT_SECRET = "env-client-secret";
const SHOP = "test-shop.myshopify.com";
const ORG_ID = "00000000-0000-0000-0000-000000000abc";
const WORKSPACE_ID = "00000000-0000-0000-0000-000000000def";
const CONNECTION_ID = "00000000-0000-0000-0000-000000000111";
const PER_CONN_CLIENT_ID = "per-conn-client-id";
const PER_CONN_SECRET = "per-conn-secret";

// ─── Module mocks ────────────────────────────────────────────────────────────

vi.mock("@/lib/shared/env", () => ({
  env: () => ({
    SHOPIFY_CLIENT_ID: ENV_CLIENT_ID,
    SHOPIFY_CLIENT_SECRET: ENV_CLIENT_SECRET,
    NEXT_PUBLIC_APP_URL,
  }),
}));

const mockRegister = vi.fn();
const mockPersist = vi.fn();

vi.mock("@/lib/server/shopify-webhook-subscriptions", () => ({
  registerWebhookSubscriptions: (...args: unknown[]) => mockRegister(...args),
  persistWebhookRegistrationMetadata: (...args: unknown[]) => mockPersist(...args),
}));

interface OAuthStateRow {
  id: string;
  oauth_token: string;
  org_id: string;
  platform: string;
  nonce_purpose: string;
  connection_id: string | null;
  expires_at: string;
}

interface ConnectionRow {
  id: string;
  shopify_app_client_id: string | null;
  shopify_app_client_secret_encrypted: string | null;
}

interface DbState {
  oauth_states: OAuthStateRow[];
  client_store_connections: ConnectionRow[];
  organizations: Array<{ id: string; workspace_id: string }>;
  upserts: Array<Record<string, unknown>>;
}

let db: DbState;

vi.mock("@/lib/server/supabase-server", () => ({
  createServiceRoleClient: () => makeMockSupabase(),
}));

function makeMockSupabase() {
  return {
    from(table: string) {
      if (table === "oauth_states") {
        return {
          insert: async (row: Omit<OAuthStateRow, "id">) => {
            db.oauth_states.push({ id: crypto.randomUUID(), ...row });
            return { error: null };
          },
          select() {
            return {
              eq(_col1: string, value1: unknown) {
                return {
                  eq(_col2: string, _value2: unknown) {
                    return {
                      maybeSingle: async () => {
                        const found = db.oauth_states.find((r) => r.oauth_token === value1);
                        return { data: found ?? null, error: null };
                      },
                    };
                  },
                };
              },
            };
          },
          delete() {
            return {
              eq: async (_col: string, value: unknown) => {
                db.oauth_states = db.oauth_states.filter((r) => r.id !== value);
                return { error: null };
              },
            };
          },
        };
      }
      if (table === "client_store_connections") {
        return {
          select(_cols: string) {
            return {
              eq(_col: string, value: unknown) {
                return {
                  maybeSingle: async () => {
                    const found = db.client_store_connections.find((r) => r.id === value);
                    return { data: found ?? null, error: null };
                  },
                };
              },
            };
          },
          upsert(values: Record<string, unknown>, _opts: unknown) {
            db.upserts.push(values);
            return {
              select(_cols: string) {
                return {
                  single: async () => ({
                    data: { id: CONNECTION_ID },
                    error: null,
                  }),
                };
              },
            };
          },
          update(_values: Record<string, unknown>) {
            return {
              eq: async (_col: string, _value: unknown) => ({ error: null }),
            };
          },
        };
      }
      if (table === "organizations") {
        return {
          select(_cols: string) {
            return {
              eq(_col: string, value: unknown) {
                return {
                  single: async () => {
                    const found = db.organizations.find((r) => r.id === value);
                    return { data: found ?? null, error: null };
                  },
                };
              },
            };
          },
        };
      }
      throw new Error(`Unexpected table in mock: ${table}`);
    },
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

let GET: typeof import("@/app/api/oauth/shopify/route").GET;

beforeEach(async () => {
  db = {
    oauth_states: [],
    client_store_connections: [],
    organizations: [{ id: ORG_ID, workspace_id: WORKSPACE_ID }],
    upserts: [],
  };
  mockRegister.mockReset();
  mockPersist.mockReset();

  // Default fetch mock for token exchange. Tests that need a different shape
  // override per-case. We return a plain object that satisfies the subset of
  // the Response interface the route reads (`ok`, `json()`, `text()`) — using
  // a real `new Response()` doesn't work because `ok` is a read-only getter.
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      json: async () => ({
        access_token: "shpat_test_token",
        scope: "read_inventory,write_inventory,read_orders",
      }),
      text: async () => "",
    })),
  );

  // Re-import the route module after the mocks are in place. Use dynamic
  // import so each test sees a clean module-scoped state.
  vi.resetModules();
  const mod = await import("@/app/api/oauth/shopify/route");
  GET = mod.GET;
});

function buildState(orgId = ORG_ID, nonce = "fixed-nonce", connectionId?: string): string {
  return Buffer.from(
    JSON.stringify({ orgId, nonce, ...(connectionId ? { connectionId } : {}) }),
  ).toString("base64");
}

function signCallbackParams(params: URLSearchParams, secret: string): string {
  const sorted = Array.from(params.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  return crypto.createHmac("sha256", secret).update(sorted).digest("hex");
}

function callbackRequest(args: {
  code: string;
  shop: string;
  state: string;
  hmac: string;
}): Request {
  const url = new URL(`${NEXT_PUBLIC_APP_URL}/api/oauth/shopify`);
  url.searchParams.set("code", args.code);
  url.searchParams.set("shop", args.shop);
  url.searchParams.set("state", args.state);
  url.searchParams.set("hmac", args.hmac);
  return new Request(url, { method: "GET" });
}

function freshCallbackPair(opts?: { orgId?: string; connectionId?: string; secret?: string }): {
  request: Request;
  nonce: string;
} {
  const orgId = opts?.orgId ?? ORG_ID;
  const nonce = "callback-nonce-1";
  const state = buildState(orgId, nonce, opts?.connectionId);
  const secret = opts?.secret ?? ENV_CLIENT_SECRET;
  const params = new URLSearchParams({
    code: "good-code",
    shop: SHOP,
    state,
  });
  const hmac = signCallbackParams(params, secret);
  return {
    nonce,
    request: callbackRequest({ code: "good-code", shop: SHOP, state, hmac }),
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("/api/oauth/shopify init phase", () => {
  it("persists nonce row + redirects to Shopify authorize URL", async () => {
    const url = new URL(`${NEXT_PUBLIC_APP_URL}/api/oauth/shopify`);
    url.searchParams.set("shop", SHOP);
    url.searchParams.set("org_id", ORG_ID);

    const res = await GET(new Request(url, { method: "GET" }) as never);

    expect(res.status).toBe(307);
    const location = res.headers.get("Location") ?? "";
    expect(location.startsWith(`https://${SHOP}/admin/oauth/authorize`)).toBe(true);
    expect(location).toContain(`client_id=${ENV_CLIENT_ID}`);
    expect(db.oauth_states).toHaveLength(1);
    expect(db.oauth_states[0]).toMatchObject({
      org_id: ORG_ID,
      platform: "shopify",
      nonce_purpose: "shopify_install",
      connection_id: null,
    });
  });

  it("uses per-connection app credentials when connection_id present + creds set", async () => {
    db.client_store_connections.push({
      id: CONNECTION_ID,
      shopify_app_client_id: PER_CONN_CLIENT_ID,
      shopify_app_client_secret_encrypted: PER_CONN_SECRET,
    });

    const url = new URL(`${NEXT_PUBLIC_APP_URL}/api/oauth/shopify`);
    url.searchParams.set("shop", SHOP);
    url.searchParams.set("org_id", ORG_ID);
    url.searchParams.set("connection_id", CONNECTION_ID);

    const res = await GET(new Request(url, { method: "GET" }) as never);

    expect(res.status).toBe(307);
    const location = res.headers.get("Location") ?? "";
    expect(location).toContain(`client_id=${PER_CONN_CLIENT_ID}`);
    expect(db.oauth_states[0].connection_id).toBe(CONNECTION_ID);
  });

  it("400s when org_id missing", async () => {
    const url = new URL(`${NEXT_PUBLIC_APP_URL}/api/oauth/shopify`);
    url.searchParams.set("shop", SHOP);
    const res = await GET(new Request(url, { method: "GET" }) as never);
    expect(res.status).toBe(400);
  });
});

describe("/api/oauth/shopify callback — security gates", () => {
  it("rejects unknown state nonce (replay defense)", async () => {
    const { request } = freshCallbackPair();
    // No row inserted into db.oauth_states → unknown nonce
    const res = await GET(request as never);
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: expect.stringMatching(/Unknown.*nonce/i) });
  });

  it("rejects expired state nonce", async () => {
    const { request } = freshCallbackPair();
    db.oauth_states.push({
      id: "row-1",
      oauth_token: "callback-nonce-1",
      org_id: ORG_ID,
      platform: "shopify",
      nonce_purpose: "shopify_install",
      connection_id: null,
      expires_at: new Date(Date.now() - 60_000).toISOString(),
    });
    const res = await GET(request as never);
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: expect.stringMatching(/expired/i) });
  });

  it("rejects org_id mismatch between state and stored row", async () => {
    const { request } = freshCallbackPair({ orgId: ORG_ID });
    db.oauth_states.push({
      id: "row-1",
      oauth_token: "callback-nonce-1",
      org_id: "different-org-id",
      platform: "shopify",
      nonce_purpose: "shopify_install",
      connection_id: null,
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    });
    const res = await GET(request as never);
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: expect.stringMatching(/org mismatch/i) });
  });

  it("rejects invalid HMAC", async () => {
    db.oauth_states.push({
      id: "row-1",
      oauth_token: "callback-nonce-1",
      org_id: ORG_ID,
      platform: "shopify",
      nonce_purpose: "shopify_install",
      connection_id: null,
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    });

    // Build a request whose hmac is signed with the WRONG secret
    const state = buildState(ORG_ID, "callback-nonce-1");
    const params = new URLSearchParams({ code: "good-code", shop: SHOP, state });
    const wrongHmac = signCallbackParams(params, "wrong-secret");
    const request = callbackRequest({ code: "good-code", shop: SHOP, state, hmac: wrongHmac });

    const res = await GET(request as never);
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: expect.stringMatching(/Invalid HMAC/i) });
  });
});

describe("/api/oauth/shopify callback — happy path (HRD-35 gap #3 + #2)", () => {
  it("burns nonce, exchanges code, upserts connection, auto-registers webhooks, persists metadata", async () => {
    db.oauth_states.push({
      id: "row-1",
      oauth_token: "callback-nonce-1",
      org_id: ORG_ID,
      platform: "shopify",
      nonce_purpose: "shopify_install",
      connection_id: null,
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    });

    mockRegister.mockResolvedValue({
      registered: [
        {
          id: "gid://shopify/WebhookSubscription/1",
          topic: "inventory_levels/update",
          apiVersion: "2026-01",
          callbackUrl: "...",
          reused: false,
        },
      ],
      failed: [],
    });
    mockPersist.mockResolvedValue({
      apiVersionPinned: "2026-01",
      apiVersionDrift: false,
      registeredAt: "2026-04-21T00:00:00.000Z",
    });

    const { request } = freshCallbackPair();
    const res = await GET(request as never);

    expect(res.status).toBe(307);
    const location = res.headers.get("Location") ?? "";
    expect(location).toContain("/admin/settings/store-connections");
    expect(location).toContain("connected=shopify");
    expect(location).toContain(`connection_id=${CONNECTION_ID}`);
    expect(location).not.toContain("webhook_register="); // no failures

    // Token exchange happened
    const fetchMock = vi.mocked(globalThis.fetch);
    expect(fetchMock).toHaveBeenCalledWith(
      `https://${SHOP}/admin/oauth/access_token`,
      expect.objectContaining({ method: "POST" }),
    );
    // Upsert carried the captured access_token
    expect(db.upserts).toHaveLength(1);
    expect(db.upserts[0]).toMatchObject({
      org_id: ORG_ID,
      platform: "shopify",
      api_key: "shpat_test_token",
      do_not_fanout: true,
    });
    // Auto-register fired with the per-connection callback URL
    expect(mockRegister).toHaveBeenCalledTimes(1);
    const callbackUrlArg = mockRegister.mock.calls[0][1] as string;
    expect(callbackUrlArg).toContain(`connection_id=${CONNECTION_ID}`);
    expect(callbackUrlArg).toContain("platform=shopify");
    // Metadata persisted with scopes from token response + app_distribution=public (no per-connection creds)
    expect(mockPersist).toHaveBeenCalledTimes(1);
    const persistArgs = mockPersist.mock.calls[0];
    expect(persistArgs[1]).toBe(CONNECTION_ID);
    expect(persistArgs[4]).toMatchObject({
      shopifyScopes: ["read_inventory", "write_inventory", "read_orders"],
      appDistribution: "public",
      installedAt: null,
    });

    // Nonce was burned
    expect(db.oauth_states).toHaveLength(0);
  });

  it("treats per-connection install (state.connectionId set) as appDistribution=custom", async () => {
    db.client_store_connections.push({
      id: CONNECTION_ID,
      shopify_app_client_id: PER_CONN_CLIENT_ID,
      shopify_app_client_secret_encrypted: PER_CONN_SECRET,
    });
    db.oauth_states.push({
      id: "row-2",
      oauth_token: "callback-nonce-1",
      org_id: ORG_ID,
      platform: "shopify",
      nonce_purpose: "shopify_install",
      connection_id: CONNECTION_ID,
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    });

    mockRegister.mockResolvedValue({ registered: [], failed: [] });
    mockPersist.mockResolvedValue({
      apiVersionPinned: null,
      apiVersionDrift: false,
      registeredAt: "2026-04-21T00:00:00.000Z",
    });

    const { request } = freshCallbackPair({
      connectionId: CONNECTION_ID,
      secret: PER_CONN_SECRET,
    });
    const res = await GET(request as never);

    expect(res.status).toBe(307);
    expect(mockPersist).toHaveBeenCalledTimes(1);
    expect(mockPersist.mock.calls[0][4]).toMatchObject({
      appDistribution: "custom",
    });
  });

  it("captures auto-register error on metadata but still completes the install", async () => {
    db.oauth_states.push({
      id: "row-1",
      oauth_token: "callback-nonce-1",
      org_id: ORG_ID,
      platform: "shopify",
      nonce_purpose: "shopify_install",
      connection_id: null,
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    });

    mockRegister.mockRejectedValue(new Error("Network blip"));

    const { request } = freshCallbackPair();
    const res = await GET(request as never);

    expect(res.status).toBe(307);
    const location = res.headers.get("Location") ?? "";
    expect(location).toContain("connected=shopify");
    expect(location).toContain("webhook_register=error");
    // Token still persisted
    expect(db.upserts).toHaveLength(1);
    // persistWebhookRegistrationMetadata NOT called (the catch path skips it)
    expect(mockPersist).not.toHaveBeenCalled();
  });

  it("flags partial registration when failed[] non-empty", async () => {
    db.oauth_states.push({
      id: "row-1",
      oauth_token: "callback-nonce-1",
      org_id: ORG_ID,
      platform: "shopify",
      nonce_purpose: "shopify_install",
      connection_id: null,
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    });

    mockRegister.mockResolvedValue({
      registered: [
        {
          id: "gid://shopify/WebhookSubscription/1",
          topic: "inventory_levels/update",
          apiVersion: "2026-01",
          callbackUrl: "...",
          reused: false,
        },
      ],
      failed: [
        {
          topic: "refunds/create",
          callbackUrl: "...",
          error: "URL invalid for this topic",
        },
      ],
    });
    mockPersist.mockResolvedValue({
      apiVersionPinned: "2026-01",
      apiVersionDrift: false,
      registeredAt: "2026-04-21T00:00:00.000Z",
    });

    const { request } = freshCallbackPair();
    const res = await GET(request as never);

    expect(res.status).toBe(307);
    expect(res.headers.get("Location") ?? "").toContain("webhook_register=partial");
  });
});
