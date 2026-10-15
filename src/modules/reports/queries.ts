import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import type { ReportDefinition, ReportGrain } from "@/modules/reports/registry";
import type { ReportPayload, ReportRow } from "@/modules/reports/types";

/**
 * Phase 16 — the only path from the pages and the export route to the report functions.
 *
 * The actor is always the signed-in user, read from the session on the server. The client
 * never supplies it. The database checks the actor's permissions and outlet access again, so
 * this module cannot widen what a person sees.
 */

export interface ReportQuery {
  businessId: string;
  actorId: string;
  /** One outlet, or null for every outlet the actor can see. */
  outletId: string | null;
  from: string;
  to: string;
  search: string;
  grain: ReportGrain;
  limit: number;
  offset: number;
}

export type ReportResult =
  | { ok: true; payload: ReportPayload }
  | { ok: false; status: "forbidden" | "invalid" | "failed"; error: string };

/** Postgres errcodes raised by the report functions: 42501 = permission, P0001 = bad input. */
function classify(
  code: string | undefined,
  message: string,
): { status: "forbidden" | "invalid" | "failed"; error: string } {
  if (code === "42501") return { status: "forbidden", error: message };
  if (code === "P0001") return { status: "invalid", error: message };
  return { status: "failed", error: "Could not load this report. Try again in a moment." };
}

export async function runReport(def: ReportDefinition, query: ReportQuery): Promise<ReportResult> {
  const admin = createAdminClient();
  const { data, error } = await admin.rpc(def.rpc, {
    p_actor: query.actorId,
    p_business_id: query.businessId,
    p_outlet_ids: query.outletId ? [query.outletId] : null,
    p_from: query.from,
    p_to: query.to,
    p_search: query.search || null,
    p_grain: query.grain,
    p_limit: query.limit,
    p_offset: query.offset,
  });

  if (error) {
    if (!["42501", "P0001"].includes(error.code ?? "")) {
      console.error(`[reports] ${def.rpc} failed`, { code: error.code, message: error.message });
    }
    return { ok: false, ...classify(error.code, error.message) };
  }

  const raw = (data ?? {}) as {
    total?: number;
    rows?: ReportRow[];
    summary?: Record<string, unknown>;
  };
  return {
    ok: true,
    payload: {
      total: Number(raw.total ?? 0),
      rows: Array.isArray(raw.rows) ? raw.rows : [],
      summary: raw.summary ?? {},
    },
  };
}

/** The business name for exports. The report call has already confirmed membership. */
export async function loadBusinessName(businessId: string): Promise<string> {
  const admin = createAdminClient();
  const { data } = await admin.from("businesses").select("name").eq("id", businessId).maybeSingle();
  return (data?.name as string | undefined) ?? "RestroNex business";
}

/** An outlet's name for exports, or "All outlets" when no single outlet is chosen. */
export async function loadOutletLabel(
  businessId: string,
  outletId: string | null,
): Promise<string> {
  if (!outletId) return "All outlets you can see";
  const admin = createAdminClient();
  const { data } = await admin
    .from("outlets")
    .select("name")
    .eq("business_id", businessId)
    .eq("id", outletId)
    .maybeSingle();
  return (data?.name as string | undefined) ?? "Selected outlet";
}
