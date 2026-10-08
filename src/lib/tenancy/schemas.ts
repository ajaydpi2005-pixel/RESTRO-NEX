import { z } from "zod";

/**
 * Validation for tenant-scoped input. All ids arriving from the client are
 * untrusted: they are shape-checked here and then re-verified against the
 * caller's server-resolved membership directory before anything runs.
 */

/** Strict UUID shape for any tenant/outlet id. */
export const uuidSchema = z.uuid({ error: "Expected a valid UUID." });

/**
 * The tenant selection a client may submit (e.g. "operate in this business,
 * at this outlet"). Outlet is optional where business-level flows apply.
 */
export const tenantSelectionSchema = z.object({
  businessId: uuidSchema,
  outletId: uuidSchema.optional(),
});

export type TenantSelection = z.infer<typeof tenantSelectionSchema>;

/** Parse unknown client input into a TenantSelection or return zod issues. */
export function parseTenantSelection(input: unknown) {
  return tenantSelectionSchema.safeParse(input);
}
