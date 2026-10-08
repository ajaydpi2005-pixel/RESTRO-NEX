"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Loader2, PencilLine } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { transitionOrder } from "@/modules/orders/actions";
import { allowedTransitions, type OrderState } from "@/modules/orders/state";
import { PAYMENT_COLLECTION_AVAILABLE } from "@/modules/orders/payment-recording";

const TRANSITION_LABELS: Partial<Record<OrderState, string>> = {
  held: "Hold",
  open: "Resume",
  placed: "Place order",
  preparing: "Start preparing",
  ready: "Mark ready",
  completed: "Complete",
  cancelled: "Cancel order",
};

/**
 * State-machine controls for one order. Every move goes through the guarded
 * transition_order_status RPC; `completed` additionally requires payment,
 * which arrives in Phase 10 (see payment-recording.ts).
 */
export function OrderActions({
  businessId,
  orderId,
  outletId,
  status,
  canManage,
}: {
  businessId: string;
  orderId: string;
  outletId: string;
  status: OrderState;
  canManage: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [cancelNote, setCancelNote] = React.useState("");

  if (!canManage) return null;
  const next = allowedTransitions(status);
  if (next.length === 0) return null;

  async function move(to: OrderState, note?: string) {
    if (busy) return;
    setBusy(to);
    setError(null);
    const formData = new FormData();
    formData.set("businessId", businessId);
    formData.set("orderId", orderId);
    formData.set("toStatus", to);
    if (note) formData.set("note", note);
    const result = await transitionOrder(formData);
    if (!result.ok) {
      setError(result.error ?? "The order could not be updated.");
      setBusy(null);
      return;
    }
    router.refresh();
    setBusy(null);
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        {status === "open" || status === "held" ? (
          <Button asChild variant="outline" className="h-10">
            <Link href={`/pos?business=${businessId}&outlet=${outletId}&order=${orderId}`}>
              <PencilLine /> Edit in POS
            </Link>
          </Button>
        ) : null}
        {next
          .filter((to) => to !== "cancelled")
          .map((to) => {
            const blocked = to === "completed" && !PAYMENT_COLLECTION_AVAILABLE;
            return (
              <Button
                key={to}
                type="button"
                variant={to === "completed" ? "secondary" : "default"}
                className={to === "completed" ? "" : "h-10 bg-ink text-parchment hover:bg-ink-soft"}
                disabled={busy !== null || blocked}
                title={blocked ? "Payment collection arrives in Phase 10" : undefined}
                onClick={() => void move(to)}
              >
                {busy === to ? <Loader2 className="animate-spin" /> : null}
                {TRANSITION_LABELS[to] ?? to}
              </Button>
            );
          })}
      </div>

      {next.includes("cancelled") ? (
        <div className="space-y-2 rounded-lg border border-destructive/25 bg-destructive/5 p-3">
          <div className="flex gap-2">
            <Input
              aria-label="Cancellation note"
              value={cancelNote}
              onChange={(e) => setCancelNote(e.target.value)}
              placeholder="Reason (optional)"
              className="h-9 flex-1"
            />
            <Button
              type="button"
              variant="destructive"
              className="h-9"
              disabled={busy !== null}
              onClick={() => void move("cancelled", cancelNote.trim() || undefined)}
            >
              {busy === "cancelled" ? <Loader2 className="animate-spin" /> : null}
              Cancel order
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Cancelling is final — it can&apos;t be undone, and the order keeps its number.
          </p>
        </div>
      ) : null}

      {status === "ready" ? (
        <p className="text-xs text-muted-foreground">
          Completing this order requires a recorded payment — payment collection ships in the next phase.
        </p>
      ) : null}

      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
