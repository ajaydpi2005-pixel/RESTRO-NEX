# RestroNex — Phase 8: POS + Order Management

The POS is the beating heart of RestroNex. It takes real orders against the
universal menu (Phase 7), re-prices everything **server-side**, and moves
them through a guarded state machine. There is no fake checkout and no
client-trusted pricing anywhere.

> **Payment is intentionally NOT collected in this phase.** Orders can be
> created, held, placed, prepared and readied, but they stay `unpaid` and
> cannot be completed until a payment is recorded. Payment collection ships
> in **Phase 10** behind a clearly labelled abstraction
> (`src/modules/orders/payment-recording.ts`).

## Data model (migration `20261008180000_orders.sql`)

| Table | Purpose |
|---|---|
| `orders` | one row per order; money in **integer minor units**; status + payment_status |
| `order_items` | snapshot of each line (name, unit price, qty, modifiers total, line total) |
| `order_item_modifiers` | priced options actually chosen on each line |
| `order_status_history` | append-only audit trail of every transition |
| `business_order_counters` | per-business monotonic `order_seq` → human `order_number` |

Key constraints:
- `(business_id, client_ref)` **unique** → the idempotency key that prevents
  duplicate orders on double-submit / retry.
- `(business_id, outlet_id, order_number)` unique → sequential per-outlet
  numbers starting at 1001.
- All money columns are `bigint` minor units with `>= 0` checks; discounts
  and charges are range-capped.

### Server-side pricing — clients never send prices

Every create/amend goes through **SECURITY DEFINER** RPCs that re-resolve all
prices from the menu tables. Clients send **ids + quantities only**.

- `pos_effective_tax_pct(business, product)` — product `tax_rate_pct` if set,
  else the sum of the business's enabled **EXCLUSIVE** tax rates. Inclusive
  rates never stack into totals.
- `pos_persist_items(...)` — validates availability (base **and** outlet
  override), variant membership, modifier-group membership, resolves variant /
  outlet-override prices, writes items + modifier rows, returns the subtotal.
- `pos_apply_totals(...)` — pro-rata discount allocation across lines,
  exclusive tax on the post-discount net, charge validation, writes totals.
- `create_pos_order(actor, payload)` / `amend_pos_order(actor, order, payload)`
  — one **transactional** unit: outlet + membership gate, idempotency return,
  counter bump, item persistence, totals, history row.
- `transition_order_status(actor, order, to, note)` — enforced transition map.

The pure mirror `src/modules/orders/pricing.ts` (`computeOrderTotals`)
reproduces the exact formula so the POS can show live totals; the DB remains
the source of truth and is asserted to match.

## Order states

```
open → held ↔ open → placed → preparing → ready → completed
open / held / placed / preparing → cancelled
```

- `ready → completed` additionally requires `paid_minor >= total_minor`
  (blocked until Phase 10 records a payment).
- `completed` and `cancelled` are terminal.
- Only `open`/`held` orders can be amended.

The map lives once in `src/modules/orders/state.ts` and is re-enforced in the
`transition_order_status` RPC, so the UI and the database can never disagree.

## Surfaces

- **POS terminal** `/pos` — fast, touch-friendly: search, category chips,
  product/combo grid, item configurator (variants, modifier groups with
  min/max + per-option quantity), cart steppers, dine-in/takeaway/delivery,
  table picker, customer + delivery fields, discounts, charges, live totals,
  **Hold / Place**, held-order strip for **resume**.
- **Orders** `/orders` — active/completed/cancelled tabs + outlet filter.
- **Order detail** `/orders/[id]` — items, modifiers, totals breakdown,
  customer, status history, and state-machine controls (including cancel with
  a reason).

Business/outlet scoping: the POS only lists outlets the actor is granted
(`membership_outlets`; owners/admins implicit). Every action re-authorises
server-side (`orders.manage`, plus `discounts.apply` for discounts).

## Security model

- Actor comes from the **session**, never from input; `businessId` is a
  selector re-verified against membership + RBAC.
- All six order RPCs are **service_role-only** (`REVOKE ... FROM public, anon,
  authenticated`; explicit `GRANT EXECUTE ... TO service_role`).
- Order tables expose **SELECT-only** RLS policies (`has_business_access`);
  zero INSERT/UPDATE/DELETE policies. `business_order_counters` has none.
- Cross-tenant products/modifiers, unavailable items, wrong-business tables
  and non-member actors are all rejected **inside** the RPCs, and rejected
  creates roll back completely (transactional).

## Testing

- Unit (`src/modules/orders/orders.test.ts`) — totals mirror (discounts,
  pro-rata tax, charge stacking, empty order), full state machine, and the
  Zod POS payload schema (dine-in/delivery requirements, ranges, limits).
- Local DB (`npm run db:verify`, `assertions-phase8.sql`) — RLS + service-role
  gates, exact repriced totals, idempotency, input guards, rollback, lifecycle
  + payment gate, amend recompute, sequential numbering, tenant isolation.
- Hosted E2E (`npm run test:pos:e2e`, `scripts/live-pos-lifecycle.mjs`) —
  full order lifecycle against the real RPCs + RLS reads + `/pos` `/orders`
  HTTP surface. Requires migrations through `20261008180000` pushed and the
  app running.

## Phase 10 seam

`src/modules/orders/payment-recording.ts` is the single place that may ever set
`orders.paid_minor` / `payment_status`. It currently **throws** if called so
nothing can silently fake a payment; `PAYMENT_COLLECTION_AVAILABLE = false`
keeps the `Complete` control honest in the UI.
