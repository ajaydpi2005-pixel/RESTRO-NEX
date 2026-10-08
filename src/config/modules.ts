/**
 * RestroNex roadmap module registry.
 *
 * Every major application area is described here together with the
 * greenfield phase (master spec §43) that implements it. Placeholder
 * pages render from this registry so the UI always reflects the real
 * plan — never fake functionality or sample data.
 */

export type AppPath =
  | "/dashboard"
  | "/pos"
  | "/floor"
  | "/payments"
  | "/kitchen"
  | "/menu"
  | "/inventory"
  | "/customers"
  | "/reports"
  | "/settings";

export interface AppModule {
  /** Route path inside the restaurant application shell. */
  path: AppPath;
  /** Short navigation label. */
  title: string;
  /** One-line description shown on cards and placeholders. */
  description: string;
  /** Greenfield phase that delivers this module (spec §43). */
  phase: number;
  phaseName: string;
  /** Capabilities planned for the module (factual roadmap, from the spec). */
  planned: string[];
}

export const appModules: AppModule[] = [
  {
    path: "/dashboard",
    title: "Dashboard",
    description: "Owner overview: today's sales, orders, top products and outlet performance.",
    phase: 6,
    phaseName: "Restaurant Onboarding",
    planned: [
      "Today's sales, orders and average order value",
      "Top products and category performance",
      "Payment breakdown and recent transactions",
      "Active kitchen orders and low stock signals",
      "Consolidated multi-outlet performance",
      "Filters: today, yesterday, week, month, custom range, outlet",
    ],
  },
  {
    path: "/pos",
    title: "POS",
    description: "Fast point of sale for dine-in, takeaway and delivery.",
    phase: 8,
    phaseName: "POS + Order Management",
    planned: [
      "Product search and category navigation",
      "Variants, modifiers, add-ons and combos",
      "Dine-in, takeaway and delivery order types",
      "Hold / resume / cancel flows",
      "Discounts, coupons, taxes, service and packaging charges",
      "Cash, UPI, card and split or partial payments",
      "Receipts, invoices, KOTs, reprints and refunds",
    ],
  },
  {
    path: "/floor",
    title: "Floor",
    description: "Live dining room: floors, sections, tables, reservations and dine-in bills.",
    phase: 9,
    phaseName: "Dining Tables + Floor Management",
    planned: [
      "Floors, sections and tables with capacity",
      "Live table status: available, reserved, occupied",
      "Seat guests straight into the POS",
      "Reserve and release tables with notes",
      "Transfer, merge and split dine-in bills",
      "Complete tables once the bill is settled",
    ],
  },
  {
    path: "/payments",
    title: "Payments",
    description: "Payments, split bills, receipts, invoices, refunds and reconciliation.",
    phase: 10,
    phaseName: "Payments + Billing + Receipts",
    planned: [
      "Cash, UPI, card and configurable payment methods",
      "Split, partial and multi-method bills",
      "Numbered invoices and receipts with audited reprints",
      "Refunds with permissions and reasons",
      "Payment status and reconciliation by outlet and IST day",
      "Razorpay abstraction (not connected; no live charges)",
    ],
  },
  {
    path: "/kitchen",
    title: "Kitchen",
    description: "Kitchen Display System with live order queues and station routing.",
    phase: 11,
    phaseName: "KOT + Kitchen Display System",
    planned: [
      "Live order queue per kitchen station",
      "Category-based routing",
      "Order and item timers with priority",
      "NEW → ACCEPTED → PREPARING → READY → COMPLETED flow",
      "Cancelled item notifications and sound alerts",
      "Full-screen, touch-first operation",
    ],
  },
  {
    path: "/menu",
    title: "Menu",
    description: "Universal menu — the single source of truth for every sales channel.",
    phase: 7,
    phaseName: "Universal Menu Management",
    planned: [
      "Categories and subcategories",
      "Products with images, SKU, price, tax and availability",
      "Variants, modifier groups and add-ons",
      "Combos and scheduled availability",
      "Outlet-level pricing and availability",
      "Feeds POS, KDS, online ordering, QR ordering and reports",
    ],
  },
  {
    path: "/inventory",
    title: "Inventory",
    description: "Ingredients, stock levels and a fully traceable movement ledger.",
    phase: 13,
    phaseName: "Recipes + Inventory",
    planned: [
      "Ingredients, raw materials and unit conversions",
      "Stock levels with minimum/maximum thresholds",
      "Adjustments, transfers and wastage",
      "Batch and expiry tracking",
      "Low stock alerts",
      "Recipes that deduct ingredients on completed orders",
    ],
  },
  {
    path: "/customers",
    title: "Customers",
    description: "Customer CRM and loyalty with ledger-based points.",
    phase: 15,
    phaseName: "CRM + Loyalty",
    planned: [
      "Profiles with order history, spend and favourites",
      "Addresses and segmentation",
      "Loyalty accounts with earn and redeem rules",
      "Points balance backed by a transaction ledger",
      "Rewards and coupons",
    ],
  },
  {
    path: "/reports",
    title: "Reports",
    description: "Sales, financial, inventory, staff and customer analytics.",
    phase: 16,
    phaseName: "Reports + Analytics",
    planned: [
      "Daily, weekly, monthly sales by outlet, product and category",
      "Revenue, tax, discounts, refunds and payment reconciliation",
      "Stock, consumption, purchase, wastage and food cost",
      "Cashier activity, discounts, refunds and order stats",
      "New vs returning customers and loyalty analytics",
      "Date and outlet filters, search, pagination, CSV/Excel export",
    ],
  },
  {
    path: "/settings",
    title: "Settings",
    description: "Business, outlet, tax, tables, kitchen and staff configuration.",
    phase: 4,
    phaseName: "Business + Outlet Management",
    planned: [
      "Business and outlet profiles",
      "Tax configuration",
      "Tables, floors and sections",
      "Kitchen stations",
      "Staff invitations, roles and outlet access",
      "Subscription and entitlement status",
    ],
  },
];

/** Sidebar groupings for the restaurant application shell. */
export const appNavGroups: { label: string; paths: AppPath[] }[] = [
  { label: "Overview", paths: ["/dashboard"] },
  { label: "Operations", paths: ["/pos", "/floor", "/payments", "/kitchen", "/menu"] },
  { label: "Management", paths: ["/inventory", "/customers"] },
  { label: "Insights", paths: ["/reports"] },
  { label: "System", paths: ["/settings"] },
];

/** Super Admin console — protected separately (spec §31, delivered in Phase 19). */
export const adminModule = {
  path: "/admin",
  title: "Super Admin",
  description:
    "Platform-level console for RestroNex operators: tenants, plans, entitlements and system health.",
  phase: 19,
  phaseName: "Super Admin",
  planned: [
    "Tenant, business and outlet management",
    "User management",
    "Subscription and plan management",
    "Feature entitlements",
    "Platform usage and integration status",
    "Support tools, audit logs and system health",
  ],
} as const;

export function getModuleByPath(pathname: string): AppModule | undefined {
  return appModules.find((m) => pathname.startsWith(m.path));
}

/** Strict module accessor for pages — throws on unknown paths (a dev-time bug). */
export function getModule(path: AppPath): AppModule {
  const found = appModules.find((m) => m.path === path);
  if (!found) {
    throw new Error(`[RestroNex] Unknown application module: ${path}`);
  }
  return found;
}
