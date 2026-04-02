import { queue } from "@trigger.dev/sdk";

// Rule #60: HTML scraping uses a SEPARATE queue (concurrency 5 as of 2026-04).
// Soft rate limit — Bandcamp does not publish hard HTML scrape limits; watch 429/blocks.
// (rateLimit is not in the current @trigger.dev/sdk QueueOptions type.)
export const bandcampScrapeQueue = queue({ name: "bandcamp-scrape", concurrencyLimit: 5 });
