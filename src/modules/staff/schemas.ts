import { z } from "zod";
import { ROLES, type Role } from "@/lib/rbac/permissions";

/**
 * Phase 5 — staff management validation. Role validity against the actor is
 * enforced server-side in the actions (it depends on the actor's own role);
 * these schemas cover shape, formats and anti-escalation basics.
 */

/** Roles a staff manager may assign — 'owner' is never assignable. */
export const ASSIGNABLE_ROLES = ROLES.filter((role) => role !== "owner");

export const membershipIdSchema = z.uuid("Membership id is invalid");

export const addStaffSchema = z.object({
  businessId: z.uuid("Business id is invalid"),
  email: z
    .string()
    .trim()
    .toLowerCase()
    .email("Enter a valid email address")
    .refine((v) => v.length <= 254, "Email is too long"),
  role: z.enum(ASSIGNABLE_ROLES as [Role, ...Role[]]),
  /** Outlet grants — required for outlet-scoped roles. */
  outletIds: z.array(z.uuid("Outlet id is invalid")).default([]),
});

export const updateStaffRoleSchema = z.object({
  businessId: z.uuid("Business id is invalid"),
  membershipId: membershipIdSchema,
  role: z.enum(ASSIGNABLE_ROLES as [Role, ...Role[]]),
});

export const setStaffStatusSchema = z.object({
  businessId: z.uuid("Business id is invalid"),
  membershipId: membershipIdSchema,
  active: z.preprocess((v) => v === true || v === "true", z.boolean()),
});

export const assignOutletsSchema = z.object({
  businessId: z.uuid("Business id is invalid"),
  membershipId: membershipIdSchema,
  outletIds: z.array(z.uuid("Outlet id is invalid")).default([]),
});
