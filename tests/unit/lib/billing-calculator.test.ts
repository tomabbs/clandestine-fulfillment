import { describe, expect, it } from "vitest";
import { calculateBillingForOrg } from "@/lib/clients/billing-calculator";

/**
 * Creates a proxy-based mock Supabase client. Every chained method (eq, gte, lte, is, in,
 * order, select) returns the same proxy. Calling .single() or awaiting the chain resolves
 * with the data configured for the table passed to .from(tableName).
 */
function createMockSupabase(tableData: Record<string, unknown>) {
  return {
    from(table: string) {
      const result = tableData[table] ?? [];
      const resolved = { data: result, error: null };
      const maybeSingleResolved = {
        data: Array.isArray(result) ? (result.length > 0 ? result[0] : null) : result,
        error: null,
      };

      const handler: ProxyHandler<object> = {
        get(_target, prop) {
          if (prop === "then") {
            return (resolve: (v: unknown) => unknown) => Promise.resolve(resolved).then(resolve);
          }
          if (prop === "single") {
            return () => Promise.resolve(resolved);
          }
          if (prop === "maybeSingle") {
            return () => Promise.resolve(maybeSingleResolved);
          }
          // All chainable methods return the proxy itself
          return () => new Proxy({}, handler);
        },
      };

      return new Proxy({}, handler);
    },
  };
}

const PERIOD = {
  start: "2026-03-01",
  end: "2026-03-31",
  label: "2026-03",
};

const WS = "ws-1";
const ORG = "org-1";

