# Page Navigation and Full Source Handoff — 2026-03-18

## Summary

This document provides a complete handoff of navigation structure and page source code for the Clandestine Fulfillment app. It covers:

- **Admin portal** (`/admin/*`): Staff-facing warehouse management with sidebar nav (Dashboard, Scan, Inventory, Inbound, Orders, Catalog, Clients, Shipping, Billing, Channels, Review Q, Support) plus a collapsible Settings submenu.
- **Client portal** (`/portal/*`): Client-facing portal with nav (Home, Inventory, Releases, Inbound, Orders, Shipping, Sales, Billing, Support, Settings).
- **Layouts**: Both use `SidebarProvider`, `SidebarInset`, `SidebarTrigger`, and `CommandPalette`.
- **Data fetching**: All pages use `useAppQuery` / `useAppMutation` wrappers with cache tiers; no direct Supabase Realtime subscriptions.

---

## Navigation Components

### Route: /admin/* — src/components/admin/admin-sidebar.tsx

```tsx
"use client";

import { createBrowserClient } from "@supabase/ssr";
import {
  AlertCircle,
  ChevronDown,
  LayoutDashboard,
  Library,
  LogOut,
  MessageSquare,
  Package,
  PackagePlus,
  Radio,
  Receipt,
  ScanBarcode,
  Settings,
  ShoppingCart,
  Truck,
  Users,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useRef } from "react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
} from "@/components/ui/sidebar";

const NAV_ITEMS = [
  { title: "Dashboard", href: "/admin", icon: LayoutDashboard },
  { title: "Scan", href: "/admin/scan", icon: ScanBarcode },
  { title: "Inventory", href: "/admin/inventory", icon: Package },
  { title: "Inbound", href: "/admin/inbound", icon: PackagePlus },
  { title: "Orders", href: "/admin/orders", icon: ShoppingCart },
  { title: "Catalog", href: "/admin/catalog", icon: Library },
  { title: "Clients", href: "/admin/clients", icon: Users },
  { title: "Shipping", href: "/admin/shipping", icon: Truck },
  { title: "Billing", href: "/admin/billing", icon: Receipt },
  { title: "Channels", href: "/admin/channels", icon: Radio },
  { title: "Review Q", href: "/admin/review-queue", icon: AlertCircle },
  { title: "Support", href: "/admin/support", icon: MessageSquare },
] as const;

const SETTINGS_ITEMS = [
  { title: "General", href: "/admin/settings" },
  { title: "Bandcamp Accounts", href: "/admin/settings/bandcamp" },
  { title: "Store Connections", href: "/admin/settings/store-connections" },
  { title: "Store Mapping", href: "/admin/settings/store-mapping" },
  { title: "Integrations", href: "/admin/settings/integrations" },
  { title: "Health", href: "/admin/settings/health" },
] as const;

export function AdminSidebar() {
  const pathname = usePathname();
  const supabaseRef = useRef<ReturnType<typeof createBrowserClient> | null>(null);

  function getSupabase() {
    if (!supabaseRef.current) {
      supabaseRef.current = createBrowserClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL ?? "",
        process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "",
      );
    }
    return supabaseRef.current;
  }

  async function handleLogout() {
    await getSupabase().auth.signOut();
    window.location.href = "/login";
  }

  return (
    <Sidebar>
      <SidebarHeader className="border-b px-4 py-3">
        <span className="text-sm font-semibold">Clandestine Fulfillment</span>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              {NAV_ITEMS.map((item) => (
                <SidebarMenuItem key={item.href}>
                  <SidebarMenuButton
                    render={<Link href={item.href} />}
                    isActive={pathname === item.href}
                  >
                    <item.icon />
                    <span>{item.title}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}

              {/* Settings collapsible */}
              <Collapsible
                defaultOpen={pathname.startsWith("/admin/settings")}
                className="group/collapsible"
              >
                <SidebarMenuItem>
                  <CollapsibleTrigger render={<SidebarMenuButton />}>
                    <Settings />
                    <span>Settings</span>
                    <ChevronDown className="ml-auto transition-transform group-data-[state=open]/collapsible:rotate-180" />
                  </CollapsibleTrigger>
                  <CollapsibleContent>
                    <SidebarMenuSub>
                      {SETTINGS_ITEMS.map((item) => (
                        <SidebarMenuSubItem key={item.href}>
                          <SidebarMenuSubButton
                            render={<Link href={item.href} />}
                            isActive={pathname === item.href}
                          >
                            {item.title}
                          </SidebarMenuSubButton>
                        </SidebarMenuSubItem>
                      ))}
                    </SidebarMenuSub>
                  </CollapsibleContent>
                </SidebarMenuItem>
              </Collapsible>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter className="border-t">
        <SidebarMenu>
          <SidebarMenuItem>
            <DropdownMenu>
              <DropdownMenuTrigger render={<SidebarMenuButton />}>
                <Avatar className="h-6 w-6">
                  <AvatarFallback className="text-xs">CF</AvatarFallback>
                </Avatar>
                <span className="truncate text-sm">Staff User</span>
              </DropdownMenuTrigger>
              <DropdownMenuContent side="top" align="start" className="w-56">
                <DropdownMenuItem onClick={handleLogout}>
                  <LogOut className="mr-2 h-4 w-4" />
                  Logout
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  );
}
```

