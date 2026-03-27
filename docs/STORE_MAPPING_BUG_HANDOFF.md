# Store Mapping — Assigned Client Search Bug Handoff

**App:** `clandestine-fulfillment` — Next.js 14 App Router, Supabase, `@tanstack/react-query`  
**Live site:** `https://cpanel.clandestinedistro.com`  
**Repo:** GitHub → Vercel auto-deploy on push to `main`

---

## Problem Statement

On `/admin/settings/store-mapping`, the **"Assign client..." dropdown** does not populate with client names.

- **23 ShipStation stores load correctly** in the table ✅  
- **Already-assigned clients display correctly** (e.g. "Nicole McCabe" shown on row 1) ✅  
- **Auto-Match button works** — server-side fuzzy match runs and assigns clients ✅  
- **Assign/unmap mutations work** — after a client is selected, it saves correctly ✅  
- **Client search dropdown shows nothing** — the dropdown opens but only shows "(Unassigned)" and "+ Add New Client" ❌

---

## Database State (Confirmed)

```
organizations table:   174 rows  ✅
warehouse_shipstation_stores table:  23 rows  ✅
```

Both tables exist and are populated. The data is not missing.

---

## Key Observation — Why This Matters

`autoMatchStores()` **queries the exact same `organizations` table** using the exact same service-role Supabase client, and it **works**. It is a mutation triggered by a button click.

The broken flow is: calling `getOrganizations()` as a Next.js Server Action POST from a `useEffect` inside a table-row component on page load. That POST fails at the **network layer** (not a 5xx error — a connection-level failure).

---

## Browser Console Evidence

When the dropdown is opened:

```
Fetch failed loading: POST "https://cpanel.clandestinedistro.com/admin/settings/store-mapping"
```

This is **not** an HTTP 500 — it is a network-level fetch abort/failure before a response is received. The request goes out, the server action handler runs on the server, but the response is never received by the client.

---

## Full File Listing — Everything This Page Touches

---

### 1. `src/app/admin/settings/store-mapping/page.tsx` — The Page

**Route:** `/admin/settings/store-mapping`  
**Type:** Client Component (`"use client"`)

