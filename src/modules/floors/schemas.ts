import { z } from "zod";

/**
 * Phase 9 — floor/table form validation (client hints + server re-check).
 * The DB RPCs enforce the same limits again; the server actions never
 * forward raw form input.
 */

const idField = z.uuid({ message: "Invalid identifier." });

const nameField = z
  .string()
  .trim()
  .min(1, "Required.")
  .max(60, "Keep it under 60 characters.");

export const saveFloorSchema = z.object({
  businessId: idField,
  outletId: idField,
  floorId: z.union([idField, z.literal("")]).default(""),
  name: nameField,
});

export const deleteFloorSchema = z.object({
  businessId: idField,
  floorId: idField,
});

export const saveSectionSchema = z.object({
  businessId: idField,
  outletId: idField,
  sectionId: z.union([idField, z.literal("")]).default(""),
  floorId: idField,
  name: nameField,
});

export const deleteSectionSchema = z.object({
  businessId: idField,
  sectionId: idField,
});

export const saveTableSchema = z
  .object({
    businessId: idField,
    outletId: idField,
    tableId: z.union([idField, z.literal("")]).default(""),
    sectionId: idField,
    label: z
      .string()
      .trim()
      .min(1, "Required.")
      .max(20, "Keep labels under 20 characters."),
    capacity: z.coerce
      .number({ message: "Capacity must be a number." })
      .int("Whole seats only.")
      .min(1, "At least 1 seat.")
      .max(50, "At most 50 seats."),
  });

export const deleteTableSchema = z.object({
  businessId: idField,
  tableId: idField,
});

export const reserveTableSchema = z.object({
  businessId: idField,
  tableId: idField,
  note: z.string().trim().max(120, "Keep notes under 120 characters.").optional(),
});

export const tableIdSchema = z.object({
  businessId: idField,
  tableId: idField,
});

export const transferTableSchema = z.object({
  businessId: idField,
  orderId: idField,
  toTableId: idField,
});

export const mergeTablesSchema = z.object({
  businessId: idField,
  keepOrderId: idField,
  mergeOrderId: idField,
});

export const splitOrderSchema = z
  .object({
    businessId: idField,
    orderId: idField,
    itemIds: z.array(idField).min(1, "Pick at least one item to move."),
    toTableId: idField,
  });

export type SaveFloorInput = z.infer<typeof saveFloorSchema>;
export type DeleteFloorInput = z.infer<typeof deleteFloorSchema>;
export type SaveSectionInput = z.infer<typeof saveSectionSchema>;
export type DeleteSectionInput = z.infer<typeof deleteSectionSchema>;
export type SaveTableInput = z.infer<typeof saveTableSchema>;
export type DeleteTableInput = z.infer<typeof deleteTableSchema>;
export type ReserveTableInput = z.infer<typeof reserveTableSchema>;
export type TableIdInput = z.infer<typeof tableIdSchema>;
export type TransferTableInput = z.infer<typeof transferTableSchema>;
export type MergeTablesInput = z.infer<typeof mergeTablesSchema>;
export type SplitOrderInput = z.infer<typeof splitOrderSchema>;
