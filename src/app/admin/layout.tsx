"use client";

import { AdminSidebar } from "@/components/admin/admin-sidebar";
import { PresenceHeaderWrapper } from "@/components/admin/presence-header-wrapper";
import { CommandPalette } from "@/components/shared/command-palette";
import { SupportLauncher } from "@/components/support/support-launcher";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return (
    // defaultOpen={false} → first-visit lands users on the icon-collapsed
    // sidebar (per design preference). Sidebar state is per-session in
    // memory; users can hit the SidebarTrigger any time to expand to
    // full text labels.
    <SidebarProvider defaultOpen={false} data-warehouse-theme>
      <AdminSidebar />
      <SidebarInset>
        <header className="flex h-12 items-center gap-2 border-b px-4">
          <SidebarTrigger />
          <PresenceHeaderWrapper />
        </header>
        <main className="flex-1 min-w-0">{children}</main>
      </SidebarInset>
      <CommandPalette />
      <SupportLauncher supportPath="/admin/support" />
    </SidebarProvider>
  );
}
