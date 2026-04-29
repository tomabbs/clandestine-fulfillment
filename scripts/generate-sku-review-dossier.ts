#!/usr/bin/env tsx

import { config } from "dotenv";
config({ path: ".env.local" });

import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fetchRemoteCatalogWithTimeout, rankSkuCandidates } from "@/lib/server/sku-matching";
import { createServiceRoleClient } from "@/lib/server/supabase-server";
import type { ClientStoreConnection } from "@/lib/shared/types";
import { normalizeSku } from "@/lib/shared/utils";

type PublicationMode = "internal" | "external";

type TargetConnectionSpec = {
  orgName: string;
  platform: "shopify" | "woocommerce";
  label: string;
  externalOrgAlias: string;
  externalConnectionAlias: string;
};

type ConnectionRow = ClientStoreConnection & {
  organizations?: { name: string } | { name: string }[] | null;
};

type CanonicalVariantRow = {
  id: string;
  sku: string;
  barcode: string | null;
  title: string | null;
  price: number | null;
  option1_value: string | null;
  format_name: string | null;
  is_preorder: boolean | null;
  product_id: string;
  warehouse_products:
    | {
        id: string;
        title: string;
        vendor: string | null;
      }
    | {
        id: string;
        title: string;
        vendor: string | null;
      }[]
    | null;
  bandcamp_product_mappings:
    | {
        id: string;
        bandcamp_album_title: string | null;
        bandcamp_origin_quantities: unknown;
        bandcamp_item_id: number | null;
        bandcamp_url: string | null;
      }[]
    | null;
  warehouse_inventory_levels:
    | {
        available: number;
        committed: number;
      }[]
    | null;
};

type ExistingMappingRow = {
  id: string;
  variant_id: string;
  remote_product_id: string | null;
  remote_variant_id: string | null;
  remote_inventory_item_id: string | null;
  remote_sku: string | null;
  is_active: boolean;
  updated_at: string;
  match_method: string | null;
  match_confidence: string | null;
  matched_at: string | null;
};

type ConflictRow = {
  id: string;
  our_sku: string | null;
  conflict_type: string;
  severity: string;
  example_product_title: string | null;
  status: string;
};

type SafeMappedRow = {
  canonicalSku: string;
  artist: string | null;
  canonicalTitle: string;
  bandcampTitle: string | null;
  format: string | null;
  canonicalAvailable: number | null;
  barcode: string | null;
  remoteSku: string | null;
  remoteProductId: string | null;
  remoteVariantId: string | null;
  remoteInventoryItemId: string | null;
  matchMethod: string | null;
  matchConfidence: string | null;
};

type SafeUnmappedRow = {
  canonicalSku: string;
  artist: string | null;
  canonicalTitle: string;
  bandcampTitle: string | null;
  format: string | null;
  canonicalAvailable: number | null;
  barcode: string | null;
  topCandidateSku: string | null;
  topCandidateTitle: string | null;
  topCandidateBarcode: string | null;
  topCandidateConfidence: string | null;
  topCandidateReasons: string[];
  topCandidateDisqualifiers: string[];
};

type SafeRemoteOnlyRow = {
  remoteSku: string | null;
  combinedTitle: string;
  productTitle: string;
  variantTitle: string | null;
  barcode: string | null;
  remoteProductId: string;
  remoteVariantId: string | null;
  remoteInventoryItemId: string | null;
};

type SafeOrphanedMappingRow = {
  mappingId: string;
  remoteSku: string | null;
  remoteProductId: string | null;
  remoteVariantId: string | null;
  remoteInventoryItemId: string | null;
  matchMethod: string | null;
  matchConfidence: string | null;
  matchedAt: string | null;
};

type SafeConflictRow = {
  mappingSku: string | null;
  conflictType: string;
  severity: string;
  exampleTitle: string | null;
  status: string;
};

type ConnectionSnapshot = {
  connectionLabel: string;
  orgName: string;
  platform: "shopify" | "woocommerce";
  connectionIdRedacted: string;
  storeUrl: string;
  connectionStatus: string;
  defaultLocationConfigured: boolean;
  remoteCatalogState: string;
  remoteCatalogError: string | null;
  remoteCatalogFetchedAt: string | null;
  canonicalVariantCount: number;
  activeMappingCount: number;
  intersectingActiveMappingCount: number;
  orphanedActiveMappingCount: number;
  unmappedCanonicalCount: number;
  remoteOnlyCount: number;
  linkedBandcampMappingCount: number;
  linkedBandcampUrlCount: number;
  openConflictCount: number;
  mappedRows: SafeMappedRow[];
  unmappedRows: SafeUnmappedRow[];
  remoteOnlyRows: SafeRemoteOnlyRow[];
  orphanedMappings: SafeOrphanedMappingRow[];
  openConflicts: SafeConflictRow[];
};

type SnapshotDocument = {
  generatedAt: string;
  gitSha: string;
  publicationMode: PublicationMode;
  workspaceId: string;
  workspaceName: string;
  connections: ConnectionSnapshot[];
  fetchHealth: Array<{
    label: string;
    state: string;
    error: string | null;
    fetchedAt: string | null;
  }>;
};

const TARGET_CONNECTIONS: TargetConnectionSpec[] = [
  {
    orgName: "True Panther",
    platform: "shopify",
    label: "true-panther-shopify",
    externalOrgAlias: "Client A",
    externalConnectionAlias: "Connection 1",
  },
  {
    orgName: "Northern Spy Records",
    platform: "shopify",
    label: "northern-spy-shopify",
    externalOrgAlias: "Client B",
    externalConnectionAlias: "Connection 2",
  },
  {
    orgName: "Northern Spy Records",
    platform: "woocommerce",
    label: "northern-spy-woocommerce",
    externalOrgAlias: "Client B",
    externalConnectionAlias: "Connection 3",
  },
];

