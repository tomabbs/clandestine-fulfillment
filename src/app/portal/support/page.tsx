"use client";

import { createBrowserClient } from "@supabase/ssr";
import { ArrowLeft, MessageSquare, Plus, Send } from "lucide-react";
import { useEffect, useState } from "react";
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
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import { useAppMutation, useAppQuery } from "@/lib/hooks/use-app-query";
import { useSupportPresence } from "@/lib/hooks/use-support-presence";
import { queryKeys } from "@/lib/shared/query-keys";
import { CACHE_TIERS } from "@/lib/shared/query-tiers";

export default function PortalSupportPage() {
  const [selectedConversationId, setSelectedConversationId] = useState<string | null>(null);
  const [showNewConversation, setShowNewConversation] = useState(false);

  if (showNewConversation) {
    return (
      <NewConversationForm
        onBack={() => setShowNewConversation(false)}
        onCreated={(id) => {
          setShowNewConversation(false);
          setSelectedConversationId(id);
        }}
      />
    );
  }

  if (selectedConversationId) {
    return (
      <ConversationDetail
        conversationId={selectedConversationId}
        onBack={() => setSelectedConversationId(null)}
      />
    );
  }

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Support</h1>
          <p className="text-muted-foreground text-sm mt-1">Get help from our team</p>
        </div>
        <Button onClick={() => setShowNewConversation(true)}>
          <Plus className="h-4 w-4 mr-2" />
          New Conversation
        </Button>
      </div>

      <ClientConversationList onSelect={setSelectedConversationId} />
    </div>
  );
}

function ClientConversationList({ onSelect }: { onSelect: (id: string) => void }) {
  const { data, isLoading, error } = useAppQuery({
    queryKey: queryKeys.support.conversations({}),
    queryFn: () => getConversations({}),
    tier: CACHE_TIERS.REALTIME,
  });
  const { data: viewer } = useAppQuery({
    queryKey: queryKeys.support.viewerContext(),
    queryFn: getSupportViewerContext,
    tier: CACHE_TIERS.REALTIME,
  });
  const { counts } = useSupportPresence({
    userId: viewer?.userId ?? "unknown-user",
    userName: viewer?.userName ?? "Portal User",
    role: "client",
    orgId: viewer?.orgId ?? null,
    currentPage: "/portal/support",
  });

  if (error) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-semibold tracking-tight">Support</h1>
        <p className="text-sm text-destructive">
          {error instanceof Error ? error.message : "Failed to load data."}
        </p>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="space-y-2">
        {["a", "b", "c"].map((key) => (
          <div key={`skeleton-${key}`} className="h-20 bg-muted animate-pulse rounded-lg" />
        ))}
      </div>
    );
  }

  const conversations = data?.conversations ?? [];

  if (conversations.length === 0) {
    return (
      <div className="text-center py-12 text-muted-foreground">
        <MessageSquare className="h-8 w-8 mx-auto mb-2 opacity-50" />
        <p>No conversations yet</p>
        <p className="text-sm mt-1">Start a new conversation to get help.</p>
      </div>
    );
  }

  return (
    <div className="space-y-1">
      <div className="mb-2 rounded-md border bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
        {counts.staff > 0
          ? `${counts.staff} support teammate${counts.staff === 1 ? "" : "s"} online now`
          : "Support is currently offline; email continuity is active."}
      </div>
      {conversations.map((conv) => {
        const timeSince = conv.last_message_at
          ? formatTimeSince(new Date(conv.last_message_at))
          : formatTimeSince(new Date(conv.updated_at));

        return (
          <button
            key={conv.id}
            type="button"
            onClick={() => onSelect(conv.id)}
            className="w-full text-left p-4 rounded-lg border transition-colors hover:bg-accent/50"
          >
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0 flex-1">
                <span className="font-medium truncate block">{conv.subject}</span>
                <div className="flex items-center gap-2 mt-0.5">
                  <StatusBadge status={conv.status} />
                  {(conv.unread_count ?? 0) > 0 && (
                    <span className="rounded bg-primary/10 px-1.5 py-0.5 text-xs text-primary">
                      {conv.unread_count} new
                    </span>
                  )}
                </div>
                {conv.last_message_preview && (
                  <p className="text-sm text-muted-foreground mt-1 truncate">
                    {conv.last_message_preview}
                  </p>
                )}
              </div>
              <span className="text-xs text-muted-foreground whitespace-nowrap">{timeSince}</span>
            </div>
          </button>
        );
      })}
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    open: "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200",
    waiting_on_client: "bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200",
    waiting_on_staff: "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200",
    resolved: "bg-gray-100 text-gray-800 dark:bg-gray-900 dark:text-gray-200",
    closed: "bg-gray-100 text-gray-800 dark:bg-gray-900 dark:text-gray-200",
  };

  return (
    <span className={`text-xs px-1.5 py-0.5 rounded ${styles[status] ?? ""}`}>
      {status.replace(/_/g, " ")}
    </span>
  );
}

