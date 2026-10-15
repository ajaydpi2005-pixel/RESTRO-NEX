// Run with: node --test agent/print-agent.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import {
  AgentAuthError,
  blockedAddressReason,
  checkHost,
  normaliseBase,
  openAndSend,
  pollOnce,
  runJob,
} from "./print-agent.mjs";

const TOKEN = "ragt_" + "A".repeat(43);
const JOB = "11111111-2222-4333-8444-555555555555";

/** A loopback TCP server that records what it receives. */
function listen() {
  return new Promise((resolve) => {
    const received = [];
    const server = net.createServer((socket) => {
      socket.on("data", (chunk) => received.push(chunk));
    });
    server.listen(0, "127.0.0.1", () => {
      resolve({
        port: server.address().port,
        received: () => Buffer.concat(received),
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

/** A port that nothing listens on. */
async function closedPort() {
  const server = net.createServer();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  await new Promise((r) => server.close(r));
  return port;
}

const lanLookup = (addresses) => async () => addresses.map((address) => ({ address, family: 4 }));

// ── Address guard ─────────────────────────────────────────────────────────

test("refuses loopback, link-local (metadata), unspecified, multicast and reserved addresses", () => {
  for (const address of [
    "127.0.0.1",
    "127.8.9.10",
    "0.0.0.0",
    "169.254.169.254",
    "224.0.0.1",
    "240.0.0.1",
    "::1",
    "::",
    "fe80::1",
    "ff02::1",
    "::ffff:127.0.0.1",
    "::ffff:169.254.169.254",
  ]) {
    assert.notEqual(blockedAddressReason(address), null, `${address} should be refused`);
  }
});

test("allows private LAN addresses", () => {
  for (const address of ["192.168.1.50", "10.0.4.7", "172.16.9.9"]) {
    assert.equal(blockedAddressReason(address), null, `${address} should be allowed`);
  }
});

test("a numeric shorthand host is checked by what it resolves to, not by its text", async () => {
  // 2130706433 is 127.0.0.1 written as one number. Its resolution must be refused.
  const result = await checkHost("2130706433", lanLookup(["127.0.0.1"]));
  assert.equal(result.ok, false);
});

test("a host name is refused when ANY resolved address is blocked", async () => {
  const result = await checkHost("printer.lan", lanLookup(["192.168.1.9", "127.0.0.1"]));
  assert.equal(result.ok, false);
  assert.match(result.reason, /loopback/);
});

test("a host name that resolves only to LAN addresses connects to the checked address", async () => {
  const result = await checkHost("kitchen.lan", lanLookup(["192.168.1.9"]));
  assert.deepEqual(result, { ok: true, address: "192.168.1.9" });
});

test("localhost, metadata names, and unresolvable names are refused without connecting", async () => {
  assert.equal((await checkHost("localhost")).ok, false);
  assert.equal((await checkHost("api.localhost")).ok, false);
  assert.equal((await checkHost("metadata.google.internal")).ok, false);
  const failing = async () => {
    throw new Error("nxdomain");
  };
  assert.equal((await checkHost("nowhere.lan", failing)).ok, false);
  assert.equal((await checkHost("bad host!")).ok, false);
  assert.equal((await checkHost("")).ok, false);
});

// ── Socket ────────────────────────────────────────────────────────────────

test("sends the exact bytes to the printer port and closes", async () => {
  const server = await listen();
  try {
    const bytes = Buffer.from([0x1b, 0x40, 0x54, 0x65, 0x73, 0x74, 0x0a]);
    await openAndSend({ address: "127.0.0.1", port: server.port, bytes });
    // Give the server a moment to read the data before checking.
    await new Promise((r) => setTimeout(r, 100));
    assert.deepEqual(server.received(), bytes);
  } finally {
    await server.close();
  }
});

test("a connection test opens a socket and sends nothing", async () => {
  const server = await listen();
  try {
    await openAndSend({ address: "127.0.0.1", port: server.port, bytes: null });
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(server.received().length, 0);
  } finally {
    await server.close();
  }
});

test("a refused connection rejects with ECONNREFUSED", async () => {
  const port = await closedPort();
  await assert.rejects(
    openAndSend({ address: "127.0.0.1", port, bytes: Buffer.from("x") }),
    (error) => error.code === "ECONNREFUSED",
  );
});

// ── Jobs ──────────────────────────────────────────────────────────────────

const printJob = (over = {}) => ({
  job_id: JOB,
  operation: "print.document",
  attempt_no: 1,
  max_attempts: 5,
  host: "192.168.1.50",
  port: 9100,
  bytes_b64: Buffer.from([0x1b, 0x40, 0x41]).toString("base64"),
  payload_error: false,
  ...over,
});

test("a print job reaches the printer on the checked address and reports success", async () => {
  const server = await listen();
  try {
    const result = await runJob(printJob(), {
      checkHost: async () => ({ ok: true, address: "127.0.0.1" }),
      port: server.port,
    });
    assert.equal(result.outcome, "succeeded");
    assert.equal(result.job_id, JOB);
    await new Promise((r) => setTimeout(r, 100));
    assert.deepEqual(server.received(), Buffer.from([0x1b, 0x40, 0x41]));
  } finally {
    await server.close();
  }
});

test("a blocked host is failed and nothing is sent", async () => {
  let sent = false;
  const result = await runJob(printJob({ host: "127.0.0.1" }), {
    send: async () => {
      sent = true;
    },
  });
  assert.equal(result.outcome, "failed");
  assert.equal(result.error_code, "blocked_address");
  assert.equal(sent, false);
});

test("a refused print is retried; a refused connection test is failed at once", async () => {
  const port = await closedPort();
  const deps = { checkHost: async () => ({ ok: true, address: "127.0.0.1" }), port };
  const printed = await runJob(printJob(), deps);
  assert.equal(printed.outcome, "retry");
  assert.equal(printed.error_code, "refused");

  const tested = await runJob(printJob({ operation: "connection.test", bytes_b64: null }), deps);
  assert.equal(tested.outcome, "failed");
  assert.equal(tested.error_code, "refused");
});

test("bad payloads, wrong ports and unknown operations are failed without sending", async () => {
  let sent = false;
  const deps = {
    checkHost: async () => ({ ok: true, address: "192.168.1.50" }),
    send: async () => {
      sent = true;
    },
  };
  assert.equal((await runJob(printJob({ payload_error: true }), deps)).outcome, "failed");
  assert.equal((await runJob(printJob({ port: 80 }), deps)).outcome, "failed");
  assert.equal((await runJob(printJob({ operation: "message.send" }), deps)).outcome, "failed");
  assert.equal((await runJob(printJob({ bytes_b64: "" }), deps)).outcome, "failed");
  assert.equal(sent, false);
});

// ── Polling and reporting ─────────────────────────────────────────────────

test("a poll claims, runs and reports each job, and never logs the token", async () => {
  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push({ url, init });
    if (url.endsWith("/claim")) {
      return new Response(JSON.stringify({ ok: true, jobs: [printJob({ host: "127.0.0.1" })] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ ok: true, status: "ok" }), { status: 200 });
  };
  const logs = [];
  const handled = await pollOnce({
    base: "https://app.example.com",
    token: TOKEN,
    fetchImpl,
    log: (line) => logs.push(line),
    deps: { checkHost: async () => ({ ok: true, address: "127.0.0.1" }) },
  });
  assert.equal(handled, 1);
  assert.equal(requests[0].url, "https://app.example.com/api/integrations/agent/claim");
  assert.equal(requests[0].init.headers.authorization, `Bearer ${TOKEN}`);
  assert.equal(requests[1].url, "https://app.example.com/api/integrations/agent/report");
  // The token travels only in the header, never in the body.
  assert.ok(!String(requests[1].init.body).includes(TOKEN));
  assert.equal(JSON.parse(requests[1].init.body).job_id, JOB);
  assert.ok(logs.every((line) => !line.includes(TOKEN)));
});

test("a rejected token stops the agent with an auth error", async () => {
  const fetchImpl = async () => new Response("{}", { status: 401 });
  await assert.rejects(
    pollOnce({ base: "https://app.example.com", token: TOKEN, fetchImpl, log() {} }),
    AgentAuthError,
  );
});

test("the base URL must be https, or http on localhost only", () => {
  assert.equal(normaliseBase("https://app.example.com/"), "https://app.example.com");
  assert.equal(normaliseBase("http://localhost:3000"), "http://localhost:3000");
  assert.throws(() => normaliseBase("http://app.example.com"));
  assert.throws(() => normaliseBase("ftp://app.example.com"));
  assert.throws(() => normaliseBase(""));
});
