"use client";

import { useActionState, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { FormError, FormSuccess, SubmitButton } from "@/components/forms/form-bits";
import { unitCostRupees } from "@/modules/inventory/math";
import { postSupplierInvoiceAction, type PurchasingActionState } from "@/modules/purchasing/actions";
import { paiseToDisplay, priceVarianceMinor, rupeesToPaise } from "@/modules/purchasing/money";
import type { BillableLine } from "@/modules/purchasing/queries";

/**
 * Bill received stock from one supplier. Only received lines that are not yet
 * billed are offered. The unit price starts at the order price; any change is
 * shown as a variance before posting. Quantities are never edited here: the
 * invoice bills what was received.
 */
export function SupplierInvoiceForm({
  businessId,
  outletId,
  supplierId,
  lines,
  today,
  dueDefault,
}: {
  businessId: string;
  outletId: string;
  supplierId: string;
  lines: BillableLine[];
  today: string;
  dueDefault: string;
}) {
  const router = useRouter();
  const [state, formAction, pending] = useActionState<PurchasingActionState | undefined, FormData>(
    postSupplierInvoiceAction,
    undefined,
  );
  const [ref, setRef] = useState(() => crypto.randomUUID());
  const [picked, setPicked] = useState<Record<string, { on: boolean; price: string }>>(() =>
    Object.fromEntries(lines.map((l) => [l.id, { on: true, price: String(unitCostRupees(l.orderedUnitCost)) }])),
  );
  const [tax, setTax] = useState("0");
  const [dates, setDates] = useState({ invoiceDate: today, dueOn: dueDefault });
  const [seenState, setSeenState] = useState(state);
  if (state !== seenState) {
    setSeenState(state);
    if (state?.ok) setRef(crypto.randomUUID());
  }
  useEffect(() => {
    if (state?.ok) router.refresh();
  }, [state, router]);

  const selected = lines.filter((l) => picked[l.id]?.on);
  // A blank price would post as zero, so block it here as well as on the server.
  const priceMissing = selected.some((l) => (picked[l.id]?.price ?? "").trim() === "");
  const subtotalPaise = selected.reduce((sum, l) => sum + rupeesToPaise(l.qty * Number(picked[l.id]!.price || 0)), 0);
  const taxPaise = rupeesToPaise(Number(tax) || 0);
  const variancePaise = selected.reduce(
    (sum, l) => sum + priceVarianceMinor(Number(picked[l.id]!.price || 0) * 100, l.orderedUnitCost, l.qty),
    0,
  );
  const payload = JSON.stringify(
    selected.map((l) => ({ goodsReceiptItemId: l.id, unitCostRupees: Number(picked[l.id]!.price || 0) })),
  );

  if (lines.length === 0) {
    return <p className="text-sm text-muted-foreground">Every received line from this supplier has been billed.</p>;
  }

  return (
    <form action={formAction} className="space-y-4" noValidate>
      <input type="hidden" name="businessId" value={businessId} />
      <input type="hidden" name="outletId" value={outletId} />
      <input type="hidden" name="supplierId" value={supplierId} />
      <input type="hidden" name="clientRef" value={ref} />
      <input type="hidden" name="lines" value={payload} />
      <FormError state={state} />
      <FormSuccess message={state?.ok ? "Invoice recorded." : undefined} />

      <div className="grid gap-3 sm:grid-cols-4">
        <div className="space-y-1.5">
          <Label htmlFor="inv-number">Supplier invoice number</Label>
          <Input id="inv-number" name="invoiceNumber" required maxLength={40} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="inv-date">Invoice date</Label>
          <Input
            id="inv-date"
            name="invoiceDate"
            type="date"
            required
            value={dates.invoiceDate}
            onChange={(e) => setDates((d) => ({ ...d, invoiceDate: e.target.value }))}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="inv-due">Due date</Label>
          <Input
            id="inv-due"
            name="dueOn"
            type="date"
            required
            value={dates.dueOn}
            onChange={(e) => setDates((d) => ({ ...d, dueOn: e.target.value }))}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="inv-tax">Tax (₹)</Label>
          <Input
            id="inv-tax"
            name="taxRupees"
            type="number"
            inputMode="decimal"
            step="0.01"
            min="0"
            value={tax}
            onChange={(e) => setTax(e.target.value)}
          />
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-left text-muted-foreground">
            <tr>
              <th className="py-2 font-medium">Bill</th>
              <th className="py-2 font-medium">Received</th>
              <th className="py-2 text-right font-medium">Qty</th>
              <th className="py-2 text-right font-medium">Ordered ₹/unit</th>
              <th className="py-2 text-right font-medium">Billed ₹/unit</th>
              <th className="py-2 text-right font-medium">Variance</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l) => {
              const p = picked[l.id] ?? { on: false, price: "0" };
              const variance = p.on
                ? priceVarianceMinor(Number(p.price || 0) * 100, l.orderedUnitCost, l.qty)
                : 0;
              return (
                <tr key={l.id} className="border-t">
                  <td className="py-2">
                    <label className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={p.on}
                        onChange={(e) =>
                          setPicked((prev) => ({ ...prev, [l.id]: { ...p, on: e.target.checked } }))
                        }
                        aria-label={`Bill ${l.ingredientName} from receipt ${l.receiptNumber}`}
                      />
                      {l.ingredientName}
                      {l.batchCode ? <span className="text-muted-foreground"> · {l.batchCode}</span> : null}
                    </label>
                  </td>
                  <td className="py-2 text-muted-foreground">
                    #{l.receiptNumber} · {l.receivedOn}
                  </td>
                  <td className="py-2 text-right tabular-nums">
                    {l.qty} {l.unit}
                  </td>
                  <td className="py-2 text-right tabular-nums text-muted-foreground">
                    {unitCostRupees(l.orderedUnitCost)}
                  </td>
                  <td className="py-2 text-right">
                    <Input
                      aria-label={`Billed price for ${l.ingredientName}`}
                      type="number"
                      inputMode="decimal"
                      step="0.01"
                      min="0"
                      className="ml-auto w-28 text-right"
                      value={p.price}
                      disabled={!p.on}
                      onChange={(e) => setPicked((prev) => ({ ...prev, [l.id]: { ...p, price: e.target.value } }))}
                    />
                  </td>
                  <td
                    className={`py-2 text-right tabular-nums ${variance > 0 ? "text-destructive" : "text-muted-foreground"}`}
                  >
                    {p.on && variance !== 0 ? `${variance > 0 ? "+" : ""}₹${paiseToDisplay(variance)}` : "—"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="space-y-1.5">
          <Label htmlFor="inv-notes">Notes</Label>
          <Input id="inv-notes" name="notes" maxLength={300} />
        </div>
        <p className="text-sm tabular-nums">
          Subtotal ₹{paiseToDisplay(subtotalPaise)} · Tax ₹{paiseToDisplay(taxPaise)} ·{" "}
          <span className="font-semibold">Total ₹{paiseToDisplay(subtotalPaise + taxPaise)}</span>
          {variancePaise !== 0 ? (
            <span className={variancePaise > 0 ? "text-destructive" : "text-muted-foreground"}>
              {" "}
              · price variance {variancePaise > 0 ? "+" : ""}₹{paiseToDisplay(variancePaise)}
            </span>
          ) : null}
        </p>
      </div>

      <SubmitButton
        label="Record supplier invoice"
        busyLabel="Recording…"
        pending={pending || selected.length === 0 || priceMissing}
        className="sm:w-auto"
      />
    </form>
  );
}
