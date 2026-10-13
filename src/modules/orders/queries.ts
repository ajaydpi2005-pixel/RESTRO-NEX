import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Phase 8 — POS + order reads (service client; pages authorise first).
 */

/**
 * Business-level exclusive tax rate (sum of enabled EXCLUSIVE rates),
 * mirroring pos_effective_tax_pct so the POS can show live totals.
 */
export async function loadBusinessTaxPct(businessId: string): Promise<number> {
  const admin = createAdminClient();
  const { data } = await admin.from("businesses").select("tax_settings").eq("id", businessId).maybeSingle();
  const settings = (data?.tax_settings ?? {}) as {
    enabled?: boolean;
    rates?: { pct?: number; inclusive?: boolean }[];
  };
  if (!settings.enabled) return 0;
  return (settings.rates ?? [])
    .filter((r) => !r.inclusive)
    .reduce((sum, r) => sum + (Number(r.pct) || 0), 0);
}

// ── POS data ────────────────────────────────────────────────────────────────

export interface PosVariant {
  id: string;
  name: string;
  priceMinor: number;
  isAvailable: boolean;
}

export interface PosModifier {
  id: string;
  name: string;
  priceMinor: number;
}

export interface PosModifierGroup {
  id: string;
  name: string;
  minSelected: number;
  maxSelected: number | null;
  modifiers: PosModifier[];
}

export interface PosProduct {
  id: string;
  name: string;
  categoryId: string;
  priceMinor: number;
  isVegetarian: boolean;
  isAvailable: boolean;
  imagePath: string | null;
  taxRatePct: number | null;
  /** effective price after outlet override (fallback: base) */
  effectivePriceMinor: number;
  outletAvailable: boolean;
  variants: PosVariant[];
  modifierGroups: PosModifierGroup[];
}

export interface PosCombo {
  id: string;
  name: string;
  priceMinor: number;
  isVegetarian: boolean;
  isAvailable: boolean;
  imagePath: string | null;
}

export interface PosTable {
  id: string;
  label: string;
  capacity: number;
  sectionName: string;
}

export interface HeldOrderSummary {
  id: string;
  orderNumber: number;
  status: string;
  orderType: string;
  tableName: string | null;
  totalMinor: number;
  updatedAt: string;
}

export interface PosCategory {
  id: string;
  name: string;
  parentId: string | null;
}

