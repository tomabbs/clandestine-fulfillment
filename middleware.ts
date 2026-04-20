import { createServerClient } from "@supabase/ssr";
import { type NextRequest, NextResponse } from "next/server";
import type { UserRole } from "@/lib/shared/constants";
import { STAFF_ROLES } from "@/lib/shared/constants";

const PUBLIC_PATHS = [
  "/login",
  "/auth/callback",
  "/api/health",
  "/terms",
  "/privacy",
  // Phase 12 — public branded customer tracking surface. Token in URL is
  // the auth: random 22-char base64url, 128 bits of entropy.
  "/track",
];

function isPublicPath(pathname: string): boolean {
  if (pathname.startsWith("/api/webhooks/")) return true;
  if (pathname.startsWith("/api/oauth/")) return true;
  return PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

function isStaffRole(role: string): boolean {
  return (STAFF_ROLES as readonly string[]).includes(role);
}

function isClientRole(role: string): boolean {
  return role === "client" || role === "client_admin";
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (isPublicPath(pathname)) {
    return NextResponse.next();
  }

  // Phase 0.8 — /portal/stores is dormant. Redirect to /portal so legacy
  // bookmarks land on the dashboard. The /portal/stores route file still
  // exists as a fallback for direct hits that bypass middleware.
  if (pathname === "/portal/stores" || pathname.startsWith("/portal/stores/")) {
    const home = request.nextUrl.clone();
    home.pathname = "/portal";
    home.search = "";
    return NextResponse.redirect(home);
  }

  let supabaseResponse = NextResponse.next({ request });

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";

  const supabase = createServerClient(supabaseUrl, supabaseAnonKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        for (const { name, value } of cookiesToSet) {
          request.cookies.set(name, value);
        }
        supabaseResponse = NextResponse.next({ request });
        for (const { name, value, options } of cookiesToSet) {
          supabaseResponse.cookies.set(name, value, options);
        }
      },
    },
  });

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    const loginUrl = request.nextUrl.clone();
    loginUrl.pathname = "/login";
    loginUrl.searchParams.set("next", pathname);
    return NextResponse.redirect(loginUrl);
  }

  const { data: profile } = await supabase
    .from("users")
    .select("role")
    .eq("auth_user_id", user.id)
    .single();

  const role: UserRole | null = profile?.role ?? null;

  if (pathname.startsWith("/admin")) {
    if (!role || !isStaffRole(role)) {
      const portalUrl = request.nextUrl.clone();
      portalUrl.pathname = isClientRole(role ?? "") ? "/portal" : "/login";
      return NextResponse.redirect(portalUrl);
    }
  }

  if (pathname.startsWith("/portal")) {
    if (!role || !isClientRole(role)) {
      const adminUrl = request.nextUrl.clone();
      adminUrl.pathname = isStaffRole(role ?? "") ? "/admin" : "/login";
      return NextResponse.redirect(adminUrl);
    }
  }

  return supabaseResponse;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)"],
};
