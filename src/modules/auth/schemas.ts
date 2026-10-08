import { z } from "zod";

/**
 * Auth input validation (spec §12). Every server action parses untrusted
 * form data through these schemas before touching Supabase.
 *
 * Password policy: minimum 8 characters with at least one letter and one
 * number. GoTrue is configured to enforce the length floor server-side too;
 * the richer rules live here and in the UI copy.
 */

export const emailSchema = z.email("Enter a valid email address.").max(254, "Email is too long.");

export const passwordSchema = z
  .string()
  .min(8, "Use at least 8 characters.")
  .max(72, "Passwords are limited to 72 characters.")
  .regex(/[A-Za-z]/, "Include at least one letter.")
  .regex(/[0-9]/, "Include at least one number.");

const confirmSchema = z.string().min(1, "Repeat your password.");

export const signUpSchema = z
  .object({
    fullName: z
      .string()
      .trim()
      .max(80, "Keep the name under 80 characters.")
      .optional()
      .or(z.literal("")),
    email: emailSchema,
    password: passwordSchema,
    confirm: confirmSchema,
  })
  .refine((data) => data.password === data.confirm, {
    message: "Passwords do not match.",
    path: ["confirm"],
  });

export const signInSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, "Enter your password."),
});

export const forgotPasswordSchema = z.object({
  email: emailSchema,
});

export const resetPasswordSchema = z
  .object({
    password: passwordSchema,
    confirm: confirmSchema,
  })
  .refine((data) => data.password === data.confirm, {
    message: "Passwords do not match.",
    path: ["confirm"],
  });

export const changePasswordSchema = z
  .object({
    current: z.string().min(1, "Enter your current password."),
    password: passwordSchema,
    confirm: confirmSchema,
  })
  .refine((data) => data.password === data.confirm, {
    message: "Passwords do not match.",
    path: ["confirm"],
  });

export const profileSchema = z.object({
  fullName: z.string().trim().min(1, "Enter a name.").max(80, "Keep the name under 80 characters."),
  phone: z
    .string()
    .trim()
    .max(20, "Phone numbers are limited to 20 characters.")
    .optional()
    .or(z.literal("")),
});

/**
 * Open-redirect guard for ?next= parameters: only same-origin,
 * path-absolute targets are honoured.
 */
export function sanitizeNext(next: string | null | undefined): string {
  if (!next || !next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\")) {
    return "/dashboard";
  }
  return next;
}
