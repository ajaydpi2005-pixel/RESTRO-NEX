import { createHmac, randomBytes } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  decryptCredentials,
  encryptCredentials,
  CredentialDecryptError,
  parseEncryptionKey,
  secretHint,
} from "./crypto";
import {
  metaEventIds,
  secretsMatch,
  twilioSignature,
  verifyMeta,
  verifyRazorpay,
  verifySvix,
  verifyTwilio,
} from "./signatures";
import { blockedAddressReason, guardPrinterHost } from "./printer-guard";
import { buildEscPosDocument, wrapLine, toPrinterAscii } from "./escpos";
import { createAdapterRegistry, parsePrintPayload } from "./adapters";
import {
  planJob,
  runWorkerBatch,
  type ClaimedJob,
  type RuntimeAccount,
  type WorkerDeps,
} from "./worker";
import { validateSave, type SaveInput } from "./schemas";
import { PROVIDER_CATALOG, findProvider } from "./catalog";
import { buildAccountingCsv, ACCOUNTING_HEADER } from "./accounting";

const ACCOUNT_ID = "5c3d2a4e-1b2c-4d5e-8f90-123456789abc";
const OTHER_ACCOUNT_ID = "6d4e3b5f-2c3d-4e6f-9a01-23456789abcd";
const BIZ = "cccccccc-0000-0000-0000-000000000001";
const OUTLET = "aaaaaaaa-1111-0000-0000-000000000002";
const KEY = randomBytes(32);

// ── Crypto ────────────────────────────────────────────────────────────────

describe("credential encryption (AES-256-GCM, account id as AAD)", () => {
  it("round-trips credentials for the same account", () => {
    const creds = { key_id: "rzp_test_123", key_secret: "s3cret-value-long" };
    const ct = encryptCredentials(creds, ACCOUNT_ID, KEY);
    expect(decryptCredentials(ct, ACCOUNT_ID, KEY)).toEqual(creds);
  });

  it("emits the format the database accepts: v1 with three base64 parts", () => {
    const ct = encryptCredentials({ a: "b" }, ACCOUNT_ID, KEY);
    expect(ct).toMatch(/^v1:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/);
    expect(ct).not.toContain("s3cret");
  });

  it("refuses a ciphertext moved to another account (AAD binding)", () => {
    const ct = encryptCredentials({ a: "b" }, ACCOUNT_ID, KEY);
    expect(() => decryptCredentials(ct, OTHER_ACCOUNT_ID, KEY)).toThrow(CredentialDecryptError);
  });

  it("refuses a tampered ciphertext and does not say which check failed", () => {
    const ct = encryptCredentials({ a: "b" }, ACCOUNT_ID, KEY);
    const parts = ct.split(":");
    const body = Buffer.from(parts[3] ?? "", "base64");
    body[0] = (body[0] ?? 0) ^ 0xff;
    const tampered = [parts[0], parts[1], parts[2], body.toString("base64")].join(":");
    expect(() => decryptCredentials(tampered, ACCOUNT_ID, KEY)).toThrow(
      "Stored credentials could not be read.",
    );
  });

  it("refuses a different key", () => {
    const ct = encryptCredentials({ a: "b" }, ACCOUNT_ID, KEY);
    expect(() => decryptCredentials(ct, ACCOUNT_ID, randomBytes(32))).toThrow(
      CredentialDecryptError,
    );
  });

  it("requires a 32-byte base64 key", () => {
    expect(() => parseEncryptionKey(undefined)).toThrow(/not set/);
    expect(() => parseEncryptionKey(randomBytes(16).toString("base64"))).toThrow(
      /exactly 32 bytes/,
    );
    expect(parseEncryptionKey(randomBytes(32).toString("base64"))).toHaveLength(32);
  });

  it("shows only a short hint for secrets", () => {
    expect(secretHint("abcdefghijklmnop")).toBe("…mnop");
    expect(secretHint("short")).toBe("set");
  });

  it("uses a fresh IV each time, so equal plaintexts give different ciphertexts", () => {
    const a = encryptCredentials({ a: "b" }, ACCOUNT_ID, KEY);
    const b = encryptCredentials({ a: "b" }, ACCOUNT_ID, KEY);
    expect(a).not.toBe(b);
  });
});

