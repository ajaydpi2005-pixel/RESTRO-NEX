"use client";

import { useActionState, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { FieldError, FormError, FormSuccess } from "@/components/forms/form-bits";
import { transferStockAction, type InventoryActionState } from "@/modules/inventory/actions";
import type { StockFormIngredient } from "@/modules/inventory/components/stock-forms";
import { compatibleUnits, isIngredientBaseUnit } from "@/modules/inventory/units";

interface Line {
  key: number;
  ingredientId: string;
  unit: string;
  qty: string;
}

export function TransferForm({
  businessId,
  outlets,
  defaultFrom,
  ingredients,
}: {
  businessId: string;
  outlets: { id: string; name: string }[];
  defaultFrom: string;
  ingredients: StockFormIngredient[];
}) {
  const router = useRouter();
  const [state, formAction, pending] = useActionState<InventoryActionState | undefined, FormData>(
    transferStockAction,
    undefined,
  );
  const [ref, setRef] = useState(() => crypto.randomUUID());
  const [nextKey, setNextKey] = useState(1);
  const [lines, setLines] = useState<Line[]>([{ key: 0, ingredientId: ingredients[0]?.id ?? "", unit: "", qty: "" }]);
  const [from, setFrom] = useState(defaultFrom);
  const [to, setTo] = useState(outlets.find((o) => o.id !== defaultFrom)?.id ?? "");

  // After a posted transfer, start a fresh key and an empty line set (render-phase update).
  const [seenState, setSeenState] = useState(state);
  if (state !== seenState) {
    setSeenState(state);
    if (state?.ok) {
      setRef(crypto.randomUUID());
      setLines([{ key: nextKey, ingredientId: ingredients[0]?.id ?? "", unit: "", qty: "" }]);
      setNextKey((k) => k + 1);
    }
  }
  useEffect(() => {
    if (state?.ok) router.refresh();
  }, [state, router]);

  const payload = JSON.stringify(
    lines
      .filter((l) => l.ingredientId && Number(l.qty) > 0 && l.unit)
      .map((l) => ({ ingredientId: l.ingredientId, unit: l.unit, qty: Number(l.qty) })),
  );

  if (outlets.length < 2) {
    return <p className="text-sm text-muted-foreground">Transfers need at least two active outlets.</p>;
  }

  return (
    <form action={formAction} className="space-y-4" noValidate>
      <input type="hidden" name="businessId" value={businessId} />
      <input type="hidden" name="clientRef" value={ref} />
      <input type="hidden" name="lines" value={payload} />
      <FormError state={state} />
      <FormSuccess message={state?.ok ? "Transfer posted." : undefined} />

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="tr-from">From outlet</Label>
          <Select id="tr-from" name="fromOutletId" value={from} onChange={(e) => setFrom(e.target.value)}>
            {outlets.map((o) => (
              <option key={o.id} value={o.id}>{o.name}</option>
            ))}
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="tr-to">To outlet</Label>
          <Select id="tr-to" name="toOutletId" value={to} onChange={(e) => setTo(e.target.value)}>
            {outlets.map((o) => (
              <option key={o.id} value={o.id}>{o.name}</option>
            ))}
          </Select>
          <FieldError state={state} name="toOutletId" />
        </div>
      </div>

      <ul className="space-y-2">
        {lines.map((line) => {
          const ing = ingredients.find((i) => i.id === line.ingredientId);
          const units = ing && isIngredientBaseUnit(ing.unit) ? compatibleUnits(ing.unit) : [];
          return (
            <li key={line.key} className="grid gap-2 sm:grid-cols-[1fr_110px_100px_auto]">
              <Select
                aria-label="Ingredient"
                value={line.ingredientId}
                onChange={(e) => {
                  const next = ingredients.find((i) => i.id === e.target.value);
                  const base = next && isIngredientBaseUnit(next.unit) ? compatibleUnits(next.unit)[0] : undefined;
                  setLines((c) => c.map((l) => (l.key === line.key ? { ...l, ingredientId: e.target.value, unit: base?.code ?? "" } : l)));
                }}
              >
                {ingredients.map((i) => (
                  <option key={i.id} value={i.id}>{i.name} ({i.unit})</option>
                ))}
              </Select>
              <Input
                aria-label="Quantity"
                type="number"
                min={0}
                step="any"
                value={line.qty}
                onChange={(e) => setLines((c) => c.map((l) => (l.key === line.key ? { ...l, qty: e.target.value } : l)))}
              />
              <Select
                aria-label="Unit"
                value={line.unit}
                onChange={(e) => setLines((c) => c.map((l) => (l.key === line.key ? { ...l, unit: e.target.value } : l)))}
              >
                {units.map((u) => (
                  <option key={u.code} value={u.code}>{u.label}</option>
                ))}
              </Select>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label="Remove line"
                disabled={lines.length === 1}
                onClick={() => setLines((c) => c.filter((l) => l.key !== line.key))}
              >
                <Trash2 className="size-4" aria-hidden />
              </Button>
            </li>
          );
        })}
      </ul>
      <FieldError state={state} name="lines" />

      <div className="flex flex-wrap items-center justify-between gap-3">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={lines.length >= 20 || ingredients.length === 0}
          onClick={() => {
            setLines((c) => [...c, { key: nextKey, ingredientId: ingredients[0]?.id ?? "", unit: "", qty: "" }]);
            setNextKey((k) => k + 1);
          }}
        >
          <Plus className="size-4" aria-hidden /> Add line
        </Button>
        <div className="flex items-center gap-3">
          <Input name="note" placeholder="Note (optional)" maxLength={200} className="w-56" />
          <Button type="submit" disabled={pending || from === to}>
            {pending ? "Posting…" : "Post transfer"}
          </Button>
        </div>
      </div>
      {from === to ? <p className="text-sm text-destructive">Choose two different outlets.</p> : null}
    </form>
  );
}
