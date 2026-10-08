"use client";

import { useActionState } from "react";
import { ArrowRight } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { CURRENCIES, TIMEZONES } from "@/modules/business/schemas";
import { onboardingCreateBusinessAction, type OnboardingActionState } from "@/modules/onboarding/actions";
import { FieldError, FormError, SubmitButton } from "@/components/forms/form-bits";

export function CreateBusinessForm() {
  const [state, formAction, pending] = useActionState<OnboardingActionState | undefined, FormData>(
    onboardingCreateBusinessAction,
    undefined,
  );

  return (
    <form action={formAction} className="space-y-5" noValidate>
      <FormError state={state} />

      <div className="space-y-1.5">
        <Label htmlFor="ob-name">Business name</Label>
        <Input id="ob-name" name="name" placeholder="e.g. Spice Route Hospitality" required minLength={2} maxLength={80} />
        <FieldError state={state} name="name" />
      </div>

      <div className="grid gap-5 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="ob-currency">Currency</Label>
          <Select id="ob-currency" name="currency" defaultValue="INR">
            {CURRENCIES.map((code) => (
              <option key={code} value={code}>
                {code}
              </option>
            ))}
          </Select>
          <FieldError state={state} name="currency" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="ob-timezone">Timezone</Label>
          <Select id="ob-timezone" name="timezone" defaultValue="Asia/Kolkata">
            {TIMEZONES.map((zone) => (
              <option key={zone} value={zone}>
                {zone}
              </option>
            ))}
          </Select>
          <FieldError state={state} name="timezone" />
        </div>
      </div>

      <SubmitButton label="Create business" busyLabel="Creating…" pending={pending} />
      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <ArrowRight className="size-3.5" aria-hidden />
        Next up: choose your restaurant type.
      </p>
    </form>
  );
}
