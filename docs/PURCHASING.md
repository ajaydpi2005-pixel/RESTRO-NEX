# Phase 14 — Purchasing and Suppliers

Suppliers, purchase orders, goods receiving, supplier invoices, supplier payments,
purchase history, supplier balances, purchase reports, and reconciliation against the
inventory ledger. Receiving stock creates inventory movements; nothing else changes stock.

Pages: `/purchasing` (overview), `/purchasing/suppliers` and `/purchasing/suppliers/[id]`
(directory, balance, ageing, history, payments), `/purchasing/orders`,
`/purchasing/orders/new`, `/purchasing/orders/[id]` (send, cancel, receive, receipts),
`/purchasing/orders/[id]/edit` (drafts only), `/purchasing/invoices` (bill received stock),
`/purchasing/reports` (spend, price variance, payables ageing, reconciliation).

Spec: `docs/MASTER_SPEC.md` §23 (Purchasing). Migration:
`supabase/migrations/20261012100000_purchasing.sql`. Assertions: `scripts/local-pg/assertions-phase14.sql` (P14.0 to P14.9).

## Decisions

These are the rules the database and tests enforce.

| Topic | Decision |
| --- | --- |
| Receiving needs an order | A goods receipt must reference a purchase order. There are no direct receipts. |
| Over-receipt | Refused. A line cannot receive more than is outstanding on the order. |
| Expired batches | Refused at receipt. Expiry must not be before the receipt date (the ledger rule). |
| Ledger value | Each receipt line creates one `receipt` movement at the order cost, with reference `grn:<receipt line id>`. |
| Order status | `draft` → `sent` → `partially_received` → `received`. Cancel is allowed from `draft` or `sent` with no stock received. |
| Editing | Only drafts can change. A sent order is cancelled and re-ordered instead. |
| Invoices bill received quantity | An invoice can bill only received lines, at the received quantity. Ordered-but-not-received stock cannot be billed. |
| One bill per receipt line | A receipt line can be billed once. A second bill for the same line is refused. |
| One supplier per invoice | Every billed line must belong to the invoice's supplier and outlet. |
| Invoice totals | Computed from lines on the server. Tax is entered in rupees and stored in paise. Totals are stored on the header at insert and never change. |
| Duplicate invoice numbers | Refused per supplier, ignoring case and surrounding spaces. |
| Price variance | Billed unit cost may differ from the order. The variance is shown and reported, not blocked. |
| Payments | On account, not allocated to specific invoices. Payments are applied oldest-invoice-first (FIFO) only when ageing is computed. |
| Overpayment | Refused. A payment cannot exceed the balance owed. |
| Immutability | Posted receipts, receipt lines, invoices, invoice lines, and payments refuse update and delete. |
| Idempotency | Receipts, invoices, and payments take a client reference. A retry returns the first record and books nothing new. |
| Who manages purchasing | `purchasing.manage`: owner, business admin, and inventory manager. Kitchen, waiter, cashier, and outlet manager have no purchasing access. |
| Who sees purchasing | `purchasing.view`, outlet-scoped for orders, receipts, and invoices. Suppliers, balances, and payments are business-level. |
| Supplier scope | Supplier records and payments are business-level. Any role with `purchasing.manage` can change them, regardless of outlet grant. This matches the role check used by the RPCs. |
| Money | Forms take rupees. Stored as whole paise. Unit costs keep four decimals, the same as inventory. |
| Reports and ageing | Computed in the app from stored rows. Reconciliation runs in the database. |

## Data model

| Table | Purpose |
| --- | --- |
| `business_sequences` | Per-business numbering for purchase orders and receipts. |
| `suppliers` | Name (unique per business, case-insensitive), contact, GSTIN (15 characters), payment terms, status. |
| `purchase_orders`, `purchase_order_items` | Order header and lines. Lines store the unit, quantity, the base quantity, and the unit cost. The subtotal is stored on the header. |
| `goods_receipts`, `goods_receipt_items` | Receipts and lines. Lines carry the batch code and expiry. Totals are computed from lines. |
| `purchase_invoices`, `purchase_invoice_items` | Supplier invoices with subtotal, tax, and total. Invoice lines point at one receipt line each. |
| `supplier_payments` | Payments on account, with method, date, and reference. |

RPCs (service role only, each checks the actor):
`supplier_save`, `purchase_order_save`, `purchase_order_send`, `purchase_order_cancel`,
`goods_receipt_post`, `purchase_invoice_post`, `supplier_payment_record`, `purchasing_reconcile`.

Receipt posting calls `inventory_book_receipt` (internal). It uses the same batch
allocation and ledger rules as the inventory `receive` action, so a purchase receipt and a
manual receipt behave the same way.

