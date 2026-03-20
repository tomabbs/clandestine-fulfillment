"use client";

import { PortalPresenceTracker } from "@/components/portal/portal-presence-tracker";
import { PortalSidebar } from "@/components/portal/portal-sidebar";
import { CommandPalette } from "@/components/shared/command-palette";
import { SupportLauncher } from "@/components/support/support-launcher";
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
      <SupportLauncher supportPath="/portal/support" />
      <PortalPresenceTracker />
    </SidebarProvider>
  );
}
