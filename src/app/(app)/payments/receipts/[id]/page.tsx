import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getViewerAbilities } from "@/lib/rbac/enforce";
import { formatMinor } from "@/lib/money";
import { guardRedirect } from "@/lib/guarded-redirect";
import { OrdersBusinessPicker } from "@/modules/orders/components/business-picker";
import { resolvePaymentsBusiness } from "@/modules/payments/context";
import { PrintReceiptButton } from "@/modules/payments/components/print-button";
import { loadReceiptView } from "@/modules/payments/queries";
import { PAYMENT_METHOD_KINDS } from "@/modules/payments/schemas";

export const metadata: Metadata = { title: "Receipt" };

const money = (minor: number) => `₹${formatMinor(minor)}`;
const KIND_TEXT: Record<string, string> = Object.fromEntries(PAYMENT_METHOD_KINDS.map((k) => [k, k.toUpperCase()]));

export default async function ReceiptPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ business?: string }>;
}) {
  const { id } = await params;
  const search = await searchParams;
  const { withBillingView, business } = await resolvePaymentsBusiness(search.business);
  if (withBillingView.length === 0) return await guardRedirect("/settings");
  if (!business) return <OrdersBusinessPicker businesses={withBillingView} basePath={`/payments/receipts/${id}`} />;

  const abilities = await getViewerAbilities(business.id);
  if (!abilities.can("billing.view")) {
    return <p className="text-muted-foreground">You don&apos;t have permission to view receipts in this business.</p>;
  }

  const view = await loadReceiptView(business.id, id);
  if (!view) notFound();

  const { receipt } = view;
  const isRefund = receipt.kind === "refund";

  return (
    <div className="mx-auto max-w-md space-y-4">
      <div className="flex items-center justify-between gap-3 print:hidden">
        <Link href={`/orders/${receipt.orderId}?business=${business.id}`} className="text-sm text-muted-foreground hover:text-ink">
          ← Back to order #{view.orderNumber}
        </Link>
      </div>

      <PrintReceiptButton
        businessId={business.id}
        receiptId={receipt.id}
        printCount={receipt.printCount}
        canPrint={abilities.can("billing.manage")}
      />

      <article className="space-y-4 rounded-xl border border-border bg-white p-6 text-sm text-neutral-900 print:rounded-none print:border-0 print:p-0">
        <header className="space-y-0.5 text-center">
          <p className="text-base font-semibold">{view.businessName}</p>
          <p className="text-xs text-neutral-600">{view.outletName}</p>
          <p className="pt-2 text-xs font-medium tracking-wide uppercase">
            {isRefund ? "Refund receipt" : "Payment receipt"}
          </p>
        </header>

        <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
          <dt className="text-neutral-600">Receipt</dt>
          <dd className="text-right font-medium">{receipt.receiptNo}</dd>
          <dt className="text-neutral-600">Order</dt>
          <dd className="text-right">#{view.orderNumber}</dd>
          <dt className="text-neutral-600">Date</dt>
          <dd className="text-right">
            {new Date(receipt.createdAt).toLocaleString("en-IN", {
              day: "2-digit",
              month: "short",
              year: "numeric",
              hour: "2-digit",
              minute: "2-digit",
            })}
          </dd>
        </dl>

        <div className="border-y border-dashed border-neutral-400 py-3">
          {view.lines.map((line, i) => (
            <div key={i} className="space-y-0.5 py-1">
              <div className="flex justify-between">
                <span>
                  {isRefund ? "Refund" : line.label}
                  {!isRefund ? <span className="ml-1 text-xs text-neutral-500">({KIND_TEXT[line.kind] ?? line.kind})</span> : null}
                </span>
                <span className="tabular-nums">{money(line.amountMinor)}</span>
              </div>
              {line.reference ? <p className="text-xs text-neutral-600">Ref: {line.reference}</p> : null}
              {line.detail ? <p className="text-xs text-neutral-600">{line.detail}</p> : null}
              {line.tenderedMinor !== null && line.tenderedMinor > 0 ? (
                <p className="text-xs text-neutral-600">
                  Tendered {money(line.tenderedMinor)} · Change {money(line.changeMinor)}
                </p>
              ) : null}
            </div>
          ))}
        </div>

        <div className="space-y-1">
          <div className="flex justify-between font-semibold">
            <span>{isRefund ? "Total refunded" : "Total received"}</span>
            <span className="tabular-nums">{money(receipt.amountMinor)}</span>
          </div>
          <div className="flex justify-between text-xs text-neutral-600">
            <span>Order total</span>
            <span className="tabular-nums">{money(view.orderTotalMinor)}</span>
          </div>
          <div className="flex justify-between text-xs text-neutral-600">
            <span>Balance due after this</span>
            <span className="tabular-nums">{money(receipt.balanceAfterMinor)}</span>
          </div>
        </div>

        <p className="pt-2 text-center text-xs text-neutral-500">Thank you for dining with us.</p>
      </article>
    </div>
  );
}