## App layer

- `src/modules/purchasing/money.ts`: rupee and paise conversion, price variance.
- `src/modules/purchasing/aging.ts`: pure payables ageing (FIFO, buckets, advance credit).
- `src/modules/purchasing/reports.ts`: pure spend by supplier, price variance, fulfilment.
- `src/modules/purchasing/schemas.ts`: zod input schemas for every form.
- `src/modules/purchasing/actions.ts`: server actions. Each checks the session and
  `purchasing.manage` (business-level for suppliers and payments, outlet-level for orders,
  receipts, and invoices), then calls one RPC. The outlet id from the form is a convenience;
  the RPC takes the outlet from the order or receipt and checks it again.
- `src/modules/purchasing/queries.ts`: read loaders. They use the service client, so every
  query filters by business and, where it applies, by outlet.
- `src/modules/purchasing/purchasing.test.ts`: 16 unit tests for ageing, reports, money,
  and schema rules.

## Verification

Run `scripts/verify-db.sh` (exit 0, 191 OK at the time of this phase). Phase 14 adds ten
notices, P14.0 to P14.9:

- P14.0: fixtures (three ingredients, two suppliers).
- P14.1: supplier records need `purchasing.manage`; duplicate names and bad GSTINs are refused.
- P14.2: orders are outlet-scoped, validated (one line per ingredient, unit family, positive
  quantity), editable only as drafts, sent once, and cancellable while unreceived.
- P14.3: GRN1 books three receipts worth 48,000 and updates stock. Over-receipt, expired
  batches, foreign lines, and waiter or branch-manager receipts are refused. A retry is
  idempotent. A partly received order cannot be cancelled.
- P14.4: GRN2 closes the order. The ledger value of all receipts equals the order subtotal
  (62,000). A closed order refuses further receipts.
- P14.5: invoices bill each receipt line once, from one supplier and outlet. Invoice 1 is
  50,000 plus 2,500 tax. Invoice 2 is 14,000. Duplicate numbers and bad due dates are refused.
- P14.6: payments are capped at the balance (66,500 owed), idempotent, and close to zero.
- P14.7: posted receipts, receipt lines, invoices, and payments refuse update and delete.
- P14.8: waiter and kitchen see no purchasing data; managers are outlet-scoped; direct table
  inserts are refused.
- P14.9: all six `purchasing_reconcile` checks agree with the ledger. The test deliberately
  alters a receipt line behind the ledger's back, confirms the value check fails, then
  restores the line and confirms the checks pass again.

Also run at the time of this phase: vitest 251 passed (21 files), `tsc --noEmit` clean,
eslint clean on the changed files, and `next build` passed with all nine purchasing routes.

Worked numbers for the fixtures:

| Item | Amount (paise) |
| --- | --- |
| Order subtotal (Tomato 5 kg at 4,000/kg, Flour 10 kg at 3,000/kg, Cups 2 dozen at 6,000/dozen) | 62,000 |
| GRN1 (Tomato 3 kg, Flour 10 kg, Cups 1 dozen) | 48,000 |
| GRN2 (Tomato 2 kg, Cups 1 dozen) | 14,000 |
| Invoice 1 (Flour billed at 3,200/kg, +2,000 variance), with 2,500 tax | 52,500 |
| Invoice 2 | 14,000 |
| Payments | 20,000 then 46,500 |

## Limitations

- Payments are on account. They are not matched to a specific invoice, so a payment can
  clear an invoice that the payer meant to hold back. Allocation to invoices is not built.
- Ageing is FIFO by invoice date. It is a view, not a stored ledger.
- Tax is entered per invoice as a single amount. Per-line tax and GST split (CGST/SGST/IGST)
  are not modelled.
- Orders carry no tax or freight. The order subtotal is pre-tax.
- Over-receipt is refused, not allowed with a variance approval. A short delivery leaves the
  line open until the rest arrives or the order is cancelled, but a partly received order
  cannot be cancelled.
- Supplier invoices and receipts cannot be corrected once posted. A mistake needs a
  reversing step, which is not built. Payments have the same limit.
- Supplier management is business-wide for any role with `purchasing.manage`, including a
  branch-only inventory manager. This matches the role check. Revisit if suppliers should be
  outlet-scoped.
- The UI was checked by type check, lint, unit tests, and build. It was not exercised in a
  browser against a running session in this phase.
- Reconciliation compares stored receipt values with the ledger. A superuser who disables the
  immutability triggers and rewrites both sides consistently would not be caught. The P14.9
  detector test shows the check fails when only one side is altered.
- No notifications. Overdue invoices appear on the reports and supplier pages only.
- Hosted push is not part of this phase.
