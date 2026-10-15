import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  AdminAccessError,
  adminAccessMessage,
  decideAdminAccess,
  isOperatorRole,
  OPERATOR_PERMISSIONS,
  OPERATOR_ROLE_PERMISSIONS,
  OPERATOR_ROLES,
  operatorCan,
  type OperatorState,
} from "./access";

const MIGRATION = readFileSync(
  join(process.cwd(), "supabase/migrations/20261017100000_super_admin.sql"),
  "utf8",
);

const operator = (role: "super_admin" | "support" | "read_only"): OperatorState => ({
  kind: "operator",
  userId: "11111111-1111-4111-8111-111111111111",
  email: "ops@example.com",
  role,
  permissions: [...OPERATOR_ROLE_PERMISSIONS[role]],
});

describe("decideAdminAccess", () => {
  it("lets operators in, whatever their role", () => {
    expect(decideAdminAccess(operator("super_admin"))).toBe("allow");
    expect(decideAdminAccess(operator("read_only"))).toBe("allow");
  });

  it("sends only an anonymous visitor to the operator sign-in page", () => {
    expect(decideAdminAccess({ kind: "anonymous" })).toBe("sign-in");
  });

  it("answers 404 to a signed-in non-operator, so the area is not revealed", () => {
    expect(decideAdminAccess({ kind: "not-operator" })).toBe("not-found");
  });

  it("fails closed when Supabase is not configured", () => {
    expect(decideAdminAccess({ kind: "unconfigured" })).toBe("not-found");
  });
});

describe("operator permissions", () => {
  it("matches the SQL matrix in platform.operator_permissions exactly", () => {
    const body = MIGRATION.slice(MIGRATION.indexOf("function platform.operator_permissions"));
    const section = body.slice(0, body.indexOf("$$;", body.indexOf("$$")));
    for (const role of OPERATOR_ROLES) {
      const line = section.split("\n").find((l) => l.includes(`'${role}' then array[`));
      expect(line, `SQL line for ${role}`).toBeDefined();
      const list = (line ?? "").slice((line ?? "").indexOf("array["));
      const sqlPermissions = [...list.matchAll(/'([a-z]+)'/g)].map((m) => m[1]).sort();
      expect(sqlPermissions).toEqual([...OPERATOR_ROLE_PERMISSIONS[role]].sort());
    }
  });

  it("gives support no money-or-tenant powers and read_only only view", () => {
    expect(operatorCan(OPERATOR_ROLE_PERMISSIONS.support, "support")).toBe(true);
    expect(operatorCan(OPERATOR_ROLE_PERMISSIONS.support, "plans")).toBe(false);
    expect(operatorCan(OPERATOR_ROLE_PERMISSIONS.support, "tenants")).toBe(false);
    expect(operatorCan(OPERATOR_ROLE_PERMISSIONS.read_only, "view")).toBe(true);
    expect(operatorCan(OPERATOR_ROLE_PERMISSIONS.read_only, "support")).toBe(false);
  });

  it("gives super_admin every permission", () => {
    for (const p of OPERATOR_PERMISSIONS) {
      expect(operatorCan(OPERATOR_ROLE_PERMISSIONS.super_admin, p)).toBe(true);
    }
  });

  it("denies when permissions are missing or malformed", () => {
    expect(operatorCan(undefined, "view")).toBe(false);
    expect(operatorCan(null, "view")).toBe(false);
    expect(operatorCan([], "view")).toBe(false);
  });
});

describe("isOperatorRole", () => {
  it("accepts only the three roles", () => {
    expect(isOperatorRole("super_admin")).toBe(true);
    expect(isOperatorRole("owner")).toBe(false);
    expect(isOperatorRole(null)).toBe(false);
    expect(isOperatorRole(undefined)).toBe(false);
  });
});

describe("refusal messages", () => {
  it("tells an anonymous action caller to sign in again", () => {
    expect(adminAccessMessage(new AdminAccessError("anonymous"))).toBe("Please sign in again.");
  });

  it("never reveals the area in a refusal", () => {
    const message = adminAccessMessage(new AdminAccessError("not-operator"));
    expect(message).toBe("You do not have Super Admin access for this action.");
    expect(message.toLowerCase()).not.toContain("operator role");
  });

  it("gives the generic refusal for anything that is not an access error", () => {
    expect(adminAccessMessage(new Error("boom"))).toBe(
      "You do not have Super Admin access for this action.",
    );
  });
});
