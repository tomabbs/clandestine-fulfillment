"use client";

import { useQueryClient } from "@tanstack/react-query";
import {
  CheckCircle2,
  Disc3,
  Loader2,
  Plus,
  ShoppingBag,
  Store,
  Trash2,
  XCircle,
} from "lucide-react";
import { useEffect, useState } from "react";
import {
  deleteStoreConnection,
  getMyStoreConnections,
  getWooCommerceAuthUrl,
} from "@/actions/portal-stores";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useAppMutation, useAppQuery } from "@/lib/hooks/use-app-query";
import { env } from "@/lib/shared/env";
import { CACHE_TIERS } from "@/lib/shared/query-tiers";

// ── Types ─────────────────────────────────────────────────────────────────────

type Connection = Awaited<ReturnType<typeof getMyStoreConnections>>["connections"][number];

type Platform = "shopify" | "squarespace" | "woocommerce" | "discogs";

const PLATFORM_META: Record<
  Platform,
  { label: string; icon: React.ReactNode; description: string; authType: "oauth" | "credentials" }
> = {
  shopify: {
    label: "Shopify",
    icon: <ShoppingBag className="h-5 w-5" />,
    description: "Connect your Shopify store for inventory sync and order fulfillment.",
    authType: "oauth",
  },
  squarespace: {
    label: "Squarespace",
    icon: <Store className="h-5 w-5" />,
    description: "Connect your Squarespace store for inventory sync and order fulfillment.",
    authType: "oauth",
  },
  woocommerce: {
    label: "WooCommerce",
    icon: <ShoppingBag className="h-5 w-5" />,
    description:
      "Connect your WooCommerce store. You'll approve the connection in your WordPress admin — no API keys needed.",
    authType: "oauth",
  },
  discogs: {
    label: "Discogs",
    icon: <Disc3 className="h-5 w-5" />,
    description: "Connect your Discogs seller account for order fulfillment.",
    authType: "oauth",
  },
};

// ── Page ──────────────────────────────────────────────────────────────────────

export default function PortalStoresPage() {
  const [showAddModal, setShowAddModal] = useState(false);
  const queryClient = useQueryClient();

  // When returning from an OAuth flow (?connected=...), invalidate cache
  // so the newly-connected store appears immediately without a manual refresh.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("connected")) {
      queryClient.invalidateQueries({ queryKey: ["portal", "stores"] });
    }
  }, [queryClient]);

  const { data, isLoading } = useAppQuery({
    queryKey: ["portal", "stores"],
    queryFn: () => getMyStoreConnections(),
    tier: CACHE_TIERS.SESSION,
  });

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Connected Stores</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Manage your store connections for inventory sync and order fulfillment.
          </p>
        </div>
        <Button onClick={() => setShowAddModal(true)}>
          <Plus className="h-4 w-4 mr-1.5" />
          Add Store
        </Button>
      </div>

      {/* Connections list */}
      {isLoading ? (
        <div className="space-y-3">
          {[1, 2].map((i) => (
            <Skeleton key={i} className="h-24 w-full" />
          ))}
        </div>
      ) : (data?.connections ?? []).length === 0 ? (
        <Card className="border-dashed">
          <CardContent className="py-12 text-center">
            <Store className="h-10 w-10 mx-auto mb-3 text-muted-foreground/50" />
            <p className="font-medium">No stores connected yet</p>
            <p className="text-sm text-muted-foreground mt-1">
              Click "Add Store" to connect your first store.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {(data?.connections ?? []).map((conn) => (
            <ConnectionCard key={conn.id} connection={conn} />
          ))}
        </div>
      )}

      {/* Add Store Modal */}
      {showAddModal && (
        <AddStoreModal orgId={data?.orgId ?? ""} onClose={() => setShowAddModal(false)} />
      )}
    </div>
  );
}

// ── Connection card ───────────────────────────────────────────────────────────

