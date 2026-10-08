import { AppShell } from "@/components/layout/app-shell";

/** Restaurant application: dashboard, POS, kitchen, menu, inventory, CRM, reports, settings. */
export default function AppLayout({ children }: { children: React.ReactNode }) {
  return <AppShell>{children}</AppShell>;
}
