import { describe, expect, it } from "vitest";
import { matchOrgByPirateShipName, parseXlsx } from "@/lib/clients/pirate-ship-parser";
import {
  buildTestXlsx,
  INTL_DATA_ROW,
  SAMPLE_HEADERS,
  SAMPLE_ROW_1,
  SAMPLE_ROW_2,
  SAMPLE_ROW_INTERNATIONAL,
} from "../../../fixtures/pirate-ship-sample";

describe("parseXlsx", () => {
  it("parses a basic XLSX with standard Pirate Ship columns", () => {
    const xlsx = buildTestXlsx([SAMPLE_HEADERS, SAMPLE_ROW_1, SAMPLE_ROW_2]);
    const result = parseXlsx(xlsx);

    expect(result.totalRows).toBe(2);
    expect(result.shipments).toHaveLength(2);
    expect(result.parseErrors).toHaveLength(0);

    const first = result.shipments[0];
    expect(first.orderNumber).toBe("ORD-001");
    expect(first.trackingNumber).toBe("1Z999AA10123456784");
    expect(first.carrier).toBe("UPS");
    expect(first.service).toBe("Ground");
    expect(first.shipDate).toBe("2026-03-15");
    expect(first.weight).toBe(2.5);
    expect(first.cost).toBe(8.99);
    expect(first.recipientName).toBe("Fat Possum Records");
    expect(first.recipientAddress1).toBe("123 Main St");
    expect(first.recipientAddress2).toBe("Suite 4");
    expect(first.recipientCity).toBe("Oxford");
    expect(first.recipientState).toBe("MS");
    expect(first.recipientZip).toBe("38655");
    expect(first.recipientCountry).toBe("US");
    expect(first.customs).toBeNull();
  });

  it("maps column indices correctly", () => {
    const xlsx = buildTestXlsx([SAMPLE_HEADERS, SAMPLE_ROW_1]);
    const result = parseXlsx(xlsx);

    expect(result.columnMap.orderNumber).toBe(0);
    expect(result.columnMap.trackingNumber).toBe(1);
    expect(result.columnMap.carrier).toBe(2);
    expect(result.columnMap.recipientName).toBe(7);
  });

  it("handles international shipping with customs fields", () => {
    const xlsx = buildTestXlsx([SAMPLE_ROW_INTERNATIONAL, INTL_DATA_ROW]);
    const result = parseXlsx(xlsx);

    expect(result.shipments).toHaveLength(1);
    const shipment = result.shipments[0];
    expect(shipment.recipientCountry).toBe("GB");
    expect(shipment.customs).not.toBeNull();
    expect(shipment.customs?.description).toBe("Vinyl Records");
    expect(shipment.customs?.value).toBe(25.0);
    expect(shipment.customs?.quantity).toBe(2);
    expect(shipment.customs?.hsTariff).toBe("8523.80");
    expect(shipment.customs?.countryOfOrigin).toBe("US");
  });

  it("skips empty rows without errors", () => {
    const xlsx = buildTestXlsx([
      SAMPLE_HEADERS,
      SAMPLE_ROW_1,
      ["", "", "", "", "", "", "", "", "", "", "", "", "", "", ""],
      SAMPLE_ROW_2,
    ]);
    const result = parseXlsx(xlsx);

    expect(result.shipments).toHaveLength(2);
    expect(result.parseErrors).toHaveLength(0);
  });

  it("records parse error for rows missing both tracking and order number", () => {
    const badRow = [
      "",
      "",
      "UPS",
      "Ground",
      "2026-03-15",
      "1.0",
      "5.00",
      "Some Name",
      "",
      "123 St",
      "",
      "City",
      "ST",
      "12345",
      "US",
    ];
    const xlsx = buildTestXlsx([SAMPLE_HEADERS, badRow]);
    const result = parseXlsx(xlsx);

    expect(result.shipments).toHaveLength(0);
    expect(result.parseErrors).toHaveLength(1);
    expect(result.parseErrors[0].message).toContain(
      "missing both tracking number and order number",
    );
  });

  it("handles missing optional columns gracefully", () => {
    const minimalHeaders = ["Order Number", "Tracking Number"];
    const minimalRow = ["ORD-100", "TRACK123"];
    const xlsx = buildTestXlsx([minimalHeaders, minimalRow]);
    const result = parseXlsx(xlsx);

    expect(result.shipments).toHaveLength(1);
    expect(result.shipments[0].orderNumber).toBe("ORD-100");
    expect(result.shipments[0].trackingNumber).toBe("TRACK123");
    expect(result.shipments[0].carrier).toBeNull();
    expect(result.shipments[0].cost).toBeNull();
    expect(result.shipments[0].recipientName).toBeNull();
  });

  it("parses currency values with $ and commas", () => {
    const headers = ["Order Number", "Tracking Number", "Cost"];
    const row = ["ORD-X", "TRACK-X", "$1,234.56"];
    const xlsx = buildTestXlsx([headers, row]);
    const result = parseXlsx(xlsx);

    expect(result.shipments[0].cost).toBe(1234.56);
  });

  it("handles alternative column names", () => {
    const altHeaders = [
      "Order #",
      "Tracking #",
      "Shipping Carrier",
      "Ship To Name",
      "Shipping Cost",
    ];
    const row = ["ORD-ALT", "TRACK-ALT", "FedEx", "Alt Label", "12.34"];
    const xlsx = buildTestXlsx([altHeaders, row]);
    const result = parseXlsx(xlsx);

    expect(result.shipments).toHaveLength(1);
    expect(result.shipments[0].carrier).toBe("FedEx");
    expect(result.shipments[0].recipientName).toBe("Alt Label");
    expect(result.shipments[0].cost).toBe(12.34);
  });

  it("throws on invalid ZIP data", () => {
    expect(() => parseXlsx(Buffer.from("not a zip file"))).toThrow();
  });

  it("throws when buffer is malformed", () => {
    expect(() => parseXlsx(Buffer.alloc(100))).toThrow();
  });

  it("returns empty result for XLSX with only headers", () => {
    const xlsx = buildTestXlsx([SAMPLE_HEADERS]);
    const result = parseXlsx(xlsx);

    expect(result.totalRows).toBe(0);
    expect(result.shipments).toHaveLength(0);
  });
});

