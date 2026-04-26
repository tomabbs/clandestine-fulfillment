// Slice 1 / Slice 2 / Slice 4 — Resend webhook Route Handler tests.
//
// Covers the broader Resend event surface (sent, delivered, delivery_delayed,
// bounced, complained, failed) and asserts:
//   - Production with no secret -> 500.
//   - Invalid signature -> 401 + signature_failed webhook_event row.
//   - Duplicate webhook_event -> 200 (no rollup change).
//   - email.sent -> rollup unchanged (already 'sent' at producer side).
//   - email.delivered -> updateNotificationStatusSafe called with 'delivered'.
//   - email.delivery_delayed -> 'delivery_delayed'.
//   - email.bounced -> 'bounced' + suppressRecipient called.
//   - email.complained -> 'complained' + suppressRecipient called + Sentry.
//   - email.failed -> 'provider_failed'.
//   - state-machine no-op (sticky terminal) -> no-throw, returns 200 with no_op.
//   - No matching send row -> ledger insert still happens, status='no_matching_send'.

import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockEnv,
  mockVerifySignature,
  mockSupabaseFrom,
  mockSupabaseClient,
  mockRecordEvent,
  mockUpdateStatusSafe,
  mockFindSendByMessageId,
  mockSuppressRecipient,
  mockSentry,
} = vi.hoisted(() => {
  const fromMock = vi.fn();
  return {
    mockEnv: vi.fn(),
    mockVerifySignature: vi.fn(),
    mockSupabaseFrom: fromMock,
    mockSupabaseClient: { from: fromMock } as never,
    mockRecordEvent: vi.fn().mockResolvedValue({ id: "evt-1" }),
    mockUpdateStatusSafe: vi.fn().mockResolvedValue({
      applied: true,
      previousStatus: "sent",
      newStatus: "delivered",
      skippedReason: null,
    }),
    mockFindSendByMessageId: vi.fn(),
    mockSuppressRecipient: vi.fn().mockResolvedValue(undefined),
    mockSentry: {
      captureMessage: vi.fn(),
      captureException: vi.fn(),
    },
  };
});

vi.mock("@/lib/shared/env", () => ({
  env: mockEnv,
}));

vi.mock("@/lib/server/resend-webhook-signature", () => ({
  verifyResendWebhook: mockVerifySignature,
}));

vi.mock("@/lib/server/supabase-server", () => ({
  createServiceRoleClient: () => mockSupabaseClient,
}));

vi.mock("@/lib/server/notification-provider-events", () => ({
  recordProviderEvent: mockRecordEvent,
}));

vi.mock("@/lib/server/notification-status", () => ({
  updateNotificationStatusSafe: mockUpdateStatusSafe,
  updateShipmentTrackingStatusSafe: vi.fn(),
}));

vi.mock("@/lib/server/notification-sends", () => ({
  findNotificationSendByMessageId: mockFindSendByMessageId,
  suppressRecipient: mockSuppressRecipient,
}));

vi.mock("@sentry/nextjs", () => mockSentry);

vi.mock("@/lib/server/webhook-body", async () => {
  const real = await vi.importActual<typeof import("@/lib/server/webhook-body")>(
    "@/lib/server/webhook-body",
  );
  return { ...real };
});

import { NextRequest } from "next/server";
import { POST } from "@/app/api/webhooks/resend/route";

function chain(result: { data: unknown; error: unknown }) {
  const c: Record<string, unknown> = {
    insert: vi.fn(),
    select: vi.fn(),
    eq: vi.fn(),
    single: vi.fn().mockResolvedValue(result),
    maybeSingle: vi.fn().mockResolvedValue(result),
    // biome-ignore lint/suspicious/noThenProperty: Supabase's PostgrestBuilder is intentionally thenable (callers can `await query.select().eq(...)` directly); this mock mirrors that contract so `await`-chaining in the webhook under test routes through the same code path as in real Supabase calls.
    then: (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve),
    catch: () => undefined,
  };
  for (const k of ["insert", "select", "eq"]) {
    (c[k] as ReturnType<typeof vi.fn>).mockReturnValue(c);
  }
  return c;
}

function makeRequest(payload: object | string, headers: Record<string, string> = {}): NextRequest {
  const raw = typeof payload === "string" ? payload : JSON.stringify(payload);
  return new NextRequest("https://example.com/api/webhooks/resend", {
    method: "POST",
    body: raw,
    headers: {
      "content-type": "application/json",
      "svix-id": "msg_test_1",
      "svix-timestamp": String(Math.floor(Date.now() / 1000)),
      "svix-signature": "v1,abcd",
      ...headers,
    },
  });
}

