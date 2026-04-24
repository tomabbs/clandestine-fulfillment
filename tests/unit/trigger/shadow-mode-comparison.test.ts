import { beforeEach, describe, expect, it, vi } from "vitest";

// Phase 3 Pass 2 — `shadow-mode-comparison` Trigger task companion suite.
//
// Covers:
//   1. shadow log row missing → returns skipped_log_missing.
//   2. row already compared (match or observed_at set) → idempotent skip.
//   3. workspace v2 defaults missing → marks row with skip_reason and
//      returns skipped_no_v2_defaults.
//   4. v2 read throws → marks row with skip_reason='v2_read_failed' and
//      returns skipped_error.
//   5. v2 returns absent SKU (treat as 0) → match=false / drift_units=-pushed.
//   6. happy path match → match=true / drift_units=0.
//   7. happy path drift → match=false / drift_units > 0.

vi.mock("@trigger.dev/sdk", () => ({
  task: (config: { run: (...args: unknown[]) => unknown }) => config,
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
  queue: vi.fn(() => ({})),
}));

vi.mock("@/trigger/lib/shipstation-queue", () => ({
  shipstationQueue: {},
}));

const listInventoryMock = vi.fn();
vi.mock("@/lib/clients/shipstation-inventory-v2", () => ({
  listInventory: (...args: unknown[]) => listInventoryMock(...args),
}));

const mockServiceFrom = vi.fn();
vi.mock("@/lib/server/supabase-server", () => ({
  createServiceRoleClient: () => ({ from: mockServiceFrom }),
}));

import { runShadowModeComparison } from "@/trigger/tasks/shadow-mode-comparison";

interface ShadowLogRow {
  id: string;
  match: boolean | null;
  observed_at: string | null;
  metadata: Record<string, unknown> | null;
}

interface WorkspaceRow {
  shipstation_v2_inventory_warehouse_id: string | null;
  shipstation_v2_inventory_location_id: string | null;
}

function makeShadowLogQuery(row: ShadowLogRow | null) {
  return {
    select: vi.fn().mockReturnValue({
      eq: vi.fn().mockReturnValue({
        maybeSingle: vi.fn().mockResolvedValue({ data: row, error: null }),
      }),
    }),
    update: vi.fn().mockReturnValue({
      eq: vi.fn().mockResolvedValue({ error: null }),
    }),
  };
}

function makeWorkspaceQuery(row: WorkspaceRow | null) {
  return {
    select: vi.fn().mockReturnValue({
      eq: vi.fn().mockReturnValue({
        single: vi.fn().mockResolvedValue({ data: row, error: null }),
      }),
    }),
  };
}

