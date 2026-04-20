// One-shot operator helper — invoke seedCarrierMapFromShipStation directly.
// Reads SHIPSTATION_API_KEY + Supabase service role from .env.production.
// All inserted rows land with block_auto_writeback=true and
// mapping_confidence='inferred' — operator must still "Verify + allow" each
// row at /admin/settings/carrier-map after a real round-trip.

import { createClient } from "@supabase/supabase-js";
import "dotenv/config";
import { seedCarrierMapFromShipStation } from "../src/lib/server/carrier-map";

async function main() {
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );
  const { data: ws } = await supabase.from("workspaces").select("id, name").limit(1).maybeSingle();
  if (!ws) throw new Error("no workspace");
  console.log(`Seeding shipstation_carrier_map for workspace ${ws.name} (${ws.id})...`);
  const r = await seedCarrierMapFromShipStation(supabase, { workspaceId: ws.id as string });
  console.log(`DONE — inserted=${r.inserted}, alreadyPresent=${r.alreadyPresent}, total_ss_carriers=${r.total_ss_carriers}`);
  console.log(
    "All inserted rows have block_auto_writeback=true. Verify + allow each at /admin/settings/carrier-map.",
  );
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
