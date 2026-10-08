import type { ReactElement } from "react";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { ActionRedirectFallback } from "@/components/action-redirect-fallback";

/**
 * True when the incoming request is (or could be) a Server Action submission:
 * a POST whose body is form-encoded. Next treats every multipart/urlencoded
 * POST to a page route as a possible action request.
 */
export async function isActionLikePost(): Promise<boolean> {
  const h = await headers();
  if (h.get("next-action")) return true;
  const contentType = h.get("content-type") ?? "";
  return (
    contentType.startsWith("multipart/form-data") ||
    contentType.startsWith("application/x-www-form-urlencoded")
  );
}

/**
 * Access-guard redirect that is safe during Server Action replays.
 *
 * Throwing `redirect()` while Next re-renders the page for an action POST
 * response makes the framework re-dispatch the same POST to the redirect
 * target. The body stream was already consumed by the first pass, so the
 * replay dies with `TypeError: Failed to parse body as FormData` and the
 * caller gets a bare 500 (verified live: cashier posting a staff form without
 * `staff.view`, expired-session form submits, etc.).
 *
 * Normal navigations keep the real 3xx redirect. Action POSTs render a tiny
 * client-side redirect instead — same outcome for the user, no replay crash.
 */
export async function guardRedirect(href: string): Promise<ReactElement> {
  if (!(await isActionLikePost())) {
    redirect(href);
  }
  return <ActionRedirectFallback href={href} />;
}
