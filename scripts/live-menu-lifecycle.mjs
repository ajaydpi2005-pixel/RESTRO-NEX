#!/usr/bin/env node
/**
 * RestroNex Phase 7 — universal menu management end-to-end.
 *
 * Requires: migrations through 20261008170000 pushed to the hosted project
 * and the app running on http://localhost:3000 (npm run start).
 *
 * Two owner accounts (two tenants) exercise the real product surface:
 *   - server-action form POSTs for categories, products (+variants),
 *     modifier groups (+attach/detach), combos, outlet overrides, bulk ops
 *   - service-role REST to verify persisted rows
 *   - tenant-isolation attacks: owner B forging writes into tenant A's
 *     business and reading tenant A's menu rows with their own JWT
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
const OWNER_A = { email: `menu-owner-a-${ts}@example.com`, password: "menu-alpha-88" };
const OWNER_B = { email: `menu-owner-b-${ts}@example.com`, password: "menu-bravo-99" };

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

// ── helpers (same wire protocol as earlier lifecycle scripts) ───────────────

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


function getFormsFromHtml(html) {
  const forms = [];
  for (const block of html.match(/<form\b[\s\S]*?<\/form>/g) ?? []) {
    const actionFields = {};
    for (const m of block.matchAll(/<input type="hidden" name="([^"]+)"(?: value="([^"]*)")?\/>/g)) {
      const [, name, value] = m;
      if (name.startsWith("$ACTION") || name === "businessId" || name === "outletId" || name === "token") {
        actionFields[name] = (value ?? "").replace(/&quot;/g, '"');
      }
    }
    forms.push({ html: block, actionFields });
  }
  return forms;
}

/**
 * Menu pages render several action forms (create + per-row rename/delete,
 * product editor + overrides + attach + delete). Each form carries its own
 * $ACTION_REF; mixing refs across forms produces undecodable submissions.
 */