// ── Webhook signatures ────────────────────────────────────────────────────

describe("webhook signatures", () => {
  it("verifies Svix (Resend) against the published test vector", () => {
    const result = verifySvix({
      rawBody: '{"test": 2432232314}',
      id: "msg_p5jXN8AQM9LWM0D4loKWxJek",
      timestamp: "1614265330",
      signatureHeader: "v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=",
      secret: "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw",
      now: 1614265330 * 1000,
    });
    expect(result).toMatchObject({ ok: true, eventId: "msg_p5jXN8AQM9LWM0D4loKWxJek" });
  });

  it("rejects Svix timestamps outside the five-minute tolerance", () => {
    const result = verifySvix({
      rawBody: '{"test": 2432232314}',
      id: "msg_p5jXN8AQM9LWM0D4loKWxJek",
      timestamp: "1614265330",
      signatureHeader: "v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=",
      secret: "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw",
      now: (1614265330 + 6 * 60) * 1000,
    });
    expect(result).toMatchObject({ ok: false, reason: "timestamp outside tolerance" });
  });

  it("accepts a valid signature among several and rejects a changed body", () => {
    const base = {
      id: "msg_p5jXN8AQM9LWM0D4loKWxJek",
      timestamp: "1614265330",
      secret: "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw",
      now: 1614265330 * 1000,
    };
    const multi = verifySvix({
      ...base,
      rawBody: '{"test": 2432232314}',
      signatureHeader: "v1,AAAA v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=",
    });
    expect(multi.ok).toBe(true);
    const changed = verifySvix({
      ...base,
      rawBody: '{"test": 1}',
      signatureHeader: "v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=",
    });
    expect(changed.ok).toBe(false);
  });

  it("verifies Razorpay HMAC-SHA256 over the raw body and refuses a wrong secret", () => {
    const body = '{"event":"payment.captured","payload":{}}';
    const sig = createHmac("sha256", "whsec-test").update(body).digest("hex");
    expect(
      verifyRazorpay({ rawBody: body, signature: sig, eventId: "evt_1", secret: "whsec-test" }),
    ).toEqual({ ok: true, eventId: "evt_1", eventType: "payment.captured" });
    expect(
      verifyRazorpay({ rawBody: body, signature: sig, eventId: "evt_1", secret: "other" }).ok,
    ).toBe(false);
    expect(
      verifyRazorpay({ rawBody: body, signature: null, eventId: "evt_1", secret: "whsec-test" }).ok,
    ).toBe(false);
  });

  it("verifies WhatsApp (Meta) sha256 signatures and extracts message ids", () => {
    const body = JSON.stringify({
      entry: [{ changes: [{ value: { messages: [{ id: "wamid.ABC" }] } }] }],
    });
    const sig = "sha256=" + createHmac("sha256", "app-secret").update(body).digest("hex");
    expect(verifyMeta({ rawBody: body, signatureHeader: sig, secret: "app-secret" }).ok).toBe(true);
    expect(verifyMeta({ rawBody: body, signatureHeader: sig, secret: "wrong" }).ok).toBe(false);
    expect(
      verifyMeta({
        rawBody: body,
        signatureHeader: sig.replace("sha256=", ""),
        secret: "app-secret",
      }).ok,
    ).toBe(false);
    expect(metaEventIds(body)).toEqual(["wamid.ABC"]);
    expect(metaEventIds("not json")).toEqual([]);
  });

  it("computes Twilio's documented signature example (URL, auth token 12345, sorted params)", () => {
    // Vector from Twilio's webhook security example, with the caller +12349013030.
    const sig = twilioSignature(
      "https://mycompany.com/myapp.php?foo=1&bar=2",
      {
        CallSid: "CA1234567890ABCDE",
        Caller: "+12349013030",
        Digits: "1234",
        From: "+12349013030",
        To: "+18005551212",
      },
      "12345",
    );
    expect(sig).toBe("0/KCTR6DLpKmkAf8muzZqo1nDgQ=");
  });

  it("verifies Twilio with the message id and refuses a different URL", () => {
    const params = { MessageSid: "SM123", MessageStatus: "delivered", To: "+919000000000" };
    const url = "https://app.example.com/api/webhooks/integrations/sms/x";
    const sig = twilioSignature(url, params, "tok");
    expect(verifyTwilio({ url, params, signature: sig, authToken: "tok" })).toEqual({
      ok: true,
      eventId: "SM123",
      eventType: "delivered",
    });
    expect(
      verifyTwilio({ url: url + "?evil=1", params, signature: sig, authToken: "tok" }).ok,
    ).toBe(false);
  });

  it("compares shared secrets in constant time and exactly", () => {
    expect(secretsMatch("abc", "abc")).toBe(true);
    expect(secretsMatch("abc", "abd")).toBe(false);
    expect(secretsMatch("abc", "abcd")).toBe(false);
  });
});

