import { createAdminClient } from "@/lib/supabase/admin";
import { asSettings } from "./public-service";
import type { OrderingSettings, QrCodeRow, QueueOrder } from "./types";

/**
 * Phase 17 — staff-side reads for the intake queue, settings and QR codes.
 *
 * Callers check the viewer's permission and outlet access before calling these
 * functions. The database functions check it again with the actor id.
 */

/** Orders from online and QR channels that still need acceptance, plus recently accepted ones. */
export async function loadIntakeQueue(
  actorUserId: string,
  outletId: string,
): Promise<QueueOrder[]> {
  const admin = createAdminClient();
  const { data, error } = await admin.rpc("online_intake_queue", {
    p_actor: actorUserId,
    p_outlet_id: outletId,
  });
  if (error || !Array.isArray(data)) return [];
  return data as QueueOrder[];
}

export async function loadOrderingSettings(outletId: string): Promise<OrderingSettings> {
  const admin = createAdminClient();
  const { data } = await admin.rpc("ordering_settings_json", { p_outlet_id: outletId });
  return asSettings(data);
}

/**
 * QR code metadata. The token hash is never selected: the database also withholds
 * that column from every client role.
 */
export async function loadQrCodes(outletId: string): Promise<QrCodeRow[]> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("qr_codes")
    .select(
      "id, label, token_prefix, status, table_id, created_at, revoked_at, dining_tables(label)",
    )
    .eq("outlet_id", outletId)
    .order("created_at", { ascending: false })
    .limit(200);
  if (error || !data) return [];

  return data.map((row) => {
    const table = Array.isArray(row.dining_tables) ? row.dining_tables[0] : row.dining_tables;
    return {
      id: row.id,
      label: row.label,
      token_prefix: row.token_prefix,
      status: row.status as QrCodeRow["status"],
      table_id: row.table_id,
      table_label: table?.label ?? null,
      created_at: row.created_at,
      revoked_at: row.revoked_at,
    };
  });
}

export async function loadActiveTables(outletId: string): Promise<{ id: string; label: string }[]> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("dining_tables")
    .select("id, label")
    .eq("outlet_id", outletId)
    .eq("is_active", true)
    .order("label", { ascending: true })
    .limit(300);
  if (error || !data) return [];
  return data;
}

/** Slugs for the public storefront link shown to staff. Read with the service client after the permission check. */
export async function loadStorefrontSlugs(
  businessId: string,
  outletId: string,
): Promise<{ businessSlug: string; outletSlug: string } | null> {
  const admin = createAdminClient();
  const [{ data: business }, { data: outlet }] = await Promise.all([
    admin.from("businesses").select("slug").eq("id", businessId).maybeSingle(),
    admin.from("outlets").select("slug").eq("id", outletId).maybeSingle(),
  ]);
  if (!business?.slug || !outlet?.slug) return null;
  return { businessSlug: business.slug, outletSlug: outlet.slug };
}