```tsx
"use client";

import {
  AlertTriangle, ArrowRight, Check, CheckCircle2, Loader2,
  Plus, RefreshCw, RotateCcw, X, Zap,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { getUserContext } from "@/actions/auth";
import { createClient } from "@/actions/clients";
import { getOrganizations } from "@/actions/organizations";  // <-- BROKEN IMPORT
import {
  type AutoMatchSuggestion,
  autoMatchStores,
  getStoreMappings,
  reprocessUnmatchedShipments,
  syncStoresFromShipStation,
  unmapStore,
  updateStoreMapping,
} from "@/actions/store-mapping";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { useAppMutation, useAppQuery } from "@/lib/hooks/use-app-query";
import { queryKeys } from "@/lib/shared/query-keys";
import { CACHE_TIERS } from "@/lib/shared/query-tiers";

// ─── OrgSelector ─────────────────────────────────────────────────────────────
// Rendered once per table row. Has its own local state for the org list.
// PROBLEM: calls getOrganizations() via useEffect — this POST fails on live site.

function OrgSelector({
  value,
  orgName,
  onSelect,
  onClear,
  onAddNew,
  disabled,
}: {
  value: string | null;
  orgName: string | null;
  onSelect: (orgId: string) => void;
  onClear: () => void;
  onAddNew: () => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [orgs, setOrgs] = useState<Array<{ id: string; name: string }>>([]);
  const [orgsLoading, setOrgsLoading] = useState(false);
  const [orgsError, setOrgsError] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Click-outside handler
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  // *** THIS IS THE BROKEN PIECE ***
  // Fires when dropdown opens. Calls getOrganizations() as a server action POST.
  // On the live site, this POST fails at the network layer.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setOrgsLoading(true);
    setOrgsError(false);
    getOrganizations()
      .then((data) => {
        if (!cancelled) {
          setOrgs(data);
          setOrgsLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setOrgsError(true);
          setOrgsLoading(false);
        }
      });
    return () => { cancelled = true; };
  }, [open]);

  const filtered = search
    ? orgs.filter((o) => o.name.toLowerCase().includes(search.toLowerCase()))
    : orgs;

  if (!open) {
    return (
      <div className="flex items-center gap-1">
        <Button
          variant="outline" size="sm"
          className="h-8 text-left justify-start font-normal min-w-[180px]"
          onClick={() => { setOpen(true); setSearch(""); }}
          disabled={disabled}
        >
          <span className={value ? "" : "text-muted-foreground"}>
            {value ? (orgName ?? "Unknown") : "Assign client..."}
          </span>
        </Button>
        {value && (
          <button type="button" onClick={onClear} className="p-1 text-muted-foreground hover:text-foreground" disabled={disabled}>
            <X className="h-3 w-3" />
          </button>
        )}
      </div>
    );
  }

  return (
    <div ref={ref} className="relative">
      <Input
        autoFocus value={search}
        onChange={(e) => setSearch(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Escape") setOpen(false); }}
        placeholder="Search clients..."
        className="h-8 text-sm w-[220px]"
      />
      <div className="absolute z-30 mt-1 w-[220px] max-h-48 overflow-y-auto bg-popover border rounded-md shadow-lg">
        <button type="button"
          className="w-full text-left px-3 py-1.5 text-sm text-muted-foreground hover:bg-accent border-b"
          onClick={() => { onClear(); setOpen(false); }}
        >
          (Unassigned)
        </button>
        {orgsLoading ? (
          <div className="flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" /> Loading clients...
          </div>
        ) : orgsError ? (
          <div className="px-3 py-2 text-xs text-destructive">
            Failed to load clients. Refresh and try again.
          </div>
        ) : filtered.length === 0 && search ? (
          <div className="px-3 py-2 text-xs text-muted-foreground">No clients match</div>
        ) : filtered.length === 0 ? (
          <div className="px-3 py-2 text-xs text-muted-foreground">No clients found.</div>
        ) : (
          filtered.map((org) => (
            <button key={org.id} type="button"
              className={`w-full text-left px-3 py-1.5 text-sm hover:bg-accent transition-colors ${org.id === value ? "bg-accent font-medium" : ""}`}
              onClick={() => { onSelect(org.id); setOpen(false); }}
            >
              {org.name}
            </button>
          ))
        )}
        <button type="button"
          className="w-full text-left px-3 py-1.5 text-sm text-primary hover:bg-accent border-t flex items-center gap-1"
          onClick={() => { setOpen(false); onAddNew(); }}
        >
          <Plus className="h-3 w-3" /> Add New Client
        </button>
      </div>
    </div>
  );
}

// ─── StoreMappingPage ─────────────────────────────────────────────────────────

export default function StoreMappingPage() {
  const [suggestions, setSuggestions] = useState<AutoMatchSuggestion[]>([]);
  const [showNewClientDialog, setShowNewClientDialog] = useState(false);
  const [pendingStoreId, setPendingStoreId] = useState<string | null>(null);
  const [newClientName, setNewClientName] = useState("");
  const [newClientEmail, setNewClientEmail] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);

  // Step 1: get workspaceId from server (WORKS)
  const { data: ctx } = useAppQuery({
    queryKey: ["user-context"],
    queryFn: () => getUserContext(),
    tier: CACHE_TIERS.STABLE,
  });
  const workspaceId = ctx?.workspaceId ?? "";

  // Step 2: get stores once workspaceId resolves (WORKS — table renders fine)
  const { data: stores, isLoading } = useAppQuery({
    queryKey: queryKeys.storeMappings.list(workspaceId),
    queryFn: () => getStoreMappings(workspaceId),
    tier: CACHE_TIERS.SESSION,
    enabled: !!workspaceId,
  });

  // Mutations (all WORK)
  const syncMutation = useAppMutation({ mutationFn: () => syncStoresFromShipStation(workspaceId), invalidateKeys: [queryKeys.storeMappings.all] });
  const autoMatchMutation = useAppMutation({ mutationFn: () => autoMatchStores(workspaceId), invalidateKeys: [], onSuccess: (data) => setSuggestions(data) });
  const assignMutation = useAppMutation({ mutationFn: ({ storeId, orgId }: { storeId: string; orgId: string }) => updateStoreMapping(storeId, orgId), invalidateKeys: [queryKeys.storeMappings.all] });
  const unmapMutation = useAppMutation({ mutationFn: (storeId: string) => unmapStore(storeId), invalidateKeys: [queryKeys.storeMappings.all] });
  const reprocessMutation = useAppMutation({ mutationFn: () => reprocessUnmatchedShipments(workspaceId), invalidateKeys: [queryKeys.storeMappings.all] });

  const totalCount = (stores ?? []).length;
  const mappedCount = (stores ?? []).filter((s) => s.org_id).length;
  const unmappedCount = totalCount - mappedCount;
  const pct = totalCount > 0 ? Math.round((mappedCount / totalCount) * 100) : 0;

  const acceptSuggestion = (s: AutoMatchSuggestion) => {
    assignMutation.mutate({ storeId: s.storeId, orgId: s.suggestedOrgId });
    setSuggestions((prev) => prev.filter((x) => x.storeId !== s.storeId));
  };

  const openNewClientDialog = (storeId: string) => {
    setPendingStoreId(storeId);
    setNewClientName(""); setNewClientEmail(""); setCreateError(null);
    setShowNewClientDialog(true);
  };

  const handleCreateClient = async () => {
    if (!newClientName.trim()) return;
    setCreateError(null);
    try {
      const result = await createClient({
        name: newClientName.trim(),
        slug: newClientName.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""),
        billingEmail: newClientEmail.trim() || undefined,
      });
      if (pendingStoreId) {
        assignMutation.mutate({ storeId: pendingStoreId, orgId: result.orgId });
      }
      setShowNewClientDialog(false);
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : "Failed to create client");
    }
  };

  return (
    <div className="p-6 space-y-4">
      {/* Header + buttons (Sync Stores, Auto-Match, Reprocess Unmatched) */}
      {/* Progress bar */}
      {/* Auto-match suggestions panel */}
      {/* Store table — each row renders an OrgSelector */}
      {(stores ?? []).map((store) => (
        <TableRow key={store.id}>
          {/* ... store_name, store_id, marketplace_name cells ... */}
          <TableCell className="overflow-visible">
            <OrgSelector
              value={store.org_id ?? null}
              orgName={store.org_name ?? null}
              onSelect={(orgId) => assignMutation.mutate({ storeId: store.id, orgId })}
              onClear={() => unmapMutation.mutate(store.id)}
              onAddNew={() => openNewClientDialog(store.id)}
              disabled={assignMutation.isPending || unmapMutation.isPending}
            />
            {/* NOTE: orgs are NOT passed as a prop — OrgSelector fetches them itself */}
          </TableCell>
        </TableRow>
      ))}
      {/* Add New Client dialog */}
    </div>
  );
}
```

