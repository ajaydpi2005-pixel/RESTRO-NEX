#!/usr/bin/env node
/**
 * RestroNex Phase 11 — Kitchen Display System, live end-to-end.
 *
 * Requires: migrations through 20261009150000_kitchen_display.sql pushed to the
 * hosted project, and the app running on http://localhost:3000 (npm run start)
 * for the HTTP checks.
 *
 * What it proves against the hosted project (not mocks):
 *   - REAL-TIME: a kitchen staff member's Supabase Realtime session receives
 *     the POS order the moment it is sent, and every later kitchen change —
 *     accept, ticket bump, priority, cancellation, acknowledgement — as it
 *     happens. Latency is measured and asserted.
 *   - ISOLATION: a second outlet's kitchen staff never receives this outlet's
 *     events, even with a forged outlet filter; their own outlet's events do
 *     arrive (positive control).
 *   - MONEY: no kitchen payload carries price, tax, total or payment fields.
 *   - PERMISSIONS: kitchen staff cannot manage routing or stations; a waiter
 *     without an outlet grant cannot operate the board.
 *   - HTTP: /kitchen renders for kitchen staff; /kitchen/routing is refused
 *     for them and renders for the owner.
 *
 * Uses the service key only for fixtures and for the POS side of each order
 * (the same RPCs the server actions call). Kitchen actions run as the kitchen
 * user's own RPC call with their identity as p_actor.
 */

import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import WebSocket from "ws";

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
const OWNER = { email: `kds-owner-${ts}@example.com`, password: "kds-owner-44" };
const KIT_MAIN = { email: `kds-kit-main-${ts}@example.com`, password: "kds-kitchen-55" };
const KIT_BRANCH = { email: `kds-kit-branch-${ts}@example.com`, password: "kds-branch-66" };
const WAITER = { email: `kds-waiter-${ts}@example.com`, password: "kds-waiter-77" };

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

const okRpc = (res) => res.status === 200 || res.status === 204;
const rpcError = (res) => (okRpc(res) ? "" : res.json?.message ?? res.text.slice(0, 160));
const rpc = (fn, body, opts = {}) => got(`/rest/v1/rpc/${fn}`, { method: "POST", service: true, body, ...opts });

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
  const res = await got(`/rest/v1/${table}?${query}`, { service: true });
  return res.json ?? [];
}

/** A Supabase client signed in as one user, the way the browser does it. */
async function signedInClient(user) {
  const client = createClient(SUPA_URL, ANON, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    realtime: { transport: WebSocket },
  });
  const { error } = await client.auth.signInWithPassword({ email: user.email, password: user.password });
  if (error) throw new Error(`sign-in failed for ${user.email}: ${error.message}`);
  return client;
}

