"use client";

import {
  AlertTriangle,
  Ban,
  CheckCircle2,
  ExternalLink,
  Link2,
  RefreshCw,
  Search,
  ShieldAlert,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import {
  acceptExactMatches,
  activateShopifyInventoryAtDefaultLocation,
  createOrUpdateSkuMatch,
  deactivateSkuMatch,
  enableSkuMatchingFeatureFlag,
  previewSkuMatch,
  rejectSkuMatchCandidate,
  type SkuMatchingClientSummary,
  type SkuMatchingConnectionSummary,
  type SkuMatchingRow,
  type SkuMatchingWorkspaceData,
  type SkuRemoteCatalogSearchResult,
  searchSkuRemoteCatalog,
} from "@/actions/sku-matching";
import { BlockList } from "@/components/shared/block-list";
import { EmptyState } from "@/components/shared/empty-state";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useAppMutation } from "@/lib/hooks/use-app-query";

type TabKey = "needs-review" | "matched" | "remote-only" | "conflicts";

const SKU_MATCHING_FULL_RENDER_LIMIT = 2000;
const SKU_MATCHING_LARGE_CATALOG_WARNING_THRESHOLD = 1500;

function toPlainServerActionInput<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function formatActionError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function remoteProductLinkLabel(platform: string): string {
  return platform === "shopify" ? "Open Shopify product" : "Open remote product";
}

function remoteSearchResultKey(item: SkuRemoteCatalogSearchResult): string {
  return (
    item.remoteInventoryItemId ??
    item.remoteVariantId ??
    item.remoteProductId ??
    item.remoteSku ??
    item.combinedTitle
  );
}

function formatUtcDateTime(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date
    .toISOString()
    .replace("T", " ")
    .replace(/\.\d{3}Z$/, " UTC");
}

function StatusBadge({ status }: { status: SkuMatchingRow["rowStatus"] }) {
  const tone =
    status === "matched_active"
      ? "default"
      : status.startsWith("conflict_") || status === "shopify_not_ready"
        ? "destructive"
        : "secondary";
  return (
    <Badge variant={tone === "destructive" ? "destructive" : tone}>
      {status.replace(/_/g, " ")}
    </Badge>
  );
}

function ConfidenceBadge({ value }: { value: string | null }) {
  if (!value) return <Badge variant="outline">unscored</Badge>;
  const variant =
    value === "deterministic" ? "default" : value === "strong" ? "secondary" : "outline";
  return <Badge variant={variant}>{value}</Badge>;
}

function buildQuery(params: Record<string, string | null | undefined>) {
  const searchParams = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value) searchParams.set(key, value);
  }
  return `?${searchParams.toString()}`;
}

