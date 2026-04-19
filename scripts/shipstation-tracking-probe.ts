#!/usr/bin/env tsx
/**
 * Targeted ShipStation tracking probe — answers: can SS track real
 * EasyPost / Pirate Ship Asendia numbers we already have in the system?
 *
 * Strategy:
 *   1. Enumerate v2 carriers (separate list from v1 carriers) to find SS's
 *      tracking-side carrier codes.
 *   2. Pull recent Pirate Ship Asendia tracking numbers from
 *      warehouse_shipments.
 *   3. Try v1 GET /shipments?trackingNumber=X — does SS have any record?
 *   4. Try v2 GET /v2/tracking?carrier_code=X&tracking_number=Y with every
 *      plausible carrier code (asendia, asendia_intl, usa_export_pba,
 *      globalpost, dhl_global_mail, etc.) until we get a 200 or exhaust.
 *
 * Read-only. No writes. No markasshipped.
 */

import { config } from "dotenv";
import { resolve } from "node:path";
import { createClient } from "@supabase/supabase-js";

const ENV_FILES = [".env.local", ".env.development.local", ".env"];
for (const file of ENV_FILES) {
  config({ path: resolve(process.cwd(), file), override: false });
}

const SS_V1_BASE = "https://ssapi.shipstation.com";
const SS_V2_BASE = "https://api.shipstation.com";

const SHIPSTATION_API_KEY = process.env.SHIPSTATION_API_KEY ?? "";
const SHIPSTATION_API_SECRET = process.env.SHIPSTATION_API_SECRET ?? "";
const SHIPSTATION_V2_API_KEY = process.env.SHIPSTATION_V2_API_KEY ?? "";
const NEXT_PUBLIC_SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

function v1Auth(): string {
  return `Basic ${Buffer.from(`${SHIPSTATION_API_KEY}:${SHIPSTATION_API_SECRET}`).toString("base64")}`;
}

interface FetchResult {
  ok: boolean;
  status: number;
  body: unknown;
}

async function v1(path: string): Promise<FetchResult> {
  const res = await fetch(`${SS_V1_BASE}${path}`, {
    headers: { Authorization: v1Auth(), "Content-Type": "application/json" },
  });
  const text = await res.text().catch(() => "");
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {}
  return { ok: res.ok, status: res.status, body };
}

async function v2(path: string): Promise<FetchResult> {
  const res = await fetch(`${SS_V2_BASE}${path}`, {
    headers: { "api-key": SHIPSTATION_V2_API_KEY, "Content-Type": "application/json" },
  });
  const text = await res.text().catch(() => "");
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {}
  return { ok: res.ok, status: res.status, body };
}

interface ShipmentRow {
  id: string;
  tracking_number: string | null;
  carrier: string | null;
  service: string | null;
  ship_date: string | null;
  label_source: string | null;
  shipstation_shipment_id: string | null;
}

async function pullAsendia(limit = 5): Promise<ShipmentRow[]> {
  if (!NEXT_PUBLIC_SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return [];
  const supabase = createClient(NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });
  const { data, error } = await supabase
    .from("warehouse_shipments")
    .select("id, tracking_number, carrier, service, ship_date, label_source, shipstation_shipment_id")
    .or("carrier.ilike.%asendia%,service.ilike.%asendia%,tracking_number.ilike.AHOY%")
    .not("tracking_number", "is", null)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) {
    console.error(`supabase error: ${error.message}`);
    return [];
  }
  return (data ?? []) as ShipmentRow[];
}

async function pullDomestic(limit = 2): Promise<ShipmentRow[]> {
  if (!NEXT_PUBLIC_SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return [];
  const supabase = createClient(NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });
  const { data, error } = await supabase
    .from("warehouse_shipments")
    .select("id, tracking_number, carrier, service, ship_date, label_source, shipstation_shipment_id")
    .ilike("carrier", "%usps%")
    .not("tracking_number", "is", null)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) {
    console.error(`supabase error: ${error.message}`);
    return [];
  }
  return (data ?? []) as ShipmentRow[];
}

const ASENDIA_CARRIER_CODE_CANDIDATES = [
  "asendia",
  "asendia_intl",
  "asendia_usa",
  "asendia_international",
  "usa_export_pba",
  "usa_export",
  "usaexport",
  "usaexportpba",
  "globalpost",
  "globalpost_smart_saver",
  "dhl_global_mail",
  "stamps_com",
];

const USPS_CARRIER_CODE_CANDIDATES = ["stamps_com", "usps", "endicia"];

async function probeAllCarrierCodes(
  trackingNumber: string,
  candidates: string[],
): Promise<{ code: string; status: number; events?: number; latest?: string | null }[]> {
  const results: { code: string; status: number; events?: number; latest?: string | null }[] = [];
  for (const code of candidates) {
    const r = await v2(
      `/v2/tracking?carrier_code=${encodeURIComponent(code)}&tracking_number=${encodeURIComponent(trackingNumber)}`,
    );
    const body = r.body as {
      events?: Array<{ description?: string; occurred_at?: string }>;
      status_description?: string;
    };
    const events = body?.events?.length ?? 0;
    const latest = body?.events?.[body.events.length - 1]?.description ?? body?.status_description ?? null;
    results.push({ code, status: r.status, events: events > 0 ? events : undefined, latest });
    if (r.status === 200 && events > 0) break;
  }
  return results;
}

