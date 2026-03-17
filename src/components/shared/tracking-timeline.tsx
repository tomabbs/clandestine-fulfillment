"use client";

import {
  AlertTriangle,
  CheckCircle,
  Clock,
  ExternalLink,
  MapPin,
  Package,
  Truck,
} from "lucide-react";
import { useAppQuery } from "@/lib/hooks/use-app-query";
import { CACHE_TIERS } from "@/lib/shared/query-tiers";

interface TrackingEvent {
  id: string;
  status: string;
  description: string | null;
  location: string | null;
  event_time: string | null;
  source: string | null;
}

interface TrackingTimelineProps {
  shipmentId: string;
  trackingNumber: string | null;
  carrier: string | null;
  fetchEvents: (shipmentId: string) => Promise<TrackingEvent[]>;
}

const STATUS_CONFIG: Record<string, { icon: typeof Package; color: string; label: string }> = {
  shipped: { icon: Package, color: "text-blue-600", label: "Shipped" },
  in_transit: { icon: Truck, color: "text-blue-600", label: "In Transit" },
  InTransit: { icon: Truck, color: "text-blue-600", label: "In Transit" },
  out_for_delivery: { icon: Truck, color: "text-green-600", label: "Out for Delivery" },
  OutForDelivery: { icon: Truck, color: "text-green-600", label: "Out for Delivery" },
  delivered: { icon: CheckCircle, color: "text-green-600", label: "Delivered" },
  Delivered: { icon: CheckCircle, color: "text-green-600", label: "Delivered" },
  exception: { icon: AlertTriangle, color: "text-red-600", label: "Exception" },
  Exception: { icon: AlertTriangle, color: "text-red-600", label: "Exception" },
  AttemptFail: { icon: AlertTriangle, color: "text-orange-600", label: "Delivery Failed" },
};

function getStatusConfig(status: string) {
  return STATUS_CONFIG[status] ?? { icon: Clock, color: "text-muted-foreground", label: status };
}

function getCarrierTrackingUrl(
  carrier: string | null,
  trackingNumber: string | null,
): string | null {
  if (!carrier || !trackingNumber) return null;
  const c = carrier.toLowerCase();
  if (c.includes("usps"))
    return `https://tools.usps.com/go/TrackConfirmAction?qtc_tLabels1=${trackingNumber}`;
  if (c.includes("ups")) return `https://www.ups.com/track?tracknum=${trackingNumber}`;
  if (c.includes("fedex")) return `https://www.fedex.com/fedextrack/?trknbr=${trackingNumber}`;
  if (c.includes("dhl"))
    return `https://www.dhl.com/us-en/home/tracking.html?tracking-id=${trackingNumber}`;
  return null;
}

export function TrackingTimeline({
  shipmentId,
  trackingNumber,
  carrier,
  fetchEvents,
}: TrackingTimelineProps) {
  const { data: events, isLoading } = useAppQuery<TrackingEvent[]>({
    queryKey: ["tracking-events", shipmentId],
    queryFn: () => fetchEvents(shipmentId),
    tier: CACHE_TIERS.SESSION,
  });

  const trackingUrl = getCarrierTrackingUrl(carrier, trackingNumber);

  return (
    <div className="space-y-3">
      {/* Header with tracking info */}
      {trackingNumber && (
        <div className="flex items-center gap-2 text-sm">
          <span className="font-mono text-xs">{trackingNumber}</span>
          {carrier && <span className="text-muted-foreground">via {carrier}</span>}
          {trackingUrl && (
            <a
              href={trackingUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-blue-600 hover:underline"
            >
              <ExternalLink className="h-3 w-3" />
              Track
            </a>
          )}
        </div>
      )}

      {/* Timeline */}
      {isLoading ? (
        <div className="space-y-2">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-12 bg-muted animate-pulse rounded" />
          ))}
        </div>
      ) : !events || events.length === 0 ? (
        <p className="text-muted-foreground text-sm">No tracking events yet.</p>
      ) : (
        <div className="relative pl-6">
          <div className="absolute left-2.5 top-0 bottom-0 w-px bg-border" />
          {events.map((event, i) => {
            const config = getStatusConfig(event.status);
            const Icon = config.icon;
            const isFirst = i === 0;

            return (
              <div key={event.id} className="relative pb-4 last:pb-0">
                <div
                  className={`absolute -left-3.5 top-0.5 flex h-5 w-5 items-center justify-center rounded-full ${isFirst ? "bg-background ring-2 ring-border" : "bg-background"}`}
                >
                  <Icon className={`h-3 w-3 ${config.color}`} />
                </div>
                <div className="ml-2">
                  <p className={`text-sm font-medium ${isFirst ? "" : "text-muted-foreground"}`}>
                    {config.label}
                  </p>
                  {event.description && (
                    <p className="text-xs text-muted-foreground">{event.description}</p>
                  )}
                  <div className="flex items-center gap-2 mt-0.5">
                    {event.location && (
                      <span className="flex items-center gap-1 text-xs text-muted-foreground">
                        <MapPin className="h-3 w-3" />
                        {event.location}
                      </span>
                    )}
                    {event.event_time && (
                      <span className="text-xs text-muted-foreground">
                        {new Date(event.event_time).toLocaleString()}
                      </span>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
