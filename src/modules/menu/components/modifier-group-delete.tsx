"use client";

import { useActionState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { Trash2 } from "lucide-react";
import { deleteModifierGroupAction, type MenuActionState } from "@/modules/menu/actions";

export function ModifierGroupDelete({ businessId, groupId, name }: { businessId: string; groupId: string; name: string }) {
  const router = useRouter();
  const [state, formAction, pending] = useActionState<MenuActionState | undefined, FormData>(
    deleteModifierGroupAction,
    undefined,
  );

  useEffect(() => {
    if (state?.ok) router.refresh();
  }, [state, router]);

  return (
    <form
      action={formAction}
      onSubmit={(event) => {
        if (!window.confirm(`Delete "${name}" and all its options? Products using it will lose the group.`)) {
          event.preventDefault();
        }
      }}
    >
      <input type="hidden" name="businessId" value={businessId} />
      <input type="hidden" name="groupId" value={groupId} />
      <button
        type="submit"
        disabled={pending}
        aria-label={`Delete ${name}`}
        className="flex size-8 items-center justify-center rounded-lg border border-ink/15 text-muted-foreground transition-colors hover:border-destructive/40 hover:text-destructive disabled:opacity-50"
      >
        <Trash2 className="size-4" aria-hidden />
      </button>
    </form>
  );
}
