import { createAdminClient } from "@/lib/supabase/admin";
import { loadIngredients } from "@/modules/inventory/queries";
import { payablesAging, type AgingInvoice, type AgingPayment, type SupplierAging } from "@/modules/purchasing/aging";
import { fulfilmentPct, priceVariance, spendBySupplier, type InvoiceForSpend, type VarianceLine } from "@/modules/purchasing/reports";

/**
 * Phase 14 — purchasing reads. Pages authorise first (purchasing.view). These
 * loaders use the service client, so every query filters by business and, where
 * it applies, by outlet. Money is returned in paise.
 */

export interface SupplierRow {
  id: string;
  name: string;
  contactName: string | null;
  phone: string | null;
  email: string | null;
  gstin: string | null;
  address: string | null;
  paymentTermsDays: number;
  status: "active" | "inactive";
  notes: string | null;
}

export interface SupplierBalance {
  invoicedMinor: number;
  paidMinor: number;
  balanceMinor: number;
}

export interface PurchaseOrderRow {
  id: string;
  number: number;
  status: string;
  supplierId: string;
  supplierName: string;
  outletId: string;
  expectedOn: string | null;
  notes: string | null;
  subtotalMinor: number;
  lines: number;
  linesComplete: number;
  createdAt: string;
}

export interface PurchaseOrderItemRow {
  id: string;
  ingredientId: string;
  ingredientName: string;
  unit: string;
  qtyOrdered: number;
  qtyReceivedBase: number;
  qtyOrderedBase: number;
  unitCost: number;
  lineTotalMinor: number;
  fulfilmentPct: number | null;
}

export interface ReceiptRow {
  id: string;
  number: number;
  receivedOn: string;
  deliveryNote: string | null;
  purchaseOrderId: string;
  purchaseOrderNumber: number;
  supplierName: string;
  lines: { id: string; ingredientName: string; qty: number; unit: string; batchCode: string | null; expiresOn: string | null; unitCost: number; lineTotalMinor: number }[];
  valueMinor: number;
}

export interface BillableLine {
  id: string;
  receiptId: string;
  receiptNumber: number;
  receivedOn: string;
  ingredientId: string;
  ingredientName: string;
  unit: string;
  qty: number;
  orderedUnitCost: number;
  batchCode: string | null;
}

export interface InvoiceRow {
  id: string;
  invoiceNumber: string;
  supplierId: string;
  supplierName: string;
  outletId: string;
  invoiceDate: string;
  dueOn: string;
  subtotalMinor: number;
  taxMinor: number;
  totalMinor: number;
  lines: number;
}

export interface PaymentRow {
  id: string;
  supplierId: string;
  supplierName: string;
  amountMinor: number;
  method: string;
  paidOn: string;
  reference: string | null;
}

function rows<T>(data: unknown): T[] {
  return (data ?? []) as T[];
}

export async function loadSupplierList(businessId: string): Promise<SupplierRow[]> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("suppliers")
    .select("id, name, contact_name, phone, email, gstin, address, payment_terms_days, status, notes")
    .eq("business_id", businessId)
    .order("name");
  return rows<Record<string, unknown>>(data).map((s) => ({
    id: s.id as string,
    name: s.name as string,
    contactName: (s.contact_name as string | null) ?? null,
    phone: (s.phone as string | null) ?? null,
    email: (s.email as string | null) ?? null,
    gstin: (s.gstin as string | null) ?? null,
    address: (s.address as string | null) ?? null,
    paymentTermsDays: Number(s.payment_terms_days),
    status: s.status as "active" | "inactive",
    notes: (s.notes as string | null) ?? null,
  }));
}

export async function loadSupplier(businessId: string, supplierId: string): Promise<SupplierRow | null> {
  const list = await loadSupplierList(businessId);
  return list.find((s) => s.id === supplierId) ?? null;
}