### Route: /portal/* — src/components/portal/portal-sidebar.tsx

```tsx
"use client";

import { createBrowserClient } from "@supabase/ssr";
import {
  Disc3,
  Home,
  LogOut,
  MessageSquare,
  Package,
  PackagePlus,
  Receipt,
  Settings,
  ShoppingCart,
  TrendingUp,
  Truck,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useRef } from "react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";

const NAV_ITEMS = [
  { title: "Home", href: "/portal", icon: Home },
  { title: "Inventory", href: "/portal/inventory", icon: Package },
  { title: "Releases", href: "/portal/releases", icon: Disc3 },
  { title: "Inbound", href: "/portal/inbound", icon: PackagePlus },
  { title: "Orders", href: "/portal/orders", icon: ShoppingCart },
  { title: "Shipping", href: "/portal/shipping", icon: Truck },
  { title: "Sales", href: "/portal/sales", icon: TrendingUp },
  { title: "Billing", href: "/portal/billing", icon: Receipt },
  { title: "Support", href: "/portal/support", icon: MessageSquare },
  { title: "Settings", href: "/portal/settings", icon: Settings },
] as const;

export function PortalSidebar() {
  const pathname = usePathname();
  const supabaseRef = useRef<ReturnType<typeof createBrowserClient> | null>(null);

  function getSupabase() {
    if (!supabaseRef.current) {
      supabaseRef.current = createBrowserClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL ?? "",
        process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "",
      );
    }
    return supabaseRef.current;
  }

  async function handleLogout() {
    await getSupabase().auth.signOut();
    window.location.href = "/login";
  }

  return (
    <Sidebar>
      <SidebarHeader className="border-b px-4 py-3">
        <span className="text-sm font-semibold">Client Portal</span>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              {NAV_ITEMS.map((item) => (
                <SidebarMenuItem key={item.href}>
                  <SidebarMenuButton
                    render={<Link href={item.href} />}
                    isActive={pathname === item.href}
                  >
                    <item.icon />
                    <span>{item.title}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter className="border-t">
        <SidebarMenu>
          <SidebarMenuItem>
            <DropdownMenu>
              <DropdownMenuTrigger render={<SidebarMenuButton />}>
                <Avatar className="h-6 w-6">
                  <AvatarFallback className="text-xs">CL</AvatarFallback>
                </Avatar>
                <span className="truncate text-sm">Client User</span>
              </DropdownMenuTrigger>
              <DropdownMenuContent side="top" align="start" className="w-56">
                <DropdownMenuItem onClick={handleLogout}>
                  <LogOut className="mr-2 h-4 w-4" />
                  Logout
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  );
}
```

### Route: /admin/* — src/app/admin/layout.tsx

```tsx
"use client";

import { AdminSidebar } from "@/components/admin/admin-sidebar";
import { CommandPalette } from "@/components/shared/command-palette";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return (
    <SidebarProvider>
      <AdminSidebar />
      <SidebarInset>
        <header className="flex h-12 items-center gap-2 border-b px-4">
          <SidebarTrigger />
        </header>
        <main className="flex-1">{children}</main>
      </SidebarInset>
      <CommandPalette />
    </SidebarProvider>
  );
}
```

### Route: /portal/* — src/app/portal/layout.tsx

```tsx
"use client";

import { PortalSidebar } from "@/components/portal/portal-sidebar";
import { CommandPalette } from "@/components/shared/command-palette";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";

export default function PortalLayout({ children }: { children: React.ReactNode }) {
  return (
    <SidebarProvider>
      <PortalSidebar />
      <SidebarInset>
        <header className="flex h-12 items-center gap-2 border-b px-4">
          <SidebarTrigger />
        </header>
        <main className="flex-1">{children}</main>
      </SidebarInset>
      <CommandPalette />
    </SidebarProvider>
  );
}
```

---

## Admin Pages

### Route: /admin — src/app/admin/page.tsx

