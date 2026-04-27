"use client";

import { createBrowserClient } from "@supabase/ssr";
import {
  AlertTriangle,
  CheckCircle,
  Clock,
  Eye,
  MessageSquare,
  PenLine,
  Plus,
  Send,
  UserPlus,
} from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import {
  addInternalNote,
  assignConversation,
  createConversation,
  getConversationDetail,
  getConversations,
  getDuplicateCandidates,
  getSupportClientContext,
  getSupportInboxSummary,
  getSupportViewerContext,
  listSavedReplies,
  listSupportAssignees,
  markConversationRead,
  markDuplicateCandidateReviewed,
  resolveConversation,
  sendMessage,
  snoozeConversation,
  updateConversationTriage,
} from "@/actions/support";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import { useAppMutation, useAppQuery } from "@/lib/hooks/use-app-query";
import { useSupportPresence } from "@/lib/hooks/use-support-presence";
import { queryKeys } from "@/lib/shared/query-keys";
import { CACHE_TIERS } from "@/lib/shared/query-tiers";
import {
  SUPPORT_CATEGORIES,
  type SupportCategory,
  supportStatusLabel,
} from "@/lib/shared/support-taxonomy";
import type { SupportConversation, SupportMessage } from "@/lib/shared/types";

type QueueKey =
  | "needs_triage"
  | "mine"
  | "waiting_on_staff"
  | "waiting_on_client"
  | "sla_breach_soon"
  | "sla_breached"
  | "unassigned"
  | "snoozed"
  | "resolved";

const QUEUES: Array<{
  key: QueueKey;
  label: string;
  summaryKey: keyof Awaited<ReturnType<typeof getSupportInboxSummary>>;
}> = [
  { key: "needs_triage", label: "Needs triage", summaryKey: "needsTriage" },
  { key: "mine", label: "Mine", summaryKey: "mine" },
  { key: "waiting_on_staff", label: "Needs staff reply", summaryKey: "waitingOnStaff" },
  { key: "waiting_on_client", label: "Waiting on client", summaryKey: "waitingOnClient" },
  { key: "sla_breach_soon", label: "Breach soon", summaryKey: "slaBreachSoon" },
  { key: "sla_breached", label: "Breached", summaryKey: "slaBreached" },
  { key: "unassigned", label: "Unassigned", summaryKey: "unassigned" },
  { key: "snoozed", label: "Snoozed", summaryKey: "snoozed" },
  { key: "resolved", label: "Resolved", summaryKey: "resolvedTotal" },
];

const DRAFT_PREFIX = "support-admin-draft:";

