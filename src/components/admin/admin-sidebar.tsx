"use client";

import { createBrowserClient } from "@supabase/ssr";
import {
  AlertCircle,
  ClipboardList,
  FileBarChart,
  LayoutDashboard,
  Library,
  LogOut,
  MessageSquare,
  Monitor,
  Moon,
  Package,
  PackagePlus,
  Receipt,
  ScanBarcode,
  Settings,
  ShoppingCart,
  Store,
  Sun,
  TrendingUp,
  Truck,
  Users,
  Warehouse,
} from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useRef } from "react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
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
import { useTheme } from "@/contexts/ThemeContext";

const NAV_ITEMS = [
  { title: "Dashboard", href: "/admin", icon: LayoutDashboard },
  { title: "Scan", href: "/admin/scan", icon: ScanBarcode },
  { title: "Inventory", href: "/admin/inventory", icon: Package },
  { title: "Manual Count", href: "/admin/inventory/manual-count", icon: ClipboardList },
  { title: "Locations", href: "/admin/inventory/locations", icon: Warehouse },
  { title: "Inbound", href: "/admin/inbound", icon: PackagePlus },
  // Phase 2.3 — single "Orders" entry (was previously a dual sidebar with
  // /admin/shipstation-orders, now 301-redirected to /admin/orders).
  // /admin/orders-legacy is intentionally NOT in the sidebar — ops only.
  { title: "Orders", href: "/admin/orders", icon: ShoppingCart },
  { title: "Mail-Order", href: "/admin/mail-order", icon: Store },
  { title: "Catalog", href: "/admin/catalog", icon: Library },
  { title: "Clients", href: "/admin/clients", icon: Users },
  { title: "Shipping Log", href: "/admin/shipping", icon: Truck },
  { title: "SCAN Forms", href: "/admin/shipping/scan-forms", icon: FileBarChart },
  { title: "Billing", href: "/admin/billing", icon: Receipt },
  { title: "Top Sellers", href: "/admin/reports/top-sellers", icon: TrendingUp },
  { title: "Review Q", href: "/admin/review-queue", icon: AlertCircle },
  { title: "Support", href: "/admin/support", icon: MessageSquare },
] as const;

const SETTINGS_ITEMS = [
  { title: "General", href: "/admin/settings" },
  { title: "Users", href: "/admin/settings/users" },
  { title: "Bandcamp Accounts", href: "/admin/settings/bandcamp" },
  { title: "Store Connections", href: "/admin/settings/store-connections" },
  { title: "Reconnect Client Stores", href: "/admin/settings/client-store-reconnect" },
  { title: "Store Mapping", href: "/admin/settings/store-mapping" },
  { title: "Carrier Mapping", href: "/admin/settings/carrier-map" },
  { title: "Feature Flags", href: "/admin/settings/feature-flags" },
  { title: "Channels", href: "/admin/channels" },
  { title: "Integrations", href: "/admin/settings/integrations" },
  { title: "ShipStation Export", href: "/admin/settings/shipstation-export" },
  { title: "Health", href: "/admin/settings/health" },
  { title: "Mega-plan verification", href: "/admin/settings/megaplan-verification" },
  { title: "Direct-Shopify cutover", href: "/admin/settings/connection-cutover" },
] as const;

