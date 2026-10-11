"use client";

import { useActionState, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { FormError, FormSuccess, SubmitButton } from "@/components/forms/form-bits";
import { recordSupplierPaymentAction, type PurchasingActionState } from "@/modules/purchasing/actions";
import { paiseToDisplay } from "@/modules/purchasing/money";

/**
 * Record a payment to a supplier. It is on account: the database refuses any
 * amount above what is owed, and a retry with the same reference is harmless.
 */
export function SupplierPaymentForm({
  businessId,
  supplierId,
  owedMinor,
  today,
}: {
  businessId: string;
  supplierId: string;
  owedMinor: number;
  today: string;
}) {
  const router = useRouter();
  const [state, formAction, pending] = useActionState<PurchasingActionState | undefined, FormData>(
    recordSupplierPaymentAction,
    undefined,
  );
  const [ref, setRef] = useState(() => crypto.randomUUID());
  const [seenState, setSeenState] = useState(state);
  if (state !== seenState) {
    setSeenState(state);
    if (state?.ok) setRef(crypto.randomUUID());
  }
  useEffect(() => {
    if (state?.ok) router.refresh();
  }, [state, router]);

  const [amount, setAmount] = useState(owedMinor > 0 ? String(owedMinor / 100) : "");
  const owed = owedMinor > 0 ? paiseToDisplay(owedMinor) : "0";

  return (
    <form action={formAction} className="grid gap-3 sm:grid-cols-2" noValidate>
      <input type="hidden" name="businessId" value={businessId} />
      <input type="hidden" name="supplierId" value={supplierId} />
      <input type="hidden" name="clientRef" value={ref} />
      <FormError state={state} />
      <FormSuccess message={state?.ok ? "Payment recorded." : undefined} />
      <p className="text-sm text-muted-foreground sm:col-span-2">
        Owed to this supplier: <span className="font-semibold text-foreground">₹{owed}</span>
      </p>
      <div className="space-y-1.5">
        <Label htmlFor="pay-amount">Amount (₹)</Label>
        <Input
          id="pay-amount"
          name="amountRupees"
          type="number"
          inputMode="decimal"
          step="0.01"
          min="0.01"
          required
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="pay-method">Method</Label>
        <Select id="pay-method" name="method" defaultValue="bank_transfer">
          <option value="bank_transfer">Bank transfer</option>
          <option value="cash">Cash</option>
          <option value="upi">UPI</option>
          <option value="cheque">Cheque</option>
          <option value="card">Card</option>
          <option value="other">Other</option>
        </Select>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="pay-date">Paid on</Label>
        <Input id="pay-date" name="paidOn" type="date" defaultValue={today} />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="pay-ref">Reference (UTR, cheque no.)</Label>
        <Input id="pay-ref" name="reference" maxLength={80} />
      </div>
      <div className="sm:col-span-2">
        <SubmitButton
          label="Record payment"
          busyLabel="Recording…"
          pending={pending || owedMinor <= 0}
          className="sm:w-auto"
        />
      </div>
    </form>
  );
}
