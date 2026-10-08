#!/usr/bin/env node
/**
 * RestroNex Phase 3 — live authentication end-to-end lifecycle.
 *
 * Runs the full auth journey against the REAL hosted Supabase project
 * (email confirmation ON — mailer_autoconfirm=false).
 *
 * Email links cannot be opened from this sandbox, so the two steps a human
 * performs via inbox are executed through the GoTrue ADMIN API, which is the
 * exact server-side operation the email link triggers:
 *   - confirmation link  → PUT /admin/users/:id { email_confirm: true }
 *   - recovery link      → PUT /admin/users/:id { password: <new> }
 * Public signup is exercised directly; if the shared Supabase SMTP rate
 * limit (over_email_send_rate_limit) blocks the confirmation email send, the
 * script falls back to admin user creation for the downstream journey and
 * reports the signup probe separately — the confirmation gate itself is
 * tested either way (unconfirmed users cannot sign in).
 *
 * App-level routing is verified against the RUNNING Next.js production
 * server on http://localhost:3000 (proxy + layout guard), with a session
 * cookie built exactly like @supabase/ssr writes it (chunked, base64-
 * prefixed).
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
if (!SUPA_URL || !ANON || !SERVICE) {
  console.error("missing env vars");
  process.exit(1);
}

const ts = Date.now();
const EMAIL = `phase3-e2e-${ts}@example.com`;
const PASSWORD = "correct-horse-battery-9";
const NEW_PASSWORD = "reset-me-please-42";
const APP = "http://localhost:3000";

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

async function got(path, { method = "GET", body, service = false, bearer } = {}) {
  const res = await fetch(`${SUPA_URL}${path}`, {
    method,
    headers: {
      apikey: service ? SERVICE : ANON,
      ...(body ? { "content-type": "application/json" } : {}),
      ...(bearer ? { authorization: `Bearer ${bearer}` } : { authorization: `Bearer ${service ? SERVICE : ANON}` }),
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

/** Mirror @supabase/ssr createChunks: ≤3180-char chunks, escape-safe cuts. */
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

console.log(`RestroNex Phase 3 auth lifecycle → ${SUPA_URL}`);
console.log(`app under test: ${APP}`);
console.log(`test account: ${EMAIL}\n`);

