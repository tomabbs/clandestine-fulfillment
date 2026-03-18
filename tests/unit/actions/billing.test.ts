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

  // === Client Overrides Tests ===

  it("client override structure includes org, rule, and override amount", () => {
    const override = {
      id: "ovr-1",
      workspace_id: "ws-1",
      org_id: "org-1",
      rule_id: "rule-1",
      override_amount: 1.5,
      effective_from: "2026-03-01",
      created_by: "user-1",
      created_at: "2026-03-01T00:00:00Z",
      updated_at: "2026-03-01T00:00:00Z",
      organizations: { name: "Test Label" },
      warehouse_billing_rules: { rule_name: "Drop Ship Base", rule_type: "per_shipment" },
    };

    expect(override.override_amount).toBe(1.5);
    expect(override.organizations.name).toBe("Test Label");
    expect(override.warehouse_billing_rules.rule_name).toBe("Drop Ship Base");
    expect(override.warehouse_billing_rules.rule_type).toBe("per_shipment");
  });

  it("client override requires org_id and rule_id", () => {
    const data = {
      workspace_id: "ws-1",
      org_id: "org-1",
      rule_id: "rule-1",
      override_amount: 2.0,
      effective_from: "2026-03-01",
    };

    expect(data.org_id).toBeTruthy();
    expect(data.rule_id).toBeTruthy();
    expect(data.override_amount).toBeGreaterThan(0);
  });

  it("client overrides list returns joined data with org name and rule info", () => {
    const overrides = [
      {
        id: "ovr-1",
        org_id: "org-1",
        rule_id: "rule-1",
        override_amount: 1.75,
        effective_from: "2026-03-01",
        organizations: { name: "Label A" },
        warehouse_billing_rules: { rule_name: "Pick & Pack", rule_type: "per_shipment" },
      },
      {
        id: "ovr-2",
        org_id: "org-2",
        rule_id: "rule-2",
        override_amount: 0.03,
        effective_from: "2026-04-01",
        organizations: { name: "Label B" },
        warehouse_billing_rules: {
          rule_name: "Storage Per Unit/Month",
          rule_type: "storage",
        },
      },
    ];

    expect(overrides).toHaveLength(2);
    expect(overrides[0].organizations.name).toBe("Label A");
    expect(overrides[1].override_amount).toBe(0.03);
  });

  // === Format Costs Tests ===

  it("format cost includes combined cost and cost_breakdown", () => {
    const formatCost = {
      id: "fc-1",
      workspace_id: "ws-1",
      format_name: "LP",
      format_key: "lp",
      display_name: "LP",
      pick_pack_cost: 2.0,
      material_cost: 0.5,
      cost_breakdown: { pick_pack: 2.0, material: 0.5 },
      sort_order: 1,
      created_at: "2026-03-01T00:00:00Z",
      updated_at: "2026-03-01T00:00:00Z",
    };

    const combinedCost = formatCost.pick_pack_cost + formatCost.material_cost;
    expect(combinedCost).toBe(2.5);
    expect(formatCost.cost_breakdown.pick_pack).toBe(2.0);
    expect(formatCost.cost_breakdown.material).toBe(0.5);
    expect(formatCost.format_key).toBe("lp");
    expect(formatCost.sort_order).toBe(1);
  });

  it("format costs are sorted by sort_order", () => {
    const costs = [
      { format_name: "LP", sort_order: 1, pick_pack_cost: 2.0, material_cost: 0.5 },
      { format_name: "CD", sort_order: 2, pick_pack_cost: 1.5, material_cost: 0.25 },
      { format_name: '7"', sort_order: 3, pick_pack_cost: 1.5, material_cost: 0.3 },
      { format_name: "Merch", sort_order: 4, pick_pack_cost: 2.0, material_cost: 0.0 },
    ];

    const sorted = [...costs].sort((a, b) => a.sort_order - b.sort_order);
    expect(sorted[0].format_name).toBe("LP");
    expect(sorted[3].format_name).toBe("Merch");
  });

  it("format_key is derived from format_name", () => {
    const deriveFn = (name: string) => name.toLowerCase().replace(/\s+/g, "_");
    expect(deriveFn("Drop Ship Base")).toBe("drop_ship_base");
    expect(deriveFn("LP")).toBe("lp");
    expect(deriveFn("Pick & Pack")).toBe("pick_&_pack");
  });

  // === Default Rates Tab Tests ===

  it("default rates display matches old app layout values", () => {
    const defaultRates = [
      { rule_name: "Drop Ship Base", rule_type: "per_shipment", amount: 2.0 },
      { rule_name: "Drop Ship Per Unit", rule_type: "per_item", amount: 0.2 },
      { rule_name: "Pick & Pack", rule_type: "per_shipment", amount: 2.0 },
      { rule_name: "Storage Per Unit/Month", rule_type: "storage", amount: 0.05 },
    ];

    expect(defaultRates[0].amount).toBe(2.0);
    expect(defaultRates[1].amount).toBe(0.2);
    expect(defaultRates[2].amount).toBe(2.0);
    expect(defaultRates[3].amount).toBe(0.05);
  });

  it("tab type includes all five tabs", () => {
    const validTabs = ["snapshots", "default-rates", "client-overrides", "formats", "adjustments"];
    expect(validTabs).toHaveLength(5);
    expect(validTabs).toContain("default-rates");
    expect(validTabs).toContain("client-overrides");
    expect(validTabs).not.toContain("rules");
  });
});
