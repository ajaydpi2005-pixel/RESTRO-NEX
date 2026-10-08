"use client";

import { useActionState, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { saveTaxSettingsAction, type OnboardingActionState } from "@/modules/onboarding/actions";
import type { OnboardingBusiness } from "@/modules/onboarding/queries";
import { FieldError, FormError, SubmitButton } from "@/components/forms/form-bits";

interface RateRow {
  key: number;
  name: string;
  pct: string;
  inclusive: "inclusive" | "exclusive";
}

interface TaxPrefill {
  enabled: boolean;
  taxNumber: string | null;
  invoiceFooter: string | null;
  rates: { name: string; pct: number; inclusive: boolean }[];
}

function prefillFrom(business: OnboardingBusiness): TaxPrefill {
  const doc = business.taxSettings as {
    enabled?: boolean;
    invoice_footer?: string | null;
    rates?: { name?: string; pct?: number; inclusive?: boolean }[];
  };
  return {
    enabled: doc.enabled ?? false,
    taxNumber: business.taxNumber,
    invoiceFooter: doc.invoice_footer ?? null,
    rates: Array.isArray(doc.rates)
      ? doc.rates.map((rate) => ({
          name: rate.name ?? "",
          pct: typeof rate.pct === "number" ? rate.pct : 0,
          inclusive: rate.inclusive ?? false,
        }))
      : [],
  };
}

export function TaxStepForm({ business }: { business: OnboardingBusiness }) {
  const prefill = prefillFrom(business);
  const [state, formAction, pending] = useActionState<OnboardingActionState | undefined, FormData>(
    saveTaxSettingsAction,
    undefined,
  );
  const [rows, setRows] = useState<RateRow[]>(
    prefill.rates.length > 0
      ? prefill.rates.map((rate, index) => ({
          key: index,
          name: rate.name,
          pct: String(rate.pct),
          inclusive: rate.inclusive ? "inclusive" : "exclusive",
        }))
      : [{ key: 0, name: "GST", pct: "5", inclusive: "exclusive" }],
  );

  return (
    <form action={formAction} className="space-y-5" noValidate>
      <input type="hidden" name="businessId" value={business.id} />
      <FormError state={state} />

      <div className="grid gap-5 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="tax-enabled">Charge tax on bills</Label>
          <Select id="tax-enabled" name="taxEnabled" defaultValue={prefill.enabled ? "yes" : "no"}>
            <option value="yes">Yes — apply the rates below</option>
            <option value="no">No — no tax for now</option>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="tax-number">Tax registration number (GSTIN)</Label>
          <Input id="tax-number" name="taxNumber" defaultValue={prefill.taxNumber ?? ""} placeholder="29ABCDE1234F1Z5" maxLength={32} />
          <FieldError state={state} name="taxNumber" />
        </div>
      </div>

      <fieldset className="space-y-3">
        <legend className="text-sm font-medium">Tax rates</legend>
        {rows.map((row) => (
          <div key={row.key} className="grid grid-cols-[1fr_92px_150px_36px] items-center gap-2">
            <Input
              aria-label="Rate name"
              name="rateName"
              defaultValue={row.name}
              placeholder="e.g. GST"
              maxLength={40}
            />
            <Input
              aria-label="Rate percentage"
              name="ratePct"
              defaultValue={row.pct}
              placeholder="5"
              inputMode="decimal"
            />
            <Select aria-label="How the rate is applied" name="rateInclusive" defaultValue={row.inclusive}>
              <option value="exclusive">Added to price</option>
              <option value="inclusive">Included in price</option>
            </Select>
            <button
              type="button"
              aria-label="Remove this rate"
              className="flex size-9 items-center justify-center rounded-lg border border-ink/15 text-muted-foreground transition-colors hover:border-destructive/40 hover:text-destructive"
              onClick={() => setRows((current) => current.filter((r) => r.key !== row.key))}
            >
              <Trash2 className="size-4" aria-hidden />
            </button>
          </div>
        ))}
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() =>
            setRows((current) => [
              ...current,
              { key: Math.max(0, ...current.map((r) => r.key)) + 1, name: "", pct: "", inclusive: "exclusive" },
            ])
          }
        >
          <Plus className="size-4" aria-hidden /> Add rate
        </Button>
        <FieldError state={state} name="ratePct" />
      </fieldset>

      <div className="space-y-1.5">
        <Label htmlFor="tax-footer">Invoice footer note</Label>
        <Input
          id="tax-footer"
          name="invoiceFooter"
          defaultValue={prefill.invoiceFooter ?? ""}
          placeholder="e.g. Prices are subject to GST as applicable"
          maxLength={200}
        />
        <FieldError state={state} name="invoiceFooter" />
      </div>

      <SubmitButton label="Save & continue" busyLabel="Saving…" pending={pending} />
    </form>
  );
}
