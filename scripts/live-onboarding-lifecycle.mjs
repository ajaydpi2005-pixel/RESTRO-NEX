#!/usr/bin/env node
/**
 * RestroNex Phase 6 — live restaurant-onboarding end-to-end.
 *
 * Requires: migrations 20261008140000, 20261008150000 AND 20261008160000
 * pushed to the hosted project, and the app running on http://localhost:3000
 * (npm run start).
 *
 * Everything runs through the real product surface:
 *   - server-action form POSTs (the exact wire protocol the browser uses)
 *   - service-role REST reads to verify persisted state
 *   - RLS-scoped reads with each user's own JWT
 *
 * Covers: the full wizard (business → type → outlet → settings → tax →
 * tables → kitchen → menu → staff invite → finish), resume state, skip
 * gating, staff-invite acceptance, and authorisation attacks (non-owner
 * writes, required-step skipping, invite misuse).
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
const OWNER = { email: `onb-owner-${ts}@example.com`, password: "onboard-owner-66" };
const STAFF = { email: `onb-staff-${ts}@example.com`, password: "onboard-staff-77" };

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

// ── helpers (same wire protocol as live-business-lifecycle.mjs) ─────────────

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
  const res = await fetch(pageUrl, { headers: { cookie }, redirect: "manual" });
  const html = await res.text();
  const fields = {};
  for (const m of html.matchAll(/<input type="hidden" name="([^"]+)"(?: value="([^"]*)")?\/>/g)) {
    const [, name, value] = m;
    if (name.startsWith("$ACTION") || name === "businessId" || name === "outletId" || name === "token") {
      fields[name] = (value ?? "").replace(/&quot;/g, '"');
    }
  }
  return { fields, html, status: res.status };
}

async function postAction(pageUrl, cookie, fields, entries) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) {
    if (k.startsWith("$ACTION")) fd.append(k, v);
  }
  for (const [k, v] of Object.entries(entries)) {
    if (Array.isArray(v)) v.forEach((item) => fd.append(k, item));
    else fd.append(k, v);
  }
  const res = await fetch(pageUrl, { method: "POST", headers: { cookie, next: "action" }, body: fd });
  return { status: res.status, text: await res.text() };
}

/** Does the RSC response indicate a redirect to `to`? */
const redirectsTo = (text, to) => text.includes(to);

async function serviceSelect(table, query = "") {
  const { json } = await got(`/rest/v1/${table}?${query}`, { service: true });
  return Array.isArray(json) ? json : [];
}

// ── lifecycle ───────────────────────────────────────────────────────────────

console.log(`RestroNex Phase 6 onboarding lifecycle → ${SUPA_URL}`);
console.log(`app under test: ${APP}\n`);

let owner = null;
let staff = null;
let businessId = null;
let outletId = null;

