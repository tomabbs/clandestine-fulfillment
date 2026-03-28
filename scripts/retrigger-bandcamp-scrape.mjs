/**
 * Retrigger bandcamp-sync for workspaces with incomplete mappings.
 * Only targets workspaces that have mappings missing bandcamp_url or bandcamp_type_name.
 *
 * Run: node scripts/retrigger-bandcamp-scrape.mjs
 *
 * Rollout thresholds — halt if breached at 1h or 24h:
 *   404 rate on constructed URLs: >20% → halt
 *   Parser failures:              >5%  → halt
 *   Coverage after 24h:           <50% → investigate
 */

import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";

const envContent = readFileSync(".env.production", "utf8");
const getEnv = (key) =>
  envContent.match(new RegExp(`^${key}=["']?(.+?)["']?$`, "m"))?.[1]?.trim();

const SUPABASE_URL = getEnv("NEXT_PUBLIC_SUPABASE_URL");
const SUPABASE_SERVICE_KEY = getEnv("SUPABASE_SERVICE_ROLE_KEY");
const TRIGGER_SECRET = getEnv("TRIGGER_SECRET_KEY");

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY || !TRIGGER_SECRET) {
  console.error("Missing env vars. Check .env.production for NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, TRIGGER_SECRET_KEY");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false },
});

async function main() {
  // Only workspaces with incomplete mappings
  const { data: gaps } = await supabase
    .from("bandcamp_product_mappings")
    .select("workspace_id")
    .or("bandcamp_url.is.null,bandcamp_type_name.is.null");

  const workspaceIds = [...new Set((gaps ?? []).map((g) => g.workspace_id))];

  if (!workspaceIds.length) {
    console.log("All mappings complete. No re-trigger needed.");
    return;
  }

  console.log(`${gaps?.length} incomplete mappings across ${workspaceIds.length} workspace(s).`);
  console.log("Triggering bandcamp-sync...\n");

  for (const workspaceId of workspaceIds) {
    const res = await fetch("https://api.trigger.dev/api/v1/tasks/bandcamp-sync/trigger", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TRIGGER_SECRET}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ payload: { workspaceId } }),
    });
    const json = await res.json();
    console.log(`Workspace ${workspaceId}: run ${json.id ?? "ERROR"}`);
    await new Promise((r) => setTimeout(r, 2000));
  }

  console.log(`
=== MONITORING QUERIES (run at 1h and 24h) ===

-- 404 rate (HALT if >20%):
SELECT
  count(*) FILTER (WHERE title LIKE '%404%') AS slug_404s,
  count(*) AS total_scrape_items,
  round(100.0 * count(*) FILTER (WHERE title LIKE '%404%') / NULLIF(count(*),0), 1) AS pct_404
FROM warehouse_review_queue
WHERE category = 'bandcamp_scraper'
  AND created_at > now() - interval '24 hours';

-- Coverage (target >90% at 24h):
SELECT
  count(*) FILTER (WHERE bandcamp_url IS NOT NULL)           AS with_url,
  count(*) FILTER (WHERE bandcamp_type_name IS NOT NULL)     AS with_type,
  count(*) FILTER (WHERE bandcamp_release_date IS NOT NULL)  AS with_release_date,
  count(*) FILTER (WHERE bandcamp_url_source = 'scraper_verified') AS scraper_verified,
  count(*) FILTER (WHERE bandcamp_url_source = 'constructed')      AS constructed,
  count(*) AS total
FROM bandcamp_product_mappings;
`);
}

main().catch(console.error);
