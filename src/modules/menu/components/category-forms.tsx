"use client";

import { useActionState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import {
  createCategoryAction,
  deleteCategoryAction,
  renameCategoryAction,
  type MenuActionState,
} from "@/modules/menu/actions";
import { FieldError, FormError, FormSuccess } from "@/components/forms/form-bits";

export function CreateCategoryForm({
  businessId,
  rootCategories,
}: {
  businessId: string;
  rootCategories: { id: string; name: string }[];
}) {
  const router = useRouter();
  const [state, formAction, pending] = useActionState<MenuActionState | undefined, FormData>(
    createCategoryAction,
    undefined,
  );
  useEffect(() => {
    if (state?.ok) router.refresh();
  }, [state, router]);

  return (
    <form action={formAction} className="space-y-3" noValidate>
      <input type="hidden" name="businessId" value={businessId} />
      <FormError state={state} />
      <FormSuccess message={state?.ok ? "Category created." : undefined} />
      <div className="grid gap-3 sm:grid-cols-[1fr_220px_auto]">
        <Input name="name" placeholder="Category name (e.g. Starters)" maxLength={60} required />
        <Select name="parentId" defaultValue="" aria-label="Parent category">
          <option value="">Top-level category</option>
          {rootCategories.map((category) => (
            <option key={category.id} value={category.id}>
              ↳ under {category.name}
            </option>
          ))}
        </Select>
        <Button type="submit" disabled={pending} variant="outline">
          <Plus className="size-4" aria-hidden /> {pending ? "Adding…" : "Add"}
        </Button>
      </div>
      <FieldError state={state} name="name" />
    </form>
  );
}

export function CategoryRowActions({
  businessId,
  categoryId,
  name,
}: {
  businessId: string;
  categoryId: string;
  name: string;
}) {
  const router = useRouter();
  const [renameState, renameAction, renamePending] = useActionState<MenuActionState | undefined, FormData>(
    renameCategoryAction,
    undefined,
  );
  const [deleteState, deleteAction, deletePending] = useActionState<MenuActionState | undefined, FormData>(
    deleteCategoryAction,
    undefined,
  );
  useEffect(() => {
    if (renameState?.ok || deleteState?.ok) router.refresh();
  }, [renameState, deleteState, router]);

  return (
    <div className="flex flex-1 flex-wrap items-center justify-end gap-2">
      <form action={renameAction} className="flex items-center gap-2">
        <input type="hidden" name="businessId" value={businessId} />
        <input type="hidden" name="categoryId" value={categoryId} />
        <Input name="name" defaultValue={name} maxLength={60} aria-label={`Rename ${name}`} className="h-8 w-44 text-sm" />
        <Button type="submit" size="sm" variant="outline" disabled={renamePending}>
          Rename
        </Button>
        <FieldError state={renameState} name="name" />
      </form>
      <form
        action={deleteAction}
        onSubmit={(event) => {
          if (!window.confirm(`Delete "${name}"? This cannot be undone.`)) event.preventDefault();
        }}
      >
        <input type="hidden" name="businessId" value={businessId} />
        <input type="hidden" name="categoryId" value={categoryId} />
        <button
          type="submit"
          disabled={deletePending}
          aria-label={`Delete ${name}`}
          className="flex size-8 items-center justify-center rounded-lg border border-ink/15 text-muted-foreground transition-colors hover:border-destructive/40 hover:text-destructive disabled:opacity-50"
        >
          <Trash2 className="size-4" aria-hidden />
        </button>
      </form>
      {deleteState?.error ? <p className="w-full text-right text-xs text-destructive">{deleteState.error}</p> : null}
    </div>
  );
}