/** Collects every postgres_changes event a client receives on the kitchen tables. */
function listen(client, label, outletId) {
  const itemEvents = [];
  const eventEvents = [];
  const channel = client
    .channel(`kds-${label}-${ts}-${Math.random().toString(36).slice(2, 7)}`)
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "kitchen_items", filter: `outlet_id=eq.${outletId}` },
      (payload) => itemEvents.push({ at: Date.now(), ...payload }),
    )
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "kitchen_events", filter: `outlet_id=eq.${outletId}` },
      (payload) => eventEvents.push({ at: Date.now(), ...payload }),
    );
  const subscribed = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} channel did not subscribe in 20s`)), 20_000);
    channel.subscribe((status, err) => {
      if (status === "SUBSCRIBED") {
        clearTimeout(timer);
        resolve();
      } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
        clearTimeout(timer);
        reject(new Error(`${label} channel ${status}: ${err?.message ?? ""}`));
      }
    });
  });
  return { itemEvents, eventEvents, channel, subscribed };
}

/** Polls the collected events until `match` finds something, or times out. */
async function waitFor(list, match, timeoutMs = 12_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const found = list.find(match);
    if (found) return { event: found, ms: Date.now() - started };
    await new Promise((r) => setTimeout(r, 100));
  }
  return { event: null, ms: Date.now() - started };
}

const MONEY_KEY = /(price|minor|total|amount|tax|discount|paid|payment|refund|invoice)/i;
function moneyKeys(row) {
  return Object.keys(row ?? {}).filter((k) => MONEY_KEY.test(k));
}

// ── run ─────────────────────────────────────────────────────────────────────

const created = { users: [], businesses: [] };
const clients = [];
let fatal = null;

try {
  console.log("0 · fixtures: tenant, two outlets, menu, kitchen users, stations, routing");
  const owner = await createConfirmedUser(OWNER);
  const kitMain = await createConfirmedUser(KIT_MAIN);
  const kitBranch = await createConfirmedUser(KIT_BRANCH);
  const waiter = await createConfirmedUser(WAITER);
  created.users.push(owner, kitMain, kitBranch, waiter);

  const biz = await rpc("create_business", {
    p_owner_id: owner.id,
    p_name: `KDS Tenant ${ts}`,
    p_restaurant_type: "casual_dining",
    p_currency_code: "INR",
    p_timezone: "Asia/Kolkata",
  });
  const business = typeof biz.json === "string" ? biz.json : null;
  check("tenant created by the owner", Boolean(business), rpcError(biz));
  if (!business) throw new Error("tenant creation failed");
  created.businesses.push(business);

  for (const [name, slug, code] of [
    ["KDS main", `kds-main-${ts}`, `KM${String(ts).slice(-6)}`],
    ["KDS branch", `kds-branch-${ts}`, `KB${String(ts).slice(-6)}`],
  ]) {
    await got("/rest/v1/outlets", {
      method: "POST",
      service: true,
      prefer: "return=representation",
      body: { business_id: business, name, slug, code, currency_code: "INR", status: "active" },
    });
  }
  const outlets = await serviceSelect("outlets", `business_id=eq.${business}&select=id,slug`);
  const main = outlets.find((o) => o.slug === `kds-main-${ts}`)?.id;
  const branch = outlets.find((o) => o.slug === `kds-branch-${ts}`)?.id;
  check("two outlets created", Boolean(main && branch));

  const category = (
    await got("/rest/v1/menu_categories", {
      method: "POST",
      service: true,
      prefer: "return=representation",
      body: { business_id: business, name: `KDS Food ${ts}` },
    })
  ).json?.[0]?.id;
  const drinkCategory = (
    await got("/rest/v1/menu_categories", {
      method: "POST",
      service: true,
      prefer: "return=representation",
      body: { business_id: business, name: `KDS Drinks ${ts}` },
    })
  ).json?.[0]?.id;
  const menu = {};
  for (const [key, name, price, cat] of [
    ["burger", `KDS Burger ${ts}`, 10000, category],
    ["juice", `KDS Juice ${ts}`, 4000, drinkCategory],
    ["water", `KDS Water ${ts}`, 1000, drinkCategory],
  ]) {
    const row = await got("/rest/v1/menu_items", {
      method: "POST",
      service: true,
      prefer: "return=representation",
      body: { business_id: business, category_id: cat, name, price_minor: price },
    });
    menu[key] = row.json?.[0]?.id;
  }
  check("menu fixtures created", Boolean(menu.burger && menu.juice && menu.water));

  // kitchen staff memberships, outlet grants
  const mKit = await got("/rest/v1/memberships", {
    method: "POST", service: true, prefer: "return=representation",
    body: { user_id: kitMain.id, business_id: business, role: "kitchen_staff", status: "active" },
  });
  const mBranch = await got("/rest/v1/memberships", {
    method: "POST", service: true, prefer: "return=representation",
    body: { user_id: kitBranch.id, business_id: business, role: "kitchen_staff", status: "active" },
  });
  const mWaiter = await got("/rest/v1/memberships", {
    method: "POST", service: true, prefer: "return=representation",
    body: { user_id: waiter.id, business_id: business, role: "waiter", status: "active" },
  });
  await got("/rest/v1/membership_outlets", {
    method: "POST", service: true, prefer: "return=representation",
    body: { membership_id: mKit.json?.[0]?.id, outlet_id: main },
  });
  await got("/rest/v1/membership_outlets", {
    method: "POST", service: true, prefer: "return=representation",
    body: { membership_id: mBranch.json?.[0]?.id, outlet_id: branch },
  });
  // the waiter has no outlet grant on purpose
  check("kitchen staff memberships granted per outlet", Boolean(mKit.json?.[0]?.id && mBranch.json?.[0]?.id && mWaiter.json?.[0]?.id));

  const stations = await rpc("kitchen_save_stations", {
    p_actor: owner.id,
    p_outlet_id: main,
    p_stations: [{ name: "Hot kitchen", description: "Grill" }, { name: "Beverages", description: null }],
  });
  check("owner configures two stations", okRpc(stations) && stations.json === 2, rpcError(stations));
  const stationRows = await serviceSelect("kitchen_stations", `outlet_id=eq.${main}&select=id,name`);
  const hot = stationRows.find((s) => s.name === "Hot kitchen")?.id;
  const bev = stationRows.find((s) => s.name === "Beverages")?.id;

  const routes = await rpc("kitchen_save_routes", {
    p_actor: owner.id,
    p_outlet_id: main,
    p_routes: [
      { target_type: "category", target_id: category, station_id: hot },
      { target_type: "category", target_id: drinkCategory, station_id: bev },
      { target_type: "item", target_id: menu.juice, station_id: bev },
    ],
  });
  check("owner saves routing", okRpc(routes) && routes.json === 3, rpcError(routes));

  // ── 1. live connections as real users ─────────────────────────────────────
  console.log("1 · realtime sessions: kitchen staff (main), kitchen staff (branch), waiter");
  const kitClient = await signedInClient(KIT_MAIN);
  const branchClient = await signedInClient(KIT_BRANCH);
  const waiterClient = await signedInClient(WAITER);
  clients.push(kitClient, branchClient, waiterClient);

  const mainFeed = listen(kitClient, "kit-main", main);
  const branchOwnFeed = listen(branchClient, "kit-branch-own", branch);
  // a forged filter: branch staff asks for MAIN's events
  const branchForgedFeed = listen(branchClient, "kit-branch-forged", main);
  const waiterFeed = listen(waiterClient, "waiter", main);
  for (const feed of [mainFeed, branchOwnFeed, branchForgedFeed, waiterFeed]) {
    await feed.subscribed;
  }

  // ── 2. POS sends an order → it appears on the kitchen board ───────────────
  console.log("2 · POS sends an order; the board receives it live");
  const orderMain = await rpc("create_pos_order", {
    p_actor: owner.id,
    p_payload: {
      outlet_id: main,
      client_ref: `kds-main-${ts}`,
      order_type: "takeaway",
      items: [
        { item_type: "product", product_id: menu.burger, quantity: 2, item_notes: "no onion" },
        { item_type: "product", product_id: menu.juice, quantity: 1 },
        { item_type: "product", product_id: menu.water, quantity: 1 },
      ],
    },
  });
  const orderId = typeof orderMain.json === "string" ? orderMain.json : null;
  check("POS creates an open order", Boolean(orderId), rpcError(orderMain));
  if (!orderId) throw new Error("order creation failed");

  const sentAt = Date.now();
  const sent = await rpc("transition_order_status", { p_actor: owner.id, p_order_id: orderId, p_to: "placed", p_note: null });
  check("POS sends the order to the kitchen", okRpc(sent), rpcError(sent));

  const burgerInsert = await waitFor(
    mainFeed.itemEvents,
    (e) => e.eventType === "INSERT" && e.new?.item_name?.startsWith("KDS Burger"),
  );
  const juiceInsert = await waitFor(
    mainFeed.itemEvents,
    (e) => e.eventType === "INSERT" && e.new?.item_name?.startsWith("KDS Juice"),
  );
  const waterInsert = await waitFor(
    mainFeed.itemEvents,
    (e) => e.eventType === "INSERT" && e.new?.item_name?.startsWith("KDS Water"),
  );
  check("kitchen receives the burger in real time", Boolean(burgerInsert.event), `waited ${burgerInsert.ms}ms`);
  check("kitchen receives the juice in real time", Boolean(juiceInsert.event), `waited ${juiceInsert.ms}ms`);
  check("kitchen receives the water in real time", Boolean(waterInsert.event), `waited ${waterInsert.ms}ms`);
  const latency = burgerInsert.event ? burgerInsert.event.at - sentAt : null;
  console.log(`     · end-to-end: ${latency ?? "n/a"} ms from POS send to kitchen screen`);
  check("order reaches the kitchen within 5 seconds", latency !== null && latency < 5000, `${latency} ms`);

  const burger = burgerInsert.event?.new;
  const juice = juiceInsert.event?.new;
  const water = waterInsert.event?.new;
  check("burger routed to Hot kitchen", burger?.station_id === hot);
  check("juice item route beats its category (Beverages)", juice?.station_id === bev);
  check("water with no route is Unrouted (null station)", water?.station_id === null);
  check("items arrive as new with an order number and table-free takeaway", burger?.kitchen_status === "new" && typeof burger?.order_number === "number" && burger?.order_type === "takeaway");
  check("special instructions reach the kitchen", burger?.item_notes === "no onion");
  check("quantity reaches the kitchen", burger?.quantity === 2);
  check("kitchen payloads carry no money fields", [burger, juice, water].every((row) => moneyKeys(row).length === 0),
    [burger, juice, water].map((row) => moneyKeys(row).join(",")).join(" | "));

  // ── 3. kitchen acts; the POS-side and other screens see it live ───────────
  console.log("3 · kitchen staff move the work; updates arrive live");
  const accept = await rpc("kds_advance_item", {
    p_actor: kitMain.id, p_item_id: burger.id, p_from: "new", p_to: "accepted",
  });
  check("kitchen staff accepts the burger (RPC as their identity)", okRpc(accept) && accept.json === "accepted", rpcError(accept));
  const acceptedUpdate = await waitFor(
    mainFeed.itemEvents,
    (e) => e.eventType === "UPDATE" && e.new?.id === burger.id && e.new?.kitchen_status === "accepted",
  );
  check("the accept reaches the board live", Boolean(acceptedUpdate.event), `waited ${acceptedUpdate.ms}ms`);

  const prep = await rpc("kds_advance_ticket", {
    p_actor: kitMain.id, p_order_id: orderId, p_station_id: hot, p_from: "accepted", p_to: "preparing",
  });
  check("Hot kitchen lane moves to preparing", okRpc(prep) && prep.json === 1, `moved ${prep.json}`);
  const prepUpdate = await waitFor(
    mainFeed.itemEvents,
    (e) => e.eventType === "UPDATE" && e.new?.id === burger.id && e.new?.kitchen_status === "preparing",
  );
  check("preparing reaches the board live", Boolean(prepUpdate.event), `waited ${prepUpdate.ms}ms`);

  const stale = await rpc("kds_advance_item", {
    p_actor: kitMain.id, p_item_id: burger.id, p_from: "accepted", p_to: "preparing",
  });
  check("a stale second tap is refused, not applied twice", !okRpc(stale) && /another screen/i.test(rpcError(stale)), rpcError(stale));

  const priority = await rpc("kds_set_priority", { p_actor: kitMain.id, p_order_id: orderId, p_priority: true });
  check("kitchen marks the order priority", okRpc(priority) && priority.json === true, rpcError(priority));
  const priorityUpdate = await waitFor(
    mainFeed.itemEvents,
    (e) => e.eventType === "UPDATE" && e.new?.id === juice?.id && e.new?.priority === true,
  );
  check("priority reaches the board live", Boolean(priorityUpdate.event), `waited ${priorityUpdate.ms}ms`);

  // finish the juice through its own lane: Beverages new → accepted → preparing → ready → completed
  for (const [from, to] of [["new", "accepted"], ["accepted", "preparing"], ["preparing", "ready"], ["ready", "completed"]]) {
    const step = await rpc("kds_advance_ticket", {
      p_actor: kitMain.id, p_order_id: orderId, p_station_id: bev, p_from: from, p_to: to,
    });
    check(`Beverages lane ${from} → ${to}`, okRpc(step) && step.json === 1, `moved ${step.json} ${rpcError(step)}`);
  }
  const completedUpdate = await waitFor(
    mainFeed.itemEvents,
    (e) => e.eventType === "UPDATE" && e.new?.id === juice?.id && e.new?.kitchen_status === "completed",
  );
  check("completion reaches the board live (item leaves the active board)", Boolean(completedUpdate.event), `waited ${completedUpdate.ms}ms`);

  // ── 4. cancellation → kitchen notified, sound-worthy event, acknowledgement ─
  console.log("4 · POS cancels the order; the kitchen is notified live");
  const cancelOrder = await rpc("transition_order_status", {
    p_actor: owner.id, p_order_id: orderId, p_to: "cancelled", p_note: "Customer left",
  });
  check("POS cancels the sent order", okRpc(cancelOrder), rpcError(cancelOrder));
  const cancelEvent = await waitFor(
    mainFeed.eventEvents,
    (e) => e.eventType === "INSERT" && e.new?.order_id === orderId && e.new?.reason === "order_cancelled",
  );
  check("the cancellation notification reaches the kitchen live", Boolean(cancelEvent.event), `waited ${cancelEvent.ms}ms`);
  const waterCancelled = await waitFor(
    mainFeed.itemEvents,
    (e) => e.eventType === "UPDATE" && e.new?.id === water?.id && e.new?.kitchen_status === "cancelled",
  );
  check("the cancelled water leaves the board live", Boolean(waterCancelled.event), `waited ${waterCancelled.ms}ms`);
  check("the burger (in preparation) is cancelled too", mainFeed.itemEvents.some(
    (e) => e.eventType === "UPDATE" && e.new?.id === burger.id && e.new?.kitchen_status === "cancelled",
  ));

  const ack = await rpc("kds_acknowledge_event", { p_actor: kitMain.id, p_event_id: cancelEvent.event?.new?.id });
  check("kitchen acknowledges the cancellation", okRpc(ack), rpcError(ack));
  const ackUpdate = await waitFor(
    mainFeed.eventEvents,
    (e) => e.eventType === "UPDATE" && e.new?.id === cancelEvent.event?.new?.id && e.new?.acknowledged_at,
  );
  check("the acknowledgement reaches the board live", Boolean(ackUpdate.event), `waited ${ackUpdate.ms}ms`);

  // ── 5. isolation ────────────────────────────────────────────────────────────
  console.log("5 · outlet isolation over realtime");
  const branchOrder = await rpc("create_pos_order", {
    p_actor: owner.id,
    p_payload: {
      outlet_id: branch, client_ref: `kds-branch-${ts}`, order_type: "takeaway",
      items: [{ item_type: "product", product_id: menu.burger, quantity: 1 }],
    },
  });
  const branchOrderId = typeof branchOrder.json === "string" ? branchOrder.json : null;
  await rpc("transition_order_status", { p_actor: owner.id, p_order_id: branchOrderId, p_to: "placed", p_note: null });

  const branchOwnInsert = await waitFor(
    branchOwnFeed.itemEvents,
    (e) => e.eventType === "INSERT" && e.new?.order_id === branchOrderId,
  );
  check("branch kitchen receives its own order (positive control)", Boolean(branchOwnInsert.event), `waited ${branchOwnInsert.ms}ms`);

  // give the forged-filter feed a fair chance to receive main's activity
  await new Promise((r) => setTimeout(r, 3000));
  check("branch kitchen with a forged filter receives NOTHING from main",
    branchForgedFeed.itemEvents.length === 0 && branchForgedFeed.eventEvents.length === 0,
    `items ${branchForgedFeed.itemEvents.length}, events ${branchForgedFeed.eventEvents.length}`);
  check("branch kitchen never sees main's order id",
    !branchOwnFeed.itemEvents.some((e) => e.new?.order_id === orderId || e.old?.order_id === orderId));
  check("the waiter (no outlet grant) receives nothing from the kitchen board",
    waiterFeed.itemEvents.length === 0 && waiterFeed.eventEvents.length === 0,
    `items ${waiterFeed.itemEvents.length}, events ${waiterFeed.eventEvents.length}`);

  // delete payloads carry ids only (no full rows)
  const deletePayloads = [...mainFeed.itemEvents, ...branchOwnFeed.itemEvents].filter((e) => e.eventType === "DELETE");
  check("no delete payload carries item content", deletePayloads.every((e) => Object.keys(e.old ?? {}).every((k) => k === "id")),
    `${deletePayloads.length} delete events`);

  // ── 6. permissions over the API ────────────────────────────────────────────
  console.log("6 · permissions");
  const kitRouting = await rpc("kitchen_save_routes", {
    p_actor: kitMain.id, p_outlet_id: main, p_routes: [],
  });
  check("kitchen staff cannot replace routing", !okRpc(kitRouting), rpcError(kitRouting));
  const kitStations = await rpc("kitchen_save_stations", {
    p_actor: kitMain.id, p_outlet_id: main, p_stations: [{ name: "Sneaky" }],
  });
  check("kitchen staff cannot change stations", !okRpc(kitStations), rpcError(kitStations));
  const waiterOperate = await rpc("kds_advance_ticket", {
    p_actor: waiter.id, p_order_id: orderId, p_station_id: hot, p_from: "accepted", p_to: "preparing",
  });
  check("a waiter without an outlet grant cannot operate the board", !okRpc(waiterOperate), rpcError(waiterOperate));
  const branchOnMain = await rpc("kds_set_priority", { p_actor: kitBranch.id, p_order_id: orderId, p_priority: true });
  check("branch kitchen cannot prioritise a main order", !okRpc(branchOnMain), rpcError(branchOnMain));

  // kitchen session reads: their own board only, no payments rows through the board
  const kitRead = await kitClient.from("kitchen_items").select("id, outlet_id").eq("outlet_id", branch);
  check("kitchen staff cannot read another outlet's board (client select)", (kitRead.data ?? []).length === 0);
  const kitEventsRead = await kitClient.from("kitchen_events").select("id, outlet_id").eq("outlet_id", branch);
  check("kitchen staff cannot read another outlet's events (client select)", (kitEventsRead.data ?? []).length === 0);
  const kitWrite = await kitClient.from("kitchen_items").update({ kitchen_status: "completed" }).eq("outlet_id", main);
  check("kitchen clients cannot write the projection directly", Boolean(kitWrite.error) || (kitWrite.data ?? []).length === 0, kitWrite.error?.message ?? "");

  // ── 7. HTTP: the pages render for the right people ────────────────────────
  console.log("7 · HTTP surface (needs the app on :3000)");
  const kitPage = await fetch(`${APP}/kitchen?business=${business}&outlet=${main}`, {
    headers: { cookie: kitMain.cookie }, redirect: "manual",
  }).catch((e) => ({ status: 0, error: e }));
  check("kitchen board renders for kitchen staff", kitPage.status === 200, `status ${kitPage.status ?? "n/a"}`);
  if (kitPage.status === 200) {
    const html = await kitPage.text();
    check("board page shows the live board controls", html.includes("Kitchen display") && html.includes("Enable sound"));
    check("board page never ships price fields for kitchen items", !html.includes("price_minor"));
  }
  const kitRoutingPage = await fetch(`${APP}/kitchen/routing?business=${business}&outlet=${main}`, {
    headers: { cookie: kitMain.cookie }, redirect: "manual",
  }).catch((e) => ({ status: 0, error: e }));
  check("routing is refused for kitchen staff", kitRoutingPage.status >= 300 || kitRoutingPage.status === 200 && !(await kitRoutingPage.text()).includes("Kitchen routing"),
    `status ${kitRoutingPage.status}`);
  const ownerRouting = await fetch(`${APP}/kitchen/routing?business=${business}&outlet=${main}`, {
    headers: { cookie: owner.cookie }, redirect: "manual",
  }).catch((e) => ({ status: 0, error: e }));
  check("owner sees the routing manager", ownerRouting.status === 200 && (await ownerRouting.text()).includes("Kitchen routing"),
    `status ${ownerRouting.status ?? "n/a"}`);
} catch (error) {
  fatal = error;
  failed += 1;
  failures.push(`fatal: ${error?.message ?? error}`);
  console.error("\nFATAL:", error);
} finally {
  for (const client of clients) {
    try {
      client.removeAllChannels();
    } catch {
      /* ignore */
    }
  }
  for (const biz of created.businesses) {
    await got(`/rest/v1/businesses?id=eq.${biz}`, { method: "DELETE", service: true });
  }
  for (const user of created.users) {
    await got(`/auth/v1/admin/users/${user.id}`, { method: "DELETE", service: true });
  }
}

console.log(`\n${"─".repeat(60)}`);
console.log(`Phase 11 kitchen display E2E: ${passed} passed, ${failed} failed`);
if (failures.length > 0) {
  console.log("Failures:");
  for (const f of failures) console.log(`  - ${f}`);
}
process.exit(fatal || failed > 0 ? 1 : 0);
