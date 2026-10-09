import { z } from "zod";
import { KITCHEN_STATUSES, KITCHEN_TARGETS } from "./constants";

/**
 * Phase 11 — kitchen form and action validation. Client hints plus a server
 * re-check; the RPCs re-verify membership, outlet grants and transitions.
 */

const idField = z.uuid({ message: "Invalid identifier." });

export const advanceItemSchema = z.object({
  outletId: idField,
  itemId: idField,
  from: z.enum(KITCHEN_STATUSES),
  to: z.enum(KITCHEN_TARGETS),
});

export const advanceTicketSchema = z.object({
  outletId: idField,
  orderId: idField,
  stationId: z.union([idField, z.null()]),
  from: z.enum(KITCHEN_STATUSES),
  to: z.enum(KITCHEN_TARGETS),
});

export const setPrioritySchema = z.object({
  outletId: idField,
  orderId: idField,
  priority: z.boolean(),
});

export const acknowledgeSchema = z.object({
  outletId: idField,
  eventId: idField,
});

export const snapshotSchema = z.object({ outletId: idField });

const stationNameField = z
  .string()
  .trim()
  .min(1, "Every station needs a name.")
  .max(60, "Keep station names under 60 characters.");

export const stationsPayloadSchema = z
  .object({
    outletId: idField,
    stations: z
      .array(
        z.object({
          name: stationNameField,
          description: z
            .string()
            .trim()
            .max(200, "Keep descriptions under 200 characters.")
            .transform((value) => (value === "" ? null : value))
            .nullable(),
        }),
      )
      .max(20, "Up to 20 stations per outlet."),
  })
  .superRefine((value, ctx) => {
    const seen = new Set<string>();
    for (const station of value.stations) {
      const key = station.name.toLowerCase();
      if (seen.has(key)) {
        ctx.addIssue({ code: "custom", message: `Station "${station.name}" is listed twice.`, path: ["stations"] });
        return;
      }
      seen.add(key);
    }
  });

export const routesPayloadSchema = z.object({
  outletId: idField,
  routes: z
    .array(
      z.object({
        targetType: z.enum(["category", "item", "combo"]),
        targetId: idField,
        stationId: idField,
      }),
    )
    .max(500, "Too many routes in one save."),
});

export type AdvanceItemInput = z.infer<typeof advanceItemSchema>;
export type AdvanceTicketInput = z.infer<typeof advanceTicketSchema>;
export type StationsPayload = z.infer<typeof stationsPayloadSchema>;
export type RoutesPayload = z.infer<typeof routesPayloadSchema>;