async function pickFormFields(pageUrl, cookie, ...needles) {
  const res = await fetch(pageUrl, { headers: { cookie }, redirect: "manual" });
  const html = await res.text();
  const forms = getFormsFromHtml(html);
  const form = forms.find((f) => needles.every((n) => f.html.includes(n)));
  return { fields: form?.actionFields ?? {}, html, status: res.status };
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

const extractId = (text, key) => {
  const m =
    text.match(new RegExp(`"${key}"[:\\\\]*"([0-9a-f-]{36})"`)) ??
    text.match(new RegExp(`${key}[=:]([0-9a-f-]{36})`));
  return m ? m[1] : null;
};

async function serviceSelect(table, query = "") {
  const { json } = await got(`/rest/v1/${table}?${query}`, { service: true });
  return Array.isArray(json) ? json : [];
}

// ── lifecycle ───────────────────────────────────────────────────────────────

console.log(`RestroNex Phase 7 universal menu lifecycle → ${SUPA_URL}`);
console.log(`app under test: ${APP}\n`);

let userA = null;
let userB = null;
let businessA = null;
let businessB = null;
let outletA = null;
let categoryId = null;
let productId = null;
let groupId = null;
let comboId = null;

try {
  console.log("0 · setup: two tenants with one outlet each");
  userA = await createConfirmedUser(OWNER_A);
  userB = await createConfirmedUser(OWNER_B);
  const rpcA = await got("/rest/v1/rpc/create_business", {
    method: "POST",
    service: true,
    body: { p_owner_id: userA.id, p_name: `Menu Tenant A ${ts}`, p_restaurant_type: "casual_dining", p_currency_code: "INR", p_timezone: "Asia/Kolkata" },
  });
  const rpcB = await got("/rest/v1/rpc/create_business", {
    method: "POST",
    service: true,
    body: { p_owner_id: userB.id, p_name: `Menu Tenant B ${ts}`, p_restaurant_type: "cafe", p_currency_code: "INR", p_timezone: "Asia/Kolkata" },
  });
  businessA = typeof rpcA.json === "string" ? rpcA.json : null;
  businessB = typeof rpcB.json === "string" ? rpcB.json : null;
  for (const [biz, tag] of [[businessA, "a"], [businessB, "b"]]) {
    await got("/rest/v1/outlets", {
      method: "POST",
      service: true,
      body: {
        business_id: biz,
        name: `menu-${tag} main`,
        slug: `menu-${tag}-${ts}`,
        code: `M${tag.toUpperCase()}${String(ts).slice(-6)}`,
        currency_code: "INR",
        status: "active",
      },
    });
  }
  outletA = (await serviceSelect("outlets", `business_id=eq.${businessA}&select=id`))[0]?.id ?? null;
  check("two tenants created with outlets", Boolean(businessA && businessB && outletA));

  // ── 1. categories + subcategories ─────────────────────────────────────────
  console.log("\n1 · categories");
  const catPage = await pickFormFields(`${APP}/menu/categories?business=${businessA}`, userA.cookie, `name="parentId"`, `name="name"`);
  const catPost = await postAction(`${APP}/menu/categories?business=${businessA}`, userA.cookie, catPage.fields, {
    businessId: businessA,
    name: `E2E Starters ${ts}`,
    parentId: "",
  });
  categoryId = extractId(catPost.text, "categoryId");
  check("category created via server action", Boolean(categoryId));

  const subPage = await pickFormFields(`${APP}/menu/categories?business=${businessA}`, userA.cookie, `name="parentId"`, `name="name"`);
  const subPost = await postAction(`${APP}/menu/categories?business=${businessA}`, userA.cookie, subPage.fields, {
    businessId: businessA,
    name: "Soups",
    parentId: categoryId,
  });
  const subId = extractId(subPost.text, "categoryId");
  const subRow = (await serviceSelect("menu_categories", `id=eq.${subId}&select=parent_id`))[0];
  check("subcategory persists under parent", subRow?.parent_id === categoryId);

  // ── 2. product with SKU, tax, variants ────────────────────────────────────
  console.log("\n2 · product + variants");
  const newPage = await pickFormFields(`${APP}/menu/products/new?business=${businessA}`, userA.cookie, `name="sku"`, `name="price"`);
  const prodPost = await postAction(`${APP}/menu/products/new?business=${businessA}`, userA.cookie, newPage.fields, {
    businessId: businessA,
    name: `E2E Biryani ${ts}`,
    description: "House special",
    categoryId,
    sku: `E2E-BIR-${ts}`,
    price: "249.50",
    taxRate: "5",
    foodType: "non_veg",
    isAvailable: "yes",
  });
  productId = extractId(prodPost.text, "productId");
  check("product created via server action", Boolean(productId));
  const prodRow = (await serviceSelect("menu_items", `id=eq.${productId}&select=*`))[0];
  check(
    "price stored in minor units, tax override persisted",
    prodRow?.price_minor === 24950 && Number(prodRow?.tax_rate_pct) === 5 && prodRow?.sku === `E2E-BIR-${ts}`,
    JSON.stringify(prodRow),
  );

  const editPage = await pickFormFields(`${APP}/menu/products/${productId}?business=${businessA}`, userA.cookie, `name="sku"`, `name="productId"`);
  const editPost = await postAction(`${APP}/menu/products/${productId}?business=${businessA}`, userA.cookie, editPage.fields, {
    businessId: businessA,
    productId,
    name: prodRow.name,
    description: "House special",
    categoryId,
    sku: prodRow.sku,
    price: "249.50",
    taxRate: "5",
    foodType: "non_veg",
    isAvailable: "yes",
    variantId: ["", ""],
    variantName: ["Half", "Full"],
    variantPrice: ["149.50", "249.50"],
    variantSku: ["", ""],
  });
  check("product save accepted", editPost.status === 200);
  const variants = await serviceSelect("product_variants", `product_id=eq.${productId}&select=name,price_minor`);
  check(
    "two variants persisted with exact prices",
    variants.length === 2 && variants.some((v) => v.price_minor === 14950) && variants.some((v) => v.price_minor === 24950),
    JSON.stringify(variants),
  );

  // ── 3. outlet pricing + availability ──────────────────────────────────────
  console.log("\n3 · outlet overrides");
  const overridePage = await pickFormFields(`${APP}/menu/products/${productId}?business=${businessA}`, userA.cookie, `name="overridePrice"`);
  const overridePost = await postAction(`${APP}/menu/products/${productId}?business=${businessA}`, userA.cookie, overridePage.fields, {
    businessId: businessA,
    productId,
    overrideOutletId: [outletA],
    overridePrice: ["219"],
    overrideAvailable: ["yes"],
  });
  check("override save accepted", overridePost.status === 200);
  const overrides = await serviceSelect("outlet_product_overrides", `product_id=eq.${productId}&select=*`);
  check(
    "outlet price override persisted (219.00)",
    overrides.length === 1 && overrides[0]?.price_minor === 21900,
    JSON.stringify(overrides),
  );

  // ── 4. modifier groups + attach ───────────────────────────────────────────
  console.log("\n4 · modifiers & add-ons");
  const modPage = await pickFormFields(`${APP}/menu/modifiers?business=${businessA}`, userA.cookie, `name="minSelected"`);
  const modPost = await postAction(`${APP}/menu/modifiers?business=${businessA}`, userA.cookie, modPage.fields, {
    businessId: businessA,
    name: `E2E Spice Level ${ts}`,
    minSelected: "1",
    maxSelected: "1",
    modifierId: ["", ""],
    modifierName: ["Mild", "Extra hot"],
    modifierPrice: ["0", "10"],
  });
  groupId = extractId(modPost.text, "groupId");
  check("modifier group created with options", Boolean(groupId));
  const modifiers = await serviceSelect("modifiers", `modifier_group_id=eq.${groupId}&select=name,price_minor`);
  check("two options persisted", modifiers.length === 2 && modifiers.some((m) => m.price_minor === 1000));

  const attachPage = await pickFormFields(`${APP}/menu/products/${productId}?business=${businessA}`, userA.cookie, `name="groupId"`);
  await postAction(`${APP}/menu/products/${productId}?business=${businessA}`, userA.cookie, attachPage.fields, {
    businessId: businessA,
    productId,
    groupId,
  });
  const links = await serviceSelect("product_modifier_groups", `product_id=eq.${productId}&select=*`);
  check("group attached to product", links.some((l) => l.modifier_group_id === groupId));

  // ── 5. combo ──────────────────────────────────────────────────────────────
  console.log("\n5 · combo");
  const comboPage = await pickFormFields(`${APP}/menu/combos/new?business=${businessA}`, userA.cookie, `name="comboProductId"`);
  const comboPost = await postAction(`${APP}/menu/combos/new?business=${businessA}`, userA.cookie, comboPage.fields, {
    businessId: businessA,
    name: `E2E Feast ${ts}`,
    description: "",
    sku: `E2E-FEAST-${ts}`,
    price: "399",
    taxRate: "",
    foodType: "non_veg",
    isAvailable: "yes",
    comboProductId: [productId],
    comboVariantId: [""],
    comboQuantity: ["2"],
  });
  comboId = extractId(comboPost.text, "comboId");
  check("combo created via server action", Boolean(comboId));
  const comboItems = await serviceSelect("combo_items", `combo_id=eq.${comboId}&select=product_id,quantity`);
  check("combo item persisted with quantity", comboItems.length === 1 && comboItems[0]?.quantity === 2);

  // ── 6. bulk availability ──────────────────────────────────────────────────
  console.log("\n6 · bulk operations");
  const listPage = await pickFormFields(`${APP}/menu/products?business=${businessA}`, userA.cookie, `name="bulkMode"`);
  await postAction(`${APP}/menu/products?business=${businessA}`, userA.cookie, listPage.fields, {
    businessId: businessA,
    bulkMode: "unavailable",
    productId: [productId],
  });
  const afterBulk = (await serviceSelect("menu_items", `id=eq.${productId}&select=is_available`))[0];
  check("bulk mark-unavailable persisted", afterBulk?.is_available === false);

  // ── 7. tenant-isolation attacks ───────────────────────────────────────────
  console.log("\n7 · tenant isolation");

  // owner B tries to create a product in tenant A's business
  const attackPage = await pickFormFields(`${APP}/menu/products/new?business=${businessA}`, userB.cookie, `name="sku"`, `name="price"`);
  const attackFields = Object.fromEntries(Object.entries(attackPage.fields).filter(([k]) => k.startsWith("$ACTION")));
  const attack = await postAction(`${APP}/menu/products/new?business=${businessA}`, userB.cookie, attackFields, {
    businessId: businessA,
    name: "Forged product",
    description: "",
    categoryId,
    sku: "",
    price: "1",
    taxRate: "",
    foodType: "veg",
    isAvailable: "yes",
  });
  const forged = await serviceSelect("menu_items", `business_id=eq.${businessA}&name=eq.Forged product&select=id`);
  check(
    "owner B cannot create products in tenant A",
    forged.length === 0 && /access|permission|found|invalid/i.test(attack.text) && attack.status !== 200,
    `status ${attack.status}`,
  );

  // owner B tries to delete tenant A's product
  const delAttack = await postAction(`${APP}/menu/products/${productId}?business=${businessA}`, userB.cookie, attackFields, {
    businessId: businessA,
    productId,
    bulkMode: "delete",
  });
  const stillAlive = await serviceSelect("menu_items", `id=eq.${productId}&select=id`);
  check(
    "owner B cannot delete tenant A's product",
    stillAlive.length === 1 && delAttack.status !== 200,
    `status ${delAttack.status}`,
  );

  // RLS read isolation with B's own JWT
  const bReads = await got(
    `/rest/v1/menu_items?business_id=eq.${businessA}&select=id`,
    { bearer: userB.token },
  );
  check("RLS hides tenant A menu rows from owner B", Array.isArray(bReads.json) && bReads.json.length === 0);

  // ── 8. dashboard reflects real data ───────────────────────────────────────
  console.log("\n8 · menu dashboard");
  const dash = await fetch(`${APP}/menu?business=${businessA}`, { headers: { cookie: userA.cookie } });
  const dashHtml = await dash.text();
  check("dashboard renders with live counts", dash.status === 200 && dashHtml.includes("E2E Starters"));
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
console.log(`Phase 7 menu E2E: ${passed} passed, ${failed} failed`);
if (failures.length > 0) {
  console.log("Failures:");
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
