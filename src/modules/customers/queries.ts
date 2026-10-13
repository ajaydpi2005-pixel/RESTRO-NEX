import { createAdminClient } from "@/lib/supabase/admin";
import { segmentFor, type CustomerSegment } from "@/modules/customers/segments";

/**
 * Phase 15 — read loaders for customers, loyalty and promotions. They use the
 * service client, so every query filters by business. Large reads page through
 * rows: Supabase returns at most 1,000 rows per request, and a silent cut-off
 * would make totals wrong.
 */

const PAGE = 1000;
const CHUNK = 200;

async function fetchAll<T>(
  page: (
    from: number,
    to: number,
  ) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await page(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    const rows = data ?? [];
    out.push(...rows);
    if (rows.length < PAGE) break;
  }
  return out;
}

export interface CustomerRecord {
  id: string;
  name: string;
  phone: string;
  email: string | null;
  notes: string | null;
  createdAt: string;
}

export interface CustomerListRow extends CustomerRecord {
  orderCount: number;
  totalSpendMinor: number;
  firstOrderAt: string | null;
  lastOrderAt: string | null;
  balance: number;
  segment: CustomerSegment;
}

interface CompletedOrder {
  id: string;
  customer_id: string;
  total_minor: number | string;
  refunded_minor: number | string;
  created_at: string;
  order_number: number;
}

function netSpend(order: CompletedOrder): number {
  return Number(order.total_minor) - Number(order.refunded_minor);
}

function summarise(orders: CompletedOrder[], now: Date) {
  const sorted = [...orders].sort((a, b) => a.created_at.localeCompare(b.created_at));
  const first = sorted[0]?.created_at ?? null;
  const last = sorted[sorted.length - 1]?.created_at ?? null;
  const totalSpendMinor = orders.reduce((sum, order) => sum + netSpend(order), 0);
  const segment = segmentFor({
    orderCount: orders.length,
    totalSpendMinor,
    firstOrderAt: first ? new Date(first) : null,
    lastOrderAt: last ? new Date(last) : null,
    now,
  });
  return {
    orderCount: orders.length,
    totalSpendMinor,
    firstOrderAt: first,
    lastOrderAt: last,
    segment,
  };
}

/** Every customer of the business with order totals, balance and segment. */
export async function loadCustomerDirectory(
  businessId: string,
  now = new Date(),
): Promise<CustomerListRow[]> {
  const admin = createAdminClient();

  const customers = await fetchAll<{
    id: string;
    name: string;
    phone: string;
    email: string | null;
    notes: string | null;
    created_at: string;
  }>((from, to) =>
    admin
      .from("customers")
      .select("id, name, phone, email, notes, created_at")
      .eq("business_id", businessId)
      .order("id")
      .range(from, to),
  );

  const orders = await fetchAll<CompletedOrder>((from, to) =>
    admin
      .from("orders")
      .select("id, customer_id, total_minor, refunded_minor, created_at, order_number")
      .eq("business_id", businessId)
      .eq("status", "completed")
      .not("customer_id", "is", null)
      .order("id")
      .range(from, to),
  );

  const balances = await fetchAll<{ customer_id: string; balance: number }>((from, to) =>
    admin
      .from("loyalty_accounts")
      .select("customer_id, balance")
      .eq("business_id", businessId)
      .order("customer_id")
      .range(from, to),
  );

  const byCustomer = new Map<string, CompletedOrder[]>();
  for (const order of orders) {
    const list = byCustomer.get(order.customer_id) ?? [];
    list.push(order);
    byCustomer.set(order.customer_id, list);
  }
  const balanceOf = new Map(balances.map((b) => [b.customer_id, Number(b.balance)]));

  return customers
    .map((c) => {
      const stats = summarise(byCustomer.get(c.id) ?? [], now);
      return {
        id: c.id,
        name: c.name,
        phone: c.phone,
        email: c.email,
        notes: c.notes,
        createdAt: c.created_at,
        ...stats,
        balance: balanceOf.get(c.id) ?? 0,
      };
    })
    .sort((a, b) => b.totalSpendMinor - a.totalSpendMinor || a.name.localeCompare(b.name));
}

export interface CustomerProfile extends CustomerRecord {
  orderCount: number;
  totalSpendMinor: number;
  firstOrderAt: string | null;
  lastOrderAt: string | null;
  segment: CustomerSegment;
  balance: number;
  favourites: { name: string; quantity: number }[];
  orders: {
    id: string;
    orderNumber: number;
    totalMinor: number;
    refundedMinor: number;
    createdAt: string;
  }[];
  addresses: { id: string; label: string; address: string }[];
  ledger: {
    id: string;
    kind: string;
    points: number;
    balanceAfter: number;
    reason: string | null;
    createdAt: string;
  }[];
  vouchers: {
    id: string;
    name: string;
    pointsSpent: number;
    status: string;
    orderId: string | null;
    createdAt: string;
  }[];
}

