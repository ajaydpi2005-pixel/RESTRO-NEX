import { IntegrationServiceError, rpc } from "@/modules/integrations/service";
import { bearerAgentToken, hashAgentToken, reportBodySchema } from "@/modules/integrations/agent";

/**
 * Phase 18 — POST /api/integrations/agent/report. The agent reports how a claimed job
 * ended: `succeeded`, `retry` (try again later) or `failed` (fatal; the account is marked
 * as an error). The database checks that this agent holds the job's lease.
 */

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;
const MAX_BODY_BYTES = 4096;

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
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return json(400, { error: "The request is not valid JSON." });
  }
  const parsed = reportBodySchema.safeParse(body);
  if (!parsed.success) {
    return json(400, { error: parsed.error.issues[0]?.message ?? "The report is not valid." });
  }
  const d = parsed.data;

  try {
    const status = await rpc<string>("integration_agent_report", {
      p_token_hash: hashAgentToken(token),
      p_job_id: d.job_id,
      p_outcome: d.outcome,
      p_error_code: d.outcome === "succeeded" ? null : (d.error_code ?? "agent_error").slice(0, 60),
      p_error_message:
        d.outcome === "succeeded"
          ? null
          : (d.error_message ?? "The print agent reported a failure.").slice(0, 500),
      p_duration_ms: d.duration_ms,
    });
    return json(200, { ok: true, status });
  } catch (error) {
    if (error instanceof IntegrationServiceError) {
      if (error.message === "Agent not recognised.") return json(401, { error: "Not authorised." });
      if (error.message === "This job is not claimed by this agent.") {
        return json(409, { error: error.message });
      }
    }
    // Anything else is a server-side problem. A 5xx tells the agent to retry the report.
    return json(500, { error: "The report could not be saved. The agent will retry." });
  }
}
