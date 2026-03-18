import { config } from "dotenv";
config({ path: ".env.local" });

async function test() {
  const SHOPIFY_STORE_URL = process.env.SHOPIFY_STORE_URL!;
  const SHOPIFY_ADMIN_API_TOKEN = process.env.SHOPIFY_ADMIN_API_TOKEN!;
  const SHOPIFY_API_VERSION = process.env.SHOPIFY_API_VERSION!;

  const query = `{
    products(first: 5) {
      edges {
        node {
          id title
          images(first: 5) {
            edges { node { id url altText } }
          }
        }
      }
    }
  }`;

  const res = await fetch(
    `${SHOPIFY_STORE_URL}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": SHOPIFY_ADMIN_API_TOKEN,
      },
      body: JSON.stringify({ query }),
    },
  );

  const json = await res.json();
  if (json.errors) {
    console.log("GraphQL errors:", JSON.stringify(json.errors, null, 2));
    return;
  }

  const products = json.data.products.edges;
  console.log(`Fetched ${products.length} products:\n`);

  for (const { node: p } of products) {
    const imgCount = p.images.edges.length;
    console.log(`${p.title} (${p.id})`);
    console.log(`  Images: ${imgCount}`);
    if (imgCount > 0) {
      const firstImg = p.images.edges[0].node;
      console.log(`  First: id=${firstImg.id} url=${firstImg.url.slice(0, 80)}...`);
    }
    console.log();
  }
}

test().catch(console.error);
