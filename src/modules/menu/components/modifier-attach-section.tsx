"use client";

import { useActionState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { Link2, Link2Off } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import {
  attachModifierGroupAction,
  detachModifierGroupAction,
  type MenuActionState,
} from "@/modules/menu/actions";
import { FormError, FormSuccess } from "@/components/forms/form-bits";

export function ModifierAttachSection({
  businessId,
  productId,
  attached,
  attachable,
}: {
  businessId: string;
  productId: string;
  attached: { id: string; name: string; minSelected: number; maxSelected: number | null; optionCount: number }[];
  attachable: { id: string; name: string }[];
}) {
  const router = useRouter();
  const [attachState, attachAction, attachPending] = useActionState<MenuActionState | undefined, FormData>(
    attachModifierGroupAction,
    undefined,
  );

  useEffect(() => {
    if (attachState?.ok) router.refresh();
  }, [attachState, router]);

  return (
    <div className="space-y-4">
      {attached.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No modifier groups attached. Attach groups to offer choices (required selections) and add-ons (optional extras).
        </p>
      ) : (
        <ul className="divide-y divide-ink/10 rounded-xl border border-ink/10 bg-white">
          {attached.map((group) => (
            <AttachedGroupRow key={group.id} businessId={businessId} productId={productId} group={group} />
          ))}
        </ul>
      )}

      {attachable.length > 0 ? (
        <form action={attachAction} className="flex flex-wrap items-center gap-2">
          <input type="hidden" name="businessId" value={businessId} />
          <input type="hidden" name="productId" value={productId} />
          <Select name="groupId" defaultValue={attachable[0]?.id ?? ""} aria-label="Modifier group to attach" className="max-w-64">
            {attachable.map((group) => (
              <option key={group.id} value={group.id}>
                {group.name}
              </option>
            ))}
          </Select>
          <Button type="submit" variant="outline" size="sm" disabled={attachPending}>
            <Link2 className="size-4" aria-hidden /> {attachPending ? "Attaching…" : "Attach"}
          </Button>
          <FormError state={attachState} />
          <FormSuccess message={attachState?.ok ? "Group attached." : undefined} />
        </form>
      ) : (
        <p className="text-xs text-muted-foreground">All your modifier groups are attached — create more from the Modifiers page.</p>
      )}
    </div>
  );
}

function AttachedGroupRow({
  businessId,
  productId,
  group,
}: {
  businessId: string;
  productId: string;
  group: { id: string; name: string; minSelected: number; maxSelected: number | null; optionCount: number };
}) {
  const router = useRouter();
  const [state, formAction, pending] = useActionState<MenuActionState | undefined, FormData>(
    detachModifierGroupAction,
    undefined,
  );

  useEffect(() => {
    if (state?.ok) router.refresh();
  }, [state, router]);

  const selectionRule =
    group.minSelected > 0
      ? `pick ${group.minSelected}${group.maxSelected && group.maxSelected !== group.minSelected ? `–${group.maxSelected}` : ""}`
      : group.maxSelected
        ? `up to ${group.maxSelected}`
        : "optional";

  return (
    <li className="flex items-center gap-3 px-4 py-3 text-sm">
      <span className="min-w-0 flex-1">
        <span className="block font-medium">{group.name}</span>
        <span className="block text-xs text-muted-foreground">
          {group.optionCount} option{group.optionCount === 1 ? "" : "s"} · {selectionRule}
        </span>
      </span>
      <form action={formAction}>
        <input type="hidden" name="businessId" value={businessId} />
        <input type="hidden" name="productId" value={productId} />
        <input type="hidden" name="groupId" value={group.id} />
        <button
          type="submit"
          disabled={pending}
          aria-label={`Detach ${group.name}`}
          className="flex items-center gap-1.5 rounded-lg border border-ink/15 px-2.5 py-1.5 text-xs text-muted-foreground transition-colors hover:border-destructive/40 hover:text-destructive disabled:opacity-50"
        >
          <Link2Off className="size-3.5" aria-hidden /> Detach
        </button>
      </form>
    </li>
  );
}