const PAYLOAD = {
  shadowLogId: "log-1",
  workspaceId: "ws-1",
  connectionId: "conn-1",
  sku: "SKU-1",
  correlationId: "corr-1",
  pushedQuantity: 10,
  pushedAt: new Date().toISOString(),
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("shadow-mode-comparison task", () => {
  it("returns skipped_log_missing when the shadow log row is gone", async () => {
    mockServiceFrom.mockImplementation((table: string) => {
      if (table === "connection_shadow_log") return makeShadowLogQuery(null);
      throw new Error(`unexpected table ${table}`);
    });
    const result = await runShadowModeComparison(PAYLOAD);
    expect(result.status).toBe("skipped_log_missing");
  });

  it("returns skipped_already_compared when match or observed_at is set", async () => {
    mockServiceFrom.mockImplementation((table: string) => {
      if (table === "connection_shadow_log") {
        return makeShadowLogQuery({
          id: "log-1",
          match: true,
          observed_at: new Date().toISOString(),
          metadata: null,
        });
      }
      throw new Error(`unexpected table ${table}`);
    });
    const result = await runShadowModeComparison(PAYLOAD);
    expect(result.status).toBe("skipped_already_compared");
  });

  it("marks the row with skip_reason='no_v2_defaults' when workspace v2 columns are NULL", async () => {
    const updateSpy = vi.fn().mockReturnValue({
      eq: vi.fn().mockResolvedValue({ error: null }),
    });
    mockServiceFrom.mockImplementation((table: string) => {
      if (table === "connection_shadow_log") {
        return {
          ...makeShadowLogQuery({
            id: "log-1",
            match: null,
            observed_at: null,
            metadata: null,
          }),
          update: updateSpy,
        };
      }
      if (table === "workspaces") {
        return makeWorkspaceQuery({
          shipstation_v2_inventory_warehouse_id: null,
          shipstation_v2_inventory_location_id: null,
        });
      }
      throw new Error(`unexpected table ${table}`);
    });
    const result = await runShadowModeComparison(PAYLOAD);
    expect(result.status).toBe("skipped_no_v2_defaults");
    expect(updateSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        match: null,
        metadata: expect.objectContaining({ skip_reason: "no_v2_defaults" }),
      }),
    );
  });

  it("returns skipped_error and marks row when listInventory throws", async () => {
    const updateSpy = vi.fn().mockReturnValue({
      eq: vi.fn().mockResolvedValue({ error: null }),
    });
    mockServiceFrom.mockImplementation((table: string) => {
      if (table === "connection_shadow_log") {
        return {
          ...makeShadowLogQuery({
            id: "log-1",
            match: null,
            observed_at: null,
            metadata: null,
          }),
          update: updateSpy,
        };
      }
      if (table === "workspaces") {
        return makeWorkspaceQuery({
          shipstation_v2_inventory_warehouse_id: "wh-1",
          shipstation_v2_inventory_location_id: "loc-1",
        });
      }
      throw new Error(`unexpected table ${table}`);
    });
    listInventoryMock.mockRejectedValueOnce(new Error("v2 503"));

    const result = await runShadowModeComparison(PAYLOAD);
    expect(result.status).toBe("skipped_error");
    expect(updateSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        match: null,
        metadata: expect.objectContaining({ skip_reason: "v2_read_failed" }),
      }),
    );
  });

  it("treats absent SKU as 0 (Phase 0 §4.2.3) and computes drift = -pushed", async () => {
    const updateSpy = vi.fn().mockReturnValue({
      eq: vi.fn().mockResolvedValue({ error: null }),
    });
    mockServiceFrom.mockImplementation((table: string) => {
      if (table === "connection_shadow_log") {
        return {
          ...makeShadowLogQuery({
            id: "log-1",
            match: null,
            observed_at: null,
            metadata: null,
          }),
          update: updateSpy,
        };
      }
      if (table === "workspaces") {
        return makeWorkspaceQuery({
          shipstation_v2_inventory_warehouse_id: "wh-1",
          shipstation_v2_inventory_location_id: "loc-1",
        });
      }
      throw new Error(`unexpected table ${table}`);
    });
    listInventoryMock.mockResolvedValueOnce([]);

    const result = await runShadowModeComparison(PAYLOAD);
    expect(result.status).toBe("compared");
    if (result.status === "compared") {
      expect(result.observedQuantity).toBe(0);
      expect(result.driftUnits).toBe(-10);
      expect(result.match).toBe(false);
    }
    expect(updateSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        ss_observed_quantity: 0,
        match: false,
        drift_units: -10,
      }),
    );
  });

  it("returns compared.match=true when v2 agrees with the pushed quantity", async () => {
    mockServiceFrom.mockImplementation((table: string) => {
      if (table === "connection_shadow_log") {
        return makeShadowLogQuery({
          id: "log-1",
          match: null,
          observed_at: null,
          metadata: null,
        });
      }
      if (table === "workspaces") {
        return makeWorkspaceQuery({
          shipstation_v2_inventory_warehouse_id: "wh-1",
          shipstation_v2_inventory_location_id: "loc-1",
        });
      }
      throw new Error(`unexpected table ${table}`);
    });
    listInventoryMock.mockResolvedValueOnce([
      {
        sku: "SKU-1",
        on_hand: 10,
        allocated: 0,
        available: 10,
        inventory_warehouse_id: "wh-1",
        inventory_location_id: "loc-1",
        last_updated_at: new Date().toISOString(),
      },
    ]);
    const result = await runShadowModeComparison(PAYLOAD);
    expect(result.status).toBe("compared");
    if (result.status === "compared") {
      expect(result.match).toBe(true);
      expect(result.driftUnits).toBe(0);
    }
  });

  it("returns compared.match=false with drift_units when v2 disagrees", async () => {
    mockServiceFrom.mockImplementation((table: string) => {
      if (table === "connection_shadow_log") {
        return makeShadowLogQuery({
          id: "log-1",
          match: null,
          observed_at: null,
          metadata: null,
        });
      }
      if (table === "workspaces") {
        return makeWorkspaceQuery({
          shipstation_v2_inventory_warehouse_id: "wh-1",
          shipstation_v2_inventory_location_id: "loc-1",
        });
      }
      throw new Error(`unexpected table ${table}`);
    });
    listInventoryMock.mockResolvedValueOnce([
      {
        sku: "SKU-1",
        on_hand: 12,
        allocated: 0,
        available: 12,
        inventory_warehouse_id: "wh-1",
        inventory_location_id: "loc-1",
        last_updated_at: new Date().toISOString(),
      },
    ]);
    const result = await runShadowModeComparison(PAYLOAD);
    expect(result.status).toBe("compared");
    if (result.status === "compared") {
      expect(result.match).toBe(false);
      expect(result.driftUnits).toBe(2);
    }
  });
});
