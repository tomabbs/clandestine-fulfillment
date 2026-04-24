/**
 * Phase 2 §9.3 D1 — per-connection Bandcamp order dispatch tests.
 *
 * Covers the four routing outcomes for an "isBandcampOrder" email:
 *   1. exactly one bandcamp_connections.inbound_forwarding_address matches
 *      one of the recipient addresses → fires
 *      `bandcamp-sale-poll-per-connection` with that connection's
 *      workspace + idempotency key + sensor=healthy.
 *   2. zero matches → falls back to the global `bandcamp-sale-poll` cron +
 *      sensor=warning(no_match_fallback).
 *   3. multiple matches → falls back to the global cron + sensor=warning(
 *      ambiguous_fallback). This is an operator config error (two rows
 *      sharing an alias) but the global poll still works correctly.
 *   4. lookup error from Supabase → falls back to global cron without
 *      throwing (the per-connection branch only matters as an
 *      optimisation; a transient DB error must not 500 the webhook).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockTrigger } = vi.hoisted(() => ({ mockTrigger: vi.fn() }));

vi.mock("@trigger.dev/sdk", () => ({
  tasks: { trigger: mockTrigger },
}));

vi.mock("@sentry/nextjs", () => ({
  captureException: vi.fn(),
  captureMessage: vi.fn(),
}));

import { routeInboundEmail } from "@/lib/server/resend-inbound-router";

interface InsertSpy {
  table: string;
  payload: Record<string, unknown>;
}

function makeFakeSupabase(opts: {
  /** rows returned from `bandcamp_connections.in("inbound_forwarding_address", [...])`. */
  bandcampMatches?: Array<{
    id: string;
    workspace_id: string;
    band_id: number;
    inbound_forwarding_address: string | null;
  }>;
  bandcampLookupError?: { message: string } | null;
}) {
  const inserts: InsertSpy[] = [];
  const updates: Array<{ table: string; id: string; payload: Record<string, unknown> }> = [];

  const from = vi.fn().mockImplementation((table: string) => {
    if (table === "bandcamp_connections") {
      return {
        select: vi.fn().mockImplementation(() => ({
          eq: vi.fn().mockImplementation(() => ({
            in: vi.fn().mockResolvedValue({
              data: opts.bandcampMatches ?? [],
              error: opts.bandcampLookupError ?? null,
            }),
          })),
        })),
      };
    }
    if (table === "sensor_readings") {
      return {
        insert: vi.fn().mockImplementation((payload: Record<string, unknown>) => {
          inserts.push({ table, payload });
          return Promise.resolve({ error: null });
        }),
      };
    }
    if (table === "webhook_events") {
      return {
        update: vi.fn().mockImplementation((payload: Record<string, unknown>) => ({
          eq: vi.fn().mockImplementation((_col: string, id: string) => {
            updates.push({ table, id, payload });
            return Promise.resolve({ error: null });
          }),
        })),
      };
    }
    // Catch-all returns chainable no-ops so the support_messages /
    // support_email_mappings strategies don't crash on tables we don't care
    // about in these tests (the Bandcamp branch returns BEFORE reaching
    // them).
    return {
      select: vi.fn().mockReturnValue({
        in: vi.fn().mockReturnValue({
          limit: vi.fn().mockReturnValue({
            maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
          }),
        }),
        eq: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
          }),
          maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
        }),
      }),
      insert: vi.fn().mockImplementation((payload: Record<string, unknown>) => {
        inserts.push({ table, payload });
        return Promise.resolve({ error: null });
      }),
    };
  });

  return {
    supabase: { from } as unknown as Parameters<typeof routeInboundEmail>[0]["supabase"],
    inserts,
    updates,
  };
}

function bandcampOrderEmail(overrides: Partial<{ to: string[]; cc: string[] }> = {}) {
  return {
    emailId: "em_test",
    envelopeFrom: "noreply@bandcamp.com",
    envelopeTo: ["orders@clandestinedistro.com"],
    realFrom: "noreply@bandcamp.com",
    to: overrides.to ?? ["orders+truepanther@clandestinedistro.com"],
    cc: overrides.cc ?? [],
    subject: "Bam! Another order for True Panther",
    text: "Body",
    html: null as string | null,
    messageId: "<msg-bc@bandcamp.com>",
    inReplyTo: undefined,
    references: [],
    headers: {},
  };
}

