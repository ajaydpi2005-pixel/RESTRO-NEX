"use client";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { FormError, FormSuccess, SubmitButton } from "@/components/forms/form-bits";
import {
  deleteAddressAction,
  saveAddressAction,
  saveCustomerAction,
} from "@/modules/customers/actions";
import { useCrmAction } from "@/modules/customers/components/use-crm-action";

interface CustomerValues {
  id: string;
  name: string;
  phone: string;
  email: string | null;
  notes: string | null;
}

/** Create a customer, or edit one when `customer` is given. Phone is the customer's identity. */
export function CustomerForm({
  businessId,
  customer,
}: {
  businessId: string;
  customer?: CustomerValues;
}) {
  const editing = Boolean(customer);
  const { state, formAction, pending, formRef } = useCrmAction(saveCustomerAction, {
    resetOnSuccess: !editing,
  });
  const message = state?.ok ? (editing ? "Customer saved." : "Customer added.") : undefined;

  return (
    <form ref={formRef} action={formAction} className="grid gap-3" noValidate>
      <input type="hidden" name="businessId" value={businessId} />
      <input type="hidden" name="id" value={customer?.id ?? ""} />
      <FormError state={state} />
      <FormSuccess message={message} />
      <div className="space-y-1.5">
        <Label htmlFor={`c-name-${customer?.id ?? "new"}`}>Name</Label>
        <Input
          id={`c-name-${customer?.id ?? "new"}`}
          name="name"
          defaultValue={customer?.name ?? ""}
          maxLength={80}
          required
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={`c-phone-${customer?.id ?? "new"}`}>Phone</Label>
        <Input
          id={`c-phone-${customer?.id ?? "new"}`}
          name="phone"
          type="tel"
          inputMode="tel"
          defaultValue={customer?.phone ?? ""}
          placeholder="+91 98765 43210"
          required
        />
        <p className="text-muted-foreground text-xs">
          Customers are matched by the last 10 digits. Changing the phone re-links their orders.
        </p>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={`c-email-${customer?.id ?? "new"}`}>Email (optional)</Label>
        <Input
          id={`c-email-${customer?.id ?? "new"}`}
          name="email"
          type="email"
          defaultValue={customer?.email ?? ""}
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={`c-notes-${customer?.id ?? "new"}`}>Notes (optional)</Label>
        <Input
          id={`c-notes-${customer?.id ?? "new"}`}
          name="notes"
          defaultValue={customer?.notes ?? ""}
          maxLength={500}
        />
      </div>
      <SubmitButton
        label={editing ? "Save customer" : "Add customer"}
        busyLabel="Saving…"
        pending={pending}
      />
    </form>
  );
}

/** Adds a saved address to a customer. */
export function AddressForm({
  businessId,
  customerId,
}: {
  businessId: string;
  customerId: string;
}) {
  const { state, formAction, pending, formRef } = useCrmAction(saveAddressAction);
  return (
    <form
      ref={formRef}
      action={formAction}
      className="grid gap-3 sm:grid-cols-[1fr_2fr_auto] sm:items-end"
      noValidate
    >
      <input type="hidden" name="businessId" value={businessId} />
      <input type="hidden" name="customerId" value={customerId} />
      <input type="hidden" name="id" value="" />
      <div className="space-y-1.5">
        <Label htmlFor="addr-label">Label</Label>
        <Input id="addr-label" name="label" placeholder="Home" maxLength={30} required />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="addr-text">Address</Label>
        <Input id="addr-text" name="address" maxLength={300} required />
      </div>
      <Button type="submit" variant="outline" disabled={pending}>
        {pending ? "Saving…" : "Add address"}
      </Button>
      <div className="sm:col-span-3">
        <FormError state={state} />
      </div>
    </form>
  );
}

/** Removes one saved address. */
export function DeleteAddressButton({
  businessId,
  addressId,
}: {
  businessId: string;
  addressId: string;
}) {
  const { state, formAction, pending, formRef } = useCrmAction(deleteAddressAction);
  return (
    <form ref={formRef} action={formAction} className="inline">
      <input type="hidden" name="businessId" value={businessId} />
      <input type="hidden" name="id" value={addressId} />
      <Button
        type="submit"
        variant="ghost"
        size="sm"
        disabled={pending}
        aria-label="Remove address"
      >
        {pending ? "Removing…" : "Remove"}
      </Button>
      {state?.error ? (
        <span role="alert" className="text-destructive ml-2 text-xs">
          {state.error}
        </span>
      ) : null}
    </form>
  );
}