export default function AdminSupportPage() {
  const [activeQueue, setActiveQueue] = useState<QueueKey>("needs_triage");
  const [selectedConversationId, setSelectedConversationId] = useState<string | null>(null);
  const [showNewConversation, setShowNewConversation] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const conversationId = params.get("conversation");
    if (conversationId) setSelectedConversationId(conversationId);
  }, []);

  const {
    data: summary,
    isLoading: summaryLoading,
    isError: summaryIsError,
    error: summaryError,
  } = useAppQuery({
    queryKey: queryKeys.support.summary(),
    queryFn: () => getSupportInboxSummary(),
    tier: CACHE_TIERS.REALTIME,
  });

  return (
    <div className="flex h-[calc(100vh-4rem)] flex-col gap-4 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Support Inbox</h1>
          <p className="text-sm text-muted-foreground">
            Triage client requests, watch SLA risk, and keep outbound delivery visible.
          </p>
        </div>
        <Button onClick={() => setShowNewConversation(true)}>
          <Plus className="mr-2 h-4 w-4" />
          New conversation
        </Button>
      </div>

      <div className="grid gap-3 md:grid-cols-7">
        <SummaryCard
          label="Tickets"
          value={summary?.totalConversations ?? 0}
          loading={summaryLoading}
        />
        <SummaryCard
          label="Messages"
          value={summary?.totalMessages ?? 0}
          loading={summaryLoading}
        />
        <SummaryCard label="Breach soon" value={summary?.slaBreachSoon ?? 0} tone="warning" />
        <SummaryCard label="Breached" value={summary?.slaBreached ?? 0} tone="danger" />
        <SummaryCard label="On track" value={summary?.onTrack ?? 0} />
        <SummaryCard label="Unassigned" value={summary?.unassigned ?? 0} />
        <SummaryCard
          label="Failed deliveries"
          value={summary?.failedDeliveries ?? 0}
          tone="danger"
        />
      </div>
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        {summaryIsError ? (
          <span className="rounded-md border border-destructive/30 bg-destructive/5 px-2 py-1 text-destructive">
            Support DB read failed: {(summaryError as Error).message}
          </span>
        ) : summary ? (
          <span className="rounded-md border bg-muted/30 px-2 py-1">
            Loaded from DB {formatLoadedAt(summary.loadedAt)} · latest message{" "}
            {summary.latestMessageAt ? formatLoadedAt(summary.latestMessageAt) : "not found"}
          </span>
        ) : (
          <span className="rounded-md border bg-muted/30 px-2 py-1">Reading support tables...</span>
        )}
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-[220px_minmax(280px,380px)_1fr] grid-rows-[minmax(0,1fr)] overflow-hidden rounded-lg border">
        <aside className="border-r bg-muted/20 p-3">
          <p className="mb-2 text-xs font-medium uppercase text-muted-foreground">Queues</p>
          <div className="space-y-1">
            {QUEUES.map((queue) => (
              <button
                key={queue.key}
                type="button"
                onClick={() => setActiveQueue(queue.key)}
                className={`flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-sm ${
                  activeQueue === queue.key
                    ? "bg-primary text-primary-foreground"
                    : "hover:bg-muted"
                }`}
              >
                <span>{queue.label}</span>
                <span className="text-xs opacity-80">{summary?.[queue.summaryKey] ?? 0}</span>
              </button>
            ))}
          </div>
        </aside>

        <ConversationList
          queue={activeQueue}
          selectedConversationId={selectedConversationId}
          onSelect={setSelectedConversationId}
        />

        <main className="min-w-0">
          {showNewConversation ? (
            <NewConversationForm
              onCancel={() => setShowNewConversation(false)}
              onCreated={(id) => {
                setShowNewConversation(false);
                setSelectedConversationId(id);
              }}
            />
          ) : selectedConversationId ? (
            <ConversationDetail conversationId={selectedConversationId} />
          ) : (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
              Select a conversation to work the ticket.
            </div>
          )}
        </main>
      </div>
    </div>
  );
}

function SummaryCard({
  label,
  value,
  loading = false,
  tone = "default",
}: {
  label: string;
  value: number;
  loading?: boolean;
  tone?: "default" | "warning" | "danger";
}) {
  const toneClass =
    tone === "danger" ? "text-red-600" : tone === "warning" ? "text-amber-600" : "text-foreground";
  return (
    <div className="rounded-lg border bg-background p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={`mt-1 text-2xl font-semibold ${toneClass}`}>{loading ? "..." : value}</p>
    </div>
  );
}

