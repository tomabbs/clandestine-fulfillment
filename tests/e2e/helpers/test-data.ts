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

  const assertOk = (error: { message: string } | null, label: string) => {
    if (error) {
      throw new Error(`[cleanupTestData] ${label}: ${error.message}`);
    }
  };

  // Delete in reverse dependency order for test-created catalog records.
  const inv = await supabase
    .from("warehouse_inventory_levels")
    .delete()
    .like("sku", `${TEST_PREFIX}%`);
  assertOk(inv.error, "warehouse_inventory_levels delete");

  const variants = await supabase
    .from("warehouse_product_variants")
    .delete()
    .like("sku", `${TEST_PREFIX}%`);
  assertOk(variants.error, "warehouse_product_variants delete");

  const products = await supabase
    .from("warehouse_products")
    .delete()
    .like("title", `${TEST_PREFIX}%`);
  assertOk(products.error, "warehouse_products delete");

  // Delete any users tied to test orgs and known E2E test emails.
  const testOrgs = await supabase
    .from("organizations")
    .select("id")
    .or(`slug.like.${TEST_PREFIX}%,name.like.${TEST_PREFIX}%`);
  assertOk(testOrgs.error, "organizations lookup");

  const orgIds = (testOrgs.data ?? []).map((o) => o.id);
  if (orgIds.length > 0) {
    const usersByOrg = await supabase.from("users").delete().in("org_id", orgIds);
    assertOk(usersByOrg.error, "users delete by org_id");
  }

  const usersByEmail = await supabase.from("users").delete().like("email", "%test.clandestine.dev");
  assertOk(usersByEmail.error, "users delete by email");

  const orgs = await supabase
    .from("organizations")
    .delete()
    .or(`slug.like.${TEST_PREFIX}%,name.like.${TEST_PREFIX}%`);
  assertOk(orgs.error, "organizations delete");

  // Also remove test users from Supabase Auth.
  const listed = await supabase.auth.admin.listUsers({ page: 1, perPage: 1000 });
  assertOk(listed.error, "auth.listUsers");
  const testAuthUsers = (listed.data?.users ?? []).filter(
    (u) => u.email && (u.email.endsWith("@test.clandestine.dev") || u.email.startsWith("e2e-")),
  );

  for (const user of testAuthUsers) {
    const deleted = await supabase.auth.admin.deleteUser(user.id);
    assertOk(deleted.error, `auth.deleteUser(${user.email})`);
  }
}