// ── Printer guard ─────────────────────────────────────────────────────────

describe("printer address guard", () => {
  const noDns = async () => {
    throw new Error("unexpected lookup");
  };

  it.each([
    ["127.0.0.1", "loopback"],
    ["127.8.9.10", "loopback"],
    ["169.254.169.254", "link-local"],
    ["0.0.0.0", "unspecified"],
    ["224.0.0.1", "multicast"],
    ["::1", "loopback"],
    ["::", "unspecified"],
    ["fe80::1", "link-local"],
    ["::ffff:127.0.0.1", "loopback"],
    ["::ffff:169.254.169.254", "link-local"],
  ])("blocks %s (%s)", async (address) => {
    const result = await guardPrinterHost(address, noDns);
    expect(result.ok).toBe(false);
  });

  it("allows private LAN printers", async () => {
    expect(await guardPrinterHost("192.168.1.50", noDns)).toEqual({
      ok: true,
      address: "192.168.1.50",
    });
    expect(await guardPrinterHost("10.0.4.7", noDns)).toEqual({ ok: true, address: "10.0.4.7" });
  });

  it("checks every resolved address, so one bad record blocks the host", async () => {
    const resolve = async () => [
      { address: "192.168.1.9", family: 4 },
      { address: "127.0.0.1", family: 4 },
    ];
    const result = await guardPrinterHost("printer.local", resolve);
    expect(result).toMatchObject({ ok: false });
  });

  it("resolves names and connects to the checked address", async () => {
    const resolve = async () => [{ address: "10.20.30.40", family: 4 }];
    expect(await guardPrinterHost("kitchen-printer.lan", resolve)).toEqual({
      ok: true,
      address: "10.20.30.40",
    });
  });

  it("catches numeric and alias names that resolve to loopback", async () => {
    const resolve = async () => [{ address: "127.0.0.1", family: 4 }];
    expect((await guardPrinterHost("2130706433", resolve)).ok).toBe(false);
    expect((await guardPrinterHost("myprinter.attacker.example", resolve)).ok).toBe(false);
  });

  it("refuses localhost names, invalid names and unresolvable hosts", async () => {
    expect((await guardPrinterHost("localhost", noDns)).ok).toBe(false);
    expect((await guardPrinterHost("api.localhost", noDns)).ok).toBe(false);
    expect((await guardPrinterHost("bad host!", noDns)).ok).toBe(false);
    expect((await guardPrinterHost("", noDns)).ok).toBe(false);
    const fails = async () => {
      throw new Error("ENOTFOUND");
    };
    expect((await guardPrinterHost("nowhere.lan", fails)).ok).toBe(false);
  });

  it("classifies addresses for the reason text", () => {
    expect(blockedAddressReason("8.8.8.8")).toBeNull();
    expect(blockedAddressReason("240.0.0.1")).toBe("reserved address");
    expect(blockedAddressReason("nonsense")).toBe("not an IP address");
  });
});

// ── ESC/POS ───────────────────────────────────────────────────────────────

describe("ESC/POS output", () => {
  it("starts with initialise, ends with a partial cut", () => {
    const bytes = buildEscPosDocument([{ text: "Hello" }], 32);
    expect(Array.from(bytes.slice(0, 2))).toEqual([0x1b, 0x40]);
    expect(Array.from(bytes.slice(-4))).toEqual([0x1d, 0x56, 0x42, 0x00]);
  });

  it("wraps long lines at the paper width on word boundaries", () => {
    expect(wrapLine("one two three four five six seven", 12)).toEqual([
      "one two",
      "three four",
      "five six",
      "seven",
    ]);
  });

  it("replaces non-ASCII characters so the printer shows them", () => {
    expect(toPrinterAscii("Chai ₹40 — hot")).toBe("Chai ?40 ? hot");
  });

  it("validates the print payload again on the adapter side", () => {
    expect(parsePrintPayload({ lines: [] }).ok).toBe(false);
    expect(parsePrintPayload({ lines: [{ text: "x".repeat(201) }] }).ok).toBe(false);
    expect(parsePrintPayload({ lines: [{ text: "ok", bold: true }] })).toMatchObject({ ok: true });
  });
});

