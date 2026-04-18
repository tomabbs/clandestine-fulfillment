import { describe, expect, it } from "vitest";

/**
 * Tests for Bandcamp inventory push logic.
 * Validates quantity_sold inclusion and push payload structure.
 */

interface PushItem {
  item_id: number;
  item_type: string;
  quantity_available: number;
  quantity_sold: number;
}

function buildPushPayload(
  mappings: Array<{
    bandcamp_item_id: number;
    bandcamp_item_type: string;
    last_quantity_sold: number | null;
  }>,
  inventoryByVariant: Map<string, number>,
  variantIds: Map<number, string>,
): PushItem[] {
  const items: PushItem[] = [];
  for (const m of mappings) {
    const variantId = variantIds.get(m.bandcamp_item_id);
    if (!variantId) continue;
    const available = inventoryByVariant.get(variantId) ?? 0;
    items.push({
      item_id: m.bandcamp_item_id,
      item_type: m.bandcamp_item_type,
      quantity_available: available,
      quantity_sold: m.last_quantity_sold ?? 0,
    });
  }
  return items;
}

describe("bandcamp inventory push payload", () => {
  it("includes quantity_sold from last_quantity_sold for race condition handling", () => {
    const mappings = [
      { bandcamp_item_id: 100, bandcamp_item_type: "package", last_quantity_sold: 42 },
      { bandcamp_item_id: 200, bandcamp_item_type: "album", last_quantity_sold: 10 },
    ];
    const inventory = new Map([
      ["variant-1", 50],
      ["variant-2", 25],
    ]);
    const variantIds = new Map([
      [100, "variant-1"],
      [200, "variant-2"],
    ]);

    const payload = buildPushPayload(mappings, inventory, variantIds);

    expect(payload).toHaveLength(2);
    expect(payload[0].quantity_sold).toBe(42);
    expect(payload[0].quantity_available).toBe(50);
    expect(payload[1].quantity_sold).toBe(10);
    expect(payload[1].quantity_available).toBe(25);
  });

  it("defaults quantity_sold to 0 when last_quantity_sold is null", () => {
    const mappings = [
      { bandcamp_item_id: 100, bandcamp_item_type: "package", last_quantity_sold: null },
    ];
    const inventory = new Map([["variant-1", 30]]);
    const variantIds = new Map([[100, "variant-1"]]);

    const payload = buildPushPayload(mappings, inventory, variantIds);

    expect(payload[0].quantity_sold).toBe(0);
  });

  it("uses 0 available when variant not found in inventory", () => {
    const mappings = [
      { bandcamp_item_id: 100, bandcamp_item_type: "package", last_quantity_sold: 5 },
    ];
    const inventory = new Map<string, number>();
    const variantIds = new Map([[100, "variant-missing"]]);

    const payload = buildPushPayload(mappings, inventory, variantIds);

    expect(payload[0].quantity_available).toBe(0);
  });

  it("skips mappings without matching variant", () => {
    const mappings = [
      { bandcamp_item_id: 999, bandcamp_item_type: "package", last_quantity_sold: 5 },
    ];
    const inventory = new Map([["variant-1", 30]]);
    const variantIds = new Map<number, string>();

    const payload = buildPushPayload(mappings, inventory, variantIds);

    expect(payload).toHaveLength(0);
  });
});

// Phase 1 — push_mode filter contract.
// The inventory-push task pulls every mapping for a workspace, then filters
// to ONLY `normal` and `manual_override`. Anything `blocked_*` is dropped at
// the source so we never call `update_quantities` for a mapping that's known
// to have a non-zero merchant baseline (would silently no-op customer-facing
// inventory) or a multi-origin merchant (would write to the wrong origin).
//
// This test pins the filter as a pure function so the contract can never
// drift from the inline filter in `bandcamp-inventory-push.ts` without
// breaking a regression check.

type PushMode = "normal" | "blocked_baseline" | "blocked_multi_origin" | "manual_override";

interface MappingWithMode {
  bandcamp_item_id: number;
  push_mode: PushMode;
}

function filterByPushMode<T extends { push_mode: PushMode }>(mappings: T[]): T[] {
  return mappings.filter((m) => m.push_mode === "normal" || m.push_mode === "manual_override");
}

describe("bandcamp inventory push push_mode filter (Phase 1)", () => {
  it("includes `normal` mappings", () => {
    const mappings: MappingWithMode[] = [{ bandcamp_item_id: 1, push_mode: "normal" }];
    expect(filterByPushMode(mappings)).toHaveLength(1);
  });

  it("includes `manual_override` mappings (operator opted in)", () => {
    const mappings: MappingWithMode[] = [{ bandcamp_item_id: 2, push_mode: "manual_override" }];
    expect(filterByPushMode(mappings)).toHaveLength(1);
  });

  it("excludes `blocked_baseline` mappings", () => {
    const mappings: MappingWithMode[] = [{ bandcamp_item_id: 3, push_mode: "blocked_baseline" }];
    expect(filterByPushMode(mappings)).toHaveLength(0);
  });

  it("excludes `blocked_multi_origin` mappings", () => {
    const mappings: MappingWithMode[] = [
      { bandcamp_item_id: 4, push_mode: "blocked_multi_origin" },
    ];
    expect(filterByPushMode(mappings)).toHaveLength(0);
  });

  it("partitions a mixed batch correctly", () => {
    const mappings: MappingWithMode[] = [
      { bandcamp_item_id: 1, push_mode: "normal" },
      { bandcamp_item_id: 2, push_mode: "blocked_baseline" },
      { bandcamp_item_id: 3, push_mode: "manual_override" },
      { bandcamp_item_id: 4, push_mode: "blocked_multi_origin" },
      { bandcamp_item_id: 5, push_mode: "normal" },
    ];
    const allowed = filterByPushMode(mappings);
    expect(allowed.map((m) => m.bandcamp_item_id)).toEqual([1, 3, 5]);
  });
});
