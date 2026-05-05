/**
 * Autonomous SKU matcher — music-variant descriptor parser.
 *
 * Plan: autonomous_sku_matching_da557209.plan.md
 *       §"Music-specific descriptor parsing" + §"Proposed generator"
 *       in "remote_fingerprint generation".
 *
 * Parses the structured fields a music catalog row exposes (title + variant
 * options) into a typed AST of `{ format, size, color, pressing, edition,
 * catalogId, variantOptions }`. The AST is used in two call sites:
 *
 *   1. `buildRemoteFingerprint()` (remote-fingerprint.ts) — the AST is the
 *      *only* title-derived input that ever enters a fingerprint hash, so
 *      that fingerprints are stable across punctuation variants (`"7\""`
 *      vs `"7 inch"` vs `7" single`) WITHOUT collapsing `"7"` and `"12"`
 *      into the same bucket.
 *   2. `rankSkuCandidates()` variant-gate (Phase 2+) — format / color /
 *      edition / bundle / preorder descriptors drive the hard
 *      disqualifiers in `CandidateEvidence.variant`.
 *
 * Contract:
 *   * PURE. No I/O, no Date.now(), no random, no Supabase. Same input →
 *     same output forever. Required for the fingerprint stability guarantee
 *     (release gate SKU-AUTO-25).
 *   * Case-insensitive on inputs; lower-cased strings on outputs.
 *   * `size` preserves the numeric value (`"7in"`, `"10in"`, `"12in"`) so
 *     `7"` vinyl cannot be confused with `12"` vinyl through normalization.
 *   * Everything unrecognised falls through as `format: "unknown"` rather
 *     than guessing; the variant gate in Phase 2+ treats `unknown` as
 *     "insufficient evidence", not as a wildcard match.
 *
 * Non-goals:
 *   * This is NOT a general-purpose title parser. It does not extract
 *     artist, album, catalog number, or release year. Those belong to
 *     whichever catalog ingestion adapter is specific to the store.
 *   * It does not do fuzzy string matching. Either a pattern matches or
 *     the field is absent.
 *
 * Tested by: `tests/unit/lib/server/music-variant-descriptors.test.ts`.
 */

export type MusicFormat =
  | "lp"
  | "7inch"
  | "12inch"
  | "10inch"
  | "cassette"
  | "cd"
  | "digital"
  | "shirt"
  | "hoodie"
  | "other"
  | "unknown";

export type MusicVariantDescriptors = {
  format: MusicFormat;
  size: string | null;
  color: string | null;
  pressing: string | null;
  edition: string | null;
  catalogId: string | null;
  signed: boolean;
  bundle: boolean;
  preorder: boolean;
  variantOptions: Array<{ name: string; value: string }>;
};

export interface MusicVariantDescriptorInput {
  title?: string | null;
  variantOptions?: Array<{ name?: string | null; value?: string | null }> | null;
}

/**
 * Canonical option-name buckets used by `inferOptionName()` in
 * `bandcamp-apparel.ts`. Kept in sync so the descriptor parser and the
 * apparel detector agree on which option name maps to which semantic slot.
 */
const OPTION_NAME_COLOR_TOKENS = new Set([
  "color",
  "colour",
  "vinyl color",
  "vinyl colour",
  "variant",
  "pressing",
]);

const OPTION_NAME_EDITION_TOKENS = new Set(["edition", "version", "release"]);

const OPTION_NAME_SIZE_TOKENS = new Set(["size"]);

const OPTION_NAME_FORMAT_TOKENS = new Set(["format", "media", "type"]);

/**
 * The format regex table is intentionally ordered; earlier entries win so
 * that `"LP"` does not swallow `"7"` etc. Tests pin the ordering.
 */
