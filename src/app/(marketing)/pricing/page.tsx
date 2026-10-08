import type { Metadata } from "next";
import { Check, Info } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";

export const metadata: Metadata = {
  title: "Pricing",
  description:
    "RestroNex subscription plans: Starter, Growth, Scale and Enterprise. Entitlements and pricing are configured when subscriptions launch.",
};

const plans = [
  {
    name: "Starter",
    audience: "For a single outlet getting started with professional operations.",
    highlight: false,
  },
  {
    name: "Growth",
    audience: "For busy independent restaurants that live on their POS.",
    highlight: true,
  },
  {
    name: "Scale",
    audience: "For multi-outlet groups that need consolidated control.",
    highlight: false,
  },
  {
    name: "Enterprise",
    audience: "For chains and restaurant groups with custom requirements.",
    highlight: false,
  },
];

const configurableLimits = [
  "Outlets",
  "Staff seats",
  "POS terminals",
  "Reports",
  "Inventory",
  "CRM & loyalty",
  "Online ordering",
  "Integrations",
  "Storage",
  "Analytics",
];

const subscriptionStates = ["Trial", "Active", "Past due", "Cancelled", "Expired"];

export default function PricingPage() {
  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-16 sm:px-6 sm:py-20">
      <div className="mx-auto mb-14 max-w-2xl text-center">
        <Badge variant="outline" className="mb-4 border-gold/50 text-muted-foreground">
          Subscription SaaS
        </Badge>
        <h1 className="font-display text-4xl font-semibold tracking-tight text-balance sm:text-5xl">
          Plans for every size of restaurant
        </h1>
        <p className="mt-4 text-lg text-muted-foreground">
          Four plans, configurable entitlements, and server-side enforcement — from your first
          outlet to your hundredth.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {plans.map((plan) => (
          <Card key={plan.name} className="relative gap-3">
            {plan.highlight ? (
              <Badge className="absolute -top-2.5 left-1/2 -translate-x-1/2 border-transparent bg-ink text-gold">
                Most popular tier
              </Badge>
            ) : null}
            <CardHeader>
              <CardTitle className="text-xl">{plan.name}</CardTitle>
              <CardDescription>{plan.audience}</CardDescription>
            </CardHeader>
            <CardContent className="flex-1">
              <p className="text-sm text-muted-foreground">
                Pricing and limits are set per plan when the subscription system launches.
              </p>
            </CardContent>
            <CardFooter>
              <Button className="w-full" disabled aria-disabled="true">
                Available at launch
              </Button>
            </CardFooter>
          </Card>
        ))}
      </div>

      <div className="mt-12 grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Configurable plan limits</CardTitle>
            <CardDescription>
              Each plan&apos;s entitlements are managed by the platform and enforced server-side —
              never only in the UI.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {configurableLimits.map((limit) => (
                <li key={limit} className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Check className="size-4 text-gold-deep dark:text-gold" />
                  {limit}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Subscription lifecycle</CardTitle>
            <CardDescription>
              Subscriptions ship in Phase 20 with a full event history and billing records.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="flex flex-wrap gap-2">
              {subscriptionStates.map((state) => (
                <li key={state}>
                  <Badge variant="secondary">{state}</Badge>
                </li>
              ))}
            </ul>
            <Separator className="my-5" />
            <div className="flex gap-3 rounded-lg bg-muted/60 p-4 text-sm text-muted-foreground">
              <Info className="size-4 shrink-0 translate-y-0.5 text-gold-deep dark:text-gold" />
              <p>
                Plans cannot be purchased yet. The checkout, entitlement enforcement and provider
                webhooks land in Phase 20 — Subscriptions + SaaS Billing.
              </p>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
