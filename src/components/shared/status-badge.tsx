/**
 * StatusBadge — semantic-color status badge.
 *
 * Replaces the monochrome amber-everywhere pattern. Five intents
 * mapped to the --status-* OKLCH tokens defined in globals.css.
 *
 * Usage:
 *
 *   <StatusBadge intent="success">Shipped</StatusBadge>
 *   <StatusBadge intent="warning">Awaiting Shipment</StatusBadge>
 *   <StatusBadge intent="danger">Failed</StatusBadge>
 *   <StatusBadge intent="info">In Transit</StatusBadge>
 *   <StatusBadge intent="neutral">Draft</StatusBadge>
 *
 * Optional dot indicator for status streams (incident lists, etc.):
 *
 *   <StatusBadge intent="danger" dot>Outage</StatusBadge>
 */

import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export type StatusIntent = "success" | "warning" | "danger" | "info" | "neutral";

export interface StatusBadgeProps {
  intent: StatusIntent;
  children: ReactNode;
  dot?: boolean;
  className?: string;
}

const INTENT_CLASSES: Record<StatusIntent, string> = {
  // Each intent uses bg at 15% opacity, border at 30%, text at full
  // saturation. Reads as a colored chip without overpowering the row.
  success: "bg-status-success/15 text-status-success border-status-success/30",
  warning: "bg-status-warning/15 text-status-warning border-status-warning/30",
  danger: "bg-status-danger/15 text-status-danger border-status-danger/30",
  info: "bg-status-info/15 text-status-info border-status-info/30",
  neutral: "bg-status-neutral/15 text-status-neutral border-status-neutral/30",
};

const INTENT_DOT_CLASSES: Record<StatusIntent, string> = {
  success: "bg-status-success",
  warning: "bg-status-warning",
  danger: "bg-status-danger",
  info: "bg-status-info",
  neutral: "bg-status-neutral",
};

export function StatusBadge({ intent, children, dot = false, className }: StatusBadgeProps) {
  return (
    <span
      data-slot="status-badge"
      data-intent={intent}
      className={cn(
        "inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md border text-xs font-medium whitespace-nowrap",
        INTENT_CLASSES[intent],
        className,
      )}
    >
      {dot && (
        <span
          className={cn("inline-block h-1.5 w-1.5 rounded-full", INTENT_DOT_CLASSES[intent])}
          aria-hidden="true"
        />
      )}
      {children}
    </span>
  );
}

/**
 * Helper — map common ShipStation/EasyPost status strings to a default
 * intent. Components can override by passing `intent` explicitly.
 */
export function statusIntentFor(status: string | null | undefined): StatusIntent {
  if (!status) return "neutral";
  const s = status.toLowerCase();
  if (
    s.includes("shipped") ||
    s.includes("delivered") ||
    s.includes("active") ||
    s.includes("verified") ||
    s.includes("paid") ||
    s.includes("complete") ||
    s.includes("success")
  ) {
    return "success";
  }
  if (
    s.includes("await") ||
    s.includes("pending") ||
    s.includes("hold") ||
    s.includes("preorder") ||
    s.includes("ready_to_ship") ||
    s.includes("ready to ship")
  ) {
    return "warning";
  }
  if (
    s.includes("fail") ||
    s.includes("error") ||
    s.includes("cancel") ||
    s.includes("voided") ||
    s.includes("delivery_failed") ||
    s.includes("exception") ||
    s.includes("return")
  ) {
    return "danger";
  }
  if (
    s.includes("transit") ||
    s.includes("out_for_delivery") ||
    s.includes("out for delivery") ||
    s.includes("in_transit") ||
    s.includes("info") ||
    s.includes("synced")
  ) {
    return "info";
  }
  return "neutral";
}
