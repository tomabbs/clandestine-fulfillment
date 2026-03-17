"use client";

import { ArrowLeft, MessageSquare, Plus, Send } from "lucide-react";
import { useState } from "react";
import {
  createConversation,
  getConversationDetail,
  getConversations,
  sendMessage,
} from "@/actions/support";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import { useAppMutation, useAppQuery } from "@/lib/hooks/use-app-query";
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
  const { data, isLoading } = useAppQuery({
    queryKey: queryKeys.support.conversations({}),
    queryFn: () => getConversations({}),
    tier: CACHE_TIERS.REALTIME,
  });

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

  const { data, isLoading } = useAppQuery({
    queryKey: queryKeys.support.messages(conversationId),
    queryFn: () => getConversationDetail(conversationId),
    tier: CACHE_TIERS.REALTIME,
  });

  const sendMutation = useAppMutation({
    mutationFn: (body: string) => sendMessage({ conversationId, body }),
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
    mutationFn: () => createConversation({ subject, body }),
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