---

### 2. `src/actions/store-mapping.ts` — Server Actions for the Page

**Type:** Server Actions (`"use server"`)  
**Auth:** Uses a local `requireAuth()` that only reads cookies — does NOT use the full `requireAuth()` from `auth-context.ts`.

```ts
"use server";

import { createServerSupabaseClient, createServiceRoleClient } from "@/lib/server/supabase-server";
import { type AutoMatchSuggestion, computeMatchSuggestions } from "@/lib/shared/store-match";
import type { WarehouseShipstationStore } from "@/lib/shared/types";

export type { AutoMatchSuggestion };

export interface StoreMappingRow extends WarehouseShipstationStore {
  org_name: string | null;
}

// Local auth — simpler than requireAuth() from auth-context.ts
// Only checks session cookie. Does NOT look up the users table or workspace_id.
async function requireAuth() {
  const supabase = await createServerSupabaseClient();
  const { data: userData } = await supabase.auth.getUser();
  if (!userData.user) throw new Error("Unauthorized");
  return userData.user;
}

// WORKS — called as React Query query, returns StoreMappingRow[]
export async function getStoreMappings(workspaceId: string): Promise<StoreMappingRow[]> {
  await requireAuth();
  const serviceClient = createServiceRoleClient();
  const { data: stores, error } = await serviceClient
    .from("warehouse_shipstation_stores")
    .select("*, organizations(name)")
    .eq("workspace_id", workspaceId)
    .order("store_name", { ascending: true });
  if (error) throw new Error(`Failed to fetch store mappings: ${error.message}`);
  return (stores ?? []).map((s) => {
    const org = s.organizations as unknown as { name: string } | null;
    return { ...s, org_name: org?.name ?? null, organizations: undefined } as StoreMappingRow;
  });
}

// WORKS — called as mutation from Sync Stores button
export async function syncStoresFromShipStation(workspaceId: string): Promise<{ synced: number }> {
  await requireAuth();
  const { fetchStores } = await import("@/lib/clients/shipstation");
  const apiStores = await fetchStores();
  const serviceClient = createServiceRoleClient();
  let synced = 0;
  for (const store of apiStores) {
    const { error } = await serviceClient.from("warehouse_shipstation_stores").upsert(
      { workspace_id: workspaceId, store_id: store.storeId, store_name: store.storeName, marketplace_name: store.marketplaceName },
      { onConflict: "workspace_id,store_id" },
    );
    if (error) throw new Error(`Failed to upsert store ${store.storeId}: ${error.message}`);
    synced++;
  }
  return { synced };
}

// WORKS — called as mutation from Auto-Match button
// NOTE: This also queries organizations using serviceClient — and it WORKS.
// This is the key proof that the data and auth are fine; only the POST call
// mechanism from useEffect is failing.
export async function autoMatchStores(workspaceId: string): Promise<AutoMatchSuggestion[]> {
  await requireAuth();
  const serviceClient = createServiceRoleClient();
  const { data: unmapped, error: storeError } = await serviceClient
    .from("warehouse_shipstation_stores")
    .select("id, store_name")
    .eq("workspace_id", workspaceId)
    .is("org_id", null);
  if (storeError) throw new Error(`Failed to fetch unmapped stores: ${storeError.message}`);
  if (!unmapped?.length) return [];
  const { data: orgs, error: orgError } = await serviceClient
    .from("organizations")
    .select("id, name")
    .eq("workspace_id", workspaceId);
  if (orgError) throw new Error(`Failed to fetch organizations: ${orgError.message}`);
  if (!orgs?.length) return [];
  const { data: aliases } = await serviceClient
    .from("organization_aliases")
    .select("org_id, alias_name")
    .eq("workspace_id", workspaceId);
  return computeMatchSuggestions(
    unmapped as Array<{ id: string; store_name: string | null }>,
    orgs as Array<{ id: string; name: string }>,
    (aliases ?? []) as Array<{ org_id: string; alias_name: string }>,
  );
}

// WORKS — mutation
export async function updateStoreMapping(storeId: string, orgId: string): Promise<void> {
  await requireAuth();
  const serviceClient = createServiceRoleClient();
  const { error } = await serviceClient
    .from("warehouse_shipstation_stores")
    .update({ org_id: orgId })
    .eq("id", storeId);
  if (error) throw new Error(`Failed to update store mapping: ${error.message}`);
}

// WORKS — mutation
export async function unmapStore(storeId: string): Promise<void> {
  await requireAuth();
  const serviceClient = createServiceRoleClient();
  const { error } = await serviceClient
    .from("warehouse_shipstation_stores")
    .update({ org_id: null })
    .eq("id", storeId);
  if (error) throw new Error(`Failed to unmap store: ${error.message}`);
}

// WORKS — mutation
export async function reprocessUnmatchedShipments(workspaceId: string): Promise<{ total: number; matched: number }> {
  await requireAuth();
  const serviceClient = createServiceRoleClient();
  // ... SKU-based org matching for unmatched shipments
}
```

