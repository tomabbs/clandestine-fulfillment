// Phase 11.1 — fetchPackingSlipData BC enrichment tests.
//
// Locks in:
//   - SS-only path (no customField1) returns no enrichment + bandcamp_enriched=false.
//   - customField1 with valid payment_id pulls buyer_note + ship_notes +
//     additional_fan_contribution + payment_state + paypal_transaction_id.
//   - Per-item enrichment (artist + album_title + image_url) joins by SKU.
//   - primaryArtist tally picks the most-frequent artist on multi-album orders.
//   - International order pulls customs_description from warehouse_shipment_items.

import { beforeEach, describe, expect, it } from "vitest";
import { fetchPackingSlipData } from "@/lib/shared/packing-slip-data";

interface Row {
  [key: string]: unknown;
}

const tables: Record<string, Row[]> = {
  shipstation_orders: [],
  shipstation_order_items: [],
  bandcamp_sales: [],
  bandcamp_product_mappings: [],
  warehouse_shipments: [],
  warehouse_shipment_items: [],
};

function makeMockClient() {
  return {
    from(table: string) {
      const eqs: Array<[string, unknown]> = [];
      let inCol: string | null = null;
      let inVals: readonly unknown[] | null = null;
      let _orderCol: string | null = null;
      let _orderAsc = true;
      let _limit: number | null = null;
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: (col: string, val: unknown) => {
          eqs.push([col, val]);
          return builder;
        },
        in: (col: string, vals: readonly unknown[]) => {
          inCol = col;
          inVals = vals;
          return builder;
        },
        order: (col: string, opts?: { ascending?: boolean }) => {
          _orderCol = col;
          _orderAsc = opts?.ascending !== false;
          return builder;
        },
        limit: (n: number) => {
          _limit = n;
          return builder;
        },
        async maybeSingle() {
          const rows = filtered();
          return { data: rows[0] ?? null, error: null };
        },
        // biome-ignore lint/suspicious/noThenProperty: intentional thenable to mimic Supabase PostgREST builder
        then(onFulfilled: (v: unknown) => unknown) {
          return Promise.resolve({ data: filtered(), error: null }).then(onFulfilled);
        },
      };
      function filtered(): Row[] {
        let rs = tables[table] ?? [];
        rs = rs.filter((r) => eqs.every(([col, val]) => r[col] === val));
        if (inCol && inVals) {
          const filterCol = inCol;
          const filterVals = inVals;
          rs = rs.filter((r) => filterVals.includes(r[filterCol]));
        }
        if (_orderCol) {
          const col = _orderCol;
          rs = [...rs].sort((a, b) => {
            const av = a[col] as number | string;
            const bv = b[col] as number | string;
            if (av < bv) return _orderAsc ? -1 : 1;
            if (av > bv) return _orderAsc ? 1 : -1;
            return 0;
          });
        }
        if (_limit != null) rs = rs.slice(0, _limit);
        return rs;
      }
      return builder;
    },
  };
}

beforeEach(() => {
  for (const k of Object.keys(tables)) tables[k] = [];
});

