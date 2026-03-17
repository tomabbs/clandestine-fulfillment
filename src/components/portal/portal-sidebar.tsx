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