---

### 3. `src/actions/organizations.ts` — The Failing Action

**Type:** Server Action (`"use server"`)  
**Auth:** Uses the **full** `requireAuth()` from `src/lib/server/auth-context.ts` (which also looks up the users table to get `workspace_id`).

```ts
"use server";

import { z } from "zod/v4";
import { requireAuth } from "@/lib/server/auth-context";   // full auth — reads users table
import { createServiceRoleClient } from "@/lib/server/supabase-server";

// *** THIS IS THE FUNCTION THAT FAILS ***
// When called from useEffect on the live site, the POST to the server
// fails at the network layer before returning data.
export async function getOrganizations(): Promise<
  Array<{ id: string; name: string; slug: string; parent_org_id: string | null }>
> {
  let userRecord: Awaited<ReturnType<typeof requireAuth>>["userRecord"];
  try {
    const auth = await requireAuth();   // reads cookie → getUser() → looks up users table
    userRecord = auth.userRecord;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (msg.toLowerCase().includes("unauthorized")) {
      return [];  // fail-soft added during debug attempts
    }
    throw error;
  }

  const serviceClient = createServiceRoleClient();
  const { data, error } = await serviceClient
    .from("organizations")
    .select("id, name, slug, parent_org_id")
    .eq("workspace_id", userRecord.workspace_id)
    .order("name", { ascending: true });

  if (error) throw new Error(`Failed to fetch organizations: ${error.message}`);
  return (data ?? []) as Array<{
    id: string;
    name: string;
    slug: string;
    parent_org_id: string | null;
  }>;
}
```

