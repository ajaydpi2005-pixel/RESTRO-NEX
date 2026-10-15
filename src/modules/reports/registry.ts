import type { Permission } from "@/lib/rbac/permissions";

/**
 * Phase 16 — the report catalogue. Pure data: no server imports, so the pages,
 * the export route and the tests all read the same definitions.
 *
 * Each report maps to one SQL function in migration 20261014100000_reports.sql.
 * The database checks reports.view and the report's extra permission, and it
 * limits outlets to the caller's access. The UI only decides what to show.
 */

export type ReportGroup = "sales" | "financial" | "inventory" | "staff" | "customer";

/**
 * money  — paise in the database, shown as rupees to 2 decimals.
 * unit_cost — paise per base unit, shown as rupees to 4 decimals.
 * points — loyalty points (integer).
 * qty    — quantity in the ingredient's base unit (up to 3 decimals).
 * percent — already rounded to 2 decimals by the database.
 * period — a bucket: period_start to period_end, shown as one label.
 * date / datetime — ISO strings.
 * bool   — shown as Yes / No.
 */
export type ColumnType =
  | "text"
  | "int"
  | "money"
  | "unit_cost"
  | "points"
  | "qty"
  | "percent"
  | "period"
  | "date"
  | "datetime"
  | "bool";

export interface ReportColumn {
  key: string;
  label: string;
  type: ColumnType;
}

export interface ReportSummaryItem {
  key: string;
  label: string;
  type: ColumnType;
}

export type ReportGrain = "day" | "week" | "month";

export interface ReportDefinition {
  slug: string;
  group: ReportGroup;
  title: string;
  description: string;
  /** Basis line shown on the page, so the numbers are read correctly. */
  basis: string;
  rpc: string;
  /** Permissions needed beyond reports.view. */
  extraPermission: Permission | null;
  columns: ReportColumn[];
  summary: ReportSummaryItem[];
  /** Period reports accept a grain. A fixed grain is used when the report is always one grain. */
  grain: { choose: true } | { choose: false; value: ReportGrain } | null;
  /** Whether the date range applies. Stock is a point-in-time report. */
  dates: boolean;
  /** Whether the outlet filter applies. Loyalty is business-wide. */
  outlet: boolean;
  /** Free-text search placeholder, or null when the report has no search. */
  search: string | null;
  /** Money column shown as an inline bar in the table, when there is one. */
  bar: string | null;
}

const PERIOD: ReportColumn = { key: "period_start", label: "Period", type: "period" };

export const REPORT_GROUPS: { key: ReportGroup; label: string; description: string }[] = [
  {
    key: "sales",
    label: "Sales",
    description: "Completed orders by day, week, month, outlet, product and category.",
  },
  {
    key: "financial",
    label: "Financial",
    description: "Revenue, tax, discounts, refunds and how money was collected.",
  },
  {
    key: "inventory",
    label: "Inventory",
    description: "Stock use, purchases, wastage and food cost.",
  },
  {
    key: "staff",
    label: "Staff",
    description: "Orders, discounts, refunds and cashier activity by person.",
  },
  {
    key: "customer",
    label: "Customers",
    description: "New and returning customers, spending and loyalty.",
  },
];

const SALES_BASIS =
  "Completed orders, counted on the day they were completed (Asia/Kolkata). Refunds are counted on the day they were recorded.";

