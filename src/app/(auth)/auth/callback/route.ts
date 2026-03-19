/**
 * Auth callback handler.
 *
 * Two auth flows land here:
 *
 * 1. PKCE / OAuth (Google login): Supabase redirects with ?code=...
 *    → Server-side: exchange code for session, look up role, redirect.
 *
 * 2. Email invite / magic link (implicit flow): Supabase redirects with
 *    #access_token=...&type=invite (hash fragment, invisible to server).
 *    → Server sees no ?code, so we return an HTML page with inline JS
 *      that extracts the hash, calls supabase.auth.getSession(), and
 *      redirects to /auth/callback/complete?ready=1 to finalize server-side.
 */

import { createServerClient } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getOrCreateUserRecord } from "@/lib/server/auth-context";
import { STAFF_ROLES } from "@/lib/shared/constants";

export async function GET(request: NextRequest) {
  const { searchParams, origin } = request.nextUrl;
  const code = searchParams.get("code");
  const next = searchParams.get("next") ?? "/";

  // ── Flow 1: PKCE / OAuth code exchange ──────────────────────────────
  if (code) {
    return handleCodeExchange(request, code, next, origin);
  }

  // ── Flow 2: Hash fragment (email invite / magic link) ───────────────
  // Return a lightweight HTML page that processes the hash client-side.
  // The Supabase JS client in the browser will read #access_token from the
  // URL hash and establish the session automatically.
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";

  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Signing in...</title>
<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js"></script>
</head><body>
<p style="font-family:sans-serif;text-align:center;margin-top:40vh">Signing you in...</p>
<script>
(async function() {
  try {
    var sb = supabase.createClient("${supabaseUrl}", "${supabaseAnonKey}");

    // Hash fragment: #access_token=...&refresh_token=...&type=invite
    var hash = window.location.hash.substring(1);
    if (!hash) {
      window.location.href = "/login?error=missing_token";
      return;
    }

    var params = new URLSearchParams(hash);
    var accessToken = params.get("access_token");
    var refreshToken = params.get("refresh_token");

    if (!accessToken || !refreshToken) {
      window.location.href = "/login?error=missing_token";
      return;
    }

    var { error } = await sb.auth.setSession({
      access_token: accessToken,
      refresh_token: refreshToken,
    });

    if (error) {
      window.location.href = "/login?error=session_failed";
      return;
    }

    // Session is now in cookies. Hit the complete endpoint to do
    // server-side role lookup and redirect.
    window.location.href = "/auth/callback/complete";
  } catch(e) {
    console.error("Auth callback error:", e);
    window.location.href = "/login?error=callback_exception";
  }
})();
</script>
</body></html>`;

  return new NextResponse(html, {
    headers: { "Content-Type": "text/html" },
  });
}

// ── PKCE code exchange (Google OAuth, magic link w/ PKCE) ──────────────

async function handleCodeExchange(
  _request: NextRequest,
  code: string,
  next: string,
  origin: string,
) {
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

  return finalizeSession(supabase, origin, next);
}

// ── Shared: look up role and redirect ──────────────────────────────────

async function finalizeSession(
  supabase: ReturnType<typeof createServerClient>,
  origin: string,
  next: string,
) {
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.redirect(`${origin}/login?error=no_user`);
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
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
