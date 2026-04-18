import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockFrom, mockTrigger, mockVerify, mockReadBody } = vi.hoisted(() => ({
  mockFrom: vi.fn(),
  mockTrigger: vi.fn().mockResolvedValue({ id: "ssrun-1" }),
  mockVerify: vi.fn(async () => true),
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

  it("returns 401 when x-ss-signature header is missing", async () => {
    const req = new Request("https://example.com/api/webhooks/shipstation", {
      method: "POST",
      body: VALID_BODY,
    });

    const res = await POST(req as unknown as Parameters<typeof POST>[0]);
    expect(res.status).toBe(401);
  });

  it("returns 401 when HMAC verification fails", async () => {
    mockVerify.mockResolvedValueOnce(false);
    const res = await POST(makeRequest() as unknown as Parameters<typeof POST>[0]);
    expect(res.status).toBe(401);
    expect(mockTrigger).not.toHaveBeenCalled();
  });

  it("returns 400 when payload does not match SHIP_NOTIFY shape", async () => {
    const bad = JSON.stringify({ resource_url: "https://x", resource_type: "ORDER_NOTIFY" });
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
