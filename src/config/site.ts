/**
 * Central site configuration for RestroNex.
 * Single source of truth for brand copy used across marketing,
 * auth and application surfaces.
 */
export const siteConfig = {
  name: "RestroNex",
  tagline: "One platform. Every restaurant.",
  description:
    "Manage billing, orders, kitchen operations, inventory, customers and multiple outlets from one powerful restaurant platform.",

  /** Current greenfield build phase (master spec §43). */
  buildPhase: 0,
  buildPhaseName: "Project Foundation",
  totalPhases: 26,

  links: {
    home: "/",
    features: "/features",
    pricing: "/pricing",
    login: "/login",
    signup: "/signup",
    dashboard: "/dashboard",
    admin: "/admin",
  },
} as const;

export const marketingNav = [
  { label: "Features", href: "/features" },
  { label: "Pricing", href: "/pricing" },
] as const;

export type MarketingNavHref = (typeof marketingNav)[number]["href"];
