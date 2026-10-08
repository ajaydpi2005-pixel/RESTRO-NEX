import Link from "next/link";
import { Logo } from "@/components/brand/logo";

/** Minimal centered layout for authentication screens. */
export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative flex min-h-dvh flex-col items-center justify-center px-4 py-12">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-96 bg-[radial-gradient(55%_60%_at_50%_0%,rgb(212_180_119/0.12),transparent)]"
      />
      <Link href="/" aria-label="RestroNex home" className="relative mb-8">
        <Logo />
      </Link>
      <div className="relative w-full max-w-md">{children}</div>
    </div>
  );
}