function ConversationList({
  queue,
  selectedConversationId,
  onSelect,
}: {
  queue: QueueKey;
  selectedConversationId: string | null;
  onSelect: (id: string) => void;
}) {
  const { data, isLoading } = useAppQuery({
    queryKey: queryKeys.support.conversations({ queue }),
    queryFn: () => getConversations({ queue, pageSize: 50 }),
    tier: CACHE_TIERS.SESSION,
  });

  if (isLoading)
    return <div className="border-r p-4 text-sm text-muted-foreground">Loading tickets...</div>;

  const conversations = data?.conversations ?? [];
  return (
    <section className="min-h-0 border-r">
      <ScrollArea className="h-full">
        {conversations.length === 0 ? (
          <div className="p-6 text-center text-sm text-muted-foreground">
            <MessageSquare className="mx-auto mb-2 h-7 w-7 opacity-50" />
            No tickets in this queue.
          </div>
        ) : (
          <div className="space-y-1 p-2">
            {conversations.map((conversation) => (
              <button
                key={conversation.id}
                type="button"
                onClick={() => onSelect(conversation.id)}
                className={`w-full rounded-md border p-3 text-left text-sm hover:bg-accent/50 ${
                  conversation.id === selectedConversationId ? "bg-accent" : ""
                }`}
              >
                <div className="flex items-start justify-between gap-2">
                  <p className="line-clamp-2 font-medium">{conversation.subject}</p>
                  {(conversation.unread_count ?? 0) > 0 && (
                    <span className="rounded bg-primary/10 px-1.5 py-0.5 text-xs text-primary">
                      {conversation.unread_count}
                    </span>
                  )}
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  {conversation.org_name ?? "Unknown org"}
                </p>
                <p className="mt-1 text-[11px] text-muted-foreground">
                  {conversation.message_count ?? 0}{" "}
                  {(conversation.message_count ?? 0) === 1 ? "message" : "messages"}
                  {conversation.last_message_at
                    ? ` · latest ${formatLoadedAt(conversation.last_message_at)}`
                    : ""}
                </p>
                <div className="mt-2 flex flex-wrap gap-1">
                  <Badge>{supportStatusLabel(conversation.status)}</Badge>
                  <Badge>{conversation.priority}</Badge>
                  {conversation.category && (
                    <Badge>{conversation.category.replaceAll("_", " ")}</Badge>
                  )}
                  {!conversation.assigned_to && <Badge tone="warning">Unassigned</Badge>}
                </div>
                {conversation.last_message_preview && (
                  <p className="mt-2 line-clamp-2 text-xs text-muted-foreground">
                    {conversation.last_message_preview}
                  </p>
                )}
              </button>
            ))}
          </div>
        )}
      </ScrollArea>
    </section>
  );
}

