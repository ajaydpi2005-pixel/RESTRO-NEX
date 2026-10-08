import { describe, expect, it } from "vitest";
import { getServerEnv, requireEnv } from "@/lib/env";

describe("server environment", () => {
  it("parses with all optional variables unset", () => {
    const env = getServerEnv();
    expect(env).toBeDefined();
    expect(["development", "test", "production"]).toContain(env.NODE_ENV);
  });

  it("requireEnv throws a helpful error for missing variables", () => {
    expect(() => requireEnv(undefined, "EXAMPLE_KEY")).toThrow(/EXAMPLE_KEY/);
    expect(requireEnv("value", "EXAMPLE_KEY")).toBe("value");
  });
});
