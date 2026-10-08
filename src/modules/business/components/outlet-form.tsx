"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Store } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  ORDER_TYPES,
  ORDER_TYPE_LABELS,
  WEEKDAYS,
  WEEKDAY_LABELS,
  type OperatingHours,
} from "@/modules/business/schemas";
import {
  createOutletAction,
  updateOutletAction,
  type BusinessActionState,
} from "@/modules/business/actions";
import { FieldError, FormError, FormSuccess, SubmitButton } from "@/components/forms/form-bits";

export interface OutletFormInitial {
  name: string;
  code: string;
  email: string;
  phone: string;
  addressLine1: string;
  addressLine2: string;
  city: string;
  state: string;
  postalCode: string;
  country: string;
  orderTypes: string[];
  operatingHours: OperatingHours;
}

interface DayState {
  closed: boolean;
  open: string;
  close: string;
}

function toDayState(hours: OperatingHours, day: string): DayState {
  const entry = hours[day as keyof OperatingHours];
  if (entry && typeof entry === "object") {
    return { closed: false, open: entry.open ?? "09:00", close: entry.close ?? "22:00" };
  }
  return { closed: true, open: "09:00", close: "22:00" };
}

function Field({
  id,
  label,
  error,
  className,
  children,
}: {
  id: string;
  label: string;
  error?: string | null;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={`space-y-1.5 ${className ?? ""}`}>
      <Label htmlFor={id}>{label}</Label>
      {children}
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </div>
  );
}

