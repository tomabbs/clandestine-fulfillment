// Slice 3 — Backfill public-safe destination columns for existing shipments.
//
// Walks warehouse_shipments where destination_city IS NULL AND destination_state
// IS NULL AND destination_country IS NULL (all three NULL = not backfilled yet),
// reads the allowlisted city/state/country from label_data.shipment.to_address
// (EasyPost persistence shape) or falls back to the linked warehouse_orders
// shipping_address JSONB. NEVER copies street/street1/street2/zip/email/phone
// into the public columns — the chk_destination_city_no_street CHECK constraint
// on warehouse_shipments is a defense-in-depth guard.
//
// Usage:
//   pnpm tsx scripts/backfill-shipment-destinations.ts --dry-run
//   pnpm tsx scripts/backfill-shipment-destinations.ts            (live)
//   pnpm tsx scripts/backfill-shipment-destinations.ts --limit=500
//   pnpm tsx scripts/backfill-shipment-destinations.ts --workspace=<id>
//   pnpm tsx scripts/backfill-shipment-destinations.ts --batch-size=100
//
// Safe to re-run; safe to interrupt mid-run. Per-row UPDATE so a CHECK-violation
// on one row never poisons the whole batch.

import { createClient } from "@supabase/supabase-js";
import "dotenv/config";

interface Args {
  dryRun: boolean;
  limit: number;
  batchSize: number;
  workspaceId: string | null;
}

interface ToAddress {
  city?: string | null;
  state?: string | null;
  country?: string | null;
}

function parseArgs(): Args {
  const args = process.argv.slice(2);
  const out: Args = { dryRun: false, limit: 5000, batchSize: 100, workspaceId: null };
  for (const a of args) {
    if (a === "--dry-run") out.dryRun = true;
    else if (a.startsWith("--limit=")) out.limit = Number.parseInt(a.slice("--limit=".length), 10);
    else if (a.startsWith("--batch-size="))
      out.batchSize = Number.parseInt(a.slice("--batch-size=".length), 10);
    else if (a.startsWith("--workspace=")) out.workspaceId = a.slice("--workspace=".length);
  }
  return out;
}

function pickToAddressFromLabelData(labelData: unknown): ToAddress | null {
  if (!labelData || typeof labelData !== "object") return null;
  const ld = labelData as Record<string, unknown>;
  const shipment = ld.shipment as Record<string, unknown> | undefined;
  const toAddress = shipment?.to_address as Record<string, unknown> | undefined;
  if (!toAddress) return null;
  return {
    city: typeof toAddress.city === "string" ? toAddress.city : null,
    state: typeof toAddress.state === "string" ? toAddress.state : null,
    country: typeof toAddress.country === "string" ? toAddress.country : null,
  };
}

function pickToAddressFromShippingAddress(shippingAddress: unknown): ToAddress | null {
  if (!shippingAddress || typeof shippingAddress !== "object") return null;
  const sa = shippingAddress as Record<string, unknown>;
  const city = typeof sa.city === "string" ? sa.city : null;
  const state = (sa.state ?? sa.province ?? sa.region) as string | null;
  const country =
    (sa.country_code ?? sa.countryCode ?? sa.country) as string | null;
  if (!city && !state && !country) return null;
  return {
    city,
    state: typeof state === "string" ? state : null,
    country: typeof country === "string" ? country : null,
  };
}

// Defense-in-depth. The DB CHECK also enforces this, but we refuse to even
// attempt the UPDATE if the city value looks like a street ("123 Main" etc).
function cityLooksLikeStreet(city: string | null): boolean {
  if (!city) return false;
  return /^\d+\s+\w/.test(city);
}

