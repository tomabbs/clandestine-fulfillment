# Full Page Source and Visual System Handoff

**Date:** 2026-03-18  
**Scope:** Complete page source, visual styling replication detail, navigation map, and click-through behavior for Clandestine Fulfillment admin and portal applications.

---

## 1. Title and Scope

This document provides a complete handoff of:

- **Visual system** — Tailwind/PostCSS/shadcn stack, theme tokens, and core UI components
- **Navigation and layout** — Admin and portal sidebar structure, layout composition
- **Full page source** — Exact file contents for all admin and portal pages listed
- **Click-through behavior** — How list rows expand to show detail (shipping, catalog, orders)

**In-scope pages:**
- Admin: Dashboard, Catalog (list + detail), Clients (list + detail), Shipping, Orders, Billing, Inventory, Inbound (list + detail), Review Queue, Scan, Store Mapping
- Portal: Billing, Shipping, Inventory, Orders

---

## 2. Navigation and Layout Map

### Admin Layout (`/admin/*`)

```
┌─────────────────────────────────────────────────────────────────┐
│ SidebarProvider                                                  │
│ ┌──────────────────┐  ┌──────────────────────────────────────┐ │
│ │ AdminSidebar      │  │ SidebarInset                           │ │
│ │ - Dashboard       │  │ ┌────────────────────────────────────┐ │ │
│ │ - Scan            │  │ │ header (h-12, border-b)            │ │ │
│ │ - Inventory       │  │ │ SidebarTrigger                      │ │ │
│ │ - Inbound         │  │ └────────────────────────────────────┘ │ │
│ │ - Orders          │  │ ┌────────────────────────────────────┐ │ │
│ │ - Catalog         │  │ │ main (flex-1)                       │ │ │
│ │ - Clients         │  │ │ {children} — page content           │ │ │
│ │ - Shipping        │  │ └────────────────────────────────────┘ │ │
│ │ - Billing         │  └──────────────────────────────────────┘ │
│ │ - Channels        │                                            │
│ │ - Review Q        │  CommandPalette (global)                   │
│ │ - Support         │                                            │
│ │ - Settings ▼      │                                            │
│ │   - General       │                                            │
│ │   - Bandcamp      │                                            │
│ │   - Store Conn.   │                                            │
│ │   - Store Mapping │                                            │
│ │   - Integrations  │                                            │
│ │   - Health        │                                            │
│ └──────────────────┘                                            │
└─────────────────────────────────────────────────────────────────┘
```

### Portal Layout (`/portal/*`)

```
┌─────────────────────────────────────────────────────────────────┐
│ SidebarProvider                                                  │
│ ┌──────────────────┐  ┌──────────────────────────────────────┐ │
│ │ PortalSidebar     │  │ SidebarInset                           │ │
│ │ - Home            │  │ Same structure: header + main         │ │
│ │ - Inventory       │  │ {children}                            │ │
│ │ - Releases        │  └──────────────────────────────────────┘ │
│ │ - Inbound         │  CommandPalette (global)                   │
│ │ - Orders          │                                            │
│ │ - Shipping        │                                            │
│ │ - Sales           │                                            │
│ │ - Billing         │                                            │
│ │ - Support         │                                            │
│ │ - Settings        │                                            │
│ └──────────────────┘                                            │
└─────────────────────────────────────────────────────────────────┘
```

**Brief explanation:** Both admin and portal use `SidebarProvider` + `SidebarInset`. The sidebar is collapsible (desktop: icon/offcanvas; mobile: Sheet overlay). Header contains `SidebarTrigger`. `CommandPalette` is rendered globally for quick navigation.

---

## 3. Visual System Technical Detail

### Tailwind / PostCSS / shadcn Stack Notes

- **Tailwind v4** via `@tailwindcss/postcss`
- **tw-animate-css** for animations
- **shadcn/tailwind.css** for component tokens
- **PostCSS** plugins: `@tailwindcss/postcss`, `autoprefixer`
- **components.json** style: `base-nova`, baseColor: `neutral`, cssVariables: true, iconLibrary: `lucide`

### Theme / Token Notes from globals.css

- **:root** — Light theme: neutral grays, `--radius: 0.625rem`, sidebar tokens
- **.dark** — Dark theme overrides for background, foreground, card, sidebar, etc.
- **@theme inline** — Maps CSS vars to Tailwind color/radius utilities
- **@layer base** — `border-border outline-ring/50` on `*`, `bg-background text-foreground` on body, `font-sans` on html

### CSS and Front-End Replication Notes

- **Token system in globals.css:** All colors, radii, and sidebar tokens live in `:root` and `.dark` blocks. Use `@theme inline` to map CSS vars to Tailwind utilities (`--color-muted`, `--radius-sm`, etc.). Replicate by copying the `:root` / `.dark` / `@theme inline` blocks and importing `shadcn/tailwind.css`.
- **Component variant approach (cva):** UI components (Button, Tabs, Badge, etc.) use `class-variance-authority` (`cva`) for variants (e.g. `variant: "default" | "outline" | "ghost"`, `size: "sm" | "default" | "lg"`). Apply `cn()` to merge base classes with variant classes.
- **Layout shell:** Admin/portal use `SidebarProvider` → `Sidebar` + `SidebarInset`. `SidebarInset` wraps page content; `SidebarTrigger` toggles on mobile. Responsive header with breadcrumbs and actions sits inside the inset.
- **Table / expanded-row interaction pattern:** Tables use `thead className="bg-muted/50"`, `tr className="hover:bg-muted/30 cursor-pointer"` for row hover. Row click toggles `expandedId`; when expanded, a second row with `colSpan={n}` and `bg-muted/30` (or `bg-muted/50`) shows expanded content.
- **State styles:** Hover: `hover:bg-muted/30` or `hover:bg-muted`; muted backgrounds: `bg-muted`, `bg-muted/50` for headers; status badges use `Badge` with `variant` (e.g. `variant="secondary"`, `variant="destructive"`) and `className` overrides for custom colors.

---

### src/app/globals.css

```css
@import "tailwindcss";
@import "tw-animate-css";
@import "shadcn/tailwind.css";

@custom-variant dark (&:is(.dark *));

:root {
    --background: oklch(1 0 0);
    --foreground: oklch(0.145 0 0);
    --card: oklch(1 0 0);
    --card-foreground: oklch(0.145 0 0);
    --popover: oklch(1 0 0);
    --popover-foreground: oklch(0.145 0 0);
    --primary: oklch(0.205 0 0);
    --primary-foreground: oklch(0.985 0 0);
    --secondary: oklch(0.97 0 0);
    --secondary-foreground: oklch(0.205 0 0);
    --muted: oklch(0.97 0 0);
    --muted-foreground: oklch(0.556 0 0);
    --accent: oklch(0.97 0 0);
    --accent-foreground: oklch(0.205 0 0);
    --destructive: oklch(0.577 0.245 27.325);
    --border: oklch(0.922 0 0);
    --input: oklch(0.922 0 0);
    --ring: oklch(0.708 0 0);
    --chart-1: oklch(0.809 0.105 251.813);
    --chart-2: oklch(0.623 0.214 259.815);
    --chart-3: oklch(0.546 0.245 262.881);
    --chart-4: oklch(0.488 0.243 264.376);
    --chart-5: oklch(0.424 0.199 265.638);
    --radius: 0.625rem;
    --sidebar: oklch(0.985 0 0);
    --sidebar-foreground: oklch(0.145 0 0);
    --sidebar-primary: oklch(0.205 0 0);
    --sidebar-primary-foreground: oklch(0.985 0 0);
    --sidebar-accent: oklch(0.97 0 0);
    --sidebar-accent-foreground: oklch(0.205 0 0);
    --sidebar-border: oklch(0.922 0 0);
    --sidebar-ring: oklch(0.708 0 0);
}

.dark {
    --background: oklch(0.145 0 0);
    --foreground: oklch(0.985 0 0);
    --card: oklch(0.205 0 0);
    --card-foreground: oklch(0.985 0 0);
    --popover: oklch(0.205 0 0);
    --popover-foreground: oklch(0.985 0 0);
    --primary: oklch(0.922 0 0);
    --primary-foreground: oklch(0.205 0 0);
    --secondary: oklch(0.269 0 0);
    --secondary-foreground: oklch(0.985 0 0);
    --muted: oklch(0.269 0 0);
    --muted-foreground: oklch(0.708 0 0);
    --accent: oklch(0.269 0 0);
    --accent-foreground: oklch(0.985 0 0);
    --destructive: oklch(0.704 0.191 22.216);
    --border: oklch(1 0 0 / 10%);
    --input: oklch(1 0 0 / 15%);
    --ring: oklch(0.556 0 0);
    --chart-1: oklch(0.809 0.105 251.813);
    --chart-2: oklch(0.623 0.214 259.815);
    --chart-3: oklch(0.546 0.245 262.881);
    --chart-4: oklch(0.488 0.243 264.376);
    --chart-5: oklch(0.424 0.199 265.638);
    --sidebar: oklch(0.205 0 0);
    --sidebar-foreground: oklch(0.985 0 0);
    --sidebar-primary: oklch(0.488 0.243 264.376);
    --sidebar-primary-foreground: oklch(0.985 0 0);
    --sidebar-accent: oklch(0.269 0 0);
    --sidebar-accent-foreground: oklch(0.985 0 0);
    --sidebar-border: oklch(1 0 0 / 10%);
    --sidebar-ring: oklch(0.556 0 0);
}

@theme inline {
    --font-sans: var(--font-sans);
    --color-sidebar-ring: var(--sidebar-ring);
    --color-sidebar-border: var(--sidebar-border);
    --color-sidebar-accent-foreground: var(--sidebar-accent-foreground);
    --color-sidebar-accent: var(--sidebar-accent);
    --color-sidebar-primary-foreground: var(--sidebar-primary-foreground);
    --color-sidebar-primary: var(--sidebar-primary);
    --color-sidebar-foreground: var(--sidebar-foreground);
    --color-sidebar: var(--sidebar);
    --color-chart-5: var(--chart-5);
    --color-chart-4: var(--chart-4);
    --color-chart-3: var(--chart-3);
    --color-chart-2: var(--chart-2);
    --color-chart-1: var(--chart-1);
    --color-ring: var(--ring);
    --color-input: var(--input);
    --color-border: var(--border);
    --color-destructive: var(--destructive);
    --color-accent-foreground: var(--accent-foreground);
    --color-accent: var(--accent);
    --color-muted-foreground: var(--muted-foreground);
    --color-muted: var(--muted);
    --color-secondary-foreground: var(--secondary-foreground);
    --color-secondary: var(--secondary);
    --color-primary-foreground: var(--primary-foreground);
    --color-primary: var(--primary);
    --color-popover-foreground: var(--popover-foreground);
    --color-popover: var(--popover);
    --color-card-foreground: var(--card-foreground);
    --color-card: var(--card);
    --color-foreground: var(--foreground);
    --color-background: var(--background);
    --radius-sm: calc(var(--radius) * 0.6);
    --radius-md: calc(var(--radius) * 0.8);
    --radius-lg: var(--radius);
    --radius-xl: calc(var(--radius) * 1.4);
    --radius-2xl: calc(var(--radius) * 1.8);
    --radius-3xl: calc(var(--radius) * 2.2);
    --radius-4xl: calc(var(--radius) * 2.6);
}

@layer base {
  * {
    @apply border-border outline-ring/50;
  }
  body {
    @apply bg-background text-foreground;
  }
  html {
    @apply font-sans;
  }
}
```

---

### components.json

```json
{
  "$schema": "https://ui.shadcn.com/schema.json",
  "style": "base-nova",
  "rsc": true,
  "tsx": true,
  "tailwind": {
    "config": "",
    "css": "src/app/globals.css",
    "baseColor": "neutral",
    "cssVariables": true,
    "prefix": ""
  },
  "iconLibrary": "lucide",
  "rtl": false,
  "aliases": {
    "components": "@/components",
    "utils": "@/lib/utils",
    "ui": "@/components/ui",
    "lib": "@/lib",
    "hooks": "@/hooks"
  },
  "menuColor": "default",
  "menuAccent": "subtle",
  "registries": {}
}
```

---

### postcss.config.mjs

```js
/** @type {import('postcss-load-config').Config} */
const config = {
  plugins: {
    "@tailwindcss/postcss": {},
    autoprefixer: {},
  },
};

export default config;
```

---

### src/components/admin/admin-sidebar.tsx

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

---

### src/components/portal/portal-sidebar.tsx

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

---

### src/app/admin/layout.tsx

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

---

### src/app/portal/layout.tsx

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

### src/components/shared/page-skeleton.tsx

*Note: The shared skeleton components are exported from a file that provides TableSkeleton, CardSkeleton, StatsRowSkeleton, and PageHeaderSkeleton. If the file is named differently (e.g. `table-skeleton.tsx`), the exports below represent the skeleton primitives used across pages.*

```tsx
import { Skeleton } from "@/components/ui/skeleton";

export function TableSkeleton({ rows = 5, columns = 5 }: { rows?: number; columns?: number }) {
  return (
    <div className="rounded-md border">
      <div className="bg-muted/50 p-3 flex gap-4">
        {Array.from({ length: columns }).map((_, i) => (
          <Skeleton key={`th-${i.toString()}`} className="h-4 flex-1" />
        ))}
      </div>
      {Array.from({ length: rows }).map((_, i) => (
        <div key={`tr-${i.toString()}`} className="border-t p-3 flex gap-4">
          {Array.from({ length: columns }).map((_, j) => (
            <Skeleton key={`td-${i.toString()}-${j.toString()}`} className="h-4 flex-1" />
          ))}
        </div>
      ))}
    </div>
  );
}

export function CardSkeleton() {
  return (
    <div className="rounded-lg border p-4 space-y-2">
      <Skeleton className="h-4 w-24" />
      <Skeleton className="h-8 w-16" />
    </div>
  );
}

export function StatsRowSkeleton({ count = 4 }: { count?: number }) {
  return (
    <div className="grid gap-4" style={{ gridTemplateColumns: `repeat(${count}, 1fr)` }}>
      {Array.from({ length: count }).map((_, i) => (
        <CardSkeleton key={`stat-${i.toString()}`} />
      ))}
    </div>
  );
}

export function PageHeaderSkeleton() {
  return (
    <div className="space-y-2">
      <Skeleton className="h-8 w-48" />
      <Skeleton className="h-4 w-64" />
    </div>
  );
}
```

---

### src/components/shared/tracking-timeline.tsx

```tsx
"use client";

import {
  AlertTriangle,
  CheckCircle,
  Clock,
  ExternalLink,
  MapPin,
  Package,
  Truck,
} from "lucide-react";
import { useAppQuery } from "@/lib/hooks/use-app-query";
import { CACHE_TIERS } from "@/lib/shared/query-tiers";

interface TrackingEvent {
  id: string;
  status: string;
  description: string | null;
  location: string | null;
  event_time: string | null;
  source: string | null;
}

interface TrackingTimelineProps {
  shipmentId: string;
  trackingNumber: string | null;
  carrier: string | null;
  fetchEvents: (shipmentId: string) => Promise<TrackingEvent[]>;
}

const STATUS_CONFIG: Record<string, { icon: typeof Package; color: string; label: string }> = {
  shipped: { icon: Package, color: "text-blue-600", label: "Shipped" },
  in_transit: { icon: Truck, color: "text-blue-600", label: "In Transit" },
  InTransit: { icon: Truck, color: "text-blue-600", label: "In Transit" },
  out_for_delivery: { icon: Truck, color: "text-green-600", label: "Out for Delivery" },
  OutForDelivery: { icon: Truck, color: "text-green-600", label: "Out for Delivery" },
  delivered: { icon: CheckCircle, color: "text-green-600", label: "Delivered" },
  Delivered: { icon: CheckCircle, color: "text-green-600", label: "Delivered" },
  exception: { icon: AlertTriangle, color: "text-red-600", label: "Exception" },
  Exception: { icon: AlertTriangle, color: "text-red-600", label: "Exception" },
  AttemptFail: { icon: AlertTriangle, color: "text-orange-600", label: "Delivery Failed" },
};

function getStatusConfig(status: string) {
  return STATUS_CONFIG[status] ?? { icon: Clock, color: "text-muted-foreground", label: status };
}

function getCarrierTrackingUrl(
  carrier: string | null,
  trackingNumber: string | null,
): string | null {
  if (!carrier || !trackingNumber) return null;
  const c = carrier.toLowerCase();
  if (c.includes("usps"))
    return `https://tools.usps.com/go/TrackConfirmAction?qtc_tLabels1=${trackingNumber}`;
  if (c.includes("ups")) return `https://www.ups.com/track?tracknum=${trackingNumber}`;
  if (c.includes("fedex")) return `https://www.fedex.com/fedextrack/?trknbr=${trackingNumber}`;
  if (c.includes("dhl"))
    return `https://www.dhl.com/us-en/home/tracking.html?tracking-id=${trackingNumber}`;
  return null;
}

