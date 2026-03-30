import { queue } from "@trigger.dev/sdk";

// Dedicated queue for ShipStation tasks.
// Kept separate from bandcampQueue (which is serial) to avoid blocking
// Bandcamp API tasks during ShipStation poll runs.
export const shipstationQueue = queue({ name: "shipstation", concurrencyLimit: 1 });