export function SkuMatchingClient({
  clients,
  connections,
  workspace,
  selectedOrgId,
}: {
  clients: SkuMatchingClientSummary[];
  connections: SkuMatchingConnectionSummary[];
  workspace: SkuMatchingWorkspaceData;
  selectedOrgId: string | null;
}) {
  const router = useRouter();
  const activeConnectionId = workspace.connection.id;
  const [tab, setTab] = useState<TabKey>("needs-review");
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [pendingRowIds, setPendingRowIds] = useState<Set<string>>(new Set());
  const [remoteSearchQuery, setRemoteSearchQuery] = useState("");
  const [manualSelectedRemoteKey, setManualSelectedRemoteKey] = useState<string | null>(null);

  const enableFlagMutation = useAppMutation({
    mutationFn: () => enableSkuMatchingFeatureFlag(),
    onSuccess: () => router.refresh(),
  });

  const previewMutation = useAppMutation({
    mutationFn: (input: {
      variantId: string;
      remoteProductId?: string | null;
      remoteVariantId?: string | null;
      remoteInventoryItemId?: string | null;
      remoteSku?: string | null;
    }) =>
      previewSkuMatch(
        toPlainServerActionInput({
          connectionId: activeConnectionId,
          variantId: input.variantId,
          remoteProductId: input.remoteProductId,
          remoteVariantId: input.remoteVariantId,
          remoteInventoryItemId: input.remoteInventoryItemId,
          remoteSku: input.remoteSku,
        }),
      ),
    onError: (error) => setPreviewError(formatActionError(error)),
  });

  const remoteSearchMutation = useAppMutation({
    mutationFn: (input: { query: string }) =>
      searchSkuRemoteCatalog(
        toPlainServerActionInput({
          connectionId: activeConnectionId,
          query: input.query,
          limit: 25,
        }),
      ),
    onError: (error) => setPreviewError(formatActionError(error)),
  });

  const upsertMutation = useAppMutation({
    mutationFn: (input: Parameters<typeof createOrUpdateSkuMatch>[0]) =>
      createOrUpdateSkuMatch(toPlainServerActionInput(input)),
    onSuccess: () => {
      setPreviewOpen(false);
      setPreviewError(null);
      setMutationError(null);
      router.refresh();
    },
    onError: (error) => {
      const message = formatActionError(error);
      setMutationError(message);
      if (previewOpen) setPreviewError(message);
    },
  });

  const deactivateMutation = useAppMutation({
    mutationFn: (input: Parameters<typeof deactivateSkuMatch>[0]) =>
      deactivateSkuMatch(toPlainServerActionInput(input)),
    onSuccess: () => router.refresh(),
  });

  const rejectCandidateMutation = useAppMutation({
    mutationFn: (input: Parameters<typeof rejectSkuMatchCandidate>[0]) =>
      rejectSkuMatchCandidate(toPlainServerActionInput(input)),
    onSuccess: () => {
      setPreviewOpen(false);
      setPreviewError(null);
      setMutationError(null);
      router.refresh();
    },
    onError: (error) => {
      const message = formatActionError(error);
      setMutationError(message);
      setPreviewError(message);
    },
  });

  const activateShopifyMutation = useAppMutation({
    mutationFn: (input: Parameters<typeof activateShopifyInventoryAtDefaultLocation>[0]) =>
      activateShopifyInventoryAtDefaultLocation(toPlainServerActionInput(input)),
    onSuccess: () => router.refresh(),
  });

  const bulkAcceptMutation = useAppMutation({
    mutationFn: (input: Parameters<typeof acceptExactMatches>[0]) =>
      acceptExactMatches(toPlainServerActionInput(input)),
    onSuccess: () => {
      setSelectedKeys(new Set());
      router.refresh();
    },
  });

  const needsReviewRows = workspace.rows.filter((row) =>
    [
      "needs_review_no_candidate",
      "needs_review_low_confidence",
      "needs_review_multiple_candidates",
    ].includes(row.rowStatus),
  );
  const matchedRows = workspace.rows.filter((row) => row.rowStatus === "matched_active");

  const bulkAcceptableRows = useMemo(
    () =>
      needsReviewRows.filter(
        (row) =>
          row.topCandidate?.confidenceTier === "deterministic" &&
          row.topCandidate.disqualifiers.length === 0 &&
          row.topCandidate.remote.remoteProductId,
      ),
    [needsReviewRows],
  );

  const previewData = previewMutation.data;
  const manualPreviewSelected = Boolean(
    previewData?.targetRemote &&
      manualSelectedRemoteKey === remoteSearchResultKey(previewData.targetRemote),
  );

  useEffect(() => {
    setSelectedKeys(new Set());
    setPreviewOpen(false);
    setPreviewError(null);
    setMutationError(null);
    setPendingRowIds(new Set());
    setRemoteSearchQuery("");
    setManualSelectedRemoteKey(null);
    previewMutation.reset();
    remoteSearchMutation.reset();
    upsertMutation.reset();
    if (activeConnectionId && typeof window !== "undefined") {
      window.scrollTo({ top: 0, behavior: "auto" });
    }
  }, [activeConnectionId, previewMutation.reset, remoteSearchMutation.reset, upsertMutation.reset]);

  useEffect(() => {
    const rowCount = workspace.rows.length + workspace.remoteOnlyRows.length;
    if (rowCount >= SKU_MATCHING_LARGE_CATALOG_WARNING_THRESHOLD) {
      console.info("SKU matching catalog approaching virtualization threshold", {
        connection_id: activeConnectionId,
        row_count: rowCount,
        threshold: SKU_MATCHING_FULL_RENDER_LIMIT,
      });
    }
  }, [activeConnectionId, workspace.remoteOnlyRows.length, workspace.rows.length]);

  function navigate(next: { orgId?: string | null; connectionId?: string | null }) {
    router.push(
      buildQuery({
        orgId: next.orgId === undefined ? selectedOrgId : next.orgId,
        connectionId: next.connectionId === undefined ? activeConnectionId : next.connectionId,
      }),
    );
  }

  function openPreview(row: SkuMatchingRow) {
    setPreviewError(null);
    setRemoteSearchQuery("");
    setManualSelectedRemoteKey(null);
    remoteSearchMutation.reset();
    setPreviewOpen(true);
    previewMutation.mutate({
      variantId: row.variantId,
      remoteProductId: row.remoteProductId,
      remoteVariantId: row.remoteVariantId,
      remoteInventoryItemId: row.remoteInventoryItemId,
      remoteSku: row.remoteSku,
    });
  }

  function runRemoteSearch() {
    const query = remoteSearchQuery.trim();
    if (query.length < 2) {
      setPreviewError("Enter at least 2 characters to search the remote catalog.");
      return;
    }
    setPreviewError(null);
    remoteSearchMutation.mutate({ query });
  }

  function previewRemoteSearchResult(item: SkuRemoteCatalogSearchResult) {
    const variantId = previewData?.canonical.variantId;
    if (!variantId) return;
    setPreviewError(null);
    const selectedKey = remoteSearchResultKey(item);
    setManualSelectedRemoteKey(selectedKey);
    previewMutation.mutate({
      variantId,
      remoteProductId: item.remoteProductId,
      remoteVariantId: item.remoteVariantId,
      remoteInventoryItemId: item.remoteInventoryItemId,
      remoteSku: item.remoteSku,
    });
  }

  async function acceptBestMatch(
    row: SkuMatchingRow,
    candidate: NonNullable<SkuMatchingRow["topCandidate"]>,
  ) {
    setMutationError(null);
    setPendingRowIds((prev) => new Set(prev).add(row.variantId));
    try {
      await upsertMutation.mutateAsync(
        toPlainServerActionInput({
          connectionId: activeConnectionId,
          variantId: row.variantId,
          remoteProductId: candidate.remote.remoteProductId ?? null,
          remoteVariantId: candidate.remote.remoteVariantId ?? null,
          remoteInventoryItemId: candidate.remote.remoteInventoryItemId ?? null,
          remoteSku: candidate.remote.remoteSku ?? null,
          fingerprint: row.candidateFingerprint,
          matchMethod: candidate.matchMethod === "manual" ? "manual" : candidate.matchMethod,
          matchConfidence: candidate.confidenceTier,
          matchReasons: [...candidate.reasons],
          candidateSnapshot: {
            remoteTitle: candidate.remote.combinedTitle,
            reasons: [...candidate.reasons],
            disqualifiers: [...candidate.disqualifiers],
            score: candidate.score,
          },
          notes: null,
        }),
      );
    } catch (error) {
      setMutationError(formatActionError(error));
    } finally {
      setPendingRowIds((prev) => {
        const next = new Set(prev);
        next.delete(row.variantId);
        return next;
      });
    }
  }

  function renderRows(rows: SkuMatchingRow[], emptyDescription: string) {
    return (
      <BlockList
        items={rows}
        itemKey={(row) => row.variantId}
        selectable={tab === "needs-review"}
        selectedKeys={selectedKeys}
        onSelectedKeysChange={(keys) => setSelectedKeys(new Set(Array.from(keys).map(String)))}
        emptyState={<EmptyState title="Nothing here" description={emptyDescription} />}
        virtualizeThreshold={SKU_MATCHING_FULL_RENDER_LIMIT}
        footerNode={
          rows.length >= SKU_MATCHING_FULL_RENDER_LIMIT ? (
            <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950">
              This connection has a very large catalog. Use the tabs and browser search to narrow
              review before loading more dense rows.
            </div>
          ) : null
        }
        bulkActionRail={({ selectedCount, clearSelection }) => (
          <div className="flex items-center gap-2">
            <span className="text-sm text-muted-foreground">{selectedCount} selected</span>
            <Button
              size="sm"
              disabled={
                selectedCount === 0 ||
                bulkAcceptMutation.isPending ||
                Array.from(selectedKeys).some(
                  (key) => !bulkAcceptableRows.some((row) => row.variantId === String(key)),
                )
              }
              onClick={() =>
                bulkAcceptMutation.mutate({
                  connectionId: activeConnectionId,
                  items: Array.from(selectedKeys)
                    .map((key) => needsReviewRows.find((row) => row.variantId === String(key)))
                    .filter((row): row is SkuMatchingRow => Boolean(row))
                    .map((row) => ({
                      variantId: row.variantId,
                      remoteProductId: row.topCandidate?.remote.remoteProductId ?? null,
                      remoteVariantId: row.topCandidate?.remote.remoteVariantId ?? null,
                      remoteInventoryItemId: row.topCandidate?.remote.remoteInventoryItemId ?? null,
                      remoteSku: row.topCandidate?.remote.remoteSku ?? null,
                      fingerprint: row.candidateFingerprint,
                    })),
                })
              }
            >
              Bulk accept deterministic
            </Button>
            <Button size="sm" variant="ghost" onClick={clearSelection}>
              Clear
            </Button>
          </div>
        )}
        renderHeader={({ row }) => (
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="outline" className="font-mono">
                {row.canonicalSku}
              </Badge>
              <StatusBadge status={row.rowStatus} />
              <ConfidenceBadge
                value={row.matchConfidence ?? row.topCandidate?.confidenceTier ?? null}
              />
            </div>
            <p className="mt-2 font-medium">
              {row.artist ? `${row.artist} - ${row.canonicalTitle}` : row.canonicalTitle}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              {row.format ?? "Unknown format"}
              {row.bandcampTitle ? ` · Bandcamp: ${row.bandcampTitle}` : ""}
              {row.variantTitle ? ` · Variant: ${row.variantTitle}` : ""}
            </p>
          </div>
        )}
        renderExceptionZone={({ row }) => (
          <div className="flex flex-wrap items-center gap-2">
            {row.remoteSku ? (
              <Badge variant="secondary" className="font-mono">
                remote {row.remoteSku}
              </Badge>
            ) : (
              <Badge variant="outline">No remote match yet</Badge>
            )}
            <Badge variant="outline">
              available {row.available} / committed {row.committed}
            </Badge>
            {row.discogs && (
              <Badge variant="outline" className="gap-1">
                Discogs #{row.discogs.releaseId}
              </Badge>
            )}
          </div>
        )}
        renderBody={({ row }) => (
          <div className="grid gap-2 text-sm md:grid-cols-2">
            <div>
              <div className="text-xs uppercase tracking-wide text-muted-foreground">
                Best candidate
              </div>
              {row.topCandidate ? (
                <div className="mt-1">
                  <div className="font-medium">{row.topCandidate.remote.combinedTitle}</div>
                  <div className="text-xs text-muted-foreground">
                    score {row.topCandidate.score}
                    {row.topCandidate.remote.remoteSku
                      ? ` · SKU ${row.topCandidate.remote.remoteSku}`
                      : ""}
                    {row.topCandidate.remote.barcode
                      ? ` · barcode ${row.topCandidate.remote.barcode}`
                      : ""}
                  </div>
                  <div className="mt-1 text-xs text-muted-foreground">
                    {row.topCandidate.reasons.join(" · ") || "No supporting reasons recorded"}
                  </div>
                  {row.topCandidate.disqualifiers.length > 0 && (
                    <div className="mt-1 text-xs text-destructive">
                      Disqualifiers: {row.topCandidate.disqualifiers.join(", ")}
                    </div>
                  )}
                </div>
              ) : (
                <div className="mt-1 text-muted-foreground">
                  No candidate found from the remote catalog.
                </div>
              )}
            </div>
            <div>
              <div className="text-xs uppercase tracking-wide text-muted-foreground">
                Linked ids
              </div>
              <div className="mt-1 space-y-1 text-xs text-muted-foreground">
                <div>product: {row.remoteProductId ?? "none"}</div>
                <div>variant: {row.remoteVariantId ?? "none"}</div>
                <div>inventory item: {row.remoteInventoryItemId ?? "none"}</div>
                <div>barcode: {row.barcode ?? "none"}</div>
                <div className="flex flex-wrap gap-2 pt-1">
                  {row.topCandidate?.remote.productUrl ? (
                    <a
                      href={row.topCandidate.remote.productUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 text-foreground underline underline-offset-2"
                    >
                      {remoteProductLinkLabel(row.topCandidate.remote.platform)}{" "}
                      <ExternalLink className="h-3 w-3" />
                    </a>
                  ) : null}
                  {row.bandcampUrl ? (
                    <a
                      href={row.bandcampUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 text-foreground underline underline-offset-2"
                    >
                      Open Bandcamp product <ExternalLink className="h-3 w-3" />
                    </a>
                  ) : null}
                </div>
              </div>
            </div>
          </div>
        )}
        renderActions={({ row, actionContext }) => (
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={actionContext.pendingActions.has("preview")}
              onClick={() =>
                actionContext.runAction("preview", async () => {
                  openPreview(row);
                })
              }
            >
              Review
            </Button>
            {row.topCandidate &&
              (() => {
                const candidate = row.topCandidate;
                return (
                  <Button
                    size="sm"
                    disabled={
                      pendingRowIds.has(row.variantId) || actionContext.pendingActions.has("accept")
                    }
                    onClick={() =>
                      actionContext.runAction("accept", () => acceptBestMatch(row, candidate))
                    }
                  >
                    {pendingRowIds.has(row.variantId) ? "Accepting..." : "Accept best match"}
                  </Button>
                );
              })()}
            {row.existingMappingId && (
              <Button
                size="sm"
                variant="ghost"
                disabled={deactivateMutation.isPending}
                onClick={() => {
                  if (!row.existingMappingId) return;
                  deactivateMutation.mutate({
                    mappingId: row.existingMappingId,
                    reason: "manual_unmatch",
                    notes: "Removed from SKU matching workspace",
                  });
                }}
              >
                Unmatch
              </Button>
            )}
          </div>
        )}
      />
    );
  }

  return (
    <div className="space-y-4 p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">SKU Matching</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Review one client connection at a time and create alias-style product identity matches
            without rewriting remote SKUs.
          </p>
        </div>
        {!workspace.featureEnabled && (
          <Button
            disabled={enableFlagMutation.isPending}
            onClick={() => enableFlagMutation.mutate()}
          >
            Enable feature flag
          </Button>
        )}
      </div>

      {!workspace.featureEnabled && (
        <div className="rounded-md border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950">
          <div className="flex items-start gap-2">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <div>
              <div className="font-medium">Feature flag is off for this workspace.</div>
              <div className="mt-1">
                You can still inspect the server-rendered bootstrap, but the intended rollout path
                is to enable `sku_matching_enabled` before broader staff use.
              </div>
            </div>
          </div>
        </div>
      )}

      <div className="grid gap-3 md:grid-cols-4">
        <label className="space-y-1 text-sm">
          <span className="text-muted-foreground">Client</span>
          <select
            className="h-9 w-full rounded-md border bg-background px-3"
            value={selectedOrgId ?? workspace.connection.orgId}
            onChange={(event) => navigate({ orgId: event.target.value, connectionId: null })}
          >
            {clients.map((client) => (
              <option key={client.id} value={client.id}>
                {client.name}
              </option>
            ))}
          </select>
        </label>
        <label className="space-y-1 text-sm md:col-span-2">
          <span className="text-muted-foreground">Connection</span>
          <select
            className="h-9 w-full rounded-md border bg-background px-3"
            value={workspace.connection.id}
            onChange={(event) => navigate({ connectionId: event.target.value })}
          >
            {connections.map((connection) => (
              <option key={connection.id} value={connection.id}>
                {connection.orgName} · {connection.platform} · {connection.storeUrl}
              </option>
            ))}
          </select>
        </label>
        <div className="space-y-1 text-sm">
          <span className="text-muted-foreground">Connection state</span>
          <div className="rounded-md border bg-card px-3 py-2">
            <div className="font-medium">{workspace.connection.connectionStatus}</div>
            <div className="text-xs text-muted-foreground">
              {workspace.connection.platform === "shopify"
                ? workspace.connection.defaultLocationId
                  ? `Default location ${workspace.connection.defaultLocationId}`
                  : "No default Shopify location"
                : `${workspace.connection.activeMappingCount} active mappings`}
            </div>
          </div>
        </div>
      </div>

      <div className="grid gap-3 md:grid-cols-4">
        <SummaryCard label="Needs review" value={workspace.needsReviewCount} />
        <SummaryCard label="Matched" value={workspace.matchedCount} />
        <SummaryCard label="Remote only" value={workspace.remoteOnlyCount} />
        <SummaryCard
          label="Conflicts"
          value={workspace.conflictCount}
          danger={workspace.conflictCount > 0}
        />
      </div>

      <div
        className={`rounded-md border p-4 text-sm ${
          workspace.remoteCatalogState === "ok"
            ? "border-emerald-200 bg-emerald-50 text-emerald-950"
            : "border-amber-300 bg-amber-50 text-amber-950"
        }`}
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="font-medium">Remote catalog status: {workspace.remoteCatalogState}</div>
            <div className="mt-1 text-xs">
              {workspace.remoteCatalogState === "ok"
                ? `Fetched ${workspace.rows.length + workspace.remoteOnlyRows.length} total candidate rows${workspace.fetchedAt ? ` at ${formatUtcDateTime(workspace.fetchedAt)}` : ""}.`
                : (workspace.remoteCatalogError ??
                  "The remote catalog could not be fetched for matching.")}
            </div>
          </div>
          <Button variant="outline" size="sm" onClick={() => router.refresh()}>
            <RefreshCw className="mr-1 h-4 w-4" /> Refresh
          </Button>
        </div>
      </div>

      {mutationError && (
        <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
          <div className="font-medium">SKU match action failed</div>
          <div className="mt-1 break-words">{mutationError}</div>
        </div>
      )}

      <Tabs value={tab} onValueChange={(value) => setTab(value as TabKey)}>
        <TabsList>
          <TabsTrigger value="needs-review">Needs review</TabsTrigger>
          <TabsTrigger value="matched">Matched</TabsTrigger>
          <TabsTrigger value="remote-only">Remote only</TabsTrigger>
          <TabsTrigger value="conflicts">Conflicts</TabsTrigger>
        </TabsList>

        <TabsContent value="needs-review" className="pt-2">
          {renderRows(
            needsReviewRows,
            "No unmatched or low-confidence canonical rows remain for this connection.",
          )}
        </TabsContent>

        <TabsContent value="matched" className="pt-2">
          {renderRows(matchedRows, "No active matches exist for this connection yet.")}
        </TabsContent>

        <TabsContent value="remote-only" className="pt-2">
          <BlockList
            items={workspace.remoteOnlyRows}
            itemKey={(row, index) => `${row.remoteProductId}:${row.remoteVariantId ?? index}`}
            virtualizeThreshold={SKU_MATCHING_FULL_RENDER_LIMIT}
            emptyState={
              <EmptyState
                title="No remote-only rows"
                description="Every remote item with a usable key is already mapped."
              />
            }
            renderHeader={({ row }) => (
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="secondary">{row.platform}</Badge>
                  {row.remoteSku ? (
                    <Badge variant="outline" className="font-mono">
                      {row.remoteSku}
                    </Badge>
                  ) : (
                    <Badge variant="outline">No SKU</Badge>
                  )}
                </div>
                <div className="mt-2 font-medium">{row.combinedTitle}</div>
              </div>
            )}
            renderBody={({ row }) => (
              <div className="grid gap-2 text-sm md:grid-cols-2">
                <div className="text-muted-foreground">
                  product {row.remoteProductId}
                  <br />
                  variant {row.remoteVariantId ?? "none"}
                  <br />
                  inventory item {row.remoteInventoryItemId ?? "none"}
                </div>
                <div className="text-muted-foreground">
                  {row.barcode ? `barcode ${row.barcode}` : "No barcode"}
                  <br />
                  {row.price != null ? `price ${row.price}` : "No price"}
                  <br />
                  {row.quantity != null ? `qty ${row.quantity}` : "Quantity unavailable"}
                </div>
              </div>
            )}
            renderActions={({ row }) => (
              <div className="flex gap-2">
                {row.productUrl && (
                  <a
                    href={row.productUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex h-9 items-center rounded-md border px-3 text-sm"
                  >
                    <ExternalLink className="mr-1 h-4 w-4" /> Open
                  </a>
                )}
              </div>
            )}
          />
        </TabsContent>

        <TabsContent value="conflicts" className="space-y-4 pt-2">
          <div className="rounded-md border bg-card p-4">
            <div className="font-medium">Remote-to-canonical duplicates</div>
            <div className="mt-2 space-y-2 text-sm">
              {workspace.remoteDuplicateConflicts.length === 0 ? (
                <div className="text-muted-foreground">
                  No duplicate remote ids are currently reported.
                </div>
              ) : (
                workspace.remoteDuplicateConflicts.map((row) => (
                  <div
                    key={`${row.remote_key ?? "remote"}:${(row.mapping_ids ?? []).join(",")}`}
                    className="rounded border p-2"
                  >
                    <div className="font-mono text-xs">
                      {row.remote_key ?? "unknown remote key"}
                    </div>
                    <div className="text-muted-foreground">
                      {row.row_count ?? 0} rows · {(row.mapping_ids ?? []).join(", ")}
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>

          <div className="rounded-md border bg-card p-4">
            <div className="font-medium">Canonical duplicates</div>
            <div className="mt-2 space-y-2 text-sm">
              {workspace.canonicalDuplicateConflicts.length === 0 ? (
                <div className="text-muted-foreground">
                  No duplicate canonical mappings are currently reported.
                </div>
              ) : (
                workspace.canonicalDuplicateConflicts.map((row) => (
                  <div
                    key={`${row.canonical_sku ?? "sku"}:${(row.mapping_ids ?? []).join(",")}`}
                    className="rounded border p-2"
                  >
                    <div className="font-mono text-xs">{row.canonical_sku ?? "unknown sku"}</div>
                    <div className="text-muted-foreground">
                      {row.row_count ?? 0} rows · {(row.mapping_ids ?? []).join(", ")}
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>

          <div className="rounded-md border bg-card p-4">
            <div className="font-medium">Existing SKU sync conflicts</div>
            <div className="mt-2 space-y-2 text-sm">
              {workspace.existingSyncConflicts.length === 0 ? (
                <div className="text-muted-foreground">
                  No open rows from `sku_sync_conflicts` are currently linked by SKU.
                </div>
              ) : (
                workspace.existingSyncConflicts.map((row) => (
                  <div key={row.id} className="rounded border p-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant="outline">{row.conflict_type}</Badge>
                      <Badge variant="outline">{row.severity}</Badge>
                      <Badge variant="outline">{row.status}</Badge>
                      {row.our_sku && <Badge variant="secondary">{row.our_sku}</Badge>}
                    </div>
                    <div className="mt-1 text-muted-foreground">
                      {row.example_product_title ?? "No title snapshot"}
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </TabsContent>
      </Tabs>

      <Dialog open={previewOpen} onOpenChange={setPreviewOpen}>
        <DialogContent className="max-h-[calc(100dvh-1rem)] w-[calc(100vw-1rem)] max-w-[calc(100vw-1rem)] overflow-x-hidden overflow-y-auto sm:max-w-4xl">
          <DialogHeader>
            <DialogTitle>Preview match</DialogTitle>
          </DialogHeader>

          {previewMutation.isPending ? (
            <div className="py-8 text-sm text-muted-foreground">Loading preview...</div>
          ) : previewData ? (
            <div className="min-w-0 space-y-4 text-sm">
              <div className="min-w-0 overflow-hidden rounded-md border bg-card p-4">
                <div className="break-words font-medium">
                  {previewData.canonical.artist
                    ? `${previewData.canonical.artist} - ${previewData.canonical.title}`
                    : previewData.canonical.title}
                </div>
                <div className="mt-1 break-words text-xs text-muted-foreground">
                  SKU {previewData.canonical.sku}
                  {previewData.canonical.barcode
                    ? ` · barcode ${previewData.canonical.barcode}`
                    : ""}
                  {previewData.canonical.format ? ` · ${previewData.canonical.format}` : ""}
                </div>
                {previewData.canonical.bandcampUrl ? (
                  <a
                    href={previewData.canonical.bandcampUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="mt-2 inline-flex items-center gap-1 text-xs underline underline-offset-2"
                  >
                    Open Bandcamp product <ExternalLink className="h-3 w-3" />
                  </a>
                ) : null}
              </div>

              <div className="min-w-0 overflow-hidden rounded-md border bg-card p-4">
                <div className="font-medium">Search remote catalog</div>
                <div className="mt-1 text-xs text-muted-foreground">
                  Search by title, SKU, artist, barcode, product ID, variant ID, or inventory item
                  ID.
                </div>
                <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                  <Input
                    className="min-w-0"
                    value={remoteSearchQuery}
                    onChange={(event) => setRemoteSearchQuery(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        runRemoteSearch();
                      }
                    }}
                    placeholder="e.g. album title, NS-001, barcode, gid://shopify/Product/..."
                  />
                  <Button
                    type="button"
                    variant="outline"
                    disabled={remoteSearchMutation.isPending}
                    onClick={runRemoteSearch}
                  >
                    <Search className="mr-1 h-4 w-4" /> Search
                  </Button>
                </div>
                {remoteSearchMutation.data ? (
                  <div className="mt-3 max-h-80 space-y-2 overflow-x-hidden overflow-y-auto pr-1">
                    {remoteSearchMutation.data.results.length === 0 ? (
                      <div className="rounded-md border border-dashed p-3 text-xs text-muted-foreground">
                        No remote catalog results matched that search.
                      </div>
                    ) : (
                      remoteSearchMutation.data.results.map((item) => {
                        const selected = manualSelectedRemoteKey === remoteSearchResultKey(item);
                        return (
                          <div
                            key={remoteSearchResultKey(item)}
                            className={`min-w-0 overflow-hidden rounded-md border p-3 ${selected ? "border-primary bg-primary/5" : ""}`}
                          >
                            <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                              <div className="min-w-0">
                                <div className="break-words font-medium">{item.combinedTitle}</div>
                                <div className="mt-1 break-all text-xs text-muted-foreground">
                                  product {item.remoteProductId}
                                  {item.remoteVariantId ? ` · variant ${item.remoteVariantId}` : ""}
                                  {item.remoteInventoryItemId
                                    ? ` · inventory ${item.remoteInventoryItemId}`
                                    : ""}
                                </div>
                                <div className="mt-1 break-words text-xs text-muted-foreground">
                                  {item.remoteSku ? `SKU ${item.remoteSku}` : "No remote SKU"}
                                  {item.barcode ? ` · barcode ${item.barcode}` : ""}
                                  {item.productType ? ` · ${item.productType}` : ""}
                                </div>
                              </div>
                              <Button
                                type="button"
                                size="sm"
                                variant={selected ? "default" : "outline"}
                                className="shrink-0"
                                onClick={() => previewRemoteSearchResult(item)}
                              >
                                {selected ? "Selected" : "Preview this match"}
                              </Button>
                            </div>
                          </div>
                        );
                      })
                    )}
                  </div>
                ) : null}
              </div>

              {previewData.targetError ? (
                <div className="rounded-md border border-amber-300 bg-amber-50 p-4 text-amber-950">
                  {previewData.targetError.message}
                </div>
              ) : previewData.targetRemote ? (
                <div className="min-w-0 overflow-hidden rounded-md border bg-card p-4">
                  <div className="break-words font-medium">
                    {previewData.targetRemote.combinedTitle}
                  </div>
                  <div className="mt-1 break-all text-xs text-muted-foreground">
                    product {previewData.targetRemote.remoteProductId}
                    {previewData.targetRemote.remoteVariantId
                      ? ` · variant ${previewData.targetRemote.remoteVariantId}`
                      : ""}
                    {previewData.targetRemote.remoteInventoryItemId
                      ? ` · inventory ${previewData.targetRemote.remoteInventoryItemId}`
                      : ""}
                  </div>
                  {previewData.targetRemote.productUrl ? (
                    <a
                      href={previewData.targetRemote.productUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="mt-2 inline-flex items-center gap-1 text-xs underline underline-offset-2"
                    >
                      {remoteProductLinkLabel(previewData.targetRemote.platform)}{" "}
                      <ExternalLink className="h-3 w-3" />
                    </a>
                  ) : null}
                  {previewData.candidate && (
                    <div className="mt-2 text-xs text-muted-foreground">
                      {previewData.candidate.reasons.join(" · ") || "No reasons recorded"}
                    </div>
                  )}
                </div>
              ) : (
                <div className="rounded-md border border-amber-300 bg-amber-50 p-4 text-amber-950">
                  This row does not have a selected remote item yet. Use the best-match action from
                  the table first.
                </div>
              )}

              {previewData.shopifyReadiness && (
                <div
                  className={`rounded-md border p-4 ${
                    previewData.shopifyReadiness.state === "ready_at_default_location"
                      ? "border-emerald-200 bg-emerald-50"
                      : "border-amber-300 bg-amber-50"
                  }`}
                >
                  <div className="flex items-center gap-2 font-medium">
                    {previewData.shopifyReadiness.state === "ready_at_default_location" ? (
                      <CheckCircle2 className="h-4 w-4 text-emerald-700" />
                    ) : (
                      <ShieldAlert className="h-4 w-4 text-amber-700" />
                    )}
                    Shopify readiness: {previewData.shopifyReadiness.state}
                  </div>
                  <div className="mt-1 text-xs text-muted-foreground">
                    {previewData.shopifyReadiness.message}
                  </div>
                </div>
              )}

              {(previewError || upsertMutation.error) && (
                <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
                  {previewError ??
                    (upsertMutation.error instanceof Error
                      ? upsertMutation.error.message
                      : "Match failed")}
                </div>
              )}

              <div className="sticky bottom-0 z-10 flex min-w-0 flex-wrap gap-2 rounded-md border bg-background/95 p-3 backdrop-blur">
                <Button
                  disabled={
                    !previewData.targetRemote ||
                    Boolean(previewData.targetError) ||
                    upsertMutation.isPending
                  }
                  onClick={() =>
                    upsertMutation.mutate(
                      toPlainServerActionInput({
                        connectionId: activeConnectionId,
                        variantId: previewData.canonical.variantId,
                        remoteProductId: previewData.targetRemote?.remoteProductId ?? null,
                        remoteVariantId: previewData.targetRemote?.remoteVariantId ?? null,
                        remoteInventoryItemId:
                          previewData.targetRemote?.remoteInventoryItemId ?? null,
                        remoteSku: previewData.targetRemote?.remoteSku ?? null,
                        fingerprint: previewData.fingerprint,
                        matchMethod: manualPreviewSelected
                          ? "manual"
                          : previewData.candidate?.matchMethod === "manual"
                            ? "manual"
                            : (previewData.candidate?.matchMethod ?? "manual"),
                        matchConfidence: manualPreviewSelected
                          ? "strong"
                          : (previewData.candidate?.confidenceTier ?? "possible"),
                        matchReasons: manualPreviewSelected
                          ? [
                              "Manual remote catalog selection",
                              ...(previewData.candidate?.reasons ?? []),
                            ]
                          : [...(previewData.candidate?.reasons ?? [])],
                        candidateSnapshot: {
                          remoteTitle: previewData.targetRemote?.combinedTitle ?? null,
                          reasons: manualPreviewSelected
                            ? [
                                "Manual remote catalog selection",
                                ...(previewData.candidate?.reasons ?? []),
                              ]
                            : [...(previewData.candidate?.reasons ?? [])],
                          disqualifiers: [...(previewData.candidate?.disqualifiers ?? [])],
                          score: previewData.candidate?.score ?? 0,
                        },
                        notes: null,
                      }),
                    )
                  }
                >
                  <Link2 className="mr-1 h-4 w-4" /> Confirm match
                </Button>
                {previewData.targetRemote && (
                  <Button
                    type="button"
                    variant="outline"
                    disabled={rejectCandidateMutation.isPending}
                    onClick={() =>
                      rejectCandidateMutation.mutate({
                        connectionId: activeConnectionId,
                        variantId: previewData.canonical.variantId,
                        remoteProductId: previewData.targetRemote?.remoteProductId ?? null,
                        remoteVariantId: previewData.targetRemote?.remoteVariantId ?? null,
                        remoteInventoryItemId:
                          previewData.targetRemote?.remoteInventoryItemId ?? null,
                        remoteSku: previewData.targetRemote?.remoteSku ?? null,
                        scope: "connection",
                        reason: "manual_not_match",
                        notes:
                          "Suppressed from SKU matching review drawer because staff marked it as not a match.",
                      })
                    }
                  >
                    <Ban className="mr-1 h-4 w-4" /> Not a match
                  </Button>
                )}
                {previewData.existingMapping?.id && (
                  <Button
                    variant="ghost"
                    disabled={deactivateMutation.isPending}
                    onClick={() => {
                      const mappingId = previewData.existingMapping?.id;
                      if (!mappingId) return;
                      deactivateMutation.mutate({
                        mappingId,
                        reason: "manual_unmatch",
                        notes: "Removed from preview drawer",
                      });
                    }}
                  >
                    Remove match
                  </Button>
                )}
                {previewData.shopifyReadiness &&
                  previewData.shopifyReadiness.state !== "ready_at_default_location" &&
                  previewData.targetRemote?.remoteInventoryItemId && (
                    <Button
                      variant="outline"
                      disabled={activateShopifyMutation.isPending}
                      onClick={() =>
                        activateShopifyMutation.mutate({
                          connectionId: activeConnectionId,
                          variantId: previewData.canonical.variantId,
                          remoteInventoryItemId:
                            previewData.targetRemote?.remoteInventoryItemId ?? null,
                          remoteProductId: previewData.targetRemote?.remoteProductId ?? null,
                          remoteVariantId: previewData.targetRemote?.remoteVariantId ?? null,
                        })
                      }
                    >
                      Activate at default location
                    </Button>
                  )}
              </div>
            </div>
          ) : (
            <div className="py-8 text-sm text-muted-foreground">
              Choose a row from the table to preview its current best match.
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function SummaryCard({
  label,
  value,
  danger = false,
}: {
  label: string;
  value: number;
  danger?: boolean;
}) {
  return (
    <div
      className={`rounded-md border p-4 ${danger ? "border-destructive/40 bg-destructive/5" : "bg-card"}`}
    >
      <div className="text-xs uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="mt-1 text-2xl font-semibold">{value}</div>
    </div>
  );
}
