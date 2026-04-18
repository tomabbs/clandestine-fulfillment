import { describe, expect, it, vi } from "vitest";
import {
  beginExternalSync,
  markExternalSyncError,
  markExternalSyncSuccess,
} from "@/lib/server/external-sync-events";

/**
 * Phase 0.5 — `external_sync_events` ledger contract tests.
 *
 * The ledger is the cornerstone of plan §1.4.2's idempotency guarantee.
 * These tests verify the helper interprets PostgREST errors correctly:
 *   - 23505 (unique-violation) ⇒ caller treated as "already in flight or done"
 *   - any other error ⇒ propagates so the caller bails out cleanly
 */

interface FakeBuilder {
  insert: (row: unknown) => FakeBuilder;
  select: (cols: string) => FakeBuilder;
  single: () => Promise<{ data: { id: string } | null; error: unknown }>;
  update: (row: unknown) => FakeBuilder;
  eq: (col: string, val: unknown) => FakeBuilder;
}

function fakeSupabase(reply: { data: unknown; error: unknown }): {
  client: {
    from: (table: string) => FakeBuilder;
  };
  calls: { table: string; insertedRow?: unknown; updatedRow?: unknown; eqs: [string, unknown][] }[];
} {
  const calls: {
    table: string;
    insertedRow?: unknown;
    updatedRow?: unknown;
    eqs: [string, unknown][];
  }[] = [];

  const builder = (table: string): FakeBuilder => {
    const ctx: {
      table: string;
      insertedRow?: unknown;
      updatedRow?: unknown;
      eqs: [string, unknown][];
    } = { table, eqs: [] };
    calls.push(ctx);
    const b: FakeBuilder = {
      insert(row) {
        ctx.insertedRow = row;
        return b;
      },
      update(row) {
        ctx.updatedRow = row;
        return b;
      },
      select() {
        return b;
      },
      eq(col, val) {
        ctx.eqs.push([col, val]);
        return b;
      },
      async single() {
        return reply as { data: { id: string } | null; error: unknown };
      },
    };
    return b;
  };

  return {
    client: { from: builder },
    calls,
  };
}

describe("beginExternalSync — idempotency contract", () => {
  it("returns acquired=true with the new row id on a clean insert", async () => {
    const fake = fakeSupabase({ data: { id: "evt-1" }, error: null });
    const result = await beginExternalSync(fake.client as never, {
      system: "shipstation_v1",
      correlation_id: "run_abc",
      sku: "SKU-A",
      action: "alias_add",
    });
    expect(result).toEqual({ acquired: true, id: "evt-1" });
    expect(fake.calls[0].insertedRow).toMatchObject({
      system: "shipstation_v1",
      correlation_id: "run_abc",
      sku: "SKU-A",
      action: "alias_add",
      status: "in_flight",
    });
  });

  it("treats Postgres 23505 unique-violation as 'already claimed' and returns the existing row's status", async () => {
    // First call (insert) returns 23505. Second call (lookup) returns the
    // existing row with status = success.
    let invocation = 0;
    const fakeClient = {
      from: () => {
        invocation += 1;
        const ctx = { eqs: [] as [string, unknown][] };
        const b: FakeBuilder = {
          insert: () => b,
          update: () => b,
          select: () => b,
          eq: (c, v) => {
            ctx.eqs.push([c, v]);
            return b;
          },
          async single() {
            if (invocation === 1) {
              return { data: null, error: { code: "23505" } } as never;
            }
            return {
              data: { id: "evt-existing", status: "success" },
              error: null,
            } as never;
          },
        };
        return b;
      },
    };

    const result = await beginExternalSync(fakeClient as never, {
      system: "shipstation_v1",
      correlation_id: "run_abc",
      sku: "SKU-A",
      action: "alias_add",
    });

    expect(result).toEqual({
      acquired: false,
      reason: "already_succeeded",
      existing_id: "evt-existing",
      existing_status: "success",
    });
  });

  it("propagates non-23505 errors instead of swallowing them", async () => {
    const fake = fakeSupabase({
      data: null,
      error: { code: "42P01", message: "relation does not exist" },
    });
    await expect(
      beginExternalSync(fake.client as never, {
        system: "shipstation_v1",
        correlation_id: "run_abc",
        sku: "SKU-A",
        action: "alias_add",
      }),
    ).rejects.toMatchObject({ code: "42P01" });
  });
});

describe("markExternalSyncSuccess / markExternalSyncError", () => {
  it("markExternalSyncSuccess writes status=success + completed_at", async () => {
    const fake = fakeSupabase({ data: null, error: null });
    // success uses .update().eq() chain — terminal call is .eq, not .single.
    // We bypass single() by giving update a thenable via direct then.
    const update = vi.fn().mockReturnValue({
      eq: vi.fn().mockResolvedValue({ data: null, error: null }),
    });
    const client = { from: vi.fn().mockReturnValue({ update }) };
    await markExternalSyncSuccess(client as never, "evt-1", { ok: true });
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "success",
        response_body: { ok: true },
      }),
    );
    // ensure .completed_at is an ISO timestamp
    const args = update.mock.calls[0][0] as { completed_at: string };
    expect(args.completed_at).toMatch(/T.*Z$/);
    // unused fake reply but keep variable used so the prior helper isn't
    // marked as unused by our linter contract.
    void fake;
  });

  it("markExternalSyncError writes a string message even when err is not an Error", async () => {
    const update = vi.fn().mockReturnValue({
      eq: vi.fn().mockResolvedValue({ data: null, error: null }),
    });
    const client = { from: vi.fn().mockReturnValue({ update }) };
    await markExternalSyncError(client as never, "evt-1", "raw string error");
    const args = update.mock.calls[0][0] as { response_body: { message: string } };
    expect(args.response_body.message).toBe("raw string error");
  });
});
