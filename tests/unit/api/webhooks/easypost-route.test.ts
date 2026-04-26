// Slice 1 / Slice 4 — EasyPost webhook Route Handler integration tests.
//
// Verifies the security + idempotency + state-machine contract end-to-end at
// the route level (no DB, no Trigger.dev, no Resend — those are mocked).
//
// Coverage:
//   - Production with no secret -> 500 (fail-CLOSED).
//   - Invalid signature -> 401 + signature_failed webhook_events row written.
//   - Duplicate webhook_event row -> 200 + status='duplicate' (no downstream side effects).
//   - Transient dedup error -> 503.
//   - No tracker payload -> 200 + status='no_tracker_data'.
//   - No matching shipment -> 200 + status='no_matching_shipment' (still writes to ledger).
//   - Successful delivered tracker -> triggers send-tracking-email + state-machine call.

import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockEnv,
  mockVerifySignature,
  mockSupabase,
  mockTrigger,
  mockRecordEvent,
  mockUpdateTrackingStatus,
  mockSentry,
} = vi.hoisted(() => {
  const fromMock = vi.fn();
  return {
    mockEnv: vi.fn(),
    mockVerifySignature: vi.fn(),
    // Single supabase client mock — every test writes its expected
    // chains via fromMock.mockImplementation; tests that don't expect
    // certain queries simply don't push results.
    mockSupabase: {
      client: { from: fromMock } as never,
      from: fromMock,
    },
    mockTrigger: vi.fn().mockResolvedValue({ id: "run-1" }),
    mockRecordEvent: vi.fn().mockResolvedValue({ id: "evt-1" }),
    mockUpdateTrackingStatus: vi.fn().mockResolvedValue({
      applied: true,
      previousStatus: "in_transit",
      newStatus: "delivered",
      skippedReason: null,
    }),
    mockSentry: {
      captureMessage: vi.fn(),
      captureException: vi.fn(),
    },
  };
});

vi.mock("@/lib/shared/env", () => ({
  env: mockEnv,
}));

vi.mock("@/lib/server/easypost-webhook-signature", () => ({
  verifyEasypostSignature: mockVerifySignature,
}));

vi.mock("@/lib/server/supabase-server", () => ({
  createServiceRoleClient: () => mockSupabase.client,
}));

vi.mock("@/lib/server/notification-provider-events", () => ({
  recordProviderEvent: mockRecordEvent,
}));

vi.mock("@/lib/server/notification-status", () => ({
  updateShipmentTrackingStatusSafe: mockUpdateTrackingStatus,
  updateNotificationStatusSafe: vi.fn(),
}));

vi.mock("@trigger.dev/sdk", () => ({
  tasks: { trigger: mockTrigger },
}));

vi.mock("@sentry/nextjs", () => mockSentry);

vi.mock("@/lib/server/webhook-body", async () => {
  const real = await vi.importActual<typeof import("@/lib/server/webhook-body")>(
    "@/lib/server/webhook-body",
  );
  return { ...real };
});

import { NextRequest } from "next/server";
import { POST } from "@/app/api/webhooks/easypost/route";

/** Build a thenable Supabase chain that resolves to `{data,error}`. */
function chain(result: { data: unknown; error: unknown }) {
  const c: Record<string, unknown> = {
    insert: vi.fn(),
    select: vi.fn(),
    eq: vi.fn(),
    limit: vi.fn(),
    update: vi.fn(),
    upsert: vi.fn(),
    single: vi.fn().mockResolvedValue(result),
    maybeSingle: vi.fn().mockResolvedValue(result),
    // biome-ignore lint/suspicious/noThenProperty: Supabase's PostgrestBuilder is intentionally thenable (callers can `await query.select().eq(...)` directly); this mock mirrors that contract so `await`-chaining in the webhook under test routes through the same code path as in real Supabase calls.
    then: (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve),
    catch: () => undefined,
  };
  for (const k of ["insert", "select", "eq", "limit", "update", "upsert"]) {
    (c[k] as ReturnType<typeof vi.fn>).mockReturnValue(c);
  }
  return c;
}

