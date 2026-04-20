// Phase 6.1 — pure helpers used by getBandcampMatchForShipStationOrder.
//
// Lives outside the "use server" action file so sync helpers can be exported
// without violating the Server Actions constraint (only async functions can
// be exported from a "use server" module).

/**
 * Pull a numeric BC payment_id out of an SS customField1 string.
 * SS customField1 is operator-configurable so we accept any of:
 *   "1234567"
 *   "BC-1234567"
 *   "Bandcamp:1234567"
 *   "payment_id=1234567"
 *
 * Returns null when no run of >= 4 digits exists.
 */
export function parsePaymentIdFromCustomField(s: string | null | undefined): number | null {
  if (!s) return null;
  const m = s.match(/(\d{4,})/);
  if (!m) return null;
  const n = Number.parseInt(m[1] ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}