const ORIG_NODE_ENV = process.env.NODE_ENV;

beforeEach(() => {
  mockEnv.mockReset();
  mockVerifySignature.mockReset();
  mockSupabaseFrom.mockReset();
  mockRecordEvent.mockReset();
  mockUpdateStatusSafe.mockReset();
  mockFindSendByMessageId.mockReset();
  mockSuppressRecipient.mockReset();
  mockSentry.captureMessage.mockReset();
  mockSentry.captureException.mockReset();
  mockRecordEvent.mockResolvedValue({ id: "evt-1" });
  mockUpdateStatusSafe.mockResolvedValue({
    applied: true,
    previousStatus: "sent",
    newStatus: "delivered",
    skippedReason: null,
  });
  mockSuppressRecipient.mockResolvedValue(undefined);
  (process.env as Record<string, string | undefined>).NODE_ENV = ORIG_NODE_ENV;
});

describe("Resend webhook — secret hardening", () => {
  it("returns 500 in production when RESEND_WEBHOOK_SECRET is unset", async () => {
    (process.env as Record<string, string | undefined>).NODE_ENV = "production";
    mockEnv.mockReturnValue({
      RESEND_WEBHOOK_SECRET: "",
      RESEND_WEBHOOK_SECRET_PREVIOUS: "",
    });
    const res = await POST(makeRequest({ type: "email.delivered" }));
    expect(res.status).toBe(500);
    expect(mockSentry.captureMessage).toHaveBeenCalledWith(
      expect.stringMatching(/secret unset in production/),
      expect.objectContaining({ level: "error" }),
    );
    expect(mockSupabaseFrom).not.toHaveBeenCalled();
  });
});

