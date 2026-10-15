import type { Metadata } from "next";
import type { ReactNode } from "react";
import { connection } from "next/server";
import { notFound, redirect } from "next/navigation";
import { decideAdminAccess } from "@/modules/admin/access";
import { AdminShell } from "@/modules/admin/components/admin-shell";
import { getOperatorState } from "@/modules/admin/session";

/**
 * Guard for every Super Admin page except the sign-in page.
 *
 *  - anonymous visitor            → redirect to /admin/sign-in
 *  - signed in, not an operator   → 404 (the area is not revealed)
 *  - Supabase not configured      → 404 (fails closed)
 *  - operator (live role check)   → render
 *
 * The proxy also redirects anonymous visitors. Every loader and action checks
 * the permission again, so this layout is one of several checks, not the only one.
 */

export const metadata: Metadata = {
  title: { default: "Super Admin", template: "%s · Super Admin" },
  robots: { index: false, follow: false },
};

export default async function AdminGuardedLayout({ children }: { children: ReactNode }) {
  await connection();

  const state = await getOperatorState();
  const decision = decideAdminAccess(state);
  if (decision === "sign-in") redirect("/admin/sign-in");
  if (decision === "not-found") notFound();
  if (state.kind !== "operator") notFound();

  return (
    <AdminShell email={state.email} role={state.role}>
      {children}
    </AdminShell>
  );
}