function ConversationDetail({
  conversationId,
  onBack,
}: {
  conversationId: string;
  onBack: () => void;
}) {
  const [replyBody, setReplyBody] = useState("");

  const { data, isLoading, refetch } = useAppQuery({
    queryKey: queryKeys.support.messages(conversationId),
    queryFn: () => getConversationDetail(conversationId),
    tier: CACHE_TIERS.REALTIME,
  });
  const { data: viewer } = useAppQuery({
    queryKey: queryKeys.support.viewerContext(),
    queryFn: getSupportViewerContext,
    tier: CACHE_TIERS.REALTIME,
  });
  const { counts } = useSupportPresence({
    userId: viewer?.userId ?? "unknown-user",
    userName: viewer?.userName ?? "Portal User",
    role: "client",
    orgId: viewer?.orgId ?? null,
    currentPage: "/portal/support",
    conversationId,
  });

  useEffect(() => {
    markConversationRead(conversationId).catch(() => {
      // Non-blocking read marker update.
    });
  }, [conversationId]);

  useEffect(() => {
    const supabase = createBrowserClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL ?? "",
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "",
    );
    const channel = supabase
      .channel(`support:conversation:${conversationId}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "support_messages",
          filter: `conversation_id=eq.${conversationId}`,
        },
        () => {
          void markConversationRead(conversationId);
          void refetch();
        },
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [conversationId, refetch]);

  const sendMutation = useAppMutation({
    mutationFn: async (body: string) => {
      const result = await sendMessage({ conversationId, body });
      if (!result.success) throw new Error(result.error);
      return result;
    },
    invalidateKeys: [queryKeys.support.messages(conversationId), queryKeys.support.all],
    onSuccess: () => setReplyBody(""),
  });

  if (isLoading || !data) {
    return (
      <div className="p-6">
        <div className="h-8 w-48 bg-muted animate-pulse rounded mb-4" />
        <div className="space-y-4">
          {["a", "b", "c"].map((key) => (
            <div key={`msg-skeleton-${key}`} className="h-24 bg-muted animate-pulse rounded-lg" />
          ))}
        </div>
      </div>
    );
  }

  const { conversation, messages } = data;

  return (
    <div className="p-6 flex flex-col h-[calc(100vh-4rem)]">
      <div className="flex items-center gap-3 mb-4">
        <Button variant="ghost" size="sm" onClick={onBack}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div>
          <h2 className="text-lg font-semibold">{conversation.subject}</h2>
          <div className="text-sm text-muted-foreground">
            <StatusBadge status={conversation.status} />
            <span className="ml-2">
              {counts.staff > 0 ? "Support active now" : "Support currently offline"}
            </span>
            {conversation.staff_last_read_at && (
              <span className="ml-2">
                Last seen {new Date(conversation.staff_last_read_at).toLocaleString()}
              </span>
            )}
          </div>
        </div>
      </div>

      <Separator />

      <ScrollArea className="flex-1 py-4">
        <div className="space-y-4 max-w-3xl mx-auto">
          {messages.map((msg) => (
            <div
              key={msg.id}
              className={`flex ${msg.sender_type === "client" ? "justify-end" : "justify-start"}`}
            >
              <div
                className={`max-w-[70%] rounded-lg p-3 ${
                  msg.sender_type === "client" ? "bg-primary text-primary-foreground" : "bg-muted"
                }`}
              >
                <div className="text-xs opacity-70 mb-1">
                  {msg.sender_type === "staff" ? "Support Team" : "You"} &middot;{" "}
                  {new Date(msg.created_at).toLocaleString()}
                  {msg.source === "email" && " · reply from email"}
                  {msg.delivered_via_email && " · delivered via email"}
                </div>
                <p className="text-sm whitespace-pre-wrap">{msg.body}</p>
              </div>
            </div>
          ))}
        </div>
      </ScrollArea>

      {conversation.status !== "resolved" && conversation.status !== "closed" && (
        <div className="flex gap-2 pt-4 border-t">
          <Textarea
            placeholder="Type your reply..."
            value={replyBody}
            onChange={(e) => setReplyBody(e.target.value)}
            className="min-h-[80px]"
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                if (replyBody.trim()) sendMutation.mutate(replyBody);
              }
            }}
          />
          <Button
            onClick={() => sendMutation.mutate(replyBody)}
            disabled={!replyBody.trim() || sendMutation.isPending}
            className="self-end"
          >
            <Send className="h-4 w-4" />
          </Button>
        </div>
      )}
      {sendMutation.error && (
        <p className="text-sm text-destructive mt-2">{(sendMutation.error as Error).message}</p>
      )}
    </div>
  );
}

function NewConversationForm({
  onBack,
  onCreated,
}: {
  onBack: () => void;
  onCreated: (id: string) => void;
}) {
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");

  const createMutation = useAppMutation({
    mutationFn: async () => {
      const result = await createConversation({ subject, body });
      if (!result.success) throw new Error(result.error);
      return result;
    },
    invalidateKeys: [queryKeys.support.all],
    onSuccess: (data) => onCreated(data.conversationId),
  });

  return (
    <div className="p-6 max-w-2xl">
      <div className="flex items-center gap-3 mb-6">
        <Button variant="ghost" size="sm" onClick={onBack}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <h2 className="text-lg font-semibold">New Conversation</h2>
      </div>

      <div className="space-y-4">
        <div>
          <label htmlFor="subject" className="text-sm font-medium block mb-1">
            Subject
          </label>
          <Input
            id="subject"
            placeholder="What do you need help with?"
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
          />
        </div>
        <div>
          <label htmlFor="body" className="text-sm font-medium block mb-1">
            Message
          </label>
          <Textarea
            id="body"
            placeholder="Describe your issue or question..."
            value={body}
            onChange={(e) => setBody(e.target.value)}
            className="min-h-[150px]"
          />
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={onBack}>
            Cancel
          </Button>
          <Button
            onClick={() => createMutation.mutate()}
            disabled={!subject.trim() || !body.trim() || createMutation.isPending}
          >
            Send
          </Button>
        </div>
        {createMutation.error && (
          <p className="text-sm text-destructive">{(createMutation.error as Error).message}</p>
        )}
      </div>
    </div>
  );
}

function formatTimeSince(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
