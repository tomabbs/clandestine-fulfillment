// Slice 2 — notification_sends helper contract tests.
//
// recordSend() is the "DB belt" of the three-layer idempotency contract
// (see notification-sends.ts header comment). The recovery branch must:
//
//   - On 23505 with an idempotency_key  -> refetch by key
//   - On 23505 without an idempotency_key -> refetch via findPriorActiveSend
//   - If neither path finds a row -> propagate the original 23505
//   - Non-23505 PostgREST errors -> propagate as throw
//
// findPriorActiveSend / findPriorSuccessfulSend / findNotificationSendByMessageId /
// findNotificationSendByIdempotencyKey all have similar "select-where-eq-eq-…"
// shapes; we exercise the chain ordering / filter args explicitly because
// the wrong filter (e.g. forgetting trigger_status) would silently return
// the wrong row in production.

import { describe, expect, it, vi } from "vitest";
import {
  ACTIVE_NOTIFICATION_STATUSES,
  STICKY_TERMINAL_STATUSES,
  bumpAttemptBookkeeping,
  findNotificationSendByIdempotencyKey,
  findNotificationSendByMessageId,
  findPriorActiveSend,
  findPriorSuccessfulSend,
  recordSend,
  stampResendMessageId,
  suppressRecipient,
} from "@/lib/server/notification-sends";

type MaybeResult = { data: unknown; error: { code: string; message: string } | null };

interface Chain {
  insert: ReturnType<typeof vi.fn>;
  select: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  eq: ReturnType<typeof vi.fn>;
  in: ReturnType<typeof vi.fn>;
  order: ReturnType<typeof vi.fn>;
  limit: ReturnType<typeof vi.fn>;
  or: ReturnType<typeof vi.fn>;
  maybeSingle: ReturnType<typeof vi.fn>;
  then: (resolve: (value: MaybeResult) => unknown) => unknown;
}

function makeChain(result: MaybeResult): Chain {
  // The chain itself is thenable so that callers like
  //   `await supabase.from(t).update({...}).eq("id", x)`
  //   `await supabase.from(t).insert({...})`
  // (which never call .maybeSingle()) resolve to the same
  // `{ data, error }` payload as terminal .maybeSingle() callers.
  const c = {
    insert: vi.fn(),
    select: vi.fn(),
    update: vi.fn(),
    eq: vi.fn(),
    in: vi.fn(),
    order: vi.fn(),
    limit: vi.fn(),
    or: vi.fn(),
    maybeSingle: vi.fn().mockResolvedValue(result),
    then(resolve: (value: MaybeResult) => unknown) {
      return Promise.resolve(result).then(resolve);
    },
  } as Chain;
  c.insert.mockReturnValue(c);
  c.select.mockReturnValue(c);
  c.update.mockReturnValue(c);
  c.eq.mockReturnValue(c);
  c.in.mockReturnValue(c);
  c.order.mockReturnValue(c);
  c.limit.mockReturnValue(c);
  c.or.mockReturnValue(c);
  return c;
}

/**
 * Build a Supabase mock whose successive `.from(...)` calls return the
 * pre-queued chains in order. Each chain is keyed to a specific result;
 * tests assert chain.* invocations to verify the filter contract.
 */
function buildClient(...results: MaybeResult[]) {
  const chains = results.map((r) => makeChain(r));
  let i = 0;
  const from = vi.fn().mockImplementation(() => {
    const next = chains[i] ?? chains[chains.length - 1];
    i += 1;
    return next;
  });
  return { client: { from } as never, chains, from };
}

