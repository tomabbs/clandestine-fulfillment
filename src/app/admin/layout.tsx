"use client";

import { AdminSidebar } from "@/components/admin/admin-sidebar";
import { PresenceHeaderWrapper } from "@/components/admin/presence-header-wrapper";
import { CommandPalette } from "@/components/shared/command-palette";
import { SupportLauncher } from "@/components/support/support-launcher";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return (
    <SidebarProvider data-warehouse-theme>
      <AdminSidebar />
      <SidebarInset>
        <header className="flex h-12 items-center gap-2 border-b px-4">
          <SidebarTrigger />
          <PresenceHeaderWrapper />
        </header>
        <main className="flex-1">{children}</main>
      </SidebarInset>
      <CommandPalette />
      <SupportLauncher supportPath="/admin/support" />
    </SidebarProvider>
  );
}