```tsx
"use client";

import { formatDistanceToNow } from "date-fns";
import {
  AlertTriangle,
  Disc3,
  Loader2,
  Package,
  PackagePlus,
  Rocket,
  ShoppingCart,
  Truck,
} from "lucide-react";
import { useCallback } from "react";
import { getDashboardStats } from "@/actions/admin-dashboard";
import { getPreorderProducts, manualRelease } from "@/actions/preorders";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useAppMutation, useAppQuery } from "@/lib/hooks/use-app-query";
import { queryKeys } from "@/lib/shared/query-keys";
import { CACHE_TIERS } from "@/lib/shared/query-tiers";

type PreorderVariant = Awaited<ReturnType<typeof getPreorderProducts>>["variants"][number];

export default function DashboardPage() {
  const { data: stats } = useAppQuery({
    queryKey: ["admin", "dashboard-stats"],
    queryFn: () => getDashboardStats(),
    tier: CACHE_TIERS.REALTIME,
  });

  const s = stats?.stats;

  return (
    <div className="space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
        <p className="text-muted-foreground mt-1">Warehouse overview</p>
      </div>

      {/* Quick stats */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
        <StatCard icon={Package} label="Products" value={s?.totalProducts ?? 0} />
        <StatCard icon={ShoppingCart} label="Orders (month)" value={s?.monthOrders ?? 0} />
        <StatCard icon={Truck} label="Shipments (month)" value={s?.monthShipments ?? 0} />
        <StatCard
          icon={AlertTriangle}
          label="Critical Items"
          value={s?.criticalReviewItems ?? 0}
          highlight={(s?.criticalReviewItems ?? 0) > 0}
        />
        <StatCard icon={PackagePlus} label="Pending Inbound" value={s?.pendingInbound ?? 0} />
      </div>

      {/* Sync health */}
      {stats?.sensorHealth && Object.keys(stats.sensorHealth).length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Integration Health</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap gap-3">
              {Object.entries(stats.sensorHealth).map(([name, reading]) => {
                const r = reading as { status: string; message: string };
                return (
                  <div key={name} className="flex items-center gap-2 text-sm">
                    <div
                      className={`h-2 w-2 rounded-full ${
                        r.status === "healthy"
                          ? "bg-green-500"
                          : r.status === "warning"
                            ? "bg-yellow-500"
                            : "bg-red-500"
                      }`}
                    />
                    <span className="font-mono text-xs">{name}</span>
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <UpcomingReleasesCard />

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Recent Activity</CardTitle>
          </CardHeader>
          <CardContent>
            {!stats?.recentActivity || stats.recentActivity.length === 0 ? (
              <p className="text-muted-foreground text-sm">No recent activity.</p>
            ) : (
              <div className="space-y-2 max-h-80 overflow-auto">
                {stats.recentActivity.map((a) => (
                  <div key={a.id} className="flex items-center justify-between text-sm">
                    <span className="truncate flex-1">
                      <Badge
                        variant={a.type === "sync" ? "secondary" : "outline"}
                        className="mr-2 text-xs"
                      >
                        {a.type}
                      </Badge>
                      {a.message}
                    </span>
                    <span className="text-xs text-muted-foreground whitespace-nowrap ml-2">
                      {formatDistanceToNow(new Date(a.created_at), { addSuffix: true })}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function StatCard({
  icon: Icon,
  label,
  value,
  highlight,
}: {
  icon: typeof Package;
  label: string;
  value: number;
  highlight?: boolean;
}) {
  return (
    <Card>
      <CardContent className="p-4 flex items-center gap-3">
        <Icon className={`h-5 w-5 ${highlight ? "text-red-600" : "text-muted-foreground"}`} />
        <div>
          <p className="text-xs text-muted-foreground">{label}</p>
          <p className={`text-xl font-semibold tabular-nums ${highlight ? "text-red-600" : ""}`}>
            {value.toLocaleString()}
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

function UpcomingReleasesCard() {
  const { data, isLoading } = useAppQuery<Awaited<ReturnType<typeof getPreorderProducts>>>({
    queryKey: queryKeys.products.list({ preorders: true }),
    queryFn: () => getPreorderProducts({ pageSize: 30 }),
    tier: CACHE_TIERS.SESSION,
  });

  const releaseMutation = useAppMutation({
    mutationFn: (variantId: string) => manualRelease(variantId),
    invalidateKeys: [queryKeys.products.all, queryKeys.orders.all],
  });

  const handleRelease = useCallback(
    (variantId: string) => releaseMutation.mutate(variantId),
    [releaseMutation],
  );

  const variants = data?.variants ?? [];
  const today = new Date();
  const thirtyDaysOut = new Date();
  thirtyDaysOut.setDate(thirtyDaysOut.getDate() + 30);

  const upcoming = variants.filter(
    (v) =>
      v.streetDate && new Date(v.streetDate) >= today && new Date(v.streetDate) <= thirtyDaysOut,
  );
  const overdue = variants.filter((v) => v.streetDate && new Date(v.streetDate) < today);

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <Disc3 className="h-5 w-5 text-muted-foreground" />
          <div>
            <CardTitle className="text-base">Upcoming Releases</CardTitle>
            <CardDescription>Pre-orders in the next 30 days</CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        ) : upcoming.length === 0 && overdue.length === 0 ? (
          <p className="text-muted-foreground text-sm text-center py-4">No upcoming releases.</p>
        ) : (
          <div className="space-y-3">
            {overdue.length > 0 && (
              <div>
                <h3 className="text-xs font-medium text-destructive mb-1">
                  Overdue ({overdue.length})
                </h3>
                <PreorderList
                  variants={overdue}
                  onRelease={handleRelease}
                  isPending={releaseMutation.isPending}
                />
              </div>
            )}
            {upcoming.length > 0 && (
              <div>
                <h3 className="text-xs font-medium text-muted-foreground mb-1">
                  Upcoming ({upcoming.length})
                </h3>
                <PreorderList
                  variants={upcoming}
                  onRelease={handleRelease}
                  isPending={releaseMutation.isPending}
                />
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function PreorderList({
  variants,
  onRelease,
  isPending,
}: {
  variants: PreorderVariant[];
  onRelease: (id: string) => void;
  isPending: boolean;
}) {
  return (
    <div className="space-y-1">
      {variants.map((v) => (
        <div key={v.id} className="flex items-center justify-between text-sm">
          <div className="min-w-0 flex-1">
            <span className="font-medium truncate block">{v.productTitle}</span>
            <span className="text-xs text-muted-foreground">
              {v.streetDate ? new Date(v.streetDate).toLocaleDateString() : "—"} &middot;{" "}
              {v.orderCount} orders &middot; {v.availableStock} avail
              {v.isShortRisk && <span className="text-destructive ml-1">SHORT</span>}
            </span>
          </div>
          <Button size="sm" variant="ghost" onClick={() => onRelease(v.id)} disabled={isPending}>
            <Rocket className="h-3 w-3" />
          </Button>
        </div>
      ))}
    </div>
  );
}
```

