import type { Metadata } from "next";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { findActiveMembership, getViewerAbilities } from "@/lib/rbac/enforce";
import { formatMinor } from "@/lib/money";
import { guardRedirect } from "@/lib/guarded-redirect";
import { OrdersBusinessPicker } from "@/modules/orders/components/business-picker";
import { loadPosOutlets } from "@/modules/orders/queries";
import { resolvePaymentsBusiness } from "@/modules/payments/context";
import { PaymentMethodManager } from "@/modules/payments/components/method-manager";
import { listPaymentProviders } from "@/modules/payments/gateway";
import { loadPaymentsWorkspace } from "@/modules/payments/queries";
import { istDayEndExclusive, istDayStart } from "@/modules/payments/schemas";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: "Payments" };

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_RANGE_DAYS = 92;
const money = (minor: number) => `₹${formatMinor(minor)}`;

/** Today in IST (UTC+05:30, no DST) as YYYY-MM-DD. */
function todayIst(): string {
  return new Date(Date.now() + 330 * 60 * 1000).toISOString().slice(0, 10);
}

function addDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function validIsoDate(value: string | undefined): string | null {
  if (!value || !ISO_DATE.test(value)) return null;
  return Number.isNaN(Date.parse(`${value}T00:00:00Z`)) ? null : value;
}