function makeRequest(body: object | string, headers: Record<string, string> = {}): NextRequest {
  const raw = typeof body === "string" ? body : JSON.stringify(body);
  return new NextRequest("https://example.com/api/webhooks/easypost", {
    method: "POST",
    body: raw,
    headers: {
      "content-type": "application/json",
      ...headers,
    },
  });
}

const VALID_HEADERS = {
  "x-timestamp": String(Math.floor(Date.now() / 1000)),
  "x-path": "/api/webhooks/easypost",
  "x-hmac-signature-v2": "hmac-sha256-hex=deadbeef",
};

const ORIG_NODE_ENV = process.env.NODE_ENV;

beforeEach(() => {
  mockEnv.mockReset();
  mockVerifySignature.mockReset();
  mockSupabase.from.mockReset();
  mockTrigger.mockReset();
  mockRecordEvent.mockReset();
  mockUpdateTrackingStatus.mockReset();
  mockSentry.captureMessage.mockReset();
  mockSentry.captureException.mockReset();
  // Sane defaults
  mockTrigger.mockResolvedValue({ id: "run-1" });
  mockRecordEvent.mockResolvedValue({ id: "evt-1" });
  mockUpdateTrackingStatus.mockResolvedValue({
    applied: true,
    previousStatus: "in_transit",
    newStatus: "delivered",
    skippedReason: null,
  });
  // Reset NODE_ENV between tests — some tests flip to production.
  // Direct assignment to process.env is NOT writable on some Node versions
  // when NODE_ENV is set on the property descriptor; use the writable
  // assignment that always works.
  (process.env as Record<string, string | undefined>).NODE_ENV = ORIG_NODE_ENV;
});

describe("EasyPost webhook — secret hardening", () => {
  it("returns 500 in production when EASYPOST_WEBHOOK_SECRET is unset (fail-CLOSED)", async () => {
    (process.env as Record<string, string | undefined>).NODE_ENV = "production";
    mockEnv.mockReturnValue({
      EASYPOST_WEBHOOK_SECRET: "",
      EASYPOST_WEBHOOK_SECRET_PREVIOUS: "",
      EASYPOST_WEBHOOK_REQUIRE_SIGNATURE: "true",
    });

    const res = await POST(makeRequest({ id: "evt_1" }));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toMatch(/misconfigured/i);
    expect(mockSentry.captureMessage).toHaveBeenCalledWith(
      expect.stringMatching(/EASYPOST_WEBHOOK_SECRET unset in production/),
      expect.objectContaining({ level: "error" }),
    );
    // No DB / Trigger writes when the secret is unset in prod.
    expect(mockSupabase.from).not.toHaveBeenCalled();
    expect(mockTrigger).not.toHaveBeenCalled();
  });

  it("accepts unsigned events in non-production with a Sentry warning", async () => {
    (process.env as Record<string, string | undefined>).NODE_ENV = "test";
    mockEnv.mockReturnValue({
      EASYPOST_WEBHOOK_SECRET: "",
      EASYPOST_WEBHOOK_SECRET_PREVIOUS: "",
      EASYPOST_WEBHOOK_REQUIRE_SIGNATURE: "true",
    });
    mockSupabase.from
      .mockReturnValueOnce(chain({ data: { id: "wh-1" }, error: null })) // webhook_events insert
      .mockReturnValueOnce(chain({ data: null, error: null })); // warehouse_shipments lookup -> no match

    const res = await POST(makeRequest({ id: "evt_1", result: {} }, VALID_HEADERS));
    expect(res.status).toBe(200);
  });
});

