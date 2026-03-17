import {
  createBrowserClient as _createBrowserClient,
  createServerClient as _createServerClient,
} from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";
import { clientEnv, env } from "@/lib/shared/env";

/**
 * Supabase client for Server Components and Server Actions.
 * Uses cookie-based auth via next/headers. Respects RLS with the anon key.
 * Call this inside an async Server Component or Server Action — never at module scope.
 */
export async function createServerSupabaseClient() {
  const { NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY } = env();
  const cookieStore = await cookies();

  return _createServerClient(NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        for (const { name, value, options } of cookiesToSet) {
          try {
            cookieStore.set(name, value, options);
          } catch {
            // setAll can fail in Server Components where the response is
            // already streaming. The middleware handles session refresh so
            // this is safe to swallow.
          }
        }
      },
    },
  });
}

/**
 * Supabase client with service_role key — bypasses RLS.
 * For Trigger.dev tasks and other trusted server-side operations ONLY.
 * NEVER expose this client to the browser.
 */
export function createServiceRoleClient() {
  const { NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = env();

  return createClient(NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}

/**
 * Supabase client for Client Components (browser-side).
 * Uses anon key — RLS applies based on the user's session cookie.
 */
export function createBrowserSupabaseClient() {
  const { NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY } = clientEnv();

  return _createBrowserClient(NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY);
}
