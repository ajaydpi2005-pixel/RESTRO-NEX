import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { sanitizeNext } from "@/modules/auth/schemas";

/**
 * Email link landing route. Supabase redirects here with ?code= (PKCE) after
 * the user clicks a confirmation or password-reset link. Exchanging the code
 * establishes the session, then we continue to the intended page.
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  // Derive the origin from the request's Host header (like the auth
  // actions do) so redirects use the URL the visitor actually used.
  const host = request.headers.get("host") ?? "localhost:3000";
  const proto = request.headers.get("x-forwarded-proto") ?? "http";
  const origin = `${proto}://${host}`;
  const code = searchParams.get("code");
  const errorDescription = searchParams.get("error_description");
  const next = sanitizeNext(searchParams.get("next"));

  if (code) {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      return NextResponse.redirect(new URL(next, origin));
    }
  }

  const target = new URL("/login", origin);
  target.searchParams.set(
    "error",
    errorDescription ?? "This link is invalid or has expired. Please try again.",
  );
  return NextResponse.redirect(target);
}
