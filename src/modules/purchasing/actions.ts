"use server";

import { createAdminClient } from "@/lib/supabase/admin";
import { getSessionUserId, permissionErrorMessage, requirePermission } from "@/lib/rbac/enforce";
import { rupeesToMinorUnitCost } from "@/modules/inventory/math";
import { rupeesToPaise } from "@/modules/purchasing/money";
import {
  goodsReceiptSchema,
  purchaseOrderActionSchema,
  purchaseOrderCancelSchema,
  purchaseOrderSchema,
  supplierInvoiceSchema,
  supplierPaymentSchema,
  supplierSchema,
} from "@/modules/purchasing/schemas";

/**
 * Phase 14 — purchasing server actions.
 *
 * Each action re-checks the session and purchasing.manage (business-level for
 * suppliers and payments, outlet-level for orders, receipts and invoices), then
 * calls one SQL RPC. Outlet ids from the form are only a convenience: the RPCs
 * take the outlet from the order or receipt itself and check it again.
 */

export interface PurchasingActionState {
  ok?: boolean;
  error?: string;
  id?: string;
}

const GENERIC_ERROR = "That did not go through. Refresh the page and try again.";
const SIGN_IN_AGAIN = "Sign in again to keep working.";

function values(formData: FormData): Record<string, FormDataEntryValue | null> {
  return Object.fromEntries(formData.entries());
}

function text(value: FormDataEntryValue | null | undefined): string {
  return typeof value === "string" ? value : "";
}

function userMessage(error: { code?: string; message?: string }): string {
  if (error.code === "P0001" || error.code === "42501") return error.message ?? GENERIC_ERROR;
  return GENERIC_ERROR;
}

async function callRpc(name: string, args: Record<string, unknown>, actorId: string): Promise<PurchasingActionState> {
  const admin = createAdminClient();
  const { data, error } = await admin.rpc(name, { p_actor: actorId, ...args });
  if (error) return { ok: false, error: userMessage(error) };
  return { ok: true, id: typeof data === "string" ? data : undefined };
}

async function authorise(
  businessId: string,
  outletIds: string[] = [],
): Promise<{ actorId: string } | { error: string }> {
  const actorId = await getSessionUserId();
  if (!actorId) return { error: SIGN_IN_AGAIN };
  try {
    await requirePermission({ businessId, permission: "purchasing.manage" });
    for (const outletId of outletIds) {
      await requirePermission({ businessId, permission: "purchasing.manage", outletId });
    }
  } catch (error) {
    return { error: permissionErrorMessage(error) };
  }
  return { actorId };
}

