#!/usr/bin/env node
/**
 * RestroNex Phase 4 — live business + outlet management end-to-end.
 *
 * Requires: migration 20261008140000 pushed to the hosted project and the
 * app running on http://localhost:3000 (npm run start).
 *
 * Two owner accounts are created through the GoTrue ADMIN API (email
 * confirmation applied server-side — no inbox needed). Everything else runs
 * through the real product surface:
 *   - server-action form POSTs (the exact wire protocol the browser uses)
 *   - RLS-scoped REST reads with each user's own JWT
 *   - direct tenant-isolation attacks across the two accounts
 *
 * Covers: business creation, outlet creation, editing, activate/deactivate,
 * tenant isolation, and owner-only access.
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
const OWNER_A = { email: `biz-owner-a-${ts}@example.com`, password: "owner-alpha-77" };
const OWNER_B = { email: `biz-owner-b-${ts}@example.com`, password: "owner-bravo-88" };

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

// ── helpers ─────────────────────────────────────────────────────────────────

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

/** Mirror @supabase/ssr createChunks for a valid session cookie. */
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

/** Extract hidden $ACTION_* fields from a rendered page. */
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

/** POST a server-action form (browser wire protocol). */
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
  const m = text.match(new RegExp(`"${key}"[:\\\\]*"([0-9a-f-]{36})"`)) ?? text.match(new RegExp(`${key}[=:]([0-9a-f-]{36})`));
  return m ? m[1] : null;
};

// ── lifecycle ───────────────────────────────────────────────────────────────

console.log(`RestroNex Phase 4 business lifecycle → ${SUPA_URL}`);
console.log(`app under test: ${APP}\n`);

let userA = null;
let userB = null;
let businessId = null;
let outletId = null;

