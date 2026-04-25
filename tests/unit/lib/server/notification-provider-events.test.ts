// Slice 1 — append-only provider event ledger contract tests.
//
// Locks in the recordProviderEvent invariants:
//   - Single insert returns the new row.
//   - Recipient is lowercased before insert (case-insensitive matching).
//   - Optional fields default to null.
//   - 23505 (UNIQUE collision on (provider, provider_event_id)) is recovered
//     by re-fetching the prior row — caller never sees the error.
//   - Non-23505 PostgREST errors propagate as throws (so the route can
//     decide whether to 503 or fall through).

import { describe, expect, it, vi } from "vitest";
import { recordProviderEvent } from "@/lib/server/notification-provider-events";

interface MaybeSingleResult {
  data: unknown;
  error: { code: string; message: string } | null;
}

interface MockChain {
  insert: ReturnType<typeof vi.fn>;
  select: ReturnType<typeof vi.fn>;
  eq: ReturnType<typeof vi.fn>;
  maybeSingle: ReturnType<typeof vi.fn>;
}

/**
 * Build a Supabase client mock whose `.from(...)` returns a chain where
 *   insert -> select -> maybeSingle  resolves to insertResult,
 *   select -> eq -> eq -> maybeSingle resolves to refetchResult.
 *
 * Each `.from(...)` call returns a *fresh* chain so we can reason about
 * the insert path and the refetch path independently.
 */
function buildClient(insertResult: MaybeSingleResult, refetchResult?: MaybeSingleResult) {
  const insertChain: MockChain = {
    insert: vi.fn().mockReturnThis(),
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    maybeSingle: vi.fn().mockResolvedValue(insertResult),
  };
  const refetchChain: MockChain = {
    insert: vi.fn().mockReturnThis(),
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    maybeSingle: vi.fn().mockResolvedValue(refetchResult ?? { data: null, error: null }),
  };
  let call = 0;
  const from = vi.fn().mockImplementation(() => {
    call += 1;
    return call === 1 ? insertChain : refetchChain;
  });
  return { client: { from } as never, insertChain, refetchChain };
}

describe("recordProviderEvent — happy path", () => {
  it("inserts the row and returns it", async () => {
    const newRow = {
      id: "pev-1",
      provider: "resend",
      provider_event_id: "svix-evt-1",
      event_type: "email.delivered",
    };
    const { client, insertChain } = buildClient({ data: newRow, error: null });

    const result = await recordProviderEvent(client, {
      provider: "resend",
      providerEventId: "svix-evt-1",
      eventType: "email.delivered",
      providerMessageId: "rs-msg-1",
      workspaceId: "ws-1",
      notificationSendId: "ns-1",
      shipmentId: "sh-1",
      recipient: "Buyer@Example.com",
      occurredAt: "2026-04-25T12:00:00Z",
      payload: { type: "email.delivered" },
    });

    expect(result).toEqual(newRow);
    expect(insertChain.insert).toHaveBeenCalledOnce();
    const insertedRow = insertChain.insert.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(insertedRow.recipient).toBe("buyer@example.com");
    expect(insertedRow.provider_event_id).toBe("svix-evt-1");
    expect(insertedRow.workspace_id).toBe("ws-1");
    expect(insertedRow.notification_send_id).toBe("ns-1");
    expect(insertedRow.shipment_id).toBe("sh-1");
  });

  it("defaults optional fields to null", async () => {
    const { client, insertChain } = buildClient({
      data: { id: "pev-1" },
      error: null,
    });
    await recordProviderEvent(client, {
      provider: "easypost",
      providerEventId: "ep-1",
      eventType: "tracker.updated",
      payload: {},
    });
    const insertedRow = insertChain.insert.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(insertedRow.workspace_id).toBeNull();
    expect(insertedRow.notification_send_id).toBeNull();
    expect(insertedRow.shipment_id).toBeNull();
    expect(insertedRow.recipient).toBeNull();
    expect(insertedRow.occurred_at).toBeNull();
    expect(insertedRow.provider_message_id).toBeNull();
  });
});

describe("recordProviderEvent — UNIQUE collision recovery (23505)", () => {
  it("returns the existing row when (provider, provider_event_id) collides", async () => {
    const existing = {
      id: "pev-existing",
      provider: "easypost",
      provider_event_id: "ep-evt-1",
      event_type: "tracker.updated",
    };
    const { client, refetchChain } = buildClient(
      { data: null, error: { code: "23505", message: "duplicate key value" } },
      { data: existing, error: null },
    );

    const result = await recordProviderEvent(client, {
      provider: "easypost",
      providerEventId: "ep-evt-1",
      eventType: "tracker.updated",
      payload: { result: { tracking_code: "1Z" } },
    });

    expect(result).toEqual(existing);
    // Refetch must filter on BOTH provider and provider_event_id (the
    // composite UNIQUE key).
    expect(refetchChain.eq).toHaveBeenCalledWith("provider", "easypost");
    expect(refetchChain.eq).toHaveBeenCalledWith("provider_event_id", "ep-evt-1");
  });

  it("falls through to the original 23505 error when the recovery refetch returns no row", async () => {
    // This is a deeply broken state (the unique index says the row exists,
    // but the row is gone). The helper does NOT swallow the situation —
    // it propagates the original PostgREST message so the route can decide
    // (in practice: 503 / Sentry).
    const { client } = buildClient(
      { data: null, error: { code: "23505", message: "duplicate key value violates unique" } },
      { data: null, error: null },
    );
    await expect(
      recordProviderEvent(client, {
        provider: "resend",
        providerEventId: "lost-evt",
        eventType: "email.delivered",
        payload: {},
      }),
    ).rejects.toThrow(/recordProviderEvent failed: duplicate key value/);
  });
});

describe("recordProviderEvent — non-23505 errors propagate", () => {
  it("throws on a non-unique-violation PostgREST error", async () => {
    const { client } = buildClient({
      data: null,
      error: { code: "42P01", message: "relation does not exist" },
    });
    await expect(
      recordProviderEvent(client, {
        provider: "resend",
        providerEventId: "abc",
        eventType: "email.delivered",
        payload: {},
      }),
    ).rejects.toThrow(/relation does not exist/);
  });

  it("throws when the insert succeeds but returns no row (PostgREST quirk)", async () => {
    const { client } = buildClient({ data: null, error: null });
    await expect(
      recordProviderEvent(client, {
        provider: "resend",
        providerEventId: "abc",
        eventType: "email.delivered",
        payload: {},
      }),
    ).rejects.toThrow(/recordProviderEvent returned no row/);
  });
});