const FORMAT_PATTERNS: Array<{ re: RegExp; format: MusicFormat; size?: string }> = [
  // 7" / 7-inch / 7 inch single
  { re: /(^|[^0-9])7\s*["”]\s*/i, format: "7inch", size: "7in" },
  { re: /(^|[^0-9])7[\s-]*in(?:ch|\.)?(?![0-9a-z])/i, format: "7inch", size: "7in" },
  // 10"
  { re: /(^|[^0-9])10\s*["”]\s*/i, format: "10inch", size: "10in" },
  { re: /(^|[^0-9])10[\s-]*in(?:ch|\.)?(?![0-9a-z])/i, format: "10inch", size: "10in" },
  // 12"
  { re: /(^|[^0-9])12\s*["”]\s*/i, format: "12inch", size: "12in" },
  { re: /(^|[^0-9])12[\s-]*in(?:ch|\.)?(?![0-9a-z])/i, format: "12inch", size: "12in" },
  // Cassette / tape
  { re: /\bcassette\b/i, format: "cassette" },
  { re: /\bcs\b/i, format: "cassette" },
  { re: /\btape\b/i, format: "cassette" },
  // CD / compact disc
  { re: /\bcd\b/i, format: "cd" },
  { re: /\bcompact\s+disc\b/i, format: "cd" },
  // Digital download / FLAC / WAV / MP3
  { re: /\bdigital(\s+download)?\b/i, format: "digital" },
  { re: /\b(flac|wav|mp3)\b/i, format: "digital" },
  // LP / vinyl (after the sized vinyl checks above so 7"/10"/12" win)
  { re: /\blp\b/i, format: "lp" },
  { re: /\bvinyl\b/i, format: "lp" },
  // Apparel
  { re: /\bhoodie\b/i, format: "hoodie" },
  { re: /\bsweatshirt\b/i, format: "hoodie" },
  { re: /\b(t-?shirt|tee)\b/i, format: "shirt" },
];

const SIGNED_RE = /\b(signed|autograph(?:ed)?)\b/i;
const BUNDLE_RE = /\b(bundle|pack|combo|set)\b/i;
const PREORDER_RE = /\b(pre-?order|pre-?sale)\b/i;

const EDITION_RE =
  /\b(limited|standard|deluxe|deluxe\s+edition|special\s+edition|collector(?:'s)?|anniversary|numbered|test\s+press|promo)\b/i;

/**
 * Intentionally narrow color vocabulary. Expanding here without a fixture
 * update will silently change fingerprints, so new colors must ship with a
 * test that asserts the hash changes in the expected direction.
 */
const COLOR_TOKENS = [
  "black",
  "white",
  "red",
  "blue",
  "green",
  "yellow",
  "orange",
  "purple",
  "pink",
  "gold",
  "silver",
  "clear",
  "cream",
  "brown",
  "grey",
  "gray",
  "transparent",
  "translucent",
  "opaque",
  "marble",
  "marbled",
  "splatter",
  "splattered",
  "swirl",
  "smoke",
  "glow",
  "coke bottle",
  "sea glass",
] as const;

const SIZE_TOKENS = /\b(xxs|xs|s|m|l|xl|xxl|xxxl|3xl|4xl)\b/i;

/**
 * Used only for apparel sizes like "M" / "XL". Separate from vinyl size to
 * avoid the two systems crossing wires.
 */
function parseApparelSize(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const match = value.trim().match(SIZE_TOKENS);
  if (!match) return null;
  return match[1].toUpperCase();
}

function canonicalOptionName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

function matchColor(text: string): string | null {
  const haystack = text.toLowerCase();
  // Slash-joined color pairs like "red/black splatter" are captured as a
  // distinct canonical value FIRST so "red/black" is not silently won by
  // whichever single-token color appears later in COLOR_TOKENS. Fingerprint
  // fixtures treat pair values as distinct from either single token.
  const pairMatch = haystack.match(/\b([a-z]+\/[a-z]+(?:\s+splatter|\s+swirl|\s+marble)?)\b/i);
  if (pairMatch) return pairMatch[1];
  // Prefer multi-token color phrases next so "coke bottle" doesn't lose
  // to a bare "coke".
  const multi = COLOR_TOKENS.filter((c) => c.includes(" "));
  for (const token of multi) {
    if (haystack.includes(token)) return token;
  }
  for (const token of COLOR_TOKENS) {
    if (token.includes(" ")) continue;
    const pattern = new RegExp(`\\b${token}\\b`, "i");
    if (pattern.test(haystack)) return token;
  }
  return null;
}

function detectFormat(text: string): { format: MusicFormat; size: string | null } {
  for (const p of FORMAT_PATTERNS) {
    if (p.re.test(text)) return { format: p.format, size: p.size ?? null };
  }
  return { format: "unknown", size: null };
}

function sanitizeVariantOptions(
  options: MusicVariantDescriptorInput["variantOptions"],
): Array<{ name: string; value: string }> {
  if (!Array.isArray(options)) return [];
  const out: Array<{ name: string; value: string }> = [];
  for (const o of options) {
    if (!o || typeof o !== "object") continue;
    const name = typeof o.name === "string" ? o.name.trim() : "";
    const value = typeof o.value === "string" ? o.value.trim() : "";
    if (!name || !value) continue;
    out.push({ name, value });
  }
  return out;
}

/**
 * Parse a remote listing's title + variant options into a typed descriptor
 * AST. Returns deterministic, structurally-sorted output suitable as input
 * to `buildRemoteFingerprint()` or the variant gate.
 */
export function parseMusicVariantDescriptors(
  input: MusicVariantDescriptorInput,
): MusicVariantDescriptors {
  const title = typeof input.title === "string" ? input.title : "";
  const options = sanitizeVariantOptions(input.variantOptions);

  // Pass 1: read structured variant-option slots first. They are higher
  // signal than the free-form title because shopkeepers typed them in
  // deliberately.
  let optionFormat: MusicFormat | null = null;
  let optionSize: string | null = null;
  let optionColor: string | null = null;
  let optionEdition: string | null = null;

  for (const opt of options) {
    const canonical = canonicalOptionName(opt.name);
    if (OPTION_NAME_FORMAT_TOKENS.has(canonical)) {
      const parsed = detectFormat(opt.value);
      if (parsed.format !== "unknown") {
        optionFormat = parsed.format;
        if (parsed.size) optionSize = parsed.size;
      }
    } else if (OPTION_NAME_SIZE_TOKENS.has(canonical)) {
      const apparel = parseApparelSize(opt.value);
      if (apparel) optionSize = apparel;
    } else if (OPTION_NAME_COLOR_TOKENS.has(canonical)) {
      optionColor = opt.value.trim().toLowerCase();
    } else if (OPTION_NAME_EDITION_TOKENS.has(canonical)) {
      optionEdition = opt.value.trim().toLowerCase();
    }
  }

  // Pass 2: derive anything still missing from the title. Title is
  // LOWER-priority than explicit variant options, and title-only color is
  // less reliable than option-sourced color (but still recorded so the
  // fingerprint can distinguish, e.g., "Limited Red" vs "Limited Black"
  // when only the title encodes the color).
  const titleFormat = detectFormat(title);
  const titleColor = matchColor(title);
  const titleEdition = title.match(EDITION_RE);

  const format = optionFormat ?? titleFormat.format;
  const size = optionSize ?? titleFormat.size;
  const color = optionColor ?? titleColor ?? null;
  const edition = optionEdition ?? titleEdition?.[1]?.toLowerCase() ?? null;

  // Signed / bundle / preorder are title-only flags for now; no platform
  // exposes them as first-class metadata.
  const signed = SIGNED_RE.test(title);
  const bundle = BUNDLE_RE.test(title);
  const preorder = PREORDER_RE.test(title);

  const catalogIdMatch = title.match(/\b([A-Z]{2,}-?\d{2,})\b/);
  const catalogId = catalogIdMatch ? catalogIdMatch[1].toUpperCase() : null;

  // Sort variantOptions deterministically so downstream fingerprint
  // sorting doesn't have to re-sort.
  const sortedOptions = options
    .map((o) => ({ name: o.name.trim(), value: o.value.trim() }))
    .sort((a, b) => {
      const byName = a.name.localeCompare(b.name);
      return byName !== 0 ? byName : a.value.localeCompare(b.value);
    });

  return {
    format,
    size: size ?? null,
    color: color ? color.trim().toLowerCase() : null,
    pressing: null,
    edition: edition ? edition.trim().toLowerCase() : null,
    catalogId,
    signed,
    bundle,
    preorder,
    variantOptions: sortedOptions,
  };
}
