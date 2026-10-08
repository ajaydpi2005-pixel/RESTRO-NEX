"use client";

import { useActionState, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  createModifierGroupAction,
  updateModifierGroupAction,
  type MenuActionState,
} from "@/modules/menu/actions";
import { minorToDisplay } from "@/modules/menu/schemas";
import { FieldError, FormError, FormSuccess, SubmitButton } from "@/components/forms/form-bits";

interface ModifierEditRow {
  key: number;
  id: string;
  name: string;
  price: string;
}

/**
 * Create/edit a modifier group with its options. An add-on is simply a group
 * with minimum selections = 0.
 */
export function ModifierGroupForm({
  businessId,
  group,
}: {
  businessId: string;
  group?: {
    id: string;
    name: string;
    minSelected: number;
    maxSelected: number | null;
    modifiers: { id: string; name: string; priceMinor: number }[];
  };
}) {
  const router = useRouter();
  const action = group ? updateModifierGroupAction : createModifierGroupAction;
  const [state, formAction, pending] = useActionState<MenuActionState | undefined, FormData>(action, undefined);
  const [rows, setRows] = useState<ModifierEditRow[]>(() =>
    group && group.modifiers.length > 0
      ? group.modifiers.map((modifier, index) => ({
          key: index,
          id: modifier.id,
          name: modifier.name,
          price: minorToDisplay(modifier.priceMinor),
        }))
      : [{ key: 0, id: "", name: "", price: "0" }],
  );
  const [nextKey, setNextKey] = useState(() => rows.length + 1);

  useEffect(() => {
    if (state?.ok) {
      if (!group && state.groupId) {
        router.push(`/menu/modifiers/${state.groupId}?business=${businessId}`);
      } else {
        router.refresh();
      }
    }
  }, [state, router, group, businessId]);

  return (
    <form action={formAction} className="space-y-5" noValidate>
      <input type="hidden" name="businessId" value={businessId} />
      {group ? <input type="hidden" name="groupId" value={group.id} /> : null}
      <FormError state={state} />
      <FormSuccess message={state?.ok && group ? "Group saved." : undefined} />

      <div className="grid gap-5 sm:grid-cols-[1fr_140px_170px]">
        <div className="space-y-1.5 sm:col-span-3">
          <Label htmlFor="mg-name">Group name</Label>
          <Input id="mg-name" name="name" defaultValue={group?.name ?? ""} maxLength={60} required placeholder="e.g. Choose your size" />
          <FieldError state={state} name="name" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="mg-min">Minimum selections</Label>
          <Input id="mg-min" name="minSelected" defaultValue={String(group?.minSelected ?? 0)} inputMode="numeric" />
          <p className="text-xs text-muted-foreground">0 makes this an optional add-on</p>
          <FieldError state={state} name="minSelected" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="mg-max">Maximum (blank = unlimited)</Label>
          <Input id="mg-max" name="maxSelected" defaultValue={group?.maxSelected != null ? String(group.maxSelected) : ""} inputMode="numeric" />
          <FieldError state={state} name="maxSelected" />
        </div>
      </div>

      <fieldset className="space-y-3">
        <legend className="text-sm font-medium">Options</legend>
        {rows.map((row) => (
          <div key={row.key} className="grid grid-cols-[32px_1fr_120px_36px] items-center gap-2">
            <input type="hidden" name="modifierId" value={row.id} />
            <span className="text-xs text-muted-foreground">{row.id ? "" : "new"}</span>
            <Input aria-label="Option name" name="modifierName" defaultValue={row.name} placeholder="e.g. Extra cheese" maxLength={60} />
            <Input aria-label="Option price" name="modifierPrice" defaultValue={row.price} inputMode="decimal" placeholder="0" />
            <button
              type="button"
              aria-label="Remove option"
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
          onClick={() => {
            setRows((current) => [...current, { key: nextKey, id: "", name: "", price: "0" }]);
            setNextKey((key) => key + 1);
          }}
        >
          <Plus className="size-4" aria-hidden /> Add option
        </Button>
        <FieldError state={state} name="modifierName" />
        <FieldError state={state} name="modifierPrice" />
      </fieldset>

      <SubmitButton
        label={group ? "Save group" : "Create group"}
        busyLabel="Saving…"
        pending={pending}
        className="sm:w-auto sm:px-8"
      />
    </form>
  );
}
