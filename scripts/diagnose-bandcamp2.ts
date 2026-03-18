import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

async function diagnose() {
  const { data: creds } = await supabase
    .from("bandcamp_credentials")
    .select("access_token")
    .limit(1)
    .single();

  if (!creds?.access_token) { console.log("No token"); return; }

  // Show the full error response
  const res = await fetch("https://bandcamp.com/api/account/1/my_bands", {
    method: "GET",
    headers: { Authorization: `Bearer ${creds.access_token}` },
  });
  const body = await res.text();
  console.log("Full API response:");
  console.log(body);

  // Also try POST (some Bandcamp API endpoints require POST)
  console.log("\n--- Trying POST ---");
  const res2 = await fetch("https://bandcamp.com/api/account/1/my_bands", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${creds.access_token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({}),
  });
  const body2 = await res2.text();
  console.log(`POST HTTP ${res2.status}:`);
  console.log(body2);
}

diagnose().catch(console.error);
