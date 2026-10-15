import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Static guard for the Super Admin area. These checks read the source, so a
 * future edit that drops a server-side check fails the build, even if the
 * route still renders in the browser.
 */

const ROOT = process.cwd();
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

const relPath = (full: string) => relative(ROOT, full).split(sep).join("/");

const ADMIN_APP = join(ROOT, "src/app/admin");
const ADMIN_MODULE = join(ROOT, "src/modules/admin");
const SUPPORT_MODULE = join(ROOT, "src/modules/support");
const MIGRATION = "supabase/migrations/20261017100000_super_admin.sql";

/** Splits a module into the chunks that begin with "export async function". */
function exportedActions(source: string): { name: string; body: string }[] {
  const parts = source.split(/\nexport async function /).slice(1);
  return parts.map((part) => ({
    name: part.slice(0, part.indexOf("(")),
    body: part,
  }));
}

describe("Super Admin routes", () => {
  const pages = walk(ADMIN_APP)
    .filter((f) => f.endsWith("page.tsx"))
    .map(relPath);

  it("keeps the operator guard layout in place", () => {
    const layout = read("src/app/admin/(guarded)/layout.tsx");
    expect(layout).toContain("getOperatorState()");
    expect(layout).toContain("decideAdminAccess(state)");
    expect(layout).toContain("notFound()");
    expect(layout).toContain('redirect("/admin/sign-in")');
  });

  it("places every page except sign-in under the guarded group", () => {
    const unguarded = pages.filter(
      (p) => !p.includes("/(guarded)/") && p !== "src/app/admin/sign-in/page.tsx",
    );
    expect(unguarded).toEqual([]);
  });

  it("makes every page check the operator permission itself", () => {
    // The sign-in page is public by design and holds no data.
    for (const page of pages.filter((p) => !p.endsWith("/sign-in/page.tsx"))) {
      expect(read(page), page).toMatch(/requireOperator\(\s*"[a-z]+"\s*\)/);
    }
  });

  it("keeps the sign-in page free of data loaders", () => {
    const signIn = read("src/app/admin/sign-in/page.tsx");
    expect(signIn).not.toMatch(/adminRpc|loadX|queries"/);
    expect(signIn).toContain('redirect("/admin")');
  });

  it("does not show a number that is hard-coded in the source", () => {
    for (const page of pages) {
      expect(read(page), page).not.toMatch(/value=\{\s*\d/);
    }
    const allAdminPages = walk(ADMIN_MODULE)
      .filter((f) => f.endsWith(".tsx"))
      .map(relPath);
    for (const file of allAdminPages) {
      expect(read(file), file).not.toMatch(/value=\{\s*\d/);
    }
  });

  it("never claims an unmeasured figure is zero", () => {
    expect(read("src/app/admin/(guarded)/health/page.tsx")).toContain("Not measured");
    expect(read("src/app/admin/(guarded)/page.tsx")).toContain("Not measured");
  });
});

describe("Super Admin server actions", () => {
  it("runs requireOperator in every exported action", () => {
    const source = read("src/modules/admin/actions.ts");
    const actions = exportedActions(source);
    expect(actions.length).toBeGreaterThanOrEqual(10);
    for (const action of actions) {
      expect(action.body, action.name).toContain("requireOperator(");
    }
  });

  it("gives every action a single permission it names", () => {
    const source = read("src/modules/admin/actions.ts");
    for (const action of exportedActions(source)) {
      const perm = action.body.match(/requireOperator\("([a-z]+)"\)/);
      expect(perm, action.name).not.toBeNull();
    }
  });

  it('exports only async functions from the "use server" module', () => {
    for (const rel of [
      "src/modules/admin/actions.ts",
      "src/modules/admin/auth-actions.ts",
      "src/modules/support/actions.ts",
    ]) {
      const source = read(rel);
      expect(source.startsWith('"use server"'), rel).toBe(true);
      const exports = [
        ...source.matchAll(/^export (?!async function|type |interface )(\w+)/gm),
      ].map((m) => m[1]);
      expect(exports, rel).toEqual([]);
    }
  });

  it("checks the operator role in sign-in before any admin area is shown", () => {
    const source = read("src/modules/admin/auth-actions.ts");
    expect(source).toContain('adminRpc<{ role: string } | null>("admin_operator_context"');
    expect(source).toContain("supabase.auth.signOut()");
  });

  it("gives every tenant support action the verified session user", () => {
    for (const action of exportedActions(read("src/modules/support/actions.ts"))) {
      expect(action.body, action.name).toContain("getSessionUserId()");
    }
  });
});

describe("database guarantees the TypeScript layer depends on", () => {
  const sql = read(MIGRATION);
  const functionBodies = (prefix: string) =>
    sql
      .split(/(?=create or replace function )/)
      .filter((chunk) => chunk.startsWith(`create or replace function public.${prefix}`));

  it("checks the operator permission inside every admin_* function", () => {
    // Documented exemption: admin_operator_context answers "what operator role,
    // if any, does this user id hold?" It is called before anyone is known to be
    // an operator, with the verified session user's id, and it is executable by
    // the service role only (see the grants test in assertions-phase19.sql, P19.15).
    const EXEMPT = new Set(["admin_operator_context"]);
    const bodies = functionBodies("admin_");
    expect(bodies.length).toBeGreaterThan(20);
    for (const body of bodies) {
      const name = body.match(/public\.(\w+)/)?.[1] ?? "";
      if (EXEMPT.has(name)) continue;
      expect(body, name).toContain("platform.require_operator(");
    }
  });

  it("checks business membership inside every support_* function", () => {
    const bodies = functionBodies("support_");
    expect(bodies.length).toBe(3);
    for (const body of bodies) {
      expect(body, body.slice(0, 80)).toContain("require_business_actor_permission(");
    }
  });

  it("only uses RPC names that exist in the migration", () => {
    const defined = new Set(
      [...sql.matchAll(/create or replace function public\.(\w+)\(/g)].map((m) => m[1]),
    );
    const used = new Set<string>();
    for (const file of [...walk(ADMIN_MODULE), ...walk(SUPPORT_MODULE)]) {
      if (!file.endsWith(".ts") && !file.endsWith(".tsx")) continue;
      for (const m of readFileSync(file, "utf8").matchAll(/adminRpc(?:<[^>]*>)?\(\s*"(\w+)"/g)) {
        used.add(m[1] as string);
      }
    }
    expect(used.size).toBeGreaterThan(15);
    for (const name of used) expect(defined.has(name), name).toBe(true);
  });

  it("stores operator-only tables in the platform schema with RLS on", () => {
    const allSql = read("supabase/migrations/20261008000002_platform_schema.sql") + sql;
    for (const table of [
      "super_admins",
      "admin_audit_logs",
      "business_subscriptions",
      "business_feature_overrides",
      "support_tickets",
      "support_ticket_messages",
      "feature_catalog",
    ]) {
      expect(allSql, table).toContain(`alter table platform.${table} enable row level security`);
    }
  });
});

describe("module boundaries", () => {
  it("never imports the server-only package, which this project does not install", () => {
    for (const file of [...walk(ADMIN_MODULE), ...walk(SUPPORT_MODULE), ...walk(ADMIN_APP)]) {
      if (!/\.(ts|tsx)$/.test(file) || file.endsWith("guard.test.ts")) continue;
      expect(readFileSync(file, "utf8"), relPath(file)).not.toContain('from "server-only"');
    }
  });

  it("keeps the service-role client out of client components", () => {
    const files = [
      ...walk(ADMIN_MODULE),
      ...walk(SUPPORT_MODULE),
      join(ROOT, "src/components/forms"),
    ];
    for (const file of files) {
      if (!/\.(ts|tsx)$/.test(file)) continue;
      const source = readFileSync(file, "utf8");
      if (!source.startsWith('"use client"')) continue;
      expect(source, relPath(file)).not.toMatch(/supabase\/admin|\/rpc"|\/session"|\/queries"/);
    }
  });

  it("does not show a /admin link on the public site", () => {
    expect(read("src/components/site/site-footer.tsx")).not.toContain('"/admin"');
  });

  it("retires the placeholder platform routes", () => {
    expect(existsSync(join(ROOT, "src/app/(platform)"))).toBe(false);
  });

  it("sends /admin requests through the proxy", () => {
    const proxy = read("src/proxy.ts");
    expect(proxy).toContain('"/admin/:path*"');
    expect(proxy).toContain('ADMIN_SIGN_IN = "/admin/sign-in"');
  });
});
