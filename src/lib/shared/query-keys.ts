export const queryKeys = {
  products: {
    all: ["products"] as const,
    list: (filters?: Record<string, unknown>) => ["products", "list", filters] as const,
    detail: (id: string) => ["products", "detail", id] as const,
  },
  inventory: {
    all: ["inventory"] as const,
    list: (filters?: Record<string, unknown>) => ["inventory", "list", filters] as const,
    detail: (sku: string) => ["inventory", "detail", sku] as const,
    activity: (filters?: Record<string, unknown>) => ["inventory", "activity", filters] as const,
  },
  orders: {
    all: ["orders"] as const,
    list: (filters?: Record<string, unknown>) => ["orders", "list", filters] as const,
    detail: (id: string) => ["orders", "detail", id] as const,
  },
  shipments: {
    all: ["shipments"] as const,
    list: (filters?: Record<string, unknown>) => ["shipments", "list", filters] as const,
    detail: (id: string) => ["shipments", "detail", id] as const,
    summary: (filters?: Record<string, unknown>) => ["shipments", "summary", filters] as const,
  },
  inbound: {
    all: ["inbound"] as const,
    list: (filters?: Record<string, unknown>) => ["inbound", "list", filters] as const,
    detail: (id: string) => ["inbound", "detail", id] as const,
  },
  billing: {
    all: ["billing"] as const,
    rules: () => ["billing", "rules"] as const,
    overrides: () => ["billing", "overrides"] as const,
    snapshots: (filters?: Record<string, unknown>) => ["billing", "snapshots", filters] as const,
  },
  support: {
    all: ["support"] as const,
    conversations: (filters?: Record<string, unknown>) =>
      ["support", "conversations", filters] as const,
    messages: (conversationId: string) => ["support", "messages", conversationId] as const,
    summary: () => ["support", "summary"] as const,
    clientContext: (conversationId: string) =>
      ["support", "client-context", conversationId] as const,
    assignees: () => ["support", "assignees"] as const,
    savedReplies: () => ["support", "saved-replies"] as const,
    duplicates: (conversationId: string) => ["support", "duplicates", conversationId] as const,
    viewerContext: () => ["support", "viewer-context"] as const,
  },
  auth: {
    all: ["auth"] as const,
    userContext: () => ["auth", "user-context"] as const,
  },
  channels: {
    all: ["channels"] as const,
    syncStatus: (channel?: string) => ["channels", "sync-status", channel] as const,
  },
  reviewQueue: {
    all: ["review-queue"] as const,
    list: (filters?: Record<string, unknown>) => ["review-queue", "list", filters] as const,
  },
  clients: {
    all: ["clients"] as const,
    list: () => ["clients", "list"] as const,
    detail: (id: string) => ["clients", "detail", id] as const,
    products: (id: string, filters?: Record<string, unknown>) =>
      ["clients", "products", id, filters] as const,
    shipments: (id: string, filters?: Record<string, unknown>) =>
      ["clients", "shipments", id, filters] as const,
    sales: (id: string) => ["clients", "sales", id] as const,
    billing: (id: string) => ["clients", "billing", id] as const,
    stores: (id: string) => ["clients", "stores", id] as const,
    settings: (id: string) => ["clients", "settings", id] as const,
    supportHistory: (id: string) => ["clients", "support-history", id] as const,
    aliases: (id: string) => ["clients", "aliases", id] as const,
    presence: (orgIds: string[], onlineUserIds: string[]) =>
      ["clients", "presence", orgIds, onlineUserIds] as const,
  },
  storeConnections: {
    all: ["store-connections"] as const,
    list: (orgId?: string) => ["store-connections", "list", orgId] as const,
  },
  pirateShipImports: {
    all: ["pirate-ship-imports"] as const,
    list: (filters?: Record<string, unknown>) => ["pirate-ship-imports", "list", filters] as const,
    detail: (id: string) => ["pirate-ship-imports", "detail", id] as const,
  },
  bandcamp: {
    all: ["bandcamp"] as const,
    accounts: (workspaceId: string) => ["bandcamp", "accounts", workspaceId] as const,
    mappings: (orgId: string) => ["bandcamp", "mappings", orgId] as const,
    scraperHealth: (workspaceId: string) => ["bandcamp", "scraper-health", workspaceId] as const,
    salesOverview: (workspaceId: string) => ["bandcamp", "sales-overview", workspaceId] as const,
    backfillAudit: (workspaceId: string) => ["bandcamp", "backfill-audit", workspaceId] as const,
  },
  bundles: {
    all: ["bundles"] as const,
    list: (workspaceId: string) => ["bundles", "list", workspaceId] as const,
    detail: (bundleVariantId: string) => ["bundles", "detail", bundleVariantId] as const,
  },
  storeMappings: {
    all: ["store-mappings"] as const,
    list: (workspaceId: string) => ["store-mappings", "list", workspaceId] as const,
  },
  catalog: {
    all: ["catalog"] as const,
    list: (filters?: Record<string, unknown>) => ["catalog", "list", filters] as const,
  },
  clientReleases: {
    all: ["client-releases"] as const,
    list: () => ["client-releases", "list"] as const,
  },
} as const;

