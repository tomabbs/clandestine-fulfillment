"use client";

import { MessageSquare, Plus } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { getConversations } from "@/actions/support";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { useAppQuery } from "@/lib/hooks/use-app-query";
import { queryKeys } from "@/lib/shared/query-keys";
import { CACHE_TIERS } from "@/lib/shared/query-tiers";

export function SupportLauncher({
  supportPath,
}: {
  supportPath: "/admin/support" | "/portal/support";
}) {
  const [open, setOpen] = useState(false);
  const { data } = useAppQuery({
    queryKey: queryKeys.support.conversations({ launcher: true }),
    queryFn: () => getConversations({ page: 1, pageSize: 8 }),
    tier: CACHE_TIERS.REALTIME,
  });

  const conversations = data?.conversations ?? [];
  const unreadCount = useMemo(
    () => conversations.reduce((sum, item) => sum + (item.unread_count ?? 0), 0),
    [conversations],
  );

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="fixed right-5 bottom-5 z-40 flex h-12 w-12 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-lg transition hover:opacity-90"
        aria-label="Open support"
      >
        <MessageSquare className="h-5 w-5" />
        {unreadCount > 0 && (
          <span className="absolute -top-1 -right-1 min-w-5 rounded-full bg-destructive px-1 text-center text-xs text-destructive-foreground">
            {unreadCount > 99 ? "99+" : unreadCount}
          </span>
        )}
      </button>

      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent className="w-full sm:max-w-md">
          <SheetHeader>
            <SheetTitle>Support</SheetTitle>
            <SheetDescription>
              {unreadCount > 0
                ? `${unreadCount} unread conversation${unreadCount === 1 ? "" : "s"}`
                : "No unread messages"}
            </SheetDescription>
          </SheetHeader>
          <div className="space-y-2 px-4 pb-4">
            <Link href={supportPath} onClick={() => setOpen(false)} className="w-full">
              <Button className="w-full justify-start">
                <Plus className="mr-2 h-4 w-4" />
                Open full support workspace
              </Button>
            </Link>
            <div className="max-h-[55vh] space-y-2 overflow-auto">
              {conversations.length === 0 && (
                <div className="rounded-md border p-3 text-sm text-muted-foreground">
                  No active conversations yet.
                </div>
              )}
              {conversations.map((conversation) => (
                <Link
                  key={conversation.id}
                  href={supportPath}
                  onClick={() => setOpen(false)}
                  className="block rounded-md border p-3 hover:bg-accent/40"
                >
                  <div className="flex items-center justify-between gap-2">
                    <p className="truncate text-sm font-medium">{conversation.subject}</p>
                    {(conversation.unread_count ?? 0) > 0 && (
                      <span className="rounded bg-primary/10 px-1.5 py-0.5 text-xs text-primary">
                        {conversation.unread_count} new
                      </span>
                    )}
                  </div>
                  <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                    {conversation.last_message_preview ?? "No messages yet"}
                  </p>
                </Link>
              ))}
            </div>
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}
