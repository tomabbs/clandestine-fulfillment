import { config } from "dotenv";
config({ path: ".env.local" });
import { createServiceRoleClient } from "@/lib/server/supabase-server";

async function main() {
  const sb = createServiceRoleClient();
  const since30d = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const since7d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  console.log("=".repeat(70));
  console.log("SUPPORT EMAIL AUDIT");
  console.log("=".repeat(70));

  console.log("\n=== 1. webhook_events for platform=resend (last 30d) ===");
  const { data: rWh, error: rWhErr } = await sb
    .from("webhook_events")
    .select("id, external_webhook_id, topic, status, created_at, processed_at, metadata")
    .eq("platform", "resend")
    .gte("created_at", since30d)
    .order("created_at", { ascending: false })
    .limit(50);
  if (rWhErr) console.log("  query error:", rWhErr.message);
  console.log(`  total resend events in 30d: ${rWh?.length ?? 0}`);
  const byStatus = new Map<string, number>();
  for (const e of rWh ?? [])
    byStatus.set(e.status ?? "(null)", (byStatus.get(e.status ?? "(null)") ?? 0) + 1);
  for (const [s, c] of byStatus) console.log(`    status=${s}: ${c}`);
  console.log("\n  Most recent 10:");
  for (const e of (rWh ?? []).slice(0, 10)) {
    const meta = e.metadata as Record<string, unknown> | null;
    const type = meta?.type ?? "(no type)";
    console.log(`    ${e.created_at?.slice(0, 19)}  ${type}  status=${e.status}`);
  }

  console.log("\n=== 2. support_email_mappings (all rows) ===");
  const { data: mappings, error: mErr } = await sb
    .from("support_email_mappings")
    .select("id, workspace_id, org_id, email_address, is_active, created_at")
    .order("created_at", { ascending: true });
  if (mErr) console.log("  query error:", mErr.message);
  console.log(`  total mappings: ${mappings?.length ?? 0}`);
  const activeCount = (mappings ?? []).filter((m) => m.is_active).length;
  console.log(`  active mappings: ${activeCount}`);
  for (const m of mappings ?? []) {
    console.log(
      `    ${m.email_address}  org=${m.org_id?.slice(0, 8)}  active=${m.is_active}  created=${m.created_at?.slice(0, 10)}`,
    );
  }

  console.log("\n=== 3. support_conversations (all-time totals) ===");
  const { count: convoCount } = await sb
    .from("support_conversations")
    .select("*", { count: "exact", head: true });
  console.log(`  total conversations: ${convoCount ?? 0}`);
  const { data: recentConvos } = await sb
    .from("support_conversations")
    .select("id, subject, status, org_id, inbound_email_id, created_at")
    .order("created_at", { ascending: false })
    .limit(10);
  console.log("\n  Most recent 10:");
  for (const c of recentConvos ?? []) {
    const inboundFlag = c.inbound_email_id ? "(EMAIL)" : "(APP)";
    console.log(
      `    ${c.created_at?.slice(0, 19)}  ${inboundFlag}  status=${c.status}  ${(c.subject ?? "").slice(0, 60)}`,
    );
  }

  console.log("\n=== 4. support_messages (all-time totals + by source) ===");
  const { count: msgCount } = await sb
    .from("support_messages")
    .select("*", { count: "exact", head: true });
  console.log(`  total messages: ${msgCount ?? 0}`);
  const { data: bySource } = await sb
    .from("support_messages")
    .select("source")
    .gte("created_at", since30d);
  const sourceMap = new Map<string, number>();
  for (const m of bySource ?? [])
    sourceMap.set(
      (m.source as string) ?? "(null)",
      (sourceMap.get((m.source as string) ?? "(null)") ?? 0) + 1,
    );
  console.log("  last 30d by source:");
  for (const [s, c] of sourceMap) console.log(`    source=${s}: ${c}`);

  console.log("\n=== 5. notification_sends — outbound support emails (last 7d) ===");
  const { data: sends, count: sendCount } = await sb
    .from("notification_sends")
    .select("status, recipient, created_at, error_detail", { count: "exact" })
    .gte("created_at", since7d)
    .order("created_at", { ascending: false })
    .limit(20);
  console.log(`  total sends in 7d: ${sendCount ?? 0}`);
  const sendStatusMap = new Map<string, number>();
  for (const s of sends ?? [])
    sendStatusMap.set(
      (s.status as string) ?? "(null)",
      (sendStatusMap.get((s.status as string) ?? "(null)") ?? 0) + 1,
    );
  for (const [st, c] of sendStatusMap) console.log(`    status=${st}: ${c}`);

  console.log("\n=== 6. resend_suppressions ===");
  const { count: supCount } = await sb
    .from("resend_suppressions")
    .select("*", { count: "exact", head: true });
  console.log(`  total suppressions: ${supCount ?? 0}`);
  const { data: recentSup } = await sb
    .from("resend_suppressions")
    .select("recipient, suppression_type, reason, created_at")
    .order("created_at", { ascending: false })
    .limit(5);
  for (const s of recentSup ?? []) {
    console.log(
      `    ${s.created_at?.slice(0, 19)}  ${s.suppression_type}  ${s.recipient}  reason=${(s.reason ?? "").slice(0, 50)}`,
    );
  }

  console.log("\n=== 7. webhook_events for platform=resend with status=dismissed ===");
  const { count: dismissedCount } = await sb
    .from("webhook_events")
    .select("*", { count: "exact", head: true })
    .eq("platform", "resend")
    .eq("status", "dismissed");
  console.log(`  total dismissed: ${dismissedCount ?? 0}`);

  console.log("\n=== 8. warehouse_review_queue items from support_email source ===");
  const { count: reviewCount } = await sb
    .from("warehouse_review_queue")
    .select("*", { count: "exact", head: true })
    .eq("category", "support_email");
  console.log(`  total review queue items (support_email): ${reviewCount ?? 0}`);

  // Try alt category names
  for (const cat of ["support_email", "unmatched_email", "inbound_support"]) {
    const { count } = await sb
      .from("warehouse_review_queue")
      .select("*", { count: "exact", head: true })
      .eq("category", cat);
    if ((count ?? 0) > 0) console.log(`    category="${cat}": ${count}`);
  }

  console.log("\n=== 9. Total webhook_events by platform (last 30d) — sanity check ===");
  const { data: allWh } = await sb
    .from("webhook_events")
    .select("platform")
    .gte("created_at", since30d);
  const platMap = new Map<string, number>();
  for (const e of allWh ?? [])
    platMap.set(e.platform ?? "?", (platMap.get(e.platform ?? "?") ?? 0) + 1);
  for (const [p, c] of [...platMap.entries()].sort()) console.log(`    ${p}: ${c}`);

  console.log("\n" + "=".repeat(70));
  console.log("DONE");
  console.log("=".repeat(70));
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
