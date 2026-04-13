import { beforeEach, describe, expect, it, vi } from "vitest";
import { getEffectiveRate } from "@/lib/shared/billing-rates";

function createMockSupabase(
  defaultRule: Record<string, unknown> | null,
  override: Record<string, unknown> | null,
) {
  const mockMaybeSingle = vi.fn();
  let callCount = 0;

  const chainable = () => {
    const chain: Record<string, unknown> = {};
    for (const method of ["from", "select", "eq", "lte", "order", "limit"]) {
      chain[method] = vi.fn(() => chain);
    }
    chain.maybeSingle = () => {
      callCount++;
      if (callCount === 1) return Promise.resolve({ data: defaultRule, error: null });
      return Promise.resolve({ data: override, error: null });
    };
    return chain;
  };

  return { from: vi.fn(() => chainable()), _maybeSingle: mockMaybeSingle };
}

describe("getEffectiveRate", () => {
  it("returns null when no default rule exists", async () => {
    const supabase = createMockSupabase(null, null);
    const result = await getEffectiveRate(
      supabase as any,
      "ws-1",
      "org-1",
      "storage",
      "2026-03-01",
    );
    expect(result).toBeNull();
  });

  it("returns default rate when no override exists", async () => {
    const supabase = createMockSupabase({ id: "rule-1", amount: 0.25, rule_name: "Storage" }, null);
    const result = await getEffectiveRate(
      supabase as any,
      "ws-1",
      "org-1",
      "storage",
      "2026-03-01",
    );
    expect(result).toEqual({ amount: 0.25, source: "default", ruleName: "Storage" });
  });

  it("returns override rate when override exists", async () => {
    const supabase = createMockSupabase(
      { id: "rule-1", amount: 0.25, rule_name: "Storage" },
      { override_amount: 0.1 },
    );
    const result = await getEffectiveRate(
      supabase as any,
      "ws-1",
      "org-1",
      "storage",
      "2026-03-01",
    );
    expect(result).toEqual({ amount: 0.1, source: "override", ruleName: "Storage" });
  });

  it("handles string amounts by converting to number", async () => {
    const supabase = createMockSupabase(
      { id: "rule-1", amount: "0.50", rule_name: "Per Shipment" },
      null,
    );
    const result = await getEffectiveRate(
      supabase as any,
      "ws-1",
      "org-1",
      "per_shipment",
      "2026-03-01",
    );
    expect(result).toEqual({ amount: 0.5, source: "default", ruleName: "Per Shipment" });
  });
});
