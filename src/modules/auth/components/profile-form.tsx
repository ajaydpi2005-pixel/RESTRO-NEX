"use client";

import { useActionState } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { updateProfileAction } from "@/modules/auth/actions";
import {
  FieldError,
  FormError,
  FormSuccess,
  SubmitButton,
} from "@/modules/auth/components/form-bits";

export function ProfileForm({
  initialFullName,
  initialPhone,
}: {
  initialFullName: string;
  initialPhone: string;
}) {
  const [state, formAction, pending] = useActionState(updateProfileAction, undefined);

  return (
    <form action={formAction} className="space-y-4" noValidate>
      <FormError state={state} />
      <FormSuccess message={state?.ok ? "Profile saved." : undefined} />

      <div className="space-y-1.5">
        <Label htmlFor="fullName">Full name</Label>
        <Input id="fullName" name="fullName" defaultValue={initialFullName} autoComplete="name" required />
        <FieldError state={state} name="fullName" />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="phone">Phone</Label>
        <Input
          id="phone"
          name="phone"
          type="tel"
          defaultValue={initialPhone}
          autoComplete="tel"
          placeholder="+91 98765 43210"
        />
        <FieldError state={state} name="phone" />
      </div>

      <SubmitButton label="Save profile" busyLabel="Saving…" pending={pending} />
    </form>
  );
}
