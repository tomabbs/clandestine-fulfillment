"use client";

import { Disc3, List, Mail, MessageSquare } from "lucide-react";
import { getDiscogsOverview } from "@/actions/discogs-admin";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useAppQuery } from "@/lib/hooks/use-app-query";
import { CACHE_TIERS } from "@/lib/shared/query-tiers";

export default function AdminDiscogsPage() {
  const { data, isLoading } = useAppQuery({
    queryKey: ["discogs", "overview"],
    queryFn: () => getDiscogsOverview(),
    tier: CACHE_TIERS.SESSION,
  });

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2">
          <Disc3 className="h-6 w-6" /> Discogs
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          Clandestine master catalog — consignment listings on Discogs marketplace.
        </p>
      </div>

      {isLoading ? (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          {[1, 2, 3, 4].map((i) => (
            <Skeleton key={i} className="h-24" />
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <Card>
            <CardHeader className="pb-1">
              <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-1.5">
                <List className="h-4 w-4" /> Active Listings
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-3xl font-semibold">{data?.activeListings ?? 0}</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-1">
              <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-1.5">
                <Mail className="h-4 w-4" /> Total Orders
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-3xl font-semibold">{data?.totalOrders ?? 0}</p>
              {(data?.unfulfilledOrders ?? 0) > 0 && (
                <Badge variant="outline" className="mt-1 text-xs">
                  {data?.unfulfilledOrders} unfulfilled
                </Badge>
              )}
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-1">
              <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-1.5">
                <MessageSquare className="h-4 w-4" /> Messages
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-3xl font-semibold">{data?.totalMessages ?? 0}</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-1">
              <CardTitle className="text-sm font-medium text-muted-foreground">Account</CardTitle>
            </CardHeader>
            <CardContent>
              {data?.hasCredentials ? (
                <div>
                  <Badge variant="default" className="text-xs">
                    Connected
                  </Badge>
                  {data.username && <p className="text-sm font-mono mt-1">@{data.username}</p>}
                </div>
              ) : (
                <Badge variant="outline" className="text-xs">
                  Not configured
                </Badge>
              )}
            </CardContent>
          </Card>
        </div>
      )}

      <div className="flex flex-wrap gap-3">
        <a
          href="/admin/discogs/credentials"
          className="inline-flex items-center justify-center rounded-md border border-input bg-background px-3 py-1.5 text-sm font-medium hover:bg-accent transition-colors"
        >
          Manage Credentials
        </a>
        <a
          href="/admin/discogs/matching"
          className="inline-flex items-center justify-center rounded-md border border-input bg-background px-3 py-1.5 text-sm font-medium hover:bg-accent transition-colors"
        >
          Product Matching
        </a>
      </div>
    </div>
  );
}
