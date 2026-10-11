"use client";

import { useActionState, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { FormError, FormSuccess, SubmitButton } from "@/components/forms/form-bits";
import { postGoodsReceiptAction, type PurchasingActionState } from "@/modules/purchasing/actions";
import { toBaseQty } from "@/modules/inventory/units";

export interface ReceiveLine {
  poItemId: string;
  ingredientName: string;
  ingredientUnit: string;
  unit: string;
  /** Still to receive, in the order's unit. */
  outstanding: number;
}

/**
 * Goods receiving against one purchase order. Quantities are in the order's
 * unit and cannot exceed what is outstanding; the database enforces the same
 * limit and books one ledger receipt per line. A retry with the same reference
 * returns the first receipt.
 */
export function ReceiveForm({
  businessId,
  outletId,
  purchaseOrderId,
  lines,
}: {
  businessId: string;
  outletId: string;
  purchaseOrderId: string;
  lines: ReceiveLine[];
}) {
  const router = useRouter();
  const [state, formAction, pending] = useActionState<PurchasingActionState | undefined, FormData>(
    postGoodsReceiptAction,
    undefined,
  );
  const [ref, setRef] = useState(() => crypto.randomUUID());
  const [values, setValues] = useState<Record<string, { qty: string; batchCode: string; expiresOn: string }>>({});
  const [seenState, setSeenState] = useState(state);
  // Rotate the idempotency key once per success (render-phase update).
  if (state !== seenState) {
    setSeenState(state);
    if (state?.ok) setRef(crypto.randomUUID());
  }
  useEffect(() => {
    if (state?.ok) router.refresh();
  }, [state, router]);

  const field = (id: string) => values[id] ?? { qty: "", batchCode: "", expiresOn: "" };
  const patch = (id: string, next: Partial<{ qty: string; batchCode: string; expiresOn: string }>) =>
    setValues((prev) => ({ ...prev, [id]: { ...field(id), ...next } }));

  // Client-side guard that mirrors the database rule; the server still decides.
  const overLines = lines.filter((l) => {
    const q = Number(field(l.poItemId).qty);
    return q > 0 && q > l.outstanding + 1e-9;
  });
  const payload = JSON.stringify(
    lines
      .filter((l) => Number(field(l.poItemId).qty) > 0)
      .map((l) => {
        const v = field(l.poItemId);
        return {
          poItemId: l.poItemId,
          qty: Number(v.qty),
          unit: l.unit,
          batchCode: v.batchCode || undefined,
          expiresOn: v.expiresOn || undefined,
        };
      }),
  );
  const anyEntered = lines.some((l) => Number(field(l.poItemId).qty) > 0);

  return (
    <form action={formAction} className="space-y-4" noValidate>
      <input type="hidden" name="businessId" value={businessId} />
      <input type="hidden" name="outletId" value={outletId} />
      <input type="hidden" name="purchaseOrderId" value={purchaseOrderId} />
      <input type="hidden" name="clientRef" value={ref} />
      <input type="hidden" name="lines" value={payload} />
      <FormError state={state} />
      <FormSuccess message={state?.ok ? "Delivery received. Stock is updated." : undefined} />

      <div className="space-y-3">
        {lines.map((l) => {
          const v = field(l.poItemId);
          const over = overLines.includes(l);
          const base = (() => {
            try {
              return toBaseQty(l.ingredientUnit, l.unit, Number(v.qty) || 0);
            } catch {
              return 0;
            }
          })();
          return (
            <fieldset key={l.poItemId} className="space-y-2 rounded-lg border p-3">
              <legend className="px-1 text-sm font-medium">{l.ingredientName}</legend>
              <p className="text-xs text-muted-foreground">
                Outstanding: {l.outstanding} {l.unit}
              </p>
              <div className="grid gap-2 sm:grid-cols-3">
                <div className="space-y-1">
                  <Label htmlFor={`rx-${l.poItemId}-qty`}>Received ({l.unit})</Label>
                  <Input
                    id={`rx-${l.poItemId}-qty`}
                    type="number"
                    inputMode="decimal"
                    step="0.001"
                    min="0"
                    max={l.outstanding}
                    value={v.qty}
                    onChange={(e) => patch(l.poItemId, { qty: e.target.value })}
                    aria-invalid={over || undefined}
                  />
                  {over ? (
                    <p role="alert" className="text-xs text-destructive">
                      More than outstanding. Receive up to {l.outstanding} {l.unit}.
                    </p>
                  ) : Number(v.qty) > 0 && base > 0 ? (
                    <p className="text-xs text-muted-foreground">Adds {base} {l.ingredientUnit} to stock</p>
                  ) : null}
                </div>
                <div className="space-y-1">
                  <Label htmlFor={`rx-${l.poItemId}-batch`}>Batch code</Label>
                  <Input
                    id={`rx-${l.poItemId}-batch`}
                    maxLength={40}
                    value={v.batchCode}
                    onChange={(e) => patch(l.poItemId, { batchCode: e.target.value })}
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor={`rx-${l.poItemId}-expiry`}>Expiry date</Label>
                  <Input
                    id={`rx-${l.poItemId}-expiry`}
                    type="date"
                    value={v.expiresOn}
                    onChange={(e) => patch(l.poItemId, { expiresOn: e.target.value })}
                  />
                </div>
              </div>
            </fieldset>
          );
        })}
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="rx-note">Delivery note number (optional)</Label>
        <Input id="rx-note" name="deliveryNote" maxLength={120} />
      </div>

      <SubmitButton
        label="Receive delivery"
        busyLabel="Receiving…"
        pending={pending || overLines.length > 0 || !anyEntered}
        className="sm:w-auto"
      />
    </form>
  );
}
