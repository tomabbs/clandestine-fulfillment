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
