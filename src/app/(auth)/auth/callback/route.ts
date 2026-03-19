import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getOrCreateUserRecord } from "@/lib/server/auth-context";
import { STAFF_ROLES } from "@/lib/shared/constants";

export async function GET(request: NextRequest) {
  const { searchParams, origin } = request.nextUrl;
  const code = searchParams.get("code");
  const next = searchParams.get("next") ?? "/";

  if (!code) {
    return NextResponse.redirect(`${origin}/login?error=missing_code`);
  }

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

  const { error: exchangeError } = await supabase.auth.exchangeCodeForSession(code);

  if (exchangeError) {
    return NextResponse.redirect(`${origin}/login?error=exchange_failed`);
  }

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.redirect(`${origin}/login?error=no_user`);
  }

  // Use service role to bypass RLS — new users have no users row yet,
  // so RLS policies would block the SELECT/INSERT needed for auto-provision.
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
    return NextResponse.redirect(`${origin}${next === "/" ? "/admin" : next}`);
  }

  if (role === "client" || role === "client_admin") {
    return NextResponse.redirect(`${origin}${next === "/" ? "/portal" : next}`);
  }

  return NextResponse.redirect(`${origin}/login?error=no_role`);
}
