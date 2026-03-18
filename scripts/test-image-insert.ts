import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

async function test() {
  // Get a product with a shopify_product_id
  const { data: product } = await supabase
    .from("warehouse_products")
    .select("id, workspace_id, shopify_product_id, title")
    .not("shopify_product_id", "is", null)
    .limit(1)
    .single();

  if (!product) { console.log("No product with shopify_product_id"); return; }
  console.log(`Testing with product: ${product.title} (${product.id})`);
  console.log(`  workspace_id: ${product.workspace_id}`);

  // Try to insert an image
  const { data: inserted, error: insertErr } = await supabase
    .from("warehouse_product_images")
    .insert({
      product_id: product.id,
      workspace_id: product.workspace_id,
      shopify_image_id: "test_image_12345",
      src: "https://cdn.shopify.com/test.jpg",
      alt: "Test image",
      position: 0,
    })
    .select()
    .single();

  if (insertErr) {
    console.log(`INSERT FAILED: ${insertErr.message}`);
    console.log(`  Code: ${insertErr.code}`);
    console.log(`  Details: ${insertErr.details}`);
    console.log(`  Hint: ${insertErr.hint}`);
  } else {
    console.log(`INSERT SUCCESS: ${inserted.id}`);
    // Clean up
    await supabase.from("warehouse_product_images").delete().eq("id", inserted.id);
    console.log("Cleaned up test row");
  }
}

test().catch(console.error);