describe("routeInboundEmail — Phase 2 §9.3 D1 per-connection Bandcamp dispatch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockTrigger.mockResolvedValue({ id: "run_x" });
  });

  it("recipient_match: single matching connection fires per-connection task with idempotency key", async () => {
    const { supabase, inserts, updates } = makeFakeSupabase({
      bandcampMatches: [
        {
          id: "conn-1",
          workspace_id: "ws-tp",
          band_id: 12345,
          inbound_forwarding_address: "orders+truepanther@clandestinedistro.com",
        },
      ],
    });

    const result = await routeInboundEmail({
      supabase,
      workspaceId: "ws-resolved",
      webhookEventId: "evt-bc-1",
      email: bandcampOrderEmail(),
    });

    expect(result.status).toBe("bandcamp_order_per_connection_dispatched");
    expect(mockTrigger).toHaveBeenCalledTimes(1);
    expect(mockTrigger).toHaveBeenCalledWith(
      "bandcamp-sale-poll-per-connection",
      expect.objectContaining({
        workspaceId: "ws-tp",
        connectionId: "conn-1",
        triggeredByWebhookEventId: "evt-bc-1",
        recipient: "orders+truepanther@clandestinedistro.com",
      }),
      expect.objectContaining({
        idempotencyKey: "bandcamp-per-connection:conn-1:evt-bc-1",
        idempotencyKeyTTL: "10m",
      }),
    );

    const evtUpdate = updates.find((u) => u.table === "webhook_events" && u.id === "evt-bc-1");
    expect(evtUpdate?.payload).toMatchObject({
      status: "processed",
      topic: "bandcamp_order_per_connection",
    });

    const sensor = inserts.find((i) => i.table === "sensor_readings");
    expect(sensor?.payload).toMatchObject({
      sensor_name: "bandcamp.email_per_connection",
      status: "healthy",
      workspace_id: "ws-tp",
      value: expect.objectContaining({
        outcome: "recipient_match",
        connection_id: "conn-1",
        candidate_count: 1,
      }),
    });
  });

  it("no_match_fallback: zero matches → global poll cron fires + sensor warns", async () => {
    const { supabase, inserts, updates } = makeFakeSupabase({ bandcampMatches: [] });

    const result = await routeInboundEmail({
      supabase,
      workspaceId: "ws-resolved",
      webhookEventId: "evt-bc-2",
      email: bandcampOrderEmail({
        to: ["orders+unconfigured@clandestinedistro.com"],
      }),
    });

    expect(result.status).toBe("bandcamp_order_global_fallback_no_match");
    expect(mockTrigger).toHaveBeenCalledTimes(1);
    expect(mockTrigger).toHaveBeenCalledWith("bandcamp-sale-poll", {});

    const evtUpdate = updates.find((u) => u.table === "webhook_events" && u.id === "evt-bc-2");
    expect(evtUpdate?.payload).toMatchObject({
      status: "processed",
      topic: "bandcamp_order_global_fallback",
    });

    const sensor = inserts.find((i) => i.table === "sensor_readings");
    expect(sensor?.payload).toMatchObject({
      sensor_name: "bandcamp.email_per_connection",
      status: "warning",
      workspace_id: "ws-resolved",
      value: expect.objectContaining({
        outcome: "no_match_fallback",
        candidate_count: 0,
      }),
    });
  });

  it("ambiguous_fallback: two connections share an alias → global poll cron fires + sensor warns", async () => {
    const { supabase, inserts, updates } = makeFakeSupabase({
      bandcampMatches: [
        {
          id: "conn-a",
          workspace_id: "ws-1",
          band_id: 1,
          inbound_forwarding_address: "orders+shared@clandestinedistro.com",
        },
        {
          id: "conn-b",
          workspace_id: "ws-1",
          band_id: 2,
          inbound_forwarding_address: "orders+shared@clandestinedistro.com",
        },
      ],
    });

    const result = await routeInboundEmail({
      supabase,
      workspaceId: "ws-resolved",
      webhookEventId: "evt-bc-3",
      email: bandcampOrderEmail({ to: ["orders+shared@clandestinedistro.com"] }),
    });

    expect(result.status).toBe("bandcamp_order_global_fallback_ambiguous");
    expect(mockTrigger).toHaveBeenCalledWith("bandcamp-sale-poll", {});

    const evtUpdate = updates.find((u) => u.table === "webhook_events" && u.id === "evt-bc-3");
    expect(evtUpdate?.payload).toMatchObject({
      status: "processed",
      topic: "bandcamp_order_global_fallback",
    });

    const sensor = inserts.find((i) => i.table === "sensor_readings");
    expect(sensor?.payload).toMatchObject({
      sensor_name: "bandcamp.email_per_connection",
      status: "warning",
      value: expect.objectContaining({
        outcome: "ambiguous_fallback",
        candidate_count: 2,
        candidate_ids: ["conn-a", "conn-b"],
      }),
    });
  });

  it("recipients are deduplicated and lowercased before lookup", async () => {
    // Capture the in() call args via a custom mock so we can assert the
    // lookup payload was normalised.
    const capturedIn = vi.fn().mockResolvedValue({ data: [], error: null });
    const supabase = {
      from: vi.fn().mockImplementation((table: string) => {
        if (table === "bandcamp_connections") {
          return {
            select: vi.fn().mockImplementation(() => ({
              eq: vi.fn().mockImplementation(() => ({ in: capturedIn })),
            })),
          };
        }
        if (table === "webhook_events") {
          return {
            update: vi.fn().mockImplementation(() => ({
              eq: vi.fn().mockResolvedValue({ error: null }),
            })),
          };
        }
        if (table === "sensor_readings") {
          return { insert: vi.fn().mockResolvedValue({ error: null }) };
        }
        return {};
      }),
    } as unknown as Parameters<typeof routeInboundEmail>[0]["supabase"];

    await routeInboundEmail({
      supabase,
      workspaceId: "ws-resolved",
      webhookEventId: "evt-bc-norm",
      email: bandcampOrderEmail({
        to: [
          "Orders+TruePanther@CLANDESTINEDISTRO.COM",
          "orders+truepanther@clandestinedistro.com",
        ],
        cc: ["ops@clandestinedistro.com"],
      }),
    });

    expect(capturedIn).toHaveBeenCalledTimes(1);
    const call = capturedIn.mock.calls[0];
    expect(call[0]).toBe("inbound_forwarding_address");
    const passed = call[1] as string[];
    // Lowercased.
    expect(passed).toContain("orders+truepanther@clandestinedistro.com");
    expect(passed).toContain("ops@clandestinedistro.com");
    // Deduped (the two case-variant rows of the same address collapse to one).
    expect(passed.filter((a) => a === "orders+truepanther@clandestinedistro.com").length).toBe(1);
  });
});
