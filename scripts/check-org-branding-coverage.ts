// Phase 12 follow-up — Org branding coverage check.
//
// Surfaces which orgs are missing brand fields used by the unified email
// pipeline + the public /track/[token] page. Run before flipping
// `email_send_strategy` to `unified_resend` so you know which orgs will
// fall back to Clandestine generic branding.
//
// Usage:
//   pnpm tsx scripts/check-org-branding-coverage.ts

import { createClient } from "@supabase/supabase-js";
import "dotenv/config";

interface OrgRow {
  id: string;
  name: string | null;
  brand_color: string | null;
  logo_url: string | null;
  support_email: string | null;
  brand_website_url: string | null;
}

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error("FATAL: NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY missing");
    process.exit(1);
  }
  const supabase = createClient(url, key);

  const { data, error } = await supabase
    .from("organizations")
    .select("id, name, brand_color, logo_url, support_email, brand_website_url")
    .order("name", { ascending: true });
  if (error) {
    console.error("FATAL:", error.message);
    process.exit(1);
  }
  if (!data || data.length === 0) {
    console.log("(no organizations)");
    return;
  }

  const orgs = data as OrgRow[];
  console.log(`\n=== Org branding coverage (${orgs.length} orgs) ===\n`);

  let missingColor = 0;
  let missingLogo = 0;
  let missingSupport = 0;
  for (const o of orgs) {
    const flags = [
      o.brand_color ? "✓color" : "✗color",
      o.logo_url ? "✓logo" : "✗logo",
      o.support_email ? "✓support" : "✗support",
      o.brand_website_url ? "✓site" : "—",
    ].join("  ");
    console.log(`  ${(o.name ?? o.id.slice(0, 8)).padEnd(40)} ${flags}`);
    if (!o.brand_color) missingColor++;
    if (!o.logo_url) missingLogo++;
    if (!o.support_email) missingSupport++;
  }

  console.log("\n--- Summary ---");
  console.log(`  ${missingColor}/${orgs.length} missing brand_color (will use #111827 fallback)`);
  console.log(`  ${missingLogo}/${orgs.length} missing logo_url (will use text name fallback)`);
  console.log(
    `  ${missingSupport}/${orgs.length} missing support_email (will use support@clandestinedistro.com fallback)`,
  );

  if (missingColor + missingLogo + missingSupport === 0) {
    console.log("\n✓ Full branding coverage. Safe to flip email_send_strategy to unified_resend.");
  } else {
    console.log(
      "\nMissing fields fall back to Clandestine defaults. Acceptable for shadow/early unified mode;",
    );
    console.log(
      "fill in via SQL or admin UI for orgs where you want artist-specific branded emails.",
    );
  }
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
