#!/usr/bin/env node
/**
 * RestroNex Phase 10 — payments, billing and receipts end-to-end.
 *
 * Requires: migrations through 20261009130000 pushed to the hosted project
 * and the app running on http://localhost:3000 (npm run start).
 *
 * Exercises the Phase 10 SECURITY DEFINER RPCs (the exact code the billing
 * server actions run) against the hosted database, plus the HTTP surface:
 *
 *   - permission matrix: waiter / cashier / outlet manager / other tenant
 *   - split + partial payments, cash change, retry with the same batch key
 *   - overpayment rejected; completion blocked until paid in full
 *   - refunds: permission, idempotency key, over-refund rejected
 *   - invoices: gap-free numbering, idempotent issue, void keeps the number
 *   - receipt reprints counted and audited
 *   - concurrency: parallel distinct payments never over-collect; parallel
 *     identical batch keys record exactly one payment
 *   - reconciliation balances; direct writes to paid fields are rejected
 *   - /payments, KOT and receipt pages render for authorised users only
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
const APP = "http://localhost:3000";
if (!SUPA_URL || !ANON || !SERVICE) {
  console.error("missing env vars");
  process.exit(1);
}
const REF = new URL(SUPA_URL).host.split(".")[0];

const ts = Date.now();
const people = {
  ownerA: { email: `pay-owner-a-${ts}@example.com`, password: "pay-alpha-77" },
  ownerB: { email: `pay-owner-b-${ts}@example.com`, password: "pay-bravo-66" },
  cashier: { email: `pay-cashier-${ts}@example.com`, password: "pay-cash-55" },
  waiter: { email: `pay-waiter-${ts}@example.com`, password: "pay-wait-44" },
  manager: { email: `pay-manager-${ts}@example.com`, password: "pay-mgr-333" },
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

async function addMembership(businessId, user, role, outletId) {
  const m = await got("/rest/v1/memberships", {
    method: "POST",
    service: true,
    prefer: "return=representation",
    body: { business_id: businessId, user_id: user.id, role, status: "active" },
  });
  const membershipId = m.json?.[0]?.id;
  if (!membershipId) throw new Error(`membership insert failed for ${role}: ${m.status} ${m.text.slice(0, 160)}`);
  await got("/rest/v1/membership_outlets", {
    method: "POST",
    service: true,
    body: { membership_id: membershipId, outlet_id: outletId },
  });
  return membershipId;
}

const batchKey = (label, n = "") => `pay-${label}-${ts}${n ? `-${n}` : ""}`;

// ── lifecycle ───────────────────────────────────────────────────────────────

console.log(`RestroNex Phase 10 payments lifecycle → ${SUPA_URL}`);
console.log(`app under test: ${APP}\n`);

const U = {};
let businessA = null;
let businessB = null;

try {
  console.log("0 · setup: tenants, outlet, menu and staff");
  for (const [key, person] of Object.entries(people)) U[key] = await createConfirmedUser(person);

  const rpcA = await rpc("create_business", {
    p_owner_id: U.ownerA.id, p_name: `Pay Tenant A ${ts}`, p_restaurant_type: "casual_dining",
    p_currency_code: "INR", p_timezone: "Asia/Kolkata",
  });
  const rpcB = await rpc("create_business", {
    p_owner_id: U.ownerB.id, p_name: `Pay Tenant B ${ts}`, p_restaurant_type: "cafe",
    p_currency_code: "INR", p_timezone: "Asia/Kolkata",
  });
  businessA = typeof rpcA.json === "string" ? rpcA.json : null;
  businessB = typeof rpcB.json === "string" ? rpcB.json : null;
  check("two tenants created", Boolean(businessA && businessB));

  await got("/rest/v1/outlets", {
    method: "POST", service: true, prefer: "return=representation",
    body: { business_id: businessA, name: "pay main", slug: `pay-a-${ts}`, code: `PA${String(ts).slice(-6)}`, currency_code: "INR", status: "active" },
  });
  const outletId = (await serviceSelect("outlets", `business_id=eq.${businessA}&select=id`))[0]?.id ?? null;
  await got("/rest/v1/outlets", {
    method: "POST", service: true, prefer: "return=representation",
    body: { business_id: businessB, name: "pay b", slug: `pay-b-${ts}`, code: `PB${String(ts).slice(-6)}`, currency_code: "INR", status: "active" },
  });
  const outletB = (await serviceSelect("outlets", `business_id=eq.${businessB}&select=id`))[0]?.id ?? null;
  check("outlets created", Boolean(outletId && outletB));

  const cat = await got("/rest/v1/menu_categories", {
    method: "POST", service: true, prefer: "return=representation",
    body: { business_id: businessA, name: `Pay E2E ${ts}` },
  });
  const categoryId = cat.json?.[0]?.id ?? null;
  const burger = (await got("/rest/v1/menu_items", {
    method: "POST", service: true, prefer: "return=representation",
    body: { business_id: businessA, category_id: categoryId, name: `Pay Burger ${ts}`, price_minor: 10000 },
  })).json?.[0]?.id;
  const fries = (await got("/rest/v1/menu_items", {
    method: "POST", service: true, prefer: "return=representation",
    body: { business_id: businessA, category_id: categoryId, name: `Pay Fries ${ts}`, price_minor: 5000 },
  })).json?.[0]?.id;
  check("menu fixtures created", Boolean(burger && fries));

  const cashierMem = await addMembership(businessA, U.cashier, "cashier", outletId);
  await addMembership(businessA, U.waiter, "waiter", outletId);
  await addMembership(businessA, U.manager, "outlet_manager", outletId);
  check("staff memberships created with outlet grants", Boolean(cashierMem));

  const seatOrder = async (ref) => {
    const res = await rpc("create_pos_order", {
      p_actor: U.ownerA.id,
      p_payload: {
        outlet_id: outletId, client_ref: ref, order_type: "takeaway",
        items: [
          { item_type: "product", product_id: burger, quantity: 1 },
          { item_type: "product", product_id: fries, quantity: 1 },
        ],
      },
    });
    return typeof res.json === "string" ? res.json : null;
  };
  const orderTotal = async (id) => (await serviceSelect("orders", `id=eq.${id}&select=total_minor`))[0]?.total_minor;

  // ── 1. order lifecycle + settlement gate ───────────────────────────────────
  console.log("\n1 · order lifecycle and the settlement gate");
  const order1 = await seatOrder(`pay-o1-${ts}`);
  check("takeaway order created", Boolean(order1));
  const T1 = await orderTotal(order1);
  check("order total is an integer number of minor units", Number.isInteger(T1) && T1 > 0, `total ${T1}`);
  for (const to of ["placed", "preparing", "ready"]) {
    await rpc("transition_order_status", { p_actor: U.ownerA.id, p_order_id: order1, p_to: to });
  }
  const unpaidComplete = await rpc("transition_order_status", { p_actor: U.ownerA.id, p_order_id: order1, p_to: "completed" });
  check("unpaid order cannot be completed", !okRpc(unpaidComplete.status), rpcError(unpaidComplete) || "it completed");

  // ── 2. permission matrix ──────────────────────────────────────────────────
  console.log("\n2 · permission matrix");
  const cashKey = batchKey("split");
  const waiterPay = await rpc("record_payments", {
    p_actor: U.waiter.id, p_order_id: order1, p_batch_key: batchKey("waiter"),
    p_lines: [{ method_key: "cash", amount_minor: 100, tendered_minor: null, reference: null }],
  });
  check("waiter (billing.view only) cannot record payments", !okRpc(waiterPay.status), `status ${waiterPay.status}`);

  const otherTenantPay = await rpc("record_payments", {
    p_actor: U.ownerB.id, p_order_id: order1, p_batch_key: batchKey("xtenant"),
    p_lines: [{ method_key: "cash", amount_minor: 100, tendered_minor: null, reference: null }],
  });
  check("owner of another tenant cannot pay this order", !okRpc(otherTenantPay.status), `status ${otherTenantPay.status}`);

  // ── 3. split + partial payments ───────────────────────────────────────────
  console.log("\n3 · split and partial payments");
  const cashPart = Math.floor(T1 / 2);
  const firstPay = await rpc("record_payments", {
    p_actor: U.cashier.id, p_order_id: order1, p_batch_key: cashKey,
    p_lines: [{ method_key: "cash", amount_minor: cashPart, tendered_minor: cashPart + 10000, reference: null }],
  });
  check("cashier records a partial cash payment with tender", okRpc(firstPay.status), rpcError(firstPay));
  const cashRows = await serviceSelect("payments", `order_id=eq.${order1}&select=amount_minor,tendered_minor,change_minor,method_key`);
  check("cash change is computed in minor units", cashRows[0]?.change_minor === 10000, JSON.stringify(cashRows[0]));

  const orderMid = (await serviceSelect("orders", `id=eq.${order1}&select=paid_minor,payment_status`))[0];
  check("partial payment leaves the order partial", orderMid?.payment_status === "partial" && orderMid?.paid_minor === cashPart,
    `${orderMid?.payment_status} ${orderMid?.paid_minor}`);

  const retry = await rpc("record_payments", {
    p_actor: U.cashier.id, p_order_id: order1, p_batch_key: cashKey,
    p_lines: [{ method_key: "cash", amount_minor: cashPart, tendered_minor: cashPart + 10000, reference: null }],
  });
  const afterRetry = await serviceSelect("payments", `order_id=eq.${order1}&select=id`);
  check("retry with the same batch key is idempotent", okRpc(retry.status) && retry.json?.duplicate === true && afterRetry.length === 1,
    `rows ${afterRetry.length}`);

  const overpay = await rpc("record_payments", {
    p_actor: U.cashier.id, p_order_id: order1, p_batch_key: batchKey("over"),
    p_lines: [{ method_key: "upi", amount_minor: T1, tendered_minor: null, reference: "UPI-OVER" }],
  });
  check("payment larger than the balance is rejected", !okRpc(overpay.status), rpcError(overpay) || "accepted");

  const rest1 = T1 - cashPart;
  const finish = await rpc("record_payments", {
    p_actor: U.cashier.id, p_order_id: order1, p_batch_key: batchKey("finish"),
    p_lines: [{ method_key: "upi", amount_minor: rest1, tendered_minor: null, reference: "UPI-REF-1" }],
  });
  check("remaining balance settled by UPI", okRpc(finish.status), rpcError(finish));
  const paidOrder = (await serviceSelect("orders", `id=eq.${order1}&select=paid_minor,payment_status`))[0];
  check("bill is paid in full", paidOrder?.payment_status === "paid" && paidOrder?.paid_minor === T1,
    `${paidOrder?.payment_status} ${paidOrder?.paid_minor}`);

  const completeNow = await rpc("transition_order_status", { p_actor: U.ownerA.id, p_order_id: order1, p_to: "completed" });
  check("paid order completes", okRpc(completeNow.status), rpcError(completeNow));

  // ── 4. refunds ────────────────────────────────────────────────────────────
  console.log("\n4 · refunds");
  const cashPayment = (await serviceSelect("payments", `order_id=eq.${order1}&method_key=eq.cash&select=id`))[0]?.id;
  const cashierRefund = await rpc("refund_payment", {
    p_actor: U.cashier.id, p_payment_id: cashPayment, p_amount_minor: 100, p_reason: "cashier try", p_client_ref: batchKey("rf-cashier"),
  });
  check("cashier (no refunds.process) cannot refund", !okRpc(cashierRefund.status), `status ${cashierRefund.status}`);

  const refundKey = batchKey("rf");
  const refund = await rpc("refund_payment", {
    p_actor: U.manager.id, p_payment_id: cashPayment, p_amount_minor: 5000, p_reason: "Guest returned fries", p_client_ref: refundKey,
  });
  check("outlet manager refunds part of a payment", okRpc(refund.status), rpcError(refund));
  const refundRetry = await rpc("refund_payment", {
    p_actor: U.manager.id, p_payment_id: cashPayment, p_amount_minor: 5000, p_reason: "Guest returned fries", p_client_ref: refundKey,
  });
  const refundRows = await serviceSelect("refunds", `payment_id=eq.${cashPayment}&select=id`);
  check("refund retry with the same key is idempotent", okRpc(refundRetry.status) && refundRows.length === 1, `rows ${refundRows.length}`);

  const overRefund = await rpc("refund_payment", {
    p_actor: U.manager.id, p_payment_id: cashPayment, p_amount_minor: T1, p_reason: "too much", p_client_ref: batchKey("rf-over"),
  });
  check("refund above the refundable amount is rejected", !okRpc(overRefund.status), rpcError(overRefund) || "accepted");

  const afterRefund = (await serviceSelect("orders", `id=eq.${order1}&select=paid_minor,refunded_minor,payment_status`))[0];
  check("refund moves net paid and refunded_minor in the ledger",
    afterRefund?.refunded_minor === 5000 && afterRefund?.paid_minor === T1 - 5000,
    JSON.stringify(afterRefund));

  // ── 5. invoices ───────────────────────────────────────────────────────────
  console.log("\n5 · invoices");
  const issue = await rpc("issue_invoice", { p_actor: U.cashier.id, p_order_id: order1 });
  const invoiceNo = issue.json?.invoice_no;
  check("cashier issues a numbered invoice", okRpc(issue.status) && /^INV/.test(invoiceNo ?? ""), rpcError(issue));
  const issueAgain = await rpc("issue_invoice", { p_actor: U.cashier.id, p_order_id: order1 });
  check("issuing again returns the same invoice", issueAgain.json?.duplicate === true && issueAgain.json?.invoice_no === invoiceNo);
  const invoiceId = issue.json?.invoice_id;

  const cashierVoid = await rpc("void_invoice", { p_actor: U.cashier.id, p_invoice_id: invoiceId, p_reason: "cashier void try" });
  check("cashier cannot void an invoice", !okRpc(cashierVoid.status), `status ${cashierVoid.status}`);
  const blockedVoid = await rpc("void_invoice", { p_actor: U.manager.id, p_invoice_id: invoiceId, p_reason: "Wrong customer name" });
  check("void is refused while the order still has net payments",
    !okRpc(blockedVoid.status) && /refund the recorded payments/i.test(blockedVoid.json?.message ?? ""), rpcError(blockedVoid) || "accepted");

  // clear every remaining net payment (read from the ledger, not hard-coded)
  const allPayments = await serviceSelect("payments", `order_id=eq.${order1}&select=id,amount_minor`);
  const allRefunds = await serviceSelect("refunds", `order_id=eq.${order1}&select=payment_id,amount_minor`);
  let clearOk = true;
  for (const pay of allPayments) {
    const refundedHere = allRefunds
      .filter((r) => r.payment_id === pay.id)
      .reduce((sum, r) => sum + r.amount_minor, 0);
    const left = pay.amount_minor - refundedHere;
    if (left <= 0) continue;
    const res = await rpc("refund_payment", {
      p_actor: U.manager.id, p_payment_id: pay.id, p_amount_minor: left,
      p_reason: "Invoice corrected after refund", p_client_ref: batchKey("rf-clear", pay.id.slice(0, 8)),
    });
    clearOk = clearOk && okRpc(res.status);
  }
  check("manager refunds the remaining balance", clearOk);
  const netAfterClear = (await serviceSelect("orders", `id=eq.${order1}&select=paid_minor`))[0]?.paid_minor;
  check("net paid is zero before voiding", netAfterClear === 0, `net ${netAfterClear}`);

  const voidRes = await rpc("void_invoice", { p_actor: U.manager.id, p_invoice_id: invoiceId, p_reason: "Wrong customer name" });
  const voided = (await serviceSelect("invoices", `id=eq.${invoiceId}&select=status,invoice_no`))[0];
  check("manager voids the invoice and the number is kept",
    okRpc(voidRes.status) && voided?.status === "void" && voided?.invoice_no === invoiceNo, rpcError(voidRes));

  // ── 6. receipts: prints and reprints ──────────────────────────────────────
  console.log("\n6 · receipt prints and reprints");
  const receiptId = (await serviceSelect("receipts", `order_id=eq.${order1}&kind=eq.payment&select=id&order=created_at.asc`))[0]?.id;
  const p1 = await rpc("record_receipt_print", { p_actor: U.cashier.id, p_receipt_id: receiptId });
  const p2 = await rpc("record_receipt_print", { p_actor: U.cashier.id, p_receipt_id: receiptId });
  check("prints are counted", p1.json === 1 && p2.json === 2, `${p1.json}, ${p2.json}`);
  const reprintAudit = await serviceSelect("audit_logs", `target_id=eq.${receiptId}&action=eq.receipt.reprinted&select=id`);
  check("the reprint is audited", reprintAudit.length >= 1);
  const waiterPrint = await rpc("record_receipt_print", { p_actor: U.waiter.id, p_receipt_id: receiptId });
  check("waiter cannot print receipts", !okRpc(waiterPrint.status), `status ${waiterPrint.status}`);

  // ── 7. concurrency: parallel distinct payments never over-collect ─────────
  console.log("\n7 · concurrency");
  const order2 = await seatOrder(`pay-o2-${ts}`);
  const T2 = await orderTotal(order2);
  const racers = await Promise.all(
    [1, 2, 3, 4, 5].map((n) =>
      rpc("record_payments", {
        p_actor: U.cashier.id, p_order_id: order2, p_batch_key: batchKey("race", n),
        p_lines: [{ method_key: "cash", amount_minor: T2, tendered_minor: null, reference: null }],
      }),
    ),
  );
  const winners = racers.filter((r) => okRpc(r.status));
  const rows2 = await serviceSelect("payments", `order_id=eq.${order2}&select=amount_minor`);
  const collected = rows2.reduce((sum, r) => sum + r.amount_minor, 0);
  check("exactly one of five parallel full payments wins", winners.length === 1, `${winners.length} winners`);
  check("parallel payments never collect more than the total", collected === T2, `collected ${collected} vs ${T2}`);

  // ── 8. concurrency: identical batch keys record exactly once ─────────────
  const order3 = await seatOrder(`pay-o3-${ts}`);
  const T3 = await orderTotal(order3);
  const sameKey = batchKey("same");
  const dupes = await Promise.all(
    [1, 2, 3, 4, 5].map(() =>
      rpc("record_payments", {
        p_actor: U.cashier.id, p_order_id: order3, p_batch_key: sameKey,
        p_lines: [{ method_key: "cash", amount_minor: 2500, tendered_minor: null, reference: null }],
      }),
    ),
  );
  const rows3 = await serviceSelect("payments", `order_id=eq.${order3}&select=id`);
  check("five parallel submits with one batch key record one payment",
    rows3.length === 1 && dupes.every((r) => okRpc(r.status)), `rows ${rows3.length}`);
  check("the order is not paid by the duplicate submit", (await serviceSelect("orders", `id=eq.${order3}&select=paid_minor`))[0]?.paid_minor === 2500);
  void T3;

  // ── 9. reconciliation ─────────────────────────────────────────────────────
  console.log("\n9 · reconciliation");
  const from = new Date(Date.now() - 86_400_000).toISOString();
  const to = new Date(Date.now() + 86_400_000).toISOString();
  const recon = await rpc("payment_reconciliation", { p_actor: U.manager.id, p_outlet_id: outletId, p_from: from, p_to: to });
  check("reconciliation balances for the outlet", okRpc(recon.status) && recon.json?.balanced === true, rpcError(recon));
  check("reconciliation nets refunds out of captured totals",
    recon.json?.totals?.net_minor === recon.json?.totals?.captured_minor - recon.json?.totals?.refunded_minor);
  const reconCashier = await rpc("payment_reconciliation", { p_actor: U.cashier.id, p_outlet_id: outletId, p_from: from, p_to: to });
  check("cashier without reports.view cannot run reconciliation", !okRpc(reconCashier.status), `status ${reconCashier.status}`);

  // ── 10. direct writes are rejected ────────────────────────────────────────
  console.log("\n10 · direct writes to money fields");
  const direct = await got(`/rest/v1/orders?id=eq.${order2}`, {
    method: "PATCH", service: true, body: { paid_minor: 1, payment_status: "paid" },
  });
  const stillPaid = (await serviceSelect("orders", `id=eq.${order2}&select=paid_minor`))[0]?.paid_minor;
  check("direct PATCH of paid fields is rejected by the ledger guard", !okRpc(direct.status) && stillPaid === T2,
    `status ${direct.status}, paid ${stillPaid}`);

  // ── 11. HTTP surface ──────────────────────────────────────────────────────
  console.log("\n11 · HTTP surface");
  const anon = await fetch(`${APP}/payments?business=${businessA}`, { redirect: "manual" });
  check("anonymous /payments redirects to login", anon.status === 307 || anon.status === 303, `got ${anon.status}`);

  const paymentsPage = await fetch(`${APP}/payments?business=${businessA}`, { headers: { cookie: U.manager.cookie } });
  const paymentsHtml = await paymentsPage.text();
  check("/payments renders for an outlet manager", paymentsPage.status === 200 && paymentsHtml.includes("Payment methods"), `status ${paymentsPage.status}`);

  const kot = await fetch(`${APP}/orders/${order1}/kot?business=${businessA}`, { headers: { cookie: U.cashier.cookie } });
  const kotHtml = await kot.text();
  check("KOT renders items without prices", kot.status === 200 && kotHtml.includes("Kitchen order ticket") && !kotHtml.includes("₹"),
    `status ${kot.status}`);

  const receiptPage = await fetch(`${APP}/payments/receipts/${receiptId}?business=${businessA}`, { headers: { cookie: U.cashier.cookie } });
  const receiptHtml = await receiptPage.text();
  check("receipt page renders for the cashier", receiptPage.status === 200 && receiptHtml.includes("Payment receipt"), `status ${receiptPage.status}`);

  const wrongTenant = await fetch(`${APP}/payments?business=${businessA}`, { headers: { cookie: U.ownerB.cookie } });
  const wrongHtml = await wrongTenant.text();
  check("owner B cannot see tenant A's payments page", !wrongHtml.includes("Payment methods"));
} catch (error) {
  failed += 1;
  failures.push(`fatal: ${error?.message ?? error}`);
  console.error("\nFATAL:", error);
} finally {
  for (const biz of [businessA, businessB]) {
    if (biz) await got(`/rest/v1/businesses?id=eq.${biz}`, { method: "DELETE", service: true });
  }
  for (const user of Object.values(U)) {
    if (user?.id) await got(`/auth/v1/admin/users/${user.id}`, { method: "DELETE", service: true });
  }
}

console.log(`\n${"─".repeat(60)}`);
console.log(`Phase 10 payments E2E: ${passed} passed, ${failed} failed`);
if (failures.length > 0) {
  console.log("Failures:");
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
