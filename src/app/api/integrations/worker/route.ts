import { getServerEnv } from "@/lib/env";
import { secretsMatch } from "@/modules/integrations/signatures";
import { runWorkerBatch } from "@/modules/integrations/worker";
import { productionWorkerDeps } from "@/modules/integrations/service";

/**
 * Phase 18 — POST /api/integrations/worker. A scheduler (cron, or a hosted job runner)
 * calls this with `Authorization: Bearer <INTEGRATION_WORKER_SECRET>`. It claims a batch
 * of due jobs and runs each one through its adapter.
 *
 *  • No secret configured → 503. Nothing runs.
 *  • Wrong or missing bearer → 401. The comparison is constant-time.
 *  • `?limit=` is clamped to 1–25.
 *  • Responses are never cached. Only counts are returned, never job payloads or credentials.
 */

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

function json(status: number, body: Record<string, unknown>) {
  return Response.json(body, { status, headers: NO_STORE });
}

export async function POST(request: Request) {
  const expected = getServerEnv().INTEGRATION_WORKER_SECRET;
  if (!expected) return json(503, { error: "The integration worker is not configured." });

  const header = request.headers.get("authorization") ?? "";
  const presented = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
  if (!presented || !secretsMatch(presented, expected)) {
    return json(401, { error: "Not authorised." });
  }

  const requested = Number(new URL(request.url).searchParams.get("limit") ?? "10");
  const limit = Number.isFinite(requested) ? Math.min(25, Math.max(1, Math.trunc(requested))) : 10;

  try {
    const summary = await runWorkerBatch(productionWorkerDeps(), limit);
    return json(200, { ok: true, ...summary });
  } catch {
    // The reason is logged by the service layer without arguments. The response stays generic.
    return json(500, { error: "The worker could not run a batch. Try again shortly." });
  }
}
