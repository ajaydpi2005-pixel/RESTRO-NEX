#!/usr/bin/env node
/**
 * RestroNex Phase 9 — dining tables + floor management end-to-end.
 *
 * Requires: migrations through 20261009130000 pushed to the hosted project
 * and the app running on http://localhost:3000 (npm run start).
 *
 * Exercises the Phase 9 SECURITY DEFINER RPCs (the exact code the floor
 * server actions run) against the hosted database, plus the HTTP surface:
 *
 *   - floor / section / table CRUD with outlet-scoped authorisation
 *   - reservations, seating (create_pos_order occupies the table)
 *   - amend table swap, transfer, merge, split, complete (settlement gate)
 *   - concurrent double-seating: exactly one winner
 *   - outlet isolation (cross-outlet tables rejected; RLS read isolation)
 *   - service-role-only RPC grants
 *   - /floor renders for an authorised owner, redirects when anon;
 *     /pos?table= deep-link preselects the table
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
const OWNER_A = { email: `floor-owner-a-${ts}@example.com`, password: "floor-alpha-77" };
const OWNER_B = { email: `floor-owner-b-${ts}@example.com`, password: "floor-bravo-66" };
const WAITER = { email: `floor-waiter-${ts}@example.com`, password: "floor-wait-55" };

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

const okRpc = (status) => status === 200 || status === 204;
const rpcError = (res) => (okRpc(res.status) ? "" : res.json?.message ?? res.text.slice(0, 140));

async function serviceSelect(table, query = "") {
  const { json } = await got(`/rest/v1/${table}?${query}`, { service: true });
  return Array.isArray(json) ? json : [];
}

async function rpc(fn, body, { service = true, bearer } = {}) {
  return got(`/rest/v1/rpc/${fn}`, { method: "POST", service, bearer, body });
}

function seatPayload(outletId, tableId, productId, clientRef, quantity = 1) {
  return {
    outlet_id: outletId,
    client_ref: clientRef,
    order_type: "dine_in",
    table_id: tableId,
    items: [{ item_type: "product", product_id: productId, quantity }],
  };
}

async function tableRow(tableId) {
  return (await serviceSelect("dining_tables", `id=eq.${tableId}&select=*`))[0] ?? null;
}

// ── lifecycle ───────────────────────────────────────────────────────────────

console.log(`RestroNex Phase 9 floor + table lifecycle → ${SUPA_URL}`);
console.log(`app under test: ${APP}\n`);

let userA = null;
let userB = null;
let userC = null;
let membershipC = null;
let businessA = null;
let businessB = null;

try {
  console.log("0 · setup: tenants, outlets, menu, floor plan via Phase 9 RPCs");
  userA = await createConfirmedUser(OWNER_A);
  userB = await createConfirmedUser(OWNER_B);
  userC = await createConfirmedUser(WAITER);

  const rpcA = await rpc("create_business", {
    p_owner_id: userA.id, p_name: `Floor Tenant A ${ts}`, p_restaurant_type: "casual_dining",
    p_currency_code: "INR", p_timezone: "Asia/Kolkata",
  });
  const rpcB = await rpc("create_business", {
    p_owner_id: userB.id, p_name: `Floor Tenant B ${ts}`, p_restaurant_type: "cafe",
    p_currency_code: "INR", p_timezone: "Asia/Kolkata",
  });
  businessA = typeof rpcA.json === "string" ? rpcA.json : null;
  businessB = typeof rpcB.json === "string" ? rpcB.json : null;
  check("two tenants created", Boolean(businessA && businessB));

  // tenant A: two outlets (main + branch)
  for (const [name, slug, code] of [
    ["floor-a main", `floor-a-${ts}`, `FA${String(ts).slice(-6)}`],
    ["floor-a branch", `floor-a-br-${ts}`, `FB${String(ts).slice(-6)}`],
  ]) {
    await got("/rest/v1/outlets", {
      method: "POST", service: true, prefer: "return=representation",
      body: { business_id: businessA, name, slug, code, currency_code: "INR", status: "active" },
    });
  }
  const outletsA = await serviceSelect("outlets", `business_id=eq.${businessA}&select=id,slug&order=created_at`);
  const outletMain = outletsA.find((o) => o.slug === `floor-a-${ts}`)?.id ?? null;
  const outletBranch = outletsA.find((o) => o.slug === `floor-a-br-${ts}`)?.id ?? null;

  // tenant B: one outlet + table for cross-outlet tests
  await got("/rest/v1/outlets", {
    method: "POST", service: true, prefer: "return=representation",
    body: {
      business_id: businessB, name: "floor-b main", slug: `floor-b-${ts}`,
      code: `FC${String(ts).slice(-6)}`, currency_code: "INR", status: "active",
    },
  });
  const outletB = (await serviceSelect("outlets", `business_id=eq.${businessB}&select=id`))[0]?.id ?? null;
  check("three outlets created", Boolean(outletMain && outletBranch && outletB));

  const menuCat = await got("/rest/v1/menu_categories", {
    method: "POST", service: true, prefer: "return=representation",
    body: { business_id: businessA, name: `Floor E2E ${ts}` },
  });
  const categoryId = menuCat.json?.[0]?.id ?? null;
  const fries = await got("/rest/v1/menu_items", {
    method: "POST", service: true, prefer: "return=representation",
    body: { business_id: businessA, category_id: categoryId, name: `E2E Fries ${ts}`, price_minor: 5000 },
  });
  const productFries = fries.json?.[0]?.id ?? null;
  const burger = await got("/rest/v1/menu_items", {
    method: "POST", service: true, prefer: "return=representation",
    body: { business_id: businessA, category_id: categoryId, name: `E2E Burger ${ts}`, price_minor: 10000 },
  });
  const productBurger = burger.json?.[0]?.id ?? null;
  check("menu fixtures created", Boolean(productFries && productBurger));

  // default floors attached automatically to every new outlet
  const floorsMain = await serviceSelect("floors", `outlet_id=eq.${outletMain}&select=id,name`);
  const floorsBranch = await serviceSelect("floors", `outlet_id=eq.${outletBranch}&select=id,name`);
  check("new outlets get a default floor automatically", floorsMain.length === 1 && floorsBranch.length === 1);

  // floor plan through the Phase 9 RPCs (owner actor)
  const floorRes = await rpc("save_floor", {
    p_actor: userA.id, p_floor_id: null, p_outlet_id: outletMain, p_name: `E2E Level ${ts}`,
  });
  const floorId = typeof floorRes.json === "string" ? floorRes.json : null;
  check("save_floor creates a floor", okRpc(floorRes.status) && Boolean(floorId), rpcError(floorRes));

  const sectionRes = await rpc("save_section", {
    p_actor: userA.id, p_section_id: null, p_outlet_id: outletMain, p_floor_id: floorId, p_name: `E2E Hall ${ts}`,
  });
  const sectionId = typeof sectionRes.json === "string" ? sectionRes.json : null;
  check("save_section creates a section on that floor", okRpc(sectionRes.status) && Boolean(sectionId), rpcError(sectionRes));

  const tableLabels = {};
  for (const [label, capacity] of [["F1", 2], ["F2", 4], ["F3", 2], ["F4", 4]]) {
    const t = await rpc("save_table", {
      p_actor: userA.id, p_table_id: null, p_outlet_id: outletMain,
      p_section_id: sectionId, p_label: `${label}-${ts}`, p_capacity: capacity,
    });
    tableLabels[label] = typeof t.json === "string" ? t.json : null;
  }
  check("save_table creates four tables", Object.values(tableLabels).every(Boolean));

  // tenant B table for isolation tests (direct insert lands on default floor)
  const bSection = await got("/rest/v1/dining_sections", {
    method: "POST", service: true, prefer: "return=representation",
    body: { business_id: businessB, outlet_id: outletB, name: `B Hall ${ts}` },
  });
  const bTable = await got("/rest/v1/dining_tables", {
    method: "POST", service: true, prefer: "return=representation",
    body: {
      business_id: businessB, outlet_id: outletB, section_id: bSection.json?.[0]?.id,
      label: `B1-${ts}`, capacity: 2,
    },
  });
  const foreignTableId = bTable.json?.[0]?.id ?? null;
  check("tenant B foreign table created", Boolean(foreignTableId));

  // ── 1. configuration guards ───────────────────────────────────────────────
  console.log("\n1 · configuration guards");
  const floorByNonMember = await rpc("save_floor", {
    p_actor: userB.id, p_floor_id: null, p_outlet_id: outletMain, p_name: "Hack floor",
  });
  check("non-member cannot add a floor", !okRpc(floorByNonMember.status) && /not a member/i.test(floorByNonMember.json?.message ?? ""));

  const dupFloor = await rpc("save_floor", {
    p_actor: userA.id, p_floor_id: null, p_outlet_id: outletMain, p_name: `E2E Level ${ts}`,
  });
  check("duplicate floor name rejected", !okRpc(dupFloor.status) && /already exists/i.test(dupFloor.json?.message ?? ""));

  const sectionWrongFloor = await rpc("save_section", {
    p_actor: userA.id, p_section_id: null, p_outlet_id: outletMain,
    p_floor_id: floorsBranch[0]?.id, p_name: "Wrong floor",
  });
  check("section cannot hang off another outlet's floor", !okRpc(sectionWrongFloor.status));

  // un-granted waiter (member, no outlet grant) is rejected by the RPC itself
  membershipC = await got("/rest/v1/memberships", {
    method: "POST", service: true, prefer: "return=representation",
    body: { user_id: userC.id, business_id: businessA, role: "waiter", status: "active" },
  });
  const membershipCId = membershipC.json?.[0]?.id ?? null;
  const tableByUngranted = await rpc("save_table", {
    p_actor: userC.id, p_table_id: null, p_outlet_id: outletMain,
    p_section_id: sectionId, p_label: "WX", p_capacity: 2,
  });
  check("waiter without outlet grant cannot add tables", !okRpc(tableByUngranted.status) && /not assigned/i.test(tableByUngranted.json?.message ?? ""));

  await got("/rest/v1/membership_outlets", {
    method: "POST", service: true, prefer: "return=representation",
    body: { membership_id: membershipCId, outlet_id: outletMain },
  });
  const tableByGranted = await rpc("save_table", {
    p_actor: userC.id, p_table_id: null, p_outlet_id: outletMain,
    p_section_id: sectionId, p_label: `W1-${ts}`, p_capacity: 2,
  });
  check("waiter WITH outlet grant can add tables", okRpc(tableByGranted.status), rpcError(tableByGranted));
  const waiterTableId = typeof tableByGranted.json === "string" ? tableByGranted.json : null;

  const delFloorBlocked = await rpc("delete_floor", { p_actor: userA.id, p_floor_id: floorId });
  check("floor with sections cannot be deleted", !okRpc(delFloorBlocked.status) && /sections first/i.test(delFloorBlocked.json?.message ?? ""));
  const delSectionBlocked = await rpc("delete_section", { p_actor: userA.id, p_section_id: sectionId });
  check("section with tables cannot be deleted", !okRpc(delSectionBlocked.status) && /tables first/i.test(delSectionBlocked.json?.message ?? ""));

  // ── 2. reservations ───────────────────────────────────────────────────────
  console.log("\n2 · reservations");
  const f1 = tableLabels.F1;
  const reserve = await rpc("reserve_table", { p_actor: userA.id, p_table_id: f1, p_note: `Mr Rao ${ts}, 8pm` });
  const afterReserve = await tableRow(f1);
  check("reserve sets status + note", okRpc(reserve.status) && afterReserve?.status === "reserved" && afterReserve?.reservation_note === `Mr Rao ${ts}, 8pm`);
  const reserveAgain = await rpc("reserve_table", { p_actor: userA.id, p_table_id: f1, p_note: "again" });
  check("double reservation rejected", !okRpc(reserveAgain.status));
  const release = await rpc("release_table", { p_actor: userA.id, p_table_id: f1 });
  const afterRelease = await tableRow(f1);
  check("release restores availability", okRpc(release.status) && afterRelease?.status === "available" && afterRelease?.reservation_note === null);
  const releaseAgain = await rpc("release_table", { p_actor: userA.id, p_table_id: f1 });
  check("releasing a non-reserved table rejected", !okRpc(releaseAgain.status));

  // ── 3. seating occupies tables ────────────────────────────────────────────
  console.log("\n3 · seating (create_pos_order occupies the table)");
  const seat1 = await rpc("create_pos_order", {
    p_actor: userA.id, p_payload: seatPayload(outletMain, f1, productFries, `floor-seat1-${ts}`),
  });
  const order1 = typeof seat1.json === "string" ? seat1.json : null;
  const f1After = await tableRow(f1);
  check("seating occupies the table and links the order",
    okRpc(seat1.status) && f1After?.status === "occupied" && f1After?.current_order_id === order1, rpcError(seat1));

  const seatDup = await rpc("create_pos_order", {
    p_actor: userA.id, p_payload: seatPayload(outletMain, f1, productFries, `floor-seat2-${ts}`),
  });
  check("double seating rejected", !okRpc(seatDup.status) && /just taken/i.test(seatDup.json?.message ?? ""));
  check("no ghost order from rejected seating",
    (await serviceSelect("orders", `client_ref=eq.floor-seat2-${ts}&select=id`)).length === 0);

  const seatForeign = await rpc("create_pos_order", {
    p_actor: userA.id, p_payload: seatPayload(outletMain, foreignTableId, productFries, `floor-seat3-${ts}`),
  });
  check("foreign-outlet table rejected", !okRpc(seatForeign.status) && /belongs to this outlet/i.test(seatForeign.json?.message ?? ""));

  // ── 4. amend swaps tables ─────────────────────────────────────────────────
  console.log("\n4 · amend performs a guarded table swap");
  const f2 = tableLabels.F2;
  const amend = await rpc("amend_pos_order", {
    p_actor: userA.id, p_order_id: order1,
    p_payload: { table_id: f2, items: [{ item_type: "product", product_id: productFries, quantity: 1 }] },
  });
  const f1AfterAmend = await tableRow(f1);
  const f2AfterAmend = await tableRow(f2);
  check("amend swaps tables (old freed, new occupied)",
    okRpc(amend.status) && f1AfterAmend?.status === "available" && f2AfterAmend?.current_order_id === order1,
    rpcError(amend));

  // ── 5. cancel frees the table ─────────────────────────────────────────────
  console.log("\n5 · cancelling frees the table");
  const cancel = await rpc("transition_order_status", { p_actor: userA.id, p_order_id: order1, p_to: "cancelled" });
  const f2AfterCancel = await tableRow(f2);
  check("cancel releases the table", okRpc(cancel.status) && f2AfterCancel?.status === "available" && f2AfterCancel?.current_order_id === null);

  // ── 6. transfer ───────────────────────────────────────────────────────────
  console.log("\n6 · transfer_table");
  const seatT = await rpc("create_pos_order", {
    p_actor: userA.id, p_payload: seatPayload(outletMain, f1, productFries, `floor-xfer-${ts}`),
  });
  const orderX = typeof seatT.json === "string" ? seatT.json : null;
  const f3 = tableLabels.F3;
  const f4 = tableLabels.F4;
  const seatY = await rpc("create_pos_order", {
    p_actor: userA.id, p_payload: seatPayload(outletMain, f4, productFries, `floor-xfer-b-${ts}`),
  });
  const orderY = typeof seatY.json === "string" ? seatY.json : null;

  const xferOccupied = await rpc("transfer_table", { p_actor: userA.id, p_order_id: orderX, p_to_table_id: f4 });
  check("transfer onto occupied table rejected", !okRpc(xferOccupied.status) && /already occupied/i.test(xferOccupied.json?.message ?? ""));
  const xferForeign = await rpc("transfer_table", { p_actor: userA.id, p_order_id: orderX, p_to_table_id: foreignTableId });
  check("transfer to another outlet rejected", !okRpc(xferForeign.status) && /belongs to this outlet/i.test(xferForeign.json?.message ?? ""));

  const xfer = await rpc("transfer_table", { p_actor: userA.id, p_order_id: orderX, p_to_table_id: f3 });
  const f1AfterXfer = await tableRow(f1);
  const f3AfterXfer = await tableRow(f3);
  check("transfer moves the order", okRpc(xfer.status) && f1AfterXfer?.status === "available" && f3AfterXfer?.current_order_id === orderX, rpcError(xfer));

  const takeaway = await rpc("create_pos_order", {
    p_actor: userA.id,
    p_payload: {
      outlet_id: outletMain, client_ref: `floor-take-${ts}`, order_type: "takeaway",
      items: [{ item_type: "product", product_id: productFries, quantity: 1 }],
    },
  });
  const orderT = typeof takeaway.json === "string" ? takeaway.json : null;
  const xferTakeaway = await rpc("transfer_table", { p_actor: userA.id, p_order_id: orderT, p_to_table_id: f2 });
  check("takeaway orders cannot be transferred", !okRpc(xferTakeaway.status) && /dine-in/i.test(xferTakeaway.json?.message ?? ""));
  await rpc("transition_order_status", { p_actor: userA.id, p_order_id: orderT, p_to: "cancelled" });

  // ── 7. merge ──────────────────────────────────────────────────────────────
  console.log("\n7 · merge_tables");
  const keepTotalBefore = (await serviceSelect("orders", `id=eq.${orderX}&select=total_minor`))[0]?.total_minor;
  const mergeTotalBefore = (await serviceSelect("orders", `id=eq.${orderY}&select=total_minor`))[0]?.total_minor;

  const mergeSelf = await rpc("merge_tables", { p_actor: userA.id, p_keep_order_id: orderX, p_merge_order_id: orderX });
  check("merge into self rejected", !okRpc(mergeSelf.status));

  const merge = await rpc("merge_tables", { p_actor: userA.id, p_keep_order_id: orderX, p_merge_order_id: orderY });
  const mergedOrder = (await serviceSelect("orders", `id=eq.${orderY}&select=*`))[0];
  const f4AfterMerge = await tableRow(f4);
  const keptItems = await serviceSelect("order_items", `order_id=eq.${orderX}&select=id`);
  const keptTotals = (await serviceSelect("orders", `id=eq.${orderX}&select=total_minor`))[0];
  check("merge moves items and closes the merged order",
    okRpc(merge.status) && keptItems.length === 2 && mergedOrder?.status === "cancelled" && mergedOrder?.table_id === null,
    rpcError(merge));
  check("merge frees the merged table and re-prices the kept order",
    f4AfterMerge?.status === "available" && keptTotals?.total_minor === keepTotalBefore + mergeTotalBefore,
    `got ${keptTotals?.total_minor} ≠ ${keepTotalBefore}+${mergeTotalBefore}`);

  // ── 8. split ──────────────────────────────────────────────────────────────
  console.log("\n8 · split_order");
  const itemsX = await serviceSelect("order_items", `order_id=eq.${orderX}&select=id,line_total_minor&order=position`);
  const moveItem = itemsX[0]?.id;
  const totalBeforeSplit = (await serviceSelect("orders", `id=eq.${orderX}&select=total_minor`))[0]?.total_minor;

  const splitAll = await rpc("split_order", {
    p_actor: userA.id, p_order_id: orderX, p_item_ids: itemsX.map((i) => i.id), p_to_table_id: f2,
  });
  check("splitting every item rejected", !okRpc(splitAll.status) && /leave at least one/i.test(splitAll.json?.message ?? ""));

  const split = await rpc("split_order", {
    p_actor: userA.id, p_order_id: orderX, p_item_ids: [moveItem], p_to_table_id: f2,
  });
  const newOrder = typeof split.json === "string" ? split.json : null;
  const f2AfterSplit = await tableRow(f2);
  const sourceAfter = (await serviceSelect("orders", `id=eq.${orderX}&select=total_minor,status`))[0];
  const newAfter = (await serviceSelect("orders", `id=eq.${newOrder}&select=total_minor,status,order_type`))[0];
  const sourceItems = await serviceSelect("order_items", `order_id=eq.${orderX}&select=id`);
  check("split creates a new dine-in order on the target table",
    okRpc(split.status) && Boolean(newOrder) && f2AfterSplit?.current_order_id === newOrder
      && newAfter?.status === "open" && newAfter?.order_type === "dine_in" && sourceItems.length === 1,
    rpcError(split));
  check("split conserves the total across both orders",
    sourceAfter?.total_minor + newAfter?.total_minor === totalBeforeSplit,
    `${sourceAfter?.total_minor} + ${newAfter?.total_minor} ≠ ${totalBeforeSplit}`);

  // ── 9. complete_table + settlement gate ───────────────────────────────────
  console.log("\n9 · complete_table (settlement gate)");
  const completeUnpaid = await rpc("complete_table", { p_actor: userA.id, p_table_id: f2 });
  check("unpaid occupied table cannot be completed",
    !okRpc(completeUnpaid.status) && (/settle the bill/i.test(completeUnpaid.json?.message ?? "") || /must be ready/i.test(completeUnpaid.json?.message ?? "")));

  // walk the kept order (on F3) to ready, pay it, complete the table
  for (const to of ["placed", "preparing", "ready"]) {
    await rpc("transition_order_status", { p_actor: userA.id, p_order_id: orderX, p_to: to });
  }
  const readyUnpaid = await rpc("complete_table", { p_actor: userA.id, p_table_id: f3 });
  check("ready-but-unpaid table still blocked", !okRpc(readyUnpaid.status) && /settle the bill/i.test(readyUnpaid.json?.message ?? ""));

  // settle the bill through the real payment ledger (never by writing paid fields)
  const orderXRow = (await serviceSelect("orders", `id=eq.${orderX}&select=total_minor`))[0];
  const settle = await rpc("record_payments", {
    p_actor: userA.id,
    p_order_id: orderX,
    p_batch_key: `floor-settle-${ts}`,
    p_lines: [{ method_key: "cash", amount_minor: orderXRow.total_minor, tendered_minor: null, reference: null }],
  });
  check("bill settled through record_payments", okRpc(settle.status), rpcError(settle));
  const completePaid = await rpc("complete_table", { p_actor: userA.id, p_table_id: f3 });
  const f3AfterComplete = await tableRow(f3);
  const orderXFinal = (await serviceSelect("orders", `id=eq.${orderX}&select=status`))[0];
  check("paid + ready table completes the order and frees the table",
    okRpc(completePaid.status) && orderXFinal?.status === "completed" && f3AfterComplete?.status === "available",
    rpcError(completePaid));

  // reserved table completes to available
  await rpc("reserve_table", { p_actor: userA.id, p_table_id: f4, p_note: "tonight" });
  const completeReserved = await rpc("complete_table", { p_actor: userA.id, p_table_id: f4 });
  check("completing a reserved table releases it",
    okRpc(completeReserved.status) && (await tableRow(f4))?.status === "available");

  // ── 10. concurrency: exactly one of five parallel seatings wins ───────────
  console.log("\n10 · concurrency: five parallel seatings of one table");
  const raceTable = waiterTableId; // W1 is free
  const racers = await Promise.all(
    [1, 2, 3, 4, 5].map((n) =>
      rpc("create_pos_order", {
        p_actor: userA.id,
        p_payload: seatPayload(outletMain, raceTable, productFries, `floor-race-${ts}-${n}`),
      })),
  );
  const winners = racers.filter((r) => okRpc(r.status));
  const losers = racers.filter((r) => !okRpc(r.status));
  const raceOrders = await serviceSelect("orders", `client_ref=like.floor-race-${ts}-*&select=id`);
  const raceTableAfter = await tableRow(raceTable);
  check("exactly one concurrent seating wins", winners.length === 1, `${winners.length} winners`);
  check("all losers get the just-taken error", losers.every((r) => /just taken/i.test(r.json?.message ?? "")));
  check("race leaves exactly one order and one occupied link",
    raceOrders.length === 1 && raceTableAfter?.current_order_id === raceOrders[0]?.id);
  await rpc("transition_order_status", {
    p_actor: userA.id, p_order_id: raceOrders[0]?.id, p_to: "cancelled",
  });

  // ── 11. security: grants + read isolation ─────────────────────────────────
  console.log("\n11 · security: service-role-only RPCs, outlet isolation, RLS");
  const asUser = await rpc("save_floor", {
    p_actor: userA.id, p_floor_id: null, p_outlet_id: outletMain, p_name: "nope",
  }, { service: false, bearer: userA.token });
  check("authenticated user cannot call save_floor directly", !okRpc(asUser.status), `status ${asUser.status}`);
  const asUserXfer = await rpc("transfer_table", {
    p_actor: userA.id, p_order_id: orderX, p_to_table_id: f2,
  }, { service: false, bearer: userA.token });
  check("authenticated user cannot call transfer_table directly", !okRpc(asUserXfer.status), `status ${asUserXfer.status}`);

  const bTables = await got(`/rest/v1/dining_tables?outlet_id=eq.${outletMain}&select=id`, { bearer: userB.token });
  check("RLS hides tenant A tables from owner B", Array.isArray(bTables.json) && bTables.json.length === 0);
  const bFloors = await got(`/rest/v1/floors?outlet_id=eq.${outletMain}&select=id`, { bearer: userB.token });
  check("RLS hides tenant A floors from owner B", Array.isArray(bFloors.json) && bFloors.json.length === 0);
  const aTables = await got(`/rest/v1/dining_tables?outlet_id=eq.${outletMain}&select=id`, { bearer: userA.token });
  check("owner A can read own tables", Array.isArray(aTables.json) && aTables.json.length >= 5, `got ${aTables.json?.length}`);

  // ── 12. HTTP surface ──────────────────────────────────────────────────────
  console.log("\n12 · HTTP surface: /floor and /pos?table=");
  const anonFloor = await fetch(`${APP}/floor?business=${businessA}`, { redirect: "manual" });
  check("anon /floor redirects to login", anonFloor.status === 307 || anonFloor.status === 303, `got ${anonFloor.status}`);

  const floorPage = await fetch(`${APP}/floor?business=${businessA}`, { headers: { cookie: userA.cookie } });
  const floorHtml = await floorPage.text();
  check("/floor renders for owner A", floorPage.status === 200 && floorHtml.includes(`F1-${ts}`) && floorHtml.includes(`E2E Level ${ts}`));
  check("/floor shows the management panel to the owner", floorHtml.includes("Manage layout"));

  const posDeepLink = await fetch(`${APP}/pos?business=${businessA}&outlet=${outletMain}&table=${f2}`, {
    headers: { cookie: userA.cookie },
  });
  const posHtml = await posDeepLink.text();
  check("/pos?table= deep-link preselects the table",
    posDeepLink.status === 200 && posHtml.includes("Seated from the floor view"));

  const posPageNav = await fetch(`${APP}/pos?business=${businessA}`, { headers: { cookie: userA.cookie } });
  const navHtml = await posPageNav.text();
  check("app navigation links to the floor view", navHtml.includes('href="/floor'));

  // owner B (different tenant) must not see tenant A's tables on /floor
  const floorAsB = await fetch(`${APP}/floor?business=${businessA}`, { headers: { cookie: userB.cookie } });
  const floorAsBHtml = await floorAsB.text();
  check("owner B cannot view tenant A's floor", !floorAsBHtml.includes(`F1-${ts}`));
} catch (error) {
  failed += 1;
  failures.push(`fatal: ${error?.message ?? error}`);
  console.error("\nFATAL:", error);
} finally {
  for (const biz of [businessA, businessB]) {
    if (biz) await got(`/rest/v1/businesses?id=eq.${biz}`, { method: "DELETE", service: true });
  }
  for (const user of [userA, userB, userC]) {
    if (user?.id) await got(`/auth/v1/admin/users/${user.id}`, { method: "DELETE", service: true });
  }
}

console.log(`\n${"─".repeat(60)}`);
console.log(`Phase 9 floor E2E: ${passed} passed, ${failed} failed`);
if (failures.length > 0) {
  console.log("Failures:");
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
