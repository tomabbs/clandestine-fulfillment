/**
 * Auth helpers for E2E tests.
 *
 * Since we can't do Google OAuth in Playwright, we create test users
 * via Supabase Admin API and set session cookies directly.
 */

import type { Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://localhost:54321";
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";

function assertE2eAuthEnv() {
  const missing: string[] = [];
  if (!SUPABASE_URL) missing.push("NEXT_PUBLIC_SUPABASE_URL");
  if (!SUPABASE_SERVICE_KEY) missing.push("SUPABASE_SERVICE_ROLE_KEY");
  if (!SUPABASE_ANON_KEY) missing.push("NEXT_PUBLIC_SUPABASE_ANON_KEY");
  if (missing.length > 0) {
    throw new Error(
      `Missing required E2E env vars: ${missing.join(", ")}. Load them via .env.local/.env.development.local or shell export before running Playwright.`,
    );
  }
}

function getAdminClient() {
  assertE2eAuthEnv();
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

/**
 * Create a test user in Supabase Auth + users table, then set session cookies.
 */
async function createTestSession(page: Page, email: string, role: string, orgId: string | null) {
  const admin = getAdminClient();

  // Create auth user (or get existing)
  let authUserId: string;
  const { data: existingUsers } = await admin.auth.admin.listUsers();
  const existing = existingUsers?.users?.find((u) => u.email === email);

  if (existing) {
    authUserId = existing.id;
  } else {
    const { data: newUser, error } = await admin.auth.admin.createUser({
      email,
      password: `test-password-${Date.now()}`,
      email_confirm: true,
    });
    if (error || !newUser.user) throw new Error(`Failed to create test user: ${error?.message}`);
    authUserId = newUser.user.id;
  }

  // Ensure users table row exists
  const { data: workspaces } = await admin.from("workspaces").select("id").limit(1);
  const workspaceId = workspaces?.[0]?.id;

  if (workspaceId) {
    await admin.from("users").upsert(
      {
        auth_user_id: authUserId,
        email,
        role,
        workspace_id: workspaceId,
        org_id: orgId,
      },
      { onConflict: "auth_user_id" },
    );
  }

  // Generate a session for this user
  const { data: session, error: sessionError } = await admin.auth.admin.generateLink({
    type: "magiclink",
    email,
  });

  if (sessionError || !session) {
    // Fallback: sign in with password
    const anonClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    const password = `test-e2e-${email}`;

    // Update password first
    await admin.auth.admin.updateUserById(authUserId, { password });

    const { data: signInData } = await anonClient.auth.signInWithPassword({
      email,
      password,
    });

    if (signInData?.session) {
      await setSessionCookies(
        page,
        signInData.session.access_token,
        signInData.session.refresh_token,
      );
      return;
    }
  }

  // If we got a magic link, exchange the token
  if (session?.properties?.hashed_token) {
    // Navigate to the callback URL to set cookies via the app
    const callbackUrl = `${SUPABASE_URL}/auth/v1/verify?token=${session.properties.hashed_token}&type=magiclink`;
    await page.goto(callbackUrl);
  }
}

async function setSessionCookies(page: Page, accessToken: string, refreshToken: string) {
  const _baseUrl = "http://localhost:3000";
  // Set Supabase auth cookies that @supabase/ssr expects
  await page.context().addCookies([
    {
      name: "sb-access-token",
      value: accessToken,
      domain: "localhost",
      path: "/",
    },
    {
      name: "sb-refresh-token",
      value: refreshToken,
      domain: "localhost",
      path: "/",
    },
  ]);
}

export async function setupStaffSession(page: Page) {
  await createTestSession(page, "e2e-staff@test.clandestine.dev", "super_admin", null);
}

export async function setupClientSession(page: Page, orgId?: string) {
  await createTestSession(page, "e2e-client@test.clandestine.dev", "client", orgId ?? null);
}

export { getAdminClient };
