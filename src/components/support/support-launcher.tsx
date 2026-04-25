"use client";

import { createBrowserClient } from "@supabase/ssr";
import { ArrowLeft, MessageSquare, Minimize2, Plus, Send } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  createConversation,
  getConversationDetail,
  getConversations,
  getSupportViewerContext,
  markConversationRead,
  sendMessage,
} from "@/actions/support";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Textarea } from "@/components/ui/textarea";
import { useAppMutation, useAppQuery } from "@/lib/hooks/use-app-query";
import { useSupportPresence } from "@/lib/hooks/use-support-presence";
import { queryKeys } from "@/lib/shared/query-keys";
import { CACHE_TIERS } from "@/lib/shared/query-tiers";

const OPEN_STATE_KEY = "support_launcher_open";

export function SupportLauncher({
  supportPath,
}: {
  supportPath: "/admin/support" | "/portal/support";
}) {
  const [open, setOpen] = useState(false);
  const [selectedConversationId, setSelectedConversationId] = useState<string | null>(null);
  const [replyBody, setReplyBody] = useState("");
  const [showNewConversationForm, setShowNewConversationForm] = useState(false);
  const [newSubject, setNewSubject] = useState("");
  const [newBody, setNewBody] = useState("");
  const [hasNewAlert, setHasNewAlert] = useState(false);
  const previousUnreadRef = useRef(0);

  useEffect(() => {
    const persisted = window.localStorage.getItem(OPEN_STATE_KEY);
    if (persisted === "1") {
      setOpen(true);
    }
  }, []);

  useEffect(() => {
    window.localStorage.setItem(OPEN_STATE_KEY, open ? "1" : "0");
  }, [open]);

  const { data: viewer } = useAppQuery({
    queryKey: queryKeys.support.viewerContext(),
    queryFn: getSupportViewerContext,
    tier: CACHE_TIERS.REALTIME,
  });

  const {
    data,
    refetch: refetchConversations,
    isLoading: conversationsLoading,
  } = useAppQuery({
    queryKey: queryKeys.support.conversations({ launcher: true }),
    queryFn: () => getConversations({ page: 1, pageSize: 8 }),
    tier: CACHE_TIERS.SESSION,
  });
  const { data: detail, refetch: refetchDetail } = useAppQuery({
    queryKey: queryKeys.support.messages(selectedConversationId ?? "launcher-none"),
    queryFn: async () => {
      if (!selectedConversationId) {
        return null;
      }
      return getConversationDetail(selectedConversationId);
    },
    enabled: !!selectedConversationId,
    tier: CACHE_TIERS.REALTIME,
  });

  const conversations = data?.conversations ?? [];
  const unreadCount = useMemo(
    () => conversations.reduce((sum, item) => sum + (item.unread_count ?? 0), 0),
    [conversations],
  );
  const { counts } = useSupportPresence({
    userId: viewer?.userId ?? "unknown-user",
    userName: viewer?.userName ?? "Support User",
    role: viewer?.role === "staff" ? "staff" : "client",
    orgId: viewer?.orgId ?? null,
    currentPage:
      supportPath === "/admin/support" ? "/admin/support/widget" : "/portal/support/widget",
    conversationId: selectedConversationId ?? undefined,
  });

  useEffect(() => {
    if (open) {
      setHasNewAlert(false);
      previousUnreadRef.current = unreadCount;
      return;
    }
    if (unreadCount > previousUnreadRef.current) {
      setHasNewAlert(true);
      setOpen(true);
    }
    previousUnreadRef.current = unreadCount;
  }, [open, unreadCount]);

  useEffect(() => {
    if (!open) return;
    const id = window.setInterval(() => {
      void refetchConversations();
    }, 30_000);
    return () => window.clearInterval(id);
  }, [open, refetchConversations]);

  useEffect(() => {
    if (!open || !selectedConversationId) return;
    const supabase = createBrowserClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL ?? "",
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "",
    );
    const msgChannel = supabase
      .channel(`support:launcher:message-detail:${selectedConversationId}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "support_messages",
          filter: `conversation_id=eq.${selectedConversationId}`,
        },
        () => {
          void refetchConversations();
          void markConversationRead(selectedConversationId);
          void refetchDetail();
        },
      )
      .subscribe();
    return () => {
      supabase.removeChannel(msgChannel);
    };
  }, [open, refetchConversations, refetchDetail, selectedConversationId]);

  const sendMutation = useAppMutation({
    mutationFn: async (body: string) => {
      if (!selectedConversationId) {
        throw new Error("No conversation selected.");
      }
      const result = await sendMessage({ conversationId: selectedConversationId, body });
      if (!result.success) {
        throw new Error(result.error);
      }
      return result;
    },
    onSuccess: () => {
      setReplyBody("");
      if (selectedConversationId) {
        void markConversationRead(selectedConversationId);
      }
      void refetchConversations();
      void refetchDetail();
    },
  });

  const createMutation = useAppMutation({
    mutationFn: async () => {
      const result = await createConversation({
        subject: newSubject,
        body: newBody,
      });
      if (!result.success) {
        throw new Error(result.error);
      }
      return result;
    },
    onSuccess: (result) => {
      setNewSubject("");
      setNewBody("");
      setShowNewConversationForm(false);
      setSelectedConversationId(result.conversationId);
      void refetchConversations();
      void refetchDetail();
    },
  });

  return (
    <>
      <button
        type="button"
        onClick={() => {
          setOpen((current) => !current);
          setHasNewAlert(false);
        }}
        className={`fixed right-5 bottom-5 z-40 flex h-12 w-12 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-lg transition hover:opacity-90 ${
          hasNewAlert ? "animate-pulse" : ""
        }`}
        aria-label="Open support"
      >
        <MessageSquare className="h-5 w-5" />
        {unreadCount > 0 && (
          <span className="absolute -top-1 -right-1 min-w-5 rounded-full bg-destructive px-1 text-center text-xs text-destructive-foreground">
            {unreadCount > 99 ? "99+" : unreadCount}
          </span>
        )}
      </button>

      {open && (
        <div className="fixed right-2 bottom-16 z-40 h-[min(640px,82vh)] w-[min(520px,calc(100vw-1rem))] rounded-xl border bg-background shadow-2xl sm:right-5 sm:bottom-20">
          <div className="flex items-center justify-between border-b px-3 py-2">
            <div>
              <p className="text-sm font-semibold">Support chat</p>
              <p className="text-xs text-muted-foreground">
                {unreadCount > 0
                  ? `${unreadCount} unread conversation${unreadCount === 1 ? "" : "s"}`
                  : "No unread messages"}
              </p>
            </div>
            <div className="flex items-center gap-1">
              <Link href={supportPath}>
                <Button variant="outline" size="sm" className="h-7 px-2 text-xs">
                  Open workspace
                </Button>
              </Link>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                onClick={() => setOpen(false)}
              >
                <Minimize2 className="h-4 w-4" />
              </Button>
            </div>
          </div>

          {hasNewAlert && (
            <div className="border-b bg-primary/5 px-3 py-1.5 text-xs text-primary">
              New support activity arrived.
            </div>
          )}

          <div className="grid h-[calc(100%-49px)] grid-cols-1 sm:grid-cols-[42%_58%]">
            <div
              className={`border-r ${selectedConversationId || showNewConversationForm ? "hidden sm:block" : ""}`}
            >
              <div className="flex items-center justify-between px-2 py-2">
                <p className="text-xs text-muted-foreground">
                  {viewer?.role === "staff"
                    ? `${counts.client} client${counts.client === 1 ? "" : "s"} active`
                    : `${counts.staff} support online`}
                </p>
                {viewer?.role === "client" && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7"
                    onClick={() => setShowNewConversationForm((current) => !current)}
                  >
                    <Plus className="h-4 w-4" />
                  </Button>
                )}
              </div>
              <ScrollArea className="h-[calc(100%-40px)] px-2 pb-2">
                {conversationsLoading ? (
                  <p className="px-1 py-2 text-xs text-muted-foreground">Loading...</p>
                ) : conversations.length === 0 ? (
                  <p className="px-1 py-2 text-xs text-muted-foreground">No conversations yet.</p>
                ) : (
                  <div className="space-y-1">
                    {conversations.map((conversation) => (
                      <button
                        key={conversation.id}
                        type="button"
                        onClick={() => {
                          setSelectedConversationId(conversation.id);
                          void markConversationRead(conversation.id);
                          setHasNewAlert(false);
                        }}
                        className={`w-full rounded-md border px-2 py-1.5 text-left hover:bg-accent/50 ${
                          selectedConversationId === conversation.id ? "bg-accent" : ""
                        }`}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <p className="truncate text-xs font-medium">{conversation.subject}</p>
                          {(conversation.unread_count ?? 0) > 0 && (
                            <span className="rounded bg-primary/10 px-1 text-[10px] text-primary">
                              {conversation.unread_count}
                            </span>
                          )}
                        </div>
                        <p className="mt-0.5 line-clamp-2 text-[11px] text-muted-foreground">
                          {conversation.last_message_preview ?? "No messages yet"}
                        </p>
                      </button>
                    ))}
                  </div>
                )}
              </ScrollArea>
            </div>

            <div
              className={`flex h-full flex-col ${
                !selectedConversationId && !showNewConversationForm ? "hidden sm:flex" : ""
              }`}
            >
              {showNewConversationForm && viewer?.role === "client" ? (
                <div className="flex h-full flex-col gap-2 p-3">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="w-fit px-2 sm:hidden"
                    onClick={() => setShowNewConversationForm(false)}
                  >
                    <ArrowLeft className="mr-1 h-4 w-4" />
                    Back
                  </Button>
                  <Input
                    placeholder="Subject"
                    value={newSubject}
                    onChange={(event) => setNewSubject(event.target.value)}
                    className="h-8 text-xs"
                  />
                  <Textarea
                    placeholder="What do you need help with?"
                    value={newBody}
                    onChange={(event) => setNewBody(event.target.value)}
                    className="min-h-[120px] text-xs"
                  />
                  <div className="mt-auto flex gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-8 text-xs"
                      onClick={() => setShowNewConversationForm(false)}
                    >
                      Cancel
                    </Button>
                    <Button
                      size="sm"
                      className="h-8 text-xs"
                      onClick={() => createMutation.mutate()}
                      disabled={!newSubject.trim() || !newBody.trim() || createMutation.isPending}
                    >
                      Create
                    </Button>
                  </div>
                  {createMutation.error && (
                    <p className="text-xs text-destructive">
                      {(createMutation.error as Error).message}
                    </p>
                  )}
                </div>
              ) : selectedConversationId && detail ? (
                <>
                  <div className="flex items-center gap-2 border-b px-3 py-2 sm:hidden">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7"
                      onClick={() => setSelectedConversationId(null)}
                    >
                      <ArrowLeft className="h-4 w-4" />
                    </Button>
                    <p className="truncate text-xs font-medium">{detail.conversation.subject}</p>
                  </div>
                  <ScrollArea className="h-full px-3 py-2">
                    <div className="space-y-2">
                      {detail.messages.map((msg) => (
                        <div
                          key={msg.id}
                          className={`flex ${
                            msg.sender_type === (viewer?.role === "staff" ? "staff" : "client")
                              ? "justify-end"
                              : "justify-start"
                          }`}
                        >
                          <div
                            className={`max-w-[88%] rounded-lg px-2.5 py-1.5 text-xs ${
                              msg.sender_type === (viewer?.role === "staff" ? "staff" : "client")
                                ? "bg-primary text-primary-foreground"
                                : "bg-muted"
                            }`}
                          >
                            <p className="whitespace-pre-wrap">{msg.body}</p>
                            <p className="mt-1 text-[10px] opacity-70">
                              {new Date(msg.created_at).toLocaleTimeString([], {
                                hour: "2-digit",
                                minute: "2-digit",
                              })}
                            </p>
                          </div>
                        </div>
                      ))}
                    </div>
                  </ScrollArea>
                  <div className="border-t p-2">
                    <div className="flex gap-1.5">
                      <Textarea
                        placeholder="Write a reply..."
                        value={replyBody}
                        onChange={(event) => setReplyBody(event.target.value)}
                        className="min-h-[64px] text-xs"
                        onKeyDown={(event) => {
                          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                            event.preventDefault();
                            if (replyBody.trim()) {
                              sendMutation.mutate(replyBody);
                            }
                          }
                        }}
                      />
                      <Button
                        size="icon"
                        className="h-8 w-8 self-end"
                        onClick={() => sendMutation.mutate(replyBody)}
                        disabled={!replyBody.trim() || sendMutation.isPending}
                      >
                        <Send className="h-4 w-4" />
                      </Button>
                    </div>
                    {sendMutation.error && (
                      <p className="mt-1 text-xs text-destructive">
                        {(sendMutation.error as Error).message}
                      </p>
                    )}
                  </div>
                </>
              ) : (
                <div className="flex h-full items-center justify-center px-4 text-center text-xs text-muted-foreground">
                  Select a conversation to chat here, or open the full support workspace.
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
