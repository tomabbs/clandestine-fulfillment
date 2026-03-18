# Clandestine Fulfillment — Code Audit Report

**Date:** 2026-03-18
**Scope:** Full codebase audit against CLAUDE.md rules, caching infrastructure review, test coverage, and structural integrity.

---

## Confirmed Issues

### 1. `src/lib/shared/utils.ts` is an empty stub — `formatCurrency()` duplicated 4x
**Rules violated:** #57 (shared utilities), #58 (one truth per concern)
**Severity:** Moderate drift risk
**Details:** The file exports nothing (`export {}`). Meanwhile, `formatCurrency()` is defined inline in:
- `src/app/admin/clients/page.tsx`
- `src/app/admin/clients/[id]/page.tsx`
- `src/app/admin/catalog/page.tsx`
- `src/app/admin/shipping/page.tsx`

Each has a slightly different signature. With 12+ parallel worktrees, this will compound.

### 2. Three pre-existing Biome format violations
**Files:** `src/actions/clients.ts`, `src/actions/product-images.ts`, `src/app/admin/clients/page.tsx`
**Severity:** Low (formatting only, no logic bugs)
**Details:** Line-length violations that Biome wants to wrap. `pnpm check:fix` would resolve all three.

### 3. Cache tiers were missing `gcTime` — garbage collection was unbounded
**Severity:** Medium (memory leak in long sessions)
**Details:** `query-tiers.ts` defined `staleTime` only. Without `gcTime`, inactive queries would never be garbage collected. **Fixed in this session** — REALTIME: 5min, SESSION: 30min, STABLE: 2hr.

### 4. QueryProvider had no persistence and used inline QueryClient config
**Severity:** Medium (every page navigation refetched everything)
**Details:** `query-provider.tsx` created a basic `QueryClient` with a hardcoded 60s staleTime, ignoring the tier system entirely. No IndexedDB persistence. **Fixed in this session** — now uses `createQueryClient()` factory + `PersistQueryClientProvider` with `idb-keyval`.

### 5. `ShipStation webhook secret defaults to empty string`
**File:** `src/lib/shared/env.ts` line 33
**Severity:** Low (integration not yet live)
**Details:** `SHIPSTATION_WEBHOOK_SECRET: z.string().default("")` with a TODO comment. Once ShipStation webhooks go live, HMAC verification will silently pass everything.

### 6. `PresenceHeaderWrapper` makes direct Supabase auth call from client component
**File:** `src/components/admin/presence-header-wrapper.tsx`
**Severity:** Low (auth calls are acceptable from browser, but inconsistent with the Server Action pattern used everywhere else)

---

## Not Actually Broken

### 1. "NO caching" was overstated — infrastructure was partially in place
- `query-keys.ts` — comprehensive key factory covering 14 domains (products, inventory, orders, shipments, inbound, billing, support, channels, reviewQueue, clients, storeConnections, pirateShipImports, bandcamp, storeMappings, catalog, clientReleases)
- `query-tiers.ts` — existed with correct staleTime values (just missing gcTime)
- `use-app-query.ts` — `useAppQuery` and `useAppMutation` wrappers fully implemented
- `invalidation-registry.ts` — 33 table-to-key mappings, complete
- `@tanstack/react-query` — already in package.json
- 36 files already use `useAppQuery` with tier annotations
- Layout already wired `<QueryProvider>` around the app

The gap was: no `gcTime`, no persistence layer, and the QueryProvider ignored the tier system.

### 2. Server Action test coverage is 100%
All 24 action files in `src/actions/` have matching `.test.ts` files in `tests/unit/actions/`. Rule #6 is fully satisfied.

### 3. All CLAUDE.md critical rules are followed
- Rule #9: Shared `bandcampQueue` with `concurrencyLimit: 1` exists
- Rule #20: `recordInventoryChange()` is the single write path
- Rule #36: Webhook handlers use `req.text()` for HMAC
- Rule #47: Redis writes guarded with SETNX + Lua script
- Rule #48: No Server Action calls external APIs directly (all via Trigger tasks)
- Rule #49: Trigger tasks report to Sentry via `@sentry/node`
- Rule #60: Separate scrape queue (`concurrencyLimit: 3`)
- Rule #62: All webhook handlers use `INSERT INTO webhook_events ON CONFLICT`
- Rule #64: Inventory mutations use Supabase RPC, not sequential `.from()` calls
- Rule #65: Echo cancellation checks `last_pushed_quantity`
- Rule #66: Route Handlers do HMAC + dedup + enqueue, target <500ms
- Rule #67: `DATABASE_URL` uses Supavisor port 6543 with `?pgbouncer=true`

