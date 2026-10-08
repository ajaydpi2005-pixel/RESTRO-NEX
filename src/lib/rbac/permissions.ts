/**
 * RestroNex Phase 5 — RBAC catalogue (code authority).
 *
 * This module is the enforcement authority for permission checks on hot
 * paths (server actions, route handlers). The database catalogue
 * (roles / permissions / role_permissions, migration
 * 20261008150000_rbac.sql) mirrors it for auditability and UI-driven
 * introspection; a live E2E check asserts the two stay in sync.
 *
 * Spec §11: granular permissions, never rely on role names alone, and every
 * check is server-side. UI permission awareness is a convenience, never a
 * boundary.
 */

export const PERMISSION_DOMAINS = [
  "orders",
  "billing",
  "discounts",
  "refunds",
  "menu",
  "inventory",
  "purchasing",
  "customers",
  "reports",
  "staff",
  "settings",
  "outlets",
  "subscriptions",
] as const;

export type PermissionDomain = (typeof PERMISSION_DOMAINS)[number];

/** Every granular permission key, grouped by domain. */
export const PERMISSIONS = [
  "orders.view",
  "orders.manage",
  "billing.view",
  "billing.manage",
  "discounts.apply",
  "discounts.manage",
  "refunds.view",
  "refunds.process",
  "refunds.manage",
  "menu.view",
  "menu.manage",
  "inventory.view",
  "inventory.manage",
  "purchasing.view",
  "purchasing.manage",
  "customers.view",
  "customers.manage",
  "reports.view",
  "staff.view",
  "staff.manage",
  "settings.view",
  "settings.manage",
  "outlets.view",
  "outlets.manage",
  "subscriptions.view",
  "subscriptions.manage",
] as const;

export type Permission = (typeof PERMISSIONS)[number];

/** Roles assignable to a membership (mirrors memberships_role_allowed). */
export const ROLES = [
  "owner",
  "business_admin",
  "outlet_manager",
  "inventory_manager",
  "accountant",
  "cashier",
  "waiter",
  "kitchen_staff",
] as const;

export type Role = (typeof ROLES)[number];

export interface RoleMeta {
  label: string;
  /** Assignment hierarchy: staff managers may only assign ranks below their own. */
  rank: number;
  scope: "business" | "outlet";
}

export const ROLE_META: Record<Role, RoleMeta> = {
  owner: { label: "Owner", rank: 100, scope: "business" },
  business_admin: { label: "Admin", rank: 90, scope: "business" },
  outlet_manager: { label: "Outlet Manager", rank: 70, scope: "outlet" },
  inventory_manager: { label: "Inventory Manager", rank: 60, scope: "business" },
  accountant: { label: "Accountant", rank: 55, scope: "business" },
  cashier: { label: "Cashier", rank: 50, scope: "outlet" },
  waiter: { label: "Waiter", rank: 40, scope: "outlet" },
  kitchen_staff: { label: "Kitchen Staff", rank: 30, scope: "outlet" },
};

const ALL: readonly Permission[] = PERMISSIONS;

/** Roles that implicitly reach every outlet of their business (no grants needed). */
export const ALL_OUTLETS_ROLES: readonly Role[] = ["owner", "business_admin"];

/**
 * Role → permission matrix. Keep in lockstep with the role_permissions seed
 * in supabase/migrations/20261008150000_rbac.sql.
 */
export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  owner: ALL,
  business_admin: ALL.filter((p) => p !== "subscriptions.manage"),
  outlet_manager: [
    "orders.view",
    "orders.manage",
    "billing.view",
    "billing.manage",
    "discounts.apply",
    "discounts.manage",
    "refunds.view",
    "refunds.process",
    "refunds.manage",
    "menu.view",
    "menu.manage",
    "customers.view",
    "customers.manage",
    "reports.view",
    "staff.view",
    "inventory.view",
    "settings.view",
    "outlets.view",
  ],
  cashier: [
    "orders.view",
    "orders.manage",
    "billing.view",
    "billing.manage",
    "discounts.apply",
    "menu.view",
    "customers.view",
  ],
  waiter: ["orders.view", "orders.manage", "billing.view", "menu.view", "customers.view"],
  kitchen_staff: ["orders.view", "menu.view"],
  inventory_manager: [
    "inventory.view",
    "inventory.manage",
    "purchasing.view",
    "purchasing.manage",
    "menu.view",
    "reports.view",
  ],
  accountant: ["billing.view", "refunds.view", "reports.view", "customers.view", "subscriptions.view"],
};

export function isRole(value: unknown): value is Role {
  return typeof value === "string" && (ROLES as readonly string[]).includes(value);
}

export function isPermission(value: unknown): value is Permission {
  return typeof value === "string" && (PERMISSIONS as readonly string[]).includes(value);
}

/** The permission set granted to a role. */
export function permissionsForRole(role: Role): ReadonlySet<Permission> {
  return new Set(ROLE_PERMISSIONS[role]);
}

/** Pure permission check — the single decision used by every server gate. */
export function hasPermission(role: Role | string | null | undefined, permission: Permission): boolean {
  if (!role || !isRole(role)) return false;
  return permissionsForRole(role).has(permission);
}

/**
 * Assignment hierarchy: `actor` may assign `target` only when the target
 * rank is strictly lower. 'owner' can never be assigned through staff
 * management (ownership transfer is a separate flow).
 */
export function canAssignRole(actor: Role | string | null | undefined, target: Role | string): boolean {
  if (!actor || !isRole(actor) || !isRole(target)) return false;
  if (target === "owner") return false;
  return ROLE_META[target].rank < ROLE_META[actor].rank;
}

/** Roles the actor may assign through staff management. */
export function assignableRoles(actor: Role | string | null | undefined): Role[] {
  if (!actor || !isRole(actor)) return [];
  return ROLES.filter((role) => canAssignRole(actor, role));
}
