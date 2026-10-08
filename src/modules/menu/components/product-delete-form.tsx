"use client";

import { useActionState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { deleteComboAction, deleteProductAction, type MenuActionState } from "@/modules/menu/actions";
import { Button } from "@/components/ui/button";
import { FormError } from "@/components/forms/form-bits";

export function DeleteEntityForm({
  businessId,
  targetId,
  kind,
  label,
}: {
  businessId: string;
  targetId: string;
  kind: "product" | "combo";
  label: string;
}) {
  const router = useRouter();
  const action = kind === "product" ? deleteProductAction : deleteComboAction;
  const [state, formAction, pending] = useActionState<MenuActionState | undefined, FormData>(action, undefined);

  const backTo = kind === "product" ? `/menu/products?business=${businessId}` : `/menu/combos?business=${businessId}`;

  useEffect(() => {
    if (state?.ok) router.push(backTo);
  }, [state, router, backTo]);

  return (
    <form
      action={formAction}
      onSubmit={(event) => {
        if (!window.confirm(`Delete "${label}"? This cannot be undone.`)) {
          event.preventDefault();
        }
      }}
      className="space-y-2"
    >
      <input type="hidden" name="businessId" value={businessId} />
      <input type="hidden" name={kind === "product" ? "productId" : "comboId"} value={targetId} />
      <FormError state={state} />
      <Button type="submit" variant="outline" className="text-destructive hover:text-destructive" disabled={pending}>
        {pending ? "Deleting…" : `Delete ${kind}`}
      </Button>
    </form>
  );
}
