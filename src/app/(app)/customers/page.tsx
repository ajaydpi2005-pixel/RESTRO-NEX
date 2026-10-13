import type { Metadata } from "next";
import Link from "next/link";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { guardRedirect } from "@/lib/guarded-redirect";
import { loadInventoryPageContext } from "@/modules/inventory/page-context";
import {
  CrmBusinessPicker,
  CrmDenied,
  CrmNoOutlet,
  CrmNav,
  SegmentBadge,
  rupees,
} from "@/modules/customers/components/crm-chrome";
import { CustomerForm } from "@/modules/customers/components/customer-forms";
import { loadCustomerDirectory } from "@/modules/customers/queries";
import { SEGMENT_LABELS, SEGMENT_ORDER, type CustomerSegment } from "@/modules/customers/segments";

export const metadata: Metadata = { title: "Customers" };

export default async function CustomersPage({
  searchParams,
}: {
  searchParams: Promise<{ business?: string; outlet?: string; q?: string; segment?: string }>;
}) {
  const params = await searchParams;
  const ctx = await loadInventoryPageContext(params, "customers.view");
  if (ctx === "redirect") return await guardRedirect("/settings");
  if (ctx.kind === "picker") return <CrmBusinessPicker businesses={ctx.businesses} />;
  if (ctx.kind === "denied") return <CrmDenied />;
  if (ctx.kind === "no-outlet") return <CrmNoOutlet />;

  const { business, abilities, outlet } = ctx;
  const canManage = abilities.can("customers.manage");
  const all = await loadCustomerDirectory(business.id);

  const query = (params.q ?? "").trim().toLowerCase();
  const segment = SEGMENT_ORDER.includes(params.segment as CustomerSegment)
    ? (params.segment as CustomerSegment)
    : null;
  const rows = all.filter((c) => {
    if (segment && c.segment !== segment) return false;
    if (!query) return true;
    const digits = query.replace(/\D/g, "");
    return (
      c.name.toLowerCase().includes(query) ||
      (digits.length > 0 && c.phone.replace(/\D/g, "").includes(digits))
    );
  });

  const vip = all.filter((c) => c.segment === "vip").length;
  const atRisk = all.filter((c) => c.segment === "at_risk" || c.segment === "lapsed").length;
  const outstandingPoints = all.reduce((sum, c) => sum + c.balance, 0);
  const base = `business=${business.id}&outlet=${outlet.id}`;

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h1 className="font-display text-3xl font-semibold tracking-tight">Customers</h1>
        <p className="text-muted-foreground">
          {business.name}. Customers are shared across outlets.
        </p>
      </div>

      <CrmNav businessId={business.id} outletId={outlet.id} />

      <div className="grid gap-4 sm:grid-cols-3">
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Customers</CardDescription>
            <CardTitle className="text-2xl tabular-nums">{all.length}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>VIP</CardDescription>
            <CardTitle className="text-2xl tabular-nums">{vip}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Lapsed or at risk</CardDescription>
            <CardTitle className="text-2xl tabular-nums">{atRisk}</CardTitle>
            <p className="text-muted-foreground text-xs">
              {outstandingPoints} loyalty points outstanding
            </p>
          </CardHeader>
        </Card>
      </div>

      <div className="grid gap-6 xl:grid-cols-[1fr_380px]">
        <Card>
          <CardHeader>
            <CardTitle>Customer directory</CardTitle>
            <CardDescription>
              Totals are net of refunds and count completed orders only. Sorted by spend.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <form method="get" className="flex flex-wrap items-end gap-2">
              <input type="hidden" name="business" value={business.id} />
              <input type="hidden" name="outlet" value={outlet.id} />
              <label className="text-muted-foreground flex min-w-48 flex-1 flex-col gap-1 text-xs">
                Search name or phone
                <input
                  name="q"
                  defaultValue={params.q ?? ""}
                  className="bg-background text-foreground h-9 rounded-md border px-3 text-sm"
                />
              </label>
              <label className="text-muted-foreground flex flex-col gap-1 text-xs">
                Segment
                <select
                  name="segment"
                  defaultValue={segment ?? ""}
                  className="bg-background text-foreground h-9 rounded-md border px-2 text-sm"
                >
                  <option value="">All segments</option>
                  {SEGMENT_ORDER.map((s) => (
                    <option key={s} value={s}>
                      {SEGMENT_LABELS[s]}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="submit"
                className="hover:bg-muted h-9 rounded-md border px-3 text-sm font-medium"
              >
                Filter
              </button>
            </form>

            {all.length === 0 ? (
              <p className="text-muted-foreground text-sm">
                No customers yet. A customer is created when an order is saved with a phone number.
              </p>
            ) : rows.length === 0 ? (
              <p className="text-muted-foreground text-sm">No customers match this search.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="text-muted-foreground text-left">
                    <tr>
                      <th className="py-2 font-medium">Customer</th>
                      <th className="py-2 font-medium">Segment</th>
                      <th className="py-2 text-right font-medium">Orders</th>
                      <th className="py-2 text-right font-medium">Net spend</th>
                      <th className="py-2 font-medium">Last order</th>
                      <th className="py-2 text-right font-medium">Points</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((c) => (
                      <tr key={c.id} className="border-t">
                        <td className="py-2">
                          <Link
                            className="font-medium underline-offset-4 hover:underline"
                            href={`/customers/${c.id}?${base}`}
                          >
                            {c.name}
                          </Link>
                          <span className="text-muted-foreground block text-xs">{c.phone}</span>
                        </td>
                        <td className="py-2">
                          <SegmentBadge segment={c.segment} />
                        </td>
                        <td className="py-2 text-right tabular-nums">{c.orderCount}</td>
                        <td className="py-2 text-right tabular-nums">
                          {rupees(c.totalSpendMinor)}
                        </td>
                        <td className="text-muted-foreground py-2">
                          {c.lastOrderAt
                            ? new Date(c.lastOrderAt).toLocaleDateString("en-IN")
                            : "—"}
                        </td>
                        <td className="py-2 text-right tabular-nums">{c.balance}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Add a customer</CardTitle>
            <CardDescription>
              Phone numbers are unique in the business. Matching uses the last 10 digits.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {canManage ? (
              <CustomerForm businessId={business.id} />
            ) : (
              <p className="text-muted-foreground text-sm">
                You can view customers. Adding or editing them needs customer management access.
              </p>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
