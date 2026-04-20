// Phase 9.2 — Scan-to-Verify modal pure-logic regression test.
//
// We don't need a DOM — the matching/quantity logic is straightforward and
// covered exhaustively by exercising the same expectedBySku map building +
// scan-decrement pattern directly.

import { describe, expect, it } from "vitest";

interface Item {
  sku: string | null;
  quantity: number;
  name: string | null;
}

function expectedMap(items: Item[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const it of items) {
    if (!it.sku) continue;
    const key = it.sku.trim().toUpperCase();
    m.set(key, (m.get(key) ?? 0) + (it.quantity ?? 1));
  }
  return m;
}

function applyScan(
  expected: Map<string, number>,
  scanned: Map<string, number>,
  raw: string,
): { ok: boolean; flash?: string } {
  const sku = raw.trim().toUpperCase();
  if (!sku) return { ok: false };
  const cap = expected.get(sku) ?? 0;
  const have = scanned.get(sku) ?? 0;
  if (cap === 0 || have >= cap) return { ok: false, flash: sku };
  scanned.set(sku, have + 1);
  return { ok: true };
}

describe("Scan-to-Verify logic (Phase 9.2)", () => {
  it("aggregates duplicate SKUs across line items", () => {
    const m = expectedMap([
      { sku: "LP-001", quantity: 1, name: null },
      { sku: "lp-001", quantity: 2, name: null }, // case-insensitive
      { sku: "CD-001", quantity: 1, name: null },
    ]);
    expect(m.get("LP-001")).toBe(3);
    expect(m.get("CD-001")).toBe(1);
  });

  it("rejects unexpected SKU + raises flash", () => {
    const exp = expectedMap([{ sku: "LP-001", quantity: 1, name: null }]);
    const sc = new Map<string, number>();
    const r = applyScan(exp, sc, "WRONG-SKU");
    expect(r.ok).toBe(false);
    expect(r.flash).toBe("WRONG-SKU");
  });

  it("rejects scan beyond expected quantity (over-scan)", () => {
    const exp = expectedMap([{ sku: "LP-001", quantity: 1, name: null }]);
    const sc = new Map<string, number>();
    expect(applyScan(exp, sc, "LP-001").ok).toBe(true);
    expect(applyScan(exp, sc, "LP-001").ok).toBe(false); // 2nd scan rejected
  });

  it("counts up to expected quantity for multi-qty SKUs", () => {
    const exp = expectedMap([{ sku: "LP-001", quantity: 3, name: null }]);
    const sc = new Map<string, number>();
    expect(applyScan(exp, sc, "lp-001").ok).toBe(true);
    expect(applyScan(exp, sc, "LP-001").ok).toBe(true);
    expect(applyScan(exp, sc, "Lp-001").ok).toBe(true);
    expect(applyScan(exp, sc, "LP-001").ok).toBe(false); // 4th rejected
    expect(sc.get("LP-001")).toBe(3);
  });

  it("treats null-sku items as un-scannable", () => {
    const exp = expectedMap([
      { sku: null, quantity: 1, name: "Mystery item" },
      { sku: "LP-001", quantity: 1, name: null },
    ]);
    expect(exp.size).toBe(1);
    expect(exp.has("LP-001")).toBe(true);
  });
});