type CliArgs = {
  mode: PublicationMode;
  outDir: string;
};

function parseArgs(argv: string[]): CliArgs {
  let mode: PublicationMode = "internal";
  let outDir = join(process.cwd(), "reports", "sku-review-dossier");

  for (const arg of argv.slice(2)) {
    if (arg.startsWith("--mode=")) {
      const value = arg.slice("--mode=".length);
      if (value === "internal" || value === "external") mode = value;
    } else if (arg.startsWith("--out-dir=")) {
      outDir = arg.slice("--out-dir=".length);
    }
  }

  return { mode, outDir };
}

function asSingle<T>(value: T | T[] | null | undefined): T | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

function redactId(value: string): string {
  return `${value.slice(0, 8)}...`;
}

function sanitizeStoreUrl(
  storeUrl: string,
  mode: PublicationMode,
  platform: "shopify" | "woocommerce",
): string {
  if (mode === "internal") return storeUrl;
  try {
    const url = new URL(storeUrl);
    if (platform === "shopify" && url.host.endsWith(".myshopify.com")) {
      return `${url.protocol}//redacted.myshopify.com`;
    }
    return `${url.protocol}//redacted-host.invalid`;
  } catch {
    return platform === "shopify" ? "https://redacted.myshopify.com" : "https://redacted-host.invalid";
  }
}

function mappingRemoteKey(mapping: {
  remote_inventory_item_id?: string | null;
  remote_variant_id?: string | null;
  remote_product_id?: string | null;
  remote_sku?: string | null;
  remoteInventoryItemId?: string | null;
  remoteVariantId?: string | null;
  remoteProductId?: string | null;
  remoteSku?: string | null;
}): string {
  return (
    mapping.remote_inventory_item_id ??
    mapping.remoteInventoryItemId ??
    mapping.remote_variant_id ??
    mapping.remoteVariantId ??
    mapping.remote_product_id ??
    mapping.remoteProductId ??
    normalizeSku(mapping.remote_sku ?? mapping.remoteSku) ??
    ""
  );
}

function getGitSha(): string {
  try {
    return execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

function formatMaybe(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === "") return "n/a";
  return String(value);
}

function formatList(items: string[]): string {
  return items.length > 0 ? items.join("; ") : "none";
}

function buildOwnerFilesSection(): string {
  const lines = [
    "- `src/actions/sku-matching.ts`: staff-only review workspace boundary, preview/match/unmatch actions, Shopify readiness/activation helpers, bulk deterministic accept, telemetry writes.",
    "- `src/lib/server/sku-matching.ts`: remote catalog fetch budgets, candidate ranking, fingerprinting, Shopify readiness classifier.",
    "- `src/actions/store-connections.ts`: connection test and catalog-discovery context for Shopify/Woo/Squarespace connectors.",
    "- `src/lib/server/shopify-connection-graphql.ts`: Shopify GraphQL catalog walk and location inventory reads used by SKU matching.",
    "- `src/lib/clients/woocommerce-client.ts`: WooCommerce catalog traversal owner; `per_page` capped at 20, nested pagination for product variations, timeout pressure grows with catalog size.",
    "- `src/lib/clients/bandcamp-scraper.ts`: `data-tralbum` parser and scraper-side evidence extraction contract.",
    "- `src/trigger/tasks/bandcamp-sync.ts`: Bandcamp API ingest plus scrape-page enrichment path; `bandcamp_type_name` can originate from API `item_type` or scraped package type name depending on the path.",
    "- `src/trigger/tasks/bandcamp-tag-backfill.ts`: HTML tag scraping path for genre/tag enrichment; weaker evidence tier than `data-tralbum` package fields.",
    "- `src/trigger/tasks/sku-sync-audit.ts`: existing conflict overlay task; suggest-only, does not auto-mutate aliases.",
    "- `src/trigger/tasks/sku-matching-monitor.ts`: weekly telemetry rollup and conflict-growth escalation for the matching workspace.",
    "- `supabase/migrations/20260425000002_sku_matching_provenance.sql`: `persist_sku_match`, `sku_mapping_events`, provenance columns, active-row uniqueness.",
    "- `supabase/migrations/20260425000003_sku_matching_monitoring.sql`: `sku_matching_perf_events` telemetry table.",
  ];
  return lines.join("\n");
}

function buildEvidenceQualitySection(): string {
  return [
    "### Tier 1: Strong Formal Evidence",
    "- `data-tralbum` fields such as `tralbumId`, album title, preorder/release state, package SKU, and UPC when present.",
    "- Use as decisive evidence only when the target org actually has linked Bandcamp rows or linked page URLs in the database.",
    "",
    "### Tier 2: Useful Supporting Evidence",
    "- Scraped package title, package type, option labels, and related descriptive fields.",
    "- Use as tie-breakers or context, not as the sole match decision when stronger identifiers are absent.",
    "",
    "### Tier 3: Not-Yet-Strongly-Verified Evidence",
    "- HTML tag extraction and other scraper-only fields whose current coverage is primarily synthetic-test-backed.",
    "- The checked-in `tests/fixtures/bandcamp-album-page.html` exists, but current CI unit coverage is mainly synthetic `makeHtml()`-built HTML, not that real-page fixture as the regression source.",
  ].join("\n");
}

function buildPublicationGuardrailsSection(mode: PublicationMode): string {
  const modeLine =
    mode === "internal"
      ? "- Publication mode: `internal` (named connections allowed; still redacted and repo-relative)."
      : "- Publication mode: `external` (pseudonymize client identifiers and reduce store URL detail to domain only).";

  return [
    modeLine,
    "- Serialize appendix rows through a strict allowlist shape before writing markdown or JSON artifacts.",
    "- Do not emit raw Shopify/WooCommerce payloads, token-bearing fields, webhook URLs with secret paths, or editor-local absolute paths.",
    "- Scrub `cost`, `inventory_quantity`, and `price` from exported remote rows unless a later reviewer version explicitly justifies them.",
    "- Run a pre-publish secret scan before sharing the markdown externally; simple grep is supplementary only.",
    "- Include front-matter style metadata in the dossier header: capture time, git SHA, intended audience, retention/review window, and redaction approver.",
  ].join("\n");
}

function buildReviewerOnboardingSection(): string {
  return [
    "- **15-minute path:** executive summary, per-connection snapshot tables, reviewer questions.",
    "- **45-minute path:** add the Bandcamp gap section, evidence-quality rubric, and remediation matrix.",
    "- **90-minute path:** add the owner-file appendix, full inline appendices, and AI constraints section.",
    "- Best feedback format: cite a dossier section, make a concrete observation, and propose a fix or question.",
  ].join("\n");
}

function buildAiConstraintsSection(): string {
  return [
    "- AI is recommendation-only and non-production in this dossier version.",
    "- Any future AI reviewer must receive only allowlisted fields such as canonical SKU/title/format, remote SKU/title/IDs, and deterministic match rationale already produced by code.",
    "- AI must not call `createOrUpdateSkuMatch()`, write directly to `client_store_sku_mappings`, or bypass human confirmation.",
    "- If this path is ever proposed to enterprise reviewers, it must also name the provider, retention mode, and data-residency stance explicitly.",
  ].join("\n");
}

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  return `\"${String(value).replaceAll('\"', '\"\"').replaceAll(/\\r?\\n/g, " ")}\"`;
}

