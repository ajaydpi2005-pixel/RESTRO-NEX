"use client";

import { useActionState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { setOutletStatusAction, type BusinessActionState } from "@/modules/business/actions";
import { SubmitButton } from "@/components/forms/form-bits";

/**
 * Activate / deactivate an outlet. Owners only — enforced again server-side
 * by setOutletStatusAction.
 */
export function OutletStatusToggle({ outletId, active }: { outletId: string; active: boolean }) {
  const router = useRouter();
  const [state, formAction, pending] = useActionState<BusinessActionState | undefined, FormData>(
    setOutletStatusAction,
    undefined,
  );

  useEffect(() => {
    if (state?.ok) {
      router.refresh();
    }
  }, [state, router]);

  return (
    <form action={formAction}>
      <input type="hidden" name="outletId" value={outletId} />
      <input type="hidden" name="active" value={String(!active)} />
      <SubmitButton
        variant="outline"
        size="sm"
        label={active ? "Deactivate" : "Activate"}
        busyLabel={active ? "Deactivating…" : "Activating…"}
        pending={pending}
      />
      {state && !state.ok && state.error ? (
        <p className="mt-1 text-xs text-destructive">{state.error}</p>
      ) : null}
    </form>
  );
}
