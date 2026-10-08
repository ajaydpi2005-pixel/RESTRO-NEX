import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getViewerAbilities } from "@/lib/rbac/enforce";
import { guardRedirect } from "@/lib/guarded-redirect";
import { PrintButton } from "@/modules/payments/components/print-button";
import { OrdersBusinessPicker } from "@/modules/orders/components/business-picker";
import { resolveOrdersBusiness } from "@/modules/orders/context";
import { loadOrderDetail } from "@/modules/orders/queries";
import { buildKitchenTicket } from "@/modules/orders/kot";
import { ORDER_TYPE_LABELS, type OrderType } from "@/modules/orders/state";

export const metadata: Metadata = { title: "KOT" };

export default async function KotPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ business?: string }>;
}) {
  const { id } = await params;
  const search = await searchParams;
  const { withOrdersView, business } = await resolveOrdersBusiness(search.business);
  if (withOrdersView.length === 0) return await guardRedirect("/settings");
  if (!business) return <OrdersBusinessPicker businesses={withOrdersView} basePath={`/orders/${id}/kot`} />;

  const abilities = await getViewerAbilities(business.id);
  if (!abilities.can("orders.view")) {
    return <p className="text-muted-foreground">You don&apos;t have permission to view this order.</p>;
  }

  const order = await loadOrderDetail(business.id, id);
  if (!order) notFound();

  const ticket = buildKitchenTicket({
    orderNumber: order.orderNumber,
    orderType: order.orderType,
    tableName: order.tableName,
    customerName: order.customerName,
    outletName: order.outletName,
    createdAt: order.createdAt,
    notes: order.notes,
    items: order.items.map((item) => ({
      name: item.name,
      quantity: item.quantity,
      itemNotes: item.itemNotes,
      modifiers: item.modifiers.map((m) => ({ name: m.name, quantity: m.quantity })),
    })),
  });

  return (
    <div className="mx-auto max-w-sm space-y-4">
      <div className="flex items-center justify-between gap-3 print:hidden">
        <Link href={`/orders/${order.id}?business=${business.id}`} className="text-sm text-muted-foreground hover:text-ink">
          ← Back to order
        </Link>
        <PrintButton label="Print KOT" />
      </div>

      <article className="space-y-3 rounded-xl border border-border bg-white p-5 font-mono text-neutral-900 print:rounded-none print:border-0 print:p-0">
        <header className="space-y-1 border-b border-dashed border-neutral-400 pb-3 text-center">
          <p className="text-xs tracking-widest uppercase">Kitchen order ticket</p>
          <p className="text-3xl font-bold">#{ticket.orderNumber}</p>
          <p className="text-sm">
            {ORDER_TYPE_LABELS[ticket.orderType as OrderType] ?? ticket.orderType}
            {ticket.tableName ? ` · Table ${ticket.tableName}` : ""}
          </p>
          <p className="text-xs text-neutral-600">
            {ticket.outletName} ·{" "}
            {new Date(ticket.createdAt).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })}
          </p>
          {ticket.customerName ? <p className="text-xs">{ticket.customerName}</p> : null}
        </header>

        <ul className="space-y-2">
          {ticket.lines.map((line, i) => (
            <li key={i} className="border-b border-neutral-200 pb-2 text-sm">
              <p className="font-semibold">
                {line.quantity} × {line.name}
              </p>
              {line.modifiers.map((m, j) => (
                <p key={j} className="ml-4 text-xs">
                  + {m}
                </p>
              ))}
              {line.notes ? <p className="ml-4 text-xs font-semibold">NOTE: {line.notes}</p> : null}
            </li>
          ))}
        </ul>

        <p className="text-right text-sm font-semibold">Total items: {ticket.totalQuantity}</p>
        {ticket.orderNotes ? (
          <p className="border-t border-dashed border-neutral-400 pt-2 text-sm">
            <span className="font-semibold">Order note:</span> {ticket.orderNotes}
          </p>
        ) : null}
      </article>
    </div>
  );
}
