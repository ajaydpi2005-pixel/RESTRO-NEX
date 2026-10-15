import { describe, expect, it } from "vitest";
import {
  AGENT_TOKEN_PREFIX,
  bearerAgentToken,
  claimBodySchema,
  generateAgentToken,
  hashAgentToken,
  reportBodySchema,
  toAgentJob,
  type AgentClaimRow,
} from "./agent";
import { printerHostSaveError } from "./printer-guard";

const JOB = "11111111-2222-4333-8444-555555555555";

function row(over: Partial<AgentClaimRow>): AgentClaimRow {
  return {
    job_id: JOB,
    operation: "print.document",
    attempt_no: 1,
    max_attempts: 5,
    payload: { lines: [{ text: "Table 4", bold: true, center: true }] },
    host: "192.168.1.50",
    paper_width_chars: 42,
    ...over,
  };
}

describe("agent tokens", () => {
  it("generates a prefixed, high-entropy token that is shown once and hashed for storage", () => {
    const a = generateAgentToken();
    const b = generateAgentToken();
    expect(a.startsWith(AGENT_TOKEN_PREFIX)).toBe(true);
    expect(a).not.toBe(b);
    expect(a.length).toBe(AGENT_TOKEN_PREFIX.length + 43);
    const hash = hashAgentToken(a);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toContain(a);
    expect(hashAgentToken(a)).toBe(hash);
  });

  it("reads only a well-formed bearer token", () => {
    const token = generateAgentToken();
    expect(bearerAgentToken(`Bearer ${token}`)).toBe(token);
    expect(bearerAgentToken(`bearer ${token}`)).toBe(token);
    expect(bearerAgentToken(null)).toBeNull();
    expect(bearerAgentToken("Bearer ")).toBeNull();
    expect(bearerAgentToken("Bearer short")).toBeNull();
    expect(bearerAgentToken(`Basic ${token}`)).toBeNull();
    expect(bearerAgentToken(`Bearer ${token} extra`)).toBeNull();
  });
});

describe("agent job conversion", () => {
  it("builds ESC/POS bytes for a print job on the server, at the outlet's paper width", () => {
    const job = toAgentJob(row({}));
    expect(job.payload_error).toBe(false);
    expect(job.port).toBe(9100);
    expect(job.host).toBe("192.168.1.50");
    const bytes = Buffer.from(job.bytes_b64 ?? "", "base64");
    expect(bytes.subarray(0, 2).toString("hex")).toBe("1b40");
    expect(bytes.toString("latin1")).toContain("Table 4");
  });

  it("never returns the payload itself", () => {
    const job = toAgentJob(row({})) as unknown as Record<string, unknown>;
    expect(job).not.toHaveProperty("payload");
  });

  it("a connection test carries no bytes", () => {
    const job = toAgentJob(row({ operation: "connection.test", payload: {} }));
    expect(job).toMatchObject({ bytes_b64: null, payload_error: false, port: 9100 });
  });

  it("flags an invalid print payload instead of building bytes", () => {
    const job = toAgentJob(row({ payload: { lines: "nope" } }));
    expect(job).toMatchObject({ bytes_b64: null, payload_error: true });
  });

  it("flags an unknown operation", () => {
    const job = toAgentJob(row({ operation: "message.send" }));
    expect(job).toMatchObject({ bytes_b64: null, payload_error: true });
  });
});

describe("agent request bodies", () => {
  it("clamps the claim limit to 1–10 and defaults to 5", () => {
    expect(claimBodySchema.parse({})).toEqual({ limit: 5 });
    expect(claimBodySchema.safeParse({ limit: 11 }).success).toBe(false);
    expect(claimBodySchema.safeParse({ limit: 0 }).success).toBe(false);
  });

  it("accepts only the three report outcomes and a uuid job id", () => {
    const ok = { job_id: JOB, outcome: "succeeded", duration_ms: 12 };
    expect(reportBodySchema.safeParse(ok).success).toBe(true);
    expect(reportBodySchema.safeParse({ ...ok, outcome: "dead" }).success).toBe(false);
    expect(reportBodySchema.safeParse({ ...ok, job_id: "nope" }).success).toBe(false);
  });
});

describe("live printer host at save time", () => {
  it("accepts a private LAN address and a host name (the agent checks names when it connects)", () => {
    expect(printerHostSaveError("192.168.1.50")).toBeNull();
    expect(printerHostSaveError("kitchen-printer.lan")).toBeNull();
  });

  it("refuses loopback, link-local (including metadata), unspecified and localhost", () => {
    expect(printerHostSaveError("127.0.0.1")).toMatch(/loopback/);
    expect(printerHostSaveError("169.254.169.254")).toMatch(/link-local/);
    expect(printerHostSaveError("0.0.0.0")).toMatch(/unspecified/);
    expect(printerHostSaveError("::1")).toMatch(/loopback/);
    expect(printerHostSaveError("localhost")).not.toBeNull();
    expect(printerHostSaveError("api.localhost")).not.toBeNull();
  });

  it("refuses numeric shorthand and an empty host", () => {
    expect(printerHostSaveError("2130706433")).not.toBeNull();
    expect(printerHostSaveError("0x7f000001")).not.toBeNull();
    expect(printerHostSaveError("  ")).not.toBeNull();
  });
});
