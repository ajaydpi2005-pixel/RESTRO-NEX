"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import {
  changePasswordSchema,
  forgotPasswordSchema,
  profileSchema,
  resetPasswordSchema,
  sanitizeNext,
  signInSchema,
  signUpSchema,
} from "@/modules/auth/schemas";

/**
 * Auth server actions (spec §12). Every action:
 *  - validates input with zod before any Supabase call
 *  - returns field-level or form-level errors for the UI
 *  - never leaks whether an email exists (sign-in/forgot flows)
 */

export interface AuthActionState {
  ok?: boolean;
  error?: string;
  fieldErrors?: Partial<Record<string, string[]>>;
  /** Sign-up succeeded; the user must confirm their email before signing in. */
  needsVerification?: boolean;
}

const GENERIC_ERROR = "Something went wrong. Please try again.";

async function getOrigin(): Promise<string> {
  const headerList = await headers();
  const host = headerList.get("host") ?? "localhost:3000";
  const proto = headerList.get("x-forwarded-proto") ?? "http";
  return `${proto}://${host}`;
}

function zodFieldErrors(error: import("zod").ZodError): Partial<Record<string, string[]>> {
  const fieldErrors: Partial<Record<string, string[]>> = {};
  for (const issue of error.issues) {
    const key = issue.path.join(".") || "form";
    (fieldErrors[key] ??= []).push(issue.message);
  }
  return fieldErrors;
}

export async function signUpAction(
  _previous: AuthActionState | undefined,
  formData: FormData,
): Promise<AuthActionState> {
  const parsed = signUpSchema.safeParse(Object.fromEntries(formData.entries()));
  if (!parsed.success) {
    return { fieldErrors: zodFieldErrors(parsed.error) };
  }

  const supabase = await createClient();
  const origin = await getOrigin();

  const { data, error } = await supabase.auth.signUp({
    email: parsed.data.email,
    password: parsed.data.password,
    options: {
      data: { full_name: parsed.data.fullName || null },
      emailRedirectTo: `${origin}/auth/confirm?next=/dashboard`,
    },
  });

  if (error) {
    return { error: error.message.includes("rate limit")
      ? "Too many attempts. Please wait a moment and try again."
      : GENERIC_ERROR };
  }

  // Email already registered: Supabase returns a user with no identities.
  if (data.user && data.user.identities && data.user.identities.length === 0) {
    return {
      error: "An account with this email already exists. Try signing in instead.",
    };
  }

  return { ok: true, needsVerification: true };
}

export async function signInAction(
  _previous: AuthActionState | undefined,
  formData: FormData,
): Promise<AuthActionState> {
  const parsed = signInSchema.safeParse(Object.fromEntries(formData.entries()));
  if (!parsed.success) {
    return { fieldErrors: zodFieldErrors(parsed.error) };
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword({
    email: parsed.data.email,
    password: parsed.data.password,
  });

  if (error) {
    // Deliberately generic: do not reveal whether the email exists.
    return { error: "Invalid email or password." };
  }

  const next = sanitizeNext(formData.get("next") as string | null);
  redirect(next);
}

export async function signOutAction(): Promise<void> {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/");
}

export async function forgotPasswordAction(
  _previous: AuthActionState | undefined,
  formData: FormData,
): Promise<AuthActionState> {
  const parsed = forgotPasswordSchema.safeParse(Object.fromEntries(formData.entries()));
  if (!parsed.success) {
    return { fieldErrors: zodFieldErrors(parsed.error) };
  }

  const supabase = await createClient();
  const origin = await getOrigin();

  await supabase.auth.resetPasswordForEmail(parsed.data.email, {
    redirectTo: `${origin}/auth/confirm?next=/reset-password`,
  });

  // Always report success — never reveal whether the email has an account.
  return { ok: true };
}

export async function resetPasswordAction(
  _previous: AuthActionState | undefined,
  formData: FormData,
): Promise<AuthActionState> {
  const parsed = resetPasswordSchema.safeParse(Object.fromEntries(formData.entries()));
  if (!parsed.success) {
    return { fieldErrors: zodFieldErrors(parsed.error) };
  }

  const supabase = await createClient();

  // The session exists only if the emailed link was verified via /auth/confirm.
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return { error: "This reset link is invalid or has expired. Request a new one." };
  }

  const { error } = await supabase.auth.updateUser({ password: parsed.data.password });
  if (error) {
    return { error: GENERIC_ERROR };
  }

  redirect("/dashboard");
}

export async function updateProfileAction(
  _previous: AuthActionState | undefined,
  formData: FormData,
): Promise<AuthActionState> {
  const parsed = profileSchema.safeParse(Object.fromEntries(formData.entries()));
  if (!parsed.success) {
    return { fieldErrors: zodFieldErrors(parsed.error) };
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    redirect("/login");
  }

  const { error } = await supabase
    .from("user_profiles")
    .update({
      full_name: parsed.data.fullName,
      phone: parsed.data.phone || null,
    })
    .eq("id", user.id);

  if (error) {
    return { error: GENERIC_ERROR };
  }

  // Keep auth metadata in sync for places that read it (e.g. future KDS/POS UIs).
  await supabase.auth.updateUser({ data: { full_name: parsed.data.fullName } });

  return { ok: true };
}

export async function changePasswordAction(
  _previous: AuthActionState | undefined,
  formData: FormData,
): Promise<AuthActionState> {
  const parsed = changePasswordSchema.safeParse(Object.fromEntries(formData.entries()));
  if (!parsed.success) {
    return { fieldErrors: zodFieldErrors(parsed.error) };
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user || !user.email) {
    redirect("/login");
  }

  // Re-authenticate with the current password before changing it.
  const { error: verifyError } = await supabase.auth.signInWithPassword({
    email: user.email,
    password: parsed.data.current,
  });
  if (verifyError) {
    return { fieldErrors: { current: ["Current password is incorrect."] } };
  }

  const { error } = await supabase.auth.updateUser({ password: parsed.data.password });
  if (error) {
    return { error: GENERIC_ERROR };
  }

  return { ok: true };
}


