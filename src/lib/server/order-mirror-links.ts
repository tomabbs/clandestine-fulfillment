/**
 * Order Pages Transition Phase 2 — pure helpers for the order mirror
 * link bridge.
 *
 * The bridge worker pairs `warehouse_orders` (Direct) and
 * `shipstation_orders` (Mirror) using a small set of well-defined
 * signals. The pairing logic is pure so it can be tested without DB
 * round-trips and so the manual-resolution Server Action can re-use
 * the same vocabulary.
 *
 * Signals (in order of precedence):
 *   1. Same `order_number` AND same workspace AND ship-window proximity
 *      ≤ 14 days → DETERMINISTIC.
 *   2. Same `order_number` AND same workspace, no ship-window evidence
 *      → PROBABLE.
 *   3. Same `customer_email` AND same `total_price` AND same workspace,
 *      ship-window proximity ≤ 14 days → PROBABLE.
 *   4. Anything else → no match.
 *
 * The ENUM type maps to the SQL `order_mirror_link_confidence` defined
 * in migration 20260429000002.
 */

export type OrderMirrorLinkConfidence = "deterministic" | "probable" | "manual" | "rejected";

export interface DirectOrderMatchInput {
  warehouseOrderId: string;
  workspaceId: string;
  orderNumber: string | null;
  customerEmail: string | null;
  totalPrice: number | null;
  createdAtMs: number;
}

export interface MirrorOrderMatchInput {
  shipstationOrderId: string;
  workspaceId: string;
  orderNumber: string | null;
  customerEmail: string | null;
  amountPaid: number | null;
  orderDateMs: number | null;
}

export interface MirrorLinkDecision {
  confidence: OrderMirrorLinkConfidence | null;
  warehouseOrderId: string;
  shipstationOrderId: string;
  signals: Record<string, unknown>;
}

const SHIP_WINDOW_MS = 14 * 86_400_000;

export function decideMirrorLink(
  direct: DirectOrderMatchInput,
  mirror: MirrorOrderMatchInput,
): MirrorLinkDecision {
  if (direct.workspaceId !== mirror.workspaceId) {
    return {
      confidence: null,
      warehouseOrderId: direct.warehouseOrderId,
      shipstationOrderId: mirror.shipstationOrderId,
      signals: { rejected: "workspace_mismatch" },
    };
  }

  const orderNumberMatch =
    !!direct.orderNumber &&
    !!mirror.orderNumber &&
    direct.orderNumber.trim().toLowerCase() === mirror.orderNumber.trim().toLowerCase();

  const shipWindowMs = mirror.orderDateMs
    ? Math.abs(direct.createdAtMs - mirror.orderDateMs)
    : Number.POSITIVE_INFINITY;
  const shipWindowOk = shipWindowMs <= SHIP_WINDOW_MS;

  if (orderNumberMatch && shipWindowOk) {
    return {
      confidence: "deterministic",
      warehouseOrderId: direct.warehouseOrderId,
      shipstationOrderId: mirror.shipstationOrderId,
      signals: {
        order_number_match: true,
        ship_window_ms: shipWindowMs,
      },
    };
  }
  if (orderNumberMatch) {
    return {
      confidence: "probable",
      warehouseOrderId: direct.warehouseOrderId,
      shipstationOrderId: mirror.shipstationOrderId,
      signals: {
        order_number_match: true,
        ship_window_ms: Number.isFinite(shipWindowMs) ? shipWindowMs : null,
      },
    };
  }

  const emailMatch =
    !!direct.customerEmail &&
    !!mirror.customerEmail &&
    direct.customerEmail.trim().toLowerCase() === mirror.customerEmail.trim().toLowerCase();
  const totalMatch =
    direct.totalPrice !== null &&
    mirror.amountPaid !== null &&
    Math.abs(Number(direct.totalPrice) - Number(mirror.amountPaid)) < 0.01;
  if (emailMatch && totalMatch && shipWindowOk) {
    return {
      confidence: "probable",
      warehouseOrderId: direct.warehouseOrderId,
      shipstationOrderId: mirror.shipstationOrderId,
      signals: {
        email_match: true,
        total_match: true,
        ship_window_ms: shipWindowMs,
      },
    };
  }

  return {
    confidence: null,
    warehouseOrderId: direct.warehouseOrderId,
    shipstationOrderId: mirror.shipstationOrderId,
    signals: { rejected: "no_signal" },
  };
}
