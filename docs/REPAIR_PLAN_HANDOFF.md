# Repair Plan Handoff Document

**Date:** 2026-03-19  
**Scope:** Settings pages (Bandcamp Accounts, Store Mapping, Store Connections) — "No Data" investigation and fixes

---

## Executive Summary

| Page | Issue | Status |
|------|-------|--------|
| Bandcamp Accounts | No data — wiring correct, needs manual add or seed | ✅ No code change needed |
| Store Mapping | No data — wiring correct, needs Sync Stores + ShipStation env | ✅ No code change needed |
| Store Connections | No data, no way to add | ✅ **Fixed** — Add Connection UI added |

---

## Affected Files (Complete List)

### 1. Modified in This Repair

| File | Change |
|------|--------|
| `src/app/admin/settings/store-connections/page.tsx` | Added Add Connection button, dialog, org selector, workspace filter |
| `src/actions/store-connections.ts` | Added `workspaceId` to `ConnectionFilters`, filter in `getStoreConnections` |
| `package.json` | Added `db:seed` script |

### 2. New Files Created

| File | Purpose |
|------|---------|
| `docs/SETTINGS_PAGES_AUDIT.md` | Audit document with data flow and wiring |
| `docs/REPAIR_PLAN_HANDOFF.md` | This handoff document |
| `scripts/seed-dev-data.ts` | Seed script for dev test data |

### 3. Related Files (No Changes Required)

| File | Role |
|------|------|
| `src/app/admin/settings/bandcamp/page.tsx` | Bandcamp Accounts page — already wired |
| `src/app/admin/settings/store-mapping/page.tsx` | Store Mapping page — already wired |
| `src/actions/bandcamp.ts` | `getBandcampAccounts`, `createBandcampConnection`, `getOrganizationsForWorkspace` |
| `src/actions/store-mapping.ts` | `getStoreMappings`, `syncStoresFromShipStation`, `updateStoreMapping`, `autoMatchStores` |
| `src/actions/auth.ts` | `getUserContext` — provides `workspaceId` |
| `src/lib/server/auth-context.ts` | `requireAuth` — validates user has `workspace_id` |
| `src/components/admin/admin-sidebar.tsx` | Navigation links to settings pages |
| `src/components/admin/store-connections-content.tsx` | Orphan component with Add Connection — not used by settings page |

### 4. Supporting Files (Data Flow)

| File | Role |
|------|------|
| `src/lib/clients/shipstation.ts` | `fetchStores` — used by Store Mapping sync |
| `src/lib/shared/store-match.ts` | `computeMatchSuggestions` — Auto-Match for Store Mapping |
| `src/lib/shared/query-keys.ts` | `queryKeys.storeConnections`, `queryKeys.storeMappings`, `queryKeys.bandcamp` |
| `src/lib/shared/types.ts` | `ClientStoreConnection`, `StorePlatform`, `ConnectionStatus` |

### 5. Database & Migrations (No Changes)

| File | Tables |
|------|--------|
| `supabase/migrations/20260316000001_core.sql` | `workspaces`, `organizations`, `users` |
| `supabase/migrations/20260316000005_supporting.sql` | `warehouse_shipstation_stores` |
| `supabase/migrations/20260316000007_bandcamp.sql` | `bandcamp_connections`, `bandcamp_credentials` |
| `supabase/migrations/20260316000011_store_connections.sql` | `client_store_connections`, `client_store_sku_mappings` |

---

## Repair Plan Summary

### Phase 1: Store Connections (Completed)

1. **Add workspace filter to `getStoreConnections`**
   - File: `src/actions/store-connections.ts`
   - Add `workspaceId` to `ConnectionFilters` schema
   - Apply filter when `workspaceId` provided

2. **Add Add Connection UI to admin settings page**
   - File: `src/app/admin/settings/store-connections/page.tsx`
   - Import `getUserContext`, `getOrganizationsForWorkspace`, `createStoreConnection`
   - Add state: `showAddDialog`, `newConn`
   - Add "Add Connection" button
   - Add Dialog with org selector, platform select, store URL input
   - Pass `workspaceId` into filters

### Phase 2: Documentation & Seed (Completed)

3. **Create audit document**
   - File: `docs/SETTINGS_PAGES_AUDIT.md`

4. **Create seed script**
   - File: `scripts/seed-dev-data.ts`
   - Add `pnpm db:seed` to `package.json`

### Phase 3: Optional Follow-ups (Not Done)

| Item | File(s) | Notes |
|------|---------|-------|
| Remove orphan `StoreConnectionsContent` | `src/components/admin/store-connections-content.tsx` | Or wire it into Settings page instead of inline UI |
| Add workspace_id to users in seed | `scripts/seed-dev-data.ts` | Seed script cannot create auth users; manual update needed |
| Add `full_name` to users table if missing | Migration | Check schema for `users.full_name` |

---

## File-by-File Diff Summary

### `src/app/admin/settings/store-connections/page.tsx`

- **Imports added:** `Plus`, `getUserContext`, `getOrganizationsForWorkspace`, `createStoreConnection`, `Dialog`, `DialogContent`, `DialogHeader`, `DialogTitle`, `Label`
- **State added:** `showAddDialog`, `newConn` (orgId, platform, storeUrl)
- **Queries added:** `getUserContext`, `getOrganizationsForWorkspace` (lazy when dialog open)
- **Mutations added:** `createMutation` for `createStoreConnection`
- **UI added:** Add Connection button, Dialog with org/platform/URL selectors, Add Connection submit
- **Empty state copy:** Updated to mention "Add Connection"

### `src/actions/store-connections.ts`

- **Schema change:** `connectionFiltersSchema` — add `workspaceId: z.string().uuid().optional()`
- **Query change:** `getStoreConnections` — apply `workspace_id` filter when `filters.workspaceId` present

### `package.json`

- **Script added:** `"db:seed": "npx tsx scripts/seed-dev-data.ts"`

---

## Verification Checklist

- [ ] `pnpm typecheck` passes
- [ ] `pnpm check` — Biome passes
- [ ] `pnpm db:seed` runs successfully (requires Supabase + `.env.local`)
- [ ] Staff user has `workspace_id` in `users` table
- [ ] Settings → Store Connections shows "Add Connection" button
- [ ] Add Connection dialog opens, org dropdown populated (if orgs exist)
- [ ] Creating a connection adds row to `client_store_connections`
- [ ] Store connections list filtered by workspace

---

## Handoff Notes

- **StoreConnectionsContent** (`src/components/admin/store-connections-content.tsx`) — Contains a richer Add Connection UI (org dropdown, platform select, etc.) but is **not used** by any page. Consider either removing it or consolidating with the settings page implementation.
- **Workspace filter** — If staff should see all workspaces (multi-tenant super-admin), remove `workspaceId` from the filters when calling `getStoreConnections`.
- **Seed script** — Uses fixed UUIDs for workspace and org. Staff user must be manually updated to `workspace_id = 00000000-0000-0000-0000-000000000001` to see seeded data.
