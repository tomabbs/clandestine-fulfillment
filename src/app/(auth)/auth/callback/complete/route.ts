/**
 * Post-hash-fragment session finalization.
 *
 * After the client-side JS in /auth/callback sets the session via
 * supabase.auth.setSession(), it redirects here. This route reads
 * the session from cookies, looks up the user's role, and redirects
 * to /admin or /portal.
 */

import { createServerClient } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getOrCreateUserRecord } from "@/lib/server/auth-context";
import { STAFF_ROLES } from "@/lib/shared/constants";

export async function GET(request: NextRequest) {
  const { origin } = request.nextUrl;
  const cookieStore = await cookies();
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";

  const supabase = createServerClient(supabaseUrl, supabaseAnonKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        for (const { name, value, options } of cookiesToSet) {
          cookieStore.set(name, value, options);
        }
      },
    },
  });

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.redirect(`${origin}/login?error=no_session`);
  }

  const serviceClient = createClient(supabaseUrl, process.env.SUPABASE_SERVICE_ROLE_KEY ?? "", {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  let role: string | null = null;
  try {
    const userRecord = await getOrCreateUserRecord(serviceClient, user);
    role = userRecord.role;
  } catch {
    return NextResponse.redirect(`${origin}/login?error=provision_failed`);
  }

  if (role && (STAFF_ROLES as readonly string[]).includes(role)) {
    return NextResponse.redirect(`${origin}/admin`);
  }

  if (role === "client" || role === "client_admin") {
    return NextResponse.redirect(`${origin}/portal`);
  }

  return NextResponse.redirect(`${origin}/login?error=no_role`);
}
