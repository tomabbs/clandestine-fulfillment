import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockMaybeSingle = vi.fn();

vi.mock("@/lib/server/supabase-server", () => ({
  createServiceRoleClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: mockMaybeSingle,
        }),
      }),
    }),
  }),
}));

import { getWorkspaceFlags, invalidateWorkspaceFlags } from "@/lib/server/workspace-flags";

beforeEach(() => {
  invalidateWorkspaceFlags();
  mockMaybeSingle.mockReset();
});

afterEach(() => {
  invalidateWorkspaceFlags();
});

describe("getWorkspaceFlags (Phase 2.4)", () => {
  it("returns empty object when workspaces row has no flags column populated", async () => {
    mockMaybeSingle.mockResolvedValue({ data: { flags: {} }, error: null });
    const flags = await getWorkspaceFlags("ws_1");
    expect(flags).toEqual({});
  });

  it("returns empty object when row is missing entirely", async () => {
    mockMaybeSingle.mockResolvedValue({ data: null, error: null });
    const flags = await getWorkspaceFlags("ws_1");
    expect(flags).toEqual({});
  });

  it("returns the persisted flags object", async () => {
    mockMaybeSingle.mockResolvedValue({
      data: {
        flags: {
          shipstation_unified_shipping: true,
          rate_delta_thresholds: { warn: 0.25, halt: 1.5 },
        },
      },
      error: null,
    });
    const flags = await getWorkspaceFlags("ws_1");
    expect(flags.shipstation_unified_shipping).toBe(true);
    expect(flags.rate_delta_thresholds).toEqual({ warn: 0.25, halt: 1.5 });
  });

  it("caches across calls (single DB read for two reads within TTL)", async () => {
    mockMaybeSingle.mockResolvedValue({
      data: { flags: { shipstation_unified_shipping: true } },
      error: null,
    });
    await getWorkspaceFlags("ws_1");
    await getWorkspaceFlags("ws_1");
    expect(mockMaybeSingle).toHaveBeenCalledTimes(1);
  });

  it("invalidate forces a fresh read on the next call", async () => {
    mockMaybeSingle.mockResolvedValue({
      data: { flags: { shipstation_unified_shipping: false } },
      error: null,
    });
    await getWorkspaceFlags("ws_1");
    expect(mockMaybeSingle).toHaveBeenCalledTimes(1);

    invalidateWorkspaceFlags("ws_1");
    mockMaybeSingle.mockResolvedValue({
      data: { flags: { shipstation_unified_shipping: true } },
      error: null,
    });
    const flags = await getWorkspaceFlags("ws_1");
    expect(mockMaybeSingle).toHaveBeenCalledTimes(2);
    expect(flags.shipstation_unified_shipping).toBe(true);
  });

  it("workspaces without explicit flags default to OFF for shipstation_unified_shipping (cutover safety)", async () => {
    mockMaybeSingle.mockResolvedValue({ data: { flags: {} }, error: null });
    const flags = await getWorkspaceFlags("ws_1");
    expect(flags.shipstation_unified_shipping).toBeUndefined();
    // Page-level guard treats undefined as falsy → renders LegacyOrdersView.
    // This is the expected "non-breaking rollout" default.
    expect(Boolean(flags.shipstation_unified_shipping)).toBe(false);
  });
});
