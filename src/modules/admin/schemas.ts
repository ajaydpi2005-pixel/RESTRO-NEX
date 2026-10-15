import { z } from "zod";
import { OPERATOR_ROLES } from "./access";
import { endOfDayIst } from "./format";

/**
 * Input validation for Super Admin actions (pure). The database validates again
 * and is the authority; these rules give quick, specific messages.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const uuid = z.string().trim().regex(UUID, "Pick a valid record.");

/** True when a route parameter is a UUID. Pages call notFound() otherwise. */
export function isUuid(value: string): boolean {
  return UUID.test(value);
}

export const reasonSchema = z
  .string()
  .trim()
  .min(3, "Enter a reason of at least 3 characters.")
  .max(300, "Keep the reason under 300 characters.");

const planCode = z
  .string()
  .trim()
  .toUpperCase()
  .regex(
    /^[A-Z][A-Z_]{1,29}$/,
    "Plan codes use capital letters and underscores (2 to 30 characters).",
  );

const featureKey = z
  .string()
  .trim()
  .regex(/^[a-z_]+$/, "Pick a valid feature.");

export const operatorGrantSchema = z.object({
  email: z.string().trim().toLowerCase().email("Enter a valid email address."),
  role: z.enum(OPERATOR_ROLES, { message: "Choose a valid operator role." }),
  reason: reasonSchema,
});

export const operatorRevokeSchema = z.object({
  userId: uuid,
  reason: reasonSchema,
});

export const businessStatusSchema = z.object({
  businessId: uuid,
  status: z.enum(["active", "suspended"], { message: "Choose active or suspended." }),
  reason: reasonSchema,
});

export const membershipDeactivateSchema = z.object({
  membershipId: uuid,
  reason: reasonSchema,
});

export const subscriptionSchema = z
  .object({
    businessId: uuid,
    planCode,
    status: z.enum(["trial", "active", "past_due", "cancelled"], {
      message: "Choose a valid subscription status.",
    }),
    trialEndsOn: z.string().trim().default(""),
    periodEndsOn: z.string().trim().default(""),
    reason: reasonSchema,
  })
  .superRefine((value, ctx) => {
    if (value.status === "trial" && value.trialEndsOn === "") {
      ctx.addIssue({
        code: "custom",
        path: ["trialEndsOn"],
        message: "A trial needs an end date.",
      });
    }
  });

export type SubscriptionInput = z.infer<typeof subscriptionSchema>;

/** Converts the validated form into RPC arguments (dates to IST end-of-day). */
export function subscriptionRpcArgs(input: SubscriptionInput) {
  return {
    p_business_id: input.businessId,
    p_plan_code: input.planCode,
    p_status: input.status,
    p_trial_ends_at: endOfDayIst(input.trialEndsOn),
    p_period_ends_at: endOfDayIst(input.periodEndsOn),
    p_reason: input.reason,
  };
}

const MAX_LIMIT = 1_000_000_000_000;

/**
 * Override form. `included` is inherit | yes | no. A blank limit inherits the
 * plan. "clear" removes the override entirely (both fields inherit).
 */
export const overrideSchema = z
  .object({
    businessId: uuid,
    featureKey,
    included: z.enum(["inherit", "yes", "no"]).default("inherit"),
    limit: z.string().trim().default(""),
    clear: z.boolean().default(false),
    reason: reasonSchema,
  })
  .superRefine((value, ctx) => {
    if (value.clear) return;
    if (value.included === "inherit" && value.limit === "") {
      ctx.addIssue({
        code: "custom",
        path: ["included"],
        message: "Choose an override, or use Clear to remove it.",
      });
    }
    if (value.limit !== "") {
      const n = Number(value.limit);
      if (!Number.isInteger(n) || n < 0 || n > MAX_LIMIT) {
        ctx.addIssue({
          code: "custom",
          path: ["limit"],
          message: "A limit must be a whole number, zero or more.",
        });
      }
    }
  });

export type OverrideInput = z.infer<typeof overrideSchema>;

export function overrideRpcArgs(input: OverrideInput) {
  if (input.clear) {
    return { p_included: null, p_limit_value: null };
  }
  return {
    p_included: input.included === "inherit" ? null : input.included === "yes",
    p_limit_value: input.limit === "" ? null : Number(input.limit),
  };
}

export interface PlanFeatureInput {
  feature_key: string;
  included: boolean;
  limit_value: number | null;
}

/**
 * Plan form fields come as `included__<key>` (checkbox) and `limit__<key>` (text).
 * The feature keys come from the form itself, so an unknown key reaches the
 * database and is refused there.
 */
export function parsePlanFeatures(formData: FormData): PlanFeatureInput[] {
  const keys = new Set<string>();
  for (const name of formData.keys()) {
    const match = /^(?:included|limit)__([a-z_]+)$/.exec(name);
    if (match?.[1]) keys.add(match[1]);
  }
  const features: PlanFeatureInput[] = [];
  for (const key of [...keys].sort()) {
    const limitRaw = String(formData.get(`limit__${key}`) ?? "").trim();
    let limit: number | null = null;
    if (limitRaw !== "") {
      const n = Number(limitRaw);
      if (!Number.isInteger(n) || n < 0 || n > MAX_LIMIT) {
        throw new RangeError(`The limit for ${key} must be a whole number, zero or more.`);
      }
      limit = n;
    }
    features.push({
      feature_key: key,
      included: formData.get(`included__${key}`) === "on",
      limit_value: limit,
    });
  }
  return features;
}

export const planSchema = z.object({
  code: planCode,
  name: z
    .string()
    .trim()
    .min(2, "Plan name must be 2 to 60 characters.")
    .max(60, "Plan name must be 2 to 60 characters."),
  description: z.string().trim().max(300, "Keep the description under 300 characters.").default(""),
  isActive: z.boolean(),
  reason: reasonSchema,
});

export const supportReplySchema = z.object({
  ticketId: uuid,
  body: z
    .string()
    .trim()
    .min(1, "Write a reply.")
    .max(4000, "Keep the reply under 4000 characters."),
});

export const supportNoteSchema = z.object({
  ticketId: uuid,
  body: z.string().trim().min(1, "Write a note.").max(4000, "Keep the note under 4000 characters."),
});

export const supportUpdateSchema = z.object({
  ticketId: uuid,
  status: z.enum(["open", "waiting_customer", "resolved"], { message: "Choose a valid status." }),
  priority: z.enum(["normal", "urgent"], { message: "Choose a valid priority." }),
  assignToMe: z.boolean(),
});
