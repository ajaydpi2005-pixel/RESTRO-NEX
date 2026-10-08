/**
 * Phase 10 — kitchen order ticket (KOT) builder.
 *
 * A KOT is the kitchen copy of an order: quantities, names, modifiers and
 * notes — never prices. Pure function so it is testable without a database.
 * Kitchen display screens (Phase 11) will consume the same shape.
 */

export interface KotSourceItem {
  name: string;
  quantity: number;
  itemNotes: string | null;
  modifiers: { name: string; quantity: number }[];
}

export interface KotSourceOrder {
  orderNumber: number;
  orderType: string;
  tableName: string | null;
  customerName: string | null;
  outletName: string;
  createdAt: string;
  notes: string | null;
  items: KotSourceItem[];
}

export interface KotLine {
  quantity: number;
  name: string;
  modifiers: string[];
  notes: string | null;
}

export interface KitchenTicket {
  orderNumber: number;
  orderType: string;
  tableName: string | null;
  customerName: string | null;
  outletName: string;
  createdAt: string;
  orderNotes: string | null;
  lines: KotLine[];
  totalQuantity: number;
}

export function buildKitchenTicket(order: KotSourceOrder): KitchenTicket {
  const lines: KotLine[] = order.items.map((item) => ({
    quantity: item.quantity,
    name: item.name,
    modifiers: item.modifiers.map((m) => (m.quantity > 1 ? `${m.quantity} × ${m.name}` : m.name)),
    notes: item.itemNotes && item.itemNotes.trim() !== "" ? item.itemNotes.trim() : null,
  }));

  return {
    orderNumber: order.orderNumber,
    orderType: order.orderType,
    tableName: order.tableName,
    customerName: order.customerName,
    outletName: order.outletName,
    createdAt: order.createdAt,
    orderNotes: order.notes && order.notes.trim() !== "" ? order.notes.trim() : null,
    lines,
    totalQuantity: lines.reduce((sum, line) => sum + line.quantity, 0),
  };
}