interface InvoiceJoinRow {
  id: string;
  supplier_id: string;
  invoice_number: string;
  invoice_date: string;
  due_on: string;
  total_minor: number | string;
}

interface PaymentJoinRow {
  supplier_id: string;
  amount_minor: number | string;
}

/** Invoices and payments for the whole business, used for balances and ageing. */
async function loadLedgerRows(businessId: string) {
  const admin = createAdminClient();
  const [inv, pay] = await Promise.all([
    admin
      .from("purchase_invoices")
      .select("id, supplier_id, invoice_number, invoice_date, due_on, total_minor")
      .eq("business_id", businessId),
    admin.from("supplier_payments").select("supplier_id, amount_minor").eq("business_id", businessId),
  ]);
  const invoices: AgingInvoice[] = rows<InvoiceJoinRow>(inv.data).map((i) => ({
    id: i.id,
    supplierId: i.supplier_id,
    invoiceNumber: i.invoice_number,
    invoiceDate: i.invoice_date,
    dueOn: i.due_on,
    totalMinor: Number(i.total_minor),
  }));
  const payments: AgingPayment[] = rows<PaymentJoinRow>(pay.data).map((p) => ({
    supplierId: p.supplier_id,
    amountMinor: Number(p.amount_minor),
  }));
  return { invoices, payments };
}

/** Balance per supplier for the business (invoiced − paid). */
export async function loadSupplierBalances(businessId: string): Promise<Map<string, SupplierBalance>> {
  const { invoices, payments } = await loadLedgerRows(businessId);
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
  const aging = payablesAging(invoices, payments, today);
  return new Map(
    aging.map((a) => [a.supplierId, { invoicedMinor: a.invoicedMinor, paidMinor: a.paidMinor, balanceMinor: a.balanceMinor }]),
  );
}

/** Payables ageing for the business, as of a given IST day. */
export async function loadPayablesAging(businessId: string, asOf: string): Promise<SupplierAging[]> {
  const { invoices, payments } = await loadLedgerRows(businessId);
  return payablesAging(invoices, payments, asOf);
}

export async function loadSupplierHistory(businessId: string, supplierId: string) {
  const admin = createAdminClient();
  const [orders, invoices, payments] = await Promise.all([
    loadPurchaseOrders(businessId, null, supplierId),
    loadInvoices(businessId, null, supplierId),
    admin
      .from("supplier_payments")
      .select("id, supplier_id, amount_minor, method, paid_on, reference")
      .eq("business_id", businessId)
      .eq("supplier_id", supplierId)
      .order("paid_on", { ascending: false })
      .order("created_at", { ascending: false })
      .limit(100),
  ]);
  const paymentRows: PaymentRow[] = rows<Record<string, unknown>>(payments.data).map((p) => ({
    id: p.id as string,
    supplierId: p.supplier_id as string,
    supplierName: "",
    amountMinor: Number(p.amount_minor),
    method: p.method as string,
    paidOn: p.paid_on as string,
    reference: (p.reference as string | null) ?? null,
  }));
  return { orders, invoices, payments: paymentRows };
}

