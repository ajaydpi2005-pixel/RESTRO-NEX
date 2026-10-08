import { describe, expect, it } from "vitest";
import {
  changePasswordSchema,
  forgotPasswordSchema,
  passwordSchema,
  resetPasswordSchema,
  sanitizeNext,
  signInSchema,
  signUpSchema,
} from "@/modules/auth/schemas";

describe("passwordSchema", () => {
  it("accepts compliant passwords", () => {
    expect(passwordSchema.safeParse("restro123").success).toBe(true);
    expect(passwordSchema.safeParse("A1b2C3d4").success).toBe(true);
  });

  it("enforces length, letters and numbers", () => {
    expect(passwordSchema.safeParse("ab1").success).toBe(false); // too short
    expect(passwordSchema.safeParse("abcdefgh").success).toBe(false); // no number
    expect(passwordSchema.safeParse("12345678").success).toBe(false); // no letter
    expect(passwordSchema.safeParse("a".repeat(73) + "1").success).toBe(false); // too long
  });
});

describe("signUpSchema", () => {
  const valid = {
    fullName: "Alex Fernandez",
    email: "alex@example.com",
    password: "restro123",
    confirm: "restro123",
  };

  it("accepts a valid registration", () => {
    expect(signUpSchema.safeParse(valid).success).toBe(true);
  });

  it("accepts an empty full name (optional)", () => {
    expect(signUpSchema.safeParse({ ...valid, fullName: "" }).success).toBe(true);
  });

  it("rejects mismatched passwords", () => {
    const result = signUpSchema.safeParse({ ...valid, confirm: "different9" });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.join(".") === "confirm")).toBe(true);
    }
  });

  it("rejects malformed emails and weak passwords", () => {
    expect(signUpSchema.safeParse({ ...valid, email: "not-an-email" }).success).toBe(false);
    expect(signUpSchema.safeParse({ ...valid, password: "short", confirm: "short" }).success).toBe(
      false,
    );
  });
});

describe("signInSchema / forgotPasswordSchema", () => {
  it("requires email and a non-empty password", () => {
    expect(signInSchema.safeParse({ email: "a@b.co", password: "x" }).success).toBe(true);
    expect(signInSchema.safeParse({ email: "a@b.co", password: "" }).success).toBe(false);
    expect(signInSchema.safeParse({ email: "nope", password: "x" }).success).toBe(false);
  });

  it("validates the recovery email", () => {
    expect(forgotPasswordSchema.safeParse({ email: "a@b.co" }).success).toBe(true);
    expect(forgotPasswordSchema.safeParse({ email: "" }).success).toBe(false);
  });
});

describe("resetPasswordSchema / changePasswordSchema", () => {
  it("requires matching compliant passwords", () => {
    expect(
      resetPasswordSchema.safeParse({ password: "newpass99", confirm: "newpass99" }).success,
    ).toBe(true);
    expect(
      resetPasswordSchema.safeParse({ password: "newpass99", confirm: "mismatch1" }).success,
    ).toBe(false);
    expect(
      changePasswordSchema.safeParse({
        current: "old12345x",
        password: "newpass99",
        confirm: "newpass99",
      }).success,
    ).toBe(true);
    expect(
      changePasswordSchema.safeParse({ current: "", password: "newpass99", confirm: "newpass99" })
        .success,
    ).toBe(false);
  });
});

describe("sanitizeNext (open-redirect guard)", () => {
  it("keeps safe internal paths", () => {
    expect(sanitizeNext("/dashboard")).toBe("/dashboard");
    expect(sanitizeNext("/pos")).toBe("/pos");
  });

  it("neutralises protocol-relative, absolute and empty values", () => {
    expect(sanitizeNext("//evil.com")).toBe("/dashboard");
    expect(sanitizeNext("/\\evil.com")).toBe("/dashboard");
    expect(sanitizeNext("https://evil.com")).toBe("/dashboard");
    expect(sanitizeNext(null)).toBe("/dashboard");
    expect(sanitizeNext(undefined)).toBe("/dashboard");
    expect(sanitizeNext("")).toBe("/dashboard");
  });
});
