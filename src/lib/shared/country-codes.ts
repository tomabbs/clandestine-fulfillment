/**
 * Phase 0.5.7 — ISO 3166-1 alpha-2 country code normalization.
 *
 * Bandcamp + Shopify + manual orders use a mix of country code formats
 * ("US", "USA", "United States", "U.S.A."). EasyPost requires alpha-2
 * ("US", "GB"). Without normalization, an order with country="UK" silently
 * routes as if it were domestic-style and EP either fails or quotes wrong rates.
 *
 * normalizeCountryCode() is intentionally permissive on the input side and
 * strict on the output side — it returns either a valid alpha-2 code or null
 * (caller decides default fallback).
 */

const ALIASES: Record<string, string> = {
  // United States variants
  US: "US",
  USA: "US",
  "U.S.A": "US",
  "U.S.A.": "US",
  "U.S.": "US",
  "UNITED STATES": "US",
  "UNITED STATES OF AMERICA": "US",
  AMERICA: "US",

  // United Kingdom variants
  UK: "GB",
  GB: "GB",
  "GREAT BRITAIN": "GB",
  ENGLAND: "GB",
  SCOTLAND: "GB",
  WALES: "GB",
  "NORTHERN IRELAND": "GB",
  "UNITED KINGDOM": "GB",
  "UNITED KINGDOM OF GREAT BRITAIN AND NORTHERN IRELAND": "GB",
  BRITAIN: "GB",

  // Canada
  CA: "CA",
  CAN: "CA",
  CANADA: "CA",

  // Australia
  AU: "AU",
  AUS: "AU",
  AUSTRALIA: "AU",

  // New Zealand
  NZ: "NZ",
  NZL: "NZ",
  "NEW ZEALAND": "NZ",

  // Germany
  DE: "DE",
  DEU: "DE",
  GERMANY: "DE",
  DEUTSCHLAND: "DE",

  // France
  FR: "FR",
  FRA: "FR",
  FRANCE: "FR",

  // Italy
  IT: "IT",
  ITA: "IT",
  ITALY: "IT",
  ITALIA: "IT",

  // Spain
  ES: "ES",
  ESP: "ES",
  SPAIN: "ES",
  ESPANA: "ES",
  "ESPAÑA": "ES",

  // Netherlands
  NL: "NL",
  NLD: "NL",
  NETHERLANDS: "NL",
  "THE NETHERLANDS": "NL",
  HOLLAND: "NL",

  // Belgium
  BE: "BE",
  BEL: "BE",
  BELGIUM: "BE",

  // Sweden
  SE: "SE",
  SWE: "SE",
  SWEDEN: "SE",

  // Norway
  NO: "NO",
  NOR: "NO",
  NORWAY: "NO",

  // Denmark
  DK: "DK",
  DNK: "DK",
  DENMARK: "DK",

  // Finland
  FI: "FI",
  FIN: "FI",
  FINLAND: "FI",

  // Ireland
  IE: "IE",
  IRL: "IE",
  IRELAND: "IE",

  // Japan
  JP: "JP",
  JPN: "JP",
  JAPAN: "JP",

  // Mexico
  MX: "MX",
  MEX: "MX",
  MEXICO: "MX",
  "MÉXICO": "MX",

  // Brazil
  BR: "BR",
  BRA: "BR",
  BRAZIL: "BR",
  BRASIL: "BR",

  // Switzerland
  CH: "CH",
  CHE: "CH",
  SWITZERLAND: "CH",

  // Austria
  AT: "AT",
  AUT: "AT",
  AUSTRIA: "AT",

  // Portugal
  PT: "PT",
  PRT: "PT",
  PORTUGAL: "PT",

  // Poland
  PL: "PL",
  POL: "PL",
  POLAND: "PL",

  // Czech Republic
  CZ: "CZ",
  CZE: "CZ",
  "CZECH REPUBLIC": "CZ",
  CZECHIA: "CZ",

  // Iceland
  IS: "IS",
  ISL: "IS",
  ICELAND: "IS",

  // South Korea
  KR: "KR",
  KOR: "KR",
  "SOUTH KOREA": "KR",
  "KOREA, REPUBLIC OF": "KR",
};

/**
 * Normalize a free-form country string to ISO 3166-1 alpha-2 ("US", "GB", etc.).
 *
 * Returns null when the input cannot be confidently mapped — caller must decide
 * whether to default to "US" or surface an address error.
 *
 * Behavior:
 *   - Trims whitespace, uppercases.
 *   - Looks up against the alias table above.
 *   - If the input is already a 2-character alpha string and not in the alias
 *     table, returns it as-is (assumes it's already alpha-2 — EP will reject
 *     it later if invalid). This keeps unknown-country shipments unblocked
 *     during the rollout.
 */
export function normalizeCountryCode(input: string | null | undefined): string | null {
  if (!input) return null;
  const cleaned = String(input).trim().toUpperCase();
  if (!cleaned) return null;
  const alias = ALIASES[cleaned];
  if (alias) return alias;
  if (/^[A-Z]{2}$/.test(cleaned)) return cleaned;
  return null;
}

/** Variant that always returns a string — falls back to "US" when unmappable. */
export function normalizeCountryCodeWithDefault(input: string | null | undefined): string {
  return normalizeCountryCode(input) ?? "US";
}