async function main() {
  const args = parseArgs();
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error("FATAL: NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY missing");
    process.exit(1);
  }
  const supabase = createClient(url, key);

  console.log(
    `[backfill-shipment-destinations] limit=${args.limit} batchSize=${args.batchSize} dryRun=${args.dryRun}${
      args.workspaceId ? ` workspace=${args.workspaceId}` : ""
    }`,
  );

  let q = supabase
    .from("warehouse_shipments")
    .select("id, workspace_id, order_id, label_data")
    .is("destination_city", null)
    .is("destination_state", null)
    .is("destination_country", null)
    .order("created_at", { ascending: false })
    .limit(args.limit);
  if (args.workspaceId) q = q.eq("workspace_id", args.workspaceId);

  const { data: rows, error } = await q;
  if (error) {
    console.error("FATAL: select failed:", error.message);
    process.exit(1);
  }
  if (!rows || rows.length === 0) {
    console.log(
      "[backfill-shipment-destinations] nothing to backfill — every shipment has destination",
    );
    return;
  }
  console.log(`[backfill-shipment-destinations] ${rows.length} candidate rows`);

  const orderIds = Array.from(
    new Set(rows.map((r) => r.order_id).filter(Boolean)),
  ) as string[];
  const orderAddressMap = new Map<string, unknown>();
  if (orderIds.length > 0) {
    const { data: orders } = await supabase
      .from("warehouse_orders")
      .select("id, shipping_address")
      .in("id", orderIds);
    for (const o of orders ?? []) {
      if (o.shipping_address) orderAddressMap.set(o.id, o.shipping_address);
    }
  }

  let updated = 0;
  let skippedNoSource = 0;
  let failedCheck = 0;
  let failedDb = 0;

  for (let i = 0; i < rows.length; i += args.batchSize) {
    const slice = rows.slice(i, i + args.batchSize);
    for (const row of slice) {
      const fromLabel = pickToAddressFromLabelData(row.label_data);
      const fromOrder = row.order_id
        ? pickToAddressFromShippingAddress(orderAddressMap.get(row.order_id))
        : null;
      const picked: ToAddress | null = fromLabel ?? fromOrder;
      if (!picked || (!picked.city && !picked.state && !picked.country)) {
        skippedNoSource++;
        continue;
      }
      if (cityLooksLikeStreet(picked.city)) {
        failedCheck++;
        console.warn(
          `  ${row.id}: refused to stamp — city looks like street (${picked.city})`,
        );
        continue;
      }
      if (args.dryRun) {
        updated++;
        continue;
      }
      const { error: updErr } = await supabase
        .from("warehouse_shipments")
        .update({
          destination_city: picked.city ?? null,
          destination_state: picked.state ?? null,
          destination_country: picked.country ?? null,
        })
        .eq("id", row.id)
        .is("destination_city", null)
        .is("destination_state", null)
        .is("destination_country", null);
      if (updErr) {
        failedDb++;
        console.warn(`  ${row.id}: ${updErr.message}`);
      } else {
        updated++;
      }
    }
    if (i + args.batchSize < rows.length) {
      console.log(
        `[backfill-shipment-destinations] progress ${Math.min(i + args.batchSize, rows.length)}/${rows.length}`,
      );
    }
  }

  console.log(
    `[backfill-shipment-destinations] DONE — updated=${updated}, skippedNoSource=${skippedNoSource}, failedCheck=${failedCheck}, failedDb=${failedDb}, scanned=${rows.length}`,
  );

  if (args.dryRun) {
    console.log(
      "[backfill-shipment-destinations] dry-run: no writes performed. Re-run without --dry-run to apply.",
    );
    return;
  }

  const sampleCount = Math.min(50, updated);
  if (sampleCount === 0) return;
  const { data: sampleRows } = await supabase
    .from("warehouse_shipments")
    .select(
      "id, destination_city, destination_state, destination_country",
    )
    .not("destination_city", "is", null)
    .limit(sampleCount);
  console.log(
    `[backfill-shipment-destinations] sample audit — ${sampleRows?.length ?? 0} rows:`,
  );
  for (const r of sampleRows ?? []) {
    console.log(
      `  ${r.id}: ${r.destination_city ?? "—"}, ${r.destination_state ?? "—"}, ${r.destination_country ?? "—"}`,
    );
  }
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