describe("Resend webhook — signature failure", () => {
  it("returns 401 + writes a signature_failed webhook_event row keyed by svix-id", async () => {
    mockEnv.mockReturnValue({
      RESEND_WEBHOOK_SECRET: "rs-secret-1",
      RESEND_WEBHOOK_SECRET_PREVIOUS: "",
    });
    mockVerifySignature.mockReturnValue({
      valid: false,
      reason: "invalid_signature",
    });
    const sigFailureChain = chain({ data: null, error: null });
    mockSupabaseFrom.mockReturnValueOnce(sigFailureChain);

    const res = await POST(makeRequest({ type: "email.delivered" }, { "svix-id": "msg_bad_1" }));
    expect(res.status).toBe(401);
    expect(mockSupabaseFrom).toHaveBeenCalledWith("webhook_events");
    const insertedRow = (sigFailureChain.insert as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(insertedRow.platform).toBe("resend");
    expect(insertedRow.status).toBe("signature_failed");
    expect(insertedRow.external_webhook_id).toBe("resend:sigfail:msg_bad_1");
    // Generic external response.
    const body = await res.json();
    expect(body.error).toBe("Unauthorized");
    expect(JSON.stringify(body)).not.toContain("invalid_signature");
    expect(mockUpdateStatusSafe).not.toHaveBeenCalled();
  });
});

describe("Resend webhook — dedup behavior", () => {
  it("returns 200 + status='duplicate' on 23505 unique violation", async () => {
    mockEnv.mockReturnValue({
      RESEND_WEBHOOK_SECRET: "rs-secret-1",
      RESEND_WEBHOOK_SECRET_PREVIOUS: "",
    });
    mockVerifySignature.mockReturnValue({ valid: true, secretIndex: 0 });
    mockSupabaseFrom.mockReturnValueOnce(
      chain({ data: null, error: { code: "23505", message: "dup" } }),
    );

    const res = await POST(
      makeRequest(
        { type: "email.delivered", data: { email_id: "e_1", to: "buyer@example.com" } },
        { "svix-id": "msg_dup_1" },
      ),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("duplicate");
    expect(mockUpdateStatusSafe).not.toHaveBeenCalled();
    expect(mockRecordEvent).not.toHaveBeenCalled();
  });
});

describe("Resend webhook — event-type → rollup transition", () => {
  function setupHappyPath() {
    mockEnv.mockReturnValue({
      RESEND_WEBHOOK_SECRET: "rs-secret-1",
      RESEND_WEBHOOK_SECRET_PREVIOUS: "",
    });
    mockVerifySignature.mockReturnValue({ valid: true, secretIndex: 0 });
    mockSupabaseFrom.mockReturnValue(chain({ data: { id: "wh-1" }, error: null }));
    mockFindSendByMessageId.mockResolvedValue({
      id: "ns-1",
      workspace_id: "ws-1",
      shipment_id: "ship-1",
      status: "sent",
    });
  }

  it("email.sent — no rollup transition (producer already wrote 'sent')", async () => {
    setupHappyPath();
    const res = await POST(
      makeRequest({ type: "email.sent", data: { email_id: "e_1", to: "x@y.z" } }),
    );
    expect(res.status).toBe(200);
    expect(mockUpdateStatusSafe).not.toHaveBeenCalled();
    // Ledger insert STILL happens for sent (audit/forensics).
    expect(mockRecordEvent).toHaveBeenCalledTimes(1);
  });

  it("email.delivered — rollup → 'delivered'", async () => {
    setupHappyPath();
    const res = await POST(
      makeRequest({ type: "email.delivered", data: { email_id: "e_1", to: "x@y.z" } }),
    );
    expect(res.status).toBe(200);
    expect(mockUpdateStatusSafe).toHaveBeenCalledWith(
      mockSupabaseClient,
      expect.objectContaining({
        notificationSendId: "ns-1",
        newStatus: "delivered",
        providerEventType: "email.delivered",
      }),
    );
    expect(mockSuppressRecipient).not.toHaveBeenCalled();
  });

  it("email.delivery_delayed — rollup → 'delivery_delayed' (not terminal)", async () => {
    setupHappyPath();
    const res = await POST(
      makeRequest({ type: "email.delivery_delayed", data: { email_id: "e_1", to: "x@y.z" } }),
    );
    expect(res.status).toBe(200);
    expect(mockUpdateStatusSafe).toHaveBeenCalledWith(
      mockSupabaseClient,
      expect.objectContaining({ newStatus: "delivery_delayed" }),
    );
  });

  it("email.bounced — rollup → 'bounced' + suppressRecipient called", async () => {
    setupHappyPath();
    const res = await POST(
      makeRequest({
        type: "email.bounced",
        data: {
          email_id: "e_1",
          to: ["bounce@example.com"],
          bounce: { message: "mailbox full", type: "transient" },
        },
      }),
    );
    expect(res.status).toBe(200);
    expect(mockUpdateStatusSafe).toHaveBeenCalledWith(
      mockSupabaseClient,
      expect.objectContaining({
        newStatus: "bounced",
        error: "mailbox full",
      }),
    );
    expect(mockSuppressRecipient).toHaveBeenCalledWith(
      mockSupabaseClient,
      expect.objectContaining({
        recipient: "bounce@example.com",
        suppressionType: "bounce",
        sourceMessageId: "e_1",
      }),
    );
  });

  it("email.complained — rollup → 'complained' + suppress + Sentry warning", async () => {
    setupHappyPath();
    const res = await POST(
      makeRequest({
        type: "email.complained",
        data: {
          email_id: "e_1",
          to: "spam@example.com",
          complaint: { message: "user reported as spam" },
        },
      }),
    );
    expect(res.status).toBe(200);
    expect(mockUpdateStatusSafe).toHaveBeenCalledWith(
      mockSupabaseClient,
      expect.objectContaining({ newStatus: "complained" }),
    );
    expect(mockSuppressRecipient).toHaveBeenCalledWith(
      mockSupabaseClient,
      expect.objectContaining({
        recipient: "spam@example.com",
        suppressionType: "complaint",
      }),
    );
    expect(mockSentry.captureMessage).toHaveBeenCalledWith(
      expect.stringMatching(/complaint received/),
      expect.objectContaining({ level: "warning" }),
    );
  });

  it("email.failed — rollup → 'provider_failed' with extracted error message", async () => {
    setupHappyPath();
    const res = await POST(
      makeRequest({
        type: "email.failed",
        data: { email_id: "e_1", to: "x@y.z", error: { message: "smtp 550" } },
      }),
    );
    expect(res.status).toBe(200);
    expect(mockUpdateStatusSafe).toHaveBeenCalledWith(
      mockSupabaseClient,
      expect.objectContaining({
        newStatus: "provider_failed",
        error: "smtp 550",
      }),
    );
  });

  it("email.failed — accepts plain-string error", async () => {
    setupHappyPath();
    const res = await POST(
      makeRequest({
        type: "email.failed",
        data: { email_id: "e_1", to: "x@y.z", error: "smtp 421 timeout" },
      }),
    );
    expect(res.status).toBe(200);
    expect(mockUpdateStatusSafe).toHaveBeenCalledWith(
      mockSupabaseClient,
      expect.objectContaining({
        newStatus: "provider_failed",
        error: "smtp 421 timeout",
      }),
    );
  });

  it("email.opened — ignored for rollup but ledger still written", async () => {
    setupHappyPath();
    const res = await POST(
      makeRequest({ type: "email.opened", data: { email_id: "e_1", to: "x@y.z" } }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ignored");
    expect(body.type).toBe("email.opened");
    expect(mockUpdateStatusSafe).not.toHaveBeenCalled();
    expect(mockRecordEvent).toHaveBeenCalledTimes(1);
  });

  it("email.suppressed — rollup → 'provider_suppressed' + suppressRecipient called (v5 mapping)", async () => {
    setupHappyPath();
    const res = await POST(
      makeRequest({
        type: "email.suppressed",
        data: {
          email_id: "e_1",
          to: ["suppressed@example.com"],
          error: "address on global suppression list",
        },
      }),
    );
    expect(res.status).toBe(200);
    expect(mockUpdateStatusSafe).toHaveBeenCalledWith(
      mockSupabaseClient,
      expect.objectContaining({
        newStatus: "provider_suppressed",
        error: "address on global suppression list",
      }),
    );
    expect(mockSuppressRecipient).toHaveBeenCalledWith(
      mockSupabaseClient,
      expect.objectContaining({
        recipient: "suppressed@example.com",
        suppressionType: "manual",
        sourceMessageId: "e_1",
      }),
    );
  });

  it("unknown event type — defaults to ledger-only (no rollup, no throw, v5 fallback)", async () => {
    setupHappyPath();
    const res = await POST(
      makeRequest({ type: "email.future_event_type_99", data: { email_id: "e_1", to: "x@y.z" } }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ignored");
    expect(mockUpdateStatusSafe).not.toHaveBeenCalled();
    expect(mockRecordEvent).toHaveBeenCalledTimes(1);
    expect(mockSentry.captureException).not.toHaveBeenCalled();
  });
});

describe("Resend webhook — no-terminal-status-regression contract", () => {
  it("does not throw or 5xx when state machine refuses delivered after bounced (returns no_op)", async () => {
    mockEnv.mockReturnValue({
      RESEND_WEBHOOK_SECRET: "rs-secret-1",
      RESEND_WEBHOOK_SECRET_PREVIOUS: "",
    });
    mockVerifySignature.mockReturnValue({ valid: true, secretIndex: 0 });
    mockSupabaseFrom.mockReturnValue(chain({ data: { id: "wh-1" }, error: null }));
    mockFindSendByMessageId.mockResolvedValue({
      id: "ns-1",
      workspace_id: "ws-1",
      shipment_id: "ship-1",
      status: "bounced",
    });
    // Simulate the state machine sticking on the prior 'bounced' terminal.
    mockUpdateStatusSafe.mockResolvedValue({
      applied: false,
      previousStatus: "bounced",
      newStatus: "bounced",
      skippedReason: "terminal_state",
    });

    const res = await POST(
      makeRequest({ type: "email.delivered", data: { email_id: "e_1", to: "x@y.z" } }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("no_op");
    expect(body.previous_status).toBe("bounced");
    // Critical: no throw, no Sentry exception.
    expect(mockSentry.captureException).not.toHaveBeenCalled();
  });
});

describe("Resend webhook — no matching send row", () => {
  it("returns 200 + status='no_matching_send' but ledger insert still happens", async () => {
    mockEnv.mockReturnValue({
      RESEND_WEBHOOK_SECRET: "rs-secret-1",
      RESEND_WEBHOOK_SECRET_PREVIOUS: "",
    });
    mockVerifySignature.mockReturnValue({ valid: true, secretIndex: 0 });
    mockSupabaseFrom.mockReturnValue(chain({ data: { id: "wh-1" }, error: null }));
    mockFindSendByMessageId.mockResolvedValue(null);

    const res = await POST(
      makeRequest({ type: "email.delivered", data: { email_id: "orphan_1", to: "x@y.z" } }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("no_matching_send");
    // Ledger insert STILL happens (forensics).
    expect(mockRecordEvent).toHaveBeenCalledTimes(1);
    // Crucially, no rollup mutation when there's no row to mutate.
    expect(mockUpdateStatusSafe).not.toHaveBeenCalled();
  });
});

describe("Resend webhook — no email_id", () => {
  it("returns 200 + status='no_email_id' when payload omits data.email_id", async () => {
    mockEnv.mockReturnValue({
      RESEND_WEBHOOK_SECRET: "rs-secret-1",
      RESEND_WEBHOOK_SECRET_PREVIOUS: "",
    });
    mockVerifySignature.mockReturnValue({ valid: true, secretIndex: 0 });
    mockSupabaseFrom.mockReturnValue(chain({ data: { id: "wh-1" }, error: null }));

    const res = await POST(makeRequest({ type: "email.delivered", data: { to: "x@y.z" } }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("no_email_id");
    expect(mockUpdateStatusSafe).not.toHaveBeenCalled();
  });
});
