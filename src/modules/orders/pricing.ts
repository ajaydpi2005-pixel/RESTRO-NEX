/**
 * Phase 8 — Order totals computation (display copy).
 *
 * The authoritative totals are computed by the DB RPCs (create_pos_order /
 * pos_apply_totals); this pure implementation mirrors the SAME formula so
 * the POS can show live totals instantly. Keep both in lockstep:
 *
 *   line_gross  = (unit_price + modifiers) * quantity
 *   subtotal    = Σ line_gross
 *   discount    = percent ? round(subtotal * value / 100) : min(value, subtotal)
 *   line_share  = round(discount * line_gross / subtotal)        (pro-rata)
 *   line_tax    = round((line_gross - line_share) * tax_pct / 100)  (exclusive)
 *   total       = subtotal - discount + Σ line_tax + Σ charges
 */

export interface OrderLineInput {
  /** unit price in minor units (already resolved incl. outlet overrides) */
  unitPriceMinor: number;
  /** sum of modifier prices (per single unit), minor units */
  modifiersMinor: number;
  quantity: number;
  /** exclusive tax percentage for this line */
  taxPct: number;
}

export interface DiscountInput {
  type: "none" | "percent" | "flat";
  value: number; // percent: 0–100 · flat: minor units
}

export interface OrderTotals {
  subtotalMinor: number;
  discountMinor: number;
  taxMinor: number;
  chargesMinor: number;
  totalMinor: number;
}

export function computeOrderTotals(
  lines: OrderLineInput[],
  discount: DiscountInput,
  chargesMinor: number[],
): OrderTotals {
  const subtotalMinor = lines.reduce(
    (sum, line) => sum + (line.unitPriceMinor + line.modifiersMinor) * line.quantity,
    0,
  );

  let discountMinor = 0;
  if (discount.type === "percent") {
    discountMinor = Math.round((subtotalMinor * Math.min(Math.max(discount.value, 0), 100)) / 100);
  } else if (discount.type === "flat") {
    discountMinor = Math.min(Math.max(discount.value, 0), subtotalMinor);
  }

  let taxMinor = 0;
  for (const line of lines) {
    const lineGross = (line.unitPriceMinor + line.modifiersMinor) * line.quantity;
    const share =
      subtotalMinor > 0 ? Math.round((discountMinor * lineGross) / subtotalMinor) : 0;
    taxMinor += Math.round(((lineGross - share) * line.taxPct) / 100);
  }

  const charges = chargesMinor.reduce((sum, c) => sum + Math.max(c, 0), 0);

  return {
    subtotalMinor,
    discountMinor,
    taxMinor,
    chargesMinor: charges,
    totalMinor: subtotalMinor - discountMinor + taxMinor + charges,
  };
}
