import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Structural guards for the Phase 1 database foundation. Behavioural
 * verification (applying migrations + RLS assertions against a real
 * PostgreSQL) lives in scripts/verify-db.sh (`npm run db:verify`).
 */
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const migrationsDir = resolve(repoRoot, "supabase", "migrations");
const files = existsSync(migrationsDir)
  ? readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort()
  : [];
const read = (name: string) => readFileSync(resolve(migrationsDir, name), "utf8");
const all = () => files.map(read).join("\n");

describe("supabase migrations", () => {
  it("exist and follow the timestamped naming convention", () => {
    expect(files.length).toBeGreaterThanOrEqual(7);
    for (const file of files) {
      expect(file).toMatch(/^\d{14}_[a-z0-9_]+\.sql$/);
    }
  });

  it("create the tenancy core tables", () => {
    const sql = all();
    for (const table of [
      "public.businesses",
      "public.outlets",
      "public.business_settings",
      "public.outlet_settings",
      "public.user_profiles",
      "public.memberships",
    ]) {
      expect(sql).toContain(`create table ${table}`);
    }
  });

  it("enable RLS on every tenant table", () => {
    const sql = all();
    for (const table of [
      "businesses",
      "outlets",
      "business_settings",
      "outlet_settings",
      "user_profiles",
      "memberships",
    ]) {
      expect(sql).toContain(`alter table public.${table} enable row level security`);
    }
  });

  it("lock the platform schema away from tenant-facing roles", () => {
    const sql = all();
    expect(sql).toContain("create schema if not exists platform");
    expect(sql).toContain("revoke all on schema platform from anon");
    expect(sql).toContain("revoke all on schema platform from authenticated");
    expect(sql).toContain("grant usage on schema platform to service_role");
  });

  it("never disables RLS as a workaround", () => {
    expect(all().toLowerCase()).not.toContain("disable row level security");
    expect(all().toLowerCase()).not.toContain("bypassrls for authenticated");
  });

  it("defines membership-based access policies", () => {
    const sql = all();
    expect(sql).toContain("function public.has_business_access");
    expect(sql).toContain("security definer");
    expect(sql).toContain("business_select_member");
    expect(sql).toContain("auth.uid()");
  });

  it("creates the storage foundation buckets", () => {
    const sql = all();
    expect(sql).toContain("insert into storage.buckets");
    expect(sql).toContain("menu-media");
    expect(sql).toContain("business-assets");
  });

  it("adds outlet-level access control (Phase 2)", () => {
    const sql = all();
    expect(sql).toContain("create table public.membership_outlets");
    expect(sql).toContain("alter table public.membership_outlets enable row level security");
    expect(sql).toContain("function public.has_outlet_access");
    expect(sql).toContain("function public.accessible_outlet_ids");
  });

  it("keeps outlet grants free of client-writable policies", () => {
    const sql = all();
    // Only the SELECT policy may reference the grants table.
    expect(sql).toContain("membership_outlets_select_member");
    expect(sql).not.toMatch(/on public\.membership_outlets for (insert|update|delete)/);
  });
});

describe("development seed", () => {
  it("seeds exactly the four subscription plans — no fake business data", () => {
    const seed = readFileSync(resolve(repoRoot, "supabase", "seed.sql"), "utf8");
    for (const plan of ["STARTER", "GROWTH", "SCALE", "ENTERPRISE"]) {
      expect(seed).toContain(plan);
    }
    expect(seed.toLowerCase()).not.toContain("insert into public.businesses");
    expect(seed.toLowerCase()).not.toContain("insert into public.outlets");
  });
});
