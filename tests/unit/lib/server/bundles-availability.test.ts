import { describe, expect, it } from "vitest";
import {
  type BundleComponentSpec,
  computeBundleAvailability,
  computeEffectiveBundleAvailable,
} from "@/lib/server/bundles";

const inv = (entries: Array<[string, number]>) =>
  new Map(entries.map(([k, v]) => [k, { available: v }]));

describe("computeBundleAvailability (Phase 2.5(b) shared helper)", () => {
  it("returns +Infinity when no components are supplied (no constraint)", () => {
    expect(computeBundleAvailability([], inv([]))).toBe(Number.POSITIVE_INFINITY);
  });

  it("returns the per-component minimum across components", () => {
    const components: BundleComponentSpec[] = [
      { component_variant_id: "v1", quantity: 1 },
      { component_variant_id: "v2", quantity: 1 },
    ];
    expect(
      computeBundleAvailability(
        components,
        inv([
          ["v1", 5],
          ["v2", 3],
        ]),
      ),
    ).toBe(3);
  });

  it("floor-divides by per-unit qty (a 2-pack of LPs needs 2 units per bundle)", () => {
    const components: BundleComponentSpec[] = [
      { component_variant_id: "vinyl", quantity: 2 },
      { component_variant_id: "tee", quantity: 1 },
    ];
    expect(
      computeBundleAvailability(
        components,
        inv([
          ["vinyl", 7],
          ["tee", 4],
        ]),
      ),
    ).toBe(3);
  });

  it("treats a missing component as 0 available", () => {
    const components: BundleComponentSpec[] = [
      { component_variant_id: "present", quantity: 1 },
      { component_variant_id: "absent", quantity: 1 },
    ];
    expect(computeBundleAvailability(components, inv([["present", 9]]))).toBe(0);
  });

  it("guards against zero or negative per-unit qty (treated as 1)", () => {
    const components: BundleComponentSpec[] = [
      { component_variant_id: "a", quantity: 0 },
      { component_variant_id: "b", quantity: -3 },
    ];
    expect(
      computeBundleAvailability(
        components,
        inv([
          ["a", 4],
          ["b", 6],
        ]),
      ),
    ).toBe(4);
  });
});

describe("computeEffectiveBundleAvailable (fanout-side)", () => {
  it("respects bundle on-hand when components exceed it", () => {
    const components: BundleComponentSpec[] = [{ component_variant_id: "v1", quantity: 1 }];
    expect(computeEffectiveBundleAvailable(2, components, inv([["v1", 50]]))).toBe(2);
  });

  it("caps at component minimum when on-hand is plentiful", () => {
    const components: BundleComponentSpec[] = [{ component_variant_id: "v1", quantity: 1 }];
    expect(computeEffectiveBundleAvailable(99, components, inv([["v1", 4]]))).toBe(4);
  });

  it("returns 0 when a required component is missing", () => {
    const components: BundleComponentSpec[] = [
      { component_variant_id: "v1", quantity: 1 },
      { component_variant_id: "missing", quantity: 1 },
    ];
    expect(computeEffectiveBundleAvailable(99, components, inv([["v1", 4]]))).toBe(0);
  });

  it("falls back to bundle stock when no components are supplied", () => {
    expect(computeEffectiveBundleAvailable(7, [], inv([]))).toBe(7);
  });

  it("never returns a negative value (defensive floor)", () => {
    const components: BundleComponentSpec[] = [{ component_variant_id: "v1", quantity: 1 }];
    expect(computeEffectiveBundleAvailable(0, components, inv([["v1", 0]]))).toBe(0);
  });

  it("drift sensor pattern: pass +Infinity for bundleStock to derive purely from components", () => {
    const components: BundleComponentSpec[] = [
      { component_variant_id: "v1", quantity: 1 },
      { component_variant_id: "v2", quantity: 2 },
    ];
    expect(
      computeEffectiveBundleAvailable(
        Number.POSITIVE_INFINITY,
        components,
        inv([
          ["v1", 5],
          ["v2", 7],
        ]),
      ),
    ).toBe(3);
  });
});
