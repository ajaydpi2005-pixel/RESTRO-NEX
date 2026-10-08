import { cn } from "@/lib/utils";

/**
 * RestroNex brand mark — a champagne-gold service cloche on a deep
 * green-black tile. Original artwork; do not reuse the reference
 * product's identity (see master spec §05 / §45).
 */
export function LogoMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 32 32"
      fill="none"
      role="img"
      aria-label="RestroNex logo"
      className={cn("size-8 shrink-0", className)}
    >
      <rect width="32" height="32" rx="9" fill="#101B19" />
      <path
        d="M9 20a7 7 0 0 1 14 0"
        stroke="#D4B477"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <path d="M6.5 23.5h19" stroke="#D4B477" strokeWidth="2" strokeLinecap="round" />
      <circle cx="16" cy="10.4" r="1.7" fill="#D4B477" />
    </svg>
  );
}

interface LogoProps {
  withWordmark?: boolean;
  className?: string;
  markClassName?: string;
}

/** Logo lockup: mark + "RestroNex" wordmark. */
export function Logo({ withWordmark = true, className, markClassName }: LogoProps) {
  return (
    <span className={cn("inline-flex items-center gap-2.5", className)}>
      <LogoMark className={markClassName} />
      {withWordmark ? (
        <span className="text-lg font-semibold tracking-tight text-foreground">
          Restro<span className="text-gold-deep dark:text-gold">Nex</span>
        </span>
      ) : null}
    </span>
  );
}