// =============================================================================
// V2 — Scope-aware query key factories (Step 1 of cache rollout)
// =============================================================================
//
// Why this exists:
//   The legacy `queryKeys` factories above carry no tenant scope (workspace,
//   org, viewer). When admin staff switch between client orgs, React Query can
//   serve the previous org's cached data for a split second before the refetch
//   lands. Server-side RLS makes this not a *security* bug, but the optimistic
//   paint is still wrong. The v2 factories add explicit scope dimensions so
//   that paint is guaranteed correct.
//
// Shape:
//   ["<domain>-v2", "ws:<workspaceId>", "org:<orgId|*>", "as:<viewer>",
//    <resource?>, ...<args>]
//
//   - Per-domain "-v2" suffix (not a global "v2" prefix) so we can roll back
//     one domain at a time during transition. Resolves Open Question #1 in the
//     scoped_query_key_hardening plan.
//   - Inline scope tokens (not nested in an object) because React Query
//     partial-prefix invalidation matches by deep equality on each array slot;
//     inline tokens keep `queryKeysV2.<domain>.all(scope)` cheap to invalidate.
//   - Sentinel "*" for null orgId (staff/global views) keeps the array shape
//     stable and prevents two distinct caches drifting around null vs undefined.
//   - Viewer dim ("staff" | "client") because the same logical resource often
//     returns DIFFERENT shapes via different Server Actions (e.g.
//     getBillingSnapshots vs getClientBillingSnapshots). Without this dim a
//     viewer switch could serve the wrong shape briefly.
//
// Invalidation hierarchy per domain:
//   <domain>.domain()           → ["<domain>-v2"] — nukes ALL scopes (use for
//                                  cross-tenant mutations or v1↔v2 bridge).
//   <domain>.all(scope)         → invalidates one full scope.
//   <domain>.<resource>(scope)  → invalidates one resource within a scope.
//
// Bridge contract during partial rollout:
//   Migrated mutations should invalidate BOTH legacy + v2 prefixes so that any
//   page still on v1 keys stays fresh. Example:
//     invalidateKeys: [queryKeys.billing.all, queryKeysV2.billing.domain()]
// =============================================================================

export type QueryViewer = "staff" | "client";

export interface QueryScope {
  workspaceId: string;
  /** null for staff/global admin views that span all orgs in a workspace. */
  orgId: string | null;
  viewer: QueryViewer;
}

function scopePrefix(scope: QueryScope) {
  return [`ws:${scope.workspaceId}`, `org:${scope.orgId ?? "*"}`, `as:${scope.viewer}`] as const;
}

