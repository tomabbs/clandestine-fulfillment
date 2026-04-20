import { createClient } from "@supabase/supabase-js";
import "dotenv/config";

async function main() {
  const s = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );
  console.log("\n=== Operator handoff verification (prod state, read-only) ===\n");

  // ── 1. Workspace flags ─────────────────────────────────────────────────
  const { data: ws } = await s.from("workspaces").select("id, name, flags");
  for (const w of ws ?? []) {
    const f = (w.flags ?? {}) as Record<string, unknown>;
    console.log(`Workspace: ${w.name} (${w.id})`);
    console.log(`  shipstation_unified_shipping: ${JSON.stringify(f.shipstation_unified_shipping ?? "unset")}`);
    console.log(`  email_send_strategy:           ${JSON.stringify(f.email_send_strategy ?? "unset (= 'off')")}`);
    console.log(`  shadow_recipients:             ${JSON.stringify(f.shadow_recipients ?? "unset")}`);
    console.log(`  easypost_buy_enabled:          ${JSON.stringify(f.easypost_buy_enabled ?? "unset (= true)")}`);
    console.log(`  shipstation_writeback_enabled: ${JSON.stringify(f.shipstation_writeback_enabled ?? "unset (= true)")}`);
    console.log(`  v1_features_enabled:           ${JSON.stringify(f.v1_features_enabled ?? "unset (= false)")}`);
    console.log(`  rate_delta_thresholds:         ${JSON.stringify(f.rate_delta_thresholds ?? "unset (defaults)")}`);
  }

  const wsId = ws?.[0]?.id as string;

  // ── 2. shipstation_carrier_map ─────────────────────────────────────────
  const { data: cmap } = await s
    .from("shipstation_carrier_map")
    .select(
      "easypost_carrier, easypost_service, shipstation_carrier_code, mapping_confidence, block_auto_writeback",
    );
  console.log(`\nshipstation_carrier_map: ${cmap?.length ?? 0} rows total`);
  if (cmap && cmap.length > 0) {
    const verified = cmap.filter(
      (r) => r.mapping_confidence === "verified" && !r.block_auto_writeback,
    );
    console.log(`  verified+unblocked:    ${verified.length}`);
    console.log(`  blocked auto-writeback: ${cmap.filter((r) => r.block_auto_writeback).length}`);
  } else {
    console.log("  ⚠ NO CARRIER MAP ROWS — would block all writeback after cutover");
  }

  // ── 3. v2 fulfillments probe ───────────────────────────────────────────
  const { count: v2Count } = await s
    .from("warehouse_shipments")
    .select("id", { count: "exact", head: true })
    .eq("shipstation_writeback_path", "v2_fulfillments")
    .not("shipstation_marked_shipped_at", "is", null);
  console.log(
    `\nv2 fulfillments writebacks ever stamped: ${v2Count ?? 0} ${
      (v2Count ?? 0) === 0 ? "⚠ probe never confirmed live" : "✓ at least one"
    }`,
  );

  // ── 4. SS writebacks ever ──────────────────────────────────────────────
  const { count: anyWriteback } = await s
    .from("warehouse_shipments")
    .select("id", { count: "exact", head: true })
    .not("shipstation_marked_shipped_at", "is", null);
  console.log(`SS writebacks ever stamped (any path): ${anyWriteback ?? 0}`);

  // ── 5. Resend webhook receipt evidence ─────────────────────────────────
  const since7dIso = new Date(Date.now() - 7 * 86400000).toISOString();
  const { data: resendSensors } = await s
    .from("sensor_readings")
    .select("sensor_name, status, created_at")
    .ilike("sensor_name", "%resend%")
    .gte("created_at", since7dIso)
    .order("created_at", { ascending: false })
    .limit(5);
  console.log(`\nresend.* sensor readings (last 7d): ${resendSensors?.length ?? 0}`);

  // ── 6. notification_sends rows EVER ────────────────────────────────────
  const { count: nsCount } = await s
    .from("notification_sends")
    .select("id", { count: "exact", head: true });
  const { data: nsByStatus } = await s
    .from("notification_sends")
    .select("status")
    .limit(5000);
  const statusCounts: Record<string, number> = {};
  for (const r of nsByStatus ?? []) {
    statusCounts[r.status as string] = (statusCounts[r.status as string] ?? 0) + 1;
  }
  console.log(
    `\nnotification_sends rows ever: ${nsCount ?? 0} ${
      (nsCount ?? 0) === 0
        ? "(strategy='off' — no sends fired yet, expected)"
        : `(${JSON.stringify(statusCounts)})`
    }`,
  );

  // ── 7. EP tracker registration evidence ────────────────────────────────
  const { count: epTrackerCount } = await s
    .from("warehouse_shipments")
    .select("id", { count: "exact", head: true })
    .not("label_data->>easypost_tracker_id", "is", null);
  console.log(`\nshipments with EP tracker registered: ${epTrackerCount ?? 0}`);

  // ── 8. AfterShip vs EP parity ──────────────────────────────────────────
  const { data: paritySensors } = await s
    .from("sensor_readings")
    .select("created_at, status, message")
    .eq("sensor_name", "tracker.parity_aftership_vs_easypost")
    .gte("created_at", since7dIso)
    .order("created_at", { ascending: false })
    .limit(5);
  console.log(`\ntracker.parity_aftership_vs_easypost (last 7d): ${paritySensors?.length ?? 0}`);
  for (const p of paritySensors ?? []) {
    console.log(`  ${p.created_at} [${p.status}]: ${(p.message as string).slice(0, 90)}`);
  }

  // ── 9. shipstation_orders backfill ─────────────────────────────────────
  const { count: ssOrders } = await s
    .from("shipstation_orders")
    .select("id", { count: "exact", head: true })
    .eq("workspace_id", wsId);
  console.log(`\nshipstation_orders rowcount: ${ssOrders ?? 0}`);

  // ── 10. shipstation-orders-poll cron alive ─────────────────────────────
  const { data: pollSensor } = await s
    .from("sensor_readings")
    .select("created_at, status")
    .eq("sensor_name", "trigger:shipstation-orders-poll")
    .gte("created_at", new Date(Date.now() - 60 * 60 * 1000).toISOString())
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  console.log(
    `shipstation-orders-poll cron in last hour: ${pollSensor ? `✓ ${pollSensor.created_at}` : "⚠ no reading (cron may be dead)"}`,
  );

  // ── 11. Sample organizations branding ──────────────────────────────────
  const { data: orgsWithBranding } = await s
    .from("organizations")
    .select("id, name, brand_color, logo_url, support_email")
    .or("brand_color.not.is.null,logo_url.not.is.null,support_email.not.is.null")
    .limit(10);
  console.log(`\norgs with ANY branding fields populated: ${orgsWithBranding?.length ?? 0}`);

  // ── 12. public_track_token coverage ────────────────────────────────────
  const { count: tokenized } = await s
    .from("warehouse_shipments")
    .select("id", { count: "exact", head: true })
    .not("public_track_token", "is", null);
  const { count: total } = await s
    .from("warehouse_shipments")
    .select("id", { count: "exact", head: true });
  console.log(
    `\npublic_track_token coverage: ${tokenized}/${total} shipments tokenized`,
  );

  console.log("\n=== END ===");
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
