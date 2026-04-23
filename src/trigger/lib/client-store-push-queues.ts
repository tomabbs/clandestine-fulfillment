/**
 * Phase 1 §9.2 D1 — push queues for the new per-SKU push tasks.
 *
 * Two queues:
 *
 *   1. `client-store-push` (concurrency 15) — shared by every platform's
 *      `client-store-push-on-sku` invocation. The plan §9.2 D1 specifies
 *      per-platform queues at concurrency 5 each (`shopify-client-store`,
 *      `squarespace-client-store`, `woocommerce-client-store`) for
 *      isolation. Pass 1 ships a single shared queue at the equivalent
 *      total throughput (3 × 5 = 15) to minimize Trigger.dev surface area
 *      and queue-routing complexity. Per-platform isolation is a Pass 2
 *      refinement — a Squarespace API outage on one connection cannot
 *      starve Shopify pushes today because each task body uses its own
 *      `createStoreSyncClient(connection)`; the only shared resource is
 *      worker pool slots, which a 5-min recovery window already absorbs.
 *
 *   2. `clandestine-shopify-push` (concurrency 5) — Phase 1 §9.2 D2.
 *      Distinct queue from the per-client `client-store-push` because the
 *      auth surface is completely different (env-singleton token vs
 *      per-connection offline tokens). Mixing them would let a runaway
 *      Clandestine push starve client pushes (or vice versa) on a single
 *      shared API rate budget that does not exist.
 *
 * Concurrency choice (`5` / `15`):
 *   Each push is one HTTPS round-trip (Shopify `inventory_levels/set`,
 *   WooCommerce `stock_quantity` PUT, Squarespace `quantity` PUT). Tighter
 *   concurrency does NOT help latency; it only reduces parallelism. The
 *   chosen values comfortably stay under each platform's per-app quota
 *   (Shopify Admin REST: 4 RPS sustained / 40 burst, well above 5
 *   concurrent calls per worker × Trigger.dev's small worker fleet).
 *
 * Ownership / single source of truth (Rule #58):
 *   This file is the canonical declaration of every per-SKU push queue.
 *   Tasks importing from elsewhere will produce a separate Trigger queue
 *   instance under the hood (Rule #9 footgun); always import from here.
 *
 * Pass 2 follow-up (deferred):
 *   Split `client-store-push` into three per-platform queues if/when
 *   isolation is observed to be the bottleneck.
 */

import { queue } from "@trigger.dev/sdk";

/**
 * Phase 1 §9.2 D1 — shared per-SKU push queue across every storefront
 * platform. Concurrency 15 = sum of the planned per-platform 5s.
 */
export const clientStorePushQueue = queue({
  name: "client-store-push",
  concurrencyLimit: 15,
});

/**
 * Phase 1 §9.2 D2 — per-SKU push queue for Clandestine Shopify (the
 * env-singleton store, not a client_store_connection).
 */
export const clandestineShopifyPushQueue = queue({
  name: "clandestine-shopify-push",
  concurrencyLimit: 5,
});