async function loadWorkspace(): Promise<{ id: string; name: string }> {
  const supabase = createServiceRoleClient();
  const { data, error } = await supabase.from("workspaces").select("id, name").limit(1).single();
  if (error || !data) throw new Error("Unable to load workspace");
  return data;
}

async function loadTargetConnections(): Promise<ConnectionRow[]> {
  const supabase = createServiceRoleClient();
  const { data, error } = await supabase
    .from("client_store_connections")
    .select("*, organizations(name)")
    .in(
      "platform",
      TARGET_CONNECTIONS.map((target) => target.platform),
    );

  if (error) throw new Error(`Failed to load client store connections: ${error.message}`);

  const connections = (data ?? []) as ConnectionRow[];
  const resolved: ConnectionRow[] = [];

  for (const target of TARGET_CONNECTIONS) {
    const match =
      connections.find((connection) => {
        const orgName = asSingle(connection.organizations)?.name ?? "";
        return orgName === target.orgName && connection.platform === target.platform;
      }) ?? null;
    if (!match) {
      throw new Error(`Missing target connection for ${target.orgName} / ${target.platform}`);
    }
    resolved.push(match);
  }

  return resolved;
}

async function getCanonicalRows(
  workspaceId: string,
  orgId: string,
): Promise<CanonicalVariantRow[]> {
  const supabase = createServiceRoleClient();
  const { data, error } = await supabase
    .from("warehouse_product_variants")
    .select(
      `
      id,
      sku,
      barcode,
      title,
      price,
      option1_value,
      format_name,
      is_preorder,
      product_id,
      warehouse_products!inner(id, title, vendor),
      bandcamp_product_mappings(
        id,
        bandcamp_album_title,
        bandcamp_origin_quantities,
        bandcamp_item_id,
        bandcamp_url
      ),
      warehouse_inventory_levels(available, committed)
    `,
    )
    .eq("workspace_id", workspaceId)
    .eq("warehouse_products.org_id", orgId)
    .order("sku", { ascending: true });

  if (error) throw new Error(`Canonical variant load failed: ${error.message}`);
  return (data ?? []) as CanonicalVariantRow[];
}

async function getExistingMappings(connectionId: string): Promise<ExistingMappingRow[]> {
  const supabase = createServiceRoleClient();
  const { data, error } = await supabase
    .from("client_store_sku_mappings")
    .select(
      "id, variant_id, remote_product_id, remote_variant_id, remote_inventory_item_id, remote_sku, is_active, updated_at, match_method, match_confidence, matched_at",
    )
    .eq("connection_id", connectionId)
    .eq("is_active", true);

  if (error) throw new Error(`Existing mapping load failed: ${error.message}`);
  return (data ?? []) as ExistingMappingRow[];
}

async function getOpenConflicts(workspaceId: string, skus: string[]): Promise<ConflictRow[]> {
  if (skus.length === 0) return [];
  const supabase = createServiceRoleClient();
  const { data, error } = await supabase
    .from("sku_sync_conflicts")
    .select("id, our_sku, conflict_type, severity, example_product_title, status")
    .eq("workspace_id", workspaceId)
    .in("status", ["open", "in_progress"])
    .in("our_sku", skus);

  if (error) throw new Error(`Conflict load failed: ${error.message}`);
  return (data ?? []) as ConflictRow[];
}

