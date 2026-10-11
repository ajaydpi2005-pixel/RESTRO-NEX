"use client";

import { useActionState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { FormError, FormSuccess, SubmitButton } from "@/components/forms/form-bits";
import {
  cancelPurchaseOrderAction,
  sendPurchaseOrderAction,
  type PurchasingActionState,
} from "@/modules/purchasing/actions";

/** Send a draft to the supplier. Sending does not move stock; receiving does. */
export function SendOrderButton({
  businessId,
  outletId,
  purchaseOrderId,
}: {
  businessId: string;
  outletId: string;
  purchaseOrderId: string;
}) {
  const router = useRouter();
  const [state, formAction, pending] = useActionState<PurchasingActionState | undefined, FormData>(
    sendPurchaseOrderAction,
    undefined,
  );
  useEffect(() => {
    if (state?.ok) router.refresh();
  }, [state, router]);
  return (
    <form action={formAction} className="space-y-2">
      <input type="hidden" name="businessId" value={businessId} />
      <input type="hidden" name="outletId" value={outletId} />
      <input type="hidden" name="purchaseOrderId" value={purchaseOrderId} />
      <FormError state={state} />
      <SubmitButton label="Mark as sent to supplier" busyLabel="Sending…" pending={pending} className="sm:w-auto" />
    </form>
  );
}

/** Cancel an order that has no received stock. The reason is kept on the order. */
export function CancelOrderForm({
  businessId,
  outletId,
  purchaseOrderId,
}: {
  businessId: string;
  outletId: string;
  purchaseOrderId: string;
}) {
  const router = useRouter();
  const [state, formAction, pending] = useActionState<PurchasingActionState | undefined, FormData>(
    cancelPurchaseOrderAction,
    undefined,
  );
  useEffect(() => {
    if (state?.ok) router.refresh();
  }, [state, router]);
  return (
    <form action={formAction} className="space-y-2">
      <input type="hidden" name="businessId" value={businessId} />
      <input type="hidden" name="outletId" value={outletId} />
      <input type="hidden" name="purchaseOrderId" value={purchaseOrderId} />
      <div className="space-y-1.5">
        <Label htmlFor={`cancel-${purchaseOrderId}`}>Reason for cancelling</Label>
        <Input id={`cancel-${purchaseOrderId}`} name="reason" required minLength={3} maxLength={200} />
      </div>
      <FormError state={state} />
      <FormSuccess message={state?.ok ? "Order cancelled." : undefined} />
      <Button type="submit" variant="outline" disabled={pending} className="sm:w-auto">
        {pending ? "Cancelling…" : "Cancel order"}
      </Button>
    </form>
  );
}