export async function loadPosMenu(businessId: string, outletId: string): Promise<{
  categories: PosCategory[];
  products: PosProduct[];
  combos: PosCombo[];
}> {
  const admin = createAdminClient();

  const { data: categories } = await admin
    .from("menu_categories")
    .select("id, name, parent_id, sort_order")
    .eq("business_id", businessId)
    .order("sort_order", { ascending: true });

  const { data: products } = await admin
    .from("menu_items")
    .select("id, name, category_id, price_minor, is_vegetarian, is_available, image_path, tax_rate_pct, sort_order")
    .eq("business_id", businessId)
    .order("sort_order", { ascending: true })
    .order("name", { ascending: true });
  const rows = products ?? [];
  const productIds = rows.map((r) => r.id);

  const { data: productOverrides } =
    productIds.length > 0
      ? await admin
          .from("outlet_product_overrides")
          .select("product_id, price_minor, is_available")
          .eq("outlet_id", outletId)
          .in("product_id", productIds)
      : { data: [] };
  const productOverrideByProduct = new Map((productOverrides ?? []).map((o) => [o.product_id, o]));

  const { data: variants } =
    productIds.length > 0
      ? await admin
          .from("product_variants")
          .select("id, name, price_minor, is_available, product_id, sort_order")
          .in("product_id", productIds)
          .order("sort_order", { ascending: true })
      : { data: [] };
  const variantIds = (variants ?? []).map((v) => v.id);
  const { data: variantOverrides } =
    variantIds.length > 0
      ? await admin
          .from("outlet_variant_overrides")
          .select("variant_id, price_minor, is_available")
          .eq("outlet_id", outletId)
          .in("variant_id", variantIds)
      : { data: [] };
  const variantOverrideById = new Map((variantOverrides ?? []).map((o) => [o.variant_id, o]));

  const { data: links } =
    productIds.length > 0
      ? await admin
          .from("product_modifier_groups")
          .select("product_id, modifier_group_id, modifier_groups(id, name, min_selected, max_selected)")
          .in("product_id", productIds)
      : { data: [] };
  const embedGroup = (raw: unknown): { id: string; name: string; min_selected: number; max_selected: number | null } | null => {
    const value = Array.isArray(raw) ? raw[0] : raw;
    if (!value || typeof value !== "object" || !("id" in value)) return null;
    return value as { id: string; name: string; min_selected: number; max_selected: number | null };
  };
  const groupIds = [
    ...new Set(
      (links ?? [])
        .map((l) => embedGroup(l.modifier_groups)?.id)
        .filter((id): id is string => Boolean(id)),
    ),
  ];
  const { data: modifiers } =
    groupIds.length > 0
      ? await admin
          .from("modifiers")
          .select("id, name, price_minor, modifier_group_id, sort_order")
          .in("modifier_group_id", groupIds)
          .order("sort_order", { ascending: true })
      : { data: [] };

  const { data: combos } = await admin
    .from("combos")
    .select("id, name, price_minor, is_vegetarian, is_available, image_path, sort_order")
    .eq("business_id", businessId)
    .eq("is_available", true)
    .order("sort_order", { ascending: true });

  return {
    categories: (categories ?? []).map((c) => ({ id: c.id, name: c.name, parentId: c.parent_id })),
    products: rows.map((product) => {
      const override = productOverrideByProduct.get(product.id);
      return {
        id: product.id,
        name: product.name,
        categoryId: product.category_id,
        priceMinor: Number(product.price_minor),
        isVegetarian: product.is_vegetarian,
        isAvailable: product.is_available,
        imagePath: product.image_path,
        taxRatePct: product.tax_rate_pct === null ? null : Number(product.tax_rate_pct),
        effectivePriceMinor: override?.price_minor != null ? Number(override.price_minor) : Number(product.price_minor),
        outletAvailable: product.is_available && (override ? override.is_available : true),
        variants: (variants ?? [])
          .filter((v) => v.product_id === product.id)
          .map((v) => {
            const vOverride = variantOverrideById.get(v.id);
            return {
              id: v.id,
              name: v.name,
              priceMinor: vOverride?.price_minor != null ? Number(vOverride.price_minor) : Number(v.price_minor),
              isAvailable: v.is_available && (vOverride ? vOverride.is_available : true),
            };
          }),
        modifierGroups: (links ?? [])
          .filter((l) => l.product_id === product.id)
          .map((l) => {
            const group = embedGroup(l.modifier_groups);
            if (!group) return null;
            return {
              id: group.id,
              name: group.name,
              minSelected: group.min_selected,
              maxSelected: group.max_selected,
              modifiers: (modifiers ?? [])
                .filter((m) => m.modifier_group_id === group.id)
                .map((m) => ({ id: m.id, name: m.name, priceMinor: Number(m.price_minor) })),
            };
          })
          .filter((g): g is PosModifierGroup => g !== null),
      };
    }),
    combos: (combos ?? []).map((c) => ({
      id: c.id,
      name: c.name,
      priceMinor: Number(c.price_minor),
      isVegetarian: c.is_vegetarian,
      isAvailable: c.is_available,
      imagePath: c.image_path,
    })),
  };
}

export async function loadPosTables(outletId: string): Promise<PosTable[]> {
  const admin = createAdminClient();
  const { data: sections } = await admin
    .from("dining_sections")
    .select("id, name")
    .eq("outlet_id", outletId);
  const sectionNames = new Map((sections ?? []).map((s) => [s.id, s.name]));
  const { data: tables } = await admin
    .from("dining_tables")
    .select("id, label, capacity, section_id, sort_order")
    .eq("outlet_id", outletId)
    .eq("is_active", true)
    .order("sort_order", { ascending: true });
  return (tables ?? []).map((t) => ({
    id: t.id,
    label: t.label,
    capacity: t.capacity,
    sectionName: (t.section_id && sectionNames.get(t.section_id)) || "Tables",
  }));
}

