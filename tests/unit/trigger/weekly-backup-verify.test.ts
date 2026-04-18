import { describe, expect, it } from "vitest";
import { runWeeklyBackupVerify } from "@/trigger/tasks/weekly-backup-verify";

interface FakeShape {
  count?: number;
  error?: { message: string };
  latest?: Record<string, string | null> | null;
}

function fakeSupabase(perTable: Record<string, FakeShape>) {
  const callsByTable: Record<string, string[]> = {};
  return {
    from: (table: string) => {
      callsByTable[table] = callsByTable[table] ?? [];
      const shape = perTable[table] ?? {};
      const builder = {
        select: (_cols: string, opts?: { count?: string; head?: boolean }) => {
          if (opts?.count === "exact" && opts.head === true) {
            return Promise.resolve({ count: shape.count ?? 0, error: shape.error ?? null });
          }
          return builder;
        },
        order: () => builder,
        limit: () => builder,
        maybeSingle: () => Promise.resolve({ data: shape.latest ?? null, error: null }),
      };
      return builder;
    },
  };
}

describe("runWeeklyBackupVerify", () => {
  const now = new Date("2026-04-13T09:00:00Z");

  it("returns success when all critical tables have rows + recent activity", async () => {
    const supabase = fakeSupabase({
      workspaces: { count: 1 },
      warehouse_inventory_levels: {
        count: 5000,
        latest: { updated_at: "2026-04-12T08:00:00Z" },
      },
      warehouse_product_variants: {
        count: 12000,
        latest: { created_at: "2026-04-10T08:00:00Z" },
      },
      warehouse_orders: { count: 2000, latest: { created_at: "2026-04-12T22:00:00Z" } },
      external_sync_events: { count: 8000, latest: { started_at: "2026-04-13T08:55:00Z" } },
    });

    const result = await runWeeklyBackupVerify({ now, supabase: supabase as never });
    expect(result.success).toBe(true);
    expect(result.alerts).toEqual([]);
    expect(result.rows_per_table.warehouse_orders).toBe(2000);
  });

  it("alerts on empty critical table", async () => {
    const supabase = fakeSupabase({
      workspaces: { count: 1 },
      warehouse_inventory_levels: { count: 0 },
      warehouse_product_variants: { count: 1, latest: { created_at: now.toISOString() } },
      warehouse_orders: { count: 1, latest: { created_at: now.toISOString() } },
      external_sync_events: { count: 1, latest: { started_at: now.toISOString() } },
    });

    const result = await runWeeklyBackupVerify({ now, supabase: supabase as never });
    expect(result.success).toBe(false);
    expect(result.alerts.some((a) => a.includes("warehouse_inventory_levels"))).toBe(true);
  });

  it("alerts when latest write is older than threshold", async () => {
    const supabase = fakeSupabase({
      workspaces: { count: 1 },
      warehouse_inventory_levels: {
        count: 5,
        latest: { updated_at: "2025-01-01T00:00:00Z" },
      },
      warehouse_product_variants: { count: 1, latest: { created_at: now.toISOString() } },
      warehouse_orders: { count: 1, latest: { created_at: now.toISOString() } },
      external_sync_events: { count: 1, latest: { started_at: now.toISOString() } },
    });

    const result = await runWeeklyBackupVerify({ now, supabase: supabase as never });
    expect(result.success).toBe(false);
    expect(result.alerts.some((a) => a.includes("warehouse_inventory_levels"))).toBe(true);
    expect(result.alerts[0]).toMatch(/threshold 30d/);
  });

  it("propagates read errors as alerts", async () => {
    const supabase = fakeSupabase({
      workspaces: { error: { message: "rls denied" } },
      warehouse_inventory_levels: { count: 1, latest: { updated_at: now.toISOString() } },
      warehouse_product_variants: { count: 1, latest: { created_at: now.toISOString() } },
      warehouse_orders: { count: 1, latest: { created_at: now.toISOString() } },
      external_sync_events: { count: 1, latest: { started_at: now.toISOString() } },
    });

    const result = await runWeeklyBackupVerify({ now, supabase: supabase as never });
    expect(result.success).toBe(false);
    expect(result.alerts.some((a) => a.includes("rls denied"))).toBe(true);
  });
});
