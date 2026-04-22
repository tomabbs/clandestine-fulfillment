"use client";

import {
  CheckCircle2,
  Copy,
  ExternalLink,
  Loader2,
  Play,
  RefreshCw,
  ShieldAlert,
  Webhook,
} from "lucide-react";
import { useEffect, useState } from "react";
import {
  type AutoDiscoverShopifySkusReport,
  autoDiscoverShopifySkus,
  type DirectShopifyDryRunReport,
  generateShopifyInstallUrl,
  getSkuMappingSummary,
  listShopifyLocations,
  type RegisterShopifyWebhookSubscriptionsReport,
  registerShopifyWebhookSubscriptions,
  runDirectShopifyDryRun,
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
 * Four-step flow (matches the Server Action contract in store-connections.ts):
 *   1) Paste per-connection Custom-distribution app Client ID + Client Secret.
 *   2) Generate install URL → operator clicks it to complete OAuth in Shopify.
 *   3) After install, pick a default Shopify location for inventory ops.
 *   4) Walk Shopify variants and populate client_store_sku_mappings (HRD-03).
 *
 * The dialog is read-only-aware: each step shows the current state of the
 * connection so an operator can re-open the dialog mid-flow without losing
 * context.
 *
 * Operator-controlled — none of these steps fire automatically. Steps 4-6
 * (discover, register webhooks, dry-run) are explicitly NOT auto-fired on
 * OAuth callback because each one writes meaningful state (mappings, webhook
 * subscriptions in Shopify, etc.) and the operator should choose when to
 * proceed.
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
          <StepBadgeRow
            connectionId={connection.id}
            credsConfigured={credsConfigured}
            tokenPresent={tokenPresent}
            defaultLocationSet={defaultLocationSet}
            doNotFanout={connection.do_not_fanout}
          />

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

          {tokenPresent && <Step4SkuDiscovery connectionId={connection.id} />}

          {tokenPresent && <Step5RegisterWebhooks connectionId={connection.id} />}

          {tokenPresent && defaultLocationSet && (
            <Step6DryRun connectionId={connection.id} doNotFanout={connection.do_not_fanout} />
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

function StepBadgeRow({
  connectionId,
  credsConfigured,
  tokenPresent,
  defaultLocationSet,
  doNotFanout,
}: {
  connectionId: string;
  credsConfigured: boolean;
  tokenPresent: boolean;
  defaultLocationSet: boolean;
  doNotFanout: boolean;
}) {
  // Step 4 done = at least one active SKU mapping with a remote_inventory_item_id
  const summary = useAppQuery({
    queryKey: ["sku-mapping-summary", connectionId],
    queryFn: () => getSkuMappingSummary({ connectionId }),
    tier: CACHE_TIERS.SESSION,
  });
  const skuDiscoveryDone = (summary.data?.withInventoryItemId ?? 0) > 0;

  return (
    <div className="flex flex-wrap gap-2">
      <StepBadge label="Step 1: App credentials" done={credsConfigured} />
      <StepBadge label="Step 2: OAuth installed" done={tokenPresent} />
      <StepBadge label="Step 3: Default location" done={defaultLocationSet} />
      <StepBadge label="Step 4: SKU discovery" done={skuDiscoveryDone} />
      {doNotFanout && (
        <Badge variant="outline" className="gap-1">
          <ShieldAlert className="h-3 w-3" />
          Dormant (do_not_fanout)
        </Badge>
      )}
    </div>
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

function Step4SkuDiscovery({ connectionId }: { connectionId: string }) {
  const [report, setReport] = useState<AutoDiscoverShopifySkusReport | null>(null);
  const [showFull, setShowFull] = useState(false);

  const summary = useAppQuery({
    queryKey: ["sku-mapping-summary", connectionId],
    queryFn: () => getSkuMappingSummary({ connectionId }),
    tier: CACHE_TIERS.SESSION,
  });

  const mutation = useAppMutation({
    mutationFn: () => autoDiscoverShopifySkus({ connectionId }),
    invalidateKeys: [["sku-mapping-summary", connectionId]],
    onSuccess: (r) => setReport(r),
  });

  const fmt = (n: number) => n.toLocaleString();

  return (
    <section className="space-y-2 border-t pt-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="font-medium">Step 4 — Discover Shopify SKUs (HRD-03)</h3>
        <Button
          size="sm"
          disabled={mutation.isPending}
          onClick={() => mutation.mutate()}
          variant="outline"
        >
          {mutation.isPending ? (
            <>
              <Loader2 className="h-3 w-3 mr-1 animate-spin" /> Walking Shopify…
            </>
          ) : (
            <>
              <RefreshCw className="h-3 w-3 mr-1" /> {report ? "Re-run discovery" : "Run discovery"}
            </>
          )}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        Walks every product variant in the store, matches by SKU against{" "}
        <code className="rounded bg-muted px-1">warehouse_product_variants</code> for this
        workspace, and writes{" "}
        <code className="rounded bg-muted px-1">client_store_sku_mappings</code>. Read-only against
        Shopify; no inventory pushes. Idempotent — safe to re-run.
      </p>

      {/* Pre-existing summary */}
      {summary.data && !report && (
        <div className="rounded-md border bg-muted/30 p-3 text-xs">
          <p>
            Currently <strong>{fmt(summary.data.totalMappings)}</strong> active mappings (
            <strong>{fmt(summary.data.withInventoryItemId)}</strong> with{" "}
            <code>remote_inventory_item_id</code>)
            {summary.data.lastDiscoveredAt && (
              <>
                {" "}
                · last updated{" "}
                {new Date(summary.data.lastDiscoveredAt).toLocaleString(undefined, {
                  dateStyle: "short",
                  timeStyle: "short",
                })}
              </>
            )}
            .
          </p>
        </div>
      )}

      {mutation.error && (
        <p className="text-red-600 text-xs">
          {mutation.error instanceof Error ? mutation.error.message : "Discovery failed"}
        </p>
      )}

      {report && (
        <div className="space-y-2 rounded-md border bg-muted/30 p-3 text-xs">
          <div className="grid grid-cols-2 gap-x-4 gap-y-1">
            <div>
              Shopify products scanned: <strong>{fmt(report.shopifyProductsScanned)}</strong>
            </div>
            <div>
              Shopify variants scanned: <strong>{fmt(report.shopifyVariantsScanned)}</strong>
            </div>
            <div>
              Workspace SKU universe: <strong>{fmt(report.warehouseSkusInWorkspace)}</strong>
            </div>
            <div>
              Matched: <strong className="text-emerald-700">{fmt(report.matched)}</strong>
            </div>
            <div>
              New mappings created: <strong>{fmt(report.newMappingsCreated)}</strong>
            </div>
            <div>
              Existing mappings updated: <strong>{fmt(report.existingMappingsUpdated)}</strong>
            </div>
            <div>
              Variants without SKU: <strong>{fmt(report.shopifyVariantsWithoutSku)}</strong>
            </div>
            <div>
              Variants without inventoryItem:{" "}
              <strong>{fmt(report.shopifyVariantsWithoutInventoryItem)}</strong>
            </div>
            <div>
              Unmatched Shopify SKUs:{" "}
              <strong className={report.unmatchedShopifySkus.length > 0 ? "text-amber-700" : ""}>
                {fmt(report.unmatchedShopifySkus.length)}
              </strong>
            </div>
            <div>
              Duplicate Shopify SKUs:{" "}
              <strong className={report.duplicateShopifySkus.length > 0 ? "text-red-700" : ""}>
                {fmt(report.duplicateShopifySkus.length)}
              </strong>
            </div>
            <div className="col-span-2">
              Warehouse SKUs not in Shopify (likely Bandcamp/legacy):{" "}
              <strong>{fmt(report.warehouseSkusNotInShopify.length)}</strong>
            </div>
            <div className="col-span-2 text-muted-foreground">
              Walked in {(report.durationMs / 1000).toFixed(1)}s
            </div>
          </div>

          {(report.unmatchedShopifySkus.length > 0 ||
            report.duplicateShopifySkus.length > 0 ||
            report.warehouseSkusNotInShopify.length > 0) && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setShowFull(!showFull)}
              className="h-7 text-xs"
            >
              {showFull ? "Hide details" : "Show details"}
            </Button>
          )}

          {showFull && (
            <div className="space-y-2 border-t pt-2">
              {report.duplicateShopifySkus.length > 0 && (
                <div>
                  <p className="font-medium text-red-700 mb-1">
                    Duplicate Shopify SKUs (Rule #8 violation — multiple Shopify variants share a
                    SKU):
                  </p>
                  <ul className="font-mono text-[11px] max-h-32 overflow-y-auto space-y-0.5">
                    {report.duplicateShopifySkus.slice(0, 30).map((d) => (
                      <li key={d.sku}>
                        {d.sku} → {d.variantIds.length} variants
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {report.unmatchedShopifySkus.length > 0 && (
                <div>
                  <p className="font-medium text-amber-700 mb-1">
                    Unmatched Shopify SKUs (in Shopify, not in warehouse):
                  </p>
                  <ul className="font-mono text-[11px] max-h-32 overflow-y-auto space-y-0.5">
                    {report.unmatchedShopifySkus.slice(0, 50).map((s) => (
                      <li key={s}>{s}</li>
                    ))}
                  </ul>
                </div>
              )}
              {report.warehouseSkusNotInShopify.length > 0 && (
                <div>
                  <p className="font-medium text-muted-foreground mb-1">
                    Warehouse SKUs not in Shopify (informational — may be Bandcamp/legacy):
                  </p>
                  <ul className="font-mono text-[11px] max-h-32 overflow-y-auto space-y-0.5">
                    {report.warehouseSkusNotInShopify.slice(0, 50).map((s) => (
                      <li key={s}>{s}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function Step5RegisterWebhooks({ connectionId }: { connectionId: string }) {
  const [report, setReport] = useState<RegisterShopifyWebhookSubscriptionsReport | null>(null);

  const mutation = useAppMutation({
    mutationFn: () => registerShopifyWebhookSubscriptions({ connectionId }),
    invalidateKeys: [queryKeys.storeConnections.all],
    onSuccess: (r) => setReport(r),
  });

  return (
    <section className="space-y-2 border-t pt-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="font-medium">Step 5 — Register Shopify webhooks (HRD-09.2)</h3>
        <Button
          size="sm"
          disabled={mutation.isPending}
          onClick={() => mutation.mutate()}
          variant="outline"
        >
          {mutation.isPending ? (
            <>
              <Loader2 className="h-3 w-3 mr-1 animate-spin" /> Registering…
            </>
          ) : (
            <>
              <Webhook className="h-3 w-3 mr-1" />{" "}
              {report ? "Re-register webhooks" : "Register webhooks"}
            </>
          )}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        Calls Shopify <code className="rounded bg-muted px-1">webhookSubscriptionCreate</code> for{" "}
        <code className="rounded bg-muted px-1">inventory_levels/update</code>,{" "}
        <code className="rounded bg-muted px-1">orders/create</code>,{" "}
        <code className="rounded bg-muted px-1">orders/cancelled</code>, and{" "}
        <code className="rounded bg-muted px-1">refunds/create</code>. Idempotent — re-running on a
        store that already has these subscriptions reuses the existing rows. The pinned API version
        Shopify reports per subscription is persisted to the connection's metadata for the deferred{" "}
        <code className="rounded bg-muted px-1">shopify-webhook-health-check</code> drift sensor.
      </p>

      {mutation.error && (
        <p className="text-red-600 text-xs">
          {mutation.error instanceof Error ? mutation.error.message : "Webhook registration failed"}
        </p>
      )}

      {report && (
        <div className="space-y-2 rounded-md border bg-muted/30 p-3 text-xs">
          <div className="grid grid-cols-2 gap-x-4 gap-y-1">
            <div>
              Topics registered: <strong>{report.registered.length}</strong>
            </div>
            <div>
              Failed:{" "}
              <strong className={report.failed.length > 0 ? "text-red-700" : ""}>
                {report.failed.length}
              </strong>
            </div>
            <div className="col-span-2">
              Pinned API version:{" "}
              <strong className={report.apiVersionDrift ? "text-amber-700" : ""}>
                {report.apiVersionPinned ?? "—"}
                {report.apiVersionDrift && " (drift detected)"}
              </strong>
            </div>
            <div className="col-span-2 break-all">
              Callback URL: <code className="font-mono">{report.callbackUrl}</code>
            </div>
          </div>

          {report.registered.length > 0 && (
            <div className="border-t pt-2">
              <p className="font-medium mb-1">Subscriptions:</p>
              <ul className="font-mono text-[11px] space-y-0.5">
                {report.registered.map((s) => (
                  <li key={s.id}>
                    {s.topic} — apiVersion={s.apiVersion}{" "}
                    {s.reused ? (
                      <span className="text-muted-foreground">(reused)</span>
                    ) : (
                      <span className="text-emerald-700">(created)</span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {report.failed.length > 0 && (
            <div className="border-t pt-2">
              <p className="font-medium text-red-700 mb-1">Failed:</p>
              <ul className="font-mono text-[11px] space-y-0.5">
                {report.failed.map((f) => (
                  <li key={f.topic}>
                    {f.topic} — {f.error}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function Step6DryRun({
  connectionId,
  doNotFanout,
}: {
  connectionId: string;
  doNotFanout: boolean;
}) {
  const [report, setReport] = useState<DirectShopifyDryRunReport | null>(null);
  const [showFull, setShowFull] = useState(false);

  const mutation = useAppMutation({
    mutationFn: () => runDirectShopifyDryRun({ connectionId }),
    onSuccess: (r) => setReport(r),
  });

  const fmt = (n: number) => n.toLocaleString();

  return (
    <section className="space-y-2 border-t pt-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="font-medium">Step 6 — Dry-run reconciliation (HRD-04 + HRD-18)</h3>
        <Button
          size="sm"
          disabled={mutation.isPending}
          onClick={() => mutation.mutate()}
          variant="outline"
        >
          {mutation.isPending ? (
            <>
              <Loader2 className="h-3 w-3 mr-1 animate-spin" /> Running…
            </>
          ) : (
            <>
              <Play className="h-3 w-3 mr-1" /> {report ? "Re-run dry-run" : "Run dry-run"}
            </>
          )}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        Read-only reconciliation — walks Shopify variants for membership mismatches (HRD-04),
        samples 50 mapped SKUs and compares quantities at the configured default location, and
        estimates webhook bandwidth (HRD-18). The verdict block must show <code>ok=true</code>{" "}
        before flipping <code className="rounded bg-muted px-1">do_not_fanout=false</code>.
      </p>

      {mutation.error && (
        <p className="text-red-600 text-xs">
          {mutation.error instanceof Error ? mutation.error.message : "Dry-run failed"}
        </p>
      )}

      {report && (
        <div className="space-y-2 rounded-md border bg-muted/30 p-3 text-xs">
          {/* Verdict banner */}
          <div
            className={`rounded p-2 ${
              report.verdict.ok
                ? "border border-emerald-200 bg-emerald-50 text-emerald-900"
                : "border border-red-200 bg-red-50 text-red-900"
            }`}
          >
            <p className="font-medium">
              {report.verdict.ok ? "Verdict: OK — safe to flip do_not_fanout" : "Verdict: BLOCKED"}
            </p>
            {report.verdict.fatalReasons.length > 0 && (
              <ul className="mt-1 ml-4 list-disc text-[11px]">
                {report.verdict.fatalReasons.map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
            )}
            {report.verdict.warnings.length > 0 && (
              <details className="mt-1 text-[11px]">
                <summary className="cursor-pointer">
                  {report.verdict.warnings.length} warnings
                </summary>
                <ul className="mt-1 ml-4 list-disc">
                  {report.verdict.warnings.map((w) => (
                    <li key={w}>{w}</li>
                  ))}
                </ul>
              </details>
            )}
            {doNotFanout && report.verdict.ok && (
              <p className="mt-1 text-[11px]">
                Connection is currently dormant (<code>do_not_fanout=true</code>). Use the
                "Reactivate" action on the connection card to flip after reviewing this report.
              </p>
            )}
          </div>

          {/* Membership stats */}
          <div className="grid grid-cols-2 gap-x-4 gap-y-1 border-t pt-2">
            <div>
              Shopify products: <strong>{fmt(report.membership.shopifyProductsScanned)}</strong>
            </div>
            <div>
              Shopify variants: <strong>{fmt(report.membership.shopifyVariantsScanned)}</strong>
            </div>
            <div>
              Workspace SKUs: <strong>{fmt(report.membership.warehouseSkusInWorkspace)}</strong>
            </div>
            <div>
              Matched SKUs:{" "}
              <strong className="text-emerald-700">{fmt(report.membership.matchedSkus)}</strong>
            </div>
            <div>
              Shopify-only SKUs:{" "}
              <strong
                className={report.membership.shopifyOnlySkus.length > 0 ? "text-red-700" : ""}
              >
                {fmt(report.membership.shopifyOnlySkus.length)}
              </strong>
            </div>
            <div>
              Warehouse-only SKUs:{" "}
              <strong>{fmt(report.membership.warehouseOnlySkus.length)}</strong>
            </div>
            <div>
              Duplicate Shopify SKUs:{" "}
              <strong
                className={report.membership.duplicateShopifySkus.length > 0 ? "text-red-700" : ""}
              >
                {fmt(report.membership.duplicateShopifySkus.length)}
              </strong>
            </div>
            <div>
              Variants without SKU:{" "}
              <strong
                className={report.membership.shopifyVariantsWithoutSku > 0 ? "text-red-700" : ""}
              >
                {fmt(report.membership.shopifyVariantsWithoutSku)}
              </strong>
            </div>
          </div>

          {/* Drift stats */}
          <div className="border-t pt-2">
            <p className="font-medium">
              Quantity drift: <strong>{fmt(report.drift.matched)}</strong> matched ·{" "}
              <strong className={report.drift.drifted > 0 ? "text-amber-700" : ""}>
                {fmt(report.drift.drifted)}
              </strong>{" "}
              drifted of {fmt(report.drift.sampled)} sampled (sample size cap{" "}
              {fmt(report.drift.sampleSize)})
            </p>
          </div>

          {/* Bandwidth estimate (HRD-18) */}
          {report.bandwidthEstimate && (
            <div className="border-t pt-2 text-[11px]">
              <p className="font-medium">
                Bandwidth (last {report.bandwidthEstimate.windowDays}d):
              </p>
              <p className="ml-2">
                {fmt(report.bandwidthEstimate.ordersInWindow)} orders ·{" "}
                {report.bandwidthEstimate.avgDailyOrders.toFixed(1)} orders/day ·{" "}
                {report.bandwidthEstimate.estimatedDailyWebhooks.toFixed(0)} webhooks/day · peak{" "}
                {report.bandwidthEstimate.peakHourlyRate.toFixed(0)}/h
              </p>
              <p className="ml-2">
                Recommendation:{" "}
                <strong
                  className={
                    report.bandwidthEstimate.recommendation === "gradual_rollout"
                      ? "text-amber-700"
                      : "text-emerald-700"
                  }
                >
                  {report.bandwidthEstimate.recommendation}
                </strong>
              </p>
            </div>
          )}

          {(report.membership.duplicateShopifySkus.length > 0 ||
            report.membership.shopifyOnlySkus.length > 0 ||
            report.membership.warehouseOnlySkus.length > 0 ||
            report.drift.rows.length > 0) && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setShowFull(!showFull)}
              className="h-7 text-xs"
            >
              {showFull ? "Hide details" : "Show details"}
            </Button>
          )}

          {showFull && (
            <div className="space-y-2 border-t pt-2">
              {report.drift.rows.length > 0 && (
                <div>
                  <p className="font-medium text-amber-700 mb-1">
                    Drift rows (sorted by |diff| desc):
                  </p>
                  <ul className="font-mono text-[11px] max-h-40 overflow-y-auto space-y-0.5">
                    {report.drift.rows.slice(0, 30).map((r) => (
                      <li key={r.sku}>
                        {r.sku} — local {r.localAvailable} · remote{" "}
                        {r.remoteAvailable === null ? "(none)" : r.remoteAvailable} · diff{" "}
                        {r.diff > 0 ? `+${r.diff}` : r.diff} · {r.reason}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {report.membership.duplicateShopifySkus.length > 0 && (
                <div>
                  <p className="font-medium text-red-700 mb-1">Duplicate Shopify SKUs:</p>
                  <ul className="font-mono text-[11px] max-h-32 overflow-y-auto space-y-0.5">
                    {report.membership.duplicateShopifySkus.slice(0, 30).map((d) => (
                      <li key={d.sku}>
                        {d.sku} → {d.variantIds.length} variants
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {report.membership.shopifyOnlySkus.length > 0 && (
                <div>
                  <p className="font-medium text-red-700 mb-1">Shopify-only SKUs (fatal):</p>
                  <ul className="font-mono text-[11px] max-h-32 overflow-y-auto space-y-0.5">
                    {report.membership.shopifyOnlySkus.slice(0, 50).map((s) => (
                      <li key={s}>{s}</li>
                    ))}
                  </ul>
                </div>
              )}
              {report.membership.warehouseOnlySkus.length > 0 && (
                <div>
                  <p className="font-medium text-muted-foreground mb-1">
                    Warehouse-only SKUs (informational):
                  </p>
                  <ul className="font-mono text-[11px] max-h-32 overflow-y-auto space-y-0.5">
                    {report.membership.warehouseOnlySkus.slice(0, 50).map((s) => (
                      <li key={s}>{s}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}

          <p className="text-[11px] text-muted-foreground">
            Generated {new Date(report.generatedAt).toLocaleString()} · ran in{" "}
            {(report.durationMs / 1000).toFixed(1)}s · default location{" "}
            <code className="font-mono">{report.defaultLocationId}</code>
          </p>
        </div>
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
