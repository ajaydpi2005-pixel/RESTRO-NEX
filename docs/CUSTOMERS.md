# Phase 15 — Customers, loyalty and promotions

Local verification only. Hosted push is pending the user's review and token.

## What it does

- **Customer profiles** (`/customers`, `/customers/[id]`): name, phone, email, notes, saved addresses, order history, net spend, last order, favourite products, and a segment label.
- **Automatic linking.** Saving an order with a phone links it to the customer with the same last-10-digit key. If none exists, one is created (name from the order, or `Customer ` + last four digits). Phones are unique per business, not globally.
- **Segments** (`segments.ts`, pure, computed on read): `vip`, `regular`, `new`, `occasional`, `at_risk` (61–180 days since last order), `lapsed` (over 180 days), `no_orders`. Recency is checked first. Thresholds are constants in `SEGMENT_THRESHOLDS`.
- **Loyalty** (`/customers/loyalty`): off by default. When on, a customer earns `floor(net spend ÷ rate)` points on each order that completes, once per order. Net spend is the total after discounts and refunds. The default rate is ₹100 per point.
- **Points ledger.** Every change is a row in `loyalty_transactions`, which is append-only. The balance is held on `loyalty_accounts` and is non-negative. A trigger sets `balance_after` and rejects a change that would overdraw, before the row is written.
- **Refunds.** A full refund reverses the points that order earned, capped at the balance.
- **Rewards.** A reward costs points and issues a single-use voucher, which is applied to an open order. Redemption is idempotent through `client_ref`.
- **Coupons.** A code is typed on an open order. Rules include validity dates, minimum bill, maximum discount, total uses, and uses per customer. Codes are stored in upper case.
- **Promotions on orders** (`orders/[id]`). One coupon or reward per order, recorded in `order_promotions`. `pos_apply_totals` recomputes the discount on every save from the snapshotted rule, and writes `orders.promotion_minor`. `discount_minor` is manual discount plus promotion.
- **Lifecycle.** A coupon and voucher are consumed when the order completes. They are released when the order is cancelled (the voucher returns to `issued`). Promotions can change only while the order is open or held, unpaid and not billed.

## Permissions

| Action | Permission and roles that hold it |
| --- | --- |
| View customers, loyalty and coupon lists | `customers.view`: owner, business admin, outlet manager, cashier, waiter, accountant |
| Create or edit customers, addresses, loyalty settings, rewards, coupons, manual point adjustments | `customers.manage`: owner, business admin, outlet manager |
| Issue a reward, redeem points | `discounts.apply`: owner, business admin, outlet manager, cashier |
| Apply or remove a coupon or reward on an order | `orders.manage` (outlet) and `discounts.apply`: owner, business admin, outlet manager, cashier |

Kitchen staff hold no customer or discount permission. Waiters can view customers but cannot apply discounts, so they cannot apply coupons or rewards. Customers are business-level and shared across outlets. RLS hides customers and coupons from other businesses and from kitchen users.

## Design notes

- Money is in paise throughout. Forms take rupees and convert them in `schemas.ts`.
- The phone key matches `public.customer_phone_key` in the database. Keep `phone.ts` and the SQL function in step.
- The phone column carries only a length check. Order phones can hold any text, and a stricter check would make order saves fail. The format is enforced in `customer_save`.
- Large reads page through rows, because Supabase returns at most 1,000 rows per request.

## Verification

- `scripts/local-pg/assertions-phase15.sql`, P15.0 to P15.10, through `scripts/verify-db.sh` (202 OK notices, exit 0).
- Unit tests: `src/modules/customers/customers.test.ts` (phone key, segments) and `schemas.test.ts` (conversions, refusals).
- tsc, eslint, vitest (273 of 273) and `next build` pass.

## Known limitations

- **No live customer lookup on the POS terminal.** Linking happens on save, by phone. Promotions and the customer panel live on `orders/[id]`.
- **Customer list aggregates in memory.** It reads all of a business's completed customer orders. This is fine for a single restaurant. It will need a summary table or a view for large businesses.
- **Spent points are not clawed back on refund.** A refund reverses only the points still available, up to the balance.
- **Coupon usage is not restored on refund.** A refunded coupon order keeps its use count.
- **Business deletion is blocked while ledger rows exist.** This protects the append-only ledger.
- **No browser test.** The pages are type-checked and built, but were not clicked through in a browser.
- **Feedback is out of scope.** `customer_feedback` is not in the Phase 15 bullets.
- **Reports and analytics are Phase 16.** New vs returning and loyalty analytics are not built here.
