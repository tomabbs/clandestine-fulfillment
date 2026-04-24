/**
 * Phase 2 §9.3 D3 — bandcamp-sale-poll-per-connection task contract tests.
 *
 * Asserts:
 *   - Payload validation rejects non-uuid ids.
 *   - Inactive / missing connection rows return a `skipped` result without
 *     calling Bandcamp APIs (no token refresh, no merch fetch, no inventory
 *     mutation).
 *   - Workspace mismatch (payload.workspaceId vs connection.workspace_id)
 *     throws — defense-in-depth against hand-fired runs with crossed wires.
 *   - Happy path: a single sale_poll loop runs against the matched
 *     connection and writes ONE channel_sync_log row tagged with the
 *     triggering webhook event id (so forensics is one query).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockTrigger } = vi.hoisted(() => ({ mockTrigger: vi.fn() }));
const { mockRefreshToken, mockGetMerch } = vi.hoisted(() => ({
  mockRefreshToken: vi.fn(),
  mockGetMerch: vi.fn(),
}));
const { mockRecordInventoryChange } = vi.hoisted(() => ({
  mockRecordInventoryChange: vi.fn(),
}));
const { mockTriggerBundleFanout } = vi.hoisted(() => ({
  mockTriggerBundleFanout: vi.fn(),
}));

vi.mock("@trigger.dev/sdk", () => ({
  tasks: { trigger: mockTrigger },
  task: (config: { run: (...args: unknown[]) => unknown }) => config,
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

vi.mock("@sentry/nextjs", () => ({
  captureException: vi.fn(),
  captureMessage: vi.fn(),
}));

vi.mock("@/lib/clients/bandcamp", () => ({
  refreshBandcampToken: mockRefreshToken,
  getMerchDetails: mockGetMerch,
}));

vi.mock("@/lib/server/record-inventory-change", () => ({
  recordInventoryChange: mockRecordInventoryChange,
}));

vi.mock("@/lib/server/bundles", () => ({
  triggerBundleFanout: mockTriggerBundleFanout,
}));

const { mockCreateServiceRoleClient } = vi.hoisted(() => ({
  mockCreateServiceRoleClient: vi.fn(),
}));

vi.mock("@/lib/server/supabase-server", () => ({
  createServiceRoleClient: mockCreateServiceRoleClient,
}));

vi.mock("@/trigger/lib/bandcamp-queue", () => ({
  bandcampQueue: { name: "bandcamp-api" },
}));

import { bandcampSalePollPerConnectionTask as _bandcampSalePollPerConnectionTask } from "@/trigger/tasks/bandcamp-sale-poll-per-connection";

const bandcampSalePollPerConnectionTask = _bandcampSalePollPerConnectionTask as unknown as {
  run: (
    payload: {
      workspaceId: string;
      connectionId: string;
      triggeredByWebhookEventId?: string;
      recipient?: string;
    },
    ctx: { ctx: { run: { id: string } } },
  ) => Promise<Record<string, unknown>>;
};

interface SupabaseFakeOpts {
  connectionRow?: {
    id: string;
    workspace_id: string;
    org_id?: string;
    band_id: number;
    is_active: boolean;
    inbound_forwarding_address: string | null;
  } | null;
}

function makeSupabase(opts: SupabaseFakeOpts) {
  const inserts: Array<{ table: string; payload: Record<string, unknown> }> = [];
  const updates: Array<{ table: string; payload: Record<string, unknown> }> = [];
  const from = vi.fn().mockImplementation((table: string) => {
    if (table === "bandcamp_connections") {
      return {
        select: vi.fn().mockImplementation(() => ({
          eq: vi.fn().mockImplementation(() => ({
            maybeSingle: vi.fn().mockResolvedValue({
              data: opts.connectionRow ?? null,
              error: null,
            }),
          })),
        })),
        update: vi.fn().mockImplementation((payload: Record<string, unknown>) => ({
          eq: vi.fn().mockImplementation(() => {
            updates.push({ table, payload });
            return Promise.resolve({ error: null });
          }),
        })),
      };
    }
    if (table === "channel_sync_log") {
      return {
        insert: vi.fn().mockImplementation((payload: Record<string, unknown>) => {
          inserts.push({ table, payload });
          return Promise.resolve({ error: null });
        }),
      };
    }
    if (table === "bandcamp_product_mappings") {
      return {
        select: vi.fn().mockImplementation(() => ({
          eq: vi.fn().mockImplementation(() => ({
            eq: vi.fn().mockImplementation(() => ({
              single: vi.fn().mockResolvedValue({ data: null, error: null }),
            })),
          })),
        })),
        update: vi.fn().mockImplementation(() => ({
          eq: vi.fn().mockResolvedValue({ error: null }),
        })),
      };
    }
    return {
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          single: vi.fn().mockResolvedValue({ data: null, error: null }),
        }),
      }),
    };
  });
  return {
    supabase: { from } as unknown,
    inserts,
    updates,
  };
}

// Trigger.dev's task body signature is `run(payload, { ctx, ... })` — the
// second argument is an OBJECT that contains `ctx` (plus taskId, signal,
// etc.). Our mock for `task()` just returns the config verbatim, so the
// `run` we call here destructures `{ ctx }` from this exact shape.
const taskCtx: { ctx: { run: { id: string } } } = { ctx: { run: { id: "run-test-1" } } };

describe("bandcamp-sale-poll-per-connection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetMerch.mockResolvedValue([]);
    mockRefreshToken.mockResolvedValue("token-abc");
  });

  it("rejects payloads with non-uuid ids", async () => {
    mockCreateServiceRoleClient.mockReturnValue(makeSupabase({ connectionRow: null }).supabase);
    await expect(
      bandcampSalePollPerConnectionTask.run(
        { workspaceId: "not-a-uuid", connectionId: "also-not-a-uuid" },
        taskCtx,
      ),
    ).rejects.toThrow();
  });

  it("returns skipped: connection_not_found when the row is missing (no API calls)", async () => {
    mockCreateServiceRoleClient.mockReturnValue(makeSupabase({ connectionRow: null }).supabase);

    const result = await bandcampSalePollPerConnectionTask.run(
      {
        workspaceId: "11111111-1111-4111-8111-111111111111",
        connectionId: "22222222-2222-4222-8222-222222222222",
      },
      taskCtx,
    );

    expect(result).toMatchObject({ skipped: "connection_not_found" });
    expect(mockRefreshToken).not.toHaveBeenCalled();
    expect(mockGetMerch).not.toHaveBeenCalled();
  });

  it("returns skipped: connection_inactive when is_active=false", async () => {
    mockCreateServiceRoleClient.mockReturnValue(
      makeSupabase({
        connectionRow: {
          id: "22222222-2222-4222-8222-222222222222",
          workspace_id: "11111111-1111-4111-8111-111111111111",
          band_id: 999,
          is_active: false,
          inbound_forwarding_address: "x@y.com",
        },
      }).supabase,
    );

    const result = await bandcampSalePollPerConnectionTask.run(
      {
        workspaceId: "11111111-1111-4111-8111-111111111111",
        connectionId: "22222222-2222-4222-8222-222222222222",
      },
      taskCtx,
    );

    expect(result).toMatchObject({ skipped: "connection_inactive" });
    expect(mockRefreshToken).not.toHaveBeenCalled();
    expect(mockGetMerch).not.toHaveBeenCalled();
  });

  it("throws on workspace mismatch (payload says ws-A, db says ws-B)", async () => {
    mockCreateServiceRoleClient.mockReturnValue(
      makeSupabase({
        connectionRow: {
          id: "22222222-2222-4222-8222-222222222222",
          workspace_id: "33333333-3333-4333-8333-333333333333",
          band_id: 999,
          is_active: true,
          inbound_forwarding_address: "x@y.com",
        },
      }).supabase,
    );

    await expect(
      bandcampSalePollPerConnectionTask.run(
        {
          workspaceId: "11111111-1111-4111-8111-111111111111",
          connectionId: "22222222-2222-4222-8222-222222222222",
        },
        taskCtx,
      ),
    ).rejects.toThrow(/workspaceId mismatch/);
  });

  it("happy path: refreshes token, polls Bandcamp once, logs channel_sync_log with triggering webhook id", async () => {
    const fake = makeSupabase({
      connectionRow: {
        id: "22222222-2222-4222-8222-222222222222",
        workspace_id: "11111111-1111-4111-8111-111111111111",
        band_id: 999,
        is_active: true,
        inbound_forwarding_address: "orders+truepanther@clandestinedistro.com",
      },
    });
    mockCreateServiceRoleClient.mockReturnValue(fake.supabase);

    const result = await bandcampSalePollPerConnectionTask.run(
      {
        workspaceId: "11111111-1111-4111-8111-111111111111",
        connectionId: "22222222-2222-4222-8222-222222222222",
        triggeredByWebhookEventId: "44444444-4444-4444-8444-444444444444",
        recipient: "orders+truepanther@clandestinedistro.com",
      },
      taskCtx,
    );

    expect(result).toMatchObject({ salesDetected: 0, errors: 0 });
    expect(mockRefreshToken).toHaveBeenCalledWith("11111111-1111-4111-8111-111111111111");
    expect(mockGetMerch).toHaveBeenCalledTimes(1);

    const logRow = fake.inserts.find((i) => i.table === "channel_sync_log");
    expect(logRow?.payload).toMatchObject({
      workspace_id: "11111111-1111-4111-8111-111111111111",
      channel: "bandcamp",
      sync_type: "sale_poll",
      status: "completed",
      metadata: expect.objectContaining({
        connection_id: "22222222-2222-4222-8222-222222222222",
        triggered_by: "resend-inbound-router",
        triggered_by_webhook_event_id: "44444444-4444-4444-8444-444444444444",
      }),
    });
  });
});
