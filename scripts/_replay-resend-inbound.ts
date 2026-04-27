/**
 * Replay stuck Resend inbound webhook events through the (now-fixed) router.
 *
 * Use after deploying the resend-inbound route fix to rebuild the support
 * inbox from rows that the broken handler dropped on the floor.
 *
 * Picks up rows where:
 *   - platform = 'resend'
 *   - status IN ('received', 'enqueued', 'envelope_parse_failed', 'fetch_body_failed', 'routing_error')
 *
 * Skips rows already in a terminal state: 'processed', 'dismissed',
 * 'review_queued', 'duplicate', 'ignored_event_type', 'dormant_skipped'.
 *
 * Usage:
 *   npx tsx scripts/_replay-resend-inbound.ts                # dry run, last 30d
 *   npx tsx scripts/_replay-resend-inbound.ts --apply        # actually write
 *   npx tsx scripts/_replay-resend-inbound.ts --apply --since 2026-04-01
 *   npx tsx scripts/_replay-resend-inbound.ts --apply --limit 10
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { fetchInboundEmail, parseInboundWebhook } from "@/lib/clients/resend-client";
import { routeInboundEmail } from "@/lib/server/resend-inbound-router";
import { createServiceRoleClient } from "@/lib/server/supabase-server";

const TERMINAL_STATUSES = new Set([
  "processed",
  "dismissed",
  "review_queued",
  "duplicate",
  "ignored_event_type",
  "dormant_skipped",
]);

function parseArgs(): { apply: boolean; since: string; limit: number } {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const sinceIdx = args.indexOf("--since");
  const since =
    sinceIdx >= 0 && args[sinceIdx + 1]
      ? new Date(args[sinceIdx + 1]).toISOString()
      : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const limitIdx = args.indexOf("--limit");
  const limit =
    limitIdx >= 0 && args[limitIdx + 1] ? Number.parseInt(args[limitIdx + 1], 10) : 1000;
  return { apply, since, limit };
}

async function main() {
  const { apply, since, limit } = parseArgs();
  console.log(
    `replay-resend-inbound: mode=${apply ? "APPLY" : "DRY-RUN"} since=${since} limit=${limit}`,
  );

  const supabase = createServiceRoleClient();

  const { data: workspaceRow } = await supabase
    .from("workspaces")
    .select("id")
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  const workspaceId = workspaceRow?.id;
  if (!workspaceId) {
    console.error("FATAL: no workspace");
    process.exit(1);
  }
  console.log(`workspace: ${workspaceId}`);

  const { data: rows, error } = await supabase
    .from("webhook_events")
    .select("id, status, created_at, metadata")
    .eq("platform", "resend")
    .filter("metadata->>type", "eq", "email.received")
    .gte("created_at", since)
    .order("created_at", { ascending: true })
    .limit(limit);

  if (error) {
    console.error("query error:", error.message);
    process.exit(1);
  }

  const replayable = (rows ?? []).filter((r) => !TERMINAL_STATUSES.has(r.status ?? ""));
  console.log(
    `found ${rows?.length ?? 0} resend rows; ${replayable.length} non-terminal (replay candidates)`,
  );

  const stats = {
    scanned: replayable.length,
    skipped_not_received_event: 0,
    parse_failed: 0,
    fetch_failed: 0,
    routed: 0,
    by_status: new Map<string, number>(),
  };

  for (const row of replayable) {
    try {
      const envelope = parseInboundWebhook(row.metadata);
      if (envelope.type !== "email.received") {
        stats.skipped_not_received_event += 1;
        continue;
      }

      if (!apply) {
        // Dry-run: just verify we CAN parse and would dispatch.
        console.log(`  [dry] ${row.id}  type=${envelope.type}  email_id=${envelope.emailId}`);
        continue;
      }

      const email = await fetchInboundEmail(envelope.emailId);
      const result = await routeInboundEmail({
        supabase,
        workspaceId,
        webhookEventId: row.id,
        email,
      });
      stats.routed += 1;
      stats.by_status.set(result.status, (stats.by_status.get(result.status) ?? 0) + 1);
      console.log(`  [apply] ${row.id}  ${result.status}  realFrom=${email.realFrom}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("Failed to fetch inbound email")) {
        stats.fetch_failed += 1;
        console.log(`  [skip] ${row.id}  fetch failed: ${msg}`);
      } else {
        stats.parse_failed += 1;
        console.log(`  [skip] ${row.id}  parse/route failed: ${msg}`);
      }
    }
  }

  console.log("\n=== summary ===");
  console.log(`  scanned:               ${stats.scanned}`);
  console.log(`  skipped (not received):${stats.skipped_not_received_event}`);
  console.log(`  parse failed:          ${stats.parse_failed}`);
  console.log(`  fetch failed:          ${stats.fetch_failed}`);
  console.log(`  routed:                ${stats.routed}`);
  for (const [s, c] of stats.by_status) {
    console.log(`    ${s}: ${c}`);
  }

  if (!apply) {
    console.log("\n  DRY-RUN — re-run with --apply to actually replay.");
  }
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
