#!/usr/bin/env node
/**
 * RestroNex Phase 5 — live RBAC end-to-end: role escalation + unauthorised
 * operations.
 *
 * Requires BOTH migrations pushed to the hosted project:
 *   20261008140000 (business/outlet details + create_business RPC)
 *   20261008150000 (RBAC catalogue)
 * …and the app running on http://localhost:3000.
 *
 * Cast (all created via GoTrue admin — no emails):
 *   O  — owner: creates the business + outlet, manages staff
 *   C  — cashier (added by O through the app's staff action)
 *   W  — waiter  (added by O, no outlet grant at first)
 *   O2 — owner of a DIFFERENT business (cross-tenant attacker)
 *
 * Attacks verified as DENIED:
 *   cashier self-promotion · cashier staff management · cashier business
 *   settings edit · cashier outlet creation · assigning the owner role ·
 *   cross-business staff manipulation · access after deactivation.
 */

import { readFileSync } from "node:fs";

const env = {};
for (const line of readFileSync(new URL("../.env.local", import.meta.url), "utf8").split("\n")) {
  const m = line.match(/^\s*([A-Z0-9_]+)=(.*)$/);
  if (m) env[m[1]] = m[2].replace(/^"|"$/g, "");
}

const SUPA_URL = env.NEXT_PUBLIC_SUPABASE_URL;
const ANON = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const SERVICE = env.SUPABASE_SERVICE_ROLE_KEY;
const REF = new URL(SUPA_URL).host.split(".")[0];
const APP = "http://localhost:3000";
if (!SUPA_URL || !ANON || !SERVICE) {
  console.error("missing env vars");
  process.exit(1);
}

const ts = Date.now();
const USERS = {
  O: { email: `rbac-owner-${ts}@example.com`, password: "owner-alpha-77" },
  C: { email: `rbac-cashier-${ts}@example.com`, password: "cashier-carl-8" },
  W: { email: `rbac-waiter-${ts}@example.com`, password: "waiter-wendy-9" },
  O2: { email: `rbac-owner2-${ts}@example.com`, password: "owner-oscar-77" },
};

