/**
 * Phase 19 — Super Admin access model (pure; no I/O).
 *
 * Operators are rows in platform.super_admins. The database decides what each
 * role may do (platform.operator_permissions); this file mirrors the same
 * matrix so the UI and the decision code can be tested without a database.
 * The test suite checks that the two copies match.
 *
 * Non-operators must never learn that the area exists, so every refusal in the
 * route tree is a 404, not a 403. Only an unauthenticated visitor is sent to
 * the operator sign-in page.
 */

export const OPERATOR_ROLES = ["super_admin", "support", "read_only"] as const;
export type OperatorRole = (typeof OPERATOR_ROLES)[number];

export const OPERATOR_PERMISSIONS = ["view", "support", "plans", "tenants", "operators"] as const;
export type OperatorPermission = (typeof OPERATOR_PERMISSIONS)[number];

export const OPERATOR_ROLE_PERMISSIONS: Record<OperatorRole, readonly OperatorPermission[]> = {
  super_admin: ["view", "support", "plans", "tenants", "operators"],
  support: ["view", "support"],
  read_only: ["view"],
};

export const OPERATOR_ROLE_LABELS: Record<OperatorRole, string> = {
  super_admin: "Super Admin",
  support: "Support",
  read_only: "Read only",
};

export function isOperatorRole(value: unknown): value is OperatorRole {
  return typeof value === "string" && (OPERATOR_ROLES as readonly string[]).includes(value);
}

export function operatorCan(
  permissions: readonly string[] | null | undefined,
  permission: OperatorPermission,
): boolean {
  return Array.isArray(permissions) && permissions.includes(permission);
}

/** The resolved state of the current request's operator session. */
export type OperatorState =
  | { kind: "unconfigured" }
  | { kind: "anonymous" }
  | { kind: "not-operator" }
  | {
      kind: "operator";
      userId: string;
      email: string;
      role: OperatorRole;
      permissions: OperatorPermission[];
    };

export type AdminAccessDecision = "allow" | "sign-in" | "not-found";

/**
 * Layout decision. Fails closed: missing configuration and non-operators get a
 * 404, and only an anonymous visitor is sent to /admin/sign-in.
 */
export function decideAdminAccess(state: OperatorState): AdminAccessDecision {
  switch (state.kind) {
    case "operator":
      return "allow";
    case "anonymous":
      return "sign-in";
    case "unconfigured":
    case "not-operator":
      return "not-found";
  }
}

export type AdminAccessCode = "unconfigured" | "anonymous" | "not-operator" | "forbidden";

export class AdminAccessError extends Error {
  readonly code: AdminAccessCode;

  constructor(code: AdminAccessCode) {
    super(
      code === "anonymous"
        ? "Please sign in again."
        : "You do not have Super Admin access for this action.",
    );
    this.code = code;
    this.name = "AdminAccessError";
  }
}

/** Safe, non-leaking message for action responses. */
export function adminAccessMessage(error: unknown): string {
  if (error instanceof AdminAccessError) return error.message;
  return "You do not have Super Admin access for this action.";
}
