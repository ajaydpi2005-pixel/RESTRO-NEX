# Waiter / Captain ordering (Phase 12)

A touch-first app at `/waiter` for taking table orders. It writes to the same orders the POS and the kitchen display use, so an order taken on the floor is the order the cashier bills and the kitchen cooks.

## Flow

1. **Tables** (`/waiter`): pick an outlet (if the waiter has more than one), then tap a table. Tiles show free, occupied, bill requested, and items ready to serve. The screen refreshes every 8 seconds, and the device vibrates when new items are ready.
2. **New order** (`/waiter/table/[id]`): add products and combos from the category tabs. Products with sizes or options open a sheet that enforces the menu's rules (required groups, maximum choices, sizes). Set quantity and a note per line, and an order note. The draft stays on the device until it is sent.
3. **Send to kitchen**: one atomic call creates the order (or sends the draft) and places it. Each line is routed to its kitchen station and appears on the KDS.
4. **Sent order**: the screen lists every line with its kitchen status (Sent, Accepted, Cooking, Ready, Served, Cancelled). A ready item shows at the top of the table and on the floor tile. The screen refreshes every 4 seconds.
5. **Another round**: add items to a sent order. Only the new lines are sent. Lines already in the kitchen are never rewritten.
6. **Request bill**: stamps the order with `bill_requested_at` and writes an audit entry. The cashier sees *Bill requested* on the floor tile. Repeated taps keep the first time.

## Permissions

- Access needs `orders.manage` for the outlet. The `waiter` role has it. Kitchen staff do not.
- Waiters **cannot** apply a discount or a charge. The payload schema is strict, so a `discount` or `charges` key is refused before the database is reached. The database refuses them again.
- Waiters **cannot** take payment, refund, complete, or cancel an order. Those stay with the cashier and manager roles.
- Waiters **cannot** read the kitchen board (`kitchen.view`). They hold `billing.view` from the existing role matrix, which lets them read payments and totals, but not change them.
- Outlet isolation holds: a waiter with a branch grant cannot submit or read main-outlet orders. Asserted by P12.1 and P12.11.

## Database (`supabase/migrations/20261009170000_waiter_ordering.sql`)

| Object | Purpose |
|---|---|
| `waiter_submit_order(actor, payload, send)` | Create, amend a draft, or append a round. Idempotent on `client_ref`. Preserves the cashier's discount and charges. Optionally sends. |
| `waiter_request_bill(actor, order)` | Stamps the bill request. Sent orders only. Idempotent. Audited. |
| `order_submissions` | Ledger of waiter writes by `client_ref`. Service-role only. |
| `orders.bill_requested_at`, `bill_requested_by` | The bill request marker. |
| `pos_persist_items(..., p_append)` | Adds an append mode that keeps sent lines and continues the position sequence. Default behaviour is unchanged. |
| `kitchen_sync_order_status` | Moves a sent order to `preparing` and then `ready` as its items progress. |
| `transition_order_status` | Adds the rule: completion is blocked while kitchen items are `new`, `accepted`, or `preparing`. |
| `pos_persist_items` (modifier rules) | Enforces each group's minimum and maximum options on every order, POS included. This closes a gap where the server accepted a missing required option. |

Both waiter RPCs are service-role only. Each re-checks membership and `orders.manage` for the outlet inside the database. Prices are never accepted from the client; the server re-prices every line.

### Why an order's money is preserved on waiter edits

`amend_pos_order` resets the discount and charges to whatever the payload sends. A waiter edit therefore reads the stored discount and charges under the order's row lock and passes them back unchanged. The cashier's discount survives a waiter edit. Asserted by P12.5.

### Order status and the kitchen

Phase 11 had the POS own the order status, with the KDS moving items only. That made a sent order unable to reach `ready` or `completed` without manual clicks. Phase 12 changes it: kitchen progress moves the order along the allowed transitions, and completion waits for the kitchen to finish. The KDS still never completes, cancels, or touches money. See `docs/KDS.md`.

## Code

- `src/modules/waiter/cart.ts`: draft lines, selection rules, estimates, payload building, draft storage (pure, tested).
- `src/modules/waiter/schemas.ts`: strict submission schema and the snake_case mapping for the RPC.
- `src/modules/waiter/actions.ts`: `submitWaiterOrderAction`, `requestBillAction`. Each re-checks the session and `orders.manage`.
- `src/modules/waiter/queries.ts`, `context.ts`: read models and business/outlet resolution.
- `src/modules/waiter/components/`: floor, table screen, product sheet, live-status hooks, draft hook.
- `src/app/waiter/`: layout (session guard, outside the desktop shell), floor page, table page. `/waiter` is in the proxy's protected prefixes.

## Verification

- `scripts/local-pg/assertions-phase12.sql` (P12.0–P12.11, plus P12.1b for modifier rules), wired into `scripts/verify-db.sh`. It covers the full Waiter → POS → KDS path with real RPCs: validation, outlet isolation, send, idempotent retry, appended round, cashier discount preserved, bill request, kitchen progress to `ready`, completion guard, payment and completion by the cashier, closed-order refusal, and the waiter's money and kitchen boundaries.
- `src/modules/waiter/waiter.test.ts`: cart rules, estimates, payload shape, strict schema, draft storage, status mapping.
- `tsc`, `eslint`, `vitest`, and `next build` pass.

## Limitations and decisions to review

- **Drafts are device-local.** An unsent cart lives in this device's localStorage. Another waiter's device does not see it, and a table with only a draft shows as free. The order is created when it is first sent.
- **POS drafts are read-only for waiters.** An order a cashier opened in the POS shows as open and cannot be edited on the waiter screen. The cashier finishes it at the POS.
- **No cancel, void, or hold for waiters.** Cancelling after sending needs a manager. Dropping an unsent draft is done by discarding the device cart.
- **Polling, not realtime.** The waiter screens refresh on an interval. Realtime is not used here because the waiter has no `kitchen.view`. Item progress is read through `orders` and `order_items`, which the waiter can already see.
- **Sounds are not included.** Only a vibration alert is used on the waiter screens.
- **Browser and hosted run are pending.** Sign-in needs the hosted auth project, so the waiter UI has not been exercised in a browser against live auth. The database path is verified locally. The hosted run is blocked on the same push token as Phase 11.
- **`billing.view` for waiters is retained** from the existing role matrix. It is read-only. Remove it from the `waiter` role if waiters should not see totals.
- **Modifier rules now apply everywhere.** Existing menus whose groups require an option will refuse orders that omit it. This is intended, but check menus with required groups before deploying.