export async function loadHeldOrders(outletId: string): Promise<HeldOrderSummary[]> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("orders")
    .select("id, order_number, status, order_type, table_id, total_minor, updated_at")
    .eq("outlet_id", outletId)
    .in("status", ["open", "held"])
    .order("updated_at", { ascending: false })
    .limit(20);
  const tableIds = [...new Set((data ?? []).map((o) => o.table_id).filter((t): t is string => Boolean(t)))];
  const { data: tables } =
    tableIds.length > 0
      ? await admin.from("dining_tables").select("id, label").in("id", tableIds)
      : { data: [] };
  const tableLabels = new Map((tables ?? []).map((t) => [t.id, t.label]));
  return (data ?? []).map((o) => ({
    id: o.id,
    orderNumber: o.order_number,
    status: o.status,
    orderType: o.order_type,
    tableName: o.table_id ? tableLabels.get(o.table_id) ?? null : null,
    totalMinor: Number(o.total_minor),
    updatedAt: o.updated_at,
  }));
}

/** Outlets the actor may operate the POS in. */
export async function loadPosOutlets(
  businessId: string,
  role: string,
  membershipId: string,
): Promise<{ id: string; name: string }[]> {
  const admin = createAdminClient();
  const { data: outlets } = await admin
    .from("outlets")
    .select("id, name")
    .eq("business_id", businessId)
    .eq("status", "active")
    .order("created_at", { ascending: true });
  if (role === "owner" || role === "business_admin") return outlets ?? [];
  const { data: grants } = await admin
    .from("membership_outlets")
    .select("outlet_id")
    .eq("membership_id", membershipId);
  const allowed = new Set((grants ?? []).map((g) => g.outlet_id));
  return (outlets ?? []).filter((o) => allowed.has(o.id));
}

// ── order management ────────────────────────────────────────────────────────

export interface OrderListRow {
  id: string;
  orderNumber: number;
  orderType: string;
  status: string;
  totalMinor: number;
  itemCount: number;
  tableName: string | null;
  customerName: string | null;
  outletName: string;
  createdAt: string;
  updatedAt: string;
}

