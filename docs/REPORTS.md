# Reports and analytics (Phase 16)

Phase 16 adds 24 reports across five groups, read directly from the ledger. Every figure
comes from a database function (`supabase/migrations/20261014100000_reports.sql`). The
pages and exports only format what those functions return.

## Where things live

| Layer | Path |
| --- | --- |
| Database functions | `supabase/migrations/20261014100000_reports.sql` (21 `report_*` functions) |
| Assertions | `scripts/local-pg/assertions-phase16.sql` (P16.0 to P16.11), run by `scripts/verify-db.sh` |
| Report catalogue | `src/modules/reports/registry.ts` (slug, columns, summary, basis, permission) |
| Filters | `src/modules/reports/schemas.ts` |
| Formatting | `src/modules/reports/format.ts` |
| Exports | `src/modules/reports/csv.ts`, `xlsx.ts`, `pdf.ts` |
| Data access | `src/modules/reports/queries.ts` (the only caller of the RPCs) |
| Pages | `src/app/(app)/reports/page.tsx` (hub), `src/app/(app)/reports/[report]/page.tsx` |
| Export route | `src/app/api/reports/export/route.ts` |

## Permissions

- Every report needs `reports.view`: owner, business admin, outlet manager, accountant.
- Inventory reports (consumption, purchases, wastage, food cost, stock) also need `inventory.view`.
- Staff reports (orders, discounts, refunds, cashier activity) also need `staff.view`. Accountants do not have it.
- Customer reports (new, returning, spending, loyalty) also need `customers.view`.

The actor is always the signed-in user, read on the server. The database checks the
permission and outlet access again, so a report cannot show more than the viewer may see.
Kitchen staff do not gain any financial permission from this phase.

## Filters

- Date range: default is the last 30 days in Asia/Kolkata. The range is capped at 400 days.
- Outlet: "All outlets" or one outlet the viewer can access. Loyalty is business-wide, so it has no outlet filter.
- Group by (day, week or month): only on period reports.
- Search: on the 16 list reports (outlets, products, categories, refunds, payment methods, ingredients, wastage reasons, staff, customers). Period reports and loyalty have no search.
- Paging: 25 rows per page. Summary cards cover all matching rows, not the page.

## Metric definitions

**Sales and revenue.** Only completed orders count. A completed order is bucketed by the day
it was completed, in Asia/Kolkata, using `order_status_history` where `to_status = 'completed'`.

- Gross sales = order subtotal before discounts.
- Discounts = manual plus promotion discounts on those orders.
- Net sales = gross − discounts.
- Tax = tax on those orders. Billed = net sales + tax + charges.
- Refunds are counted on the day they were recorded (cash basis), not the day of the order.
- Net revenue = billed − refunds recorded in the period.

**Tax.** Tax billed is on completed orders. Tax refunded is pro-rated per refund:
`round(refund × order tax ÷ order total)`. Net tax = billed − refunded.

**Discounts.** Shown as manual and promotion, with the percentage of gross.
Discounts are attributed to the order's creator (`orders.created_by`). See limitations.

**Refunds and payments.** Recorded on the day they were recorded (cash basis). Payments are
grouped by method. Collected, refunded and net are reported per method.

**Food cost.** Theoretical: recipe consumption cost of completed orders ÷ net sales
(subtotal − discount, excluding tax). Wastage is shown beside it, as its own percentage.

**Inventory.**

- Consumption, wastage and stock movements use the ledger `created_at`.
- Purchases use `goods_receipts.received_on`.
- Stock is point-in-time: on hand, minimum, value, below-minimum, and whether batches match on hand.

**Staff.**

- Orders: opened, completed, cancelled, still open, by `orders.created_by`.
- Discounts: attributed to the order's creator.
- Refunds: by `refunds.created_by`.
- Cashier activity: `payments.created_by`, `refunds.created_by`, and `order_status_history.changed_by`.

**Customers.**

- New: the customer's first-ever completed order falls in the window.
- Returning: the customer has a completed order before the window.
- Spending: net spend (billed − refunds) in the window, ranked.
- Loyalty: points earned, redeemed, reversed and adjusted, plus outstanding points. Business-wide.

## Export

- CSV: UTF-8 with a byte-order mark, so Excel opens it as UTF-8. Money is plain rupees to two decimals with no symbol.
- Excel: real numbers with number formats, so totals can be summed in the sheet. Frozen header row.
- PDF: standard fonts, so money reads "Rs." (the standard fonts have no ₹). Landscape for reports with more than five columns. Header row repeats on each page.
- Text cells starting with `=`, `+`, `-`, `@`, or a tab or carriage return are prefixed with an apostrophe in CSV. This also affects phone numbers that start with `+`. That is deliberate, because a spreadsheet would otherwise evaluate them as formulas.
- Exports are capped at 20,000 rows. Above that the route returns 413 and asks for a narrower filter. It never sends a partial file.
- Responses are `Cache-Control: no-store`. Filenames: `restronex-<report>-<from>-<to>.<ext>`.

## Limitations

- **Discount attribution.** The database stores no separate discount author. A discount typed by someone other than the order's creator is attributed to the creator. This is shown on the page.
- **Completions without history.** Phase 15 test fixtures complete orders with a direct status update, which writes no history row. Reports do not count such orders in sales, because they have no completion day. The Phase 16 assertions report this as INFO (P16.11). The app's own transition path always writes the row.
- **Stock drift.** Phase 13 test data has stock that does not match batches (Oil and Patty in the fixtures). The stock report flags these with a batch-mismatch count. It does not hide them.
- **Customer loyalty points** already spent are not clawed back on refund (Phase 15 limitation). Loyalty report shows the ledger as it is.
- **Browser check.** The pages were built and type-checked, but not clicked through in a browser with a live Supabase session.

## Verification

- `scripts/verify-db.sh`: exit 0, 213 OK (P15.0 to P15.10 and P16.0 to P16.10, with P16.11 INFO).
  - P16.2 day, week and month sales reconcile.
  - P16.3 revenue nets refunds.
  - P16.4 tax billed 750, refunded 500.
  - P16.5 discounts 12000 (manual 3000, promotion 9000).
  - P16.6 collections 312250, refunds 75500.
  - P16.7 outlet, product and category reconcile to sales.
  - P16.8 consumption 10260, purchases 102000, wastage 425, food cost 4.09%.
  - P16.9 staff and cashier totals reconcile to raw rows.
  - P16.10 customer and loyalty totals reconcile to raw rows.
- Unit tests: `src/modules/reports/reports.test.ts` (38 tests). They cover the registry (24 reports, 21 RPCs that exist in the migration, and column keys that appear in the SQL), filter rules, formatting, CSV escaping, an Excel round trip, and PDF layout.
- Real-data export check: all 24 reports were run against the fixture database and exported to CSV, Excel and PDF. The Excel files read back, and a sampled PDF was rendered and checked.
