/**
 * Canonical pre-order date helpers.
 *
 * All comparisons use America/New_York to stay aligned with:
 *   - preorder-fulfillment cron (America/New_York)
 *   - what the customer sees on the storefront ("releases on <date> in NY time")
 *
 * Never import `new Date()` directly for release-date comparisons — always use
 * getTodayNY() so the entire system shares a single timezone reference.
 */

/** Returns today as YYYY-MM-DD in America/New_York. */
export function getTodayNY(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}

/** Normalise a timestamptz or date-only string to YYYY-MM-DD. Returns null if falsy. */
export function extractDateOnly(dateStr: string | null | undefined): string | null {
  if (!dateStr) return null;
  return dateStr.slice(0, 10);
}

/**
 * Returns true when the release date is strictly in the future (pre-order).
 * Compares date-only strings to avoid "releases at midnight" edge cases.
 */
export function isFutureReleaseDate(dateStr: string | null | undefined): boolean {
  const d = extractDateOnly(dateStr);
  if (!d) return false;
  return d > getTodayNY();
}

/** Returns true when the release date is today or in the past (should release). */
export function isStreetDateOnOrBefore(dateStr: string | null | undefined): boolean {
  const d = extractDateOnly(dateStr);
  if (!d) return false;
  return d <= getTodayNY();
}

/** Returns true when the street_date is more than `days` days in the past. */
export function isDaysAfterRelease(dateStr: string | null | undefined, days: number): boolean {
  const d = extractDateOnly(dateStr);
  if (!d) return false;
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  return d <= cutoff.toISOString().slice(0, 10);
}

/**
 * Derives the canonical street_date (YYYY-MM-DD) and is_preorder flag
 * from the available data sources, in priority order:
 *
 *  1. Scraper-verified bandcamp_release_date (most accurate)
 *  2. bandcamp_new_date from API                (good fallback)
 *  3. merchItem.new_date from the merch scan    (last resort)
 *
 * bandcamp_is_preorder overrides the date-based calculation when true.
 */
export function deriveStreetDateAndPreorder(params: {
  /** Date from scraper (e.g. bandcamp_product_mappings.bandcamp_release_date) — preferred */
  scraperReleaseDate?: string | null;
  /** Date from Bandcamp API tralbum listing (bandcamp_product_mappings.bandcamp_new_date) */
  apiNewDate?: string | null;
  /** Raw new_date from the merch item scan result */
  merchNewDate?: string | null;
  /** Explicit pre-order flag from mapping scraper */
  bandcampIsPreorder?: boolean | null;
  /** Current value on the variant (used to decide whether to overwrite) */
  currentStreetDate?: string | null;
  /** Only allow overwriting street_date when authority_status = 'bandcamp_initial' */
  authorityStatus?: string | null;
}): { street_date: string | null; is_preorder: boolean } {
  const today = getTodayNY();
  const isInitial = !params.authorityStatus || params.authorityStatus === "bandcamp_initial";

  // Pick the best available date (priority order)
  const scraped = extractDateOnly(params.scraperReleaseDate);
  const api = extractDateOnly(params.apiNewDate);
  const merch = extractDateOnly(params.merchNewDate);

  let street_date: string | null = params.currentStreetDate
    ? extractDateOnly(params.currentStreetDate)
    : null;

  // Only overwrite when we have authority
  if (isInitial) {
    if (scraped) {
      street_date = scraped;
    } else if (api) {
      street_date = api;
    } else if (merch) {
      street_date = merch;
    }
  } else if (!street_date) {
    // Even for warehouse-owned variants, fill an empty date from available sources
    street_date = scraped ?? api ?? merch ?? null;
  }

  // Determine is_preorder
  let is_preorder = false;
  if (params.bandcampIsPreorder === true) {
    // Explicit scraper signal beats date arithmetic
    is_preorder = street_date ? street_date > today : true;
  } else if (street_date) {
    is_preorder = street_date > today;
  }

  return { street_date, is_preorder };
}