function ConnectionCard({ connection }: { connection: Connection }) {
  const deleteMut = useAppMutation({
    mutationFn: () => deleteStoreConnection(connection.id),
    invalidateKeys: [["portal", "stores"]],
  });

  const isActive = connection.connection_status === "active";
  const isError =
    connection.connection_status === "error" ||
    connection.connection_status === "disabled_auth_failure";

  const meta = PLATFORM_META[connection.platform as Platform];

  return (
    <Card>
      <CardContent className="py-4">
        <div className="flex items-start justify-between">
          <div className="flex items-start gap-3">
            <div className="mt-0.5 text-muted-foreground">
              {meta?.icon ?? <Store className="h-5 w-5" />}
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="font-medium capitalize">{meta?.label ?? connection.platform}</span>
                {isActive ? (
                  <Badge variant="default" className="text-xs gap-1">
                    <CheckCircle2 className="h-3 w-3" /> Active
                  </Badge>
                ) : isError ? (
                  <Badge variant="destructive" className="text-xs gap-1">
                    <XCircle className="h-3 w-3" />
                    {connection.connection_status === "disabled_auth_failure"
                      ? "Auth Error"
                      : "Error"}
                  </Badge>
                ) : (
                  <Badge variant="outline" className="text-xs capitalize">
                    {connection.connection_status}
                  </Badge>
                )}
              </div>
              <p className="text-sm text-muted-foreground mt-0.5">{connection.store_url}</p>
              {isError && connection.last_error && (
                <p className="text-xs text-destructive mt-1">{connection.last_error}</p>
              )}
              {connection.last_poll_at && (
                <p className="text-xs text-muted-foreground mt-0.5">
                  Last synced: {new Date(connection.last_poll_at).toLocaleString()}
                </p>
              )}
            </div>
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground hover:text-destructive h-8 w-8 p-0"
            disabled={deleteMut.isPending}
            onClick={() => {
              if (confirm("Remove this store connection?")) {
                deleteMut.mutate();
              }
            }}
          >
            {deleteMut.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Trash2 className="h-4 w-4" />
            )}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

// ── Add Store Modal ───────────────────────────────────────────────────────────

function AddStoreModal({ orgId, onClose }: { orgId: string; onClose: () => void }) {
  const [selectedPlatform, setSelectedPlatform] = useState<Platform | null>(null);

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
      <div className="bg-background rounded-lg shadow-xl w-full max-w-md">
        <div className="flex items-center justify-between p-4 border-b">
          <h2 className="text-lg font-semibold">Add Store Connection</h2>
          <Button variant="ghost" size="sm" className="h-8 w-8 p-0" onClick={onClose}>
            ✕
          </Button>
        </div>

        <div className="p-4 space-y-4">
          {!selectedPlatform ? (
            <PlatformPicker onSelect={setSelectedPlatform} />
          ) : (
            <PlatformConnectFlow
              platform={selectedPlatform}
              orgId={orgId}
              onBack={() => setSelectedPlatform(null)}
              onDone={onClose}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function PlatformPicker({ onSelect }: { onSelect: (p: Platform) => void }) {
  return (
    <div className="space-y-2">
      <p className="text-sm text-muted-foreground">Select your store platform:</p>
      <div className="grid grid-cols-2 gap-2">
        {(Object.entries(PLATFORM_META) as [Platform, (typeof PLATFORM_META)[Platform]][]).map(
          ([platform, meta]) => (
            <button
              key={platform}
              type="button"
              onClick={() => onSelect(platform)}
              className="flex flex-col items-center gap-2 border rounded-lg p-4 hover:border-primary hover:bg-primary/5 transition-colors text-sm font-medium"
            >
              {meta.icon}
              {meta.label}
            </button>
          ),
        )}
      </div>
    </div>
  );
}

function PlatformConnectFlow({
  platform,
  orgId,
  onBack,
  onDone,
}: {
  platform: Platform;
  orgId: string;
  onBack: () => void;
  onDone: () => void;
}) {
  const meta = PLATFORM_META[platform];

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="sm" className="h-8 w-8 p-0 -ml-1" onClick={onBack}>
          ←
        </Button>
        <div className="flex items-center gap-1.5">
          {meta.icon}
          <span className="font-medium">{meta.label}</span>
        </div>
      </div>

      <p className="text-sm text-muted-foreground">{meta.description}</p>

      {platform === "shopify" && <ShopifyOAuthFlow orgId={orgId} />}
      {platform === "squarespace" && (
        <OAuthRedirectButton
          platform="squarespace"
          orgId={orgId}
          label="Connect with Squarespace"
        />
      )}
      {platform === "discogs" && (
        <OAuthRedirectButton platform="discogs" orgId={orgId} label="Authorize on Discogs" />
      )}
      {platform === "woocommerce" && <WooCommerceCredentialsForm orgId={orgId} onDone={onDone} />}
    </div>
  );
}

// ── OAuth flow components ─────────────────────────────────────────────────────

function ShopifyOAuthFlow({ orgId }: { orgId: string }) {
  const [shopDomain, setShopDomain] = useState("");

  const handleConnect = () => {
    if (!shopDomain) return;
    const shop = shopDomain.replace(/^https?:\/\//, "").replace(/\/$/, "");
    window.open(
      `/api/oauth/shopify?shop=${encodeURIComponent(shop)}&org_id=${encodeURIComponent(orgId)}`,
      "_blank",
    );
  };

  return (
    <div className="space-y-3">
      <div>
        <label htmlFor="shop-domain" className="text-sm font-medium block mb-1">
          Your Shopify domain
        </label>
        <Input
          id="shop-domain"
          placeholder="yourstore.myshopify.com"
          value={shopDomain}
          onChange={(e) => setShopDomain(e.target.value)}
          className="font-mono"
        />
        <p className="text-xs text-muted-foreground mt-1">Enter your .myshopify.com domain</p>
      </div>
      <Button onClick={handleConnect} disabled={!shopDomain.trim()} className="w-full">
        Connect with Shopify →
      </Button>
    </div>
  );
}

function OAuthRedirectButton({
  platform,
  orgId,
  label,
}: {
  platform: string;
  orgId: string;
  label: string;
}) {
  return (
    <Button
      className="w-full"
      onClick={() => {
        window.open(`/api/oauth/${platform}?org_id=${encodeURIComponent(orgId)}`, "_blank");
      }}
    >
      {label} →
    </Button>
  );
}

function WooCommerceCredentialsForm({
  orgId: _orgId,
  onDone: _onDone,
}: {
  orgId: string;
  onDone: () => void;
}) {
  const [storeUrl, setStoreUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleConnect = async () => {
    if (!storeUrl.trim()) return;
    setError(null);
    setLoading(true);
    try {
      const result = await getWooCommerceAuthUrl(storeUrl.trim());
      // Open the WP admin approval screen in a new tab
      window.open(result.url, "_blank");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to build auth URL");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-3">
      <div>
        <label htmlFor="woo-store-url" className="text-sm font-medium block mb-1">
          Store URL
        </label>
        <Input
          id="woo-store-url"
          placeholder="https://yourstore.com"
          value={storeUrl}
          onChange={(e) => setStoreUrl(e.target.value)}
          className="font-mono"
        />
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
      <Button className="w-full" disabled={!storeUrl.trim() || loading} onClick={handleConnect}>
        {loading ? (
          <>
            <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
            Opening…
          </>
        ) : (
          "Connect with WooCommerce →"
        )}
      </Button>
      <p className="text-xs text-muted-foreground">
        You'll log into WordPress and then approve the connection — no API keys needed.
      </p>
    </div>
  );
}
