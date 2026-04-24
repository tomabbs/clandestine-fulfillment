/**
 * Bandcamp sale poll — per-connection event-driven entry point.
 *
 * Phase 2 §9.3 D3 — fired by `routeInboundEmail()` (resend-inbound webhook
 * router) when an order email's recipient address matches exactly one
 * `bandcamp_connections.inbound_forwarding_address`. Replaces the prior
 * `tasks.trigger("bandcamp-sale-poll", {})` global fan-out for the matched
 * case. With N active bands and N inbound mailboxes configured, this cuts
 * Bandcamp `getMerchDetails()` calls from O(N) per order email down to 1.
 *
 * Body delegates to `pollOneBandcampConnection()` so the cron and event-
 * driven paths share the SAME idempotency contract, post-sale fanout, and
 * Rule #65 v2 echo-skip rationale.
 *
 * Rule #9: Pinned to `bandcampQueue` (concurrencyLimit:1) so this task and
 * the cron `bandcamp-sale-poll` cannot race on the OAuth token family —
 * even though they read the same band, refreshBandcampToken() is invoked
 * inside both, and Bandcamp invalidates older tokens when a newer refresh
 * succeeds (the duplicate_grant kill rule from Rule #48).
 *
 * Idempotency at the call site: the resend-inbound router sets
 * `idempotencyKey = bandcamp-per-connection:{connectionId}:{webhookEventId}`
 * with a 10-minute TTL — so Resend retries (signature replay protection in
 * the route handler already drops duplicates, but Trigger.dev side is
 * belt-and-braces) cannot enqueue twice.
 *
 * Rule #20: Inventory deltas go through recordInventoryChange() (inside runner).
 * Rule #7: Service-role Supabase client.
 */

import * as Sentry from "@sentry/nextjs";
import { logger, task } from "@trigger.dev/sdk";
import { z } from "zod";
import { refreshBandcampToken } from "@/lib/clients/bandcamp";
import { createServiceRoleClient } from "@/lib/server/supabase-server";
import { bandcampQueue } from "@/trigger/lib/bandcamp-queue";
import { pollOneBandcampConnection } from "@/trigger/lib/bandcamp-sale-poll-runner";

const payloadSchema = z.object({
  workspaceId: z.string().uuid(),
  connectionId: z.string().uuid(),
  /**
   * Resend `webhook_events.id` (uuid) that triggered this run. Stored on
   * the channel_sync_log row for forensics — operator can grep
   * webhook_events for the original payload when investigating a sale.
   */
  triggeredByWebhookEventId: z.string().uuid().optional(),
  /** Optional informational hint — the matched mailbox alias. */
  recipient: z.string().optional(),
});

export type BandcampSalePollPerConnectionPayload = z.infer<typeof payloadSchema>;

export const bandcampSalePollPerConnectionTask = task({
  id: "bandcamp-sale-poll-per-connection",
  queue: bandcampQueue,
  maxDuration: 60,
  run: async (payload: BandcampSalePollPerConnectionPayload, { ctx }) => {
    const parsed = payloadSchema.parse(payload);
    const supabase = createServiceRoleClient();
    const startedAt = new Date().toISOString();

    const { data: connection, error: connError } = await supabase
      .from("bandcamp_connections")
      .select("id, workspace_id, org_id, band_id, is_active, inbound_forwarding_address")
      .eq("id", parsed.connectionId)
      .maybeSingle();

    if (connError) {
      Sentry.captureException(connError, {
        tags: { task: "bandcamp-sale-poll-per-connection", failure: "connection_lookup_failed" },
        extra: { connectionId: parsed.connectionId },
      });
      throw connError;
    }

    if (!connection) {
      logger.warn(
        `[bandcamp-sale-poll-per-connection] connection ${parsed.connectionId} not found — falling back is the router's job, this run is a no-op`,
      );
      return { skipped: "connection_not_found", salesDetected: 0, errors: 0 };
    }

    if (!connection.is_active) {
      logger.warn(
        `[bandcamp-sale-poll-per-connection] connection ${parsed.connectionId} (band ${connection.band_id}) is inactive — skipping`,
      );
      return { skipped: "connection_inactive", salesDetected: 0, errors: 0 };
    }

    if (connection.workspace_id !== parsed.workspaceId) {
      // Defense-in-depth: the router computed workspaceId from the
      // matched connection row, so a mismatch here means someone
      // hand-fired the task with crossed wires. Fail loud rather than
      // silently poll the wrong workspace's data.
      const msg = `[bandcamp-sale-poll-per-connection] workspaceId mismatch payload=${parsed.workspaceId} db=${connection.workspace_id} connection=${parsed.connectionId}`;
      Sentry.captureMessage(msg, {
        level: "error",
        tags: { task: "bandcamp-sale-poll-per-connection", failure: "workspace_mismatch" },
      });
      throw new Error(msg);
    }

    const accessToken = await refreshBandcampToken(connection.workspace_id);

    const result = await pollOneBandcampConnection({
      supabase,
      workspaceId: connection.workspace_id,
      connectionId: connection.id,
      bandId: connection.band_id,
      accessToken,
      runId: ctx.run.id,
    });

    await supabase.from("channel_sync_log").insert({
      workspace_id: connection.workspace_id,
      channel: "bandcamp",
      sync_type: "sale_poll",
      status: result.errors > 0 ? "partial" : "completed",
      items_processed: result.salesDetected,
      items_failed: result.errors,
      started_at: startedAt,
      completed_at: new Date().toISOString(),
      metadata: {
        connection_id: connection.id,
        band_id: connection.band_id,
        triggered_by: "resend-inbound-router",
        triggered_by_webhook_event_id: parsed.triggeredByWebhookEventId ?? null,
        recipient: parsed.recipient ?? null,
        run_id: ctx.run.id,
      },
    });

    return result;
  },
});
