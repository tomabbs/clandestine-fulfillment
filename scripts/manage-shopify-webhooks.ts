/**
 * Manage Shopify webhooks — list existing and register new ones.
 * Run: npx tsx scripts/manage-shopify-webhooks.ts
 */

import { config } from "dotenv";
config({ path: ".env.local" });

const RAW_STORE = process.env.SHOPIFY_STORE_URL ?? ""; // may include https://
const SHOPIFY_STORE = RAW_STORE.replace(/^https?:\/\//, "");
const SHOPIFY_TOKEN = process.env.SHOPIFY_ADMIN_API_TOKEN;
const API_VERSION = process.env.SHOPIFY_API_VERSION ?? "2026-01";
const BASE_URL = `https://${SHOPIFY_STORE}/admin/api/${API_VERSION}`;
const APP_DOMAIN = "https://cpanel.clandestinedistro.com";

async function shopifyFetch(path: string, init?: RequestInit) {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: {
      "X-Shopify-Access-Token": SHOPIFY_TOKEN!,
      "Content-Type": "application/json",
      ...init?.headers,
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Shopify ${res.status}: ${body}`);
  }
  return res.json();
}

async function listWebhooks() {
  const data = await shopifyFetch("/webhooks.json");
  const webhooks = data.webhooks ?? [];
  console.log(`Found ${webhooks.length} webhook(s):\n`);
  for (const wh of webhooks) {
    console.log(`  [${wh.id}] ${wh.topic} → ${wh.address}`);
    console.log(`    format=${wh.format}, created=${wh.created_at}\n`);
  }
  return webhooks;
}

async function createWebhook(topic: string, address: string) {
  console.log(`Creating: ${topic} → ${address}`);
  const data = await shopifyFetch("/webhooks.json", {
    method: "POST",
    body: JSON.stringify({ webhook: { topic, address, format: "json" } }),
  });
  if (data.webhook) {
    console.log(`  Created: id=${data.webhook.id}\n`);
  } else {
    console.log(`  Response: ${JSON.stringify(data)}\n`);
  }
  return data;
}

async function deleteWebhook(id: number) {
  console.log(`Deleting webhook ${id}...`);
  await shopifyFetch(`/webhooks/${id}.json`, { method: "DELETE" }).catch(() => null);
  console.log(`  Deleted.\n`);
}

async function main() {
  console.log(`Store: ${SHOPIFY_STORE}`);
  console.log(`API: ${API_VERSION}`);
  console.log(`Target: ${APP_DOMAIN}\n`);

  console.log("=== Existing Webhooks ===\n");
  const existing = await listWebhooks();

  // Webhooks we want registered
  const desired = [
    { topic: "inventory_levels/update", path: "/api/webhooks/shopify" },
    { topic: "orders/create", path: "/api/webhooks/shopify" },
    { topic: "products/update", path: "/api/webhooks/shopify" },
  ];

  console.log("=== Registering Webhooks ===\n");
  for (const d of desired) {
    const address = `${APP_DOMAIN}${d.path}`;
    const exists = existing.find(
      (wh: { topic: string; address: string }) => wh.topic === d.topic && wh.address === address,
    );
    if (exists) {
      console.log(`  [skip] ${d.topic} already registered at ${address}\n`);
    } else {
      // Delete any old webhook for same topic pointing elsewhere
      const old = existing.filter(
        (wh: { topic: string; address: string }) => wh.topic === d.topic && wh.address !== address,
      );
      for (const o of old) {
        console.log(`  [replace] Removing old ${d.topic} → ${o.address}`);
        await deleteWebhook(o.id);
      }
      await createWebhook(d.topic, address);
    }
  }

  console.log("=== Final Webhook State ===\n");
  await listWebhooks();
}

main().catch(console.error);
