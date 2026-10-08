/**
 * RestroNex Phase 2 — LIVE security matrix against the hosted Supabase
 * project. Creates temporary sec-test users/tenants, runs the six attack
 * classes through real REST/JWT paths, then removes every trace.
 *
 * Usage: node scripts/live-security-matrix.mjs  (reads .env.local values
 * from process env — source it first)
 */
const BASE = process.env.NEXT_PUBLIC_SUPABASE_URL;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!BASE || !ANON || !SERVICE) {
  console.error("Missing env. Run: set -a && . ./.env.local && set +a");
  process.exit(1);
}

const sql = async (query) => {
  const r = await fetch(`https://api.supabase.com/v1/projects/${process.env.PROJECT_REF}/database/query`, {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.SUPABASE_ACCESS_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });
  const body = await r.text();
  if (!r.ok) throw new Error(`SQL endpoint ${r.status}: ${body.slice(0, 300)}`);
  return JSON.parse(body);
};

/** REST as a signed-in user: anon apikey + the user's JWT (Supabase convention). */
const rest = async (method, path, userJwt, body) => {
  const r = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      apikey: ANON,
      Authorization: `Bearer ${userJwt}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* keep text */ }
  return { status: r.status, json, text };
};

const rpc = (token, fn, args) => rest("POST", `/rest/v1/rpc/${fn}`, token, args);

const results = [];
const check = (id, ok, detail) => {
  results.push({ id, ok, detail });
  console.log(`${ok ? "✅ DENIED/SAFE" : "❌ FAILED"}  ${id}${detail ? " — " + detail : ""}`);
  if (!ok) process.exitCode = 1;
};

const ZERO = "00000000-0000-0000-0000-000000000000";
const EMAILS = ["sec-a@restro-nex.test", "sec-b@restro-nex.test", "sec-c@restro-nex.test"];
const PASSWORD = "SecTest-Phase2-!x9";

const createdUserIds = [];

try {
  // ── Setup: 3 real auth users ────────────────────────────────────────────
  for (const [i, email] of EMAILS.entries()) {
    const r = await fetch(`${BASE}/auth/v1/admin/users`, {
      method: "POST",
      headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: PASSWORD, email_confirm: true, user_metadata: { full_name: `Sec Test ${i}` } }),
    });
    const body = await r.json();
    if (!r.ok) throw new Error(`user create failed: ${r.status} ${JSON.stringify(body).slice(0, 200)}`);
    createdUserIds.push(body.id);
  }
  const [A, B, C] = createdUserIds;
  console.log(`setup: users created (${createdUserIds.join(", ")})`);

  // ── Setup: tenants/outlets/memberships via privileged SQL ───────────────
  await sql(`
    insert into public.businesses (id, name, slug) values
      ('11111111-1111-4111-8111-111111111111', 'Sec Tenant A', 'sec-tenant-a'),
      ('22222222-2222-4222-8222-222222222222', 'Sec Tenant B', 'sec-tenant-b');
    insert into public.outlets (id, business_id, name, slug, currency_code) values
      ('33333333-3333-4333-8333-333333333331', '11111111-1111-4111-8111-111111111111', 'Sec A Outlet 1', 'sec-a-outlet-1', 'INR'),
      ('33333333-3333-4333-8333-333333333332', '11111111-1111-4111-8111-111111111111', 'Sec A Outlet 2', 'sec-a-outlet-2', 'INR'),
      ('44444444-4444-4444-8444-444444444441', '22222222-2222-4222-8222-222222222222', 'Sec B Outlet 1', 'sec-b-outlet-1', 'INR');
    insert into public.memberships (user_id, business_id, role) values
      ('${A}', '11111111-1111-4111-8111-111111111111', 'owner'),
      ('${B}', '22222222-2222-4222-8222-222222222222', 'owner'),
      ('${C}', '11111111-1111-4111-8111-111111111111', 'waiter');
  `);
  console.log("setup: tenants, outlets, memberships created");

  // ── Sign in: real JWTs via password grant ──────────────────────────────
  const tokens = {};
  for (const [name, email] of [["A", EMAILS[0]], ["B", EMAILS[1]], ["C", EMAILS[2]]]) {
    const r = await fetch(`${BASE}/auth/v1/token?grant_type=password`, {
      method: "POST",
      headers: { apikey: ANON, "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: PASSWORD }),
    });
    const body = await r.json();
    if (!body.access_token) throw new Error(`sign-in failed for ${email}: ${JSON.stringify(body).slice(0, 200)}`);
    tokens[name] = body.access_token;
  }
  console.log("setup: all three users signed in with real JWTs\n");

  const TENANT_B = "22222222-2222-4222-8222-222222222222";
  const A_OUT1 = "33333333-3333-4333-8333-333333333331";
  const A_OUT2 = "33333333-3333-4333-8333-333333333332";
  const B_OUT1 = "44444444-4444-4444-8444-444444444441";

  // ── TEST 1: Tenant A reading Tenant B ───────────────────────────────────
  let r1 = await rest("GET", `/rest/v1/businesses?slug=eq.sec-tenant-b&select=id,name`, tokens.A);
  const t1a = r1.status === 200 && Array.isArray(r1.json) && r1.json.length === 0;
  let r2 = await rest("GET", `/rest/v1/outlets?business_id=eq.${TENANT_B}&select=id`, tokens.A);
  const t1b = r2.status === 200 && Array.isArray(r2.json) && r2.json.length === 0;
  let r3 = await rest("GET", `/rest/v1/memberships?business_id=eq.${TENANT_B}&select=id,role`, tokens.A);
  const t1c = r3.status === 200 && Array.isArray(r3.json) && r3.json.length === 0;
  let r4 = await rpc(tokens.A, "has_business_access", { p_business_id: TENANT_B });
  const t1d = r4.status === 200 && r4.json === false;
  check("T1 Tenant A reading Tenant B", t1a && t1b && t1c && t1d,
    `businesses:${r1.json?.length} outlets:${r2.json?.length} memberships:${r3.json?.length} rpc:${JSON.stringify(r4.json)}`);

  // ── TEST 2: Tenant A modifying Tenant B ─────────────────────────────────
  let w1 = await rest("PATCH", `/rest/v1/businesses?id=eq.${TENANT_B}`, tokens.A, { name: "pwned" });
  const t2a = w1.status === 200 && Array.isArray(w1.json) && w1.json.length === 0;
  let w2 = await rest("POST", `/rest/v1/outlets`, tokens.A, { business_id: TENANT_B, name: "rogue", slug: "rogue", currency_code: "INR" });
  const t2b = w2.status >= 400;
  let w3 = await rest("POST", `/rest/v1/memberships`, tokens.A, { user_id: A, business_id: TENANT_B, role: "owner" });
  const t2c = w3.status >= 400;
  let w4 = await rest("DELETE", `/rest/v1/businesses?id=eq.${TENANT_B}`, tokens.A);
  const t2d = w4.status === 200 && Array.isArray(w4.json) && w4.json.length === 0;
  check("T2 Tenant A modifying Tenant B", t2a && t2b && t2c && t2d,
    `patch:${w1.status}/${w1.json?.length} insertOutlet:${w2.status} insertMembership:${w3.status} delete:${w4.status}`);

  // ── TEST 3: unauthorised outlet access ─────────────────────────────────
  let o1 = await rpc(tokens.C, "has_outlet_access", { p_outlet_id: A_OUT2 });
  let o2 = await rpc(tokens.C, "accessible_outlet_ids", {});
  const t3a = o1.status === 200 && o1.json === false && Array.isArray(o2.json) && o2.json.length === 0;
  let o3 = await rpc(tokens.B, "has_outlet_access", { p_outlet_id: A_OUT1 });
  let o4 = await rpc(tokens.B, "has_outlet_access", { p_outlet_id: B_OUT1 });
  const t3b = o3.json === false && o4.json === true; // owner of B: blocked from A, allowed own
  check("T3 unauthorised outlet access", t3a && t3b,
    `waiter-ungranted:${o1.json} waiter-set:${JSON.stringify(o2.json)} ownerB→A-outlet:${o3.json} ownerB→own:${o4.json}`);

  // ── TEST 4: invalid tenant IDs ─────────────────────────────────────────
  let i1 = await rpc(tokens.A, "has_business_access", { p_business_id: ZERO });
  let i2 = await rpc(tokens.A, "has_outlet_access", { p_outlet_id: ZERO });
  let i3 = await rest("GET", `/rest/v1/businesses?id=eq.${ZERO}&select=id`, tokens.A);
  check("T4 invalid tenant IDs", i1.json === false && i2.json === false && i3.json?.length === 0,
    `business:${i1.json} outlet:${i2.json} rows:${i3.json?.length}`);

  // ── TEST 5: forged request parameters ──────────────────────────────────
  let f1 = await rest("PATCH", `/rest/v1/memberships?user_id=eq.${C}`, tokens.C, { business_id: TENANT_B });
  const t5a = f1.status >= 400 && /immutable|42501|row-level/i.test(f1.text);
  let f2 = await rest("PATCH", `/rest/v1/memberships?user_id=eq.${C}`, tokens.C, { role: "owner" });
  const t5b = f2.status >= 400 && /immutable|42501|row-level/i.test(f2.text);
  let f3 = await rest("PATCH", `/rest/v1/memberships?user_id=eq.${C}`, tokens.C, { status: "deactivated" });
  const t5c = f3.status === 200 && f3.json?.length === 1;
  await rest("PATCH", `/rest/v1/memberships?user_id=eq.${C}`, tokens.C, { status: "active" });
  check("T5 forged request parameters", t5a && t5b && t5c,
    `re-point:${f1.status} escalation:${f2.status} legit-status-update:${f3.status}`);

  // ── TEST 6: direct database queries attempting cross-tenant access ─────
  // PostgREST-equivalent: SET LOCAL role + JWT claims inside one transaction.
  // Claims live in a DO block so the statement of interest is the ONLY
  // row-returning statement (the endpoint returns the last result set).
  const claimsB = JSON.stringify({ sub: B, role: "authenticated" });
  const direct = async (stmt) =>
    sql(
      `begin; set local role authenticated; do $x$ begin perform set_config('request.jwt.claims', '${claimsB}', true); end $x$; ${stmt} commit;`,
    );

  const d1 = await direct(`select count(*)::int as n from public.businesses where slug = 'sec-tenant-a';`);
  const d2 = await direct(`update public.businesses set name = 'pwned' where slug = 'sec-tenant-a' returning 1;`);
  const d3 = await direct(`select count(*)::int as n from public.user_profiles where id = '${A}';`);
  let d4 = "allowed";
  try {
    await direct(`select * from platform.super_admins;`);
  } catch { d4 = "denied"; }
  // Read back the attack target as postgres: name must NOT be 'pwned'.
  const d5 = await sql(`select name from public.businesses where slug = 'sec-tenant-a';`);
  check("T6 direct DB cross-tenant queries",
    d1[0]?.n === 0 && d2.length === 0 && d3[0]?.n === 0 && d4 === "denied" && d5[0]?.name === "Sec Tenant A",
    `read-A:${d1[0]?.n} update-A-rows:${d2.length} profile-A:${d3[0]?.n} platform:${d4} readback:"${d5[0]?.name}"`);

} finally {
  // ── Cleanup: remove every sec-test trace ────────────────────────────────
  try {
    await sql(`
      delete from public.membership_outlets where membership_id in
        (select id from public.memberships where business_id in
          (select id from public.businesses where slug like 'sec-tenant-%'));
      delete from public.memberships where business_id in
        (select id from public.businesses where slug like 'sec-tenant-%');
      delete from public.outlets where business_id in
        (select id from public.businesses where slug like 'sec-tenant-%');
      delete from public.business_settings where business_id in
        (select id from public.businesses where slug like 'sec-tenant-%');
      delete from public.businesses where slug like 'sec-tenant-%';
    `);
    for (const id of createdUserIds) {
      await fetch(`${BASE}/auth/v1/admin/users/${id}`, {
        method: "DELETE",
        headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` },
      });
    }
    const leftover = await sql(`
      select (select count(*) from public.businesses where slug like 'sec-tenant-%')
           + (select count(*) from public.outlets where slug like 'sec-%')
           + (select count(*) from public.memberships where user_id in ('${createdUserIds.join("','") || "x"}')) as n;
    `);
    console.log(`\ncleanup: complete — leftover rows: ${leftover[0]?.n}`);
  } catch (e) {
    console.error("cleanup error:", e.message);
  }
}

const failed = results.filter((r) => !r.ok).length;
console.log(failed === 0
  ? "\n✅ LIVE SECURITY MATRIX: ALL 6 ATTACK CLASSES DENIED ON THE HOSTED PROJECT"
  : `\n❌ ${failed} check(s) failed`);
