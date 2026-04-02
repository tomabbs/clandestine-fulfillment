import { queue } from "@trigger.dev/sdk";

// Dedicated queue for sweep orchestration — no Bandcamp OAuth API calls.
// Runs independently of bandcamp-api (which is used by sale polls, inventory pushes,
// and the main sync) so backfill never competes with those tasks.
export const bandcampSweepQueue = queue({
  name: "bandcamp-sweep",
  concurrencyLimit: 1,
});
