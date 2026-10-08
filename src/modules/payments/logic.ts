import { parseMoneyToMinor } from "@/lib/money";

/**
 * Pure payment rules shared by the UI previews and the unit tests.
 * The database is the authority: `derive_payment_status` in the Phase 10
 * migration implements exactly the same table, and the reconciliation RPC
 * re-checks every order against the ledger.
 */

export type PaymentStatus = "unpaid" | "partial" | "paid" | "refunded";

export const PAYMENT_STATUS_LABELS: Record<PaymentStatus, string> = {
  unpaid: "Unpaid",
  partial: "Partly paid",
  paid: "Paid",
  refunded: "Refunded",
};

export const MAX_PAYMENT_LINES = 6;

export function netPaidMinor(capturedMinor: number, refundedMinor: number): number {
  return capturedMinor - refundedMinor;
}

export function derivePaymentStatus(totalMinor: number, capturedMinor: number, refundedMinor: number): PaymentStatus {
  if (totalMinor === 0) return "paid";
  if (capturedMinor === 0) return "unpaid";
  const net = netPaidMinor(capturedMinor, refundedMinor);
  if (net <= 0) return "refunded";
  if (net < totalMinor) return "partial";
  return "paid";
}

export function balanceDueMinor(totalMinor: number, capturedMinor: number, refundedMinor: number): number {
  return Math.max(totalMinor - netPaidMinor(capturedMinor, refundedMinor), 0);
}

export function refundableMinor(paymentAmountMinor: number, refundedAgainstPaymentMinor: number): number {
  return Math.max(paymentAmountMinor - refundedAgainstPaymentMinor, 0);
}

/** Change owed back to the customer for a cash line. */
export function cashChangeMinor(amountMinor: number, tenderedMinor: number): number {
  if (tenderedMinor < amountMinor) {
    throw new RangeError("Cash tendered is less than the amount.");
  }
  return tenderedMinor - amountMinor;
}

export interface PaymentDraftLine {
  key: string;
  methodKey: string;
  methodLabel: string;
  kind: "cash" | "upi" | "card" | "other";
  requiresReference: boolean;
  amountText: string;
  tenderedText: string;
  reference: string;
}

export interface PaymentDraftSummary {
  totalMinor: number;
  changeMinor: number;
  errors: string[];
  canSubmit: boolean;
}

/**
 * Live preview of a split-payment draft. Mirrors the server validation so the
 * cashier sees problems before submitting; the RPC repeats every check.
 */
export function summarisePaymentDraft(lines: readonly PaymentDraftLine[], balanceMinor: number): PaymentDraftSummary {
  const errors: string[] = [];
  let totalMinor = 0;
  let changeMinor = 0;

  if (lines.length === 0) errors.push("Add at least one payment.");
  if (lines.length > MAX_PAYMENT_LINES) errors.push(`A bill takes at most ${MAX_PAYMENT_LINES} payment lines.`);
  if (balanceMinor <= 0) errors.push("Nothing is due on this bill.");

  for (const line of lines) {
    const amount = parseMoneyToMinor(line.amountText);
    if (amount === null || amount <= 0) {
      errors.push(`${line.methodLabel}: enter an amount greater than zero.`);
      continue;
    }
    totalMinor += amount;

    if (line.kind === "cash" && line.tenderedText.trim() !== "") {
      const tendered = parseMoneyToMinor(line.tenderedText);
      if (tendered === null || tendered < amount) {
        errors.push(`${line.methodLabel}: cash tendered must be at least the amount.`);
      } else {
        changeMinor += tendered - amount;
      }
    }
    if (line.requiresReference && line.reference.trim() === "") {
      errors.push(`${line.methodLabel}: enter a reference.`);
    }
  }

  if (balanceMinor > 0 && totalMinor > balanceMinor) {
    errors.push("The payments add up to more than the balance due.");
  }

  const allValid = errors.length === 0 && lines.length > 0;
  return {
    totalMinor,
    changeMinor,
    errors,
    canSubmit: allValid && totalMinor > 0 && totalMinor <= balanceMinor,
  };
}
