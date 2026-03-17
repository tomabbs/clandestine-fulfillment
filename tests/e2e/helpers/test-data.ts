/**
 * Test data helpers for E2E tests.
 * Creates and cleans up test data via Supabase service_role.
 */

import { getAdminClient } from "./auth";

const TEST_PREFIX = "e2e-test-";

export async function createTestOrg(name: string) {
  const supabase = getAdminClient();

  const { data: workspace } = await supabase.from("workspaces").select("id").limit(1).single();
  if (!workspace) throw new Error("No workspace found — run migrations first");

  const slug = `${TEST_PREFIX}${name.toLowerCase().replace(/\s+/g, "-")}-${Date.now()}`;

  const { data: org, error } = await supabase
    .from("organizations")
    .insert({
      workspace_id: workspace.id,
      name: `${TEST_PREFIX}${name}`,
      slug,
      onboarding_state: { login_complete: true },
    })
    .select("id")
    .single();

  if (error) throw new Error(`Failed to create test org: ${error.message}`);
  return { orgId: org.id, workspaceId: workspace.id };
}

export async function createTestProduct(
  workspaceId: string,
  orgId: string,
  sku: string,
  title: string,
) {
  const supabase = getAdminClient();

  const { data: product, error: productError } = await supabase
    .from("warehouse_products")
    .insert({
      workspace_id: workspaceId,
      org_id: orgId,
      title: `${TEST_PREFIX}${title}`,
      status: "active",
    })
    .select("id")
    .single();

  if (productError) throw new Error(`Failed to create test product: ${productError.message}`);

  const { data: variant, error: variantError } = await supabase
    .from("warehouse_product_variants")
    .insert({
      product_id: product.id,
      workspace_id: workspaceId,
      sku: `${TEST_PREFIX}${sku}`,
      title: "Default",
    })
    .select("id")
    .single();

  if (variantError) throw new Error(`Failed to create test variant: ${variantError.message}`);

  await supabase.from("warehouse_inventory_levels").insert({
    variant_id: variant.id,
    workspace_id: workspaceId,
    sku: `${TEST_PREFIX}${sku}`,
    available: 100,
    committed: 0,
    incoming: 0,
  });

  return { productId: product.id, variantId: variant.id, sku: `${TEST_PREFIX}${sku}` };
}

export async function cleanupTestData() {
  const supabase = getAdminClient();

  // Delete in reverse dependency order
  await supabase.from("warehouse_inventory_levels").delete().like("sku", `${TEST_PREFIX}%`);
  await supabase.from("warehouse_product_variants").delete().like("sku", `${TEST_PREFIX}%`);
  await supabase.from("warehouse_products").delete().like("title", `${TEST_PREFIX}%`);
  await supabase.from("organizations").delete().like("slug", `${TEST_PREFIX}%`);
}
