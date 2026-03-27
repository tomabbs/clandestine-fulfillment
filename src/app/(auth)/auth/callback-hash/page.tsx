"use client";

/**
 * Hash-fragment auth handler.
 *
 * This page handles the implicit-flow magic link case where Supabase
 * redirects to /auth/callback#access_token=...&refresh_token=...
 *
 * The /auth/callback route handler can't process the hash (server never
 * sees URL fragments), so it redirects here via JavaScript. This page
 * uses createBrowserClient from @supabase/ssr — which writes the session
 * to cookies — so that /auth/callback/complete can read it server-side.
 */

import { createBrowserClient } from "@supabase/ssr";
import { useRouter } from "next/navigation";
import { useEffect } from "react";

export default function CallbackHashPage() {
  const router = useRouter();

  useEffect(() => {
    const hash = window.location.hash.substring(1);

    if (!hash) {
      router.replace("/login?error=missing_token");
      return;
    }

    const params = new URLSearchParams(hash);
    const accessToken = params.get("access_token");
    const refreshToken = params.get("refresh_token");

    if (!accessToken || !refreshToken) {
      router.replace("/login?error=missing_token");
      return;
    }

    // createBrowserClient (from @supabase/ssr) stores the session in
    // cookies, not localStorage — so /auth/callback/complete can read it
    // server-side via createServerClient.
    const supabase = createBrowserClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    );

    supabase.auth
      .setSession({ access_token: accessToken, refresh_token: refreshToken })
      .then(({ error }) => {
        if (error) {
          router.replace("/login?error=session_failed");
        } else {
          router.replace("/auth/callback/complete");
        }
      });
  }, [router]);

  return (
    <p style={{ fontFamily: "sans-serif", textAlign: "center", marginTop: "40vh" }}>
      Signing you in...
    </p>
  );
}