describe("ACTIVE_NOTIFICATION_STATUSES (set used by widened partial unique index)", () => {
  it("matches the v4 plan's widened index predicate exactly", () => {
    // v4 plan: WHERE status IN ('pending','sent','delivered','delivery_delayed',
    //                            'bounced','complained','provider_suppressed','shadow')
    expect(ACTIVE_NOTIFICATION_STATUSES.size).toBe(8);
    expect(ACTIVE_NOTIFICATION_STATUSES.has("pending")).toBe(true);
    expect(ACTIVE_NOTIFICATION_STATUSES.has("sent")).toBe(true);
    expect(ACTIVE_NOTIFICATION_STATUSES.has("delivered")).toBe(true);
    expect(ACTIVE_NOTIFICATION_STATUSES.has("delivery_delayed")).toBe(true);
    expect(ACTIVE_NOTIFICATION_STATUSES.has("bounced")).toBe(true);
    expect(ACTIVE_NOTIFICATION_STATUSES.has("complained")).toBe(true);
    expect(ACTIVE_NOTIFICATION_STATUSES.has("provider_suppressed")).toBe(true);
    expect(ACTIVE_NOTIFICATION_STATUSES.has("shadow")).toBe(true);
    // CRITICAL: provider_failed and cancelled MUST be excluded so retries
    // can create fresh pending rows.
    expect(ACTIVE_NOTIFICATION_STATUSES.has("provider_failed")).toBe(false);
    expect(ACTIVE_NOTIFICATION_STATUSES.has("cancelled")).toBe(false);
  });
});

describe("STICKY_TERMINAL_STATUSES", () => {
  it("matches the state-machine sticky terminals", () => {
    expect(STICKY_TERMINAL_STATUSES.has("bounced")).toBe(true);
    expect(STICKY_TERMINAL_STATUSES.has("complained")).toBe(true);
    expect(STICKY_TERMINAL_STATUSES.has("cancelled")).toBe(true);
    // delivered is a sticky-positive terminal in the state machine but it
    // is NOT in this set — the constant is for "do not retry / suppress
    // future sends" decisions, where delivered behaves like a fresh
    // success and a new trigger can fire.
    expect(STICKY_TERMINAL_STATUSES.has("delivered")).toBe(false);
  });
});

describe("recordSend — happy path", () => {
  it("inserts and returns the row", async () => {
    const inserted = { id: "ns-1", status: "pending", shipment_id: "sh-1" };
    const { client, chains } = buildClient({ data: inserted, error: null });

    const result = await recordSend(client, {
      workspaceId: "ws-1",
      shipmentId: "sh-1",
      triggerStatus: "shipped",
      templateId: "t-1",
      recipient: "buyer@example.com",
      status: "pending",
    });
    expect(result).toEqual(inserted);
    const insertedRow = chains[0]?.insert.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(insertedRow.shipment_id).toBe("sh-1");
    expect(insertedRow.status).toBe("pending");
    expect(insertedRow.channel).toBe("email"); // default
    expect(insertedRow.attempt_count).toBe(0);
  });

  it("auto-fills sent_at when status='sent' and sentAt not provided", async () => {
    const before = Date.now();
    const { client, chains } = buildClient({ data: { id: "ns-1" }, error: null });
    await recordSend(client, {
      workspaceId: "ws-1",
      shipmentId: "sh-1",
      triggerStatus: "shipped",
      templateId: "t-1",
      recipient: "x@y.z",
      status: "sent",
    });
    const insertedRow = chains[0]?.insert.mock.calls[0]?.[0] as Record<string, unknown>;
    const sentAt = Date.parse(insertedRow.sent_at as string);
    expect(sentAt).toBeGreaterThanOrEqual(before);
    expect(sentAt).toBeLessThanOrEqual(Date.now() + 1);
  });

  it("does NOT auto-fill sent_at for status='pending'", async () => {
    const { client, chains } = buildClient({ data: { id: "ns-1" }, error: null });
    await recordSend(client, {
      workspaceId: "ws-1",
      shipmentId: "sh-1",
      triggerStatus: "shipped",
      templateId: "t-1",
      recipient: "x@y.z",
      status: "pending",
    });
    const insertedRow = chains[0]?.insert.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(insertedRow.sent_at).toBeNull();
  });
});

