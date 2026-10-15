import type { OrderingSettings, PublicMenuItem, PublicModifier, PublicVariant } from "./types";

/**
 * Phase 17 — cart logic shared by the storefront and its tests. Pure functions.
 *
 * Totals computed here are for display only. The server re-prices every line
 * from the universal menu when the order is placed.
 */

export interface CartModifier {
  id: string;
  name: string;
  price_minor: number;
}

export interface CartLine {
  lineId: string;
  kind: "product" | "combo";
  itemId: string;
  itemName: string;
  variant: { id: string; name: string; price_minor: number } | null;
  modifiers: CartModifier[];
  quantity: number;
  notes: string | null;
  unitMinor: number;
}

export interface ModifierSelection {
  groupId: string;
  groupName: string;
  min: number;
  max: number | null;
  options: PublicModifier[];
}

export function unitPriceMinor(
  item: Pick<PublicMenuItem, "price_minor">,
  variant: PublicVariant | null,
  modifiers: { price_minor: number }[],
): number {
  const base = variant ? variant.price_minor : item.price_minor;
  return base + modifiers.reduce((sum, m) => sum + m.price_minor, 0);
}

export function lineTotalMinor(line: Pick<CartLine, "unitMinor" | "quantity">): number {
  return line.unitMinor * line.quantity;
}

export function cartSubtotalMinor(lines: CartLine[]): number {
  return lines.reduce((sum, line) => sum + lineTotalMinor(line), 0);
}

/**
 * Checks the choices for one item against the menu's rules. Returns the first
 * problem as a customer-facing sentence, or null when the choices are valid.
 */
export function validateSelection(input: {
  item: PublicMenuItem;
  variantId: string | null;
  selectedModifierIds: string[];
  quantity: number;
}): string | null {
  const { item, variantId, selectedModifierIds, quantity } = input;
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 99) {
    return "Quantity must be between 1 and 99.";
  }
  if (item.variants.length > 0 && !item.variants.some((v) => v.id === variantId)) {
    return "Choose a size or variant.";
  }
  for (const group of item.modifier_groups) {
    const chosen = group.modifiers.filter((m) => selectedModifierIds.includes(m.id)).length;
    if (chosen < group.min_selected) {
      return `Choose at least ${group.min_selected} option${group.min_selected === 1 ? "" : "s"} for ${group.name}.`;
    }
    if (group.max_selected !== null && chosen > group.max_selected) {
      return `Choose at most ${group.max_selected} option${group.max_selected === 1 ? "" : "s"} for ${group.name}.`;
    }
  }
  return null;
}

/** A stable description of the cart and form. A retried submission reuses its key only when this matches. */
export function cartSignature(lines: CartLine[], form: Record<string, string>): string {
  return JSON.stringify({
    lines: lines.map((l) => [
      l.kind,
      l.itemId,
      l.variant?.id ?? null,
      l.modifiers.map((m) => m.id).sort(),
      l.quantity,
      l.notes,
    ]),
    form: Object.keys(form)
      .sort()
      .map((k) => [k, form[k]]),
  });
}

/** Whether the outlet can take an order right now, and why not. */
export function orderingBlock(
  settings: OrderingSettings,
  mode: "online" | "qr",
  orderType: "takeaway" | "delivery" | null,
): string | null {
  if (!settings.accepting_orders) return "The restaurant is not taking orders right now.";
  if (mode === "qr") {
    return settings.qr_enabled ? null : "Table ordering is not available right now.";
  }
  if (!settings.online_enabled) return "Online ordering is not available right now.";
  if (!settings.takeaway_enabled && !settings.delivery_enabled) {
    return "Online ordering is not available right now.";
  }
  if (orderType === "takeaway" && !settings.takeaway_enabled)
    return "Takeaway is not available right now.";
  if (orderType === "delivery" && !settings.delivery_enabled)
    return "Delivery is not available right now.";
  return null;
}
