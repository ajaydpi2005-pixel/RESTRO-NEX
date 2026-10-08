import { createAdminClient } from "@/lib/supabase/admin";
import type { ProductFilters } from "@/modules/menu/schemas";

/**
 * Phase 7 — Menu reads (service client; pages authorise first via RBAC).
 */

export interface CategoryNode {
  id: string;
  name: string;
  parentId: string | null;
  productCount: number;
  children: CategoryNode[];
}

export async function loadCategoryTree(businessId: string): Promise<CategoryNode[]> {
  const admin = createAdminClient();
  const { data: categories, error } = await admin
    .from("menu_categories")
    .select("id, name, parent_id, sort_order")
    .eq("business_id", businessId)
    .order("sort_order", { ascending: true });
  if (error || !categories) return [];

  const { data: products } = await admin
    .from("menu_items")
    .select("category_id")
    .eq("business_id", businessId);
  const counts = new Map<string, number>();
  for (const product of products ?? []) {
    counts.set(product.category_id, (counts.get(product.category_id) ?? 0) + 1);
  }

  const nodes = new Map<string, CategoryNode>();
  for (const category of categories) {
    nodes.set(category.id, {
      id: category.id,
      name: category.name,
      parentId: category.parent_id,
      productCount: counts.get(category.id) ?? 0,
      children: [],
    });
  }
  const roots: CategoryNode[] = [];
  for (const node of nodes.values()) {
    if (node.parentId && nodes.has(node.parentId)) {
      nodes.get(node.parentId)!.children.push(node);
      // roll subcategory products up into the parent for dashboard counts
      nodes.get(node.parentId)!.productCount += node.productCount;
    } else {
      roots.push(node);
    }
  }
  return roots;
}

export function flatCategoryOptions(tree: CategoryNode[]): { id: string; label: string }[] {
  const options: { id: string; label: string }[] = [];
  for (const node of tree) {
    options.push({ id: node.id, label: node.name });
    for (const child of node.children) {
      options.push({ id: child.id, label: `${node.name} → ${child.name}` });
    }
  }
  return options;
}

export interface ProductRow {
  id: string;
  name: string;
  sku: string | null;
  priceMinor: number;
  isVegetarian: boolean;
  isAvailable: boolean;
  imagePath: string | null;
  categoryId: string;
  categoryName: string;
  variantCount: number;
}

export async function loadProducts(
  businessId: string,
  filters: ProductFilters,
): Promise<ProductRow[]> {
  const admin = createAdminClient();
  let query = admin
    .from("menu_items")
    .select("id, name, sku, price_minor, is_vegetarian, is_available, image_path, category_id, menu_categories(name)")
    .eq("business_id", businessId)
    .order("sort_order", { ascending: true })
    .order("name", { ascending: true })
    .limit(200);

  if (filters.q) {
    const q = filters.q.replace(/[%,]/g, " ");
    query = query.or(`name.ilike.%${q}%,sku.ilike.%${q}%`);
  }
  if (filters.category) {
    query = query.eq("category_id", filters.category);
  }
  if (filters.availability === "available") query = query.eq("is_available", true);
  if (filters.availability === "unavailable") query = query.eq("is_available", false);
  if (filters.food === "veg") query = query.eq("is_vegetarian", true);
  if (filters.food === "non_veg") query = query.eq("is_vegetarian", false);

  const { data, error } = await query;
  if (error || !data) return [];

  const ids = data.map((row) => row.id);
  const variantCounts = new Map<string, number>();
  if (ids.length > 0) {
    const { data: variants } = await admin
      .from("product_variants")
      .select("product_id")
      .in("product_id", ids);
    for (const variant of variants ?? []) {
      variantCounts.set(variant.product_id, (variantCounts.get(variant.product_id) ?? 0) + 1);
    }
  }

  return data.map((row) => ({
    id: row.id,
    name: row.name,
    sku: row.sku,
    priceMinor: Number(row.price_minor),
    isVegetarian: row.is_vegetarian,
    isAvailable: row.is_available,
    imagePath: row.image_path,
    categoryId: row.category_id,
    categoryName: (row as { menu_categories?: { name?: string } }).menu_categories?.name ?? "—",
    variantCount: variantCounts.get(row.id) ?? 0,
  }));
}

