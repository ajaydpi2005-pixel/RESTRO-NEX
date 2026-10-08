import { Suspense } from "react";
import Link from "next/link";
import { Logo } from "@/components/brand/logo";
import { CurrentYear } from "@/components/site/current-year";
import { Separator } from "@/components/ui/separator";
import { siteConfig } from "@/config/site";

const footerColumns: { heading: string; links: { label: string; href: string }[] }[] = [
  {
    heading: "Product",
    links: [
      { label: "Features", href: "/features" },
      { label: "Pricing", href: "/pricing" },
      { label: "POS", href: "/pos" },
      { label: "Kitchen", href: "/kitchen" },
      { label: "Menu", href: "/menu" },
      { label: "Inventory", href: "/inventory" },
      { label: "Reports", href: "/reports" },
    ],
  },
  {
    heading: "Account",
    links: [
      { label: "Log in", href: "/login" },
      { label: "Sign up", href: "/signup" },
      { label: "Dashboard", href: "/dashboard" },
      { label: "Super Admin", href: "/admin" },
    ],
  },
];

export function SiteFooter() {
  return (
    <footer className="border-t border-border bg-card/50">
      <div className="mx-auto grid w-full max-w-6xl gap-10 px-4 py-12 sm:px-6 md:grid-cols-[1.4fr_1fr_1fr]">
        <div className="space-y-3">
          <Logo />
          <p className="max-w-xs text-sm text-muted-foreground">{siteConfig.tagline}</p>
          <p className="max-w-xs text-xs text-muted-foreground/80">
            Premium multi-tenant restaurant POS &amp; management SaaS — built for restaurants,
            cafés, QSRs, cloud kitchens and enterprise chains.
          </p>
        </div>

        {footerColumns.map((column) => (
          <nav key={column.heading} aria-label={column.heading}>
            <h3 className="mb-3 text-sm font-semibold text-foreground">{column.heading}</h3>
            <ul className="space-y-2">
              {column.links.map((link) => (
                <li key={link.href}>
                  <Link
                    href={link.href}
                    className="text-sm text-muted-foreground transition-colors hover:text-foreground"
                  >
                    {link.label}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
        ))}
      </div>

      <Separator />

      <div className="mx-auto flex w-full max-w-6xl flex-col gap-2 px-4 py-5 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between sm:px-6">
        <p>
          ©{" "}
          <Suspense fallback={<span aria-hidden>…</span>}>
            <CurrentYear />
          </Suspense>{" "}
          {siteConfig.name}. Working brand — all rights reserved.
        </p>
        <p>
          Build phase {siteConfig.buildPhase} of {siteConfig.totalPhases - 1} ·{" "}
          {siteConfig.buildPhaseName}
        </p>
      </div>
    </footer>
  );
}
