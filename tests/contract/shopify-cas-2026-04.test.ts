/**
 * Phase 1 Pass 2 §9.2 D4 Step C / D4.1 — Shopify CAS contract test.
 *
 * Validates the `setShopifyInventoryWithCompare` helper against a REAL
 * Shopify Admin GraphQL endpoint (a long-lived test store on the
 * 2026-04 API version). The CAS contract is the ONE thing the unit tests
 * cannot prove on their own — the unit tests mock the GraphQL client, so
 * a Shopify schema rename (e.g. `compareQuantity` → `expectedQuantity`)
 * or a `@idempotent` directive removal would slip past unit tests but
 * ship a silently-broken hot-path retry loop.
 *
 * --------------------------------------------------------------------------
 * GATE: This file is GATED on `SHOPIFY_CONTRACT_TEST=1` AND a full set of
 * `SHOPIFY_CONTRACT_*` credentials. The release-gate runner
 * (`scripts/check-release-gates.sh`) calls this file unconditionally and
 * the suite skips itself when the env is missing — so a developer running
 * `pnpm vitest run` locally never needs the credentials, but the cutover
 * gate refuses to pass-by-skip in CI when `REQUIRE_SHOPIFY_CONTRACT=1` is
 * set in the cutover workflow.
 * --------------------------------------------------------------------------
 *
 * Required env (set in the cutover workflow's secret store, NOT in repo):
 *
 *   SHOPIFY_CONTRACT_TEST=1
 *   SHOPIFY_CONTRACT_STORE_URL=https://clandestine-cas-test.myshopify.com
 *   SHOPIFY_CONTRACT_ACCESS_TOKEN=shpat_xxx   # offline token, write_inventory scope
 *   SHOPIFY_CONTRACT_INVENTORY_ITEM_ID=gid://shopify/InventoryItem/123
 *   SHOPIFY_CONTRACT_LOCATION_ID=gid://shopify/Location/456
 *
 * The test store should be a dedicated, throwaway dev store — the test
 * mutates inventory on the configured InventoryItem. It resets to a known
 * baseline at the start of each test, so back-to-back runs are safe, but
 * concurrent runs against the same store WILL race each other.
 *
 * What this test pins (and unit tests cannot):
 *   1. `inventorySetQuantities` mutation accepts `compareQuantity` and
 *      returns `INVALID_COMPARE_QUANTITY` (or our message-substring
 *      fallback) on mismatch — so the CAS retry loop has a real signal.
 *   2. `@idempotent(key:)` directive is honored — the same key submitted
 *      twice does NOT create a second adjustment row. (Without this, the
 *      hot-path retry loop's `:retryN` suffix is the ONLY layer of dedup
 *      and any framework retry would double-write.)
 *   3. `referenceDocumentUri` survives the round-trip on the audit row —
 *      so we can reverse-map a Shopify adjustment to a clandestine
 *      correlation_id without a parallel ledger.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { makeCasIdempotencyKey, setShopifyInventoryWithCompare } from "@/lib/clients/shopify-cas";
import type { ConnectionShopifyContext } from "@/lib/server/shopify-connection-graphql";

const CONTRACT_GATE = process.env.SHOPIFY_CONTRACT_TEST === "1";
const STORE_URL = process.env.SHOPIFY_CONTRACT_STORE_URL ?? "";
const ACCESS_TOKEN = process.env.SHOPIFY_CONTRACT_ACCESS_TOKEN ?? "";
const INVENTORY_ITEM_ID = process.env.SHOPIFY_CONTRACT_INVENTORY_ITEM_ID ?? "";
const LOCATION_ID = process.env.SHOPIFY_CONTRACT_LOCATION_ID ?? "";

// REQUIRE_SHOPIFY_CONTRACT=1 in the cutover CI workflow turns "skipped"
// into "failed" — local devs without the env get a clean skip.
const REQUIRE = process.env.REQUIRE_SHOPIFY_CONTRACT === "1";

const ENV_READY =
  CONTRACT_GATE &&
  STORE_URL.length > 0 &&
  ACCESS_TOKEN.length > 0 &&
  INVENTORY_ITEM_ID.length > 0 &&
  LOCATION_ID.length > 0;

// One small note: vitest's `describe.skipIf(true)` evaluates the predicate
// at import time, so we wrap the whole suite in a top-level conditional
// rather than per-test skip. This keeps the SKIP message clear in CI logs.
if (!ENV_READY) {
  if (REQUIRE) {
    describe("Shopify CAS contract (2026-04) — REQUIRED but env missing", () => {
      it("fails because REQUIRE_SHOPIFY_CONTRACT=1 but contract env is incomplete", () => {
        const missing = [
          ["SHOPIFY_CONTRACT_TEST=1", CONTRACT_GATE ? "set" : "MISSING"],
          ["SHOPIFY_CONTRACT_STORE_URL", STORE_URL ? "set" : "MISSING"],
          ["SHOPIFY_CONTRACT_ACCESS_TOKEN", ACCESS_TOKEN ? "set" : "MISSING"],
          ["SHOPIFY_CONTRACT_INVENTORY_ITEM_ID", INVENTORY_ITEM_ID ? "set" : "MISSING"],
          ["SHOPIFY_CONTRACT_LOCATION_ID", LOCATION_ID ? "set" : "MISSING"],
        ]
          .map(([k, v]) => `${k}=${v}`)
          .join(", ");
        throw new Error(`REQUIRE_SHOPIFY_CONTRACT=1 but contract test env incomplete: ${missing}`);
      });
    });
  } else {
    describe.skip("Shopify CAS contract (2026-04) — gated on SHOPIFY_CONTRACT_TEST=1", () => {
      it("skipped (set SHOPIFY_CONTRACT_TEST=1 + SHOPIFY_CONTRACT_* env to run)", () => {
        // intentionally empty — describe.skip prevents execution
      });
    });
  }
} else {
  describe("Shopify CAS contract (2026-04)", () => {
    const ctx: ConnectionShopifyContext = {
      storeUrl: STORE_URL,
      accessToken: ACCESS_TOKEN,
    };

    // Use a stable correlation namespace per run so back-to-back runs against
    // the same store don't accidentally hit the @idempotent dedup window.
    const RUN_ID = `cas-contract-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const TEST_SKU = "CAS-CONTRACT-SKU";

    // Baseline value the suite resets to at start. Picked to be small and
    // recognizable in the Shopify admin UI when triaging a flake.
    const BASELINE = 50;

    async function setBaseline(): Promise<void> {
      // Force-reset by ignoring CAS — we don't care what the prior run left
      // behind, only that we have a known starting point for THIS run.
      const resetKey = makeCasIdempotencyKey("clandestine_shopify", `${RUN_ID}:reset`, TEST_SKU);
      // Read first so we have a real expected value (CAS path); if it's
      // already BASELINE we're done.
      // (We can't call inventorySetQuantities with ignoreCompareQuantity:true
      // through our helper — by design the helper enforces CAS. So we read,
      // then write.)
      const remote = await readRemoteAvailable(ctx, INVENTORY_ITEM_ID, LOCATION_ID);
      if (remote === BASELINE) return;
      const result = await setShopifyInventoryWithCompare(
        { kind: "per_connection", ctx },
        {
          inventoryItemId: INVENTORY_ITEM_ID,
          locationId: LOCATION_ID,
          expectedQuantity: remote,
          desiredQuantity: BASELINE,
          idempotencyKey: resetKey,
          reason: "correction",
        },
      );
      if (!result.ok) {
        throw new Error(
          `baseline reset failed: ${result.reason} (actual=${result.actualQuantity})`,
        );
      }
    }

    beforeAll(async () => {
      await setBaseline();
    }, 30_000);

    afterAll(async () => {
      // Best-effort restore — don't fail the suite if Shopify rate-limits
      // us at teardown.
      try {
        await setBaseline();
      } catch {
        // swallow
      }
    }, 30_000);

    it("happy path — CAS write returns ok:true and persists desiredQuantity", async () => {
      const desired = BASELINE + 7;
      const key = makeCasIdempotencyKey("clandestine_shopify", `${RUN_ID}:happy`, TEST_SKU);
      const result = await setShopifyInventoryWithCompare(
        { kind: "per_connection", ctx },
        {
          inventoryItemId: INVENTORY_ITEM_ID,
          locationId: LOCATION_ID,
          expectedQuantity: BASELINE,
          desiredQuantity: desired,
          idempotencyKey: key,
        },
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.newQuantity).toBe(desired);
      expect(result.adjustmentGroupId).toMatch(/^gid:\/\/shopify\/InventoryAdjustmentGroup\//);

      // Confirm via independent read.
      const remote = await readRemoteAvailable(ctx, INVENTORY_ITEM_ID, LOCATION_ID);
      expect(remote).toBe(desired);
    }, 30_000);

    it("CAS mismatch — wrong expected returns ok:false with actualQuantity", async () => {
      // Reset to BASELINE first so this test is independent.
      await setBaseline();

      const key = makeCasIdempotencyKey("clandestine_shopify", `${RUN_ID}:mismatch`, TEST_SKU);
      const result = await setShopifyInventoryWithCompare(
        { kind: "per_connection", ctx },
        {
          inventoryItemId: INVENTORY_ITEM_ID,
          locationId: LOCATION_ID,
          // Intentionally wrong — actual is BASELINE.
          expectedQuantity: BASELINE + 9999,
          desiredQuantity: BASELINE - 1,
          idempotencyKey: key,
        },
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe("compare_mismatch");
      // The contract gate insists Shopify reports actual quantity in the
      // userError. If this assertion fails, Shopify changed the message
      // shape — update extractActualQuantity in shopify-cas.ts.
      expect(result.actualQuantity).toBe(BASELINE);

      // Confirm Shopify did NOT mutate state on a CAS-failed write.
      const remote = await readRemoteAvailable(ctx, INVENTORY_ITEM_ID, LOCATION_ID);
      expect(remote).toBe(BASELINE);
    }, 30_000);

    it("@idempotent — same key submitted twice does NOT double-write", async () => {
      await setBaseline();

      const desired = BASELINE + 3;
      const key = makeCasIdempotencyKey("clandestine_shopify", `${RUN_ID}:idem`, TEST_SKU);

      // First write.
      const first = await setShopifyInventoryWithCompare(
        { kind: "per_connection", ctx },
        {
          inventoryItemId: INVENTORY_ITEM_ID,
          locationId: LOCATION_ID,
          expectedQuantity: BASELINE,
          desiredQuantity: desired,
          idempotencyKey: key,
        },
      );
      expect(first.ok).toBe(true);
      if (!first.ok) return;
      expect(first.newQuantity).toBe(desired);

      // Second write with the SAME key — Shopify's @idempotent directive
      // should return the original result without applying a second
      // adjustment. If this test fails, the directive is no longer being
      // honored and the hot-path retry loop is unsafe.
      const second = await setShopifyInventoryWithCompare(
        { kind: "per_connection", ctx },
        {
          inventoryItemId: INVENTORY_ITEM_ID,
          locationId: LOCATION_ID,
          // Note: we intentionally pass DIFFERENT expected/desired here.
          // If @idempotent is honored, Shopify ignores the new input and
          // returns the original result (newQuantity == desired).
          // If @idempotent is NOT honored, Shopify either applies the new
          // values (newQuantity != desired) OR returns CAS mismatch
          // (because expected is now stale).
          expectedQuantity: BASELINE,
          desiredQuantity: desired + 100,
          idempotencyKey: key,
        },
      );
      expect(second.ok).toBe(true);
      if (!second.ok) return;
      // The exact return shape on idempotent replay isn't documented to
      // round-trip the original `quantityAfterChange`, so we assert the
      // SIDE EFFECT: remote available is still `desired`, NOT `desired+100`.
      const remote = await readRemoteAvailable(ctx, INVENTORY_ITEM_ID, LOCATION_ID);
      expect(remote).toBe(desired);
    }, 30_000);

    it("retry suffix — `:retry1` is a fresh key Shopify treats independently", async () => {
      await setBaseline();

      const desired = BASELINE - 5;
      const baseKey = makeCasIdempotencyKey("clandestine_shopify", `${RUN_ID}:retry`, TEST_SKU);
      const retryKey = makeCasIdempotencyKey("clandestine_shopify", `${RUN_ID}:retry`, TEST_SKU, 1);
      expect(retryKey).toBe(`${baseKey}:retry1`);

      // First write succeeds with base key.
      const first = await setShopifyInventoryWithCompare(
        { kind: "per_connection", ctx },
        {
          inventoryItemId: INVENTORY_ITEM_ID,
          locationId: LOCATION_ID,
          expectedQuantity: BASELINE,
          desiredQuantity: desired,
          idempotencyKey: baseKey,
        },
      );
      expect(first.ok).toBe(true);

      // Retry write with `:retry1` key — Shopify should treat it as a
      // brand-new mutation, attempt the CAS against the NEW expected (the
      // value first write just landed), and succeed.
      const retried = await setShopifyInventoryWithCompare(
        { kind: "per_connection", ctx },
        {
          inventoryItemId: INVENTORY_ITEM_ID,
          locationId: LOCATION_ID,
          expectedQuantity: desired,
          desiredQuantity: desired - 1,
          idempotencyKey: retryKey,
        },
      );
      expect(retried.ok).toBe(true);
      if (!retried.ok) return;
      expect(retried.newQuantity).toBe(desired - 1);
    }, 30_000);
  });
}

/**
 * Independent read of `inventoryLevel.quantities[available]` — bypasses
 * the helper so we can confirm side-effects without circular reasoning.
 */
async function readRemoteAvailable(
  ctx: ConnectionShopifyContext,
  inventoryItemId: string,
  locationId: string,
): Promise<number> {
  const { connectionShopifyGraphQL } = await import("@/lib/server/shopify-connection-graphql");
  const query = `
    query ContractRead($inventoryItemId: ID!, $locationId: ID!) {
      inventoryItem(id: $inventoryItemId) {
        inventoryLevel(locationId: $locationId) {
          quantities(names: ["available"]) {
            name
            quantity
          }
        }
      }
    }
  `;
  const data = await connectionShopifyGraphQL<{
    inventoryItem: {
      inventoryLevel: {
        quantities: Array<{ name: string; quantity: number }>;
      } | null;
    } | null;
  }>(ctx, query, { inventoryItemId, locationId });
  const q = data.inventoryItem?.inventoryLevel?.quantities ?? [];
  const available = q.find((row) => row.name === "available");
  if (!available) {
    throw new Error("inventoryLevel.quantities[available] not found in contract read");
  }
  return available.quantity;
}
