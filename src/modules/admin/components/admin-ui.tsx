import Link from "next/link";
import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PAGE_SIZE, pageHref } from "../format";

/**
 * Shared presentation for the Super Admin dashboard (server-renderable).
 * Rule: a number that was not measured renders as "not measured", never 0.
 */

export function NotMeasured() {
  return <span className="text-muted-foreground text-sm italic">not measured</span>;
}

export function Metric({
  label,
  value,
  note,
}: {
  label: string;
  value: number | string | null | undefined;
  note?: string;
}) {
  return (
    <Card className="gap-2 py-4">
      <CardContent className="space-y-1 px-5">
        <p className="text-muted-foreground text-xs font-medium tracking-wide uppercase">{label}</p>
        <p className="font-display text-2xl font-semibold tabular-nums">
          {value === null || value === undefined ? <NotMeasured /> : value}
        </p>
        {note ? <p className="text-muted-foreground text-xs">{note}</p> : null}
      </CardContent>
    </Card>
  );
}

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div className="space-y-1">
        <h1 className="font-display text-foreground text-3xl font-semibold tracking-tight">
          {title}
        </h1>
        {description ? (
          <p className="text-muted-foreground max-w-3xl text-sm">{description}</p>
        ) : null}
      </div>
      {actions}
    </div>
  );
}

export function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
        {description ? <CardDescription>{description}</CardDescription> : null}
      </CardHeader>
      <CardContent className="space-y-4">{children}</CardContent>
    </Card>
  );
}

export function DataTable({
  headers,
  children,
  empty,
  isEmpty,
}: {
  headers: string[];
  children: ReactNode;
  empty: string;
  isEmpty: boolean;
}) {
  if (isEmpty) {
    return <p className="text-muted-foreground py-6 text-center text-sm">{empty}</p>;
  }
  return (
    <div className="overflow-x-auto rounded-lg border">
      <table className="w-full min-w-[640px] text-left text-sm">
        <thead className="bg-muted/50 text-muted-foreground text-xs tracking-wide uppercase">
          <tr>
            {headers.map((h) => (
              <th key={h} scope="col" className="px-3 py-2 font-medium">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y">{children}</tbody>
      </table>
    </div>
  );
}

export function Cell({ children, className }: { children: ReactNode; className?: string }) {
  return <td className={`px-3 py-2 align-top ${className ?? ""}`}>{children}</td>;
}

const TONE: Record<string, string> = {
  active: "border-emerald-500/40 text-emerald-700 dark:text-emerald-300",
  connected: "border-emerald-500/40 text-emerald-700 dark:text-emerald-300",
  online: "border-emerald-500/40 text-emerald-700 dark:text-emerald-300",
  resolved: "border-emerald-500/40 text-emerald-700 dark:text-emerald-300",
  trial: "border-gold/50 text-gold-deep dark:text-gold",
  open: "border-gold/50 text-gold-deep dark:text-gold",
  waiting_customer: "border-gold/50 text-gold-deep dark:text-gold",
  untested: "border-gold/50 text-gold-deep dark:text-gold",
  suspended: "border-destructive/50 text-destructive",
  error: "border-destructive/50 text-destructive",
  past_due: "border-destructive/50 text-destructive",
  revoked: "border-destructive/50 text-destructive",
  closed: "border-destructive/50 text-destructive",
  urgent: "border-destructive/50 text-destructive",
};

export function StatusBadge({ value }: { value: string | null | undefined }) {
  if (!value) return <NotMeasured />;
  return (
    <Badge variant="outline" className={TONE[value] ?? "text-muted-foreground"}>
      {value.replaceAll("_", " ")}
    </Badge>
  );
}

export function Pager({
  basePath,
  params,
  page,
  total,
}: {
  basePath: string;
  params: Record<string, string>;
  page: number;
  total: number;
}) {
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  return (
    <div className="text-muted-foreground flex items-center justify-between gap-3 text-xs">
      <span>
        {total} total · page {page} of {pages}
      </span>
      <span className="flex gap-2">
        {page > 1 ? (
          <Link
            className="underline underline-offset-4"
            href={pageHref(basePath, params, page - 1)}
          >
            Previous
          </Link>
        ) : null}
        {page < pages ? (
          <Link
            className="underline underline-offset-4"
            href={pageHref(basePath, params, page + 1)}
          >
            Next
          </Link>
        ) : null}
      </span>
    </div>
  );
}

/** GET filter bar. Submitting reloads the page with the query string. */
export function FilterBar({
  children,
  submitLabel = "Apply",
}: {
  children: ReactNode;
  submitLabel?: string;
}) {
  return (
    <form method="get" className="flex flex-wrap items-end gap-3">
      {children}
      <button
        type="submit"
        className="bg-ink text-parchment hover:bg-ink/90 h-9 rounded-md px-4 text-sm font-medium"
      >
        {submitLabel}
      </button>
    </form>
  );
}

export const adminInputClass =
  "border-input bg-background h-9 rounded-md border px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring";

export const adminTextareaClass =
  "border-input bg-background min-h-20 w-full rounded-md border px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring";

export function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: ReactNode;
  hint?: string;
}) {
  return (
    <label className="flex flex-col gap-1.5 text-sm">
      <span className="font-medium">{label}</span>
      {children}
      {hint ? <span className="text-muted-foreground text-xs">{hint}</span> : null}
    </label>
  );
}

export function ReadOnlyNote() {
  return (
    <p className="text-muted-foreground rounded-md border border-dashed px-3 py-2 text-xs">
      Read-only access. Your role cannot make changes here.
    </p>
  );
}
