"use server";

import { createAdminClient } from "@/lib/supabase/admin";
import { permissionErrorMessage, requirePermission } from "@/lib/rbac/enforce";
import type { Permission } from "@/lib/rbac/permissions";
import { loadBoardSnapshot, loadRoutingData, outletBusinessId, type BoardSnapshot, type RoutingData } from "./queries";
import {
  acknowledgeSchema,
  advanceItemSchema,
  advanceTicketSchema,
  routesPayloadSchema,
  setPrioritySchema,
  snapshotSchema,
  stationsPayloadSchema,
  type AdvanceItemInput,
  type AdvanceTicketInput,
  type RoutesPayload,
  type StationsPayload,
} from "./schemas";

/**
 * Phase 11 — kitchen server actions.
 *
 * Security model (mirrors Phases 8–10):
 *  - the actor is the session user, never form input
 *  - the outlet's business is resolved from the database, not the client
 *  - requirePermission gates each action (membership + role + outlet grant)
 *  - the SECURITY DEFINER RPCs re-check the same rules and never touch money
 */

export type KitchenResult<T = never> =
  | { ok: true; value?: T }
  | { ok: false; error: string; stale?: boolean };

const GENERIC_ERROR = "Something went wrong. Please try again.";
const INVALID_INPUT = "That request was not valid. Refresh the page and try again.";

type Authorised = { ok: true; actorId: string } | { ok: false; error: string };

async function authorise(outletId: string, permission: Permission): Promise<Authorised> {
  const businessId = await outletBusinessId(outletId);
  if (!businessId) return { ok: false, error: "Outlet not found." };
  try {
    const actor = await requirePermission({ businessId, permission, outletId });
    return { ok: true, actorId: actor.userId };
  } catch (error) {
    return { ok: false, error: permissionErrorMessage(error) };
  }
}

interface RpcFailure {
  code?: string;
  message?: string;
}

/** Only our own RPC messages (P0001) and permission errors (42501) are shown verbatim. */
function rpcFailure(error: RpcFailure): { ok: false; error: string; stale?: boolean } {
  const message = error.message ?? "";
  if (error.code === "P0001" || error.code === "42501") {
    return {
      ok: false,
      error: message,
      stale: message.includes("another screen"),
    };
  }
  return { ok: false, error: GENERIC_ERROR };
}

export async function advanceItemAction(input: AdvanceItemInput): Promise<KitchenResult<string>> {
  const parsed = advanceItemSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: INVALID_INPUT };

  const auth = await authorise(parsed.data.outletId, "kitchen.operate");
  if (!auth.ok) return { ok: false, error: auth.error };

  const admin = createAdminClient();
  const { data, error } = await admin.rpc("kds_advance_item", {
    p_actor: auth.actorId,
    p_item_id: parsed.data.itemId,
    p_from: parsed.data.from,
    p_to: parsed.data.to,
  });
  if (error) return rpcFailure(error);
  return { ok: true, value: String(data) };
}

export async function advanceTicketAction(input: AdvanceTicketInput): Promise<KitchenResult<number>> {
  const parsed = advanceTicketSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: INVALID_INPUT };

  const auth = await authorise(parsed.data.outletId, "kitchen.operate");
  if (!auth.ok) return { ok: false, error: auth.error };

  const admin = createAdminClient();
  const { data, error } = await admin.rpc("kds_advance_ticket", {
    p_actor: auth.actorId,
    p_order_id: parsed.data.orderId,
    p_station_id: parsed.data.stationId,
    p_from: parsed.data.from,
    p_to: parsed.data.to,
  });
  if (error) return rpcFailure(error);
  return { ok: true, value: Number(data ?? 0) };
}

export async function setPriorityAction(input: {
  outletId: string;
  orderId: string;
  priority: boolean;
}): Promise<KitchenResult<boolean>> {
  const parsed = setPrioritySchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: INVALID_INPUT };

  const auth = await authorise(parsed.data.outletId, "kitchen.operate");
  if (!auth.ok) return { ok: false, error: auth.error };

  const admin = createAdminClient();
  const { data, error } = await admin.rpc("kds_set_priority", {
    p_actor: auth.actorId,
    p_order_id: parsed.data.orderId,
    p_priority: parsed.data.priority,
  });
  if (error) return rpcFailure(error);
  return { ok: true, value: Boolean(data) };
}

export async function acknowledgeEventAction(input: {
  outletId: string;
  eventId: string;
}): Promise<KitchenResult> {
  const parsed = acknowledgeSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: INVALID_INPUT };

  const auth = await authorise(parsed.data.outletId, "kitchen.operate");
  if (!auth.ok) return { ok: false, error: auth.error };

  const admin = createAdminClient();
  const { error } = await admin.rpc("kds_acknowledge_event", {
    p_actor: auth.actorId,
    p_event_id: parsed.data.eventId,
  });
  if (error) return rpcFailure(error);
  return { ok: true };
}

/** Full board state. Used on every (re)connect to heal anything missed while offline. */
export async function loadKitchenSnapshotAction(input: {
  outletId: string;
}): Promise<KitchenResult<BoardSnapshot>> {
  const parsed = snapshotSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: INVALID_INPUT };

  const auth = await authorise(parsed.data.outletId, "kitchen.view");
  if (!auth.ok) return { ok: false, error: auth.error };

  return { ok: true, value: await loadBoardSnapshot(parsed.data.outletId) };
}

export async function loadRoutingAction(input: {
  outletId: string;
}): Promise<KitchenResult<RoutingData>> {
  const parsed = snapshotSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: INVALID_INPUT };

  const businessId = await outletBusinessId(parsed.data.outletId);
  if (!businessId) return { ok: false, error: "Outlet not found." };
  try {
    await requirePermission({ businessId, permission: "kitchen.manage", outletId: parsed.data.outletId });
  } catch (error) {
    return { ok: false, error: permissionErrorMessage(error) };
  }
  return { ok: true, value: await loadRoutingData(businessId, parsed.data.outletId) };
}

export async function saveStationsAction(input: StationsPayload): Promise<KitchenResult<number>> {
  const parsed = stationsPayloadSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? INVALID_INPUT };

  const auth = await authorise(parsed.data.outletId, "kitchen.manage");
  if (!auth.ok) return { ok: false, error: auth.error };

  const admin = createAdminClient();
  const { data, error } = await admin.rpc("kitchen_save_stations", {
    p_actor: auth.actorId,
    p_outlet_id: parsed.data.outletId,
    p_stations: parsed.data.stations.map((station) => ({
      name: station.name,
      description: station.description,
    })),
  });
  if (error) return rpcFailure(error);
  return { ok: true, value: Number(data ?? 0) };
}

export async function saveRoutesAction(input: RoutesPayload): Promise<KitchenResult<number>> {
  const parsed = routesPayloadSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? INVALID_INPUT };

  const auth = await authorise(parsed.data.outletId, "kitchen.manage");
  if (!auth.ok) return { ok: false, error: auth.error };

  const admin = createAdminClient();
  const { data, error } = await admin.rpc("kitchen_save_routes", {
    p_actor: auth.actorId,
    p_outlet_id: parsed.data.outletId,
    p_routes: parsed.data.routes.map((route) => ({
      target_type: route.targetType,
      target_id: route.targetId,
      station_id: route.stationId,
    })),
  });
  if (error) return rpcFailure(error);
  return { ok: true, value: Number(data ?? 0) };
}