describe("recordSend — 23505 recovery (the Slice 2 dedup contract)", () => {
  it("recovers via idempotency_key when supplied", async () => {
    const winner = { id: "ns-winner", status: "pending", idempotency_key: "key-1" };
    const { client, chains } = buildClient(
      { data: null, error: { code: "23505", message: "dup" } },
      { data: winner, error: null }, // findNotificationSendByIdempotencyKey
    );
    const result = await recordSend(client, {
      workspaceId: "ws-1",
      shipmentId: "sh-1",
      triggerStatus: "shipped",
      templateId: "t-1",
      recipient: "x@y.z",
      status: "pending",
      idempotencyKey: "key-1",
    });
    expect(result).toEqual(winner);
    // Recovery branch hit the idempotency_key lookup, not the (shipment,
    // trigger) lookup.
    expect(chains[1]?.eq).toHaveBeenCalledWith("idempotency_key", "key-1");
  });

  it("recovers via (shipment, trigger) active-row lookup when idempotency_key absent", async () => {
    const winner = { id: "ns-winner", status: "sent", shipment_id: "sh-1" };
    const { client, chains } = buildClient(
      { data: null, error: { code: "23505", message: "dup" } },
      { data: winner, error: null }, // findPriorActiveSend
    );
    const result = await recordSend(client, {
      workspaceId: "ws-1",
      shipmentId: "sh-1",
      triggerStatus: "shipped",
      templateId: "t-1",
      recipient: "x@y.z",
      status: "pending",
    });
    expect(result).toEqual(winner);
    // Recovery branch filtered on (shipment_id, trigger_status, status IN active).
    expect(chains[1]?.eq).toHaveBeenCalledWith("shipment_id", "sh-1");
    expect(chains[1]?.eq).toHaveBeenCalledWith("trigger_status", "shipped");
    expect(chains[1]?.in).toHaveBeenCalledWith(
      "status",
      Array.from(ACTIVE_NOTIFICATION_STATUSES),
    );
  });

  it("falls through and throws when 23505 fires but no recovery row found", async () => {
    const { client } = buildClient(
      { data: null, error: { code: "23505", message: "dup-but-gone" } },
      { data: null, error: null }, // idempotency_key lookup -> empty
      { data: null, error: null }, // findPriorActiveSend -> empty
    );
    await expect(
      recordSend(client, {
        workspaceId: "ws-1",
        shipmentId: "sh-1",
        triggerStatus: "shipped",
        templateId: "t-1",
        recipient: "x@y.z",
        status: "pending",
        idempotencyKey: "ghost-key",
      }),
    ).rejects.toThrow(/recordSend failed: dup-but-gone/);
  });

  it("propagates non-23505 PostgREST errors as throws", async () => {
    const { client } = buildClient({
      data: null,
      error: { code: "42703", message: "column does not exist" },
    });
    await expect(
      recordSend(client, {
        workspaceId: "ws-1",
        shipmentId: "sh-1",
        triggerStatus: "shipped",
        templateId: "t-1",
        recipient: "x@y.z",
        status: "pending",
      }),
    ).rejects.toThrow(/column does not exist/);
  });

  it("throws when insert succeeds with no row + no error (defensive)", async () => {
    const { client } = buildClient({ data: null, error: null });
    await expect(
      recordSend(client, {
        workspaceId: "ws-1",
        shipmentId: "sh-1",
        triggerStatus: "shipped",
        templateId: "t-1",
        recipient: "x@y.z",
        status: "pending",
      }),
    ).rejects.toThrow(/recordSend returned no row/);
  });
});

describe("findPriorActiveSend filter contract", () => {
  it("filters on shipment_id + trigger_status + status IN active set", async () => {
    const { client, chains } = buildClient({ data: { id: "ns-active" }, error: null });
    await findPriorActiveSend(client, {
      shipmentId: "sh-1",
      triggerStatus: "delivered",
    });
    expect(chains[0]?.eq).toHaveBeenCalledWith("shipment_id", "sh-1");
    expect(chains[0]?.eq).toHaveBeenCalledWith("trigger_status", "delivered");
    expect(chains[0]?.in).toHaveBeenCalledWith(
      "status",
      Array.from(ACTIVE_NOTIFICATION_STATUSES),
    );
    expect(chains[0]?.order).toHaveBeenCalledWith("pending_at", { ascending: false });
    expect(chains[0]?.limit).toHaveBeenCalledWith(1);
  });

  it("returns null when no active row exists", async () => {
    const { client } = buildClient({ data: null, error: null });
    const result = await findPriorActiveSend(client, {
      shipmentId: "sh-1",
      triggerStatus: "shipped",
    });
    expect(result).toBeNull();
  });
});

