"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { formatRupees } from "../client-random";
import { CHANNEL_LABELS, INTAKE_LABELS, PAYMENT_MODE_LABELS } from "../constants";
import { acceptOnlineOrderAction, rejectOnlineOrderAction } from "../actions";
import type { QueueOrder } from "../types";

/**
 * Phase 17 — staff queue for website and QR orders.
 *
 * Accept and reject use the database functions (orders.manage). This screen only
 * shows what the server returns, and it hides customer contact details from
 * viewers who can see orders but cannot manage them.
 */

const ORDER_TYPE_LABELS: Record<string, string> = {
  dine_in: "Dine-in",
  takeaway: "Takeaway",
  delivery: "Delivery",
};

export function IntakeQueue(props: {
  businessId: string;
  outletId: string;
  outlets: { id: string; name: string }[];
  orders: QueueOrder[];
  canManage: boolean;
  basePath: string;
}) {
  const waiting = props.orders.filter((o) => o.intake_status === "awaiting_acceptance");
  const accepted = props.orders.filter((o) => o.intake_status === "accepted");
  const others = props.orders.filter(
    (o) => o.intake_status !== "awaiting_acceptance" && o.intake_status !== "accepted",
  );

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="space-y-1">
          <Link href="/orders" className="text-muted-foreground hover:text-ink text-sm">
            ← Back to orders
          </Link>
          <h1 className="font-display text-3xl font-semibold tracking-tight">Online orders</h1>
          <p className="text-muted-foreground">
            Website and QR orders wait here until staff accept them. Accepted orders go to the
            kitchen.
          </p>
        </div>
        {props.outlets.length > 1 ? (
          <nav aria-label="Outlets" className="bg-muted flex flex-wrap gap-1 rounded-lg p-1">
            {props.outlets.map((outlet) => (
              <Link
                key={outlet.id}
                href={`${props.basePath}?business=${props.businessId}&outlet=${outlet.id}`}
                aria-current={outlet.id === props.outletId ? "page" : undefined}
                className={
                  outlet.id === props.outletId
                    ? "bg-background rounded-md px-3 py-1.5 text-sm font-medium shadow-sm"
                    : "text-muted-foreground hover:text-ink rounded-md px-3 py-1.5 text-sm"
                }
              >
                {outlet.name}
              </Link>
            ))}
          </nav>
        ) : null}
      </div>

      <Section title="Waiting for acceptance" count={waiting.length} empty="No orders are waiting.">
        {waiting.map((order) => (
          <OrderCard
            key={order.id}
            order={order}
            canManage={props.canManage}
            businessId={props.businessId}
            outletId={props.outletId}
          />
        ))}
      </Section>

      <Section
        title="Accepted"
        count={accepted.length}
        empty="No accepted orders in the last 24 hours."
      >
        {accepted.map((order) => (
          <OrderCard
            key={order.id}
            order={order}
            canManage={props.canManage}
            businessId={props.businessId}
            outletId={props.outletId}
          />
        ))}
      </Section>

      {others.length > 0 ? (
        <Section title="Rejected" count={others.length} empty="">
          {others.map((order) => (
            <OrderCard
              key={order.id}
              order={order}
              canManage={props.canManage}
              businessId={props.businessId}
              outletId={props.outletId}
            />
          ))}
        </Section>
      ) : null}
    </div>
  );
}

function Section(props: {
  title: string;
  count: number;
  empty: string;
  children: React.ReactNode;
}) {
  const items = Array.isArray(props.children)
    ? props.children.filter(Boolean)
    : props.children
      ? [props.children]
      : [];
  return (
    <section className="space-y-3" aria-label={props.title}>
      <h2 className="font-display flex items-center gap-2 text-xl font-semibold">
        {props.title}
        <span className="text-muted-foreground text-sm font-normal">({props.count})</span>
      </h2>
      {items.length === 0 ? <p className="text-muted-foreground text-sm">{props.empty}</p> : null}
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">{props.children}</div>
    </section>
  );
}

