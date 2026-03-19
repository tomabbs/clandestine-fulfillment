"use client";

import { createBrowserClient } from "@supabase/ssr";
import {
  AlertCircle,
  ChevronDown,
  LayoutDashboard,
  Library,
  LogOut,
  MessageSquare,
  Monitor,
  Moon,
  Package,
  PackagePlus,
  Radio,
  Receipt,
  ScanBarcode,
  Settings,
  ShoppingCart,
  Sun,
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
import { useTheme } from "@/contexts/ThemeContext";

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
  { title: "Users", href: "/admin/settings/users" },
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
        <ThemeToggle />
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

function ThemeToggle() {
  const { theme, setTheme } = useTheme();

  const options = [
    { value: "light" as const, icon: Sun, label: "Light" },
    { value: "dark" as const, icon: Moon, label: "Dark" },
    { value: "system" as const, icon: Monitor, label: "System" },
  ];

  return (
    <div className="flex items-center justify-center gap-1 px-3 py-2">
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
