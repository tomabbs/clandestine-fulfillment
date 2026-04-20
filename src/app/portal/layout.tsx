"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { getVisiblePages } from "@/actions/portal-settings";
import { PortalPresenceTracker } from "@/components/portal/portal-presence-tracker";
import { PortalSidebar } from "@/components/portal/portal-sidebar";
import { CommandPalette } from "@/components/shared/command-palette";
import { SupportLauncher } from "@/components/support/support-launcher";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { getPageKeyFromPathname } from "@/lib/shared/portal-pages";

function PortalPageGuard({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [allowed, setAllowed] = useState<boolean | null>(null);

  useEffect(() => {
    const pageKey = getPageKeyFromPathname(pathname);
    if (!pageKey) {
      setAllowed(true);
      return;
    }

    getVisiblePages()
      .then((pages) => {
        if (pages[pageKey] === false) {
          router.replace("/portal");
        } else {
          setAllowed(true);
        }
      })
      .catch(() => setAllowed(true));
  }, [pathname, router]);

  if (allowed === null) return null;
  return <>{children}</>;
}

export default function PortalLayout({ children }: { children: React.ReactNode }) {
  return (
    <SidebarProvider data-warehouse-theme>
      <PortalSidebar />
      <SidebarInset>
        <header className="flex h-12 items-center gap-2 border-b px-4">
          <SidebarTrigger />
        </header>
        <main className="flex-1 min-w-0">
          <PortalPageGuard>{children}</PortalPageGuard>
        </main>
      </SidebarInset>
      <CommandPalette />
      <SupportLauncher supportPath="/portal/support" />
      <PortalPresenceTracker />
    </SidebarProvider>
  );
}
