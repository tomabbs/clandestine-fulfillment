"use client";

import { Loader2 } from "lucide-react";
import { getIntegrationStatus } from "@/actions/admin-settings";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useAppQuery } from "@/lib/hooks/use-app-query";
import { CACHE_TIERS } from "@/lib/shared/query-tiers";

const INTEGRATIONS = [
  { key: "shopify", name: "Shopify", desc: "Product catalog + inventory sync" },
  { key: "shipstation", name: "ShipStation", desc: "Shipment tracking" },
  { key: "bandcamp", name: "Bandcamp", desc: "Sales + inventory push" },
  { key: "aftership", name: "AfterShip", desc: "Tracking updates" },
  { key: "billing", name: "Stripe", desc: "Billing + invoicing" },
  { key: "resend", name: "Resend", desc: "Email + inbound support" },
];

export default function IntegrationsPage() {
  const { data, isLoading } = useAppQuery({
    queryKey: ["admin", "settings", "integrations"],
    queryFn: () => getIntegrationStatus(),
    tier: CACHE_TIERS.SESSION,
  });

  if (isLoading || !data) {
    return (
      <div className="p-6 flex items-center gap-2 text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading...
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6">
      <h1 className="text-2xl font-semibold tracking-tight">Integrations</h1>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {INTEGRATIONS.map((integration) => {
          const activity = data.lastActivity[integration.key] as
            | { status: string; completed_at: string }
            | undefined;
          return (
            <Card key={integration.key}>
              <CardHeader className="pb-2">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-base">{integration.name}</CardTitle>
                  <Badge
                    variant={
                      activity?.status === "completed"
                        ? "default"
                        : activity
                          ? "secondary"
                          : "outline"
                    }
                  >
                    {activity?.status ?? "no data"}
                  </Badge>
                </div>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-muted-foreground">{integration.desc}</p>
                {activity?.completed_at && (
                  <p className="text-xs text-muted-foreground mt-1">
                    Last: {new Date(activity.completed_at).toLocaleString()}
                  </p>
                )}
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
