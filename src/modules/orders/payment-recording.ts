import { callLedger, LedgerError } from "@/modules/payments/ledger";

/**
 * Phase 10 — the ONLY place that records customer payments.
 *
 * Phase 8 shipped this as a throwing stub. It now delegates to the
 * `record_payments` RPC, which:
 *   - locks the order row, so concurrent payments serialise;
 *   - dedupes on the batch key, so a retried submit cannot charge twice;
 *   - validates every line in SQL (method, amount, tender, reference, balance);
 *   - writes the payment rows, a numbered receipt and an audit entry, then
 *     recomputes `orders.paid_minor` / `payment_status` from the ledger.
 *
 * Amounts are integer minor units. Callers must pass parsed integers, never
 * floats or display strings.
 */

export interface PaymentLineRecord {
  methodKey: string;
  amountMinor: number;
  tenderedMinor?: number | null;
  reference?: string | null;
}

export interface RecordPaymentBatchInput {
  actorUserId: string;
  orderId: string;
  batchKey: string;
  lines: PaymentLineRecord[];
}

export interface RecordPaymentBatchResult {
  duplicate: boolean;
  receiptId: string;
  receiptNo: string;
  amountMinor: number;
  balanceDueMinor: number;
}

export async function recordPaymentBatch(input: RecordPaymentBatchInput): Promise<RecordPaymentBatchResult> {
  const result = await callLedger<{
    duplicate: boolean;
    receipt_id: string;
    receipt_no: string;
    amount_minor: number;
    balance_due_minor: number;
  }>("record_payments", {
    p_actor: input.actorUserId,
    p_order_id: input.orderId,
    p_batch_key: input.batchKey,
    p_lines: input.lines.map((line) => ({
      method_key: line.methodKey,
      amount_minor: line.amountMinor,
      tendered_minor: line.tenderedMinor ?? null,
      reference: line.reference ?? null,
    })),
  });
  return {
    duplicate: Boolean(result.duplicate),
    receiptId: result.receipt_id,
    receiptNo: result.receipt_no,
    amountMinor: Number(result.amount_minor),
    balanceDueMinor: Number(result.balance_due_minor),
  };
}

export { LedgerError };
