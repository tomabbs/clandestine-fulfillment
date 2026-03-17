"use client";

import { CheckCircle, Circle, Loader2 } from "lucide-react";
import { useParams, useRouter } from "next/navigation";
import { getClientDetail, updateClient, updateOnboardingStep } from "@/actions/clients";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { useAppMutation, useAppQuery } from "@/lib/hooks/use-app-query";
import { queryKeys } from "@/lib/shared/query-keys";
import { CACHE_TIERS } from "@/lib/shared/query-tiers";

export default function ClientDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const orgId = params.id;

  const { data, isLoading } = useAppQuery({
    queryKey: queryKeys.clients.detail(orgId),
    queryFn: () => getClientDetail(orgId),
    tier: CACHE_TIERS.SESSION,
  });

  const stepMut = useAppMutation({
    mutationFn: ({ step, completed }: { step: string; completed: boolean }) =>
      updateOnboardingStep(orgId, step, completed),
    invalidateKeys: [queryKeys.clients.detail(orgId)],
  });

  if (isLoading || !data) {
    return (
      <div className="p-6 flex items-center gap-2 text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading...
      </div>
    );
  }

  const { org, onboardingSteps, productCount, connections, recentSnapshots, recentConversations } =
    data;

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center gap-4">
        <Button variant="outline" size="sm" onClick={() => router.push("/admin/clients")}>
          Back
        </Button>
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{org.name}</h1>
          <p className="text-muted-foreground text-sm">
            {org.slug} &middot; {org.billing_email ?? "No billing email"}
          </p>
        </div>
      </div>

      {/* Overview stats */}
      <div className="grid grid-cols-4 gap-4">
        <Card>
          <CardContent className="p-4">
            <p className="text-xs text-muted-foreground">Products</p>
            <p className="text-2xl font-semibold">{productCount}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-xs text-muted-foreground">Store Connections</p>
            <p className="text-2xl font-semibold">{connections.length}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-xs text-muted-foreground">Billing Snapshots</p>
            <p className="text-2xl font-semibold">{recentSnapshots.length}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-xs text-muted-foreground">Support Tickets</p>
            <p className="text-2xl font-semibold">{recentConversations.length}</p>
          </CardContent>
        </Card>
      </div>

      {/* Onboarding checklist (Rule #56) */}
      <Card>
        <CardHeader>
          <CardTitle>Onboarding Checklist</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-2">
            {onboardingSteps.map((step) => (
              <div key={step.key} className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => stepMut.mutate({ step: step.key, completed: !step.completed })}
                  className="shrink-0"
                >
                  {step.completed ? (
                    <CheckCircle className="h-5 w-5 text-green-600" />
                  ) : (
                    <Circle className="h-5 w-5 text-muted-foreground hover:text-foreground" />
                  )}
                </button>
                <span
                  className={`text-sm ${step.completed ? "text-muted-foreground line-through" : ""}`}
                >
                  {step.label}
                </span>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Connections */}
      {connections.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Store Connections</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {connections.map((c) => (
                <div key={c.id} className="flex items-center justify-between text-sm">
                  <span className="capitalize">
                    {c.platform} — {c.store_url}
                  </span>
                  <Badge variant={c.connection_status === "active" ? "default" : "secondary"}>
                    {c.connection_status}
                  </Badge>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Settings */}
      <ClientSettings org={org} orgId={orgId} />
    </div>
  );
}

function ClientSettings({ org, orgId }: { org: Record<string, unknown>; orgId: string }) {
  const updateMut = useAppMutation({
    mutationFn: (data: Parameters<typeof updateClient>[1]) => updateClient(orgId, data),
    invalidateKeys: [queryKeys.clients.detail(orgId)],
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Settings</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label htmlFor="billing-email" className="text-sm font-medium block mb-1">
              Billing Email
            </label>
            <div className="flex gap-2">
              <Input
                id="billing-email"
                defaultValue={(org.billing_email as string) ?? ""}
                onBlur={(e) => updateMut.mutate({ billing_email: e.target.value || null })}
              />
            </div>
          </div>
          <div>
            <label htmlFor="pirate-ship" className="text-sm font-medium block mb-1">
              Pirate Ship Name
            </label>
            <Input
              id="pirate-ship"
              defaultValue={(org.pirate_ship_name as string) ?? ""}
              onBlur={(e) => updateMut.mutate({ pirate_ship_name: e.target.value || null })}
            />
          </div>
        </div>

        <div className="flex items-center gap-4">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={(org.storage_fee_waived as boolean) ?? false}
              onChange={(e) => updateMut.mutate({ storage_fee_waived: e.target.checked })}
            />
            Storage fee waived
          </label>
        </div>
      </CardContent>
    </Card>
  );
}
