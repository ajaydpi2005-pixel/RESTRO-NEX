import { describe, expect, it } from "vitest";
import {
  businessStatusSchema,
  isUuid,
  operatorGrantSchema,
  overrideRpcArgs,
  overrideSchema,
  parsePlanFeatures,
  planSchema,
  reasonSchema,
  subscriptionRpcArgs,
  subscriptionSchema,
  supportReplySchema,
  supportUpdateSchema,
} from "./schemas";

const BIZ = "cccccccc-0000-4000-8000-000000000001";

function form(entries: Record<string, string>): FormData {
  const data = new FormData();
  for (const [k, v] of Object.entries(entries)) data.set(k, v);
  return data;
}

describe("isUuid", () => {
  it("accepts a UUID and rejects anything else", () => {
    expect(isUuid(BIZ)).toBe(true);
    expect(isUuid("not-a-uuid")).toBe(false);
    expect(isUuid("")).toBe(false);
    expect(isUuid(`${BIZ}; drop table x`)).toBe(false);
  });
});

describe("reason", () => {
  it("requires 3 to 300 characters", () => {
    expect(reasonSchema.safeParse("ab").success).toBe(false);
    expect(reasonSchema.safeParse("  okay  ").success).toBe(true);
    expect(reasonSchema.safeParse("  ok  ").success).toBe(false);
    expect(reasonSchema.safeParse("x".repeat(301)).success).toBe(false);
  });
});

describe("operator grant", () => {
  it("normalises the email and accepts a known role", () => {
    const parsed = operatorGrantSchema.parse({
      email: " Ops@Example.com ",
      role: "support",
      reason: "New hire",
    });
    expect(parsed.email).toBe("ops@example.com");
  });

  it("rejects an unknown role and a bad email", () => {
    expect(
      operatorGrantSchema.safeParse({ email: "a@b.co", role: "owner", reason: "x y" }).success,
    ).toBe(false);
    expect(
      operatorGrantSchema.safeParse({ email: "nope", role: "support", reason: "x y" }).success,
    ).toBe(false);
  });
});

describe("business status", () => {
  it("allows only active or suspended from the operator form", () => {
    const base = { businessId: BIZ, reason: "Non-payment review" };
    expect(businessStatusSchema.safeParse({ ...base, status: "suspended" }).success).toBe(true);
    expect(businessStatusSchema.safeParse({ ...base, status: "active" }).success).toBe(true);
    expect(businessStatusSchema.safeParse({ ...base, status: "closed" }).success).toBe(false);
  });
});

describe("subscriptions", () => {
  const base = { businessId: BIZ, reason: "Trial extended" };

  it("requires a trial end date for a trial", () => {
    const result = subscriptionSchema.safeParse({
      ...base,
      planCode: "GROWTH",
      status: "trial",
      trialEndsOn: "",
    });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0]?.path).toEqual(["trialEndsOn"]);
  });

  it("uppercases the plan code and converts dates to IST end of day", () => {
    const parsed = subscriptionSchema.parse({
      ...base,
      planCode: "growth",
      status: "trial",
      trialEndsOn: "2026-10-29",
      periodEndsOn: "",
    });
    expect(parsed.planCode).toBe("GROWTH");
    expect(subscriptionRpcArgs(parsed)).toEqual({
      p_business_id: BIZ,
      p_plan_code: "GROWTH",
      p_status: "trial",
      p_trial_ends_at: "2026-10-29T23:59:59+05:30",
      p_period_ends_at: null,
      p_reason: "Trial extended",
    });
  });

  it("allows an active subscription without dates", () => {
    expect(
      subscriptionSchema.safeParse({ ...base, planCode: "SCALE", status: "active" }).success,
    ).toBe(true);
  });

  it("rejects an unknown status", () => {
    expect(
      subscriptionSchema.safeParse({ ...base, planCode: "SCALE", status: "paid" }).success,
    ).toBe(false);
  });
});

describe("entitlement overrides", () => {
  const base = { businessId: BIZ, featureKey: "outlets", reason: "Pilot site" };

  it("refuses an override that sets nothing", () => {
    expect(overrideSchema.safeParse({ ...base, included: "inherit", limit: "" }).success).toBe(
      false,
    );
  });

  it("allows clearing an override with a reason", () => {
    const parsed = overrideSchema.parse({ ...base, clear: true });
    expect(overrideRpcArgs(parsed)).toEqual({ p_included: null, p_limit_value: null });
  });

  it("maps yes and a whole-number limit to the RPC arguments", () => {
    const parsed = overrideSchema.parse({ ...base, included: "yes", limit: "5" });
    expect(overrideRpcArgs(parsed)).toEqual({ p_included: true, p_limit_value: 5 });
  });

  it("maps inherit to null so the plan applies", () => {
    const parsed = overrideSchema.parse({ ...base, included: "inherit", limit: "7" });
    expect(overrideRpcArgs(parsed)).toEqual({ p_included: null, p_limit_value: 7 });
  });

  it("rejects fractional, negative and oversized limits", () => {
    for (const limit of ["1.5", "-1", "1e3x", "9999999999999999"]) {
      expect(overrideSchema.safeParse({ ...base, included: "yes", limit }).success, limit).toBe(
        false,
      );
    }
  });
});

describe("plan features from the form", () => {
  it("reads checkboxes and limits, sorted by key, blank limit as null", () => {
    const features = parsePlanFeatures(
      form({
        included__online_ordering: "on",
        limit__outlets: "3",
        included__outlets: "on",
        limit__staff: "",
        included__staff: "on",
      }),
    );
    expect(features).toEqual([
      { feature_key: "online_ordering", included: true, limit_value: null },
      { feature_key: "outlets", included: true, limit_value: 3 },
      { feature_key: "staff", included: true, limit_value: null },
    ]);
  });

  it("treats an unticked box as off", () => {
    const features = parsePlanFeatures(form({ limit__outlets: "1" }));
    expect(features).toEqual([{ feature_key: "outlets", included: false, limit_value: 1 }]);
  });

  it("refuses a limit that is not a whole number", () => {
    expect(() => parsePlanFeatures(form({ limit__outlets: "two" }))).toThrow(RangeError);
    expect(() => parsePlanFeatures(form({ limit__outlets: "2.5" }))).toThrow(RangeError);
  });
});

describe("plan save", () => {
  it("validates the code shape and name length", () => {
    const base = { name: "Growth", description: "", isActive: true, reason: "Price update" };
    expect(planSchema.safeParse({ ...base, code: "GROWTH" }).success).toBe(true);
    expect(planSchema.safeParse({ ...base, code: "1BAD" }).success).toBe(false);
    expect(planSchema.safeParse({ ...base, code: "GROWTH", name: "G" }).success).toBe(false);
  });
});

describe("support operator input", () => {
  const ticket = "dddddddd-0000-4000-8000-000000000002";

  it("requires a non-empty reply", () => {
    expect(supportReplySchema.safeParse({ ticketId: ticket, body: "   " }).success).toBe(false);
    expect(supportReplySchema.safeParse({ ticketId: ticket, body: "On it." }).success).toBe(true);
  });

  it("accepts only the defined statuses and priorities", () => {
    const base = { ticketId: ticket, assignToMe: true };
    expect(
      supportUpdateSchema.safeParse({ ...base, status: "resolved", priority: "urgent" }).success,
    ).toBe(true);
    expect(
      supportUpdateSchema.safeParse({ ...base, status: "closed", priority: "urgent" }).success,
    ).toBe(false);
    expect(
      supportUpdateSchema.safeParse({ ...base, status: "open", priority: "high" }).success,
    ).toBe(false);
  });
});
