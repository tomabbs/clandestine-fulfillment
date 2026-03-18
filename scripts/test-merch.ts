import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

async function test() {
  // Get access token
  const { data: creds } = await supabase
    .from("bandcamp_credentials")
    .select("access_token")
    .limit(1)
    .single();
  if (!creds?.access_token) { console.log("No token"); return; }

  // Get first few connections
  const { data: connections } = await supabase
    .from("bandcamp_connections")
    .select("band_id, band_name")
    .eq("is_active", true)
    .limit(3);

  console.log(`Testing ${connections?.length ?? 0} connections...\n`);

  for (const conn of connections ?? []) {
    console.log(`--- ${conn.band_name} (band_id: ${conn.band_id}) ---`);
    try {
      const res = await fetch("https://bandcamp.com/api/merch/1/merch_details", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${creds.access_token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ band_id: conn.band_id }),
      });

      const text = await res.text();
      console.log(`  HTTP ${res.status}`);

      try {
        const json = JSON.parse(text);
        if (json.error) {
          console.log(`  API error: ${json.error_message}`);
        } else if (json.items) {
          console.log(`  Success! ${json.items.length} merch items`);
          if (json.items[0]) {
            const first = json.items[0];
            console.log(`  First item: "${first.title}" SKU=${first.sku ?? "none"} qty_avail=${first.quantity_available}`);
          }
        } else {
          console.log(`  Unexpected response keys: ${Object.keys(json)}`);
          console.log(`  Body: ${text.slice(0, 200)}`);
        }
      } catch {
        console.log(`  Non-JSON response: ${text.slice(0, 200)}`);
      }
    } catch (err) {
      console.log(`  Fetch error: ${err}`);
    }
    console.log();
  }
}

test().catch(console.error);
