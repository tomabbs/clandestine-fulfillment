import he from "he";
import { z } from "zod";
import { normalizeTag } from "@/lib/shared/genre-taxonomy";

// ─── URL construction helper ──────────────────────────────────────────────────
// Exported here so bandcamp-sync.ts imports it and unit tests validate the real
// implementation (not a local copy).
//
// Step 0 confirmed: "Birds & Beasts" → "birds-beasts" → live Bandcamp page. ✓
// NFD normalization handles accented Latin chars (é → e) without external deps.
// Non-ASCII slugs that can't be normalized will 404 and get logged to the
// review queue — intentional, expected behavior.

export function buildBandcampAlbumUrl(subdomain: string, albumTitle: string): string | null {
  const trimmed = albumTitle.trim();
  if (!trimmed) return null;
  const slug = trimmed
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  if (!slug) return null;
  return `https://${subdomain}.bandcamp.com/album/${slug}`;
}

const FORMAT_PATTERNS = [
  /\b\d*x?LP\b/i,
  /\bCD\b/i,
  /\bCassette\b/i,
  /\bTape\b/i,
  /\bVinyl\b/i,
  /\b(?:7|10|12)\s*[""\u201C\u201D\u2033']?\s*(?:inch)?\b/i,
  /\bBox\s*Set\b/i,
  /\bPicture\s*Disc\b/i,
  /\bFlexi\b/i,
  /\bSACD\b/i,
  /\bDVD\b/i,
  /\bBlu-?ray\b/i,
  /\bDigipak\b/i,
  /\bDigipack\b/i,
  /\bDigisleeve\b/i,
  /\bGatefold\b/i,
  /\bJewel\s*Case\b/i,
  /\bSlipcase\b/i,
  /\bCompact\s*Disc\b/i,
  /\bLimited\s*Edition\b/i,
  /\bStandard\s*Edition\b/i,
  /\bDeluxe\s*Edition\b/i,
  /\bDeluxe\b/i,
  /\bLTD\b/i,
  /\bColou?red\b/i,
  /\bSplatter\b/i,
  /\bReissue\b/i,
  /\bSplit\b/i,
  /\bTriple\b/i,
  /\bDouble\b/i,
  /\bSingle\b/i,
  /\bw\/\s*Alt\.?\s*Artwork\b/i,
  /\bAlt\.?\s*Artwork\b/i,
  /\bTranslucent\b/i,
  /\bBlack\s*Variant\b/i,
  /\bNatural\b.*\bSplatter\b/i,
  /\bin\s+(Digipack|Digisleeve|Digipak|Jacket|Gatefold)\b/i,
];

const MERCH_PATTERNS = [
  /\bT-?Shirt\b/i,
  /\bTee\b/i,
  /\bHoodie\b/i,
  /\bHat\b/i,
  /\bCap\b/i,
  /\bPoster\b/i,
  /\bSticker\b/i,
  /\bTote\b/i,
  /\bPatch\b/i,
  /\bPin\b/i,
  /\bMug\b/i,
  /\bBundle\b/i,
  /\bSlipmat\b/i,
  /\bFlag\b/i,
  /\bBag\b/i,
  /\bAlbum\s*Cover\s*T\b/i,
  /\s+T$/,
];

/**
 * Extract a plausible album title from a warehouse product title.
 * Product titles follow patterns like:
 *   "Artist Name - Album Title Format" (e.g. "Horse Lords - Interventions CD")
 *   "Album Title - Format Description" (e.g. "Interventions - Limited Edition 12\"")
 *   "Format Description" alone (e.g. "CD in Digipack") — returns null
 *   Merch items (e.g. "Band T-Shirt") — returns null
 *
 * Returns the cleaned album title or null if the title is pure format/merch.
 */
export function extractAlbumTitle(productTitle: string): string | null {
  const raw = productTitle.trim();
  if (!raw) return null;

  // Reject pure merch items — no album page exists
  if (MERCH_PATTERNS.some((p) => p.test(raw))) return null;

  // Reject PACKAGE bundle listings — no single album page
  if (/PACKAGE\s*:/i.test(raw)) return null;

  const parts = raw
    .split(" - ")
    .map((s) => s.trim())
    .filter(Boolean);

  // Try to extract a clean album title from each candidate
  function stripFormats(text: string): string | null {
    let cleaned = text;
    for (const pat of FORMAT_PATTERNS) {
      cleaned = cleaned.replace(new RegExp(pat, "gi"), "");
    }
    cleaned = cleaned
      .replace(/\(.*\)/g, "")
      .replace(/[.\s]+$/g, "")
      .replace(/^\s+/g, "")
      .trim();

    // Strip stray prepositions/articles and dangling quotes
    cleaned = cleaned.replace(/^(in|on|with|w\/|&)\s+/i, "").trim();
    cleaned = cleaned.replace(/\s+(in|on|with|w\/)$/i, "").trim();
    cleaned = cleaned.replace(/\s*[""\u201C\u201D\u2033']+\s*$/g, "").trim();
    // Strip leading punctuation residue
    cleaned = cleaned.replace(/^[&:,\-\s]+/, "").trim();

    if (!cleaned || cleaned.length < 3) return null;
    if (/^[\d\u201C\u201D\u2033""'"\s.\-!?&]+$/.test(cleaned)) return null;
    if (
      /^(Standard|Double|Single|Special|Original|Limited|Triple|Alt|Split|Reissue)?\s*(Black|White|Clear|Red|Blue|Green|Orange|Pink|Natural|Colored|Colou?red)?\s*[""\u201C\u201D\u2033']?\s*$/i.test(
        cleaned,
      )
    )
      return null;
    // Reject residue that's still just packaging/bundle descriptors
    if (/^(Artwork|Art\s*Print|Sleeve|Jacket|Insert|Booklet|Batch|Series|Sigil)\s*$/i.test(cleaned))
      return null;
    if (/^\d+\s*(CD|LP)$/i.test(cleaned)) return null;
    // Reject PACKAGE: prefixed bundle items
    if (/^PACKAGE\s*:/i.test(cleaned)) return null;
    // Reject if it's mostly uppercase noise with numbers (e.g. "WITH 16 COLORFUL INSERTS")
    if (/^WITH\s+\d/i.test(cleaned)) return null;
    return cleaned;
  }

  if (parts.length === 1) {
    return stripFormats(parts[0]);
  }

  // Multi-part: "Artist - Title Format" or "Title - Format Description"
  // Strategy: try the LAST non-format segment first (most likely the album title),
  // then fall back to the first segment (when the rest is pure format)
  const afterFirst = parts.slice(1).join(" - ");
  const candidateAfter = stripFormats(afterFirst);
  if (candidateAfter) return candidateAfter;

  // The part(s) after the first dash were all format noise — try the first segment as album
  const candidateFirst = stripFormats(parts[0]);
  return candidateFirst;
}

// ─── Typed fetch error ────────────────────────────────────────────────────────
// Carries HTTP status so callers can do `err instanceof BandcampFetchError &&
// err.status === 404` instead of `String(err).includes("404")`, which misfires
// on proxy errors or any message that happens to contain "404".

export class BandcampFetchError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly url: string,
    public readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "BandcampFetchError";
  }
}

// ─── Zod schema for data-tralbum JSON ────────────────────────────────────────
// Targets the data-tralbum HTML attribute — stable for 7-10 years (powers
// Bandcamp's player, embeds, and purchase flow).
//
// Step 0 audit (2026-03-29) confirmed:
// - pkg.image_id is ALWAYS NULL on real pages
// - pkg.arts[0].image_id is the real primary image source (4 arts per package typical)
// - packages[].sku matches warehouse SKUs (e.g. LP-NS-167, CD-NS-167)
// - packages[].type_id is present (1=CD, 3=Cassette, 15=2xLP)

const packageArtSchema = z
  .object({
    image_id: z.number().nullish(),
  })
  .passthrough();

const tralbumDataSchema = z
  .object({
    art_id: z.number().nullish(),
    is_preorder: z.boolean().nullish(),
    album_is_preorder: z.boolean().nullish(),
    current: z
      .object({
        title: z.string().nullish(),
        release_date: z.string().nullish(),
        art_id: z.number().nullish(),
        about: z.string().nullish(),
        credits: z.string().nullish(),
        upc: z.string().nullish(),
      })
      .passthrough()
      .nullish(),
    packages: z
      .array(
        z
          .object({
            type_name: z.string().nullish(),
            type_id: z.number().nullish(),
            title: z.string().nullish(),
            sku: z.string().nullish(),
            release_date: z.string().nullish(),
            new_date: z.string().nullish(),
            image_id: z.number().nullish(),
            arts: z.array(packageArtSchema).nullish(),
          })
          .passthrough(),
      )
      .nullish(),
    trackinfo: z
      .array(
        z
          .object({
            track_num: z.number().nullish(),
            title: z.string().nullish(),
            duration: z.number().nullish(),
          })
          .passthrough(),
      )
      .nullish(),
  })
  .passthrough();

export type TralbumData = z.infer<typeof tralbumDataSchema>;

// ─── Output types ─────────────────────────────────────────────────────────────

export interface ScrapedPackageImage {
  imageId: number;
  url: string;
}

export interface ScrapedPackage {
  typeName: string | null;
  typeId: number | null;
  title: string | null;
  sku: string | null;
  releaseDate: Date | null; // parsed from release_date or new_date GMT string
  imageId: number | null; // arts[0].image_id (pkg.image_id is always NULL)
  imageUrl: string | null; // 1200px image from arts[0]
  arts: ScrapedPackageImage[]; // all arts entries (typically 4 per package)
}

export interface ScrapedTrack {
  trackNum: number;
  title: string;
  durationSec: number; // raw float seconds from Bandcamp
  durationFormatted: string; // "M:SS" display string
}

export interface ScrapedAlbumData {
  releaseDate: Date | null; // from current.release_date
  isPreorder: boolean; // from is_preorder || album_is_preorder
  artId: number | null; // top-level album art_id
  albumArtUrl: string | null; // 1200px from https://f4.bcbits.com/img/a{art_id}_10.jpg
  title: string | null;
  packages: ScrapedPackage[];
  metadataIncomplete: boolean; // true when release_date or packages absent
  about: string | null;
  credits: string | null;
  upc: string | null;
  tracks: ScrapedTrack[];
  tralbumId: number | null; // album ID from data-tralbum.id (NOT package_id)
  tags: string[]; // display names from <a class="tag"> HTML elements
  tagNorms: string[]; // normalized keys for matching (lowercase, hyphenated)
}

// ─── Image URL construction ───────────────────────────────────────────────────

/**
 * Album art URL (uses "a" prefix): https://f4.bcbits.com/img/a{art_id}_{size}.jpg
 * Sizes: 10=1200px, 5=700px, 2=350px. Default 10 (highest quality).
 */
export function bandcampAlbumArtUrl(artId: number | null | undefined, size = 10): string | null {
  if (artId == null) return null;
  return `https://f4.bcbits.com/img/a${artId}_${size}.jpg`;
}

/**
 * Package/merch image URL (no "a" prefix): https://f4.bcbits.com/img/{image_id}_{size}.jpg
 * Source: pkg.arts[].image_id (NOT pkg.image_id — confirmed always NULL on real pages).
 */
export function bandcampMerchImageUrl(
  imageId: number | null | undefined,
  size = 10,
): string | null {
  if (imageId == null) return null;
  return `https://f4.bcbits.com/img/${imageId}_${size}.jpg`;
}

// ─── Track duration formatting ────────────────────────────────────────────────
// Bandcamp returns duration as a float in seconds (e.g. 345.621).
// Convert to "M:SS" display format (e.g. "5:45").

function formatDuration(seconds: number): string {
  const totalSec = Math.round(seconds);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

// ─── GMT date parsing ─────────────────────────────────────────────────────────
// Bandcamp format: "20 Mar 2026 00:00:00 GMT" — JS Date handles this natively.

function parseGMTDate(dateStr: string | null | undefined): Date | null {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  return Number.isNaN(d.getTime()) ? null : d;
}

// ─── HTML fetching ────────────────────────────────────────────────────────────

export async function fetchBandcampPage(url: string): Promise<string> {
  // 15-second timeout — prevents hung tasks from locking the scrape queue.
  // Without this, a slow/unresponsive Bandcamp server holds the task open
  // for the full maxDuration (300s global), blocking all 3 queue slots.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml",
      },
    });

    if (!response.ok) {
      let retryAfter: number | undefined;
      if (response.status === 429) {
        const ra = response.headers.get("retry-after");
        if (ra) {
          const parsed = Number(ra);
          retryAfter = Number.isFinite(parsed) ? parsed : undefined;
        }
      }
      throw new BandcampFetchError(
        `Failed to fetch album page: ${response.status}`,
        response.status,
        url,
        retryAfter,
      );
    }

    return response.text();
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      // Timeout — treat as a transient HTTP error so the catch block routes it correctly
      throw new BandcampFetchError(`Fetch timeout after 15s: ${url}`, 408, url);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

// ─── Main parser ──────────────────────────────────────────────────────────────
// Uses `he` for robust HTML entity decoding (replaces fragile manual .replace chain).

export function parseBandcampPage(html: string): ScrapedAlbumData | null {
  const attrMatch = html.match(/data-tralbum="([^"]+)"/);
  if (!attrMatch) return null;

  let data: TralbumData;
  try {
    const decoded = he.decode(attrMatch[1]);
    data = tralbumDataSchema.parse(JSON.parse(decoded));
  } catch {
    return null;
  }

  const artId = data.art_id ?? data.current?.art_id ?? null;
  const releaseDate = parseGMTDate(data.current?.release_date ?? null);
  const isPreorder = data.is_preorder === true || data.album_is_preorder === true;

  const packages: ScrapedPackage[] = (data.packages ?? []).map((pkg) => {
    const arts: ScrapedPackageImage[] = (pkg.arts ?? [])
      .filter((a) => a.image_id != null)
      .map((a) => ({
        imageId: a.image_id as number,
        url: bandcampMerchImageUrl(a.image_id) as string,
      }));

    // CRITICAL: pkg.image_id is ALWAYS NULL on real pages (confirmed Step 0).
    // Primary image comes from arts[0].image_id.
    const primaryImageId = arts[0]?.imageId ?? null;

    return {
      typeName: pkg.type_name ?? null,
      typeId: pkg.type_id ?? null,
      title: pkg.title ?? null,
      sku: pkg.sku ?? null,
      releaseDate: parseGMTDate(pkg.release_date ?? pkg.new_date ?? null),
      imageId: primaryImageId,
      imageUrl: bandcampMerchImageUrl(primaryImageId),
      arts,
    };
  });

  const metadataIncomplete = !releaseDate || packages.length === 0;

  const tracks: ScrapedTrack[] = (data.trackinfo ?? [])
    .filter((t) => t.title != null && t.duration != null)
    .map((t) => ({
      trackNum: t.track_num ?? 0,
      title: t.title as string,
      durationSec: t.duration as number,
      durationFormatted: formatDuration(t.duration as number),
    }))
    .sort((a, b) => a.trackNum - b.trackNum);

  // Extract tralbum_id from data-tralbum.id (the real album ID, NOT package_id)
  const tralbumId =
    typeof (data as Record<string, unknown>).id === "number"
      ? ((data as Record<string, unknown>).id as number)
      : null;

  // Extract genre tags from <a class="tag"> HTML elements (NOT from data-tralbum which lacks tags)
  let tags: string[] = [];
  let tagNorms: string[] = [];
  try {
    const tagMatches = html.match(/<a class="tag"[^>]*>([^<]+)<\/a>/g);
    tags = (tagMatches ?? []).map((t) => t.replace(/<[^>]+>/g, "").trim()).filter(Boolean);
    tagNorms = Array.from(new Set(tags.map(normalizeTag).filter(Boolean)));
  } catch {
    // Tag extraction is non-critical; continue without tags
  }

  return {
    releaseDate,
    isPreorder,
    artId,
    albumArtUrl: bandcampAlbumArtUrl(artId),
    title: data.current?.title ?? null,
    packages,
    metadataIncomplete,
    about: data.current?.about?.trim() ?? null,
    credits: data.current?.credits?.trim() ?? null,
    upc: data.current?.upc?.trim() ?? null,
    tracks,
    tralbumId,
    tags,
    tagNorms,
  };
}

// ─── Legacy compatibility exports ─────────────────────────────────────────────
// Keep old function names working so existing code doesn't break during migration.
// bandcamp-sync.ts will be updated to use parseBandcampPage directly.

/** @deprecated Use fetchBandcampPage instead */
export const fetchAlbumPage = fetchBandcampPage;

/** @deprecated Use parseBandcampPage instead */
export function parseTralbumData(html: string): ScrapedAlbumData & {
  parserVersion: "v1" | "v2";
  typeName: string;
  raw: null;
} {
  const result = parseBandcampPage(html);
  const base = result ?? {
    releaseDate: null,
    isPreorder: false,
    artId: null,
    albumArtUrl: null,
    title: null,
    packages: [],
    metadataIncomplete: true,
    about: null,
    credits: null,
    upc: null,
    tracks: [],
    tralbumId: null,
    tags: [],
    tagNorms: [],
  };
  return {
    ...base,
    parserVersion: "v1" as const,
    typeName: base.packages[0]?.typeName ?? "Merch",
    raw: null,
  };
}
