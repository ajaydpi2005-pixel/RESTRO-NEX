"use client";

import { useActionState, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { saveFloorPlanAction, type OnboardingActionState } from "@/modules/onboarding/actions";
import type { FloorPlanSection, OnboardingOutlet } from "@/modules/onboarding/queries";
import { FieldError, FormError, SubmitButton } from "@/components/forms/form-bits";

interface SectionRow {
  key: number;
  name: string;
  count: string;
  capacity: string;
}

export function TablesStepForm({
  businessId,
  outlets,
  existing,
}: {
  businessId: string;
  outlets: OnboardingOutlet[];
  existing: { outletId: string; sections: FloorPlanSection[] } | null;
}) {
  const [state, formAction, pending] = useActionState<OnboardingActionState | undefined, FormData>(
    saveFloorPlanAction,
    undefined,
  );
  const [rows, setRows] = useState<SectionRow[]>(() => {
    if (existing && existing.sections.length > 0) {
      return existing.sections.map((section, index) => ({
        key: index,
        name: section.name,
        count: String(section.tables.length || 1),
        capacity: String(section.tables[0]?.capacity ?? 4),
      }));
    }
    return [{ key: 0, name: "Main hall", count: "10", capacity: "4" }];
  });

  return (
    <form action={formAction} className="space-y-5" noValidate>
      <input type="hidden" name="businessId" value={businessId} />
      <FormError state={state} />

      {outlets.length > 1 ? (
        <div className="space-y-1.5">
          <Label htmlFor="tables-outlet">Outlet</Label>
          <Select id="tables-outlet" name="outletId" defaultValue={existing?.outletId ?? outlets[0]?.id}>
            {outlets.map((outlet) => (
              <option key={outlet.id} value={outlet.id}>
                {outlet.name}
              </option>
            ))}
          </Select>
        </div>
      ) : (
        <input type="hidden" name="outletId" value={outlets[0]?.id ?? ""} />
      )}

      <fieldset className="space-y-3">
        <legend className="text-sm font-medium">Sections</legend>
        <div className="grid grid-cols-[1fr_84px_84px_36px] items-center gap-2 text-xs text-muted-foreground">
          <span>Section name</span>
          <span>Tables</span>
          <span>Seats</span>
          <span />
        </div>
        {rows.map((row) => (
          <div key={row.key} className="grid grid-cols-[1fr_84px_84px_36px] items-center gap-2">
            <Input aria-label="Section name" name="sectionName" defaultValue={row.name} placeholder="e.g. Terrace" maxLength={60} />
            <Input aria-label="Number of tables" name="tableCount" defaultValue={row.count} inputMode="numeric" placeholder="10" />
            <Input aria-label="Seats per table" name="capacity" defaultValue={row.capacity} inputMode="numeric" placeholder="4" />
            <button
              type="button"
              aria-label="Remove this section"
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
              { key: Math.max(0, ...current.map((r) => r.key)) + 1, name: "", count: "", capacity: "4" },
            ])
          }
        >
          <Plus className="size-4" aria-hidden /> Add section
        </Button>
        <FieldError state={state} name="sectionName" />
        <FieldError state={state} name="tableCount" />
        <FieldError state={state} name="capacity" />
        <p className="text-xs text-muted-foreground">
          Tables are numbered automatically (T1, T2, …) across all sections. Saving replaces the current floor plan for this outlet.
        </p>
      </fieldset>

      <SubmitButton label="Save & continue" busyLabel="Saving…" pending={pending} />
    </form>
  );
}