describe("fetchPackingSlipData (Phase 11.1)", () => {
  it("returns base shape for SS-only order (no customField1, no BC sales)", async () => {
    tables.shipstation_orders.push({
      id: "ord_1",
      workspace_id: "ws_1",
      shipstation_order_id: 1001,
      order_number: "SS-1001",
      order_date: "2026-04-01T12:00:00Z",
      customer_name: "Jane Doe",
      customer_email: "jane@example.com",
      ship_to: { name: "Jane Doe", city: "NYC", state: "NY", country: "US" },
      org_id: "org_1",
      advanced_options: {},
      organizations: { name: "Test Org" },
    });
    tables.shipstation_order_items.push({
      shipstation_order_id: "ord_1",
      sku: "LP-001",
      name: "Album X",
      quantity: 1,
      unit_price: 25,
      item_index: 0,
    });

    const data = await fetchPackingSlipData(
      makeMockClient() as unknown as Parameters<typeof fetchPackingSlipData>[0],
      "ord_1",
    );
    expect(data).not.toBeNull();
    expect(data?.bandcamp_enriched).toBe(false);
    expect(data?.buyer_note).toBeNull();
    expect(data?.artist).toBeNull();
    expect(data?.items[0]?.artist).toBeNull();
    expect(data?.items[0]?.image_url).toBeNull();
  });

  it("enriches from customField1 → BC sales rows + per-SKU image_url", async () => {
    tables.shipstation_orders.push({
      id: "ord_2",
      workspace_id: "ws_1",
      shipstation_order_id: 1002,
      order_number: "SS-1002",
      order_date: null,
      customer_name: null,
      customer_email: null,
      ship_to: { country: "US" },
      org_id: "org_1",
      advanced_options: { customField1: "BC-1234567" },
      organizations: null,
    });
    tables.shipstation_order_items.push(
      {
        shipstation_order_id: "ord_2",
        sku: "LP-001",
        name: "Album X",
        quantity: 1,
        unit_price: 25,
        item_index: 0,
      },
      {
        shipstation_order_id: "ord_2",
        sku: "LP-002",
        name: "Album Y",
        quantity: 2,
        unit_price: 30,
        item_index: 1,
      },
    );
    tables.bandcamp_sales.push(
      {
        workspace_id: "ws_1",
        bandcamp_transaction_id: 1234567,
        sku: "LP-001",
        artist: "Band Alpha",
        album_title: "Album X",
        buyer_note: "Please squeeze in the catalog!",
        ship_notes: null,
        additional_fan_contribution: 5,
        payment_state: "paid",
        paypal_transaction_id: "PP-XYZ-123",
      },
      {
        workspace_id: "ws_1",
        bandcamp_transaction_id: 1234567,
        sku: "LP-002",
        artist: "Band Alpha",
        album_title: "Album Y",
        buyer_note: null,
        ship_notes: null,
        additional_fan_contribution: 5,
        payment_state: "paid",
        paypal_transaction_id: "PP-XYZ-123",
      },
    );
    tables.bandcamp_product_mappings.push(
      { workspace_id: "ws_1", sku: "LP-001", bandcamp_image_url: "https://img/lp1.jpg" },
      { workspace_id: "ws_1", sku: "LP-002", bandcamp_image_url: "https://img/lp2.jpg" },
    );

    const data = await fetchPackingSlipData(
      makeMockClient() as unknown as Parameters<typeof fetchPackingSlipData>[0],
      "ord_2",
    );
    expect(data?.bandcamp_enriched).toBe(true);
    expect(data?.buyer_note).toBe("Please squeeze in the catalog!");
    expect(data?.payment_state).toBe("paid");
    expect(data?.paypal_transaction_id).toBe("PP-XYZ-123");
    expect(data?.additional_fan_contribution).toBe(5);
    expect(data?.artist).toBe("Band Alpha");
    expect(data?.items[0]?.artist).toBe("Band Alpha");
    expect(data?.items[0]?.image_url).toBe("https://img/lp1.jpg");
    expect(data?.items[1]?.album_title).toBe("Album Y");
  });

  it("primaryArtist tally returns the MOST-frequent artist on mixed-artist orders", async () => {
    tables.shipstation_orders.push({
      id: "ord_3",
      workspace_id: "ws_1",
      shipstation_order_id: 1003,
      order_number: "SS-1003",
      ship_to: {},
      advanced_options: { customField1: "9999" },
      organizations: null,
    });
    tables.bandcamp_sales.push(
      { workspace_id: "ws_1", bandcamp_transaction_id: 9999, sku: "A", artist: "Solo Person" },
      { workspace_id: "ws_1", bandcamp_transaction_id: 9999, sku: "B", artist: "Band Beta" },
      { workspace_id: "ws_1", bandcamp_transaction_id: 9999, sku: "C", artist: "Band Beta" },
    );

    const data = await fetchPackingSlipData(
      makeMockClient() as unknown as Parameters<typeof fetchPackingSlipData>[0],
      "ord_3",
    );
    expect(data?.artist).toBe("Band Beta"); // 2 vs 1
  });

  it("loads customs_description from warehouse_shipment_items when label printed", async () => {
    tables.shipstation_orders.push({
      id: "ord_4",
      workspace_id: "ws_1",
      shipstation_order_id: 1004,
      order_number: "SS-1004",
      ship_to: { country: "GB" },
      advanced_options: {},
      organizations: null,
    });
    tables.shipstation_order_items.push({
      shipstation_order_id: "ord_4",
      sku: "LP-001",
      name: "Album",
      quantity: 1,
      unit_price: 25,
      item_index: 0,
    });
    tables.warehouse_shipments.push({
      id: "wsh_1",
      workspace_id: "ws_1",
      shipstation_order_id: "1004",
      ship_date: "2026-04-15",
    });
    tables.warehouse_shipment_items.push({
      shipment_id: "wsh_1",
      sku: "LP-001",
      customs_description: "Vinyl Record - 1 piece",
    });

    const data = await fetchPackingSlipData(
      makeMockClient() as unknown as Parameters<typeof fetchPackingSlipData>[0],
      "ord_4",
    );
    expect(data?.items[0]?.customs_description).toBe("Vinyl Record - 1 piece");
  });

  it("missing BC payment match returns base shape gracefully", async () => {
    tables.shipstation_orders.push({
      id: "ord_5",
      workspace_id: "ws_1",
      shipstation_order_id: 1005,
      order_number: "SS-1005",
      ship_to: {},
      advanced_options: { customField1: "BC-7777" }, // no matching sales row
      organizations: null,
    });
    const data = await fetchPackingSlipData(
      makeMockClient() as unknown as Parameters<typeof fetchPackingSlipData>[0],
      "ord_5",
    );
    expect(data?.bandcamp_enriched).toBe(false);
    expect(data?.buyer_note).toBeNull();
  });
});
