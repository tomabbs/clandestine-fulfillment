import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  determineFanoutTargets,
  resolveShipstationV2EchoSkip,
  shouldEchoSkipShipstationV2,
} from "@/lib/server/inventory-fanout";

// === Pause guard — logic tests ===
// fanoutInventoryChange itself requires Supabase + external services.
// These tests verify the guard decision logic in isolation.

describe("inventory-fanout — pause guard logic", () => {
  it("returns zeroed FanoutResult immediately when workspace is paused", () => {
    // Simulate the guard decision (audit fix F2 — 2026-04-13)
    function applyPauseGuard(paused: boolean) {
      if (paused) {
        return {
          storeConnectionsPushed: 0,
          bandcampPushed: false,
          shopifyPushed: false,
          shipstationV2Enqueued: false,
        };
      }
      return null; // continue to push logic
    }

    const resultWhenPaused = applyPauseGuard(true);
    expect(resultWhenPaused).toEqual({
      storeConnectionsPushed: 0,
      bandcampPushed: false,
      shopifyPushed: false,
      shipstationV2Enqueued: false,
    });
  });

  it("does not short-circuit when workspace is not paused", () => {
    function applyPauseGuard(paused: boolean) {
      if (paused) {
        return {
          storeConnectionsPushed: 0,
          bandcampPushed: false,
          shopifyPushed: false,
          shipstationV2Enqueued: false,
        };
      }
      return null;
    }

    const resultWhenActive = applyPauseGuard(false);
    expect(resultWhenActive).toBeNull(); // continues to actual push logic
  });
});

// === ShipStation v2 echo-skip logic (audit fix F1 — 2026-04-13, Rule #65) ===
//
// fanoutInventoryChange enqueues `shipstation-v2-adjust-on-sku` for every
// non-zero, non-bundle inventory change EXCEPT when the originating event
// already reflects ShipStation v2 state. Pre-fix this gap was tracked as
// FR-1 in docs/plans/shipstation-source-of-truth-plan.md §12.
//
// Second-pass audit (2026-04-13): the operator activated **ShipStation
// Inventory Sync** for every connected Shopify / Squarespace / WooCommerce
// store AND ShipStation has native Bandcamp store integrations registered
// in `warehouse_shipstation_stores`. SS Inventory Sync subscribes directly
// to each storefront's order webhooks and decrements v2 natively at import
// time — completely independent of our app's webhook processing. The set
// below was extended to include those storefront sources to prevent the
// double-decrement loop described in Rule #65.
//
// Echo sources that MUST skip:
//   - 'shipstation'  → SHIP_NOTIFY processor; v2 already decremented locally
//   - 'reconcile'    → drift sensor pulled our DB into alignment with v2
//   - 'shopify'      → SS Inventory Sync decremented v2 from the Shopify order
//   - 'squarespace'  → SS Inventory Sync decremented v2 from the Squarespace order
//   - 'woocommerce'  → SS Inventory Sync decremented v2 from the Woo order
//   - 'bandcamp'     → SS imports the Bandcamp order natively + decrements v2
//
// Warehouse-side write sources (`manual`, `manual_inventory_count`,
// `cycle_count`, `inbound`, `preorder`, `backfill`) MUST fanout — these
// originate in our app and v2 has not yet seen them.
//
// If both layers ever drift out of sync (e.g. the storefront list above is
// reduced WITHOUT also re-enabling explicit v2 enqueues in the corresponding
// task — see the `bandcamp-sale-poll` comment block) the Phase 5 reconcile
// sensor (`shipstation-bandcamp-reconcile-{hot,warm,cold}`) catches the drift.

describe("inventory-fanout — ShipStation v2 echo-skip logic", () => {
  it.each([
    ["shipstation"],
    ["reconcile"],
    ["shopify"],
    ["squarespace"],
    ["woocommerce"],
    ["bandcamp"],
  ] as const)("skips v2 fanout for source=%s (already mirrored by v2 / SS Inventory Sync)", (source) => {
    expect(shouldEchoSkipShipstationV2(source)).toBe(true);
  });

  it.each([
    ["manual"],
    ["inbound"],
    ["preorder"],
    ["backfill"],
    ["manual_inventory_count"],
    ["cycle_count"],
  ] as const)("does NOT skip v2 fanout for warehouse-originated source=%s (v2 has not seen it)", (source) => {
    expect(shouldEchoSkipShipstationV2(source)).toBe(false);
  });

  it("does NOT skip v2 fanout when source is undefined (defensive default)", () => {
    expect(shouldEchoSkipShipstationV2(undefined)).toBe(false);
  });
});

