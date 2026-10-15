import type { Metadata } from "next";
import { guardRedirect } from "@/lib/guarded-redirect";
import { loadInventoryPageContext } from "@/modules/inventory/page-context";
import {
  ReportHub,
  ReportsBusinessPicker,
  ReportsDenied,
  ReportsNoOutlet,
} from "@/modules/reports/components/report-chrome";

export const metadata: Metadata = { title: "Reports" };

export default async function ReportsPage({
  searchParams,
}: {
  searchParams: Promise<{ business?: string; outlet?: string }>;
}) {
  const params = await searchParams;
  const ctx = await loadInventoryPageContext(params, "reports.view");
  if (ctx === "redirect") return await guardRedirect("/settings");
  if (ctx.kind === "picker") return <ReportsBusinessPicker businesses={ctx.businesses} />;
  if (ctx.kind === "denied") return <ReportsDenied />;
  if (ctx.kind === "no-outlet") return <ReportsNoOutlet />;

  const { business, abilities } = ctx;
  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h1 className="font-display text-3xl font-semibold tracking-tight">Reports</h1>
        <p className="text-muted-foreground">
          Sales, financial, inventory, staff and customer reports. Each one shows the rule it uses
          for dates and money.
        </p>
      </div>
      <ReportHub
        businessId={business.id}
        businessName={business.name}
        canSee={(def) => !def.extraPermission || abilities.can(def.extraPermission)}
      />
    </div>
  );
}