export interface VariantRow {
  id: string;
  name: string;
  sku: string | null;
  priceMinor: number;
  isAvailable: boolean;
}

export interface ProductDetail {
  id: string;
  name: string;
  description: string | null;
  sku: string | null;
  priceMinor: number;
  taxRatePct: number | null;
  isVegetarian: boolean;
  isAvailable: boolean;
  imagePath: string | null;
  categoryId: string;
  categoryName: string;
  variants: VariantRow[];
  modifierGroups: { id: string; name: string; minSelected: number; maxSelected: number | null; optionCount: number }[];
  overrides: { outletId: string; priceMinor: number | null; isAvailable: boolean }[];
}

export async function loadProductDetail(
  businessId: string,
  productId: string,
): Promise<ProductDetail | null> {
  const admin = createAdminClient();
  const { data: product, error } = await admin
    .from("menu_items")
    .select("id, name, description, sku, price_minor, tax_rate_pct, is_vegetarian, is_available, image_path, category_id, menu_categories(name)")
    .eq("id", productId)
    .eq("business_id", businessId)
    .maybeSingle();
  if (error || !product) return null;

  const { data: variants } = await admin
    .from("product_variants")
    .select("id, name, sku, price_minor, is_available, sort_order")
    .eq("product_id", productId)
    .order("sort_order", { ascending: true });

  const { data: links } = await admin
    .from("product_modifier_groups")
    .select("modifier_group_id, modifier_groups(id, name, min_selected, max_selected)")
    .eq("product_id", productId)
    .order("sort_order", { ascending: true });

  const groupIds = (links ?? [])
    .map((link) => (link.modifier_groups as { id?: string } | null)?.id)
    .filter((id): id is string => Boolean(id));
  const optionCounts = new Map<string, number>();
  if (groupIds.length > 0) {
    const { data: modifiers } = await admin
      .from("modifiers")
      .select("modifier_group_id")
      .in("modifier_group_id", groupIds);
    for (const modifier of modifiers ?? []) {
      optionCounts.set(
        modifier.modifier_group_id,
        (optionCounts.get(modifier.modifier_group_id) ?? 0) + 1,
      );
    }
  }

  const { data: overrides } = await admin
    .from("outlet_product_overrides")
    .select("outlet_id, price_minor, is_available")
    .eq("product_id", productId);

  return {
    id: product.id,
    name: product.name,
    description: product.description,
    sku: product.sku,
    priceMinor: Number(product.price_minor),
    taxRatePct: product.tax_rate_pct === null ? null : Number(product.tax_rate_pct),
    isVegetarian: product.is_vegetarian,
    isAvailable: product.is_available,
    imagePath: product.image_path,
    categoryId: product.category_id,
    categoryName: (product as { menu_categories?: { name?: string } }).menu_categories?.name ?? "—",
    variants: (variants ?? []).map((variant) => ({
      id: variant.id,
      name: variant.name,
      sku: variant.sku,
      priceMinor: Number(variant.price_minor),
      isAvailable: variant.is_available,
    })),
    modifierGroups: (links ?? [])
      .map((link) => {
        const group = link.modifier_groups as unknown as {
          id: string;
          name: string;
          min_selected: number;
          max_selected: number | null;
        } | null;
        if (!group) return null;
        return {
          id: group.id,
          name: group.name,
          minSelected: group.min_selected,
          maxSelected: group.max_selected,
          optionCount: optionCounts.get(group.id) ?? 0,
        };
      })
      .filter((group): group is NonNullable<typeof group> => group !== null),
    overrides: (overrides ?? []).map((override) => ({
      outletId: override.outlet_id,
      priceMinor: override.price_minor === null ? null : Number(override.price_minor),
      isAvailable: override.is_available,
    })),
  };
}

export interface OutletRow {
  id: string;
  name: string;
}

