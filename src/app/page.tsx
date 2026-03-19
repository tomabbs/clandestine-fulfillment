"use client";

import { createBrowserClient } from "@supabase/ssr";
import { useRouter } from "next/navigation";
import { useEffect, useRef } from "react";

export default function Home() {
  const router = useRouter();
  const handled = useRef(false);

  useEffect(() => {
    if (handled.current) return;
    handled.current = true;

    (async () => {
      const hash = window.location.hash;

      // Supabase email invite lands here with #access_token=...&refresh_token=...
      if (hash && hash.includes("access_token")) {
        const params = new URLSearchParams(hash.substring(1));
        const accessToken = params.get("access_token");
        const refreshToken = params.get("refresh_token");

        if (accessToken && refreshToken) {
          const supabase = createBrowserClient(
            process.env.NEXT_PUBLIC_SUPABASE_URL ?? "",
            process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "",
          );

          const { error } = await supabase.auth.setSession({
            access_token: accessToken,
            refresh_token: refreshToken,
          });

          if (!error) {
            router.replace("/auth/callback/complete");
            return;
          }
        }
      }

      // No auth tokens — go to login
      router.replace("/login");
    })();
  }, [router]);

  return (
    <div className="flex min-h-screen items-center justify-center">
      <p className="text-sm text-muted-foreground">Loading...</p>
    </div>
  );
}
