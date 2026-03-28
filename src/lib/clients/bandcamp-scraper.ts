import he from "he";
import { z } from "zod";

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
    .normalize("NFD")                 // decompose é → e + combining accent
    .replace(/[\u0300-\u036f]/g, "")  // strip combining diacritics
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  if (!slug) return null;
  return `https://${subdomain}.bandcamp.com/album/${slug}`;
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

const packageArtSchema = z.object({
  image_id: z.number().nullish(),
});

const tralbumDataSchema = z.object({
  art_id:            z.number().nullish(),
  is_preorder:       z.boolean().nullish(),
  album_is_preorder: z.boolean().nullish(),
  current: z
    .object({
      title:        z.string().nullish(),
      release_date: z.string().nullish(),
      art_id:       z.number().nullish(),
    })
    .nullish(),
  packages: z
    .array(
      z.object({
        type_name:    z.string().nullish(),
        type_id:      z.number().nullish(),     // 1=CD, 3=Cassette, 15=2xLP — confirmed present
        title:        z.string().nullish(),
        sku:          z.string().nullish(),     // matches warehouse variant SKU
        release_date: z.string().nullish(),     // package ship date (may differ from album)
        new_date:     z.string().nullish(),     // legacy — fall back if release_date absent
        image_id:     z.number().nullish(),     // ALWAYS NULL on real pages — use arts[0]
        arts:         z.array(packageArtSchema).nullish(),  // real image source
      }),
    )
    .nullish(),
});

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
  releaseDate: Date | null;    // parsed from release_date or new_date GMT string
  imageId: number | null;      // arts[0].image_id (pkg.image_id is always NULL)
  imageUrl: string | null;     // 1200px image from arts[0]
  arts: ScrapedPackageImage[]; // all arts entries (typically 4 per package)
}

export interface ScrapedAlbumData {
  releaseDate: Date | null;    // from current.release_date
  isPreorder: boolean;         // from is_preorder || album_is_preorder
  artId: number | null;        // top-level album art_id
  albumArtUrl: string | null;  // 1200px from https://f4.bcbits.com/img/a{art_id}_10.jpg
  title: string | null;
  packages: ScrapedPackage[];
  metadataIncomplete: boolean; // true when release_date or packages absent
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
export function bandcampMerchImageUrl(imageId: number | null | undefined, size = 10): string | null {
  if (imageId == null) return null;
  return `https://f4.bcbits.com/img/${imageId}_${size}.jpg`;
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
  const response = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      Accept: "text/html,application/xhtml+xml",
    },
  });

  if (!response.ok) {
    throw new BandcampFetchError(
      `Failed to fetch album page: ${response.status}`,
      response.status,
      url,
    );
  }

  return response.text();
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
      typeName:    pkg.type_name ?? null,
      typeId:      pkg.type_id ?? null,
      title:       pkg.title ?? null,
      sku:         pkg.sku ?? null,
      releaseDate: parseGMTDate(pkg.release_date ?? pkg.new_date ?? null),
      imageId:     primaryImageId,
      imageUrl:    bandcampMerchImageUrl(primaryImageId),
      arts,
    };
  });

  const metadataIncomplete = !releaseDate || packages.length === 0;

  return {
    releaseDate,
    isPreorder,
    artId,
    albumArtUrl: bandcampAlbumArtUrl(artId),
    title: data.current?.title ?? null,
    packages,
    metadataIncomplete,
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
  };
  return {
    ...base,
    parserVersion: "v1" as const,
    typeName: base.packages[0]?.typeName ?? "Merch",
    raw: null,
  };
}
