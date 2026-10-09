import { describe, expect, it } from "vitest";
import {
  assignableRoles,
  canAssignRole,
  hasPermission,
  isPermission,
  PERMISSIONS,
  PERMISSION_DOMAINS,
  permissionsForRole,
  ROLE_META,
  ROLE_PERMISSIONS,
  ROLES,
} from "@/lib/rbac/permissions";

describe("RBAC catalogue integrity", () => {
  it("defines all 8 required roles", () => {
    expect([...ROLES].sort()).toEqual(
      [
        "owner",
        "business_admin",
        "outlet_manager",
        "cashier",
        "waiter",
        "kitchen_staff",
        "inventory_manager",
        "accountant",
      ].sort(),
    );
  });

  it("covers all 14 permission domains (Phase 11 adds kitchen)", () => {
    expect([...PERMISSION_DOMAINS].sort()).toEqual(
      [
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
        "kitchen",
      ].sort(),
    );
    const domainsInKeys = new Set(PERMISSIONS.map((p) => p.split(".")[0]));
    expect([...domainsInKeys].sort()).toEqual([...PERMISSION_DOMAINS].sort());
  });

  it("every role maps to valid, non-empty permission sets", () => {
    for (const role of ROLES) {
      const permissions = ROLE_PERMISSIONS[role];
      expect(permissions.length).toBeGreaterThan(0);
      for (const permission of permissions) {
        expect(isPermission(permission)).toBe(true);
      }
    }
  });

  it("owner holds every permission and is a superset of every role", () => {
    const owner = permissionsForRole("owner");
    expect(owner.size).toBe(PERMISSIONS.length);
    for (const role of ROLES) {
      for (const permission of permissionsForRole(role)) {
        expect(owner.has(permission)).toBe(true);
      }
    }
  });

  it("business_admin holds everything except subscriptions.manage", () => {
    const admin = permissionsForRole("business_admin");
    expect(admin.has("subscriptions.manage")).toBe(false);
    expect(admin.has("subscriptions.view")).toBe(true);
    expect(admin.size).toBe(PERMISSIONS.length - 1);
  });

  it("waiter gets no financial administration (spec §19)", () => {
    const waiter = permissionsForRole("waiter");
    for (const forbidden of [
      "discounts.apply",
      "discounts.manage",
      "refunds.process",
      "refunds.manage",
      "billing.manage",
      "reports.view",
      "staff.manage",
      "settings.manage",
    ]) {
      expect(waiter.has(forbidden as (typeof PERMISSIONS)[number])).toBe(false);
    }
  });

  it("cashier cannot refund or view reports", () => {
    expect(hasPermission("cashier", "refunds.process")).toBe(false);
    expect(hasPermission("cashier", "reports.view")).toBe(false);
    expect(hasPermission("cashier", "discounts.apply")).toBe(true);
  });

  it("accountant is read-only everywhere it can see", () => {
    const accountant = permissionsForRole("accountant");
    for (const permission of accountant) {
      expect(permission.endsWith(".view")).toBe(true);
    }
    expect(accountant.has("subscriptions.view")).toBe(true);
    expect(accountant.has("subscriptions.manage")).toBe(false);
  });

  it("kitchen staff see orders and the menu, and work the board — nothing financial", () => {
    expect([...permissionsForRole("kitchen_staff")].sort()).toEqual([
      "kitchen.operate",
      "kitchen.view",
      "menu.view",
      "orders.view",
    ]);
    const kitchen = permissionsForRole("kitchen_staff");
    expect(kitchen.has("kitchen.manage")).toBe(false);
    for (const prefix of ["billing.", "refunds.", "discounts.", "settings.", "subscriptions.", "reports."]) {
      expect([...kitchen].some((p) => p.startsWith(prefix))).toBe(false);
    }
  });

  it("only managers can configure kitchen routing; no other role touches the KDS", () => {
    for (const role of ["owner", "business_admin", "outlet_manager"] as const) {
      expect(permissionsForRole(role).has("kitchen.manage")).toBe(true);
    }
    for (const role of ["cashier", "waiter", "accountant", "inventory_manager"] as const) {
      expect([...permissionsForRole(role)].some((p) => p.startsWith("kitchen."))).toBe(false);
    }
  });

  it("hasPermission is safe against garbage input", () => {
    expect(hasPermission(null, "orders.view")).toBe(false);
    expect(hasPermission("superuser", "orders.view")).toBe(false);
    expect(hasPermission(undefined, "staff.manage")).toBe(false);
  });
});

describe("role assignment hierarchy (anti-escalation)", () => {
  it("owner can assign every role except owner", () => {
    for (const role of ROLES) {
      if (role === "owner") continue;
      expect(canAssignRole("owner", role)).toBe(true);
    }
    expect(canAssignRole("owner", "owner")).toBe(false);
  });

  it("nobody can assign owner through staff management", () => {
    for (const role of ROLES) {
      expect(canAssignRole(role, "owner")).toBe(false);
    }
  });

  it("actors cannot assign roles at or above their own rank", () => {
    expect(canAssignRole("business_admin", "business_admin")).toBe(false);
    expect(canAssignRole("outlet_manager", "outlet_manager")).toBe(false);
    expect(canAssignRole("outlet_manager", "business_admin")).toBe(false);
    expect(canAssignRole("waiter", "cashier")).toBe(false);
    expect(canAssignRole("cashier", "cashier")).toBe(false);
  });

  it("assignment only flows down the rank ladder", () => {
    expect(canAssignRole("business_admin", "outlet_manager")).toBe(true);
    expect(canAssignRole("outlet_manager", "cashier")).toBe(true);
    expect(canAssignRole("outlet_manager", "waiter")).toBe(true);
    expect(canAssignRole("outlet_manager", "kitchen_staff")).toBe(true);
    expect(canAssignRole("cashier", "kitchen_staff")).toBe(true);
    expect(canAssignRole("waiter", "kitchen_staff")).toBe(true);
    expect(canAssignRole("kitchen_staff", "waiter")).toBe(false);
  });

  it("assignableRoles respects the hierarchy", () => {
    expect(assignableRoles("owner")).not.toContain("owner");
    expect(assignableRoles("business_admin")).toContain("outlet_manager");
    expect(assignableRoles("business_admin")).not.toContain("business_admin");
    // Outlet managers could rank-assign below themselves, but they lack
    // staff.manage entirely — the permission gate stops them first.
    expect(assignableRoles("outlet_manager")).toEqual(
      expect.arrayContaining(["cashier", "waiter", "kitchen_staff"]),
    );
    expect(assignableRoles("outlet_manager")).not.toContain("business_admin");
    expect(assignableRoles("waiter")).toEqual(["kitchen_staff"]);
    expect(assignableRoles("kitchen_staff")).toEqual([]);
    expect(assignableRoles("ghost")).toEqual([]);
  });

  it("ranks are unique and ordered", () => {
    const ranks = ROLES.map((r) => ROLE_META[r].rank);
    expect(new Set(ranks).size).toBe(ranks.length);
    expect(ROLE_META.owner.rank).toBeGreaterThan(ROLE_META.business_admin.rank);
    expect(ROLE_META.business_admin.rank).toBeGreaterThan(ROLE_META.outlet_manager.rank);
  });
});
