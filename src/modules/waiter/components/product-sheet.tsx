"use client";

import * as React from "react";
import { Minus, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { minorToDisplay } from "@/modules/menu/schemas";
import type { PosCombo, PosProduct } from "@/modules/orders/queries";
import {
  WAITER_NOTE_MAX,
  WAITER_QTY_MAX,
  buildComboLine,
  buildProductLine,
  checkProductSelection,
  type WaiterLine,
} from "@/modules/waiter/cart";
import { cn } from "@/lib/utils";

export type SheetTarget =
  | { kind: "product"; product: PosProduct }
  | { kind: "combo"; combo: PosCombo };

interface Props {
  target: SheetTarget | null;
  onClose: () => void;
  onAdd: (line: WaiterLine) => void;
  newKey: () => string;
}

const money = (minor: number) => `₹${minorToDisplay(minor)}`;

function ruleText(min: number, max: number | null): string {
  if (max === 1 && min === 1) return "Choose 1 (required)";
  if (max === 1) return "Choose 1";
  if (min > 0 && max !== null) return `Choose ${min}–${max} (required)`;
  if (min > 0) return `Choose at least ${min} (required)`;
  if (max !== null) return `Choose up to ${max}`;
  return "Optional";
}

/**
 * Phase 12 — touch sheet for a menu item: variant, modifier options, quantity
 * and a note. Adding is blocked until the selection meets the menu's rules.
 */
export function WaiterProductSheet({ target, onClose, onAdd, newKey }: Props) {
  return (
    <Sheet open={target !== null} onOpenChange={(open) => (open ? undefined : onClose())}>
      <SheetContent side="bottom" className="max-h-[90dvh] overflow-y-auto rounded-t-2xl p-0">
        {target ? (
          <SheetBody key={target.kind === "product" ? target.product.id : target.combo.id} target={target} onAdd={onAdd} newKey={newKey} onClose={onClose} />
        ) : null}
      </SheetContent>
    </Sheet>
  );
}

function SheetBody({
  target,
  onAdd,
  newKey,
  onClose,
}: {
  target: SheetTarget;
  onAdd: (line: WaiterLine) => void;
  newKey: () => string;
  onClose: () => void;
}) {
  const product = target.kind === "product" ? target.product : null;
  const combo = target.kind === "combo" ? target.combo : null;
  const name = product?.name ?? combo?.name ?? "";

  const firstVariant = product?.variants.find((v) => v.isAvailable)?.id ?? null;
  const [variantId, setVariantId] = React.useState<string | null>(firstVariant);
  const [modifierIds, setModifierIds] = React.useState<string[]>([]);
  const [quantity, setQuantity] = React.useState(1);
  const [itemNotes, setItemNotes] = React.useState("");

  const selection = { variantId, modifierIds, quantity, itemNotes };
  const check = product
    ? checkProductSelection(product, selection)
    : quantity >= 1 && quantity <= WAITER_QTY_MAX && itemNotes.trim().length <= WAITER_NOTE_MAX
      ? ({ ok: true } as const)
      : ({ ok: false, errors: ["Check the quantity and note."] } as const);

  const unitPrice = product
    ? (product.variants.find((v) => v.id === variantId)?.priceMinor ?? product.effectivePriceMinor)
    : (combo?.priceMinor ?? 0);
  const optionsTotal = product
    ? product.modifierGroups.reduce(
        (sum, g) => sum + g.modifiers.filter((m) => modifierIds.includes(m.id)).reduce((s, m) => s + m.priceMinor, 0),
        0,
      )
    : 0;
  const total = (unitPrice + optionsTotal) * quantity;

  const toggleOption = (groupMax: number | null, groupModifierIds: string[], optionId: string) => {
    setModifierIds((current) => {
      const isOn = current.includes(optionId);
      if (isOn) return current.filter((id) => id !== optionId);
      if (groupMax === 1) {
        // single-choice group: picking one replaces the previous pick in that group
        return [...current.filter((id) => !groupModifierIds.includes(id)), optionId];
      }
      return [...current, optionId];
    });
  };

  const add = () => {
    if (!check.ok) return;
    if (product) onAdd(buildProductLine(product, selection, newKey()));
    if (combo) onAdd(buildComboLine(combo, quantity, itemNotes, newKey()));
    onClose();
  };

  return (
    <div className="flex flex-col">
      <SheetHeader className="px-5 pt-5">
        <SheetTitle className="font-display text-2xl">{name}</SheetTitle>
        <SheetDescription className="text-base">
          {product && product.variants.length === 0 ? money(product.effectivePriceMinor) : null}
          {combo ? money(combo.priceMinor) : null}
          {product && product.variants.length > 0 ? "Choose a size" : null}
        </SheetDescription>
      </SheetHeader>

      <div className="flex flex-col gap-6 px-5 py-4">
        {product && product.variants.length > 0 ? (
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1 text-sm font-semibold uppercase tracking-wide text-muted-foreground">Size</legend>
            {product.variants.map((variant) => (
              <OptionRow
                key={variant.id}
                selected={variantId === variant.id}
                disabled={!variant.isAvailable}
                label={variant.name}
                detail={money(variant.priceMinor)}
                onClick={() => setVariantId(variant.id)}
                type="radio"
              />
            ))}
          </fieldset>
        ) : null}

        {product?.modifierGroups.map((group) => (
          <fieldset key={group.id} className="flex flex-col gap-2">
            <legend className="mb-1 flex flex-wrap items-baseline gap-2">
              <span className="text-base font-semibold">{group.name}</span>
              <span className="text-sm text-muted-foreground">{ruleText(group.minSelected, group.maxSelected)}</span>
            </legend>
            {group.modifiers.map((option) => (
              <OptionRow
                key={option.id}
                selected={modifierIds.includes(option.id)}
                label={option.name}
                detail={option.priceMinor > 0 ? `+${money(option.priceMinor)}` : null}
                onClick={() =>
                  toggleOption(group.maxSelected, group.modifiers.map((m) => m.id), option.id)
                }
                type={group.maxSelected === 1 ? "radio" : "checkbox"}
              />
            ))}
          </fieldset>
        ))}

        <div className="flex flex-col gap-2">
          <span className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Quantity</span>
          <Stepper
            value={quantity}
            onChange={setQuantity}
            min={1}
            max={WAITER_QTY_MAX}
          />
        </div>

        <label className="flex flex-col gap-2">
          <span className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Note for kitchen</span>
          <textarea
            value={itemNotes}
            maxLength={WAITER_NOTE_MAX}
            onChange={(e) => setItemNotes(e.target.value)}
            placeholder="No onion, extra spicy, allergy…"
            rows={2}
            className="min-h-14 rounded-xl border border-input bg-background px-4 py-3 text-base outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        </label>

        {!check.ok ? (
          <ul className="flex flex-col gap-1 text-sm text-amber-700 dark:text-amber-400">
            {check.errors.map((message) => (
              <li key={message}>• {message}</li>
            ))}
          </ul>
        ) : null}
      </div>

      <SheetFooter className="sticky bottom-0 border-t bg-background px-5 py-4">
        <Button
          size="lg"
          className="h-14 w-full text-base"
          disabled={!check.ok}
          onClick={add}
        >
          Add {quantity} · {money(total)}
        </Button>
      </SheetFooter>
    </div>
  );
}

function OptionRow({
  selected,
  disabled,
  label,
  detail,
  onClick,
  type,
}: {
  selected: boolean;
  disabled?: boolean;
  label: string;
  detail: string | null;
  onClick: () => void;
  type: "radio" | "checkbox";
}) {
  return (
    <button
      type="button"
      role={type}
      aria-checked={selected}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "flex min-h-14 items-center justify-between gap-3 rounded-xl border-2 px-4 py-3 text-left text-base transition-colors",
        selected ? "border-primary bg-primary/10 font-semibold" : "border-border bg-background",
        disabled && "opacity-40",
      )}
    >
      <span className="flex items-center gap-3">
        <span
          aria-hidden
          className={cn(
            "flex size-6 shrink-0 items-center justify-center border-2 border-current",
            type === "radio" ? "rounded-full" : "rounded-md",
            selected && "bg-primary text-primary-foreground",
          )}
        >
          {selected ? "✓" : ""}
        </span>
        {label}
      </span>
      {detail ? <span className="text-sm text-muted-foreground">{detail}</span> : null}
    </button>
  );
}

export function Stepper({
  value,
  onChange,
  min,
  max,
  label,
}: {
  value: number;
  onChange: (next: number) => void;
  min: number;
  max: number;
  label?: string;
}) {
  return (
    <div className="flex items-center gap-4" role="group" aria-label={label ?? "Quantity"}>
      <Button
        type="button"
        variant="outline"
        className="size-14 rounded-xl"
        aria-label="Decrease"
        disabled={value <= min}
        onClick={() => onChange(Math.max(min, value - 1))}
      >
        <Minus className="size-6" />
      </Button>
      <span className="min-w-12 text-center font-display text-3xl font-semibold tabular-nums">{value}</span>
      <Button
        type="button"
        variant="outline"
        className="size-14 rounded-xl"
        aria-label="Increase"
        disabled={value >= max}
        onClick={() => onChange(Math.min(max, value + 1))}
      >
        <Plus className="size-6" />
      </Button>
    </div>
  );
}