---

## Caching/Realtime Notes

**Current behavior (from code):**

- **useAppQuery / useAppMutation wrappers**: All data reads use `useAppQuery` (wraps TanStack `useQuery`); mutations use `useAppMutation` (wraps `useMutation` with automatic `invalidateKeys` on success).
- **Cache tiers** (from `src/lib/shared/query-tiers.ts`):
  - `REALTIME`: `staleTime: 30_000`, `refetchInterval: 30_000` (30s)
  - `SESSION`: `staleTime: 5 * 60_000` (5 min)
  - `STABLE`: `staleTime: 30 * 60_000` (30 min)
- **No direct Supabase Realtime subscriptions**: The app does not use `supabase.channel()` or `.on('postgres_changes', ...)`. Live updates come from refetch intervals (REALTIME tier) and mutation-triggered invalidations.

---

## Admin Catalog Page

### Route: /admin/catalog — src/app/admin/catalog/page.tsx

```tsx
"use client";

import { ChevronLeft, ChevronRight, Package, Search } from "lucide-react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { getProducts } from "@/actions/catalog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useAppQuery } from "@/lib/hooks/use-app-query";
import { queryKeys } from "@/lib/shared/query-keys";
import { CACHE_TIERS } from "@/lib/shared/query-tiers";

const PAGE_SIZES = [25, 50, 100] as const;

const STATUS_VARIANTS: Record<string, "default" | "secondary" | "outline"> = {
  active: "default",
  draft: "secondary",
  archived: "outline",
};

export default function CatalogPage() {
  const router = useRouter();
  const [filters, setFilters] = useState({
    orgId: "",
    format: "",
    status: "" as "" | "active" | "draft" | "archived",
    search: "",
    page: 1,
    pageSize: 25 as 25 | 50 | 100,
  });

  const queryFilters = {
    ...(filters.orgId && { orgId: filters.orgId }),
    ...(filters.format && { format: filters.format }),
    ...(filters.status && { status: filters.status }),
    ...(filters.search && { search: filters.search }),
    page: filters.page,
    pageSize: filters.pageSize,
  };

  const { data, isLoading } = useAppQuery({
    queryKey: queryKeys.catalog.list(queryFilters),
    queryFn: () => getProducts(queryFilters),
    tier: CACHE_TIERS.SESSION,
  });

  const totalPages = data ? Math.ceil(data.total / data.pageSize) : 0;

  return (
    <div className="p-6 space-y-4">
      <h1 className="text-2xl font-semibold tracking-tight">Catalog</h1>

      {/* Filters */}
      <div className="flex flex-wrap gap-3">
        <div className="relative w-64">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search by title or SKU..."
            value={filters.search}
            onChange={(e) => setFilters((f) => ({ ...f, search: e.target.value, page: 1 }))}
            className="pl-9"
          />
        </div>
        <Input
          placeholder="Filter by org ID..."
          value={filters.orgId}
          onChange={(e) => setFilters((f) => ({ ...f, orgId: e.target.value, page: 1 }))}
          className="w-48"
        />
        <Input
          placeholder="Filter by format..."
          value={filters.format}
          onChange={(e) => setFilters((f) => ({ ...f, format: e.target.value, page: 1 }))}
          className="w-40"
        />
        <select
          value={filters.status}
          onChange={(e) =>
            setFilters((f) => ({
              ...f,
              status: e.target.value as "" | "active" | "draft" | "archived",
              page: 1,
            }))
          }
          className="border-input bg-background h-9 rounded-md border px-3 text-sm"
        >
          <option value="">All statuses</option>
          <option value="active">Active</option>
          <option value="draft">Draft</option>
          <option value="archived">Archived</option>
        </select>
      </div>

      {/* Table */}
      {isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={`skel-cat-${i.toString()}`} className="h-12 w-full" />
          ))}
        </div>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-12" />
              <TableHead>Title</TableHead>
              <TableHead>Label</TableHead>
              <TableHead>Variants</TableHead>
              <TableHead>Format</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Updated</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {(data?.products ?? []).map((product) => {
              const variants = (product.warehouse_product_variants ?? []) as Array<{
                id: string;
                sku: string;
                title: string | null;
                format_name: string | null;
                is_preorder: boolean;
              }>;
              const images = (product.warehouse_product_images ?? []) as Array<{
                id: string;
                src: string;
                alt: string | null;
                position: number;
              }>;
              const org = product.organizations as { id: string; name: string } | null;
              const primaryImage = images.sort((a, b) => a.position - b.position)[0];
              const formats = Array.from(
                new Set(variants.map((v) => v.format_name).filter(Boolean)),
              );

              return (
                <TableRow
                  key={product.id}
                  className="cursor-pointer"
                  onClick={() => router.push(`/admin/catalog/${product.id}`)}
                >
                  <TableCell>
                    {primaryImage ? (
                      <Image
                        src={primaryImage.src}
                        alt={primaryImage.alt ?? product.title}
                        width={32}
                        height={32}
                        className="h-8 w-8 rounded object-cover"
                      />
                    ) : (
                      <div className="bg-muted flex h-8 w-8 items-center justify-center rounded">
                        <Package className="text-muted-foreground h-4 w-4" />
                      </div>
                    )}
                  </TableCell>
                  <TableCell>
                    <div className="font-medium">{product.title}</div>
                    {variants.length === 1 && (
                      <div className="text-muted-foreground text-xs">{variants[0].sku}</div>
                    )}
                  </TableCell>
                  <TableCell className="text-muted-foreground text-sm">
                    {org?.name ?? product.vendor ?? "—"}
                  </TableCell>
                  <TableCell className="text-sm">{variants.length}</TableCell>
                  <TableCell className="text-muted-foreground text-sm">
                    {formats.join(", ") || "—"}
                  </TableCell>
                  <TableCell>
                    <Badge variant={STATUS_VARIANTS[product.status] ?? "outline"}>
                      {product.status}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-muted-foreground text-xs">
                    {product.updated_at ? new Date(product.updated_at).toLocaleDateString() : "—"}
                  </TableCell>
                </TableRow>
              );
            })}
            {(data?.products ?? []).length === 0 && (
              <TableRow>
                <TableCell colSpan={7} className="py-8 text-center text-muted-foreground">
                  <Package className="h-8 w-8 mx-auto mb-2 opacity-50" />
                  No products found.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      )}

      {/* Pagination */}
      {data && data.total > 0 && (
        <div className="flex items-center justify-between">
          <div className="text-muted-foreground flex items-center gap-2 text-sm">
            <span>Rows per page:</span>
            <select
              value={filters.pageSize}
              onChange={(e) =>
                setFilters((f) => ({
                  ...f,
                  pageSize: Number(e.target.value) as 25 | 50 | 100,
                  page: 1,
                }))
              }
              className="border-input bg-background rounded border px-2 py-1 text-sm"
            >
              {PAGE_SIZES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
            <span>
              {(data.page - 1) * data.pageSize + 1}–
              {Math.min(data.page * data.pageSize, data.total)} of {data.total}
            </span>
          </div>
          <div className="flex gap-1">
            <Button
              variant="outline"
              size="sm"
              disabled={filters.page <= 1}
              onClick={() => setFilters((f) => ({ ...f, page: f.page - 1 }))}
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={filters.page >= totalPages}
              onClick={() => setFilters((f) => ({ ...f, page: f.page + 1 }))}
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
```