describe("matchOrgByPirateShipName", () => {
  const mockOrgs = [
    { id: "org-1", name: "Fat Possum Records", pirate_ship_name: "Fat Possum Records" },
    { id: "org-2", name: "Sub Pop", pirate_ship_name: "Sub Pop Records" },
    { id: "org-3", name: "Merge Records", pirate_ship_name: "Merge" },
  ];

  function makeMockSupabase(orgs: typeof mockOrgs) {
    return {
      from: (_table: string) => ({
        select: (_columns: string) => ({
          eq: (_column: string, _value: string) => ({
            not: (_column: string, _operator: string, _value: null) => ({
              data: orgs,
            }),
          }),
        }),
      }),
    };
  }

  it("matches exact pirate_ship_name (case-insensitive)", async () => {
    const result = await matchOrgByPirateShipName(
      "fat possum records",
      null,
      "ws-1",
      makeMockSupabase(mockOrgs),
    );

    expect(result.matched).toBe(true);
    expect(result.orgId).toBe("org-1");
    expect(result.orgName).toBe("Fat Possum Records");
  });

  it("matches on company name if recipient name fails", async () => {
    const result = await matchOrgByPirateShipName(
      "John Doe",
      "Sub Pop Records",
      "ws-1",
      makeMockSupabase(mockOrgs),
    );

    expect(result.matched).toBe(true);
    expect(result.orgId).toBe("org-2");
  });

  it("matches partial/contains names", async () => {
    const result = await matchOrgByPirateShipName(
      "Merge Records LLC",
      null,
      "ws-1",
      makeMockSupabase(mockOrgs),
    );

    expect(result.matched).toBe(true);
    expect(result.orgId).toBe("org-3");
    expect(result.matchedOn).toBe("Merge Records LLC");
  });

  it("returns unmatched for unknown names", async () => {
    const result = await matchOrgByPirateShipName(
      "Unknown Label",
      null,
      "ws-1",
      makeMockSupabase(mockOrgs),
    );

    expect(result.matched).toBe(false);
    expect(result.orgId).toBeNull();
  });

  it("returns unmatched when both name and company are null", async () => {
    const result = await matchOrgByPirateShipName(null, null, "ws-1", makeMockSupabase(mockOrgs));

    expect(result.matched).toBe(false);
  });

  it("returns unmatched when no orgs have pirate_ship_name set", async () => {
    const result = await matchOrgByPirateShipName("Some Label", null, "ws-1", makeMockSupabase([]));

    expect(result.matched).toBe(false);
  });
});
