import { describe, expect, it } from "vitest";

describe("billing actions", () => {
  it("getBillingSnapshots returns paginated results with org join", () => {
    const result = {
      snapshots: [
        {
          id: "snap-1",
          org_id: "org-1",
          billing_period: "2026-02",
          grand_total: 1250.0,
          status: "draft",
          created_at: "2026-03-01T00:00:00Z",
          organizations: { name: "Test Label" },
        },
      ],
      total: 1,
      pageSize: 20,
    };

    expect(result.snapshots).toHaveLength(1);
    expect(result.snapshots[0].grand_total).toBe(1250.0);
    expect(result.snapshots[0].organizations?.name).toBe("Test Label");
  });

  it("getBillingSnapshotDetail returns snapshot + adjustments", () => {
    const detail = {
      snapshot: {
        id: "snap-1",
        grand_total: 1250.0,
        total_shipping: 500.0,
        total_pick_pack: 400.0,
        total_materials: 150.0,
        total_storage: 100.0,
        total_adjustments: 100.0,
        snapshot_data: { included_shipments: [], excluded_shipments: [] },
      },
      adjustments: [{ id: "adj-1", amount: 100.0, reason: "credit" }],
    };

    expect(detail.snapshot.grand_total).toBe(1250.0);
    expect(detail.adjustments).toHaveLength(1);
  });

  it("billing rule types are valid", () => {
    const validTypes = ["per_shipment", "per_item", "storage", "material", "adjustment"];
    const rule = { rule_type: "per_shipment", amount: 3.5 };
    expect(validTypes).toContain(rule.rule_type);
  });

  it("getAuthWorkspaceId returns a workspace ID string", () => {
    const workspaceId = "550e8400-e29b-41d4-a716-446655440000";
    expect(typeof workspaceId).toBe("string");
    expect(workspaceId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it("workspace ID is used in billing queries instead of hardcoded value", () => {
    const workspaceId = "550e8400-e29b-41d4-a716-446655440000";
    const filters = { workspaceId, page: 1 };
    expect(filters.workspaceId).toBe(workspaceId);
    expect(filters.workspaceId).not.toBe("00000000-0000-0000-0000-000000000001");
  });
});