export const REPORTS: readonly ReportDefinition[] = [
  // ── sales ───────────────────────────────────────────────────────────
  {
    slug: "sales-daily",
    group: "sales",
    title: "Daily sales",
    description: "Orders and sales for each day.",
    basis: SALES_BASIS,
    rpc: "report_revenue_periods",
    extraPermission: null,
    columns: [
      PERIOD,
      { key: "orders", label: "Orders", type: "int" },
      { key: "gross_minor", label: "Gross sales", type: "money" },
      { key: "discount_minor", label: "Discounts", type: "money" },
      { key: "net_sales_minor", label: "Net sales", type: "money" },
      { key: "tax_minor", label: "Tax", type: "money" },
      { key: "billed_minor", label: "Billed", type: "money" },
      { key: "avg_order_minor", label: "Average order", type: "money" },
    ],
    summary: [
      { key: "orders", label: "Orders", type: "int" },
      { key: "gross_minor", label: "Gross sales", type: "money" },
      { key: "discount_minor", label: "Discounts", type: "money" },
      { key: "net_sales_minor", label: "Net sales", type: "money" },
      { key: "tax_minor", label: "Tax", type: "money" },
      { key: "billed_minor", label: "Billed", type: "money" },
    ],
    grain: { choose: false, value: "day" },
    dates: true,
    outlet: true,
    search: null,
    bar: "billed_minor",
  },
  {
    slug: "sales-weekly",
    group: "sales",
    title: "Weekly sales",
    description: "Orders and sales for each week (Monday to Sunday).",
    basis: SALES_BASIS,
    rpc: "report_revenue_periods",
    extraPermission: null,
    columns: [
      PERIOD,
      { key: "orders", label: "Orders", type: "int" },
      { key: "gross_minor", label: "Gross sales", type: "money" },
      { key: "discount_minor", label: "Discounts", type: "money" },
      { key: "net_sales_minor", label: "Net sales", type: "money" },
      { key: "tax_minor", label: "Tax", type: "money" },
      { key: "billed_minor", label: "Billed", type: "money" },
      { key: "avg_order_minor", label: "Average order", type: "money" },
    ],
    summary: [
      { key: "orders", label: "Orders", type: "int" },
      { key: "gross_minor", label: "Gross sales", type: "money" },
      { key: "discount_minor", label: "Discounts", type: "money" },
      { key: "net_sales_minor", label: "Net sales", type: "money" },
      { key: "tax_minor", label: "Tax", type: "money" },
      { key: "billed_minor", label: "Billed", type: "money" },
    ],
    grain: { choose: false, value: "week" },
    dates: true,
    outlet: true,
    search: null,
    bar: "billed_minor",
  },
  {
    slug: "sales-monthly",
    group: "sales",
    title: "Monthly sales",
    description: "Orders and sales for each calendar month.",
    basis: SALES_BASIS,
    rpc: "report_revenue_periods",
    extraPermission: null,
    columns: [
      PERIOD,
      { key: "orders", label: "Orders", type: "int" },
      { key: "gross_minor", label: "Gross sales", type: "money" },
      { key: "discount_minor", label: "Discounts", type: "money" },
      { key: "net_sales_minor", label: "Net sales", type: "money" },
      { key: "tax_minor", label: "Tax", type: "money" },
      { key: "billed_minor", label: "Billed", type: "money" },
      { key: "avg_order_minor", label: "Average order", type: "money" },
    ],
    summary: [
      { key: "orders", label: "Orders", type: "int" },
      { key: "gross_minor", label: "Gross sales", type: "money" },
      { key: "discount_minor", label: "Discounts", type: "money" },
      { key: "net_sales_minor", label: "Net sales", type: "money" },
      { key: "tax_minor", label: "Tax", type: "money" },
      { key: "billed_minor", label: "Billed", type: "money" },
    ],
    grain: { choose: false, value: "month" },
    dates: true,
    outlet: true,
    search: null,
    bar: "billed_minor",
  },
  {
    slug: "sales-outlet",
    group: "sales",
    title: "Sales by outlet",
    description: "Sales, refunds and net revenue for each outlet you can see.",
    basis: SALES_BASIS,
    rpc: "report_sales_by_outlet",
    extraPermission: null,
    columns: [
      { key: "outlet_name", label: "Outlet", type: "text" },
      { key: "orders", label: "Orders", type: "int" },
      { key: "gross_minor", label: "Gross sales", type: "money" },
      { key: "discount_minor", label: "Discounts", type: "money" },
      { key: "net_sales_minor", label: "Net sales", type: "money" },
      { key: "billed_minor", label: "Billed", type: "money" },
      { key: "refunds_minor", label: "Refunds", type: "money" },
      { key: "net_revenue_minor", label: "Net revenue", type: "money" },
    ],
    summary: [
      { key: "orders", label: "Orders", type: "int" },
      { key: "billed_minor", label: "Billed", type: "money" },
      { key: "refunds_minor", label: "Refunds", type: "money" },
      { key: "net_revenue_minor", label: "Net revenue", type: "money" },
    ],
    grain: null,
    dates: true,
    outlet: true,
    search: "Search outlets",
    bar: "net_revenue_minor",
  },
  {
    slug: "sales-channel",
    group: "sales",
    title: "Sales by channel",
    description:
      "Orders and billed sales for each channel (counter, website, QR table) and order type.",
    basis: SALES_BASIS,
    rpc: "report_sales_by_channel",
    extraPermission: null,
    columns: [
      { key: "channel_label", label: "Channel", type: "text" },
      { key: "order_type_label", label: "Order type", type: "text" },
      { key: "orders", label: "Orders", type: "int" },
      { key: "gross_minor", label: "Gross sales", type: "money" },
      { key: "discount_minor", label: "Discounts", type: "money" },
      { key: "net_sales_minor", label: "Net sales", type: "money" },
      { key: "tax_minor", label: "Tax", type: "money" },
      { key: "billed_minor", label: "Billed", type: "money" },
      { key: "avg_order_minor", label: "Average order", type: "money" },
    ],
    summary: [
      { key: "orders", label: "Orders", type: "int" },
      { key: "billed_minor", label: "Billed", type: "money" },
      { key: "discount_minor", label: "Discounts", type: "money" },
      { key: "tax_minor", label: "Tax", type: "money" },
    ],
    grain: null,
    dates: true,
    outlet: true,
    search: "Search channels or order types",
    bar: "billed_minor",
  },
  {
    slug: "sales-product",
    group: "sales",
    title: "Sales by product",
    description: "Quantity sold and gross sales for each product and combo.",
    basis:
      "Order lines of completed orders, counted on the day they were completed. Cancelled orders are excluded. Gross includes modifiers, before discounts and tax.",
    rpc: "report_sales_by_product",
    extraPermission: null,
    columns: [
      { key: "item_name", label: "Product", type: "text" },
      { key: "category", label: "Category", type: "text" },
      { key: "orders", label: "Orders", type: "int" },
      { key: "quantity", label: "Quantity", type: "int" },
      { key: "gross_minor", label: "Gross sales", type: "money" },
      { key: "share_pct", label: "Share", type: "percent" },
    ],
    summary: [
      { key: "items", label: "Products", type: "int" },
      { key: "quantity", label: "Quantity", type: "int" },
      { key: "gross_minor", label: "Gross sales", type: "money" },
    ],
    grain: null,
    dates: true,
    outlet: true,
    search: "Search products or categories",
    bar: "gross_minor",
  },
  {
    slug: "sales-category",
    group: "sales",
    title: "Sales by category",
    description: "Quantity sold and gross sales for each menu category.",
    basis:
      "Order lines of completed orders, counted on the day they were completed. Combos are grouped under Combos. Items without a category are grouped under Uncategorised.",
    rpc: "report_sales_by_category",
    extraPermission: null,
    columns: [
      { key: "category", label: "Category", type: "text" },
      { key: "items", label: "Products", type: "int" },
      { key: "orders", label: "Orders", type: "int" },
      { key: "quantity", label: "Quantity", type: "int" },
      { key: "gross_minor", label: "Gross sales", type: "money" },
      { key: "share_pct", label: "Share", type: "percent" },
    ],
    summary: [
      { key: "categories", label: "Categories", type: "int" },
      { key: "quantity", label: "Quantity", type: "int" },
      { key: "gross_minor", label: "Gross sales", type: "money" },
    ],
    grain: null,
    dates: true,
    outlet: true,
    search: "Search categories",
    bar: "gross_minor",
  },

  // ── financial ───────────────────────────────────────────────────────
  {
    slug: "revenue",
    group: "financial",
    title: "Revenue",
    description: "Billed sales, less refunds recorded in the period, by day, week or month.",
    basis:
      "Billed is completed orders in the period. Refunds are the refunds recorded in the period, even when the order was billed earlier (cash basis). Net revenue = billed − refunds.",
    rpc: "report_revenue_periods",
    extraPermission: null,
    columns: [
      PERIOD,
      { key: "orders", label: "Orders", type: "int" },
      { key: "gross_minor", label: "Gross sales", type: "money" },
      { key: "discount_minor", label: "Discounts", type: "money" },
      { key: "net_sales_minor", label: "Net sales", type: "money" },
      { key: "tax_minor", label: "Tax", type: "money" },
      { key: "charges_minor", label: "Charges", type: "money" },
      { key: "billed_minor", label: "Billed", type: "money" },
      { key: "refunds_minor", label: "Refunds", type: "money" },
      { key: "net_revenue_minor", label: "Net revenue", type: "money" },
    ],
    summary: [
      { key: "billed_minor", label: "Billed", type: "money" },
      { key: "refunds_minor", label: "Refunds", type: "money" },
      { key: "net_revenue_minor", label: "Net revenue", type: "money" },
      { key: "tax_minor", label: "Tax", type: "money" },
    ],
    grain: { choose: true },
    dates: true,
    outlet: true,
    search: null,
    bar: "net_revenue_minor",
  },
  {
    slug: "tax",
    group: "financial",
    title: "Tax",
    description: "Tax billed, tax refunded and net tax by period.",
    basis:
      "Tax billed is on completed orders in the period. Tax refunded is the pro-rata tax of each refund recorded in the period: refund × order tax ÷ order total, rounded to the paisa.",
    rpc: "report_tax_periods",
    extraPermission: null,
    columns: [
      PERIOD,
      { key: "orders", label: "Orders", type: "int" },
      { key: "taxable_minor", label: "Taxable value", type: "money" },
      { key: "tax_billed_minor", label: "Tax billed", type: "money" },
      { key: "tax_refunded_minor", label: "Tax refunded", type: "money" },
      { key: "net_tax_minor", label: "Net tax", type: "money" },
    ],
    summary: [
      { key: "taxable_minor", label: "Taxable value", type: "money" },
      { key: "tax_billed_minor", label: "Tax billed", type: "money" },
      { key: "tax_refunded_minor", label: "Tax refunded", type: "money" },
      { key: "net_tax_minor", label: "Net tax", type: "money" },
    ],
    grain: { choose: true },
    dates: true,
    outlet: true,
    search: null,
    bar: null,
  },
  {
    slug: "discounts",
    group: "financial",
    title: "Discounts",
    description: "Manual discounts and promotions on completed orders, by period.",
    basis:
      "Completed orders in the period. Manual is the discount typed at the till. Promotion is coupons and rewards. Percentages are of gross sales.",
    rpc: "report_discount_periods",
    extraPermission: null,
    columns: [
      PERIOD,
      { key: "orders", label: "Orders", type: "int" },
      { key: "discounted_orders", label: "Discounted orders", type: "int" },
      { key: "gross_minor", label: "Gross sales", type: "money" },
      { key: "manual_minor", label: "Manual", type: "money" },
      { key: "promotion_minor", label: "Promotions", type: "money" },
      { key: "total_discount_minor", label: "Total", type: "money" },
      { key: "discount_pct", label: "% of gross", type: "percent" },
    ],
    summary: [
      { key: "discounted_orders", label: "Discounted orders", type: "int" },
      { key: "manual_minor", label: "Manual", type: "money" },
      { key: "promotion_minor", label: "Promotions", type: "money" },
      { key: "total_discount_minor", label: "Total discounts", type: "money" },
    ],
    grain: { choose: true },
    dates: true,
    outlet: true,
    search: null,
    bar: null,
  },
  {
    slug: "refunds",
    group: "financial",
    title: "Refunds",
    description: "Every refund recorded in the period, newest first.",
    basis:
      "Refunds are listed by the time they were recorded. Tax is the pro-rata share of the order's tax. The processed-by name is the person who recorded the refund.",
    rpc: "report_refunds_list",
    extraPermission: null,
    columns: [
      { key: "created_at", label: "Recorded", type: "datetime" },
      { key: "order_number", label: "Order", type: "int" },
      { key: "method_label", label: "Method", type: "text" },
      { key: "amount_minor", label: "Amount", type: "money" },
      { key: "tax_minor", label: "Tax refunded", type: "money" },
      { key: "reason", label: "Reason", type: "text" },
      { key: "processed_by", label: "Processed by", type: "text" },
    ],
    summary: [
      { key: "refunds", label: "Refunds", type: "int" },
      { key: "amount_minor", label: "Amount", type: "money" },
      { key: "tax_minor", label: "Tax refunded", type: "money" },
    ],
    grain: null,
    dates: true,
    outlet: true,
    search: "Search order number, reason or method",
    bar: null,
  },
  {
    slug: "payments",
    group: "financial",
    title: "Payments",
    description: "What was collected and refunded by each payment method.",
    basis:
      "Captured payments recorded in the period, by the time they were recorded, less refunds recorded in the period. Net = collected − refunded.",
    rpc: "report_payments_by_method",
    extraPermission: null,
    columns: [
      { key: "method_label", label: "Method", type: "text" },
      { key: "method_kind", label: "Kind", type: "text" },
      { key: "payments_count", label: "Payments", type: "int" },
      { key: "collected_minor", label: "Collected", type: "money" },
      { key: "refunds_count", label: "Refunds", type: "int" },
      { key: "refunded_minor", label: "Refunded", type: "money" },
      { key: "net_minor", label: "Net", type: "money" },
    ],
    summary: [
      { key: "payments_count", label: "Payments", type: "int" },
      { key: "collected_minor", label: "Collected", type: "money" },
      { key: "refunds_count", label: "Refunds", type: "int" },
      { key: "refunded_minor", label: "Refunded", type: "money" },
      { key: "net_minor", label: "Net", type: "money" },
    ],
    grain: null,
    dates: true,
    outlet: true,
    search: "Search methods",
    bar: "collected_minor",
  },

  // ── inventory ───────────────────────────────────────────────────────
  {
    slug: "inventory-consumption",
    group: "inventory",
    title: "Consumption",
    description: "Ingredients used by sales, with cost, by outlet.",
    basis:
      "Ledger rows of kind consumption, counted on the day they were posted. Posting happens when an order completes. Cost is at the batch cost recorded in the ledger.",
    rpc: "report_inventory_consumption",
    extraPermission: "inventory.view",
    columns: [
      { key: "outlet_name", label: "Outlet", type: "text" },
      { key: "ingredient_name", label: "Ingredient", type: "text" },
      { key: "unit", label: "Unit", type: "text" },
      { key: "quantity", label: "Quantity", type: "qty" },
      { key: "cost_minor", label: "Cost", type: "money" },
      { key: "avg_unit_cost", label: "Avg cost per unit", type: "unit_cost" },
    ],
    summary: [
      { key: "ingredients", label: "Ingredients", type: "int" },
      { key: "cost_minor", label: "Total cost", type: "money" },
    ],
    grain: null,
    dates: true,
    outlet: true,
    search: "Search ingredients or outlets",
    bar: "cost_minor",
  },
  {
    slug: "inventory-purchases",
    group: "inventory",
    title: "Purchases",
    description: "Goods received, with value, by outlet.",
    basis:
      "Goods receipts, counted on the day they were received. Value is the receipt line total as posted.",
    rpc: "report_inventory_purchases",
    extraPermission: "inventory.view",
    columns: [
      { key: "outlet_name", label: "Outlet", type: "text" },
      { key: "ingredient_name", label: "Ingredient", type: "text" },
      { key: "unit", label: "Unit", type: "text" },
      { key: "receipts", label: "Receipts", type: "int" },
      { key: "quantity", label: "Quantity", type: "qty" },
      { key: "value_minor", label: "Value", type: "money" },
      { key: "avg_unit_cost", label: "Avg cost per unit", type: "unit_cost" },
    ],
    summary: [
      { key: "ingredients", label: "Ingredients", type: "int" },
      { key: "receipts", label: "Receipts", type: "int" },
      { key: "value_minor", label: "Total value", type: "money" },
    ],
    grain: null,
    dates: true,
    outlet: true,
    search: "Search ingredients or outlets",
    bar: "value_minor",
  },
  {
    slug: "inventory-wastage",
    group: "inventory",
    title: "Wastage",
    description: "Stock written off as waste, with reasons, by outlet.",
    basis: "Ledger rows of kind wastage, counted on the day they were recorded.",
    rpc: "report_inventory_wastage",
    extraPermission: "inventory.view",
    columns: [
      { key: "outlet_name", label: "Outlet", type: "text" },
      { key: "ingredient_name", label: "Ingredient", type: "text" },
      { key: "unit", label: "Unit", type: "text" },
      { key: "entries", label: "Entries", type: "int" },
      { key: "quantity", label: "Quantity", type: "qty" },
      { key: "cost_minor", label: "Cost", type: "money" },
      { key: "reasons", label: "Reasons", type: "text" },
    ],
    summary: [
      { key: "entries", label: "Entries", type: "int" },
      { key: "cost_minor", label: "Total cost", type: "money" },
    ],
    grain: null,
    dates: true,
    outlet: true,
    search: "Search ingredients or reasons",
    bar: "cost_minor",
  },
  {
    slug: "food-cost",
    group: "inventory",
    title: "Food cost",
    description: "Theoretical food cost: recipe consumption ÷ net sales, by period.",
    basis:
      "Consumption is the recipe cost of the orders completed in the period. Net sales = subtotal − discounts, before tax. Food cost % = consumption ÷ net sales. Wastage is shown beside it and is not included. This is theoretical cost, not counted stock.",
    rpc: "report_inventory_food_cost",
    extraPermission: "inventory.view",
    columns: [
      PERIOD,
      { key: "orders", label: "Orders", type: "int" },
      { key: "net_sales_minor", label: "Net sales", type: "money" },
      { key: "consumption_minor", label: "Recipe cost", type: "money" },
      { key: "food_cost_pct", label: "Food cost %", type: "percent" },
      { key: "wastage_minor", label: "Wastage", type: "money" },
      { key: "wastage_pct", label: "Wastage %", type: "percent" },
    ],
    summary: [
      { key: "net_sales_minor", label: "Net sales", type: "money" },
      { key: "consumption_minor", label: "Recipe cost", type: "money" },
      { key: "food_cost_pct", label: "Food cost %", type: "percent" },
      { key: "wastage_minor", label: "Wastage", type: "money" },
    ],
    grain: { choose: true },
    dates: true,
    outlet: true,
    search: null,
    bar: null,
  },
  {
    slug: "inventory-stock",
    group: "inventory",
    title: "Stock",
    description: "Stock on hand now, its value, and items below their minimum.",
    basis:
      "A point-in-time view: on hand is today's stock. Value is the batches that hold it. A mismatch means on hand differs from the batches, which needs a stock check.",
    rpc: "report_inventory_stock",
    extraPermission: "inventory.view",
    columns: [
      { key: "outlet_name", label: "Outlet", type: "text" },
      { key: "ingredient_name", label: "Ingredient", type: "text" },
      { key: "unit", label: "Unit", type: "text" },
      { key: "on_hand", label: "On hand", type: "qty" },
      { key: "minimum_stock", label: "Minimum", type: "qty" },
      { key: "below_minimum", label: "Below minimum", type: "bool" },
      { key: "value_minor", label: "Value", type: "money" },
      { key: "batches_match", label: "Batches match", type: "bool" },
    ],
    summary: [
      { key: "items", label: "Items", type: "int" },
      { key: "value_minor", label: "Stock value", type: "money" },
      { key: "below_minimum", label: "Below minimum", type: "int" },
      { key: "batch_mismatches", label: "Batch mismatches", type: "int" },
    ],
    grain: null,
    dates: false,
    outlet: true,
    search: "Search ingredients or outlets",
    bar: "value_minor",
  },

  // ── staff ───────────────────────────────────────────────────────────
  {
    slug: "staff-orders",
    group: "staff",
    title: "Orders by staff",
    description: "Orders opened by each person, and how they ended.",
    basis:
      "Orders opened (created) in the period, grouped by the person who opened them. Status is the status now. Completed value is the billed total of completed orders.",
    rpc: "report_staff_orders",
    extraPermission: "staff.view",
    columns: [
      { key: "user_name", label: "Staff", type: "text" },
      { key: "opened", label: "Opened", type: "int" },
      { key: "completed", label: "Completed", type: "int" },
      { key: "cancelled", label: "Cancelled", type: "int" },
      { key: "still_open", label: "Still open", type: "int" },
      { key: "completed_minor", label: "Completed value", type: "money" },
    ],
    summary: [
      { key: "opened", label: "Opened", type: "int" },
      { key: "completed", label: "Completed", type: "int" },
      { key: "cancelled", label: "Cancelled", type: "int" },
      { key: "completed_minor", label: "Completed value", type: "money" },
    ],
    grain: null,
    dates: true,
    outlet: true,
    search: "Search staff",
    bar: "completed_minor",
  },
  {
    slug: "staff-discounts",
    group: "staff",
    title: "Discounts by staff",
    description: "Discounts on completed orders, by the person who created the order.",
    basis:
      "Completed orders in the period, grouped by the person who created the order. The database stores no separate discount author, so this is a limitation: a discount typed by someone else on that order is attributed to its creator.",
    rpc: "report_staff_discounts",
    extraPermission: "staff.view",
    columns: [
      { key: "user_name", label: "Staff", type: "text" },
      { key: "orders", label: "Orders", type: "int" },
      { key: "discounted_orders", label: "Discounted orders", type: "int" },
      { key: "gross_minor", label: "Gross sales", type: "money" },
      { key: "manual_minor", label: "Manual", type: "money" },
      { key: "promotion_minor", label: "Promotions", type: "money" },
      { key: "total_discount_minor", label: "Total", type: "money" },
      { key: "discount_pct", label: "% of gross", type: "percent" },
    ],
    summary: [
      { key: "orders", label: "Orders", type: "int" },
      { key: "discounted_orders", label: "Discounted orders", type: "int" },
      { key: "total_discount_minor", label: "Total discounts", type: "money" },
    ],
    grain: null,
    dates: true,
    outlet: true,
    search: "Search staff",
    bar: "total_discount_minor",
  },
  {
    slug: "staff-refunds",
    group: "staff",
    title: "Refunds by staff",
    description: "Refunds recorded by each person in the period.",
    basis: "Refunds recorded in the period (refund date), grouped by the person who recorded them.",
    rpc: "report_staff_refunds",
    extraPermission: "staff.view",
    columns: [
      { key: "user_name", label: "Staff", type: "text" },
      { key: "refunds", label: "Refunds", type: "int" },
      { key: "amount_minor", label: "Amount", type: "money" },
      { key: "avg_refund_minor", label: "Average refund", type: "money" },
    ],
    summary: [
      { key: "refunds", label: "Refunds", type: "int" },
      { key: "amount_minor", label: "Amount", type: "money" },
    ],
    grain: null,
    dates: true,
    outlet: true,
    search: "Search staff",
    bar: "amount_minor",
  },
  {
    slug: "cashier-activity",
    group: "staff",
    title: "Cashier activity",
    description:
      "Orders opened, completed and cancelled, payments taken and refunds processed, by person.",
    basis:
      "Each count uses its own timestamp in the period: orders opened by creation time, completions and cancellations by status-change time, payments and refunds by recording time.",
    rpc: "report_staff_cashier",
    extraPermission: "staff.view",
    columns: [
      { key: "user_name", label: "Staff", type: "text" },
      { key: "orders_opened", label: "Opened", type: "int" },
      { key: "orders_completed", label: "Completed", type: "int" },
      { key: "orders_cancelled", label: "Cancelled", type: "int" },
      { key: "payments_count", label: "Payments", type: "int" },
      { key: "payments_minor", label: "Taken", type: "money" },
      { key: "refunds_count", label: "Refunds", type: "int" },
      { key: "refunds_minor", label: "Refunded", type: "money" },
    ],
    summary: [
      { key: "orders_opened", label: "Opened", type: "int" },
      { key: "orders_completed", label: "Completed", type: "int" },
      { key: "payments_minor", label: "Taken", type: "money" },
      { key: "refunds_minor", label: "Refunded", type: "money" },
    ],
    grain: null,
    dates: true,
    outlet: true,
    search: "Search staff",
    bar: "payments_minor",
  },

  // ── customers ───────────────────────────────────────────────────────
  {
    slug: "customers-new",
    group: "customer",
    title: "New customers",
    description: "Customers whose first completed order fell in the period.",
    basis:
      "A customer is new when their first completed order (at any outlet) falls in the period. Customers are shared across outlets; the outlet filter narrows only their orders in the period.",
    rpc: "report_customers_new",
    extraPermission: "customers.view",
    columns: [
      { key: "name", label: "Customer", type: "text" },
      { key: "phone", label: "Phone", type: "text" },
      { key: "first_order_day", label: "First order", type: "date" },
      { key: "orders", label: "Orders in period", type: "int" },
      { key: "billed_minor", label: "Billed", type: "money" },
      { key: "refunds_minor", label: "Refunds", type: "money" },
      { key: "net_minor", label: "Net", type: "money" },
      { key: "points_balance", label: "Points", type: "points" },
    ],
    summary: [
      { key: "customers", label: "New customers", type: "int" },
      { key: "orders", label: "Orders", type: "int" },
      { key: "billed_minor", label: "Billed", type: "money" },
      { key: "net_minor", label: "Net", type: "money" },
    ],
    grain: null,
    dates: true,
    outlet: true,
    search: "Search name or phone",
    bar: null,
  },
  {
    slug: "customers-returning",
    group: "customer",
    title: "Returning customers",
    description: "Customers who ordered in the period after an earlier completed order.",
    basis:
      "A customer is returning when they completed an order in the period and their first completed order was before the period started.",
    rpc: "report_customers_returning",
    extraPermission: "customers.view",
    columns: [
      { key: "name", label: "Customer", type: "text" },
      { key: "phone", label: "Phone", type: "text" },
      { key: "first_order_day", label: "First order", type: "date" },
      { key: "last_order_day", label: "Last order in period", type: "date" },
      { key: "orders", label: "Orders in period", type: "int" },
      { key: "billed_minor", label: "Billed", type: "money" },
      { key: "refunds_minor", label: "Refunds", type: "money" },
      { key: "net_minor", label: "Net", type: "money" },
    ],
    summary: [
      { key: "customers", label: "Returning customers", type: "int" },
      { key: "orders", label: "Orders", type: "int" },
      { key: "billed_minor", label: "Billed", type: "money" },
      { key: "net_minor", label: "Net", type: "money" },
    ],
    grain: null,
    dates: true,
    outlet: true,
    search: "Search name or phone",
    bar: null,
  },
  {
    slug: "customers-spending",
    group: "customer",
    title: "Customer spending",
    description: "Customers ranked by net spend in the period.",
    basis:
      "Net spend = billed on completed orders in the period − refunds recorded in the period. Customers are ranked by net spend.",
    rpc: "report_customers_spending",
    extraPermission: "customers.view",
    columns: [
      { key: "name", label: "Customer", type: "text" },
      { key: "phone", label: "Phone", type: "text" },
      { key: "status", label: "Status", type: "text" },
      { key: "orders", label: "Orders", type: "int" },
      { key: "billed_minor", label: "Billed", type: "money" },
      { key: "refunds_minor", label: "Refunds", type: "money" },
      { key: "net_minor", label: "Net spend", type: "money" },
      { key: "avg_order_minor", label: "Average order", type: "money" },
      { key: "last_order_day", label: "Last order", type: "date" },
      { key: "points_balance", label: "Points", type: "points" },
    ],
    summary: [
      { key: "customers", label: "Customers", type: "int" },
      { key: "orders", label: "Orders", type: "int" },
      { key: "billed_minor", label: "Billed", type: "money" },
      { key: "net_minor", label: "Net spend", type: "money" },
    ],
    grain: null,
    dates: true,
    outlet: true,
    search: "Search name or phone",
    bar: "net_minor",
  },
  {
    slug: "loyalty",
    group: "customer",
    title: "Loyalty",
    description:
      "Points earned, redeemed, reversed and adjusted, by period, with the balance outstanding now.",
    basis:
      "Ledger rows in the period, by the time they were recorded. Redeemed and reversed show points taken away. Outstanding is the balance across all customers now. Loyalty is business-wide, so the outlet filter does not apply.",
    rpc: "report_customers_loyalty",
    extraPermission: "customers.view",
    columns: [
      PERIOD,
      { key: "earned", label: "Earned", type: "points" },
      { key: "redeemed", label: "Redeemed", type: "points" },
      { key: "reversed", label: "Reversed", type: "points" },
      { key: "adjusted", label: "Adjusted", type: "points" },
      { key: "net_points", label: "Net", type: "points" },
      { key: "rewards_issued", label: "Rewards issued", type: "int" },
    ],
    summary: [
      { key: "earned", label: "Earned", type: "points" },
      { key: "redeemed", label: "Redeemed", type: "points" },
      { key: "net_points", label: "Net movement", type: "points" },
      { key: "outstanding_points", label: "Outstanding now", type: "points" },
      { key: "accounts_with_points", label: "Customers with points", type: "int" },
    ],
    grain: { choose: true },
    dates: true,
    outlet: false,
    search: null,
    bar: null,
  },
];

export const REPORT_SLUGS = REPORTS.map((r) => r.slug);

export function findReport(slug: string): ReportDefinition | null {
  return REPORTS.find((r) => r.slug === slug) ?? null;
}

export function reportsInGroup(group: ReportGroup): ReportDefinition[] {
  return REPORTS.filter((r) => r.group === group);
}