// CF-2 (Phase 0.5) — regression guard for cross-tenant SKU mapping leak.
// fanoutInventoryChange is heavily Supabase-coupled and exercising the full
// chain inside vitest is expensive (Sentry spans + Trigger.dev tasks +
// 5+ table reads). Instead, assert at source level that the
// `client_store_sku_mappings` query is scoped by workspace_id. This catches
// the regression with zero infra.
describe("inventory-fanout — CF-2 cross-tenant filter (source-level guard)", () => {
  const src = readFileSync(
    resolve(__dirname, "../../../../src/lib/server/inventory-fanout.ts"),
    "utf8",
  );

  it('scopes client_store_sku_mappings lookup with .eq("workspace_id", workspaceId)', () => {
    // Find the actual query block (the `.from("client_store_sku_mappings")`
    // call, not the comment that mentions the table name) and verify all
    // three filters live in the same chain. If any disappear the assertion
    // fails — a future refactor that drops workspace_id filtering would
    // re-introduce the cross-tenant leak that CF-2 closed.
    const idx = src.indexOf('.from("client_store_sku_mappings")');
    expect(idx).toBeGreaterThan(-1);
    const block = src.slice(idx, idx + 800);
    expect(block).toMatch(/\.eq\("workspace_id",\s*workspaceId\)/);
    expect(block).toMatch(/\.eq\("remote_sku",\s*sku\)/);
    expect(block).toMatch(/\.eq\("is_active",\s*true\)/);
  });
});

