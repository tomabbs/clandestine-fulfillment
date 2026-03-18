import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

async function poll() {
  console.log(`=== Image Backfill Status @ ${new Date().toISOString()} ===\n`);

  const { count: imageCount } = await supabase
    .from("warehouse_product_images")
    .select("id", { count: "exact", head: true });
  console.log(`  warehouse_product_images: ${imageCount ?? 0}`);

  const { count: productsWithImages } = await supabase
    .from("warehouse_product_images")
    .select("product_id", { count: "exact", head: true });
  console.log(`  Image rows total: ${productsWithImages ?? 0}`);

  // Products with image_url set
  const { count: productsWithUrl } = await supabase
    .from("warehouse_products")
    .select("id", { count: "exact", head: true })
    .not("image_url", "is", null);
  console.log(`  Products with image_url set: ${productsWithUrl ?? 0}`);

  const { count: totalProducts } = await supabase
    .from("warehouse_products")
    .select("id", { count: "exact", head: true });
  console.log(`  Total products: ${totalProducts ?? 0}`);

  // Recent sync logs
  const { data: logs } = await supabase
    .from("channel_sync_log")
    .select("channel, sync_type, status, items_processed, items_failed, error_message, started_at, completed_at")
    .eq("channel", "shopify")
    .order("created_at", { ascending: false })
    .limit(5);

  console.log("\nRecent Shopify sync logs:");
  for (const log of logs ?? []) {
    const duration = log.completed_at && log.started_at
      ? `${((new Date(log.completed_at).getTime() - new Date(log.started_at).getTime()) / 1000).toFixed(0)}s`
      : "running";
    console.log(`  ${log.sync_type}: ${log.status} — ${log.items_processed ?? 0} processed, ${log.items_failed ?? 0} failed (${duration})${log.error_message ? ` ERROR: ${log.error_message.slice(0, 100)}` : ""}`);
  }
}

poll().catch(console.error);