---

### 4. `src/actions/auth.ts` — getUserContext (Used by page for workspaceId)

```ts
"use server";

import { requireAuth } from "@/lib/server/auth-context";
import { createServiceRoleClient } from "@/lib/server/supabase-server";

// Called by StoreMappingPage via useAppQuery to get workspaceId.
// This WORKS fine.
export async function getUserContext(): Promise<{
  workspaceId: string;
  orgId: string | null;
  isStaff: boolean;
  userId: string;
  userName: string;
  userRole: string;
}> {
  const { userRecord, isStaff } = await requireAuth();
  return {
    workspaceId: userRecord.workspace_id,
    orgId: userRecord.org_id,
    isStaff,
    userId: userRecord.id,
    userName: userRecord.name ?? userRecord.email ?? "Unknown",
    userRole: userRecord.role,
  };
}
```

---

### 5. `src/lib/server/auth-context.ts` — requireAuth()

The full auth context used by `getOrganizations()` and `getUserContext()`.

```ts
import { createServerSupabaseClient, createServiceRoleClient } from "@/lib/server/supabase-server";
import { STAFF_ROLES } from "@/lib/shared/constants";

export async function requireAuth(): Promise<AuthContext> {
  const supabase = await createServerSupabaseClient();    // reads cookies
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error("Unauthorized");

  const serviceClient = createServiceRoleClient();
  const userRecord = await getOrCreateUserRecord(serviceClient, user);
  // userRecord includes: id, workspace_id, org_id, role, email, name

  if (!userRecord.workspace_id) throw new Error("User has no workspace assigned");
  const isStaff = (STAFF_ROLES as readonly string[]).includes(userRecord.role);

  return { supabase, authUserId: user.id, userRecord, isStaff };
}
```