// ── Adapters ──────────────────────────────────────────────────────────────

describe("adapters", () => {
  const ctx = {
    accountId: ACCOUNT_ID,
    config: { host: "192.168.1.50", paper_width_chars: 32 },
    credentials: {},
  };

  it("DEMO adapters make no network calls and say they are simulated", async () => {
    const registry = createAdapterRegistry();
    const wa = registry.get("whatsapp", "demo")!;
    const outcome = await wa.send(ctx, {
      operation: "message.send",
      payload: { to: "9190", body: "hi" },
    });
    expect(outcome).toMatchObject({ ok: true, result: { mode: "demo", simulated: true } });

    const printer = registry.get("printer", "demo")!;
    const printed = await printer.send(ctx, {
      operation: "print.document",
      payload: { lines: [{ text: "Table 4" }] },
    });
    expect(printed).toMatchObject({
      ok: true,
      result: { mode: "demo", simulated: true, lines: 1 },
    });
  });

  it("live stubs never report success", async () => {
    const registry = createAdapterRegistry();
    for (const provider of ["razorpay", "whatsapp", "sms", "email"] as const) {
      const adapter = registry.get(provider, "live")!;
      expect(await adapter.test(ctx)).toMatchObject({ ok: false, code: "not_built", fatal: true });
    }
  });

  it("Swiggy and Zomato have no live adapter at all", () => {
    const registry = createAdapterRegistry();
    expect(registry.get("swiggy", "live")).toBeNull();
    expect(registry.get("zomato", "live")).toBeNull();
    expect(registry.get("swiggy", "demo")).not.toBeNull();
  });

  it("the server has no live printer adapter: live printing goes through the print agent", () => {
    // The server worker must never open a socket to a LAN printer.
    expect(createAdapterRegistry().get("printer", "live")).toBeNull();
  });
});

// ── Worker ────────────────────────────────────────────────────────────────

function job(overrides: Partial<ClaimedJob> = {}): ClaimedJob {
  return {
    job_id: "11111111-2222-4333-8444-555555555555",
    account_id: ACCOUNT_ID,
    business_id: BIZ,
    operation: "message.send",
    payload: { to: "919000000000", body: "Order ready" },
    attempt_no: 1,
    max_attempts: 5,
    ...overrides,
  };
}

function account(overrides: Partial<RuntimeAccount> = {}): RuntimeAccount {
  return {
    account_id: ACCOUNT_ID,
    business_id: BIZ,
    outlet_id: null,
    provider: "whatsapp",
    mode: "demo",
    enabled: true,
    status: "connected",
    config: {},
    ciphertext: null,
    ...overrides,
  };
}

function deps(over: Partial<WorkerDeps> = {}): WorkerDeps {
  return {
    claim: vi.fn(async () => []),
    loadAccount: vi.fn(async () => account()),
    decrypt: vi.fn(() => ({})),
    adapters: createAdapterRegistry(),
    finish: vi.fn(async () => {}),
    now: () => 1_000,
    ...over,
  };
}

