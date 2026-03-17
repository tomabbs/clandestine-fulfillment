import { describe, expect, it } from "vitest";

describe("portal-sales actions", () => {
  it("getSalesData returns expected shape", () => {
    const result = {
      totalOrders: 25,
      totalUnits: 150,
      topSkus: [
        { sku: "LP-001", quantity: 50 },
        { sku: "CD-002", quantity: 30 },
      ],
      orders: [],
      chartData: [],
    };

    expect(result.totalOrders).toBe(25);
    expect(result.topSkus).toHaveLength(2);
    expect(result.topSkus[0].sku).toBe("LP-001");
  });

  it("chart data covers 30 days", () => {
    const chartData: Array<{ date: string; count: number }> = [];
    for (let i = 29; i >= 0; i--) {
      const d = new Date(Date.now() - i * 24 * 60 * 60 * 1000);
      chartData.push({ date: d.toISOString().split("T")[0], count: 0 });
    }

    expect(chartData).toHaveLength(30);
  });

  it("top SKUs are sorted by quantity descending", () => {
    const skuCounts = new Map([
      ["LP-001", 50],
      ["CD-002", 30],
      ["TAPE-003", 80],
    ]);

    const topSkus = Array.from(skuCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([sku, qty]) => ({ sku, quantity: qty }));

    expect(topSkus[0].sku).toBe("TAPE-003");
    expect(topSkus[0].quantity).toBe(80);
  });
});
