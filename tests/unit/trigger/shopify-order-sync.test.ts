import { describe, expect, it } from "vitest";
import type { ShopifyLineItem } from "@/lib/clients/shopify-client";
import { groupLineItemsByOrg } from "@/trigger/tasks/shopify-order-sync";

function makeLI(sku: string, quantity = 1): ShopifyLineItem {
  return {
    id: `gid://shopify/LineItem/${sku}`,
    sku,
    title: `Product ${sku}`,
    variantTitle: null,
    quantity,
    originalUnitPriceSet: { shopMoney: { amount: "10.00" } },
  };
}

describe("groupLineItemsByOrg", () => {
  it("groups line items by org from SKU lookup", () => {
    const lineItems = [makeLI("LP-001"), makeLI("LP-002"), makeLI("CD-001")];
    const skuToOrg = new Map([
      ["LP-001", { orgId: "org-A", isPreorder: false, streetDate: null }],
      ["LP-002", { orgId: "org-A", isPreorder: false, streetDate: null }],
      ["CD-001", { orgId: "org-B", isPreorder: false, streetDate: null }],
    ]);

    const groups = groupLineItemsByOrg(lineItems, skuToOrg);

    expect(groups).toHaveLength(2);
    const orgA = groups.find((g) => g.orgId === "org-A");
    const orgB = groups.find((g) => g.orgId === "org-B");
    expect(orgA?.lineItems).toHaveLength(2);
    expect(orgB?.lineItems).toHaveLength(1);
  });

  it("splits orders with items from multiple orgs", () => {
    const lineItems = [makeLI("SKU-A"), makeLI("SKU-B")];
    const skuToOrg = new Map([
      ["SKU-A", { orgId: "org-1", isPreorder: false, streetDate: null }],
      ["SKU-B", { orgId: "org-2", isPreorder: false, streetDate: null }],
    ]);

    const groups = groupLineItemsByOrg(lineItems, skuToOrg);

    expect(groups).toHaveLength(2);
    expect(groups[0].orgId).not.toBe(groups[1].orgId);
    expect(groups[0].lineItems).toHaveLength(1);
    expect(groups[1].lineItems).toHaveLength(1);
  });

  it("detects pre-orders from variant flags", () => {
    const lineItems = [makeLI("PRE-001"), makeLI("REG-001")];
    const skuToOrg = new Map([
      ["PRE-001", { orgId: "org-A", isPreorder: true, streetDate: "2026-04-01" }],
      ["REG-001", { orgId: "org-A", isPreorder: false, streetDate: null }],
    ]);

    const groups = groupLineItemsByOrg(lineItems, skuToOrg);

    expect(groups).toHaveLength(1);
    expect(groups[0].isPreorder).toBe(true);
    expect(groups[0].streetDate).toBe("2026-04-01");
  });

  it("uses latest street date when multiple pre-order items exist", () => {
    const lineItems = [makeLI("PRE-A"), makeLI("PRE-B")];
    const skuToOrg = new Map([
      ["PRE-A", { orgId: "org-A", isPreorder: true, streetDate: "2026-04-01" }],
      ["PRE-B", { orgId: "org-A", isPreorder: true, streetDate: "2026-05-15" }],
    ]);

    const groups = groupLineItemsByOrg(lineItems, skuToOrg);

    expect(groups[0].streetDate).toBe("2026-05-15");
  });

  it("skips line items without SKU", () => {
    const lineItems: ShopifyLineItem[] = [
      {
        id: "1",
        sku: null,
        title: "Gift Card",
        variantTitle: null,
        quantity: 1,
        originalUnitPriceSet: { shopMoney: { amount: "25" } },
      },
      makeLI("LP-001"),
    ];
    const skuToOrg = new Map([["LP-001", { orgId: "org-A", isPreorder: false, streetDate: null }]]);

    const groups = groupLineItemsByOrg(lineItems, skuToOrg);

    expect(groups).toHaveLength(1);
    expect(groups[0].lineItems).toHaveLength(1);
  });

  it("skips line items with unmapped SKUs", () => {
    const lineItems = [makeLI("UNKNOWN-SKU")];
    const skuToOrg = new Map<
      string,
      { orgId: string; isPreorder: boolean; streetDate: string | null }
    >();

    const groups = groupLineItemsByOrg(lineItems, skuToOrg);

    expect(groups).toHaveLength(0);
  });
});
