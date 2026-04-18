"use client";

import { createBrowserClient } from "@supabase/ssr";
import {
  Disc3,
  DollarSign,
  LayoutDashboard,
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
import { useEffect, useRef, useState } from "react";
import { getVisiblePages } from "@/actions/portal-settings";
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

// Phase 0.8 — "Connected Stores" entry removed. Store connections are now
// administered through ShipStation Inventory Sync; staff can re-enable the
// first-party connectors per-row from /admin/settings/client-store-reconnect.
const NAV_ITEMS = [
  { title: "Home", href: "/portal", icon: LayoutDashboard, alwaysVisible: true },
  { title: "Inventory", href: "/portal/inventory", icon: Package, key: "inventory" },
  { title: "Catalog", href: "/portal/catalog", icon: Disc3, key: "catalog" },
  { title: "Inbound", href: "/portal/inbound", icon: PackagePlus, key: "inbound" },
  { title: "Fulfillment", href: "/portal/fulfillment", icon: ShoppingCart, key: "fulfillment" },
  { title: "Mail-Order", href: "/portal/mail-order", icon: DollarSign, key: "mail-order" },
  { title: "Shipping", href: "/portal/shipping", icon: Truck, key: "shipping" },
  { title: "Sales", href: "/portal/sales", icon: TrendingUp, key: "sales" },
  { title: "Billing", href: "/portal/billing", icon: Receipt, key: "billing" },
  { title: "Support", href: "/portal/support", icon: MessageSquare, key: "support" },
  { title: "Settings", href: "/portal/settings", icon: Settings, alwaysVisible: true },
] as const;

export function PortalSidebar() {
  const pathname = usePathname();
  const supabaseRef = useRef<ReturnType<typeof createBrowserClient> | null>(null);
  const [visiblePages, setVisiblePages] = useState<Record<string, boolean> | null>(null);

  useEffect(() => {
    getVisiblePages()
      .then(setVisiblePages)
      .catch(() => setVisiblePages(null));
  }, []);

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
              {NAV_ITEMS.filter((item) => {
                if ("alwaysVisible" in item) return true;
                if (!visiblePages) return true;
                return visiblePages[item.key] !== false;
              }).map((item) => (
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
