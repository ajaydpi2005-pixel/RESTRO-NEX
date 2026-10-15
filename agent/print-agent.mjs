#!/usr/bin/env node
/**
 * RestroNex on-site print agent. Plain Node.js ESM, zero dependencies, Node 18 or newer.
 *
 * It runs on a computer on the outlet's network. It asks the RestroNex server for jobs
 * over HTTPS, sends ESC/POS bytes to the printer on port 9100, and reports the result.
 * The server never connects to a printer, so the printer never needs a public address.
 *
 * Configuration (environment variables):
 *   RESTRO_URL     Base URL of the RestroNex app, for example https://app.example.com
 *                  (http is accepted only for localhost, for development).
 *   AGENT_TOKEN    The token shown once when the agent was created (starts with ragt_).
 *   POLL_SECONDS   Optional. How often to ask for jobs, 2–60 (default 5).
 *   BATCH          Optional. Jobs claimed per poll, 1–10 (default 5).
 *
 * Safety:
 *   • Every address a printer host resolves to is checked before connecting. Loopback,
 *     link-local (including the cloud metadata address), unspecified, multicast and
 *     reserved addresses are refused. Private LAN addresses are allowed.
 *   • The socket connects to the address that was checked, not to the name.
 *   • Each connect and write has a 4-second timeout.
 *   • Logs never include the token or the print bytes.
 *
 * Delivery is at least once. If a report cannot be saved, the job's lease expires and it
 * is claimed again, so a page could print twice. Staff can see this in the activity log.
 */

import net from "node:net";
import dns from "node:dns";
import { pathToFileURL } from "node:url";

export const PRINTER_PORT = 9100;
export const CONNECT_TIMEOUT_MS = 4000;
export const WRITE_TIMEOUT_MS = 4000;
export const MAX_PRINT_BYTES = 64 * 1024;
const REQUEST_TIMEOUT_MS = 15000;
const TOKEN_RE = /^ragt_[A-Za-z0-9_-]{40,}$/;
const HOST_RE =
  /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/i;
const BLOCKED_HOSTNAMES = ["localhost", "metadata.google.internal"];

// ── Address guard (mirrors src/modules/integrations/printer-guard.ts) ────────

function ipv4Parts(ip) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  return parts.every((p) => p >= 0 && p <= 255) ? parts : null;
}

export function blockedIPv4Reason(ip) {
  const p = ipv4Parts(ip);
  if (!p) return "not an IPv4 address";
  const [a, b] = p;
  if (a === 0) return "unspecified address";
  if (a === 127) return "loopback address";
  if (a === 169 && b === 254) return "link-local address";
  if (a >= 224 && a <= 239) return "multicast address";
  if (a >= 240) return "reserved address";
  return null;
}

export function blockedIPv6Reason(ip) {
  const lower = ip.toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (mapped) return blockedIPv4Reason(mapped[1]);
  if (lower === "::" || /^0+(:0+)*$/.test(lower)) return "unspecified address";
  if (lower === "::1" || /^0+(:0+)*:1$/.test(lower)) return "loopback address";
  if (/^fe[89ab][0-9a-f]:/.test(lower)) return "link-local address";
  if (lower.startsWith("ff")) return "multicast address";
  return null;
}

export function blockedAddressReason(address) {
  const family = net.isIP(address);
  if (family === 4) return blockedIPv4Reason(address);
  if (family === 6) return blockedIPv6Reason(address);
  return "not an IP address";
}

const defaultLookup = (name) => dns.promises.lookup(name, { all: true, verbatim: true });

/**
 * Checks a printer host. A name is resolved here, and every address it resolves to must
 * pass. Returns the address to connect to.
 */