describe("worker decisions", () => {
  it("a DEMO send succeeds and records a simulated result", async () => {
    const plan = await planJob(job(), deps());
    expect(plan).toMatchObject({ outcome: "succeeded", accountStatus: null });
    expect(plan.result).toMatchObject({ simulated: true });
  });

  it("a disabled connection is retried later and nothing is sent", async () => {
    const d = deps({ loadAccount: vi.fn(async () => account({ enabled: false })) });
    const plan = await planJob(job(), d);
    expect(plan).toMatchObject({ outcome: "retry", errorCode: "account_disabled" });
  });

  it("an untested connection is retried, not sent", async () => {
    const plan = await planJob(
      job(),
      deps({ loadAccount: vi.fn(async () => account({ status: "untested" })) }),
    );
    expect(plan).toMatchObject({ outcome: "retry", errorCode: "account_not_connected" });
  });

  it("a missing or cross-tenant account fails", async () => {
    expect(await planJob(job(), deps({ loadAccount: vi.fn(async () => null) }))).toMatchObject({
      outcome: "failed",
      errorCode: "account_missing",
    });
    expect(
      await planJob(
        job(),
        deps({
          loadAccount: vi.fn(async () =>
            account({ business_id: "dddddddd-0000-0000-0000-000000000002" }),
          ),
        }),
      ),
    ).toMatchObject({ outcome: "failed", errorCode: "account_missing" });
  });

  it("unreadable credentials fail and mark the connection as error", async () => {
    const d = deps({
      loadAccount: vi.fn(async () => account({ ciphertext: "v1:AAAA:AAAA:AAAA" })),
      decrypt: vi.fn(() => {
        throw new CredentialDecryptError("nope");
      }),
    });
    expect(await planJob(job(), d)).toMatchObject({
      outcome: "failed",
      errorCode: "credentials_unreadable",
      accountStatus: "error",
    });
  });

  it("Swiggy live has no adapter, so the job fails without a send", async () => {
    const plan = await planJob(
      job({ operation: "aggregator.push_status" }),
      deps({ loadAccount: vi.fn(async () => account({ provider: "swiggy", mode: "live" })) }),
    );
    expect(plan).toMatchObject({ outcome: "failed", errorCode: "no_adapter" });
  });

  it("a fatal adapter error fails the job and marks the connection as error", async () => {
    const plan = await planJob(
      job({ operation: "message.send" }),
      deps({ loadAccount: vi.fn(async () => account({ mode: "live" })) }),
    );
    expect(plan).toMatchObject({
      outcome: "failed",
      errorCode: "not_built",
      accountStatus: "error",
    });
  });

  it("an adapter that throws is retried with a generic message that hides its error", async () => {
    const throwing = {
      get: () => ({
        provider: "whatsapp" as const,
        mode: "demo" as const,
        test: async () => {
          throw new Error("secret-token-leak");
        },
        send: async () => {
          throw new Error("secret-token-leak");
        },
      }),
    };
    const plan = await planJob(job(), deps({ adapters: throwing }));
    expect(plan).toMatchObject({ outcome: "retry", errorCode: "adapter_error" });
    expect(plan.errorMessage).not.toContain("secret-token-leak");
  });

  it("a batch claims with a clamped limit and finishes every job once", async () => {
    const claim = vi.fn(async () => [
      job(),
      job({ job_id: "99999999-2222-4333-8444-555555555555" }),
    ]);
    const finish = vi.fn(async () => {});
    const summary = await runWorkerBatch(deps({ claim, finish }), 999);
    expect(claim).toHaveBeenCalledWith(25, 120);
    expect(finish).toHaveBeenCalledTimes(2);
    expect(summary).toEqual({ claimed: 2, succeeded: 2, retried: 0, failed: 0 });
    await runWorkerBatch(deps({ claim }), 0);
    expect(claim).toHaveBeenLastCalledWith(1, 120);
  });
});

// ── Save validation ───────────────────────────────────────────────────────

function save(over: Partial<SaveInput> = {}): SaveInput {
  return {
    businessId: BIZ,
    accountId: null,
    outletId: OUTLET,
    provider: "printer",
    mode: "demo",
    enabled: false,
    config: { host: "192.168.1.50", paper_width_chars: 32 },
    credentials: {},
    ...over,
  };
}

