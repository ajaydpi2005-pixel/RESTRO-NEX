# Kitchen Display System (Phase 11)

Route: `/kitchen` (live board) · `/kitchen/routing` (stations and routing, `kitchen.manage`).
Migration: `supabase/migrations/20261009150000_kitchen_display.sql`.
Follow-up: `supabase/migrations/20261009160000_payments_rls_scope.sql` scopes Phase 10 money reads (see Open items).

## What the kitchen sees

Orders come from the POS. When the POS sends an order (`open` or `held` → `placed`), each item
enters the kitchen as **New** on the station it routes to. The board shows one ticket per
order and station. A ticket sits in the column of its least-advanced item.

| Item status | Meaning | Board action |
| --- | --- | --- |
| `pending` | In an open order, not yet sent | not shown |
| `new` | Sent, not started | Accept |
| `accepted` | Kitchen has taken it | Start |
| `preparing` | Being cooked | Ready |
| `ready` | Ready to serve | Done |
| `completed` | Done. Leaves the board | — |
| `cancelled` | Order cancelled. Leaves the board and raises a notification | — |

Kitchen progress moves the order status along the allowed transitions only (Phase 12, `20261009170000_waiter_ordering.sql`, `kitchen_sync_order_status`):

- the first item accepted or cooking moves a `placed` order to `preparing`;
- when every live item is `ready` or `completed`, the order moves to `ready`.

The KDS never completes, cancels, or edits money on an order. Completion is blocked while any item is still `new`, `accepted` or `preparing` (`transition_order_status`), so a late round cannot be cleared off the board by a cashier. Each automatic step writes a history row with the note *Kitchen progress*.

## Routing

Resolved when the item is sent, in this order:

1. item route (`kitchen_routes.target_type = 'item'`)
2. category route (`'category'`)
3. **Unrouted**: an explicit lane on the board, so nothing is lost

Combos use their own route. Routes are per outlet. Stations are never deleted: removing one
deactivates it, so in-flight tickets keep their station and new items fall back to Unrouted.
Changing a route affects only items sent after the change.

## Permissions

| Permission | Who | Used for |
| --- | --- | --- |
| `kitchen.view` | kitchen staff, managers, owner, admin | read the board |
| `kitchen.operate` | kitchen staff, managers, owner, admin | move items, priority, acknowledge |
| `kitchen.manage` | outlet manager, admin, owner | stations and routing |

Kitchen staff hold no billing, refund, discount, settings or subscription permission. The
matrix is pinned in `rbac.test.ts` and `scripts/local-pg/assertions-phase11.sql` (P11.2).

Kitchen staff still hold `orders.view` and `menu.view` from Phase 5, which they had before
this phase. See *Open items* below.

## Data model: money stays out

- `kitchen_items` is a projection of active and recently finished kitchen work. It has no
  price, tax, total or payment column. Kitchen clients can read it, but cannot write it.
- `kitchen_events` records cancellations and removals for the notification and sound.
- `order_items` gains `station_id`, `kitchen_status`, `kitchen_status_at` and `kitchen_sent_at`.
- Triggers keep the projection in step with every POS write: insert, amend, merge, split,
  send, cancel, complete, priority and table moves. Application code never writes the
  projection.
- Kitchen RPCs (`kds_advance_item`, `kds_advance_ticket`, `kds_set_priority`,
  `kds_acknowledge_event`, `kitchen_save_stations`, `kitchen_save_routes`) are service-role
  only. Each re-checks membership and the outlet grant via `require_outlet_permission`. None
  touches `orders` money, `order_items` prices or any payment table (P11.6).

## Realtime

- The board subscribes with the signed-in browser client to `kitchen_items` and
  `kitchen_events`, filtered by outlet. RLS decides what each screen may receive.
- Finished work leaves the board by an **UPDATE** to a terminal status, not a DELETE, so
  delete payloads are never needed in normal flow.
- Replica identity stays **DEFAULT**. `FULL` would put full rows into delete payloads, which
  are not row-filtered. With DEFAULT a delete carries only the id.
- On every (re)connect, and every 30 seconds, the board reloads a full snapshot, so anything
  missed while offline is healed. A failed write also reloads the snapshot, so the screen
  never shows a state the server rejected.
- Orders and order items are now outlet-scoped under RLS (`has_outlet_access`). Before this
  phase, any business member could read every outlet's orders with their own session.

## Screen

- Touch targets are at least 48px. Actions are on the screen, not hover-only.
- Timers: order age runs from the earliest send; item age runs from the last status change.
  Amber at 8 minutes, red at 15. Timers render only after hydration.
- Sound: Web Audio, unlocked by an explicit "Enable sound" tap (browsers block audio before a
  gesture). New tickets and cancellations each have a distinct tone.
- Full screen: the Fullscreen API on the board.
- Cancelled items show a red banner until a cook acknowledges it.

## Verification

| Check | Command | Result |
| --- | --- | --- |
| Migration on a clean cluster, all phases | `npm run db:verify` | exit 0, 150 OK checks; Phase 11 = P11.0–P11.15 |
| Unit tests (board logic, timers, schemas, RBAC) | `npm test` | all passing |
| Types, lint, build | `npx tsc --noEmit`, `npm run lint`, `npm run build` | clean |
| Live realtime, RLS and HTTP against hosted | `npm run test:kitchen:e2e` (app on :3000) | **pending** hosted push |

The live script needs the migration on the hosted project. It signs in as real kitchen users,
sends a POS order, and asserts that the kitchen session receives it within 5 seconds. It then
checks that accept, ticket bump, priority, cancellation and acknowledgement all arrive live.
It also checks that another outlet's staff, even with a forged filter, receive nothing.

## Open items

- **Hosted push**: the migration has not been applied to the hosted project yet.
- **Retention**: finished rows (`completed`, `cancelled`) accumulate in `kitchen_items`, one per
  item sent. A scheduled prune of rows older than a few days is not built yet.
- **Payments RLS (Phase 10): fixed** in `20261009160000_payments_rls_scope.sql`. `payments`,
  `receipts`, `invoices` need `billing.view`, `refunds` needs `refunds.view`, both scoped to the
  outlet (business-scoped roles such as accountant read across outlets). `payment_methods` needs
  `billing.view` at business level. Kitchen staff read none of these. Asserted by P11.16.
- **Kitchen staff and `orders.view`**: kept on purpose. The owner chose to keep it, so kitchen
  staff can see order totals. Revisit this if the business wants totals hidden from the kitchen.