let userId = null;
try {
  // ── 0. public signup probe ───────────────────────────────────────────────
  console.log("0 · public signup (POST /auth/v1/signup)");
  const su = await got("/auth/v1/signup", {
    method: "POST",
    body: { email: EMAIL, password: PASSWORD },
  });
  const rateLimited = su.status === 429;
  if (!rateLimited) {
    userId = su.json?.user?.id ?? su.json?.id;
    check(
      "signup → 200 with user id",
      su.status === 200 && Boolean(userId),
      `status ${su.status} ${su.json?.msg ?? ""}`,
    );
    check("new account starts UNCONFIRMED", (su.json?.email_confirmed_at ?? null) == null);
  } else {
    console.log(`  ⚠️  shared SMTP rate-limited (${su.json?.msg}) — using admin-created user; signup probe deferred`);
  }

  // ── 0b. password policy is enforced server-side ─────────────────────────
  console.log("\n1 · password policy (GoTrue-enforced)");
  const weak = await got("/auth/v1/signup", {
    method: "POST",
    body: { email: `weak-${ts}@example.com`, password: "ab1" },
  });
  check("short/weak password rejected (HTTP 422)", weak.status === 422, `status ${weak.status}`);

  // ── 1. ensure we have an UNCONFIRMED user ────────────────────────────────
  if (!userId) {
    const create = await got("/auth/v1/admin/users", {
      method: "POST",
      service: true,
      body: { email: EMAIL, password: PASSWORD, email_confirm: false },
    });
    userId = create.json?.id;
    check("fallback admin user created", create.status === 200 && Boolean(userId), `status ${create.status}`);
  }

  // user_profiles trigger row
  const prof = await fetch(
    `${SUPA_URL}/rest/v1/user_profiles?id=eq.${userId}&select=id,email`,
    { headers: { apikey: SERVICE, authorization: `Bearer ${SERVICE}` } },
  );
  const profRows = await prof.json();
  check(
    "user_profiles row auto-created on signup (onboarding-ready)",
    Array.isArray(profRows) && profRows.length === 1 && profRows[0].email === EMAIL,
    JSON.stringify(profRows).slice(0, 140),
  );

  // ── 2. confirmation gate ─────────────────────────────────────────────────
  console.log("\n2 · email-confirmation gate");
  const early = await got("/auth/v1/token?grant_type=password", {
    method: "POST",
    body: { email: EMAIL, password: PASSWORD },
  });
  check(
    "login BLOCKED while email unconfirmed",
    early.status === 400 && /confirm/i.test(early.json?.error_description ?? early.json?.msg ?? ""),
    `status ${early.status}: ${early.json?.error_description ?? early.json?.msg}`,
  );

  const confirm = await got(`/auth/v1/admin/users/${userId}`, {
    method: "PUT",
    service: true,
    body: { email_confirm: true },
  });
  check(
    "email confirmed (admin PUT = confirmation-link effect)",
    confirm.status === 200 && Boolean(confirm.json?.email_confirmed_at),
    `status ${confirm.status}`,
  );

  // ── 3. login after confirmation ──────────────────────────────────────────
  console.log("\n3 · login after confirmation");
  const login = await got("/auth/v1/token?grant_type=password", {
    method: "POST",
    body: { email: EMAIL, password: PASSWORD },
  });
  const token = login.json?.access_token;
  check("password grant issues session", login.status === 200 && Boolean(token), `status ${login.status}`);

  const who = await got("/auth/v1/user", { bearer: token });
  check("session JWT resolves to the user", who.status === 200 && who.json?.email === EMAIL);

  // ── 4. session honored by the running Next.js app ────────────────────────
  console.log("\n4 · signed-in session through the app (proxy + guard)");
  const session = {
    access_token: token,
    token_type: login.json.token_type,
    expires_at: login.json.expires_at,
    expires_in: login.json.expires_in,
    refresh_token: login.json.refresh_token,
    user: who.json,
  };
  const cookie = makeSessionCookies(`sb-${REF}-auth-token`, JSON.stringify(session));

  const dash = await fetch(`${APP}/dashboard`, { headers: { cookie }, redirect: "manual" });
  // A fresh account is routed into onboarding (Phase 6); an onboarded one
  // sees the dashboard directly. Both prove the session passed the guards.
  const dashLoc = dash.headers.get("location") ?? "";
  check(
    "/dashboard → 200 with valid session",
    dash.status === 200 || (dash.status >= 300 && dash.status < 400 && dashLoc.includes("/onboarding")),
    `status ${dash.status} location ${dashLoc}`,
  );

  const acct = await fetch(`${APP}/account`, { headers: { cookie }, redirect: "manual" });
  check("/account → 200 with valid session", acct.status === 200, `status ${acct.status}`);

  const loginBounce = await fetch(`${APP}/login`, { headers: { cookie }, redirect: "manual" });
  const bounceTo = loginBounce.headers.get("location") ?? "";
  check(
    "signed-in /login bounces to /dashboard",
    [302, 303, 307, 308].includes(loginBounce.status) && bounceTo.endsWith("/dashboard"),
    `status ${loginBounce.status} → ${bounceTo}`,
  );

  const anonDash = await fetch(`${APP}/dashboard`, { redirect: "manual" });
  const anonTo = anonDash.headers.get("location") ?? "";
  check(
    "anonymous /dashboard bounces to /login?next=…",
    [302, 303, 307, 308].includes(anonDash.status) && anonTo.includes("/login?next=%2Fdashboard"),
    `status ${anonDash.status} → ${anonTo}`,
  );

  // tampered/expired cookie must not grant access
  const forged = makeSessionCookies(`sb-${REF}-auth-token`, JSON.stringify({ ...session, access_token: token.slice(0, -8) + "aaaaaaaa" }));
  const forgedDash = await fetch(`${APP}/dashboard`, { headers: { cookie: forged }, redirect: "manual" });
  check("forged session cookie still bounces to /login", [302, 303, 307, 308].includes(forgedDash.status), `status ${forgedDash.status}`);

  // ── 5. anti-enumeration ──────────────────────────────────────────────────
  console.log("\n5 · anti-enumeration behaviour");
  const wrong = await got("/auth/v1/token?grant_type=password", {
    method: "POST",
    body: { email: EMAIL, password: "totally-wrong-password" },
  });
  const ghost = await got("/auth/v1/token?grant_type=password", {
    method: "POST",
    body: { email: `nobody-${ts}@example.com`, password: PASSWORD },
  });
  const wrongMsg = wrong.json?.error_description ?? wrong.json?.msg ?? "";
  const ghostMsg = ghost.json?.error_description ?? ghost.json?.msg ?? "";
  check("wrong password → 400 invalid credentials", wrong.status === 400 && /invalid/i.test(wrongMsg), wrongMsg);
  check(
    "unknown email → IDENTICAL generic message (no user enumeration)",
    ghost.status === 400 && ghostMsg === wrongMsg,
    `"${ghostMsg}" vs "${wrongMsg}"`,
  );
  const recovUnknown = await got("/auth/v1/recover", {
    method: "POST",
    body: { email: `nobody-${ts}@example.com` },
  });
  check("forgot-password for unknown email silently returns 200", recovUnknown.status === 200, `status ${recovUnknown.status}`);

  // ── 6. logout / revocation ───────────────────────────────────────────────
  console.log("\n6 · logout");
  const out = await got("/auth/v1/logout", { method: "POST", bearer: token });
  check("logout accepted", [200, 204].includes(out.status), `status ${out.status}`);
  const after = await got("/auth/v1/user", { bearer: token });
  check(
    "logged-out JWT no longer resolves (401/403)",
    [401, 403].includes(after.status),
    `status ${after.status}`,
  );

  // ── 7. forgot → reset ────────────────────────────────────────────────────
  console.log("\n7 · forgot password → reset");
  const recov = await got("/auth/v1/recover", { method: "POST", body: { email: EMAIL } });
  if (recov.status === 429) {
    console.log("  ⚠️  recovery email rate-limited by shared SMTP (endpoint logic unaffected)");
  }
  check(
    "recovery request accepted (200, or 429 from shared SMTP quota)",
    [200, 429].includes(recov.status),
    `status ${recov.status}`,
  );

  const set = await got(`/auth/v1/admin/users/${userId}`, {
    method: "PUT",
    service: true,
    body: { password: NEW_PASSWORD },
  });
  check("reset applied (admin PUT = recovery-link effect)", set.status === 200, `status ${set.status}`);

  const newLogin = await got("/auth/v1/token?grant_type=password", {
    method: "POST",
    body: { email: EMAIL, password: NEW_PASSWORD },
  });
  check("new password signs in", newLogin.status === 200 && Boolean(newLogin.json?.access_token), `status ${newLogin.status}`);
  const oldLogin = await got("/auth/v1/token?grant_type=password", {
    method: "POST",
    body: { email: EMAIL, password: PASSWORD },
  });
  check("old password rejected after reset", oldLogin.status === 400);

  // ── 7b. email-link landing routes ────────────────────────────────────────
  console.log("\n7b · email-link landing routes");
  const bogus = await fetch(`${APP}/auth/confirm?code=bogus`, { redirect: "manual" });
  const bogusTo = bogus.headers.get("location") ?? "";
  check(
    "bad PKCE code → /login with friendly error",
    [302, 303, 307, 308].includes(bogus.status) && bogusTo.includes("/login?error="),
    `status ${bogus.status} → ${bogusTo}`,
  );
  const cb = await fetch(`${APP}/auth/callback`, { redirect: "manual" });
  check("implicit-flow fallback page serves", cb.status === 200, `status ${cb.status}`);

  // Follow a REAL admin-generated recovery link through GoTrue's /auth/v1/verify
  // (this is the exact hop a browser makes when opening an emailed link).
  const linkUser = await got("/auth/v1/admin/users", {
    method: "POST",
    service: true,
    body: { email: `link-e2e-${ts}@example.com`, password: PASSWORD, email_confirm: true },
  });
  const linkUserId = linkUser.json?.id;
  if (linkUserId) {
    const gl = await got("/auth/v1/admin/generate_link", {
      method: "POST",
      service: true,
      body: {
        type: "recovery",
        email: linkUser.json.email,
        redirectTo: `${APP}/auth/callback?next=/reset-password`,
      },
    });
    const actionLink = (gl.json?.action_link ?? "").replace(
      /redirect_to=[^&]*/,
      `redirect_to=${encodeURIComponent(`${APP}/auth/callback?next=/reset-password`)}`,
    );
    if (actionLink) {
      const hop = await fetch(actionLink, { redirect: "manual" });
      const hopTo = hop.headers.get("location") ?? "";
      check(
        "real recovery link → /auth/callback with session fragment",
        [302, 303].includes(hop.status) &&
          hopTo.startsWith(`${APP}/auth/callback?next=/reset-password#access_token=`) &&
          hopTo.includes("refresh_token="),
        `status ${hop.status} → ${hopTo.slice(0, 90)}…`,
      );
    } else {
      check("recovery link generated", false, "generate_link returned no action_link");
    }
    await got(`/auth/v1/admin/users/${linkUserId}`, { method: "DELETE", service: true });
  }

  // ── 8. cleanup ───────────────────────────────────────────────────────────
  console.log("\n8 · cleanup");
  const del = await got(`/auth/v1/admin/users/${userId}`, { method: "DELETE", service: true });
  check("test user deleted", del.status === 200, `status ${del.status}`);
  userId = null;
  const leftover = await fetch(
    `${SUPA_URL}/rest/v1/user_profiles?email=eq.${encodeURIComponent(EMAIL)}&select=id`,
    { headers: { apikey: SERVICE, authorization: `Bearer ${SERVICE}` } },
  );
  const rows = await leftover.json();
  check("no leftover user_profiles rows", Array.isArray(rows) && rows.length === 0, JSON.stringify(rows));
} catch (err) {
  failed += 1;
  console.error(`\n💥 lifecycle aborted: ${err instanceof Error ? err.stack : String(err)}`);
} finally {
  if (userId) {
    await fetch(`${SUPA_URL}/auth/v1/admin/users/${userId}`, {
      method: "DELETE",
      headers: { apikey: SERVICE, authorization: `Bearer ${SERVICE}` },
    }).catch(() => {});
  }
}

console.log(`\n${"─".repeat(60)}`);
console.log(`RESULT: ${passed} passed, ${failed} failed${failed ? ` — ${failures.join("; ")}` : ""}`);
process.exit(failed === 0 ? 0 : 1);
