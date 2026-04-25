// Phase 11.1 — Buyer-supplied text sanitizer for packing slips + drawer.
//
// Buyer notes / ship instructions arrive directly from BC checkout. We
// render them as plain text via React's escaping (no innerHTML), so HTML
// tags appear literal. This helper additionally:
//   - strips zero-width + bidi-override Unicode chars (RLO swap, ZWSP)
//     that could visually mangle the slip
//   - caps length at MAX_LEN chars (whole-notes vs slip-real-estate budget)
//   - normalizes CRLF → LF for consistent whitespace rendering
// Pure + sync. Locked in by tests/unit/lib/sanitize-buyer-text.test.ts.

export const MAX_BUYER_TEXT_LEN = 800;

const STRIP_RE = /[\u202A-\u202E\u2066-\u2069\u200B-\u200D\uFEFF]/g;

export function sanitizeBuyerText(input: string | null | undefined): string {
  if (!input) return "";
  const stripped = input.replace(STRIP_RE, "").replace(/\r\n/g, "\n");
  return stripped.length > MAX_BUYER_TEXT_LEN
    ? `${stripped.slice(0, MAX_BUYER_TEXT_LEN)}…`
    : stripped;
}
