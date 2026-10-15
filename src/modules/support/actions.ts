"use server";

import { revalidatePath } from "next/cache";
import type { FormActionState } from "@/components/forms/form-bits";
import { getSessionUserId } from "@/lib/rbac/enforce";
import { adminRpc, adminServiceMessage } from "@/modules/admin/rpc";
import { openTicketSchema, tenantReplySchema } from "./schemas";

/**
 * Tenant support actions (Phase 19). The actor is the verified session user.
 * The database checks settings.manage on the business and refuses suspended
 * members, so a suspended business cannot open tickets.
 */

export type SupportActionState = FormActionState & { message?: string };

const SIGN_IN_AGAIN = "Please sign in again.";

export async function openSupportTicketAction(
  _previous: SupportActionState | undefined,
  formData: FormData,
): Promise<SupportActionState> {
  const parsed = openTicketSchema.safeParse({
    businessId: String(formData.get("businessId") ?? ""),
    subject: String(formData.get("subject") ?? ""),
    body: String(formData.get("body") ?? ""),
  });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Check the highlighted fields." };
  }
  const actor = await getSessionUserId();
  if (!actor) return { ok: false, error: SIGN_IN_AGAIN };
  try {
    await adminRpc("support_ticket_open", {
      p_actor: actor,
      p_business_id: parsed.data.businessId,
      p_subject: parsed.data.subject,
      p_body: parsed.data.body,
    });
    revalidatePath("/settings/support");
    return { ok: true, message: "Ticket sent. RestroNex support replies here." };
  } catch (error) {
    return { ok: false, error: adminServiceMessage(error) };
  }
}

export async function replySupportTicketAction(
  _previous: SupportActionState | undefined,
  formData: FormData,
): Promise<SupportActionState> {
  const parsed = tenantReplySchema.safeParse({
    businessId: String(formData.get("businessId") ?? ""),
    ticketId: String(formData.get("ticketId") ?? ""),
    body: String(formData.get("body") ?? ""),
  });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Check the highlighted fields." };
  }
  const actor = await getSessionUserId();
  if (!actor) return { ok: false, error: SIGN_IN_AGAIN };
  try {
    await adminRpc("support_ticket_reply", {
      p_actor: actor,
      p_business_id: parsed.data.businessId,
      p_ticket_id: parsed.data.ticketId,
      p_body: parsed.data.body,
    });
    revalidatePath("/settings/support");
    return { ok: true, message: "Reply sent." };
  } catch (error) {
    return { ok: false, error: adminServiceMessage(error) };
  }
}