export function AdminSidebar() {
  const pathname = usePathname();
  const router = useRouter();
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
    // collapsible="icon" makes the sidebar shrink to icon-only width when
    // toggled (rather than vanishing offcanvas). Pages like /admin/orders
    // auto-collapse on mount so the table has more horizontal room; users
    // can hit the SidebarTrigger in the header to expand back to full text.
    <Sidebar collapsible="icon">
      <SidebarHeader className="border-b px-4 py-3 group-data-[collapsible=icon]:px-2">
        {/* Full logo in expanded state — hidden when collapsed to icon mode. */}
        <Image
          src="/logo.webp"
          alt="Clandestine Distribution"
          width={216}
          height={43}
          priority
          className="h-auto w-auto group-data-[collapsible=icon]:hidden"
        />
        {/* Compact mark when collapsed — the Clandestine 'C' hex emblem
            from public/icon-mark.png. Same source as the browser favicon. */}
        <Image
          src="/icon-mark.png"
          alt="Clandestine"
          width={32}
          height={32}
          priority
          className="hidden h-6 w-6 mx-auto group-data-[collapsible=icon]:block"
        />
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              {NAV_ITEMS.map((item) => (
                <SidebarMenuItem key={item.href}>
                  {/* tooltip prop auto-shows ONLY when sidebar is collapsed
                      to icon mode (and is hidden on mobile) — courtesy of
                      the shadcn SidebarMenuButton component. Tooltip text
                      matches the menu item label so users know what each
                      icon is when text labels are hidden. */}
                  <SidebarMenuButton
                    render={<Link href={item.href} />}
                    isActive={pathname === item.href}
                    tooltip={item.title}
                  >
                    <item.icon />
                    <span>{item.title}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}

              {/* Settings flyout — DropdownMenu opens a popover so the
                  submenu is reachable in both expanded and icon-collapsed
                  sidebar modes.
                  Children (icon + label) live INSIDE the render element
                  so Base UI's render-prop merge gives the SidebarMenuButton
                  its visible content. Putting them as children of
                  DropdownMenuTrigger (outside the render element) caused
                  the button to render empty.
                  Items use onClick+router.push because Base UI's MenuItem
                  exposes `onClick` (NOT Radix's `onSelect`, which is
                  silently ignored) and doesn't accept a Link via render
                  — props don't proxy through to Next's anchor. */}
              <SidebarMenuItem>
                <DropdownMenu>
                  <DropdownMenuTrigger
                    render={
                      <SidebarMenuButton isActive={pathname.startsWith("/admin/settings")}>
                        <Settings />
                        <span>Settings</span>
                      </SidebarMenuButton>
                    }
                  />
                  <DropdownMenuContent side="right" align="start" className="w-60">
                    {/* Group wrapper required — Base UI's MenuGroupLabel
                        crashes ("MenuGroupRootContext is missing") when
                        used outside a Menu.Group. */}
                    <DropdownMenuGroup>
                      <DropdownMenuLabel>Settings</DropdownMenuLabel>
                      <DropdownMenuSeparator />
                      {SETTINGS_ITEMS.map((item) => (
                        <DropdownMenuItem
                          key={item.href}
                          onClick={() => router.push(item.href)}
                          className={pathname === item.href ? "bg-accent font-medium" : undefined}
                        >
                          {item.title}
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuGroup>
                  </DropdownMenuContent>
                </DropdownMenu>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter className="border-t">
        <ThemeToggle />
        <SidebarMenu>
          <SidebarMenuItem>
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <SidebarMenuButton>
                    <Avatar className="h-6 w-6">
                      <AvatarFallback className="text-xs">CF</AvatarFallback>
                    </Avatar>
                    <span className="truncate text-sm">Staff User</span>
                  </SidebarMenuButton>
                }
              />
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

function ThemeToggle() {
  const { theme, setTheme } = useTheme();

  const options = [
    { value: "light" as const, icon: Sun, label: "Light" },
    { value: "dark" as const, icon: Moon, label: "Dark" },
    { value: "system" as const, icon: Monitor, label: "System" },
  ];

  return (
    // Horizontal row of 3 buttons when sidebar is expanded; stacks
    // vertically (column) when sidebar is collapsed to icon mode so the
    // 3 buttons don't spill outside the narrow icon-only width.
    <div className="flex items-center justify-center gap-1 px-3 py-2 group-data-[collapsible=icon]:flex-col group-data-[collapsible=icon]:px-1 group-data-[collapsible=icon]:gap-0.5">
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          title={opt.label}
          onClick={() => setTheme(opt.value)}
          className={`rounded-md p-1.5 transition-colors ${
            theme === opt.value
              ? "bg-sidebar-accent text-sidebar-accent-foreground"
              : "text-sidebar-foreground/50 hover:text-sidebar-foreground hover:bg-sidebar-accent/50"
          }`}
        >
          <opt.icon className="h-4 w-4" />
        </button>
      ))}
    </div>
  );
}
