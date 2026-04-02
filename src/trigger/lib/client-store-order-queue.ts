import { queue } from "@trigger.dev/sdk";

// Prevents overlapping client store order polls.
// Without this limit, two concurrent runs could both see the same new orders
// and attempt duplicate inserts (partially protected by external_order_id dedup,
// but the race still burns DB round-trips and creates noisy errors).
export const clientStoreOrderQueue = queue({
  name: "client-store-order",
  concurrencyLimit: 1,
});
