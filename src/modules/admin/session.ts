import { cache } from "react";
import { getSupabaseEnv } from "@/lib/env";
import { createClient } from "@/lib/supabase/server";
import {
  AdminAccessError,
  isOperatorRole,
  OPERATOR_PERMISSIONS,
  operatorCan,
  type OperatorPermission,
  type OperatorState,
} from "./access";
import { adminRpc } from "./rpc";

/**
 * Operator session resolution. SERVER ONLY.
 *
 * The user comes from the verified Supabase session (auth.getUser), never from
 * request input. The operator role is read live from the database on every
 * request, so a revoked operator loses access on their next request, even with
 * a valid login. Cached per request so the layout, page and loaders share one
 * lookup.
 */

export type OperatorSession = Extract<OperatorState, { kind: "operator" }>;

function isPermission(value: string): value is OperatorPermission {
  return (OPERATOR_PERMISSIONS as readonly string[]).includes(value);
}

export const getOperatorState = cache(async (): Promise<OperatorState> => {
  try {
    getSupabaseEnv();
  } catch {
    return { kind: "unconfigured" };
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { kind: "anonymous" };

  const context = await adminRpc<{ role: string; permissions: string[] } | null>(
    "admin_operator_context",
    { p_actor: user.id },
  );
  if (!context || !isOperatorRole(context.role)) return { kind: "not-operator" };

  return {
    kind: "operator",
    userId: user.id,
    email: user.email ?? "",
    role: context.role,
    permissions: context.permissions.filter(isPermission),
  };
});

/**
 * Throws unless the current request is an operator holding `permission`.
 * Every admin loader and action calls this first. The database checks again.
 */
export async function requireOperator(permission: OperatorPermission): Promise<OperatorSession> {
  const state = await getOperatorState();
  if (state.kind === "operator") {
    if (!operatorCan(state.permissions, permission)) {
      throw new AdminAccessError("forbidden");
    }
    return state;
  }
  if (state.kind === "anonymous") throw new AdminAccessError("anonymous");
  if (state.kind === "unconfigured") throw new AdminAccessError("unconfigured");
  throw new AdminAccessError("not-operator");
}
