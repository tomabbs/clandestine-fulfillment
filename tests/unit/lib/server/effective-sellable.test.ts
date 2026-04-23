/**
 * Phase 1 §9.2 D8 / N-13 — pure-formula contract for the shared push-formula
 * helper. Every push path (Bandcamp focused + cron, Clandestine Shopify
 * focused + cron, client-store focused + cron) imports from
 * `src/lib/server/effective-sellable.ts`. This test pins the math so the
 * X-7 dual-edit hazard is statically prevented: cron and focused push must
 * always agree on the value to push for a given (SKU, channel, snapshot).
 */

import { describe, expect, it } from "vitest";
import {
  type EffectiveSellableSnapshot,
  evaluateEffectiveSellable,
  PUSH_FORMULA_GREP_PATTERN,
} from "@/lib/server/effective-sellable";

const VARIANT = { id: "var-1" };

function snap(overrides: Partial<EffectiveSellableSnapshot> = {}): EffectiveSellableSnapshot {
  return {
    variant: VARIANT,
    level: { available: 10, safety_stock: null },
    ...overrides,
  };
}

describe("evaluateEffectiveSellable — pure formula", () => {
  it("returns effectiveSellable=available when no safety stock and no committed", () => {
    const result = evaluateEffectiveSellable("bandcamp", snap());
    expect(result.effectiveSellable).toBe(10);
    expect(result.available).toBe(10);
    expect(result.committedQuantity).toBe(0);
    expect(result.safetyStock).toBe(0);
    expect(result.safetySource).toBe("fallback_zero");
    expect(result.committedSource).toBe("absent_phase5_pending");
    expect(result.reason).toBeNull();
    expect(result.variantId).toBe("var-1");
  });

  it("subtracts legacy per-SKU safety_stock from warehouse_inventory_levels", () => {
    const result = evaluateEffectiveSellable(
      "bandcamp",
      snap({
        level: { available: 10, safety_stock: 3 },
      }),
    );
    expect(result.effectiveSellable).toBe(7);
    expect(result.safetyStock).toBe(3);
    expect(result.safetySource).toBe("level_legacy");
  });

  it("connection_mapping safety wins over per_channel + level + workspace_default for storefronts", () => {
    const result = evaluateEffectiveSellable(
      "client_store_shopify",
      snap({
        level: { available: 20, safety_stock: 5 },
        connectionMappingSafety: 1,
        perChannelSafety: 4,
        workspaceDefaultSafety: 7,
      }),
    );
    expect(result.effectiveSellable).toBe(19);
    expect(result.safetyStock).toBe(1);
    expect(result.safetySource).toBe("connection_mapping");
  });

  it("connection_mapping safety is IGNORED for non-storefront channels (bandcamp / clandestine_shopify)", () => {
    const result = evaluateEffectiveSellable(
      "bandcamp",
      snap({
        level: { available: 20, safety_stock: 5 },
        connectionMappingSafety: 1,
        perChannelSafety: 4,
        workspaceDefaultSafety: 7,
      }),
    );
    expect(result.effectiveSellable).toBe(16);
    expect(result.safetyStock).toBe(4);
    expect(result.safetySource).toBe("per_channel_table");
  });

  it("per_channel_table safety wins over level + workspace_default", () => {
    const result = evaluateEffectiveSellable(
      "clandestine_shopify",
      snap({
        level: { available: 10, safety_stock: 5 },
        perChannelSafety: 2,
        workspaceDefaultSafety: 7,
      }),
    );
    expect(result.effectiveSellable).toBe(8);
    expect(result.safetyStock).toBe(2);
    expect(result.safetySource).toBe("per_channel_table");
  });

  it("workspace_default is the final fallback before zero", () => {
    const result = evaluateEffectiveSellable(
      "bandcamp",
      snap({
        level: { available: 10, safety_stock: null },
        workspaceDefaultSafety: 3,
      }),
    );
    expect(result.effectiveSellable).toBe(7);
    expect(result.safetyStock).toBe(3);
    expect(result.safetySource).toBe("workspace_default");
  });

  it("clamps to 0 when safety_stock exceeds available (never negative push)", () => {
    const result = evaluateEffectiveSellable(
      "bandcamp",
      snap({
        level: { available: 2, safety_stock: 10 },
      }),
    );
    expect(result.effectiveSellable).toBe(0);
    expect(result.safetyStock).toBe(10);
  });

  it("clamps to 0 when committed_quantity exceeds available - safety", () => {
    const result = evaluateEffectiveSellable(
      "bandcamp",
      snap({
        level: { available: 10, safety_stock: 2, committed_quantity: 100 },
      }),
    );
    expect(result.effectiveSellable).toBe(0);
    expect(result.committedQuantity).toBe(100);
    expect(result.committedSource).toBe("level_counter");
  });

  it("subtracts committed_quantity when present (Phase 5 D1 path)", () => {
    const result = evaluateEffectiveSellable(
      "client_store_shopify",
      snap({
        level: { available: 20, safety_stock: 2, committed_quantity: 5 },
        connectionMappingSafety: 0,
      }),
    );
    expect(result.effectiveSellable).toBe(15);
    expect(result.committedQuantity).toBe(5);
    expect(result.committedSource).toBe("level_counter");
    expect(result.safetyStock).toBe(0);
    expect(result.safetySource).toBe("connection_mapping");
  });

  it("treats missing committed_quantity column as 0 (Phase 5 not landed yet)", () => {
    const result = evaluateEffectiveSellable(
      "bandcamp",
      snap({
        level: { available: 10, safety_stock: 2 },
      }),
    );
    expect(result.committedQuantity).toBe(0);
    expect(result.committedSource).toBe("absent_phase5_pending");
    expect(result.effectiveSellable).toBe(8);
  });

  it("returns reason='unknown_channel' for typos and never silently flushes inventory", () => {
    const result = evaluateEffectiveSellable(
      "bandcmap" as unknown as "bandcamp",
      snap({ level: { available: 100, safety_stock: 0 } }),
    );
    expect(result.reason).toBe("unknown_channel");
    expect(result.effectiveSellable).toBe(0);
    expect(result.safetySource).toBe("fallback_zero");
  });

  it("returns reason='variant_not_found' when variant snapshot is null", () => {
    const result = evaluateEffectiveSellable("bandcamp", { variant: null, level: null });
    expect(result.reason).toBe("variant_not_found");
    expect(result.effectiveSellable).toBe(0);
    expect(result.variantId).toBeNull();
  });

  it("treats negative available defensively as 0", () => {
    const result = evaluateEffectiveSellable(
      "bandcamp",
      snap({
        level: { available: -5, safety_stock: 0 },
      }),
    );
    expect(result.available).toBe(0);
    expect(result.effectiveSellable).toBe(0);
  });

  it("connection_mapping=0 (explicit) honored, NOT treated as missing", () => {
    const result = evaluateEffectiveSellable(
      "client_store_shopify",
      snap({
        level: { available: 10, safety_stock: 5 },
        connectionMappingSafety: 0,
        workspaceDefaultSafety: 99,
      }),
    );
    expect(result.safetyStock).toBe(0);
    expect(result.safetySource).toBe("connection_mapping");
    expect(result.effectiveSellable).toBe(10);
  });
});

describe("PUSH_FORMULA_GREP_PATTERN — X-7 lint guard regex", () => {
  it("matches the inline cron formula it is meant to ban", () => {
    expect("Math.max(0, available - effectiveSafety)").toMatch(PUSH_FORMULA_GREP_PATTERN);
    expect("Math.max(0, effectiveAvailable - effectiveSafety)").toMatch(PUSH_FORMULA_GREP_PATTERN);
    expect("Math.max(0, rawAvailable - safety_stock)").toMatch(PUSH_FORMULA_GREP_PATTERN);
    expect("Math.max(0, rawAvailable - workspaceSafety)").toMatch(PUSH_FORMULA_GREP_PATTERN);
  });

  it("does NOT match the helper itself (different shape)", () => {
    expect("return Math.max(0, available - committedQuantity - safetyStock);").not.toMatch(
      PUSH_FORMULA_GREP_PATTERN,
    );
  });
});
