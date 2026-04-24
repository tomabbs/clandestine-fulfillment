/**
 * Phase 5 §9.6 D1.c — unit tests for the daily counter↔ledger recon.
 *
 * Tested invariants:
 *   - No drift => zero review queue rows + healthy sensor reading per workspace
 *   - counter > ledger sum (over-committed) => one drift row + 'high'/'warning'
 *   - counter < ledger sum (under-committed) => one drift row + 'high'/'warning'
 *   - ledger row with no level row => drift in the OTHER direction is reported
 *   - Multi-workspace recon emits per-workspace sensor rows
 *   - Pagination terminates correctly when a page is full
 */

import { describe, expect, it, vi } from "vitest";
import { runInventoryCommittedCounterRecon } from "@/trigger/tasks/inventory-committed-counter-recon";

interface Level {
  workspace_id: string;
  sku: string;
  committed_quantity: number | null;
}
interface Commitment {
  workspace_id: string;
  sku: string;
  qty: number;
  released_at: string | null;
}

interface FakeOptions {
  levels: Level[];
  commitments: Commitment[];
  pageSize?: number;
}

interface CapturedInsert {
  table: string;
  rows: unknown[];
  isUpsert: boolean;
  conflictTarget?: string;
}

function makeFake(opts: FakeOptions) {
  const captured: CapturedInsert[] = [];
  const pageSize = opts.pageSize ?? 1000;

  function rangeSlice<T>(rows: T[], from: number, to: number): T[] {
    return rows.slice(from, to + 1);
  }

  // Build a tiny query builder just rich enough for the recon's
  // call shape: .from(t).select(c).range(from, to)
  // and .from(t).select(c).is(col, null).range(from, to)
  // and .from(t).insert(rows)
  // and .from(t).upsert(rows, { onConflict, ignoreDuplicates })
  const supabase = {
    from(table: string) {
      const builder = {
        _filters: { onlyOpen: false },
        select(_cols: string) {
          return builder;
        },
        is(col: string, value: unknown) {
          if (col === "released_at" && value === null) builder._filters.onlyOpen = true;
          return builder;
        },
        async range(from: number, to: number) {
          if (table === "warehouse_inventory_levels") {
            return { data: rangeSlice(opts.levels, from, to), error: null };
          }
          if (table === "inventory_commitments") {
            const filtered = builder._filters.onlyOpen
              ? opts.commitments.filter((c) => c.released_at === null)
              : opts.commitments;
            return { data: rangeSlice(filtered, from, to), error: null };
          }
          return { data: [], error: null };
        },
        async insert(rows: unknown) {
          captured.push({
            table,
            rows: Array.isArray(rows) ? rows : [rows],
            isUpsert: false,
          });
          return { data: null, error: null };
        },
        async upsert(rows: unknown, options?: { onConflict?: string }) {
          captured.push({
            table,
            rows: Array.isArray(rows) ? rows : [rows],
            isUpsert: true,
            conflictTarget: options?.onConflict,
          });
          return { data: null, error: null };
        },
      };
      return builder;
    },
  };

  return { supabase, captured, pageSize };
}

const RUN_ID = "run_test_committed_recon";

