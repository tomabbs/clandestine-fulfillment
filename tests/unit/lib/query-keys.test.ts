import { describe, expect, it } from "vitest";
import { queryKeys } from "@/lib/shared/query-keys";

describe("queryKeys", () => {
  describe("products", () => {
    it("all returns base key", () => {
      expect(queryKeys.products.all).toEqual(["products"]);
    });

    it("list includes filters", () => {
      const filters = { status: "active" };
      expect(queryKeys.products.list(filters)).toEqual(["products", "list", filters]);
    });

    it("list without filters includes undefined", () => {
      expect(queryKeys.products.list()).toEqual(["products", "list", undefined]);
    });

    it("detail includes id", () => {
      expect(queryKeys.products.detail("abc")).toEqual(["products", "detail", "abc"]);
    });
  });

  describe("inventory", () => {
    it("all returns base key", () => {
      expect(queryKeys.inventory.all).toEqual(["inventory"]);
    });

    it("detail uses sku", () => {
      expect(queryKeys.inventory.detail("SKU-001")).toEqual(["inventory", "detail", "SKU-001"]);
    });
  });

  describe("orders", () => {
    it("all returns base key", () => {
      expect(queryKeys.orders.all).toEqual(["orders"]);
    });

    it("list includes filters", () => {
      expect(queryKeys.orders.list({ status: "pending" })).toEqual([
        "orders",
        "list",
        { status: "pending" },
      ]);
    });
  });

  describe("shipments", () => {
    it("all and detail work", () => {
      expect(queryKeys.shipments.all).toEqual(["shipments"]);
      expect(queryKeys.shipments.detail("s1")).toEqual(["shipments", "detail", "s1"]);
    });
  });

  describe("clients", () => {
    it("all, list, and detail work", () => {
      expect(queryKeys.clients.all).toEqual(["clients"]);
      expect(queryKeys.clients.list()).toEqual(["clients", "list"]);
      expect(queryKeys.clients.detail("org-1")).toEqual(["clients", "detail", "org-1"]);
    });
  });

  describe("billing", () => {
    it("all and rules work", () => {
      expect(queryKeys.billing.all).toEqual(["billing"]);
      expect(queryKeys.billing.rules()).toEqual(["billing", "rules"]);
    });

    it("snapshots includes filters", () => {
      expect(queryKeys.billing.snapshots({ period: "2024-01" })).toEqual([
        "billing",
        "snapshots",
        { period: "2024-01" },
      ]);
    });
  });

  describe("bandcamp", () => {
    it("accounts includes workspaceId", () => {
      expect(queryKeys.bandcamp.accounts("ws-1")).toEqual(["bandcamp", "accounts", "ws-1"]);
    });

    it("mappings includes orgId", () => {
      expect(queryKeys.bandcamp.mappings("org-1")).toEqual(["bandcamp", "mappings", "org-1"]);
    });
  });

  describe("support", () => {
    it("messages includes conversationId", () => {
      expect(queryKeys.support.messages("conv-1")).toEqual(["support", "messages", "conv-1"]);
    });
  });

  describe("channels", () => {
    it("syncStatus returns expected key", () => {
      expect(queryKeys.channels.syncStatus()).toEqual(["channels", "sync-status"]);
    });
  });

  describe("key uniqueness", () => {
    it("top-level keys are all unique", () => {
      const allKeys = Object.values(queryKeys).map((group) => group.all[0]);
      const unique = new Set(allKeys);
      expect(unique.size).toBe(allKeys.length);
    });
  });
});
