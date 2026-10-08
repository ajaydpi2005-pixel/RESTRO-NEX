"use client";

import { useActionState, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { saveKitchenStationsAction, type OnboardingActionState } from "@/modules/onboarding/actions";
import type { KitchenStationRow, OnboardingOutlet } from "@/modules/onboarding/queries";
import { FieldError, FormError, SubmitButton } from "@/components/forms/form-bits";

interface StationRow {
  key: number;
  name: string;
  description: string;
}

const SUGGESTIONS = ["Hot kitchen", "Tandoor", "Fry station", "Beverages", "Desserts"];

export function KitchenStepForm({
  businessId,
  outlets,
  existing,
}: {
  businessId: string;
  outlets: OnboardingOutlet[];
  existing: { outletId: string; stations: KitchenStationRow[] } | null;
}) {
  const [state, formAction, pending] = useActionState<OnboardingActionState | undefined, FormData>(
    saveKitchenStationsAction,
    undefined,
  );
  const [rows, setRows] = useState<StationRow[]>(() => {
    if (existing && existing.stations.length > 0) {
      return existing.stations.map((station, index) => ({
        key: index,
        name: station.name,
        description: station.description ?? "",
      }));
    }
    return [
      { key: 0, name: "Hot kitchen", description: "" },
      { key: 1, name: "Beverages", description: "" },
    ];
  });

  return (
    <form action={formAction} className="space-y-5" noValidate>
      <input type="hidden" name="businessId" value={businessId} />
      <FormError state={state} />

      {outlets.length > 1 ? (
        <div className="space-y-1.5">
          <Label htmlFor="kitchen-outlet">Outlet</Label>
          <Select id="kitchen-outlet" name="outletId" defaultValue={existing?.outletId ?? outlets[0]?.id}>
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
        <legend className="text-sm font-medium">Stations</legend>
        {rows.map((row) => (
          <div key={row.key} className="grid grid-cols-[200px_1fr_36px] items-center gap-2">
            <Input aria-label="Station name" name="stationName" defaultValue={row.name} placeholder="e.g. Tandoor" maxLength={60} />
            <Input
              aria-label="Station description"
              name="stationDescription"
              defaultValue={row.description}
              placeholder="What gets prepared here (optional)"
              maxLength={200}
            />
            <button
              type="button"
              aria-label="Remove this station"
              className="flex size-9 items-center justify-center rounded-lg border border-ink/15 text-muted-foreground transition-colors hover:border-destructive/40 hover:text-destructive"
              onClick={() => setRows((current) => current.filter((r) => r.key !== row.key))}
            >
              <Trash2 className="size-4" aria-hidden />
            </button>
          </div>
        ))}
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() =>
              setRows((current) => [
                ...current,
                { key: Math.max(0, ...current.map((r) => r.key)) + 1, name: "", description: "" },
              ])
            }
          >
            <Plus className="size-4" aria-hidden /> Add station
          </Button>
          {SUGGESTIONS.filter((s) => !rows.some((r) => r.name.toLowerCase() === s.toLowerCase())).slice(0, 3).map(
            (suggestion) => (
              <button
                key={suggestion}
                type="button"
                className="rounded-full border border-ink/15 px-3 py-1 text-xs text-muted-foreground transition-colors hover:border-gold-deep hover:text-ink"
                onClick={() =>
                  setRows((current) => [
                    ...current,
                    { key: Math.max(0, ...current.map((r) => r.key)) + 1, name: suggestion, description: "" },
                  ])
                }
              >
                + {suggestion}
              </button>
            ),
          )}
        </div>
        <FieldError state={state} name="stationName" />
        <p className="text-xs text-muted-foreground">
          Kitchen order tickets are routed to these stations once KDS goes live. Saving replaces the current stations for this outlet.
        </p>
      </fieldset>

      <SubmitButton label="Save & continue" busyLabel="Saving…" pending={pending} />
    </form>
  );
}