---

### 6. `src/lib/server/supabase-server.ts` — Supabase Client Factories

```ts
import { createBrowserClient as _createBrowserClient, createServerClient as _createServerClient } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";

// Server Actions / Server Components — RLS-aware, reads session cookies
export async function createServerSupabaseClient() {
  const cookieStore = await cookies();
  return _createServerClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    cookies: {
      getAll() { return cookieStore.getAll(); },
      setAll(cookiesToSet) { /* ... */ },
    },
  });
}

// Bypasses RLS — for trusted server-side operations only
export function createServiceRoleClient() {
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

// Browser client — RLS-aware, uses anon key
export function createBrowserSupabaseClient() {
  return _createBrowserClient(SUPABASE_URL, SUPABASE_ANON_KEY);
}
```

---

### 7. `src/lib/hooks/use-app-query.ts` — React Query Wrappers

```ts
"use client";

import { type UseQueryOptions, useQuery, useMutation, useQueryClient } from "@tanstack/react-query";

// Merges cache tier defaults into useQuery
export function useAppQuery<TData>(
  options: UseQueryOptions<TData> & { tier: CacheTier }
) {
  const { tier, ...queryOptions } = options;
  return useQuery<TData>({ ...tier, ...queryOptions });
}

// Mutation wrapper that invalidates query keys on success
export function useAppMutation<TData, TVariables>(
  options: UseMutationOptions<TData, DefaultError, TVariables> & {
    invalidateKeys?: readonly QueryKey[];
  }
) {
  const queryClient = useQueryClient();
  const { invalidateKeys, onSuccess, ...mutationOptions } = options;
  return useMutation<TData, DefaultError, TVariables>({
    ...mutationOptions,
    onSuccess: (...args) => {
      if (invalidateKeys) {
        for (const key of invalidateKeys) {
          queryClient.invalidateQueries({ queryKey: key as QueryKey });
        }
      }
      onSuccess?.(...args);
    },
  });
}
```

---

### 8. `src/lib/shared/query-tiers.ts` — Cache Configuration

```ts
export const CACHE_TIERS = {
  REALTIME: { staleTime: 30_000,        gcTime: 5 * 60_000    },  // 30s stale
  SESSION:  { staleTime: 5 * 60_000,    gcTime: 30 * 60_000   },  // 5min stale
  STABLE:   { staleTime: 30 * 60_000,   gcTime: 2 * 60 * 60_000 }, // 30min stale
} as const;
```

`getStoreMappings` uses `SESSION` (5 min stale). `getUserContext` uses `STABLE` (30 min stale).

---

### 9. `src/lib/shared/query-keys.ts` — Cache Key Registry (relevant section)

```ts
storeMappings: {
  all: ["store-mappings"] as const,
  list: (workspaceId: string) => ["store-mappings", "list", workspaceId] as const,
},
```

---

### 10. `src/lib/shared/store-match.ts` — Auto-Match Logic (pure function)

Used by `autoMatchStores()`. Pure function, no DB calls.

```ts
export interface AutoMatchSuggestion {
  storeId: string;
  storeName: string;
  suggestedOrgId: string;
  suggestedOrgName: string;
  confidence: number; // 0–1
}

// Strips marketplace suffixes (Bandcamp, Shopify, etc.) then token-scores
// store name against org names and aliases.
export function computeMatchSuggestions(
  unmappedStores: Array<{ id: string; store_name: string | null }>,
  orgs: Array<{ id: string; name: string }>,
  aliases?: Array<{ org_id: string; alias_name: string }>,
): AutoMatchSuggestion[] { ... }
```

---

### 11. `tests/unit/actions/store-mapping.test.ts` — Unit Tests

**Critical note:** The mock for `getStoreMappings` uses a single `.from()` chain returning one mock response. If `getStoreMappings` is changed to call `.from()` twice (e.g. a `Promise.all` for stores + orgs), this mock will break — it must be updated to use `mockReturnValueOnce` twice, like the existing `autoMatchStores` test.

