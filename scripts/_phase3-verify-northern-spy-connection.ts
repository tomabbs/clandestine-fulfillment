/**
 * Phase 3 Pass 2 soak — end-to-end read-only verification of the Northern
 * Spy Shopify connection.
 *
 * Side effects: NONE.
 *   - Read-only GraphQL queries against Shopify (shop info, webhook
 *     subscription list, default-location existence, sample inventory level).
 *   - Read-only Postgres queries against `webhook_events` and
 *     `sensor_readings` for the last 24h.
 *
 * Purpose: prove that authentication is healthy in both directions before
 * the operator (a) imports the correct inventory numbers and (b) clears
 * dormancy / flips cutover_state to `shadow`. This is the "are we wired
 * up?" gate before any state-machine transition.
 *
 * Usage:
 *   pnpm tsx scripts/_phase3-verify-northern-spy-connection.ts
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import {
  type ConnectionShopifyContext,
  connectionShopifyGraphQL,
} from "@/lib/server/shopify-connection-graphql";
import { listWebhookSubscriptions } from "@/lib/server/shopify-webhook-subscriptions";
import { createServiceRoleClient } from "@/lib/server/supabase-server";
import { env } from "@/lib/shared/env";

const NORTHERN_SPY_SHOPIFY_CONN_ID = "93225922-357f-4607-a5a4-2c1ad3a9beac";

interface CheckResult {
  name: string;
  status: "ok" | "warn" | "fail";
  detail: string;
}

const results: CheckResult[] = [];
function record(r: CheckResult): void {
  results.push(r);
  const tag = r.status === "ok" ? "  OK  " : r.status === "warn" ? " WARN " : " FAIL ";
  console.log(`[${tag}] ${r.name}`);
  for (const line of r.detail.split("\n")) console.log(`        ${line}`);
}

async function main() {
  const sb = createServiceRoleClient();

  const { data: conn } = await sb
    .from("client_store_connections")
    .select(
      "id, store_url, shopify_verified_domain, platform, connection_status, do_not_fanout, cutover_state, api_key, shopify_app_client_secret_encrypted, webhook_secret, default_location_id, last_webhook_at, metadata",
    )
    .eq("id", NORTHERN_SPY_SHOPIFY_CONN_ID)
    .single();

  if (!conn) {
    console.error("connection lookup failed");
    process.exit(1);
  }

  const storeUrl = conn.shopify_verified_domain
    ? `https://${conn.shopify_verified_domain}`
    : (conn.store_url as string);
  const ctx: ConnectionShopifyContext = {
    storeUrl,
    accessToken: conn.api_key as string,
  };

  console.log("Phase 3 Pass 2 soak \u2014 Northern Spy connection verification");
  console.log("─".repeat(72));
  console.log(`  connection.id   : ${conn.id}`);
  console.log(`  storeUrl        : ${storeUrl}`);
  console.log(`  cutover_state   : ${conn.cutover_state}`);
  console.log(`  do_not_fanout   : ${conn.do_not_fanout}`);
  console.log(`  default_location: ${conn.default_location_id ?? "(null)"}`);
  console.log("─".repeat(72));
  console.log();

  // ─── Check 1: Shopify GraphQL auth (read-side) ────────────────────────────
  try {
    type ShopResp = {
      shop: { id: string; name: string; email: string; myshopifyDomain: string; primaryDomain: { url: string } };
    };
    const data = await connectionShopifyGraphQL<ShopResp>(
      ctx,
      `query { shop { id name email myshopifyDomain primaryDomain { url } } }`,
    );
    record({
      name: "Shopify GraphQL auth (read shop info)",
      status: "ok",
      detail: `name="${data.shop.name}" myshopifyDomain=${data.shop.myshopifyDomain} primaryDomain=${data.shop.primaryDomain.url}`,
    });
  } catch (err) {
    record({
      name: "Shopify GraphQL auth (read shop info)",
      status: "fail",
      detail: `ERROR: ${err instanceof Error ? err.message : String(err)}`,
    });
    return summarize();
  }

  // ─── Check 2: Webhook subscriptions are live + canonical ───────────────────
  const callbackUrl = `${env().NEXT_PUBLIC_APP_URL}/api/webhooks/client-store?connection_id=${conn.id}&platform=shopify`;
  try {
    const subs = await listWebhookSubscriptions(ctx);
    const onOurUrl = subs.filter((s) => s.callbackUrl === callbackUrl);
    const onOtherUrl = subs.filter((s) => s.callbackUrl !== callbackUrl);
    const requiredTopics = [
      "inventory_levels/update",
      "orders/create",
      "orders/cancelled",
      "refunds/create",
    ];
    const present = new Set(onOurUrl.map((s) => s.topic));
    const missing = requiredTopics.filter((t) => !present.has(t));
    if (missing.length === 0) {
      const apiVersions = new Set(onOurUrl.map((s) => s.apiVersion));
      record({
        name: "Required webhook subscriptions live on Shopify",
        status: apiVersions.size === 1 ? "ok" : "warn",
        detail: [
          `${onOurUrl.length} subscription(s) on canonical callbackUrl`,
          `apiVersions: ${Array.from(apiVersions).join(", ")}`,
          ...onOurUrl.map(
            (s) => `  \u2713 ${s.topic.padEnd(28)} apiVersion=${s.apiVersion}  id=${s.id}`,
          ),
          ...(onOtherUrl.length > 0
            ? [
                `${onOtherUrl.length} other subscription(s) on this store (different callbackUrl):`,
                ...onOtherUrl.map((s) => `  \u00b7 ${s.topic.padEnd(28)} \u2192 ${s.callbackUrl}`),
              ]
            : []),
        ].join("\n"),
      });
    } else {
      record({
        name: "Required webhook subscriptions live on Shopify",
        status: "fail",
        detail: `Missing topics on canonical callbackUrl: ${missing.join(", ")}`,
      });
    }
  } catch (err) {
    record({
      name: "Required webhook subscriptions live on Shopify",
      status: "fail",
      detail: `ERROR: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  // ─── Check 3: Default location exists + matches Northern Spy ───────────────
  if (!conn.default_location_id) {
    record({
      name: "Default Shopify location",
      status: "fail",
      detail: "default_location_id is NULL \u2014 cannot push inventory anywhere",
    });
  } else {
    try {
      const locId = `gid://shopify/Location/${conn.default_location_id}`;
      type LocResp = {
        location: { id: string; name: string; address: { city: string | null; country: string | null }; isActive: boolean; fulfillsOnlineOrders: boolean };
      };
      const data = await connectionShopifyGraphQL<LocResp>(
        ctx,
        `query($id: ID!) { location(id: $id) { id name address { city country } isActive fulfillsOnlineOrders } }`,
        { id: locId },
      );
      if (!data.location) {
        record({
          name: "Default Shopify location",
          status: "fail",
          detail: `Location ${conn.default_location_id} not found on Shopify (deleted or wrong shop?)`,
        });
      } else {
        record({
          name: "Default Shopify location",
          status: data.location.isActive ? "ok" : "warn",
          detail: `id=${conn.default_location_id} name="${data.location.name}" city=${data.location.address.city ?? "(none)"} country=${data.location.address.country ?? "(none)"} isActive=${data.location.isActive} fulfillsOnlineOrders=${data.location.fulfillsOnlineOrders}`,
        });
      }
    } catch (err) {
      record({
        name: "Default Shopify location",
        status: "fail",
        detail: `ERROR: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  // ─── Check 4: Inventory READ scope (sample first available SKU) ────────────
  if (conn.default_location_id) {
    try {
      type InvResp = {
        location: {
          id: string;
          inventoryLevels: {
            edges: Array<{
              node: { id: string; quantities: Array<{ name: string; quantity: number }>; item: { id: string; sku: string | null } };
            }>;
          };
        };
      };
      const locId = `gid://shopify/Location/${conn.default_location_id}`;
      const data = await connectionShopifyGraphQL<InvResp>(
        ctx,
        `query($id: ID!) {
          location(id: $id) {
            id
            inventoryLevels(first: 5) {
              edges { node {
                id
                quantities(names: ["available"]) { name quantity }
                item { id sku }
              } }
            }
          }
        }`,
        { id: locId },
      );
      const edges = data.location?.inventoryLevels?.edges ?? [];
      if (edges.length === 0) {
        record({
          name: "Inventory READ scope (sample at default location)",
          status: "warn",
          detail: "Location returned 0 inventoryLevels (empty location, or no inventory items have rows here)",
        });
      } else {
        record({
          name: "Inventory READ scope (sample at default location)",
          status: "ok",
          detail: [
            `Sampled ${edges.length} inventory level(s) at the default location:`,
            ...edges.map(
              (e) =>
                `  \u00b7 sku=${e.node.item.sku ?? "(null)"}  available=${e.node.quantities[0]?.quantity ?? "?"}  itemId=${e.node.item.id}`,
            ),
          ].join("\n"),
        });
      }
    } catch (err) {
      record({
        name: "Inventory READ scope (sample at default location)",
        status: "fail",
        detail: `ERROR: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  // ─── Check 5: Recent webhook_events for this connection ────────────────────
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { data: events } = await sb
    .from("webhook_events")
    .select("id, platform, topic, status, created_at, dedup_key")
    .eq("workspace_id", "1e59b9ca-ab4e-442b-952b-a649e2aadb0e")
    .eq("platform", "shopify")
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(20);
  const evRows = (events ?? []) as Array<{
    id: string;
    topic: string | null;
    status: string;
    created_at: string;
  }>;
  if (evRows.length === 0) {
    record({
      name: "webhook_events activity (last 24h, this workspace, platform=shopify)",
      status: "warn",
      detail: "No rows. Either no organic Shopify activity since registration, or webhooks haven't begun delivering yet (Shopify normally fires the first delivery within seconds of creation, but only when something actually changes).",
    });
  } else {
    const failed = evRows.filter((e) => e.status === "enqueue_failed").length;
    record({
      name: "webhook_events activity (last 24h, this workspace, platform=shopify)",
      status: failed > 0 ? "fail" : "ok",
      detail: [
        `${evRows.length} row(s) total  enqueue_failed=${failed}`,
        ...evRows
          .slice(0, 10)
          .map((e) => `  \u00b7 ${e.created_at}  topic=${e.topic ?? "(none)"}  status=${e.status}`),
      ].join("\n"),
    });
  }

  // ─── Check 6: sensor_readings for this connection in last 24h ──────────────
  const { data: sensors } = await sb
    .from("sensor_readings")
    .select("category, severity, message, created_at")
    .eq("workspace_id", "1e59b9ca-ab4e-442b-952b-a649e2aadb0e")
    .gte("created_at", since)
    .or("category.like.webhook%,category.like.client_store%,category.like.shopify%")
    .order("created_at", { ascending: false })
    .limit(20);
  const sRows = (sensors ?? []) as Array<{
    category: string;
    severity: string;
    message: string;
    created_at: string;
  }>;
  if (sRows.length === 0) {
    record({
      name: "sensor_readings (webhook/client_store/shopify, last 24h, this workspace)",
      status: "ok",
      detail: "No alerts.",
    });
  } else {
    const high = sRows.filter((s) => s.severity === "high" || s.severity === "critical").length;
    record({
      name: "sensor_readings (webhook/client_store/shopify, last 24h, this workspace)",
      status: high > 0 ? "warn" : "ok",
      detail: [
        `${sRows.length} reading(s); high+critical=${high}`,
        ...sRows
          .slice(0, 10)
          .map(
            (s) =>
              `  \u00b7 ${s.created_at} [${s.severity}] ${s.category}: ${s.message.slice(0, 120)}`,
          ),
      ].join("\n"),
    });
  }

  summarize();
}

function summarize(): void {
  console.log();
  console.log("─".repeat(72));
  const ok = results.filter((r) => r.status === "ok").length;
  const warn = results.filter((r) => r.status === "warn").length;
  const fail = results.filter((r) => r.status === "fail").length;
  console.log(`Summary: ok=${ok}  warn=${warn}  fail=${fail}`);
  if (fail === 0) {
    console.log(
      "Verdict: Connection is wired up correctly. SAFE to import inventory numbers next; HOLD on cutover_state and do_not_fanout until operator says go.",
    );
  } else {
    console.log("Verdict: One or more failures \u2014 do NOT proceed with inventory import yet.");
    process.exitCode = 2;
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
