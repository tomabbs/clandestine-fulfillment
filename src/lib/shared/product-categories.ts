const BUNDLE_PATTERNS = /bundle|combo|\b2.?pack\b|\blp\s*\+\s*/i;
const VINYL_PATTERNS = /vinyl|lp|record|test press|lathe/i;
const CD_PATTERNS = /compact disc|\bcd\b|digipack|digipak/i;
const CASSETTE_PATTERNS = /cassette|tape|\bcs\b/i;
const APPAREL_PATTERNS =
  /t-shirt|shirt|tee|hoodie|sweater|sweatshirt|hat|cap|apparel|longsleeve|long sleeve|crewneck/i;
const MERCH_PATTERNS =
  /bag|tote|poster|print|sticker|pin|patch|button|zine|book|magazine|slipmat|bandana|usb|flash drive/i;

export type ProductCategory =
  | "vinyl"
  | "cd"
  | "cassette"
  | "apparel"
  | "merch"
  | "bundle"
  | "other";

export function classifyProduct(
  typeName: string | null,
  url: string | null,
  title: string | null,
): ProductCategory {
  const tn = (typeName ?? "").normalize("NFKC").toLowerCase();
  const t = (title ?? "").normalize("NFKC").toLowerCase();
  const combined = `${tn} ${t}`;

  if (BUNDLE_PATTERNS.test(combined)) return "bundle";
  if (VINYL_PATTERNS.test(combined)) return "vinyl";
  if (CD_PATTERNS.test(combined)) return "cd";
  if (CASSETTE_PATTERNS.test(combined)) return "cassette";
  if (APPAREL_PATTERNS.test(combined)) return "apparel";
  if (MERCH_PATTERNS.test(combined)) return "merch";

  if (url) {
    try {
      const path = new URL(url).pathname;
      if (path.startsWith("/merch/")) {
        if (APPAREL_PATTERNS.test(combined)) return "apparel";
        return "merch";
      }
      if (path.startsWith("/album/")) return "other";
    } catch {
      // Malformed URL — fall through
    }
  }

  return "other";
}

export const CATEGORY_EXPECTED_FIELDS: Record<
  ProductCategory,
  { about: boolean; credits: boolean; tracks: boolean; art: boolean; tags: boolean }
> = {
  vinyl: { about: true, credits: true, tracks: true, art: true, tags: true },
  cd: { about: true, credits: true, tracks: true, art: true, tags: true },
  cassette: { about: true, credits: true, tracks: true, art: true, tags: true },
  apparel: { about: false, credits: false, tracks: false, art: true, tags: false },
  merch: { about: false, credits: false, tracks: false, art: true, tags: false },
  bundle: { about: true, credits: false, tracks: false, art: true, tags: true },
  other: { about: true, credits: false, tracks: false, art: true, tags: false },
};

export const ALBUM_FORMAT_CATEGORIES: ProductCategory[] = ["vinyl", "cd", "cassette"];
export const NON_ALBUM_CATEGORIES: ProductCategory[] = ["apparel", "merch", "bundle", "other"];
