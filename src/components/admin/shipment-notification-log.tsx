"use client";

// Slice 4 — Per-shipment notification + webhook audit drilldown.
//
// Renders into the shipping cockpit's expanded shipment row + the orders
// detail drawer. Shows the FULL audit trail for every notification that
// has ever fired for this shipment:
//   - notification_sends row(s)        — current/historical state per
//                                          (shipment, trigger_status)
//   - notification_provider_events     — every Resend/EasyPost event we
//                                          received for the matched send
//   - notification_operator_events     — every operator action (retry,
//                                          cancel, force_resend) with the
//                                          operator who performed it
//
// Renders as a collapsible block to keep the parent page compact when
// nothing is interesting. Lazy-loaded — only fetches when the section is
// expanded.

import { ChevronDown, ChevronRight, Loader2 } from "lucide-react";
import { useState } from "react";
import {
  getShipmentNotificationLog,
  type ShipmentNotificationLogRow,
} from "@/actions/notification-operations";
import { Badge } from "@/components/ui/badge";
import { useAppQuery } from "@/lib/hooks/use-app-query";
import { CACHE_TIERS } from "@/lib/shared/query-tiers";

function statusBadgeVariant(status: string): "default" | "secondary" | "destructive" | "outline" {
  if (status === "delivered" || status === "sent") return "default";
  if (status === "pending" || status === "delivery_delayed" || status === "shadow")
    return "secondary";
  if (status === "cancelled" || status === "skipped" || status === "suppressed") return "outline";
  return "destructive";
}

export function ShipmentNotificationLog({ shipmentId }: { shipmentId: string }) {
  const [expanded, setExpanded] = useState(false);

  const query = useAppQuery({
    queryKey: ["admin", "shipping", "notification-log", shipmentId],
    queryFn: () => getShipmentNotificationLog(shipmentId),
    enabled: expanded,
    tier: CACHE_TIERS.SESSION,
  });

  const rows = query.data ?? [];

  return (
    <div className="rounded-md border bg-background/60">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-muted/30"
      >
        <span className="flex items-center gap-2">
          {expanded ? (
            <ChevronDown className="h-4 w-4" />
          ) : (
            <ChevronRight className="h-4 w-4" />
          )}
          <span className="font-medium">Notification audit log</span>
          {expanded && query.isFetching ? (
            <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
          ) : null}
        </span>
        <span className="text-xs text-muted-foreground">
          {expanded ? `${rows.length} send${rows.length === 1 ? "" : "s"}` : "click to expand"}
        </span>
      </button>

      {expanded && (
        <div className="border-t px-3 py-3">
          {query.isLoading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No notifications have been queued for this shipment yet. The send-tracking-email task
              fires when the label is purchased and on every EasyPost status update.
            </p>
          ) : (
            <div className="space-y-4">
              {rows.map((entry) => (
                <NotificationLogEntry key={entry.send.id} entry={entry} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function NotificationLogEntry({ entry }: { entry: ShipmentNotificationLogRow }) {
  const { send, providerEvents, operatorEvents } = entry;
  return (
    <div className="rounded-md border p-3 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <Badge variant="secondary">{send.trigger_status}</Badge>
            <Badge variant={statusBadgeVariant(send.status)}>{send.status}</Badge>
            <span className="text-xs text-muted-foreground">
              attempt {send.attempt_count}
            </span>
          </div>
          <p className="text-xs font-mono text-muted-foreground">{send.recipient}</p>
        </div>
        <div className="text-xs text-right text-muted-foreground space-y-0.5">
          <p>Pending: {new Date(send.pending_at).toLocaleString()}</p>
          {send.sent_at && <p>Sent: {new Date(send.sent_at).toLocaleString()}</p>}
          {send.delivered_at && (
            <p>Delivered: {new Date(send.delivered_at).toLocaleString()}</p>
          )}
          {send.bounced_at && <p>Bounced: {new Date(send.bounced_at).toLocaleString()}</p>}
          {send.complained_at && (
            <p>Complained: {new Date(send.complained_at).toLocaleString()}</p>
          )}
          {send.cancelled_at && (
            <p>Cancelled: {new Date(send.cancelled_at).toLocaleString()}</p>
          )}
        </div>
      </div>

      {send.error && (
        <div className="rounded bg-red-50 dark:bg-red-950/20 border border-red-200 dark:border-red-900/40 px-2 py-1 text-xs text-red-900 dark:text-red-200">
          <span className="font-medium">Last error:</span> {send.error}
        </div>
      )}

      {send.resend_message_id && (
        <p className="text-xs text-muted-foreground">
          Resend message id: <span className="font-mono">{send.resend_message_id}</span>
        </p>
      )}

      {providerEvents.length > 0 && (
        <div>
          <p className="text-[11px] uppercase tracking-wide text-muted-foreground mb-1">
            Provider events ({providerEvents.length})
          </p>
          <ul className="text-xs space-y-1">
            {providerEvents.map((ev) => (
              <li key={ev.id} className="flex items-center gap-2">
                <Badge variant="outline" className="text-[10px]">
                  {ev.provider}
                </Badge>
                <span className="font-mono">{ev.event_type ?? "unknown"}</span>
                <span className="text-muted-foreground">
                  {new Date(ev.received_at).toLocaleString()}
                </span>
                {ev.provider_event_id && (
                  <span className="font-mono text-muted-foreground truncate max-w-[12rem]">
                    {ev.provider_event_id}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {operatorEvents.length > 0 && (
        <div>
          <p className="text-[11px] uppercase tracking-wide text-muted-foreground mb-1">
            Operator actions ({operatorEvents.length})
          </p>
          <ul className="text-xs space-y-1">
            {operatorEvents.map((ev) => (
              <li key={ev.id} className="space-y-0.5">
                <div className="flex items-center gap-2">
                  <Badge variant="secondary" className="text-[10px]">
                    {ev.action}
                  </Badge>
                  <span className="text-muted-foreground">
                    {new Date(ev.created_at).toLocaleString()}
                  </span>
                  {ev.previous_status && ev.new_status && (
                    <span className="text-muted-foreground">
                      {ev.previous_status} → {ev.new_status}
                    </span>
                  )}
                </div>
                {ev.reason && (
                  <p className="text-muted-foreground italic pl-1">{ev.reason}</p>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
