import type { PosCombo, PosProduct } from "@/modules/orders/queries";

/**
 * Phase 12 — waiter cart (pure logic, no React, no I/O).
 *
 * The cart holds what the waiter is about to send. Prices shown here are
 * ESTIMATES for the waiter's screen only: the database re-prices every line
 * when the order is sent (waiter_submit_order → pos_persist_items).
 */

export const WAITER_QTY_MAX = 99;
export const WAITER_NOTE_MAX = 200;
export const WAITER_ORDER_NOTE_MAX = 400;

export interface WaiterModifier {
  modifierId: string;
  name: string;
  priceMinor: number;
}

export interface WaiterLine {
  /** local key only — never sent to the server */
  key: string;
  itemType: "product" | "combo";
  productId: string | null;
  comboId: string | null;
  variantId: string | null;
  name: string;
  /** estimate, minor units */
  unitPriceMinor: number;
  modifiers: WaiterModifier[];
  quantity: number;
  itemNotes: string | null;
}

export interface ProductSelection {
  variantId: string | null;
  /** chosen option ids (each option is taken once) */
  modifierIds: string[];
  quantity: number;
  itemNotes: string;
}

export type SelectionCheck = { ok: true } | { ok: false; errors: string[] };

/** Client-side mirror of the modifier and variant rules. The DB re-checks them. */
export function checkProductSelection(product: PosProduct, sel: ProductSelection): SelectionCheck {
  const errors: string[] = [];

  if (product.variants.length > 0) {
    const variant = product.variants.find((v) => v.id === sel.variantId);
    if (!variant) errors.push("Choose a size or variant.");
    else if (!variant.isAvailable) errors.push(`${variant.name} is not available right now.`);
  }

  for (const group of product.modifierGroups) {
    const chosen = group.modifiers.filter((m) => sel.modifierIds.includes(m.id)).length;
    if (chosen < group.minSelected) {
      errors.push(`${group.name}: choose at least ${group.minSelected}.`);
    }
    if (group.maxSelected !== null && chosen > group.maxSelected) {
      errors.push(`${group.name}: choose at most ${group.maxSelected}.`);
    }
  }

  if (!Number.isInteger(sel.quantity) || sel.quantity < 1 || sel.quantity > WAITER_QTY_MAX) {
    errors.push(`Quantity must be between 1 and ${WAITER_QTY_MAX}.`);
  }
  if (sel.itemNotes.trim().length > WAITER_NOTE_MAX) {
    errors.push(`Notes must be ${WAITER_NOTE_MAX} characters or fewer.`);
  }

  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

/** Build a cart line from a checked product selection. */
export function buildProductLine(
  product: PosProduct,
  sel: ProductSelection,
  key: string,
): WaiterLine {
  const variant = product.variants.find((v) => v.id === sel.variantId) ?? null;
  const modifiers: WaiterModifier[] = [];
  for (const group of product.modifierGroups) {
    for (const option of group.modifiers) {
      if (sel.modifierIds.includes(option.id)) {
        modifiers.push({ modifierId: option.id, name: option.name, priceMinor: option.priceMinor });
      }
    }
  }
  return {
    key,
    itemType: "product",
    productId: product.id,
    comboId: null,
    variantId: variant?.id ?? null,
    name: variant ? `${product.name} (${variant.name})` : product.name,
    unitPriceMinor: variant ? variant.priceMinor : product.effectivePriceMinor,
    modifiers,
    quantity: sel.quantity,
    itemNotes: sel.itemNotes.trim() || null,
  };
}

export function buildComboLine(
  combo: PosCombo,
  quantity: number,
  itemNotes: string,
  key: string,
): WaiterLine {
  return {
    key,
    itemType: "combo",
    productId: null,
    comboId: combo.id,
    variantId: null,
    name: combo.name,
    unitPriceMinor: combo.priceMinor,
    modifiers: [],
    quantity,
    itemNotes: itemNotes.trim() || null,
  };
}

export function lineEstimateMinor(line: WaiterLine): number {
  const perUnit = line.unitPriceMinor + line.modifiers.reduce((sum, m) => sum + m.priceMinor, 0);
  return perUnit * line.quantity;
}

export function estimateTotalMinor(lines: readonly WaiterLine[]): number {
  return lines.reduce((sum, line) => sum + lineEstimateMinor(line), 0);
}

export function itemCount(lines: readonly WaiterLine[]): number {
  return lines.reduce((sum, line) => sum + line.quantity, 0);
}

export function setLineQuantity(lines: WaiterLine[], key: string, quantity: number): WaiterLine[] {
  const clamped = Math.min(WAITER_QTY_MAX, Math.max(1, Math.round(quantity)));
  return lines.map((line) => (line.key === key ? { ...line, quantity: clamped } : line));
}

export function removeLine(lines: WaiterLine[], key: string): WaiterLine[] {
  return lines.filter((line) => line.key !== key);
}

export function setLineNote(lines: WaiterLine[], key: string, note: string): WaiterLine[] {
  const trimmed = note.trim().slice(0, WAITER_NOTE_MAX);
  return lines.map((line) => (line.key === key ? { ...line, itemNotes: trimmed || null } : line));
}

/** Payload shape the waiter_submit_order action expects (camelCase, validated server-side). */
export function toSubmissionItems(lines: readonly WaiterLine[]) {
  return lines.map((line) => ({
    itemType: line.itemType,
    productId: line.productId,
    comboId: line.comboId,
    variantId: line.variantId,
    quantity: line.quantity,
    itemNotes: line.itemNotes ?? "",
    modifiers: line.modifiers.map((m) => ({ modifierId: m.modifierId, quantity: 1 })),
  }));
}

/** Local draft storage: restores an unsent cart after a reload. Invalid data is dropped. */
export function serializeDraft(lines: readonly WaiterLine[]): string {
  return JSON.stringify(lines);
}

export function parseDraft(raw: string | null): WaiterLine[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(isWaiterLine);
}

function isWaiterLine(value: unknown): value is WaiterLine {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.key === "string" &&
    (v.itemType === "product" || v.itemType === "combo") &&
    typeof v.name === "string" &&
    typeof v.unitPriceMinor === "number" &&
    Array.isArray(v.modifiers) &&
    typeof v.quantity === "number" &&
    Number.isInteger(v.quantity) &&
    v.quantity >= 1 &&
    v.quantity <= WAITER_QTY_MAX
  );
}

export function draftStorageKey(outletId: string, tableId: string): string {
  return `restronex.waiter.draft.${outletId}.${tableId}`;
}
