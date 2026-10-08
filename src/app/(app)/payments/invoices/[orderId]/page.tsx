import type { Metadata } from "next";
import Link from "next/link";
import { getViewerAbilities } from "@/lib/rbac/enforce";
import { formatMinor } from "@/lib/money";
import { guardRedirect } from "@/lib/guarded-redirect";
import { OrdersBusinessPicker } from "@/modules/orders/components/business-picker";
import { resolvePaymentsBusiness } from "@/modules/payments/context";
import { PrintButton } from "@/modules/payments/components/print-button";
import { loadLatestInvoice } from "@/modules/payments/queries";

export const metadata: Metadata = { title: "Invoice" };

const money = (minor: number) => `₹${formatMinor(minor)}`;

export default async function InvoicePage({
  params,
  searchParams,
}: {
  params: Promise<{ orderId: string }>;
  searchParams: Promise<{ business?: string }>;
}) {
  const { orderId } = await params;
  const search = await searchParams;
  const { withBillingView, business } = await resolvePaymentsBusiness(search.business);
  if (withBillingView.length === 0) return await guardRedirect("/settings");
  if (!business) return <OrdersBusinessPicker businesses={withBillingView} basePath={`/payments/invoices/${orderId}`} />;

  const abilities = await getViewerAbilities(business.id);
  if (!abilities.can("billing.view")) {
    return <p className="text-muted-foreground">You don&apos;t have permission to view invoices in this business.</p>;
  }

  const invoice = await loadLatestInvoice(business.id, orderId);
  const backHref = `/orders/${orderId}?business=${business.id}`;

  if (!invoice) {
    return (
      <div className="mx-auto max-w-md space-y-4">
        <Link href={backHref} className="text-sm text-muted-foreground hover:text-ink">← Back to order</Link>
        <p className="text-sm text-muted-foreground">No invoice has been issued for this order yet. Issue one from the billing panel on the order.</p>
      </div>
    );
  }

  const s = invoice.snapshot;
  const isVoid = invoice.status === "void";

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <div className="flex items-center justify-between gap-3 print:hidden">
        <Link href={backHref} className="text-sm text-muted-foreground hover:text-ink">← Back to order #{s.order_number}</Link>
        <PrintButton label="Print invoice" />
      </div>

      {isVoid ? (
        <p role="status" className="rounded-md border border-rose-300 bg-rose-50 p-3 text-sm text-rose-900 print:border-neutral-900 print:bg-white print:text-neutral-900">
          VOID — {invoice.voidReason ?? "voided"}. The invoice number is retained for the audit trail.
        </p>
      ) : null}

      <article className="space-y-5 rounded-xl border border-border bg-white p-6 text-sm text-neutral-900 print:rounded-none print:border-0 print:p-0">
        <header className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-lg font-semibold">{s.business_name}</p>
            <p className="text-xs text-neutral-600">{s.outlet_name}</p>
          </div>
          <div className="text-right text-xs">
            <p className="text-sm font-semibold">Invoice {invoice.invoiceNo}</p>
            <p className="text-neutral-600">
              Issued{" "}
              {new Date(invoice.issuedAt).toLocaleString("en-IN", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" })}
            </p>
            <p className="text-neutral-600">Order #{s.order_number} · {s.order_type.replace("_", " ")}{s.table_label ? ` · Table ${s.table_label}` : ""}</p>
          </div>
        </header>

        {s.customer_name || s.customer_phone || s.delivery_address ? (
          <div className="text-xs text-neutral-700">
            {s.customer_name ? <p>{s.customer_name}</p> : null}
            {s.customer_phone ? <p>{s.customer_phone}</p> : null}
            {s.delivery_address ? <p>Deliver to: {s.delivery_address}</p> : null}
          </div>
        ) : null}

        <table className="w-full text-sm">
          <thead className="border-b border-neutral-300 text-left text-xs text-neutral-600">
            <tr>
              <th className="py-1.5 font-medium">Item</th>
              <th className="py-1.5 text-right font-medium">Qty</th>
              <th className="py-1.5 text-right font-medium">Rate</th>
              <th className="py-1.5 text-right font-medium">Amount</th>
            </tr>
          </thead>
          <tbody>
            {s.items.map((item, i) => (
              <tr key={i} className="border-b border-neutral-100 align-top">
                <td className="py-1.5">
                  {item.name}
                  {item.modifiers.map((m, j) => (
                    <p key={j} className="text-xs text-neutral-600">
                      + {m.quantity > 1 ? `${m.quantity} × ` : ""}{m.name}
                    </p>
                  ))}
                </td>
                <td className="py-1.5 text-right tabular-nums">{item.quantity}</td>
                <td className="py-1.5 text-right tabular-nums">{money(item.unit_price_minor)}</td>
                <td className="py-1.5 text-right tabular-nums">{money(item.line_total_minor)}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <div className="ml-auto w-full max-w-xs space-y-1 text-sm">
          <Row label="Subtotal" value={money(s.subtotal_minor)} />
          {s.discount_minor > 0 ? <Row label="Discount" value={`−${money(s.discount_minor)}`} /> : null}
          {s.tax_minor > 0 ? <Row label="Tax" value={money(s.tax_minor)} /> : null}
          {s.charges.map((c) => (
            <Row key={c.name} label={c.name} value={money(c.amount_minor)} />
          ))}
          <div className="flex justify-between border-t border-neutral-300 pt-2 text-base font-semibold">
            <span>Total</span>
            <span className="tabular-nums">{money(invoice.totalMinor)}</span>
          </div>
          <Row label="Paid to date (net)" value={money(s.paid_minor)} />
        </div>
      </article>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between text-neutral-700">
      <span>{label}</span>
      <span className="tabular-nums">{value}</span>
    </div>
  );
}
