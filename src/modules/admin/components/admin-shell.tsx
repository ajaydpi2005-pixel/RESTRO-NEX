import Link from "next/link";
import type { ReactNode } from "react";
import { ShieldCheck } from "lucide-react";
import { LogoMark } from "@/components/brand/logo";
import { OPERATOR_ROLE_LABELS, type OperatorRole } from "../access";
import { operatorSignOutAction } from "../auth-actions";

const NAV: { href: string; label: string }[] = [
  { href: "/admin", label: "Overview" },
  { href: "/admin/businesses", label: "Businesses" },
  { href: "/admin/outlets", label: "Outlets" },
  { href: "/admin/users", label: "Users" },
  { href: "/admin/subscriptions", label: "Subscriptions" },
  { href: "/admin/plans", label: "Plans" },
  { href: "/admin/entitlements", label: "Entitlements" },
  { href: "/admin/usage", label: "Usage" },
  { href: "/admin/integrations", label: "Integrations" },
  { href: "/admin/support", label: "Support" },
  { href: "/admin/audit", label: "Audit log" },
  { href: "/admin/health", label: "Platform health" },
  { href: "/admin/operators", label: "Operators" },
];

/**
 * Super Admin chrome. Deliberately distinct from the restaurant app shell, so
 * no one mistakes operator tools for a tenant screen.
 */
export function AdminShell({
  email,
  role,
  children,
}: {
  email: string;
  role: OperatorRole;
  children: ReactNode;
}) {
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="border-parchment/10 bg-ink text-parchment border-b">
        <div className="mx-auto flex h-14 w-full max-w-7xl items-center justify-between gap-4 px-4 sm:px-6">
          <span className="inline-flex items-center gap-2.5">
            <LogoMark />
            <span className="text-sm font-semibold tracking-tight">
              RestroNex <span className="text-gold">Super Admin</span>
            </span>
            <ShieldCheck className="text-gold size-4" aria-hidden />
          </span>
          <div className="flex items-center gap-4 text-xs">
            <span className="text-parchment/70 hidden sm:inline">
              {email} · {OPERATOR_ROLE_LABELS[role]}
            </span>
            <form action={operatorSignOutAction}>
              <button
                type="submit"
                className="text-parchment/80 underline-offset-4 hover:underline"
              >
                Sign out
              </button>
            </form>
          </div>
        </div>
        <nav aria-label="Super Admin" className="border-parchment/10 border-t">
          <ul className="mx-auto flex w-full max-w-7xl gap-1 overflow-x-auto px-3 py-1.5 sm:px-6">
            {NAV.map((item) => (
              <li key={item.href}>
                <Link
                  href={item.href}
                  className="text-parchment/80 hover:bg-parchment/10 hover:text-parchment block rounded-md px-3 py-1.5 text-sm whitespace-nowrap"
                >
                  {item.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      </header>
      <main className="bg-background flex-1 px-4 py-8 sm:px-6">
        <div className="mx-auto w-full max-w-7xl space-y-6">{children}</div>
      </main>
    </div>
  );
}
