"use client";

import { useActionState } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { CURRENCIES, TIMEZONES } from "@/modules/business/schemas";
import { saveOnboardingSettingsAction, type OnboardingActionState } from "@/modules/onboarding/actions";
import type { OnboardingBusiness } from "@/modules/onboarding/queries";
import { FieldError, FormError, SubmitButton } from "@/components/forms/form-bits";

export function SettingsStepForm({ business }: { business: OnboardingBusiness }) {
  const [state, formAction, pending] = useActionState<OnboardingActionState | undefined, FormData>(
    saveOnboardingSettingsAction,
    undefined,
  );

  return (
    <form action={formAction} className="space-y-5" noValidate>
      <input type="hidden" name="businessId" value={business.id} />
      <FormError state={state} />

      <div className="space-y-1.5">
        <Label htmlFor="set-name">Business name</Label>
        <Input id="set-name" name="name" defaultValue={business.name} required minLength={2} maxLength={80} />
        <FieldError state={state} name="name" />
      </div>

      <div className="grid gap-5 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="set-email">Email</Label>
          <Input id="set-email" name="email" type="email" defaultValue={business.email ?? ""} placeholder="hello@restaurant.com" />
          <FieldError state={state} name="email" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="set-phone">Phone</Label>
          <Input id="set-phone" name="phone" defaultValue={business.phone ?? ""} placeholder="+91 98765 43210" />
          <FieldError state={state} name="phone" />
        </div>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="set-address1">Address line 1</Label>
        <Input id="set-address1" name="addressLine1" defaultValue={business.addressLine1 ?? ""} maxLength={120} />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="set-address2">Address line 2</Label>
        <Input id="set-address2" name="addressLine2" defaultValue={business.addressLine2 ?? ""} maxLength={120} />
      </div>

      <div className="grid gap-5 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="set-city">City</Label>
          <Input id="set-city" name="city" defaultValue={business.city ?? ""} maxLength={80} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="set-state">State</Label>
          <Input id="set-state" name="state" defaultValue={business.state ?? ""} maxLength={80} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="set-postal">Postal code</Label>
          <Input id="set-postal" name="postalCode" defaultValue={business.postalCode ?? ""} maxLength={12} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="set-country">Country</Label>
          <Input id="set-country" name="country" defaultValue={business.country ?? ""} maxLength={80} />
        </div>
      </div>

      <div className="grid gap-5 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="set-currency">Currency</Label>
          <Select id="set-currency" name="currency" defaultValue={business.currencyCode}>
            {CURRENCIES.map((code) => (
              <option key={code} value={code}>
                {code}
              </option>
            ))}
          </Select>
          <FieldError state={state} name="currency" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="set-timezone">Timezone</Label>
          <Select id="set-timezone" name="timezone" defaultValue={business.timezone}>
            {TIMEZONES.map((zone) => (
              <option key={zone} value={zone}>
                {zone}
              </option>
            ))}
          </Select>
          <FieldError state={state} name="timezone" />
        </div>
      </div>

      <SubmitButton label="Save & continue" busyLabel="Saving…" pending={pending} />
    </form>
  );
}
