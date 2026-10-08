import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

/**
 * RestroNex request proxy (Next 16 successor to middleware).
 *
 * Responsibilities:
 *  - refresh the Supabase session cookie on every matched request
 *  - redirect unauthenticated users away from protected routes to /login
 *  - redirect signed-in users away from the auth entry pages
 *
 * Layout-level guards still re-verify the session server-side; this proxy
 * is the fast outer fence, not the only one.
 */

const PROTECTED_PREFIXES = [
  "/dashboard",
  "/pos",
  "/kitchen",
  "/menu",
  "/inventory",
  "/customers",
  "/reports",
  "/settings",
  "/account",
];

const AUTH_PAGES = ["/login", "/signup"];

function matches(pathname: string, prefixes: string[]): boolean {
  return prefixes.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

export async function proxy(request: NextRequest) {
  let response = NextResponse.next({ request });

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    // Supabase not configured yet: never break the site over auth.
    return response;
  }

  const supabase = createServerClient(url, anonKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        cookiesToSet.forEach(({ name, value }) => {
          request.cookies.set(name, value);
        });
        response = NextResponse.next({ request });
        cookiesToSet.forEach(({ name, value, options }) => {
          response.cookies.set(name, value, options);
        });
      },
    },
  });

  // Refreshes the session token when needed; must run before reading user.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { pathname } = request.nextUrl;

  if (matches(pathname, PROTECTED_PREFIXES) && !user) {
    const target = new URL("/login", request.url);
    target.searchParams.set("next", pathname);
    return NextResponse.redirect(target);
  }

  if (matches(pathname, AUTH_PAGES) && user) {
    return NextResponse.redirect(new URL("/dashboard", request.url));
  }

  return response;
}

export const config = {
  matcher: [
    "/dashboard/:path*",
    "/pos/:path*",
    "/kitchen/:path*",
    "/menu/:path*",
    "/inventory/:path*",
    "/customers/:path*",
    "/reports/:path*",
    "/settings/:path*",
    "/account/:path*",
    "/login",
    "/signup",
  ],
};
