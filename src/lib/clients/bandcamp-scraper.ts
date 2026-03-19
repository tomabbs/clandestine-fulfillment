import { z } from "zod";

// === Zod schema for parsed TralbumData ===

const packageArtSchema = z.object({
  image_id: z.number().nullish(),
  width: z.number().nullish(),
  height: z.number().nullish(),
});

const tralbumDataSchema = z.object({
  art_id: z.number().nullish(),
  item_type: z.string().nullish(),
  release_date: z.string().nullish(),
  current: z
    .object({
      type: z.string().nullish(),
      release_date: z.string().nullish(),
      title: z.string().nullish(),
    })
    .nullish(),
  packages: z
    .array(
      z.object({
        type_name: z.string().nullish(),
        title: z.string().nullish(),
        new_date: z.string().nullish(),
        url: z.string().nullish(),
        sku: z.string().nullish(),
        image_id: z.number().nullish(),
        arts: z.array(packageArtSchema).nullish(),
      }),
    )
    .nullish(),
});

export type TralbumData = z.infer<typeof tralbumDataSchema>;

export interface ScrapedPackageImage {
  imageId: number;
  url: string;
}

export interface ScrapedAlbumData {
  releaseDate: string | null;
  typeName: string | null;
  title: string | null;
  artId: number | null;
  albumArtUrl: string | null;
  packages: Array<{
    typeName: string | null;
    title: string | null;
    newDate: string | null;
    url: string | null;
    sku: string | null;
    imageId: number | null;
    imageUrl: string | null;
    arts: ScrapedPackageImage[];
  }>;
  raw: TralbumData | null;
  parserVersion: "v1" | "v2";
  metadataIncomplete: boolean;
}

// === Image URL construction ===

/**
 * Construct a 700px Bandcamp image URL from an art_id.
 * Album art uses the "a" prefix: https://f4.bcbits.com/img/a{art_id}_10.jpg
 */
export function bandcampAlbumArtUrl(artId: number | null | undefined): string | null {
  if (artId == null) return null;
  return `https://f4.bcbits.com/img/a${artId}_10.jpg`;
}

/**
 * Construct a 700px Bandcamp image URL from a package/merch image_id.
 * Merch images omit the "a" prefix: https://f4.bcbits.com/img/{image_id}_10.jpg
 */
export function bandcampMerchImageUrl(imageId: number | null | undefined): string | null {
  if (imageId == null) return null;
  return `https://f4.bcbits.com/img/${imageId}_10.jpg`;
}

// === HTML fetching ===

export async function fetchAlbumPage(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      Accept: "text/html,application/xhtml+xml",
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch album page ${url}: ${response.status}`);
  }

  return response.text();
}

// === V1 parser: data-tralbum attribute on <script> tag ===

export function parseV1(html: string): TralbumData | null {
  // V1: TralbumData is embedded as a data-tralbum attribute on a script or div element
  const attrMatch = html.match(/data-tralbum="([^"]*)"/);
  if (!attrMatch) return null;

  try {
    const decoded = attrMatch[1]
      .replace(/&quot;/g, '"')
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&#39;/g, "'");
    const parsed = JSON.parse(decoded);
    return tralbumDataSchema.parse(parsed);
  } catch {
    return null;
  }
}

// === V2 parser: TralbumData in inline <script> var assignment ===

export function parseV2(html: string): TralbumData | null {
  // V2: var TralbumData = { ... }; in an inline script
  const scriptMatch = html.match(/var\s+TralbumData\s*=\s*(\{[\s\S]*?\});\s*(?:\n|var\s)/);
  if (!scriptMatch) return null;

  try {
    const parsed = JSON.parse(scriptMatch[1]);
    return tralbumDataSchema.parse(parsed);
  } catch {
    return null;
  }
}

// === Version heuristic (Rule #25) ===

function selectParser(html: string): "v1" | "v2" {
  // If the page has data-tralbum attribute, prefer V1
  if (html.includes("data-tralbum=")) return "v1";
  // If the page has inline TralbumData var, use V2
  if (html.includes("var TralbumData")) return "v2";
  // Default to V2 as a fallback (newer pages)
  return "v2";
}

// === Main parser (Rule #24: never crash, default gracefully) ===

export function parseTralbumData(html: string): ScrapedAlbumData {
  const version = selectParser(html);
  const parser = version === "v1" ? parseV1 : parseV2;
  const data = parser(html);

  if (!data) {
    // Rule #24: On parse failure, default type to "Merch", leave street_date blank
    return {
      releaseDate: null,
      typeName: "Merch",
      title: null,
      artId: null,
      albumArtUrl: null,
      packages: [],
      raw: null,
      parserVersion: version,
      metadataIncomplete: true,
    };
  }

  const releaseDate = data.current?.release_date ?? data.release_date ?? null;
  const typeName = data.current?.type ?? data.item_type ?? null;
  const title = data.current?.title ?? null;
  const artId = data.art_id ?? null;

  const packages = (data.packages ?? []).map((pkg) => ({
    typeName: pkg.type_name ?? null,
    title: pkg.title ?? null,
    newDate: pkg.new_date ?? null,
    url: pkg.url ?? null,
    sku: pkg.sku ?? null,
    imageId: pkg.image_id ?? null,
    imageUrl: bandcampMerchImageUrl(pkg.image_id),
    arts: (pkg.arts ?? [])
      .filter((a) => a.image_id != null)
      .map((a) => ({
        imageId: a.image_id as number,
        url: bandcampMerchImageUrl(a.image_id) as string,
      })),
  }));

  const metadataIncomplete = !typeName || !releaseDate;

  return {
    releaseDate,
    typeName: typeName || "Merch",
    title,
    artId,
    albumArtUrl: bandcampAlbumArtUrl(artId),
    packages,
    raw: data,
    parserVersion: version,
    metadataIncomplete,
  };
}
