import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { guardRedirect } from "@/lib/guarded-redirect";
import { loadInventoryPageContext } from "@/modules/inventory/page-context";
import { businessToday } from "@/modules/inventory/queries";
import {
  PurchasingBusinessPicker,
  PurchasingDenied,
  PurchasingNav,
  PurchasingNoOutlet,
  StatusBadge,
} from "@/modules/purchasing/components/purchasing-chrome";
import { SupplierForm } from "@/modules/purchasing/components/supplier-form";
import { SupplierPaymentForm } from "@/modules/purchasing/components/payment-form";
import { AGING_BUCKETS, type AgingBucket } from "@/modules/purchasing/aging";
import { paiseToDisplay } from "@/modules/purchasing/money";
import {
  loadPayablesAging,
  loadSupplier,
  loadSupplierHistory,
} from "@/modules/purchasing/queries";

export const metadata: Metadata = { title: "Supplier" };

const BUCKET_LABEL: Record<AgingBucket, string> = {
  current: "Not yet due",
  "1-30": "1–30 days",
  "31-60": "31–60 days",
  "61-90": "61–90 days",
  "90+": "Over 90 days",
};

export default async function SupplierDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ business?: string; outlet?: string }>;
}) {
  const { id } = await params;
  const query = await searchParams;
  const ctx = await loadInventoryPageContext(query, "purchasing.view");
  if (ctx === "redirect") return await guardRedirect("/settings");
  if (ctx.kind === "picker") return <PurchasingBusinessPicker businesses={ctx.businesses} />;
  if (ctx.kind === "denied") return <PurchasingDenied />;
  if (ctx.kind === "no-outlet") return <PurchasingNoOutlet />;

  const { business, abilities, outlet } = ctx;
  const canManage = abilities.can("purchasing.manage");
  const supplier = await loadSupplier(business.id, id);
  if (!supplier) notFound();

  const today = businessToday();
  const [history, aging] = await Promise.all([
    loadSupplierHistory(business.id, supplier.id),
    loadPayablesAging(business.id, today),
  ]);
  const balance = aging.find((a) => a.supplierId === supplier.id);
  const owedMinor = balance?.balanceMinor ?? 0;
  const openInvoices = balance?.openInvoices ?? [];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="space-y-1">
          <p className="text-sm text-muted-foreground">
            <Link className="underline-offset-4 hover:underline" href={`/purchasing/suppliers?business=${business.id}&outlet=${outlet.id}`}>
              Suppliers
            </Link>{" "}
            / {supplier.name}
          </p>
          <h1 className="font-display text-3xl font-semibold tracking-tight">{supplier.name}</h1>
          <p className="text-muted-foreground">
            {supplier.paymentTermsDays} day terms
            {supplier.gstin ? ` · GSTIN ${supplier.gstin}` : ""}
            {supplier.status === "inactive" ? " · inactive" : ""}
          </p>
        </div>
        <div className="text-right">
          <p className="text-sm text-muted-foreground">Balance owed</p>
          <p className="font-display text-3xl font-semibold tabular-nums">₹{paiseToDisplay(owedMinor)}</p>
        </div>
      </div>

      <PurchasingNav businessId={business.id} outletId={outlet.id} />

      <div className="grid gap-6 xl:grid-cols-[1fr_380px]">
        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Payables ageing</CardTitle>
              <CardDescription>
                Payments are applied to the oldest invoices first. Ageing is as of today (IST).
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-5">
                {AGING_BUCKETS.map((b) => (
                  <div key={b} className="rounded-lg border p-2">
                    <dt className="text-xs text-muted-foreground">{BUCKET_LABEL[b]}</dt>
                    <dd className="font-medium tabular-nums">₹{paiseToDisplay(balance?.buckets[b] ?? 0)}</dd>
                  </div>
                ))}
              </dl>
              {openInvoices.length === 0 ? (
                <p className="text-sm text-muted-foreground">Nothing open to pay.</p>
              ) : (
                <ul className="divide-y text-sm">
                  {openInvoices.map((i) => (
                    <li key={i.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                      <span>
                        Invoice {i.invoiceNumber} · due {i.dueOn}
                      </span>
                      <span className="flex items-center gap-3 tabular-nums">
                        ₹{paiseToDisplay(i.openMinor)} open
                        <Badge variant={i.daysOverdue > 0 ? "destructive" : "outline"}>
                          {i.daysOverdue > 0 ? `${i.daysOverdue} days overdue` : "Not yet due"}
                        </Badge>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Purchase orders</CardTitle>
              <CardDescription>Most recent orders to this supplier across outlets.</CardDescription>
            </CardHeader>
            <CardContent>
              {history.orders.length === 0 ? (
                <p className="text-sm text-muted-foreground">No orders yet.</p>
              ) : (
                <ul className="divide-y text-sm">
                  {history.orders.slice(0, 25).map((o) => (
                    <li key={o.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                      <Link
                        className="underline-offset-4 hover:underline"
                        href={`/purchasing/orders/${o.id}?business=${business.id}&outlet=${o.outletId}`}
                      >
                        PO-{o.number} · {o.createdAt.slice(0, 10)}
                      </Link>
                      <span className="flex items-center gap-3 tabular-nums">
                        ₹{paiseToDisplay(o.subtotalMinor)} <StatusBadge status={o.status} />
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Invoices</CardTitle>
              <CardDescription>Supplier invoices recorded against this supplier.</CardDescription>
            </CardHeader>
            <CardContent>
              {history.invoices.length === 0 ? (
                <p className="text-sm text-muted-foreground">No invoices yet.</p>
              ) : (
                <ul className="divide-y text-sm">
                  {history.invoices.slice(0, 25).map((i) => (
                    <li key={i.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                      <span>
                        {i.invoiceNumber} · {i.invoiceDate} · {i.lines} lines
                      </span>
                      <span className="tabular-nums">₹{paiseToDisplay(i.totalMinor)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Payments</CardTitle>
              <CardDescription>Every payment is kept. Payments cannot be edited or deleted.</CardDescription>
            </CardHeader>
            <CardContent>
              {history.payments.length === 0 ? (
                <p className="text-sm text-muted-foreground">No payments yet.</p>
              ) : (
                <ul className="divide-y text-sm">
                  {history.payments.slice(0, 25).map((p) => (
                    <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                      <span>
                        {p.paidOn} · {p.method.replace("_", " ")}
                        {p.reference ? <span className="text-muted-foreground"> · {p.reference}</span> : null}
                      </span>
                      <span className="tabular-nums">₹{paiseToDisplay(p.amountMinor)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </div>

        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Record a payment</CardTitle>
              <CardDescription>Payments cannot exceed the balance owed.</CardDescription>
            </CardHeader>
            <CardContent>
              {canManage ? (
                <SupplierPaymentForm
                  businessId={business.id}
                  supplierId={supplier.id}
                  owedMinor={owedMinor}
                  today={today}
                />
              ) : (
                <p className="text-sm text-muted-foreground">Recording payments needs purchasing access.</p>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Supplier details</CardTitle>
              <CardDescription>
                {canManage ? "Changes apply to new orders and invoices." : "Only purchasing managers can change these."}
              </CardDescription>
            </CardHeader>
            <CardContent>
              {canManage ? (
                <SupplierForm businessId={business.id} initial={supplier} />
              ) : (
                <dl className="space-y-2 text-sm">
                  <div>
                    <dt className="text-muted-foreground">Contact</dt>
                    <dd>{supplier.contactName ?? "—"}</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">Phone</dt>
                    <dd>{supplier.phone ?? "—"}</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">Email</dt>
                    <dd>{supplier.email ?? "—"}</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">Address</dt>
                    <dd>{supplier.address ?? "—"}</dd>
                  </div>
                </dl>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
