import { describe, expect, it } from "vitest";
import {
  addAliasToProduct,
  removeAliasFromProduct,
  type ShipStationProduct,
  shipStationProductSchema,
} from "@/lib/clients/shipstation";

/**
 * Phase 0.5 contract tests for the ShipStation v1 product alias helpers.
 *
 * These never hit the network — they exercise the GET-merge logic and
 * idempotency contracts that are critical to plan §7.1.10's lost-update
 * mitigation. The Trigger task wraps these helpers in a Redis mutex; the
 * helpers themselves must be deterministic and side-effect-free at the
 * shape level.
 */

function buildProduct(overrides: Partial<ShipStationProduct> = {}): ShipStationProduct {
  const base = shipStationProductSchema.parse({
    productId: 999,
    sku: "MASTER-1",
    name: "Test Product",
    aliases: [],
  });
  return { ...base, ...overrides };
}

describe("shipStationProductSchema", () => {
  it("treats missing aliases as []", () => {
    const parsed = shipStationProductSchema.parse({ productId: 1, sku: "X" });
    expect(parsed.aliases).toEqual([]);
  });

  it("treats null aliases as []", () => {
    const parsed = shipStationProductSchema.parse({ productId: 1, sku: "X", aliases: null });
    expect(parsed.aliases).toEqual([]);
  });

  it("preserves unknown fields via passthrough so PUT round-trip doesn't drop them", () => {
    const parsed = shipStationProductSchema.parse({
      productId: 1,
      sku: "X",
      futureFieldShipStationMightAdd: "value-we-do-not-model",
    });
    // Cast to pass-through container so we can assert the field survived.
    expect((parsed as unknown as Record<string, unknown>).futureFieldShipStationMightAdd).toBe(
      "value-we-do-not-model",
    );
  });
});

describe("addAliasToProduct (idempotent merge)", () => {
  it("is a no-op if the alias SKU is already present", async () => {
    const current = buildProduct({
      aliases: [{ name: "ALIAS-A", storeId: null, storeName: null }],
    });
    const result = await addAliasToProduct({
      current,
      aliasSku: "ALIAS-A",
    });
    // No PUT was issued — we get back the same object reference, not a
    // network response. This is the tell-tale of the idempotent fast path.
    expect(result).toBe(current);
    expect(result.aliases).toHaveLength(1);
  });
});

describe("removeAliasFromProduct (idempotent merge)", () => {
  it("is a no-op if the alias SKU is not in the array", async () => {
    const current = buildProduct({
      aliases: [{ name: "ALIAS-A", storeId: null, storeName: null }],
    });
    const result = await removeAliasFromProduct({
      current,
      aliasSku: "DOES-NOT-EXIST",
    });
    expect(result).toBe(current);
    expect(result.aliases).toHaveLength(1);
  });
});