describe("EasyPost webhook — signature verification failure", () => {
  it("returns 401 + writes a signature_failed webhook_event row", async () => {
    mockEnv.mockReturnValue({
      EASYPOST_WEBHOOK_SECRET: "secret-1",
      EASYPOST_WEBHOOK_SECRET_PREVIOUS: "",
      EASYPOST_WEBHOOK_REQUIRE_SIGNATURE: "true",
    });
    mockVerifySignature.mockReturnValue({
      valid: false,
      reason: "bad_signature",
      variant: "v2",
    });

    const sigFailureChain = chain({ data: null, error: null });
    mockSupabase.from.mockReturnValueOnce(sigFailureChain);

    const res = await POST(makeRequest({ id: "evt_1" }, VALID_HEADERS));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("Unauthorized");

    // CRITICAL Slice 4 contract: persist a webhook_events row so the
    // notification-failure-sensor can roll up signature failures.
    expect(mockSupabase.from).toHaveBeenCalledWith("webhook_events");
    const insertedRow = (sigFailureChain.insert as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(insertedRow.platform).toBe("easypost");
    expect(insertedRow.status).toBe("signature_failed");
    expect(insertedRow.topic).toBe("signature_failed");
    expect(insertedRow.external_webhook_id).toMatch(/^sigfail:/);
    expect(insertedRow.metadata.reason).toBe("bad_signature");

    // Generic external response — never leak the verifier's reason.
    expect(JSON.stringify(body)).not.toContain("bad_signature");

    // No downstream processing.
    expect(mockTrigger).not.toHaveBeenCalled();
    expect(mockRecordEvent).not.toHaveBeenCalled();
  });
});

describe("EasyPost webhook — dedup behavior", () => {
  it("returns 200 + status='duplicate' on 23505 unique violation", async () => {
    mockEnv.mockReturnValue({
      EASYPOST_WEBHOOK_SECRET: "secret-1",
      EASYPOST_WEBHOOK_SECRET_PREVIOUS: "",
      EASYPOST_WEBHOOK_REQUIRE_SIGNATURE: "true",
    });
    mockVerifySignature.mockReturnValue({ valid: true, variant: "v2", secretIndex: 0 });
    mockSupabase.from.mockReturnValueOnce(
      chain({ data: null, error: { code: "23505", message: "dup" } }),
    );

    const res = await POST(
      makeRequest(
        {
          id: "evt_dup",
          result: { tracking_code: "1Z999", status: "in_transit" },
        },
        VALID_HEADERS,
      ),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("duplicate");
    // Critical: no downstream side-effects on a duplicate.
    expect(mockTrigger).not.toHaveBeenCalled();
    expect(mockRecordEvent).not.toHaveBeenCalled();
    expect(mockUpdateTrackingStatus).not.toHaveBeenCalled();
  });

  it("returns 503 on transient PostgREST dedup failure", async () => {
    mockEnv.mockReturnValue({
      EASYPOST_WEBHOOK_SECRET: "secret-1",
      EASYPOST_WEBHOOK_SECRET_PREVIOUS: "",
      EASYPOST_WEBHOOK_REQUIRE_SIGNATURE: "true",
    });
    mockVerifySignature.mockReturnValue({ valid: true, variant: "v2", secretIndex: 0 });
    mockSupabase.from.mockReturnValueOnce(
      chain({ data: null, error: { code: "57P03", message: "cannot connect" } }),
    );

    const res = await POST(
      makeRequest({ id: "evt_x", result: { tracking_code: "1Z999" } }, VALID_HEADERS),
    );
    expect(res.status).toBe(503);
    expect(mockTrigger).not.toHaveBeenCalled();
  });
});

describe("EasyPost webhook — payload shape handling", () => {
  it("returns 200 + status='no_tracker_data' when payload has no tracker", async () => {
    mockEnv.mockReturnValue({
      EASYPOST_WEBHOOK_SECRET: "secret-1",
      EASYPOST_WEBHOOK_SECRET_PREVIOUS: "",
      EASYPOST_WEBHOOK_REQUIRE_SIGNATURE: "true",
    });
    mockVerifySignature.mockReturnValue({ valid: true, variant: "v2", secretIndex: 0 });
    // No webhook_events insert when tracker data missing — early return.
    const res = await POST(makeRequest({ id: "evt_y" }, VALID_HEADERS));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("no_tracker_data");
    // Early return BEFORE the dedup insert.
    expect(mockSupabase.from).not.toHaveBeenCalled();
  });

  it("returns 200 + status='no_matching_shipment' but STILL writes to provider event ledger", async () => {
    mockEnv.mockReturnValue({
      EASYPOST_WEBHOOK_SECRET: "secret-1",
      EASYPOST_WEBHOOK_SECRET_PREVIOUS: "",
      EASYPOST_WEBHOOK_REQUIRE_SIGNATURE: "true",
    });
    mockVerifySignature.mockReturnValue({ valid: true, variant: "v2", secretIndex: 0 });
    mockSupabase.from
      .mockReturnValueOnce(chain({ data: { id: "wh-1" }, error: null })) // dedup insert
      .mockReturnValueOnce(chain({ data: null, error: null })); // shipment lookup

    const res = await POST(
      makeRequest(
        { id: "evt_z", result: { tracking_code: "ORPHAN-1", status: "in_transit" } },
        VALID_HEADERS,
      ),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("no_matching_shipment");
    // Slice 1 contract: ledger insert happens for unmatched shipments too.
    expect(mockRecordEvent).toHaveBeenCalledTimes(1);
    const ledgerArgs = mockRecordEvent.mock.calls[0]?.[1];
    expect(ledgerArgs.provider).toBe("easypost");
    expect(ledgerArgs.shipmentId).toBeNull();
    expect(ledgerArgs.workspaceId).toBeNull();
    // No status update + no email when there's no shipment.
    expect(mockUpdateTrackingStatus).not.toHaveBeenCalled();
    expect(mockTrigger).not.toHaveBeenCalled();
  });
});

describe("EasyPost webhook — happy path: delivered tracker", () => {
  it("triggers send-tracking-email and updates status via state-machine wrapper", async () => {
    mockEnv.mockReturnValue({
      EASYPOST_WEBHOOK_SECRET: "secret-1",
      EASYPOST_WEBHOOK_SECRET_PREVIOUS: "",
      EASYPOST_WEBHOOK_REQUIRE_SIGNATURE: "true",
    });
    mockVerifySignature.mockReturnValue({ valid: true, variant: "v2", secretIndex: 0 });
    const dedupChain = chain({ data: { id: "wh-2" }, error: null });
    const shipmentChain = chain({
      data: {
        id: "ship-1",
        workspace_id: "ws-1",
        easypost_tracker_id: "trk-1",
        easypost_tracker_public_url: "https://track.easypost.com/x",
        easypost_tracker_status: "in_transit",
      },
      error: null,
    });
    const existingEventsChain = chain({ data: [], error: null });
    const insertEventsChain = chain({ data: null, error: null });
    const sideUpdateChain = chain({ data: null, error: null });

    mockSupabase.from
      .mockReturnValueOnce(dedupChain)
      .mockReturnValueOnce(shipmentChain)
      .mockReturnValueOnce(existingEventsChain)
      .mockReturnValueOnce(insertEventsChain)
      .mockReturnValueOnce(sideUpdateChain);

    const res = await POST(
      makeRequest(
        {
          id: "evt_delivered_1",
          description: "tracker.updated",
          result: {
            id: "trk_1",
            tracking_code: "1Z999",
            status: "delivered",
            public_url: "https://track.easypost.com/x",
            tracking_details: [
              {
                id: "ep_detail_1",
                status: "delivered",
                status_detail: "delivered_to_recipient",
                description: "Delivered, Front Door/Porch",
                datetime: "2026-04-25T14:00:00Z",
                tracking_location: { city: "Brooklyn", state: "NY", country: "US" },
              },
            ],
          },
        },
        VALID_HEADERS,
      ),
    );
    expect(res.status).toBe(200);
    expect(mockUpdateTrackingStatus).toHaveBeenCalledWith(
      mockSupabase.client,
      expect.objectContaining({
        shipmentId: "ship-1",
        newStatus: "delivered",
      }),
    );
    expect(mockTrigger).toHaveBeenCalledWith(
      "send-tracking-email",
      expect.objectContaining({
        shipment_id: "ship-1",
        trigger_status: "delivered",
      }),
    );
    expect(mockRecordEvent).toHaveBeenCalledTimes(1);
  });
});
