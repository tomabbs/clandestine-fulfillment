/**
 * Local script: backfill warehouse_product_images from Shopify.
 * Run: npx tsx scripts/backfill-images.ts
 * Delete after use.
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

const SHOPIFY_URL = process.env.SHOPIFY_STORE_URL!;
const SHOPIFY_TOKEN = process.env.SHOPIFY_ADMIN_API_TOKEN!;
const SHOPIFY_VERSION = process.env.SHOPIFY_API_VERSION!;
const PAGE_SIZE = 50;

const QUERY = `
  query FetchProducts($first: Int!, $after: String) {
    products(first: $first, after: $after, sortKey: UPDATED_AT) {
      edges {
        node {
          id
          images(first: 20) {
            edges { node { id url altText } }
          }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

async function shopifyFetch(query: string, variables: Record<string, unknown>) {
  const res = await fetch(`${SHOPIFY_URL}/admin/api/${SHOPIFY_VERSION}/graphql.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": SHOPIFY_TOKEN,
    },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (json.errors?.length) throw new Error(json.errors.map((e: { message: string }) => e.message).join(", "));
  return json.data;
}

async function main() {
  let cursor: string | null = null;
  let hasNext = true;
  let totalImages = 0;
  let totalProducts = 0;
  let productsWithImages = 0;

  // Get workspace ID
  const { data: ws } = await supabase.from("workspaces").select("id").limit(1).single();
  if (!ws) { console.error("No workspace"); process.exit(1); }

  console.log(`Workspace: ${ws.id}`);
  console.log(`Fetching products from Shopify...\n`);

  while (hasNext) {
    const data = await shopifyFetch(QUERY, { first: PAGE_SIZE, after: cursor });
    const edges = data.products.edges;

    for (const { node: product } of edges) {
      totalProducts++;
      const images = product.images.edges;

      if (images.length === 0) continue;
      productsWithImages++;

      // Look up our warehouse product by shopify_product_id
      // Handle mixed formats: some rows store "12345", others "gid://shopify/Product/12345"
      const numericId = product.id.replace("gid://shopify/Product/", "");
      const { data: dbProduct } = await supabase
        .from("warehouse_products")
        .select("id")
        .or(`shopify_product_id.eq.${product.id},shopify_product_id.eq.${numericId}`)
        .maybeSingle();

      if (!dbProduct) continue;

      for (let i = 0; i < images.length; i++) {
        const img = images[i].node;
        const shopifyImageId = img.id.replace(/gid:\/\/shopify\/(ImageSource|ProductImage)\//, "");

        // Check if already exists
        const { data: existing } = await supabase
          .from("warehouse_product_images")
          .select("id")
          .eq("shopify_image_id", shopifyImageId)
          .maybeSingle();

        if (existing) continue;

        const { error } = await supabase.from("warehouse_product_images").insert({
          product_id: dbProduct.id,
          workspace_id: ws.id,
          shopify_image_id: shopifyImageId,
          src: img.url,
          alt: img.altText,
          position: i,
        });

        if (error) {
          console.error(`  Failed to insert image for product ${product.id}: ${error.message}`);
        } else {
          totalImages++;
        }
      }

      // Update product image_url to first image
      const firstUrl = images[0].node.url;
      await supabase
        .from("warehouse_products")
        .update({ image_url: firstUrl })
        .eq("id", dbProduct.id);
    }

    hasNext = data.products.pageInfo.hasNextPage;
    cursor = data.products.pageInfo.endCursor;

    process.stdout.write(`\r  Processed ${totalProducts} products, ${totalImages} images inserted...`);
  }

  console.log(`\n\nDone!`);
  console.log(`  Products scanned: ${totalProducts}`);
  console.log(`  Products with images: ${productsWithImages}`);
  console.log(`  Images inserted: ${totalImages}`);

  // Final count
  const { count } = await supabase
    .from("warehouse_product_images")
    .select("id", { count: "exact", head: true });
  console.log(`  Total warehouse_product_images: ${count}`);
}

main().catch(console.error);
