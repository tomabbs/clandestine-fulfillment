import { describe, expect, it } from "vitest";
import { determineFanoutTargets } from "@/lib/server/inventory-fanout";

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