export function OutletForm({
  mode,
  businessId,
  outletId,
  initial,
}: {
  mode: "create" | "edit";
  businessId: string;
  outletId?: string;
  initial?: Partial<OutletFormInitial>;
}) {
  const router = useRouter();
  const action = mode === "create" ? createOutletAction : updateOutletAction;
  const [state, formAction, pending] = useActionState<BusinessActionState | undefined, FormData>(
    action,
    undefined,
  );

  const [days, setDays] = useState<Record<string, DayState>>(() => {
    const next: Record<string, DayState> = {};
    for (const day of WEEKDAYS) next[day] = toDayState(initial?.operatingHours ?? {}, day);
    return next;
  });
  const hoursJsonRef = useRef<HTMLInputElement>(null);

  const serialiseHours = (): string => {
    const out: Record<string, { open: string; close: string } | null> = {};
    for (const day of WEEKDAYS) {
      const d = days[day];
      out[day] = d && !d.closed && d.open && d.close ? { open: d.open, close: d.close } : null;
    }
    return JSON.stringify(out);
  };

  useEffect(() => {
    if (state?.ok) {
      router.replace(`/settings/outlets?business=${businessId}`);
      router.refresh();
    }
  }, [state, router, businessId]);

  const firstError = (name: string) => state?.fieldErrors?.[name]?.[0] ?? null;

  return (
    <form
      action={formAction}
      className="space-y-8"
      noValidate
      onSubmit={() => {
        if (hoursJsonRef.current) hoursJsonRef.current.value = serialiseHours();
      }}
    >
      {mode === "create" ? <input type="hidden" name="businessId" value={businessId} /> : null}
      {mode === "edit" && outletId ? <input type="hidden" name="outletId" value={outletId} /> : null}
      <input ref={hoursJsonRef} type="hidden" name="operatingHours" value={serialiseHours()} />

      <FormError state={state} />
      <FormSuccess message={state?.ok ? "Outlet saved." : undefined} />

      <section className="space-y-4">
        <h3 className="text-xs font-semibold tracking-widest text-muted-foreground uppercase">Outlet</h3>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field id="name" label="Outlet name" error={firstError("name")}>
            <Input id="name" name="name" defaultValue={initial?.name ?? ""} placeholder="e.g. Anna Nagar" required minLength={2} maxLength={80} />
          </Field>
          <Field id="code" label="Outlet code" error={firstError("code")}>
            <Input
              id="code"
              name="code"
              defaultValue={initial?.code ?? ""}
              placeholder="OUT-01"
              required
              maxLength={16}
              className="font-mono uppercase"
            />
          </Field>
          <Field id="email" label="Email" error={firstError("email")}>
            <Input id="email" name="email" type="email" defaultValue={initial?.email ?? ""} />
          </Field>
          <Field id="phone" label="Phone" error={firstError("phone")}>
            <Input id="phone" name="phone" type="tel" defaultValue={initial?.phone ?? ""} />
          </Field>
        </div>
      </section>

      <section className="space-y-4">
        <h3 className="text-xs font-semibold tracking-widest text-muted-foreground uppercase">Address</h3>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field id="addressLine1" label="Address line 1" error={firstError("addressLine1")}>
            <Input id="addressLine1" name="addressLine1" defaultValue={initial?.addressLine1 ?? ""} />
          </Field>
          <Field id="addressLine2" label="Address line 2" error={firstError("addressLine2")}>
            <Input id="addressLine2" name="addressLine2" defaultValue={initial?.addressLine2 ?? ""} />
          </Field>
          <Field id="city" label="City" error={firstError("city")}>
            <Input id="city" name="city" defaultValue={initial?.city ?? ""} />
          </Field>
          <Field id="state" label="State" error={firstError("state")}>
            <Input id="state" name="state" defaultValue={initial?.state ?? ""} />
          </Field>
          <Field id="postalCode" label="Postal code" error={firstError("postalCode")}>
            <Input id="postalCode" name="postalCode" defaultValue={initial?.postalCode ?? ""} />
          </Field>
          <Field id="country" label="Country" error={firstError("country")}>
            <Input id="country" name="country" defaultValue={initial?.country ?? ""} />
          </Field>
        </div>
      </section>

      <section className="space-y-4">
        <h3 className="text-xs font-semibold tracking-widest text-muted-foreground uppercase">Order types</h3>
        <div className="flex flex-wrap gap-4">
          {ORDER_TYPES.map((type) => (
            <label key={type} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                name="orderTypes"
                value={type}
                defaultChecked={(initial?.orderTypes ?? ["dine_in"]).includes(type)}
                className="size-4 accent-[#D4B477]"
              />
              {ORDER_TYPE_LABELS[type]}
            </label>
          ))}
        </div>
        <FieldError state={state} name="orderTypes" />
      </section>

      <section className="space-y-4">
        <h3 className="text-xs font-semibold tracking-widest text-muted-foreground uppercase">
          Operating hours <span className="normal-case text-muted-foreground/70">(leave closed for days off)</span>
        </h3>
        <div className="space-y-2">
          {WEEKDAYS.map((day) => {
            const d: DayState = days[day] ?? { closed: true, open: "09:00", close: "22:00" };
            return (
              <div key={day} className="flex flex-wrap items-center gap-3 rounded-lg border border-foreground/10 px-3 py-2">
                <span className="w-24 text-sm font-medium">{WEEKDAY_LABELS[day]}</span>
                <label className="flex items-center gap-2 text-sm text-muted-foreground">
                  <input
                    type="checkbox"
                    checked={!d.closed}
                    onChange={(e) =>
                      setDays((prev) => ({
                        ...prev,
                        [day]: { ...(prev[day] ?? d), closed: !e.target.checked },
                      }))
                    }
                    className="size-4 accent-[#D4B477]"
                  />
                  Open
                </label>
                {d.closed ? (
                  <span className="text-xs text-muted-foreground italic">Closed</span>
                ) : (
                  <>
                    <input
                      type="time"
                      aria-label={`${WEEKDAY_LABELS[day]} opening time`}
                      value={d.open}
                      onChange={(e) =>
                        setDays((prev) => ({ ...prev, [day]: { ...(prev[day] ?? d), open: e.target.value } }))
                      }
                      className="h-7 rounded-md border border-input bg-transparent px-2 text-sm"
                    />
                    <span className="text-xs text-muted-foreground">to</span>
                    <input
                      type="time"
                      aria-label={`${WEEKDAY_LABELS[day]} closing time`}
                      value={d.close}
                      onChange={(e) =>
                        setDays((prev) => ({ ...prev, [day]: { ...(prev[day] ?? d), close: e.target.value } }))
                      }
                      className="h-7 rounded-md border border-input bg-transparent px-2 text-sm"
                    />
                  </>
                )}
              </div>
            );
          })}
        </div>
      </section>

      <div className="flex items-center gap-3 border-t border-foreground/10 pt-6">
        <Store className="size-4 text-gold-deep dark:text-gold" />
        <SubmitButton
          label={mode === "create" ? "Create outlet" : "Save changes"}
          busyLabel={mode === "create" ? "Creating…" : "Saving…"}
          pending={pending}
        />
      </div>
    </form>
  );
}