```ts
// Current mock structure (works for one .from() call):
mockServiceFrom.mockReturnValue({
  select: vi.fn().mockReturnValue({
    eq: vi.fn().mockReturnValue({
      order: vi.fn().mockResolvedValue({
        data: [{ id: "store-1", ... organizations: { name: "Test Org" } }],
        error: null,
      }),
    }),
  }),
});

// If Promise.all is used, needs to become:
mockServiceFrom
  .mockReturnValueOnce({ /* stores query chain */ })
  .mockReturnValueOnce({ /* orgs query chain */ });

// Also update assertions from:
expect(result).toHaveLength(1);
expect(result[0].store_name).toBe("Test Store");
// To:
expect(result.stores).toHaveLength(1);
expect(result.stores[0].store_name).toBe("Test Store");
expect(result.orgs).toHaveLength(1);
```

---

## The Recommended Fix (What Needs to Change)

The safest fix is to **bundle the org list into `getStoreMappings`** so no separate server action call is needed. `autoMatchStores` proves this pattern works.

### Change 1: `src/actions/store-mapping.ts`

Add a new return type and fetch orgs in parallel with stores:

```ts
// NEW — add this interface
export interface StoreMappingData {
  stores: StoreMappingRow[];
  orgs: Array<{ id: string; name: string }>;
}

// CHANGE — return type from StoreMappingRow[] to StoreMappingData
export async function getStoreMappings(workspaceId: string): Promise<StoreMappingData> {
  await requireAuth();
  const serviceClient = createServiceRoleClient();

  const [storesResult, orgsResult] = await Promise.all([
    serviceClient
      .from("warehouse_shipstation_stores")
      .select("*, organizations(name)")
      .eq("workspace_id", workspaceId)
      .order("store_name", { ascending: true }),
    serviceClient
      .from("organizations")
      .select("id, name")
      .eq("workspace_id", workspaceId)
      .order("name", { ascending: true }),
  ]);

  if (storesResult.error)
    throw new Error(`Failed to fetch store mappings: ${storesResult.error.message}`);
  if (orgsResult.error)
    throw new Error(`Failed to fetch organizations: ${orgsResult.error.message}`);

  const stores = (storesResult.data ?? []).map((s) => {
    const org = s.organizations as unknown as { name: string } | null;
    return { ...s, org_name: org?.name ?? null, organizations: undefined } as StoreMappingRow;
  });

  const orgs = (orgsResult.data ?? []) as Array<{ id: string; name: string }>;

  return { stores, orgs };
}
```

### Change 2: `src/app/admin/settings/store-mapping/page.tsx`

**Remove** `getOrganizations` import.  
**Remove** all `useState`/`useEffect` for orgs inside `OrgSelector`.  
**Add** `orgs` as a prop.  
**Update** the parent query destructuring.

```tsx
// REMOVE this import:
import { getOrganizations } from "@/actions/organizations";

// CHANGE OrgSelector signature to accept orgs as a prop:
function OrgSelector({
  value, orgName, orgs, onSelect, onClear, onAddNew, disabled,
}: {
  value: string | null;
  orgName: string | null;
  orgs: Array<{ id: string; name: string }>;  // <-- NEW PROP
  onSelect: (orgId: string) => void;
  onClear: () => void;
  onAddNew: () => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  // REMOVE: useState for orgs, orgsLoading, orgsError
  // REMOVE: useEffect that calls getOrganizations()

  const filtered = search
    ? orgs.filter((o) => o.name.toLowerCase().includes(search.toLowerCase()))
    : orgs;

  // ... rest of render (remove orgsLoading/orgsError branches, they're no longer needed)
}

// In StoreMappingPage, update query destructuring:
const { data: mappingData, isLoading } = useAppQuery({
  queryKey: queryKeys.storeMappings.list(workspaceId),
  queryFn: () => getStoreMappings(workspaceId),
  tier: CACHE_TIERS.SESSION,
  enabled: !!workspaceId,
});
const stores = mappingData?.stores;
const orgs = mappingData?.orgs ?? [];

// In table render, pass orgs prop:
<OrgSelector
  value={store.org_id ?? null}
  orgName={store.org_name ?? null}
  orgs={orgs}                           // <-- ADD THIS
  onSelect={(orgId) => assignMutation.mutate({ storeId: store.id, orgId })}
  onClear={() => unmapMutation.mutate(store.id)}
  onAddNew={() => openNewClientDialog(store.id)}
  disabled={assignMutation.isPending || unmapMutation.isPending}
/>
```

