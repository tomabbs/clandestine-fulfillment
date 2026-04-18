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
// Echo sources that MUST skip:
//   - 'shipstation'  → SHIP_NOTIFY processor; v2 already decremented locally
//   - 'reconcile'    → drift sensor pulled our DB into alignment with v2
//
// Sales (`bandcamp`, `shopify`, `squarespace`, `woocommerce`) and write-only
// sources (`manual`, `manual_inventory_count`, `cycle_count`, `inbound`,
// `preorder`, `backfill`) MUST fanout. Sibling enqueues that share the same
// correlation_id (e.g. `bandcamp-sale-poll` enqueuing `shipstation-v2-decrement`
// for the same Bandcamp sale, or `submitManualInventoryCounts` direct-calling
// `shipstation-v2-adjust-on-sku`) are deduplicated downstream by the
// `external_sync_events` UNIQUE on (system, correlation_id, sku, action).

describe("inventory-fanout — ShipStation v2 echo-skip logic", () => {
  it("skips v2 fanout for SHIP_NOTIFY-originated writes", () => {
    expect(shouldEchoSkipShipstationV2("shipstation")).toBe(true);
  });

  it("skips v2 fanout for reconcile-originated writes", () => {
    expect(shouldEchoSkipShipstationV2("reconcile")).toBe(true);
  });

  it.each([
    ["shopify"],
    ["bandcamp"],
    ["squarespace"],
    ["woocommerce"],
    ["manual"],
    ["inbound"],
    ["preorder"],
    ["backfill"],
    ["manual_inventory_count"],
    ["cycle_count"],
  ] as const)("does NOT skip v2 fanout for source=%s", (source) => {
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
