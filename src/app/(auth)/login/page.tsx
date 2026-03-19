"use client";

import { createBrowserClient } from "@supabase/ssr";
import Image from "next/image";
import { useRef, useState } from "react";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [magicLinkSent, setMagicLinkSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [cooldownUntil, setCooldownUntil] = useState<number | null>(null);

  const supabaseRef = useRef<ReturnType<typeof createBrowserClient> | null>(null);
  function getSupabase() {
    if (!supabaseRef.current) {
      supabaseRef.current = createBrowserClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL ?? "",
        process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "",
      );
    }
    return supabaseRef.current;
  }

  async function handleGoogleLogin() {
    setError(null);
    const { error: oauthError } = await getSupabase().auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo: `${window.location.origin}/auth/callback`,
      },
    });
    if (oauthError) setError(oauthError.message);
  }

  async function handleMagicLink(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    // Client-side cooldown: prevent rapid retries
    if (cooldownUntil && Date.now() < cooldownUntil) {
      const secsLeft = Math.ceil((cooldownUntil - Date.now()) / 1000);
      setError(`Please wait ${secsLeft} seconds before requesting another link.`);
      return;
    }

    setLoading(true);

    const { error: magicError } = await getSupabase().auth.signInWithOtp({
      email,
      options: {
        emailRedirectTo: `${window.location.origin}/auth/callback`,
        shouldCreateUser: false,
      },
    });

    setLoading(false);

    if (magicError) {
      const msg = magicError.message.toLowerCase();
      if (msg.includes("rate") || msg.includes("limit") || msg.includes("exceeded")) {
        setError(
          "Too many sign-in requests. Please check your inbox for an existing link, or wait a few minutes and try again.",
        );
        // Set 60-second client-side cooldown
        setCooldownUntil(Date.now() + 60_000);
      } else if (msg.includes("signups not allowed") || msg.includes("not allowed")) {
        // shouldCreateUser: false returns this when email doesn't exist
        setError("No account found for this email. Please contact your label administrator.");
      } else {
        setError(magicError.message);
      }
    } else {
      setMagicLinkSent(true);
      // Set cooldown after successful send too (prevent resend spam)
      setCooldownUntil(Date.now() + 30_000);
    }
  }

  return (
    <div className="w-full max-w-sm space-y-8">
      <div className="text-center">
        <Image
          src="/logo.webp"
          alt="Clandestine Distribution"
          width={325}
          height={65}
          priority
          className="mx-auto"
        />
        <p className="mt-4 text-sm text-gray-600">Sign in to your account</p>
      </div>

      {error && <div className="rounded-md bg-red-50 p-3 text-sm text-red-700">{error}</div>}

      {/* Staff Login */}
      <div className="space-y-4">
        <h2 className="text-sm font-medium text-gray-700">Staff</h2>
        <button
          type="button"
          onClick={handleGoogleLogin}
          className="flex w-full items-center justify-center gap-2 rounded-md bg-white px-4 py-2 text-sm font-medium text-gray-700 shadow-sm ring-1 ring-gray-300 hover:bg-gray-50"
        >
          Staff Login with Google
        </button>
      </div>

      <div className="relative">
        <div className="absolute inset-0 flex items-center">
          <div className="w-full border-t border-gray-200" />
        </div>
        <div className="relative flex justify-center text-sm">
          <span className="bg-gray-50 px-2 text-gray-500">or</span>
        </div>
      </div>

      {/* Client Login */}
      <div className="space-y-4">
        <h2 className="text-sm font-medium text-gray-700">Client</h2>
        {magicLinkSent ? (
          <div className="space-y-3">
            <div className="rounded-md bg-green-50 p-3 text-sm text-green-700">
              Check your email for a sign-in link.
            </div>
            <button
              type="button"
              onClick={() => {
                setMagicLinkSent(false);
                setError(null);
              }}
              className="text-sm text-blue-600 hover:underline"
            >
              Didn&apos;t receive it? Try again
            </button>
          </div>
        ) : (
          <form onSubmit={handleMagicLink} className="space-y-3">
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@label.com"
              required
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm placeholder-gray-400 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
            <button
              type="submit"
              disabled={loading}
              className="w-full rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-blue-700 disabled:opacity-50"
            >
              {loading ? "Sending..." : "Send Magic Link"}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
