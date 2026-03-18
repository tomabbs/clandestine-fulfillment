import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

async function test() {
  const { data: creds } = await supabase
    .from("bandcamp_credentials")
    .select("access_token")
    .limit(1)
    .single();
  if (!creds?.access_token) { console.log("No token"); return; }

  const bandId = 1430196613;
  const token = creds.access_token;

  // Try sales API paths
  const endpoints = [
    { path: "/api/sales/2/get_merch_details", body: { band_id: bandId } },
    { path: "/api/sales/1/get_merch_details", body: { band_id: bandId } },
    { path: "/api/sales/3/get_merch_details", body: { band_id: bandId } },
    { path: "/api/sales/2/merch_details", body: { band_id: bandId } },
    // Try band API
    { path: "/api/band/3/search", body: { band_id: bandId } },
    // Try the items endpoint
    { path: "/api/merch/1/get_items", body: { band_id: bandId } },
    { path: "/api/merch/2/get_items", body: { band_id: bandId } },
    // Original style but on sales
    { path: "/api/sales/2/merch_details", body: { band_id: bandId, member_band_id: bandId } },
  ];

  for (const ep of endpoints) {
    const url = `https://bandcamp.com${ep.path}`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(ep.body),
    });
    const text = await res.text();
    let summary = "";
    try {
      const json = JSON.parse(text);
      if (json.error) summary = `ERROR: ${json.error_message}`;
      else if (json.items) summary = `OK: ${json.items.length} items`;
      else summary = `keys: ${Object.keys(json).join(",")} | ${text.slice(0, 150)}`;
    } catch {
      summary = text.slice(0, 150);
    }
    console.log(`${ep.path} → HTTP ${res.status}: ${summary}`);
  }
}

test().catch(console.error);
