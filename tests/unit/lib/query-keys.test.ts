import { describe, expect, it } from "vitest";
import { type QueryScope, queryKeys, queryKeysV2 } from "@/lib/shared/query-keys";

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
    it("syncStatus returns expected key without channel", () => {
      expect(queryKeys.channels.syncStatus()).toEqual(["channels", "sync-status", undefined]);
    });

    it("syncStatus returns expected key with channel", () => {
      expect(queryKeys.channels.syncStatus("shopify")).toEqual([
        "channels",
        "sync-status",
        "shopify",
      ]);
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

// ───────────────────────────────────────────────────────────────────────────
// V2 — Scope-aware query keys (scoped_query_key_hardening plan)
// ───────────────────────────────────────────────────────────────────────────
//
// These tests guarantee the *cache contract* for the v2 keys:
//   1. Scope dimensions (workspaceId, orgId, viewer) appear inline so React
//      Query partial-prefix invalidation works at every level.
//   2. Two scopes that differ in ANY dimension produce non-equal keys (no
//      cross-tenant cache bleed).
//   3. `domain()` is a strict prefix of `all(scope)`, which is a strict prefix
//      of every resource key — so invalidating at any level cascades correctly.
//   4. The legacy v1 namespace and the v2 namespace never collide, so the
//      bridge invalidation pattern is safe during partial rollout.
// ───────────────────────────────────────────────────────────────────────────

describe("queryKeysV2 — scoped contract", () => {
  const staffScope: QueryScope = {
    workspaceId: "ws-1",
    orgId: null,
    viewer: "staff",
  };
  const clientScope: QueryScope = {
    workspaceId: "ws-1",
    orgId: "org-A",
    viewer: "client",
  };

  describe("scope dimensions appear inline", () => {
    it("staff (orgId=null) renders as `org:*` sentinel", () => {
      expect(queryKeysV2.shipping.all(staffScope)).toEqual([
        "shipping-v2",
        "ws:ws-1",
        "org:*",
        "as:staff",
      ]);
    });

    it("client (orgId set) renders the actual orgId", () => {
      expect(queryKeysV2.shipping.all(clientScope)).toEqual([
        "shipping-v2",
        "ws:ws-1",
        "org:org-A",
        "as:client",
      ]);
    });
  });

  describe("no cross-tenant cache bleed", () => {
    it("different workspaceId → different key", () => {
      const a = queryKeysV2.billing.snapshots(staffScope);
      const b = queryKeysV2.billing.snapshots({ ...staffScope, workspaceId: "ws-2" });
      expect(a).not.toEqual(b);
    });

    it("different orgId → different key", () => {
      const a = queryKeysV2.billing.snapshots(clientScope);
      const b = queryKeysV2.billing.snapshots({ ...clientScope, orgId: "org-B" });
      expect(a).not.toEqual(b);
    });

    it("different viewer → different key (same shape, different Server Action)", () => {
      const a = queryKeysV2.billing.snapshots({ ...clientScope, viewer: "staff" });
      const b = queryKeysV2.billing.snapshots({ ...clientScope, viewer: "client" });
      expect(a).not.toEqual(b);
    });
  });

  describe("invalidation hierarchy (prefix containment)", () => {
    function isPrefix(prefix: readonly unknown[], full: readonly unknown[]) {
      if (prefix.length > full.length) return false;
      return prefix.every((slot, i) => Object.is(slot, full[i]));
    }

    it("domain() is a prefix of all(scope)", () => {
      expect(isPrefix(queryKeysV2.shipping.domain(), queryKeysV2.shipping.all(staffScope))).toBe(
        true,
      );
    });

    it("all(scope) is a prefix of every resource key in that scope", () => {
      const root = queryKeysV2.shipping.all(staffScope);
      const list = queryKeysV2.shipping.list(staffScope, { paid: false });
      const summary = queryKeysV2.shipping.summary(staffScope);
      const detail = queryKeysV2.shipping.detail(staffScope, "ship-1");
      const items = queryKeysV2.shipping.items(staffScope, "ship-1");
      expect(isPrefix(root, list)).toBe(true);
      expect(isPrefix(root, summary)).toBe(true);
      expect(isPrefix(root, detail)).toBe(true);
      expect(isPrefix(root, items)).toBe(true);
    });

    it("scope-A all() is NOT a prefix of scope-B resource keys", () => {
      const rootA = queryKeysV2.orders.all(staffScope);
      const detailB = queryKeysV2.orders.bandcampMatch(clientScope, "order-1");
      expect(isPrefix(rootA, detailB)).toBe(false);
    });
  });

  describe("v1 / v2 namespace isolation", () => {
    it("legacy roots and v2 roots never share a top-level token", () => {
      const v1Roots = new Set(Object.values(queryKeys).map((g) => g.all[0]));
      const v2Roots = ["shipping-v2", "billing-v2", "orders-v2", "auth-context-v2"];
      for (const r of v2Roots) {
        expect(v1Roots.has(r)).toBe(false);
      }
    });

    it("v2 domains are unique among each other", () => {
      const domains = [
        queryKeysV2.shipping.domain()[0],
        queryKeysV2.billing.domain()[0],
        queryKeysV2.orders.domain()[0],
        queryKeysV2.authContext.domain()[0],
      ];
      expect(new Set(domains).size).toBe(domains.length);
    });
  });

  describe("authContext (no workspaceId in key)", () => {
    it("user key carries only viewer dimension", () => {
      expect(queryKeysV2.authContext.user("staff")).toEqual(["auth-context-v2", "user", "staff"]);
      expect(queryKeysV2.authContext.user("client")).toEqual(["auth-context-v2", "user", "client"]);
      expect(queryKeysV2.authContext.user()).toEqual(["auth-context-v2", "user", "any"]);
    });

    it("workspaceId key never embeds a workspaceId (it RETURNS one)", () => {
      const k = queryKeysV2.authContext.workspaceId("staff");
      expect(k).toEqual(["auth-context-v2", "workspace-id", "staff"]);
      expect(k.some((slot) => typeof slot === "string" && slot.startsWith("ws:"))).toBe(false);
    });
  });

  describe("orders.cockpitList accepts typed filter objects", () => {
    it("does not require a `Record<string, unknown>` cast for typed filters", () => {
      interface CockpitFiltersLike {
        orderStatus: string;
        page: number;
      }
      const filters: CockpitFiltersLike = { orderStatus: "awaiting_shipment", page: 1 };
      const key = queryKeysV2.orders.cockpitList(staffScope, filters);
      expect(key).toEqual(["orders-v2", "ws:ws-1", "org:*", "as:staff", "cockpit-list", filters]);
    });
  });
});
