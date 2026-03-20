"use client";

import { createBrowserClient } from "@supabase/ssr";
import { ArrowLeft, CheckCircle, MessageSquare, Plus, Send, UserPlus } from "lucide-react";
import { useEffect, useState } from "react";
import {
  assignConversation,
  createConversation,
  getConversationDetail,
  getConversations,
  getSupportViewerContext,
  markConversationRead,
  resolveConversation,
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
import type { ConversationStatus } from "@/lib/shared/types";

const STATUS_TABS: { label: string; value: ConversationStatus | undefined }[] = [
  { label: "Waiting on Staff", value: "waiting_on_staff" },
  { label: "Waiting on Client", value: "waiting_on_client" },
  { label: "Open", value: "open" },
  { label: "Resolved", value: "resolved" },
];

export default function AdminSupportPage() {
  const [activeTab, setActiveTab] = useState<ConversationStatus | undefined>("waiting_on_staff");
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
          <p className="text-muted-foreground text-sm mt-1">
            Manage support conversations with clients
          </p>
        </div>
        <Button onClick={() => setShowNewConversation(true)}>
          <Plus className="h-4 w-4 mr-2" />
          New Conversation
        </Button>
      </div>

      <div className="flex gap-2 mb-4">
        {STATUS_TABS.map((tab) => (
          <button
            key={tab.value ?? "all"}
            type="button"
            onClick={() => setActiveTab(tab.value)}
            className={`px-3 py-1.5 text-sm rounded-md transition-colors ${
              activeTab === tab.value
                ? "bg-primary text-primary-foreground"
                : "bg-muted text-muted-foreground hover:bg-muted/80"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <ConversationList status={activeTab} onSelect={setSelectedConversationId} />
    </div>
  );
}

function ConversationList({
  status,
  onSelect,
}: {
  status: ConversationStatus | undefined;
  onSelect: (id: string) => void;
}) {
  const { data: viewer } = useAppQuery({
    queryKey: queryKeys.support.viewerContext(),
    queryFn: getSupportViewerContext,
    tier: CACHE_TIERS.REALTIME,
  });
  const { counts } = useSupportPresence({
    userId: viewer?.userId ?? "unknown-user",
    userName: viewer?.userName ?? "Staff User",
    role: "staff",
    orgId: viewer?.orgId ?? null,
    currentPage: "/admin/support",
  });

  const { data, isLoading } = useAppQuery({
    queryKey: queryKeys.support.conversations({ status }),
    queryFn: () => getConversations({ status }),
    tier: CACHE_TIERS.REALTIME,
  });

  if (isLoading) {
    return (
      <div className="space-y-2">
        {["a", "b", "c", "d", "e"].map((key) => (
          <div
            key={`skeleton-${status}-${key}`}
            className="h-20 bg-muted animate-pulse rounded-lg"
          />
        ))}
      </div>
    );
  }

  const conversations = data?.conversations ?? [];

  if (conversations.length === 0) {
    return (
      <div className="text-center py-12 text-muted-foreground">
        <MessageSquare className="h-8 w-8 mx-auto mb-2 opacity-50" />
        <p>No conversations in this category</p>
      </div>
    );
  }

  return (
    <div className="space-y-1">
      <div className="mb-2 rounded-md border bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
        {counts.client > 0
          ? `${counts.client} client${counts.client === 1 ? "" : "s"} active in support`
          : "No active clients in support right now"}
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
            className={`w-full text-left p-4 rounded-lg border transition-colors hover:bg-accent/50 ${
              !conv.assigned_to ? "border-amber-300 bg-amber-50/50 dark:bg-amber-950/20" : ""
            }`}
          >
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-medium truncate">{conv.subject}</span>
                  {!conv.assigned_to && (
                    <span className="text-xs bg-amber-100 text-amber-800 px-1.5 py-0.5 rounded dark:bg-amber-900 dark:text-amber-200">
                      Unassigned
                    </span>
                  )}
                </div>
                <div className="text-sm text-muted-foreground mt-0.5">{conv.org_name}</div>
                {(conv.unread_count ?? 0) > 0 && (
                  <span className="mt-1 inline-flex rounded bg-primary/10 px-1.5 py-0.5 text-xs text-primary">
                    {conv.unread_count} unread
                  </span>
                )}
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

function ConversationDetail({
  conversationId,
  onBack,
}: {
  conversationId: string;
  onBack: () => void;
}) {
  const [replyBody, setReplyBody] = useState("");
  const [assignUserId, setAssignUserId] = useState("");

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
    userName: viewer?.userName ?? "Staff User",
    role: "staff",
    orgId: viewer?.orgId ?? null,
    currentPage: "/admin/support",
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

  const resolveMutation = useAppMutation({
    mutationFn: () => resolveConversation(conversationId),
    invalidateKeys: [queryKeys.support.messages(conversationId), queryKeys.support.all],
  });

  const assignMutation = useAppMutation({
    mutationFn: (userId: string) => assignConversation(conversationId, userId),
    invalidateKeys: [queryKeys.support.messages(conversationId), queryKeys.support.all],
    onSuccess: () => {
      setAssignUserId("");
      refetch();
    },
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
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="sm" onClick={onBack}>
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div>
            <h2 className="text-lg font-semibold">{conversation.subject}</h2>
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <span>{conversation.org_name}</span>
              <span>&middot;</span>
              <span className="capitalize">{conversation.status.replace(/_/g, " ")}</span>
              <span>&middot;</span>
              <span>{counts.client > 0 ? "Client active now" : "Client offline"}</span>
              {conversation.client_last_read_at && (
                <>
                  <span>&middot;</span>
                  <span>
                    Client last seen {new Date(conversation.client_last_read_at).toLocaleString()}
                  </span>
                </>
              )}
              {conversation.assigned_name && (
                <>
                  <span>&middot;</span>
                  <span>Assigned to {conversation.assigned_name}</span>
                </>
              )}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1">
            <Input
              placeholder="User ID to assign"
              value={assignUserId}
              onChange={(e) => setAssignUserId(e.target.value)}
              className="w-48 h-8 text-sm"
            />
            <Button
              variant="outline"
              size="sm"
              onClick={() => assignMutation.mutate(assignUserId)}
              disabled={!assignUserId || assignMutation.isPending}
            >
              <UserPlus className="h-4 w-4" />
            </Button>
          </div>
          {conversation.status !== "resolved" && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => resolveMutation.mutate()}
              disabled={resolveMutation.isPending}
            >
              <CheckCircle className="h-4 w-4 mr-1" />
              Resolve
            </Button>
          )}
        </div>
      </div>

      <Separator />

      <ScrollArea className="flex-1 py-4">
        <div className="space-y-4 max-w-3xl mx-auto">
          {messages.map((msg) => (
            <div
              key={msg.id}
              className={`flex ${msg.sender_type === "staff" ? "justify-end" : "justify-start"}`}
            >
              <div
                className={`max-w-[70%] rounded-lg p-3 ${
                  msg.sender_type === "staff" ? "bg-primary text-primary-foreground" : "bg-muted"
                }`}
              >
                <div className="text-xs opacity-70 mb-1">
                  {msg.sender_type === "staff" ? "Staff" : "Client"} &middot;{" "}
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
  const [orgId, setOrgId] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");

  const createMutation = useAppMutation({
    mutationFn: async () => {
      const result = await createConversation({ subject, body, orgId: orgId || undefined });
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
          <label htmlFor="org-id" className="text-sm font-medium block mb-1">
            Organization ID
          </label>
          <Input
            id="org-id"
            placeholder="UUID of the client organization"
            value={orgId}
            onChange={(e) => setOrgId(e.target.value)}
          />
        </div>
        <div>
          <label htmlFor="subject" className="text-sm font-medium block mb-1">
            Subject
          </label>
          <Input
            id="subject"
            placeholder="Conversation subject"
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
            placeholder="Your message..."
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
            Create Conversation
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