describe("save validation (the server repeats these in the database)", () => {
  it("accepts a DEMO printer for an outlet", () => {
    expect(validateSave(save())).toBeNull();
  });

  it("refuses live for every integration except the printer, and says why for Swiggy and Zomato", () => {
    expect(validateSave(save({ provider: "swiggy", outletId: null, mode: "live" }))).toMatch(
      /partner onboarding/,
    );
    expect(validateSave(save({ provider: "zomato", outletId: null, mode: "live" }))).toMatch(
      /partner onboarding/,
    );
    expect(validateSave(save({ provider: "whatsapp", outletId: null, mode: "live" }))).toMatch(
      /not available/,
    );
  });

  it("accepts a live printer for an outlet (served by the print agent)", () => {
    expect(validateSave(save({ mode: "live" }))).toBeNull();
  });

  it("requires an outlet for a printer", () => {
    expect(validateSave(save({ outletId: null }))).toMatch(/outlet/);
  });

  it("refuses settings and credentials that are not in the allow-list", () => {
    expect(validateSave(save({ config: { host: "192.168.1.50", api_key: "x" } }))).toMatch(
      /not a setting/,
    );
    expect(validateSave(save({ credentials: { password: "x" } }))).toMatch(/credential field/);
  });

  it("validates the printer host and paper width", () => {
    expect(validateSave(save({ config: { host: "not a host!" } }))).toMatch(/not valid/);
    expect(validateSave(save({ config: { host: "192.168.1.999" } }))).toMatch(/not valid/);
    expect(validateSave(save({ config: { host: "192.168.1.50", paper_width_chars: 20 } }))).toMatch(
      /Paper width/,
    );
  });

  it("the accounting export is a file, not a connection", () => {
    expect(
      validateSave(save({ provider: "accounting_export", outletId: null, config: {} })),
    ).toMatch(/file export/);
  });
});

// ── Catalogue ─────────────────────────────────────────────────────────────

describe("catalogue", () => {
  it("only the printer claims a live path in this build, and it is the print agent", () => {
    const live = PROVIDER_CATALOG.filter((p) => p.liveAvailable).map((p) => p.key);
    expect(live).toEqual(["printer"]);
  });

  it("Swiggy and Zomato are DEMO-only, and their operations are the aggregator pair", () => {
    for (const key of ["swiggy", "zomato"] as const) {
      const def = findProvider(key)!;
      expect(def.liveAvailable).toBe(false);
      expect(def.operations).toEqual(["aggregator.sync_menu", "aggregator.push_status"]);
    }
  });

  it("every provider's operations match the database allow-list names", () => {
    expect(findProvider("razorpay")!.operations).toEqual(["payment.create_link"]);
    expect(findProvider("email")!.operations).toEqual(["email.send"]);
    expect(findProvider("printer")!.operations).toEqual(["print.document", "connection.test"]);
  });
});

// ── Accounting CSV ────────────────────────────────────────────────────────

describe("accounting CSV", () => {
  const rows = [
    {
      period_start: "2026-10-01",
      orders: 2,
      gross_minor: 120000,
      discount_minor: 0,
      net_sales_minor: 120000,
      tax_minor: 6000,
      billed_minor: 126000,
    },
    {
      period_start: "2026-10-02",
      orders: 1,
      gross_minor: 1234567,
      discount_minor: 1000,
      net_sales_minor: 1233567,
      tax_minor: 61678,
      billed_minor: 1295245,
    },
  ];

  it("writes the header, one line per day, and a total that adds up", () => {
    const csv = buildAccountingCsv(rows, "Main");
    const lines = csv
      .replace(/^\uFEFF/, "")
      .trim()
      .split("\r\n");
    expect(lines[0]).toBe(ACCOUNTING_HEADER.join(","));
    expect(lines[1]).toBe("2026-10-01,Main,Sales,2,1200.00,0.00,1200.00,60.00,1260.00");
    expect(lines[3]).toBe("Total,Main,Sales,3,13545.67,10.00,13535.67,676.78,14212.45");
  });

  it("writes plain decimals with no thousands separators", () => {
    const csv = buildAccountingCsv(rows, "Main");
    expect(csv).not.toContain("13,545.67");
    expect(csv).toContain("13545.67");
  });

  it("guards text cells against formula injection", () => {
    const csv = buildAccountingCsv([], '=HYPERLINK("x")');
    expect(csv).toContain("'=HYPERLINK");
  });

  it("starts with a byte-order mark so Excel reads UTF-8", () => {
    expect(buildAccountingCsv([], "Main").charCodeAt(0)).toBe(0xfeff);
  });
});

describe("encryption key is never printed", () => {
  it("parse errors do not include the key material", () => {
    const bad = randomBytes(8).toString("base64");
    try {
      parseEncryptionKey(bad);
    } catch (error) {
      expect((error as Error).message).not.toContain(bad);
    }
  });
});
