import { createAdminClient } from "@/lib/supabase/admin";
import { balanceDueMinor, derivePaymentStatus, type PaymentStatus } from "@/modules/payments/logic";
import { listPaymentProviders, type PaymentProviderStatus } from "@/modules/payments/gateway";
import { paymentReconciliationRpc, type ReconciliationReport } from "@/modules/payments/ledger";
import type { PaymentMethodKind } from "@/modules/payments/schemas";

/**
 * Phase 10 — read models for billing screens. Server only (service role).
 * Callers authorise first (abilities / requirePermission); these functions
 * never trust a client-supplied business or outlet without matching it here.
 */

export interface MethodOption {
  id: string;
  key: string;
  label: string;
  kind: PaymentMethodKind;
  requiresReference: boolean;
  isActive: boolean;
}

export interface BillingPaymentRow {
  id: string;
  methodKey: string;
  methodLabel: string;
  methodKind: PaymentMethodKind;
  amountMinor: number;
  tenderedMinor: number;
  changeMinor: number;
  reference: string | null;
  createdAt: string;
  receiptId: string;
  receiptNo: string;
  refundedMinor: number;
}

export interface BillingRefundRow {
  id: string;
  paymentId: string;
  amountMinor: number;
  reason: string;
  createdAt: string;
  receiptId: string;
  receiptNo: string;
}

export interface BillingInvoiceRow {
  id: string;
  invoiceNo: string;
  status: "issued" | "void";
  totalMinor: number;
  issuedAt: string;
  voidedAt: string | null;
  voidReason: string | null;
}

export interface BillingReceiptRow {
  id: string;
  receiptNo: string;
  kind: "payment" | "refund";
  amountMinor: number;
  balanceAfterMinor: number;
  printCount: number;
  createdAt: string;
}

export interface OrderBilling {
  orderId: string;
  outletId: string;
  orderStatus: string;
  orderNumber: number;
  totalMinor: number;
  paidMinor: number;
  refundedMinor: number;
  balanceDueMinor: number;
  paymentStatus: PaymentStatus;
  billedAt: string | null;
  payments: BillingPaymentRow[];
  refunds: BillingRefundRow[];
  invoices: BillingInvoiceRow[];
  receipts: BillingReceiptRow[];
  activeMethods: MethodOption[];
}

type Row = Record<string, unknown>;
const str = (v: unknown) => (typeof v === "string" ? v : "");
const num = (v: unknown) => Number(v ?? 0);

