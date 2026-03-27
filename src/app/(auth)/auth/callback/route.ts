/**
 * Auth callback handler.
 *
 * Three auth flows land here:
 *
 * 1. PKCE / OAuth (Google login): Supabase redirects with ?code=...
 *    → Server-side: exchange code for session, look up role, redirect.
 *
 * 2. Token hash (signInWithOtp PKCE / newer magic links): Supabase redirects
 *    with ?token_hash=...&type=magiclink (or email).
 *    → Server-side: verifyOtp, establish session, look up role, redirect.
 *
 * 3. Email invite / magic link (implicit flow): Supabase redirects with
 *    #access_token=...&type=invite (hash fragment, invisible to server).
 *    → Server sees no ?code or ?token_hash, so we return an HTML page with
 *      inline JS that extracts the hash, calls supabase.auth.setSession(),
 *      and redirects to /auth/callback/complete to finalize server-side.
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
  const tokenHash = searchParams.get("token_hash");
  const type = searchParams.get("type");
  const next = searchParams.get("next") ?? "/";

  // ── Flow 1: PKCE / OAuth code exchange ──────────────────────────────
  if (code) {
    return handleCodeExchange(request, code, next, origin);
  }

  // ── Flow 2: Token hash (signInWithOtp PKCE, newer Supabase magic links)
  // signInWithOtp with PKCE enabled sends ?token_hash=...&type=magiclink
  if (tokenHash && type) {
    return handleTokenHash(request, tokenHash, type, origin);
  }

  // ── Flow 3: Hash fragment (email invite / magic link implicit) ───────
  // The hash fragment (#access_token=...) is invisible to the server, so
  // we redirect to a client component page that:
  //   1. Reads the hash with window.location.hash
  //   2. Calls createBrowserClient (from @supabase/ssr) — writes to cookies
  //   3. Redirects to /auth/callback/complete (server reads cookies)
  //
  // JavaScript window.location assignments preserve the hash, so the
  // redirect from route handler → client page keeps the hash intact.
  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Signing in...</title></head>
<body>
<p style="font-family:sans-serif;text-align:center;margin-top:40vh">Signing you in...</p>
<script>
// Redirect to the client component that handles hash fragments properly.
// window.location.hash is preserved in JavaScript-initiated navigations.
window.location.replace("/auth/callback-hash" + window.location.hash);
</script>
</body></html>`;

  return new NextResponse(html, {
    headers: { "Content-Type": "text/html" },
  });
}

// ── Token hash exchange (signInWithOtp PKCE / newer magic links) ───────

async function handleTokenHash(
  _request: NextRequest,
  tokenHash: string,
  type: string,
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

  const { error } = await supabase.auth.verifyOtp({
    token_hash: tokenHash,
    type: type as "signup" | "invite" | "magiclink" | "recovery" | "email_change" | "email",
  });

  if (error) {
    return NextResponse.redirect(`${origin}/login?error=verify_failed`);
  }

  return finalizeSession(supabase, origin, "/");
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