describe("runInventoryCommittedCounterRecon", () => {
  it("returns zero drift + writes healthy sensor row when counter matches ledger", async () => {
    const { supabase, captured } = makeFake({
      levels: [
        { workspace_id: "ws_a", sku: "SKU-1", committed_quantity: 3 },
        { workspace_id: "ws_a", sku: "SKU-2", committed_quantity: 0 },
      ],
      commitments: [
        { workspace_id: "ws_a", sku: "SKU-1", qty: 2, released_at: null },
        { workspace_id: "ws_a", sku: "SKU-1", qty: 1, released_at: null },
        // SKU-2 has no open commits, level=0 — healthy
        // Released row that should be ignored:
        { workspace_id: "ws_a", sku: "SKU-1", qty: 99, released_at: "2026-04-23T10:00:00Z" },
      ],
    });

    const result = await runInventoryCommittedCounterRecon({
      supabase: supabase as never,
      reconRunId: RUN_ID,
    });

    expect(result.driftCount).toBe(0);
    expect(result.drift).toEqual([]);
    expect(result.levelsScanned).toBe(2);
    expect(result.openLedgerKeys).toBe(1);

    // No review_queue upserts when no drift
    expect(captured.filter((c) => c.table === "warehouse_review_queue")).toEqual([]);

    // Exactly one healthy sensor row for ws_a
    const sensor = captured.find((c) => c.table === "sensor_readings");
    expect(sensor).toBeDefined();
    expect(sensor?.rows).toHaveLength(1);
    const sensorRow = sensor?.rows[0] as Record<string, unknown>;
    expect(sensorRow.workspace_id).toBe("ws_a");
    expect(sensorRow.sensor_name).toBe("inv.committed_counter_recon");
    expect(sensorRow.status).toBe("healthy");
  });

  it("reports over-committed drift (counter > ledger) as a high-severity review row", async () => {
    const { supabase, captured } = makeFake({
      levels: [
        // counter says 5 committed, ledger only sums to 2 — drift = +3
        { workspace_id: "ws_a", sku: "SKU-1", committed_quantity: 5 },
      ],
      commitments: [{ workspace_id: "ws_a", sku: "SKU-1", qty: 2, released_at: null }],
    });

    const result = await runInventoryCommittedCounterRecon({
      supabase: supabase as never,
      reconRunId: RUN_ID,
    });

    expect(result.driftCount).toBe(1);
    expect(result.drift[0]).toMatchObject({
      workspace_id: "ws_a",
      sku: "SKU-1",
      counter_value: 5,
      ledger_sum: 2,
      drift: 3,
    });

    const queue = captured.find((c) => c.table === "warehouse_review_queue");
    expect(queue).toBeDefined();
    expect(queue?.isUpsert).toBe(true);
    expect(queue?.conflictTarget).toBe("group_key");
    const row = queue?.rows[0] as Record<string, unknown>;
    expect(row.severity).toBe("high");
    expect(row.category).toBe("inv_committed_counter_drift");
    expect(row.group_key).toBe("inv-committed-drift:ws_a:SKU-1");
    expect((row.metadata as Record<string, unknown>).drift).toBe(3);

    const sensor = captured.find((c) => c.table === "sensor_readings");
    expect((sensor?.rows[0] as Record<string, unknown>).status).toBe("warning");
  });

  it("reports under-committed drift (counter < ledger) as drift in the other direction", async () => {
    const { supabase } = makeFake({
      levels: [{ workspace_id: "ws_a", sku: "SKU-1", committed_quantity: 1 }],
      commitments: [
        { workspace_id: "ws_a", sku: "SKU-1", qty: 2, released_at: null },
        { workspace_id: "ws_a", sku: "SKU-1", qty: 2, released_at: null },
      ],
    });

    const result = await runInventoryCommittedCounterRecon({
      supabase: supabase as never,
      reconRunId: RUN_ID,
    });

    expect(result.driftCount).toBe(1);
    expect(result.drift[0]).toMatchObject({
      counter_value: 1,
      ledger_sum: 4,
      drift: -3,
    });
  });

  it("reports drift when an open ledger row exists for a SKU with no level row", async () => {
    const { supabase } = makeFake({
      levels: [],
      commitments: [{ workspace_id: "ws_a", sku: "ORPHAN-SKU", qty: 7, released_at: null }],
    });

    const result = await runInventoryCommittedCounterRecon({
      supabase: supabase as never,
      reconRunId: RUN_ID,
    });

    expect(result.driftCount).toBe(1);
    expect(result.drift[0]).toMatchObject({
      workspace_id: "ws_a",
      sku: "ORPHAN-SKU",
      counter_value: 0,
      ledger_sum: 7,
      drift: -7,
    });
  });

  it("emits one sensor row per workspace, mixing healthy + warning", async () => {
    const { supabase, captured } = makeFake({
      levels: [
        // ws_a healthy
        { workspace_id: "ws_a", sku: "A1", committed_quantity: 0 },
        // ws_b drifted (+2)
        { workspace_id: "ws_b", sku: "B1", committed_quantity: 2 },
      ],
      commitments: [],
    });

    const result = await runInventoryCommittedCounterRecon({
      supabase: supabase as never,
      reconRunId: RUN_ID,
    });

    expect(result.driftCount).toBe(1);

    const sensor = captured.find((c) => c.table === "sensor_readings");
    expect(sensor?.rows).toHaveLength(2);
    const byWs = new Map<string, Record<string, unknown>>();
    for (const r of sensor?.rows ?? []) {
      const row = r as Record<string, unknown>;
      byWs.set(row.workspace_id as string, row);
    }
    expect(byWs.get("ws_a")?.status).toBe("healthy");
    expect(byWs.get("ws_b")?.status).toBe("warning");
  });

  it("treats committed_quantity NULL as 0 when comparing", async () => {
    const { supabase } = makeFake({
      levels: [{ workspace_id: "ws_a", sku: "SKU-1", committed_quantity: null }],
      commitments: [{ workspace_id: "ws_a", sku: "SKU-1", qty: 3, released_at: null }],
    });

    const result = await runInventoryCommittedCounterRecon({
      supabase: supabase as never,
      reconRunId: RUN_ID,
    });

    expect(result.driftCount).toBe(1);
    expect(result.drift[0].counter_value).toBe(0);
    expect(result.drift[0].ledger_sum).toBe(3);
  });

  it("paginates correctly when the level catalog exceeds one page", async () => {
    const levels: Level[] = [];
    for (let i = 0; i < 25; i++) {
      levels.push({ workspace_id: "ws_a", sku: `SKU-${i}`, committed_quantity: 0 });
    }
    const { supabase } = makeFake({ levels, commitments: [] });

    const result = await runInventoryCommittedCounterRecon({
      supabase: supabase as never,
      reconRunId: RUN_ID,
      pageSize: 10, // Forces 3 pages: 10 + 10 + 5
    });

    expect(result.levelsScanned).toBe(25);
    expect(result.driftCount).toBe(0);
  });

  it("does not insert any sensor rows if there are no workspaces with levels or drift", async () => {
    const { supabase, captured } = makeFake({ levels: [], commitments: [] });
    await runInventoryCommittedCounterRecon({
      supabase: supabase as never,
      reconRunId: RUN_ID,
    });
    expect(captured.filter((c) => c.table === "sensor_readings")).toEqual([]);
  });
});

// Suppress @trigger.dev/sdk logger noise during tests.
vi.mock("@trigger.dev/sdk", async () => {
  const actual = await vi.importActual<typeof import("@trigger.dev/sdk")>("@trigger.dev/sdk");
  return {
    ...actual,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  };
});
