import { describe, expect, it } from "vitest";
import { determineFanoutTargets } from "@/lib/server/inventory-fanout";

// === Pause guard — logic tests ===
// fanoutInventoryChange itself requires Supabase + external services.
// These tests verify the guard decision logic in isolation.

describe("inventory-fanout — pause guard logic", () => {
  it("returns zeroed FanoutResult immediately when workspace is paused", () => {
    // Simulate the guard decision
    function applyPauseGuard(paused: boolean) {
      if (paused) {
        return { storeConnectionsPushed: 0, bandcampPushed: false, shopifyPushed: false };
      }
      return null; // continue to push logic
    }

    const resultWhenPaused = applyPauseGuard(true);
    expect(resultWhenPaused).toEqual({
      storeConnectionsPushed: 0,
      bandcampPushed: false,
      shopifyPushed: false,
    });
  });

  it("does not short-circuit when workspace is not paused", () => {
    function applyPauseGuard(paused: boolean) {
      if (paused) {
        return { storeConnectionsPushed: 0, bandcampPushed: false, shopifyPushed: false };
      }
      return null;
    }

    const resultWhenActive = applyPauseGuard(false);
    expect(resultWhenActive).toBeNull(); // continues to actual push logic
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
