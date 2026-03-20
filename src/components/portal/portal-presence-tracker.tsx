"use client";

import { usePathname } from "next/navigation";
import { useEffect } from "react";
import { getUserContext, heartbeatPresence } from "@/actions/auth";
import { useAppQuery } from "@/lib/hooks/use-app-query";
import { usePresenceTracking } from "@/lib/hooks/use-presence-tracking";
import { queryKeys } from "@/lib/shared/query-keys";
import { CACHE_TIERS } from "@/lib/shared/query-tiers";

export function PortalPresenceTracker() {
  const pathname = usePathname();
  const { data: user } = useAppQuery({
    queryKey: queryKeys.auth.userContext(),
    queryFn: getUserContext,
    tier: CACHE_TIERS.REALTIME,
  });

  usePresenceTracking({
    userId: user?.userId ?? "unknown-user",
    userName: user?.userName ?? "Portal User",
    role: user?.userRole ?? "client",
    currentPage: pathname,
  });

  useEffect(() => {
    if (!pathname) return;
    void heartbeatPresence(pathname);
    const id = window.setInterval(() => {
      void heartbeatPresence(pathname);
    }, 60_000);
    return () => window.clearInterval(id);
  }, [pathname]);

  return null;
}
