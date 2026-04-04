/**
 * Bandcamp Discover API client (undocumented public endpoints).
 *
 * dig_deeper: trending albums by genre for the Trending tab.
 * These are NOT part of the official Bandcamp OAuth API.
 */

export interface DigDeeperItem {
  tralbum_type: string;
  tralbum_id: number;
  item_id: number;
  title: string;
  artist: string;
  band_name: string;
  band_id: number;
  subdomain: string;
  genre: string;
  genre_id: number;
  tralbum_url: string;
  band_url: string;
  art_id: number;
  slug_text: string;
  is_preorder: boolean | null;
  num_comments: number;
  featured_track_title: string | null;
  featured_track_number: number | null;
  audio_url: { "mp3-128"?: string } | null;
  packages: Array<{
    id: number;
    price: { amount: number; currency: string };
    type_str: string;
    is_vinyl: boolean;
    image?: { id: number; width: number; height: number };
  }>;
  custom_domain: string | null;
}

export interface DigDeeperResponse {
  ok: boolean;
  items: DigDeeperItem[];
  more_available: boolean;
  discover_spec: {
    tag_name: string;
    tag_pretty_name: string;
    tag_id: number;
    genre_id: number;
    format: string;
  };
}

export async function fetchDigDeeper(
  tags: string[],
  options?: {
    format?: "all" | "digital" | "vinyl" | "cd" | "cassette";
    sort?: "pop" | "new" | "rec" | "surprise" | "top";
    page?: number;
  },
): Promise<DigDeeperResponse | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch("https://bandcamp.com/api/hub/2/dig_deeper", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        filters: {
          tags,
          format: options?.format ?? "all",
          sort: options?.sort ?? "pop",
          location: 0,
        },
        page: options?.page ?? 1,
      }),
    });
    if (!res.ok) return null;
    return (await res.json()) as DigDeeperResponse;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

export function bandcampArtUrl(artId: number, size: 2 | 5 | 10 = 2): string {
  return `https://f4.bcbits.com/img/a${artId}_${size}.jpg`;
}
