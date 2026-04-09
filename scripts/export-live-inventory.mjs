/**
 * Export LIVE inventory from Bandcamp Merch API.
 * Pulls directly from the API (not the database) for each member band.
 * Usage: node scripts/export-live-inventory.mjs
 */
import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import XLSX from "xlsx";

config({ path: ".env.local" });
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const BC_CLIENT_ID = process.env.BANDCAMP_CLIENT_ID;
const BC_CLIENT_SECRET = process.env.BANDCAMP_CLIENT_SECRET;

let accessToken = null;
let tokenExpiresAt = 0;

async function ensureToken() {
  if (accessToken && Date.now() < tokenExpiresAt - 60000) return accessToken;
  const { data: creds } = await sb.from("bandcamp_credentials").select("id, access_token, token_expires_at, refresh_token").limit(1).single();
  if (creds?.access_token && new Date(creds.token_expires_at).getTime() > Date.now() + 60000) {
    accessToken = creds.access_token;
    tokenExpiresAt = new Date(creds.token_expires_at).getTime();
    return accessToken;
  }
  const res = await fetch("https://bandcamp.com/oauth_token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", client_id: BC_CLIENT_ID, client_secret: BC_CLIENT_SECRET, refresh_token: creds.refresh_token }),
  });
  const parsed = await res.json();
  accessToken = parsed.access_token;
  tokenExpiresAt = Date.now() + parsed.expires_in * 1000;
  await sb.from("bandcamp_credentials").update({ access_token: parsed.access_token, refresh_token: parsed.refresh_token, token_expires_at: new Date(tokenExpiresAt).toISOString(), updated_at: new Date().toISOString() }).eq("id", creds.id);
  return accessToken;
}

const DELAY = 3000;

async function main() {
  const { data: conns } = await sb.from("bandcamp_connections").select("id, band_id, band_name").eq("is_active", true).order("band_name");

  console.log("Step 1: Get member bands via Account API...\n");
  const token = await ensureToken();
  const myBandsRes = await fetch("https://bandcamp.com/api/account/1/my_bands", {
    method: "POST",
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    body: "{}",
  });
  const myBandsData = await myBandsRes.json();
  const allBands = myBandsData.bands ?? [];
  console.log("Total bands/labels in account:", allBands.length);

  const membersByLabel = new Map();
  for (const b of allBands) {
    if (b.member_bands?.length) {
      membersByLabel.set(b.band_id, b.member_bands);
      console.log("  " + (b.name ?? b.band_id).toString().padEnd(28) + b.member_bands.length + " member bands");
    }
  }

  console.log("\nStep 2: Pull merch for each member band...\n");
  const allItems = [];
  let totalApiCalls = 0;

  for (const conn of conns) {
    const members = membersByLabel.get(conn.band_id) ?? [];

    if (members.length === 0) {
      const t = await ensureToken();
      const res = await fetch("https://bandcamp.com/api/merchorders/1/get_merch_details", {
        method: "POST",
        headers: { Authorization: "Bearer " + t, "Content-Type": "application/json" },
        body: JSON.stringify({ band_id: conn.band_id, start_time: "2000-01-01 00:00:00" }),
      });
      totalApiCalls++;
      if (res.ok) {
        const data = await res.json();
        const items = data.items ?? [];
        console.log("  " + conn.band_name.padEnd(28) + items.length + " items (direct)");
        for (const item of items) pushItem(allItems, conn.band_name, item.subdomain, item);
      }
      await new Promise(r => setTimeout(r, DELAY));
      continue;
    }

    let connTotal = 0;
    for (const member of members) {
      const t = await ensureToken();
      const res = await fetch("https://bandcamp.com/api/merchorders/1/get_merch_details", {
        method: "POST",
        headers: { Authorization: "Bearer " + t, "Content-Type": "application/json" },
        body: JSON.stringify({ band_id: conn.band_id, member_band_id: member.band_id, start_time: "2000-01-01 00:00:00" }),
      });
      totalApiCalls++;
      if (!res.ok) { await new Promise(r => setTimeout(r, DELAY)); continue; }
      const data = await res.json();
      const items = data.items ?? [];
      connTotal += items.length;
      for (const item of items) pushItem(allItems, conn.band_name, member.subdomain ?? item.subdomain, item);
      await new Promise(r => setTimeout(r, DELAY));
    }
    console.log("  " + conn.band_name.padEnd(28) + connTotal + " items (" + members.length + " artists)");
  }

  console.log("\nTotal rows:", allItems.length, "| API calls:", totalApiCalls);

  allItems.sort((a, b) => {
    const c1 = a["Account"].localeCompare(b["Account"]);
    if (c1) return c1;
    return (a["Product Title"] || "").localeCompare(b["Product Title"] || "");
  });

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(allItems);
  ws["!cols"] = [
    { wch: 24 }, { wch: 22 }, { wch: 30 }, { wch: 35 }, { wch: 20 },
    { wch: 18 }, { wch: 18 }, { wch: 15 }, { wch: 8 }, { wch: 6 },
    { wch: 16 }, { wch: 12 }, { wch: 20 }, { wch: 40 }, { wch: 14 },
  ];
  XLSX.utils.book_append_sheet(wb, ws, "Live Bandcamp Inventory");

  const outPath = process.env.HOME + "/Downloads/bandcamp-live-inventory-" + new Date().toISOString().slice(0, 10) + ".xlsx";
  XLSX.writeFile(wb, outPath);
  console.log("Wrote to", outPath);
}

function pushItem(allItems, account, artist, item) {
  const options = item.options ?? [];
  if (options.length > 0) {
    for (const opt of options) {
      allItems.push({
        "Account": account,
        "Artist": artist ?? "",
        "Album": item.album_title ?? "",
        "Product Title": item.title ?? "",
        "Option/Variant": opt.title ?? "",
        "SKU (Item)": item.sku ?? "",
        "SKU (Option)": opt.sku ?? "",
        "Catalog Number": item.catalog_number ?? "",
        "Price": item.price ?? "",
        "Currency": item.currency ?? "",
        "Qty Available (LIVE)": opt.quantity_available ?? "",
        "Qty Sold (LIVE)": opt.quantity_sold ?? "",
        "Release Date": item.new_date ?? "",
        "Image URL": item.image_url ?? "",
        "Package ID": item.package_id ?? "",
      });
    }
  } else {
    allItems.push({
      "Account": account,
      "Artist": artist ?? "",
      "Album": item.album_title ?? "",
      "Product Title": item.title ?? "",
      "Option/Variant": "",
      "SKU (Item)": item.sku ?? "",
      "SKU (Option)": "",
      "Catalog Number": item.catalog_number ?? "",
      "Price": item.price ?? "",
      "Currency": item.currency ?? "",
      "Qty Available (LIVE)": item.quantity_available ?? "",
      "Qty Sold (LIVE)": item.quantity_sold ?? "",
      "Release Date": item.new_date ?? "",
      "Image URL": item.image_url ?? "",
      "Package ID": item.package_id ?? "",
    });
  }
}

main().catch(e => { console.error(e); process.exit(1); });