describe("findPriorSuccessfulSend filter contract", () => {
  it("only matches sent / shadow / delivered (the strict success set)", async () => {
    const { client, chains } = buildClient({ data: { id: "ns" }, error: null });
    await findPriorSuccessfulSend(client, {
      shipmentId: "sh-1",
      triggerStatus: "shipped",
    });
    expect(chains[0]?.in).toHaveBeenCalledWith("status", ["sent", "shadow", "delivered"]);
  });
});

describe("findNotificationSendByMessageId / findNotificationSendByIdempotencyKey", () => {
  it("looks up by resend_message_id", async () => {
    const { client, chains } = buildClient({
      data: { id: "ns-1", resend_message_id: "rs-msg-1" },
      error: null,
    });
    const result = await findNotificationSendByMessageId(client, "rs-msg-1");
    expect(chains[0]?.eq).toHaveBeenCalledWith("resend_message_id", "rs-msg-1");
    expect(result?.id).toBe("ns-1");
  });

  it("looks up by idempotency_key", async () => {
    const { client, chains } = buildClient({
      data: { id: "ns-2", idempotency_key: "k-1" },
      error: null,
    });
    const result = await findNotificationSendByIdempotencyKey(client, "k-1");
    expect(chains[0]?.eq).toHaveBeenCalledWith("idempotency_key", "k-1");
    expect(result?.id).toBe("ns-2");
  });
});

describe("bumpAttemptBookkeeping", () => {
  it("updates the bookkeeping fields without touching status", async () => {
    const { client, chains } = buildClient({ data: null, error: null });
    await bumpAttemptBookkeeping(client, {
      notificationSendId: "ns-1",
      attemptCount: 3,
      lastAttemptAt: "2026-04-25T12:00:00Z",
      nextRetryAt: "2026-04-25T12:05:00Z",
      error: "rate-limited",
    });
    const update = chains[0]?.update.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(update.attempt_count).toBe(3);
    expect(update.last_attempt_at).toBe("2026-04-25T12:00:00Z");
    expect(update.next_retry_at).toBe("2026-04-25T12:05:00Z");
    expect(update.error).toBe("rate-limited");
    // CI grep guard contract: this update MUST NOT touch status.
    expect(update.status).toBeUndefined();
  });

  it("throws on update error", async () => {
    const { client } = buildClient({
      data: null,
      error: { code: "42P01", message: "relation does not exist" },
    });
    await expect(
      bumpAttemptBookkeeping(client, {
        notificationSendId: "ns-1",
        attemptCount: 1,
        lastAttemptAt: "2026-04-25T12:00:00Z",
      }),
    ).rejects.toThrow(/relation does not exist/);
  });
});

describe("stampResendMessageId", () => {
  it("only updates resend_message_id", async () => {
    const { client, chains } = buildClient({ data: null, error: null });
    await stampResendMessageId(client, {
      notificationSendId: "ns-1",
      resendMessageId: "rs-msg-X",
    });
    const update = chains[0]?.update.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(update).toEqual({ resend_message_id: "rs-msg-X" });
    expect(update.status).toBeUndefined();
  });
});

describe("suppressRecipient — idempotent insert", () => {
  it("ignores 23505 (already suppressed) without throwing", async () => {
    const { client } = buildClient({
      data: null,
      error: { code: "23505", message: "dup" },
    });
    await expect(
      suppressRecipient(client, {
        workspaceId: "ws-1",
        recipient: "buyer@example.com",
        suppressionType: "bounce",
      }),
    ).resolves.toBeUndefined();
  });

  it("propagates non-23505 errors", async () => {
    const { client } = buildClient({
      data: null,
      error: { code: "42P01", message: "relation does not exist" },
    });
    await expect(
      suppressRecipient(client, {
        workspaceId: "ws-1",
        recipient: "buyer@example.com",
        suppressionType: "bounce",
      }),
    ).rejects.toThrow(/relation does not exist/);
  });
});
