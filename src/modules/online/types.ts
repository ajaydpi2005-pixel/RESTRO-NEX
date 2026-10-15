/**
 * Phase 17 — shapes returned by the public_* and online_* database functions.
 * Money is integer minor units (paise) everywhere.
 */

export interface OrderingSettings {
  online_enabled: boolean;
  takeaway_enabled: boolean;
  delivery_enabled: boolean;
  qr_enabled: boolean;
  accepting_orders: boolean;
  auto_accept: boolean;
  min_order_minor: number;
  delivery_fee_minor: number;
  packaging_fee_minor: number;
  prep_minutes: number;
}

export interface StorefrontContext {
  business_id: string;
  business_name: string;
  business_slug: string;
  outlet_id: string;
  outlet_name: string;
  outlet_slug: string;
  currency_code: string;
  settings: OrderingSettings;
}

export interface QrContext {
  qr_code_id: string;
  business_id: string;
  business_name: string;
  outlet_id: string;
  outlet_name: string;
  currency_code: string;
  table_id: string;
  table_label: string;
  settings: OrderingSettings;
}

export interface PublicVariant {
  id: string;
  name: string;
  price_minor: number;
}

export interface PublicModifier {
  id: string;
  name: string;
  price_minor: number;
}

export interface PublicModifierGroup {
  id: string;
  name: string;
  min_selected: number;
  max_selected: number | null;
  modifiers: PublicModifier[];
}

export interface PublicMenuItem {
  id: string;
  item_type: "product" | "combo";
  name: string;
  description: string | null;
  is_vegetarian: boolean;
  price_minor: number;
  variants: PublicVariant[];
  modifier_groups: PublicModifierGroup[];
}

export interface PublicCategory {
  id: string;
  name: string;
  parent_id: string | null;
  items: PublicMenuItem[];
}

export interface PublicMenu {
  categories: PublicCategory[];
  combos: PublicMenuItem[];
}

export interface PublicOrderItem {
  name: string;
  quantity: number;
  line_total_minor: number;
}

export interface PublicOrderStatus {
  order_id: string;
  order_number: number;
  channel: "online" | "qr";
  order_type: "dine_in" | "takeaway" | "delivery";
  status: string;
  intake_status: "awaiting_acceptance" | "accepted" | "rejected" | null;
  payment_mode: string | null;
  total_minor: number;
  paid_minor: number;
  rejected_reason: string | null;
  created_at: string;
  accepted_at: string | null;
  items: PublicOrderItem[];
}

export interface QueueOrder {
  id: string;
  order_number: number;
  channel: "online" | "qr";
  order_type: "dine_in" | "takeaway" | "delivery";
  status: string;
  intake_status: "awaiting_acceptance" | "accepted" | "rejected" | null;
  payment_mode: string | null;
  table_label: string | null;
  customer_name: string | null;
  customer_phone: string | null;
  delivery_address: string | null;
  notes: string | null;
  total_minor: number;
  created_at: string;
  accepted_at: string | null;
  rejected_reason: string | null;
  items: PublicOrderItem[];
}

export interface QrCodeRow {
  id: string;
  label: string;
  token_prefix: string;
  status: "active" | "revoked";
  table_id: string;
  table_label: string | null;
  created_at: string;
  revoked_at: string | null;
}
