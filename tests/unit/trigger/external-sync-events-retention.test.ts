import { describe, expect, it, vi } from "vitest";
import { runExternalSyncRetention } from "@/trigger/tasks/external-sync-events-retention";

type DeleteCall = {
  status: "success" | "error";
  before: string;
};

function fakeSupabase(opts: {
  successDeleted?: number;
  errorDeleted?: number;
  successErr?: string;
  errorErr?: string;
}) {
  const calls: DeleteCall[] = [];

  const builder = (_status: "success" | "error") => ({
    eq: (col: string, value: string) => {
      const _ = col;
      const expectedStatus = value;
      return {
        lt: (_col: string, before: string) => {
          calls.push({ status: expectedStatus as "success" | "error", before });
          if (expectedStatus === "success") {
            if (opts.successErr) return { count: null, error: { message: opts.successErr } };
            return { count: opts.successDeleted ?? 0, error: null };
          }
          if (opts.errorErr) return { count: null, error: { message: opts.errorErr } };
          return { count: opts.errorDeleted ?? 0, error: null };
        },
      };
    },
  });

  let phase: "success" | "error" = "success";

  const supabase = {
    from: () => ({
      delete: () => {
        const ret = builder(phase);
        phase = "error";
        return ret;
      },
    }),
  };

  return { supabase: supabase as never, calls };
}

describe("runExternalSyncRetention", () => {
  it("deletes both success (>7d) and error (>30d) buckets", async () => {
    const fixedNow = new Date("2026-04-13T07:30:00Z");
    const { supabase, calls } = fakeSupabase({ successDeleted: 1234, errorDeleted: 56 });
    const result = await runExternalSyncRetention({ now: fixedNow, supabase });

    expect(result.success).toBe(true);
    expect(result.deleted_success).toBe(1234);
    expect(result.deleted_error).toBe(56);
    expect(calls).toHaveLength(2);
    expect(calls[0].status).toBe("success");
    expect(calls[0].before).toBe("2026-04-06T07:30:00.000Z");
    expect(calls[1].status).toBe("error");
    expect(calls[1].before).toBe("2026-03-14T07:30:00.000Z");
  });

  it("returns success=false when success-sweep fails and skips error sweep", async () => {
    const { supabase, calls } = fakeSupabase({ successErr: "boom" });
    const result = await runExternalSyncRetention({
      now: new Date("2026-04-13T07:30:00Z"),
      supabase,
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe("boom");
    expect(result.deleted_success).toBe(0);
    expect(result.deleted_error).toBe(0);
    expect(calls).toHaveLength(1);
  });

  it("propagates error-sweep failure but reports success-sweep count", async () => {
    const { supabase } = fakeSupabase({ successDeleted: 5, errorErr: "kaboom" });
    const result = await runExternalSyncRetention({
      now: new Date("2026-04-13T07:30:00Z"),
      supabase,
    });

    expect(result.success).toBe(false);
    expect(result.deleted_success).toBe(5);
    expect(result.deleted_error).toBe(0);
    expect(result.error).toBe("kaboom");
  });

  it("returns 0 deletions cleanly when nothing aged out", async () => {
    const { supabase } = fakeSupabase({});
    const result = await runExternalSyncRetention({
      now: new Date("2026-04-13T07:30:00Z"),
      supabase,
    });

    expect(result.success).toBe(true);
    expect(result.deleted_success).toBe(0);
    expect(result.deleted_error).toBe(0);
  });

  it("uses now() default when no override given", async () => {
    const spy = vi.spyOn(Date, "now").mockReturnValue(new Date("2026-04-13T07:30:00Z").getTime());
    const { supabase, calls } = fakeSupabase({});
    await runExternalSyncRetention({ supabase });
    expect(calls.length).toBeGreaterThan(0);
    spy.mockRestore();
  });
});