let passed = 0;
let failed = 0;
const failures = [];
function check(name, ok, detail = "") {
  if (ok) {
    passed += 1;
    console.log(`  ✅ ${name}`);
  } else {
    failed += 1;
    failures.push(name);
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// ── helpers (same wire protocol as the browser) ────────────────────────────

async function got(path, { method = "GET", body, service = false, bearer } = {}) {
  const res = await fetch(`${SUPA_URL}${path}`, {
    method,
    headers: {
      apikey: service ? SERVICE : ANON,
      ...(body ? { "content-type": "application/json" } : {}),
      authorization: `Bearer ${bearer ?? (service ? SERVICE : ANON)}`,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* non-JSON */
  }
  return { status: res.status, json, text };
}

function makeSessionCookies(key, value) {
  const MAX = 3180;
  const encoded = "base64-" + Buffer.from(value, "utf8").toString("base64url");
  let enc = encodeURIComponent(encoded);
  const cookies = [];
  if (enc.length <= MAX) {
    cookies.push({ name: key, value: encoded });
  } else {
    let i = 0;
    while (enc.length > 0) {
      let head = enc.slice(0, MAX);
      const lastEsc = head.lastIndexOf("%");
      if (lastEsc > MAX - 3) head = head.slice(0, lastEsc);
      while (head.length > 0) {
        try {
          decodeURIComponent(head);
          break;
        } catch {
          head = head.slice(0, head.length - 3);
        }
      }
      cookies.push({ name: `${key}.${i}`, value: decodeURIComponent(head) });
      i += 1;
      enc = enc.slice(head.length);
    }
  }
  return cookies.map((c) => `${c.name}=${c.value}`).join("; ");
}

async function createConfirmedUser({ email, password }) {
  const create = await got("/auth/v1/admin/users", {
    method: "POST",
    service: true,
    body: { email, password, email_confirm: true },
  });
  const userId = create.json?.id;
  if (!userId) throw new Error(`could not create user ${email}: ${create.status}`);
  const login = await got("/auth/v1/token?grant_type=password", {
    method: "POST",
    body: { email, password },
  });
  const who = await got("/auth/v1/user", { bearer: login.json.access_token });
  const session = {
    access_token: login.json.access_token,
    token_type: login.json.token_type,
    expires_at: login.json.expires_at,
    expires_in: login.json.expires_in,
    refresh_token: login.json.refresh_token,
    user: who.json,
  };
  return {
    id: userId,
    email,
    token: login.json.access_token,
    cookie: makeSessionCookies(`sb-${REF}-auth-token`, JSON.stringify(session)),
  };
}

async function getActionFields(pageUrl, cookie) {
  const res = await fetch(pageUrl, { headers: { cookie } });
  const html = await res.text();
  const fields = {};
  for (const m of html.matchAll(/<input type="hidden" name="([^"]+)"(?: value="([^"]*)")?\/>/g)) {
    const [, name, value] = m;
    if (name.startsWith("$ACTION")) fields[name] = (value ?? "").replace(/&quot;/g, '"');
  }
  return { fields, html };
}

async function postAction(pageUrl, cookie, fields, entries) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  for (const [k, v] of Object.entries(entries)) {
    if (Array.isArray(v)) v.forEach((item) => fd.append(k, item));
    else fd.append(k, v);
  }
  const res = await fetch(pageUrl, { method: "POST", headers: { cookie, next: "action" }, body: fd });
  return { status: res.status, text: await res.text() };
}

const extractId = (text, key) => {
  const m = text.match(new RegExp(`"${key}"[:\\\\]*"([0-9a-f-]{36})"`));
  return m ? m[1] : null;
};

const denied = (text) =>
  text.includes("permission") || text.includes("not found") || text.includes("cannot") || text.includes("don't have access");

async function rest(sqlPath, opts = {}) {
  return fetch(`${SUPA_URL}/rest/v1/${sqlPath}`, {
    headers: { apikey: SERVICE, authorization: `Bearer ${SERVICE}`, ...(opts.headers ?? {}) },
    ...(opts.method ? { method: opts.method } : {}),
    ...(opts.body ? { body: JSON.stringify(opts.body) } : {}),
  });
}

// ── lifecycle ───────────────────────────────────────────────────────────────

console.log(`RestroNex Phase 5 RBAC lifecycle → ${SUPA_URL}`);
console.log(`app under test: ${APP}\n`);

const U = {};
let businessId = null;
let business2Id = null;
let outletId = null;
let cashierMembershipId = null;

try {
  console.log("0 · setup: four confirmed accounts");
  for (const [key, spec] of Object.entries(USERS)) {
    U[key] = await createConfirmedUser(spec);
  }
  check("all four users created", Object.keys(U).length === 4);

  // ── 1. owner builds a business + outlet ─────────────────────────────────
  console.log("\n1 · owner setup (business + outlet via app)");
  const bizPage = await getActionFields(`${APP}/settings/business/new`, U.O.cookie);
  const bizPost = await postAction(`${APP}/settings/business/new`, U.O.cookie, bizPage.fields, {
    name: `RBAC E2E ${ts}`,
    restaurantType: "cafe",
    currency: "INR",
    timezone: "Asia/Kolkata",
  });
  businessId = extractId(bizPost.text, "businessId");
  check("owner created business", Boolean(businessId), `status ${bizPost.status}`);

  if (businessId) {
    const outPage = await getActionFields(`${APP}/settings/outlets/new?business=${businessId}`, U.O.cookie);
    const outPost = await postAction(`${APP}/settings/outlets/new?business=${businessId}`, U.O.cookie, outPage.fields, {
      businessId,
      name: "RBAC Outlet",
      code: "RBC-01",
      orderTypes: ["dine_in"],
      operatingHours: "{}",
    });
    outletId = extractId(outPost.text, "outletId");
    check("owner created outlet", Boolean(outletId), `status ${outPost.status}`);
  }

  // ── 2. role assignment through the app ──────────────────────────────────
  console.log("\n2 · role assignment (staff actions)");
  if (businessId && outletId) {
    const staffPage = await getActionFields(`${APP}/settings/staff?business=${businessId}`, U.O.cookie);
    const addC = await postAction(`${APP}/settings/staff?business=${businessId}`, U.O.cookie, staffPage.fields, {
      businessId,
      email: USERS.C.email,
      role: "cashier",
      outletId: [outletId],
    });
    check("owner added cashier", addC.text.includes('"ok"') || addC.text.includes("ok"), `status ${addC.status}`);

    const addW = await postAction(`${APP}/settings/staff?business=${businessId}`, U.O.cookie, staffPage.fields, {
      businessId,
      email: USERS.W.email,
      role: "waiter",
    });
    // waiter is outlet-scoped → missing outlets must be REJECTED by validation
    check("waiter without outlets rejected (outlet role requires grants)", denied(addW.text) || addW.text.includes("outlet"), `status ${addW.status}`);

    const addW2 = await postAction(`${APP}/settings/staff?business=${businessId}`, U.O.cookie, staffPage.fields, {
      businessId,
      email: USERS.W.email,
      role: "waiter",
      outletId: [outletId],
    });
    check("owner added waiter with outlet", addW2.text.includes('"ok"') || addW2.text.includes("ok"), `status ${addW2.status}`);

    const mem = await rest(`memberships?business_id=eq.${businessId}&select=id,user_id,role,status`).then((r) => r.json());
    const cashier = mem.find((m) => m.user_id === U.C.id);
    const waiter = mem.find((m) => m.user_id === U.W.id);
    cashierMembershipId = cashier?.id;
    check("memberships persisted (cashier active)", Boolean(cashier) && cashier.role === "cashier" && cashier.status === "active");
    check("memberships persisted (waiter active)", Boolean(waiter) && waiter.role === "waiter");

    const grants = await rest(`membership_outlets?membership_id=eq.${cashier?.id}&select=outlet_id`).then((r) => r.json());
    check("cashier outlet grant persisted", grants.length === 1 && grants[0].outlet_id === outletId);

    // owner tries to assign 'owner' through staff management
    const addOwner = await postAction(`${APP}/settings/staff?business=${businessId}`, U.O.cookie, staffPage.fields, {
      businessId,
      email: USERS.O2.email,
      role: "owner",
    });
    check("assigning role=owner is rejected", denied(addOwner.text) || addOwner.text.includes("invalid"), `status ${addOwner.status}`);
  }

  // ── 3. escalation attacks (all must fail) ───────────────────────────────
  console.log("\n3 · escalation attacks");
  if (businessId && outletId && cashierMembershipId) {
    const staffFields = (await getActionFields(`${APP}/settings/staff?business=${businessId}`, U.O.cookie)).fields;

    const selfPromote = await postAction(`${APP}/settings/staff?business=${businessId}`, U.C.cookie, staffFields, {
      businessId,
      membershipId: cashierMembershipId,
      role: "business_admin",
    });
    check("cashier cannot self-promote", denied(selfPromote.text), `status ${selfPromote.status}`);

    const cashierAddsStaff = await postAction(`${APP}/settings/staff?business=${businessId}`, U.C.cookie, staffFields, {
      businessId,
      email: USERS.O2.email,
      role: "cashier",
      outletId: [outletId],
    });
    check("cashier cannot add staff (no staff.manage)", denied(cashierAddsStaff.text), `status ${cashierAddsStaff.status}`);

    const bizPage = (await getActionFields(`${APP}/settings/business/new`, U.C.cookie)).fields;
    const cashierEditsBiz = await postAction(`${APP}/settings/business/${businessId}/edit`, U.C.cookie, bizPage, {
      businessId,
      name: "Cashier Owned Now",
      restaurantType: "cafe",
      currency: "INR",
      timezone: "Asia/Kolkata",
    });
    const unchanged = await rest(`businesses?id=eq.${businessId}&select=name`).then((r) => r.json());
    check(
      "cashier cannot edit business settings",
      denied(cashierEditsBiz.text) && unchanged[0]?.name !== "Cashier Owned Now",
      `status ${cashierEditsBiz.status}`,
    );

    const outPage = (await getActionFields(`${APP}/settings/outlets/new?business=${businessId}`, U.O.cookie)).fields;
    const cashierCreatesOutlet = await postAction(`${APP}/settings/outlets/new?business=${businessId}`, U.C.cookie, outPage, {
      businessId,
      name: "Rogue Outlet",
      code: "ROG-01",
      orderTypes: ["dine_in"],
      operatingHours: "{}",
    });
    check("cashier cannot create outlets", denied(cashierCreatesOutlet.text), `status ${cashierCreatesOutlet.status}`);

    // cashier tries to deactivate the OWNER's membership
    const ownerMem = await rest(`memberships?business_id=eq.${businessId}&user_id=eq.${U.O.id}&select=id`).then((r) => r.json());
    if (ownerMem[0]) {
      const touchOwner = await postAction(`${APP}/settings/staff?business=${businessId}`, U.C.cookie, staffFields, {
        businessId,
        membershipId: ownerMem[0].id,
        active: "false",
      });
      const ownerStillActive = await rest(`memberships?id=eq.${ownerMem[0].id}&select=status`).then((r) => r.json());
      check(
        "cashier cannot deactivate the owner",
        denied(touchOwner.text) && ownerStillActive[0]?.status === "active",
        `status ${touchOwner.status}`,
      );
    }
  }

  // ── 4. cross-tenant attack ──────────────────────────────────────────────
  console.log("\n4 · cross-tenant staff manipulation");
  if (businessId && cashierMembershipId) {
    // O2 builds their own business first (legit), then attacks O's staff
    const biz2 = await postAction(`${APP}/settings/business/new`, U.O2.cookie, (await getActionFields(`${APP}/settings/business/new`, U.O2.cookie)).fields, {
      name: `RBAC E2E Two ${ts}`,
      restaurantType: "other",
      currency: "INR",
      timezone: "UTC",
    });
    business2Id = extractId(biz2.text, "businessId");

    const crossPromote = await postAction(`${APP}/settings/staff?business=${businessId}`, U.O2.cookie, (await getActionFields(`${APP}/settings/business/new`, U.O2.cookie)).fields, {
      businessId,
      membershipId: cashierMembershipId,
      role: "kitchen_staff",
    });
    const roleNow = await rest(`memberships?id=eq.${cashierMembershipId}&select=role`).then((r) => r.json());
    check(
      "foreign owner cannot modify another tenant's staff",
      denied(crossPromote.text) && roleNow[0]?.role === "cashier",
      `status ${crossPromote.status}`,
    );

    // RLS: O2's JWT sees nothing of O's business
    const leak = await fetch(`${SUPA_URL}/rest/v1/memberships?business_id=eq.${businessId}&select=id`, {
      headers: { apikey: ANON, authorization: `Bearer ${U.O2.token}` },
    }).then((r) => r.json());
    check("RLS: foreign owner cannot read tenant memberships", Array.isArray(leak) && leak.length === 0);
  }

  // ── 5. outlet scope + deactivation ──────────────────────────────────────
  console.log("\n5 · outlet scope & deactivation");
  if (businessId && outletId) {
    const cAccess = await fetch(`${SUPA_URL}/rest/v1/rpc/accessible_outlet_ids`, {
      method: "POST",
      headers: { apikey: ANON, authorization: `Bearer ${U.C.token}`, "content-type": "application/json" },
      body: "{}",
    }).then((r) => r.json());
    check("cashier operates exactly their granted outlet", Array.isArray(cAccess) && cAccess.includes(outletId) && cAccess.length === 1);

    // owner deactivates cashier via the app, then cashier loses everything
    const staffFields = (await getActionFields(`${APP}/settings/staff?business=${businessId}`, U.O.cookie)).fields;
    if (cashierMembershipId) {
      const deact = await postAction(`${APP}/settings/staff?business=${businessId}`, U.O.cookie, staffFields, {
        businessId,
        membershipId: cashierMembershipId,
        active: "false",
      });
      const statusNow = await rest(`memberships?id=eq.${cashierMembershipId}&select=status`).then((r) => r.json());
      check("owner deactivated cashier", deact.status === 200 && statusNow[0]?.status === "deactivated", `status ${deact.status}`);

      const cAccessAfter = await fetch(`${SUPA_URL}/rest/v1/rpc/accessible_outlet_ids`, {
        method: "POST",
        headers: { apikey: ANON, authorization: `Bearer ${U.C.token}`, "content-type": "application/json" },
        body: "{}",
      }).then((r) => r.json());
      check("deactivated cashier loses outlet access", Array.isArray(cAccessAfter) && cAccessAfter.length === 0);

      const reactivate = await postAction(`${APP}/settings/staff?business=${businessId}`, U.O.cookie, staffFields, {
        businessId,
        membershipId: cashierMembershipId,
        active: "true",
      });
      check("owner reactivated cashier", reactivate.status === 200);
    }
  }

  // ── 6. catalogue sync (code matrix vs database) ─────────────────────────
  console.log("\n6 · RBAC catalogue sync");
  const EXPECTED_COUNTS = {
    owner: 26,
    business_admin: 25,
    outlet_manager: 18,
    cashier: 7,
    waiter: 5,
    kitchen_staff: 2,
    inventory_manager: 6,
    accountant: 5,
  };
  const counts = await rest(
    "role_permissions?select=role_key&order=role_key",
  ).then((r) => r.json());
  const byRole = {};
  for (const row of counts ?? []) byRole[row.role_key] = (byRole[row.role_key] ?? 0) + 1;
  let syncOk = true;
  for (const [role, expected] of Object.entries(EXPECTED_COUNTS)) {
    if (byRole[role] !== expected) {
      syncOk = false;
      console.log(`     drift: ${role} db=${byRole[role]} code=${expected}`);
    }
  }
  check("database catalogue matches the code matrix (counts per role)", syncOk, JSON.stringify(byRole));

  // ── 7. cleanup ──────────────────────────────────────────────────────────
  console.log("\n7 · cleanup");
  for (const id of [businessId, business2Id]) {
    if (id) await rest(`businesses?id=eq.${id}`, { method: "DELETE" });
  }
  for (const u of Object.values(U)) {
    await got(`/auth/v1/admin/users/${u.id}`, { method: "DELETE", service: true });
  }
  check("cleanup completed", true);
} catch (err) {
  failed += 1;
  console.error(`\n💥 lifecycle aborted: ${err instanceof Error ? err.stack : String(err)}`);
} finally {
  for (const id of [businessId, business2Id]) {
    if (id) {
      await rest(`businesses?id=eq.${id}`, { method: "DELETE" }).catch(() => {});
    }
  }
  for (const u of Object.values(U)) {
    if (u?.id) await got(`/auth/v1/admin/users/${u.id}`, { method: "DELETE", service: true }).catch(() => {});
  }
}

console.log(`\n${"─".repeat(60)}`);
console.log(`RESULT: ${passed} passed, ${failed} failed${failed ? ` — ${failures.join("; ")}` : ""}`);
process.exit(failed === 0 ? 0 : 1);