async function main(): Promise<void> {
  console.log(`# ShipStation tracking probe (real numbers from DB)`);
  console.log(``);
  console.log(`_Run at: ${new Date().toISOString()}_`);
  console.log(``);

  // Step 1: v2 carriers (separate from v1 carriers — tracking-capable list).
  console.log(`## Step 1 — v2 carriers list (tracking-capable)`);
  console.log(``);
  const v2Carriers = await v2("/v2/carriers");
  if (v2Carriers.ok) {
    const list = (v2Carriers.body as { carriers?: Array<{ carrier_id: string; carrier_code: string; friendly_name: string }> }).carriers ?? [];
    console.log(`Found ${list.length} v2 carriers:`);
    for (const c of list) {
      console.log(`- ${c.friendly_name} — code \`${c.carrier_code}\` — id \`${c.carrier_id}\``);
    }
    const asendiaIsh = list.filter((c) =>
      `${c.friendly_name} ${c.carrier_code}`.toLowerCase().match(/asendia|usa.?export|pba|globalpost/),
    );
    console.log(``);
    console.log(`**Asendia/GlobalPost-ish v2 carriers:** ${asendiaIsh.length}`);
    for (const a of asendiaIsh) console.log(`  - ${a.friendly_name} (\`${a.carrier_code}\`)`);
  } else {
    console.log(`> v2 /carriers failed: ${v2Carriers.status} ${JSON.stringify(v2Carriers.body).slice(0, 300)}`);
  }
  console.log(``);

  // Step 2: real Asendia tracking numbers
  const asendia = await pullAsendia(5);
  const domestic = await pullDomestic(2);
  console.log(`## Step 2 — real tracking numbers from warehouse_shipments`);
  console.log(``);
  console.log(`Asendia (${asendia.length}):`);
  for (const s of asendia) {
    console.log(
      `- \`${s.tracking_number}\` carrier=${s.carrier} service=${s.service} source=${s.label_source} ship_date=${s.ship_date}`,
    );
  }
  console.log(``);
  console.log(`Domestic USPS (${domestic.length}):`);
  for (const s of domestic) {
    console.log(
      `- \`${s.tracking_number}\` carrier=${s.carrier} service=${s.service} source=${s.label_source} ship_date=${s.ship_date}`,
    );
  }
  console.log(``);

  // Step 3: v1 /shipments lookup (does SS have any record at all?)
  console.log(`## Step 3 — v1 GET /shipments?trackingNumber=X (does SS have any record?)`);
  console.log(``);
  for (const s of [...asendia.slice(0, 2), ...domestic.slice(0, 1)]) {
    if (!s.tracking_number) continue;
    const r = await v1(`/shipments?trackingNumber=${encodeURIComponent(s.tracking_number)}`);
    const total = (r.body as { total?: number; shipments?: unknown[] })?.total ?? 0;
    const shipments = (r.body as { shipments?: Array<{ shipmentId: number; orderId: number; carrierCode: string; shipDate: string }> })?.shipments ?? [];
    console.log(`- \`${s.tracking_number}\`: HTTP ${r.status}, total=${total}, found ${shipments.length} matches`);
    for (const m of shipments.slice(0, 2)) {
      console.log(`    -> shipmentId=${m.shipmentId} orderId=${m.orderId} carrierCode=${m.carrierCode} shipDate=${m.shipDate}`);
    }
    if (r.status !== 200) {
      console.log(`    body: ${JSON.stringify(r.body).slice(0, 200)}`);
    }
  }
  console.log(``);

  // Step 4: v2 /v2/tracking with ALL plausible carrier codes
  console.log(`## Step 4 — v2 /v2/tracking with multiple carrier code candidates`);
  console.log(``);
  for (const s of asendia.slice(0, 2)) {
    if (!s.tracking_number) continue;
    console.log(`### Asendia \`${s.tracking_number}\``);
    const results = await probeAllCarrierCodes(s.tracking_number, ASENDIA_CARRIER_CODE_CANDIDATES);
    for (const r of results) {
      const marker = r.status === 200 && r.events ? "✓" : r.status === 200 ? "?" : "x";
      console.log(
        `  ${marker} \`${r.code}\` -> HTTP ${r.status}${r.events ? `, ${r.events} events` : ""}${r.latest ? `, "${r.latest}"` : ""}`,
      );
    }
    console.log(``);
  }
  for (const s of domestic.slice(0, 1)) {
    if (!s.tracking_number) continue;
    console.log(`### Domestic USPS \`${s.tracking_number}\``);
    const results = await probeAllCarrierCodes(s.tracking_number, USPS_CARRIER_CODE_CANDIDATES);
    for (const r of results) {
      const marker = r.status === 200 && r.events ? "✓" : r.status === 200 ? "?" : "x";
      console.log(
        `  ${marker} \`${r.code}\` -> HTTP ${r.status}${r.events ? `, ${r.events} events` : ""}${r.latest ? `, "${r.latest}"` : ""}`,
      );
    }
    console.log(``);
  }

  console.log(`## Conclusion`);
  console.log(``);
  console.log(`If any v2 probe returned events, SS can track that carrier directly without import.`);
  console.log(`If all probes returned 404 / 0 events, SS only tracks shipments it has imported (via SS-issued labels or markasshipped).`);
  console.log(``);
  console.log(`_End of probe._`);
}

main().catch((e) => {
  console.error(`FATAL: ${(e as Error).message}`);
  process.exit(1);
});