---

## Admin Catalog Detail Page

### Route: /admin/catalog/[id] — src/app/admin/catalog/[id]/page.tsx

```tsx
"use client";

import { ArrowLeftIcon, ExternalLinkIcon } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useState } from "react";
import { getProductDetail, updateProduct, updateVariants } from "@/actions/catalog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useAppMutation, useAppQuery } from "@/lib/hooks/use-app-query";
import { queryKeys } from "@/lib/shared/query-keys";
import { CACHE_TIERS } from "@/lib/shared/query-tiers";
import type {
  BandcampProductMapping,
  WarehouseInventoryLevel,
  WarehouseProductImage,
  WarehouseProductVariant,
  WarehouseVariantLocation,
} from "@/lib/shared/types";

type VariantLocation = WarehouseVariantLocation & {
  warehouse_locations: { name: string; location_type: string } | null;
};

const STATUS_VARIANTS: Record<string, "default" | "secondary" | "outline"> = {
  active: "default",
  draft: "secondary",
  archived: "outline",
};

export default function ProductDetailPage() {
  const params = useParams<{ id: string }>();
  const productId = params.id;

  const { data: product, isLoading } = useAppQuery({
    queryKey: queryKeys.products.detail(productId),
    queryFn: () => getProductDetail(productId),
    tier: CACHE_TIERS.STABLE,
  });

  const [editMode, setEditMode] = useState(false);
  const [editTitle, setEditTitle] = useState("");
  const [editProductType, setEditProductType] = useState("");
  const [editTags, setEditTags] = useState("");

  const startEdit = useCallback(() => {
    if (!product) return;
    setEditTitle(product.title);
    setEditProductType(product.product_type ?? "");
    setEditTags((product.tags as string[])?.join(", ") ?? "");
    setEditMode(true);
  }, [product]);

  const productMutation = useAppMutation({
    mutationFn: () =>
      updateProduct(productId, {
        title: editTitle,
        productType: editProductType || undefined,
        tags: editTags
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean),
      }),
    invalidateKeys: [queryKeys.products.detail(productId), queryKeys.products.all],
    onSuccess: () => setEditMode(false),
  });

  const [editingVariantId, setEditingVariantId] = useState<string | null>(null);
  const [variantPrice, setVariantPrice] = useState("");
  const [variantCompareAt, setVariantCompareAt] = useState("");
  const [variantWeight, setVariantWeight] = useState("");

  const startVariantEdit = useCallback((variant: WarehouseProductVariant) => {
    setEditingVariantId(variant.id);
    setVariantPrice(variant.price?.toString() ?? "");
    setVariantCompareAt(variant.compare_at_price?.toString() ?? "");
    setVariantWeight(variant.weight?.toString() ?? "");
  }, []);

  const variantMutation = useAppMutation({
    mutationFn: () => {
      const variant = (product?.warehouse_product_variants as WarehouseProductVariant[])?.find(
        (v) => v.id === editingVariantId,
      );
      if (!variant) throw new Error("Variant not found");
      return updateVariants(productId, [
        {
          id: variant.id,
          shopifyVariantId: variant.shopify_variant_id ?? "",
          price: variantPrice || undefined,
          compareAtPrice: variantCompareAt || null,
          weight: variantWeight ? Number(variantWeight) : undefined,
        },
      ]);
    },
    invalidateKeys: [queryKeys.products.detail(productId), queryKeys.products.all],
    onSuccess: () => setEditingVariantId(null),
  });

  if (isLoading) {
    return (
      <div className="p-6">
        <p className="text-muted-foreground">Loading product...</p>
      </div>
    );
  }

  if (!product) {
    return (
      <div className="p-6">
        <p className="text-muted-foreground">Product not found.</p>
      </div>
    );
  }

  const variants = (product.warehouse_product_variants ?? []) as WarehouseProductVariant[];
  const images = (product.warehouse_product_images ?? []) as WarehouseProductImage[];
  const inventoryLevels = (product.inventoryLevels ?? []) as WarehouseInventoryLevel[];
  const variantLocations = (product.variantLocations ?? []) as VariantLocation[];
  const bandcampMappings = (product.bandcampMappings ?? []) as BandcampProductMapping[];
  const org = product.organizations as { id: string; name: string } | null;

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center gap-3">
        <Link href="/admin/catalog">
          <Button variant="ghost" size="icon-sm">
            <ArrowLeftIcon className="size-4" />
          </Button>
        </Link>
        <div className="flex-1">
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-semibold tracking-tight">{product.title}</h1>
            <Badge variant={STATUS_VARIANTS[product.status] ?? "outline"}>{product.status}</Badge>
          </div>
          <p className="text-sm text-muted-foreground mt-1">
            {org?.name ?? product.vendor ?? "Unknown vendor"}
            {product.shopify_product_id && (
              <>
                {" · "}
                <a
                  href={`https://${product.shopify_handle ? "" : "admin.shopify.com"}/products/${product.shopify_product_id}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-blue-600 hover:underline"
                >
                  Shopify <ExternalLinkIcon className="size-3" />
                </a>
              </>
            )}
          </p>
        </div>
        {!editMode && (
          <Button variant="outline" onClick={startEdit}>
            Edit Product
          </Button>
        )}
      </div>

      {editMode && (
        <Card>
          <CardHeader>
            <CardTitle>Edit Product</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div>
              <label className="text-sm font-medium" htmlFor="edit-title">
                Title
              </label>
              <Input
                id="edit-title"
                value={editTitle}
                onChange={(e) => setEditTitle(e.currentTarget.value)}
              />
            </div>
            <div>
              <label className="text-sm font-medium" htmlFor="edit-type">
                Product Type
              </label>
              <Input
                id="edit-type"
                value={editProductType}
                onChange={(e) => setEditProductType(e.currentTarget.value)}
              />
            </div>
            <div>
              <label className="text-sm font-medium" htmlFor="edit-tags">
                Tags (comma-separated)
              </label>
              <Input
                id="edit-tags"
                value={editTags}
                onChange={(e) => setEditTags(e.currentTarget.value)}
              />
            </div>
            <div className="flex gap-2">
              <Button
                onClick={() => productMutation.mutate(undefined)}
                disabled={productMutation.isPending}
              >
                {productMutation.isPending ? "Saving..." : "Save"}
              </Button>
              <Button variant="outline" onClick={() => setEditMode(false)}>
                Cancel
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      <Tabs defaultValue="variants">
        <TabsList>
          <TabsTrigger value="variants">Variants</TabsTrigger>
          <TabsTrigger value="images">Images</TabsTrigger>
          <TabsTrigger value="inventory">Inventory</TabsTrigger>
          <TabsTrigger value="bandcamp">Bandcamp</TabsTrigger>
        </TabsList>

        <TabsContent value="variants">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>SKU</TableHead>
                <TableHead>Title</TableHead>
                <TableHead>Price</TableHead>
                <TableHead>Compare At</TableHead>
                <TableHead>Barcode</TableHead>
                <TableHead>Weight</TableHead>
                <TableHead>Format</TableHead>
                <TableHead>Pre-Order</TableHead>
                <TableHead>Street Date</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {variants.map((variant) => (
                <TableRow key={variant.id}>
                  {editingVariantId === variant.id ? (
                    <>
                      <TableCell className="font-mono text-xs">{variant.sku}</TableCell>
                      <TableCell>{variant.title ?? "—"}</TableCell>
                      <TableCell>
                        <Input
                          className="w-24"
                          value={variantPrice}
                          onChange={(e) => setVariantPrice(e.currentTarget.value)}
                        />
                      </TableCell>
                      <TableCell>
                        <Input
                          className="w-24"
                          value={variantCompareAt}
                          onChange={(e) => setVariantCompareAt(e.currentTarget.value)}
                        />
                      </TableCell>
                      <TableCell>{variant.barcode ?? "—"}</TableCell>
                      <TableCell>
                        <Input
                          className="w-20"
                          value={variantWeight}
                          onChange={(e) => setVariantWeight(e.currentTarget.value)}
                        />
                      </TableCell>
                      <TableCell>{variant.format_name ?? "—"}</TableCell>
                      <TableCell>{variant.is_preorder ? "Yes" : "No"}</TableCell>
                      <TableCell>{variant.street_date ?? "—"}</TableCell>
                      <TableCell>
                        <div className="flex gap-1">
                          <Button
                            size="xs"
                            onClick={() => variantMutation.mutate(undefined)}
                            disabled={variantMutation.isPending}
                          >
                            Save
                          </Button>
                          <Button
                            size="xs"
                            variant="outline"
                            onClick={() => setEditingVariantId(null)}
                          >
                            Cancel
                          </Button>
                        </div>
                      </TableCell>
                    </>
                  ) : (
                    <>
                      <TableCell className="font-mono text-xs">{variant.sku}</TableCell>
                      <TableCell>{variant.title ?? "—"}</TableCell>
                      <TableCell>
                        {variant.price != null ? `$${Number(variant.price).toFixed(2)}` : "—"}
                      </TableCell>
                      <TableCell>
                        {variant.compare_at_price != null
                          ? `$${Number(variant.compare_at_price).toFixed(2)}`
                          : "—"}
                      </TableCell>
                      <TableCell>{variant.barcode ?? "—"}</TableCell>
                      <TableCell>
                        {variant.weight != null ? `${variant.weight} ${variant.weight_unit}` : "—"}
                      </TableCell>
                      <TableCell>{variant.format_name ?? "—"}</TableCell>
                      <TableCell>{variant.is_preorder ? "Yes" : "No"}</TableCell>
                      <TableCell>{variant.street_date ?? "—"}</TableCell>
                      <TableCell>
                        <Button size="xs" variant="ghost" onClick={() => startVariantEdit(variant)}>
                          Edit
                        </Button>
                      </TableCell>
                    </>
                  )}
                </TableRow>
              ))}
              {variants.length === 0 && (
                <TableRow>
                  <TableCell colSpan={10} className="text-center py-4 text-muted-foreground">
                    No variants.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </TabsContent>

        <TabsContent value="images">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            {images
              .sort((a, b) => a.position - b.position)
              .map((img) => (
                <div key={img.id} className="rounded-lg overflow-hidden border">
                  <Image
                    src={img.src}
                    alt={img.alt ?? product.title}
                    width={300}
                    height={300}
                    className="object-cover w-full aspect-square"
                  />
                  {img.alt && (
                    <p className="px-2 py-1 text-xs text-muted-foreground truncate">{img.alt}</p>
                  )}
                </div>
              ))}
            {images.length === 0 && (
              <p className="col-span-full text-muted-foreground py-4">No images.</p>
            )}
          </div>
        </TabsContent>

        <TabsContent value="inventory">
          <div className="space-y-4">
            {variants.map((variant) => {
              const inv = inventoryLevels.find((l) => l.variant_id === variant.id);
              const locations = variantLocations.filter((vl) => vl.variant_id === variant.id);

              return (
                <Card key={variant.id} size="sm">
                  <CardHeader>
                    <CardTitle>
                      {variant.sku} — {variant.title ?? "Default"}
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    {inv ? (
                      <div className="grid grid-cols-3 gap-4 mb-3">
                        <div>
                          <p className="text-xs text-muted-foreground">Available</p>
                          <p className="text-lg font-semibold">{inv.available}</p>
                        </div>
                        <div>
                          <p className="text-xs text-muted-foreground">Committed</p>
                          <p className="text-lg font-semibold">{inv.committed}</p>
                        </div>
                        <div>
                          <p className="text-xs text-muted-foreground">Incoming</p>
                          <p className="text-lg font-semibold">{inv.incoming}</p>
                        </div>
                      </div>
                    ) : (
                      <p className="text-sm text-muted-foreground mb-3">No inventory data.</p>
                    )}

                    {locations.length > 0 && (
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>Location</TableHead>
                            <TableHead>Type</TableHead>
                            <TableHead>Quantity</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {locations.map((loc) => (
                            <TableRow key={loc.id}>
                              <TableCell>{loc.warehouse_locations?.name ?? "Unknown"}</TableCell>
                              <TableCell>{loc.warehouse_locations?.location_type ?? "—"}</TableCell>
                              <TableCell>{loc.quantity}</TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    )}
                  </CardContent>
                </Card>
              );
            })}
            {variants.length === 0 && (
              <p className="text-muted-foreground py-4">No variants to show inventory for.</p>
            )}
          </div>
        </TabsContent>

        <TabsContent value="bandcamp">
          {bandcampMappings.length > 0 ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Variant</TableHead>
                  <TableHead>Bandcamp URL</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>New Date</TableHead>
                  <TableHead>Last Qty Sold</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {bandcampMappings.map((mapping) => {
                  const variant = variants.find((v) => v.id === mapping.variant_id);
                  return (
                    <TableRow key={mapping.id}>
                      <TableCell className="font-mono text-xs">
                        {variant?.sku ?? mapping.variant_id}
                      </TableCell>
                      <TableCell>
                        {mapping.bandcamp_url ? (
                          <a
                            href={mapping.bandcamp_url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1 text-blue-600 hover:underline"
                          >
                            {mapping.bandcamp_url}
                            <ExternalLinkIcon className="size-3" />
                          </a>
                        ) : (
                          "—"
                        )}
                      </TableCell>
                      <TableCell>{mapping.bandcamp_type_name ?? "—"}</TableCell>
                      <TableCell>{mapping.bandcamp_new_date ?? "—"}</TableCell>
                      <TableCell>{mapping.last_quantity_sold ?? "—"}</TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          ) : (
            <p className="text-muted-foreground py-4">No Bandcamp mappings for this product.</p>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
```
