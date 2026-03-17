import { queue } from "@trigger.dev/sdk";

// Rule #60: HTML scraping uses a SEPARATE queue (concurrency 3)
export const bandcampScrapeQueue = queue({ name: "bandcamp-scrape", concurrencyLimit: 3 });
