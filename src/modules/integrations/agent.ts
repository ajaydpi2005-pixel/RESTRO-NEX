import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { buildEscPosDocument } from "./escpos";
import { paperWidthOf, parsePrintPayload } from "./adapters";
import { PRINTER_PORT } from "./printer-guard";

/**
 * Phase 18 — print agent: the server side of the outbound-only poller.
 *
 * The agent runs on the outlet's LAN, asks this server for jobs over HTTPS, and sends the
 * bytes to the printer itself. The server never connects to a LAN printer.
 *
 * Tokens: each agent gets a random `ragt_…` token, shown once. The database keeps only
 * its SHA-256 hex digest, so a leaked table cannot be replayed as a token.
 */

export const AGENT_TOKEN_PREFIX = "ragt_";
const TOKEN_RE = /^ragt_[A-Za-z0-9_-]{40,}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function generateAgentToken(): string {
  return AGENT_TOKEN_PREFIX + randomBytes(32).toString("base64url");
}

export function hashAgentToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Reads the bearer token from an Authorization header. Null when missing or malformed. */
export function bearerAgentToken(header: string | null): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  if (!match) return null;
  const token = match[1] ?? "";
  return TOKEN_RE.test(token) ? token : null;
}

export const claimBodySchema = z.object({
  limit: z.number().int().min(1).max(10).default(5),
});

export const reportBodySchema = z.object({
  job_id: z.string().regex(UUID_RE, "That job id is not valid."),
  outcome: z.enum(["succeeded", "retry", "failed"]),
  error_code: z.string().max(60).nullable().optional(),
  error_message: z.string().max(500).nullable().optional(),
  duration_ms: z.number().int().min(0).max(600_000).default(0),
});

/** One row from `integration_agent_claim`. */
export interface AgentClaimRow {
  job_id: string;
  operation: string;
  attempt_no: number;
  max_attempts: number;
  payload: Record<string, unknown>;
  host: string | null;
  paper_width_chars: number | null;
}

/** What the agent receives. The payload is not sent; the built bytes are. */
export interface AgentJob {
  job_id: string;
  operation: string;
  attempt_no: number;
  max_attempts: number;
  host: string | null;
  port: number;
  /** Base64 ESC/POS bytes for print.document. Null for connection.test. */
  bytes_b64: string | null;
  /** True when the server cannot build this job. The agent reports it as failed. */
  payload_error: boolean;
}

/** Turns a claimed row into what the agent needs. Bytes are built here, not on the agent. */
export function toAgentJob(row: AgentClaimRow): AgentJob {
  const base = {
    job_id: row.job_id,
    operation: row.operation,
    attempt_no: row.attempt_no,
    max_attempts: row.max_attempts,
    host: row.host,
    port: PRINTER_PORT,
  };
  if (row.operation === "connection.test") {
    return { ...base, bytes_b64: null, payload_error: false };
  }
  if (row.operation === "print.document") {
    const parsed = parsePrintPayload(row.payload);
    if (!parsed.ok) return { ...base, bytes_b64: null, payload_error: true };
    const width = paperWidthOf({ paper_width_chars: row.paper_width_chars });
    const bytes = buildEscPosDocument(parsed.lines, width);
    return {
      ...base,
      bytes_b64: Buffer.from(bytes).toString("base64"),
      payload_error: false,
    };
  }
  return { ...base, bytes_b64: null, payload_error: true };
}
