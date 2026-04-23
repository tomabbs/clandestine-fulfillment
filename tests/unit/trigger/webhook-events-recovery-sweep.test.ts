/**
 * HRD-17.1 — webhook-events-recovery-sweep tests.
 *
 * Verifies the sweeper:
 *   - selects rows in 'received' or 'enqueue_failed' status older than 2 min
 *   - re-fires tasks.trigger with a global-scope idempotency key (HRD-29) so
 *     duplicate route-handler dispatches collide instead of spawning new runs
 *   - flips status to 'enqueued' on success
 *   - on transient failure: leaves 'enqueue_failed' as-is, flips 'received'
 *     to 'enqueue_failed' so the next sweep tick keeps retrying
 *   - bounds runtime by capping at 100 rows / sweep
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockFrom, mockTrigger, mockIdempotencyCreate } = vi.hoisted(() => ({
  mockFrom: vi.fn(),
  mockTrigger: vi.fn().mockResolvedValue({ id: "run-1" }),
  mockIdempotencyCreate: vi
    .fn()
    .mockImplementation(async (key: string) => ({ id: key, scope: "global" })),
}));

vi.mock("@/lib/server/supabase-server", () => ({
  createServiceRoleClient: () => ({ from: mockFrom }),
}));

vi.mock("@trigger.dev/sdk", () => ({
  tasks: { trigger: mockTrigger },
  idempotencyKeys: { create: mockIdempotencyCreate },
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
  schedules: { task: (def: unknown) => def },
  task: (def: unknown) => def,
}));

import { webhookEventsRecoverySweepTask } from "@/trigger/tasks/webhook-events-recovery-sweep";

interface PendingRow {
  id: string;
  platform: string;
  status: string;
  created_at: string;
}

function setupSupabaseMock(opts: {
  pending: PendingRow[];
  selectError?: { message: string } | null;
}) {
  const updateCalls: Array<{ id: string; payload: Record<string, unknown> }> = [];

  mockFrom.mockImplementation((table: string) => {
    if (table !== "webhook_events") return {};

    return {
      select: vi.fn().mockImplementation(() => ({
        // R-3: sweeper now adds a second `.in("platform", [...])` filter so
        // it never picks up Resend / EasyPost / AfterShip rows.
        in: vi.fn().mockImplementation(() => ({
          in: vi.fn().mockImplementation(() => ({
            lt: vi.fn().mockImplementation(() => ({
              order: vi.fn().mockImplementation(() => ({
                limit: vi.fn().mockResolvedValue({
                  data: opts.selectError ? null : opts.pending,
                  error: opts.selectError ?? null,
                }),
              })),
            })),
          })),
        })),
      })),
      update: vi.fn().mockImplementation((payload: Record<string, unknown>) => ({
        eq: vi.fn().mockImplementation((_col: string, id: string) => {
          updateCalls.push({ id, payload });
          return Promise.resolve({ error: null });
        }),
      })),
    };
  });

  return { updateCalls };
}

const runSweeper = () =>
  (webhookEventsRecoverySweepTask as unknown as { run: () => Promise<unknown> }).run();

describe("webhook-events-recovery-sweep", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockTrigger.mockResolvedValue({ id: "run-1" });
    mockIdempotencyCreate.mockImplementation(async (key: string) => ({
      id: key,
      scope: "global",
    }));
  });

  it("returns scanned=0 when no rows pending", async () => {
    setupSupabaseMock({ pending: [] });
    const result = (await runSweeper()) as Record<string, unknown>;
    expect(result.scanned).toBe(0);
    expect(result.recovered).toBe(0);
    expect(mockTrigger).not.toHaveBeenCalled();
  });

  it("re-fires each pending row with a global-scope idempotency key and flips status='enqueued'", async () => {
    const { updateCalls } = setupSupabaseMock({
      pending: [
        {
          id: "evt-A",
          platform: "shopify",
          status: "received",
          created_at: "2026-04-22T10:00:00Z",
        },
        {
          id: "evt-B",
          platform: "shopify",
          status: "enqueue_failed",
          created_at: "2026-04-22T10:01:00Z",
        },
      ],
    });

    const result = (await runSweeper()) as Record<string, unknown>;
    expect(result.scanned).toBe(2);
    expect(result.recovered).toBe(2);
    expect(result.failed).toBe(0);

    expect(mockIdempotencyCreate).toHaveBeenCalledWith("process-client-store-webhook:evt-A", {
      scope: "global",
    });
    expect(mockIdempotencyCreate).toHaveBeenCalledWith("process-client-store-webhook:evt-B", {
      scope: "global",
    });

    expect(mockTrigger).toHaveBeenCalledTimes(2);
    expect(mockTrigger).toHaveBeenCalledWith(
      "process-client-store-webhook",
      { webhookEventId: "evt-A" },
      { idempotencyKey: { id: "process-client-store-webhook:evt-A", scope: "global" } },
    );

    // both rows flipped to 'enqueued'
    expect(updateCalls).toHaveLength(2);
    expect(updateCalls.every((u) => u.payload.status === "enqueued")).toBe(true);
  });

  it("on trigger failure: 'received' → 'enqueue_failed'; 'enqueue_failed' stays untouched", async () => {
    const { updateCalls } = setupSupabaseMock({
      pending: [
        {
          id: "evt-X",
          platform: "shopify",
          status: "received",
          created_at: "2026-04-22T10:00:00Z",
        },
        {
          id: "evt-Y",
          platform: "shopify",
          status: "enqueue_failed",
          created_at: "2026-04-22T10:01:00Z",
        },
      ],
    });

    mockTrigger.mockRejectedValue(new Error("trigger blip"));

    const result = (await runSweeper()) as Record<string, unknown>;
    expect(result.recovered).toBe(0);
    expect(result.failed).toBe(2);

    // only the 'received' row gets a status update; the 'enqueue_failed' row is left alone
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0]?.id).toBe("evt-X");
    expect(updateCalls[0]?.payload).toEqual({ status: "enqueue_failed" });
  });

  it("returns gracefully when Postgres select errors (no throw)", async () => {
    setupSupabaseMock({ pending: [], selectError: { message: "supabase down" } });
    const result = (await runSweeper()) as Record<string, unknown>;
    expect(result.scanned).toBe(0);
  });

  it("partial failure: one row fails, the other recovers", async () => {
    const { updateCalls } = setupSupabaseMock({
      pending: [
        {
          id: "evt-1",
          platform: "shopify",
          status: "received",
          created_at: "2026-04-22T10:00:00Z",
        },
        {
          id: "evt-2",
          platform: "shopify",
          status: "received",
          created_at: "2026-04-22T10:01:00Z",
        },
      ],
    });

    mockTrigger.mockResolvedValueOnce({ id: "run-1" }).mockRejectedValueOnce(new Error("blip"));

    const result = (await runSweeper()) as Record<string, unknown>;
    expect(result.scanned).toBe(2);
    expect(result.recovered).toBe(1);
    expect(result.failed).toBe(1);

    // evt-1 → 'enqueued', evt-2 → 'enqueue_failed'
    expect(updateCalls).toHaveLength(2);
    const u1 = updateCalls.find((u) => u.id === "evt-1");
    const u2 = updateCalls.find((u) => u.id === "evt-2");
    expect(u1?.payload).toEqual({ status: "enqueued" });
    expect(u2?.payload).toEqual({ status: "enqueue_failed" });
  });
});
