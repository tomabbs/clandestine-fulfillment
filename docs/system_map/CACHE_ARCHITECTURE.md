# Cache Architecture Contract

Canonical cache and freshness policy for all admin + portal surfaces.

## Purpose

This document is mandatory guidance for any new page, feature, or data flow.
No new read path is complete unless it follows this contract.

## Multi-Tier Model (required)

- **L1:** React Query in-memory cache (current-tab fast path).
- **L2:** Persisted browser cache (IndexedDB via query persister).
- **L3:** Scope-shared server cache (for approved/shared datasets only).
- **L4:** Source of truth (Postgres/API/Trigger-backed systems).

Design intent:
- Serve immediate data from L1/L2/L3 when present.
- Refresh in background based on data class policy.
- Preserve correctness via mutation/event invalidation before TTL fallback.

## Data Class Policy (required per query)

Every query must be classified:

1. **Hot operational**
   - Examples: shipping status, active order queues, inventory movement.
   - Refresh: push invalidation preferred; otherwise short poll (5-10s only where needed).
2. **Warm collaborative**
   - Examples: list/detail management pages.
   - Refresh: stale-while-revalidate on focus/visibility/navigation.
3. **Cold config/reference**
   - Examples: settings, mappings, static lookup lists.
   - Refresh: long TTL + mutation-driven invalidation.
   - When the first read requires request-bound auth/session state, prefer a server-rendered bootstrap payload plus client-side mutations with `router.refresh()` over client-side bootstrap calls to request-scoped Server Actions. `/admin/settings/store-connections` now follows this pattern.

## Query Key and Scope Contract

All new keys must be built from `query-keys.ts` factories (no ad-hoc arrays for durable reads).

Minimum key dimensions:
- workspace scope
- org scope when data is org-bound
- auth/result-shape variant when response shape differs
- canonical resource and filter hash

Required properties:
- deterministic
- versionable (schema/key version)
- tenant-safe (no cross-scope collisions)

### V2 scoped factories (live)

The `queryKeysV2` namespace in `src/lib/shared/query-keys.ts` is the canonical
implementation of this contract for migrated domains. Shape:

```
["<domain>-v2", "ws:<workspaceId>", "org:<orgId|*>", "as:<viewer>", <resource?>, ...args]
```

- Per-domain `-v2` suffix (not a global `v2` prefix) so each domain can roll
  back independently during migration.
- Inline scope tokens (not a nested object) because React Query partial-prefix
  invalidation matches by deep equality on each array slot.
- Sentinel `org:*` for null orgId (staff/global views) keeps the array shape
  stable and prevents `null` vs `undefined` cache forks.
- `viewer` dimension (`"staff"` | `"client"`) because the same logical resource
  often returns DIFFERENT shapes via different Server Actions (e.g.
  `getBillingSnapshots` vs `getClientBillingSnapshots`). Without this dim a
  viewer switch could serve the wrong shape briefly.

Invalidation hierarchy per domain:

| Level | Builder | Invalidates |
| --- | --- | --- |
| Domain | `queryKeysV2.<domain>.domain()` | every scope (use for v1↔v2 bridge or cross-tenant ops) |
| Scope | `queryKeysV2.<domain>.all(scope)` | every resource for one scope |
| Resource | `queryKeysV2.<domain>.<resource>(scope, ...)` | one resource within a scope |

**Bridge contract (in effect during partial rollout):** mutations on migrated
pages MUST invalidate BOTH the legacy `queryKeys.<domain>.all` AND the new
`queryKeysV2.<domain>.all(scope)` (or `.domain()` when no scope is in hand) so
unmigrated surfaces stay fresh. Remove the legacy half only after every reader
of that domain has been moved to v2.

Migrated domains as of `scoped_query_key_hardening_36769ea7`:

- `shipping-v2` — admin + portal shipping pages.
- `billing-v2` — admin + portal billing pages.
- `orders-v2` — admin orders cockpit (drawer subcomponents included).
- `auth-context-v2` — bootstrap reads that RETURN workspaceId/userContext
  (cannot embed those in their own keys).

## Invalidation Order of Truth

Freshness priority:

1. Mutation-driven invalidation (entity/tag/prefix)
2. Event-driven invalidation (webhook/realtime/task outcomes)
3. Stale-while-revalidate reads
4. TTL expiry safety net

TTL is never the primary consistency mechanism.

## Polling and Push Rules

- Polling is opt-in and route-specific (not blanket global defaults).
- Polling must be adaptive:
  - fast only for hot data
  - slowed/paused on hidden tabs or constrained conditions
- Prefer push/realtime invalidation for high-churn entities when practical.
- Support Inbox 2.0 exception/scoping rule (2026-04-25): only the active conversation detail pane subscribes to granular `support_messages` Realtime changes with a `conversation_id` filter. Queue/list surfaces and the floating launcher use mutation invalidation, focus refresh, or bounded polling; they MUST NOT subscribe broadly to all support messages or all support conversations.

## Shared Server Cache Rules

Scope-shared cache may be used only when:
- cache key includes required scope/authz dimensions
- payload does not violate access constraints for that scope
- stale-on-error behavior is defined
- stampede controls exist (single-flight, jitter, soft/hard TTL)

## Performance and Reliability SLOs

Baseline targets:
- cached first meaningful paint: p95 under 300ms desktop / 500ms mobile
- freshness update completion: p95 under 2s after refresh trigger
- route-to-usable-content responsiveness: p95 under 700ms

Engineering budgets to monitor:
- cache hit/miss by tier and route
- source read latency by endpoint
- payload size and parse cost on hot pages
- stale-age distribution and poll amplification

## Mandatory Build Checklist (new page/feature)

Before merge, verify:

1. query uses `useAppQuery` with explicit tier/data class
2. query key comes from `query-keys.ts` (or factory added there)
3. key includes required scope dimensions
4. mutation paths invalidate the right key families
5. refresh behavior (poll/focus/push) is explicitly defined
6. large lists have rendering strategy (virtualization/splitting) where needed
7. tests cover key correctness and invalidation behavior
8. docs updated in `TRUTH_LAYER.md`, `API_CATALOG.md`, and release-gate criteria when policy changes

## Validation Matrix (minimum)

- `pnpm typecheck`
- cache key/unit tests (`query-keys`, `query-tiers`)
- targeted integration isolation checks when scope logic changes
- route-level e2e smoke for pages affected by cache/polling policy

## Anti-Patterns (disallowed)

- ad-hoc persistent query keys lacking scope dimensions
- global polling enabled for all `REALTIME` queries without per-route evidence
- introducing shared cache without explicit invalidation strategy
- relying on TTL-only correctness
- adding new durable read paths without updating this document and related truth docs
