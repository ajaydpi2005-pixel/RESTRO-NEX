import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Phase 10 — thin, typed wrappers around the money RPCs.
 *
 * SERVER ONLY. Every call here runs as service role AFTER the caller has been
 * authorised by `requirePermission` in actions.ts; the RPCs then re-check the
 * actor's membership, outlet grant and permission in SQL (defence in depth).
 * Nothing in this file touches `orders.paid_minor` — the ledger does.
 */

export class LedgerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LedgerError";
  }
}

export async function callLedger<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  const admin = createAdminClient();
  const { data, error } = await admin.rpc(fn, args);
  if (error) {
    throw new LedgerError(error.message || "The payment could not be processed. Please try again.");
  }
  return data as T;
}

export interface RefundRpcResult {
  duplicate: boolean;
  refund_id?: string;
  receipt_id: string;
  receipt_no: string;
  amount_minor?: number;
}

export function refundPaymentRpc(input: {
  actorUserId: string;
  paymentId: string;
  amountMinor: number;
  reason: string;
  clientRef: string;
}): Promise<RefundRpcResult> {
  return callLedger<RefundRpcResult>("refund_payment", {
    p_actor: input.actorUserId,
    p_payment_id: input.paymentId,
    p_amount_minor: input.amountMinor,
    p_reason: input.reason,
    p_client_ref: input.clientRef,
  });
}

export interface InvoiceRpcResult {
  duplicate: boolean;
  invoice_id: string;
  invoice_no: string;
}

export function issueInvoiceRpc(input: { actorUserId: string; orderId: string }): Promise<InvoiceRpcResult> {
  return callLedger<InvoiceRpcResult>("issue_invoice", {
    p_actor: input.actorUserId,
    p_order_id: input.orderId,
  });
}

export function voidInvoiceRpc(input: { actorUserId: string; invoiceId: string; reason: string }) {
  return callLedger<{ invoice_no: string }>("void_invoice", {
    p_actor: input.actorUserId,
    p_invoice_id: input.invoiceId,
    p_reason: input.reason,
  });
}

/** Counts a print; prints after the first are audited as reprints. */
export function recordReceiptPrintRpc(input: { actorUserId: string; receiptId: string }): Promise<number> {
  return callLedger<number>("record_receipt_print", {
    p_actor: input.actorUserId,
    p_receipt_id: input.receiptId,
  });
}

export function savePaymentMethodRpc(input: {
  actorUserId: string;
  businessId: string;
  methodId: string | null;
  key: string | null;
  label: string;
  kind: string;
  requiresReference: boolean;
  isActive: boolean;
}): Promise<string> {
  return callLedger<string>("save_payment_method", {
    p_actor: input.actorUserId,
    p_business_id: input.businessId,
    p_method_id: input.methodId,
    p_key: input.key,
    p_label: input.label,
    p_kind: input.kind,
    p_requires_reference: input.requiresReference,
    p_is_active: input.isActive,
  });
}

export interface ReconciliationReport {
  from: string;
  to: string;
  totals: {
    payment_count: number;
    refund_count: number;
    captured_minor: number;
    refunded_minor: number;
    net_minor: number;
  };
  methods: {
    method_key: string;
    payment_count: number;
    refund_count: number;
    captured_minor: number;
    refunded_minor: number;
    net_minor: number;
  }[];
  invoices: { issued: number; voided: number };
  mismatch_count: number;
  mismatches: {
    order_id: string;
    order_number: number;
    expected_paid_minor: number;
    recorded_paid_minor: number;
    expected_refunded_minor: number;
    recorded_refunded_minor: number;
    expected_status: string;
    recorded_status: string;
  }[];
  balanced: boolean;
}

export function paymentReconciliationRpc(input: {
  actorUserId: string;
  outletId: string;
  fromIso: string;
  toIso: string;
}): Promise<ReconciliationReport> {
  return callLedger<ReconciliationReport>("payment_reconciliation", {
    p_actor: input.actorUserId,
    p_outlet_id: input.outletId,
    p_from: input.fromIso,
    p_to: input.toIso,
  });
}
