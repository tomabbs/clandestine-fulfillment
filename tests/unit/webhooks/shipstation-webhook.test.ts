import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockFrom, mockTrigger, mockVerify, mockReadBody } = vi.hoisted(() => ({
  mockFrom: vi.fn(),
  mockTrigger: vi.fn().mockResolvedValue({ id: "ssrun-1" }),
  mockVerify: vi.fn<(body: string, sig: string | null, secret: string) => Promise<boolean>>(
    async () => true,
  ),
  mockReadBody: vi.fn(async (req: Request) => req.text()),
}));

vi.mock("@/lib/server/supabase-server", () => ({
  createServiceRoleClient: () => ({ from: mockFrom }),
}));

vi.mock("@/lib/server/webhook-body", () => ({
  readWebhookBody: mockReadBody,
}));

vi.mock("@/lib/clients/shipstation", async () => {
  const actual = await vi.importActual<typeof import("@/lib/clients/shipstation")>(
    "@/lib/clients/shipstation",
  );
  return {
    ...actual,
    verifyShipStationSignature: mockVerify,
  };
});

vi.mock("@/lib/shared/env", () => ({
  env: () => ({ SHIPSTATION_WEBHOOK_SECRET: "test-ss-secret" }),
}));

vi.mock("@trigger.dev/sdk", () => ({
  tasks: { trigger: mockTrigger },
}));

import { POST } from "@/app/api/webhooks/shipstation/route";

const VALID_BODY = JSON.stringify({
  resource_url: "https://ssapi.shipstation.com/shipments/123456?includeShipmentItems=True",
  resource_type: "SHIP_NOTIFY",
});

function makeRequest(body: string = VALID_BODY, headers: Record<string, string> = {}) {
  return new Request("https://example.com/api/webhooks/shipstation", {
    method: "POST",
    body,
    headers: { "x-ss-signature": "valid-sig", ...headers },
  });
}

function mockWebhookInsertSuccess() {
  mockFrom.mockImplementation((table: string) => {
    if (table === "webhook_events") {
      return {
        insert: vi.fn().mockReturnValue({
          select: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue({
              data: { id: "evt-ss-1" },
              error: null,
            }),
          }),
        }),
      };
    }
    return {};
  });
}

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
    return {};
  });
}

describe("POST /api/webhooks/shipstation (SHIP_NOTIFY)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockVerify.mockImplementation(async () => true);
    mockReadBody.mockImplementation(async (req: Request) => req.text());
  });

  it("accepts requests without x-ss-signature header (signing is best-effort per SS docs; revised 2026-04-20)", async () => {
    // Now that we accept unsigned, the request reaches the supabase insert.
    mockWebhookInsertSuccess();
    const req = new Request("https://example.com/api/webhooks/shipstation", {
      method: "POST",
      body: VALID_BODY,
    });

    const res = await POST(req as unknown as Parameters<typeof POST>[0]);
    // Was 401 in original Phase 1.3; revised to 200 — SS doesn't always
    // send x-ss-signature (depends on subscription type + payload version).
    // Strict rejection broke legitimate webhook deliveries; we now accept
    // unsigned events + log to Sentry once per cold start.
    expect(res.status).toBe(200);
  });

  it("returns 401 when HMAC verification fails", async () => {
    mockVerify.mockResolvedValueOnce(false);
    const res = await POST(makeRequest() as unknown as Parameters<typeof POST>[0]);
    expect(res.status).toBe(401);
    expect(mockTrigger).not.toHaveBeenCalled();
  });

  it("returns 400 when payload does not match a known SHIP_NOTIFY / ORDER_NOTIFY shape", async () => {
    const bad = JSON.stringify({ resource_url: "https://x", resource_type: "WHAT_IS_THIS" });
    const res = await POST(makeRequest(bad) as unknown as Parameters<typeof POST>[0]);
    expect(res.status).toBe(400);
    expect(mockTrigger).not.toHaveBeenCalled();
  });

  it("dedupes duplicate webhooks (UNIQUE conflict on webhook_events)", async () => {
    mockWebhookInsertDuplicate();
    const res = await POST(makeRequest() as unknown as Parameters<typeof POST>[0]);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.status).toBe("duplicate");
    expect(mockTrigger).not.toHaveBeenCalled();
  });

  it("enqueues process-shipstation-shipment with the webhook id and resource_url", async () => {
    mockWebhookInsertSuccess();
    const res = await POST(makeRequest() as unknown as Parameters<typeof POST>[0]);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(mockTrigger).toHaveBeenCalledWith(
      "process-shipstation-shipment",
      expect.objectContaining({
        webhookEventId: "evt-ss-1",
        resource_url: "https://ssapi.shipstation.com/shipments/123456?includeShipmentItems=True",
      }),
    );
  });

  it("uses the raw body for HMAC verification (Rule #36)", async () => {
    mockWebhookInsertSuccess();
    await POST(makeRequest() as unknown as Parameters<typeof POST>[0]);
    expect(mockVerify).toHaveBeenCalledWith(VALID_BODY, "valid-sig", "test-ss-secret");
  });
});

