import { afterEach, describe, expect, it, vi } from "vitest";

/** Import a fresh module copy so the cached env never leaks between tests. */
async function loadEnv() {
  vi.resetModules();
  return import("@/lib/env");
}

describe("server environment", () => {
  afterEach(() => {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  });

  it("parses with all optional variables unset", async () => {
    const { getServerEnv } = await loadEnv();
    const env = getServerEnv();
    expect(env).toBeDefined();
    expect(["development", "test", "production"]).toContain(env.NODE_ENV);
  });

  it("requireEnv throws a helpful error for missing variables", async () => {
    const { requireEnv } = await loadEnv();
    expect(() => requireEnv(undefined, "EXAMPLE_KEY")).toThrow(/EXAMPLE_KEY/);
    expect(requireEnv("value", "EXAMPLE_KEY")).toBe("value");
  });

  it("getSupabaseEnv throws an actionable error when unconfigured", async () => {
    const { getSupabaseEnv } = await loadEnv();
    expect(() => getSupabaseEnv()).toThrow(/NEXT_PUBLIC_SUPABASE_URL/);
  });

  it("getSupabaseEnv returns url and anon key when configured", async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-key";
    const { getSupabaseEnv } = await loadEnv();
    expect(getSupabaseEnv()).toEqual({
      url: "https://example.supabase.co",
      anonKey: "anon-key",
    });
  });

  it("getSupabaseServiceEnv requires the service-role key", async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-key";
    const { getSupabaseServiceEnv } = await loadEnv();
    expect(() => getSupabaseServiceEnv()).toThrow(/SUPABASE_SERVICE_ROLE_KEY/);

    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-key";
    const fresh = await loadEnv();
    expect(fresh.getSupabaseServiceEnv()).toEqual({
      url: "https://example.supabase.co",
      serviceRoleKey: "service-key",
    });
  });
});
