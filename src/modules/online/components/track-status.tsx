"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { formatRupees } from "../client-random";
import { INTAKE_LABELS, PAYMENT_MODE_LABELS } from "../constants";
import type { PublicOrderStatus } from "../types";

/**
 * Phase 17 — customer order tracking.
 *
 * The tracking secret is read from the URL fragment (#s=…). Browsers never send
 * the fragment to a server, so the secret stays out of server logs and referrers.
 * It is sent in a request header, not in the URL.
 */

const POLL_MS = 15_000;

function readSecret(hash: string): string | null {
  const match = /^#s=([A-Za-z0-9_-]{32,64})$/.exec(hash);
  return match?.[1] ?? null;
}

function subscribeHash(onChange: () => void) {
  window.addEventListener("hashchange", onChange);
  return () => window.removeEventListener("hashchange", onChange);
}

function headline(order: PublicOrderStatus): { title: string; body: string } {
  if (order.intake_status === "rejected") {
    return {
      title: "This order could not be accepted",
      body: order.rejected_reason ?? "The restaurant could not take this order.",
    };
  }
  if (order.intake_status === "awaiting_acceptance") {
    return { title: "Waiting for the restaurant", body: "Staff will confirm your order shortly." };
  }
  switch (order.status) {
    case "completed":
      return { title: "Completed", body: "Thank you for ordering with us." };
    case "cancelled":
      return { title: "Cancelled", body: "This order was cancelled." };
    case "ready":
      return {
        title: "Ready",
        body:
          order.channel === "online" && order.order_type === "delivery"
            ? "Your order is on its way or ready for pickup."
            : "Your order is ready.",
      };
    case "preparing":
      return { title: "Being prepared", body: "The kitchen is preparing your order." };
    default:
      return { title: "Order received", body: "Your order is in the queue." };
  }
}

export function TrackStatus({ orderId }: { orderId: string }) {
  const hash = useSyncExternalStore(
    subscribeHash,
    () => window.location.hash,
    () => "",
  );
  const secret = readSecret(hash);
  const [order, setOrder] = useState<PublicOrderStatus | null>(null);
  const [state, setState] = useState<"loading" | "ok" | "missing" | "error">("loading");

  useEffect(() => {
    if (!secret) return;
    let cancelled = false;

    async function load() {
      try {
        const response = await fetch(`/api/public/orders/${encodeURIComponent(orderId)}`, {
          headers: { "x-tracking-secret": secret! },
          cache: "no-store",
        });
        if (cancelled) return;
        if (response.status === 404) {
          setState("missing");
          return;
        }
        if (!response.ok) {
          setState("error");
          return;
        }
        const data = (await response.json()) as { order: PublicOrderStatus };
        if (cancelled) return;
        setOrder(data.order);
        setState("ok");
      } catch {
        if (!cancelled) setState("error");
      }
    }

    load();
    const timer = setInterval(load, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [orderId, secret]);

  if (!secret) {
    return (
      <Panel
        title="We could not find this order"
        body="Open the link from your confirmation screen. It contains the key that unlocks your order."
      />
    );
  }
  if (state === "missing") {
    return (
      <Panel
        title="We could not find this order"
        body="Check the link you were given, or contact the restaurant."
      />
    );
  }
  if (state === "error") {
    return (
      <Panel
        title="Status is unavailable"
        body="We will keep trying. You can also refresh the page."
      />
    );
  }
  if (state === "loading" || !order) {
    return <p className="text-muted-foreground text-sm">Loading your order…</p>;
  }

  const view = headline(order);
  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <p className="text-muted-foreground text-xs tracking-widest uppercase">
          Order #{order.order_number}
        </p>
        <h1 className="font-display text-3xl font-semibold tracking-tight">{view.title}</h1>
        <p className="text-muted-foreground">{view.body}</p>
        {order.intake_status === "accepted" ? (
          <p className="text-muted-foreground text-sm">
            Accepted. Preparation time varies with the kitchen&apos;s queue.
          </p>
        ) : null}
      </div>

      <ul className="border-border bg-card space-y-2 rounded-xl border p-4 text-sm">
        {order.items.map((item, index) => (
          <li key={`${item.name}-${index}`} className="flex justify-between gap-3">
            <span>
              {item.quantity} × {item.name}
            </span>
            <span className="tabular-nums">₹{formatRupees(item.line_total_minor)}</span>
          </li>
        ))}
        <li className="border-border flex justify-between gap-3 border-t pt-2 font-medium">
          <span>Total (as recorded)</span>
          <span className="tabular-nums">₹{formatRupees(order.total_minor)}</span>
        </li>
      </ul>

      <p className="text-muted-foreground text-sm">
        {order.payment_mode
          ? `Payment: ${PAYMENT_MODE_LABELS[order.payment_mode] ?? order.payment_mode}.`
          : "Payment is taken by the restaurant."}{" "}
        {order.paid_minor > 0 ? "Paid in full." : "Not yet marked as paid."}
      </p>
      <p className="text-muted-foreground text-xs">
        Status: {INTAKE_LABELS[order.intake_status ?? ""] ?? order.status}. This page refreshes
        every 15 seconds.
      </p>
    </div>
  );
}

function Panel(props: { title: string; body: string }) {
  return (
    <div className="border-border bg-card space-y-2 rounded-xl border p-6">
      <h1 className="font-display text-2xl font-semibold tracking-tight">{props.title}</h1>
      <p className="text-muted-foreground text-sm">{props.body}</p>
    </div>
  );
}