describe("calculateBillingForOrg", () => {
  it("returns empty snapshot when no shipments exist", async () => {
    const supabase = createMockSupabase({
      organizations: { storage_fee_waived: false, warehouse_grace_period_ends_at: null },
    });
    const result = await calculateBillingForOrg(supabase as never, WS, ORG, PERIOD);

    expect(result.billing_period).toBe("2026-03");
    expect(result.included_shipments).toHaveLength(0);
    expect(result.totals.grand_total).toBe(0);
  });

  it("includes unbilled, non-voided shipments", async () => {
    const supabase = createMockSupabase({
      warehouse_shipments: [
        {
          id: "s1",
          workspace_id: WS,
          org_id: ORG,
          tracking_number: "TRACK1",
          ship_date: "2026-03-15",
          carrier: "USPS",
          shipping_cost: 5.5,
          voided: false,
          billed: false,
        },
      ],
      organizations: { storage_fee_waived: false, warehouse_grace_period_ends_at: null },
    });

    const result = await calculateBillingForOrg(supabase as never, WS, ORG, PERIOD);

    expect(result.included_shipments).toHaveLength(1);
    expect(result.included_shipments[0].shipment_id).toBe("s1");
    expect(result.totals.total_shipping).toBe(5.5);
  });

  it("excludes voided shipments with reason", async () => {
    const supabase = createMockSupabase({
      warehouse_shipments: [
        {
          id: "s1",
          tracking_number: "TRACK1",
          ship_date: "2026-03-15",
          shipping_cost: 5,
          voided: true,
          billed: false,
        },
      ],
      organizations: { storage_fee_waived: false, warehouse_grace_period_ends_at: null },
    });

    const result = await calculateBillingForOrg(supabase as never, WS, ORG, PERIOD);

    expect(result.included_shipments).toHaveLength(0);
    expect(result.excluded_shipments).toContainEqual(
      expect.objectContaining({ shipment_id: "s1", reason: "voided" }),
    );
  });

  it("excludes already-billed shipments with reason", async () => {
    const supabase = createMockSupabase({
      warehouse_shipments: [
        {
          id: "s1",
          tracking_number: "TRACK1",
          ship_date: "2026-03-15",
          shipping_cost: 5,
          voided: false,
          billed: true,
        },
      ],
      organizations: { storage_fee_waived: false, warehouse_grace_period_ends_at: null },
    });

    const result = await calculateBillingForOrg(supabase as never, WS, ORG, PERIOD);

    expect(result.included_shipments).toHaveLength(0);
    expect(result.excluded_shipments).toContainEqual(
      expect.objectContaining({ shipment_id: "s1", reason: "already_billed" }),
    );
  });

  it("looks up format costs from format detection", async () => {
    const supabase = createMockSupabase({
      warehouse_shipments: [
        {
          id: "s1",
          tracking_number: "T1",
          ship_date: "2026-03-10",
          carrier: "USPS",
          shipping_cost: 4.0,
          voided: false,
          billed: false,
        },
      ],
      warehouse_shipment_items: [
        {
          shipment_id: "s1",
          sku: "LP-001",
          quantity: 1,
          product_title: "Vinyl LP Edition",
        },
      ],
      warehouse_format_rules: [
        {
          id: "fr1",
          workspace_id: WS,
          format_pattern: "\\bLP\\b|vinyl",
          format_name: "LP",
          priority: 10,
          created_at: "2026-01-01",
        },
      ],
      warehouse_format_costs: [
        {
          id: "fc1",
          workspace_id: WS,
          format_name: "LP",
          pick_pack_cost: 2.5,
          material_cost: 1.0,
        },
      ],
      organizations: { storage_fee_waived: false, warehouse_grace_period_ends_at: null },
    });

    const result = await calculateBillingForOrg(supabase as never, WS, ORG, PERIOD);

    expect(result.included_shipments[0].format_name).toBe("LP");
    expect(result.included_shipments[0].pick_pack_cost).toBe(2.5);
    expect(result.included_shipments[0].material_cost).toBe(1.0);
    expect(result.totals.total_pick_pack).toBe(2.5);
    expect(result.totals.total_materials).toBe(1.0);
  });

  it("calculates storage only when not waived", async () => {
    const supabase = createMockSupabase({
      organizations: { storage_fee_waived: true, warehouse_grace_period_ends_at: null },
      warehouse_inventory_levels: [{ sku: "SKU-1", available: 100 }],
      warehouse_billing_rules: [
        { rule_type: "storage", amount: 0.1, is_active: true, effective_from: "2026-01-01" },
      ],
    });

    const result = await calculateBillingForOrg(supabase as never, WS, ORG, PERIOD);

    expect(result.totals.total_storage).toBe(0);
    expect(result.storage_line_items).toHaveLength(0);
  });

  it("skips storage when org is within grace period", async () => {
    const supabase = createMockSupabase({
      organizations: { storage_fee_waived: false, warehouse_grace_period_ends_at: "2099-12-31" },
      warehouse_inventory_levels: [{ sku: "SKU-1", available: 100 }],
      warehouse_billing_rules: [
        { rule_type: "storage", amount: 0.1, is_active: true, effective_from: "2026-01-01" },
      ],
    });

    const result = await calculateBillingForOrg(supabase as never, WS, ORG, PERIOD);

    expect(result.totals.total_storage).toBe(0);
  });

  it("sums adjustments into grand total", async () => {
    const supabase = createMockSupabase({
      warehouse_billing_adjustments: [
        { id: "a1", amount: -50, reason: "Damaged item credit" },
        { id: "a2", amount: 25, reason: "Rush fee" },
      ],
      organizations: { storage_fee_waived: false, warehouse_grace_period_ends_at: null },
    });

    const result = await calculateBillingForOrg(supabase as never, WS, ORG, PERIOD);

    expect(result.totals.total_adjustments).toBe(-25);
    expect(result.totals.grand_total).toBe(-25);
    expect(result.adjustments).toHaveLength(2);
  });

  it("grand_total sums all categories", async () => {
    const supabase = createMockSupabase({
      warehouse_shipments: [
        {
          id: "s1",
          tracking_number: "T1",
          ship_date: "2026-03-10",
          carrier: "USPS",
          shipping_cost: 10,
          voided: false,
          billed: false,
        },
      ],
      warehouse_billing_adjustments: [{ id: "a1", amount: 5, reason: "fee" }],
      organizations: { storage_fee_waived: false, warehouse_grace_period_ends_at: null },
    });

    const result = await calculateBillingForOrg(supabase as never, WS, ORG, PERIOD);

    expect(result.totals.grand_total).toBe(
      result.totals.total_shipping +
        result.totals.total_pick_pack +
        result.totals.total_materials +
        result.totals.total_storage +
        result.totals.total_adjustments,
    );
  });
});
