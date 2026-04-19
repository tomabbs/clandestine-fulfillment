#!/usr/bin/env tsx
/**
 * Phase 4.0.A — SS v2 Fulfillments capability probe.
 *
 * Verifies that POST /v2/fulfillments works as documented before Phase 4.1
 * client work begins. The plan originally assumed v1 markasshipped was the
 * only writeback path; v2 fulfillments materially reduces R16 (v1 deprecation)
 * exposure if it works for both notify_customer and notify_order_source.
 *
 * Usage:
 *   READ-ONLY (default):
 *     pnpm tsx scripts/shipstation-v2-fulfillments-probe.ts
 *     - Lists v2 shape availability + sample shipment IDs.
 *
 *   LIVE WRITE (requires explicit confirm + a real shipment_id + tracking_number):
 *     pnpm tsx scripts/shipstation-v2-fulfillments-probe.ts \
 *       --shipment-id=se_xxxxx \
 *       --tracking=9405511899560000000000 \
 *       --carrier=stamps_com \
 *       --confirm
 *
 * The --confirm flag prevents accidental fulfillments. Without it, the probe
 * stops after building the request body and prints what it WOULD send.
 *
 * Exit codes:
 *   0 — probe completed (read-only or live-write succeeded)
 *   1 — fatal error (env missing, network down, etc.)
 *   2 — live write returned partial success or has_errors=true (operator should investigate)
 *
 * After running with --confirm:
 *   - Inspect SS dashboard within 60s for the order to flip to Shipped.
 *   - Confirm customer email arrives.
 *   - For BC orders: confirm BC ship_date populates within 5 minutes (Phase 4.0.B).
 *
 * Outcome documentation: docs/SHIPSTATION_UNIFIED_SHIPPING.md
 *   (record decision tree result: v2 PRIMARY, v1 PRIMARY, or split_by_channel).
 */

import { config } from "dotenv";
import { resolve } from "node:path";

const ENV_FILES = [".env.local", ".env.development.local", ".env"];
for (const file of ENV_FILES) {
  config({ path: resolve(process.cwd(), file), override: false });
}

const SS_V2_BASE = "https://api.shipstation.com";
const SS_V1_BASE = "https://ssapi.shipstation.com";
const SHIPSTATION_API_KEY = process.env.SHIPSTATION_API_KEY ?? "";
const SHIPSTATION_API_SECRET = process.env.SHIPSTATION_API_SECRET ?? "";
const SHIPSTATION_V2_API_KEY = process.env.SHIPSTATION_V2_API_KEY ?? "";

if (!SHIPSTATION_V2_API_KEY) {
  console.error("Missing SHIPSTATION_V2_API_KEY in .env.local");
  process.exit(1);
}

function arg(name: string): string | undefined {
  return process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
}
const flag = (name: string): boolean => process.argv.includes(`--${name}`);

const shipmentId = arg("shipment-id");
const trackingNumber = arg("tracking");
const carrierCode = arg("carrier");
const isLive = flag("confirm");

async function v2(path: string, init?: RequestInit): Promise<{ status: number; body: string }> {
  const r = await fetch(`${SS_V2_BASE}${path}`, {
    ...init,
    headers: {
      "api-key": SHIPSTATION_V2_API_KEY,
      "Content-Type": "application/json",
      ...init?.headers,
    },
  });
  return { status: r.status, body: await r.text().catch(() => "") };
}

async function v1<T>(path: string): Promise<T> {
  const auth = `Basic ${Buffer.from(`${SHIPSTATION_API_KEY}:${SHIPSTATION_API_SECRET}`).toString("base64")}`;
  const r = await fetch(`${SS_V1_BASE}${path}`, {
    headers: { Authorization: auth, "Content-Type": "application/json" },
  });
  if (!r.ok) throw new Error(`v1 ${path}: ${r.status} ${(await r.text()).slice(0, 300)}`);
  return r.json() as Promise<T>;
}

