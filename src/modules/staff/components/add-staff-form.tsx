"use client";

import { useActionState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { UserPlus } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { ROLE_META, type Role } from "@/lib/rbac/permissions";
import { addStaffAction, type StaffActionState } from "@/modules/staff/actions";
import { FieldError, FormError, FormSuccess, SubmitButton } from "@/components/forms/form-bits";

export interface AssignableOutlet {
  id: string;
  name: string;
}

export function AddStaffForm({
  businessId,
  assignableRoles,
  outlets,
}: {
  businessId: string;
  assignableRoles: Role[];
  outlets: AssignableOutlet[];
}) {
  const router = useRouter();
  const [state, formAction, pending] = useActionState<StaffActionState | undefined, FormData>(
    addStaffAction,
    undefined,
  );

  useEffect(() => {
    if (state?.ok) {
      router.refresh();
    }
  }, [state, router]);

  return (
    <form action={formAction} className="space-y-4" noValidate>
      <input type="hidden" name="businessId" value={businessId} />
      <FormError state={state} />
      <FormSuccess message={state?.ok ? "Staff member added." : undefined} />

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="staff-email">Email</Label>
          <Input
            id="staff-email"
            name="email"
            type="email"
            placeholder="colleague@company.com"
            required
          />
          <p className="text-xs text-muted-foreground">
            They must already have a RestroNex account.
          </p>
          <FieldError state={state} name="email" />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="staff-role">Role</Label>
          <Select id="staff-role" name="role" required defaultValue={assignableRoles[0] ?? "cashier"}>
            {assignableRoles.map((role) => (
              <option key={role} value={role}>
                {ROLE_META[role].label}
              </option>
            ))}
          </Select>
          <FieldError state={state} name="role" />
        </div>
      </div>

      {outlets.length > 0 ? (
        <div className="space-y-1.5">
          <Label>Outlets</Label>
          <div className="flex flex-wrap gap-x-6 gap-y-2">
            {outlets.map((outlet) => (
              <label key={outlet.id} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  name="outletId"
                  value={outlet.id}
                  className="size-4 accent-[#D4B477]"
                />
                {outlet.name}
              </label>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">
            Required for outlet roles (manager, cashier, waiter, kitchen). Admins and owners
            reach every outlet automatically.
          </p>
          <FieldError state={state} name="outletIds" />
        </div>
      ) : null}

      <SubmitButton
        label="Add staff member"
        busyLabel="Adding…"
        pending={pending}
        className="w-fit"
      />
      <span className="sr-only">
        <UserPlus />
      </span>
    </form>
  );
}