describe("POST /api/webhooks/shipstation (ORDER_NOTIFY — Phase 1.3)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockVerify.mockImplementation(async () => true);
    mockReadBody.mockImplementation(async (req: Request) => req.text());
  });

  const ORDER_NOTIFY_BODY = JSON.stringify({
    resource_url: "https://ssapi.shipstation.com/orders?modifyDateStart=2026-04-19+12%3A00%3A00",
    resource_type: "ORDER_NOTIFY",
  });

  function makeOrderRequest() {
    return new Request("https://example.com/api/webhooks/shipstation", {
      method: "POST",
      body: ORDER_NOTIFY_BODY,
      headers: { "x-ss-signature": "valid-sig" },
    });
  }

  it("accepts ORDER_NOTIFY payloads (200) and enqueues the windowed poll task", async () => {
    mockWebhookInsertSuccess();
    const res = await POST(makeOrderRequest() as unknown as Parameters<typeof POST>[0]);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(mockTrigger).toHaveBeenCalledWith(
      "shipstation-orders-poll-window",
      expect.objectContaining({ windowMinutes: expect.any(Number) }),
    );
  });

  it("ORDER_NOTIFY does NOT enqueue process-shipstation-shipment", async () => {
    mockWebhookInsertSuccess();
    await POST(makeOrderRequest() as unknown as Parameters<typeof POST>[0]);
    const taskNames = mockTrigger.mock.calls.map((c) => c[0]);
    expect(taskNames).not.toContain("process-shipstation-shipment");
  });

  it("ORDER_NOTIFY dedup is independent from SHIP_NOTIFY (different external_webhook_id prefixes)", async () => {
    let lastInsert: Record<string, unknown> | null = null;
    mockFrom.mockImplementation((table: string) => {
      if (table === "webhook_events") {
        return {
          insert: vi.fn((row) => {
            lastInsert = row;
            return {
              select: vi.fn().mockReturnValue({
                single: vi.fn().mockResolvedValue({ data: { id: "evt-on-1" }, error: null }),
              }),
            };
          }),
        };
      }
      return {};
    });
    await POST(makeOrderRequest() as unknown as Parameters<typeof POST>[0]);
    expect(lastInsert).not.toBeNull();
    expect((lastInsert as unknown as { external_webhook_id: string }).external_webhook_id).toMatch(
      /^shipstation:order_notify:/,
    );
    expect((lastInsert as unknown as { topic: string }).topic).toBe("ORDER_NOTIFY");
  });
});

describe("POST /api/webhooks/shipstation (Phase 1.3 — revised 2026-04-20)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockVerify.mockImplementation(async () => true);
    mockReadBody.mockImplementation(async (req: Request) => req.text());
  });

  it("accepts unsigned events in production when neither SHIPSTATION_WEBHOOK_SECRET nor SHIPSTATION_API_SECRET is set (SS doesn't expose a webhook secret in their dashboard; signing is best-effort)", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.doMock("@/lib/shared/env", () => ({
      env: () => ({ SHIPSTATION_WEBHOOK_SECRET: "", SHIPSTATION_API_SECRET: "" }),
    }));
    vi.resetModules();
    try {
      const { POST: PostInProd } = await import("@/app/api/webhooks/shipstation/route");
      const req = new Request("https://example.com/api/webhooks/shipstation", {
        method: "POST",
        body: VALID_BODY,
      });
      const res = await PostInProd(req as unknown as Parameters<typeof POST>[0]);
      // Was 500 in original Phase 1.3; revised to 200 (accept) per SS docs.
      expect(res.status).toBe(200);
    } finally {
      vi.unstubAllEnvs();
      vi.doUnmock("@/lib/shared/env");
      vi.resetModules();
    }
  });

  it("falls back to SHIPSTATION_API_SECRET when SHIPSTATION_WEBHOOK_SECRET is empty (SS reuses the API secret as the HMAC key per their docs)", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.doMock("@/lib/shared/env", () => ({
      env: () => ({
        SHIPSTATION_WEBHOOK_SECRET: "",
        SHIPSTATION_API_SECRET: "the-api-secret",
      }),
    }));
    mockVerify.mockImplementation(async (_body, _sig, secret) => secret === "the-api-secret");
    vi.resetModules();
    try {
      const { POST: PostInProd } = await import("@/app/api/webhooks/shipstation/route");
      const req = new Request("https://example.com/api/webhooks/shipstation", {
        method: "POST",
        body: VALID_BODY,
        headers: { "x-ss-signature": "valid-sig" },
      });
      const res = await PostInProd(req as unknown as Parameters<typeof POST>[0]);
      expect(res.status).toBe(200);
      // Confirms verifier was called with the API secret, not the webhook one.
      expect(mockVerify).toHaveBeenCalledWith(expect.any(String), "valid-sig", "the-api-secret");
    } finally {
      vi.unstubAllEnvs();
      vi.doUnmock("@/lib/shared/env");
      vi.resetModules();
    }
  });
});