async function main(): Promise<number> {
console.log("# ShipStation v2 Fulfillments capability probe — Phase 4.0.A\n");

// ── Step 1: Read-only sample of recent v2 shipments to confirm we have IDs ──
console.log("## Step 1 — sampling recent v2 shipments\n");
const list = await v2("/v2/shipments?page_size=5&sort_by=created_at&sort_dir=desc");
console.log(`HTTP ${list.status}`);
if (list.status === 200) {
  try {
    const j = JSON.parse(list.body);
    const ids = (j.shipments ?? []).map((s: { shipment_id: string }) => s.shipment_id);
    console.log(`  recent shipment_ids: ${ids.join(", ") || "(none)"}\n`);
  } catch {
    console.log("  (response was not JSON)\n");
  }
} else {
  console.log(`  body: ${list.body.slice(0, 300)}\n`);
}

// ── Step 2: BC stores so we can identify a BC-connected shipment for 4.0.B ──
console.log("## Step 2 — BC stores from v1 /stores (operator hint for 4.0.B test order)\n");
try {
  const stores = await v1<Array<{ storeId: number; storeName: string; marketplaceName: string; active?: boolean }>>(
    "/stores",
  );
  const bc = stores.filter((s) => s.marketplaceName?.toLowerCase().includes("bandcamp"));
  console.log(`  ${bc.length} Bandcamp store(s) connected:`);
  for (const s of bc) console.log(`    - ${s.storeId}: ${s.storeName} (active=${s.active ?? "?"})`);
  console.log("");
} catch (err) {
  console.log(`  v1 /stores failed: ${err instanceof Error ? err.message : err}\n`);
}

// ── Step 3: Build the fulfillments request body ──────────────────────────────
if (!shipmentId || !trackingNumber || !carrierCode) {
  console.log("## Step 3 — request preview (no --shipment-id / --tracking / --carrier supplied)\n");
  console.log(
    "Re-run with all three to preview the request body. Add --confirm to actually call POST /v2/fulfillments.\n",
  );
  console.log("Example:");
  console.log(
    `  pnpm tsx scripts/shipstation-v2-fulfillments-probe.ts \\\n    --shipment-id=se_xxxxx \\\n    --tracking=9405511899560000000000 \\\n    --carrier=stamps_com \\\n    --confirm\n`,
  );
  return 0;
}

const body = {
  fulfillments: [
    {
      shipment_id: shipmentId,
      tracking_number: trackingNumber,
      carrier_code: carrierCode,
      ship_date: new Date().toISOString().slice(0, 10),
      notify_customer: true,
      notify_order_source: true,
    },
  ],
};

console.log("## Step 3 — request body that WILL be POSTed\n");
console.log("```json");
console.log(JSON.stringify(body, null, 2));
console.log("```\n");

if (!isLive) {
  console.log("Add --confirm to actually call POST /v2/fulfillments. Aborting (dry-preview only).\n");
  return 0;
}

// ── Step 4: Live POST ────────────────────────────────────────────────────────
console.log("## Step 4 — POST /v2/fulfillments (LIVE)\n");
const r = await v2("/v2/fulfillments", {
  method: "POST",
  body: JSON.stringify(body),
});
console.log(`HTTP ${r.status}`);
console.log("```json");
console.log(r.body);
console.log("```\n");

// ── Step 5: Decision tree ────────────────────────────────────────────────────
console.log("## Step 5 — decision tree\n");
let parsed: { has_errors?: boolean; fulfillments?: Array<{ error_message?: string | null }> } | null = null;
try {
  parsed = JSON.parse(r.body);
} catch {
  // not JSON
}

const hadAnyError = parsed?.has_errors === true;
const perItemErrors = (parsed?.fulfillments ?? []).filter((f) => f.error_message);

if (r.status === 200 && !hadAnyError && perItemErrors.length === 0) {
  console.log("PASS: has_errors=false and no per-item error_message.");
  console.log("   Verify within 60 seconds: SS UI shows Shipped, customer email sent.");
  console.log("   For BC orders: confirm BC ship_date populates within 5 minutes (4.0.B).");
  console.log("   If all green -> DECISION: v2 fulfillments PRIMARY (Phase 4.3 step 1).\n");
  return 0;
}

if (r.status === 200 && (hadAnyError || perItemErrors.length > 0)) {
  console.log("PARTIAL: HTTP 200 but has_errors=true or per-item error_message present.");
  console.log(`   per-item errors: ${perItemErrors.length}`);
  for (const e of perItemErrors) console.log(`     - ${e.error_message}`);
  console.log("   DECISION: investigate before making v2 PRIMARY. Likely candidates:");
  console.log("     - carrier_code not connected for this account (re-check via /carriers)");
  console.log("     - shipment_id stale or already fulfilled");
  console.log("     - notify_order_source not supported for this store's marketplace\n");
  return 2;
}

console.log(`FAIL: HTTP ${r.status} — request did not succeed.`);
console.log("   DECISION: stay on v1 markasshipped (current Phase 4.3 fallback path).");
console.log("   Document the failure mode in docs/SHIPSTATION_UNIFIED_SHIPPING.md.\n");
return 2;
}

main().then((code) => process.exit(code)).catch((err) => {
  console.error(err);
  process.exit(1);
});
