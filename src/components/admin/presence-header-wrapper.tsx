"use client";

import { createBrowserClient } from "@supabase/ssr";
import { useEffect, useState } from "react";
import { PresenceHeader } from "@/components/shared/presence-header";
import { usePresenceTracking } from "@/lib/hooks/use-presence-tracking";

/**
 * Self-contained wrapper that fetches the current user and renders PresenceHeader.
 * Keeps the layout.tsx change to a single import + component.
 */
export function PresenceHeaderWrapper() {
  const [user, setUser] = useState<{
    userId: string;
    userName: string;
    role: string;
  } | null>(null);

  useEffect(() => {
    const supabase = createBrowserClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL ?? "",
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "",
    );
    supabase.auth.getUser().then(({ data }) => {
      if (data.user) {
        setUser({
          userId: data.user.id,
          userName: data.user.email?.split("@")[0] ?? "Unknown",
          role: (data.user.app_metadata?.role as string) ?? "staff",
        });
      }
    });
  }, []);

  if (!user) return null;

  return <PresenceHeaderInner user={user} />;
}

function PresenceHeaderInner({
  user,
}: {
  user: { userId: string; userName: string; role: string };
}) {
  const { onlineUsers } = usePresenceTracking({
    ...user,
    currentPage: typeof window !== "undefined" ? window.location.pathname : "/admin",
  });

  return <PresenceHeader onlineUsers={onlineUsers} />;
}
