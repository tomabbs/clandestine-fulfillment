import { beforeEach, describe, expect, it, vi } from "vitest";

// --- Mocks (vi.hoisted ensures these are available to vi.mock factories) ---

const { mockFrom, mockTrigger } = vi.hoisted(() => ({
  mockFrom: vi.fn(),
  mockTrigger: vi.fn().mockResolvedValue({ id: "run-1" }),
}));

vi.mock("@/lib/server/supabase-server", () => ({
  createServiceRoleClient: () => ({ from: mockFrom }),
}));

vi.mock("@/lib/server/webhook-body", () => ({
  readWebhookBody: vi.fn(async (req: Request) => req.text()),
  verifyHmacSignature: vi.fn(async () => true),
}));

vi.mock("@/lib/shared/env", () => ({
  env: () => ({
    SHOPIFY_WEBHOOK_SECRET: "test-secret",
    SHOPIFY_STORE_URL: "https://clandestine-store.myshopify.com",
  }),
}));

vi.mock("@trigger.dev/sdk", () => ({
  tasks: { trigger: mockTrigger },
}));

import { POST } from "@/app/api/webhooks/shopify/route";
import { verifyHmacSignature } from "@/lib/server/webhook-body";

// --- Helpers ---

function makeRequest(body: Record<string, unknown>, headers: Record<string, string> = {}) {
  const defaultHeaders: Record<string, string> = {
    "X-Shopify-Hmac-SHA256": "valid-sig",
    "X-Shopify-Topic": "orders/create",
    "X-Shopify-Webhook-Id": "wh-123",
    ...headers,
  };
  return new Request("https://example.com/api/webhooks/shopify", {
    method: "POST",
    body: JSON.stringify(body),
    headers: defaultHeaders,
  });
}

/** Set up mockFrom for resolved workspace + successful webhook insert. */
function mockResolvedWorkspaceAndInsert() {
  mockFrom.mockImplementation((table: string) => {
    if (table === "workspaces") {
      return {
        select: vi.fn().mockReturnValue({
          order: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue({
              data: [{ id: "ws-1" }],
              error: null,
            }),
          }),
        }),
      };
    }
    if (table === "webhook_events") {
      return {
        insert: vi.fn().mockReturnValue({
          select: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue({
              data: { id: "evt-1" },
              error: null,
            }),
          }),
        }),
        update: vi.fn().mockReturnValue({
          eq: vi.fn().mockResolvedValue({ error: null }),
        }),
      };
    }
    return { insert: vi.fn(), update: vi.fn(), select: vi.fn() };
  });
}

/** Set up mockFrom to simulate duplicate (insert returns null). */
function mockWebhookInsertDuplicate() {
  mockFrom.mockImplementation((table: string) => {
    if (table === "workspaces") {
      return {
        select: vi.fn().mockReturnValue({
          order: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue({
              data: [{ id: "ws-1" }],
              error: null,
            }),
          }),
        }),
      };
    }
    if (table === "webhook_events") {
      return {
        insert: vi.fn().mockReturnValue({
          select: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue({
              data: null,
              error: { code: "23505", message: "duplicate" },
            }),
          }),
        }),
      };
    }
    return { insert: vi.fn(), update: vi.fn(), select: vi.fn() };
  });
}

function mockUnresolvedWorkspaceAndInsert() {
  mockFrom.mockImplementation((table: string) => {
    if (table === "webhook_events") {
      return {
        insert: vi.fn().mockReturnValue({
          select: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue({
              data: { id: "evt-unresolved" },
              error: null,
            }),
          }),
        }),
      };
    }
    return {};
  });
}

describe("POST /api/webhooks/shopify", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 401 when HMAC signature is missing", async () => {
    const req = makeRequest(
      { id: 1 },
      {
        "X-Shopify-Hmac-SHA256": "",
        "X-Shopify-Topic": "orders/create",
        "X-Shopify-Webhook-Id": "wh-123",
      },
    );
    // Remove the header entirely
    req.headers.delete("X-Shopify-Hmac-SHA256");

    const res = await POST(req);
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.error).toBe("Missing signature");
  });

  it("returns 401 when HMAC signature is invalid", async () => {
    vi.mocked(verifyHmacSignature).mockResolvedValueOnce(false);
    const req = makeRequest({ id: 1 });

    const res = await POST(req);
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.error).toBe("Invalid signature");
  });

  it("returns 400 for invalid JSON body", async () => {
    const req = new Request("https://example.com/api/webhooks/shopify", {
      method: "POST",
      body: "not json{{{",
      headers: {
        "X-Shopify-Hmac-SHA256": "valid-sig",
        "X-Shopify-Topic": "orders/create",
        "X-Shopify-Webhook-Id": "wh-123",
      },
    });

    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it("deduplicates already-processed webhooks", async () => {
    mockWebhookInsertDuplicate();
    const req = makeRequest({ id: 1 });

    const res = await POST(req);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.status).toBe("duplicate");
    expect(mockTrigger).not.toHaveBeenCalled();
  });

  it("marks inventory webhook as ignored when shipstation is authoritative", async () => {
    mockResolvedWorkspaceAndInsert();
    const req = makeRequest(
      { inventory_item_id: 1, available: 42 },
      {
        "X-Shopify-Topic": "inventory_levels/update",
        "X-Shopify-WebHook-Id": "wh-shipstation-mode",
        "X-Shopify-Shop-Domain": "clandestine-store.myshopify.com",
      },
    );

    const res = await POST(req);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.status).toBe("ignored_shipstation_authoritative");
    expect(mockTrigger).not.toHaveBeenCalled();
  });

  it("returns workspace_resolution_failed when shop domain does not match configured domain", async () => {
    mockUnresolvedWorkspaceAndInsert();
    const req = makeRequest(
      { id: 1 },
      {
        "X-Shopify-Shop-Domain": "other-store.myshopify.com",
      },
    );

    const res = await POST(req);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.status).toBe("workspace_resolution_failed");
    expect(mockTrigger).not.toHaveBeenCalled();
  });

  it("returns workspace_ambiguous when multiple workspaces exist", async () => {
    mockFrom.mockImplementation((table: string) => {
      if (table === "workspaces") {
        return {
          select: vi.fn().mockReturnValue({
            order: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue({
                data: [{ id: "ws-1" }, { id: "ws-2" }],
                error: null,
              }),
            }),
          }),
        };
      }
      if (table === "webhook_events") {
        return {
          insert: vi.fn().mockReturnValue({
            select: vi.fn().mockReturnValue({
              single: vi.fn().mockResolvedValue({
                data: { id: "evt-ambiguous" },
                error: null,
              }),
            }),
          }),
        };
      }
      return {};
    });

    const req = makeRequest(
      { id: 1 },
      {
        "X-Shopify-Shop-Domain": "clandestine-store.myshopify.com",
      },
    );

    const res = await POST(req);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.status).toBe("workspace_ambiguous");
    expect(mockTrigger).not.toHaveBeenCalled();
  });
});