export function TrackingTimeline({
  shipmentId,
  trackingNumber,
  carrier,
  fetchEvents,
}: TrackingTimelineProps) {
  const { data: events, isLoading } = useAppQuery<TrackingEvent[]>({
    queryKey: ["tracking-events", shipmentId],
    queryFn: () => fetchEvents(shipmentId),
    tier: CACHE_TIERS.SESSION,
  });

  const trackingUrl = getCarrierTrackingUrl(carrier, trackingNumber);

  return (
    <div className="space-y-3">
      {/* Header with tracking info */}
      {trackingNumber && (
        <div className="flex items-center gap-2 text-sm">
          <span className="font-mono text-xs">{trackingNumber}</span>
          {carrier && <span className="text-muted-foreground">via {carrier}</span>}
          {trackingUrl && (
            <a
              href={trackingUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-blue-600 hover:underline"
            >
              <ExternalLink className="h-3 w-3" />
              Track
            </a>
          )}
        </div>
      )}

      {/* Timeline */}
      {isLoading ? (
        <div className="space-y-2">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-12 bg-muted animate-pulse rounded" />
          ))}
        </div>
      ) : !events || events.length === 0 ? (
        <p className="text-muted-foreground text-sm">No tracking events yet.</p>
      ) : (
        <div className="relative pl-6">
          <div className="absolute left-2.5 top-0 bottom-0 w-px bg-border" />
          {events.map((event, i) => {
            const config = getStatusConfig(event.status);
            const Icon = config.icon;
            const isFirst = i === 0;

            return (
              <div key={event.id} className="relative pb-4 last:pb-0">
                <div
                  className={`absolute -left-3.5 top-0.5 flex h-5 w-5 items-center justify-center rounded-full ${isFirst ? "bg-background ring-2 ring-border" : "bg-background"}`}
                >
                  <Icon className={`h-3 w-3 ${config.color}`} />
                </div>
                <div className="ml-2">
                  <p className={`text-sm font-medium ${isFirst ? "" : "text-muted-foreground"}`}>
                    {config.label}
                  </p>
                  {event.description && (
                    <p className="text-xs text-muted-foreground">{event.description}</p>
                  )}
                  <div className="flex items-center gap-2 mt-0.5">
                    {event.location && (
                      <span className="flex items-center gap-1 text-xs text-muted-foreground">
                        <MapPin className="h-3 w-3" />
                        {event.location}
                      </span>
                    )}
                    {event.event_time && (
                      <span className="text-xs text-muted-foreground">
                        {new Date(event.event_time).toLocaleString()}
                      </span>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
```

---

### src/components/ui/sidebar.tsx

*Full file is 483 lines. Key exports: SidebarProvider, Sidebar, SidebarContent, SidebarFooter, SidebarHeader, SidebarInset, SidebarTrigger, SidebarMenu, SidebarMenuItem, SidebarMenuButton, SidebarMenuSub, SidebarMenuSubItem, SidebarMenuSubButton, SidebarGroup, SidebarGroupContent. Uses @base-ui/react, cva, Sheet, Skeleton, Tooltip. See project source for complete implementation.*

---

### src/components/ui/button.tsx

```tsx
"use client"

import { Button as ButtonPrimitive } from "@base-ui/react/button"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

const buttonVariants = cva(
  "group/button inline-flex shrink-0 items-center justify-center rounded-lg border border-transparent bg-clip-padding text-sm font-medium whitespace-nowrap transition-all outline-none select-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 active:translate-y-px disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground [a]:hover:bg-primary/80",
        outline:
          "border-border bg-background hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground dark:border-input dark:bg-input/30 dark:hover:bg-input/50",
        secondary:
          "bg-secondary text-secondary-foreground hover:bg-secondary/80 aria-expanded:bg-secondary aria-expanded:text-secondary-foreground",
        ghost:
          "hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground dark:hover:bg-muted/50",
        destructive:
          "bg-destructive/10 text-destructive hover:bg-destructive/20 focus-visible:border-destructive/40 focus-visible:ring-destructive/20 dark:bg-destructive/20 dark:hover:bg-destructive/30 dark:focus-visible:ring-destructive/40",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default:
          "h-8 gap-1.5 px-2.5 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2",
        xs: "h-6 gap-1 rounded-[min(var(--radius-md),10px)] px-2 text-xs in-data-[slot=button-group]:rounded-lg has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3",
        sm: "h-7 gap-1 rounded-[min(var(--radius-md),12px)] px-2.5 text-[0.8rem] in-data-[slot=button-group]:rounded-lg has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3.5",
        lg: "h-9 gap-1.5 px-2.5 has-data-[icon=inline-end]:pr-3 has-data-[icon=inline-start]:pl-3",
        icon: "size-8",
        "icon-xs":
          "size-6 rounded-[min(var(--radius-md),10px)] in-data-[slot=button-group]:rounded-lg [&_svg:not([class*='size-'])]:size-3",
        "icon-sm":
          "size-7 rounded-[min(var(--radius-md),12px)] in-data-[slot=button-group]:rounded-lg",
        "icon-lg": "size-9",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Button({
  className,
  variant = "default",
  size = "default",
  ...props
}: ButtonPrimitive.Props & VariantProps<typeof buttonVariants>) {
  return (
    <ButtonPrimitive
      data-slot="button"
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
```

---

### src/components/ui/input.tsx

```tsx
import { Input as InputPrimitive } from "@base-ui/react/input"
import * as React from "react"

import { cn } from "@/lib/utils"

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <InputPrimitive
      type={type}
      data-slot="input"
      className={cn(
        "h-8 w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 py-1 text-base transition-colors outline-none file:inline-flex file:h-6 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:cursor-not-allowed disabled:bg-input/50 disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 md:text-sm dark:bg-input/30 dark:disabled:bg-input/80 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40",
        className
      )}
      {...props}
    />
  )
}

export { Input }
```

---

### src/components/ui/card.tsx

```tsx
import * as React from "react"

import { cn } from "@/lib/utils"

function Card({
  className,
  size = "default",
  ...props
}: React.ComponentProps<"div"> & { size?: "default" | "sm" }) {
  return (
    <div
      data-slot="card"
      data-size={size}
      className={cn(
        "group/card flex flex-col gap-4 overflow-hidden rounded-xl bg-card py-4 text-sm text-card-foreground ring-1 ring-foreground/10 has-data-[slot=card-footer]:pb-0 has-[>img:first-child]:pt-0 data-[size=sm]:gap-3 data-[size=sm]:py-3 data-[size=sm]:has-data-[slot=card-footer]:pb-0 *:[img:first-child]:rounded-t-xl *:[img:last-child]:rounded-b-xl",
        className
      )}
      {...props}
    />
  )
}

function CardHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-header"
      className={cn(
        "group/card-header @container/card-header grid auto-rows-min items-start gap-1 rounded-t-xl px-4 group-data-[size=sm]/card:px-3 has-data-[slot=card-action]:grid-cols-[1fr_auto] has-data-[slot=card-description]:grid-rows-[auto_auto] [.border-b]:pb-4 group-data-[size=sm]/card:[.border-b]:pb-3",
        className
      )}
      {...props}
    />
  )
}

function CardTitle({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-title"
      className={cn(
        "text-base leading-snug font-medium group-data-[size=sm]/card:text-sm",
        className
      )}
      {...props}
    />
  )
}

function CardDescription({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-description"
      className={cn("text-sm text-muted-foreground", className)}
      {...props}
    />
  )
}

function CardAction({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-action"
      className={cn(
        "col-start-2 row-span-2 row-start-1 self-start justify-self-end",
        className
      )}
      {...props}
    />
  )
}

function CardContent({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-content"
      className={cn("px-4 group-data-[size=sm]/card:px-3", className)}
      {...props}
    />
  )
}

function CardFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-footer"
      className={cn(
        "flex items-center rounded-b-xl border-t bg-muted/50 p-4 group-data-[size=sm]/card:p-3",
        className
      )}
      {...props}
    />
  )
}

export {
  Card,
  CardHeader,
  CardFooter,
  CardTitle,
  CardAction,
  CardDescription,
  CardContent,
}
```

---

### src/components/ui/table.tsx

```tsx
"use client"

import * as React from "react"

import { cn } from "@/lib/utils"

function Table({ className, ...props }: React.ComponentProps<"table">) {
  return (
    <div
      data-slot="table-container"
      className="relative w-full overflow-x-auto"
    >
      <table
        data-slot="table"
        className={cn("w-full caption-bottom text-sm", className)}
        {...props}
      />
    </div>
  )
}

function TableHeader({ className, ...props }: React.ComponentProps<"thead">) {
  return (
    <thead
      data-slot="table-header"
      className={cn("[&_tr]:border-b", className)}
      {...props}
    />
  )
}

function TableBody({ className, ...props }: React.ComponentProps<"tbody">) {
  return (
    <tbody
      data-slot="table-body"
      className={cn("[&_tr:last-child]:border-0", className)}
      {...props}
    />
  )
}

function TableFooter({ className, ...props }: React.ComponentProps<"tfoot">) {
  return (
    <tfoot
      data-slot="table-footer"
      className={cn(
        "border-t bg-muted/50 font-medium [&>tr]:last:border-b-0",
        className
      )}
      {...props}
    />
  )
}

function TableRow({ className, ...props }: React.ComponentProps<"tr">) {
  return (
    <tr
      data-slot="table-row"
      className={cn(
        "border-b transition-colors hover:bg-muted/50 data-[state=selected]:bg-muted",
        className
      )}
      {...props}
    />
  )
}

function TableHead({ className, ...props }: React.ComponentProps<"th">) {
  return (
    <th
      data-slot="table-head"
      className={cn(
        "h-10 px-2 text-left align-middle font-medium whitespace-nowrap text-foreground [&:has([role=checkbox])]:pr-0",
        className
      )}
      {...props}
    />
  )
}

function TableCell({ className, ...props }: React.ComponentProps<"td">) {
  return (
    <td
      data-slot="table-cell"
      className={cn(
        "p-2 align-middle whitespace-nowrap [&:has([role=checkbox])]:pr-0",
        className
      )}
      {...props}
    />
  )
}

function TableCaption({
  className,
  ...props
}: React.ComponentProps<"caption">) {
  return (
    <caption
      data-slot="table-caption"
      className={cn("mt-4 text-sm text-muted-foreground", className)}
      {...props}
    />
  )
}

export {
  Table,
  TableHeader,
  TableBody,
  TableFooter,
  TableHead,
  TableRow,
  TableCell,
  TableCaption,
}
```

---

### src/components/ui/tabs.tsx

```tsx
"use client"

import { Tabs as TabsPrimitive } from "@base-ui/react/tabs"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

function Tabs({
  className,
  orientation = "horizontal",
  ...props
}: TabsPrimitive.Root.Props) {
  return (
    <TabsPrimitive.Root
      data-slot="tabs"
      data-orientation={orientation}
      className={cn(
        "group/tabs flex gap-2 data-horizontal:flex-col",
        className
      )}
      {...props}
    />
  )
}

const tabsListVariants = cva(
  "group/tabs-list inline-flex w-fit items-center justify-center rounded-lg p-[3px] text-muted-foreground group-data-horizontal/tabs:h-8 group-data-vertical/tabs:h-fit group-data-vertical/tabs:flex-col data-[variant=line]:rounded-none",
  {
    variants: {
      variant: {
        default: "bg-muted",
        line: "gap-1 bg-transparent",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

function TabsList({
  className,
  variant = "default",
  ...props
}: TabsPrimitive.List.Props & VariantProps<typeof tabsListVariants>) {
  return (
    <TabsPrimitive.List
      data-slot="tabs-list"
      data-variant={variant}
      className={cn(tabsListVariants({ variant }), className)}
      {...props}
    />
  )
}

function TabsTrigger({ className, ...props }: TabsPrimitive.Tab.Props) {
  return (
    <TabsPrimitive.Tab
      data-slot="tabs-trigger"
      className={cn(
        "relative inline-flex h-[calc(100%-1px)] flex-1 items-center justify-center gap-1.5 rounded-md border border-transparent px-1.5 py-0.5 text-sm font-medium whitespace-nowrap text-foreground/60 transition-all group-data-vertical/tabs:w-full group-data-vertical/tabs:justify-start hover:text-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-1 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-50 aria-disabled:pointer-events-none aria-disabled:opacity-50 dark:text-muted-foreground dark:hover:text-foreground group-data-[variant=default]/tabs-list:data-active:shadow-sm group-data-[variant=line]/tabs-list:data-active:shadow-none [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        "group-data-[variant=line]/tabs-list:bg-transparent group-data-[variant=line]/tabs-list:data-active:bg-transparent dark:group-data-[variant=line]/tabs-list:data-active:border-transparent dark:group-data-[variant=line]/tabs-list:data-active:bg-transparent",
        "data-active:bg-background data-active:text-foreground dark:data-active:border-input dark:data-active:bg-input/30 dark:data-active:text-foreground",
        "after:absolute after:bg-foreground after:opacity-0 after:transition-opacity group-data-horizontal/tabs:after:inset-x-0 group-data-horizontal/tabs:after:bottom-[-5px] group-data-horizontal/tabs:after:h-0.5 group-data-vertical/tabs:after:inset-y-0 group-data-vertical/tabs:after:-right-1 group-data-vertical/tabs:after:w-0.5 group-data-[variant=line]/tabs-list:data-active:after:opacity-100",
        className
      )}
      {...props}
    />
  )
}

function TabsContent({ className, ...props }: TabsPrimitive.Panel.Props) {
  return (
    <TabsPrimitive.Panel
      data-slot="tabs-content"
      className={cn("flex-1 text-sm outline-none", className)}
      {...props}
    />
  )
}

export { Tabs, TabsList, TabsTrigger, TabsContent, tabsListVariants }
```

---

### src/components/ui/badge.tsx

```tsx
import { mergeProps } from "@base-ui/react/merge-props"
import { useRender } from "@base-ui/react/use-render"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

const badgeVariants = cva(
  "group/badge inline-flex h-5 w-fit shrink-0 items-center justify-center gap-1 overflow-hidden rounded-4xl border border-transparent px-2 py-0.5 text-xs font-medium whitespace-nowrap transition-all focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 [&>svg]:pointer-events-none [&>svg]:size-3!",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground [a]:hover:bg-primary/80",
        secondary:
          "bg-secondary text-secondary-foreground [a]:hover:bg-secondary/80",
        destructive:
          "bg-destructive/10 text-destructive focus-visible:ring-destructive/20 dark:bg-destructive/20 dark:focus-visible:ring-destructive/40 [a]:hover:bg-destructive/20",
        outline:
          "border-border text-foreground [a]:hover:bg-muted [a]:hover:text-muted-foreground",
        ghost:
          "hover:bg-muted hover:text-muted-foreground dark:hover:bg-muted/50",
        link: "text-primary underline-offset-4 hover:underline",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

function Badge({
  className,
  variant = "default",
  render,
  ...props
}: useRender.ComponentProps<"span"> & VariantProps<typeof badgeVariants>) {
  return useRender({
    defaultTagName: "span",
    props: mergeProps<"span">(
      {
        className: cn(badgeVariants({ variant }), className),
      },
      props
    ),
    render,
    state: {
      slot: "badge",
      variant,
    },
  })
}

export { Badge, badgeVariants }
```

---

## 4. Full Page Source Appendix

*Due to document length, the full page sources are included below. Each section contains the exact file content.*

### src/app/admin/page.tsx

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

---

### src/app/admin/catalog/page.tsx

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

---

### src/app/admin/catalog/[id]/page.tsx

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
        tags: editTags.split(",").map((t) => t.trim()).filter(Boolean),
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
      return updateVariants(productId, [{
        id: variant.id,
        shopifyVariantId: variant.shopify_variant_id ?? "",
        price: variantPrice || undefined,
        compareAtPrice: variantCompareAt || null,
        weight: variantWeight ? Number(variantWeight) : undefined,
      }]);
    },
    invalidateKeys: [queryKeys.products.detail(productId), queryKeys.products.all],
    onSuccess: () => setEditingVariantId(null),
  });

  if (isLoading) return <div className="p-6"><p className="text-muted-foreground">Loading product...</p></div>;
  if (!product) return <div className="p-6"><p className="text-muted-foreground">Product not found.</p></div>;

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
          <Button variant="ghost" size="icon-sm"><ArrowLeftIcon className="size-4" /></Button>
        </Link>
        <div className="flex-1">
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-semibold tracking-tight">{product.title}</h1>
            <Badge variant={STATUS_VARIANTS[product.status] ?? "outline"}>{product.status}</Badge>
          </div>
          <p className="text-sm text-muted-foreground mt-1">
            {org?.name ?? product.vendor ?? "Unknown vendor"}
            {product.shopify_product_id && (
              <> · <a href={`https://${product.shopify_handle ? "" : "admin.shopify.com"}/products/${product.shopify_product_id}`} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-blue-600 hover:underline">Shopify <ExternalLinkIcon className="size-3" /></a></>
            )}
          </p>
        </div>
        {!editMode && <Button variant="outline" onClick={startEdit}>Edit Product</Button>}
      </div>

      {editMode && (
        <Card>
          <CardHeader><CardTitle>Edit Product</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            <div><label className="text-sm font-medium" htmlFor="edit-title">Title</label>
            <Input id="edit-title" value={editTitle} onChange={(e) => setEditTitle(e.currentTarget.value)} /></div>
            <div><label className="text-sm font-medium" htmlFor="edit-type">Product Type</label>
            <Input id="edit-type" value={editProductType} onChange={(e) => setEditProductType(e.currentTarget.value)} /></div>
            <div><label className="text-sm font-medium" htmlFor="edit-tags">Tags (comma-separated)</label>
            <Input id="edit-tags" value={editTags} onChange={(e) => setEditTags(e.currentTarget.value)} /></div>
            <div className="flex gap-2">
              <Button onClick={() => productMutation.mutate(undefined)} disabled={productMutation.isPending}>{productMutation.isPending ? "Saving..." : "Save"}</Button>
              <Button variant="outline" onClick={() => setEditMode(false)}>Cancel</Button>
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
                <TableHead>SKU</TableHead><TableHead>Title</TableHead><TableHead>Price</TableHead><TableHead>Compare At</TableHead><TableHead>Barcode</TableHead><TableHead>Weight</TableHead><TableHead>Format</TableHead><TableHead>Pre-Order</TableHead><TableHead>Street Date</TableHead><TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {variants.map((variant) => (
                <TableRow key={variant.id}>
                  {editingVariantId === variant.id ? (
                    <><TableCell className="font-mono text-xs">{variant.sku}</TableCell><TableCell>{variant.title ?? "—"}</TableCell>
                    <TableCell><Input className="w-24" value={variantPrice} onChange={(e) => setVariantPrice(e.currentTarget.value)} /></TableCell>
                    <TableCell><Input className="w-24" value={variantCompareAt} onChange={(e) => setVariantCompareAt(e.currentTarget.value)} /></TableCell>
                    <TableCell>{variant.barcode ?? "—"}</TableCell>
                    <TableCell><Input className="w-20" value={variantWeight} onChange={(e) => setVariantWeight(e.currentTarget.value)} /></TableCell>
                    <TableCell>{variant.format_name ?? "—"}</TableCell><TableCell>{variant.is_preorder ? "Yes" : "No"}</TableCell><TableCell>{variant.street_date ?? "—"}</TableCell>
                    <TableCell><div className="flex gap-1"><Button size="xs" onClick={() => variantMutation.mutate(undefined)} disabled={variantMutation.isPending}>Save</Button><Button size="xs" variant="outline" onClick={() => setEditingVariantId(null)}>Cancel</Button></div></TableCell></>
                  ) : (
                    <><TableCell className="font-mono text-xs">{variant.sku}</TableCell><TableCell>{variant.title ?? "—"}</TableCell>
                    <TableCell>{variant.price != null ? `$${Number(variant.price).toFixed(2)}` : "—"}</TableCell>
                    <TableCell>{variant.compare_at_price != null ? `$${Number(variant.compare_at_price).toFixed(2)}` : "—"}</TableCell>
                    <TableCell>{variant.barcode ?? "—"}</TableCell><TableCell>{variant.weight != null ? `${variant.weight} ${variant.weight_unit}` : "—"}</TableCell>
                    <TableCell>{variant.format_name ?? "—"}</TableCell><TableCell>{variant.is_preorder ? "Yes" : "No"}</TableCell><TableCell>{variant.street_date ?? "—"}</TableCell>
                    <TableCell><Button size="xs" variant="ghost" onClick={() => startVariantEdit(variant)}>Edit</Button></TableCell></>
                  )}
                </TableRow>
              ))}
              {variants.length === 0 && <TableRow><TableCell colSpan={10} className="text-center py-4 text-muted-foreground">No variants.</TableCell></TableRow>}
            </TableBody>
          </Table>
        </TabsContent>
        <TabsContent value="images">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            {images.sort((a, b) => a.position - b.position).map((img) => (
              <div key={img.id} className="rounded-lg overflow-hidden border">
                <Image src={img.src} alt={img.alt ?? product.title} width={300} height={300} className="object-cover w-full aspect-square" />
                {img.alt && <p className="px-2 py-1 text-xs text-muted-foreground truncate">{img.alt}</p>}
              </div>
            ))}
            {images.length === 0 && <p className="col-span-full text-muted-foreground py-4">No images.</p>}
          </div>
        </TabsContent>
        <TabsContent value="inventory">
          <div className="space-y-4">
            {variants.map((variant) => {
              const inv = inventoryLevels.find((l) => l.variant_id === variant.id);
              const locations = variantLocations.filter((vl) => vl.variant_id === variant.id);
              return (
                <Card key={variant.id} size="sm">
                  <CardHeader><CardTitle>{variant.sku} — {variant.title ?? "Default"}</CardTitle></CardHeader>
                  <CardContent>
                    {inv ? <div className="grid grid-cols-3 gap-4 mb-3"><div><p className="text-xs text-muted-foreground">Available</p><p className="text-lg font-semibold">{inv.available}</p></div><div><p className="text-xs text-muted-foreground">Committed</p><p className="text-lg font-semibold">{inv.committed}</p></div><div><p className="text-xs text-muted-foreground">Incoming</p><p className="text-lg font-semibold">{inv.incoming}</p></div></div> : <p className="text-sm text-muted-foreground mb-3">No inventory data.</p>}
                    {locations.length > 0 && <Table><TableHeader><TableRow><TableHead>Location</TableHead><TableHead>Type</TableHead><TableHead>Quantity</TableHead></TableRow></TableHeader><TableBody>{locations.map((loc) => <TableRow key={loc.id}><TableCell>{loc.warehouse_locations?.name ?? "Unknown"}</TableCell><TableCell>{loc.warehouse_locations?.location_type ?? "—"}</TableCell><TableCell>{loc.quantity}</TableCell></TableRow>)}</TableBody></Table>}
                  </CardContent>
                </Card>
              );
            })}
            {variants.length === 0 && <p className="text-muted-foreground py-4">No variants to show inventory for.</p>}
          </div>
        </TabsContent>
        <TabsContent value="bandcamp">
          {bandcampMappings.length > 0 ? (
            <Table><TableHeader><TableRow><TableHead>Variant</TableHead><TableHead>Bandcamp URL</TableHead><TableHead>Type</TableHead><TableHead>New Date</TableHead><TableHead>Last Qty Sold</TableHead></TableRow></TableHeader><TableBody>
              {bandcampMappings.map((mapping) => { const variant = variants.find((v) => v.id === mapping.variant_id); return <TableRow key={mapping.id}><TableCell className="font-mono text-xs">{variant?.sku ?? mapping.variant_id}</TableCell><TableCell>{mapping.bandcamp_url ? <a href={mapping.bandcamp_url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-blue-600 hover:underline">{mapping.bandcamp_url}<ExternalLinkIcon className="size-3" /></a> : "—"}</TableCell><TableCell>{mapping.bandcamp_type_name ?? "—"}</TableCell><TableCell>{mapping.bandcamp_new_date ?? "—"}</TableCell><TableCell>{mapping.last_quantity_sold ?? "—"}</TableCell></TableRow>; })}
            </TableBody></Table>
          ) : <p className="text-muted-foreground py-4">No Bandcamp mappings for this product.</p>}
        </TabsContent>
      </Tabs>
    </div>
  );
}
```

---

### src/app/admin/clients/page.tsx

```tsx
"use client";

import { Loader2, Plus, Search, Users } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { createClient, getClients } from "@/actions/clients";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useAppMutation, useAppQuery } from "@/lib/hooks/use-app-query";
import { queryKeys } from "@/lib/shared/query-keys";
import { CACHE_TIERS } from "@/lib/shared/query-tiers";

export default function ClientsPage() {
  const router = useRouter();
  const [search, setSearch] = useState("");
  const [showNew, setShowNew] = useState(false);
  const [newClient, setNewClient] = useState({ name: "", slug: "", billingEmail: "" });

  const { data, isLoading } = useAppQuery({
    queryKey: queryKeys.clients.list(),
    queryFn: () => getClients({ search: search || undefined }),
    tier: CACHE_TIERS.SESSION,
  });

  const createMut = useAppMutation({
    mutationFn: () => createClient(newClient),
    invalidateKeys: [queryKeys.clients.all],
    onSuccess: () => { setShowNew(false); setNewClient({ name: "", slug: "", billingEmail: "" }); },
  });

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Clients</h1>
        <Button onClick={() => setShowNew(true)}><Plus className="h-4 w-4 mr-1" /> Add Client</Button>
      </div>
      <div className="relative w-64">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input placeholder="Search by name..." value={search} onChange={(e) => setSearch(e.target.value)} className="pl-9" />
      </div>
      {isLoading ? (
        <div className="flex justify-center py-8 text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /></div>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead><TableHead>Slug</TableHead><TableHead className="text-right">Products</TableHead><TableHead className="text-right">Connections</TableHead><TableHead>Onboarding</TableHead><TableHead>Created</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {(data?.clients ?? []).map((client) => (
              <TableRow key={client.id} className="cursor-pointer" onClick={() => router.push(`/admin/clients/${client.id}`)}>
                <TableCell className="font-medium">{client.name}</TableCell>
                <TableCell className="font-mono text-xs text-muted-foreground">{client.slug}</TableCell>
                <TableCell className="text-right">{client.productCount}</TableCell>
                <TableCell className="text-right">{client.activeConnections}</TableCell>
                <TableCell><OnboardingBadge pct={client.onboardingPct} /></TableCell>
                <TableCell className="text-muted-foreground text-xs">{new Date(client.createdAt).toLocaleDateString()}</TableCell>
              </TableRow>
            ))}
            {(data?.clients ?? []).length === 0 && (
              <TableRow><TableCell colSpan={6} className="py-8 text-center text-muted-foreground"><Users className="h-8 w-8 mx-auto mb-2 opacity-50" />No clients found.</TableCell></TableRow>
            )}
          </TableBody>
        </Table>
      )}
      <Dialog open={showNew} onOpenChange={setShowNew}>
        <DialogContent><DialogHeader><DialogTitle>Add New Client</DialogTitle></DialogHeader>
        <div className="space-y-3 pt-2">
          <Input placeholder="Organization name" value={newClient.name} onChange={(e) => setNewClient((c) => ({ ...c, name: e.target.value, slug: e.target.value.toLowerCase().replace(/\s+/g, "-") }))} />
          <Input placeholder="Slug" value={newClient.slug} onChange={(e) => setNewClient((c) => ({ ...c, slug: e.target.value }))} className="font-mono" />
          <Input type="email" placeholder="Billing email (optional)" value={newClient.billingEmail} onChange={(e) => setNewClient((c) => ({ ...c, billingEmail: e.target.value }))} />
          <Button className="w-full" disabled={!newClient.name || !newClient.slug || createMut.isPending} onClick={() => createMut.mutate()}>{createMut.isPending ? "Creating..." : "Create Client"}</Button>
        </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function OnboardingBadge({ pct }: { pct: number }) {
  if (pct === 100) return <Badge variant="default">Complete</Badge>;
  if (pct > 0) return <Badge variant="secondary">{pct}%</Badge>;
  return <Badge variant="outline">Not started</Badge>;
}
```

---

### src/app/admin/clients/[id]/page.tsx

```tsx
"use client";

import { CheckCircle, Circle, Loader2 } from "lucide-react";
import { useParams, useRouter } from "next/navigation";
import { getClientDetail, updateClient, updateOnboardingStep } from "@/actions/clients";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { useAppMutation, useAppQuery } from "@/lib/hooks/use-app-query";
import { queryKeys } from "@/lib/shared/query-keys";
import { CACHE_TIERS } from "@/lib/shared/query-tiers";

export default function ClientDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const orgId = params.id;

  const { data, isLoading } = useAppQuery({
    queryKey: queryKeys.clients.detail(orgId),
    queryFn: () => getClientDetail(orgId),
    tier: CACHE_TIERS.SESSION,
  });

  const stepMut = useAppMutation({
    mutationFn: ({ step, completed }: { step: string; completed: boolean }) => updateOnboardingStep(orgId, step, completed),
    invalidateKeys: [queryKeys.clients.detail(orgId)],
  });

  if (isLoading || !data) return <div className="p-6 flex items-center gap-2 text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading...</div>;

  const { org, onboardingSteps, productCount, connections, recentSnapshots, recentConversations } = data;

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center gap-4">
        <Button variant="outline" size="sm" onClick={() => router.push("/admin/clients")}>Back</Button>
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{org.name}</h1>
          <p className="text-muted-foreground text-sm">{org.slug} · {org.billing_email ?? "No billing email"}</p>
        </div>
      </div>
      <div className="grid grid-cols-4 gap-4">
        <Card><CardContent className="p-4"><p className="text-xs text-muted-foreground">Products</p><p className="text-2xl font-semibold">{productCount}</p></CardContent></Card>
        <Card><CardContent className="p-4"><p className="text-xs text-muted-foreground">Store Connections</p><p className="text-2xl font-semibold">{connections.length}</p></CardContent></Card>
        <Card><CardContent className="p-4"><p className="text-xs text-muted-foreground">Billing Snapshots</p><p className="text-2xl font-semibold">{recentSnapshots.length}</p></CardContent></Card>
        <Card><CardContent className="p-4"><p className="text-xs text-muted-foreground">Support Tickets</p><p className="text-2xl font-semibold">{recentConversations.length}</p></CardContent></Card>
      </div>
      <Card>
        <CardHeader><CardTitle>Onboarding Checklist</CardTitle></CardHeader>
        <CardContent>
          <div className="space-y-2">
            {onboardingSteps.map((step) => (
              <div key={step.key} className="flex items-center gap-3">
                <button type="button" onClick={() => stepMut.mutate({ step: step.key, completed: !step.completed })} className="shrink-0">
                  {step.completed ? <CheckCircle className="h-5 w-5 text-green-600" /> : <Circle className="h-5 w-5 text-muted-foreground hover:text-foreground" />}
                </button>
                <span className={`text-sm ${step.completed ? "text-muted-foreground line-through" : ""}`}>{step.label}</span>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
      {connections.length > 0 && (
        <Card>
          <CardHeader><CardTitle>Store Connections</CardTitle></CardHeader>
          <CardContent>
            <div className="space-y-2">
              {connections.map((c) => (
                <div key={c.id} className="flex items-center justify-between text-sm">
                  <span className="capitalize">{c.platform} — {c.store_url}</span>
                  <Badge variant={c.connection_status === "active" ? "default" : "secondary"}>{c.connection_status}</Badge>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
      <ClientSettings org={org} orgId={orgId} />
    </div>
  );
}

function ClientSettings({ org, orgId }: { org: Record<string, unknown>; orgId: string }) {
  const updateMut = useAppMutation({
    mutationFn: (data: Parameters<typeof updateClient>[1]) => updateClient(orgId, data),
    invalidateKeys: [queryKeys.clients.detail(orgId)],
  });
  return (
    <Card>
      <CardHeader><CardTitle>Settings</CardTitle></CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-2 gap-4">
          <div><label htmlFor="billing-email" className="text-sm font-medium block mb-1">Billing Email</label>
          <Input id="billing-email" defaultValue={(org.billing_email as string) ?? ""} onBlur={(e) => updateMut.mutate({ billing_email: e.target.value || null })} /></div>
          <div><label htmlFor="pirate-ship" className="text-sm font-medium block mb-1">Pirate Ship Name</label>
          <Input id="pirate-ship" defaultValue={(org.pirate_ship_name as string) ?? ""} onBlur={(e) => updateMut.mutate({ pirate_ship_name: e.target.value || null })} /></div>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={(org.storage_fee_waived as boolean) ?? false} onChange={(e) => updateMut.mutate({ storage_fee_waived: e.target.checked })} />
          Storage fee waived
        </label>
      </CardContent>
    </Card>
  );
}
```

---

### src/app/admin/shipping/page.tsx

```tsx
"use client";

import { useCallback, useState } from "react";
import type { GetShipmentsFilters } from "@/actions/shipping";
import { getShipmentDetail, getShipments } from "@/actions/shipping";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useAppQuery } from "@/lib/hooks/use-app-query";
import { queryKeys } from "@/lib/shared/query-keys";
import { CACHE_TIERS } from "@/lib/shared/query-tiers";

type ShipmentRow = Awaited<ReturnType<typeof getShipments>>["shipments"][number];
type ShipmentDetail = Awaited<ReturnType<typeof getShipmentDetail>>;

export default function ShippingPage() {
  const [filters, setFilters] = useState<GetShipmentsFilters>({
    page: 1,
    pageSize: 25,
  });
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const { data, isLoading } = useAppQuery({
    tier: CACHE_TIERS.SESSION,
    queryKey: queryKeys.shipments.list(filters),
    queryFn: () => getShipments(filters),
  });

  const { data: detail, isLoading: detailLoading } = useAppQuery({
    tier: CACHE_TIERS.SESSION,
    queryKey: queryKeys.shipments.detail(expandedId ?? ""),
    queryFn: () => getShipmentDetail(expandedId ?? ""),
    enabled: !!expandedId,
  });

  const handleFilterChange = useCallback((key: keyof GetShipmentsFilters, value: string) => {
    setFilters((prev) => ({ ...prev, [key]: value || undefined, page: 1 }));
    setExpandedId(null);
  }, []);

  const totalPages = data ? Math.ceil(data.total / data.pageSize) : 0;

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Shipping</h1>
        <p className="text-muted-foreground mt-1">
          {data ? `${data.total} shipments` : "Loading..."}
        </p>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-3">
        <Input
          placeholder="Filter by org ID..."
          className="w-64"
          onChange={(e) => handleFilterChange("orgId", e.target.value)}
        />
        <Input
          type="date"
          placeholder="From"
          className="w-40"
          onChange={(e) => handleFilterChange("dateFrom", e.target.value)}
        />
        <Input
          type="date"
          placeholder="To"
          className="w-40"
          onChange={(e) => handleFilterChange("dateTo", e.target.value)}
        />
        <Input
          placeholder="Carrier..."
          className="w-40"
          onChange={(e) => handleFilterChange("carrier", e.target.value)}
        />
        <Input
          placeholder="Status..."
          className="w-40"
          onChange={(e) => handleFilterChange("status", e.target.value)}
        />
      </div>

      {/* Table */}
      <div className="rounded-md border">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b bg-muted/50">
              <th className="px-4 py-3 text-left font-medium">Tracking Number</th>
              <th className="px-4 py-3 text-left font-medium">Carrier</th>
              <th className="px-4 py-3 text-left font-medium">Service</th>
              <th className="px-4 py-3 text-left font-medium">Ship Date</th>
              <th className="px-4 py-3 text-left font-medium">Organization</th>
              <th className="px-4 py-3 text-left font-medium">Status</th>
              <th className="px-4 py-3 text-right font-medium">Cost</th>
            </tr>
          </thead>
          <tbody>
            {isLoading && (
              <>
                <SkeletonRow />
                <SkeletonRow />
                <SkeletonRow />
                <SkeletonRow />
                <SkeletonRow />
              </>
            )}
            {data?.shipments.map((shipment: ShipmentRow) => (
              <ShipmentTableRow
                key={shipment.id}
                shipment={shipment}
                isExpanded={expandedId === shipment.id}
                onToggle={() =>
                  setExpandedId((prev) => (prev === shipment.id ? null : shipment.id))
                }
                detail={expandedId === shipment.id ? detail : undefined}
                detailLoading={expandedId === shipment.id && detailLoading}
              />
            ))}
            {data && data.shipments.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-muted-foreground">
                  No shipments found.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between">
          <p className="text-sm text-muted-foreground">
            Page {filters.page} of {totalPages}
          </p>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={filters.page === 1}
              onClick={() => setFilters((prev) => ({ ...prev, page: (prev.page ?? 1) - 1 }))}
            >
              Previous
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={filters.page === totalPages}
              onClick={() => setFilters((prev) => ({ ...prev, page: (prev.page ?? 1) + 1 }))}
            >
              Next
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function ShipmentTableRow({
  shipment,
  isExpanded,
  onToggle,
  detail,
  detailLoading,
}: {
  shipment: ShipmentRow;
  isExpanded: boolean;
  onToggle: () => void;
  detail: ShipmentDetail | undefined;
  detailLoading: boolean;
}) {
  const orgName =
    (shipment as ShipmentRow & { organizations?: { name: string } }).organizations?.name ?? "---";

  return (
    <>
      <tr
        className="border-b cursor-pointer hover:bg-muted/30 transition-colors"
        onClick={onToggle}
      >
        <td className="px-4 py-3 font-mono text-xs">{shipment.tracking_number ?? "---"}</td>
        <td className="px-4 py-3">{shipment.carrier ?? "---"}</td>
        <td className="px-4 py-3">{shipment.service ?? "---"}</td>
        <td className="px-4 py-3">
          {shipment.ship_date ? new Date(shipment.ship_date).toLocaleDateString() : "---"}
        </td>
        <td className="px-4 py-3">{orgName}</td>
        <td className="px-4 py-3">
          <StatusBadge status={shipment.status} />
        </td>
        <td className="px-4 py-3 text-right font-mono">
          {shipment.shipping_cost != null ? `$${shipment.shipping_cost.toFixed(2)}` : "---"}
        </td>
      </tr>
      {isExpanded && (
        <tr className="border-b bg-muted/10">
          <td colSpan={7} className="px-6 py-4">
            {detailLoading ? (
              <div className="space-y-2">
                <Skeleton className="h-4 w-48" />
                <Skeleton className="h-4 w-64" />
                <Skeleton className="h-4 w-40" />
              </div>
            ) : detail ? (
              <ShipmentExpandedDetail detail={detail} />
            ) : null}
          </td>
        </tr>
      )}
    </>
  );
}

function ShipmentExpandedDetail({ detail }: { detail: ShipmentDetail }) {
  return (
    <div className="grid grid-cols-2 gap-6">
      {/* Items */}
      <div>
        <h3 className="font-medium mb-2">Shipment Items</h3>
        {detail.items.length === 0 ? (
          <p className="text-sm text-muted-foreground">No items recorded.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b">
                <th className="text-left py-1 pr-4 font-medium">SKU</th>
                <th className="text-left py-1 pr-4 font-medium">Product</th>
                <th className="text-right py-1 font-medium">Qty</th>
              </tr>
            </thead>
            <tbody>
              {detail.items.map((item) => (
                <tr key={item.id} className="border-b border-dashed">
                  <td className="py-1 pr-4 font-mono text-xs">{item.sku}</td>
                  <td className="py-1 pr-4">{item.product_title ?? "---"}</td>
                  <td className="py-1 text-right">{item.quantity}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Tracking Timeline */}
      <div>
        <h3 className="font-medium mb-2">Tracking Timeline</h3>
        {detail.trackingEvents.length === 0 ? (
          <p className="text-sm text-muted-foreground">No tracking events yet.</p>
        ) : (
          <div className="space-y-2">
            {detail.trackingEvents.map((event) => (
              <div key={event.id} className="flex gap-3 text-sm">
                <span className="text-muted-foreground whitespace-nowrap">
                  {event.event_time ? new Date(event.event_time).toLocaleString() : "---"}
                </span>
                <div>
                  <p className="font-medium">{event.status}</p>
                  {event.description && (
                    <p className="text-muted-foreground">{event.description}</p>
                  )}
                  {event.location && (
                    <p className="text-xs text-muted-foreground">{event.location}</p>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function SkeletonRow() {
  return (
    <tr className="border-b">
      <td className="px-4 py-3">
        <Skeleton className="h-4 w-full" />
      </td>
      <td className="px-4 py-3">
        <Skeleton className="h-4 w-full" />
      </td>
      <td className="px-4 py-3">
        <Skeleton className="h-4 w-full" />
      </td>
      <td className="px-4 py-3">
        <Skeleton className="h-4 w-full" />
      </td>
      <td className="px-4 py-3">
        <Skeleton className="h-4 w-full" />
      </td>
      <td className="px-4 py-3">
        <Skeleton className="h-4 w-full" />
      </td>
      <td className="px-4 py-3">
        <Skeleton className="h-4 w-full" />
      </td>
    </tr>
  );
}

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    shipped: "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200",
    voided: "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200",
    delivered: "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200",
  };
  const colorClass =
    colors[status] ?? "bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-200";
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${colorClass}`}
    >
      {status}
    </span>
  );
}
```

---

### src/app/admin/orders/page.tsx

```tsx
"use client";

import { ChevronLeft, ChevronRight, Package } from "lucide-react";
import { useState } from "react";
import { getOrderDetail, getOrders, getTrackingEvents } from "@/actions/orders";
import { TrackingTimeline } from "@/components/shared/tracking-timeline";
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

type OrderRow = Awaited<ReturnType<typeof getOrders>>["orders"][number];

const SOURCE_COLORS: Record<string, string> = {
  shopify: "bg-green-100 text-green-800",
  bandcamp: "bg-blue-100 text-blue-800",
  woocommerce: "bg-purple-100 text-purple-800",
  squarespace: "bg-yellow-100 text-yellow-800",
  manual: "bg-gray-100 text-gray-800",
};

export default function AdminOrdersPage() {
  const [filters, setFilters] = useState({
    page: 1,
    pageSize: 25,
    status: "",
    source: "",
    search: "",
    orgId: "",
  });
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const { data, isLoading } = useAppQuery({
    queryKey: queryKeys.orders.list(filters),
    queryFn: () => getOrders(filters),
    tier: CACHE_TIERS.SESSION,
  });

  const { data: detail, isLoading: detailLoading } = useAppQuery({
    queryKey: queryKeys.orders.detail(expandedId ?? ""),
    queryFn: () => getOrderDetail(expandedId ?? ""),
    tier: CACHE_TIERS.SESSION,
    enabled: !!expandedId,
  });

  const totalPages = data ? Math.ceil(data.total / data.pageSize) : 0;

  return (
    <div className="p-6 space-y-4">
      <h1 className="text-2xl font-semibold tracking-tight">Orders</h1>

      <div className="flex flex-wrap gap-3">
        <Input
          placeholder="Search order/customer..."
          value={filters.search}
          onChange={(e) => setFilters((f) => ({ ...f, search: e.target.value, page: 1 }))}
          className="w-64"
        />
        <select
          value={filters.source}
          onChange={(e) => setFilters((f) => ({ ...f, source: e.target.value, page: 1 }))}
          className="border-input bg-background h-9 rounded-md border px-3 text-sm"
        >
          <option value="">All sources</option>
          <option value="shopify">Shopify</option>
          <option value="bandcamp">Bandcamp</option>
          <option value="woocommerce">WooCommerce</option>
          <option value="squarespace">Squarespace</option>
          <option value="manual">Manual</option>
        </select>
        <select
          value={filters.status}
          onChange={(e) => setFilters((f) => ({ ...f, status: e.target.value, page: 1 }))}
          className="border-input bg-background h-9 rounded-md border px-3 text-sm"
        >
          <option value="">All statuses</option>
          <option value="pending">Pending</option>
          <option value="ready_to_ship">Ready to Ship</option>
          <option value="shipped">Shipped</option>
          <option value="delivered">Delivered</option>
        </select>
      </div>

      {isLoading ? (
        <div className="space-y-2">
          {[1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Order</TableHead>
              <TableHead>Date</TableHead>
              <TableHead>Customer</TableHead>
              <TableHead>Organization</TableHead>
              <TableHead>Source</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Total</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {(data?.orders ?? []).map((order: OrderRow) => {
              const orgName =
                (order as OrderRow & { organizations?: { name: string } }).organizations?.name ??
                "—";
              return (
                <>
                  <TableRow
                    key={order.id}
                    className="cursor-pointer"
                    onClick={() => setExpandedId((prev) => (prev === order.id ? null : order.id))}
                  >
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-sm">{order.order_number ?? "—"}</span>
                        {order.is_preorder && (
                          <Badge variant="secondary" className="text-xs">
                            Pre-Order
                          </Badge>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {new Date(order.created_at).toLocaleDateString()}
                    </TableCell>
                    <TableCell>{order.customer_name ?? "—"}</TableCell>
                    <TableCell className="text-sm">{orgName}</TableCell>
                    <TableCell>
                      <span
                        className={`text-xs px-1.5 py-0.5 rounded ${SOURCE_COLORS[order.source] ?? "bg-gray-100"}`}
                      >
                        {order.source}
                      </span>
                    </TableCell>
                    <TableCell>
                      <StatusBadge status={order.fulfillment_status} />
                    </TableCell>
                    <TableCell className="text-right font-mono">
                      {order.total_price != null ? `$${Number(order.total_price).toFixed(2)}` : "—"}
                    </TableCell>
                  </TableRow>

                  {expandedId === order.id && (
                    <TableRow key={`${order.id}-detail`}>
                      <TableCell colSpan={7} className="bg-muted/30 p-4">
                        {detailLoading ? (
                          <Skeleton className="h-32 w-full" />
                        ) : detail ? (
                          <OrderDetailExpanded detail={detail} />
                        ) : null}
                      </TableCell>
                    </TableRow>
                  )}
                </>
              );
            })}
            {(data?.orders ?? []).length === 0 && (
              <TableRow>
                <TableCell colSpan={7} className="py-8 text-center text-muted-foreground">
                  <Package className="h-8 w-8 mx-auto mb-2 opacity-50" />
                  No orders found.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      )}

      {totalPages > 1 && (
        <div className="flex items-center justify-between">
          <span className="text-sm text-muted-foreground">
            Page {filters.page} of {totalPages} ({data?.total ?? 0} total)
          </span>
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

function OrderDetailExpanded({ detail }: { detail: Awaited<ReturnType<typeof getOrderDetail>> }) {
  return (
    <div className="grid grid-cols-2 gap-6">
      <div>
        <h4 className="text-sm font-semibold mb-2">Line Items</h4>
        <div className="space-y-1 text-sm">
          {detail.items.map((item) => (
            <div key={item.id} className="flex justify-between">
              <span>
                <span className="font-mono text-xs text-muted-foreground">{item.sku}</span>{" "}
                {item.title ?? ""}
              </span>
              <span className="font-mono">
                x{item.quantity}
                {item.price != null && ` · $${Number(item.price).toFixed(2)}`}
              </span>
            </div>
          ))}
        </div>
      </div>
      <div>
        <h4 className="text-sm font-semibold mb-2">Shipments</h4>
        {detail.shipments.length === 0 ? (
          <p className="text-muted-foreground text-sm">No shipments yet</p>
        ) : (
          <div className="space-y-3">
            {detail.shipments.map((s) => (
              <div key={s.id} className="border rounded-lg p-3">
                <TrackingTimeline
                  shipmentId={s.id}
                  trackingNumber={s.tracking_number}
                  carrier={s.carrier}
                  fetchEvents={getTrackingEvents}
                />
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: string | null }) {
  const config: Record<
    string,
    { variant: "default" | "secondary" | "destructive" | "outline"; label: string }
  > = {
    pending: { variant: "outline", label: "Pending" },
    ready_to_ship: { variant: "secondary", label: "Ready to Ship" },
    shipped: { variant: "default", label: "Shipped" },
    delivered: { variant: "default", label: "Delivered" },
  };
  const c = config[status ?? ""] ?? { variant: "outline" as const, label: status ?? "—" };
  return <Badge variant={c.variant}>{c.label}</Badge>;
}
```

---

### src/app/admin/billing/page.tsx

```tsx
"use client";

import { Loader2 } from "lucide-react";
import { useCallback, useState } from "react";
import {
  createBillingAdjustment,
  createBillingRule,
  createFormatCost,
  getAuthWorkspaceId,
  getBillingRules,
  getBillingSnapshotDetail,
  getBillingSnapshots,
  updateBillingRule,
  updateFormatCost,
} from "@/actions/billing";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useAppMutation, useAppQuery } from "@/lib/hooks/use-app-query";
import { queryKeys } from "@/lib/shared/query-keys";
import { CACHE_TIERS } from "@/lib/shared/query-tiers";
import type { WarehouseBillingRule, WarehouseFormatCost } from "@/lib/shared/types";

type Tab = "snapshots" | "rules" | "formats" | "adjustments";

export default function BillingPage() {
  const [activeTab, setActiveTab] = useState<Tab>("snapshots");

  const { data: workspaceId, isLoading: wsLoading } = useAppQuery({
    queryKey: ["auth", "workspace-id"],
    queryFn: () => getAuthWorkspaceId(),
    tier: CACHE_TIERS.SESSION,
  });

  if (wsLoading || !workspaceId) {
    return (
      <div className="p-6 flex items-center gap-2 text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading billing...
      </div>
    );
  }

  const tabs: { key: Tab; label: string }[] = [
    { key: "snapshots", label: "Snapshots" },
    { key: "rules", label: "Rules" },
    { key: "formats", label: "Format Costs" },
    { key: "adjustments", label: "Adjustments" },
  ];

  return (
    <div className="p-6 space-y-6">
      <h1 className="text-2xl font-semibold tracking-tight">Billing</h1>

      <div className="flex gap-1 border-b">
        {tabs.map((tab) => (
          <button
            key={tab.key}
            type="button"
            onClick={() => setActiveTab(tab.key)}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
              activeTab === tab.key
                ? "border-foreground text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {activeTab === "snapshots" && <SnapshotsTab workspaceId={workspaceId} />}
      {activeTab === "rules" && <RulesTab workspaceId={workspaceId} />}
      {activeTab === "formats" && <FormatCostsTab workspaceId={workspaceId} />}
      {activeTab === "adjustments" && <AdjustmentsTab workspaceId={workspaceId} />}
    </div>
  );
}

// === Status Badge ===

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    draft: "bg-yellow-100 text-yellow-800",
    sent: "bg-blue-100 text-blue-800",
    paid: "bg-green-100 text-green-800",
    overdue: "bg-red-100 text-red-800",
    void: "bg-gray-100 text-gray-800",
  };

  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${
        colors[status] ?? "bg-gray-100 text-gray-800"
      }`}
    >
      {status}
    </span>
  );
}

// === Snapshots Tab ===

function SnapshotsTab({ workspaceId }: { workspaceId: string }) {
  const [page, setPage] = useState(1);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const { data, isLoading } = useAppQuery({
    tier: CACHE_TIERS.SESSION,
    queryKey: queryKeys.billing.snapshots({ page }),
    queryFn: () => getBillingSnapshots({ workspaceId, page }),
  });

  if (selectedId) {
    return <SnapshotDetail id={selectedId} onBack={() => setSelectedId(null)} />;
  }

  return (
    <div className="space-y-4">
      {isLoading ? (
        <p className="text-muted-foreground text-sm">Loading snapshots…</p>
      ) : !data?.snapshots.length ? (
        <p className="text-muted-foreground text-sm">No billing snapshots yet.</p>
      ) : (
        <>
          <div className="border rounded-lg overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-muted/50">
                <tr>
                  <th className="text-left p-3 font-medium">Organization</th>
                  <th className="text-left p-3 font-medium">Period</th>
                  <th className="text-left p-3 font-medium">Status</th>
                  <th className="text-right p-3 font-medium">Grand Total</th>
                  <th className="text-right p-3 font-medium">Created</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {data.snapshots.map((s) => (
                  <tr
                    key={s.id}
                    className="hover:bg-muted/30 cursor-pointer"
                    onClick={() => setSelectedId(s.id)}
                  >
                    <td className="p-3">{s.organizations?.name ?? s.org_id}</td>
                    <td className="p-3">{s.billing_period}</td>
                    <td className="p-3">
                      <StatusBadge status={s.status} />
                    </td>
                    <td className="p-3 text-right font-mono">${s.grand_total.toFixed(2)}</td>
                    <td className="p-3 text-right text-muted-foreground">
                      {new Date(s.created_at).toLocaleDateString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="flex items-center justify-between">
            <p className="text-sm text-muted-foreground">
              {data.total} snapshot{data.total !== 1 ? "s" : ""} total
            </p>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={page <= 1}
                onClick={() => setPage((p) => p - 1)}
              >
                Previous
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={page * (data.pageSize ?? 20) >= data.total}
                onClick={() => setPage((p) => p + 1)}
              >
                Next
              </Button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// === Snapshot Detail (Rule #16 — included/excluded shipments with reasons) ===

function SnapshotDetail({ id, onBack }: { id: string; onBack: () => void }) {
  const { data, isLoading } = useAppQuery({
    tier: CACHE_TIERS.SESSION,
    queryKey: ["billing", "snapshot-detail", id],
    queryFn: () => getBillingSnapshotDetail(id),
  });

  if (isLoading) {
    return <p className="text-muted-foreground text-sm">Loading snapshot…</p>;
  }

  if (!data) {
    return <p className="text-muted-foreground text-sm">Snapshot not found.</p>;
  }

  const { snapshot, adjustments } = data;
  const sd = snapshot.snapshot_data as Record<string, unknown>;
  const included = (sd.included_shipments ?? []) as Array<{
    shipment_id: string;
    tracking_number: string | null;
    ship_date: string | null;
    carrier: string | null;
    shipping_cost: number;
    format_name: string;
    pick_pack_cost: number;
    material_cost: number;
  }>;
  const excluded = (sd.excluded_shipments ?? []) as Array<{
    shipment_id: string;
    tracking_number: string | null;
    reason: string;
  }>;
  const storageItems = (sd.storage_line_items ?? []) as Array<{
    sku: string;
    total_inventory: number;
    active_stock_threshold: number;
    billable_units: number;
    storage_fee: number;
  }>;

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Button variant="outline" size="sm" onClick={onBack}>
          Back
        </Button>
        <div>
          <h2 className="text-lg font-semibold">
            {snapshot.organizations?.name} — {snapshot.billing_period}
          </h2>
          <StatusBadge status={snapshot.status} />
        </div>
      </div>

      {/* Totals */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
        {[
          { label: "Shipping", value: snapshot.total_shipping },
          { label: "Pick & Pack", value: snapshot.total_pick_pack },
          { label: "Materials", value: snapshot.total_materials },
          { label: "Storage", value: snapshot.total_storage },
          { label: "Adjustments", value: snapshot.total_adjustments },
          { label: "Grand Total", value: snapshot.grand_total },
        ].map((item) => (
          <div key={item.label} className="border rounded-lg p-3">
            <p className="text-xs text-muted-foreground">{item.label}</p>
            <p className="text-lg font-mono font-semibold">${(item.value ?? 0).toFixed(2)}</p>
          </div>
        ))}
      </div>

      {/* Included Shipments */}
      <div>
        <h3 className="text-sm font-semibold mb-2">Included Shipments ({included.length})</h3>
        {included.length === 0 ? (
          <p className="text-sm text-muted-foreground">No shipments included.</p>
        ) : (
          <div className="border rounded-lg overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-muted/50">
                <tr>
                  <th className="text-left p-2 font-medium">Tracking</th>
                  <th className="text-left p-2 font-medium">Ship Date</th>
                  <th className="text-left p-2 font-medium">Carrier</th>
                  <th className="text-left p-2 font-medium">Format</th>
                  <th className="text-right p-2 font-medium">Shipping</th>
                  <th className="text-right p-2 font-medium">Pick/Pack</th>
                  <th className="text-right p-2 font-medium">Material</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {included.map((s) => (
                  <tr key={s.shipment_id}>
                    <td className="p-2 font-mono text-xs">{s.tracking_number ?? "—"}</td>
                    <td className="p-2">{s.ship_date ?? "—"}</td>
                    <td className="p-2">{s.carrier ?? "—"}</td>
                    <td className="p-2">{s.format_name}</td>
                    <td className="p-2 text-right font-mono">${s.shipping_cost.toFixed(2)}</td>
                    <td className="p-2 text-right font-mono">${s.pick_pack_cost.toFixed(2)}</td>
                    <td className="p-2 text-right font-mono">${s.material_cost.toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Excluded Shipments — Rule #16 debug view */}
      <div>
        <h3 className="text-sm font-semibold mb-2">Excluded Shipments ({excluded.length})</h3>
        {excluded.length === 0 ? (
          <p className="text-sm text-muted-foreground">No shipments excluded.</p>
        ) : (
          <div className="border rounded-lg overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-muted/50">
                <tr>
                  <th className="text-left p-2 font-medium">Shipment ID</th>
                  <th className="text-left p-2 font-medium">Tracking</th>
                  <th className="text-left p-2 font-medium">Reason</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {excluded.map((s) => (
                  <tr key={s.shipment_id}>
                    <td className="p-2 font-mono text-xs">{s.shipment_id.slice(0, 8)}…</td>
                    <td className="p-2 font-mono text-xs">{s.tracking_number ?? "—"}</td>
                    <td className="p-2">
                      <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-orange-100 text-orange-800">
                        {s.reason.replace(/_/g, " ")}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Storage Line Items */}
      {storageItems.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold mb-2">Storage Charges</h3>
          <div className="border rounded-lg overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-muted/50">
                <tr>
                  <th className="text-left p-2 font-medium">SKU</th>
                  <th className="text-right p-2 font-medium">Inventory</th>
                  <th className="text-right p-2 font-medium">Active Stock</th>
                  <th className="text-right p-2 font-medium">Billable</th>
                  <th className="text-right p-2 font-medium">Fee</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {storageItems.map((item) => (
                  <tr key={item.sku}>
                    <td className="p-2 font-mono text-xs">{item.sku}</td>
                    <td className="p-2 text-right">{item.total_inventory}</td>
                    <td className="p-2 text-right">{item.active_stock_threshold}</td>
                    <td className="p-2 text-right">{item.billable_units}</td>
                    <td className="p-2 text-right font-mono">${item.storage_fee.toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Adjustments */}
      {adjustments.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold mb-2">Adjustments</h3>
          <div className="border rounded-lg overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-muted/50">
                <tr>
                  <th className="text-left p-2 font-medium">Reason</th>
                  <th className="text-right p-2 font-medium">Amount</th>
                  <th className="text-right p-2 font-medium">Date</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {adjustments.map((a) => (
                  <tr key={a.id}>
                    <td className="p-2">{a.reason ?? "—"}</td>
                    <td className="p-2 text-right font-mono">${a.amount.toFixed(2)}</td>
                    <td className="p-2 text-right text-muted-foreground">
                      {new Date(a.created_at).toLocaleDateString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

// === Rules Tab ===

function RulesTab({ workspaceId }: { workspaceId: string }) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValues, setEditValues] = useState<Partial<WarehouseBillingRule>>({});
  const [showNew, setShowNew] = useState(false);
  const [newRule, setNewRule] = useState({
    rule_name: "",
    rule_type: "per_shipment" as WarehouseBillingRule["rule_type"],
    amount: 0,
    description: "",
    is_active: true,
    effective_from: new Date().toISOString().split("T")[0],
  });

  const { data, isLoading } = useAppQuery({
    tier: CACHE_TIERS.SESSION,
    queryKey: queryKeys.billing.rules(),
    queryFn: () => getBillingRules(workspaceId),
  });

  const updateMutation = useAppMutation({
    mutationFn: ({ id, data }: { id: string; data: Partial<WarehouseBillingRule> }) =>
      updateBillingRule(id, data),
    invalidateKeys: [queryKeys.billing.all],
  });

  const createMutation = useAppMutation({
    mutationFn: (data: Omit<WarehouseBillingRule, "id" | "created_at">) => createBillingRule(data),
    invalidateKeys: [queryKeys.billing.all],
  });

  const handleSave = useCallback(
    (id: string) => {
      updateMutation.mutate({ id, data: editValues }, { onSuccess: () => setEditingId(null) });
    },
    [editValues, updateMutation],
  );

  if (isLoading) {
    return <p className="text-muted-foreground text-sm">Loading rules…</p>;
  }

  const rules = data?.rules ?? [];

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button size="sm" onClick={() => setShowNew(!showNew)}>
          {showNew ? "Cancel" : "Add Rule"}
        </Button>
      </div>

      {showNew && (
        <div className="border rounded-lg p-4 space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <Input
              placeholder="Rule name"
              value={newRule.rule_name}
              onChange={(e) => setNewRule((r) => ({ ...r, rule_name: e.target.value }))}
            />
            <select
              className="border rounded-md px-3 py-2 text-sm"
              value={newRule.rule_type}
              onChange={(e) =>
                setNewRule((r) => ({
                  ...r,
                  rule_type: e.target.value as WarehouseBillingRule["rule_type"],
                }))
              }
            >
              <option value="per_shipment">Per Shipment</option>
              <option value="per_item">Per Item</option>
              <option value="storage">Storage</option>
              <option value="material">Material</option>
              <option value="adjustment">Adjustment</option>
            </select>
            <Input
              type="number"
              step="0.01"
              placeholder="Amount"
              value={newRule.amount || ""}
              onChange={(e) =>
                setNewRule((r) => ({ ...r, amount: Number.parseFloat(e.target.value) || 0 }))
              }
            />
            <Input
              type="date"
              value={newRule.effective_from}
              onChange={(e) => setNewRule((r) => ({ ...r, effective_from: e.target.value }))}
            />
          </div>
          <Input
            placeholder="Description"
            value={newRule.description}
            onChange={(e) => setNewRule((r) => ({ ...r, description: e.target.value }))}
          />
          <Button
            size="sm"
            onClick={() =>
              createMutation.mutate(
                { ...newRule, workspace_id: workspaceId },
                { onSuccess: () => setShowNew(false) },
              )
            }
          >
            Create Rule
          </Button>
        </div>
      )}

      <div className="border rounded-lg overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-muted/50">
            <tr>
              <th className="text-left p-3 font-medium">Name</th>
              <th className="text-left p-3 font-medium">Type</th>
              <th className="text-right p-3 font-medium">Amount</th>
              <th className="text-center p-3 font-medium">Active</th>
              <th className="text-left p-3 font-medium">Effective From</th>
              <th className="text-right p-3 font-medium">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {rules.map((rule) => {
              const isEditing = editingId === rule.id;
              return (
                <tr key={rule.id}>
                  <td className="p-3">
                    {isEditing ? (
                      <Input
                        value={editValues.rule_name ?? rule.rule_name}
                        onChange={(e) =>
                          setEditValues((v) => ({ ...v, rule_name: e.target.value }))
                        }
                      />
                    ) : (
                      rule.rule_name
                    )}
                  </td>
                  <td className="p-3 text-muted-foreground">{rule.rule_type}</td>
                  <td className="p-3 text-right font-mono">
                    {isEditing ? (
                      <Input
                        type="number"
                        step="0.01"
                        className="text-right"
                        value={editValues.amount ?? rule.amount}
                        onChange={(e) =>
                          setEditValues((v) => ({
                            ...v,
                            amount: Number.parseFloat(e.target.value) || 0,
                          }))
                        }
                      />
                    ) : (
                      `$${rule.amount.toFixed(2)}`
                    )}
                  </td>
                  <td className="p-3 text-center">
                    <button
                      type="button"
                      onClick={() =>
                        updateMutation.mutate({
                          id: rule.id,
                          data: { is_active: !rule.is_active },
                        })
                      }
                      className={`w-8 h-5 rounded-full transition-colors ${
                        rule.is_active ? "bg-green-500" : "bg-gray-300"
                      }`}
                    >
                      <span
                        className={`block w-3.5 h-3.5 bg-white rounded-full transition-transform ${
                          rule.is_active ? "translate-x-3.5" : "translate-x-0.5"
                        }`}
                      />
                    </button>
                  </td>
                  <td className="p-3 text-muted-foreground">{rule.effective_from}</td>
                  <td className="p-3 text-right">
                    {isEditing ? (
                      <div className="flex gap-1 justify-end">
                        <Button size="sm" onClick={() => handleSave(rule.id)}>
                          Save
                        </Button>
                        <Button variant="outline" size="sm" onClick={() => setEditingId(null)}>
                          Cancel
                        </Button>
                      </div>
                    ) : (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          setEditingId(rule.id);
                          setEditValues({
                            rule_name: rule.rule_name,
                            amount: rule.amount,
                            description: rule.description,
                          });
                        }}
                      >
                        Edit
                      </Button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// === Format Costs Tab ===

function FormatCostsTab({ workspaceId }: { workspaceId: string }) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValues, setEditValues] = useState<Partial<WarehouseFormatCost>>({});
  const [showNew, setShowNew] = useState(false);
  const [newFormat, setNewFormat] = useState({
    format_name: "",
    pick_pack_cost: 0,
    material_cost: 0,
  });

  const { data, isLoading } = useAppQuery({
    tier: CACHE_TIERS.SESSION,
    queryKey: queryKeys.billing.rules(),
    queryFn: () => getBillingRules(workspaceId),
  });

  const updateMutation = useAppMutation({
    mutationFn: ({ id, data }: { id: string; data: Partial<WarehouseFormatCost> }) =>
      updateFormatCost(id, data),
    invalidateKeys: [queryKeys.billing.all],
  });

  const createMutation = useAppMutation({
    mutationFn: (data: Omit<WarehouseFormatCost, "id" | "created_at" | "updated_at">) =>
      createFormatCost(data),
    invalidateKeys: [queryKeys.billing.all],
  });

  if (isLoading) {
    return <p className="text-muted-foreground text-sm">Loading format costs…</p>;
  }

  const formatCosts = data?.formatCosts ?? [];

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button size="sm" onClick={() => setShowNew(!showNew)}>
          {showNew ? "Cancel" : "Add Format Cost"}
        </Button>
      </div>

      {showNew && (
        <div className="border rounded-lg p-4 space-y-3">
          <div className="grid grid-cols-3 gap-3">
            <Input
              placeholder="Format name (e.g. LP)"
              value={newFormat.format_name}
              onChange={(e) => setNewFormat((f) => ({ ...f, format_name: e.target.value }))}
            />
            <Input
              type="number"
              step="0.01"
              placeholder="Pick & Pack cost"
              value={newFormat.pick_pack_cost || ""}
              onChange={(e) =>
                setNewFormat((f) => ({
                  ...f,
                  pick_pack_cost: Number.parseFloat(e.target.value) || 0,
                }))
              }
            />
            <Input
              type="number"
              step="0.01"
              placeholder="Material cost"
              value={newFormat.material_cost || ""}
              onChange={(e) =>
                setNewFormat((f) => ({
                  ...f,
                  material_cost: Number.parseFloat(e.target.value) || 0,
                }))
              }
            />
          </div>
          <Button
            size="sm"
            onClick={() =>
              createMutation.mutate(
                { ...newFormat, workspace_id: workspaceId },
                { onSuccess: () => setShowNew(false) },
              )
            }
          >
            Create Format Cost
          </Button>
        </div>
      )}

      <div className="border rounded-lg overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-muted/50">
            <tr>
              <th className="text-left p-3 font-medium">Format</th>
              <th className="text-right p-3 font-medium">Pick & Pack</th>
              <th className="text-right p-3 font-medium">Material</th>
              <th className="text-right p-3 font-medium">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {formatCosts.map((fc) => {
              const isEditing = editingId === fc.id;
              return (
                <tr key={fc.id}>
                  <td className="p-3 font-medium">{fc.format_name}</td>
                  <td className="p-3 text-right font-mono">
                    {isEditing ? (
                      <Input
                        type="number"
                        step="0.01"
                        className="text-right"
                        value={editValues.pick_pack_cost ?? fc.pick_pack_cost}
                        onChange={(e) =>
                          setEditValues((v) => ({
                            ...v,
                            pick_pack_cost: Number.parseFloat(e.target.value) || 0,
                          }))
                        }
                      />
                    ) : (
                      `$${fc.pick_pack_cost.toFixed(2)}`
                    )}
                  </td>
                  <td className="p-3 text-right font-mono">
                    {isEditing ? (
                      <Input
                        type="number"
                        step="0.01"
                        className="text-right"
                        value={editValues.material_cost ?? fc.material_cost}
                        onChange={(e) =>
                          setEditValues((v) => ({
                            ...v,
                            material_cost: Number.parseFloat(e.target.value) || 0,
                          }))
                        }
                      />
                    ) : (
                      `$${fc.material_cost.toFixed(2)}`
                    )}
                  </td>
                  <td className="p-3 text-right">
                    {isEditing ? (
                      <div className="flex gap-1 justify-end">
                        <Button
                          size="sm"
                          onClick={() => {
                            updateMutation.mutate(
                              { id: fc.id, data: editValues },
                              { onSuccess: () => setEditingId(null) },
                            );
                          }}
                        >
                          Save
                        </Button>
                        <Button variant="outline" size="sm" onClick={() => setEditingId(null)}>
                          Cancel
                        </Button>
                      </div>
                    ) : (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          setEditingId(fc.id);
                          setEditValues({
                            pick_pack_cost: fc.pick_pack_cost,
                            material_cost: fc.material_cost,
                          });
                        }}
                      >
                        Edit
                      </Button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// === Adjustments Tab ===

function AdjustmentsTab({ workspaceId }: { workspaceId: string }) {
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({
    org_id: "",
    billing_period: "",
    amount: 0,
    reason: "",
  });

  const { isLoading } = useAppQuery({
    tier: CACHE_TIERS.SESSION,
    queryKey: queryKeys.billing.snapshots({ adjustments: true }),
    queryFn: () => getBillingSnapshots({ workspaceId: workspaceId, pageSize: 100 }),
  });

  const createMutation = useAppMutation({
    mutationFn: (data: Parameters<typeof createBillingAdjustment>[0]) =>
      createBillingAdjustment(data),
    invalidateKeys: [queryKeys.billing.all],
  });

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button size="sm" onClick={() => setShowForm(!showForm)}>
          {showForm ? "Cancel" : "Add Adjustment"}
        </Button>
      </div>

      {showForm && (
        <div className="border rounded-lg p-4 space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <Input
              placeholder="Organization ID"
              value={form.org_id}
              onChange={(e) => setForm((f) => ({ ...f, org_id: e.target.value }))}
            />
            <Input
              placeholder="Billing Period (YYYY-MM)"
              value={form.billing_period}
              onChange={(e) => setForm((f) => ({ ...f, billing_period: e.target.value }))}
            />
            <Input
              type="number"
              step="0.01"
              placeholder="Amount (negative for credit)"
              value={form.amount || ""}
              onChange={(e) =>
                setForm((f) => ({
                  ...f,
                  amount: Number.parseFloat(e.target.value) || 0,
                }))
              }
            />
          </div>
          <Input
            placeholder="Reason"
            value={form.reason}
            onChange={(e) => setForm((f) => ({ ...f, reason: e.target.value }))}
          />
          <Button
            size="sm"
            disabled={!form.org_id || !form.billing_period || !form.reason}
            onClick={() =>
              createMutation.mutate(
                { ...form, workspace_id: workspaceId },
                {
                  onSuccess: () => {
                    setShowForm(false);
                    setForm({ org_id: "", billing_period: "", amount: 0, reason: "" });
                  },
                },
              )
            }
          >
            Create Adjustment
          </Button>
        </div>
      )}

      {isLoading ? (
        <p className="text-muted-foreground text-sm">Loading…</p>
      ) : (
        <p className="text-sm text-muted-foreground">
          Adjustments are shown in snapshot detail views. Use the form above to create adjustments
          for a specific org and billing period.
        </p>
      )}
    </div>
  );
}
```

---

### src/app/admin/inventory/page.tsx

```tsx
"use client";

import { ChevronLeft, ChevronRight, ExternalLink, Minus, Package, Plus } from "lucide-react";
import { useState } from "react";
import { adjustInventory, getInventoryDetail, getInventoryLevels } from "@/actions/inventory";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
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
import { useAppMutation, useAppQuery } from "@/lib/hooks/use-app-query";
import { queryKeys } from "@/lib/shared/query-keys";
import { CACHE_TIERS } from "@/lib/shared/query-tiers";

const PAGE_SIZES = [10, 25, 50, 100];

export default function InventoryPage() {
  const [filters, setFilters] = useState({
    orgId: "",
    format: "",
    status: "",
    search: "",
    page: 1,
    pageSize: 25,
  });
  const [expandedSku, setExpandedSku] = useState<string | null>(null);
  const [adjustDialog, setAdjustDialog] = useState<{
    sku: string;
    title: string;
  } | null>(null);
  const [adjustDelta, setAdjustDelta] = useState("");
  const [adjustReason, setAdjustReason] = useState("");

  const queryFilters = {
    ...(filters.orgId && { orgId: filters.orgId }),
    ...(filters.format && { format: filters.format }),
    ...(filters.status && { status: filters.status }),
    ...(filters.search && { search: filters.search }),
    page: filters.page,
    pageSize: filters.pageSize,
  };

  const { data, isLoading } = useAppQuery({
    queryKey: queryKeys.inventory.list(queryFilters),
    queryFn: () => getInventoryLevels(queryFilters),
    tier: CACHE_TIERS.REALTIME,
  });

  const { data: detail, isLoading: detailLoading } = useAppQuery({
    queryKey: queryKeys.inventory.detail(expandedSku ?? ""),
    queryFn: () => getInventoryDetail(expandedSku ?? ""),
    tier: CACHE_TIERS.REALTIME,
    enabled: !!expandedSku,
  });

  const adjustMutation = useAppMutation({
    mutationFn: async () => {
      if (!adjustDialog) throw new Error("No SKU selected");
      return adjustInventory(adjustDialog.sku, Number(adjustDelta), adjustReason);
    },
    invalidateKeys: [queryKeys.inventory.all],
    onSuccess: () => {
      setAdjustDialog(null);
      setAdjustDelta("");
      setAdjustReason("");
    },
  });

  const totalPages = data ? Math.ceil(data.total / data.pageSize) : 0;

  return (
    <div className="p-6 space-y-4">
      <h1 className="text-2xl font-semibold tracking-tight">Inventory</h1>

      {/* Filters */}
      <div className="flex flex-wrap gap-3">
        <Input
          placeholder="Search SKU or title..."
          value={filters.search}
          onChange={(e) => setFilters((f) => ({ ...f, search: e.target.value, page: 1 }))}
          className="w-64"
        />
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
          onChange={(e) => setFilters((f) => ({ ...f, status: e.target.value, page: 1 }))}
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
            <Skeleton key={`skel-inv-${i.toString()}`} className="h-12 w-full" />
          ))}
        </div>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-12" />
              <TableHead>Product / SKU</TableHead>
              <TableHead>Label</TableHead>
              <TableHead className="text-right">Available</TableHead>
              <TableHead className="text-right">Committed</TableHead>
              <TableHead className="text-right">Incoming</TableHead>
              <TableHead>Format</TableHead>
              <TableHead className="w-20" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {data?.rows.map((row) => (
              <>
                <TableRow
                  key={row.variantId}
                  className="cursor-pointer"
                  onClick={() => setExpandedSku((prev) => (prev === row.sku ? null : row.sku))}
                >
                  <TableCell>
                    {row.imageSrc ? (
                      // biome-ignore lint/performance/noImgElement: external Shopify CDN URLs — next/image optimization not applicable
                      <img
                        src={row.imageSrc}
                        alt={row.productTitle}
                        className="h-8 w-8 rounded object-cover"
                      />
                    ) : (
                      <div className="bg-muted flex h-8 w-8 items-center justify-center rounded">
                        <Package className="text-muted-foreground h-4 w-4" />
                      </div>
                    )}
                  </TableCell>
                  <TableCell>
                    <div className="font-medium">{row.productTitle}</div>
                    <div className="text-muted-foreground text-xs">{row.sku}</div>
                  </TableCell>
                  <TableCell className="text-muted-foreground text-sm">
                    {row.orgName ?? "—"}
                  </TableCell>
                  <TableCell className="text-right font-mono">{row.available}</TableCell>
                  <TableCell className="text-right font-mono">{row.committed}</TableCell>
                  <TableCell className="text-right font-mono">{row.incoming}</TableCell>
                  <TableCell className="text-muted-foreground text-sm">
                    {row.formatName ?? "—"}
                  </TableCell>
                  <TableCell>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={(e) => {
                        e.stopPropagation();
                        setAdjustDialog({ sku: row.sku, title: row.productTitle });
                      }}
                    >
                      Adjust
                    </Button>
                  </TableCell>
                </TableRow>

                {/* Expanded detail */}
                {expandedSku === row.sku && (
                  <TableRow key={`${row.variantId}-detail`}>
                    <TableCell colSpan={8} className="bg-muted/30 p-4">
                      {detailLoading ? (
                        <Skeleton className="h-24 w-full" />
                      ) : detail ? (
                        <div className="grid grid-cols-2 gap-6">
                          {/* Locations */}
                          <div>
                            <h4 className="mb-2 text-sm font-semibold">Locations</h4>
                            {detail.locations.length === 0 ? (
                              <p className="text-muted-foreground text-sm">No location data</p>
                            ) : (
                              <ul className="space-y-1 text-sm">
                                {detail.locations.map((loc) => (
                                  <li key={loc.locationId} className="flex justify-between">
                                    <span>
                                      {loc.locationName}{" "}
                                      <span className="text-muted-foreground">
                                        ({loc.locationType})
                                      </span>
                                    </span>
                                    <span className="font-mono">{loc.quantity}</span>
                                  </li>
                                ))}
                              </ul>
                            )}
                            {detail.bandcampUrl && (
                              <a
                                href={detail.bandcampUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="mt-2 inline-flex items-center gap-1 text-sm text-blue-600 hover:underline"
                              >
                                <ExternalLink className="h-3 w-3" />
                                Bandcamp
                              </a>
                            )}
                          </div>

                          {/* Recent Activity */}
                          <div>
                            <h4 className="mb-2 text-sm font-semibold">Recent Activity</h4>
                            {detail.recentActivity.length === 0 ? (
                              <p className="text-muted-foreground text-sm">No activity yet</p>
                            ) : (
                              <ul className="space-y-1 text-sm">
                                {detail.recentActivity.slice(0, 10).map((a) => (
                                  <li key={a.id} className="flex items-center justify-between">
                                    <span className="flex items-center gap-1">
                                      {a.delta > 0 ? (
                                        <Plus className="h-3 w-3 text-green-600" />
                                      ) : (
                                        <Minus className="h-3 w-3 text-red-600" />
                                      )}
                                      <span className="font-mono">
                                        {a.delta > 0 ? `+${a.delta}` : a.delta}
                                      </span>
                                      <span className="text-muted-foreground">{a.source}</span>
                                    </span>
                                    <span className="text-muted-foreground text-xs">
                                      {new Date(a.createdAt).toLocaleDateString()}
                                    </span>
                                  </li>
                                ))}
                              </ul>
                            )}
                          </div>
                        </div>
                      ) : null}
                    </TableCell>
                  </TableRow>
                )}
              </>
            ))}
            {data?.rows.length === 0 && (
              <TableRow>
                <TableCell colSpan={8} className="text-muted-foreground py-8 text-center">
                  No inventory found
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
                setFilters((f) => ({ ...f, pageSize: Number(e.target.value), page: 1 }))
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

      {/* Adjust Dialog */}
      <Dialog
        open={!!adjustDialog}
        onOpenChange={(open) => {
          if (!open) {
            setAdjustDialog(null);
            setAdjustDelta("");
            setAdjustReason("");
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Adjust Inventory — {adjustDialog?.sku}</DialogTitle>
          </DialogHeader>
          <p className="text-muted-foreground text-sm">{adjustDialog?.title}</p>
          <div className="space-y-3 pt-2">
            <div>
              <label htmlFor="adjust-delta" className="text-sm font-medium">
                Delta (positive to add, negative to remove)
              </label>
              <Input
                id="adjust-delta"
                type="number"
                value={adjustDelta}
                onChange={(e) => setAdjustDelta(e.target.value)}
                placeholder="e.g. -5 or 10"
              />
            </div>
            <div>
              <label htmlFor="adjust-reason" className="text-sm font-medium">
                Reason
              </label>
              <Input
                id="adjust-reason"
                value={adjustReason}
                onChange={(e) => setAdjustReason(e.target.value)}
                placeholder="Reason for adjustment..."
              />
            </div>
            <Button
              className="w-full"
              disabled={
                !adjustDelta ||
                Number(adjustDelta) === 0 ||
                !adjustReason ||
                adjustMutation.isPending
              }
              onClick={() => adjustMutation.mutate()}
            >
              {adjustMutation.isPending ? "Adjusting..." : "Confirm Adjustment"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
```

---

### src/app/admin/inbound/page.tsx

```tsx
"use client";

import { Package, Search } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import {
  getInboundShipments,
  type InboundFilters,
  type InboundShipmentWithOrg,
} from "@/actions/inbound";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useAppQuery } from "@/lib/hooks/use-app-query";
import { queryKeys } from "@/lib/shared/query-keys";
import { CACHE_TIERS } from "@/lib/shared/query-tiers";

const STATUS_TABS = ["all", "expected", "arrived", "checking_in", "checked_in", "issue"] as const;

const STATUS_LABELS: Record<string, string> = {
  all: "All",
  expected: "Expected",
  arrived: "Arrived",
  checking_in: "Checking In",
  checked_in: "Checked In",
  issue: "Issue",
};

const STATUS_COLORS: Record<string, string> = {
  expected: "bg-blue-100 text-blue-800",
  arrived: "bg-yellow-100 text-yellow-800",
  checking_in: "bg-orange-100 text-orange-800",
  checked_in: "bg-green-100 text-green-800",
  issue: "bg-red-100 text-red-800",
};

export default function AdminInboundPage() {
  const router = useRouter();
  const [activeTab, setActiveTab] = useState<string>("all");
  const [orgFilter, setOrgFilter] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [page, setPage] = useState(1);

  const filters: InboundFilters = {
    status: activeTab === "all" ? undefined : (activeTab as InboundFilters["status"]),
    dateFrom: dateFrom || undefined,
    dateTo: dateTo || undefined,
    page,
    pageSize: 25,
  };

  const { data, isLoading } = useAppQuery<{ data: InboundShipmentWithOrg[]; count: number }>({
    queryKey: queryKeys.inbound.list(filters as Record<string, unknown>),
    queryFn: () => getInboundShipments(filters),
    tier: CACHE_TIERS.REALTIME,
  });

  const shipments = data?.data ?? [];
  const totalCount = data?.count ?? 0;
  const totalPages = Math.ceil(totalCount / 25);

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Inbound Shipments</h1>
          <p className="text-muted-foreground mt-1">
            Manage incoming shipments from labels and distributors.
          </p>
        </div>
      </div>

      {/* Status Tabs */}
      <div className="flex gap-1 border-b">
        {STATUS_TABS.map((tab) => (
          <button
            key={tab}
            type="button"
            onClick={() => {
              setActiveTab(tab);
              setPage(1);
            }}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
              activeTab === tab
                ? "border-primary text-primary"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            {STATUS_LABELS[tab]}
          </button>
        ))}
      </div>

      {/* Filters */}
      <div className="flex gap-4 items-end">
        <div className="flex-1 max-w-xs">
          <label htmlFor="inbound-search" className="text-sm font-medium mb-1 block">
            Search
          </label>
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              id="inbound-search"
              placeholder="Filter by org name..."
              value={orgFilter}
              onChange={(e) => setOrgFilter(e.target.value)}
              className="pl-9"
            />
          </div>
        </div>
        <div>
          <label htmlFor="inbound-date-from" className="text-sm font-medium mb-1 block">
            From
          </label>
          <Input
            id="inbound-date-from"
            type="date"
            value={dateFrom}
            onChange={(e) => {
              setDateFrom(e.target.value);
              setPage(1);
            }}
          />
        </div>
        <div>
          <label htmlFor="inbound-date-to" className="text-sm font-medium mb-1 block">
            To
          </label>
          <Input
            id="inbound-date-to"
            type="date"
            value={dateTo}
            onChange={(e) => {
              setDateTo(e.target.value);
              setPage(1);
            }}
          />
        </div>
      </div>

      {/* Table */}
      <div className="border rounded-lg overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b bg-muted/50">
              <th className="text-left p-3 font-medium">Tracking Number</th>
              <th className="text-left p-3 font-medium">Carrier</th>
              <th className="text-left p-3 font-medium">Organization</th>
              <th className="text-left p-3 font-medium">Expected Date</th>
              <th className="text-left p-3 font-medium">Status</th>
              <th className="text-left p-3 font-medium">Items</th>
              <th className="text-left p-3 font-medium">Submitted By</th>
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              ["s1", "s2", "s3", "s4", "s5"].map((rowId) => (
                <tr key={rowId} className="border-b">
                  {["a", "b", "c", "d", "e", "f", "g"].map((colId) => (
                    <td key={`${rowId}-${colId}`} className="p-3">
                      <Skeleton className="h-4 w-full" />
                    </td>
                  ))}
                </tr>
              ))
            ) : shipments.length === 0 ? (
              <tr>
                <td colSpan={7} className="p-12 text-center text-muted-foreground">
                  <Package className="h-8 w-8 mx-auto mb-2 opacity-50" />
                  No inbound shipments found.
                </td>
              </tr>
            ) : (
              shipments
                .filter((s) =>
                  orgFilter ? s.org_name?.toLowerCase().includes(orgFilter.toLowerCase()) : true,
                )
                .map((shipment) => (
                  <tr
                    key={shipment.id}
                    className="border-b hover:bg-muted/30 cursor-pointer transition-colors"
                    onClick={() => router.push(`/admin/inbound/${shipment.id}`)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") router.push(`/admin/inbound/${shipment.id}`);
                    }}
                  >
                    <td className="p-3 font-mono text-xs">{shipment.tracking_number || "—"}</td>
                    <td className="p-3">{shipment.carrier || "—"}</td>
                    <td className="p-3">{shipment.org_name || "—"}</td>
                    <td className="p-3">
                      {shipment.expected_date
                        ? new Date(shipment.expected_date).toLocaleDateString()
                        : "—"}
                    </td>
                    <td className="p-3">
                      <span
                        className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_COLORS[shipment.status] ?? "bg-gray-100 text-gray-800"}`}
                      >
                        {STATUS_LABELS[shipment.status] ?? shipment.status}
                      </span>
                    </td>
                    <td className="p-3">{shipment.item_count}</td>
                    <td className="p-3">{shipment.submitter_name || "—"}</td>
                  </tr>
                ))
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between">
          <p className="text-sm text-muted-foreground">
            Page {page} of {totalPages} ({totalCount} total)
          </p>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={page <= 1}
              onClick={() => setPage((p) => p - 1)}
            >
              Previous
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={page >= totalPages}
              onClick={() => setPage((p) => p + 1)}
            >
              Next
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
```

---

### src/app/admin/inbound/[id]/page.tsx

```tsx
"use client";

import { ArrowLeft, Check, CheckCircle2, CircleDot, Clock, Package, Truck } from "lucide-react";
import { useParams, useRouter } from "next/navigation";
import { useState } from "react";
import {
  beginCheckIn,
  checkInItem,
  completeCheckIn,
  getInboundDetail,
  type InboundDetailResult,
  markArrived,
} from "@/actions/inbound";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { useAppMutation, useAppQuery } from "@/lib/hooks/use-app-query";
import { queryKeys } from "@/lib/shared/query-keys";
import { CACHE_TIERS } from "@/lib/shared/query-tiers";
import type { InboundStatus, WarehouseInboundItem } from "@/lib/shared/types";

const STATUS_STEPS: { key: InboundStatus; label: string; icon: typeof Clock }[] = [
  { key: "expected", label: "Expected", icon: Clock },
  { key: "arrived", label: "Arrived", icon: Truck },
  { key: "checking_in", label: "Checking In", icon: CircleDot },
  { key: "checked_in", label: "Checked In", icon: CheckCircle2 },
];

function StatusProgressBar({ currentStatus }: { currentStatus: InboundStatus }) {
  const currentIndex = STATUS_STEPS.findIndex((s) => s.key === currentStatus);
  const isIssue = currentStatus === "issue";

  return (
    <div className="flex items-center gap-2">
      {STATUS_STEPS.map((step, i) => {
        const isCompleted = !isIssue && i <= currentIndex;
        const isCurrent = !isIssue && i === currentIndex;
        const Icon = step.icon;

        return (
          <div key={step.key} className="flex items-center gap-2">
            <div
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium transition-colors ${
                isCompleted
                  ? isCurrent
                    ? "bg-primary text-primary-foreground"
                    : "bg-primary/20 text-primary"
                  : "bg-muted text-muted-foreground"
              }`}
            >
              <Icon className="h-3.5 w-3.5" />
              {step.label}
            </div>
            {i < STATUS_STEPS.length - 1 && (
              <div
                className={`h-0.5 w-8 ${!isIssue && i < currentIndex ? "bg-primary" : "bg-muted"}`}
              />
            )}
          </div>
        );
      })}
      {isIssue && (
        <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium bg-red-100 text-red-800">
          Issue
        </div>
      )}
    </div>
  );
}

function ItemCheckInRow({
  item,
  isCheckingIn,
  onCheckIn,
}: {
  item: WarehouseInboundItem;
  isCheckingIn: boolean;
  onCheckIn: (
    itemId: string,
    receivedQty: number,
    conditionNotes: string,
    locationId?: string,
  ) => void;
}) {
  const [receivedQty, setReceivedQty] = useState(
    item.received_quantity?.toString() ?? item.expected_quantity.toString(),
  );
  const [conditionNotes, setConditionNotes] = useState(item.condition_notes ?? "");
  const isChecked = item.received_quantity !== null;
  const hasDiscrepancy = isChecked && item.received_quantity !== item.expected_quantity;

  return (
    <tr className={`border-b ${hasDiscrepancy ? "bg-yellow-50" : ""}`}>
      <td className="p-3 font-mono text-xs">{item.sku}</td>
      <td className="p-3">{item.expected_quantity}</td>
      <td className="p-3">
        {isCheckingIn && !isChecked ? (
          <Input
            type="number"
            min={0}
            value={receivedQty}
            onChange={(e) => setReceivedQty(e.target.value)}
            className="w-20 h-8"
          />
        ) : (
          <span className={hasDiscrepancy ? "text-yellow-700 font-medium" : ""}>
            {item.received_quantity ?? "—"}
          </span>
        )}
      </td>
      <td className="p-3">
        {isCheckingIn && !isChecked ? (
          <Textarea
            value={conditionNotes}
            onChange={(e) => setConditionNotes(e.target.value)}
            placeholder="Condition notes..."
            className="h-8 min-h-[2rem] text-sm"
          />
        ) : (
          item.condition_notes || "—"
        )}
      </td>
      <td className="p-3">{item.location_id ? item.location_id.slice(0, 8) : "—"}</td>
      <td className="p-3">
        {isCheckingIn && !isChecked && (
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              onCheckIn(item.id, Number.parseInt(receivedQty, 10) || 0, conditionNotes)
            }
          >
            <Check className="h-3.5 w-3.5 mr-1" />
            Confirm
          </Button>
        )}
        {isChecked && (
          <span className="text-green-600 text-xs font-medium flex items-center gap-1">
            <CheckCircle2 className="h-3.5 w-3.5" />
            Done
          </span>
        )}
      </td>
    </tr>
  );
}

export default function InboundDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();

  const {
    data: detail,
    isLoading,
    refetch,
  } = useAppQuery<InboundDetailResult>({
    queryKey: queryKeys.inbound.detail(params.id),
    queryFn: () => getInboundDetail(params.id),
    tier: CACHE_TIERS.REALTIME,
  });

  const markArrivedMutation = useAppMutation({
    mutationFn: () => markArrived(params.id),
    invalidateKeys: [queryKeys.inbound.all],
    onSuccess: () => refetch(),
  });

  const beginCheckInMutation = useAppMutation({
    mutationFn: () => beginCheckIn(params.id),
    invalidateKeys: [queryKeys.inbound.all],
    onSuccess: () => refetch(),
  });

  const checkInItemMutation = useAppMutation({
    mutationFn: (input: {
      itemId: string;
      receivedQty: number;
      conditionNotes: string;
      locationId?: string;
    }) =>
      checkInItem({
        itemId: input.itemId,
        receivedQty: input.receivedQty,
        conditionNotes: input.conditionNotes,
        locationId: input.locationId,
      }),
    invalidateKeys: [queryKeys.inbound.all],
    onSuccess: () => refetch(),
  });

  const completeCheckInMutation = useAppMutation({
    mutationFn: () => completeCheckIn(params.id),
    invalidateKeys: [queryKeys.inbound.all],
    onSuccess: () => refetch(),
  });

  if (isLoading) {
    return (
      <div className="p-6 space-y-6">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (!detail) {
    return (
      <div className="p-6">
        <p className="text-muted-foreground">Shipment not found.</p>
      </div>
    );
  }

  const allCheckedIn = detail.items.every((item) => item.received_quantity !== null);

  return (
    <div className="p-6 space-y-6">
      {/* Back nav */}
      <button
        type="button"
        onClick={() => router.push("/admin/inbound")}
        className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors"
      >
        <ArrowLeft className="h-4 w-4" />
        Back to Inbound
      </button>

      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2">
            <Package className="h-6 w-6" />
            {detail.tracking_number || "No Tracking Number"}
          </h1>
          <div className="flex gap-4 mt-2 text-sm text-muted-foreground">
            <span>Carrier: {detail.carrier || "—"}</span>
            <span>Org: {detail.org_name || "—"}</span>
            <span>
              Expected:{" "}
              {detail.expected_date ? new Date(detail.expected_date).toLocaleDateString() : "—"}
            </span>
            {detail.actual_arrival_date && (
              <span>Arrived: {new Date(detail.actual_arrival_date).toLocaleDateString()}</span>
            )}
          </div>
          {detail.notes && <p className="mt-2 text-sm bg-muted/50 rounded p-2">{detail.notes}</p>}
        </div>

        {/* Action buttons */}
        <div className="flex gap-2">
          {detail.status === "expected" && (
            <Button
              onClick={() => markArrivedMutation.mutate()}
              disabled={markArrivedMutation.isPending}
            >
              <Truck className="h-4 w-4 mr-2" />
              Mark Arrived
            </Button>
          )}
          {detail.status === "arrived" && (
            <Button
              onClick={() => beginCheckInMutation.mutate()}
              disabled={beginCheckInMutation.isPending}
            >
              <CircleDot className="h-4 w-4 mr-2" />
              Begin Check-in
            </Button>
          )}
          {detail.status === "checking_in" && allCheckedIn && (
            <Button
              onClick={() => completeCheckInMutation.mutate()}
              disabled={completeCheckInMutation.isPending}
            >
              <CheckCircle2 className="h-4 w-4 mr-2" />
              Complete Check-in
            </Button>
          )}
        </div>
      </div>

      {/* Status Progression */}
      <StatusProgressBar currentStatus={detail.status} />

      {/* Items Table */}
      <div>
        <h2 className="text-lg font-medium mb-3">Items ({detail.items.length})</h2>
        <div className="border rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/50">
                <th className="text-left p-3 font-medium">SKU</th>
                <th className="text-left p-3 font-medium">Expected Qty</th>
                <th className="text-left p-3 font-medium">Received Qty</th>
                <th className="text-left p-3 font-medium">Condition Notes</th>
                <th className="text-left p-3 font-medium">Location</th>
                <th className="text-left p-3 font-medium">Action</th>
              </tr>
            </thead>
            <tbody>
              {detail.items.map((item) => (
                <ItemCheckInRow
                  key={item.id}
                  item={item}
                  isCheckingIn={detail.status === "checking_in"}
                  onCheckIn={(itemId, receivedQty, conditionNotes, locationId) =>
                    checkInItemMutation.mutate({ itemId, receivedQty, conditionNotes, locationId })
                  }
                />
              ))}
              {detail.items.length === 0 && (
                <tr>
                  <td colSpan={6} className="p-8 text-center text-muted-foreground">
                    No items in this shipment.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
```

---

### src/app/admin/review-queue/page.tsx

```tsx
"use client";

import { Check, Loader2, Pause, RotateCcw } from "lucide-react";
import { useState } from "react";
import {
  assignReviewItem,
  bulkAssign,
  bulkResolve,
  getReviewQueueItems,
  reopenReviewItem,
  resolveReviewItem,
  suppressReviewItem,
} from "@/actions/review-queue";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useAppMutation, useAppQuery } from "@/lib/hooks/use-app-query";
import { queryKeys } from "@/lib/shared/query-keys";
import { CACHE_TIERS } from "@/lib/shared/query-tiers";

const SEVERITY_TABS = ["all", "critical", "high", "medium", "low"] as const;

function severityBadgeVariant(s: string) {
  if (s === "critical") return "destructive" as const;
  if (s === "high") return "default" as const;
  return "secondary" as const;
}

function slaIndicator(slaDueAt: string | null) {
  if (!slaDueAt) return null;
  const now = Date.now();
  const due = new Date(slaDueAt).getTime();
  const hoursLeft = (due - now) / (1000 * 60 * 60);
  if (hoursLeft < 0) return { color: "text-red-600", label: "Overdue" };
  if (hoursLeft < 2) return { color: "text-yellow-600", label: "Approaching" };
  return { color: "text-green-600", label: "On track" };
}

type QueueItem = Awaited<ReturnType<typeof getReviewQueueItems>>["items"][number];

export default function ReviewQueuePage() {
  const [tab, setTab] = useState<string>("all");
  const [filters, setFilters] = useState({ category: "", page: 1 });
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [assignInput, setAssignInput] = useState("");

  const queryFilters = {
    ...(tab !== "all" ? { severity: tab } : {}),
    ...(filters.category ? { category: filters.category } : {}),
    status: "open",
    page: filters.page,
  };

  const { data, isLoading } = useAppQuery({
    queryKey: queryKeys.reviewQueue.list(queryFilters),
    queryFn: () => getReviewQueueItems(queryFilters),
    tier: CACHE_TIERS.REALTIME,
  });

  const resolveMut = useAppMutation({
    mutationFn: ({ id, notes }: { id: string; notes: string }) => resolveReviewItem(id, notes),
    invalidateKeys: [queryKeys.reviewQueue.all],
  });

  const _assignMut = useAppMutation({
    mutationFn: ({ id, userId }: { id: string; userId: string }) => assignReviewItem(id, userId),
    invalidateKeys: [queryKeys.reviewQueue.all],
  });

  const suppressMut = useAppMutation({
    mutationFn: ({ id, hours }: { id: string; hours: number }) => suppressReviewItem(id, hours),
    invalidateKeys: [queryKeys.reviewQueue.all],
  });

  const reopenMut = useAppMutation({
    mutationFn: (id: string) => reopenReviewItem(id),
    invalidateKeys: [queryKeys.reviewQueue.all],
  });

  const bulkAssignMut = useAppMutation({
    mutationFn: (userId: string) => bulkAssign(Array.from(selected), userId),
    invalidateKeys: [queryKeys.reviewQueue.all],
    onSuccess: () => setSelected(new Set()),
  });

  const bulkResolveMut = useAppMutation({
    mutationFn: () => bulkResolve(Array.from(selected), "Bulk resolved"),
    invalidateKeys: [queryKeys.reviewQueue.all],
    onSuccess: () => setSelected(new Set()),
  });

  const items = data?.items ?? [];

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Review Queue</h1>
        <span className="text-muted-foreground text-sm">{data?.total ?? 0} items</span>
      </div>

      {/* Severity tabs */}
      <div className="flex gap-1 border-b">
        {SEVERITY_TABS.map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => {
              setTab(t);
              setFilters((f) => ({ ...f, page: 1 }));
            }}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors capitalize ${
              tab === t
                ? "border-primary text-primary"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      {/* Filters + bulk actions */}
      <div className="flex gap-3 items-center">
        <Input
          placeholder="Filter by category..."
          value={filters.category}
          onChange={(e) => setFilters((f) => ({ ...f, category: e.target.value, page: 1 }))}
          className="w-48"
        />
        {selected.size > 0 && (
          <div className="flex gap-2 items-center ml-auto">
            <span className="text-sm text-muted-foreground">{selected.size} selected</span>
            <Input
              placeholder="User ID"
              value={assignInput}
              onChange={(e) => setAssignInput(e.target.value)}
              className="w-40 h-8"
            />
            <Button
              size="sm"
              variant="outline"
              onClick={() => bulkAssignMut.mutate(assignInput)}
              disabled={!assignInput}
            >
              Assign
            </Button>
            <Button size="sm" variant="outline" onClick={() => bulkResolveMut.mutate()}>
              Resolve All
            </Button>
          </div>
        )}
      </div>

      {isLoading ? (
        <div className="flex items-center gap-2 py-8 justify-center text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading...
        </div>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-8">
                <input
                  type="checkbox"
                  onChange={(e) =>
                    setSelected(e.target.checked ? new Set(items.map((i) => i.id)) : new Set())
                  }
                  checked={selected.size === items.length && items.length > 0}
                />
              </TableHead>
              <TableHead>Title</TableHead>
              <TableHead>Category</TableHead>
              <TableHead>Severity</TableHead>
              <TableHead>SLA</TableHead>
              <TableHead className="text-right">Count</TableHead>
              <TableHead>Created</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((item: QueueItem) => {
              const sla = slaIndicator(item.sla_due_at);
              return (
                <>
                  <TableRow
                    key={item.id}
                    className="cursor-pointer"
                    onClick={() => setExpandedId((p) => (p === item.id ? null : item.id))}
                  >
                    <TableCell onClick={(e) => e.stopPropagation()}>
                      <input
                        type="checkbox"
                        checked={selected.has(item.id)}
                        onChange={(e) => {
                          const next = new Set(selected);
                          e.target.checked ? next.add(item.id) : next.delete(item.id);
                          setSelected(next);
                        }}
                      />
                    </TableCell>
                    <TableCell className="font-medium max-w-xs truncate">{item.title}</TableCell>
                    <TableCell className="text-muted-foreground text-xs">{item.category}</TableCell>
                    <TableCell>
                      <Badge variant={severityBadgeVariant(item.severity)}>{item.severity}</Badge>
                    </TableCell>
                    <TableCell>
                      {sla ? <span className={`text-xs ${sla.color}`}>{sla.label}</span> : "—"}
                    </TableCell>
                    <TableCell className="text-right">
                      {item.occurrence_count > 1 && (
                        <Badge variant="outline">{item.occurrence_count}x</Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {new Date(item.created_at).toLocaleDateString()}
                    </TableCell>
                  </TableRow>
                  {expandedId === item.id && (
                    <TableRow key={`${item.id}-detail`}>
                      <TableCell colSpan={7} className="bg-muted/30 p-4">
                        <div className="space-y-3">
                          {item.description && <p className="text-sm">{item.description}</p>}
                          {item.metadata && (
                            <pre className="text-xs bg-muted p-2 rounded overflow-auto max-h-40">
                              {JSON.stringify(item.metadata, null, 2)}
                            </pre>
                          )}
                          <div className="flex gap-2">
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => resolveMut.mutate({ id: item.id, notes: "Resolved" })}
                            >
                              <Check className="h-3 w-3 mr-1" /> Resolve
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => suppressMut.mutate({ id: item.id, hours: 4 })}
                            >
                              <Pause className="h-3 w-3 mr-1" /> Snooze 4h
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => reopenMut.mutate(item.id)}
                            >
                              <RotateCcw className="h-3 w-3 mr-1" /> Re-open
                            </Button>
                          </div>
                        </div>
                      </TableCell>
                    </TableRow>
                  )}
                </>
              );
            })}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
```

---

### src/app/admin/scan/page.tsx

```tsx
"use client";

import Image from "next/image";
import { useCallback, useEffect, useState } from "react";
import {
  lookupBarcode,
  lookupLocation,
  recordReceivingScan,
  submitCount,
} from "@/actions/scanning";
import { CountSession } from "@/components/admin/count-session";
import { ScannerInput } from "@/components/admin/scanner-input";
import { Button } from "@/components/ui/button";
import type { ScanMode } from "@/lib/hooks/use-scanner";
import { useScannerStore } from "@/lib/hooks/use-scanner";
import { cn } from "@/lib/utils";

// === Lookup Result Types ===

interface LookupResult {
  variant: Record<string, unknown>;
  product: Record<string, unknown> | null;
  inventory: Record<string, unknown> | null;
  locations: Array<Record<string, unknown>>;
}

// === Tab Config ===

const TABS: Array<{ mode: ScanMode; label: string }> = [
  { mode: "lookup", label: "Quick Lookup" },
  { mode: "count", label: "Count" },
  { mode: "receiving", label: "Receiving" },
];

// === Sub-Components ===

function LookupTab() {
  const [result, setResult] = useState<LookupResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleScan = useCallback(async (barcode: string) => {
    setLoading(true);
    setError(null);
    const res = await lookupBarcode(barcode);
    setLoading(false);
    if ("error" in res) {
      setError(res.error ?? "Unknown error");
      setResult(null);
    } else {
      setResult(res);
    }
  }, []);

  return (
    <div className="space-y-4">
      <ScannerInput onScan={handleScan} />
      {loading && <p className="text-muted-foreground text-sm">Looking up...</p>}
      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-400">
          {error}
        </div>
      )}
      {result && (
        <div className="space-y-3 rounded-lg border p-4">
          <div className="flex items-start gap-3">
            {result.product &&
              Array.isArray((result.product as Record<string, unknown>).images) &&
              ((result.product as Record<string, unknown>).images as Array<Record<string, unknown>>)
                .length > 0 && (
                <Image
                  src={
                    (
                      (
                        (result.product as Record<string, unknown>).images as Array<
                          Record<string, unknown>
                        >
                      )[0] as Record<string, unknown>
                    ).src as string
                  }
                  alt={((result.product as Record<string, unknown>).title as string) ?? ""}
                  width={64}
                  height={64}
                  className="size-16 rounded-md object-cover"
                />
              )}
            <div className="min-w-0 flex-1">
              <h3 className="font-medium leading-tight">
                {((result.product as Record<string, unknown>)?.title as string) ??
                  "Unknown product"}
              </h3>
              <p className="text-muted-foreground font-mono text-sm">
                {(result.variant as Record<string, unknown>).sku as string}
              </p>
              {(result.variant as Record<string, unknown>).barcode ? (
                <p className="text-muted-foreground text-xs">
                  Barcode: {String((result.variant as Record<string, unknown>).barcode)}
                </p>
              ) : null}
            </div>
          </div>

          {result.inventory && (
            <div className="grid grid-cols-3 gap-2 text-center">
              <div className="rounded-md bg-muted p-2">
                <p className="text-lg font-semibold tabular-nums">
                  {(result.inventory as Record<string, unknown>).available as number}
                </p>
                <p className="text-muted-foreground text-xs">Available</p>
              </div>
              <div className="rounded-md bg-muted p-2">
                <p className="text-lg font-semibold tabular-nums">
                  {(result.inventory as Record<string, unknown>).committed as number}
                </p>
                <p className="text-muted-foreground text-xs">Committed</p>
              </div>
              <div className="rounded-md bg-muted p-2">
                <p className="text-lg font-semibold tabular-nums">
                  {(result.inventory as Record<string, unknown>).incoming as number}
                </p>
                <p className="text-muted-foreground text-xs">Incoming</p>
              </div>
            </div>
          )}

          {result.locations.length > 0 && (
            <div>
              <h4 className="text-muted-foreground mb-1 text-xs font-medium uppercase">
                Locations
              </h4>
              <div className="divide-y rounded-md border">
                {result.locations.map((loc) => (
                  <div
                    key={loc.id as string}
                    className="flex items-center justify-between px-3 py-1.5 text-sm"
                  >
                    <span>
                      {((loc.warehouse_locations as Record<string, unknown>)?.name as string) ??
                        "—"}
                    </span>
                    <span className="font-medium tabular-nums">{loc.quantity as number}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function CountTab() {
  const { currentLocation, countSession, setLocation, startCountSession, addScanToCount } =
    useScannerStore();
  const [submitting, setSubmitting] = useState(false);
  const [submitResult, setSubmitResult] = useState<{
    matchedCount: number;
    mismatchCount: number;
  } | null>(null);

  // Step 1: Scan location barcode
  const handleLocationScan = useCallback(
    async (barcode: string) => {
      const res = await lookupLocation(barcode);
      if ("error" in res) {
        return;
      }
      setLocation({
        id: res.location.id,
        name: res.location.name,
        barcode: res.location.barcode ?? barcode,
      });
    },
    [setLocation],
  );

  // Step 2: Scan product barcodes
  const handleProductScan = useCallback(
    async (barcode: string) => {
      const res = await lookupBarcode(barcode);
      if ("error" in res) return;

      const sku = (res.variant as Record<string, unknown>).sku as string;
      // Find expected count at this location
      const locationEntry = res.locations.find(
        (loc) => (loc.location_id as string) === currentLocation?.id,
      );
      const expectedCount = (locationEntry?.quantity as number) ?? 0;
      addScanToCount(sku, expectedCount);
    },
    [currentLocation, addScanToCount],
  );

  const handleComplete = useCallback(
    async (
      locationId: string,
      counts: Array<{
        sku: string;
        scannedCount: number;
        expectedCount: number;
      }>,
    ) => {
      setSubmitting(true);
      const res = await submitCount(locationId, counts);
      setSubmitting(false);
      if ("error" in res) return;
      setSubmitResult({
        matchedCount: res.matchedCount,
        mismatchCount: res.mismatchCount,
      });
      setLocation(null);
    },
    [setLocation],
  );

  // Resume prompt
  const hasActiveSession = countSession !== null;

  if (submitResult) {
    return (
      <div className="space-y-3 rounded-lg border border-green-200 bg-green-50 p-4 dark:border-green-900 dark:bg-green-950">
        <h3 className="font-medium text-green-800 dark:text-green-200">Count submitted</h3>
        <p className="text-sm text-green-700 dark:text-green-300">
          {submitResult.matchedCount} confirmed, {submitResult.mismatchCount} sent to review queue
        </p>
        <Button size="sm" variant="outline" onClick={() => setSubmitResult(null)}>
          Start new count
        </Button>
      </div>
    );
  }

  // Step 1: No location set
  if (!currentLocation) {
    return (
      <div className="space-y-4">
        {hasActiveSession && (
          <div className="rounded-lg border border-yellow-200 bg-yellow-50 p-3 dark:border-yellow-900 dark:bg-yellow-950">
            <p className="text-sm text-yellow-800 dark:text-yellow-200">
              You have an active count session. Resume or start fresh?
            </p>
            <div className="mt-2 flex gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  if (countSession) {
                    setLocation({
                      id: countSession.locationId,
                      name: countSession.locationId,
                      barcode: countSession.locationId,
                    });
                  }
                }}
              >
                Resume
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => useScannerStore.getState().clearSession()}
              >
                Start fresh
              </Button>
            </div>
          </div>
        )}
        <p className="text-muted-foreground text-sm">Scan a location barcode to begin counting</p>
        <ScannerInput onScan={handleLocationScan} />
      </div>
    );
  }

  // Step 2 & 3: Location set, counting in progress
  if (!countSession) {
    startCountSession(currentLocation.id);
  }

  return (
    <div className="space-y-4">
      <ScannerInput onScan={handleProductScan} disabled={submitting} />
      <CountSession onComplete={handleComplete} />
    </div>
  );
}

function ReceivingTab() {
  const [shipmentId, setShipmentId] = useState<string | null>(null);
  const [items, setItems] = useState<Array<Record<string, unknown>>>([]);
  const [scanLog, setScanLog] = useState<
    Array<{ id: string; sku: string; received: number; expected: number; isOver: boolean }>
  >([]);
  const [completing, setCompleting] = useState(false);

  const handleShipmentScan = useCallback((barcode: string) => {
    setShipmentId(barcode);
    // In production, this would fetch inbound shipment items
  }, []);

  const handleItemScan = useCallback(
    async (barcode: string) => {
      if (!shipmentId) return;

      // Look up item by barcode to find matching inbound item
      const res = await lookupBarcode(barcode);
      if ("error" in res) return;

      const sku = (res.variant as Record<string, unknown>).sku as string;

      // Find the matching inbound item (simplified — real version matches by SKU)
      const matchingItem = items.find((item) => (item.sku as string) === sku);

      if (matchingItem) {
        const scanResult = await recordReceivingScan(matchingItem.id as string, 1);
        if (!("error" in scanResult)) {
          setScanLog((prev) => [
            {
              id: `${scanResult.inboundItemId}-${Date.now()}`,
              sku: scanResult.sku,
              received: scanResult.newReceived,
              expected: scanResult.expectedQuantity,
              isOver: scanResult.isOver,
            },
            ...prev,
          ]);
        }
      }
    },
    [shipmentId, items],
  );

  if (!shipmentId) {
    return (
      <div className="space-y-4">
        <p className="text-muted-foreground text-sm">Scan or enter an inbound shipment ID</p>
        <ScannerInput onScan={handleShipmentScan} />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="font-medium">Shipment: {shipmentId}</h3>
          <p className="text-muted-foreground text-xs">Scan items to check in</p>
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            setShipmentId(null);
            setItems([]);
            setScanLog([]);
          }}
        >
          Change
        </Button>
      </div>

      <ScannerInput onScan={handleItemScan} />

      {scanLog.length > 0 && (
        <div className="divide-y rounded-lg border">
          {scanLog.map((entry) => (
            <div key={entry.id} className="flex items-center justify-between px-3 py-2">
              <span className="font-mono text-sm">{entry.sku}</span>
              <div className="flex items-center gap-2">
                <span
                  className={cn(
                    "text-sm font-medium tabular-nums",
                    entry.isOver
                      ? "text-orange-600 dark:text-orange-400"
                      : entry.received === entry.expected
                        ? "text-green-600 dark:text-green-400"
                        : "text-foreground",
                  )}
                >
                  {entry.received}
                </span>
                <span className="text-muted-foreground text-xs">/</span>
                <span className="text-muted-foreground text-sm tabular-nums">{entry.expected}</span>
              </div>
            </div>
          ))}
        </div>
      )}

      <Button
        className="w-full"
        disabled={scanLog.length === 0 || completing}
        onClick={() => {
          setCompleting(true);
          // Complete check-in: in production, this calls a server action
          // to update inbound shipment status to 'checked_in'
          setTimeout(() => {
            setCompleting(false);
            setShipmentId(null);
            setItems([]);
            setScanLog([]);
          }, 500);
        }}
      >
        {completing ? "Completing..." : "Complete Check-in"}
      </Button>
    </div>
  );
}

// === Main Page ===

export default function ScanPage() {
  const { scanMode, setScanMode } = useScannerStore();

  // Default to lookup mode
  useEffect(() => {
    if (!scanMode) setScanMode("lookup");
  }, [scanMode, setScanMode]);

  const activeMode = scanMode ?? "lookup";

  return (
    <div className="mx-auto max-w-lg p-4 sm:p-6">
      <h1 className="text-2xl font-semibold tracking-tight">Scan</h1>
      <p className="text-muted-foreground mt-1 text-sm">
        Barcode scanner hub for warehouse operations
      </p>

      {/* Mode Tabs */}
      <div className="mt-4 flex gap-1 rounded-lg bg-muted p-1">
        {TABS.map((tab) => (
          <button
            key={tab.mode}
            type="button"
            onClick={() => setScanMode(tab.mode)}
            className={cn(
              "flex-1 rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
              activeMode === tab.mode
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Tab Content */}
      <div className="mt-4">
        {activeMode === "lookup" && <LookupTab />}
        {activeMode === "count" && <CountTab />}
        {activeMode === "receiving" && <ReceivingTab />}
      </div>
    </div>
  );
}
```

---

### src/app/admin/settings/store-mapping/page.tsx

```tsx
"use client";

import { ArrowRight, CheckCircle2, Loader2, RefreshCw, Unlink } from "lucide-react";
import { useState } from "react";
import { getUserContext } from "@/actions/auth";
import {
  type AutoMatchSuggestion,
  autoMatchStores,
  getStoreMappings,
  syncStoresFromShipStation,
  unmapStore,
  updateStoreMapping,
} from "@/actions/store-mapping";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useAppMutation, useAppQuery } from "@/lib/hooks/use-app-query";
import { queryKeys } from "@/lib/shared/query-keys";
import { CACHE_TIERS } from "@/lib/shared/query-tiers";

export default function StoreMappingPage() {
  const [suggestions, setSuggestions] = useState<AutoMatchSuggestion[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);

  const { data: ctx } = useAppQuery({
    queryKey: ["user-context"],
    queryFn: () => getUserContext(),
    tier: CACHE_TIERS.STABLE,
  });
  const workspaceId = ctx?.workspaceId ?? "";

  const { data: stores, isLoading } = useAppQuery({
    queryKey: queryKeys.storeMappings.list(workspaceId),
    queryFn: () => getStoreMappings(workspaceId),
    tier: CACHE_TIERS.SESSION,
    enabled: !!workspaceId,
  });

  const syncMutation = useAppMutation({
    mutationFn: () => syncStoresFromShipStation(workspaceId),
    invalidateKeys: [queryKeys.storeMappings.all],
  });

  const autoMatchMutation = useAppMutation({
    mutationFn: () => autoMatchStores(workspaceId),
    invalidateKeys: [],
    onSuccess: (data) => {
      setSuggestions(data);
      setShowSuggestions(true);
    },
  });

  const applyMappingMutation = useAppMutation({
    mutationFn: ({ storeId, orgId }: { storeId: string; orgId: string }) =>
      updateStoreMapping(storeId, orgId),
    invalidateKeys: [queryKeys.storeMappings.all],
  });

  const unmapMutation = useAppMutation({
    mutationFn: (storeId: string) => unmapStore(storeId),
    invalidateKeys: [queryKeys.storeMappings.all],
  });

  const mapped = (stores ?? []).filter((s) => s.org_id);
  const unmapped = (stores ?? []).filter((s) => !s.org_id);

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Store Mapping</h1>
        <div className="flex gap-2">
          <Button
            variant="outline"
            disabled={autoMatchMutation.isPending}
            onClick={() => autoMatchMutation.mutate()}
          >
            Auto-Match
          </Button>
          <Button
            variant="outline"
            disabled={syncMutation.isPending}
            onClick={() => syncMutation.mutate()}
          >
            <RefreshCw className={`h-4 w-4 mr-1 ${syncMutation.isPending ? "animate-spin" : ""}`} />
            Sync from ShipStation
          </Button>
        </div>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-3 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Total Stores
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold">{(stores ?? []).length}</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Mapped</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold text-green-600">{mapped.length}</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Unmapped</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold text-amber-600">{unmapped.length}</p>
          </CardContent>
        </Card>
      </div>

      {isLoading ? (
        <div className="flex justify-center py-8 text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
        </div>
      ) : (stores ?? []).length === 0 ? (
        <div className="py-8 text-center text-muted-foreground">
          No ShipStation stores found. Click &ldquo;Sync from ShipStation&rdquo; to import.
        </div>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Store Name</TableHead>
              <TableHead>Store ID</TableHead>
              <TableHead>Marketplace</TableHead>
              <TableHead>Mapped Org</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="w-24" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {(stores ?? []).map((store) => (
              <TableRow key={store.id}>
                <TableCell className="font-medium">{store.store_name ?? "Unnamed"}</TableCell>
                <TableCell className="font-mono text-xs text-muted-foreground">
                  {store.store_id}
                </TableCell>
                <TableCell className="text-muted-foreground text-sm">
                  {store.marketplace_name ?? "—"}
                </TableCell>
                <TableCell>
                  {store.org_name ? (
                    <span className="font-medium">{store.org_name}</span>
                  ) : (
                    <span className="text-muted-foreground italic">Unmapped</span>
                  )}
                </TableCell>
                <TableCell>
                  {store.org_id ? (
                    <Badge variant="default" className="gap-1">
                      <CheckCircle2 className="h-3 w-3" /> Mapped
                    </Badge>
                  ) : (
                    <Badge variant="outline">Unmapped</Badge>
                  )}
                </TableCell>
                <TableCell>
                  {store.org_id && (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={unmapMutation.isPending}
                      onClick={() => unmapMutation.mutate(store.id)}
                    >
                      <Unlink className="h-3 w-3 mr-1" /> Unmap
                    </Button>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      {/* Auto-match suggestions dialog */}
      <Dialog open={showSuggestions} onOpenChange={setShowSuggestions}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Auto-Match Suggestions</DialogTitle>
          </DialogHeader>
          {suggestions.length === 0 ? (
            <p className="text-muted-foreground text-sm py-4">
              No matches found. All stores may already be mapped.
            </p>
          ) : (
            <div className="space-y-3 max-h-96 overflow-y-auto">
              {suggestions.map((s) => (
                <div
                  key={s.storeId}
                  className="flex items-center justify-between border rounded-lg p-3"
                >
                  <div className="flex items-center gap-2 text-sm">
                    <span className="font-medium">{s.storeName}</span>
                    <ArrowRight className="h-3 w-3 text-muted-foreground" />
                    <span>{s.suggestedOrgName}</span>
                    <Badge variant="secondary" className="text-xs">
                      {Math.round(s.confidence * 100)}%
                    </Badge>
                  </div>
                  <Button
                    size="sm"
                    disabled={applyMappingMutation.isPending}
                    onClick={() => {
                      applyMappingMutation.mutate({ storeId: s.storeId, orgId: s.suggestedOrgId });
                    }}
                  >
                    Apply
                  </Button>
                </div>
              ))}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
```

---

### src/app/portal/billing/page.tsx

```tsx
"use client";

import { useState } from "react";
import { getUserContext } from "@/actions/auth";
import { getBillingSnapshotDetail, getBillingSnapshots } from "@/actions/billing";
import { Button } from "@/components/ui/button";
import { useAppQuery } from "@/lib/hooks/use-app-query";
import { queryKeys } from "@/lib/shared/query-keys";
import { CACHE_TIERS } from "@/lib/shared/query-tiers";

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    draft: "bg-yellow-100 text-yellow-800",
    sent: "bg-blue-100 text-blue-800",
    paid: "bg-green-100 text-green-800",
    overdue: "bg-red-100 text-red-800",
    void: "bg-gray-100 text-gray-800",
  };

  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${
        colors[status] ?? "bg-gray-100 text-gray-800"
      }`}
    >
      {status}
    </span>
  );
}

export default function BillingPage() {
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const { data: ctx } = useAppQuery({
    queryKey: ["user-context"],
    queryFn: () => getUserContext(),
    tier: CACHE_TIERS.STABLE,
  });
  const workspaceId = ctx?.workspaceId ?? "";
  const orgId = ctx?.orgId ?? "";

  const { data, isLoading } = useAppQuery({
    tier: CACHE_TIERS.SESSION,
    queryKey: queryKeys.billing.snapshots({ orgId }),
    queryFn: () => getBillingSnapshots({ workspaceId, orgId, pageSize: 50 }),
    enabled: !!workspaceId && !!orgId,
  });

  if (selectedId) {
    return <SnapshotDetail id={selectedId} onBack={() => setSelectedId(null)} />;
  }

  return (
    <div className="p-6 space-y-6">
      <h1 className="text-2xl font-semibold tracking-tight">Billing</h1>

      {isLoading ? (
        <p className="text-muted-foreground text-sm">Loading billing history…</p>
      ) : !data?.snapshots.length ? (
        <p className="text-muted-foreground text-sm">No billing statements yet.</p>
      ) : (
        <div className="border rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-muted/50">
              <tr>
                <th className="text-left p-3 font-medium">Period</th>
                <th className="text-left p-3 font-medium">Status</th>
                <th className="text-right p-3 font-medium">Total</th>
                <th className="text-right p-3 font-medium">Date</th>
                <th className="text-right p-3 font-medium" />
              </tr>
            </thead>
            <tbody className="divide-y">
              {data.snapshots.map((s) => (
                <tr key={s.id} className="hover:bg-muted/30">
                  <td className="p-3 font-medium">{s.billing_period}</td>
                  <td className="p-3">
                    <StatusBadge status={s.status} />
                  </td>
                  <td className="p-3 text-right font-mono">${s.grand_total.toFixed(2)}</td>
                  <td className="p-3 text-right text-muted-foreground">
                    {new Date(s.created_at).toLocaleDateString()}
                  </td>
                  <td className="p-3 text-right">
                    <div className="flex gap-2 justify-end">
                      <Button variant="outline" size="sm" onClick={() => setSelectedId(s.id)}>
                        View
                      </Button>
                      {s.stripe_invoice_id && (
                        <a
                          href={`https://invoice.stripe.com/i/${s.stripe_invoice_id}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center justify-center rounded-lg border border-border bg-background px-2.5 h-7 text-[0.8rem] font-medium hover:bg-muted hover:text-foreground transition-all"
                        >
                          Download
                        </a>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// === Read-only Snapshot Detail ===

function SnapshotDetail({ id, onBack }: { id: string; onBack: () => void }) {
  const { data, isLoading } = useAppQuery({
    tier: CACHE_TIERS.SESSION,
    queryKey: ["billing", "snapshot-detail", id],
    queryFn: () => getBillingSnapshotDetail(id),
  });

  if (isLoading) {
    return (
      <div className="p-6">
        <p className="text-muted-foreground text-sm">Loading statement…</p>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="p-6">
        <p className="text-muted-foreground text-sm">Statement not found.</p>
      </div>
    );
  }

  const { snapshot } = data;
  const sd = snapshot.snapshot_data as Record<string, unknown>;
  const included = (sd.included_shipments ?? []) as Array<{
    shipment_id: string;
    tracking_number: string | null;
    ship_date: string | null;
    carrier: string | null;
    shipping_cost: number;
    format_name: string;
    pick_pack_cost: number;
    material_cost: number;
  }>;
  const storageItems = (sd.storage_line_items ?? []) as Array<{
    sku: string;
    billable_units: number;
    storage_fee: number;
  }>;

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center gap-4">
        <Button variant="outline" size="sm" onClick={onBack}>
          Back
        </Button>
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            Statement — {snapshot.billing_period}
          </h1>
          <StatusBadge status={snapshot.status} />
        </div>
        {snapshot.stripe_invoice_id && (
          <a
            href={`https://invoice.stripe.com/i/${snapshot.stripe_invoice_id}`}
            target="_blank"
            rel="noopener noreferrer"
            className="ml-auto inline-flex items-center justify-center rounded-lg border border-border bg-background px-2.5 h-7 text-[0.8rem] font-medium hover:bg-muted hover:text-foreground transition-all"
          >
            Download Invoice
          </a>
        )}
      </div>

      {/* Totals */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
        {[
          { label: "Shipping", value: snapshot.total_shipping },
          { label: "Pick & Pack", value: snapshot.total_pick_pack },
          { label: "Materials", value: snapshot.total_materials },
          { label: "Storage", value: snapshot.total_storage },
          { label: "Adjustments", value: snapshot.total_adjustments },
          { label: "Grand Total", value: snapshot.grand_total },
        ].map((item) => (
          <div key={item.label} className="border rounded-lg p-3">
            <p className="text-xs text-muted-foreground">{item.label}</p>
            <p className="text-lg font-mono font-semibold">${(item.value ?? 0).toFixed(2)}</p>
          </div>
        ))}
      </div>

      {/* Shipments */}
      {included.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold mb-2">Shipments ({included.length})</h3>
          <div className="border rounded-lg overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-muted/50">
                <tr>
                  <th className="text-left p-2 font-medium">Tracking</th>
                  <th className="text-left p-2 font-medium">Ship Date</th>
                  <th className="text-left p-2 font-medium">Carrier</th>
                  <th className="text-left p-2 font-medium">Format</th>
                  <th className="text-right p-2 font-medium">Shipping</th>
                  <th className="text-right p-2 font-medium">Pick/Pack</th>
                  <th className="text-right p-2 font-medium">Material</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {included.map((s) => (
                  <tr key={s.shipment_id}>
                    <td className="p-2 font-mono text-xs">{s.tracking_number ?? "—"}</td>
                    <td className="p-2">{s.ship_date ?? "—"}</td>
                    <td className="p-2">{s.carrier ?? "—"}</td>
                    <td className="p-2">{s.format_name}</td>
                    <td className="p-2 text-right font-mono">${s.shipping_cost.toFixed(2)}</td>
                    <td className="p-2 text-right font-mono">${s.pick_pack_cost.toFixed(2)}</td>
                    <td className="p-2 text-right font-mono">${s.material_cost.toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Storage */}
      {storageItems.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold mb-2">Storage Charges</h3>
          <div className="border rounded-lg overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-muted/50">
                <tr>
                  <th className="text-left p-2 font-medium">SKU</th>
                  <th className="text-right p-2 font-medium">Billable Units</th>
                  <th className="text-right p-2 font-medium">Fee</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {storageItems.map((item) => (
                  <tr key={item.sku}>
                    <td className="p-2 font-mono text-xs">{item.sku}</td>
                    <td className="p-2 text-right">{item.billable_units}</td>
                    <td className="p-2 text-right font-mono">${item.storage_fee.toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
```

---

### src/app/portal/shipping/page.tsx

```tsx
"use client";

import { ChevronLeft, ChevronRight, Package } from "lucide-react";
import { useState } from "react";
import { getClientShipments, getShipmentItems, getTrackingEvents } from "@/actions/orders";
import { TrackingTimeline } from "@/components/shared/tracking-timeline";
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

type ShipmentRow = Awaited<ReturnType<typeof getClientShipments>>["shipments"][number];

export default function PortalShippingPage() {
  const [filters, setFilters] = useState({ page: 1, pageSize: 25, status: "", carrier: "" });
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const { data, isLoading } = useAppQuery({
    queryKey: queryKeys.shipments.list({ ...filters, portal: true }),
    queryFn: () => getClientShipments(filters),
    tier: CACHE_TIERS.SESSION,
  });

  const { data: expandedItems, isLoading: itemsLoading } = useAppQuery({
    queryKey: ["shipment-items", expandedId],
    queryFn: () => getShipmentItems(expandedId ?? ""),
    tier: CACHE_TIERS.SESSION,
    enabled: !!expandedId,
  });

  const totalPages = data ? Math.ceil(data.total / data.pageSize) : 0;

  return (
    <div className="p-6 space-y-4">
      <h1 className="text-2xl font-semibold tracking-tight">Shipping</h1>

      <div className="flex flex-wrap gap-3">
        <Input
          placeholder="Filter by carrier..."
          value={filters.carrier}
          onChange={(e) => setFilters((f) => ({ ...f, carrier: e.target.value, page: 1 }))}
          className="w-48"
        />
        <select
          value={filters.status}
          onChange={(e) => setFilters((f) => ({ ...f, status: e.target.value, page: 1 }))}
          className="border-input bg-background h-9 rounded-md border px-3 text-sm"
        >
          <option value="">All statuses</option>
          <option value="shipped">Shipped</option>
          <option value="in_transit">In Transit</option>
          <option value="out_for_delivery">Out for Delivery</option>
          <option value="delivered">Delivered</option>
          <option value="exception">Exception</option>
        </select>
      </div>

      {isLoading ? (
        <div className="space-y-2">
          {[1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Tracking</TableHead>
              <TableHead>Carrier</TableHead>
              <TableHead>Ship Date</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Weight</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {(data?.shipments ?? []).map((shipment: ShipmentRow) => (
              <>
                <TableRow
                  key={shipment.id}
                  className="cursor-pointer"
                  onClick={() =>
                    setExpandedId((prev) => (prev === shipment.id ? null : shipment.id))
                  }
                >
                  <TableCell className="font-mono text-xs">
                    {shipment.tracking_number ?? "—"}
                  </TableCell>
                  <TableCell>{shipment.carrier ?? "—"}</TableCell>
                  <TableCell className="text-sm">
                    {shipment.ship_date ? new Date(shipment.ship_date).toLocaleDateString() : "—"}
                  </TableCell>
                  <TableCell>
                    <ShipmentStatusBadge status={shipment.status} />
                  </TableCell>
                  <TableCell className="text-muted-foreground text-sm">
                    {shipment.weight ? `${shipment.weight} lbs` : "—"}
                  </TableCell>
                </TableRow>

                {expandedId === shipment.id && (
                  <TableRow key={`${shipment.id}-detail`}>
                    <TableCell colSpan={5} className="bg-muted/30 p-4">
                      <div className="grid grid-cols-2 gap-6">
                        <div>
                          <h4 className="text-sm font-semibold mb-2">Items</h4>
                          {itemsLoading ? (
                            <Skeleton className="h-16 w-full" />
                          ) : !expandedItems || expandedItems.length === 0 ? (
                            <p className="text-muted-foreground text-sm">No items recorded</p>
                          ) : (
                            <div className="space-y-1 text-sm">
                              {expandedItems.map((item) => (
                                <div key={item.id} className="flex justify-between">
                                  <span>
                                    <span className="font-mono text-xs text-muted-foreground">
                                      {item.sku}
                                    </span>{" "}
                                    {item.product_title ?? ""}
                                  </span>
                                  <span className="font-mono">x{item.quantity}</span>
                                </div>
                              ))}
                            </div>
                          )}

                          {shipment.shipping_cost != null && (
                            <div className="mt-3 text-sm">
                              <span className="text-muted-foreground">Cost: </span>
                              <span className="font-mono">
                                ${Number(shipment.shipping_cost).toFixed(2)}
                              </span>
                            </div>
                          )}
                        </div>

                        <div>
                          <h4 className="text-sm font-semibold mb-2">Tracking</h4>
                          <TrackingTimeline
                            shipmentId={shipment.id}
                            trackingNumber={shipment.tracking_number}
                            carrier={shipment.carrier}
                            fetchEvents={getTrackingEvents}
                          />
                        </div>
                      </div>
                    </TableCell>
                  </TableRow>
                )}
              </>
            ))}
            {data?.shipments.length === 0 && (
              <TableRow>
                <TableCell colSpan={5} className="py-8 text-center text-muted-foreground">
                  <Package className="h-8 w-8 mx-auto mb-2 opacity-50" />
                  No shipments found.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      )}

      {totalPages > 1 && (
        <div className="flex items-center justify-between">
          <span className="text-sm text-muted-foreground">
            Page {filters.page} of {totalPages}
          </span>
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

function ShipmentStatusBadge({ status }: { status: string }) {
  const config: Record<
    string,
    { variant: "default" | "secondary" | "destructive" | "outline"; label: string }
  > = {
    shipped: { variant: "secondary", label: "Shipped" },
    in_transit: { variant: "secondary", label: "In Transit" },
    out_for_delivery: { variant: "default", label: "Out for Delivery" },
    delivered: { variant: "default", label: "Delivered" },
    exception: { variant: "destructive", label: "Exception" },
  };
  const c = config[status] ?? { variant: "outline" as const, label: status };
  return <Badge variant={c.variant}>{c.label}</Badge>;
}
```

---

### src/app/portal/inventory/page.tsx

```tsx
"use client";

import { ChevronLeft, ChevronRight, ExternalLink, Minus, Package, Plus } from "lucide-react";
import { useState } from "react";
import { getInventoryDetail, getInventoryLevels } from "@/actions/inventory";
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

const PAGE_SIZES = [10, 25, 50, 100];

export default function InventoryPage() {
  const [filters, setFilters] = useState({
    format: "",
    search: "",
    page: 1,
    pageSize: 25,
  });
  const [expandedSku, setExpandedSku] = useState<string | null>(null);

  const queryFilters = {
    ...(filters.format && { format: filters.format }),
    ...(filters.search && { search: filters.search }),
    page: filters.page,
    pageSize: filters.pageSize,
  };

  // RLS filters to own org automatically via Supabase auth
  const { data, isLoading } = useAppQuery({
    queryKey: queryKeys.inventory.list({ ...queryFilters, portal: true }),
    queryFn: () => getInventoryLevels(queryFilters),
    tier: CACHE_TIERS.REALTIME,
  });

  const { data: detail, isLoading: detailLoading } = useAppQuery({
    queryKey: queryKeys.inventory.detail(expandedSku ?? ""),
    queryFn: () => getInventoryDetail(expandedSku ?? ""),
    tier: CACHE_TIERS.REALTIME,
    enabled: !!expandedSku,
  });

  const totalPages = data ? Math.ceil(data.total / data.pageSize) : 0;

  return (
    <div className="p-6 space-y-4">
      <h1 className="text-2xl font-semibold tracking-tight">Inventory</h1>

      {/* Filters */}
      <div className="flex flex-wrap gap-3">
        <Input
          placeholder="Search SKU or title..."
          value={filters.search}
          onChange={(e) => setFilters((f) => ({ ...f, search: e.target.value, page: 1 }))}
          className="w-64"
        />
        <Input
          placeholder="Filter by format..."
          value={filters.format}
          onChange={(e) => setFilters((f) => ({ ...f, format: e.target.value, page: 1 }))}
          className="w-40"
        />
      </div>

      {/* Table */}
      {isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={`skel-inv-${i.toString()}`} className="h-12 w-full" />
          ))}
        </div>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-12" />
              <TableHead>Product / SKU</TableHead>
              <TableHead className="text-right">Available</TableHead>
              <TableHead className="text-right">Committed</TableHead>
              <TableHead className="text-right">Incoming</TableHead>
              <TableHead>Format</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data?.rows.map((row) => (
              <>
                <TableRow
                  key={row.variantId}
                  className="cursor-pointer"
                  onClick={() => setExpandedSku((prev) => (prev === row.sku ? null : row.sku))}
                >
                  <TableCell>
                    {row.imageSrc ? (
                      // biome-ignore lint/performance/noImgElement: external Shopify CDN URLs — next/image optimization not applicable
                      <img
                        src={row.imageSrc}
                        alt={row.productTitle}
                        className="h-8 w-8 rounded object-cover"
                      />
                    ) : (
                      <div className="bg-muted flex h-8 w-8 items-center justify-center rounded">
                        <Package className="text-muted-foreground h-4 w-4" />
                      </div>
                    )}
                  </TableCell>
                  <TableCell>
                    <div className="font-medium">{row.productTitle}</div>
                    <div className="text-muted-foreground text-xs">{row.sku}</div>
                  </TableCell>
                  <TableCell className="text-right font-mono">{row.available}</TableCell>
                  <TableCell className="text-right font-mono">{row.committed}</TableCell>
                  <TableCell className="text-right font-mono">{row.incoming}</TableCell>
                  <TableCell className="text-muted-foreground text-sm">
                    {row.formatName ?? "—"}
                  </TableCell>
                </TableRow>

                {/* Expanded detail */}
                {expandedSku === row.sku && (
                  <TableRow key={`${row.variantId}-detail`}>
                    <TableCell colSpan={6} className="bg-muted/30 p-4">
                      {detailLoading ? (
                        <Skeleton className="h-24 w-full" />
                      ) : detail ? (
                        <div className="grid grid-cols-2 gap-6">
                          {/* Locations */}
                          <div>
                            <h4 className="mb-2 text-sm font-semibold">Locations</h4>
                            {detail.locations.length === 0 ? (
                              <p className="text-muted-foreground text-sm">No location data</p>
                            ) : (
                              <ul className="space-y-1 text-sm">
                                {detail.locations.map((loc) => (
                                  <li key={loc.locationId} className="flex justify-between">
                                    <span>
                                      {loc.locationName}{" "}
                                      <span className="text-muted-foreground">
                                        ({loc.locationType})
                                      </span>
                                    </span>
                                    <span className="font-mono">{loc.quantity}</span>
                                  </li>
                                ))}
                              </ul>
                            )}
                            {detail.bandcampUrl && (
                              <a
                                href={detail.bandcampUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="mt-2 inline-flex items-center gap-1 text-sm text-blue-600 hover:underline"
                              >
                                <ExternalLink className="h-3 w-3" />
                                Bandcamp
                              </a>
                            )}
                          </div>

                          {/* Recent Activity */}
                          <div>
                            <h4 className="mb-2 text-sm font-semibold">Recent Activity</h4>
                            {detail.recentActivity.length === 0 ? (
                              <p className="text-muted-foreground text-sm">No activity yet</p>
                            ) : (
                              <ul className="space-y-1 text-sm">
                                {detail.recentActivity.slice(0, 10).map((a) => (
                                  <li key={a.id} className="flex items-center justify-between">
                                    <span className="flex items-center gap-1">
                                      {a.delta > 0 ? (
                                        <Plus className="h-3 w-3 text-green-600" />
                                      ) : (
                                        <Minus className="h-3 w-3 text-red-600" />
                                      )}
                                      <span className="font-mono">
                                        {a.delta > 0 ? `+${a.delta}` : a.delta}
                                      </span>
                                      <span className="text-muted-foreground">{a.source}</span>
                                    </span>
                                    <span className="text-muted-foreground text-xs">
                                      {new Date(a.createdAt).toLocaleDateString()}
                                    </span>
                                  </li>
                                ))}
                              </ul>
                            )}
                          </div>
                        </div>
                      ) : null}
                    </TableCell>
                  </TableRow>
                )}
              </>
            ))}
            {data?.rows.length === 0 && (
              <TableRow>
                <TableCell colSpan={6} className="text-muted-foreground py-8 text-center">
                  No inventory found
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
                setFilters((f) => ({ ...f, pageSize: Number(e.target.value), page: 1 }))
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

### src/app/portal/orders/page.tsx

```tsx
"use client";

import { ChevronLeft, ChevronRight, Package } from "lucide-react";
import { useState } from "react";
import { getOrderDetail, getOrders, getTrackingEvents } from "@/actions/orders";
import { TrackingTimeline } from "@/components/shared/tracking-timeline";
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

type OrderRow = Awaited<ReturnType<typeof getOrders>>["orders"][number];

export default function PortalOrdersPage() {
  const [filters, setFilters] = useState({ page: 1, pageSize: 25, status: "", search: "" });
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const { data, isLoading } = useAppQuery({
    queryKey: queryKeys.orders.list({ ...filters, portal: true }),
    queryFn: () => getOrders(filters),
    tier: CACHE_TIERS.SESSION,
  });

  const { data: detail, isLoading: detailLoading } = useAppQuery({
    queryKey: queryKeys.orders.detail(expandedId ?? ""),
    queryFn: () => getOrderDetail(expandedId ?? ""),
    tier: CACHE_TIERS.SESSION,
    enabled: !!expandedId,
  });

  const totalPages = data ? Math.ceil(data.total / data.pageSize) : 0;

  return (
    <div className="p-6 space-y-4">
      <h1 className="text-2xl font-semibold tracking-tight">Orders</h1>

      <div className="flex flex-wrap gap-3">
        <Input
          placeholder="Search order number..."
          value={filters.search}
          onChange={(e) => setFilters((f) => ({ ...f, search: e.target.value, page: 1 }))}
          className="w-64"
        />
        <select
          value={filters.status}
          onChange={(e) => setFilters((f) => ({ ...f, status: e.target.value, page: 1 }))}
          className="border-input bg-background h-9 rounded-md border px-3 text-sm"
        >
          <option value="">All statuses</option>
          <option value="pending">Pending</option>
          <option value="ready_to_ship">Ready to Ship</option>
          <option value="shipped">Shipped</option>
          <option value="delivered">Delivered</option>
        </select>
      </div>

      {isLoading ? (
        <div className="space-y-2">
          {[1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Order</TableHead>
              <TableHead>Date</TableHead>
              <TableHead>Customer</TableHead>
              <TableHead>Items</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Total</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {(data?.orders ?? []).map((order: OrderRow) => (
              <>
                <TableRow
                  key={order.id}
                  className="cursor-pointer"
                  onClick={() => setExpandedId((prev) => (prev === order.id ? null : order.id))}
                >
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-sm">{order.order_number ?? "—"}</span>
                      {order.is_preorder && (
                        <Badge variant="secondary" className="text-xs">
                          Pre-Order
                          {order.street_date &&
                            ` · ${new Date(order.street_date).toLocaleDateString()}`}
                        </Badge>
                      )}
                    </div>
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {new Date(order.created_at).toLocaleDateString()}
                  </TableCell>
                  <TableCell>{order.customer_name ?? order.customer_email ?? "—"}</TableCell>
                  <TableCell className="text-muted-foreground text-sm">
                    {Array.isArray(order.line_items) ? order.line_items.length : 0} item(s)
                  </TableCell>
                  <TableCell>
                    <OrderStatusBadge status={order.fulfillment_status} />
                  </TableCell>
                  <TableCell className="text-right font-mono">
                    {order.total_price != null ? `$${Number(order.total_price).toFixed(2)}` : "—"}
                  </TableCell>
                </TableRow>

                {expandedId === order.id && (
                  <TableRow key={`${order.id}-detail`}>
                    <TableCell colSpan={6} className="bg-muted/30 p-4">
                      {detailLoading ? (
                        <Skeleton className="h-32 w-full" />
                      ) : detail ? (
                        <OrderExpandedDetail detail={detail} />
                      ) : null}
                    </TableCell>
                  </TableRow>
                )}
              </>
            ))}
            {data?.orders.length === 0 && (
              <TableRow>
                <TableCell colSpan={6} className="py-8 text-center text-muted-foreground">
                  <Package className="h-8 w-8 mx-auto mb-2 opacity-50" />
                  No orders found.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      )}

      {totalPages > 1 && (
        <div className="flex items-center justify-between">
          <span className="text-sm text-muted-foreground">
            Page {filters.page} of {totalPages}
          </span>
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

function OrderExpandedDetail({ detail }: { detail: Awaited<ReturnType<typeof getOrderDetail>> }) {
  const { order, items, shipments } = detail;
  if (!order) return null;

  return (
    <div className="grid grid-cols-2 gap-6">
      <div>
        <h4 className="text-sm font-semibold mb-2">Line Items</h4>
        {items.length === 0 ? (
          <p className="text-muted-foreground text-sm">No items</p>
        ) : (
          <div className="space-y-1 text-sm">
            {items.map((item) => (
              <div key={item.id} className="flex justify-between">
                <span>
                  <span className="font-mono text-xs text-muted-foreground">{item.sku}</span>{" "}
                  {item.title ?? item.variant_title ?? ""}
                </span>
                <span className="font-mono">
                  x{item.quantity}
                  {item.price != null && ` · $${Number(item.price).toFixed(2)}`}
                </span>
              </div>
            ))}
          </div>
        )}

        {order.shipping_address && (
          <div className="mt-4">
            <h4 className="text-sm font-semibold mb-1">Shipping Address</h4>
            <p className="text-sm text-muted-foreground whitespace-pre-line">
              {formatAddress(order.shipping_address as Record<string, unknown>)}
            </p>
          </div>
        )}
      </div>

      <div>
        <h4 className="text-sm font-semibold mb-2">Shipments</h4>
        {shipments.length === 0 ? (
          <p className="text-muted-foreground text-sm">No shipments yet</p>
        ) : (
          <div className="space-y-4">
            {shipments.map((s) => (
              <div key={s.id} className="border rounded-lg p-3">
                <TrackingTimeline
                  shipmentId={s.id}
                  trackingNumber={s.tracking_number}
                  carrier={s.carrier}
                  fetchEvents={getTrackingEvents}
                />
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function OrderStatusBadge({ status }: { status: string | null }) {
  const config: Record<
    string,
    { variant: "default" | "secondary" | "destructive" | "outline"; label: string }
  > = {
    pending: { variant: "outline", label: "Pending" },
    ready_to_ship: { variant: "secondary", label: "Ready to Ship" },
    shipped: { variant: "default", label: "Shipped" },
    delivered: { variant: "default", label: "Delivered" },
  };
  const c = config[status ?? ""] ?? { variant: "outline" as const, label: status ?? "Unknown" };
  return <Badge variant={c.variant}>{c.label}</Badge>;
}

function formatAddress(addr: Record<string, unknown>): string {
  const parts = [
    addr.firstName && addr.lastName ? `${addr.firstName} ${addr.lastName}` : null,
    addr.company,
    addr.address1,
    addr.address2,
    [addr.city, addr.province, addr.zip].filter(Boolean).join(", "),
    addr.country,
  ].filter(Boolean);
  return parts.join("\n");
}
```

---

## 5. Click-Through Behavior Notes

### Shipping List → Expanded Shipment Detail

**Admin (`/admin/shipping`):**
- Each row is a `<tr>` with `onClick={onToggle}`. Clicking toggles `expandedId`.
- When `expandedId === shipment.id`, a second `<tr>` is rendered with `colSpan={7}` and `bg-muted/10`.
- Expanded content: `ShipmentExpandedDetail` — grid 2 cols: (1) Shipment Items table (SKU, Product, Qty), (2) Tracking Timeline (events with status, description, location, event_time).
- Detail is fetched via `getShipmentDetail(expandedId)` when `expandedId` is set.

**Portal (`/portal/shipping`):**
- Same pattern: row click toggles `expandedId`.
- Expanded row: `colSpan={5}`, `bg-muted/30`. Content: (1) Items from `getShipmentItems(expandedId)`, (2) `TrackingTimeline` with `getTrackingEvents`.
- No separate detail page; all in-place expansion.

### Catalog List → Product Detail Page

**Admin (`/admin/catalog`):**
- Each `TableRow` has `onClick={() => router.push(\`/admin/catalog/${product.id}\`)}` — navigates to a new page.
- No in-place expansion. Full navigation to `/admin/catalog/[id]`.
- Detail page shows product header, edit form, and Tabs: Variants, Images, Inventory, Bandcamp.

### Orders List → Expanded Detail

**Admin (`/admin/orders`):**
- Row click toggles `expandedId`. When expanded, a second `TableRow` with `colSpan={7}` and `bg-muted/30` shows `OrderDetailExpanded`.
- Expanded content: grid 2 cols — (1) Line Items (SKU, title, qty, price), (2) Shipments with `TrackingTimeline` per shipment.

**Portal (`/portal/orders`):**
- Same pattern: row click toggles `expandedId`. Expanded row `colSpan={6}`, `bg-muted/30`.
- `OrderExpandedDetail`: (1) Line Items + Shipping Address, (2) Shipments with `TrackingTimeline`.

---

## Completion Summary

- **Document created:** `clandestine-fulfillment/docs/FULL_PAGE_SOURCE_AND_VISUAL_SYSTEM_HANDOFF_2026-03-18.md`
- **Sections included:** (1) Title and scope, (2) Navigation and layout map, (3) Visual system technical detail with full source for globals.css, components.json, postcss.config.mjs, admin-sidebar, portal-sidebar, admin/portal layouts, page-skeleton, tracking-timeline, UI components (button, input, card, table, tabs, badge), and CSS and Front-End Replication Notes, (4) Full page source appendix with complete source for all requested pages, (5) Click-through behavior notes for shipping, catalog, and orders.
- **Full source in document:** All requested pages now have full source included: admin (page, catalog, catalog/[id], clients, clients/[id], billing, inventory, inbound, inbound/[id], review-queue, scan, settings/store-mapping, shipping, orders), portal (billing, inventory, shipping, orders). See Section 4 for paths and source blocks.