function buildMappedRow(
  canonical: CanonicalVariantRow,
  mapping: ExistingMappingRow,
  mode: PublicationMode,
): SafeMappedRow {
  const product = asSingle(canonical.warehouse_products);
  const bandcamp = Array.isArray(canonical.bandcamp_product_mappings)
    ? canonical.bandcamp_product_mappings[0]
    : null;
  const inventory = asSingle(canonical.warehouse_inventory_levels);

  return {
    canonicalSku: canonical.sku,
    artist: mode === "internal" ? product?.vendor ?? null : null,
    canonicalTitle: product?.title ?? canonical.title ?? canonical.sku,
    bandcampTitle: bandcamp?.bandcamp_album_title ?? null,
    format: canonical.format_name,
    canonicalAvailable: mode === "internal" ? inventory?.available ?? 0 : null,
    barcode: canonical.barcode,
    remoteSku: mapping.remote_sku,
    remoteProductId: mapping.remote_product_id,
    remoteVariantId: mapping.remote_variant_id,
    remoteInventoryItemId: mapping.remote_inventory_item_id,
    matchMethod: mapping.match_method,
    matchConfidence: mapping.match_confidence,
  };
}

function buildUnmappedRow(
  canonical: CanonicalVariantRow,
  remoteItems: Awaited<ReturnType<typeof fetchRemoteCatalogWithTimeout>>["items"],
  mode: PublicationMode,
): SafeUnmappedRow {
  const product = asSingle(canonical.warehouse_products);
  const bandcamp = Array.isArray(canonical.bandcamp_product_mappings)
    ? canonical.bandcamp_product_mappings[0]
    : null;
  const inventory = asSingle(canonical.warehouse_inventory_levels);

  const ranked = rankSkuCandidates(
    {
      variantId: canonical.id,
      sku: canonical.sku,
      barcode: canonical.barcode,
      artist: product?.vendor ?? null,
      title: product?.title ?? canonical.title ?? canonical.sku,
      bandcampTitle: bandcamp?.bandcamp_album_title ?? null,
      format: canonical.format_name,
      variantTitle: canonical.title,
      optionValue: canonical.option1_value,
      isPreorder: Boolean(canonical.is_preorder),
      price: canonical.price,
      bandcampOptionId: null,
      bandcampOptionTitle: null,
      bandcampOriginQuantities: bandcamp?.bandcamp_origin_quantities ?? null,
    },
    remoteItems,
  );
  const top = ranked[0] ?? null;

  return {
    canonicalSku: canonical.sku,
    artist: mode === "internal" ? product?.vendor ?? null : null,
    canonicalTitle: product?.title ?? canonical.title ?? canonical.sku,
    bandcampTitle: bandcamp?.bandcamp_album_title ?? null,
    format: canonical.format_name,
    canonicalAvailable: mode === "internal" ? inventory?.available ?? 0 : null,
    barcode: canonical.barcode,
    topCandidateSku: top?.remote.remoteSku ?? null,
    topCandidateTitle: top?.remote.combinedTitle ?? null,
    topCandidateBarcode: top?.remote.barcode ?? null,
    topCandidateConfidence: top?.confidenceTier ?? null,
    topCandidateReasons: top?.reasons ?? [],
    topCandidateDisqualifiers: top?.disqualifiers ?? [],
  };
}

function buildRemoteOnlyRow(item: Awaited<ReturnType<typeof fetchRemoteCatalogWithTimeout>>["items"][number]): SafeRemoteOnlyRow {
  return {
    remoteSku: item.remoteSku,
    combinedTitle: item.combinedTitle,
    productTitle: item.productTitle,
    variantTitle: item.variantTitle,
    barcode: item.barcode,
    remoteProductId: item.remoteProductId,
    remoteVariantId: item.remoteVariantId,
    remoteInventoryItemId: item.remoteInventoryItemId,
  };
}

function buildOrphanedMappingRow(mapping: ExistingMappingRow): SafeOrphanedMappingRow {
  return {
    mappingId: mapping.id,
    remoteSku: mapping.remote_sku,
    remoteProductId: mapping.remote_product_id,
    remoteVariantId: mapping.remote_variant_id,
    remoteInventoryItemId: mapping.remote_inventory_item_id,
    matchMethod: mapping.match_method,
    matchConfidence: mapping.match_confidence,
    matchedAt: mapping.matched_at,
  };
}

function buildConflictRow(row: ConflictRow): SafeConflictRow {
  return {
    mappingSku: row.our_sku,
    conflictType: row.conflict_type,
    severity: row.severity,
    exampleTitle: row.example_product_title,
    status: row.status,
  };
}