export async function checkHost(host, lookup = defaultLookup) {
  const h = String(host ?? "")
    .trim()
    .toLowerCase();
  if (!h) return { ok: false, reason: "No printer address is set." };
  if (h.length > 253) return { ok: false, reason: "The printer address is too long." };
  if (BLOCKED_HOSTNAMES.includes(h) || h.endsWith(".localhost")) {
    return { ok: false, reason: "That printer address is not allowed." };
  }
  if (!net.isIP(h) && !HOST_RE.test(h)) {
    return { ok: false, reason: "The printer address is not a valid host name or IP address." };
  }

  let addresses;
  if (net.isIP(h)) {
    addresses = [{ address: h, family: net.isIP(h) }];
  } else {
    try {
      addresses = await lookup(h);
    } catch {
      return { ok: false, reason: "The printer address could not be resolved." };
    }
  }
  if (!addresses || addresses.length === 0) {
    return { ok: false, reason: "The printer address could not be resolved." };
  }
  for (const entry of addresses) {
    const reason = blockedAddressReason(entry.address);
    if (reason) return { ok: false, reason: `That printer address is a ${reason}.` };
  }
  return { ok: true, address: addresses[0].address };
}

// ── Socket ──────────────────────────────────────────────────────────────────

/**
 * Connects to an already-checked address and, when there are bytes, writes them and
 * closes. With no bytes it only checks that the printer accepts a connection.
 */
export function openAndSend({
  address,
  port = PRINTER_PORT,
  bytes = null,
  connectTimeoutMs = CONNECT_TIMEOUT_MS,
  writeTimeoutMs = WRITE_TIMEOUT_MS,
}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    const socket = net.connect({ host: address, port });

    const finish = (error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve();
    };
    const timeout = () => finish(Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }));

    timer = setTimeout(timeout, connectTimeoutMs);
    socket.once("error", (error) => finish(error));
    socket.once("connect", () => {
      clearTimeout(timer);
      if (!bytes) return finish(null);
      timer = setTimeout(timeout, writeTimeoutMs);
      socket.end(bytes, () => finish(null));
    });
  });
}

/** Maps a socket error to a short, safe code for the server log. */
export function networkErrorCode(error) {
  const code = error?.code ?? "";
  if (code === "ETIMEDOUT") return "timeout";
  if (code === "ECONNREFUSED") return "refused";
  if (code === "EHOSTUNREACH" || code === "ENETUNREACH") return "unreachable";
  return "network";
}

// ── Jobs ────────────────────────────────────────────────────────────────────

/**
 * Runs one job from the server and returns the report body for it.
 * `deps` exists for tests: checkHost, send, and port (the port the socket uses).
 */
export async function runJob(job, deps = {}) {
  const started = Date.now();
  const check = deps.checkHost ?? ((host) => checkHost(host));
  const send = deps.send ?? openAndSend;
  const port = deps.port ?? PRINTER_PORT;

  const report = (outcome, errorCode = null, errorMessage = null) => ({
    job_id: job.job_id,
    outcome,
    error_code: errorCode,
    error_message: errorMessage,
    duration_ms: Math.max(0, Date.now() - started),
  });

  if (job.payload_error) {
    return report("failed", "bad_payload", "The print job has no valid lines.");
  }
  if (job.port !== PRINTER_PORT) {
    return report("failed", "bad_port", "The job asked for an unexpected port.");
  }
  if (job.operation !== "connection.test" && job.operation !== "print.document") {
    return report("failed", "unsupported", "The agent does not handle this operation.");
  }

  const guard = await check(job.host);
  if (!guard.ok) return report("failed", "blocked_address", guard.reason);

  let bytes = null;
  if (job.operation === "print.document") {
    if (typeof job.bytes_b64 !== "string" || job.bytes_b64 === "") {
      return report("failed", "bad_payload", "The print job has no bytes.");
    }
    bytes = Buffer.from(job.bytes_b64, "base64");
    if (bytes.length === 0 || bytes.length > MAX_PRINT_BYTES) {
      return report("failed", "bad_payload", "The print job is empty or too large.");
    }
  }

  try {
    await send({ address: guard.address, port, bytes });
    return report("succeeded");
  } catch (error) {
    const code = networkErrorCode(error);
    // A connection test is a direct question: answer it now. A print job is retried.
    if (job.operation === "connection.test") {
      return report("failed", code, "The printer did not accept a connection.");
    }
    return report("retry", code, "The printer did not accept the job. It will be retried.");
  }
}

