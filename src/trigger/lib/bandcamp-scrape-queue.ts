import { queue } from "@trigger.dev/sdk";

// Rule #60: HTML scraping uses a SEPARATE queue (concurrency 3).
// concurrencyLimit: 3 means at most 3 Bandcamp pages are fetched simultaneously.
// This is a soft rate limit; Bandcamp does not publish hard rate limits for
// HTML scraping but 3 concurrent workers is conservative. Monitor for 429/blocks.
// (rateLimit is not in the current @trigger.dev/sdk QueueOptions type.)
export const bandcampScrapeQueue = queue({ name: "bandcamp-scrape", concurrencyLimit: 3 });
