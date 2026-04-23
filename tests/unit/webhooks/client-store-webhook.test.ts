/**
 * HRD-17.1 — client-store webhook route handler tests.
 *
 * Critical contract under test: the row in webhook_events MUST be created
 * BEFORE tasks.trigger() runs (so dedup works), but on enqueue failure the
 * route MUST flip status to 'enqueue_failed' AND return 5xx so the platform
 * retries — never silently swallow the trigger failure.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// --- Mocks (vi.hoisted ensures these are available to vi.mock factories) ---

const { mockFrom, mockTrigger, mockIdempotencyCreate } = vi.hoisted(() => ({
  mockFrom: vi.fn(),
  mockTrigger: vi.fn().mockResolvedValue({ id: "run-1" }),
  mockIdempotencyCreate: vi
    .fn()
    .mockImplementation(async (key: string) => ({ id: key, scope: "global" })),
}));

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({ from: mockFrom }),
}));

vi.mock("@/lib/server/webhook-body", async () => {
  // Use the real `checkWebhookFreshness` + dedup helpers so HRD-24 / F-3 /
  // F-4 route-level tests exercise the real logic without parallel mock
  // implementations that would silently drift from production behavior.
  const real = await vi.importActual<typeof import("@/lib/server/webhook-body")>(
    "@/lib/server/webhook-body",
  );
  return {
    readWebhookBody: vi.fn(async (req: Request) => req.text()),
    verifyHmacSignature: vi.fn(async () => true),
    checkWebhookFreshness: real.checkWebhookFreshness,
    sanitizeWebhookPayload: real.sanitizeWebhookPayload,
    interpretDedupError: real.interpretDedupError,
    canonicalBodyDedupKey: real.canonicalBodyDedupKey,
  };
});

vi.mock("@trigger.dev/sdk", () => ({
  tasks: { trigger: mockTrigger },
  idempotencyKeys: { create: mockIdempotencyCreate },
}));

import type { NextRequest } from "next/server";
import { POST } from "@/app/api/webhooks/client-store/route";

// --- Helpers ---

const CONNECTION_ID = "11111111-1111-4111-8111-111111111111";
const WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";

function makeRequest(
  body: Record<string, unknown>,
  opts: {
    connectionId?: string | null;
    headers?: Record<string, string>;
    platform?: string;
  } = {},
): NextRequest {
  const connectionId = opts.connectionId === undefined ? CONNECTION_ID : opts.connectionId;
  const platform = opts.platform ?? "shopify";
  const url = connectionId
    ? `https://example.com/api/webhooks/client-store?connection_id=${connectionId}&platform=${platform}`
    : `https://example.com/api/webhooks/client-store?platform=${platform}`;

  const defaultHeaders: Record<string, string> = {
    "X-Shopify-Hmac-SHA256": "valid-sig",
    "X-Shopify-Topic": "inventory_levels/update",
    "X-Shopify-Webhook-Id": `wh-${Math.random().toString(36).slice(2)}`,
    ...opts.headers,
  };
  // Empty string overrides delete the header (lets HRD-22 tests remove the
  // Shopify defaults to simulate Woo/Squarespace deliveries).
  for (const k of Object.keys(defaultHeaders)) {
    if (defaultHeaders[k] === "") delete defaultHeaders[k];
  }

  const req = new Request(url, {
    method: "POST",
    body: JSON.stringify(body),
    headers: defaultHeaders,
  });
  // Attach nextUrl shim — plain Request doesn't have it, but the route reads it.
  Object.defineProperty(req, "nextUrl", {
    value: new URL(url),
    writable: false,
  });
  return req as unknown as NextRequest;
}

interface ConnectionRow {
  id: string;
  workspace_id: string;
  platform: string;
  webhook_secret: string | null;
}

function setupSupabaseMock(opts: {
  connection?: ConnectionRow | null;
  insertResult?: "ok" | "duplicate" | "transient" | "unknown";
}) {
  const updateCalls: Array<{ table: string; payload: Record<string, unknown> }> = [];
  const insertCalls: Array<{ table: string; payload: Record<string, unknown> }> = [];

  // F-3: error shapes for the typed dedup helper. `transient` exercises a
  // pooler outage (08006); `unknown` exercises a NULL/constraint regression.
  const insertResponseFor = (kind: typeof opts.insertResult) => {
    switch (kind) {
      case "duplicate":
        return { data: null, error: { code: "23505", message: "duplicate" } };
      case "transient":
        return { data: null, error: { code: "08006", message: "connection_failure" } };
      case "unknown":
        return {
          data: null,
          error: { code: "23502", message: "null value in column violates not-null constraint" },
        };
      default:
        return { data: { id: "evt-1" }, error: null };
    }
  };

  mockFrom.mockImplementation((table: string) => {
    if (table === "client_store_connections") {
      return {
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue({
              data: opts.connection ?? null,
              error: opts.connection ? null : { message: "not found" },
            }),
          }),
        }),
      };
    }
    if (table === "webhook_events") {
      return {
        insert: vi.fn().mockImplementation((payload: Record<string, unknown>) => {
          insertCalls.push({ table, payload });
          return {
            select: vi.fn().mockReturnValue({
              single: vi.fn().mockResolvedValue(insertResponseFor(opts.insertResult)),
            }),
          };
        }),
        update: vi.fn().mockImplementation((payload: Record<string, unknown>) => {
          updateCalls.push({ table, payload });
          return {
            eq: vi.fn().mockResolvedValue({ data: null, error: null }),
          };
        }),
      };
    }
    return { insert: vi.fn(), update: vi.fn(), select: vi.fn() };
  });

  return { updateCalls, insertCalls };
}

// --- Tests ---

describe("POST /api/webhooks/client-store", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockTrigger.mockResolvedValue({ id: "run-1" });
    mockIdempotencyCreate.mockImplementation(async (key: string) => ({
      id: key,
      scope: "global",
    }));
  });

  it("returns 400 when connection_id is missing", async () => {
    const req = makeRequest({ id: 1 }, { connectionId: null });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it("returns 404 when connection does not exist", async () => {
    setupSupabaseMock({ connection: null });
    const req = makeRequest({ id: 1 });
    const res = await POST(req);
    expect(res.status).toBe(404);
  });

  it("returns 200 status='duplicate' on dedup constraint violation", async () => {
    setupSupabaseMock({
      connection: {
        id: CONNECTION_ID,
        workspace_id: WORKSPACE_ID,
        platform: "shopify",
        webhook_secret: null,
      },
      insertResult: "duplicate",
    });

    const req = makeRequest({ id: 1 });
    const res = await POST(req);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.status).toBe("duplicate");
    expect(mockTrigger).not.toHaveBeenCalled();
  });

  it("on success: enqueues with global idempotency key, marks status='enqueued', returns 200", async () => {
    const { updateCalls } = setupSupabaseMock({
      connection: {
        id: CONNECTION_ID,
        workspace_id: WORKSPACE_ID,
        platform: "shopify",
        webhook_secret: null,
      },
      insertResult: "ok",
    });

    const req = makeRequest({ id: 1, sku: "TEST-SKU" });
    const res = await POST(req);

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);

    // HRD-29: idempotency key created with global scope
    expect(mockIdempotencyCreate).toHaveBeenCalledWith("process-client-store-webhook:evt-1", {
      scope: "global",
    });
    // tasks.trigger called with that key
    expect(mockTrigger).toHaveBeenCalledWith(
      "process-client-store-webhook",
      { webhookEventId: "evt-1" },
      { idempotencyKey: { id: "process-client-store-webhook:evt-1", scope: "global" } },
    );
    // status flipped to 'enqueued'
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0]?.payload).toEqual({ status: "enqueued" });
  });

  it("HRD-17.1: on tasks.trigger() failure → marks status='enqueue_failed', returns 503 (so platform retries)", async () => {
    const { updateCalls } = setupSupabaseMock({
      connection: {
        id: CONNECTION_ID,
        workspace_id: WORKSPACE_ID,
        platform: "shopify",
        webhook_secret: null,
      },
      insertResult: "ok",
    });

    mockTrigger.mockRejectedValueOnce(new Error("Trigger.dev unreachable"));

    const req = makeRequest({ id: 1, sku: "TEST-SKU" });
    const res = await POST(req);

    expect(res.status).toBe(503);
    const json = await res.json();
    expect(json.ok).toBe(false);
    expect(json.status).toBe("enqueue_failed");
    expect(json.will_retry).toBe(true);

    expect(updateCalls).toHaveLength(1);
    const update = updateCalls[0]?.payload as Record<string, unknown>;
    expect(update.status).toBe("enqueue_failed");
    const meta = update.metadata as Record<string, unknown>;
    expect(meta.enqueue_error).toBe("Trigger.dev unreachable");
    expect(typeof meta.enqueue_failed_at).toBe("string");
  });

  it("HRD-17.1: on idempotencyKeys.create() failure → also marks status='enqueue_failed', returns 503", async () => {
    setupSupabaseMock({
      connection: {
        id: CONNECTION_ID,
        workspace_id: WORKSPACE_ID,
        platform: "shopify",
        webhook_secret: null,
      },
      insertResult: "ok",
    });

    mockIdempotencyCreate.mockRejectedValueOnce(new Error("idempotency-key SDK init failed"));

    const req = makeRequest({ id: 1 });
    const res = await POST(req);

    expect(res.status).toBe(503);
    expect(mockTrigger).not.toHaveBeenCalled();
  });

  // --- HRD-22: dedup key precedence ---

  it("HRD-22: prefers X-Shopify-Event-Id over X-Shopify-Webhook-Id for external_webhook_id", async () => {
    const { insertCalls } = setupSupabaseMock({
      connection: {
        id: CONNECTION_ID,
        workspace_id: WORKSPACE_ID,
        platform: "shopify",
        webhook_secret: null,
      },
      insertResult: "ok",
    });

    const req = makeRequest(
      { id: 1, sku: "TEST-SKU" },
      {
        headers: {
          "X-Shopify-Event-Id": "evt-business-event-id-stable-across-retries",
          "X-Shopify-Webhook-Id": "wh-per-delivery-changes-each-retry",
        },
      },
    );
    await POST(req);

    expect(insertCalls).toHaveLength(1);
    const insertedRow = insertCalls[0]?.payload as Record<string, unknown>;
    expect(insertedRow.external_webhook_id).toBe("evt-business-event-id-stable-across-retries");
  });

  it("HRD-22: falls back to X-Shopify-Webhook-Id when X-Shopify-Event-Id is absent (back-compat)", async () => {
    const { insertCalls } = setupSupabaseMock({
      connection: {
        id: CONNECTION_ID,
        workspace_id: WORKSPACE_ID,
        platform: "shopify",
        webhook_secret: null,
      },
      insertResult: "ok",
    });

    const req = makeRequest(
      { id: 1 },
      {
        // explicitly omit X-Shopify-Event-Id; default helper sets only X-Shopify-Webhook-Id
        headers: { "X-Shopify-Webhook-Id": "wh-fallback-value" },
      },
    );
    await POST(req);

    expect(insertCalls).toHaveLength(1);
    const insertedRow = insertCalls[0]?.payload as Record<string, unknown>;
    expect(insertedRow.external_webhook_id).toBe("wh-fallback-value");
  });

  // --- HRD-24: freshness ceiling ---

  it("HRD-24: rejects 401 stale_webhook when payload timestamp exceeds platform ceiling, never inserts row", async () => {
    const { insertCalls } = setupSupabaseMock({
      connection: {
        id: CONNECTION_ID,
        workspace_id: WORKSPACE_ID,
        platform: "shopify",
        webhook_secret: null,
      },
      insertResult: "ok",
    });

    // 100h-old payload — well past Shopify's 72h ceiling.
    const ancient = new Date(Date.now() - 100 * 60 * 60 * 1000).toISOString();
    const req = makeRequest({ id: 1, updated_at: ancient });
    const res = await POST(req);

    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.error).toBe("stale_webhook");
    expect(json.reason).toBe("exceeds_ceiling");
    // Critical: the row was NEVER inserted — suspect deliveries don't
    // pollute webhook_events, and tasks.trigger was never called.
    expect(insertCalls).toHaveLength(0);
    expect(mockTrigger).not.toHaveBeenCalled();
  });

  it("HRD-24: rejects 401 future_timestamp on payload >5 min in the future", async () => {
    const { insertCalls } = setupSupabaseMock({
      connection: {
        id: CONNECTION_ID,
        workspace_id: WORKSPACE_ID,
        platform: "shopify",
        webhook_secret: null,
      },
      insertResult: "ok",
    });

    const future = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    const req = makeRequest({ id: 1, updated_at: future });
    const res = await POST(req);

    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.reason).toBe("future_timestamp");
    expect(insertCalls).toHaveLength(0);
  });

  it("HRD-24: accepts 1h-old Shopify delivery (well within 72h ceiling)", async () => {
    const { insertCalls } = setupSupabaseMock({
      connection: {
        id: CONNECTION_ID,
        workspace_id: WORKSPACE_ID,
        platform: "shopify",
        webhook_secret: null,
      },
      insertResult: "ok",
    });

    const recent = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const req = makeRequest({ id: 1, updated_at: recent });
    const res = await POST(req);

    expect(res.status).toBe(200);
    expect(insertCalls).toHaveLength(1);
  });

  it("HRD-24: accepts payload with no timestamp (fail-OPEN — HRD-01 monotonic guard handles ordering)", async () => {
    const { insertCalls } = setupSupabaseMock({
      connection: {
        id: CONNECTION_ID,
        workspace_id: WORKSPACE_ID,
        platform: "shopify",
        webhook_secret: null,
      },
      insertResult: "ok",
    });

    const req = makeRequest({ id: 1 /* no updated_at, no created_at */ });
    const res = await POST(req);

    expect(res.status).toBe(200);
    expect(insertCalls).toHaveLength(1);
  });

  it("HRD-22: falls back to X-WC-Webhook-ID for non-Shopify platforms", async () => {
    const { insertCalls } = setupSupabaseMock({
      connection: {
        id: CONNECTION_ID,
        workspace_id: WORKSPACE_ID,
        platform: "woocommerce",
        webhook_secret: null,
      },
      insertResult: "ok",
    });

    const req = makeRequest(
      { id: 1 },
      {
        headers: {
          // Drop both Shopify headers to simulate Woo delivery; keep WC header.
          "X-Shopify-Hmac-SHA256": "",
          "X-Shopify-Topic": "",
          "X-Shopify-Webhook-Id": "",
          "X-WC-Webhook-ID": "wc-delivery-id-789",
          "X-WC-Webhook-Signature": "valid-sig",
        },
      },
    );
    await POST(req);

    expect(insertCalls).toHaveLength(1);
    const insertedRow = insertCalls[0]?.payload as Record<string, unknown>;
    expect(insertedRow.external_webhook_id).toBe("wc-delivery-id-789");
  });

  it("HRD-30: strips PII (customer block, email, billing address) before persisting webhook_events.metadata", async () => {
    const { insertCalls } = setupSupabaseMock({
      connection: {
        id: CONNECTION_ID,
        workspace_id: WORKSPACE_ID,
        platform: "shopify",
        webhook_secret: "secret",
      },
      insertResult: "ok",
    });

    const piiPayload = {
      id: 99887766,
      name: "#1042",
      email: "buyer@example.com",
      customer: {
        id: 5550001,
        first_name: "Jane",
        last_name: "Doe",
        email: "buyer@example.com",
      },
      billing_address: {
        address1: "123 Main St",
        city: "Brooklyn",
        zip: "11211",
      },
      line_items: [{ id: 1, sku: "SKU-A", quantity: 2 }],
    };

    await POST(
      makeRequest(piiPayload, {
        headers: {
          "X-Shopify-Topic": "orders/create",
          "X-Shopify-Event-Id": "evt-pii-1",
          "X-Shopify-Triggered-At": new Date().toISOString(),
        },
      }),
    );

    expect(insertCalls).toHaveLength(1);
    const insertedRow = insertCalls[0]?.payload as Record<string, unknown>;
    const metadata = insertedRow.metadata as Record<string, unknown>;
    const persistedPayload = metadata.payload as Record<string, unknown>;

    expect(persistedPayload.id).toBe(99887766);
    expect(persistedPayload.name).toBe("#1042");
    expect(persistedPayload.email).toBe("[REDACTED]");
    expect(persistedPayload.customer).toBe("[REDACTED]");
    expect(persistedPayload.billing_address).toBe("[REDACTED]");
    expect(persistedPayload.line_items).toEqual([{ id: 1, sku: "SKU-A", quantity: 2 }]);
  });

  // --- F-3: typed dedup outcomes ---

  it("F-3: SQLSTATE 08006 (connection_failure) → 503 transient (NOT silently swallowed as duplicate)", async () => {
    setupSupabaseMock({
      connection: {
        id: CONNECTION_ID,
        workspace_id: WORKSPACE_ID,
        platform: "shopify",
        webhook_secret: null,
      },
      insertResult: "transient",
    });

    const req = makeRequest({ id: 1 });
    const res = await POST(req);

    // Pre-F-3 this returned 200 "duplicate" and the platform stopped
    // retrying — losing the event. Post-F-3 we return 503 so Shopify
    // retries, and the structured log captures error_code=08006 for
    // operator triage.
    expect(res.status).toBe(503);
    const json = await res.json();
    expect(json.status).toBe("transient_dedup_failure");
    expect(json.will_retry).toBe(true);
    expect(mockTrigger).not.toHaveBeenCalled();
  });

  it("F-3: SQLSTATE 23502 (NOT NULL violation) → 503 unknown (so platform retries + ops sees the bug)", async () => {
    setupSupabaseMock({
      connection: {
        id: CONNECTION_ID,
        workspace_id: WORKSPACE_ID,
        platform: "shopify",
        webhook_secret: null,
      },
      insertResult: "unknown",
    });

    const req = makeRequest({ id: 1 });
    const res = await POST(req);

    expect(res.status).toBe(503);
    const json = await res.json();
    expect(json.status).toBe("unknown_dedup_failure");
    expect(mockTrigger).not.toHaveBeenCalled();
  });

  it("F-3: emits structured `webhook_dedup` log line with sqlState + dedup_kind on every non-fresh outcome", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      setupSupabaseMock({
        connection: {
          id: CONNECTION_ID,
          workspace_id: WORKSPACE_ID,
          platform: "shopify",
          webhook_secret: null,
        },
        insertResult: "transient",
      });
      await POST(makeRequest({ id: 1 }));

      const dedupLogs = consoleSpy.mock.calls
        .map((c) => String(c[0]))
        .filter((s) => s.includes('"tag":"webhook_dedup"'));
      expect(dedupLogs.length).toBeGreaterThanOrEqual(1);
      const parsed = JSON.parse(dedupLogs[0] ?? "{}");
      expect(parsed).toMatchObject({
        tag: "webhook_dedup",
        connection_id: CONNECTION_ID,
        platform: "shopify",
        dedup_kind: "transient",
        error_code: "08006",
      });
    } finally {
      consoleSpy.mockRestore();
    }
  });

  // --- F-4: canonical-body sha256 dedup fallback ---

  it("F-4: when no header webhook id is present, dedup_key is `{platform}:{sha256(body)}` and is stable across retries", async () => {
    const { insertCalls } = setupSupabaseMock({
      connection: {
        id: CONNECTION_ID,
        workspace_id: WORKSPACE_ID,
        platform: "squarespace",
        webhook_secret: null,
      },
      insertResult: "ok",
    });

    const body = { order: { id: 9876 } };
    // Drop every Shopify/WC header so we hit the F-4 hash fallback.
    const reqA = makeRequest(body, {
      platform: "squarespace",
      headers: {
        "X-Shopify-Hmac-SHA256": "",
        "X-Shopify-Topic": "",
        "X-Shopify-Webhook-Id": "",
      },
    });
    const reqB = makeRequest(body, {
      platform: "squarespace",
      headers: {
        "X-Shopify-Hmac-SHA256": "",
        "X-Shopify-Topic": "",
        "X-Shopify-Webhook-Id": "",
      },
    });
    await POST(reqA);
    await POST(reqB);

    expect(insertCalls).toHaveLength(2);
    const a = insertCalls[0]?.payload as Record<string, unknown>;
    const b = insertCalls[1]?.payload as Record<string, unknown>;
    expect(a.dedup_key).toEqual(b.dedup_key); // stable across retries (was Date.now()-broken pre-F-4)
    expect(typeof a.dedup_key).toBe("string");
    expect((a.dedup_key as string).startsWith("squarespace:")).toBe(true);
    // 64-char hex hash suffix
    const [, hash] = (a.dedup_key as string).split(":");
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    // external_webhook_id mirrors the dedup key when no header was supplied,
    // preserving the existing UNIQUE constraint semantics.
    expect(a.external_webhook_id).toBe(a.dedup_key);
  });

  it("F-4: when X-Shopify-Event-Id IS present, dedup_key = `{connection_id}:{event_id}` (per-connection scope)", async () => {
    const { insertCalls } = setupSupabaseMock({
      connection: {
        id: CONNECTION_ID,
        workspace_id: WORKSPACE_ID,
        platform: "shopify",
        webhook_secret: null,
      },
      insertResult: "ok",
    });

    await POST(
      makeRequest({ id: 1 }, { headers: { "X-Shopify-Event-Id": "evt-stable-business-id" } }),
    );

    expect(insertCalls).toHaveLength(1);
    const inserted = insertCalls[0]?.payload as Record<string, unknown>;
    expect(inserted.dedup_key).toBe(`${CONNECTION_ID}:evt-stable-business-id`);
    expect(inserted.external_webhook_id).toBe("evt-stable-business-id");
  });

  // ─── HRD-22 / OQ-1 closure (Phase 0 §9.1 D5) ────────────────────────────
  //
  // Plan §9.1 D5 wants this combined invariant pinned in one place so a
  // future refactor can't silently drop either side:
  //   1. external_webhook_id MUST resolve to the X-Shopify-Event-Id header
  //      value when both Event-Id and Webhook-Id are present (Event-Id is
  //      per-business-event = stable across retries; Webhook-Id is
  //      per-delivery = changes each retry → would permit double-process).
  //   2. dedup_key MUST be `{connection_id}:{event-id}` (per-connection
  //      scope, not the loose `'shopify:{event-id}'` that the plan prose
  //      sketched — connection scope is stricter, since two connections in
  //      the same workspace could theoretically collide on Shopify event-id
  //      across different shops).
  //   3. Three retries of the SAME business event with rotating Webhook-Ids
  //      MUST collapse to a single dedup_key (the row only inserts once;
  //      the second + third retries hit the dedup constraint).
  //
  // Closes OQ-1: "Confirm `X-Shopify-Event-Id` is the canonical dedup
  // header for retries of the same business event."
  it("HRD-22 / OQ-1: Event-Id is the canonical dedup header — three retries of one event collapse to one row", async () => {
    // Track unique dedup_keys per insert. We can't replay duplicate-error
    // semantics through the existing setupSupabaseMock helper without
    // more plumbing, so we run three POSTs with the same Event-Id but
    // rotating Webhook-Ids and assert all three resolve to the SAME
    // dedup_key + external_webhook_id. The DB-level UNIQUE(platform,
    // external_webhook_id) constraint (migration 008 line 67) is what
    // actually rejects retries 2/3 in production; the contract this test
    // pins is "the route picks the stable identifier for the dedup key".
    const { insertCalls } = setupSupabaseMock({
      connection: {
        id: CONNECTION_ID,
        workspace_id: WORKSPACE_ID,
        platform: "shopify",
        webhook_secret: null,
      },
      insertResult: "ok",
    });

    const stableEventId = "evt-business-event-stable-123";
    for (let retry = 1; retry <= 3; retry++) {
      await POST(
        makeRequest(
          { id: 1, sku: "TEST" },
          {
            headers: {
              "X-Shopify-Event-Id": stableEventId,
              // Webhook-Id rotates on every retry — proves we don't fall
              // back to it when Event-Id is present.
              "X-Shopify-Webhook-Id": `wh-delivery-${retry}-${Math.random()}`,
            },
          },
        ),
      );
    }

    expect(insertCalls).toHaveLength(3);
    const dedupKeys = insertCalls.map(
      (c) => (c.payload as Record<string, unknown>).dedup_key as string,
    );
    const externalIds = insertCalls.map(
      (c) => (c.payload as Record<string, unknown>).external_webhook_id as string,
    );
    // All three retries MUST produce the same dedup_key — proves
    // X-Shopify-Webhook-Id rotation does not poison the dedup boundary.
    expect(new Set(dedupKeys).size).toBe(1);
    expect(dedupKeys[0]).toBe(`${CONNECTION_ID}:${stableEventId}`);
    // external_webhook_id is the unsuffixed Event-Id (per-event scope at
    // the column level; the dedup_key carries the connection prefix).
    expect(new Set(externalIds).size).toBe(1);
    expect(externalIds[0]).toBe(stableEventId);
  });
});
