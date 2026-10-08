#!/usr/bin/env node
/**
 * RestroNex Phase 8 — POS + order management end-to-end.
 *
 * Requires: migrations through 20261008180000 pushed to the hosted project
 * and the app running on http://localhost:3000 (npm run start).
 *
 * The POS terminal submits orders through the savePosOrder / transitionOrder
 * server actions, which are thin wrappers over the SECURITY DEFINER order
 * RPCs. This script exercises those RPCs — the exact server-side code the
 * actions run — against the hosted database, then proves the HTTP surface:
 *
 *   - full order lifecycle: create → hold/resume → place → preparing → ready
 *   - server-side repricing (variant/modifier/outlet overrides), discounts,
 *     exclusive tax, charges — exact minor-unit totals
 *   - duplicate prevention via client_ref idempotency
 *   - transactional rollback of every rejected create
 *   - state-machine guards + the Phase-10 payment gate on `completed`
 *   - service-role-only RPCs (authenticated users get no EXECUTE)
 *   - RLS read isolation between tenants
 *   - /pos and /orders render for an authorised owner, redirect when anon
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
const OWNER_A = { email: `pos-owner-a-${ts}@example.com`, password: "pos-alpha-77" };
const OWNER_B = { email: `pos-owner-b-${ts}@example.com`, password: "pos-bravo-66" };

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

async function got(path, { method = "GET", body, service = false, bearer, prefer } = {}) {
  const res = await fetch(`${SUPA_URL}${path}`, {
    method,
    headers: {
      apikey: service ? SERVICE : ANON,
      ...(body ? { "content-type": "application/json" } : {}),
      ...(prefer ? { prefer } : {}),
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

async function serviceSelect(table, query = "") {
  const { json } = await got(`/rest/v1/${table}?${query}`, { service: true });
  return Array.isArray(json) ? json : [];
}

async function rpc(fn, body, { service = true, bearer } = {}) {
  return got(`/rest/v1/rpc/${fn}`, { method: "POST", service, bearer, body });
}

// ── lifecycle ───────────────────────────────────────────────────────────────

console.log(`RestroNex Phase 8 POS + order lifecycle → ${SUPA_URL}`);
console.log(`app under test: ${APP}\n`);

let userA = null;
let userB = null;
let businessA = null;
let businessB = null;
let outletA = null;
let tableId = null;
let productBurger = null;
let productFries = null;
let variantLarge = null;
let modifierCheese = null;
let comboMeal = null;

try {
  console.log("0 · setup: two tenants; tenant A gets a menu, a table and tax settings");
  userA = await createConfirmedUser(OWNER_A);
  userB = await createConfirmedUser(OWNER_B);
  const rpcA = await got("/rest/v1/rpc/create_business", {
    method: "POST",
    service: true,
    body: { p_owner_id: userA.id, p_name: `POS Tenant A ${ts}`, p_restaurant_type: "casual_dining", p_currency_code: "INR", p_timezone: "Asia/Kolkata" },
  });
  const rpcB = await got("/rest/v1/rpc/create_business", {
    method: "POST",
    service: true,
    body: { p_owner_id: userB.id, p_name: `POS Tenant B ${ts}`, p_restaurant_type: "cafe", p_currency_code: "INR", p_timezone: "Asia/Kolkata" },
  });
  businessA = typeof rpcA.json === "string" ? rpcA.json : null;
  businessB = typeof rpcB.json === "string" ? rpcB.json : null;
  check("two tenants created", Boolean(businessA && businessB));

  await got("/rest/v1/outlets", {
    method: "POST",
    service: true,
    body: { business_id: businessA, name: "pos-a main", slug: `pos-a-${ts}`, status: "active" },
  });
  outletA = (await serviceSelect("outlets", `business_id=eq.${businessA}&select=id`))[0]?.id ?? null;
  check("tenant A outlet created", Boolean(outletA));

  // menu fixtures for tenant A
  const cat = await got("/rest/v1/menu_categories", {
    method: "POST",
    service: true,
    prefer: "return=representation",
    body: { business_id: businessA, name: `POS E2E ${ts}` },
  });
  const categoryId = cat.json?.[0]?.id ?? null;

  const burgers = await got("/rest/v1/menu_items", {
    method: "POST",
    service: true,
    body: { business_id: businessA, category_id: categoryId, name: `E2E Burger ${ts}`, price_minor: 10000 },
  });
  productBurger = burgers.json?.[0]?.id ?? null;
  const fries = await got("/rest/v1/menu_items", {
    method: "POST",
    service: true,
    body: { business_id: businessA, category_id: categoryId, name: `E2E Fries ${ts}`, price_minor: 5000, tax_rate_pct: 5 },
  });
  productFries = fries.json?.[0]?.id ?? null;

  const variant = await got("/rest/v1/product_variants", {
    method: "POST",
    service: true,
    body: { business_id: businessA, product_id: productBurger, name: "Large", price_minor: 15000 },
  });
  variantLarge = variant.json?.[0]?.id ?? null;

  const group = await got("/rest/v1/modifier_groups", {
    method: "POST",
    service: true,
    body: { business_id: businessA, name: `E2E Toppings ${ts}`, min_selected: 0, max_selected: 2 },
  });
  const groupId = group.json?.[0]?.id ?? null;
  const cheese = await got("/rest/v1/modifiers", {
    method: "POST",
    service: true,
    body: { business_id: businessA, modifier_group_id: groupId, name: "E2E Cheese", price_minor: 2000 },
  });
  modifierCheese = cheese.json?.[0]?.id ?? null;
  await got("/rest/v1/product_modifier_groups", {
    method: "POST",
    service: true,
    body: { product_id: productBurger, modifier_group_id: groupId },
  });

  const combo = await got("/rest/v1/combos", {
    method: "POST",
    service: true,
    body: { business_id: businessA, name: `E2E Meal ${ts}`, price_minor: 20000 },
  });
  comboMeal = combo.json?.[0]?.id ?? null;

  // outlet override: reprice the Large variant to 16000
  await got("/rest/v1/outlet_variant_overrides", {
    method: "POST",
    service: true,
    body: { variant_id: variantLarge, outlet_id: outletA, price_minor: 16000 },
  });

  // dining table
  const section = await got("/rest/v1/dining_sections", {
    method: "POST",
    service: true,
    body: { business_id: businessA, outlet_id: outletA, name: "E2E Hall" },
  });
  const sectionId = section.json?.[0]?.id ?? null;
  const table = await got("/rest/v1/dining_tables", {
    method: "POST",
    service: true,
    body: { business_id: businessA, outlet_id: outletA, section_id: sectionId, label: `T-${ts}`, capacity: 4 },
  });
  tableId = table.json?.[0]?.id ?? null;

  // exclusive 5% + inclusive 2% (inclusive must NOT stack into totals)
  await got(`/rest/v1/businesses?id=eq.${businessA}`, {
    method: "PATCH",
    service: true,
    body: {
      tax_settings: {
        enabled: true,
        rates: [
          { name: "GST", pct: 5, inclusive: false },
          { name: "VAT", pct: 2, inclusive: true },
        ],
      },
    },
  });
  check(
    "menu fixtures + table + tax settings seeded",
    Boolean(categoryId && productBurger && productFries && variantLarge && modifierCheese && comboMeal && tableId),
  );

  // ── 1. order creation with server-side repricing ──────────────────────────
  console.log("\n1 · create order (dine-in, variant + modifier + combo, 10% discount, charge)");
  const happyRef = `pos-happy-${ts}`;
  const happyPayload = {
    outlet_id: outletA,
    client_ref: happyRef,
    order_type: "dine_in",
    table_id: tableId,
    customer_name: "Walk-in 12",
    discount: { type: "percent", value: 10 },
    charges: [{ name: "Packing", amount_minor: 500 }],
    items: [
      { item_type: "product", product_id: productFries, quantity: 1 },
      {
        item_type: "product",
        product_id: productBurger,
        variant_id: variantLarge,
        quantity: 2,
        item_notes: "no onions",
        modifiers: [{ modifier_id: modifierCheese, quantity: 1 }],
      },
      { item_type: "combo", combo_id: comboMeal, quantity: 1 },
    ],
  };
  const happyCreate = await rpc("create_pos_order", { p_actor: userA.id, p_payload: happyPayload });
  const happyId = typeof happyCreate.json === "string" ? happyCreate.json : null;
  check("order created via RPC", Boolean(happyId), happyCreate.text.slice(0, 160));

  const happyRow = (await serviceSelect("orders", `id=eq.${happyId}&select=*`))[0];
  // variant override 16000 + cheese 2000, qty 2 → 36000; fries 5000; combo 20000 → 61000
  check("subtotal repriced server-side (610.00)", happyRow?.subtotal_minor === 61000, `got ${happyRow?.subtotal_minor}`);
  check("percent discount applied (61.00)", happyRow?.discount_minor === 6100, `got ${happyRow?.discount_minor}`);
  // exclusive 5% on post-discount nets: 1620 + 225 + 0 = 1845
  check("exclusive tax computed (18.45)", Number(happyRow?.tax_minor) === 1845, `got ${happyRow?.tax_minor}`);
  check("charges added (5.00)", happyRow?.charges_minor === 500, `got ${happyRow?.charges_minor}`);
  check("grand total exact (572.45)", happyRow?.total_minor === 57245, `got ${happyRow?.total_minor}`);
  check("new order is unpaid with zero paid", happyRow?.paid_minor === 0 && happyRow?.payment_status === "unpaid");

  const burgerLine = (await serviceSelect("order_items", `order_id=eq.${happyId}&variant_id=eq.${variantLarge}&select=*`))[0];
  check("variant outlet override applied (160.00)", burgerLine?.unit_price_minor === 16000, `got ${burgerLine?.unit_price_minor}`);
  check("variant label includes size", burgerLine?.name === `E2E Burger ${ts} (Large)`, `got ${burgerLine?.name}`);
  const modLine = await serviceSelect("order_item_modifiers", `order_item_id=eq.${burgerLine?.id}&select=*`);
  check("modifier row persisted", modLine.length === 1 && modLine[0]?.price_minor === 2000);

  // ── 2. duplicate prevention ───────────────────────────────────────────────
  console.log("\n2 · duplicate prevention (client_ref idempotency)");
  const dupCreate = await rpc("create_pos_order", { p_actor: userA.id, p_payload: happyPayload });
  const dupId = typeof dupCreate.json === "string" ? dupCreate.json : null;
  const refCount = (await serviceSelect("orders", `business_id=eq.${businessA}&client_ref=eq.${happyRef}&select=id`)).length;
  check("same client_ref returns the original order", dupId === happyId, `got ${dupId}`);
  check("no duplicate row written", refCount === 1, `got ${refCount}`);

  // ── 3. input guards + transactional rollback ─────────────────────────────
  console.log("\n3 · input guards (all failures roll back fully)");
  const countBefore = (await serviceSelect("orders", `business_id=eq.${businessA}&select=id`)).length;

  const noTable = await rpc("create_pos_order", {
    p_actor: userA.id,
    p_payload: { ...happyPayload, client_ref: `pos-notable-${ts}`, order_type: "dine_in", table_id: null },
  });
  check("dine-in without table rejected", noTable.status !== 200, noTable.text.slice(0, 120));

  const noPhone = await rpc("create_pos_order", {
    p_actor: userA.id,
    p_payload: {
      outlet_id: outletA,
      client_ref: `pos-nophone-${ts}`,
      order_type: "delivery",
      items: [{ item_type: "product", product_id: productFries, quantity: 1 }],
    },
  });
  check("delivery without phone/address rejected", noPhone.status !== 200, noPhone.text.slice(0, 120));

  // cross-tenant item needs tenant B's own category
  const catB = await got("/rest/v1/menu_categories", {
    method: "POST",
    service: true,
    body: { business_id: businessB, name: `POS B ${ts}` },
  });
  const catBId = catB.json?.[0]?.id ?? null;
  const bProd = await got("/rest/v1/menu_items", {
    method: "POST",
    service: true,
    body: { business_id: businessB, category_id: catBId, name: `E2E B Item ${ts}`, price_minor: 100 },
  });
  const bProductId = bProd.json?.[0]?.id ?? null;
  const crossTenant = await rpc("create_pos_order", {
    p_actor: userA.id,
    p_payload: {
      outlet_id: outletA,
      client_ref: `pos-cross-${ts}`,
      order_type: "takeaway",
      items: [{ item_type: "product", product_id: bProductId, quantity: 1 }],
    },
  });
  check("cross-tenant product rejected", crossTenant.status !== 200, crossTenant.text.slice(0, 120));

  const countAfter = (await serviceSelect("orders", `business_id=eq.${businessA}&select=id`)).length;
  check("rejected creates left no rows (transactional)", countAfter === countBefore, `${countBefore} → ${countAfter}`);

  // ── 4. state machine + payment gate ───────────────────────────────────────
  console.log("\n4 · state machine + Phase-10 payment gate");
  const lcRef = `pos-lifecycle-${ts}`;
  const lcCreate = await rpc("create_pos_order", {
    p_actor: userA.id,
    p_payload: {
      outlet_id: outletA,
      client_ref: lcRef,
      order_type: "takeaway",
      items: [{ item_type: "product", product_id: productFries, quantity: 2 }],
    },
  });
  const lcId = typeof lcCreate.json === "string" ? lcCreate.json : null;
  check("lifecycle order created (open)", Boolean(lcId));

  const skip = await rpc("transition_order_status", { p_actor: userA.id, p_order_id: lcId, p_to: "preparing" });
  check("open → preparing blocked", skip.status !== 200);

  const hold = await rpc("transition_order_status", { p_actor: userA.id, p_order_id: lcId, p_to: "held" });
  const resume = await rpc("transition_order_status", { p_actor: userA.id, p_order_id: lcId, p_to: "open" });
  check("hold ↔ resume works", hold.status === 200 && resume.status === 200);

  for (const to of ["placed", "preparing", "ready"]) {
    const r = await rpc("transition_order_status", { p_actor: userA.id, p_order_id: lcId, p_to: to });
    check(`advanced to ${to}`, r.status === 200, r.text.slice(0, 120));
  }
  const complete = await rpc("transition_order_status", { p_actor: userA.id, p_order_id: lcId, p_to: "completed" });
  check("ready → completed blocked until paid", complete.status !== 200, complete.text.slice(0, 140));

  const history = await serviceSelect("order_status_history", `order_id=eq.${lcId}&select=to_status`);
  check("status history recorded", history.length >= 5, `got ${history.length}`);

  // ── 5. amend + recompute ─────────────────────────────────────────────────
  console.log("\n5 · amend order (reprices + recomputes)");
  const amCreate = await rpc("create_pos_order", {
    p_actor: userA.id,
    p_payload: {
      outlet_id: outletA,
      client_ref: `pos-amend-${ts}`,
      order_type: "takeaway",
      items: [{ item_type: "product", product_id: productFries, quantity: 1 }],
    },
  });
  const amId = typeof amCreate.json === "string" ? amCreate.json : null;
  const amend = await rpc("amend_pos_order", {
    p_actor: userA.id,
    p_order_id: amId,
    p_payload: {
      status: "held",
      discount: { type: "flat", value: 1000 },
      items: [{ item_type: "product", product_id: productBurger, quantity: 2 }],
    },
  });
  const amRow = (await serviceSelect("orders", `id=eq.${amId}&select=*`))[0];
  check("amend applied", amend.status === 200, amend.text.slice(0, 120));
  // burger base 10000 * 2 = 20000; flat 1000; 5% on 19000 = 950; total 19950
  check("amend recomputed subtotal (200.00)", amRow?.subtotal_minor === 20000, `got ${amRow?.subtotal_minor}`);
  check("amend recomputed total (199.50)", amRow?.total_minor === 19950, `got ${amRow?.total_minor}`);
  check("amend set status to held", amRow?.status === "held");

  const amendReady = await rpc("amend_pos_order", {
    p_actor: userA.id,
    p_order_id: lcId,
    p_payload: { items: [{ item_type: "product", product_id: productFries, quantity: 3 }] },
  });
  check("amending a ready order blocked", amendReady.status !== 200);

  // ── 6. service-role-only + tenant isolation ──────────────────────────────
  console.log("\n6 · security: RPCs are service_role-only; reads are tenant-isolated");
  const asUser = await rpc("create_pos_order", { p_actor: userA.id, p_payload: happyPayload }, { service: false, bearer: userA.token });
  check("authenticated user cannot call create_pos_order", asUser.status !== 200, `status ${asUser.status}`);

  const bReads = await got(`/rest/v1/orders?business_id=eq.${businessA}&select=id`, { bearer: userB.token });
  check("RLS hides tenant A orders from owner B", Array.isArray(bReads.json) && bReads.json.length === 0);

  const aReads = await got(`/rest/v1/orders?business_id=eq.${businessA}&select=id`, { bearer: userA.token });
  check("owner A can read own orders", Array.isArray(aReads.json) && aReads.json.length >= 3, `got ${aReads.json?.length}`);

  // ── 7. HTTP surface ──────────────────────────────────────────────────────
  console.log("\n7 · HTTP surface: /pos and /orders");
  const anonPos = await fetch(`${APP}/pos?business=${businessA}`, { redirect: "manual" });
  check("anon /pos redirects to login", anonPos.status === 307 || anonPos.status === 303, `got ${anonPos.status}`);

  const posPage = await fetch(`${APP}/pos?business=${businessA}`, { headers: { cookie: userA.cookie } });
  const posHtml = await posPage.text();
  check("POS terminal renders for owner A", posPage.status === 200 && posHtml.includes(`E2E Burger ${ts}`));

  const ordersPage = await fetch(`${APP}/orders?business=${businessA}`, { headers: { cookie: userA.cookie } });
  const ordersHtml = await ordersPage.text();
  check("orders list renders for owner A", ordersPage.status === 200 && /Order|#\d{4}/.test(ordersHtml));
} catch (error) {
  failed += 1;
  failures.push(`fatal: ${error?.message ?? error}`);
  console.error("\nFATAL:", error);
} finally {
  for (const biz of [businessA, businessB]) {
    if (biz) await got(`/rest/v1/businesses?id=eq.${biz}`, { method: "DELETE", service: true });
  }
  for (const user of [userA, userB]) {
    if (user?.id) await got(`/auth/v1/admin/users/${user.id}`, { method: "DELETE", service: true });
  }
}

console.log(`\n${"─".repeat(60)}`);
console.log(`Phase 8 POS E2E: ${passed} passed, ${failed} failed`);
if (failures.length > 0) {
  console.log("Failures:");
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