### Change 3: `tests/unit/actions/store-mapping.test.ts`

```ts
// getStoreMappings now makes TWO .from() calls, so use mockReturnValueOnce:
describe("getStoreMappings", () => {
  it("returns stores with org names", async () => {
    mockServiceFrom
      .mockReturnValueOnce({
        // First call: warehouse_shipstation_stores
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            order: vi.fn().mockResolvedValue({
              data: [{
                id: "store-1", workspace_id: "ws-1", org_id: "org-1",
                store_id: 100, store_name: "Test Store",
                marketplace_name: "Shopify", created_at: "2026-01-01T00:00:00Z",
                organizations: { name: "Test Org" },
              }],
              error: null,
            }),
          }),
        }),
      })
      .mockReturnValueOnce({
        // Second call: organizations
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            order: vi.fn().mockResolvedValue({
              data: [{ id: "org-1", name: "Test Org" }],
              error: null,
            }),
          }),
        }),
      });

    const result = await getStoreMappings("ws-1");

    // Assertions on new shape:
    expect(result.stores).toHaveLength(1);
    expect(result.stores[0].store_name).toBe("Test Store");
    expect(result.stores[0].org_name).toBe("Test Org");
    expect(result.orgs).toHaveLength(1);
    expect(result.orgs[0].name).toBe("Test Org");
  });

  it("returns null org_name for unmapped stores", async () => {
    mockServiceFrom
      .mockReturnValueOnce({ /* stores query with organizations: null */ })
      .mockReturnValueOnce({ /* orgs query */ });

    const result = await getStoreMappings("ws-1");
    expect(result.stores[0].org_name).toBeNull();
  });

  it("throws when user is not authenticated", async () => {
    mockGetUser.mockResolvedValue({ data: { user: null } });
    await expect(getStoreMappings("ws-1")).rejects.toThrow("Unauthorized");
  });
});
```

---

## Why This Fix Will Work

`autoMatchStores()` already does exactly this pattern:
1. `await requireAuth()` ✅
2. `createServiceRoleClient()` ✅
3. `serviceClient.from("organizations").select("id, name").eq("workspace_id", workspaceId)` ✅

And `getStoreMappings()` already does steps 1–2 and works. Adding the orgs query to the same `Promise.all` puts both fetches in the same proven-working server action invocation. The orgs data arrives as part of the same response as the stores — no separate network call needed.

---

## Database Tables Referenced

| Table | Used by |
|---|---|
| `warehouse_shipstation_stores` | `getStoreMappings`, `syncStoresFromShipStation`, `autoMatchStores`, `updateStoreMapping`, `unmapStore` |
| `organizations` | `getOrganizations` (BROKEN), `autoMatchStores` (WORKS), proposed fix adds to `getStoreMappings` |
| `organization_aliases` | `autoMatchStores` |
| `users` | `requireAuth()` (via `auth-context.ts`) |
| `workspaces` | `requireAuth()` auto-provisioning |
| `warehouse_shipments` | `reprocessUnmatchedShipments` |
| `warehouse_shipment_items` | `reprocessUnmatchedShipments` |
| `warehouse_product_variants` | `reprocessUnmatchedShipments` |