function parseLines(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function firstIssue(error: { issues: { message: string }[] }): string {
  return error.issues[0]?.message ?? GENERIC_ERROR;
}

export async function saveSupplierAction(
  _prev: PurchasingActionState | undefined,
  formData: FormData,
): Promise<PurchasingActionState> {
  const v = values(formData);
  const parsed = supplierSchema.safeParse({
    businessId: text(v.businessId),
    id: text(v.id),
    name: text(v.name),
    contactName: text(v.contactName),
    phone: text(v.phone),
    email: text(v.email),
    gstin: text(v.gstin),
    address: text(v.address),
    paymentTermsDays: text(v.paymentTermsDays),
    status: text(v.status) || "active",
    notes: text(v.notes),
  });
  if (!parsed.success) return { ok: false, error: firstIssue(parsed.error) };
  const input = parsed.data;

  const auth = await authorise(input.businessId);
  if ("error" in auth) return { ok: false, error: auth.error };

  return callRpc(
    "supplier_save",
    {
      p_business_id: input.businessId,
      p_id: input.id ?? null,
      p_name: input.name,
      p_contact_name: input.contactName ?? null,
      p_phone: input.phone ?? null,
      p_email: input.email ?? null,
      p_gstin: input.gstin ?? null,
      p_address: input.address ?? null,
      p_payment_terms_days: input.paymentTermsDays,
      p_status: input.status,
      p_notes: input.notes ?? null,
    },
    auth.actorId,
  );
}

export async function savePurchaseOrderAction(
  _prev: PurchasingActionState | undefined,
  formData: FormData,
): Promise<PurchasingActionState> {
  const v = values(formData);
  const rawLines = parseLines(text(v.lines));
  if (!Array.isArray(rawLines)) return { ok: false, error: "Add at least one line." };
  const parsed = purchaseOrderSchema.safeParse({
    businessId: text(v.businessId),
    outletId: text(v.outletId),
    supplierId: text(v.supplierId),
    id: text(v.id),
    expectedOn: text(v.expectedOn),
    notes: text(v.notes),
    lines: rawLines,
  });
  if (!parsed.success) return { ok: false, error: firstIssue(parsed.error) };
  const input = parsed.data;

  const auth = await authorise(input.businessId, [input.outletId]);
  if ("error" in auth) return { ok: false, error: auth.error };

  return callRpc(
    "purchase_order_save",
    {
      p_outlet_id: input.outletId,
      p_supplier_id: input.supplierId,
      p_id: input.id ?? null,
      p_expected_on: input.expectedOn ?? null,
      p_notes: input.notes ?? null,
      p_lines: input.lines.map((l) => ({
        ingredient_id: l.ingredientId,
        unit: l.unit,
        qty: l.qty,
        unit_cost: rupeesToMinorUnitCost(l.unitCostRupees),
      })),
    },
    auth.actorId,
  );
}

async function purchaseOrderTransition(
  formData: FormData,
  run: (actorId: string, poId: string) => Promise<PurchasingActionState>,
): Promise<PurchasingActionState> {
  const v = values(formData);
  const parsed = purchaseOrderActionSchema.safeParse({
    businessId: text(v.businessId),
    outletId: text(v.outletId),
    purchaseOrderId: text(v.purchaseOrderId),
  });
  if (!parsed.success) return { ok: false, error: firstIssue(parsed.error) };
  const auth = await authorise(parsed.data.businessId, [parsed.data.outletId]);
  if ("error" in auth) return { ok: false, error: auth.error };
  return run(auth.actorId, parsed.data.purchaseOrderId);
}

export async function sendPurchaseOrderAction(
  _prev: PurchasingActionState | undefined,
  formData: FormData,
): Promise<PurchasingActionState> {
  return purchaseOrderTransition(formData, (actorId, poId) =>
    callRpc("purchase_order_send", { p_po: poId }, actorId),
  );
}

export async function cancelPurchaseOrderAction(
  _prev: PurchasingActionState | undefined,
  formData: FormData,
): Promise<PurchasingActionState> {
  const v = values(formData);
  const parsed = purchaseOrderCancelSchema.safeParse({
    businessId: text(v.businessId),
    outletId: text(v.outletId),
    purchaseOrderId: text(v.purchaseOrderId),
    reason: text(v.reason),
  });
  if (!parsed.success) return { ok: false, error: firstIssue(parsed.error) };
  const auth = await authorise(parsed.data.businessId, [parsed.data.outletId]);
  if ("error" in auth) return { ok: false, error: auth.error };
  return callRpc(
    "purchase_order_cancel",
    { p_po: parsed.data.purchaseOrderId, p_reason: parsed.data.reason },
    auth.actorId,
  );
}

export async function postGoodsReceiptAction(
  _prev: PurchasingActionState | undefined,
  formData: FormData,
): Promise<PurchasingActionState> {
  const v = values(formData);
  const rawLines = parseLines(text(v.lines));
  if (!Array.isArray(rawLines)) return { ok: false, error: "Enter the quantity received for at least one line." };
  const parsed = goodsReceiptSchema.safeParse({
    businessId: text(v.businessId),
    outletId: text(v.outletId),
    purchaseOrderId: text(v.purchaseOrderId),
    clientRef: text(v.clientRef),
    deliveryNote: text(v.deliveryNote),
    notes: text(v.notes),
    lines: rawLines
      .filter((l) => l && typeof l === "object" && Number((l as { qty?: unknown }).qty) > 0)
      .map((l) => {
        const line = l as Record<string, unknown>;
        return {
          poItemId: line.poItemId,
          qty: line.qty,
          unit: line.unit,
          batchCode: line.batchCode,
          expiresOn: line.expiresOn,
        };
      }),
  });
  if (!parsed.success) return { ok: false, error: firstIssue(parsed.error) };
  const input = parsed.data;

  const auth = await authorise(input.businessId, [input.outletId]);
  if ("error" in auth) return { ok: false, error: auth.error };

  return callRpc(
    "goods_receipt_post",
    {
      p_po: input.purchaseOrderId,
      p_client_ref: input.clientRef,
      p_delivery_note: input.deliveryNote ?? null,
      p_notes: input.notes ?? null,
      p_lines: input.lines.map((l) => ({
        po_item_id: l.poItemId,
        qty: l.qty,
        unit: l.unit,
        batch_code: l.batchCode ?? null,
        expires_on: l.expiresOn ?? null,
      })),
    },
    auth.actorId,
  );
}

export async function postSupplierInvoiceAction(
  _prev: PurchasingActionState | undefined,
  formData: FormData,
): Promise<PurchasingActionState> {
  const v = values(formData);
  const rawLines = parseLines(text(v.lines));
  if (!Array.isArray(rawLines)) return { ok: false, error: "Choose at least one received line to bill." };
  const parsed = supplierInvoiceSchema.safeParse({
    businessId: text(v.businessId),
    outletId: text(v.outletId),
    supplierId: text(v.supplierId),
    invoiceNumber: text(v.invoiceNumber),
    invoiceDate: text(v.invoiceDate),
    dueOn: text(v.dueOn),
    taxRupees: text(v.taxRupees) || 0,
    notes: text(v.notes),
    clientRef: text(v.clientRef),
    // The form sends only the lines the user chose to bill.
    lines: rawLines.map((l) => {
      const line = (l ?? {}) as Record<string, unknown>;
      return { goodsReceiptItemId: line.goodsReceiptItemId, unitCostRupees: line.unitCostRupees };
    }),
  });
  if (!parsed.success) return { ok: false, error: firstIssue(parsed.error) };
  const input = parsed.data;

  const auth = await authorise(input.businessId, [input.outletId]);
  if ("error" in auth) return { ok: false, error: auth.error };

  return callRpc(
    "purchase_invoice_post",
    {
      p_outlet_id: input.outletId,
      p_supplier_id: input.supplierId,
      p_invoice_number: input.invoiceNumber,
      p_invoice_date: input.invoiceDate,
      p_due_on: input.dueOn,
      p_tax_minor: rupeesToPaise(input.taxRupees),
      p_notes: input.notes ?? null,
      p_client_ref: input.clientRef,
      p_lines: input.lines.map((l) => ({
        goods_receipt_item_id: l.goodsReceiptItemId,
        unit_cost: rupeesToMinorUnitCost(l.unitCostRupees),
      })),
    },
    auth.actorId,
  );
}

export async function recordSupplierPaymentAction(
  _prev: PurchasingActionState | undefined,
  formData: FormData,
): Promise<PurchasingActionState> {
  const v = values(formData);
  const parsed = supplierPaymentSchema.safeParse({
    businessId: text(v.businessId),
    supplierId: text(v.supplierId),
    amountRupees: text(v.amountRupees),
    method: text(v.method),
    paidOn: text(v.paidOn),
    reference: text(v.reference),
    clientRef: text(v.clientRef),
  });
  if (!parsed.success) return { ok: false, error: firstIssue(parsed.error) };
  const input = parsed.data;

  const auth = await authorise(input.businessId);
  if ("error" in auth) return { ok: false, error: auth.error };

  return callRpc(
    "supplier_payment_record",
    {
      p_business_id: input.businessId,
      p_supplier_id: input.supplierId,
      p_amount: rupeesToPaise(input.amountRupees),
      p_method: input.method,
      p_paid_on: input.paidOn ?? null,
      p_reference: input.reference ?? null,
      p_notes: null,
      p_client_ref: input.clientRef,
    },
    auth.actorId,
  );
}
