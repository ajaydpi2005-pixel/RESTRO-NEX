import type { Metadata } from "next";
import {
  Armchair,
  BarChart3,
  BookOpen,
  Boxes,
  Building2,
  ChefHat,
  CreditCard,
  HeartHandshake,
  MonitorSmartphone,
  QrCode,
  ReceiptText,
  ShieldCheck,
  Truck,
  type LucideIcon,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export const metadata: Metadata = {
  title: "Features",
  description:
    "POS, kitchen, menu, inventory, purchasing, CRM, loyalty, online ordering, payments, reports and multi-outlet management — the complete RestroNex feature map.",
};

interface FeatureGroup {
  icon: LucideIcon;
  title: string;
  blurb: string;
  phase: number;
  points: string[];
}

const featureGroups: FeatureGroup[] = [
  {
    icon: ReceiptText,
    title: "POS & Billing",
    blurb: "A point of sale built for speed, accuracy and every service style.",
    phase: 8,
    points: [
      "Product search, category navigation, variants, modifiers, add-ons and combos",
      "Dine-in, takeaway and delivery order types",
      "Hold, resume and cancel flows",
      "Discounts, coupons, taxes, service charge and packaging charge",
      "Cash, UPI, card and configurable payment methods with split and partial payments",
      "Receipts, invoices, KOTs, reprints and refunds — transactional, idempotent, minor-unit money",
    ],
  },
  {
    icon: Armchair,
    title: "Tables & Dine-in Operations",
    blurb: "Visual floor management for full-service restaurants.",
    phase: 9,
    points: [
      "Floors, sections and tables with capacity",
      "Statuses: available, occupied, reserved, billing",
      "Create orders directly from a table",
      "Transfer and merge tables",
      "Split bills, request bill, complete bill",
    ],
  },
  {
    icon: ChefHat,
    title: "Kitchen Display System",
    blurb: "A dedicated KDS that keeps the pass moving.",
    phase: 11,
    points: [
      "Live order queue with kitchen stations and category routing",
      "Order and item timers with priority handling",
      "NEW → ACCEPTED → PREPARING → READY → COMPLETED status flow",
      "Cancelled item notifications and sound alerts",
      "Full-screen mode and touch-first controls",
    ],
  },
  {
    icon: MonitorSmartphone,
    title: "Waiter / Captain Ordering",
    blurb: "Mobile and tablet ordering straight from the floor.",
    phase: 12,
    points: [
      "Outlet and table selection",
      "Add products, modifiers and notes",
      "Send orders to the kitchen instantly",
      "Track order status and request the bill",
      "No financial administration permissions by default",
    ],
  },
  {
    icon: BookOpen,
    title: "Universal Menu",
    blurb: "One menu that feeds every channel — POS, KDS, online, QR and reports.",
    phase: 7,
    points: [
      "Categories and subcategories for any cuisine or format",
      "Products with images, SKU, price, tax and availability",
      "Variants, modifier groups, add-ons and combos",
      "Outlet-level pricing and availability",
      "Scheduled availability windows",
    ],
  },
  {
    icon: Boxes,
    title: "Recipes & Inventory",
    blurb: "Real inventory with a traceable movement ledger — never overwritten quantities.",
    phase: 13,
    points: [
      "Ingredients and raw materials with units and conversions",
      "Recipes that deduct ingredients when orders complete — with duplicate-deduction protection",
      "Estimated gross margin from selling price vs ingredient cost",
      "Adjustments, transfers, wastage, batch and expiry tracking",
      "Minimum/maximum stock levels with low-stock alerts",
    ],
  },
  {
    icon: Truck,
    title: "Purchasing & Suppliers",
    blurb: "From purchase order to goods receipt to supplier balance.",
    phase: 14,
    points: [
      "Supplier profiles and balances",
      "Purchase orders with line items",
      "Goods receiving that creates inventory movements",
      "Purchase invoices and history",
    ],
  },
  {
    icon: HeartHandshake,
    title: "CRM & Loyalty",
    blurb: "Know your guests and reward the ones who keep coming back.",
    phase: 15,
    points: [
      "Customer profiles with order history, total spend and favourites",
      "Addresses and segmentation",
      "Loyalty accounts with configurable earn and redeem rules",
      "Points balance backed by a transaction ledger — no duplicate rewards",
      "Rewards and coupons",
    ],
  },
  {
    icon: QrCode,
    title: "Online & QR Ordering",
    blurb: "Your own ordering channels plus aggregator-ready architecture.",
    phase: 17,
    points: [
      "Restaurant website ordering for takeaway and delivery",
      "QR ordering at the table",
      "Integration adapters for Swiggy and Zomato",
      "Clearly labelled demo/sandbox mode until production API access exists",
    ],
  },
  {
    icon: CreditCard,
    title: "Payments",
    blurb: "A payment abstraction that treats money with respect.",
    phase: 10,
    points: [
      "Cash, UPI, card and extensible payment methods",
      "Gateway-ready architecture (Razorpay or equivalent)",
      "Verified provider webhooks and idempotent processing",
      "Payment status is always confirmed server-side",
    ],
  },
  {
    icon: Building2,
    title: "Multi-Outlet & Staff",
    blurb: "From one outlet to 100+, with granular permissions.",
    phase: 5,
    points: [
      "Business → outlet → staff hierarchy",
      "Roles: owner, admin, outlet manager, cashier, waiter, kitchen, inventory, accountant",
      "Granular, server-enforced permissions",
      "Staff invitations, outlet assignments and activation controls",
      "Consolidated owner reporting across outlets",
    ],
  },
  {
    icon: BarChart3,
    title: "Reports & Analytics",
    blurb: "The numbers that run the business, filtered the way you work.",
    phase: 16,
    points: [
      "Sales: daily, weekly, monthly by outlet, product and category",
      "Financial: revenue, tax, discounts, refunds and payment reconciliation",
      "Inventory: stock, consumption, purchases, wastage and food cost",
      "Staff activity and customer analytics",
      "Date and outlet filters, pagination, CSV and Excel export",
    ],
  },
  {
    icon: ShieldCheck,
    title: "Platform & Security",
    blurb: "SaaS-grade protection underneath everything.",
    phase: 23,
    points: [
      "Multi-tenant isolation with PostgreSQL Row Level Security",
      "Subscription plans with server-side entitlement enforcement",
      "Dedicated, separately protected Super Admin console",
      "Audit logs for staff, prices, refunds, stock and settings changes",
      "Email, SMS, WhatsApp and in-app notification architecture",
    ],
  },
];

export default function FeaturesPage() {
  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-16 sm:px-6 sm:py-20">
      <div className="mx-auto mb-14 max-w-2xl text-center">
        <Badge variant="outline" className="mb-4 border-gold/50 text-muted-foreground">
          Feature roadmap
        </Badge>
        <h1 className="font-display text-4xl font-semibold tracking-tight text-balance sm:text-5xl">
          Everything a restaurant needs to operate
        </h1>
        <p className="mt-4 text-lg text-muted-foreground">
          Each capability below ships in a numbered build phase. This page reflects the committed
          roadmap — no vaporware, no inflated claims.
        </p>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        {featureGroups.map((group) => (
          <Card key={group.title} className="gap-3">
            <CardHeader>
              <div className="flex items-start justify-between gap-3">
                <div className="flex size-10 items-center justify-center rounded-lg bg-ink text-gold">
                  <group.icon className="size-5" />
                </div>
                <Badge variant="secondary" className="shrink-0">
                  Phase {group.phase}
                </Badge>
              </div>
              <CardTitle className="mt-2 text-lg">{group.title}</CardTitle>
              <p className="text-sm text-muted-foreground">{group.blurb}</p>
            </CardHeader>
            <CardContent>
              <ul className="space-y-2">
                {group.points.map((point) => (
                  <li key={point} className="flex gap-2.5 text-sm text-muted-foreground">
                    <span aria-hidden className="mt-2 size-1 shrink-0 rounded-full bg-gold" />
                    {point}
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
