import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /**
   * Cache Components / Partial Prefetching are intentionally DISABLED.
   *
   * RestroNex is a fully authenticated multi-tenant dashboard — every route is
   * per-request dynamic, so prerendered shells buy us nothing. Worse, with
   * `cacheComponents` enabled, Next 16 replays Server Action POST responses
   * through a prerender pass that (a) crashes on Supabase's session loader
   * (`Date.now()` during prerender, logged on every request) and (b) turns
   * any `redirect()` encountered during the replay (expired session, missing
   * permission) into a 500 "Failed to parse body as FormData". Verified
   * end-to-end against the live RBAC E2E suite (cashier escalation probes).
   * Re-enable only after upstream fixes action-replay prerendering.
   */
  cacheComponents: false,
  partialPrefetching: false,
  // Phase 16: report exports. pdfkit reads its standard font metrics from disk, so it must stay
  // out of the server bundle.
  serverExternalPackages: ["pdfkit", "exceljs"],
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
