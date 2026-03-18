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
  env: () => ({ SHOPIFY_WEBHOOK_SECRET: "test-secret" }),
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

/** Set up mockFrom to handle webhook_events insert and return inserted row. */
function mockWebhookInsertSuccess() {
  mockFrom.mockImplementation((table: string) => {
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
      };
    }
    return { insert: vi.fn(), update: vi.fn(), select: vi.fn() };
  });
}

/** Set up mockFrom to simulate duplicate (insert returns null). */
function mockWebhookInsertDuplicate() {
  mockFrom.mockImplementation((table: string) => {
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

  it("enqueues process-shopify-webhook task for new webhooks", async () => {
    mockWebhookInsertSuccess();
    const req = makeRequest({ id: 1, name: "Test Order" });

    const res = await POST(req);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(mockTrigger).toHaveBeenCalledWith(
      "process-shopify-webhook",
      expect.objectContaining({
        webhookEventId: "evt-1",
        topic: "orders/create",
      }),
    );
  });

  describe("echo cancellation (Rule #65)", () => {
    it("cancels inventory_levels/update that matches last_pushed_quantity", async () => {
      const mockWebhookUpdate = vi.fn().mockReturnValue({
        eq: vi.fn().mockResolvedValue({ error: null }),
      });

      mockFrom.mockImplementation((table: string) => {
        if (table === "webhook_events") {
          return {
            insert: vi.fn().mockReturnValue({
              select: vi.fn().mockReturnValue({
                single: vi.fn().mockResolvedValue({
                  data: { id: "evt-echo" },
                  error: null,
                }),
              }),
            }),
            update: mockWebhookUpdate,
          };
        }
        if (table === "client_store_sku_mappings") {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                eq: vi.fn().mockReturnValue({
                  limit: vi.fn().mockReturnValue({
                    maybeSingle: vi.fn().mockResolvedValue({
                      data: { id: "map-1", last_pushed_quantity: 42 },
                      error: null,
                    }),
                  }),
                }),
              }),
            }),
          };
        }
        return {};
      });

      const req = makeRequest(
        { inventory_item_id: 9001, available: 42 },
        {
          "X-Shopify-Hmac-SHA256": "valid-sig",
          "X-Shopify-Topic": "inventory_levels/update",
          "X-Shopify-Webhook-Id": "wh-echo-1",
        },
      );

      const res = await POST(req);
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.status).toBe("echo_cancelled");
      expect(mockTrigger).not.toHaveBeenCalled();
    });

    it("processes inventory_levels/update when quantity differs from last_pushed", async () => {
      mockFrom.mockImplementation((table: string) => {
        if (table === "webhook_events") {
          return {
            insert: vi.fn().mockReturnValue({
              select: vi.fn().mockReturnValue({
                single: vi.fn().mockResolvedValue({
                  data: { id: "evt-real" },
                  error: null,
                }),
              }),
            }),
          };
        }
        if (table === "client_store_sku_mappings") {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                eq: vi.fn().mockReturnValue({
                  limit: vi.fn().mockReturnValue({
                    maybeSingle: vi.fn().mockResolvedValue({
                      data: { id: "map-1", last_pushed_quantity: 50 },
                      error: null,
                    }),
                  }),
                }),
              }),
            }),
          };
        }
        return {};
      });

      const req = makeRequest(
        { inventory_item_id: 9001, available: 42 },
        {
          "X-Shopify-Hmac-SHA256": "valid-sig",
          "X-Shopify-Topic": "inventory_levels/update",
          "X-Shopify-Webhook-Id": "wh-real-1",
        },
      );

      const res = await POST(req);
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.status).toBeUndefined();
      expect(mockTrigger).toHaveBeenCalledWith(
        "process-shopify-webhook",
        expect.objectContaining({ webhookEventId: "evt-real" }),
      );
    });

    it("processes inventory_levels/update when no SKU mapping exists", async () => {
      mockFrom.mockImplementation((table: string) => {
        if (table === "webhook_events") {
          return {
            insert: vi.fn().mockReturnValue({
              select: vi.fn().mockReturnValue({
                single: vi.fn().mockResolvedValue({
                  data: { id: "evt-nomap" },
                  error: null,
                }),
              }),
            }),
          };
        }
        if (table === "client_store_sku_mappings") {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                eq: vi.fn().mockReturnValue({
                  limit: vi.fn().mockReturnValue({
                    maybeSingle: vi.fn().mockResolvedValue({
                      data: null,
                      error: null,
                    }),
                  }),
                }),
              }),
            }),
          };
        }
        return {};
      });

      const req = makeRequest(
        { inventory_item_id: 9001, available: 42 },
        {
          "X-Shopify-Hmac-SHA256": "valid-sig",
          "X-Shopify-Topic": "inventory_levels/update",
          "X-Shopify-Webhook-Id": "wh-nomap-1",
        },
      );

      const res = await POST(req);
      expect(res.status).toBe(200);
      expect(mockTrigger).toHaveBeenCalled();
    });
  });
});
