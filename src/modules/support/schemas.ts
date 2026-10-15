import { z } from "zod";

/**
 * Tenant support input (pure). The database checks settings.manage and the
 * ticket's business again; these rules only give quick, specific messages.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuid = z.string().trim().regex(UUID, "Pick a valid record.");

export const openTicketSchema = z.object({
  businessId: uuid,
  subject: z
    .string()
    .trim()
    .min(3, "The subject needs at least 3 characters.")
    .max(120, "Keep the subject under 120 characters."),
  body: z
    .string()
    .trim()
    .min(1, "Describe the problem.")
    .max(4000, "Keep the message under 4000 characters."),
});

export const tenantReplySchema = z.object({
  businessId: uuid,
  ticketId: uuid,
  body: z
    .string()
    .trim()
    .min(1, "Write a reply.")
    .max(4000, "Keep the reply under 4000 characters."),
});
