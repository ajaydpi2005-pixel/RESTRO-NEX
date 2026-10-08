/**
 * Phase 7 — Effective price/availability resolution.
 *
 * The menu is the single source of truth: base values live on the product /
 * variant; outlets may override price and/or availability. A missing override
 * means "inherit the base". POS, online ordering and reports all resolve
 * through this function so the rules never drift.
 */

export interface MenuBaseValues {
  priceMinor: number;
  isAvailable: boolean;
}

export interface OutletOverrideValues {
  /** null = no price override → base price applies. */
  priceMinor: number | null;
  isAvailable: boolean;
}

export interface ResolvedMenuValues {
  priceMinor: number;
  isAvailable: boolean;
  priceOverridden: boolean;
}

export function resolveMenuValues(
  base: MenuBaseValues,
  override: OutletOverrideValues | null | undefined,
): ResolvedMenuValues {
  if (!override) {
    return { priceMinor: base.priceMinor, isAvailable: base.isAvailable, priceOverridden: false };
  }
  return {
    priceMinor: override.priceMinor ?? base.priceMinor,
    // Outlet availability is authoritative when an override row exists.
    isAvailable: base.isAvailable && override.isAvailable,
    priceOverridden: override.priceMinor !== null,
  };
}

/** True when the product (or variant) can be sold in the outlet right now. */
export function sellableInOutlet(
  base: MenuBaseValues,
  override: OutletOverrideValues | null | undefined,
): boolean {
  return resolveMenuValues(base, override).isAvailable;
}