### 4. Middleware correctly enforces role-based routing
Imports `STAFF_ROLES` from constants (not hardcoded strings). CLAUDE.md references `ROLE_MATRIX` but the actual export name is `STAFF_ROLES` — functionally correct, naming is a documentation mismatch.

### 5. No broken imports found
Every import across 233 files resolves to an existing module.

---

## Needs More Investigation

### 1. Are all 36 useAppQuery call sites using the correct cache tier?
Spot checks show dashboard uses REALTIME and product lists use SESSION, but a full audit of tier assignment per query hasn't been done. Misassigned tiers (e.g., STABLE on inventory) would cause stale data.

### 2. Shopify bulk sync uses individual upserts instead of batch operations
`src/trigger/tasks/shopify-sync.ts` loops over items calling `.upsert()` one at a time. Rule #59 permits this as an exception, but performance may degrade at scale (hundreds of products). Worth benchmarking.

### 3. Catalog action has unimplemented cost filter
`src/actions/catalog.ts` line 104: `// TODO: add cost column to warehouse_product_variants if needed`. If cost-based filtering is expected by the catalog UI, this is a silent no-op.

### 4. IndexedDB persistence cache size and eviction
The new `idb-keyval` persister stores the entire React Query cache. For users with many tabs or long sessions, this could grow large. No max size or eviction strategy is configured. Monitor in production.

### 5. ShipStation webhook security gap when integration goes live
The empty-string default on `SHIPSTATION_WEBHOOK_SECRET` means HMAC verification will be a no-op. Needs a real secret before enabling the webhook endpoint.

---

## Quick Wins

### 1. Run `pnpm check:fix` to clear 3 Biome format errors
**Effort:** 10 seconds. **Impact:** Clean CI.

### 2. Consolidate `formatCurrency()` into `src/lib/shared/utils.ts`
**Effort:** 15 minutes. **Impact:** Eliminates 4 duplicate implementations, prevents drift across worktrees. Extract the best implementation, add to `utils.ts`, replace all inline copies with imports.

### 3. Remove empty-string default from `SHIPSTATION_WEBHOOK_SECRET`
**Effort:** 1 minute. **Impact:** Forces explicit configuration before deployment, preventing silent security bypass. Change `.default("")` to `.min(1)` or remove the default entirely.

### 4. Add `maxAge` to the IDB persister
**Effort:** 5 minutes. **Impact:** Prevents unbounded cache growth. Add `maxAge: 24 * 60 * 60 * 1000` (24 hours) to the `PersistQueryClientProvider` `persistOptions`.

---

## Recommended Priority Order

| Priority | Item | Type | Risk if Deferred |
|----------|------|------|------------------|
| **P0** | Fix Biome format errors (`pnpm check:fix`) | Hygiene | Blocks CI if enforced |
| **P1** | Consolidate `formatCurrency()` into shared utils | Rule violation | Drift multiplies with parallel worktrees |
| **P2** | Audit all `useAppQuery` call sites for correct tier assignment | Data correctness | Stale inventory shown to warehouse staff |
| **P3** | Remove empty-string default on ShipStation webhook secret | Security | Silent HMAC bypass when integration goes live |
| **P4** | Add `maxAge` to IDB persistence config | Performance | Unbounded IndexedDB growth in long sessions |
| **P5** | Benchmark Shopify bulk sync upsert performance | Performance | Slow full backfills at scale |
| **P6** | Implement catalog cost filter or remove the TODO | Feature gap | Silent no-op on cost-based searches |

---

## What Was Fixed in This Session

| Change | Files |
|--------|-------|
| Added `gcTime` to all cache tiers | `src/lib/shared/query-tiers.ts` |
| Created QueryClient factory with `retry: 1`, `refetchOnReconnect: true` | `src/lib/query-client.ts` (new) |
| Created IndexedDB persister via `idb-keyval` | `src/lib/idb-persister.ts` (new) |
| Upgraded QueryProvider to use factory + persistence | `src/components/shared/query-provider.tsx` |
| Added deps: `idb-keyval@6.2.2`, `@tanstack/react-query-persist-client@5.90.25` | `package.json` |
| Tests for tier values (staleTime, gcTime, ordering) | `tests/unit/lib/query-tiers.test.ts` |
| Tests for query key factory (all domains + uniqueness) | `tests/unit/lib/query-keys.test.ts` (new) |

**Verification:** `pnpm typecheck` clean, `pnpm test` 519/519 passed, `pnpm build` clean (43 pages).
