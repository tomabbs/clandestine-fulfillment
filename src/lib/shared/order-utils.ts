/**
 * Normalize order numbers across all ingest pipelines (ShipStation, Pirate Ship, EasyPost).
 *
 * Strips common prefixes (BC-, bandcamp, #), removes non-alphanumeric chars,
 * lowercases, and trims so that "BC-12345678", "bc 12345678", and "12345678"
 * all map to "12345678".
 *
 * This function is cross-pipeline infrastructure — changes here affect all
 * three shipping ingest paths. Lock behavior with unit tests before modifying.
 */
export function normalizeOrderNumber(
  raw: string | null | undefined,
): string | null {
  if (!raw) return null;
  return (
    raw
      .toLowerCase()
      .replace(/^(bc|bandcamp)[-\s]*/i, "")
      .replace(/[^a-z0-9]/g, "")
      .trim() || null
  );
}
