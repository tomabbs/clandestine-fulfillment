"use client";

import { createBrowserClient } from "@supabase/ssr";
import { useEffect, useMemo, useState } from "react";

type SupportPresenceRole = "staff" | "client";

interface SupportPresencePayload {
  userId: string;
  userName: string;
  role: SupportPresenceRole;
  orgId: string | null;
  currentPage: string;
  conversationId?: string;
}

interface PresenceUser {
  userId: string;
  userName: string;
  role: SupportPresenceRole;
  orgId: string | null;
  currentPage: string;
}

export function useSupportPresence(payload: SupportPresencePayload) {
  const [users, setUsers] = useState<PresenceUser[]>([]);
  const { conversationId, currentPage, orgId, role, userId, userName } = payload;
  const trackPayload = useMemo(
    () => ({ conversationId, currentPage, orgId, role, userId, userName }),
    [conversationId, currentPage, orgId, role, userId, userName],
  );

  useEffect(() => {
    const supabase = createBrowserClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL ?? "",
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "",
    );
    const channelName = trackPayload.conversationId
      ? `presence:support:conversation:${trackPayload.conversationId}`
      : "presence:support:global";
    const channel = supabase.channel(channelName);

    channel
      .on("presence", { event: "sync" }, () => {
        const nextUsers: PresenceUser[] = [];
        const state = channel.presenceState<PresenceUser>();
        for (const list of Object.values(state)) {
          for (const value of list) {
            nextUsers.push(value);
          }
        }
        setUsers(nextUsers);
      })
      .subscribe(async (status) => {
        if (status === "SUBSCRIBED") {
          await channel.track(trackPayload);
        }
      });

    return () => {
      channel.untrack();
      supabase.removeChannel(channel);
    };
  }, [trackPayload]);

  const counts = useMemo(() => {
    return users.reduce(
      (acc, item) => {
        if (item.role === "staff") acc.staff += 1;
        if (item.role === "client") acc.client += 1;
        return acc;
      },
      { staff: 0, client: 0 },
    );
  }, [users]);

  return { users, counts };
}
