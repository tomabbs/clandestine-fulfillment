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