function OrderCard(props: {
  order: QueueOrder;
  canManage: boolean;
  businessId: string;
  outletId: string;
}) {
  const { order } = props;
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);

  const scope = { businessId: props.businessId, outletId: props.outletId, orderId: order.id };

  function accept() {
    setError(null);
    startTransition(async () => {
      const result = await acceptOnlineOrderAction(scope);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      router.refresh();
    });
  }

  function reject() {
    setError(null);
    startTransition(async () => {
      const result = await rejectOnlineOrderAction({ ...scope, reason });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setRejecting(false);
      router.refresh();
    });
  }

  const waiting = order.intake_status === "awaiting_acceptance";
  const channel = CHANNEL_LABELS[order.channel] ?? order.channel;

  return (
    <Card className="flex flex-col">
      <CardContent className="flex flex-1 flex-col gap-3 p-5">
        <div className="flex items-start justify-between gap-2">
          <div>
            <p className="font-display text-lg font-semibold">#{order.order_number}</p>
            <p className="text-muted-foreground text-xs">
              {channel} · {ORDER_TYPE_LABELS[order.order_type] ?? order.order_type}
              {order.table_label ? ` · ${order.table_label}` : ""}
            </p>
          </div>
          <Badge variant="outline" className="border-gold/50">
            {INTAKE_LABELS[order.intake_status ?? ""] ?? order.status}
          </Badge>
        </div>

        <p className="text-sm">
          {order.customer_name ?? "Guest"}
          {props.canManage && order.customer_phone ? (
            <span className="text-muted-foreground"> · {order.customer_phone}</span>
          ) : null}
        </p>
        {props.canManage && order.delivery_address ? (
          <p className="text-muted-foreground text-sm">{order.delivery_address}</p>
        ) : null}
        {order.notes ? <p className="text-muted-foreground text-sm">Note: {order.notes}</p> : null}

        <ul className="space-y-1 text-sm">
          {order.items.map((item, index) => (
            <li key={`${item.name}-${index}`} className="flex justify-between gap-2">
              <span>
                {item.quantity} × {item.name}
              </span>
              <span className="tabular-nums">₹{formatRupees(item.line_total_minor)}</span>
            </li>
          ))}
        </ul>

        <div className="border-border mt-auto space-y-3 border-t pt-3">
          <div className="flex justify-between text-sm">
            <span className="text-muted-foreground">
              {order.payment_mode
                ? (PAYMENT_MODE_LABELS[order.payment_mode] ?? order.payment_mode)
                : "Payment"}
            </span>
            <span className="font-medium tabular-nums">₹{formatRupees(order.total_minor)}</span>
          </div>

          {order.rejected_reason ? (
            <p className="text-destructive text-sm">Rejected: {order.rejected_reason}</p>
          ) : null}
          {error ? (
            <p role="alert" className="text-destructive text-sm">
              {error}
            </p>
          ) : null}

          {waiting && props.canManage ? (
            rejecting ? (
              <div className="space-y-2">
                <Input
                  aria-label="Reason for rejecting"
                  placeholder="Reason shown to the customer"
                  value={reason}
                  maxLength={200}
                  onChange={(e) => setReason(e.target.value)}
                />
                <div className="flex gap-2">
                  <Button
                    type="button"
                    variant="destructive"
                    size="sm"
                    disabled={pending || reason.trim().length < 3}
                    onClick={reject}
                  >
                    Confirm reject
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => setRejecting(false)}
                    disabled={pending}
                  >
                    Cancel
                  </Button>
                </div>
              </div>
            ) : (
              <div className="flex gap-2">
                <Button type="button" size="sm" disabled={pending} onClick={accept}>
                  {pending ? "Working…" : "Accept"}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={pending}
                  onClick={() => setRejecting(true)}
                >
                  Reject
                </Button>
              </div>
            )
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}