export async function loadOrderBilling(businessId: string, orderId: string): Promise<OrderBilling | null> {
  const admin = createAdminClient();
  const { data: order } = await admin
    .from("orders")
    .select("id, business_id, outlet_id, status, order_number, total_minor, paid_minor, refunded_minor, payment_status, billed_at")
    .eq("id", orderId)
    .eq("business_id", businessId)
    .maybeSingle();
  if (!order) return null;

  const [paymentsRes, refundsRes, invoicesRes, receiptsRes, methodsRes] = await Promise.all([
    admin
      .from("payments")
      .select("id, method_key, method_kind, amount_minor, tendered_minor, change_minor, reference, status, created_at, receipt_id")
      .eq("order_id", orderId)
      .order("created_at", { ascending: true }),
    admin
      .from("refunds")
      .select("id, payment_id, amount_minor, reason, status, created_at, receipt_id")
      .eq("order_id", orderId)
      .order("created_at", { ascending: true }),
    admin
      .from("invoices")
      .select("id, invoice_no, status, total_minor, issued_at, voided_at, void_reason")
      .eq("order_id", orderId)
      .order("issued_at", { ascending: true }),
    admin
      .from("receipts")
      .select("id, receipt_no, kind, amount_minor, balance_after_minor, print_count, created_at")
      .eq("order_id", orderId)
      .order("created_at", { ascending: true }),
    admin
      .from("payment_methods")
      .select("id, key, label, kind, requires_reference, is_active, sort_order")
      .eq("business_id", businessId)
      .order("sort_order", { ascending: true }),
  ]);

  const methods = (methodsRes.data ?? []) as Row[];
  const labelFor = new Map(methods.map((m) => [str(m.key), str(m.label)]));
  const receipts = (receiptsRes.data ?? []) as Row[];
  const receiptNoFor = new Map(receipts.map((r) => [str(r.id), str(r.receipt_no)]));
  const refunds = (refundsRes.data ?? []) as Row[];
  const payments = (paymentsRes.data ?? []) as Row[];

  const refundedByPayment = new Map<string, number>();
  for (const refund of refunds) {
    if (refund.status !== "succeeded") continue;
    const pid = str(refund.payment_id);
    refundedByPayment.set(pid, (refundedByPayment.get(pid) ?? 0) + num(refund.amount_minor));
  }

  const total = num(order.total_minor);
  const paid = num(order.paid_minor);
  const refunded = num(order.refunded_minor);

  return {
    orderId: str(order.id),
    outletId: str(order.outlet_id),
    orderStatus: str(order.status),
    orderNumber: num(order.order_number),
    totalMinor: total,
    paidMinor: paid,
    refundedMinor: refunded,
    balanceDueMinor: balanceDueMinor(total, paid + refunded, refunded),
    paymentStatus: (str(order.payment_status) || derivePaymentStatus(total, paid + refunded, refunded)) as PaymentStatus,
    billedAt: order.billed_at ? str(order.billed_at) : null,
    payments: payments
      .filter((p) => p.status === "captured")
      .map((p) => ({
        id: str(p.id),
        methodKey: str(p.method_key),
        methodLabel: labelFor.get(str(p.method_key)) ?? str(p.method_key),
        methodKind: str(p.method_kind) as PaymentMethodKind,
        amountMinor: num(p.amount_minor),
        tenderedMinor: num(p.tendered_minor),
        changeMinor: num(p.change_minor),
        reference: p.reference ? str(p.reference) : null,
        createdAt: str(p.created_at),
        receiptId: str(p.receipt_id),
        receiptNo: receiptNoFor.get(str(p.receipt_id)) ?? "",
        refundedMinor: refundedByPayment.get(str(p.id)) ?? 0,
      })),
    refunds: refunds.map((r) => ({
      id: str(r.id),
      paymentId: str(r.payment_id),
      amountMinor: num(r.amount_minor),
      reason: str(r.reason),
      createdAt: str(r.created_at),
      receiptId: str(r.receipt_id),
      receiptNo: receiptNoFor.get(str(r.receipt_id)) ?? "",
    })),
    invoices: ((invoicesRes.data ?? []) as Row[]).map((i) => ({
      id: str(i.id),
      invoiceNo: str(i.invoice_no),
      status: str(i.status) as "issued" | "void",
      totalMinor: num(i.total_minor),
      issuedAt: str(i.issued_at),
      voidedAt: i.voided_at ? str(i.voided_at) : null,
      voidReason: i.void_reason ? str(i.void_reason) : null,
    })),
    receipts: receipts.map((r) => ({
      id: str(r.id),
      receiptNo: str(r.receipt_no),
      kind: str(r.kind) as "payment" | "refund",
      amountMinor: num(r.amount_minor),
      balanceAfterMinor: num(r.balance_after_minor),
      printCount: num(r.print_count),
      createdAt: str(r.created_at),
    })),
    activeMethods: methods
      .filter((m) => m.is_active === true)
      .map((m) => ({
        id: str(m.id),
        key: str(m.key),
        label: str(m.label),
        kind: str(m.kind) as PaymentMethodKind,
        requiresReference: m.requires_reference === true,
        isActive: true,
      })),
  };
}

export interface ReceiptView {
  receipt: BillingReceiptRow & { orderId: string; outletId: string };
  orderNumber: number;
  orderTotalMinor: number;
  outletName: string;
  businessName: string;
  lines: {
    label: string;
    kind: PaymentMethodKind | "refund";
    amountMinor: number;
    tenderedMinor: number | null;
    changeMinor: number;
    reference: string | null;
    detail: string | null;
  }[];
}

