import { queue } from "@trigger.dev/sdk";

// Rule #9: ALL Bandcamp OAuth API tasks share this queue (concurrencyLimit: 1)
export const bandcampQueue = queue({ name: "bandcamp-api", concurrencyLimit: 1 });