export async function loadOutlets(businessId: string): Promise<OutletRow[]> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("outlets")
    .select("id, name")
    .eq("business_id", businessId)
    .eq("status", "active")
    .order("created_at", { ascending: true });
  if (error || !data) return [];
  return data;
}

export interface ModifierGroupRow {
  id: string;
  name: string;
  minSelected: number;
  maxSelected: number | null;
  optionCount: number;
  productCount: number;
}

export async function loadModifierGroups(businessId: string): Promise<ModifierGroupRow[]> {
  const admin = createAdminClient();
  const { data: groups, error } = await admin
    .from("modifier_groups")
    .select("id, name, min_selected, max_selected")
    .eq("business_id", businessId)
    .order("sort_order", { ascending: true })
    .order("name", { ascending: true });
  if (error || !groups) return [];
  const ids = groups.map((g) => g.id);
  const { data: modifiers } = await admin.from("modifiers").select("modifier_group_id").in("modifier_group_id", ids);
  const { data: links } = await admin.from("product_modifier_groups").select("modifier_group_id").in("modifier_group_id", ids);
  const optionCounts = new Map<string, number>();
  const productCounts = new Map<string, number>();
  for (const m of modifiers ?? []) optionCounts.set(m.modifier_group_id, (optionCounts.get(m.modifier_group_id) ?? 0) + 1);
  for (const l of links ?? []) productCounts.set(l.modifier_group_id, (productCounts.get(l.modifier_group_id) ?? 0) + 1);
  return groups.map((group) => ({
    id: group.id,
    name: group.name,
    minSelected: group.min_selected,
    maxSelected: group.max_selected,
    optionCount: optionCounts.get(group.id) ?? 0,
    productCount: productCounts.get(group.id) ?? 0,
  }));
}

export interface ModifierGroupDetail {
  id: string;
  name: string;
  minSelected: number;
  maxSelected: number | null;
  modifiers: { id: string; name: string; priceMinor: number }[];
  linkedProducts: { id: string; name: string }[];
}

export async function loadModifierGroupDetail(
  businessId: string,
  groupId: string,
): Promise<ModifierGroupDetail | null> {
  const admin = createAdminClient();
  const { data: group, error } = await admin
    .from("modifier_groups")
    .select("id, name, min_selected, max_selected")
    .eq("id", groupId)
    .eq("business_id", businessId)
    .maybeSingle();
  if (error || !group) return null;

  const { data: modifiers } = await admin
    .from("modifiers")
    .select("id, name, price_minor, sort_order")
    .eq("modifier_group_id", groupId)
    .order("sort_order", { ascending: true });

  const { data: links } = await admin
    .from("product_modifier_groups")
    .select("product_id, menu_items(id, name)")
    .eq("modifier_group_id", groupId);

  return {
    id: group.id,
    name: group.name,
    minSelected: group.min_selected,
    maxSelected: group.max_selected,
    modifiers: (modifiers ?? []).map((m) => ({
      id: m.id,
      name: m.name,
      priceMinor: Number(m.price_minor),
    })),
    linkedProducts: (links ?? [])
      .map((link) => link.menu_items as unknown as { id: string; name: string } | null)
      .filter((p): p is { id: string; name: string } => p !== null),
  };
}

export interface ComboRow {
  id: string;
  name: string;
  sku: string | null;
  priceMinor: number;
  isAvailable: boolean;
  itemCount: number;
}

export async function loadCombos(businessId: string, q: string | null): Promise<ComboRow[]> {
  const admin = createAdminClient();
  let query = admin
    .from("combos")
    .select("id, name, sku, price_minor, is_available")
    .eq("business_id", businessId)
    .order("sort_order", { ascending: true })
    .order("name", { ascending: true })
    .limit(200);
  if (q) query = query.or(`name.ilike.%${q.replace(/[%,]/g, " ")}%,sku.ilike.%${q.replace(/[%,]/g, " ")}%`);
  const { data, error } = await query;
  if (error || !data) return [];
  const ids = data.map((c) => c.id);
  const counts = new Map<string, number>();
  if (ids.length > 0) {
    const { data: items } = await admin.from("combo_items").select("combo_id").in("combo_id", ids);
    for (const item of items ?? []) counts.set(item.combo_id, (counts.get(item.combo_id) ?? 0) + 1);
  }
  return data.map((combo) => ({
    id: combo.id,
    name: combo.name,
    sku: combo.sku,
    priceMinor: Number(combo.price_minor),
    isAvailable: combo.is_available,
    itemCount: counts.get(combo.id) ?? 0,
  }));
}