export async function loadCustomerProfile(
  businessId: string,
  customerId: string,
  now = new Date(),
): Promise<CustomerProfile | null> {
  const admin = createAdminClient();
  const { data: customer } = await admin
    .from("customers")
    .select("id, name, phone, email, notes, created_at")
    .eq("id", customerId)
    .eq("business_id", businessId)
    .maybeSingle();
  if (!customer) return null;

  const orders = await fetchAll<CompletedOrder>((from, to) =>
    admin
      .from("orders")
      .select("id, customer_id, total_minor, refunded_minor, created_at, order_number")
      .eq("business_id", businessId)
      .eq("customer_id", customerId)
      .eq("status", "completed")
      .order("id")
      .range(from, to),
  );

  // favourite products: quantity across completed orders, in chunks of order ids
  const tally = new Map<string, { name: string; quantity: number }>();
  const orderIds = orders.map((o) => o.id);
  for (let i = 0; i < orderIds.length; i += CHUNK) {
    const { data: items, error } = await admin
      .from("order_items")
      .select("name, quantity")
      .in("order_id", orderIds.slice(i, i + CHUNK));
    if (error) throw new Error(error.message);
    for (const item of items ?? []) {
      const entry = tally.get(item.name) ?? { name: item.name, quantity: 0 };
      entry.quantity += Number(item.quantity);
      tally.set(item.name, entry);
    }
  }
  const favourites = [...tally.values()]
    .sort((a, b) => b.quantity - a.quantity || a.name.localeCompare(b.name))
    .slice(0, 5);

  const [{ data: addresses }, { data: ledger }, { data: vouchers }, { data: account }] =
    await Promise.all([
      admin
        .from("customer_addresses")
        .select("id, label, address")
        .eq("customer_id", customerId)
        .eq("business_id", businessId)
        .order("created_at", { ascending: true }),
      admin
        .from("loyalty_transactions")
        .select("id, kind, points, balance_after, reason, created_at")
        .eq("customer_id", customerId)
        .eq("business_id", businessId)
        .order("created_at", { ascending: false })
        .limit(30),
      admin
        .from("customer_vouchers")
        .select("id, name, points_spent, status, order_id, created_at")
        .eq("customer_id", customerId)
        .eq("business_id", businessId)
        .order("created_at", { ascending: false })
        .limit(50),
      admin.from("loyalty_accounts").select("balance").eq("customer_id", customerId).maybeSingle(),
    ]);

  const stats = summarise(orders, now);
  return {
    id: customer.id,
    name: customer.name,
    phone: customer.phone,
    email: customer.email,
    notes: customer.notes,
    createdAt: customer.created_at,
    ...stats,
    balance: Number(account?.balance ?? 0),
    favourites,
    orders: [...orders]
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .slice(0, 20)
      .map((o) => ({
        id: o.id,
        orderNumber: o.order_number,
        totalMinor: Number(o.total_minor),
        refundedMinor: Number(o.refunded_minor),
        createdAt: o.created_at,
      })),
    addresses: (addresses ?? []).map((a) => ({ id: a.id, label: a.label, address: a.address })),
    ledger: (ledger ?? []).map((t) => ({
      id: t.id,
      kind: t.kind,
      points: Number(t.points),
      balanceAfter: Number(t.balance_after),
      reason: t.reason,
      createdAt: t.created_at,
    })),
    vouchers: (vouchers ?? []).map((v) => ({
      id: v.id,
      name: v.name,
      pointsSpent: Number(v.points_spent),
      status: v.status,
      orderId: v.order_id,
      createdAt: v.created_at,
    })),
  };
}

export interface LoyaltySettingsRow {
  enabled: boolean;
  earnMinorPerPoint: number;
}

export async function loadLoyaltySettings(businessId: string): Promise<LoyaltySettingsRow> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("loyalty_settings")
    .select("enabled, earn_minor_per_point")
    .eq("business_id", businessId)
    .maybeSingle();
  return {
    enabled: data?.enabled ?? false,
    earnMinorPerPoint: Number(data?.earn_minor_per_point ?? 10000),
  };
}

export interface RewardRow {
  id: string;
  name: string;
  pointsCost: number;
  discountType: "flat" | "percent";
  discountValue: number;
  maxDiscountMinor: number | null;
  active: boolean;
}

export async function loadRewards(businessId: string): Promise<RewardRow[]> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("loyalty_rewards")
    .select("id, name, points_cost, discount_type, discount_value, max_discount_minor, active")
    .eq("business_id", businessId)
    .order("points_cost", { ascending: true });
  if (error) throw new Error(error.message);
  return (data ?? []).map((r) => ({
    id: r.id,
    name: r.name,
    pointsCost: Number(r.points_cost),
    discountType: r.discount_type as "flat" | "percent",
    discountValue: Number(r.discount_value),
    maxDiscountMinor: r.max_discount_minor == null ? null : Number(r.max_discount_minor),
    active: r.active,
  }));
}