export default async function PaymentsPage({
  searchParams,
}: {
  searchParams: Promise<{ business?: string; outlet?: string; from?: string; to?: string }>;
}) {
  const params = await searchParams;
  const { withBillingView, business } = await resolvePaymentsBusiness(params.business);
  if (withBillingView.length === 0) return await guardRedirect("/settings");
  if (!business) return <OrdersBusinessPicker businesses={withBillingView} basePath="/payments" />;

  const abilities = await getViewerAbilities(business.id);
  if (!abilities.can("billing.view") && !abilities.can("reports.view")) {
    return <p className="text-muted-foreground">You don&apos;t have permission to view payments in this business.</p>;
  }

  const membership = abilities.userId ? await findActiveMembership(abilities.userId, business.id) : null;
  if (!membership || !abilities.userId) return await guardRedirect("/settings");

  const outlets = await loadPosOutlets(business.id, membership.role, membership.id);
  if (outlets.length === 0) {
    return (
      <div className="space-y-4">
        <h1 className="font-display text-3xl font-semibold tracking-tight">Payments</h1>
        <Card>
          <CardContent className="py-10 text-center">
            <p className="font-medium">No outlet assigned</p>
            <p className="mt-1 text-sm text-muted-foreground">Ask an owner or admin to add an outlet and assign you to it.</p>
          </CardContent>
        </Card>
      </div>
    );
  }
  const outlet = outlets.find((o) => o.id === params.outlet) ?? outlets[0]!;

  const today = todayIst();
  const from = validIsoDate(params.from) ?? today;
  let to = validIsoDate(params.to) ?? from;
  if (to < from) to = from;
  if (Date.parse(to) - Date.parse(from) > MAX_RANGE_DAYS * 86_400_000) to = addDays(from, MAX_RANGE_DAYS);

  const canReconcile = abilities.can("reports.view");
  const workspace = await loadPaymentsWorkspace({
    businessId: business.id,
    outletId: outlet.id,
    actorUserId: abilities.userId,
    fromIso: istDayStart(from),
    toIso: istDayEndExclusive(to),
    canSeeAudit: abilities.can("billing.manage"),
    canReconcile,
  });
  const canManageMethods = abilities.can("billing.manage");
  const rec = workspace.reconciliation;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1">
          <h1 className="font-display text-3xl font-semibold tracking-tight">Payments</h1>
          <p className="text-sm text-muted-foreground">
            Ledger, refunds and reconciliation for {outlet.name}. Dates are in IST.
          </p>
        </div>
        <form className="flex flex-wrap items-end gap-2 text-sm" method="get">
          <input type="hidden" name="business" value={business.id} />
          {outlets.length > 1 ? (
            <label className="space-y-1">
              <span className="block text-xs text-muted-foreground">Outlet</span>
              <select name="outlet" defaultValue={outlet.id} className="h-9 rounded-md border border-input bg-background px-2">
                {outlets.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.name}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <input type="hidden" name="outlet" value={outlet.id} />
          )}
          <label className="space-y-1">
            <span className="block text-xs text-muted-foreground">From</span>
            <input type="date" name="from" defaultValue={from} className="h-9 rounded-md border border-input bg-background px-2" />
          </label>
          <label className="space-y-1">
            <span className="block text-xs text-muted-foreground">To</span>
            <input type="date" name="to" defaultValue={to} className="h-9 rounded-md border border-input bg-background px-2" />
          </label>
          <button type="submit" className="h-9 rounded-md border border-input px-3 hover:bg-muted">
            Apply
          </button>
        </form>
      </div>

      {rec ? (
        <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Stat label="Captured" value={money(rec.totals.captured_minor)} sub={`${rec.totals.payment_count} payments`} />
          <Stat label="Refunded" value={money(rec.totals.refunded_minor)} sub={`${rec.totals.refund_count} refunds`} />
          <Stat label="Net collected" value={money(rec.totals.net_minor)} sub={`${rec.invoices.issued} invoices issued, ${rec.invoices.voided} voided`} />
          <Card>
            <CardContent className="space-y-1 py-4">
              <p className="text-xs text-muted-foreground">Reconciliation</p>
              <Badge className={cn("border-0", rec.balanced ? "bg-emerald-100 text-emerald-900" : "bg-rose-100 text-rose-900")}>
                {rec.balanced ? "Balanced" : `${rec.mismatch_count} mismatch${rec.mismatch_count === 1 ? "" : "es"}`}
              </Badge>
              <p className="text-xs text-muted-foreground">Orders whose stored paid amount differs from the ledger.</p>
            </CardContent>
          </Card>
        </section>
      ) : (
        <p className="text-sm text-muted-foreground">Reconciliation totals are shown to users with reports access.</p>
      )}

      {rec && rec.methods.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">By payment method</CardTitle>
          </CardHeader>
          <CardContent className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-muted-foreground">
                <tr>
                  <th className="py-1 font-medium">Method</th>
                  <th className="py-1 text-right font-medium">Payments</th>
                  <th className="py-1 text-right font-medium">Captured</th>
                  <th className="py-1 text-right font-medium">Refunded</th>
                  <th className="py-1 text-right font-medium">Net</th>
                </tr>
              </thead>
              <tbody>
                {rec.methods.map((m) => (
                  <tr key={m.method_key} className="border-t border-border">
                    <td className="py-1.5">{workspace.methods.find((x) => x.key === m.method_key)?.label ?? m.method_key}</td>
                    <td className="py-1.5 text-right tabular-nums">{m.payment_count}</td>
                    <td className="py-1.5 text-right tabular-nums">{money(m.captured_minor)}</td>
                    <td className="py-1.5 text-right tabular-nums">{money(m.refunded_minor)}</td>
                    <td className="py-1.5 text-right tabular-nums">{money(m.net_minor)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Payments</CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          {workspace.payments.length === 0 ? (
            <p className="text-sm text-muted-foreground">No payments in this period.</p>
          ) : (
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-muted-foreground">
                <tr>
                  <th className="py-1 font-medium">Time</th>
                  <th className="py-1 font-medium">Order</th>
                  <th className="py-1 font-medium">Method</th>
                  <th className="py-1 font-medium">Receipt</th>
                  <th className="py-1 text-right font-medium">Amount</th>
                </tr>
              </thead>
              <tbody>
                {workspace.payments.map((p) => (
                  <tr key={p.id} className="border-t border-border">
                    <td className="py-1.5 text-xs text-muted-foreground">
                      {new Date(p.createdAt).toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}
                    </td>
                    <td className="py-1.5">
                      <Link className="underline" href={`/orders/${p.orderId}?business=${business.id}`}>
                        #{p.orderNumber}
                      </Link>
                    </td>
                    <td className="py-1.5">{workspace.methods.find((m) => m.key === p.methodKey)?.label ?? p.methodKey}</td>
                    <td className="py-1.5">{p.receiptNo}</td>
                    <td className="py-1.5 text-right tabular-nums">{money(p.amountMinor)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      {workspace.refunds.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Refunds</CardTitle>
          </CardHeader>
          <CardContent className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-muted-foreground">
                <tr>
                  <th className="py-1 font-medium">Time</th>
                  <th className="py-1 font-medium">Order</th>
                  <th className="py-1 font-medium">Reason</th>
                  <th className="py-1 font-medium">Receipt</th>
                  <th className="py-1 text-right font-medium">Amount</th>
                </tr>
              </thead>
              <tbody>
                {workspace.refunds.map((r) => (
                  <tr key={r.id} className="border-t border-border">
                    <td className="py-1.5 text-xs text-muted-foreground">
                      {new Date(r.createdAt).toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}
                    </td>
                    <td className="py-1.5">
                      <Link className="underline" href={`/orders/${r.orderId}?business=${business.id}`}>
                        #{r.orderNumber}
                      </Link>
                    </td>
                    <td className="py-1.5">{r.reason}</td>
                    <td className="py-1.5">{r.receiptNo}</td>
                    <td className="py-1.5 text-right tabular-nums text-rose-700">−{money(r.amountMinor)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      ) : null}

      {rec && rec.mismatches.length > 0 ? (
        <Card className="border-rose-300">
          <CardHeader>
            <CardTitle className="text-base">Mismatched orders</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1 text-sm">
            {rec.mismatches.slice(0, 20).map((m) => (
              <p key={m.order_id}>
                <Link className="underline" href={`/orders/${m.order_id}?business=${business.id}`}>
                  Order #{m.order_number}
                </Link>{" "}
                stored paid {money(m.recorded_paid_minor)}, ledger says {money(m.expected_paid_minor)} ({m.recorded_status} → {m.expected_status})
              </p>
            ))}
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Payment methods</CardTitle>
        </CardHeader>
        <CardContent>
          <PaymentMethodManager businessId={business.id} methods={workspace.methods} canManage={canManageMethods} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Payment providers</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {listPaymentProviders().map((p) => (
            <div key={p.key} className="flex flex-wrap items-center justify-between gap-2 text-sm">
              <span className="font-medium">{p.label}</span>
              <Badge className={cn("border-0", p.connected ? "bg-emerald-100 text-emerald-900" : "bg-muted text-muted-foreground")}>
                {p.connected ? "Available" : "Not connected"}
              </Badge>
              <p className="w-full text-xs text-muted-foreground">{p.reason}</p>
            </div>
          ))}
        </CardContent>
      </Card>

      {canManageMethods ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Audit trail</CardTitle>
          </CardHeader>
          <CardContent className="overflow-x-auto">
            {workspace.audit.length === 0 ? (
              <p className="text-sm text-muted-foreground">No audited actions yet.</p>
            ) : (
              <ul className="space-y-1 text-xs">
                {workspace.audit.map((a) => (
                  <li key={a.id} className="flex flex-wrap gap-2 border-t border-border py-1.5">
                    <span className="text-muted-foreground">
                      {new Date(a.createdAt).toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}
                    </span>
                    <span className="font-medium">{a.action}</span>
                    <span className="text-muted-foreground">{a.targetType}</span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <Card>
      <CardContent className="space-y-1 py-4">
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className="font-display text-2xl font-semibold tabular-nums">{value}</p>
        <p className="text-xs text-muted-foreground">{sub}</p>
      </CardContent>
    </Card>
  );
}
