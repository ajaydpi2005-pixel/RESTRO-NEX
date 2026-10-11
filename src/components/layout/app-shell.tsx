"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import {
  BarChart3,
  Armchair,
  BookOpen,
  Boxes,
  ChefHat,
  Globe,
  LayoutDashboard,
  LogOut,
  Menu,
  ReceiptText,
  Settings2,
  ShieldCheck,
  Users,
  type LucideIcon,
  Wallet,
  Truck,
} from "lucide-react";
import { Logo } from "@/components/brand/logo";
import { signOutAction } from "@/modules/auth/actions";
import { ThemeToggle } from "@/components/theme-toggle";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import {
  Sheet,
  SheetContent,
  SheetTrigger,
} from "@/components/ui/sheet";
import { adminModule, appModules, appNavGroups, getModuleByPath, type AppPath } from "@/config/modules";
import { siteConfig } from "@/config/site";
import { cn } from "@/lib/utils";

const moduleIcons: Record<AppPath, LucideIcon> = {
  "/dashboard": LayoutDashboard,
  "/pos": ReceiptText,
  "/floor": Armchair,
  "/payments": Wallet,
  "/kitchen": ChefHat,
  "/menu": BookOpen,
  "/inventory": Boxes,
  "/purchasing": Truck,
  "/customers": Users,
  "/reports": BarChart3,
  "/settings": Settings2,
};

function SidebarNav({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();

  return (
    <nav className="flex-1 space-y-5 overflow-y-auto px-3 py-4 scrollbar-slim" aria-label="Application">
      {appNavGroups.map((group) => (
        <div key={group.label}>
          <p className="mb-1.5 px-3 text-[11px] font-semibold tracking-widest text-sidebar-foreground/40 uppercase">
            {group.label}
          </p>
          <ul className="space-y-0.5">
            {group.paths.map((path) => {
              const navModule = appModules.find((m) => m.path === path);
              if (!navModule) return null;
              const Icon = moduleIcons[path];
              const active = pathname.startsWith(path);
              return (
                <li key={path}>
                  <Link
                    href={path}
                    onClick={onNavigate}
                    aria-current={active ? "page" : undefined}
                    className={cn(
                      "relative flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
                      active
                        ? "bg-sidebar-accent text-sidebar-accent-foreground"
                        : "text-sidebar-foreground/70 hover:bg-sidebar-accent/60 hover:text-sidebar-foreground",
                    )}
                  >
                    {active ? (
                      <span aria-hidden className="absolute top-1/2 left-0 h-4 w-0.5 -translate-y-1/2 rounded-full bg-sidebar-primary" />
                    ) : null}
                    <Icon className="size-4 shrink-0" />
                    {navModule.title}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}

function SidebarFooter({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <div className="space-y-3 border-t border-sidebar-border px-4 py-4">
      <Link
        href={adminModule.path}
        onClick={onNavigate}
        className="flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-sm font-medium text-sidebar-foreground/70 transition-colors hover:bg-sidebar-accent/60 hover:text-sidebar-foreground"
      >
        <ShieldCheck className="size-4 shrink-0 text-sidebar-primary" />
        Super Admin
      </Link>
      <Badge
        variant="outline"
        className="w-full justify-center border-sidebar-border text-sidebar-foreground/60"
      >
        Phase {siteConfig.buildPhase} · {siteConfig.buildPhaseName}
      </Badge>
    </div>
  );
}

/**
 * Restaurant application shell: brand sidebar, topbar and mobile drawer.
 * Operational screens prioritise speed and clarity (spec §41).
 */
export function AppShell({
  children,
  userEmail,
}: {
  children: React.ReactNode;
  userEmail?: string | null;
}) {
  const pathname = usePathname();
  const [mobileOpen, setMobileOpen] = useState(false);
  const activeModule = getModuleByPath(pathname);

  return (
    <div className="min-h-dvh">
      {/* Desktop sidebar */}
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-64 flex-col bg-sidebar text-sidebar-foreground lg:flex print:hidden">
        <div className="flex h-14 items-center gap-2.5 border-b border-sidebar-border px-4">
          <Link href="/dashboard" onClick={() => setMobileOpen(false)} aria-label="RestroNex dashboard">
            <Logo className="text-sidebar-foreground" />
          </Link>
        </div>
        <SidebarNav />
        <SidebarFooter />
      </aside>

      {/* Content column */}
      <div className="flex min-h-dvh flex-col lg:pl-64 print:min-h-0 print:pl-0">
        <header className="print:hidden sticky top-0 z-20 flex h-14 items-center gap-3 border-b border-border bg-background/90 px-4 backdrop-blur supports-[backdrop-filter]:bg-background/70 sm:px-6">
          <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
            <SheetTrigger asChild>
              <Button variant="ghost" size="icon" className="lg:hidden" aria-label="Open navigation">
                <Menu className="size-5" />
              </Button>
            </SheetTrigger>
            <SheetContent side="left" className="w-72 bg-sidebar p-0 text-sidebar-foreground">
              <div className="flex h-14 items-center border-b border-sidebar-border px-4">
                <Logo className="text-sidebar-foreground" />
              </div>
              <div className="flex h-[calc(100%-3.5rem)] flex-col">
                <SidebarNav onNavigate={() => setMobileOpen(false)} />
                <SidebarFooter onNavigate={() => setMobileOpen(false)} />
              </div>
            </SheetContent>
          </Sheet>

          <h2 className="truncate text-sm font-semibold">
            {activeModule?.title ?? "RestroNex"}
          </h2>

          <div className="ml-auto flex items-center gap-1.5">
            <Button variant="ghost" size="sm" asChild className="hidden text-muted-foreground sm:inline-flex">
              <Link href="/">
                <Globe className="size-4" />
                View site
              </Link>
            </Button>
            <ThemeToggle />
            <Separator orientation="vertical" className="mx-1 hidden h-6 sm:block" />
            {userEmail ? (
              <div className="flex items-center gap-1.5">
                <Button variant="ghost" size="sm" asChild className="max-w-44 text-muted-foreground">
                  <Link href="/account" title={userEmail}>
                    <span className="truncate">{userEmail}</span>
                  </Link>
                </Button>
                <form action={signOutAction}>
                  <Button type="submit" variant="outline" size="sm">
                    <LogOut className="size-4" />
                    <span className="hidden sm:inline">Sign out</span>
                  </Button>
                </form>
              </div>
            ) : (
              <Button variant="outline" size="sm" asChild>
                <Link href="/login">Sign in</Link>
              </Button>
            )}
          </div>
        </header>

        <main className="flex-1 px-4 py-6 sm:px-6 lg:px-8 print:p-0">
          <div className="mx-auto w-full max-w-6xl">{children}</div>
        </main>
      </div>
    </div>
  );
}
