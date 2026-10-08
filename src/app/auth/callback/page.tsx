"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef } from "react";
import { createClient } from "@/lib/supabase/client";
import { sanitizeNext } from "@/modules/auth/schemas";

const LINK_ERROR = "This link is invalid or has expired. Please try again.";

/**
 * Fallback landing page for auth links that carry their tokens in the URL
 * FRAGMENT (`#access_token=…&refresh_token=…`) — the "implicit" flow used by
 * legacy or admin-generated Supabase links.
 *
 * RestroNex's own emails use PKCE (`?code=…`) and land on /auth/confirm;
 * fragments never reach the server, so this client bridge exists purely as a
 * safety net. It stores the session and continues to the intended page.
 */
export default function AuthCallbackPage() {
  const router = useRouter();
  const handled = useRef(false);

  useEffect(() => {
    if (handled.current) return;
    handled.current = true;

    const hash = window.location.hash.startsWith("#") ? window.location.hash.slice(1) : "";
    const params = new URLSearchParams(hash);
    const accessToken = params.get("access_token");
    const refreshToken = params.get("refresh_token");
    const next = sanitizeNext(new URLSearchParams(window.location.search).get("next"));

    const finish = (target: string) => {
      window.history.replaceState(null, "", window.location.pathname);
      router.replace(target);
    };

    if (!accessToken || !refreshToken) {
      finish(`/login?error=${encodeURIComponent(LINK_ERROR)}`);
      return;
    }

    const supabase = createClient();
    supabase.auth
      .setSession({ access_token: accessToken, refresh_token: refreshToken })
      .then(({ error }) =>
        finish(error ? `/login?error=${encodeURIComponent(LINK_ERROR)}` : next),
      )
      .catch(() => finish(`/login?error=${encodeURIComponent(LINK_ERROR)}`));
  }, [router]);

  return (
    <div className="flex min-h-dvh items-center justify-center">
      <p className="text-sm text-muted-foreground">Signing you in…</p>
    </div>
  );
}
