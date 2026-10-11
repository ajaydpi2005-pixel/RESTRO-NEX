"use client";

import { useActionState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { FormError, FormSuccess, SubmitButton } from "@/components/forms/form-bits";
import { saveSupplierAction, type PurchasingActionState } from "@/modules/purchasing/actions";
import type { SupplierRow } from "@/modules/purchasing/queries";

/** Create or edit a supplier. Saving an edit refreshes the page; a new supplier opens its page. */
export function SupplierForm({ businessId, initial }: { businessId: string; initial?: SupplierRow }) {
  const router = useRouter();
  const [state, formAction, pending] = useActionState<PurchasingActionState | undefined, FormData>(
    saveSupplierAction,
    undefined,
  );

  useEffect(() => {
    if (!state?.ok) return;
    if (!initial && state.id) router.push(`/purchasing/suppliers/${state.id}?business=${businessId}`);
    else router.refresh();
  }, [state, initial, businessId, router]);

  const id = `supplier-${initial?.id ?? "new"}`;
  return (
    <form action={formAction} className="grid gap-3 sm:grid-cols-2" noValidate>
      <input type="hidden" name="businessId" value={businessId} />
      <input type="hidden" name="id" value={initial?.id ?? ""} />
      <FormError state={state} />
      <FormSuccess message={state?.ok && initial ? "Supplier saved." : undefined} />

      <div className="space-y-1.5 sm:col-span-2">
        <Label htmlFor={`${id}-name`}>Supplier name</Label>
        <Input id={`${id}-name`} name="name" required maxLength={120} defaultValue={initial?.name ?? ""} />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={`${id}-contact`}>Contact person</Label>
        <Input id={`${id}-contact`} name="contactName" maxLength={80} defaultValue={initial?.contactName ?? ""} />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={`${id}-phone`}>Phone</Label>
        <Input id={`${id}-phone`} name="phone" maxLength={20} defaultValue={initial?.phone ?? ""} />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={`${id}-email`}>Email</Label>
        <Input id={`${id}-email`} name="email" type="email" maxLength={254} defaultValue={initial?.email ?? ""} />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={`${id}-gstin`}>GSTIN</Label>
        <Input
          id={`${id}-gstin`}
          name="gstin"
          maxLength={15}
          placeholder="15 characters"
          defaultValue={initial?.gstin ?? ""}
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={`${id}-terms`}>Payment terms (days)</Label>
        <Input
          id={`${id}-terms`}
          name="paymentTermsDays"
          type="number"
          inputMode="numeric"
          min={0}
          max={365}
          defaultValue={initial?.paymentTermsDays ?? 0}
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={`${id}-status`}>Status</Label>
        <Select id={`${id}-status`} name="status" defaultValue={initial?.status ?? "active"}>
          <option value="active">Active</option>
          <option value="inactive">Inactive (no new orders)</option>
        </Select>
      </div>
      <div className="space-y-1.5 sm:col-span-2">
        <Label htmlFor={`${id}-address`}>Address</Label>
        <Input id={`${id}-address`} name="address" maxLength={300} defaultValue={initial?.address ?? ""} />
      </div>
      <div className="space-y-1.5 sm:col-span-2">
        <Label htmlFor={`${id}-notes`}>Notes</Label>
        <Input id={`${id}-notes`} name="notes" maxLength={500} defaultValue={initial?.notes ?? ""} />
      </div>
      <div className="sm:col-span-2">
        <SubmitButton
          label={initial ? "Save supplier" : "Add supplier"}
          busyLabel="Saving…"
          pending={pending}
          className="sm:w-auto"
        />
      </div>
    </form>
  );
}
