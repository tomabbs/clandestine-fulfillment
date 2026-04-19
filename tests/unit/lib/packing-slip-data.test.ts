// Phase 3.4 — packing-slip data shape tests.

import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { fetchPackingSlipData } from "@/lib/shared/packing-slip-data";

function makeMockClient(opts: {
  order: Record<string, unknown> | null;
  items: Array<Record<string, unknown>>;
}): SupabaseClient {
  return {
    from(table: string) {
      if (table === "shipstation_orders") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: opts.order, error: null }),
            }),
          }),
        };
      }
      if (table === "shipstation_order_items") {
        return {
          select: () => ({
            eq: () => ({
              order: () => Promise.resolve({ data: opts.items, error: null }),
            }),
          }),
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  } as unknown as SupabaseClient;
}

describe("fetchPackingSlipData (Phase 3.4)", () => {
  it("returns null when the order is missing", async () => {
    const sb = makeMockClient({ order: null, items: [] });
    const data = await fetchPackingSlipData(sb, "missing");
    expect(data).toBeNull();
  });

  it("hydrates a complete packing slip payload from the order + items + org join", async () => {
    const sb = makeMockClient({
      order: {
        id: "ord_uuid_1",
        shipstation_order_id: 9001,
        order_number: "BC-9001",
        order_date: "2026-04-19T12:00:00Z",
        customer_name: "Buyer One",
        customer_email: "buyer@example.com",
        ship_to: {
          name: "Buyer One",
          street1: "123 Vinyl Lane",
          city: "Cincinnati",
          state: "OH",
          postalCode: "45225",
          country: "US",
        },
        org_id: "org_1",
        organizations: { name: "Avant! Records" },
      },
      items: [
        { sku: "LP-001", name: "Album One", quantity: 1, unit_price: 25 },
        { sku: "CD-001", name: "Album Two CD", quantity: 2, unit_price: 12 },
      ],
    });
    const data = await fetchPackingSlipData(sb, "ord_uuid_1");
    expect(data).not.toBeNull();
    expect(data?.shipstation_order_id_internal).toBe("ord_uuid_1");
    expect(data?.shipstation_order_id).toBe(9001);
    expect(data?.org_name).toBe("Avant! Records");
    expect(data?.ship_to.city).toBe("Cincinnati");
    expect(data?.ship_to.country).toBe("US");
    expect(data?.items).toHaveLength(2);
    expect(data?.items[0]).toMatchObject({ sku: "LP-001", quantity: 1, unit_price: 25 });
  });

  it("handles missing ship_to gracefully (renders empty address)", async () => {
    const sb = makeMockClient({
      order: {
        id: "ord_uuid_2",
        shipstation_order_id: 9002,
        order_number: "BC-9002",
        order_date: null,
        customer_name: null,
        customer_email: null,
        ship_to: null,
        org_id: null,
        organizations: null,
      },
      items: [],
    });
    const data = await fetchPackingSlipData(sb, "ord_uuid_2");
    expect(data?.ship_to).toEqual({
      name: null,
      company: null,
      street1: null,
      street2: null,
      city: null,
      state: null,
      postalCode: null,
      country: null,
    });
    expect(data?.org_name).toBeNull();
    expect(data?.items).toEqual([]);
  });

  it("filters non-string ship_to values out of the address (defensive against bad JSONB)", async () => {
    const sb = makeMockClient({
      order: {
        id: "ord_uuid_3",
        shipstation_order_id: 9003,
        order_number: "BC-9003",
        order_date: null,
        customer_name: null,
        customer_email: null,
        ship_to: {
          name: "Buyer",
          street1: "", // empty string treated as null
          city: 12345, // wrong type
          country: "US",
        },
        org_id: "org_2",
        organizations: { name: "Some Label" },
      },
      items: [],
    });
    const data = await fetchPackingSlipData(sb, "ord_uuid_3");
    expect(data?.ship_to.name).toBe("Buyer");
    expect(data?.ship_to.street1).toBeNull();
    expect(data?.ship_to.city).toBeNull();
    expect(data?.ship_to.country).toBe("US");
  });
});