export const queryKeysV2 = {
  shipping: {
    /** Domain-wide root — invalidates every shipping-v2 scope. */
    domain: () => ["shipping-v2"] as const,
    /** Scope-wide root — invalidates every shipping resource for one scope. */
    all: (scope: QueryScope) => ["shipping-v2", ...scopePrefix(scope)] as const,
    list: (scope: QueryScope, filters?: Record<string, unknown>) =>
      ["shipping-v2", ...scopePrefix(scope), "list", filters] as const,
    summary: (scope: QueryScope, filters?: Record<string, unknown>) =>
      ["shipping-v2", ...scopePrefix(scope), "summary", filters] as const,
    detail: (scope: QueryScope, id: string) =>
      ["shipping-v2", ...scopePrefix(scope), "detail", id] as const,
    items: (scope: QueryScope, shipmentId: string) =>
      ["shipping-v2", ...scopePrefix(scope), "items", shipmentId] as const,
  },
  billing: {
    domain: () => ["billing-v2"] as const,
    all: (scope: QueryScope) => ["billing-v2", ...scopePrefix(scope)] as const,
    snapshots: (scope: QueryScope, filters?: Record<string, unknown>) =>
      ["billing-v2", ...scopePrefix(scope), "snapshots", filters] as const,
    snapshotDetail: (scope: QueryScope, id: string) =>
      ["billing-v2", ...scopePrefix(scope), "snapshot-detail", id] as const,
    preview: (scope: QueryScope) => ["billing-v2", ...scopePrefix(scope), "preview"] as const,
    rules: (scope: QueryScope) => ["billing-v2", ...scopePrefix(scope), "rules"] as const,
    overrides: (scope: QueryScope) => ["billing-v2", ...scopePrefix(scope), "overrides"] as const,
    formatCosts: (scope: QueryScope) =>
      ["billing-v2", ...scopePrefix(scope), "format-costs"] as const,
  },
  orders: {
    domain: () => ["orders-v2"] as const,
    all: (scope: QueryScope) => ["orders-v2", ...scopePrefix(scope)] as const,
    /**
     * Cockpit table: ShipStation orders joined to local DB rows.
     * `filters` is intentionally typed as `object` (not `Record<string,
     * unknown>`) so callers can pass typed filter interfaces (e.g.
     * `CockpitFilters`) without an index-signature cast. Deep equality is what
     * React Query uses for cache lookups, so the structural shape is what
     * matters at runtime.
     */
    cockpitList: (scope: QueryScope, filters?: object) =>
      ["orders-v2", ...scopePrefix(scope), "cockpit-list", filters] as const,
    featureFlags: (scope: QueryScope) =>
      ["orders-v2", ...scopePrefix(scope), "feature-flags"] as const,
    tagDefs: (scope: QueryScope) => ["orders-v2", ...scopePrefix(scope), "tag-defs"] as const,
    /** Per-order Bandcamp reconcile lookup (for cockpit drawer). */
    bandcampMatch: (scope: QueryScope, orderId: string) =>
      ["orders-v2", ...scopePrefix(scope), "bandcamp-match", orderId] as const,
    /** Per-order Bandcamp enrichment (note/gift/tip). */
    bandcampEnrichment: (scope: QueryScope, orderId: string) =>
      ["orders-v2", ...scopePrefix(scope), "bandcamp-enrichment", orderId] as const,
    /** Workspace-wide list of orgs eligible for manual order assignment. */
    assignableOrgs: (scope: QueryScope) =>
      ["orders-v2", ...scopePrefix(scope), "assignable-orgs"] as const,
    /** Workspace-wide list of staff users that can be assigned to orders. */
    assignableStaff: (scope: QueryScope) =>
      ["orders-v2", ...scopePrefix(scope), "assignable-staff"] as const,
  },
  /**
   * Auth/bootstrap context — the data needed to build a QueryScope itself.
   * Cannot carry workspaceId in the key because the query RETURNS workspaceId.
   * Only viewer dimension applies (admin vs client portal).
   */
  authContext: {
    domain: () => ["auth-context-v2"] as const,
    user: (viewer?: QueryViewer) => ["auth-context-v2", "user", viewer ?? "any"] as const,
    workspaceId: (viewer?: QueryViewer) =>
      ["auth-context-v2", "workspace-id", viewer ?? "any"] as const,
  },
  skuMatching: {
    domain: () => ["sku-matching-v2"] as const,
    all: (scope: QueryScope) => ["sku-matching-v2", ...scopePrefix(scope)] as const,
    connections: (scope: QueryScope, orgId?: string | null) =>
      ["sku-matching-v2", ...scopePrefix(scope), "connections", orgId ?? "*"] as const,
    workspace: (scope: QueryScope, connectionId: string) =>
      ["sku-matching-v2", ...scopePrefix(scope), "workspace", connectionId] as const,
    preview: (scope: QueryScope, connectionId: string, variantId: string) =>
      ["sku-matching-v2", ...scopePrefix(scope), "preview", connectionId, variantId] as const,
    conflicts: (scope: QueryScope, connectionId: string) =>
      ["sku-matching-v2", ...scopePrefix(scope), "conflicts", connectionId] as const,
  },
} as const;