/** Purchase orders, newest first, optionally for one outlet and/or supplier. */
export async function loadPurchaseOrders(
  businessId: string,
  outletId: string | null,
  supplierId?: string | null,
): Promise<PurchaseOrderRow[]> {
  const admin = createAdminClient();
  let query = admin
    .from("purchase_orders")
    .select("id, number, status, supplier_id, outlet_id, expected_on, notes, subtotal_minor, created_at")
    .eq("business_id", businessId)
    .order("created_at", { ascending: false })
    .limit(200);
  if (outletId) query = query.eq("outlet_id", outletId);
  if (supplierId) query = query.eq("supplier_id", supplierId);
  const { data } = await query;
  const orders = rows<Record<string, unknown>>(data);
  if (orders.length === 0) return [];

  const ids = orders.map((o) => o.id as string);
  const [suppliers, items] = await Promise.all([
    admin.from("suppliers").select("id, name").eq("business_id", businessId),
    admin
      .from("purchase_order_items")
      .select("purchase_order_id, qty_ordered_base, qty_received_base")
      .in("purchase_order_id", ids),
  ]);
  const names = new Map(rows<{ id: string; name: string }>(suppliers.data).map((s) => [s.id, s.name]));
  const counts = new Map<string, { lines: number; complete: number }>();
  for (const item of rows<Record<string, unknown>>(items.data)) {
    const key = item.purchase_order_id as string;
    const c = counts.get(key) ?? { lines: 0, complete: 0 };
    c.lines += 1;
    if (Number(item.qty_received_base) >= Number(item.qty_ordered_base)) c.complete += 1;
    counts.set(key, c);
  }

  return orders.map((o) => {
    const c = counts.get(o.id as string) ?? { lines: 0, complete: 0 };
    return {
      id: o.id as string,
      number: Number(o.number),
      status: o.status as string,
      supplierId: o.supplier_id as string,
      supplierName: names.get(o.supplier_id as string) ?? "Supplier",
      outletId: o.outlet_id as string,
      expectedOn: (o.expected_on as string | null) ?? null,
      notes: (o.notes as string | null) ?? null,
      subtotalMinor: Number(o.subtotal_minor),
      lines: c.lines,
      linesComplete: c.complete,
      createdAt: o.created_at as string,
    };
  });
}

/** One purchase order with its lines and receipts. Null when it is not at this outlet. */
export async function loadPurchaseOrder(
  businessId: string,
  outletId: string,
  poId: string,
): Promise<{ order: PurchaseOrderRow; items: PurchaseOrderItemRow[]; receipts: ReceiptRow[] } | null> {
  const admin = createAdminClient();
  // The list is already filtered to this business and outlet, so a miss means "not here".
  const order = (await loadPurchaseOrders(businessId, outletId)).find((o) => o.id === poId);
  if (!order) return null;
  const [items, receipts, ingredients] = await Promise.all([
    admin
      .from("purchase_order_items")
      .select("id, ingredient_id, unit, qty_ordered, qty_ordered_base, qty_received_base, unit_cost, line_total_minor")
      .eq("purchase_order_id", poId)
      .order("created_at"),
    loadReceipts(businessId, outletId, poId, 50),
    loadIngredients(businessId),
  ]);
  const names = new Map(ingredients.map((i) => [i.id, i]));
  const itemRows: PurchaseOrderItemRow[] = rows<Record<string, unknown>>(items.data).map((i) => ({
    id: i.id as string,
    ingredientId: i.ingredient_id as string,
    ingredientName: names.get(i.ingredient_id as string)?.name ?? "Ingredient",
    unit: i.unit as string,
    qtyOrdered: Number(i.qty_ordered),
    qtyOrderedBase: Number(i.qty_ordered_base),
    qtyReceivedBase: Number(i.qty_received_base),
    unitCost: Number(i.unit_cost),
    lineTotalMinor: Math.round(Number(i.line_total_minor)),
    fulfilmentPct: fulfilmentPct(Number(i.qty_ordered_base), Number(i.qty_received_base)),
  }));
  return { order, items: itemRows, receipts };
}