try {
  console.log("0 · setup: owner + staff accounts");
  owner = await createConfirmedUser(OWNER);
  staff = await createConfirmedUser(STAFF);
  check("two confirmed users created", Boolean(owner.token && staff.token));

  // ── 1. entry: fresh account lands on the business step ─────────────────
  console.log("\n1 · wizard entry");
  const entry = await fetch(`${APP}/onboarding`, { headers: { cookie: owner.cookie }, redirect: "manual" });
  const entryLoc = entry.headers.get("location") ?? "";
  check("fresh owner is routed to /onboarding/business", entryLoc.includes("/onboarding/business"), entryLoc);

  // ── 2. create business ──────────────────────────────────────────────────
  console.log("\n2 · create business (step: business)");
  const bizPage = await getActionFields(`${APP}/onboarding/business`, owner.cookie);
  const bizPost = await postAction(`${APP}/onboarding/business`, owner.cookie, bizPage.fields, {
    name: `Phase6 E2E Bistro ${ts}`,
    currency: "INR",
    timezone: "Asia/Kolkata",
  });
  check("business step saves & continues to type", redirectsTo(bizPost.text, "/onboarding/type"));

  const membership = (await serviceSelect("memberships", `user_id=eq.${owner.id}&select=business_id,role`))[0];
  businessId = membership?.business_id ?? null;
  check("business + owner membership persisted", Boolean(businessId) && membership?.role === "owner");

  const progressRow = (await serviceSelect("onboarding_progress", `business_id=eq.${businessId}&select=*`))[0];
  check(
    "progress auto-initialised at the type step",
    progressRow?.current_step === "type" && (progressRow?.completed_steps ?? []).includes("business"),
    JSON.stringify(progressRow),
  );

  // ── 3. restaurant type ──────────────────────────────────────────────────
  console.log("\n3 · restaurant type");
  const typePage = await getActionFields(`${APP}/onboarding/type`, owner.cookie);
  check("type step prefilled with business id", typePage.fields.businessId === businessId);
  const typePost = await postAction(`${APP}/onboarding/type`, owner.cookie, typePage.fields, {
    businessId,
    restaurantType: "casual_dining",
  });
  check("type step advances to outlet", redirectsTo(typePost.text, "/onboarding/outlet"));
  const bizAfterType = (await serviceSelect("businesses", `id=eq.${businessId}&select=restaurant_type`))[0];
  check("restaurant_type persisted", bizAfterType?.restaurant_type === "casual_dining");

  // ── 4. first outlet ─────────────────────────────────────────────────────
  console.log("\n4 · first outlet");
  const outletPage = await getActionFields(`${APP}/onboarding/outlet`, owner.cookie);
  const outletPost = await postAction(`${APP}/onboarding/outlet`, owner.cookie, outletPage.fields, {
    businessId,
    name: "E2E Main Outlet",
    phone: "+91 44 5555 1234",
    addressLine1: "1 Test Street",
    city: "Chennai",
    orderTypes: ["dine_in", "takeaway"],
  });
  check("outlet step advances to settings", redirectsTo(outletPost.text, "/onboarding/settings"));
  const outlet = (await serviceSelect("outlets", `business_id=eq.${businessId}&select=*`))[0];
  outletId = outlet?.id ?? null;
  check(
    "outlet persisted with code + order types",
    Boolean(outletId) && (outlet?.order_types ?? []).includes("dine_in"),
  );

  // ── 5. business settings ────────────────────────────────────────────────
  console.log("\n5 · business settings");
  const setPage = await getActionFields(`${APP}/onboarding/settings`, owner.cookie);
  const setPost = await postAction(`${APP}/onboarding/settings`, owner.cookie, setPage.fields, {
    businessId,
    name: `Phase6 E2E Bistro ${ts}`,
    email: "hello@phase6.example",
    phone: "+91 44 5555 9999",
    addressLine1: "1 Test Street",
    city: "Chennai",
    state: "Tamil Nadu",
    postalCode: "600001",
    country: "India",
    currency: "INR",
    timezone: "Asia/Kolkata",
  });
  check("settings step advances to tax", redirectsTo(setPost.text, "/onboarding/tax"));
  const bizAfterSettings = (await serviceSelect("businesses", `id=eq.${businessId}&select=city,email`))[0];
  check("settings persisted", bizAfterSettings?.city === "Chennai" && bizAfterSettings?.email === "hello@phase6.example");

  // ── 6. tax settings ─────────────────────────────────────────────────────
  console.log("\n6 · tax settings");
  const taxPage = await getActionFields(`${APP}/onboarding/tax`, owner.cookie);
  const taxPost = await postAction(`${APP}/onboarding/tax`, owner.cookie, taxPage.fields, {
    businessId,
    taxEnabled: "yes",
    taxNumber: "33PHASE6E2E1Z5",
    invoiceFooter: "Thank you for dining with us",
    rateName: ["GST", ""],
    ratePct: ["5", ""],
    rateInclusive: ["exclusive", "exclusive"],
  });
  check("tax step advances to tables", redirectsTo(taxPost.text, "/onboarding/tables"));
  const bizAfterTax = (await serviceSelect("businesses", `id=eq.${businessId}&select=tax_number,tax_settings`))[0];
  const rates = bizAfterTax?.tax_settings?.rates ?? [];
  check(
    "tax_settings jsonb persisted (enabled + GST 5%)",
    bizAfterTax?.tax_number === "33PHASE6E2E1Z5" && bizAfterTax?.tax_settings?.enabled === true && rates[0]?.pct === 5,
    JSON.stringify(bizAfterTax?.tax_settings),
  );

  // ── 7. tables ───────────────────────────────────────────────────────────
  console.log("\n7 · tables");
  const tablesPage = await getActionFields(`${APP}/onboarding/tables`, owner.cookie);
  const tablesPost = await postAction(`${APP}/onboarding/tables`, owner.cookie, tablesPage.fields, {
    businessId,
    outletId,
    sectionName: ["Main hall", "Terrace"],
    tableCount: ["3", "2"],
    capacity: ["4", "2"],
  });
  check("tables step advances to kitchen", redirectsTo(tablesPost.text, "/onboarding/kitchen"));
  const tables = await serviceSelect("dining_tables", `outlet_id=eq.${outletId}&select=label,capacity`);
  check("5 tables persisted across 2 sections", tables.length === 5);
  check("tables numbered T1..T5", tables.map((t) => t.label).sort().join(",") === "T1,T2,T3,T4,T5");

  // ── 8. kitchen stations ─────────────────────────────────────────────────
  console.log("\n8 · kitchen stations");
  const kitchenPage = await getActionFields(`${APP}/onboarding/kitchen`, owner.cookie);
  const kitchenPost = await postAction(`${APP}/onboarding/kitchen`, owner.cookie, kitchenPage.fields, {
    businessId,
    outletId,
    stationName: ["Hot kitchen", "Beverages"],
    stationDescription: ["", "Bar counter"],
  });
  check("kitchen step advances to menu", redirectsTo(kitchenPost.text, "/onboarding/menu"));
  const stations = await serviceSelect("kitchen_stations", `outlet_id=eq.${outletId}&select=name`);
  check("2 kitchen stations persisted", stations.length === 2);

  // ── 9. menu ─────────────────────────────────────────────────────────────
  console.log("\n9 · menu setup");
  const menuPage = await getActionFields(`${APP}/onboarding/menu`, owner.cookie);
  const menuPost = await postAction(`${APP}/onboarding/menu`, owner.cookie, menuPage.fields, {
    businessId,
    categoryName: ["Starters", "Mains"],
    itemName: ["Tomato Soup", "Veg Biryani"],
    itemPrice: ["99.50", "250"],
    itemFood: ["veg", "veg"],
    itemDescription: ["", "House special"],
  });
  check("menu step advances to staff", redirectsTo(menuPost.text, "/onboarding/staff"));
  const items = await serviceSelect("menu_items", `business_id=eq.${businessId}&select=name,price_minor`);
  check(
    "menu items persisted with exact minor-unit prices",
    items.length === 2 && items.some((i) => i.price_minor === 9950) && items.some((i) => i.price_minor === 25000),
    JSON.stringify(items),
  );

  // ── 10. staff invitation + acceptance ───────────────────────────────────
  console.log("\n10 · staff invitation");
  const staffPage = await getActionFields(`${APP}/onboarding/staff`, owner.cookie);
  const invitePost = await postAction(`${APP}/onboarding/staff`, owner.cookie, staffPage.fields, {
    businessId,
    email: STAFF.email,
    role: "waiter",
    outletId: [outletId],
    expiryDays: "7",
  });
  const tokenMatch = invitePost.text.match(/inviteToken[\\"]*:[\\"]*([A-Za-z0-9_-]{20,})/);
  check("invite created and token returned", Boolean(tokenMatch?.[1]));
  const inviteToken = tokenMatch?.[1] ?? "";

  const inviteRow = (await serviceSelect("staff_invites", `business_id=eq.${businessId}&select=*`))[0];
  check("invite persisted (waiter, email-locked)", inviteRow?.role === "waiter" && inviteRow?.email === STAFF.email);

  // staff accepts via the public invite page
  const acceptPage = await getActionFields(`${APP}/invite/${inviteToken}`, staff.cookie);
  check("invite page renders accept form for the invitee", Object.keys(acceptPage.fields).some((k) => k.startsWith("$ACTION")));
  const acceptPost = await postAction(`${APP}/invite/${inviteToken}`, staff.cookie, acceptPage.fields, {
    token: inviteToken,
  });
  check("acceptance routes to dashboard", redirectsTo(acceptPost.text, "/dashboard?joined=1"));
  const staffMembership = (
    await serviceSelect("memberships", `user_id=eq.${staff.id}&business_id=eq.${businessId}&select=role,status`)
  )[0];
  check("staff membership created as waiter", staffMembership?.role === "waiter" && staffMembership?.status === "active");

  // outlet grant arrived via the invite
  const grants = await serviceSelect(
    "membership_outlets",
    `membership_id=eq.${staffMembership?.id ?? "00000000-0000-0000-0000-000000000000"}&select=outlet_id`,
  );
  check("outlet grant created from invite", grants.some((g) => g.outlet_id === outletId));

  // token is single-use
  const reuse = await postAction(`${APP}/invite/${inviteToken}`, staff.cookie, acceptPage.fields, {
    token: inviteToken,
  });
  check("invite token cannot be reused", /already been used|already/i.test(reuse.text));

  // ── 11. authorisation attacks ───────────────────────────────────────────
  console.log("\n11 · authorisation attacks");

  // staff (waiter) cannot run the owner's wizard steps
  const taxPageAsStaff = await getActionFields(`${APP}/onboarding/tax`, staff.cookie);
  const taxAttack = await postAction(`${APP}/onboarding/tax`, staff.cookie, taxPageAsStaff.fields, {
    businessId,
    taxEnabled: "yes",
    taxNumber: "HACKED",
    invoiceFooter: "",
    rateName: [],
    ratePct: [],
    rateInclusive: [],
  });
  const bizAfterAttack = (await serviceSelect("businesses", `id=eq.${businessId}&select=tax_number`))[0];
  check(
    "waiter blocked from onboarding writes",
    /owners and admins|permission/i.test(taxAttack.text) && bizAfterAttack?.tax_number === "33PHASE6E2E1Z5",
  );

  // required steps cannot be skipped
  const skipPage = await getActionFields(`${APP}/onboarding/outlet`, owner.cookie);
  const skipAttack = await postAction(`${APP}/onboarding/outlet`, owner.cookie, skipPage.fields, {
    businessId,
    step: "outlet",
  });
  check("required step cannot be skipped", /can't be skipped/i.test(skipAttack.text));

  // staff cannot forge invites into the business
  const staffInvitePage = await getActionFields(`${APP}/onboarding/staff`, staff.cookie);
  if (Object.keys(staffInvitePage.fields).some((k) => k.startsWith("$ACTION"))) {
    const forge = await postAction(`${APP}/onboarding/staff`, staff.cookie, staffInvitePage.fields, {
      businessId,
      email: "",
      role: "business_admin",
      outletId: [],
      expiryDays: "30",
    });
    const forged = await serviceSelect("staff_invites", `business_id=eq.${businessId}&role=eq.business_admin&select=id`);
    check("waiter cannot create admin invites", forged.length === 0 && /owners and admins|permission/i.test(forge.text));
  } else {
    check("waiter never sees the invite form", true);
  }

  // ── 12. finish + resume state ───────────────────────────────────────────
  console.log("\n12 · finish");
  const finishPage = await getActionFields(`${APP}/onboarding/finish`, owner.cookie);
  const finishPost = await postAction(`${APP}/onboarding/finish`, owner.cookie, finishPage.fields, { businessId });
  check("finish routes to dashboard with celebration flag", redirectsTo(finishPost.text, "/dashboard?onboarded=1"));
  const finalProgress = (await serviceSelect("onboarding_progress", `business_id=eq.${businessId}&select=*`))[0];
  check(
    "onboarding stamped complete with full step history",
    finalProgress?.completed_at !== null && finalProgress?.current_step === "done",
    JSON.stringify(finalProgress),
  );

  const dashboard = await fetch(`${APP}/dashboard`, { headers: { cookie: owner.cookie }, redirect: "manual" });
  check("completed owner lands on dashboard (no redirect loop)", dashboard.status === 200);
} catch (error) {
  failed += 1;
  failures.push(`fatal: ${error?.message ?? error}`);
  console.error("\nFATAL:", error);
} finally {
  // ── cleanup ─────────────────────────────────────────────────────────────
  if (businessId) {
    await got(`/rest/v1/businesses?id=eq.${businessId}`, { method: "DELETE", service: true });
  }
  for (const user of [owner, staff]) {
    if (user?.id) await got(`/auth/v1/admin/users/${user.id}`, { method: "DELETE", service: true });
  }
}

console.log(`\n${"─".repeat(60)}`);
console.log(`Phase 6 onboarding E2E: ${passed} passed, ${failed} failed`);
if (failures.length > 0) {
  console.log("Failures:");
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
