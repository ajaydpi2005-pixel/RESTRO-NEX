import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

/**
 * RestroNex request proxy (Next 16 successor to middleware).
 *
 * Responsibilities:
 *  - refresh the Supabase session cookie on every matched request
 *  - redirect unauthenticated users away from protected routes to /login
 *  - redirect signed-in users away from the auth entry pages
 *  - send anonymous visitors under /admin to the operator sign-in page
 *
 * Layout-level guards still re-verify the session server-side; this proxy
 * is the fast outer fence, not the only one.
 */

const PROTECTED_PREFIXES = [
  "/dashboard",
  "/pos",
  "/kitchen",
  "/waiter",
  "/menu",
  "/inventory",
  "/purchasing",
  "/customers",
  "/reports",
  "/settings",
  "/account",
];

const AUTH_PAGES = ["/login", "/signup"];

const ADMIN_SIGN_IN = "/admin/sign-in";

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

  // A 3xx redirect returned for a form-encoded POST (a Server Action
  // submission) makes the framework replay the POST against the redirect
  // target; the body stream is already consumed by then and the replay dies
  // with "Failed to parse body as FormData" (bare 500). For those requests
  // we pass through and let the app-level guards (guardRedirect) render a
  // client-side redirect instead.
  const contentType = request.headers.get("content-type") ?? "";
  const isActionLikePost =
    request.method === "POST" &&
    (request.headers.get("next-action") !== null ||
      contentType.startsWith("multipart/form-data") ||
      contentType.startsWith("application/x-www-form-urlencoded"));

  // Super Admin: anonymous visitors go to the operator sign-in page. Signed-in
  // non-operators are refused by the layout (404), not here, so the proxy does
  // not reveal whether the area exists.
  if (matches(pathname, ["/admin"]) && !matches(pathname, [ADMIN_SIGN_IN]) && !user) {
    if (isActionLikePost) return response;
    return NextResponse.redirect(new URL(ADMIN_SIGN_IN, request.url));
  }

  if (matches(pathname, PROTECTED_PREFIXES) && !user) {
    if (isActionLikePost) return response;
    const target = new URL("/login", request.url);
    target.searchParams.set("next", pathname);
    return NextResponse.redirect(target);
  }

  if (matches(pathname, AUTH_PAGES) && user) {
    if (isActionLikePost) return response;
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
    "/purchasing/:path*",
    "/customers/:path*",
    "/reports/:path*",
    "/settings/:path*",
    "/account/:path*",
    "/admin/:path*",
    "/login",
    "/signup",
  ],
};
