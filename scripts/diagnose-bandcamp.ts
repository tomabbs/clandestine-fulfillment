import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

async function diagnose() {
  // 1. Check bandcamp_credentials
  const { data: creds } = await supabase
    .from("bandcamp_credentials")
    .select("workspace_id, client_id, access_token, refresh_token, token_expires_at, updated_at")
    .limit(1)
    .single();

  if (!creds) {
    console.log("No bandcamp credentials found!");
    return;
  }

  console.log("Bandcamp credentials:");
  console.log(`  client_id: ${creds.client_id?.slice(0, 10)}...`);
  console.log(`  access_token: ${creds.access_token ? `${creds.access_token.slice(0, 15)}... (${creds.access_token.length} chars)` : "NULL"}`);
  console.log(`  refresh_token: ${creds.refresh_token ? `${creds.refresh_token.slice(0, 15)}... (${creds.refresh_token.length} chars)` : "NULL"}`);
  console.log(`  token_expires_at: ${creds.token_expires_at}`);
  console.log(`  updated_at: ${creds.updated_at}`);

  const expired = creds.token_expires_at && new Date(creds.token_expires_at) < new Date();
  console.log(`  Token expired: ${expired ? "YES" : "no"}`);

  // 2. Test if current access_token works (if we have one)
  if (creds.access_token) {
    console.log("\nTesting access_token against Bandcamp API...");
    try {
      const res = await fetch("https://bandcamp.com/api/account/1/my_bands", {
        method: "GET",
        headers: { Authorization: `Bearer ${creds.access_token}` },
      });
      console.log(`  HTTP ${res.status} ${res.statusText}`);
      const text = await res.text();
      if (res.ok) {
        const json = JSON.parse(text);
        console.log(`  Response keys: ${Object.keys(json)}`);
        console.log(`  bands: ${Array.isArray(json.bands) ? `${json.bands.length} bands` : typeof json.bands}`);
      } else {
        console.log(`  Error body: ${text.slice(0, 300)}`);
      }
    } catch (err) {
      console.log(`  Fetch error: ${err}`);
    }
  }

  // 3. Check if token refresh would work
  if (creds.refresh_token) {
    console.log("\nTesting token refresh...");
    const BANDCAMP_CLIENT_ID = process.env.BANDCAMP_CLIENT_ID;
    const BANDCAMP_CLIENT_SECRET = process.env.BANDCAMP_CLIENT_SECRET;

    if (!BANDCAMP_CLIENT_ID || !BANDCAMP_CLIENT_SECRET) {
      console.log("  Missing BANDCAMP_CLIENT_ID or BANDCAMP_CLIENT_SECRET in env");
      return;
    }

    try {
      const res = await fetch("https://bandcamp.com/oauth_token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          client_id: BANDCAMP_CLIENT_ID,
          client_secret: BANDCAMP_CLIENT_SECRET,
          refresh_token: creds.refresh_token,
        }),
      });
      console.log(`  HTTP ${res.status} ${res.statusText}`);
      const text = await res.text();
      if (res.ok) {
        const json = JSON.parse(text);
        console.log(`  New access_token: ${json.access_token?.slice(0, 15)}...`);
        console.log(`  New refresh_token: ${json.refresh_token?.slice(0, 15)}...`);
        console.log(`  Expires in: ${json.expires_in}s`);

        // Save the new tokens
        const { error: updateErr } = await supabase
          .from("bandcamp_credentials")
          .update({
            access_token: json.access_token,
            refresh_token: json.refresh_token,
            token_expires_at: new Date(Date.now() + json.expires_in * 1000).toISOString(),
            updated_at: new Date().toISOString(),
          })
          .eq("workspace_id", creds.workspace_id);

        if (updateErr) {
          console.log(`  Failed to save: ${updateErr.message}`);
        } else {
          console.log("  Tokens saved to DB");
        }

        // Now test the NEW token
        console.log("\nTesting NEW access_token...");
        const bandsRes = await fetch("https://bandcamp.com/api/account/1/my_bands", {
          method: "GET",
          headers: { Authorization: `Bearer ${json.access_token}` },
        });
        console.log(`  HTTP ${bandsRes.status} ${bandsRes.statusText}`);
        if (bandsRes.ok) {
          const bandsJson = await bandsRes.json();
          console.log(`  bands: ${Array.isArray(bandsJson.bands) ? `${bandsJson.bands.length} bands found!` : "MISSING"}`);
          if (bandsJson.bands?.[0]) {
            console.log(`  First band: ${bandsJson.bands[0].name} (id: ${bandsJson.bands[0].band_id})`);
          }
        } else {
          console.log(`  Error: ${await bandsRes.text()}`);
        }
      } else {
        console.log(`  Refresh failed: ${text}`);
      }
    } catch (err) {
      console.log(`  Fetch error: ${err}`);
    }
  }

  // 4. Check review queue for bandcamp errors
  const { data: reviews } = await supabase
    .from("warehouse_review_queue")
    .select("title, description, category")
    .like("category", "bandcamp%")
    .order("created_at", { ascending: false })
    .limit(3);

  if (reviews?.length) {
    console.log("\nRecent Bandcamp review queue items:");
    for (const r of reviews) {
      console.log(`  [${r.category}] ${r.title}: ${r.description?.slice(0, 150)}`);
    }
  }
}

diagnose().catch(console.error);