export async function loadReceiptView(businessId: string, receiptId: string): Promise<ReceiptView | null> {
  const admin = createAdminClient();
  const { data: receipt } = await admin
    .from("receipts")
    .select("id, business_id, outlet_id, order_id, receipt_no, kind, amount_minor, balance_after_minor, print_count, created_at")
    .eq("id", receiptId)
    .eq("business_id", businessId)
    .maybeSingle();
  if (!receipt) return null;

  const [orderRes, outletRes, businessRes, methodsRes, paymentsRes, refundsRes] = await Promise.all([
    admin.from("orders").select("order_number, total_minor").eq("id", receipt.order_id).maybeSingle(),
    admin.from("outlets").select("name").eq("id", receipt.outlet_id).maybeSingle(),
    admin.from("businesses").select("name").eq("id", businessId).maybeSingle(),
    admin.from("payment_methods").select("key, label").eq("business_id", businessId),
    admin
      .from("payments")
      .select("method_key, method_kind, amount_minor, tendered_minor, change_minor, reference")
      .eq("receipt_id", receipt.id),
    admin.from("refunds").select("amount_minor, reason, payment_id").eq("receipt_id", receipt.id),
  ]);

  const labelFor = new Map(((methodsRes.data ?? []) as Row[]).map((m) => [str(m.key), str(m.label)]));
  const lines: ReceiptView["lines"] = [];

  if (receipt.kind === "payment") {
    for (const p of (paymentsRes.data ?? []) as Row[]) {
      lines.push({
        label: labelFor.get(str(p.method_key)) ?? str(p.method_key),
        kind: str(p.method_kind) as PaymentMethodKind,
        amountMinor: num(p.amount_minor),
        tenderedMinor: num(p.tendered_minor),
        changeMinor: num(p.change_minor),
        reference: p.reference ? str(p.reference) : null,
        detail: null,
      });
    }
  } else {
    for (const r of (refundsRes.data ?? []) as Row[]) {
      lines.push({
        label: "Refund",
        kind: "refund",
        amountMinor: num(r.amount_minor),
        tenderedMinor: null,
        changeMinor: 0,
        reference: null,
        detail: str(r.reason),
      });
    }
  }

  return {
    receipt: {
      id: str(receipt.id),
      receiptNo: str(receipt.receipt_no),
      kind: str(receipt.kind) as "payment" | "refund",
      amountMinor: num(receipt.amount_minor),
      balanceAfterMinor: num(receipt.balance_after_minor),
      printCount: num(receipt.print_count),
      createdAt: str(receipt.created_at),
      orderId: str(receipt.order_id),
      outletId: str(receipt.outlet_id),
    },
    orderNumber: num(orderRes.data?.order_number),
    orderTotalMinor: num(orderRes.data?.total_minor),
    outletName: str(outletRes.data?.name),
    businessName: str(businessRes.data?.name),
    lines,
  };
}

export interface InvoiceSnapshot {
  business_name: string;
  outlet_name: string;
  currency_code: string;
  order_number: number;
  order_type: string;
  table_label: string | null;
  customer_name: string | null;
  customer_phone: string | null;
  delivery_address: string | null;
  items: {
    name: string;
    quantity: number;
    unit_price_minor: number;
    modifiers_minor: number;
    line_total_minor: number;
    item_notes: string | null;
    modifiers: { name: string; quantity: number; price_minor: number }[];
  }[];
  subtotal_minor: number;
  discount_minor: number;
  tax_minor: number;
  charges_minor: number;
  charges: { name: string; amount_minor: number }[];
  total_minor: number;
  paid_minor: number;
}

export interface InvoiceView {
  id: string;
  orderId: string;
  invoiceNo: string;
  status: "issued" | "void";
  totalMinor: number;
  issuedAt: string;
  voidedAt: string | null;
  voidReason: string | null;
  snapshot: InvoiceSnapshot;
}

/** Latest invoice for an order: the issued one if it exists, else the newest void. */
export async function loadLatestInvoice(businessId: string, orderId: string): Promise<InvoiceView | null> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("invoices")
    .select("id, order_id, invoice_no, status, total_minor, snapshot, issued_at, voided_at, void_reason")
    .eq("business_id", businessId)
    .eq("order_id", orderId)
    .order("issued_at", { ascending: false });
  const rows = (data ?? []) as Row[];
  const row = rows.find((r) => r.status === "issued") ?? rows[0];
  if (!row) return null;
  return {
    id: str(row.id),
    orderId: str(row.order_id),
    invoiceNo: str(row.invoice_no),
    status: str(row.status) as "issued" | "void",
    totalMinor: num(row.total_minor),
    issuedAt: str(row.issued_at),
    voidedAt: row.voided_at ? str(row.voided_at) : null,
    voidReason: row.void_reason ? str(row.void_reason) : null,
    snapshot: row.snapshot as InvoiceSnapshot,
  };
}

export interface LedgerPaymentRow {
  id: string;
  orderId: string;
  orderNumber: number;
  methodKey: string;
  amountMinor: number;
  status: string;
  createdAt: string;
  receiptNo: string;
}

