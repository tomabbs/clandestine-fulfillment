/**
 * Phase 4 X-1.b extension — temporal distribution of parse_failed +
 * pending statuses surfaced by the operational verification.
 *
 * Question: are these statuses concentrated in a past window (already
 * fixed by a deploy) or ongoing (active operational debt)?
 *
 * Method: bucket statuses by day for the last 30 days.
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { createServiceRoleClient } from "@/lib/server/supabase-server";

async function main() {
  const days = 30;
  const sb = createServiceRoleClient();
  const sinceIso = new Date(Date.now() - days * 86400_000).toISOString();

  console.log("Status temporal distribution (parse_failed + pending focus)");
  console.log("─".repeat(72));

  let offset = 0;
  const PAGE = 1000;
  const dayStatusCounts = new Map<string, Map<string, number>>(); // day → status → count

  while (true) {
    const { data, error } = await sb
      .from("webhook_events")
      .select("status, external_webhook_id, created_at, platform, metadata")
      .gte("created_at", sinceIso)
      .order("created_at", { ascending: true })
      .range(offset, offset + PAGE - 1);
    if (error) {
      console.error("Query failed:", error);
      process.exit(1);
    }
    if (!data || data.length === 0) break;
    for (const r of data as Array<{ status: string | null; external_webhook_id: string; created_at: string; platform: string; metadata: Record<string, unknown> | null }>) {
      if (r.external_webhook_id.startsWith("phase4-burst-") || r.external_webhook_id.startsWith("phase4-x1b-probe-")) continue;
      const day = r.created_at.slice(0, 10);
      const status = r.status ?? "(null)";
      let inner = dayStatusCounts.get(day);
      if (!inner) {
        inner = new Map();
        dayStatusCounts.set(day, inner);
      }
      inner.set(status, (inner.get(status) ?? 0) + 1);
    }
    if (data.length < PAGE) break;
    offset += PAGE;
  }

  // Print per-day matrix focused on parse_failed, pending, received, processed
  const keyStatuses = ["parse_failed", "pending", "received", "enqueued", "processed", "sku_not_found", "review_queued"];
  console.log(`Day         | ${keyStatuses.map((s) => s.slice(0, 10).padStart(10)).join(" | ")} | total`);
  console.log("─".repeat(120));
  const sortedDays = [...dayStatusCounts.keys()].sort();
  for (const day of sortedDays) {
    const inner = dayStatusCounts.get(day);
    if (!inner) continue;
    const total = [...inner.values()].reduce((a, b) => a + b, 0);
    const cells = keyStatuses.map((s) => String(inner.get(s) ?? 0).padStart(10)).join(" | ");
    console.log(`${day} | ${cells} | ${String(total).padStart(5)}`);
  }
  console.log();

  // Now sample a few `parse_failed` rows for diagnosis
  console.log("Sampling 5 most recent parse_failed rows for root-cause diagnosis…");
  const { data: pfSamples } = await sb
    .from("webhook_events")
    .select("id, created_at, platform, external_webhook_id, status, metadata")
    .eq("status", "parse_failed")
    .order("created_at", { ascending: false })
    .limit(5);
  for (const r of (pfSamples ?? []) as Array<{ id: string; created_at: string; platform: string; external_webhook_id: string; status: string; metadata: Record<string, unknown> | null }>) {
    const reason = r.metadata?.parse_error ?? r.metadata?.reason ?? r.metadata?.error ?? "(no error in metadata)";
    console.log(`  ${r.created_at}  ${r.platform.padEnd(12)} ${r.external_webhook_id.slice(0, 40).padEnd(40)} reason=${JSON.stringify(reason).slice(0, 80)}`);
  }
  console.log();

  // Sample 5 most recent `pending` rows
  console.log("Sampling 5 most recent pending rows…");
  const { data: pSamples } = await sb
    .from("webhook_events")
    .select("id, created_at, platform, external_webhook_id, status, metadata")
    .eq("status", "pending")
    .order("created_at", { ascending: false })
    .limit(5);
  for (const r of (pSamples ?? []) as Array<{ id: string; created_at: string; platform: string; external_webhook_id: string; status: string; metadata: Record<string, unknown> | null }>) {
    const ageMs = Date.now() - new Date(r.created_at).getTime();
    const ageHours = (ageMs / 3600_000).toFixed(2);
    console.log(`  ${r.created_at}  ${r.platform.padEnd(12)} ${r.external_webhook_id.slice(0, 40).padEnd(40)} age_hours=${ageHours}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
