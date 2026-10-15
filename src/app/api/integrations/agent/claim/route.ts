import { IntegrationServiceError, rpc } from "@/modules/integrations/service";
import {
  AgentClaimRow,
  bearerAgentToken,
  claimBodySchema,
  hashAgentToken,
  toAgentJob,
} from "@/modules/integrations/agent";

/**
 * Phase 18 — POST /api/integrations/agent/claim. An on-site print agent polls here with
 * its own token (`Authorization: Bearer ragt_…`). It gets back the jobs due for its
 * outlet, with ESC/POS bytes built here. The agent then connects to the printer itself.
 *
 *  • A missing, malformed, unknown or revoked token → 401. Nothing is revealed about why.
 *  • The body is optional, and capped at 2 KB. `limit` is 1–10 (default 5).
 *  • Responses are never cached. Payloads and credentials are never logged.
 */

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;
const MAX_BODY_BYTES = 2048;

function json(status: number, body: Record<string, unknown>) {
  return Response.json(body, { status, headers: NO_STORE });
}

export async function POST(request: Request) {
  const token = bearerAgentToken(request.headers.get("authorization"));
  if (!token) return json(401, { error: "Not authorised." });

  let raw = "";
  try {
    raw = await request.text();
  } catch {
    return json(400, { error: "The request could not be read." });
  }
  if (new TextEncoder().encode(raw).length > MAX_BODY_BYTES) {
    return json(413, { error: "The request is too large." });
  }
  let body: unknown = {};
  if (raw.trim() !== "") {
    try {
      body = JSON.parse(raw);
    } catch {
      return json(400, { error: "The request is not valid JSON." });
    }
  }
  const parsed = claimBodySchema.safeParse(body);
  if (!parsed.success) return json(400, { error: "The claim request is not valid." });

  try {
    const rows = await rpc<AgentClaimRow[]>("integration_agent_claim", {
      p_token_hash: hashAgentToken(token),
      p_limit: parsed.data.limit,
      p_lease_seconds: 120,
    });
    return json(200, { ok: true, jobs: (rows ?? []).map(toAgentJob) });
  } catch (error) {
    if (error instanceof IntegrationServiceError && error.message === "Agent not recognised.") {
      return json(401, { error: "Not authorised." });
    }
    // The service layer logs the function name and code only.
    return json(500, { error: "The agent could not claim jobs. Try again shortly." });
  }
}
