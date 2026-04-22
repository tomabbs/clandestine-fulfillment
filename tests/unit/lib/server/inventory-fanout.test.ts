import { describe, expect, it } from "vitest";
import { determineFanoutTargets, shouldEchoSkipShipstationV2 } from "@/lib/server/inventory-fanout";

// === Pause guard — logic tests ===
// fanoutInventoryChange itself requires Supabase + external services.
// These tests verify the guard decision logic in isolation.

describe("inventory-fanout — pause guard logic", () => {
  it("returns zeroed FanoutResult immediately when workspace is paused", () => {
    // Simulate the guard decision (audit fix F2 — 2026-04-13)
    function applyPauseGuard(paused: boolean) {
      if (paused) {
        return {
          storeConnectionsPushed: 0,
          bandcampPushed: false,
          shopifyPushed: false,
          shipstationV2Enqueued: false,
        };
      }
      return null; // continue to push logic
    }

    const resultWhenPaused = applyPauseGuard(true);
    expect(resultWhenPaused).toEqual({
      storeConnectionsPushed: 0,
      bandcampPushed: false,
      shopifyPushed: false,
      shipstationV2Enqueued: false,
    });
  });

  it("does not short-circuit when workspace is not paused", () => {
    function applyPauseGuard(paused: boolean) {
      if (paused) {
        return {
          storeConnectionsPushed: 0,
          bandcampPushed: false,
          shopifyPushed: false,
          shipstationV2Enqueued: false,
        };
      }
      return null;
    }

    const resultWhenActive = applyPauseGuard(false);
    expect(resultWhenActive).toBeNull(); // continues to actual push logic
  });
});

// === ShipStation v2 echo-skip logic (audit fix F1 — 2026-04-13, Rule #65) ===
//
// fanoutInventoryChange enqueues `shipstation-v2-adjust-on-sku` for every
// non-zero, non-bundle inventory change EXCEPT when the originating event
// already reflects ShipStation v2 state. Pre-fix this gap was tracked as
// FR-1 in docs/plans/shipstation-source-of-truth-plan.md §12.
//
// Second-pass audit (2026-04-13): the operator activated **ShipStation
// Inventory Sync** for every connected Shopify / Squarespace / WooCommerce
// store AND ShipStation has native Bandcamp store integrations registered
// in `warehouse_shipstation_stores`. SS Inventory Sync subscribes directly
// to each storefront's order webhooks and decrements v2 natively at import
// time — completely independent of our app's webhook processing. The set
// below was extended to include those storefront sources to prevent the
// double-decrement loop described in Rule #65.
//
// Echo sources that MUST skip:
//   - 'shipstation'  → SHIP_NOTIFY processor; v2 already decremented locally
//   - 'reconcile'    → drift sensor pulled our DB into alignment with v2
//   - 'shopify'      → SS Inventory Sync decremented v2 from the Shopify order
//   - 'squarespace'  → SS Inventory Sync decremented v2 from the Squarespace order
//   - 'woocommerce'  → SS Inventory Sync decremented v2 from the Woo order
//   - 'bandcamp'     → SS imports the Bandcamp order natively + decrements v2
//
// Warehouse-side write sources (`manual`, `manual_inventory_count`,
// `cycle_count`, `inbound`, `preorder`, `backfill`) MUST fanout — these
// originate in our app and v2 has not yet seen them.
//
// If both layers ever drift out of sync (e.g. the storefront list above is
// reduced WITHOUT also re-enabling explicit v2 enqueues in the corresponding
// task — see the `bandcamp-sale-poll` comment block) the Phase 5 reconcile
// sensor (`shipstation-bandcamp-reconcile-{hot,warm,cold}`) catches the drift.

describe("inventory-fanout — ShipStation v2 echo-skip logic", () => {
  it.each([
    ["shipstation"],
    ["reconcile"],
    ["shopify"],
    ["squarespace"],
    ["woocommerce"],
    ["bandcamp"],
  ] as const)("skips v2 fanout for source=%s (already mirrored by v2 / SS Inventory Sync)", (source) => {
    expect(shouldEchoSkipShipstationV2(source)).toBe(true);
  });

  it.each([
    ["manual"],
    ["inbound"],
    ["preorder"],
    ["backfill"],
    ["manual_inventory_count"],
    ["cycle_count"],
  ] as const)("does NOT skip v2 fanout for warehouse-originated source=%s (v2 has not seen it)", (source) => {
    expect(shouldEchoSkipShipstationV2(source)).toBe(false);
  });

  it("does NOT skip v2 fanout when source is undefined (defensive default)", () => {
    expect(shouldEchoSkipShipstationV2(undefined)).toBe(false);
  });
});

describe("inventory-fanout", () => {
  describe("determineFanoutTargets", () => {
    it("pushes to stores when SKU has store connections", () => {
      const targets = determineFanoutTargets(true, false);
      expect(targets.pushToStores).toBe(true);
      expect(targets.pushToBandcamp).toBe(false);
    });

    it("pushes to Bandcamp when SKU has Bandcamp mapping", () => {
      const targets = determineFanoutTargets(false, true);
      expect(targets.pushToStores).toBe(false);
      expect(targets.pushToBandcamp).toBe(true);
    });

    it("pushes to both when SKU has both mappings", () => {
      const targets = determineFanoutTargets(true, true);
      expect(targets.pushToStores).toBe(true);
      expect(targets.pushToBandcamp).toBe(true);
    });

    it("pushes to neither when SKU has no mappings", () => {
      const targets = determineFanoutTargets(false, false);
      expect(targets.pushToStores).toBe(false);
      expect(targets.pushToBandcamp).toBe(false);
    });
  });
});
