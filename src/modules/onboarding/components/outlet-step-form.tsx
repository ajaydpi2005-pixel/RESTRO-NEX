"use client";

import { useActionState } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ORDER_TYPES, ORDER_TYPE_LABELS } from "@/modules/business/schemas";
import { onboardingOutletAction, type OnboardingActionState } from "@/modules/onboarding/actions";
import { FieldError, FormError, SubmitButton } from "@/components/forms/form-bits";

const ORDER_TYPE_HINTS: Record<(typeof ORDER_TYPES)[number], string> = {
  dine_in: "Guests order at tables",
  takeaway: "Pickup at the counter",
  delivery: "Delivered to the door",
};

export function OutletStepForm({ businessId }: { businessId: string }) {
  const [state, formAction, pending] = useActionState<OnboardingActionState | undefined, FormData>(
    onboardingOutletAction,
    undefined,
  );

  return (
    <form action={formAction} className="space-y-5" noValidate>
      <input type="hidden" name="businessId" value={businessId} />
      <FormError state={state} />

      <div className="space-y-1.5">
        <Label htmlFor="outlet-name">Outlet name</Label>
        <Input id="outlet-name" name="name" placeholder="e.g. Anna Nagar" required minLength={2} maxLength={80} />
        <FieldError state={state} name="name" />
      </div>

      <div className="grid gap-5 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="outlet-phone">Phone</Label>
          <Input id="outlet-phone" name="phone" placeholder="+91 98765 43210" />
          <FieldError state={state} name="phone" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="outlet-email">Email</Label>
          <Input id="outlet-email" name="email" type="email" placeholder="outlet@restaurant.com" />
          <FieldError state={state} name="email" />
        </div>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="outlet-address1">Address line 1</Label>
        <Input id="outlet-address1" name="addressLine1" placeholder="Street address" maxLength={120} />
      </div>

      <div className="grid gap-5 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="outlet-city">City</Label>
          <Input id="outlet-city" name="city" maxLength={80} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="outlet-state">State</Label>
          <Input id="outlet-state" name="state" maxLength={80} />
        </div>
      </div>

      <fieldset className="space-y-2.5">
        <legend className="text-sm font-medium">Order types</legend>
        <div className="grid gap-2.5 sm:grid-cols-3">
          {ORDER_TYPES.map((type) => (
            <label
              key={type}
              className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-ink/15 bg-white p-3 transition-colors hover:border-ink/35 has-[:checked]:border-gold-deep has-[:checked]:bg-gold/10"
            >
              <input
                type="checkbox"
                name="orderTypes"
                value={type}
                defaultChecked={type === "dine_in"}
                className="mt-0.5 size-4 accent-ink"
              />
              <span>
                <span className="block text-sm font-medium">{ORDER_TYPE_LABELS[type]}</span>
                <span className="block text-xs text-muted-foreground">{ORDER_TYPE_HINTS[type]}</span>
              </span>
            </label>
          ))}
        </div>
        <FieldError state={state} name="orderTypes" />
      </fieldset>

      <SubmitButton label="Save & continue" busyLabel="Saving…" pending={pending} />
    </form>
  );
}
