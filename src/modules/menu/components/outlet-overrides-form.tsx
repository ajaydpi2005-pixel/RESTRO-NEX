"use client";

import { useActionState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { Select } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { saveOutletOverridesAction, type MenuActionState } from "@/modules/menu/actions";
import { minorToDisplay } from "@/modules/menu/schemas";
import { Button } from "@/components/ui/button";
import { FormError, FormSuccess, FieldError } from "@/components/forms/form-bits";

export function OutletOverridesForm({
  businessId,
  productId,
  basePriceMinor,
  outlets,
  overrides,
}: {
  businessId: string;
  productId: string;
  basePriceMinor: number;
  outlets: { id: string; name: string }[];
  overrides: { outletId: string; priceMinor: number | null; isAvailable: boolean }[];
}) {
  const router = useRouter();
  const [state, formAction, pending] = useActionState<MenuActionState | undefined, FormData>(
    saveOutletOverridesAction,
    undefined,
  );

  useEffect(() => {
    if (state?.ok) router.refresh();
  }, [state, router]);

  const overrideFor = (outletId: string) => overrides.find((row) => row.outletId === outletId);

  return (
    <form action={formAction} className="space-y-4">
      <input type="hidden" name="businessId" value={businessId} />
      <input type="hidden" name="productId" value={productId} />
      <FormError state={state} />
      <FormSuccess message={state?.ok ? "Outlet settings saved." : undefined} />

      {outlets.length === 0 ? (
        <p className="text-sm text-muted-foreground">No active outlets yet.</p>
      ) : (
        <div className="space-y-2.5">
          <div className="grid grid-cols-[1fr_130px_150px] gap-2 text-xs text-muted-foreground">
            <span>Outlet</span>
            <span>Price (blank = {minorToDisplay(basePriceMinor)})</span>
            <span>Availability</span>
          </div>
          {outlets.map((outlet) => {
            const override = overrideFor(outlet.id);
            return (
              <div key={outlet.id} className="grid grid-cols-[1fr_130px_150px] items-center gap-2">
                <input type="hidden" name="overrideOutletId" value={outlet.id} />
                <span className="text-sm">{outlet.name}</span>
                <Input
                  aria-label={`Price at ${outlet.name}`}
                  name="overridePrice"
                  defaultValue={override?.priceMinor != null ? minorToDisplay(override.priceMinor) : ""}
                  inputMode="decimal"
                  placeholder=""
                />
                <Select
                  aria-label={`Availability at ${outlet.name}`}
                  name="overrideAvailable"
                  defaultValue={override ? (override.isAvailable ? "yes" : "no") : "yes"}
                >
                  <option value="yes">Available</option>
                  <option value="no">Hidden here</option>
                </Select>
              </div>
            );
          })}
        </div>
      )}
      <FieldError state={state} name="overridePrice" />
      <Button type="submit" disabled={pending} variant="outline" className="sm:w-auto sm:px-6">
        {pending ? "Saving…" : "Save outlet settings"}
      </Button>
    </form>
  );
}