// ── Server calls ────────────────────────────────────────────────────────────

export class AgentAuthError extends Error {}

async function postJson(fetchImpl, url, token, body) {
  return fetchImpl(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
}

async function reportWithRetry(fetchImpl, base, token, body, attempts = 3) {
  for (let i = 1; i <= attempts; i++) {
    try {
      const res = await postJson(fetchImpl, `${base}/api/integrations/agent/report`, token, body);
      if (res.status === 401) throw new AgentAuthError("The agent token was rejected.");
      if (res.ok) return true;
      if (res.status >= 400 && res.status < 500) return false;
    } catch (error) {
      if (error instanceof AgentAuthError) throw error;
    }
    if (i < attempts) await new Promise((r) => setTimeout(r, 2000 * i));
  }
  return false;
}

/** One poll: claim due jobs, run each, report each. Returns how many jobs were handled. */
export async function pollOnce({
  base,
  token,
  batch = 5,
  fetchImpl = fetch,
  deps = {},
  log = console.log,
}) {
  const claim = await postJson(fetchImpl, `${base}/api/integrations/agent/claim`, token, {
    limit: batch,
  });
  if (claim.status === 401) {
    throw new AgentAuthError("The agent token was rejected. Create a new agent in Settings.");
  }
  if (!claim.ok) throw new Error(`claim failed with HTTP ${claim.status}`);

  const body = await claim.json();
  const jobs = Array.isArray(body.jobs) ? body.jobs : [];
  for (const job of jobs) {
    const result = await runJob(job, deps);
    const saved = await reportWithRetry(fetchImpl, base, token, result);
    const short = String(job.job_id).slice(0, 8);
    const detail = result.error_code ? ` (${result.error_code})` : "";
    log(
      `job ${short} ${job.operation} → ${result.outcome}${detail}${saved ? "" : " [report not saved]"}`,
    );
  }
  return jobs.length;
}

// ── Program ─────────────────────────────────────────────────────────────────

/** Accepts https, or http for localhost only. Returns the base URL without a trailing slash. */
export function normaliseBase(raw) {
  let url;
  try {
    url = new URL(String(raw ?? "").trim());
  } catch {
    throw new Error("RESTRO_URL is missing or not a valid URL.");
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
    throw new Error("RESTRO_URL must use https:// (http is allowed for localhost only).");
  }
  return url.origin;
}

const clamp = (n, lo, hi, fallback) => {
  const v = Number(n);
  return Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.trunc(v))) : fallback;
};

export async function main(env = process.env) {
  let base;
  try {
    base = normaliseBase(env.RESTRO_URL);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
  const token = env.AGENT_TOKEN ?? "";
  if (!TOKEN_RE.test(token)) {
    console.error("AGENT_TOKEN is missing or malformed. Copy it again from Settings.");
    process.exit(1);
  }
  const pollMs = clamp(env.POLL_SECONDS, 2, 60, 5) * 1000;
  const batch = clamp(env.BATCH, 1, 10, 5);

  console.log(`RestroNex print agent started. Polling ${base} every ${pollMs / 1000}s.`);
  let delay = pollMs;
  let running = true;
  process.on("SIGINT", () => {
    running = false;
    console.log("Print agent stopping.");
    process.exit(0);
  });

  while (running) {
    try {
      await pollOnce({ base, token, batch });
      delay = pollMs;
    } catch (error) {
      if (error instanceof AgentAuthError) {
        console.error(error.message);
        process.exit(2);
      }
      // Back off on errors, up to one minute. Never print the token or the response body.
      console.error(`poll failed: ${error.message}`);
      delay = Math.min(delay * 2, 60_000);
    }
    await new Promise((r) => setTimeout(r, delay));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
