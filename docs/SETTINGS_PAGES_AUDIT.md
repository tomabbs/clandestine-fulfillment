# Settings Pages Audit & Data Flow

**Date:** 2026-03-19

## Summary

Audit of admin Settings pages: Bandcamp Accounts, Store Mapping, Store Connections. Includes wiring, data flow, and fixes applied.

---

## 1. Bandcamp Accounts (`/admin/settings/bandcamp`)

### Purpose
Manage Bandcamp artist/label connections for inventory sync. Each connection links an organization (client) to a Bandcamp band.

### Data Flow
| Step | Source | Target |
|------|--------|--------|
| 1 | `getUserContext()` | `workspaceId` |
| 2 | `getBandcampAccounts(workspaceId)` | `bandcamp_connections` table (filtered by workspace_id) |
| 3 | `getOrganizationsForWorkspace(workspaceId)` | Org dropdown for Add dialog |
| 4 | `createBandcampConnection({ workspaceId, orgId, bandId, bandName, bandUrl })` | Insert into `bandcamp_connections` |

### Tables
- `bandcamp_connections` — workspace_id, org_id, band_id, band_name, band_url, is_active, last_synced_at
- `bandcamp_credentials` — OAuth tokens (workspace-level)
- `bandcamp_product_mappings` — links warehouse variants to Bandcamp items

### Wiring Status
- **Wired correctly.** Page uses `getBandcampAccounts`, `createBandcampConnection`, `deleteBandcampConnection`, `triggerBandcampSync`.
- **Add Account** button opens dialog with org selector, Band ID, Band Name, Band URL.
- **Empty state:** "No Bandcamp accounts connected. Click 'Add Account' to get started."

### Why "No Data"?
1. **No workspace_id** — If `getUserContext()` returns empty workspaceId (user not in `users` table or missing workspace_id), query is disabled.
2. **No rows** — `bandcamp_connections` is empty for this workspace. Staff must add accounts manually via "Add Account".

---

## 2. Store Mapping (`/admin/settings/store-mapping`)

### Purpose
Map ShipStation stores to organizations. When ShipStation webhooks/polling receive shipments, the store_id is used to route them to the correct org.

### Data Flow
| Step | Source | Target |
|------|--------|--------|
| 1 | `getUserContext()` | `workspaceId` |
| 2 | `getStoreMappings(workspaceId)` | `warehouse_shipstation_stores` (filtered by workspace_id) |
| 3 | `syncStoresFromShipStation(workspaceId)` | Calls ShipStation API `/stores`, upserts into `warehouse_shipstation_stores` |
| 4 | `updateStoreMapping(storeId, orgId)` | Updates `org_id` on `warehouse_shipstation_stores` |
| 5 | `autoMatchStores(workspaceId)` | Heuristic match by store name ↔ org name |
| 6 | `reprocessUnmatchedShipments(workspaceId)` | Re-runs org matching for shipments with null org_id |

### Tables
- `warehouse_shipstation_stores` — workspace_id, store_id (ShipStation ID), store_name, marketplace_name, org_id (nullable)

### Wiring Status
- **Wired correctly.** Data comes from ShipStation API, not manual creation.
- **Sync Stores** — Must be clicked to pull stores from ShipStation. Requires `SHIPSTATION_API_KEY` and `SHIPSTATION_API_SECRET` env vars.
- **Empty state:** "No ShipStation stores found. Click 'Sync Stores' to import."

### Why "No Data"?
1. **No workspace_id** — Same as Bandcamp.
2. **Sync not run** — Staff must click "Sync Stores" to fetch stores from ShipStation API.
3. **ShipStation not configured** — Missing env vars or invalid credentials will cause sync to fail.
4. **No stores in ShipStation** — If the ShipStation account has no stores/marketplaces, the list will be empty.

---

## 3. Store Connections (`/admin/settings/store-connections`)

### Purpose
Manage client store connections (Shopify, WooCommerce, Squarespace, BigCommerce) for inventory sync and order ingestion.

### Data Flow
| Step | Source | Target |
|------|--------|--------|
| 1 | `getUserContext()` | `workspaceId` (for filter + Add dialog) |
| 2 | `getStoreConnections(filters)` | `client_store_connections` (optionally filtered by workspace_id) |
| 3 | `createStoreConnection({ orgId, platform, storeUrl })` | Insert into `client_store_connections` (status: pending) |
| 4 | Client portal | Client submits API key/secret via `submitClientStoreCredentials` → connection becomes active |

### Tables
- `client_store_connections` — workspace_id, org_id, platform, store_url, api_key, api_secret, connection_status, last_webhook_at, last_poll_at, last_error
- `client_store_sku_mappings` — Maps warehouse variants to remote product/variant IDs

### Wiring Status (After Fix)
- **Add Connection** button added to admin settings page.
- Dialog: Organization dropdown, Platform select, Store URL input.
- **Workspace filter** — Staff see only connections in their workspace.
- **Empty state:** "No store connections found. Click 'Add Connection' to create a new connection for a client store."

### Why "No Data" Before Fix?
1. **No Add button** — The settings page did not include an "Add Connection" UI. `createStoreConnection` existed but was only used by the orphan `StoreConnectionsContent` component (not rendered anywhere).
2. **No rows** — `client_store_connections` is empty. Connections must be created by staff, then clients submit credentials in the portal.

### Fixes Applied
- Added "Add Connection" button and dialog to `/admin/settings/store-connections`.
- Org selector (dropdown) instead of raw UUID input.
- Workspace filter so staff only see their workspace's connections.

---

## Test Data Streams

### Prerequisites
- Supabase running (`pnpm supabase start` or hosted project)
- At least one workspace, one organization, one staff user with `workspace_id` set

### Bandcamp Accounts
1. Ensure `organizations` has rows for the workspace.
2. Go to Settings → Bandcamp Accounts.
3. Click "Add Account".
4. Select org, enter Band ID (e.g. `1430196613`), Band Name, optional Band URL.
5. Click "Add Account". Row appears in table.

### Store Mapping
1. Set `SHIPSTATION_API_KEY` and `SHIPSTATION_API_SECRET` in `.env.local`.
2. Go to Settings → Store Mapping.
3. Click "Sync Stores". ShipStation API is called; stores appear in table.
4. Use OrgSelector to assign each store to an organization, or click "Auto-Match".

### Store Connections
1. Ensure `organizations` has rows.
2. Go to Settings → Store Connections.
3. Click "Add Connection".
4. Select org, platform (e.g. Shopify), store URL (e.g. `https://mystore.myshopify.com`).
5. Click "Add Connection". Row appears with status "pending".
6. Client logs into portal, goes to Settings, sees the connection, submits API key/secret.

---

## Seed Script (Development)

Run `pnpm db:seed` to populate minimal test data. Creates:
- Workspace `dev` (id: 00000000-0000-0000-0000-000000000001)
- Organization `Test Label` (id: 00000000-0000-0000-0000-000000000002)
- 1 Bandcamp connection, 1 Store connection (pending), 1 ShipStation store mapping

**Important:** Your staff user must have `workspace_id = 00000000-0000-0000-0000-000000000001` in the `users` table to see this data. Update via Supabase dashboard or SQL.

---

## Checklist for "No Data" Debugging

- [ ] User has `workspace_id` in `users` table
- [ ] `workspaces` and `organizations` tables have rows
- [ ] Bandcamp: Add accounts manually
- [ ] Store Mapping: Click "Sync Stores" (ShipStation env vars set)
- [ ] Store Connections: Click "Add Connection" (now available)
