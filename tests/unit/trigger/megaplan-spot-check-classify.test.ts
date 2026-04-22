/**
 * B-4 / HRD-15 — unit tests for the symmetric 5-source classifier in
 * `megaplan-spot-check`. Pure-function tests; no Trigger / Supabase mocks.
 */

import { describe, expect, it } from "vitest";
import { classify } from "@/trigger/tasks/megaplan-spot-check";

describe("megaplan-spot-check classify (5-source)", () => {
  it("agreed: all 5 sources match", () => {
    expect(classify({ db: 7, redis: 7, ss: 7, bc: 7, shopify: 7 })).toBe("agreed");
  });

  it("agreed: 4-source case (no shopify mapping) preserves prior behavior", () => {
    expect(classify({ db: 7, redis: 7, ss: 7, bc: 7, shopify: null })).toBe("agreed");
  });

  it("drift_major: shopify-direct disagrees with DB by >2", () => {
    // Even when the legacy sources agree, a Shopify-direct mismatch >2 is
    // the cutover red flag — escalate to drift_major immediately.
    expect(classify({ db: 5, redis: 5, ss: 5, bc: 5, shopify: 12 })).toBe("drift_major");
  });

  it("legacy_drift: shopify-direct + DB agree but ShipStation disagrees", () => {
    // The "ShipStation was wrong before cutover" signal — informational
    // artifact, NOT a review queue escalation.
    expect(classify({ db: 4, redis: 4, ss: 9, bc: 4, shopify: 4 })).toBe("legacy_drift");
  });

  it("bandcamp_drift: shopify + DB + SS agree but Bandcamp disagrees", () => {
    expect(classify({ db: 6, redis: 6, ss: 6, bc: 0, shopify: 6 })).toBe("bandcamp_drift");
  });

  it("delayed_propagation: DB === Redis but external sources lag (no shopify mapping)", () => {
    expect(classify({ db: 10, redis: 10, ss: 8, bc: 10, shopify: null })).toBe(
      "delayed_propagation",
    );
  });

  it("drift_minor: redis lags by 1 — small diff falls through to drift_minor", () => {
    // Avoid triggering legacy_drift / bandcamp_drift / delayed_propagation:
    //   - shopify === db === ss === bc, only redis differs
    //   - db !== redis, so delayed_propagation rule (db === redis) doesn't apply
    expect(classify({ db: 10, redis: 9, ss: 10, bc: 10, shopify: 10 })).toBe("drift_minor");
  });

  it("drift_major: any source returned null (cannot verify) on legacy sources", () => {
    expect(classify({ db: 5, redis: null, ss: 5, bc: 5, shopify: 5 })).toBe("drift_major");
  });

  it("drift_major: shopify-direct off by exactly 3 escalates", () => {
    expect(classify({ db: 10, redis: 10, ss: 10, bc: 10, shopify: 13 })).toBe("drift_major");
  });

  it("drift_minor when shopify-direct is null and other diffs <= 2", () => {
    // Confirms shopify=null path doesn't accidentally inflate diffs.
    expect(classify({ db: 10, redis: 11, ss: 9, bc: 10, shopify: null })).toBe("drift_minor");
  });
});
