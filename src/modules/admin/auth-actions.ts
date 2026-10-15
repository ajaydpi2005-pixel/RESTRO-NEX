"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { signInSchema } from "@/modules/auth/schemas";
import { adminRpc } from "./rpc";

/**
 * Operator sign-in and sign-out. Separate from tenant sign-in on purpose.
 *
 * Signing in with a correct password is not enough: the account must also be an
 * active operator. A non-operator session is signed out straight away, so no
 * tenant session is left behind on the operator sign-in page.
 */

export interface OperatorSignInState {
  error?: string;
  fieldErrors?: Partial<Record<string, string[]>>;
}

const NOT_OPERATOR = "Those details do not open a Super Admin session.";

export async function operatorSignInAction(
  _previous: OperatorSignInState | undefined,
  formData: FormData,
): Promise<OperatorSignInState> {
  const parsed = signInSchema.safeParse({
    email: String(formData.get("email") ?? ""),
    password: String(formData.get("password") ?? ""),
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Check the highlighted fields." };
  }

  let supabase: Awaited<ReturnType<typeof createClient>>;
  try {
    supabase = await createClient();
  } catch {
    return { error: "Super Admin sign-in is not configured." };
  }

  const { data, error } = await supabase.auth.signInWithPassword({
    email: parsed.data.email,
    password: parsed.data.password,
  });
  if (error || !data.user) {
    return { error: "Email or password is incorrect." };
  }

  // Any failure to read the operator role fails closed.
  const context = await adminRpc<{ role: string } | null>("admin_operator_context", {
    p_actor: data.user.id,
  }).catch(() => null);
  if (!context) {
    await supabase.auth.signOut();
    return { error: NOT_OPERATOR };
  }

  redirect("/admin");
}

export async function operatorSignOutAction(): Promise<void> {
  try {
    const supabase = await createClient();
    await supabase.auth.signOut();
  } finally {
    redirect("/admin/sign-in");
  }
}
