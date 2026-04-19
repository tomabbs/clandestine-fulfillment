#!/usr/bin/env tsx
/**
 * ShipStation pre-flight check for the unified shipping workflow plan.
 *
 * Read-only verifications (no markasshipped, no writes):
 *   1. List connected carriers (v1 GET /carriers) — seeds shipstation_carrier_map.
 *   2. List connected stores (v1 GET /stores) — confirms Bandcamp connector + counts.
 *   3. Sample Asendia tracking lookups (v2 GET /v2/tracking) — confirms SS can
 *      surface tracking events for EP-printed Asendia numbers.
 *
 * Outputs a markdown report to stdout. Exit code is always 0; failures are
 * surfaced inline so the operator can read them.
 *
 * Usage: pnpm tsx scripts/shipstation-precheck.ts
 *
 * Plan: docs/plans/unified_shipping_workflow_a8ac6c94.plan.md
 *   Phase 4.2 (carrier map), Phase 6.5 (BC verifier), Phase 10.1 (tracking).
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

async function v1<T>(path: string): Promise<T> {
  const res = await fetch(`${SS_V1_BASE}${path}`, {
    headers: { Authorization: v1Auth(), "Content-Type": "application/json" },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`v1 ${path} -> ${res.status}: ${body.slice(0, 300)}`);
  }
  return res.json() as Promise<T>;
}

async function v2<T>(path: string): Promise<T> {
  const res = await fetch(`${SS_V2_BASE}${path}`, {
    headers: { "api-key": SHIPSTATION_V2_API_KEY, "Content-Type": "application/json" },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`v2 ${path} -> ${res.status}: ${body.slice(0, 300)}`);
  }
  return res.json() as Promise<T>;
}

interface Carrier {
  name: string;
  code: string;
  accountNumber?: string | null;
  primary?: boolean;
  balance?: number | null;
  shippingProviderId?: number | null;
}

interface Store {
  storeId: number;
  storeName: string;
  marketplaceName: string;
  active: boolean;
  lastRefreshAttempt?: string | null;
  lastModified?: string | null;
}

interface RecentShipment {
  tracking_number: string | null;
  carrier: string | null;
  service: string | null;
  ship_date: string | null;
  shipstation_shipment_id: string | null;
}

async function checkCarriers(): Promise<Carrier[]> {
  return v1<Carrier[]>("/carriers");
}

async function checkStores(): Promise<Store[]> {
  return v1<Store[]>("/stores?showInactive=false");
}

async function pullRecentAsendiaTracking(limit = 3): Promise<RecentShipment[]> {
  if (!NEXT_PUBLIC_SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return [];
  }
  const supabase = createClient(NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });
  const { data, error } = await supabase
    .from("warehouse_shipments")
    .select("tracking_number, carrier, service, ship_date, shipstation_shipment_id")
    .or("carrier.ilike.%asendia%,carrier.ilike.%usaexport%,service.ilike.%asendia%")
    .not("tracking_number", "is", null)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) {
    console.error(`[asendia] supabase query error: ${error.message}`);
    return [];
  }
  return (data ?? []) as RecentShipment[];
}

async function pullRecentDomesticTracking(limit = 2): Promise<RecentShipment[]> {
  if (!NEXT_PUBLIC_SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return [];
  const supabase = createClient(NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });
  const { data, error } = await supabase
    .from("warehouse_shipments")
    .select("tracking_number, carrier, service, ship_date, shipstation_shipment_id")
    .ilike("carrier", "%usps%")
    .not("tracking_number", "is", null)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) {
    console.error(`[domestic] supabase query error: ${error.message}`);
    return [];
  }
  return (data ?? []) as RecentShipment[];
}

interface TrackingProbeResult {
  tracking_number: string;
  carrier_attempted: string;
  status: "found" | "not_found" | "error";
  events?: number;
  latest?: string | null;
  error?: string;
}

async function probeTracking(
  tracking: string,
  carrierCode: string,
): Promise<TrackingProbeResult> {
  try {
    const data = await v2<{
      status_code?: string;
      status_description?: string;
      events?: Array<{ description?: string; occurred_at?: string }>;
    }>(`/v2/tracking?carrier_code=${encodeURIComponent(carrierCode)}&tracking_number=${encodeURIComponent(tracking)}`);
    const events = data.events ?? [];
    return {
      tracking_number: tracking,
      carrier_attempted: carrierCode,
      status: events.length > 0 || data.status_code ? "found" : "not_found",
      events: events.length,
      latest: events[events.length - 1]?.description ?? data.status_description ?? null,
    };
  } catch (e) {
    return {
      tracking_number: tracking,
      carrier_attempted: carrierCode,
      status: "error",
      error: (e as Error).message,
    };
  }
}

function pickLikelyAsendiaCarrierCode(carriers: Carrier[]): string {
  const asendia = carriers.find(
    (c) =>
      c.code?.toLowerCase().includes("asendia") ||
      c.name?.toLowerCase().includes("asendia") ||
      c.code?.toLowerCase().includes("usa_export") ||
      c.name?.toLowerCase().includes("usa export"),
  );
  return asendia?.code ?? "asendia_intl";
}

function pickLikelyUspsCarrierCode(carriers: Carrier[]): string {
  const usps = carriers.find(
    (c) =>
      c.code?.toLowerCase() === "stamps_com" ||
      c.code?.toLowerCase() === "usps" ||
      c.name?.toLowerCase().includes("usps") ||
      c.name?.toLowerCase().includes("stamps"),
  );
  return usps?.code ?? "stamps_com";
}

function fmtCarrier(c: Carrier): string {
  return `- ${c.name} (\`${c.code}\`)${c.primary ? " **primary**" : ""}${
    c.balance != null ? ` — balance $${c.balance.toFixed(2)}` : ""
  }`;
}

function fmtStore(s: Store): string {
  const last = s.lastRefreshAttempt ? ` last sync: ${s.lastRefreshAttempt}` : "";
  return `- **${s.storeName}** (${s.marketplaceName}) — id ${s.storeId}${
    s.active ? "" : " *(inactive)*"
  }${last}`;
}

async function main(): Promise<void> {
  const startedAt = new Date().toISOString();
  console.log(`# ShipStation Pre-flight Check`);
  console.log(``);
  console.log(`_Run at: ${startedAt}_`);
  console.log(``);

  // ── Env presence ───────────────────────────────────────────────────────────
  const envOk = {
    v1: SHIPSTATION_API_KEY.length > 0 && SHIPSTATION_API_SECRET.length > 0,
    v2: SHIPSTATION_V2_API_KEY.length > 0,
    supabase: NEXT_PUBLIC_SUPABASE_URL.length > 0 && SUPABASE_SERVICE_ROLE_KEY.length > 0,
  };
  console.log(`## Env`);
  console.log(``);
  console.log(`- v1 creds present: ${envOk.v1 ? "YES" : "NO"}`);
  console.log(`- v2 key present: ${envOk.v2 ? "YES" : "NO"}`);
  console.log(`- supabase service-role for tracking-history sample: ${envOk.supabase ? "YES" : "NO"}`);
  console.log(``);

  if (!envOk.v1) {
    console.log(`> Cannot proceed: SHIPSTATION_API_KEY / SHIPSTATION_API_SECRET missing in env.`);
    return;
  }

  // ── 1. Carriers ────────────────────────────────────────────────────────────
  console.log(`## 1. Connected carriers (v1 GET /carriers)`);
  console.log(``);
  let carriers: Carrier[] = [];
  try {
    carriers = await checkCarriers();
    if (carriers.length === 0) {
      console.log(`> No carriers returned.`);
    } else {
      for (const c of carriers) console.log(fmtCarrier(c));
    }
    const asendiaConnected = carriers.some(
      (c) =>
        c.name?.toLowerCase().includes("asendia") ||
        c.code?.toLowerCase().includes("asendia") ||
        c.code?.toLowerCase().includes("usa_export"),
    );
    console.log(``);
    console.log(`**Asendia in SS carrier list:** ${asendiaConnected ? "YES" : "NO"}`);
    console.log(`(Note: even if NO, SS can usually still TRACK Asendia numbers via partnership — see §3.)`);
  } catch (e) {
    console.log(`> Failed: ${(e as Error).message}`);
  }
  console.log(``);

  // ── 2. Stores ──────────────────────────────────────────────────────────────
  console.log(`## 2. Connected stores (v1 GET /stores)`);
  console.log(``);
  let stores: Store[] = [];
  try {
    stores = await checkStores();
    if (stores.length === 0) {
      console.log(`> No active stores returned.`);
    } else {
      for (const s of stores) console.log(fmtStore(s));
    }
    const bandcampStores = stores.filter(
      (s) =>
        s.marketplaceName?.toLowerCase().includes("bandcamp") ||
        s.storeName?.toLowerCase().includes("bandcamp"),
    );
    console.log(``);
    console.log(`**Bandcamp stores connected:** ${bandcampStores.length}`);
    for (const bc of bandcampStores) {
      console.log(`  - ${bc.storeName} (id ${bc.storeId}) ${bc.active ? "active" : "inactive"}`);
    }
    if (bandcampStores.length === 0) {
      console.log(`> Bandcamp connector NOT configured. Phase 6.5 keeps bandcamp-mark-shipped as primary, not a verifier.`);
    }
  } catch (e) {
    console.log(`> Failed: ${(e as Error).message}`);
  }
  console.log(``);

  // ── 3. Tracking probes ─────────────────────────────────────────────────────
  console.log(`## 3. Tracking probes (v2 GET /v2/tracking)`);
  console.log(``);
  if (!envOk.v2) {
    console.log(`> Skipped: SHIPSTATION_V2_API_KEY not configured.`);
  } else if (!envOk.supabase) {
    console.log(`> Skipped: Supabase creds missing — cannot pull recent shipments to probe.`);
  } else {
    const asendiaCode = pickLikelyAsendiaCarrierCode(carriers);
    const uspsCode = pickLikelyUspsCarrierCode(carriers);
    console.log(`Probing with carrier codes: asendia=\`${asendiaCode}\`, usps=\`${uspsCode}\``);
    console.log(``);

    const asendia = await pullRecentAsendiaTracking(3);
    const domestic = await pullRecentDomesticTracking(2);

    console.log(`### Asendia / international samples (${asendia.length})`);
    if (asendia.length === 0) {
      console.log(`> No recent Asendia shipments in warehouse_shipments.`);
    } else {
      for (const s of asendia) {
        if (!s.tracking_number) continue;
        const r = await probeTracking(s.tracking_number, asendiaCode);
        console.log(
          `- \`${s.tracking_number}\` (carrier in DB: ${s.carrier ?? "?"}, service: ${s.service ?? "?"}) -> ` +
            `${r.status}${r.events != null ? `, ${r.events} events` : ""}${
              r.latest ? `, latest: "${r.latest}"` : ""
            }${r.error ? `, error: ${r.error}` : ""}`,
        );
      }
    }
    console.log(``);
    console.log(`### Domestic samples (${domestic.length})`);
    if (domestic.length === 0) {
      console.log(`> No recent USPS shipments in warehouse_shipments.`);
    } else {
      for (const s of domestic) {
        if (!s.tracking_number) continue;
        const r = await probeTracking(s.tracking_number, uspsCode);
        console.log(
          `- \`${s.tracking_number}\` (carrier in DB: ${s.carrier ?? "?"}, service: ${s.service ?? "?"}) -> ` +
            `${r.status}${r.events != null ? `, ${r.events} events` : ""}${
              r.latest ? `, latest: "${r.latest}"` : ""
            }${r.error ? `, error: ${r.error}` : ""}`,
        );
      }
    }
  }
  console.log(``);

  // ── Summary ────────────────────────────────────────────────────────────────
  console.log(`## Summary — plan implications`);
  console.log(``);
  const bandcampCount = stores.filter(
    (s) =>
      s.marketplaceName?.toLowerCase().includes("bandcamp") ||
      s.storeName?.toLowerCase().includes("bandcamp"),
  ).length;
  console.log(
    `- **Carrier code mapping (Phase 4.2):** ${carriers.length} carriers found. Use these as seed data for \`shipstation_carrier_map\`.`,
  );
  console.log(
    `- **Bandcamp connector (Phase 6.5):** ${
      bandcampCount > 0
        ? `${bandcampCount} BC store(s) connected. Demote bandcamp-mark-shipped to verifier (markasshipped + notifySalesChannel:true will push to BC).`
        : `Not configured. Keep bandcamp-mark-shipped as primary push until BC store is connected in SS.`
    }`,
  );
  console.log(`- **Tracking via SS (Phase 10):** see probe results above. If Asendia probes return events, AfterShip sunset is safe. If they return not_found / error, keep AfterShip for Asendia coverage.`);
  console.log(`- **markasshipped + email:** NOT tested (skipped per plan-mode policy). Run a separate test against a known order ID once we pick one.`);
  console.log(``);
  console.log(`_End of report._`);
}

main().catch((e) => {
  console.error(`FATAL: ${(e as Error).message}`);
  process.exit(1);
});
