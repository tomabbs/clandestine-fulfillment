"use client";

import { CheckCircle2, Copy, ExternalLink, Loader2, ShieldAlert } from "lucide-react";
import { useEffect, useState } from "react";
import {
  generateShopifyInstallUrl,
  listShopifyLocations,
  type ShopifyLocationSummary,
  setShopifyAppCredentials,
  setShopifyDefaultLocation,
} from "@/actions/store-connections";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAppMutation, useAppQuery } from "@/lib/hooks/use-app-query";
import { queryKeys } from "@/lib/shared/query-keys";
import { CACHE_TIERS } from "@/lib/shared/query-tiers";

/**
 * HRD-35 onboarding dialog for a single Shopify client_store_connections row.
 *
 * Three-step flow (matches the Server Action contract in store-connections.ts):
 *   1) Paste per-connection Custom-distribution app Client ID + Client Secret.
 *   2) Generate install URL → operator clicks it to complete OAuth in Shopify.
 *   3) After install, pick a default Shopify location for inventory ops.
 *
 * The dialog is read-only-aware: each step shows the current state of the
 * connection so an operator can re-open the dialog mid-flow without losing
 * context.
 */
export function ConfigureShopifyAppDialog({
  open,
  onOpenChange,
  connection,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  connection: {
    id: string;
    org_id: string;
    org_name: string;
    store_url: string;
    api_key: string | null;
    shopify_app_client_id: string | null;
    shopify_app_client_secret_encrypted: string | null;
    default_location_id: string | null;
    do_not_fanout: boolean;
  };
}) {
  const credsConfigured = Boolean(
    connection.shopify_app_client_id && connection.shopify_app_client_secret_encrypted,
  );
  const tokenPresent = Boolean(connection.api_key);
  const defaultLocationSet = Boolean(connection.default_location_id);

  const shopDomain = extractShopDomain(connection.store_url);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Configure Shopify app — {connection.org_name}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 pt-2 text-sm">
          <div className="flex flex-wrap gap-2">
            <StepBadge label="Step 1: App credentials" done={credsConfigured} />
            <StepBadge label="Step 2: OAuth installed" done={tokenPresent} />
            <StepBadge label="Step 3: Default location" done={defaultLocationSet} />
            {connection.do_not_fanout && (
              <Badge variant="outline" className="gap-1">
                <ShieldAlert className="h-3 w-3" />
                Dormant (do_not_fanout)
              </Badge>
            )}
          </div>

          <div className="rounded-md border bg-muted/30 p-3">
            <p className="text-xs uppercase tracking-wide text-muted-foreground">Store</p>
            <p className="font-mono text-xs">{connection.store_url}</p>
            {!shopDomain && (
              <p className="text-amber-600 mt-1 text-xs">
                Could not parse a *.myshopify.com hostname from store_url. Step 2 install URL
                generation will fail until store_url is corrected.
              </p>
            )}
          </div>

          <Step1Credentials connectionId={connection.id} alreadyConfigured={credsConfigured} />

          {credsConfigured && shopDomain && (
            <Step2Install connectionId={connection.id} shopDomain={shopDomain} />
          )}

          {tokenPresent && (
            <Step3DefaultLocation
              connectionId={connection.id}
              currentDefaultLocationId={connection.default_location_id}
            />
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function StepBadge({ label, done }: { label: string; done: boolean }) {
  return (
    <Badge variant={done ? "default" : "outline"} className="gap-1">
      {done ? <CheckCircle2 className="h-3 w-3" /> : <span className="h-3 w-3" />}
      {label}
    </Badge>
  );
}

function Step1Credentials({
  connectionId,
  alreadyConfigured,
}: {
  connectionId: string;
  alreadyConfigured: boolean;
}) {
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [showForm, setShowForm] = useState(!alreadyConfigured);

  const mutation = useAppMutation({
    mutationFn: () =>
      setShopifyAppCredentials({
        connectionId,
        shopifyAppClientId: clientId.trim(),
        shopifyAppClientSecret: clientSecret.trim(),
      }),
    invalidateKeys: [queryKeys.storeConnections.all],
    onSuccess: () => {
      setClientId("");
      setClientSecret("");
      setShowForm(false);
    },
  });

  if (alreadyConfigured && !showForm) {
    return (
      <section className="space-y-2 border-t pt-3">
        <div className="flex items-center justify-between">
          <h3 className="font-medium">Step 1 — App credentials</h3>
          <Button variant="outline" size="sm" onClick={() => setShowForm(true)}>
            Replace credentials
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          Per-connection Custom-distribution app credentials are configured. Replace them only if
          you've rotated the Client Secret in the Partner Dashboard.
        </p>
      </section>
    );
  }

  return (
    <section className="space-y-2 border-t pt-3">
      <h3 className="font-medium">Step 1 — Paste per-client app credentials</h3>
      <p className="text-xs text-muted-foreground">
        Created in the client's Shopify Partner Dashboard as a <em>Custom distribution</em> app. The
        app and the destination store must belong to the same Shopify Partner organization.
      </p>
      <div>
        <Label htmlFor={`${connectionId}-client-id`}>Client ID</Label>
        <Input
          id={`${connectionId}-client-id`}
          autoComplete="off"
          spellCheck={false}
          value={clientId}
          onChange={(e) => setClientId(e.target.value)}
          placeholder="abcdef0123456789…"
          className="mt-1 font-mono text-xs"
        />
      </div>
      <div>
        <Label htmlFor={`${connectionId}-client-secret`}>Client Secret</Label>
        <Input
          id={`${connectionId}-client-secret`}
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={clientSecret}
          onChange={(e) => setClientSecret(e.target.value)}
          placeholder="shpss_…"
          className="mt-1 font-mono text-xs"
        />
      </div>
      {mutation.error && (
        <p className="text-red-600 text-xs">
          {mutation.error instanceof Error ? mutation.error.message : "Save failed"}
        </p>
      )}
      <div className="flex gap-2">
        <Button
          size="sm"
          disabled={!clientId.trim() || !clientSecret.trim() || mutation.isPending}
          onClick={() => mutation.mutate()}
        >
          {mutation.isPending ? "Saving..." : "Save credentials"}
        </Button>
        {alreadyConfigured && (
          <Button variant="ghost" size="sm" onClick={() => setShowForm(false)}>
            Cancel
          </Button>
        )}
      </div>
    </section>
  );
}

function Step2Install({ connectionId, shopDomain }: { connectionId: string; shopDomain: string }) {
  const [installUrl, setInstallUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const mutation = useAppMutation({
    mutationFn: () => generateShopifyInstallUrl({ connectionId, shopDomain }),
    onSuccess: (result) => setInstallUrl(result.installUrl),
  });

  return (
    <section className="space-y-2 border-t pt-3">
      <h3 className="font-medium">Step 2 — Install the app on the client store</h3>
      <p className="text-xs text-muted-foreground">
        Generate the install URL, open it in a browser session that's signed into the client's
        Shopify admin, approve the OAuth scope list. The callback will land on this page with{" "}
        <code className="rounded bg-muted px-1">?connected=shopify</code>.
      </p>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" disabled={mutation.isPending} onClick={() => mutation.mutate()}>
          {mutation.isPending ? "Generating..." : "Generate install URL"}
        </Button>
      </div>
      {mutation.error && (
        <p className="text-red-600 text-xs">
          {mutation.error instanceof Error ? mutation.error.message : "Generation failed"}
        </p>
      )}
      {installUrl && (
        <div className="space-y-2 rounded-md border bg-muted/30 p-3">
          <p className="font-mono text-xs break-all">{installUrl}</p>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={async () => {
                await navigator.clipboard.writeText(installUrl);
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              }}
            >
              <Copy className="h-3 w-3 mr-1" /> {copied ? "Copied" : "Copy"}
            </Button>
            <a
              href={installUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex h-9 items-center rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground hover:bg-primary/90"
            >
              <ExternalLink className="h-3 w-3 mr-1" /> Open install link
            </a>
          </div>
        </div>
      )}
    </section>
  );
}

function Step3DefaultLocation({
  connectionId,
  currentDefaultLocationId,
}: {
  connectionId: string;
  currentDefaultLocationId: string | null;
}) {
  const [selectedId, setSelectedId] = useState<string>(currentDefaultLocationId ?? "");

  const { data, isLoading, error } = useAppQuery({
    queryKey: ["shopify-locations", connectionId],
    queryFn: () => listShopifyLocations({ connectionId }),
    tier: CACHE_TIERS.SESSION,
  });

  // Auto-select the only active location when the store has just one
  // (Northern Spy probe finding 2026-04-21).
  useEffect(() => {
    if (selectedId) return;
    if (!data) return;
    const active = data.filter((l) => l.active);
    if (active.length === 1) {
      setSelectedId(active[0].id);
    }
  }, [data, selectedId]);

  const mutation = useAppMutation({
    mutationFn: () =>
      setShopifyDefaultLocation({
        connectionId,
        locationId: selectedId,
      }),
    invalidateKeys: [queryKeys.storeConnections.all],
  });

  return (
    <section className="space-y-2 border-t pt-3">
      <h3 className="font-medium">Step 3 — Default Shopify location</h3>
      <p className="text-xs text-muted-foreground">
        Inventory operations use this location. Webhooks for other locations are persisted as{" "}
        <code className="rounded bg-muted px-1">wrong_location</code> and not applied (HRD-05).
      </p>
      {isLoading && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" /> Fetching locations from Shopify…
        </div>
      )}
      {error && (
        <p className="text-red-600 text-xs">
          {error instanceof Error ? error.message : "Failed to list Shopify locations"}
        </p>
      )}
      {data && data.length === 0 && (
        <p className="text-amber-600 text-xs">
          Shopify returned zero locations. Confirm the offline token has the{" "}
          <code className="rounded bg-muted px-1">read_locations</code> scope — installs predating
          the HRD-25 scope expansion need re-consent.
        </p>
      )}
      {data && data.length > 0 && (
        <>
          <div>
            <Label htmlFor={`${connectionId}-default-loc`}>Location</Label>
            <select
              id={`${connectionId}-default-loc`}
              value={selectedId}
              onChange={(e) => setSelectedId(e.target.value)}
              className="border-input bg-background w-full h-9 rounded-md border px-3 text-sm mt-1"
            >
              <option value="">Select a location…</option>
              {data.map((l: ShopifyLocationSummary) => (
                <option key={l.id} value={l.id} disabled={!l.active}>
                  {l.name} {l.city ? `(${l.city})` : ""} {l.active ? "" : "— inactive"}
                </option>
              ))}
            </select>
          </div>
          {mutation.error && (
            <p className="text-red-600 text-xs">
              {mutation.error instanceof Error ? mutation.error.message : "Save failed"}
            </p>
          )}
          <Button
            size="sm"
            disabled={!selectedId || selectedId === currentDefaultLocationId || mutation.isPending}
            onClick={() => mutation.mutate()}
          >
            {mutation.isPending
              ? "Saving..."
              : selectedId === currentDefaultLocationId
                ? "No change"
                : "Set as default"}
          </Button>
        </>
      )}
    </section>
  );
}

function extractShopDomain(storeUrl: string): string | null {
  // Accept either `https://shop.myshopify.com` or `https://shop.myshopify.com/`.
  // Reject custom domains — Shopify install URLs require the canonical
  // `*.myshopify.com` hostname even when the storefront uses a custom domain.
  try {
    const url = new URL(storeUrl);
    if (!/^[a-z0-9-]+\.myshopify\.com$/i.test(url.hostname)) return null;
    return url.hostname.toLowerCase();
  } catch {
    return null;
  }
}