export async function loadReceipts(
  businessId: string,
  outletId: string | null,
  purchaseOrderId?: string,
  limit = 20,
): Promise<ReceiptRow[]> {
  const admin = createAdminClient();
  let query = admin
    .from("goods_receipts")
    .select("id, number, received_on, delivery_note, purchase_order_id, supplier_id")
    .eq("business_id", businessId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (outletId) query = query.eq("outlet_id", outletId);
  if (purchaseOrderId) query = query.eq("purchase_order_id", purchaseOrderId);
  const { data } = await query;
  const receipts = rows<Record<string, unknown>>(data);
  if (receipts.length === 0) return [];

  const ids = receipts.map((r) => r.id as string);
  const [items, pos, suppliers, ingredients] = await Promise.all([
    admin
      .from("goods_receipt_items")
      .select("id, goods_receipt_id, purchase_order_item_id, ingredient_id, qty, unit, batch_code, expires_on, unit_cost, line_total_minor")
      .in("goods_receipt_id", ids),
    admin.from("purchase_orders").select("id, number").eq("business_id", businessId),
    admin.from("suppliers").select("id, name").eq("business_id", businessId),
    loadIngredients(businessId),
  ]);
  const poNumber = new Map(rows<{ id: string; number: number }>(pos.data).map((p) => [p.id, p.number]));
  const supplierName = new Map(rows<{ id: string; name: string }>(suppliers.data).map((s) => [s.id, s.name]));
  const ingredientName = new Map(ingredients.map((i) => [i.id, i.name]));

  return receipts.map((r) => {
    const lines = rows<Record<string, unknown>>(items.data)
      .filter((i) => i.goods_receipt_id === r.id)
      .map((i) => ({
        id: i.id as string,
        ingredientName: ingredientName.get(i.ingredient_id as string) ?? "Ingredient",
        qty: Number(i.qty),
        unit: i.unit as string,
        batchCode: (i.batch_code as string | null) ?? null,
        expiresOn: (i.expires_on as string | null) ?? null,
        unitCost: Number(i.unit_cost),
        lineTotalMinor: Math.round(Number(i.line_total_minor)),
      }));
    return {
      id: r.id as string,
      number: Number(r.number),
      receivedOn: r.received_on as string,
      deliveryNote: (r.delivery_note as string | null) ?? null,
      purchaseOrderId: r.purchase_order_id as string,
      purchaseOrderNumber: poNumber.get(r.purchase_order_id as string) ?? 0,
      supplierName: supplierName.get(r.supplier_id as string) ?? "Supplier",
      lines,
      valueMinor: lines.reduce((sum, l) => sum + l.lineTotalMinor, 0),
    };
  });
}

/** Received lines at this outlet from one supplier that have not been billed yet. */
export async function loadBillableLines(businessId: string, outletId: string, supplierId: string): Promise<BillableLine[]> {
  const admin = createAdminClient();
  const { data: receipts } = await admin
    .from("goods_receipts")
    .select("id, number, received_on")
    .eq("business_id", businessId)
    .eq("outlet_id", outletId)
    .eq("supplier_id", supplierId);
  const receiptRows = rows<{ id: string; number: number; received_on: string }>(receipts);
  if (receiptRows.length === 0) return [];
  const receiptById = new Map(receiptRows.map((r) => [r.id, r]));

  const [items, billed, ingredients] = await Promise.all([
    admin
      .from("goods_receipt_items")
      .select("id, goods_receipt_id, purchase_order_item_id, ingredient_id, qty, unit, batch_code")
      .in("goods_receipt_id", receiptRows.map((r) => r.id)),
    admin.from("purchase_invoice_items").select("goods_receipt_item_id").eq("business_id", businessId),
    loadIngredients(businessId),
  ]);
  const billedIds = new Set(rows<{ goods_receipt_item_id: string }>(billed.data).map((b) => b.goods_receipt_item_id));
  const poItemIds = [...new Set(rows<Record<string, unknown>>(items.data).map((i) => i.purchase_order_item_id as string))];
  const poItems = poItemIds.length
    ? await admin.from("purchase_order_items").select("id, unit_cost").in("id", poItemIds)
    : { data: [] };
  const orderedCost = new Map(rows<{ id: string; unit_cost: number | string }>(poItems.data).map((p) => [p.id, Number(p.unit_cost)]));
  const names = new Map(ingredients.map((i) => [i.id, i.name]));

  return rows<Record<string, unknown>>(items.data)
    .filter((i) => !billedIds.has(i.id as string))
    .map((i) => {
      const receipt = receiptById.get(i.goods_receipt_id as string)!;
      return {
        id: i.id as string,
        receiptId: receipt.id,
        receiptNumber: receipt.number,
        receivedOn: receipt.received_on,
        ingredientId: i.ingredient_id as string,
        ingredientName: names.get(i.ingredient_id as string) ?? "Ingredient",
        unit: i.unit as string,
        qty: Number(i.qty),
        orderedUnitCost: orderedCost.get(i.purchase_order_item_id as string) ?? 0,
        batchCode: (i.batch_code as string | null) ?? null,
      };
    })
    .sort((a, b) => a.receivedOn.localeCompare(b.receivedOn) || a.receiptNumber - b.receiptNumber);
}

export async function loadInvoices(
  businessId: string,
  outletId: string | null,
  supplierId?: string | null,
): Promise<InvoiceRow[]> {
  const admin = createAdminClient();
  let query = admin
    .from("purchase_invoices")
    .select("id, invoice_number, supplier_id, outlet_id, invoice_date, due_on, subtotal_minor, tax_minor, total_minor, created_at")
    .eq("business_id", businessId)
    .order("invoice_date", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(200);
  if (outletId) query = query.eq("outlet_id", outletId);
  if (supplierId) query = query.eq("supplier_id", supplierId);
  const { data } = await query;
  const invoices = rows<Record<string, unknown>>(data);
  if (invoices.length === 0) return [];
  const [suppliers, items] = await Promise.all([
    admin.from("suppliers").select("id, name").eq("business_id", businessId),
    admin.from("purchase_invoice_items").select("invoice_id").in("invoice_id", invoices.map((i) => i.id as string)),
  ]);
  const names = new Map(rows<{ id: string; name: string }>(suppliers.data).map((s) => [s.id, s.name]));
  const lineCount = new Map<string, number>();
  for (const item of rows<{ invoice_id: string }>(items.data)) {
    lineCount.set(item.invoice_id, (lineCount.get(item.invoice_id) ?? 0) + 1);
  }
  return invoices.map((i) => ({
    id: i.id as string,
    invoiceNumber: i.invoice_number as string,
    supplierId: i.supplier_id as string,
    supplierName: names.get(i.supplier_id as string) ?? "Supplier",
    outletId: i.outlet_id as string,
    invoiceDate: i.invoice_date as string,
    dueOn: i.due_on as string,
    subtotalMinor: Number(i.subtotal_minor),
    taxMinor: Number(i.tax_minor),
    totalMinor: Number(i.total_minor),
    lines: lineCount.get(i.id as string) ?? 0,
  }));
}

/** Spend and price-variance inputs for the reports page. */
export async function loadSpendAndVariance(businessId: string, outletId: string | null) {
  const admin = createAdminClient();
  const invoices = await loadInvoices(businessId, outletId);
  const spend = spendBySupplier(
    invoices.map<InvoiceForSpend>((i) => ({
      supplierId: i.supplierId,
      supplierName: i.supplierName,
      subtotalMinor: i.subtotalMinor,
      taxMinor: i.taxMinor,
      totalMinor: i.totalMinor,
    })),
  );

  const { data: lines } = await admin
    .from("purchase_invoice_items")
    .select("invoice_id, goods_receipt_item_id, ingredient_id, unit, qty, unit_cost")
    .eq("business_id", businessId);
  const invoiceIds = new Set(invoices.map((i) => i.id));
  const billed = rows<Record<string, unknown>>(lines).filter((l) => invoiceIds.has(l.invoice_id as string));
  const receiptItemIds = billed.map((l) => l.goods_receipt_item_id as string);
  const receiptItems = receiptItemIds.length
    ? await admin.from("goods_receipt_items").select("id, purchase_order_item_id").in("id", receiptItemIds)
    : { data: [] };
  const poItemOf = new Map(rows<{ id: string; purchase_order_item_id: string }>(receiptItems.data).map((r) => [r.id, r.purchase_order_item_id]));
  const poItemIds = [...new Set([...poItemOf.values()])];
  const poItems = poItemIds.length
    ? await admin.from("purchase_order_items").select("id, unit_cost").in("id", poItemIds)
    : { data: [] };
  const orderedCost = new Map(rows<{ id: string; unit_cost: number | string }>(poItems.data).map((p) => [p.id, Number(p.unit_cost)]));
  const ingredients = await loadIngredients(businessId);
  const names = new Map(ingredients.map((i) => [i.id, i.name]));
  const supplierOfInvoice = new Map(invoices.map((i) => [i.id, i.supplierName]));

  const varianceInput: VarianceLine[] = billed.map((l) => ({
    ingredientName: names.get(l.ingredient_id as string) ?? "Ingredient",
    supplierName: supplierOfInvoice.get(l.invoice_id as string) ?? "Supplier",
    unit: l.unit as string,
    qty: Number(l.qty),
    orderedUnitCost: orderedCost.get(poItemOf.get(l.goods_receipt_item_id as string) ?? "") ?? 0,
    billedUnitCost: Number(l.unit_cost),
  }));
  return { spend, variance: priceVariance(varianceInput), invoiceCount: invoices.length };
}

/** Received lines at this outlet that have not been billed yet (count only). */
async function countUnbilledLines(businessId: string, outletId: string): Promise<number> {
  const admin = createAdminClient();
  const { data: receipts } = await admin
    .from("goods_receipts")
    .select("id")
    .eq("business_id", businessId)
    .eq("outlet_id", outletId);
  const receiptIds = rows<{ id: string }>(receipts).map((r) => r.id);
  if (receiptIds.length === 0) return 0;
  const [items, billed] = await Promise.all([
    admin.from("goods_receipt_items").select("id").in("goods_receipt_id", receiptIds),
    admin.from("purchase_invoice_items").select("goods_receipt_item_id").eq("business_id", businessId),
  ]);
  const billedIds = new Set(rows<{ goods_receipt_item_id: string }>(billed.data).map((b) => b.goods_receipt_item_id));
  return rows<{ id: string }>(items.data).filter((i) => !billedIds.has(i.id)).length;
}

/** Dashboard figures for the purchasing overview. `asOf` is the IST business day. */
export async function loadPurchasingOverview(businessId: string, outletId: string, asOf: string) {
  const [orders, receipts, unbilledLines, aging] = await Promise.all([
    loadPurchaseOrders(businessId, outletId),
    loadReceipts(businessId, outletId, undefined, 5),
    countUnbilledLines(businessId, outletId),
    loadPayablesAging(businessId, asOf),
  ]);
  const openOrders = orders.filter((o) => o.status === "sent" || o.status === "partially_received");
  const payableMinor = aging.reduce((sum, a) => sum + Math.max(a.balanceMinor, 0), 0);
  const overdueMinor = aging.reduce(
    (sum, a) => sum + a.buckets["1-30"] + a.buckets["31-60"] + a.buckets["61-90"] + a.buckets["90+"],
    0,
  );
  return { orders, openOrders, receipts, unbilledLines, payableMinor, overdueMinor };
}

/** Purchasing reconciliation, run by the database under the viewer's permission. */
export async function loadPurchasingReconciliation(actorId: string, outletId: string) {
  const admin = createAdminClient();
  const { data, error } = await admin.rpc("purchasing_reconcile", { p_actor: actorId, p_outlet_id: outletId });
  if (error) return { checks: [], mismatches: 0, error: true as const };
  const checks = rows<{ check_name: string; expected: number | string; actual: number | string; ok: boolean }>(data).map((c) => ({
    name: c.check_name,
    expected: Number(c.expected),
    actual: Number(c.actual),
    ok: c.ok,
  }));
  return { checks, mismatches: checks.filter((c) => !c.ok).length, error: false as const };
}