export interface CouponRow {
  id: string;
  code: string;
  name: string;
  discountType: "flat" | "percent";
  discountValue: number;
  maxDiscountMinor: number | null;
  minSubtotalMinor: number;
  startsOn: string | null;
  endsOn: string | null;
  usageLimit: number | null;
  perCustomerLimit: number | null;
  active: boolean;
  redeemed: number;
}

export async function loadCoupons(businessId: string): Promise<CouponRow[]> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("coupons")
    .select(
      "id, code, name, discount_type, discount_value, max_discount_minor, min_subtotal_minor, starts_on, ends_on, usage_limit, per_customer_limit, active",
    )
    .eq("business_id", businessId)
    .order("code", { ascending: true });
  if (error) throw new Error(error.message);

  const redemptions = await fetchAll<{ coupon_id: string }>((from, to) =>
    admin
      .from("coupon_redemptions")
      .select("coupon_id")
      .eq("business_id", businessId)
      .order("id")
      .range(from, to),
  );
  const used = new Map<string, number>();
  for (const r of redemptions) used.set(r.coupon_id, (used.get(r.coupon_id) ?? 0) + 1);

  return (data ?? []).map((c) => ({
    id: c.id,
    code: c.code,
    name: c.name,
    discountType: c.discount_type as "flat" | "percent",
    discountValue: Number(c.discount_value),
    maxDiscountMinor: c.max_discount_minor == null ? null : Number(c.max_discount_minor),
    minSubtotalMinor: Number(c.min_subtotal_minor),
    startsOn: c.starts_on,
    endsOn: c.ends_on,
    usageLimit: c.usage_limit,
    perCustomerLimit: c.per_customer_limit,
    active: c.active,
    redeemed: used.get(c.id) ?? 0,
  }));
}

export interface OrderPromotionRow {
  kind: "coupon" | "reward";
  label: string;
  amountMinor: number;
  discountType: "flat" | "percent";
  discountValue: number;
  minSubtotalMinor: number;
  voucherId: string | null;
}

export async function loadOrderPromotion(
  businessId: string,
  orderId: string,
): Promise<OrderPromotionRow | null> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("order_promotions")
    .select(
      "kind, label, amount_minor, discount_type, discount_value, min_subtotal_minor, voucher_id",
    )
    .eq("business_id", businessId)
    .eq("order_id", orderId)
    .maybeSingle();
  if (!data) return null;
  return {
    kind: data.kind as "coupon" | "reward",
    label: data.label,
    amountMinor: Number(data.amount_minor),
    discountType: data.discount_type as "flat" | "percent",
    discountValue: Number(data.discount_value),
    minSubtotalMinor: Number(data.min_subtotal_minor),
    voucherId: data.voucher_id,
  };
}

export interface IssuedVoucher {
  id: string;
  name: string;
  pointsSpent: number;
  discountType: "flat" | "percent";
  discountValue: number;
  maxDiscountMinor: number | null;
}

/** Vouchers a customer can still spend: issued, and not on another order. */
export async function loadIssuedVouchers(
  businessId: string,
  customerId: string,
): Promise<IssuedVoucher[]> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("customer_vouchers")
    .select("id, name, points_spent, discount_type, discount_value, max_discount_minor")
    .eq("business_id", businessId)
    .eq("customer_id", customerId)
    .eq("status", "issued")
    .order("created_at", { ascending: true });
  if (error) throw new Error(error.message);
  return (data ?? []).map((v) => ({
    id: v.id,
    name: v.name,
    pointsSpent: Number(v.points_spent),
    discountType: v.discount_type as "flat" | "percent",
    discountValue: Number(v.discount_value),
    maxDiscountMinor: v.max_discount_minor == null ? null : Number(v.max_discount_minor),
  }));
}

/** Customer and balance for an order, for the promotion panel. */
export async function loadOrderCustomer(
  businessId: string,
  customerId: string | null,
): Promise<{ id: string; name: string; phone: string; balance: number } | null> {
  if (!customerId) return null;
  const admin = createAdminClient();
  const { data: customer } = await admin
    .from("customers")
    .select("id, name, phone")
    .eq("id", customerId)
    .eq("business_id", businessId)
    .maybeSingle();
  if (!customer) return null;
  const { data: account } = await admin
    .from("loyalty_accounts")
    .select("balance")
    .eq("customer_id", customerId)
    .maybeSingle();
  return {
    id: customer.id,
    name: customer.name,
    phone: customer.phone,
    balance: Number(account?.balance ?? 0),
  };
}