function formatLoadedAt(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function ConversationDetail({ conversationId }: { conversationId: string }) {
  const [replyBody, setReplyBody] = useState("");
  const [collisionMessage, setCollisionMessage] = useState<SupportMessage | null>(null);
  const [noteBody, setNoteBody] = useState("");

  const draftKey = `${DRAFT_PREFIX}${conversationId}`;
  const { data, isLoading, refetch } = useAppQuery({
    queryKey: queryKeys.support.messages(conversationId),
    queryFn: () => getConversationDetail(conversationId),
    tier: CACHE_TIERS.REALTIME,
  });
  const { data: viewer } = useAppQuery({
    queryKey: queryKeys.support.viewerContext(),
    queryFn: () => getSupportViewerContext(),
    tier: CACHE_TIERS.SESSION,
  });
  const { data: assignees } = useAppQuery({
    queryKey: queryKeys.support.assignees(),
    queryFn: () => listSupportAssignees(),
    tier: CACHE_TIERS.SESSION,
  });
  const { data: savedReplies } = useAppQuery({
    queryKey: queryKeys.support.savedReplies(),
    queryFn: () => listSavedReplies(),
    tier: CACHE_TIERS.SESSION,
  });
  const { data: context } = useAppQuery({
    queryKey: queryKeys.support.clientContext(conversationId),
    queryFn: () => getSupportClientContext(conversationId),
    tier: CACHE_TIERS.SESSION,
  });
  const { data: duplicates, refetch: refetchDuplicates } = useAppQuery({
    queryKey: queryKeys.support.duplicates(conversationId),
    queryFn: () => getDuplicateCandidates(conversationId),
    tier: CACHE_TIERS.SESSION,
  });

  const { users } = useSupportPresence({
    userId: viewer?.userId ?? "unknown-user",
    userName: viewer?.userName ?? "Staff User",
    role: "staff",
    orgId: viewer?.orgId ?? null,
    currentPage: "/admin/support",
    conversationId,
  });

  useEffect(() => {
    setReplyBody(window.sessionStorage.getItem(draftKey) ?? "");
  }, [draftKey]);

  useEffect(() => {
    window.sessionStorage.setItem(draftKey, replyBody);
  }, [draftKey, replyBody]);

  useEffect(() => {
    markConversationRead(conversationId).catch(() => {});
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

  const latestMessage = data?.messages[data.messages.length - 1] ?? null;

  const sendMutation = useAppMutation<Awaited<ReturnType<typeof sendMessage>>, Error, boolean>({
    mutationFn: async (force = false) => {
      const result = await sendMessage({
        conversationId,
        body: replyBody,
        clientMutationId: crypto.randomUUID(),
        lastSeenMessageId: latestMessage?.id,
        lastSeenMessageCreatedAt: latestMessage?.created_at,
        forceSendAfterCollision: force,
      });
      if (!result.success) {
        if (result.code === "CONVERSATION_CHANGED") {
          setCollisionMessage(result.latestMessage ?? null);
        }
        throw new Error(result.error);
      }
      return result;
    },
    invalidateKeys: [
      queryKeys.support.messages(conversationId),
      queryKeys.support.summary(),
      queryKeys.support.all,
    ],
    onSuccess: () => {
      setReplyBody("");
      setCollisionMessage(null);
      window.sessionStorage.removeItem(draftKey);
    },
  });

  const noteMutation = useAppMutation({
    mutationFn: () => addInternalNote(conversationId, noteBody),
    invalidateKeys: [queryKeys.support.messages(conversationId)],
    onSuccess: () => setNoteBody(""),
  });

  const conversation = data?.conversation;
  if (isLoading || !data || !conversation) {
    return <div className="p-6 text-sm text-muted-foreground">Loading conversation...</div>;
  }

  return (
    <div className="grid h-full min-h-0 min-w-0 grid-cols-[1fr_280px] grid-rows-[minmax(0,1fr)]">
      <div className="flex min-h-0 min-w-0 flex-col">
        <header className="border-b p-4">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <h2 className="truncate text-lg font-semibold">{conversation.subject}</h2>
              <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <span>{conversation.org_name}</span>
                <Badge>{supportStatusLabel(conversation.status)}</Badge>
                <Badge>{conversation.priority}</Badge>
                {users
                  .filter((user) => user.userId !== viewer?.userId)
                  .slice(0, 3)
                  .map((user) => (
                    <span key={user.userId} className="inline-flex items-center gap-1">
                      <Eye className="h-3 w-3 text-amber-600" />
                      {user.userName}
                    </span>
                  ))}
                {replyBody.trim() && (
                  <span className="inline-flex items-center gap-1">
                    <PenLine className="h-3 w-3 text-red-600" />
                    You are drafting
                  </span>
                )}
              </div>
            </div>
            <ConversationActions conversation={conversation} assignees={assignees ?? []} />
          </div>
          {(duplicates?.length ?? 0) > 0 && (
            <div className="mt-3 rounded-md border border-amber-300 bg-amber-50 p-2 text-sm text-amber-900 dark:bg-amber-950/20 dark:text-amber-200">
              <div className="flex items-center justify-between gap-2">
                <span className="inline-flex items-center gap-2">
                  <AlertTriangle className="h-4 w-4" />
                  Possible duplicate of {duplicates?.[0]?.duplicate_of_conversation_id.slice(0, 8)}{" "}
                  ({Math.round((duplicates?.[0]?.confidence ?? 0) * 100)}%)
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={async () => {
                    const duplicate = duplicates?.[0];
                    if (!duplicate) return;
                    await markDuplicateCandidateReviewed(duplicate.id, "keep_separate");
                    await refetchDuplicates();
                  }}
                >
                  Keep separate
                </Button>
              </div>
            </div>
          )}
        </header>

        <ScrollArea className="min-h-0 flex-1 p-4">
          <div className="mx-auto max-w-3xl space-y-4">
            {data.messages.map((msg) => (
              <MessageBubble key={msg.id} message={msg} />
            ))}
            {data.internalNotes.map((note) => (
              <div
                key={note.id}
                className="rounded-md border border-dashed bg-muted/40 p-3 text-sm"
              >
                <p className="text-xs font-medium text-muted-foreground">Internal note</p>
                <p className="mt-1 whitespace-pre-wrap">{note.body}</p>
              </div>
            ))}
          </div>
        </ScrollArea>

        <footer className="border-t p-4">
          {collisionMessage && (
            <div className="mb-3 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm dark:bg-amber-950/20">
              <p className="font-medium">A newer message arrived. Your draft is still here.</p>
              <p className="mt-1 whitespace-pre-wrap text-muted-foreground">
                {collisionMessage.body}
              </p>
              <Button className="mt-2" size="sm" onClick={() => sendMutation.mutate(true)}>
                Send anyway
              </Button>
            </div>
          )}
          <div className="mb-2 flex flex-wrap gap-2">
            {savedReplies?.slice(0, 5).map((reply) => (
              <Button
                key={reply.id}
                type="button"
                size="sm"
                variant="outline"
                onClick={() =>
                  setReplyBody((current) => `${current}${current ? "\n\n" : ""}${reply.body}`)
                }
              >
                {reply.title}
              </Button>
            ))}
          </div>
          <div className="flex gap-2">
            <Textarea
              placeholder="Type your reply..."
              value={replyBody}
              onChange={(event) => setReplyBody(event.target.value)}
              className="min-h-[88px]"
              onKeyDown={(event) => {
                if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && replyBody.trim()) {
                  event.preventDefault();
                  sendMutation.mutate(false);
                }
              }}
            />
            <Button
              onClick={() => sendMutation.mutate(false)}
              disabled={!replyBody.trim() || sendMutation.isPending}
              className="self-end"
            >
              <Send className="h-4 w-4" />
            </Button>
          </div>
          {sendMutation.error && (
            <p className="mt-2 text-sm text-destructive">{(sendMutation.error as Error).message}</p>
          )}
        </footer>
      </div>

      <aside className="min-h-0 border-l bg-muted/20">
        <ScrollArea className="h-full p-4">
          <div className="space-y-4">
            <section>
              <p className="text-xs font-medium uppercase text-muted-foreground">Client context</p>
              <p className="mt-2 font-medium">{context?.org.name ?? conversation.org_name}</p>
              <div className="mt-2 space-y-1 text-xs">
                <a className="block text-primary" href={context?.links.orgAdminUrl}>
                  Client detail
                </a>
                <a className="block text-primary" href={context?.links.ordersUrl}>
                  Orders
                </a>
                <a className="block text-primary" href={context?.links.shipmentsUrl}>
                  Shipments
                </a>
                <a className="block text-primary" href={context?.links.inventoryUrl}>
                  Inventory
                </a>
              </div>
            </section>
            <Separator />
            <section>
              <p className="text-xs font-medium uppercase text-muted-foreground">Related order</p>
              {context?.linkedOrder ? (
                <div className="mt-2 space-y-2 rounded border bg-background p-2 text-xs">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium">
                      {context.linkedOrder.order_number ?? "Order"}
                    </span>
                    <a
                      className="text-primary"
                      href={`/admin/orders?search=${encodeURIComponent(
                        context.linkedOrder.order_number ?? context.linkedOrder.id,
                      )}`}
                    >
                      Open
                    </a>
                  </div>
                  <p className="text-muted-foreground">
                    {context.linkedOrder.fulfillment_status ?? "status unknown"}
                    {context.linkedOrder.customer_email
                      ? ` · ${context.linkedOrder.customer_email}`
                      : ""}
                  </p>
                  {context.linkedOrder.bandcamp_payment_id ? (
                    <p className="font-mono text-muted-foreground">
                      Bandcamp {context.linkedOrder.bandcamp_payment_id}
                    </p>
                  ) : null}
                </div>
              ) : (
                <p className="mt-2 text-xs text-muted-foreground">No related order found.</p>
              )}
            </section>
            <Separator />
            <section>
              <p className="text-xs font-medium uppercase text-muted-foreground">
                Related shipment
              </p>
              {context?.linkedShipment ? (
                <div className="mt-2 space-y-2 rounded border bg-background p-2 text-xs">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium">
                      {context.linkedShipment.status ?? "shipment status unknown"}
                    </span>
                    {context.linkedShipment.public_track_token ? (
                      <a
                        className="text-primary"
                        href={`/track/${context.linkedShipment.public_track_token}`}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        Customer page
                      </a>
                    ) : null}
                  </div>
                  {context.linkedShipment.tracking_number ? (
                    <p className="font-mono text-muted-foreground">
                      {context.linkedShipment.carrier ?? "carrier"}{" "}
                      {context.linkedShipment.tracking_number}
                    </p>
                  ) : (
                    <p className="text-muted-foreground">No tracking number yet.</p>
                  )}
                  {context.linkedShipment.easypost_tracker_public_url ? (
                    <a
                      className="block text-primary"
                      href={context.linkedShipment.easypost_tracker_public_url}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      Carrier tracking
                    </a>
                  ) : null}
                </div>
              ) : (
                <p className="mt-2 text-xs text-muted-foreground">No shipment found yet.</p>
              )}
            </section>
            <Separator />
            <section>
              <p className="text-xs font-medium uppercase text-muted-foreground">Contacts</p>
              <div className="mt-2 space-y-1 text-xs">
                {context?.contacts.length ? (
                  context.contacts.map((contact) => <p key={contact.id}>{contact.email_address}</p>)
                ) : (
                  <p className="text-muted-foreground">No support email mappings.</p>
                )}
              </div>
            </section>
            <Separator />
            <section>
              <p className="text-xs font-medium uppercase text-muted-foreground">Recent tickets</p>
              <div className="mt-2 space-y-2 text-xs">
                {context?.recentConversations.length ? (
                  context.recentConversations.map((recent) => (
                    <p key={recent.id} className="rounded border bg-background p-2">
                      {recent.subject}
                    </p>
                  ))
                ) : (
                  <p className="text-muted-foreground">No recent tickets.</p>
                )}
              </div>
            </section>
            <Separator />
            <section>
              <p className="text-xs font-medium uppercase text-muted-foreground">Internal note</p>
              <Textarea
                value={noteBody}
                onChange={(event) => setNoteBody(event.target.value)}
                placeholder="Add staff-only context..."
                className="mt-2 min-h-[90px]"
              />
              <Button
                className="mt-2 w-full"
                size="sm"
                onClick={() => noteMutation.mutate()}
                disabled={!noteBody.trim() || noteMutation.isPending}
              >
                Add note
              </Button>
            </section>
          </div>
        </ScrollArea>
      </aside>
    </div>
  );
}

function ConversationActions({
  conversation,
  assignees,
}: {
  conversation: SupportConversation;
  assignees: Array<{ id: string; name: string; email: string }>;
}) {
  const assignMutation = useAppMutation({
    mutationFn: (staffUserId: string | null) => assignConversation(conversation.id, staffUserId),
    invalidateKeys: [
      queryKeys.support.messages(conversation.id),
      queryKeys.support.summary(),
      queryKeys.support.all,
    ],
  });
  const triageMutation = useAppMutation({
    mutationFn: (input: {
      priority?: "low" | "normal" | "high" | "urgent";
      category?: SupportCategory;
    }) => updateConversationTriage({ conversationId: conversation.id, ...input }),
    invalidateKeys: [
      queryKeys.support.messages(conversation.id),
      queryKeys.support.summary(),
      queryKeys.support.all,
    ],
  });
  const resolveMutation = useAppMutation({
    mutationFn: () => resolveConversation(conversation.id, { resolutionCode: "answered" }),
    invalidateKeys: [
      queryKeys.support.messages(conversation.id),
      queryKeys.support.summary(),
      queryKeys.support.all,
    ],
  });
  const snoozeMutation = useAppMutation({
    mutationFn: () =>
      snoozeConversation(conversation.id, new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()),
    invalidateKeys: [
      queryKeys.support.messages(conversation.id),
      queryKeys.support.summary(),
      queryKeys.support.all,
    ],
  });

  return (
    <div className="flex flex-wrap justify-end gap-2">
      <Select
        value={conversation.assigned_to ?? "unassigned"}
        onValueChange={(value) => assignMutation.mutate(value === "unassigned" ? null : value)}
      >
        <SelectTrigger className="h-8 w-40">
          <SelectValue placeholder="Assign" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="unassigned">Unassigned</SelectItem>
          {assignees.map((assignee) => (
            <SelectItem key={assignee.id} value={assignee.id}>
              {assignee.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Select
        value={conversation.category ?? undefined}
        onValueChange={(value) => triageMutation.mutate({ category: value as SupportCategory })}
      >
        <SelectTrigger className="h-8 w-40">
          <SelectValue placeholder="Category" />
        </SelectTrigger>
        <SelectContent>
          {SUPPORT_CATEGORIES.map((category) => (
            <SelectItem key={category} value={category}>
              {category.replaceAll("_", " ")}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Select
        value={conversation.priority}
        onValueChange={(value) =>
          triageMutation.mutate({ priority: value as "low" | "normal" | "high" | "urgent" })
        }
      >
        <SelectTrigger className="h-8 w-28">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {["low", "normal", "high", "urgent"].map((priority) => (
            <SelectItem key={priority} value={priority}>
              {priority}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Button variant="outline" size="sm" onClick={() => snoozeMutation.mutate()}>
        <Clock className="mr-1 h-4 w-4" />
        Snooze
      </Button>
      {conversation.status !== "resolved" && (
        <Button variant="outline" size="sm" onClick={() => resolveMutation.mutate()}>
          <CheckCircle className="mr-1 h-4 w-4" />
          Resolve
        </Button>
      )}
    </div>
  );
}

function MessageBubble({ message }: { message: SupportMessage }) {
  const outbound = message.sender_type === "staff";
  return (
    <div className={`flex ${outbound ? "justify-end" : "justify-start"}`}>
      <div
        className={`max-w-[72%] rounded-lg p-3 ${outbound ? "bg-primary text-primary-foreground" : "bg-muted"}`}
      >
        <div className="mb-1 text-xs opacity-70">
          {outbound ? "Staff" : "Client"} · {new Date(message.created_at).toLocaleString()}
          {message.source_channel &&
            message.source_channel !== "app" &&
            ` · ${message.source_channel}`}
          {message.delivered_via_email && " · email sent"}
        </div>
        <p className="whitespace-pre-wrap text-sm">{message.body}</p>
      </div>
    </div>
  );
}

function Badge({
  children,
  tone = "default",
}: {
  children: ReactNode;
  tone?: "default" | "warning";
}) {
  return (
    <span
      className={`rounded px-1.5 py-0.5 text-[11px] ${
        tone === "warning"
          ? "bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200"
          : "bg-muted text-muted-foreground"
      }`}
    >
      {children}
    </span>
  );
}

function NewConversationForm({
  onCancel,
  onCreated,
}: {
  onCancel: () => void;
  onCreated: (id: string) => void;
}) {
  const [orgId, setOrgId] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [category, setCategory] = useState<SupportCategory>("other");

  const createMutation = useAppMutation({
    mutationFn: async () => {
      const result = await createConversation({
        subject,
        body,
        orgId: orgId || undefined,
        category,
        priority: "normal",
      });
      if (!result.success) throw new Error(result.error);
      return result;
    },
    invalidateKeys: [queryKeys.support.summary(), queryKeys.support.all],
    onSuccess: (result) => onCreated(result.conversationId),
  });

  return (
    <div className="p-6">
      <h2 className="text-lg font-semibold">New support conversation</h2>
      <div className="mt-4 max-w-2xl space-y-4">
        <Input
          placeholder="Client organization UUID"
          value={orgId}
          onChange={(event) => setOrgId(event.target.value)}
        />
        <Input
          placeholder="Subject"
          value={subject}
          onChange={(event) => setSubject(event.target.value)}
        />
        <Select value={category} onValueChange={(value) => setCategory(value as SupportCategory)}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {SUPPORT_CATEGORIES.map((item) => (
              <SelectItem key={item} value={item}>
                {item.replaceAll("_", " ")}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Textarea
          placeholder="Message"
          value={body}
          onChange={(event) => setBody(event.target.value)}
          className="min-h-[150px]"
        />
        <div className="flex gap-2">
          <Button variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            onClick={() => createMutation.mutate()}
            disabled={!subject.trim() || !body.trim() || createMutation.isPending}
          >
            <UserPlus className="mr-2 h-4 w-4" />
            Create
          </Button>
        </div>
        {createMutation.error && (
          <p className="text-sm text-destructive">{(createMutation.error as Error).message}</p>
        )}
      </div>
    </div>
  );
}
