"use client";

import { PortalSidebar } from "@/components/portal/portal-sidebar";
import { CommandPalette } from "@/components/shared/command-palette";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";

export default function PortalLayout({ children }: { children: React.ReactNode }) {
  return (
    <SidebarProvider data-warehouse-theme>
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