async function buildConnectionSnapshot(
  connection: ConnectionRow,
  spec: TargetConnectionSpec,
  mode: PublicationMode,
): Promise<ConnectionSnapshot> {
  const orgName = asSingle(connection.organizations)?.name ?? "Unknown org";
  const canonicalRows = await getCanonicalRows(connection.workspace_id, connection.org_id);
  const mappings = await getExistingMappings(connection.id);
  const conflicts = await getOpenConflicts(
    connection.workspace_id,
    canonicalRows.map((row) => row.sku).filter(Boolean),
  );
  const remoteCatalog = await fetchRemoteCatalogWithTimeout(connection);

  const canonicalVariantIds = new Set(canonicalRows.map((row) => row.id));
  const mappingsByVariantId = new Map(mappings.map((mapping) => [mapping.variant_id, mapping]));
  const intersectingMappings = mappings.filter((mapping) => canonicalVariantIds.has(mapping.variant_id));
  const orphanedMappings = mappings.filter((mapping) => !canonicalVariantIds.has(mapping.variant_id));
  const mappingRemoteKeys = new Set(
    mappings
      .map((mapping) =>
        mappingRemoteKey({
          remote_inventory_item_id: mapping.remote_inventory_item_id,
          remote_variant_id: mapping.remote_variant_id,
          remote_product_id: mapping.remote_product_id,
          remote_sku: mapping.remote_sku,
        }),
      )
      .filter(Boolean),
  );

  const mappedRows: SafeMappedRow[] = [];
  const unmappedRows: SafeUnmappedRow[] = [];

  let linkedBandcampMappingCount = 0;
  let linkedBandcampUrlCount = 0;

  for (const canonical of canonicalRows) {
    const mapping = mappingsByVariantId.get(canonical.id) ?? null;
    const bandcampMappings = Array.isArray(canonical.bandcamp_product_mappings)
      ? canonical.bandcamp_product_mappings
      : [];
    if (bandcampMappings.length > 0) linkedBandcampMappingCount += 1;
    if (bandcampMappings.some((row) => Boolean(row.bandcamp_url))) linkedBandcampUrlCount += 1;

    if (mapping) {
      mappedRows.push(buildMappedRow(canonical, mapping, mode));
    } else {
      unmappedRows.push(buildUnmappedRow(canonical, remoteCatalog.items, mode));
    }
  }

  const remoteOnlyRows =
    remoteCatalog.state === "ok"
      ? remoteCatalog.items
          .filter((item) => {
            const key = mappingRemoteKey(item);
            return key && !mappingRemoteKeys.has(key);
          })
          .map(buildRemoteOnlyRow)
      : [];

  return {
    connectionLabel: mode === "internal" ? spec.label : spec.externalConnectionAlias,
    orgName: mode === "internal" ? orgName : spec.externalOrgAlias,
    platform: connection.platform as "shopify" | "woocommerce",
    connectionIdRedacted: redactId(connection.id),
    storeUrl: sanitizeStoreUrl(
      connection.store_url,
      mode,
      connection.platform as "shopify" | "woocommerce",
    ),
    connectionStatus: connection.connection_status,
    defaultLocationConfigured: Boolean(connection.default_location_id),
    remoteCatalogState: remoteCatalog.state,
    remoteCatalogError: remoteCatalog.error,
    remoteCatalogFetchedAt: remoteCatalog.fetchedAt,
    canonicalVariantCount: canonicalRows.length,
    activeMappingCount: mappings.length,
    intersectingActiveMappingCount: intersectingMappings.length,
    orphanedActiveMappingCount: orphanedMappings.length,
    unmappedCanonicalCount: canonicalRows.length - intersectingMappings.length,
    remoteOnlyCount: remoteOnlyRows.length,
    linkedBandcampMappingCount,
    linkedBandcampUrlCount,
    openConflictCount: conflicts.length,
    mappedRows,
    unmappedRows,
    remoteOnlyRows,
    orphanedMappings: orphanedMappings.map(buildOrphanedMappingRow),
    openConflicts: conflicts.map(buildConflictRow),
  };
}

function renderRowsAsBullets<T extends Record<string, unknown>>(rows: T[]): string {
  if (rows.length === 0) return "_None._";
  return rows
    .map((row) => {
      const parts = Object.entries(row)
        .map(([key, value]) => {
          if (Array.isArray(value)) return `**${key}**: ${value.length > 0 ? value.join("; ") : "none"}`;
          return `**${key}**: ${formatMaybe(value as string | number | null | undefined)}`;
        })
        .join(" | ");
      return `- ${parts}`;
    })
    .join("\n");
}

function renderConnectionSection(snapshot: ConnectionSnapshot): string {
  return [
    `## ${snapshot.orgName} (${snapshot.platform})`,
    "",
    `- **Connection label**: \`${snapshot.connectionLabel}\``,
    `- **Connection ID**: \`${snapshot.connectionIdRedacted}\``,
    `- **Store URL**: ${snapshot.storeUrl}`,
    `- **Connection status**: \`${snapshot.connectionStatus}\``,
    `- **Default Shopify location configured**: ${snapshot.defaultLocationConfigured ? "yes" : "no"}`,
    `- **Remote catalog fetch**: \`${snapshot.remoteCatalogState}\`${snapshot.remoteCatalogError ? ` — ${snapshot.remoteCatalogError}` : ""}`,
    `- **Remote catalog fetched at**: ${formatMaybe(snapshot.remoteCatalogFetchedAt)}`,
    "",
    "| Metric | Count |",
    "|---|---:|",
    `| Canonical variants in scope | ${snapshot.canonicalVariantCount} |`,
    `| Active mappings | ${snapshot.activeMappingCount} |`,
    `| Active mappings intersecting current canonical | ${snapshot.intersectingActiveMappingCount} |`,
    `| Orphaned active mappings | ${snapshot.orphanedActiveMappingCount} |`,
    `| Unmapped canonical rows | ${snapshot.unmappedCanonicalCount} |`,
    `| Remote-only rows | ${snapshot.remoteOnlyCount} |`,
    `| Linked Bandcamp mapping rows | ${snapshot.linkedBandcampMappingCount} |`,
    `| Linked Bandcamp URL rows | ${snapshot.linkedBandcampUrlCount} |`,
    `| Open ` + "`sku_sync_conflicts`" + ` rows touching current canonical SKUs | ${snapshot.openConflictCount} |`,
    "",
    "### Mapped Rows",
    renderRowsAsBullets(snapshot.mappedRows),
    "",
    "### Unmapped Canonical Rows",
    renderRowsAsBullets(snapshot.unmappedRows),
    "",
    "### Orphaned Active Mappings",
    renderRowsAsBullets(snapshot.orphanedMappings),
    "",
    "### Remote-Only Rows",
    renderRowsAsBullets(snapshot.remoteOnlyRows),
    "",
    "### Existing Conflict Overlay",
    renderRowsAsBullets(snapshot.openConflicts),
  ].join("\n");
}