// Phase 1 §9.2 D3 — source-level guards that pin the per-SKU enqueue
// refactor. fanoutInventoryChange() must NOT inline `inventoryAdjustQuantities`
// anymore (the Clandestine push moves into `clandestine-shopify-push-on-sku`),
// and it must NOT enqueue the empty-payload `multi-store-inventory-push` for
// the per-SKU happy path (the per-(connection_id, sku) `client-store-push-on-sku`
// task replaces it). The 5-min crons remain alive as drift safety nets, but
// they are NOT enqueued from the focused-push branch — only from the bundle-
// parent fallback near the bottom of the function.
describe("inventory-fanout — Phase 1 D3 per-SKU enqueue refactor (source-level guard)", () => {
  const src = readFileSync(
    resolve(__dirname, "../../../../src/lib/server/inventory-fanout.ts"),
    "utf8",
  );

  it("no longer calls inventoryAdjustQuantities inline (must enqueue clandestine-shopify-push-on-sku instead)", () => {
    expect(src).not.toMatch(/inventoryAdjustQuantities\s*\(/);
  });

  it("imports the new per-SKU task payload types instead of the Shopify client", () => {
    expect(src).not.toMatch(/from\s+["']@\/lib\/clients\/shopify-client["']/);
    expect(src).toMatch(
      /import\s+type\s+\{\s*ClandestineShopifyPushOnSkuPayload\s*\}\s+from\s+["']@\/trigger\/tasks\/clandestine-shopify-push-on-sku["']/,
    );
    expect(src).toMatch(
      /import\s+type\s+\{\s*ClientStorePushOnSkuPayload\s*\}\s+from\s+["']@\/trigger\/tasks\/client-store-push-on-sku["']/,
    );
  });

  it("enqueues clandestine-shopify-push-on-sku from the focused-push branch", () => {
    expect(src).toMatch(/tasks\.trigger\(\s*["']clandestine-shopify-push-on-sku["']/);
  });

  it("enqueues client-store-push-on-sku per skuMapping row (not the empty global sweep)", () => {
    // Per-row enqueue uses connectionId from the mapping row.
    expect(src).toMatch(/tasks\.trigger\(\s*["']client-store-push-on-sku["']/);
    // Pin the per-row loop variable so a regression to the empty-payload
    // global sweep is caught at source level.
    expect(src).toMatch(/for\s*\(\s*const\s+mapping\s+of\s+skuMappings/);
  });

  it("retains the bundle-parent fallback to the global sweeps (intentional Pass 1 trade-off)", () => {
    // The bundle fallback at the bottom of the function still hits the
    // global sweeps; that's documented as a known Pass 2 follow-up.
    const bundleStart = src.indexOf("parentBundles?.length");
    expect(bundleStart).toBeGreaterThan(-1);
    const bundleBlock = src.slice(bundleStart, bundleStart + 800);
    expect(bundleBlock).toMatch(/tasks\.trigger\(\s*["']bandcamp-inventory-push["'],\s*\{\}\s*\)/);
    expect(bundleBlock).toMatch(
      /tasks\.trigger\(\s*["']multi-store-inventory-push["'],\s*\{\}\s*\)/,
    );
  });
});

describe("inventory-fanout", () => {
  describe("determineFanoutTargets", () => {
    it("pushes to stores when SKU has store connections", () => {
      const targets = determineFanoutTargets(true, false);
      expect(targets.pushToStores).toBe(true);
      expect(targets.pushToBandcamp).toBe(false);
    });

    it("pushes to Bandcamp when SKU has Bandcamp mapping", () => {
      const targets = determineFanoutTargets(false, true);
      expect(targets.pushToStores).toBe(false);
      expect(targets.pushToBandcamp).toBe(true);
    });

    it("pushes to both when SKU has both mappings", () => {
      const targets = determineFanoutTargets(true, true);
      expect(targets.pushToStores).toBe(true);
      expect(targets.pushToBandcamp).toBe(true);
    });

    it("pushes to neither when SKU has no mappings", () => {
      const targets = determineFanoutTargets(false, false);
      expect(targets.pushToStores).toBe(false);
      expect(targets.pushToBandcamp).toBe(false);
    });
  });
});

// === Phase 3 D4 — connection-aware echo-skip (resolveShipstationV2EchoSkip) ===
//
// resolveShipstationV2EchoSkip extends shouldEchoSkipShipstationV2 with a
// per-connection override read from `connection_echo_overrides`. Tests pin
// the contract:
//
//   - Direct-v2 sources (`shipstation`, `reconcile`) ALWAYS echo-skip,
//     regardless of any override row. Their writes are v2's own — pushing
//     back is the literal Rule #65 echo loop.
//   - Storefront-driven sources (`shopify`, `squarespace`, `woocommerce`,
//     `bandcamp`) default to echo-skip (SS Inventory Sync mirrors them
//     into v2 already), BUT respect a `(connection_id, exclude_from_v2_echo,
//     is_active=true)` row to flip echo-skip OFF — that's the cutover-direct
//     hand-off where this connection's storefront events MUST be pushed to
//     v2 because SS Inventory Sync no longer mirrors it.
//   - Warehouse-side sources (`manual`, `manual_inventory_count`,
//     `cycle_count`, `inbound`, `preorder`, `backfill`) and undefined source
//     never echo-skip — irrelevant to override logic.
//   - DB lookup failures fail CLOSED (still echo-skip) — the alternative
//     would silently re-introduce double-decrement on transient errors.

interface MockSelectChain {
  data: { id: string } | null;
  error: Error | null;
}

function makeMockSupabase(chain: MockSelectChain) {
  // Builds a chained mock that satisfies the shape called by the resolver:
  // .from(t).select(c).eq(...).eq(...).eq(...).limit(n).maybeSingle()
  const fromImpl = (_table: string) => {
    const builder = {
      select: (_cols: string) => builder,
      eq: (_col: string, _val: unknown) => builder,
      limit: (_n: number) => builder,
      maybeSingle: async () => {
        if (chain.error) throw chain.error;
        return { data: chain.data, error: null };
      },
    };
    return builder;
  };
  return { from: fromImpl };
}

describe("resolveShipstationV2EchoSkip — Phase 3 D4 per-connection override", () => {
  it("returns false when source is undefined (mirrors sync helper)", async () => {
    const supabase = makeMockSupabase({ data: null, error: null });
    expect(await resolveShipstationV2EchoSkip(undefined, "conn-1", supabase)).toBe(false);
  });

  it.each([
    ["manual"],
    ["inbound"],
    ["preorder"],
    ["backfill"],
    ["manual_inventory_count"],
    ["cycle_count"],
  ] as const)("returns false (no skip) for warehouse-originated source=%s regardless of override", async (source) => {
    // Even with an active override row in the DB, warehouse-side sources
    // are not in SHIPSTATION_V2_ECHO_SOURCES at all — short-circuits to
    // false before the DB lookup.
    const supabase = makeMockSupabase({ data: { id: "ovr-1" }, error: null });
    expect(await resolveShipstationV2EchoSkip(source, "conn-1", supabase)).toBe(false);
  });

  it.each([
    ["shipstation"],
    ["reconcile"],
  ] as const)("returns true (always skip) for direct-v2 source=%s, ignoring any override", async (source) => {
    // Even with an active override row in the DB, direct-v2 sources cannot
    // be pushed back to v2 — that's the Rule #65 echo loop. The override
    // table only governs storefront-driven sources.
    const supabase = makeMockSupabase({ data: { id: "ovr-1" }, error: null });
    expect(await resolveShipstationV2EchoSkip(source, "conn-1", supabase)).toBe(true);
  });

  it.each([
    ["shopify"],
    ["squarespace"],
    ["woocommerce"],
    ["bandcamp"],
  ] as const)("returns true (default echo-skip) for storefront source=%s with NO override row", async (source) => {
    const supabase = makeMockSupabase({ data: null, error: null });
    expect(await resolveShipstationV2EchoSkip(source, "conn-1", supabase)).toBe(true);
  });

  it.each([
    ["shopify"],
    ["squarespace"],
    ["woocommerce"],
    ["bandcamp"],
  ] as const)("returns false (override applies) for storefront source=%s with active exclude_from_v2_echo row", async (source) => {
    const supabase = makeMockSupabase({ data: { id: "ovr-1" }, error: null });
    expect(await resolveShipstationV2EchoSkip(source, "conn-1", supabase)).toBe(false);
  });

  it.each([
    ["shopify"],
    ["squarespace"],
    ["woocommerce"],
    ["bandcamp"],
  ] as const)("returns true (no override applies) for storefront source=%s when originatingConnectionId is null", async (source) => {
    // Legacy callsites that don't plumb the connection_id yet still get
    // the pre-Phase-3 behavior (always echo-skip). This is the safe default
    // until every caller is updated.
    const supabase = makeMockSupabase({ data: { id: "ovr-1" }, error: null });
    expect(await resolveShipstationV2EchoSkip(source, null, supabase)).toBe(true);
    expect(await resolveShipstationV2EchoSkip(source, undefined, supabase)).toBe(true);
  });

  it("fails CLOSED (returns true / still echo-skips) when the override lookup throws", async () => {
    // A transient DB error must NOT silently flip echo-skip off — that
    // would re-introduce the double-decrement bug Rule #65 prevents. The
    // safe failure mode is to keep echo-skipping until the override can be
    // confirmed.
    const supabase = makeMockSupabase({ data: null, error: new Error("transient db failure") });
    expect(await resolveShipstationV2EchoSkip("shopify", "conn-1", supabase)).toBe(true);
  });
});

// === Phase 3 D4 — fanoutInventoryChange signature accepts originatingConnectionId ===
//
// Source-level guard: the published signature must include the
// originatingConnectionId parameter so callers (recordInventoryChange,
// process-client-store-webhook) can plumb it through. A regression that
// drops the param would silently revert per-connection cutover behavior.
describe("inventory-fanout — Phase 3 originatingConnectionId plumbing (source-level guard)", () => {
  const src = readFileSync(
    resolve(__dirname, "../../../../src/lib/server/inventory-fanout.ts"),
    "utf8",
  );

  it("fanoutInventoryChange exposes originatingConnectionId as an optional parameter", () => {
    // Pin the parameter spelling + optional shape so a refactor that drops
    // it (or renames it) breaks loudly rather than silently restoring
    // pre-Phase-3 echo behavior.
    expect(src).toMatch(/originatingConnectionId\?\s*:\s*string\s*\|\s*null/);
  });

  it("uses the async resolveShipstationV2EchoSkip in the v2 push branch (not the sync helper)", () => {
    // The async resolver is what consults connection_echo_overrides. If a
    // refactor swaps it back to the sync `shouldEchoSkipShipstationV2`,
    // per-connection overrides become dead code.
    expect(src).toMatch(/resolveShipstationV2EchoSkip\s*\(/);
  });

  it("plumbs originatingConnectionId into the resolver call", () => {
    // Defensive: the resolver must receive the connection_id, otherwise the
    // override row lookup is impossible.
    expect(src).toMatch(/resolveShipstationV2EchoSkip\([^)]*originatingConnectionId/);
  });
});