export async function loadOrders(
  businessId: string,
  filter: { outletId?: string | null; group: "active" | "completed" | "cancelled" },
): Promise<OrderListRow[]> {
  const admin = createAdminClient();
  let query = admin
    .from("orders")
    .select("id, order_number, order_type, status, total_minor, table_id, customer_name, outlet_id, created_at, updated_at")
    .eq("business_id", businessId)
    .order("created_at", { ascending: false })
    .limit(100);
  if (filter.outletId) query = query.eq("outlet_id", filter.outletId);
  if (filter.group === "active") {
    query = query.in("status", ["open", "held", "placed", "preparing", "ready"]);
  } else if (filter.group === "completed") {
    query = query.eq("status", "completed");
  } else {
    query = query.eq("status", "cancelled");
  }
  const { data } = await query;
  const rows = data ?? [];
  const ids = rows.map((r) => r.id);
  const tableIds = [...new Set(rows.map((r) => r.table_id).filter((t): t is string => Boolean(t)))];
  const outletIds = [...new Set(rows.map((r) => r.outlet_id))];

  const [{ data: items }, { data: tables }, { data: outlets }] = await Promise.all([
    ids.length > 0
      ? admin.from("order_items").select("order_id").in("order_id", ids)
      : Promise.resolve({ data: [] as { order_id: string }[] }),
    tableIds.length > 0
      ? admin.from("dining_tables").select("id, label").in("id", tableIds)
      : Promise.resolve({ data: [] as { id: string; label: string }[] }),
    outletIds.length > 0
      ? admin.from("outlets").select("id, name").in("id", outletIds)
      : Promise.resolve({ data: [] as { id: string; name: string }[] }),
  ]);

  const itemCounts = new Map<string, number>();
  for (const item of items ?? []) {
    itemCounts.set(item.order_id, (itemCounts.get(item.order_id) ?? 0) + 1);
  }
  const tableLabels = new Map((tables ?? []).map((t) => [t.id, t.label]));
  const outletNames = new Map((outlets ?? []).map((o) => [o.id, o.name]));

  return rows.map((row) => ({
    id: row.id,
    orderNumber: row.order_number,
    orderType: row.order_type,
    status: row.status,
    totalMinor: Number(row.total_minor),
    itemCount: itemCounts.get(row.id) ?? 0,
    tableName: row.table_id ? tableLabels.get(row.table_id) ?? null : null,
    customerName: row.customer_name,
    outletName: outletNames.get(row.outlet_id) ?? "—",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

export interface OrderDetail {
  id: string;
  outletId: string;
  orderNumber: number;
  orderType: string;
  status: string;
  paymentStatus: string;
  paidMinor: number;
  tableName: string | null;
  customerName: string | null;
  customerPhone: string | null;
  /** Phase 15: linked customer (set from the phone on save). */
  customerId: string | null;
  /** Phase 15: coupon or reward discount, in paise, already part of discountMinor. */
  promotionMinor: number;
  promotion: {
    kind: "coupon" | "reward";
    label: string;
    amountMinor: number;
    discountType: "flat" | "percent";
    discountValue: number;
    minSubtotalMinor: number;
    voucherId: string | null;
  } | null;
  /** True once an invoice is billed. Promotions cannot change then. */
  billed: boolean;
  deliveryAddress: string | null;
  notes: string | null;
  discountType: string;
  discountValue: number;
  charges: { name: string; amount_minor: number }[];
  subtotalMinor: number;
  discountMinor: number;
  taxMinor: number;
  chargesMinor: number;
  totalMinor: number;
  outletName: string;
  createdAt: string;
  items: {
    id: string;
    name: string;
    quantity: number;
    unitPriceMinor: number;
    modifiersMinor: number;
    lineTotalMinor: number;
    itemNotes: string | null;
    modifiers: { id: string; name: string; priceMinor: number; quantity: number }[];
  }[];
  history: { id: string; fromStatus: string | null; toStatus: string; note: string | null; createdAt: string }[];
}

export async function loadOrderDetail(businessId: string, orderId: string): Promise<OrderDetail | null> {
  const admin = createAdminClient();
  const { data: order } = await admin
    .from("orders")
    .select("*")
    .eq("id", orderId)
    .eq("business_id", businessId)
    .maybeSingle();
  if (!order) return null;

  const { data: items } = await admin
    .from("order_items")
    .select("id, name, quantity, unit_price_minor, modifiers_minor, line_total_minor, item_notes, position")
    .eq("order_id", orderId)
    .order("position", { ascending: true });
  const itemIds = (items ?? []).map((i) => i.id);
  const { data: modifiers } =
    itemIds.length > 0
      ? await admin
          .from("order_item_modifiers")
          .select("id, order_item_id, name, price_minor, quantity")
          .in("order_item_id", itemIds)
      : { data: [] };
  const { data: history } = await admin
    .from("order_status_history")
    .select("id, from_status, to_status, note, created_at")
    .eq("order_id", orderId)
    .order("created_at", { ascending: true });
  const { data: outlet } = await admin.from("outlets").select("name").eq("id", order.outlet_id).maybeSingle();
  const { data: promotion } = await admin
    .from("order_promotions")
    .select("kind, label, amount_minor, discount_type, discount_value, min_subtotal_minor, voucher_id")
    .eq("order_id", orderId)
    .eq("business_id", businessId)
    .maybeSingle();
  let tableName: string | null = null;
  if (order.table_id) {
    const { data: table } = await admin.from("dining_tables").select("label").eq("id", order.table_id).maybeSingle();
    tableName = table?.label ?? null;
  }

  return {
    id: order.id,
    outletId: order.outlet_id,
    orderNumber: order.order_number,
    orderType: order.order_type,
    status: order.status,
    paymentStatus: order.payment_status,
    paidMinor: Number(order.paid_minor),
    tableName,
    customerName: order.customer_name,
    customerPhone: order.customer_phone,
    customerId: order.customer_id ?? null,
    promotionMinor: Number(order.promotion_minor ?? 0),
    promotion: promotion
      ? {
          kind: promotion.kind as "coupon" | "reward",
          label: promotion.label,
          amountMinor: Number(promotion.amount_minor),
          discountType: promotion.discount_type as "flat" | "percent",
          discountValue: Number(promotion.discount_value),
          minSubtotalMinor: Number(promotion.min_subtotal_minor),
          voucherId: promotion.voucher_id,
        }
      : null,
    billed: order.billed_at != null,
    deliveryAddress: order.delivery_address,
    notes: order.notes,
    discountType: order.discount_type,
    discountValue: Number(order.discount_value),
    charges: (order.charges ?? []) as { name: string; amount_minor: number }[],
    subtotalMinor: Number(order.subtotal_minor),
    discountMinor: Number(order.discount_minor),
    taxMinor: Number(order.tax_minor),
    chargesMinor: Number(order.charges_minor),
    totalMinor: Number(order.total_minor),
    outletName: outlet?.name ?? "—",
    createdAt: order.created_at,
    items: (items ?? []).map((item) => ({
      id: item.id,
      name: item.name,
      quantity: item.quantity,
      unitPriceMinor: Number(item.unit_price_minor),
      modifiersMinor: Number(item.modifiers_minor),
      lineTotalMinor: Number(item.line_total_minor),
      itemNotes: item.item_notes,
      modifiers: (modifiers ?? [])
        .filter((m) => m.order_item_id === item.id)
        .map((m) => ({ id: m.id, name: m.name, priceMinor: Number(m.price_minor), quantity: m.quantity })),
    })),
    history: (history ?? []).map((h) => ({
      id: h.id,
      fromStatus: h.from_status,
      toStatus: h.to_status,
      note: h.note,
      createdAt: h.created_at,
    })),
  };
}

/** Load a held/open order back into the POS cart. */
export async function loadOrderForPos(
  businessId: string,
  orderId: string,
): Promise<{
  clientRef: string;
  orderType: string;
  status: string;
  tableId: string | null;
  customerName: string | null;
  customerPhone: string | null;
  deliveryAddress: string | null;
  notes: string | null;
  discount: { type: "none" | "percent" | "flat"; value: number };
  charges: { name: string; amountMinor: number }[];
  items: {
    itemType: "product" | "combo";
    productId: string | null;
    comboId: string | null;
    variantId: string | null;
    quantity: number;
    itemNotes: string | null;
    modifiers: { modifierId: string; quantity: number }[];
  }[];
} | null> {
  const admin = createAdminClient();
  const { data: order } = await admin
    .from("orders")
    .select("id, client_ref, order_type, status, table_id, customer_name, customer_phone, delivery_address, notes, discount_type, discount_value, charges")
    .eq("id", orderId)
    .eq("business_id", businessId)
    .in("status", ["open", "held"])
    .maybeSingle();
  if (!order) return null;

  const { data: items } = await admin
    .from("order_items")
    .select("id, item_type, product_id, combo_id, variant_id, quantity, item_notes, position")
    .eq("order_id", orderId)
    .order("position", { ascending: true });
  const itemIds = (items ?? []).map((i) => i.id);
  const { data: modifiers } =
    itemIds.length > 0
      ? await admin
          .from("order_item_modifiers")
          .select("order_item_id, modifier_id, quantity")
          .in("order_item_id", itemIds)
      : { data: [] };

  return {
    clientRef: order.client_ref,
    orderType: order.order_type,
    status: order.status,
    tableId: order.table_id,
    customerName: order.customer_name,
    customerPhone: order.customer_phone,
    deliveryAddress: order.delivery_address,
    notes: order.notes,
    discount: { type: order.discount_type, value: Number(order.discount_value) },
    charges: ((order.charges ?? []) as { name: string; amount_minor: number }[]).map((c) => ({
      name: c.name,
      amountMinor: Number(c.amount_minor),
    })),
    items: (items ?? []).map((item) => ({
      itemType: item.item_type,
      productId: item.product_id,
      comboId: item.combo_id,
      variantId: item.variant_id,
      quantity: item.quantity,
      itemNotes: item.item_notes,
      modifiers: (modifiers ?? [])
        .filter((m) => m.order_item_id === item.id)
        .filter((m) => Boolean(m.modifier_id))
        .map((m) => ({ modifierId: m.modifier_id as string, quantity: m.quantity })),
    })),
  };
}