function renderMarkdown(doc: SnapshotDocument): string {
  const fetchHealthTable = [
    "| Connection | State | Error | Fetched at |",
    "|---|---|---|---|",
    ...doc.fetchHealth.map(
      (row) =>
        `| ${row.label} | \`${row.state}\` | ${row.error ?? "n/a"} | ${row.fetchedAt ?? "n/a"} |`,
    ),
  ].join("\n");

  const totalCanonical = doc.connections.reduce((sum, row) => sum + row.canonicalVariantCount, 0);
  const totalActiveMappings = doc.connections.reduce((sum, row) => sum + row.activeMappingCount, 0);
  const totalIntersecting = doc.connections.reduce(
    (sum, row) => sum + row.intersectingActiveMappingCount,
    0,
  );
  const totalOrphaned = doc.connections.reduce((sum, row) => sum + row.orphanedActiveMappingCount, 0);
  const totalUnmapped = doc.connections.reduce((sum, row) => sum + row.unmappedCanonicalCount, 0);

  const dossier = [
    "# SKU Review Dossier",
    "",
    `> **Generated at:** ${doc.generatedAt}`,
    `> **Git SHA:** \`${doc.gitSha}\``,
    `> **Publication mode:** \`${doc.publicationMode}\``,
    `> **Workspace:** ${doc.workspaceName}${doc.publicationMode === "internal" ? ` (\`${doc.workspaceId}\`)` : ""}`,
    `> **Classification:** ${doc.publicationMode === "internal" ? "Confidential - internal operational review" : "External review draft - pseudonymized"}`,
    "",
    "## Scope summary",
    "This dossier documents the current SKU-matching system for the three live review targets, using a Bandcamp-first reviewer lens, Shopify as the closest secondary comparator, and WooCommerce as the current long-tail comparison surface in scope.",
    "",
    "## Feature",
    "- Bandcamp-first product identity framing and current Bandcamp linkage reality",
    "- Current live connection state",
    "- Mapping coverage and unmapped-product evidence",
    "- Bandcamp scraper capabilities, persistence rules, and evidence quality",
    "- Current code/schema/Trigger surfaces that define the setup today",
    "- Publication guardrails and remediation paths",
    "",
    "## Goal",
    "- Explain what the SKU-matching system does today.",
    "- Show how Bandcamp should function as the primary identity layer for cross-client review, and what is missing today for the target orgs.",
    "- Show the current live Shopify/WooCommerce state for the target clients.",
    "- Identify the unmapped backlog and legacy/orphaned mapping drift.",
    "- Give outside reviewers enough repo-traceable context to refine the next remediation steps.",
    "",
    "## Context",
    "- Bandcamp is the dominant cross-client catalog in product reality, but the current target orgs still have zero linked Bandcamp mapping/URL rows in the database slice reviewed here.",
    "- Shopify is the strongest secondary comparison surface because it exposes richer remote identifiers than the smaller long-tail platforms.",
    "- WooCommerce remains important in scope for the reviewed WooCommerce connection, but the current fetch path can time out under its 20-second remote-catalog budget.",
    "- Runtime truth still follows the repo authority split in `TRUTH_LAYER.md`: warehouse canonical variants are operational truth, Bandcamp API is authoritative for ingest/descriptive fields, and `data-tralbum` scraping is enrichment rather than a co-equal runtime source of truth.",
    "",
    "## Requirements",
    "### Functional",
    "- Keep the narrative Bandcamp-first, Shopify-second, long-tail stores last.",
    "- Include live current-state evidence for the three target connections.",
    "- Use allowlisted export rows only.",
    "- Keep the Bandcamp no-linkage gap explicit and visually unavoidable.",
    "",
    "### Non-functional",
    "- No raw payload dumps.",
    "- Repo-relative evidence only.",
    "- Deterministic, documented export path.",
    "- Publication metadata and redaction guardrails included.",
    "",
    "## Constraints",
    "### Technical",
    "- No fabricated Bandcamp URLs or guessed linkage for target orgs.",
    "- No raw Shopify/Woo payloads in the exported markdown.",
    "- Current owner files and Trigger boundaries must remain the source of truth for behavior claims.",
    "",
    "### Product",
    "- Alias-first model only; no remote SKU rewriting.",
    "- Bandcamp-first framing in this document is editorial/reviewer-facing, not a blanket runtime source-of-truth claim.",
    "",
    "### External",
    "- Shopify/Woo live data can drift after capture time.",
    "- WooCommerce catalog comparison can be incomplete when the remote catalog does not return within the 20-second budget.",
    "",
    "## Evidence sources",
    "- `TRUTH_LAYER.md`",
    "- `docs/system_map/INDEX.md`",
    "- `docs/system_map/API_CATALOG.md`",
    "- `docs/system_map/TRIGGER_TASK_CATALOG.md`",
    "- `project_state/engineering_map.yaml`",
    "- `project_state/journeys.yaml`",
    "- `docs/RELEASE_GATE_CRITERIA.md`",
    "- `src/actions/sku-matching.ts`",
    "- `src/lib/server/sku-matching.ts`",
    "- `src/actions/store-connections.ts`",
    "- `src/lib/server/shopify-connection-graphql.ts`",
    "- `src/lib/clients/woocommerce-client.ts`",
    "- `src/lib/clients/bandcamp-scraper.ts`",
    "- `src/trigger/tasks/bandcamp-sync.ts`",
    "- `src/trigger/tasks/bandcamp-tag-backfill.ts`",
    "- `src/trigger/tasks/sku-sync-audit.ts`",
    "- `src/trigger/tasks/sku-matching-monitor.ts`",
    "- `supabase/migrations/20260425000002_sku_matching_provenance.sql`",
    "- `supabase/migrations/20260425000003_sku_matching_monitoring.sql`",
    "- `tests/unit/lib/clients/bandcamp-scraper.test.ts`",
    "- `tests/fixtures/bandcamp-album-page.html`",
    "",
    "## API boundaries impacted",
    "- `src/actions/sku-matching.ts`",
    "- `src/actions/store-connections.ts`",
    "",
    "## Trigger touchpoint check",
    "- `sku-sync-audit`: existing conflict overlay for the review workspace",
    "- `sku-matching-monitor`: telemetry and conflict-growth monitoring",
    "- `bandcamp-sync`: Bandcamp API ingest plus `bandcamp-scrape-page` enrichment path",
    "- `bandcamp-tag-backfill`: HTML tag backfill path that should not be confused with stronger `data-tralbum` evidence",
    "",
    "## Executive summary",
    `- **Canonical variants in scope**: ${totalCanonical}`,
    `- **Active mappings**: ${totalActiveMappings}`,
    `- **Intersecting active mappings**: ${totalIntersecting}`,
    `- **Orphaned active mappings**: ${totalOrphaned}`,
    `- **Unmapped canonical rows**: ${totalUnmapped}`,
    "",
    "> **Bandcamp evidence status: absent for these target orgs**",
    ">",
    "> The three target review sets currently have **0 linked Bandcamp mapping/URL rows** in the database. The codebase can enrich Bandcamp data when linkage exists, but the target orgs reviewed here do not currently benefit from that data in the live DB slice.",
    "",
    "## Fetch health",
    fetchHealthTable,
    "",
    "## Current live data",
    ...doc.connections.flatMap((snapshot) => ["", renderConnectionSection(snapshot)]),
    "",
    "## Bandcamp gap and scraper/API clarity",
    "- The official Bandcamp API remains authoritative for initial ingest and durable descriptive fields already persisted into the app.",
    "- The scraper exists because the public storefront `data-tralbum` payload exposes package-level evidence such as package SKU, UPC, and package type details that the API path does not consistently provide in the same shape.",
    "- In the current target-org review slice, there are no linked `bandcamp_product_mappings` / `bandcamp_url` rows to bring that evidence into the connection-scoped SKU review model.",
    "- `bandcamp_album_title` is API-backed in current runtime usage; it is not a scraper-only field.",
    "- `bandcamp_type_name` can come from API `item_type` on sync paths or scraped `packages[0].typeName` on scrape/backfill paths.",
    "",
    "## Evidence quality",
    buildEvidenceQualitySection(),
    "",
    "## Current setup code",
    buildOwnerFilesSection(),
    "",
    "## Publication guardrails",
    buildPublicationGuardrailsSection(doc.publicationMode),
    "",
    "## Snapshot freshness contract",
    "- **T1**: live counts, fetch states, and mapping totals in this dossier; regenerate within 24 hours for fresh review.",
    "- **T2**: sample evidence and row examples; regenerate within 7 days or when major matching work occurs.",
    "- **T3**: code and schema references; validate against the cited git SHA before sharing.",
    "- **T4**: architecture and reviewer workflow guidance; update when authority model or publication process changes materially.",
    "",
    "## Document-as-code regeneration strategy",
    "- This dossier was generated from repo code plus live snapshot queries, not hand-assembled from editor-local notes.",
    "- Live snapshot artifacts are stored under `reports/sku-review-dossier/` so the markdown can be regenerated without relying on machine-local cache paths.",
    "- Minimum viable reproducibility means the live sections can be regenerated with one documented script invocation; further polish is deferred.",
    "",
    "## Reviewer onboarding",
    buildReviewerOnboardingSection(),
    "",
    "## Remediations and improvement paths",
    "| Remediation | Type | Problem addressed | Expected impact | Risks / guardrails |",
    "|---|---|---|---|---|",
    "| Bandcamp linkage bootstrap/backfill | data cleanup | Target orgs currently have no linked Bandcamp evidence in the DB | Highest leverage for Bandcamp-first review quality | Must not fabricate links; backfill should be explicit and auditable |",
    "| Stronger negative signals in ranking | code | Title-only suggestions can still be noisy | Better precision on ambiguous rows | Keep deterministic-ID-first behavior intact |",
    "| Orphaned legacy mapping cleanup | data cleanup | Active mappings no longer intersect current canonical slice | Cleaner counts and less reviewer confusion | Must preserve audit trail, not hard-delete silently |",
    "| Woo timeout mitigation | operational | Current 20s budget can make review look worse than it is | More complete Woo comparison evidence | Consider background caching or pre-snapshot warmups |",
    "| Shopify traversal unification outside matching | code | Non-matching code paths may still inherit duplicate traversal strategies | Lower maintenance and less reviewer confusion | Matching workspace already uses GraphQL-first traversal |",
    "| Better title normalization / token overlap | code | Weak product-title differences reduce suggestion quality | More strong/possible candidates | Must not overfit or demote exact identifier matches |",
    "| One-to-one candidate reservation | code | Duplicate top suggestions across many canonical rows | Cleaner review queue | Needs careful reviewer override path |",
    "| Provenance backfill on older mappings | data cleanup | Older rows lack the lean provenance now expected | Better reviewer trust in existing matches | Backfill should use append-only audit notes where possible |",
    "| Richer Bandcamp evidence persistence | code/data | Current stored subset is thinner than the scraper can observe | More decisive package-level comparison | Avoid overclaiming scraper confidence until test coverage improves |",
    "",
    "## AI agent option",
    buildAiConstraintsSection(),
    "",
    "## Reviewer questions / refinement targets",
    "- Do reviewers agree Bandcamp should remain the primary reviewer-facing identity source across clients, with Shopify as the practical secondary comparator?",
    "- Which remediation delivers the highest return before any broader alias-review rollout?",
    "- Is the WooCommerce problem primarily fetch architecture or true catalog mismatch?",
    "- Is the optional AI-assisted review path worth the compliance and operational complexity relative to deterministic rule improvements?",
    "",
    "## Assumptions",
    "- This artifact is a reviewer dossier, not a code-change proposal for runtime behavior.",
    "- Current runtime authority still follows `TRUTH_LAYER.md` rather than a blanket Bandcamp-wins rule.",
    "- Identity review does not require raw payloads or unrestricted business-intelligence fields.",
    "",
    "## Risks",
    "- Live counts can drift quickly after generation.",
    "- WooCommerce fetch incompleteness can be mistaken for true no-match outcomes.",
    "- The inline appendices are large by design and require careful redaction discipline.",
    "",
    "## Validation plan",
    "- Verify the current live counts and linkage gaps still match the snapshot artifacts.",
    "- Verify every cited file path and migration ID exists at the generated SHA.",
    "- Verify all exported rows are allowlisted and that no raw payloads slipped into the markdown.",
    "- Verify the Woo section distinguishes true unmatched rows from fetch-incomplete rows.",
    "",
    "## Rollback plan",
    "- If the dossier is too large for routine review, split the executive summary from the heavy appendices while keeping all artifacts repo-relative and allowlisted.",
    "- If redaction validation fails, keep the artifact internal-only until corrected.",
    "",
    "## Rejected alternatives",
    "- Fabricating Bandcamp URLs or manual web-search linkage for the target orgs.",
    "- Dumping raw Shopify/Woo payloads inline for completeness.",
    "- Treating Bandcamp as universal runtime truth in the markdown.",
    "",
    "## Open questions",
    "- Should the first external-share variant default to pseudonymized org naming even if the internal build keeps named labels?",
    "- Should future builds inline every mapped row, or only every unmapped/orphaned/conflict row plus deterministic mapped exemplars?",
    "",
    "## Deferred items",
    "- AI-assisted reviewer implementation.",
    "- Bandcamp linkage backfill for the target orgs themselves.",
    "- Richer persisted scraper evidence beyond the current stored subset.",
    "- Extra automation polish beyond the minimum rerunnable generator and publication gate.",
    "",
    "## Revision history",
    "- Generated from the audited dossier build plan and current repo/code state.",
    `- Snapshot generated at ${doc.generatedAt} from git SHA ${doc.gitSha}.`,
  ].join("\n");

  return `${dossier}\n`;
}

function writeJson(path: string, value: unknown) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function writeCsv(path: string, snapshot: SnapshotDocument) {
  const header = [
    "connection_label",
    "org_name",
    "platform",
    "connection_id_redacted",
    "store_url",
    "remote_catalog_state",
    "canonical_variant_count",
    "active_mapping_count",
    "intersecting_active_mapping_count",
    "orphaned_active_mapping_count",
    "unmapped_canonical_count",
    "remote_only_count",
    "linked_bandcamp_mapping_count",
    "linked_bandcamp_url_count",
    "open_conflict_count",
  ];

  const lines = [header.join(",")];
  for (const row of snapshot.connections) {
    lines.push(
      [
        csvCell(row.connectionLabel),
        csvCell(row.orgName),
        csvCell(row.platform),
        csvCell(row.connectionIdRedacted),
        csvCell(row.storeUrl),
        csvCell(row.remoteCatalogState),
        csvCell(row.canonicalVariantCount),
        csvCell(row.activeMappingCount),
        csvCell(row.intersectingActiveMappingCount),
        csvCell(row.orphanedActiveMappingCount),
        csvCell(row.unmappedCanonicalCount),
        csvCell(row.remoteOnlyCount),
        csvCell(row.linkedBandcampMappingCount),
        csvCell(row.linkedBandcampUrlCount),
        csvCell(row.openConflictCount),
      ].join(","),
    );
  }

  writeFileSync(path, `${lines.join("\n")}\n`, "utf8");
}

async function main() {
  const args = parseArgs(process.argv);
  mkdirSync(args.outDir, { recursive: true });

  const workspace = await loadWorkspace();
  const connections = await loadTargetConnections();
  const gitSha = getGitSha();
  const generatedAt = new Date().toISOString();
  const ts = generatedAt.replaceAll(":", "-").replaceAll(".", "-");

  const snapshots: ConnectionSnapshot[] = [];
  for (let index = 0; index < connections.length; index += 1) {
    const spec = TARGET_CONNECTIONS[index];
    const connection = connections[index];
    snapshots.push(await buildConnectionSnapshot(connection, spec, args.mode));
  }

  const snapshotDoc: SnapshotDocument = {
    generatedAt,
    gitSha,
    publicationMode: args.mode,
    workspaceId: args.mode === "internal" ? workspace.id : "redacted",
    workspaceName: args.mode === "internal" ? workspace.name : "Redacted workspace",
    connections: snapshots,
    fetchHealth: snapshots.map((snapshot) => ({
      label: snapshot.connectionLabel,
      state: snapshot.remoteCatalogState,
      error: snapshot.remoteCatalogError,
      fetchedAt: snapshot.remoteCatalogFetchedAt,
    })),
  };

  const snapshotPath = join(args.outDir, `sku-review-dossier-snapshot-${ts}.json`);
  const summaryCsvPath = join(args.outDir, `sku-review-dossier-summary-${ts}.csv`);
  const markdownPath = join(args.outDir, `sku-review-dossier-${ts}.md`);

  writeJson(snapshotPath, snapshotDoc);
  writeCsv(summaryCsvPath, snapshotDoc);
  writeFileSync(markdownPath, renderMarkdown(snapshotDoc), "utf8");

  console.log(`Generated snapshot JSON: ${snapshotPath}`);
  console.log(`Generated summary CSV:   ${summaryCsvPath}`);
  console.log(`Generated dossier MD:   ${markdownPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
