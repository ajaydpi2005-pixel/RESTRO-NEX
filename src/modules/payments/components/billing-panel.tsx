"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useActionState } from "react";
import { Loader2, Plus, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { formatMinor, minorToDecimalText } from "@/lib/money";
import {
  issueInvoiceAction,
  recordPaymentsAction,
  refundPaymentAction,
  voidInvoiceAction,
  type PaymentActionState,
} from "@/modules/payments/actions";
import { PAYMENT_COLLECTION_AVAILABLE } from "@/modules/payments/availability";
import {
  MAX_PAYMENT_LINES,
  PAYMENT_STATUS_LABELS,
  refundableMinor,
  summarisePaymentDraft,
  type PaymentDraftLine,
  type PaymentStatus,
} from "@/modules/payments/logic";
import type { BillingPaymentRow, InvoiceView, MethodOption, OrderBilling } from "@/modules/payments/queries";

/**
 * Phase 10 — billing panel on the order page. Every money action goes through
 * a server action (permission-checked, RPC-backed). The panel never computes
 * the authoritative balance; it displays what the ledger reports.
 */

const money = (minor: number) => `₹${formatMinor(minor)}`;

const STATUS_CLASS: Record<PaymentStatus, string> = {
  unpaid: "bg-amber-100 text-amber-900",
  partial: "bg-sky-100 text-sky-900",
  paid: "bg-emerald-100 text-emerald-900",
  refunded: "bg-rose-100 text-rose-900",
};

const inputClass = "h-9 rounded-md border border-input bg-background px-2 text-sm";

/** Unique per payment attempt. Not a secret: it only dedupes retries. */
function newClientRef(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function makeId(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

/** Refresh the page after a successful action (once per new result). */
function useRefreshOnOk(state: PaymentActionState | undefined) {
  const router = useRouter();
  React.useEffect(() => {
    if (state?.ok) router.refresh();
  }, [state, router]);
}

function ResultMessages({ state }: { state: PaymentActionState | undefined }) {
  const firstFieldError = state?.fieldErrors ? Object.values(state.fieldErrors).flat()[0] : undefined;
  return (
    <>
      {state?.error || firstFieldError ? (
        <p role="alert" className="text-sm text-destructive">
          {state?.error ?? firstFieldError}
        </p>
      ) : null}
    </>
  );
}

// ── collect payment ─────────────────────────────────────────────────────────

type DraftLine = PaymentDraftLine;

function draftFor(method: MethodOption, amountText: string): DraftLine {
  return {
    key: makeId(),
    methodKey: method.key,
    methodLabel: method.label,
    kind: method.kind,
    requiresReference: method.requiresReference,
    amountText,
    tenderedText: "",
    reference: "",
  };
}

function CollectPaymentForm({
  businessId,
  orderId,
  balanceDueMinor,
  methods,
}: {
  businessId: string;
  orderId: string;
  balanceDueMinor: number;
  methods: MethodOption[];
}) {
  // A fresh batch key per attempt: the parent remounts this form (via `key`)
  // whenever the receipt count changes, so a new payment never reuses a key.
  const [batchKey] = React.useState(newClientRef);
  const [state, action, pending] = useActionState<PaymentActionState | undefined, FormData>(
    recordPaymentsAction,
    undefined,
  );
  useRefreshOnOk(state);

  const usable = methods.filter((m) => m.isActive);
  const [lines, setLines] = React.useState<DraftLine[]>(() =>
    usable[0] ? [draftFor(usable[0], minorToDecimalText(balanceDueMinor))] : [],
  );

  const summary = summarisePaymentDraft(lines, balanceDueMinor);
  const remainingText = minorToDecimalText(Math.max(balanceDueMinor - summary.totalMinor, 0));

  function patchLine(key: string, patch: Partial<DraftLine>) {
    setLines((prev) => prev.map((line) => (line.key === key ? { ...line, ...patch } : line)));
  }

  function changeMethod(key: string, methodKey: string) {
    const method = usable.find((m) => m.key === methodKey);
    if (!method) return;
    patchLine(key, {
      methodKey: method.key,
      methodLabel: method.label,
      kind: method.kind,
      requiresReference: method.requiresReference,
      tenderedText: "",
      reference: "",
    });
  }

  function addLine() {
    if (!usable[0] || lines.length >= MAX_PAYMENT_LINES) return;
    setLines((prev) => [...prev, draftFor(usable[0]!, remainingText)]);
  }

  const linesJson = JSON.stringify(
    lines.map((line) => ({
      methodKey: line.methodKey,
      amount: line.amountText,
      tendered: line.kind === "cash" ? line.tenderedText : "",
      reference: line.reference,
    })),
  );

  if (usable.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No active payment methods. Add one in Payments → Payment methods.
      </p>
    );
  }

  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="businessId" value={businessId} />
      <input type="hidden" name="orderId" value={orderId} />
      <input type="hidden" name="batchKey" value={batchKey} />
      <input type="hidden" name="lines" value={linesJson} />

      {lines.map((line) => (
        <div key={line.key} className="flex flex-wrap items-center gap-2">
          <select
            aria-label="Payment method"
            value={line.methodKey}
            onChange={(e) => changeMethod(line.key, e.target.value)}
            className={`${inputClass} w-40`}
          >
            {usable.map((m) => (
              <option key={m.key} value={m.key}>
                {m.label}
              </option>
            ))}
          </select>
          <Input
            aria-label="Amount"
            inputMode="decimal"
            placeholder="0.00"
            value={line.amountText}
            onChange={(e) => patchLine(line.key, { amountText: e.target.value })}
            className="h-9 w-32"
          />
          {line.kind === "cash" ? (
            <Input
              aria-label="Cash tendered"
              inputMode="decimal"
              placeholder="Tendered (optional)"
              value={line.tenderedText}
              onChange={(e) => patchLine(line.key, { tenderedText: e.target.value })}
              className="h-9 w-40"
            />
          ) : null}
          {line.requiresReference ? (
            <Input
              aria-label="Reference"
              placeholder="Reference"
              maxLength={120}
              value={line.reference}
              onChange={(e) => patchLine(line.key, { reference: e.target.value })}
              className="h-9 min-w-40 flex-1"
            />
          ) : null}
          {lines.length > 1 ? (
            <Button
              type="button"
              variant="ghost"
              className="h-9 w-9 p-0"
              aria-label="Remove payment line"
              onClick={() => setLines((prev) => prev.filter((l) => l.key !== line.key))}
            >
              <Trash2 />
            </Button>
          ) : null}
        </div>
      ))}

      <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
        <span>
          Applying <strong className="tabular-nums">{money(summary.totalMinor)}</strong> of{" "}
          <span className="tabular-nums">{money(balanceDueMinor)}</span> due
        </span>
        {summary.changeMinor > 0 ? (
          <span>
            Change due <strong className="tabular-nums">{money(summary.changeMinor)}</strong>
          </span>
        ) : null}
      </div>

      {summary.errors.length > 0 ? (
        <ul className="list-disc space-y-0.5 pl-5 text-xs text-muted-foreground">
          {summary.errors.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="outline"
          className="h-9"
          onClick={addLine}
          disabled={lines.length >= MAX_PAYMENT_LINES || pending}
        >
          <Plus /> Add payment
        </Button>
        <Button
          type="submit"
          className="h-9 bg-ink text-parchment hover:bg-ink-soft"
          disabled={pending || !summary.canSubmit || !PAYMENT_COLLECTION_AVAILABLE}
        >
          {pending ? <Loader2 className="animate-spin" /> : null} Record payment
        </Button>
      </div>

      <ResultMessages state={state} />
      {state?.ok ? (
        <p role="status" className="text-sm text-emerald-800">
          {state.duplicate ? "This payment was already recorded. " : "Payment recorded. "}
          {state.receiptId ? (
            <Link className="underline" href={`/payments/receipts/${state.receiptId}?business=${businessId}`}>
              View receipt {state.receiptNo}
            </Link>
          ) : null}
        </p>
      ) : null}
    </form>
  );
}

// ── refunds ─────────────────────────────────────────────────────────────────

function RefundForm({
  businessId,
  payment,
  refundable,
  onDone,
}: {
  businessId: string;
  payment: BillingPaymentRow;
  refundable: number;
  onDone: () => void;
}) {
  const [refundKey] = React.useState(newClientRef);
  const [state, action, pending] = useActionState<PaymentActionState | undefined, FormData>(
    refundPaymentAction,
    undefined,
  );
  useRefreshOnOk(state);
  return (
    <form action={action} className="flex flex-wrap items-center gap-2 pt-2">
      <input type="hidden" name="businessId" value={businessId} />
      <input type="hidden" name="paymentId" value={payment.id} />
      <input type="hidden" name="refundKey" value={refundKey} />
      <Input
        name="amount"
        aria-label="Refund amount"
        inputMode="decimal"
        defaultValue={minorToDecimalText(refundable)}
        className="h-9 w-32"
      />
      <Input name="reason" aria-label="Refund reason" placeholder="Reason (required)" minLength={3} maxLength={200} required className="h-9 min-w-48 flex-1" />
      <Button type="submit" variant="destructive" className="h-9" disabled={pending}>
        {pending ? <Loader2 className="animate-spin" /> : null} Refund
      </Button>
      <Button type="button" variant="ghost" className="h-9" onClick={onDone} disabled={pending}>
        Cancel
      </Button>
      <div className="w-full">
        <ResultMessages state={state} />
      </div>
    </form>
  );
}

function RefundControl({ businessId, payment }: { businessId: string; payment: BillingPaymentRow }) {
  const [open, setOpen] = React.useState(false);
  const refundable = refundableMinor(payment.amountMinor, payment.refundedMinor);
  if (refundable <= 0) return null;
  if (!open) {
    return (
      <Button type="button" variant="outline" className="h-8" onClick={() => setOpen(true)}>
        Refund
      </Button>
    );
  }
  return (
    <RefundForm
      key={payment.refundedMinor}
      businessId={businessId}
      payment={payment}
      refundable={refundable}
      onDone={() => setOpen(false)}
    />
  );
}

// ── invoice ─────────────────────────────────────────────────────────────────

function IssueInvoiceControl({ businessId, orderId }: { businessId: string; orderId: string }) {
  const [state, action, pending] = useActionState<PaymentActionState | undefined, FormData>(
    issueInvoiceAction,
    undefined,
  );
  useRefreshOnOk(state);
  return (
    <form action={action} className="space-y-2">
      <input type="hidden" name="businessId" value={businessId} />
      <input type="hidden" name="orderId" value={orderId} />
      <Button type="submit" variant="outline" className="h-9" disabled={pending}>
        {pending ? <Loader2 className="animate-spin" /> : null} Issue invoice
      </Button>
      <ResultMessages state={state} />
    </form>
  );
}

function VoidInvoiceControl({ businessId, invoiceId }: { businessId: string; invoiceId: string }) {
  const [state, action, pending] = useActionState<PaymentActionState | undefined, FormData>(
    voidInvoiceAction,
    undefined,
  );
  useRefreshOnOk(state);
  return (
    <form action={action} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="businessId" value={businessId} />
      <input type="hidden" name="invoiceId" value={invoiceId} />
      <Input name="reason" aria-label="Void reason" placeholder="Reason to void (required)" minLength={3} maxLength={200} required className="h-9 min-w-48 flex-1" />
      <Button type="submit" variant="outline" className="h-9 border-destructive/40 text-destructive" disabled={pending}>
        {pending ? <Loader2 className="animate-spin" /> : null} Void invoice
      </Button>
      <div className="w-full">
        <ResultMessages state={state} />
      </div>
    </form>
  );
}

// ── panel ───────────────────────────────────────────────────────────────────

export interface BillingPanelProps {
  businessId: string;
  orderId: string;
  orderStatus: string;
  billing: OrderBilling;
  invoice: InvoiceView | null;
  canCollect: boolean;
  canRefund: boolean;
}

export function BillingPanel({ businessId, orderId, orderStatus, billing, invoice, canCollect, canRefund }: BillingPanelProps) {
  const balance = billing.balanceDueMinor;
  const canTakePayment = canCollect && balance > 0 && orderStatus !== "cancelled";

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 space-y-0">
        <CardTitle className="text-base">Billing</CardTitle>
        <Badge className={`border-0 px-2.5 py-0.5 ${STATUS_CLASS[billing.paymentStatus]}`}>
          {PAYMENT_STATUS_LABELS[billing.paymentStatus]}
        </Badge>
      </CardHeader>
      <CardContent className="space-y-5">
        <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
          <div>
            <dt className="text-xs text-muted-foreground">Total</dt>
            <dd className="font-medium tabular-nums">{money(billing.totalMinor)}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Paid (net)</dt>
            <dd className="font-medium tabular-nums">{money(billing.paidMinor)}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Refunded</dt>
            <dd className="font-medium tabular-nums">{money(billing.refundedMinor)}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Balance due</dt>
            <dd className="font-semibold tabular-nums">{money(balance)}</dd>
          </div>
        </dl>

        {billing.payments.length > 0 ? (
          <div className="space-y-2">
            <h3 className="text-sm font-medium">Payments</h3>
            <ul className="divide-y divide-border rounded-lg border border-border">
              {billing.payments.map((p) => {
                const refundable = refundableMinor(p.amountMinor, p.refundedMinor);
                return (
                  <li key={p.id} className="space-y-1 px-3 py-2 text-sm">
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <span>
                        <span className="font-medium">{p.methodLabel}</span>
                        {p.reference ? <span className="ml-2 text-xs text-muted-foreground">ref {p.reference}</span> : null}
                        {p.changeMinor > 0 ? (
                          <span className="ml-2 text-xs text-muted-foreground">change {money(p.changeMinor)}</span>
                        ) : null}
                      </span>
                      <span className="tabular-nums">
                        {money(p.amountMinor)}
                        {p.refundedMinor > 0 ? (
                          <span className="ml-2 text-xs text-rose-700">−{money(p.refundedMinor)} refunded</span>
                        ) : null}
                      </span>
                    </div>
                    <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
                      <span>
                        {p.receiptNo ? (
                          <Link className="underline" href={`/payments/receipts/${p.receiptId}?business=${businessId}`}>
                            Receipt {p.receiptNo}
                          </Link>
                        ) : null}{" "}
                        · {new Date(p.createdAt).toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}
                      </span>
                      {canRefund && refundable > 0 ? <RefundControl businessId={businessId} payment={p} /> : null}
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
        ) : null}

        {billing.refunds.length > 0 ? (
          <div className="space-y-2">
            <h3 className="text-sm font-medium">Refunds</h3>
            <ul className="space-y-1 text-sm">
              {billing.refunds.map((r) => (
                <li key={r.id} className="flex flex-wrap justify-between gap-2">
                  <span className="text-muted-foreground">
                    {r.reason}
                    {r.receiptNo ? (
                      <>
                        {" "}
                        · <Link className="underline" href={`/payments/receipts/${r.receiptId}?business=${businessId}`}>{r.receiptNo}</Link>
                      </>
                    ) : null}
                  </span>
                  <span className="tabular-nums text-rose-700">−{money(r.amountMinor)}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {canTakePayment ? (
          <div className="space-y-2 rounded-lg border border-border p-3">
            <h3 className="text-sm font-medium">Record payment</h3>
            <p className="text-xs text-muted-foreground">
              Split or partial payments are supported. The order can be completed once the bill is paid in full.
            </p>
            <CollectPaymentForm
              key={billing.receipts.length}
              businessId={businessId}
              orderId={orderId}
              balanceDueMinor={balance}
              methods={billing.activeMethods}
            />
          </div>
        ) : balance > 0 && orderStatus !== "cancelled" ? (
          <p className="text-sm text-muted-foreground">Payments are recorded by cashiers and managers.</p>
        ) : null}

        {billing.receipts.length > 0 ? (
          <div className="space-y-2">
            <h3 className="text-sm font-medium">Receipts</h3>
            <ul className="space-y-1 text-sm">
              {billing.receipts.map((r) => (
                <li key={r.id} className="flex flex-wrap justify-between gap-2">
                  <Link className="underline" href={`/payments/receipts/${r.id}?business=${businessId}`}>
                    {r.receiptNo}
                  </Link>
                  <span className="text-xs text-muted-foreground">
                    {r.kind === "refund" ? "Refund" : "Payment"} · {money(r.amountMinor)}
                    {r.printCount > 0 ? ` · printed ${r.printCount}×` : ""}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        <div className="space-y-2 border-t border-border pt-4">
          <h3 className="text-sm font-medium">Invoice</h3>
          {invoice && invoice.status === "issued" ? (
            <div className="space-y-2">
              <p className="text-sm">
                <Link className="underline" href={`/payments/invoices/${orderId}?business=${businessId}`}>
                  {invoice.invoiceNo}
                </Link>{" "}
                <span className="text-muted-foreground">· {money(invoice.totalMinor)}</span>
              </p>
              {canRefund ? <VoidInvoiceControl businessId={businessId} invoiceId={invoice.id} /> : null}
            </div>
          ) : (
            <div className="space-y-2">
              {invoice ? (
                <p className="text-xs text-muted-foreground">
                  Invoice {invoice.invoiceNo} was voided{invoice.voidReason ? `: ${invoice.voidReason}` : ""}.
                </p>
              ) : null}
              {canCollect && billing.totalMinor > 0 ? (
                <IssueInvoiceControl businessId={businessId} orderId={orderId} />
              ) : (
                <p className="text-xs text-muted-foreground">No invoice issued yet.</p>
              )}
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
