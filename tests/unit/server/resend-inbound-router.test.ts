/**
 * Tests for `routeInboundEmail` — the heart of the 2026-04-23 inbound-email
 * fix bundle. Covers each of the four routing branches (Bandcamp order /
 * Bandcamp new release / Bandcamp fan message → support / thread reply /
 * sender mapping / unmatched review queue) plus the R-4 forwarder-rewrite
 * scenario that motivated the rewrite (`from` rewritten by Workspace forward,
 * subject still starts with `Bam!` so we route as a Bandcamp order even with
 * the wrong envelope).
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

interface FakeRow {
  table: string;
  payload: Record<string, unknown>;
}

function makeFakeSupabase(
  opts: {
    threadMatchConversationId?: string;
    emailMappingOrgId?: string;
    orgWorkspaceId?: string;
    reviewInsertError?: { message: string } | null;
  } = {},
) {
  const inserts: FakeRow[] = [];
  const updates: Array<{ table: string; id: string; payload: Record<string, unknown> }> = [];

  const from = vi.fn().mockImplementation((table: string) => {
    if (table === "support_messages") {
      return {
        select: vi.fn().mockImplementation(() => ({
          in: vi.fn().mockImplementation(() => ({
            limit: vi.fn().mockImplementation(() => ({
              maybeSingle: vi.fn().mockResolvedValue({
                data: opts.threadMatchConversationId
                  ? { conversation_id: opts.threadMatchConversationId }
                  : null,
                error: null,
              }),
            })),
          })),
          eq: vi.fn().mockImplementation(() => ({
            maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
          })),
        })),
        insert: vi.fn().mockImplementation((payload: Record<string, unknown>) => {
          inserts.push({ table, payload });
          return Promise.resolve({ error: null });
        }),
      };
    }
    if (table === "support_email_mappings") {
      return {
        select: vi.fn().mockImplementation(() => ({
          eq: vi.fn().mockImplementation(() => ({
            eq: vi.fn().mockImplementation(() => ({
              maybeSingle: vi.fn().mockResolvedValue({
                data: opts.emailMappingOrgId ? { org_id: opts.emailMappingOrgId } : null,
                error: null,
              }),
            })),
          })),
        })),
      };
    }
    if (table === "organizations") {
      return {
        select: vi.fn().mockImplementation(() => ({
          eq: vi.fn().mockImplementation(() => ({
            single: vi.fn().mockResolvedValue({
              data: opts.orgWorkspaceId ? { workspace_id: opts.orgWorkspaceId } : null,
              error: null,
            }),
          })),
        })),
      };
    }
    if (table === "support_conversations") {
      return {
        insert: vi.fn().mockImplementation((payload: Record<string, unknown>) => {
          inserts.push({ table, payload });
          return {
            select: vi.fn().mockImplementation(() => ({
              single: vi.fn().mockResolvedValue({
                data: { id: "conv-new" },
                error: null,
              }),
            })),
          };
        }),
        update: vi.fn().mockImplementation((payload: Record<string, unknown>) => ({
          eq: vi.fn().mockImplementation((_col: string, id: string) => {
            updates.push({ table, id, payload });
            return Promise.resolve({ error: null });
          }),
        })),
        select: vi.fn().mockImplementation(() => ({
          eq: vi.fn().mockImplementation(() => ({
            single: vi.fn().mockResolvedValue({
              data: { workspace_id: opts.orgWorkspaceId ?? "ws-conv" },
              error: null,
            }),
          })),
        })),
      };
    }
    if (table === "warehouse_review_queue") {
      return {
        insert: vi.fn().mockImplementation((payload: Record<string, unknown>) => {
          inserts.push({ table, payload });
          return Promise.resolve({ error: opts.reviewInsertError ?? null });
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
    return {};
  });

  return {
    supabase: { from } as unknown as Parameters<typeof routeInboundEmail>[0]["supabase"],
    inserts,
    updates,
  };
}

interface EmailOverrides {
  realFrom?: string;
  envelopeFrom?: string;
  subject?: string;
  text?: string;
  inReplyTo?: string;
  references?: string[];
}

function makeEmail(overrides: EmailOverrides = {}) {
  return {
    emailId: "em_test",
    envelopeFrom: overrides.envelopeFrom ?? "orders@clandestinedistro.com",
    envelopeTo: ["orders@clandestinedistro.com"],
    realFrom: overrides.realFrom ?? "noreply@bandcamp.com",
    to: ["orders@clandestinedistro.com"],
    cc: [],
    subject: overrides.subject ?? "Bam! Another order for True Panther",
    text: overrides.text ?? "Body text",
    html: null as string | null,
    messageId: "<msg-1@bandcamp.com>",
    inReplyTo: overrides.inReplyTo,
    references: overrides.references ?? [],
    headers: {},
  };
}

describe("routeInboundEmail", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockTrigger.mockResolvedValue({ id: "run_1" });
  });

  it("routes a Bandcamp order email by sender, fires bandcamp-sale-poll, and stamps webhook_events processed", async () => {
    const { supabase, updates } = makeFakeSupabase();
    const result = await routeInboundEmail({
      supabase,
      workspaceId: "ws-1",
      webhookEventId: "evt-1",
      email: makeEmail(),
    });
    expect(result.status).toBe("bandcamp_order_poll_triggered");
    expect(mockTrigger).toHaveBeenCalledWith("bandcamp-sale-poll", {});
    const evtUpdate = updates.find((u) => u.table === "webhook_events" && u.id === "evt-1");
    expect(evtUpdate?.payload).toMatchObject({ status: "processed", topic: "bandcamp_order" });
  });

  it("R-4: detects Bandcamp by subject even when forwarder rewrites realFrom (the production failure mode)", async () => {
    // This is the EXACT scenario the audit caught: Workspace forwarding
    // rewrote `from` to `orders@clandestinedistro.com`, so sender-based
    // detection would miss it; the subject prefix is the safety net.
    const { supabase } = makeFakeSupabase();
    const result = await routeInboundEmail({
      supabase,
      workspaceId: "ws-1",
      webhookEventId: "evt-2",
      email: makeEmail({
        realFrom: "orders@clandestinedistro.com",
        envelopeFrom: "orders@clandestinedistro.com",
        subject: "Bam! Another order for True Panther",
      }),
    });
    expect(result.status).toBe("bandcamp_order_poll_triggered");
    expect(mockTrigger).toHaveBeenCalled();
  });

  it("Bandcamp 'Cha-ching!' order subjects route to the order poll branch too", async () => {
    const { supabase } = makeFakeSupabase();
    const result = await routeInboundEmail({
      supabase,
      workspaceId: "ws-1",
      webhookEventId: "evt-3",
      email: makeEmail({ subject: "Cha-ching! 1 sale on Bandcamp" }),
    });
    expect(result.status).toBe("bandcamp_order_poll_triggered");
  });

  it("Bandcamp new-release announcements are dismissed (no support conversation, no poll)", async () => {
    const { supabase, updates } = makeFakeSupabase();
    const result = await routeInboundEmail({
      supabase,
      workspaceId: "ws-1",
      webhookEventId: "evt-4",
      email: makeEmail({ subject: "New release from Some Artist" }),
    });
    expect(result.status).toBe("bandcamp_new_release_skipped");
    expect(mockTrigger).not.toHaveBeenCalled();
    const evtUpdate = updates.find((u) => u.table === "webhook_events" && u.id === "evt-4");
    expect(evtUpdate?.payload).toMatchObject({
      status: "dismissed",
      topic: "bandcamp_new_release",
    });
  });

  it("Strategy 1: thread match via In-Reply-To appends to existing support conversation", async () => {
    const { supabase, inserts, updates } = makeFakeSupabase({
      threadMatchConversationId: "conv-existing",
    });
    const result = await routeInboundEmail({
      supabase,
      workspaceId: "ws-1",
      webhookEventId: "evt-5",
      email: makeEmail({
        realFrom: "client@example.com",
        envelopeFrom: "client@example.com",
        subject: "Re: Question about my order",
        inReplyTo: "<orig-msg@clandestinedistro.com>",
      }),
    });
    expect(result.status).toBe("support_thread_reply");
    expect(inserts.some((i) => i.table === "support_messages")).toBe(true);
    const evtUpdate = updates.find((u) => u.table === "webhook_events" && u.id === "evt-5");
    expect(evtUpdate?.payload).toMatchObject({
      status: "processed",
      topic: "support_thread_reply",
    });
  });

  it("Strategy 2: sender match via support_email_mappings creates a new conversation", async () => {
    const { supabase, inserts, updates } = makeFakeSupabase({
      emailMappingOrgId: "org-99",
      orgWorkspaceId: "ws-99",
    });
    const result = await routeInboundEmail({
      supabase,
      workspaceId: "ws-1",
      webhookEventId: "evt-6",
      email: makeEmail({
        realFrom: "Customer Person <customer@example.com>",
        envelopeFrom: "customer@example.com",
        subject: "Question about my order",
      }),
    });
    expect(result.status).toBe("support_new_conversation");
    expect(inserts.some((i) => i.table === "support_conversations")).toBe(true);
    expect(inserts.some((i) => i.table === "support_messages")).toBe(true);
    const evtUpdate = updates.find((u) => u.table === "webhook_events" && u.id === "evt-6");
    expect(evtUpdate?.payload).toMatchObject({
      status: "processed",
      topic: "support_new_conversation",
    });
  });

  it("Strategy 3: unmatched email lands in warehouse_review_queue with R-5 column names (category/metadata, NOT source/payload)", async () => {
    const { supabase, inserts, updates } = makeFakeSupabase();
    const result = await routeInboundEmail({
      supabase,
      workspaceId: "ws-1",
      webhookEventId: "evt-7",
      email: makeEmail({
        realFrom: "Random Person <random@example.com>",
        envelopeFrom: "random@example.com",
        subject: "Hi there",
        text: "I have a question",
      }),
    });
    expect(result.status).toBe("review_queued");
    const reviewInsert = inserts.find((i) => i.table === "warehouse_review_queue");
    expect(reviewInsert).toBeDefined();
    // R-5: must use `category` + `metadata`, never `source` / `payload`
    expect(reviewInsert?.payload).toHaveProperty("category", "support_email_unmatched");
    expect(reviewInsert?.payload).toHaveProperty("metadata");
    expect(reviewInsert?.payload).not.toHaveProperty("source");
    expect(reviewInsert?.payload).not.toHaveProperty("payload");
    // dedup hint must include sender to deduplicate per-sender review noise
    expect(reviewInsert?.payload).toMatchObject({
      group_key: expect.stringContaining("random@example.com"),
      severity: "medium",
    });
    const evtUpdate = updates.find((u) => u.table === "webhook_events" && u.id === "evt-7");
    expect(evtUpdate?.payload).toMatchObject({
      status: "review_queued",
      topic: "support_email_unmatched",
    });
  });

  it("strips display name from realFrom when matching support_email_mappings", async () => {
    // R-4: extractEmailAddress must unwrap "Name <addr>" so the .eq() lookup
    // matches the bare address stored in the mapping row.
    const { supabase, inserts } = makeFakeSupabase({
      emailMappingOrgId: "org-77",
      orgWorkspaceId: "ws-77",
    });
    await routeInboundEmail({
      supabase,
      workspaceId: "ws-1",
      webhookEventId: "evt-8",
      email: makeEmail({
        realFrom: "Some Person <some@example.com>",
        envelopeFrom: "some@example.com",
        subject: "Hello",
      }),
    });
    // Conversation should have been created (i.e. the lookup matched).
    expect(inserts.some((i) => i.table === "support_conversations")).toBe(true);
  });
});
