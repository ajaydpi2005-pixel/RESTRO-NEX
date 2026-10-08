import Link from "next/link";
import { Globe, ShieldCheck } from "lucide-react";
import { LogoMark } from "@/components/brand/logo";
import { Button } from "@/components/ui/button";

/**
 * RestroNex platform surface — Super Admin.
 * Deliberately separate from the tenant application shell and protected
 * independently once authentication lands (spec §31).
 */
export default function PlatformLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="border-b border-parchment/10 bg-ink text-parchment">
        <div className="mx-auto flex h-14 w-full max-w-6xl items-center justify-between gap-4 px-4 sm:px-6">
          <span className="inline-flex items-center gap-2.5">
            <LogoMark />
            <span className="text-sm font-semibold tracking-tight">
              RestroNex <span className="text-gold">Super Admin</span>
            </span>
            <ShieldCheck className="size-4 text-gold" aria-hidden />
          </span>
          <Button variant="ghost" size="sm" asChild className="text-parchment/80 hover:bg-parchment/10 hover:text-parchment">
            <Link href="/">
              <Globe className="size-4" />
              View site
            </Link>
          </Button>
        </div>
      </header>
      <main className="flex-1 px-4 py-8 sm:px-6">
        <div className="mx-auto w-full max-w-6xl">{children}</div>
      </main>
    </div>
  );
}