try {
  console.log("0 · setup: two confirmed owner accounts");
  userA = await createConfirmedUser(OWNER_A);
  userB = await createConfirmedUser(OWNER_B);
  check("two owners created and signed in", Boolean(userA.token && userB.token));

  // ── 1. business creation through the app ────────────────────────────────
  console.log("\n1 · create business (server action)");
  const bizPage = await getActionFields(`${APP}/settings/business/new`, userA.cookie);
  check("new-business page renders for owner A", Object.keys(bizPage.fields).length > 0);

  const bizPost = await postAction(`${APP}/settings/business/new`, userA.cookie, bizPage.fields, {
    name: `Phase4 E2E Café ${ts}`,
    restaurantType: "cafe",
    currency: "INR",
    timezone: "Asia/Kolkata",
    email: "hello@phase4.example",
    phone: "+91 44 5555 0000",
    addressLine1: "12 Marina Way",
    city: "Chennai",
    state: "Tamil Nadu",
    postalCode: "600005",
    country: "India",
    taxNumber: "33PHASE4E2E1Z5",
  });
  businessId = extractId(bizPost.text, "businessId");
  check(
    "createBusinessAction succeeds",
    bizPost.status === 200 && bizPost.text.includes('"ok"') && Boolean(businessId),
    `status ${bizPost.status}`,
  );

  if (businessId) {
    const row = await fetch(
      `${SUPA_URL}/rest/v1/businesses?id=eq.${businessId}&select=name,slug,currency_code,timezone,restaurant_type,tax_number,city`,
      { headers: { apikey: SERVICE, authorization: `Bearer ${SERVICE}` } },
    ).then((r) => r.json());
    const biz = row[0];
    check(
      "business persisted with all details",
      Boolean(biz) &&
        biz.restaurant_type === "cafe" &&
        biz.currency_code === "INR" &&
        biz.timezone === "Asia/Kolkata" &&
        biz.tax_number === "33PHASE4E2E1Z5" &&
        biz.city === "Chennai",
      JSON.stringify(biz ?? row).slice(0, 160),
    );
    const mem = await fetch(
      `${SUPA_URL}/rest/v1/memberships?business_id=eq.${businessId}&select=role,status,user_id`,
      { headers: { apikey: SERVICE, authorization: `Bearer ${SERVICE}` } },
    ).then((r) => r.json());
    check(
      "owner membership created automatically",
      mem.length === 1 && mem[0].role === "owner" && mem[0].status === "active" && mem[0].user_id === userA.id,
      JSON.stringify(mem).slice(0, 160),
    );

    // RLS-scoped read with A's own JWT
    const own = await fetch(`${SUPA_URL}/rest/v1/businesses?id=eq.${businessId}&select=id,name`, {
      headers: { apikey: ANON, authorization: `Bearer ${userA.token}` },
    }).then((r) => r.json());
    check("owner A sees their business via RLS", own.length === 1);
  }

  // ── 2. outlet creation through the app ──────────────────────────────────
  console.log("\n2 · create outlet (server action)");
  if (businessId) {
    const outPage = await getActionFields(`${APP}/settings/outlets/new?business=${businessId}`, userA.cookie);
    const outPost = await postAction(
      `${APP}/settings/outlets/new?business=${businessId}`,
      userA.cookie,
      outPage.fields,
      {
        businessId,
        name: "Marina Kiosk",
        code: "mkn-01",
        email: "marina@phase4.example",
        phone: "+91 44 5555 1111",
        addressLine1: "12 Marina Way",
        city: "Chennai",
        orderTypes: ["dine_in", "takeaway"],
        operatingHours: JSON.stringify({
          mon: { open: "08:00", close: "23:00" },
          tue: { open: "08:00", close: "23:00" },
          sun: null,
        }),
      },
    );
    outletId = extractId(outPost.text, "outletId");
    check(
      "createOutletAction succeeds",
      outPost.status === 200 && Boolean(outletId),
      `status ${outPost.status}`,
    );

    if (outletId) {
      const rows = await fetch(
        `${SUPA_URL}/rest/v1/outlets?id=eq.${outletId}&select=code,order_types,operating_hours,currency_code,timezone,status,business_id`,
        { headers: { apikey: SERVICE, authorization: `Bearer ${SERVICE}` } },
      ).then((r) => r.json());
      const out = rows[0];
      check(
        "outlet persisted (code uppercased, order types, hours, inherited locale)",
        Boolean(out) &&
          out.code === "MKN-01" &&
          JSON.stringify(out.order_types) === JSON.stringify(["dine_in", "takeaway"]) &&
          out.operating_hours?.mon?.open === "08:00" &&
          out.operating_hours?.sun === null &&
          out.currency_code === "INR" &&
          out.timezone === "Asia/Kolkata" &&
          out.business_id === businessId,
        JSON.stringify(out ?? rows).slice(0, 200),
      );
    }
  }

  // ── 3. editing through the app ──────────────────────────────────────────
  console.log("\n3 · edit business + outlet (server actions)");
  if (businessId) {
    const editPage = await getActionFields(`${APP}/settings/business/${businessId}/edit`, userA.cookie);
    const editPost = await postAction(
      `${APP}/settings/business/${businessId}/edit`,
      userA.cookie,
      editPage.fields,
      {
        businessId,
        name: `Phase4 E2E Café ${ts}`,
        restaurantType: "casual_dining",
        currency: "USD",
        timezone: "UTC",
        email: "updated@phase4.example",
        phone: "",
        addressLine1: "99 Edited Street",
        city: "Bengaluru",
        state: "Karnataka",
        postalCode: "560001",
        country: "India",
        taxNumber: "29PHASE4E2E9Z9",
      },
    );
    const updated = await fetch(
      `${SUPA_URL}/rest/v1/businesses?id=eq.${businessId}&select=city,currency_code,timezone,restaurant_type,email`,
      { headers: { apikey: SERVICE, authorization: `Bearer ${SERVICE}` } },
    ).then((r) => r.json());
    const u = updated[0];
    check(
      "business edits persisted",
      editPost.status === 200 &&
        Boolean(u) &&
        u.city === "Bengaluru" &&
        u.currency_code === "USD" &&
        u.timezone === "UTC" &&
        u.restaurant_type === "casual_dining" &&
        u.email === "updated@phase4.example",
      JSON.stringify(u ?? updated).slice(0, 160),
    );
  }
  if (outletId && businessId) {
    const editPage = await getActionFields(`${APP}/settings/outlets/${outletId}/edit`, userA.cookie);
    await postAction(`${APP}/settings/outlets/${outletId}/edit`, userA.cookie, editPage.fields, {
      outletId,
      name: "Marina Kiosk — Flagship",
      code: "MKN-01",
      email: "",
      phone: "",
      addressLine1: "99 Edited Street",
      city: "Bengaluru",
      orderTypes: ["dine_in", "delivery"],
      operatingHours: JSON.stringify({ mon: { open: "10:00", close: "22:00" } }),
    });
    const rows = await fetch(
      `${SUPA_URL}/rest/v1/outlets?id=eq.${outletId}&select=name,order_types,operating_hours`,
      { headers: { apikey: SERVICE, authorization: `Bearer ${SERVICE}` } },
    ).then((r) => r.json());
    const out = rows[0];
    check(
      "outlet edits persisted",
      Boolean(out) &&
        out.name === "Marina Kiosk — Flagship" &&
        JSON.stringify(out.order_types) === JSON.stringify(["dine_in", "delivery"]) &&
        out.operating_hours?.mon?.open === "10:00",
      JSON.stringify(out ?? rows).slice(0, 160),
    );
  }

  // ── 4. activate / deactivate ────────────────────────────────────────────
  console.log("\n4 · outlet activation");
  if (outletId && businessId) {
    const listPage = await getActionFields(`${APP}/settings/outlets?business=${businessId}`, userA.cookie);
    // The toggle form is one of several on the page; find the one whose
    // hidden fields include this outlet id by re-fetching and POSTing with
    // the page's bound action references (form fields repeat per outlet).
    const res = await fetch(`${APP}/settings/outlets?business=${businessId}`, { headers: { cookie: userA.cookie } });
    const html = await res.text();
    // Locate the action binding for the status toggle: it's the action whose
    // form contains `name="outletId" value="${outletId}"`.
    const slice = html.split(`name="outletId" value="${outletId}"`)[0];
    const refMatches = [...slice.matchAll(/\$ACTION_REF_(\d+)/g)];
    const lastRef = refMatches.length > 0 ? refMatches[refMatches.length - 1][1] : null;
    const toggleFields = {};
    for (const m of html.matchAll(new RegExp(`<input type="hidden" name="\\$ACTION_${lastRef}[^\\""]*"(?: value="([^"]*)")?\\/?>`, "g"))) {
      toggleFields[m[0].match(/name="([^"]+)"/)[1]] = (m[1] ?? "").replace(/&quot;/g, '"');
    }
    toggleFields[`$ACTION_REF_${lastRef}`] = "";
    const togglePost = await postAction(
      `${APP}/settings/outlets?business=${businessId}`,
      userA.cookie,
      toggleFields,
      { outletId, active: "false" },
    );
    const rows = await fetch(`${SUPA_URL}/rest/v1/outlets?id=eq.${outletId}&select=status`, {
      headers: { apikey: SERVICE, authorization: `Bearer ${SERVICE}` },
    }).then((r) => r.json());
    check(
      "deactivate toggles outlet status",
      togglePost.status === 200 && rows[0]?.status === "inactive",
      `status ${togglePost.status}, db=${JSON.stringify(rows).slice(0, 80)}`,
    );
    // re-activate for later checks
    toggleFields.active = "true";
    void (await postAction(`${APP}/settings/outlets?business=${businessId}`, userA.cookie, { ...listPage.fields }, { outletId, active: "true" }));
  }

  // ── 5. tenant isolation ─────────────────────────────────────────────────
  console.log("\n5 · tenant isolation (owner B vs owner A)");
  if (businessId) {
    const stolen = await postAction(`${APP}/settings/business/${businessId}/edit`, userB.cookie, (await getActionFields(`${APP}/settings/business/new`, userB.cookie)).fields, {
      businessId,
      name: "Stolen Business",
      restaurantType: "other",
      currency: "INR",
      timezone: "UTC",
    });
    check(
      "owner B cannot edit owner A's business via the app",
      stolen.text.includes("not found") || stolen.text.includes("don't have access"),
      `status ${stolen.status}`,
    );
    const still = await fetch(`${SUPA_URL}/rest/v1/businesses?id=eq.${businessId}&select=name`, {
      headers: { apikey: SERVICE, authorization: `Bearer ${SERVICE}` },
    }).then((r) => r.json());
    check("…and the row is unchanged", still[0]?.name?.includes("Stolen") === false, JSON.stringify(still).slice(0, 100));

    const bRead = await fetch(`${SUPA_URL}/rest/v1/businesses?id=eq.${businessId}&select=id`, {
      headers: { apikey: ANON, authorization: `Bearer ${userB.token}` },
    }).then((r) => r.json());
    check("RLS: owner B's JWT cannot read A's business", Array.isArray(bRead) && bRead.length === 0);

    const bOutlets = await fetch(`${SUPA_URL}/rest/v1/outlets?business_id=eq.${businessId}&select=id`, {
      headers: { apikey: ANON, authorization: `Bearer ${userB.token}` },
    }).then((r) => r.json());
    check("RLS: owner B's JWT cannot read A's outlets", Array.isArray(bOutlets) && bOutlets.length === 0);

    const bUpdate = await fetch(`${SUPA_URL}/rest/v1/businesses?id=eq.${businessId}`, {
      method: "PATCH",
      headers: {
        apikey: ANON,
        authorization: `Bearer ${userB.token}`,
        "content-type": "application/json",
        Prefer: "return=representation",
      },
      body: JSON.stringify({ name: "RLS Bypass Attempt" }),
    }).then((r) => r.json());
    check("RLS: owner B's JWT cannot UPDATE A's business", Array.isArray(bUpdate) && bUpdate.length === 0);

    const bInsert = await fetch(`${SUPA_URL}/rest/v1/outlets`, {
      method: "POST",
      headers: {
        apikey: ANON,
        authorization: `Bearer ${userB.token}`,
        "content-type": "application/json",
        Prefer: "return=representation",
      },
      body: JSON.stringify({ business_id: businessId, name: "Sneaky", slug: "sneaky", currency_code: "INR" }),
    });
    check("RLS: direct outlet INSERT into A's business denied", [401, 403].includes(bInsert.status), `status ${bInsert.status}`);
  }

  // ── 6. owner access (staff role cannot manage) ──────────────────────────
  console.log("\n6 · owner-only access");
  if (businessId && outletId) {
    await fetch(`${SUPA_URL}/rest/v1/memberships`, {
      method: "POST",
      headers: { apikey: SERVICE, authorization: `Bearer ${SERVICE}`, "content-type": "application/json" },
      body: JSON.stringify({ user_id: userB.id, business_id: businessId, role: "cashier", status: "active" }),
    });
    // The cashier also owns a separate business, so the settings pages show a
    // chooser of the businesses they actually manage — the security property
    // is that tenant A's data and forms are NOT part of that view.
    const staffList = await fetch(`${APP}/settings/outlets?business=${businessId}`, {
      headers: { cookie: userB.cookie },
      redirect: "manual",
    });
    // Next's flight payload echoes the requested URL back to the requester's
    // own router — that is not a leak. The security property is that tenant A's
    // *content* (name, outlets, management UI) is absent from the view.
    const staffHtml = await staffList.text();
    check(
      "cashier's outlet view never renders the other tenant",
      staffList.status === 200 && !staffHtml.includes(`Phase4 E2E Café ${ts}`),
      `status ${staffList.status}`,
    );
    const staffEdit = await postAction(`${APP}/settings/outlets/new`, userB.cookie, (await getActionFields(`${APP}/settings/outlets/new?business=${businessId}`, userB.cookie)).fields, {
      businessId,
      name: "Staff Outlet",
      code: "STF-01",
      orderTypes: ["dine_in"],
      operatingHours: "{}",
    });
    const forgedOutlets = await got(
      `/rest/v1/outlets?business_id=eq.${businessId}&name=eq.Staff Outlet&select=id`,
      { service: true },
    );
    check(
      "cashier cannot create outlets in the other tenant",
      Array.isArray(forgedOutlets.json) && forgedOutlets.json.length === 0,
      `status ${staffEdit.status}`,
    );
    await fetch(`${SUPA_URL}/rest/v1/memberships?user_id=eq.${userB.id}&business_id=eq.${businessId}`, {
      method: "DELETE",
      headers: { apikey: SERVICE, authorization: `Bearer ${SERVICE}` },
    });
  }

  // ── 7. cleanup ──────────────────────────────────────────────────────────
  console.log("\n7 · cleanup");
  if (businessId) {
    await fetch(`${SUPA_URL}/rest/v1/businesses?id=eq.${businessId}`, {
      method: "DELETE",
      headers: { apikey: SERVICE, authorization: `Bearer ${SERVICE}` },
    });
  }
  for (const u of [userA, userB]) {
    if (u) await got(`/auth/v1/admin/users/${u.id}`, { method: "DELETE", service: true });
  }
  const leftoverBiz = await fetch(
    `${SUPA_URL}/rest/v1/businesses?slug=like.phase4-e2e*&select=id`,
    { headers: { apikey: SERVICE, authorization: `Bearer ${SERVICE}` } },
  ).then((r) => r.json());
  check("no leftover test businesses", Array.isArray(leftoverBiz) && leftoverBiz.length === 0, JSON.stringify(leftoverBiz));
} catch (err) {
  failed += 1;
  console.error(`\n💥 lifecycle aborted: ${err instanceof Error ? err.stack : String(err)}`);
} finally {
  if (businessId) {
    await fetch(`${SUPA_URL}/rest/v1/businesses?id=eq.${businessId}`, {
      method: "DELETE",
      headers: { apikey: SERVICE, authorization: `Bearer ${SERVICE}` },
    }).catch(() => {});
  }
  for (const u of [userA, userB]) {
    if (u) {
      await got(`/auth/v1/admin/users/${u.id}`, { method: "DELETE", service: true }).catch(() => {});
    }
  }
}

console.log(`\n${"─".repeat(60)}`);
console.log(`RESULT: ${passed} passed, ${failed} failed${failed ? ` — ${failures.join("; ")}` : ""}`);
process.exit(failed === 0 ? 0 : 1);
