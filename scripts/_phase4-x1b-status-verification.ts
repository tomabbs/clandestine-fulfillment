/**
 * Phase 4 X-1.b extension — operational verification of the historical
 * burst audit. Did any of the high-burst windows we identified actually
 * produce `enqueue_failed` (HRD-17.1 graceful degradation) status rows?
 *
 * Cross-references:
 *   - reports/phase4-burst/historical-burst-{ts}.json (which produced the
 *     theoretical "30 events/sec single peak" finding) against
 *   - real `webhook_events.status` distribution per peak window
 *
 * If there are zero `enqueue_failed` rows in production over the 30-day
 * window, then despite 30+ rps peaks, Trigger.dev's rate-limiter never
 * actually fired against us — production bursts are too short / too
 * spread to consume the bucket. That changes the X-1.b urgency from
 * "URGENT" to "WATCHFUL" or even "GREEN".
 *
 * Also reports the full status code distribution so we can see the
 * health of the ingress pipeline at a glance.
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { createServiceRoleClient } from "@/lib/server/supabase-server";

interface CliArgs {
  days: number;
}

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = { days: 30 };
  for (const a of argv.slice(2)) {
    if (a.startsWith("--days=")) out.days = Math.max(1, Number.parseInt(a.slice("--days=".length), 10) || 30);
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv);
  const sb = createServiceRoleClient();
  const sinceIso = new Date(Date.now() - args.days * 86400_000).toISOString();

  console.log("Phase 4 X-1.b — operational verification (status distribution)");
  console.log("─".repeat(72));
  console.log(`  window_days   : ${args.days}`);
  console.log(`  since         : ${sinceIso}`);
  console.log("─".repeat(72));
  console.log();

  // Pull all status values in window. Filter probe traffic out client-side.
  let offset = 0;
  const PAGE = 1000;
  const statusCounts = new Map<string, number>();
  let totalReal = 0;
  let totalProbe = 0;

  while (true) {
    const { data, error } = await sb
      .from("webhook_events")
      .select("status, external_webhook_id, platform, created_at")
      .gte("created_at", sinceIso)
      .order("created_at", { ascending: true })
      .range(offset, offset + PAGE - 1);
    if (error) {
      console.error("Query failed:", error);
      process.exit(1);
    }
    if (!data || data.length === 0) break;
    for (const r of data as Array<{ status: string | null; external_webhook_id: string; platform: string; created_at: string }>) {
      if (r.external_webhook_id.startsWith("phase4-burst-") || r.external_webhook_id.startsWith("phase4-x1b-probe-")) {
        totalProbe++;
        continue;
      }
      totalReal++;
      const k = r.status ?? "(null)";
      statusCounts.set(k, (statusCounts.get(k) ?? 0) + 1);
    }
    if (data.length < PAGE) break;
    offset += PAGE;
  }

  console.log(`Total real production webhook_events rows : ${totalReal}`);
  console.log(`Excluded probe rows                       : ${totalProbe}`);
  console.log();
  console.log("Status distribution:");
  const sortedStatuses = [...statusCounts.entries()].sort((a, b) => b[1] - a[1]);
  for (const [status, count] of sortedStatuses) {
    const pct = ((count / totalReal) * 100).toFixed(2);
    console.log(`  ${status.padEnd(50)} ${String(count).padStart(8)}  (${pct}%)`);
  }
  console.log();

  // Crucial check: any enqueue_failed in real production traffic?
  const enqueueFailedReal = statusCounts.get("enqueue_failed") ?? 0;
  console.log("─".repeat(72));
  if (enqueueFailedReal === 0) {
    console.log("VERDICT: ZERO `enqueue_failed` rows in production over the window.");
    console.log("  Despite single-second peaks of 30 rps observed in the historical");
    console.log("  burst audit, Trigger.dev's rate-limiter never fired against us.");
    console.log("  This shifts X-1.b urgency: production bursts are too short / too");
    console.log("  spread to consume the bucket. Phase 4 enqueue mitigations remain");
    console.log("  WATCHFUL (defensive / future-scaling) rather than URGENT.");
  } else {
    const pctFailed = ((enqueueFailedReal / totalReal) * 100).toFixed(3);
    console.log(`VERDICT: ${enqueueFailedReal} \`enqueue_failed\` rows in production (${pctFailed}%).`);
    console.log("  Production has actually hit the Trigger.dev rate-limit at least");
    console.log(`  ${enqueueFailedReal} times in the last ${args.days} days. X-1.b is operationally`);
    console.log("  real. Phase 4 mitigations should be prioritized.");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