export interface ComboDetail {
  id: string;
  name: string;
  description: string | null;
  sku: string | null;
  priceMinor: number;
  taxRatePct: number | null;
  isVegetarian: boolean;
  isAvailable: boolean;
  imagePath: string | null;
  items: {
    id: string;
    productId: string;
    productName: string;
    variantId: string | null;
    variantName: string | null;
    quantity: number;
  }[];
}

export async function loadComboDetail(businessId: string, comboId: string): Promise<ComboDetail | null> {
  const admin = createAdminClient();
  const { data: combo, error } = await admin
    .from("combos")
    .select("id, name, description, sku, price_minor, tax_rate_pct, is_vegetarian, is_available, image_path")
    .eq("id", comboId)
    .eq("business_id", businessId)
    .maybeSingle();
  if (error || !combo) return null;

  const { data: items } = await admin
    .from("combo_items")
    .select("id, product_id, variant_id, quantity, sort_order, menu_items(id, name), product_variants(id, name)")
    .eq("combo_id", comboId)
    .order("sort_order", { ascending: true });

  return {
    id: combo.id,
    name: combo.name,
    description: combo.description,
    sku: combo.sku,
    priceMinor: Number(combo.price_minor),
    taxRatePct: combo.tax_rate_pct === null ? null : Number(combo.tax_rate_pct),
    isVegetarian: combo.is_vegetarian,
    isAvailable: combo.is_available,
    imagePath: combo.image_path,
    items: (items ?? []).map((item) => {
      const product = item.menu_items as unknown as { id: string; name: string } | null;
      const variant = item.product_variants as unknown as { id: string; name: string } | null;
      return {
        id: item.id,
        productId: item.product_id,
        productName: product?.name ?? "(deleted product)",
        variantId: item.variant_id,
        variantName: variant?.name ?? null,
        quantity: item.quantity,
      };
    }),
  };
}

/** Product picker list for combo building (id, name, variants). */
export async function loadProductPicker(businessId: string): Promise<
  { id: string; name: string; variants: { id: string; name: string }[] }[]
> {
  const admin = createAdminClient();
  const { data: products, error } = await admin
    .from("menu_items")
    .select("id, name")
    .eq("business_id", businessId)
    .order("name", { ascending: true })
    .limit(500);
  if (error || !products) return [];
  const ids = products.map((p) => p.id);
  const { data: variants } =
    ids.length > 0
      ? await admin
          .from("product_variants")
          .select("id, name, product_id")
          .in("product_id", ids)
          .order("sort_order", { ascending: true })
      : { data: [] };
  return products.map((product) => ({
    id: product.id,
    name: product.name,
    variants: (variants ?? [])
      .filter((v) => v.product_id === product.id)
      .map((v) => ({ id: v.id, name: v.name })),
  }));
}

export interface MenuDashboardStats {
  categories: number;
  products: number;
  unavailableProducts: number;
  variants: number;
  modifierGroups: number;
  combos: number;
  images: number;
}

export async function loadMenuStats(businessId: string): Promise<MenuDashboardStats> {
  const admin = createAdminClient();
  const count = async (table: string) => {
    const { count: n } = await admin
      .from(table)
      .select("id", { count: "exact", head: true })
      .eq("business_id", businessId);
    return n ?? 0;
  };
  const products = await admin
    .from("menu_items")
    .select("id, is_available, image_path")
    .eq("business_id", businessId);
  const rows = products.data ?? [];
  return {
    categories: await count("menu_categories"),
    products: rows.length,
    unavailableProducts: rows.filter((r) => !r.is_available).length,
    variants: await count("product_variants"),
    modifierGroups: await count("modifier_groups"),
    combos: await count("combos"),
    images: rows.filter((r) => r.image_path).length,
  };
}
