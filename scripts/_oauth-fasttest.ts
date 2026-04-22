/**
 * Throwaway OAuth fast-path test harness for the Direct-Shopify+Bandcamp cutover.
 *
 * Why this exists:
 *   Validates the live OAuth callback at src/app/api/oauth/shopify/route.ts works
 *   end-to-end TODAY against ONE Custom-distribution Shopify app, BEFORE building
 *   the multi-app HRD-35 install UI. Frees the engineering work to happen with
 *   confidence the production OAuth pipeline is real.
 *
 * Usage:
 *   pnpm tsx scripts/_oauth-fasttest.ts preflight   # before manual install
 *   pnpm tsx scripts/_oauth-fasttest.ts verify      # after manual install
 *   pnpm tsx scripts/_oauth-fasttest.ts cleanup     # delete test connection row
 *
 * Read-only except for `cleanup` (DELETE) and `verify`'s defensive
 * do_not_fanout=true forced UPDATE on the new row.
 *
 * Safe to delete after the cutover ships.
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { createServiceRoleClient } from "@/lib/server/supabase-server";
import { env } from "@/lib/shared/env";

const TEST_ORG_ID = "4350cb01-8c7e-48eb-9eba-cb8e818de46d";
const EXPECTED_ORG_NAME = "True Panther";
const EXPECTED_WORKSPACE_ID = "1e59b9ca-ab4e-442b-952b-a649e2aadb0e";
const TEST_SHOP_DOMAIN = "true-panther-records.myshopify.com";
const EXPECTED_STORE_URL = `https://${TEST_SHOP_DOMAIN}`;
const APP_URL = "https://clandestine-fulfillment.vercel.app";
const OAUTH_ROUTE = `${APP_URL}/api/oauth/shopify`;

const EXPECTED_SCOPES_CSV =
  "read_products,write_products,read_inventory,write_inventory,read_orders,write_orders,read_fulfillments,write_fulfillments,write_publications";
const EXPECTED_SCOPES = EXPECTED_SCOPES_CSV.split(",");

const PASS = "PASS";
const FAIL = "FAIL";
const WARN = "WARN";

type CheckResult = { name: string; status: typeof PASS | typeof FAIL | typeof WARN; detail: string };

function logCheck(r: CheckResult): void {
  const tag = r.status === PASS ? "[PASS]" : r.status === FAIL ? "[FAIL]" : "[WARN]";
  console.log(`${tag} ${r.name}`);
  if (r.detail) console.log(`       ${r.detail}`);
}

function summarize(results: CheckResult[]): boolean {
  const fails = results.filter((r) => r.status === FAIL).length;
  const warns = results.filter((r) => r.status === WARN).length;
  const passes = results.filter((r) => r.status === PASS).length;
  console.log("");
  console.log("─".repeat(60));
  console.log(`SUMMARY: ${passes} pass, ${warns} warn, ${fails} fail`);
  console.log("─".repeat(60));
  if (fails === 0) {
    console.log("READY ✓");
    return true;
  }
  console.log("NOT READY — fix the FAIL items above before proceeding.");
  return false;
}

// ─── PREFLIGHT ──────────────────────────────────────────────────────────────
async function preflight(): Promise<boolean> {
  console.log("");
  console.log("OAuth fast-path PREFLIGHT");
  console.log(`  org_id        = ${TEST_ORG_ID}`);
  console.log(`  shop          = ${TEST_SHOP_DOMAIN}`);
  console.log(`  callback URL  = ${OAUTH_ROUTE}`);
  console.log("");

  const sb = createServiceRoleClient();
  const results: CheckResult[] = [];

  // Check 1: org exists with the expected name + workspace
  const { data: org, error: orgErr } = await sb
    .from("organizations")
    .select("id, name, workspace_id")
    .eq("id", TEST_ORG_ID)
    .maybeSingle();

  if (orgErr || !org) {
    results.push({
      name: "Organization row exists",
      status: FAIL,
      detail: orgErr ? `query error: ${orgErr.message}` : `no row for id=${TEST_ORG_ID}`,
    });
  } else {
    const nameOk = org.name === EXPECTED_ORG_NAME;
    const wsOk = org.workspace_id === EXPECTED_WORKSPACE_ID;
    results.push({
      name: "Organization row exists",
      status: nameOk && wsOk ? PASS : WARN,
      detail: `name='${org.name}' (expected '${EXPECTED_ORG_NAME}'), workspace_id='${org.workspace_id}' (expected '${EXPECTED_WORKSPACE_ID}')`,
    });
  }

  // Check 2: no existing shopify connection for this org
  const { data: existing, error: existingErr } = await sb
    .from("client_store_connections")
    .select("id, store_url, connection_status, do_not_fanout, api_key")
    .eq("org_id", TEST_ORG_ID)
    .eq("platform", "shopify");

  if (existingErr) {
    results.push({
      name: "No existing Shopify connection (clean slate)",
      status: FAIL,
      detail: `query error: ${existingErr.message}`,
    });
  } else if ((existing?.length ?? 0) > 0) {
    results.push({
      name: "No existing Shopify connection (clean slate)",
      status: WARN,
      detail: `found ${existing?.length} row(s). The OAuth upsert will UPDATE existing on (org_id,platform,store_url) — should be safe but inspect: ${JSON.stringify(
        existing?.map((r) => ({
          id: r.id,
          store_url: r.store_url,
          status: r.connection_status,
          do_not_fanout: r.do_not_fanout,
          has_token: Boolean(r.api_key),
        })),
      )}`,
    });
  } else {
    results.push({
      name: "No existing Shopify connection (clean slate)",
      status: PASS,
      detail: "0 rows — upsert will INSERT a fresh row",
    });
  }

  // Check 3: live OAuth callback responds
  try {
    const probeRes = await fetch(OAUTH_ROUTE, { method: "GET" });
    const probeText = await probeRes.text();
    let probeJson: unknown = null;
    try {
      probeJson = JSON.parse(probeText);
    } catch {
      // not JSON — that's a fail signal
    }
    const isExpected400 =
      probeRes.status === 400 &&
      probeJson !== null &&
      typeof probeJson === "object" &&
      (probeJson as { error?: string }).error === "Invalid request";
    results.push({
      name: "Live OAuth route deployed and reachable",
      status: isExpected400 ? PASS : FAIL,
      detail: `${probeRes.status} ${probeRes.statusText} — body: ${probeText.slice(0, 200)}`,
    });
  } catch (e) {
    results.push({
      name: "Live OAuth route deployed and reachable",
      status: FAIL,
      detail: `fetch failed: ${(e as Error).message}`,
    });
  }

  // Check 4: scope set printed for Partner Dashboard config (informational only)
  results.push({
    name: "Scopes to register in Partner Dashboard (copy these EXACTLY)",
    status: PASS,
    detail: EXPECTED_SCOPES.join(", "),
  });

  // Check 5: install URL printed (no manual URL crafting needed)
  const installUrl = `${OAUTH_ROUTE}?shop=${TEST_SHOP_DOMAIN}&org_id=${TEST_ORG_ID}`;
  results.push({
    name: "Install URL (open in browser AFTER Partner-Dashboard + Vercel envs done)",
    status: PASS,
    detail: installUrl,
  });

  // Check 6: env vars sanity (warn-only — Vercel-side is what matters)
  const envSnap = env();
  const localCidLen = envSnap.SHOPIFY_CLIENT_ID?.length ?? 0;
  const localSecLen = envSnap.SHOPIFY_CLIENT_SECRET?.length ?? 0;
  results.push({
    name: "Local .env.local has SHOPIFY_CLIENT_ID/SECRET set",
    status: localCidLen > 0 && localSecLen > 0 ? PASS : WARN,
    detail: `local CID len=${localCidLen}, SECRET len=${localSecLen}. NOTE: this script doesn't use them — only Vercel-side env matters for the live route.`,
  });

  for (const r of results) logCheck(r);
  return summarize(results);
}

// ─── VERIFY (post-install) ──────────────────────────────────────────────────
async function verify(): Promise<boolean> {
  console.log("");
  console.log("OAuth fast-path VERIFY (post-install)");
  console.log("");

  const sb = createServiceRoleClient();
  const results: CheckResult[] = [];

  // Check 1: connection row landed
  const { data: rows, error: rowsErr } = await sb
    .from("client_store_connections")
    .select(
      "id, workspace_id, org_id, platform, store_url, connection_status, do_not_fanout, api_key, created_at, updated_at",
    )
    .eq("org_id", TEST_ORG_ID)
    .eq("platform", "shopify");

  if (rowsErr) {
    results.push({
      name: "Connection row exists",
      status: FAIL,
      detail: `query error: ${rowsErr.message}`,
    });
    for (const r of results) logCheck(r);
    return summarize(results);
  }

  if (!rows || rows.length === 0) {
    results.push({
      name: "Connection row exists",
      status: FAIL,
      detail: "0 rows — OAuth callback did not run or upsert failed. Check Vercel function logs for /api/oauth/shopify.",
    });
    for (const r of results) logCheck(r);
    return summarize(results);
  }

  const row = rows[0];
  const tokenLen = row.api_key?.length ?? 0;
  results.push({
    name: "Connection row exists",
    status: PASS,
    detail: `id=${row.id}, status='${row.connection_status}', token_len=${tokenLen}, do_not_fanout=${row.do_not_fanout}, store_url='${row.store_url}', created_at=${row.created_at}`,
  });

  // Check 2: store_url matches expected
  results.push({
    name: "store_url matches expected",
    status: row.store_url === EXPECTED_STORE_URL ? PASS : FAIL,
    detail: `got '${row.store_url}', expected '${EXPECTED_STORE_URL}'`,
  });

  // Check 3: connection_status is 'active'
  results.push({
    name: "connection_status is 'active'",
    status: row.connection_status === "active" ? PASS : FAIL,
    detail: `got '${row.connection_status}'`,
  });

  // Check 4: token captured (length sanity check — Shopify offline tokens are >30 chars)
  results.push({
    name: "Access token captured (length > 30)",
    status: tokenLen > 30 ? PASS : FAIL,
    detail: `token_len=${tokenLen}`,
  });

  // Check 5: SAFETY GATE — force do_not_fanout=true
  if (row.do_not_fanout !== true) {
    const { error: updErr } = await sb
      .from("client_store_connections")
      .update({ do_not_fanout: true })
      .eq("id", row.id);
    results.push({
      name: "SAFETY: forced do_not_fanout=true on test connection",
      status: updErr ? FAIL : PASS,
      detail: updErr
        ? `update failed: ${updErr.message}`
        : `was ${row.do_not_fanout}, now true — no inventory will fan out from this test row`,
    });
  } else {
    results.push({
      name: "SAFETY: do_not_fanout already true",
      status: PASS,
      detail: "no fanout possible from this row",
    });
  }

  // Check 6: SMOKE TEST — token actually works against Shopify Admin API
  if (tokenLen > 30 && row.api_key) {
    const apiVersion = env().SHOPIFY_API_VERSION;
    const shopUrl = `${EXPECTED_STORE_URL}/admin/api/${apiVersion}/shop.json`;
    try {
      const shopRes = await fetch(shopUrl, {
        headers: { "X-Shopify-Access-Token": row.api_key },
      });
      const shopBody = await shopRes.text();
      let shopJson: { shop?: { name?: string; myshopify_domain?: string; plan_name?: string } } = {};
      try {
        shopJson = JSON.parse(shopBody);
      } catch {
        // body wasn't JSON — surface raw
      }
      results.push({
        name: "Smoke test: GET /admin/api/{version}/shop.json with captured token",
        status: shopRes.ok ? PASS : FAIL,
        detail: shopRes.ok
          ? `200 OK — shop.name='${shopJson.shop?.name}', myshopify_domain='${shopJson.shop?.myshopify_domain}', plan='${shopJson.shop?.plan_name}'`
          : `${shopRes.status} ${shopRes.statusText} — ${shopBody.slice(0, 200)}`,
      });

      // Check 7: scope grant matches what we registered in Partner Dashboard
      const scopesUrl = `${EXPECTED_STORE_URL}/admin/oauth/access_scopes.json`;
      const scopesRes = await fetch(scopesUrl, {
        headers: { "X-Shopify-Access-Token": row.api_key },
      });
      const scopesBody = await scopesRes.text();
      let scopesJson: { access_scopes?: Array<{ handle: string }> } = {};
      try {
        scopesJson = JSON.parse(scopesBody);
      } catch {
        // body wasn't JSON
      }
      const grantedHandles = (scopesJson.access_scopes ?? []).map((s) => s.handle).sort();
      const expectedSorted = [...EXPECTED_SCOPES].sort();
      const missing = expectedSorted.filter((s) => !grantedHandles.includes(s));
      const extra = grantedHandles.filter((s) => !expectedSorted.includes(s));
      const exactMatch = missing.length === 0 && extra.length === 0;
      results.push({
        name: "Granted scopes match registered scopes",
        status: scopesRes.ok ? (exactMatch ? PASS : WARN) : FAIL,
        detail: scopesRes.ok
          ? exactMatch
            ? `exact match (${grantedHandles.length} scopes): ${grantedHandles.join(", ")}`
            : `granted: ${grantedHandles.join(", ")}; missing: [${missing.join(", ")}]; extra: [${extra.join(", ")}]`
          : `${scopesRes.status} ${scopesRes.statusText} — ${scopesBody.slice(0, 200)}`,
      });
    } catch (e) {
      results.push({
        name: "Smoke test: Shopify API call",
        status: FAIL,
        detail: `fetch failed: ${(e as Error).message}`,
      });
    }
  }

  for (const r of results) logCheck(r);
  return summarize(results);
}

// ─── CLEANUP ────────────────────────────────────────────────────────────────
async function cleanup(): Promise<boolean> {
  console.log("");
  console.log("OAuth fast-path CLEANUP — deleting test connection row");
  console.log("");

  const sb = createServiceRoleClient();

  const { data: rows, error: selErr } = await sb
    .from("client_store_connections")
    .select("id, store_url")
    .eq("org_id", TEST_ORG_ID)
    .eq("platform", "shopify");

  if (selErr) {
    console.log(`[FAIL] select before delete: ${selErr.message}`);
    return false;
  }
  if (!rows || rows.length === 0) {
    console.log("[PASS] no rows to delete (already clean)");
    return true;
  }

  console.log(`Deleting ${rows.length} row(s):`);
  for (const r of rows) console.log(`  - id=${r.id} store_url=${r.store_url}`);

  const { error: delErr } = await sb
    .from("client_store_connections")
    .delete()
    .eq("org_id", TEST_ORG_ID)
    .eq("platform", "shopify");

  if (delErr) {
    console.log(`[FAIL] delete: ${delErr.message}`);
    return false;
  }

  console.log("[PASS] deleted");
  console.log("");
  console.log("Reminder: also restore Vercel env vars to your original public-app credentials,");
  console.log("then redeploy. The Custom-distribution Partner-Dashboard app can stay idle.");
  return true;
}

// ─── ENTRY ──────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  const cmd = process.argv[2];
  let ok = false;
  switch (cmd) {
    case "preflight":
      ok = await preflight();
      break;
    case "verify":
      ok = await verify();
      break;
    case "cleanup":
      ok = await cleanup();
      break;
    default:
      console.log("Usage: pnpm tsx scripts/_oauth-fasttest.ts <preflight|verify|cleanup>");
      process.exit(2);
  }
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error("UNHANDLED ERROR:", e);
  process.exit(1);
});
