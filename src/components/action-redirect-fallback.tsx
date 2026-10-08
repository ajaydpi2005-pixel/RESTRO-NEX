"use client";

import { useEffect } from "react";

/**
 * Client-side redirect used by `guardRedirect()` when a render-path access
 * guard fires during a Server Action POST replay (where throwing `redirect()`
 * crashes the response). Works both as hydrated HTML and when streamed back
 * through the action flight payload. The <noscript> meta-refresh covers
 * script-less MPA form submissions.
 */
export function ActionRedirectFallback({ href }: { href: string }) {
  useEffect(() => {
    window.location.replace(href);
  }, [href]);

  return (
    <div className="flex min-h-[40vh] flex-col items-center justify-center gap-2 p-8 text-center">
      <p className="text-sm text-muted-foreground">
        Redirecting…{" "}
        <a href={href} className="font-medium text-gold-deep underline underline-offset-4 dark:text-gold">
          Continue
        </a>
      </p>
      <noscript>
        <meta httpEquiv="refresh" content={`0; url=${href}`} />
      </noscript>
    </div>
  );
}
