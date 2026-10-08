import Link from "next/link";
import {
  Activity,
  ArrowRight,
  BarChart3,
  Armchair,
  BookOpen,
  Boxes,
  Building2,
  ChefHat,
  Database,
  LayoutDashboard,
  ReceiptText,
  ScrollText,
  Settings2,
  ShieldCheck,
  Users,
  type LucideIcon,
  Wallet,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { appModules, type AppPath } from "@/config/modules";
import { siteConfig } from "@/config/site";

const moduleIcons: Record<AppPath, LucideIcon> = {
  "/dashboard": LayoutDashboard,
  "/pos": ReceiptText,
  "/floor": Armchair,
  "/payments": Wallet,
  "/kitchen": ChefHat,
  "/menu": BookOpen,
  "/inventory": Boxes,
  "/customers": Users,
  "/reports": BarChart3,
  "/settings": Settings2,
};

const restaurantFormats = [
  "Restaurants",
  "Cafés",
  "Bakeries",
  "Dessert & waffle shops",
  "QSRs & fast food",
  "Fine dining",
  "Juice shops",
  "Food courts",
  "Cloud kitchens",
  "Takeaway",
  "Multi-brand kitchens",
  "Restaurant chains",
];

const foundations: { icon: LucideIcon; title: string; description: string }[] = [
  {
    icon: Database,
    title: "Multi-tenant by design",
    description:
      "Every restaurant is an isolated tenant. Separation is enforced at the frontend, server and database layers with PostgreSQL Row Level Security.",
  },
  {
    icon: ShieldCheck,
    title: "Server-side validation",
    description:
      "Prices, taxes, discounts, roles and payment status are never trusted from the client. Every mutation is validated server-side.",
  },
  {
    icon: ScrollText,
    title: "Ledger-grade records",
    description:
      "Inventory movements, loyalty points and cash sessions are tracked as traceable ledgers — quantities are never silently overwritten.",
  },
  {
    icon: Activity,
    title: "Full audit trail",
    description:
      "Who changed what, when, at which outlet: staff, permissions, prices, refunds, stock and subscriptions are all recorded.",
  },
];

export default function HomePage() {
  return (
    <div>
      {/* Hero */}
      <section className="relative overflow-hidden border-b border-border/60">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 top-0 h-125 bg-[radial-gradient(60%_60%_at_50%_0%,rgb(212_180_119/0.14),transparent)]"
        />
        <div className="mx-auto flex w-full max-w-6xl flex-col items-center px-4 py-20 text-center sm:px-6 sm:py-28">
          <Badge variant="outline" className="mb-6 gap-2 border-gold/50 text-muted-foreground">
            <span aria-hidden className="size-1.5 rounded-full bg-gold" />
            Greenfield build — Phase {siteConfig.buildPhase} of {siteConfig.totalPhases - 1}:{" "}
            {siteConfig.buildPhaseName}
          </Badge>

          <h1 className="max-w-3xl font-display text-4xl font-semibold tracking-tight text-balance sm:text-6xl">
            One platform. Every restaurant.
          </h1>

          <p className="mt-6 max-w-2xl text-lg text-pretty text-muted-foreground">
            {siteConfig.description}
          </p>

          <div className="mt-9 flex flex-col gap-3 sm:flex-row">
            <Button size="lg" asChild>
              <Link href="/signup">
                Get started <ArrowRight className="size-4" />
              </Link>
            </Button>
            <Button size="lg" variant="outline" asChild>
              <Link href="/features">Explore features</Link>
            </Button>
          </div>

          <p className="mt-6 text-xs text-muted-foreground">
            Multi-tenant subscription SaaS · from a single café to enterprise restaurant groups
          </p>
        </div>
      </section>

      {/* Restaurant formats */}
      <section className="border-b border-border/60 bg-card/40">
        <div className="mx-auto w-full max-w-6xl px-4 py-10 sm:px-6">
          <p className="mb-5 text-center text-xs font-medium tracking-widest text-muted-foreground uppercase">
            Built for every restaurant format
          </p>
          <ul className="flex flex-wrap items-center justify-center gap-2">
            {restaurantFormats.map((format) => (
              <li
                key={format}
                className="rounded-full border border-border bg-background px-3.5 py-1.5 text-sm text-muted-foreground"
              >
                {format}
              </li>
            ))}
          </ul>
        </div>
      </section>

      {/* Modules */}
      <section className="mx-auto w-full max-w-6xl px-4 py-20 sm:px-6">
        <div className="mx-auto mb-12 max-w-2xl text-center">
          <h2 className="font-display text-3xl font-semibold tracking-tight sm:text-4xl">
            A complete restaurant operating system
          </h2>
          <p className="mt-4 text-muted-foreground">
            Billing, kitchen, inventory, customers and multi-outlet management — one platform, one
            design system, strictly isolated per business.
          </p>
        </div>

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {appModules.map((module) => {
            const Icon = moduleIcons[module.path];
            return (
              <Card key={module.path} className="gap-3">
                <CardHeader>
                  <div className="mb-1 flex size-9 items-center justify-center rounded-lg bg-ink text-gold">
                    <Icon className="size-4.5" />
                  </div>
                  <CardTitle className="text-base">{module.title}</CardTitle>
                  <CardDescription>{module.description}</CardDescription>
                </CardHeader>
                <CardContent>
                  <Badge variant="secondary" className="text-xs">
                    Phase {module.phase}
                  </Badge>
                </CardContent>
              </Card>
            );
          })}
        </div>
      </section>

      {/* Enterprise foundations */}
      <section className="border-y border-border/60 bg-ink text-parchment">
        <div className="mx-auto w-full max-w-6xl px-4 py-20 sm:px-6">
          <div className="mx-auto mb-12 max-w-2xl text-center">
            <p className="mb-3 text-xs font-medium tracking-widest text-gold uppercase">
              Enterprise foundations
            </p>
            <h2 className="font-display text-3xl font-semibold tracking-tight text-balance sm:text-4xl">
              Engineered for trust at every outlet
            </h2>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            {foundations.map((item) => (
              <div
                key={item.title}
                className="rounded-xl border border-parchment/10 bg-parchment/5 p-6"
              >
                <item.icon className="mb-4 size-5 text-gold" />
                <h3 className="mb-2 font-semibold">{item.title}</h3>
                <p className="text-sm leading-relaxed text-parchment/70">{item.description}</p>
              </div>
            ))}
          </div>

          <p className="mt-8 flex items-center justify-center gap-2 text-center text-xs text-parchment/50">
            <Building2 className="size-3.5" />
            Scales from one outlet to 100+ — consolidated owner reporting included
          </p>
        </div>
      </section>

      {/* CTA */}
      <section className="mx-auto w-full max-w-6xl px-4 py-20 sm:px-6">
        <div className="rounded-2xl border border-border bg-card p-8 text-center sm:p-12">
          <h2 className="font-display text-3xl font-semibold tracking-tight">
            Build your restaurant on {siteConfig.name}
          </h2>
          <p className="mx-auto mt-3 max-w-xl text-muted-foreground">
            Self-serve onboarding takes a restaurant from sign-up to POS: business, outlets, tax,
            tables, menu and staff — then straight to billing.
          </p>
          <div className="mt-8 flex flex-col justify-center gap-3 sm:flex-row">
            <Button size="lg" asChild>
              <Link href="/signup">Get started</Link>
            </Button>
            <Button size="lg" variant="outline" asChild>
              <Link href="/pricing">View plans</Link>
            </Button>
          </div>
          <p className="mt-5 text-xs text-muted-foreground">
            Account creation opens when authentication ships in Phase 3.
          </p>
        </div>
      </section>
    </div>
  );
}