export interface LedgerRefundRow {
  id: string;
  orderId: string;
  orderNumber: number;
  methodKey: string;
  amountMinor: number;
  reason: string;
  createdAt: string;
  receiptNo: string;
}

export interface AuditRow {
  id: string;
  action: string;
  targetType: string;
  targetId: string;
  createdAt: string;
  actorUserId: string | null;
  metadata: Record<string, unknown>;
}

export interface PaymentsWorkspace {
  /** Null when the viewer lacks reports.view (reconciliation is a report). */
  reconciliation: ReconciliationReport | null;
  payments: LedgerPaymentRow[];
  refunds: LedgerRefundRow[];
  methods: MethodOption[];
  audit: AuditRow[];
  providers: PaymentProviderStatus[];
}

export async function loadPaymentsWorkspace(input: {
  businessId: string;
  outletId: string;
  actorUserId: string;
  fromIso: string;
  toIso: string;
  canSeeAudit: boolean;
  canReconcile: boolean;
}): Promise<PaymentsWorkspace> {
  const admin = createAdminClient();
  const [reconciliation, paymentsRes, refundsRes, methodsRes, auditRes] = await Promise.all([
    input.canReconcile
      ? paymentReconciliationRpc({
          actorUserId: input.actorUserId,
          outletId: input.outletId,
          fromIso: input.fromIso,
          toIso: input.toIso,
        })
      : Promise.resolve(null),
    admin
      .from("payments")
      .select("id, order_id, method_key, amount_minor, status, created_at, orders(order_number), receipts(receipt_no)")
      .eq("outlet_id", input.outletId)
      .gte("created_at", input.fromIso)
      .lt("created_at", input.toIso)
      .order("created_at", { ascending: false })
      .limit(200),
    admin
      .from("refunds")
      .select("id, order_id, amount_minor, reason, created_at, payments(method_key), orders(order_number), receipts(receipt_no)")
      .eq("outlet_id", input.outletId)
      .gte("created_at", input.fromIso)
      .lt("created_at", input.toIso)
      .order("created_at", { ascending: false })
      .limit(200),
    admin
      .from("payment_methods")
      .select("id, key, label, kind, requires_reference, is_active, sort_order")
      .eq("business_id", input.businessId)
      .order("sort_order", { ascending: true }),
    input.canSeeAudit
      ? admin
          .from("audit_logs")
          .select("id, action, target_type, target_id, created_at, actor_user_id, metadata")
          .eq("business_id", input.businessId)
          .order("created_at", { ascending: false })
          .limit(50)
      : Promise.resolve({ data: [] as Row[] }),
  ]);

  const embedded = (value: unknown): Row => {
    const first = Array.isArray(value) ? value[0] : value;
    return (first ?? {}) as Row;
  };

  return {
    reconciliation,
    payments: ((paymentsRes.data ?? []) as Row[]).map((p) => ({
      id: str(p.id),
      orderId: str(p.order_id),
      orderNumber: num(embedded(p.orders).order_number),
      methodKey: str(p.method_key),
      amountMinor: num(p.amount_minor),
      status: str(p.status),
      createdAt: str(p.created_at),
      receiptNo: str(embedded(p.receipts).receipt_no),
    })),
    refunds: ((refundsRes.data ?? []) as Row[]).map((r) => ({
      id: str(r.id),
      orderId: str(r.order_id),
      orderNumber: num(embedded(r.orders).order_number),
      methodKey: str(embedded(r.payments).method_key),
      amountMinor: num(r.amount_minor),
      reason: str(r.reason),
      createdAt: str(r.created_at),
      receiptNo: str(embedded(r.receipts).receipt_no),
    })),
    methods: ((methodsRes.data ?? []) as Row[]).map((m) => ({
      id: str(m.id),
      key: str(m.key),
      label: str(m.label),
      kind: str(m.kind) as PaymentMethodKind,
      requiresReference: m.requires_reference === true,
      isActive: m.is_active === true,
    })),
    audit: ((auditRes.data ?? []) as Row[]).map((a) => ({
      id: str(a.id),
      action: str(a.action),
      targetType: str(a.target_type),
      targetId: str(a.target_id),
      createdAt: str(a.created_at),
      actorUserId: a.actor_user_id ? str(a.actor_user_id) : null,
      metadata: (a.metadata ?? {}) as Record<string, unknown>,
    })),
    providers: listPaymentProviders(),
  };
}
