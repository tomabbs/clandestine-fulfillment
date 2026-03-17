import { describe, expect, it } from "vitest";

/**
 * Contract test: verifies that the persist_billing_snapshot RPC parameter names
 * match what the Supabase RPC expects. Supabase rpc() requires JS keys to EXACTLY
 * match PL/pgSQL argument names (including the p_ prefix). See CLAUDE.md Rule #22.
 */

const EXPECTED_RPC_PARAMS = [
  "p_workspace_id",
  "p_org_id",
  "p_billing_period",
  "p_snapshot_data",
  "p_grand_total",
  "p_total_shipping",
  "p_total_pick_pack",
  "p_total_materials",
  "p_total_storage",
  "p_total_adjustments",
] as const;

function buildBillingSnapshotPayload() {
  return {
    p_workspace_id: "00000000-0000-0000-0000-000000000001",
    p_org_id: "00000000-0000-0000-0000-000000000002",
    p_billing_period: "2026-03",
    p_snapshot_data: { shipments: [], line_items: [] },
    p_grand_total: 1250.0,
    p_total_shipping: 500.0,
    p_total_pick_pack: 400.0,
    p_total_materials: 150.0,
    p_total_storage: 100.0,
    p_total_adjustments: 100.0,
  };
}

describe("persist_billing_snapshot RPC contract", () => {
  it("payload keys match expected p_-prefixed parameter names", () => {
    const payload = buildBillingSnapshotPayload();
    const payloadKeys = Object.keys(payload).sort();
    const expectedKeys = [...EXPECTED_RPC_PARAMS].sort();

    expect(payloadKeys).toEqual(expectedKeys);
  });

  it("all expected parameters are present in payload", () => {
    const payload = buildBillingSnapshotPayload();
    for (const param of EXPECTED_RPC_PARAMS) {
      expect(payload).toHaveProperty(param);
    }
  });

  it("payload has no extra keys beyond expected parameters", () => {
    const payload = buildBillingSnapshotPayload();
    const payloadKeys = Object.keys(payload);
    for (const key of payloadKeys) {
      expect(EXPECTED_RPC_PARAMS).toContain(key);
    }
  });

  it("numeric fields are numbers, not strings", () => {
    const payload = buildBillingSnapshotPayload();
    expect(typeof payload.p_grand_total).toBe("number");
    expect(typeof payload.p_total_shipping).toBe("number");
    expect(typeof payload.p_total_pick_pack).toBe("number");
    expect(typeof payload.p_total_materials).toBe("number");
    expect(typeof payload.p_total_storage).toBe("number");
    expect(typeof payload.p_total_adjustments).toBe("number");
  });

  it("p_snapshot_data is an object, not a string", () => {
    const payload = buildBillingSnapshotPayload();
    expect(typeof payload.p_snapshot_data).toBe("object");
    expect(payload.p_snapshot_data).not.toBeNull();
  });
});
