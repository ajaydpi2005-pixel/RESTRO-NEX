"use client";

import { useActionState, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Building2 } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import {
  CURRENCIES,
  RESTAURANT_TYPES,
  RESTAURANT_TYPE_LABELS,
  TIMEZONES,
  slugify,
} from "@/modules/business/schemas";
import {
  createBusinessAction,
  updateBusinessAction,
  type BusinessActionState,
} from "@/modules/business/actions";
import { FieldError, FormError, FormSuccess, SubmitButton } from "@/components/forms/form-bits";

export interface BusinessFormInitial {
  name: string;
  restaurantType: string;
  currency: string;
  timezone: string;
  email: string;
  phone: string;
  addressLine1: string;
  addressLine2: string;
  city: string;
  state: string;
  postalCode: string;
  country: string;
  taxNumber: string;
  logoUrl: string;
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-4">
      <h3 className="text-xs font-semibold tracking-widest text-muted-foreground uppercase">{title}</h3>
      <div className="grid gap-4 sm:grid-cols-2">{children}</div>
    </section>
  );
}

export function BusinessForm({
  mode,
  businessId,
  initial,
}: {
  mode: "create" | "edit";
  businessId?: string;
  initial?: Partial<BusinessFormInitial>;
}) {
  const router = useRouter();
  const action = mode === "create" ? createBusinessAction : updateBusinessAction;
  const [state, formAction, pending] = useActionState<BusinessActionState | undefined, FormData>(
    action,
    undefined,
  );
  const [logoPreview, setLogoPreview] = useState(initial?.logoUrl ?? "");

  const defaultTimezone = useMemo(() => {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Kolkata";
    } catch {
      return "Asia/Kolkata";
    }
  }, []);

  const [slugPreview, setSlugPreview] = useState(initial?.name ? slugify(initial.name) : "");

  if (state?.ok) {
    if (mode === "create" && state.businessId) {
      router.replace(`/settings/outlets?business=${state.businessId}`);
      return null;
    }
    router.refresh();
  }

  return (
    <form action={formAction} className="space-y-8" noValidate>
      {businessId ? <input type="hidden" name="businessId" value={businessId} /> : null}
      <FormError state={state} />
      <FormSuccess message={state?.ok && mode === "edit" ? "Business saved." : undefined} />

      <Section title="Brand">
        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor="name">Business name</Label>
          <Input
            id="name"
            name="name"
            defaultValue={initial?.name ?? ""}
            placeholder="e.g. Spice Route Hospitality"
            required
            minLength={2}
            maxLength={80}
            onChange={(e) => {
              if (mode === "create") setSlugPreview(slugify(e.target.value));
            }}
          />
          {mode === "create" && slugPreview ? (
            <p className="text-xs text-muted-foreground">
              URL slug: <span className="font-mono text-gold-deep dark:text-gold">{slugPreview}</span>
            </p>
          ) : null}
          <FieldError state={state} name="name" />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="restaurantType">Restaurant type</Label>
          <Select id="restaurantType" name="restaurantType" defaultValue={initial?.restaurantType ?? "casual_dining"} required>
            {RESTAURANT_TYPES.map((type) => (
              <option key={type} value={type}>
                {RESTAURANT_TYPE_LABELS[type]}
              </option>
            ))}
          </Select>
          <FieldError state={state} name="restaurantType" />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="logoUrl">Logo URL</Label>
          <Input
            id="logoUrl"
            name="logoUrl"
            type="url"
            defaultValue={initial?.logoUrl ?? ""}
            placeholder="https://…"
            onChange={(e) => setLogoPreview(e.target.value)}
          />
          {/^https?:\/\/.+/.test(logoPreview) ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={logoPreview}
              alt="Logo preview"
              className="mt-1 h-10 w-10 rounded-md object-contain ring-1 ring-foreground/10"
            />
          ) : null}
          <FieldError state={state} name="logoUrl" />
        </div>
      </Section>

      <Section title="Locale">
        <div className="space-y-1.5">
          <Label htmlFor="currency">Currency</Label>
          <Select id="currency" name="currency" defaultValue={initial?.currency ?? "INR"} required>
            {CURRENCIES.map((code) => (
              <option key={code} value={code}>
                {code}
              </option>
            ))}
          </Select>
          <FieldError state={state} name="currency" />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="timezone">Time zone</Label>
          <Input
            id="timezone"
            name="timezone"
            list="restro-nex-timezones"
            defaultValue={initial?.timezone ?? defaultTimezone}
            placeholder="Asia/Kolkata"
            required
          />
          <datalist id="restro-nex-timezones">
            {TIMEZONES.map((tz) => (
              <option key={tz} value={tz} />
            ))}
          </datalist>
          <FieldError state={state} name="timezone" />
        </div>
      </Section>

      <Section title="Contact">
        <div className="space-y-1.5">
          <Label htmlFor="email">Email</Label>
          <Input id="email" name="email" type="email" defaultValue={initial?.email ?? ""} placeholder="hello@restaurant.com" />
          <FieldError state={state} name="email" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="phone">Phone</Label>
          <Input id="phone" name="phone" type="tel" defaultValue={initial?.phone ?? ""} placeholder="+91 98765 43210" />
          <FieldError state={state} name="phone" />
        </div>
      </Section>

      <Section title="Address">
        <div className="space-y-1.5">
          <Label htmlFor="addressLine1">Address line 1</Label>
          <Input id="addressLine1" name="addressLine1" defaultValue={initial?.addressLine1 ?? ""} />
          <FieldError state={state} name="addressLine1" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="addressLine2">Address line 2</Label>
          <Input id="addressLine2" name="addressLine2" defaultValue={initial?.addressLine2 ?? ""} />
          <FieldError state={state} name="addressLine2" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="city">City</Label>
          <Input id="city" name="city" defaultValue={initial?.city ?? ""} />
          <FieldError state={state} name="city" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="state">State</Label>
          <Input id="state" name="state" defaultValue={initial?.state ?? ""} />
          <FieldError state={state} name="state" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="postalCode">Postal code</Label>
          <Input id="postalCode" name="postalCode" defaultValue={initial?.postalCode ?? ""} />
          <FieldError state={state} name="postalCode" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="country">Country</Label>
          <Input id="country" name="country" defaultValue={initial?.country ?? ""} />
          <FieldError state={state} name="country" />
        </div>
      </Section>

      <Section title="Tax">
        <div className="space-y-1.5">
          <Label htmlFor="taxNumber">Tax registration number (GSTIN / VAT)</Label>
          <Input id="taxNumber" name="taxNumber" defaultValue={initial?.taxNumber ?? ""} placeholder="29ABCDE1234F1Z5" />
          <FieldError state={state} name="taxNumber" />
        </div>
      </Section>

      <div className="flex items-center gap-3 border-t border-foreground/10 pt-6">
        <Building2 className="size-4 text-gold-deep dark:text-gold" />
        <SubmitButton
          label={mode === "create" ? "Create business" : "Save changes"}
          busyLabel={mode === "create" ? "Creating…" : "Saving…"}
          pending={pending}
        />
      </div>
    </form>
  );
}
