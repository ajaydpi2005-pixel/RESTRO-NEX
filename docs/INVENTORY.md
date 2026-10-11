# Phase 13 — Recipes and Inventory

Ingredients, recipes, stock by outlet, a traceable movement ledger, and food cost.
Consumption posts automatically when an order is **completed**.

Pages: `/inventory` (stock, alerts, food cost, receive / wastage / count, movements),
`/inventory/ingredients`, `/inventory/recipes` (recipes and theoretical margin),
`/inventory/transfers`.

Spec: `docs/MASTER_SPEC.md` §21 (Recipe Management) and §22 (Inventory).

## Decisions

These are the rules the code and tests enforce.

| Topic | Decision |
| --- | --- |
| When stock is consumed | On `completed` only. Open, held, and sent orders do not move stock. |
| Combos | A combo deducts the recipes of its component products, multiplied by the component quantity. |
| Recipe scope | Per product, not per variant. Modifiers have no recipe lines, so extra cheese is not deducted. |
| Negative stock on sales | Allowed. The shortfall is recorded as an unbatched consumption at the ingredient's standard cost. A sale never fails because of stock. |
| Negative stock on wastage and transfers | Refused. |
| Refunds | Do not restock. |
| Food cost | Actual, at batch cost, from the posting. Theoretical margin uses the standard `cost_per_unit`. |
| Who sees costs | `inventory.view`. Kitchen, waiter and cashier have no inventory access. |
| Who edits ingredients and stock | `inventory.manage`, per outlet for stock actions. |
| Who edits recipes | `menu.manage`. An inventory manager can read recipes and costs but cannot edit them. |
| Ledger | Append-only. Updates and deletes are refused. A business with movements cannot be deleted. |
| Alerts | Low stock, out of stock, and expiry are computed when the page loads. They are not stored. |

## Data model

Migration: `supabase/migrations/20261009180000_recipes_inventory.sql`.

| Object | Purpose |
| --- | --- |
| `units` | g, kg, ml, l, pc, dz with factors to the base unit. |
| `ingredients` | One base unit per ingredient (g, ml or pc), standard cost per base unit in minor currency units, min and max levels. |
| `inventory_stock` | Cached on-hand per outlet and ingredient. Maintained by the movement trigger. |
| `inventory_batches` | Receipts with batch code, cost, and expiry. `remaining_qty ≥ 0`. Expiry is not before receipt. |
| `inventory_movements` | Append-only ledger. Kinds: receipt, consumption, wastage, adjustment, transfer_out, transfer_in. Unique `(business_id, reference_key)`. |
| `stock_transfers`, `stock_transfer_items` | Transfer header and lines. |
| `stock_adjustments` | Counts with system quantity, counted quantity, delta, and reason. |
| `inventory_requests` | Idempotency for manual RPCs, keyed on `client_ref`. |
| `recipes`, `recipe_ingredients` | One recipe per menu product, with lines in base units. |
| `inventory_postings` | One row per completed order: ingredient count and food cost. The unique key prevents double posting. |

RPCs (service role only, each re-checks the actor's permission):
`inventory_receive`, `inventory_waste`, `inventory_adjust`, `inventory_transfer`,
`inventory_post_order`, `ingredient_save`, `recipe_save`, `inventory_reconcile`.
Trigger: `orders_inventory_post` (status → completed) calls `inventory_post_order`.

FEFO: allocation takes the earliest `expires_on` first (nulls last), then the oldest receipt.
Expired batches are skipped unless the call is wastage or a count, which dispose of them.
"Today" is the IST date (`Asia/Kolkata`) in every expiry check.

## Consumption on completion

1. The order status moves to `completed` (cashier action, Phase 8/12 rules).
2. `inventory_post_order` aggregates needs by ingredient across product lines and combo components.
3. For each ingredient it allocates FEFO from outlet batches. Any remainder is recorded as an unbatched consumption at standard cost.
4. It writes one posting row. A second completion or a manual re-run finds the posting and does nothing.

## Verification

`scripts/local-pg/assertions-phase13.sql` (wired into `verify-db.sh` after phase 12) covers:

- P13.1 unit conversion and family mismatch refusal
- P13.2 ingredient permissions and base-unit rules
- P13.3 receipts: outlet scope, idempotency, cost valuation
- P13.4 recipes: `menu.manage`, unit conversion, replace on save
- P13.5 completion: FEFO, combo explosion, shortfall, food cost 4910 on the fixture order
- P13.6 duplicate posting prevention, including re-completion
- P13.7 append-only ledger and business-deletion block
- P13.8 wastage: expired disposal, shortfall refusal, reason, idempotency
- P13.9 counts: signed delta, reason, negative count refused
- P13.10 transfers: both-side permissions, conservation, expiry kept, idempotency, same-outlet refusal
- P13.11 reconciliation consistent at both outlets, shortfall shown as unbatched
- P13.12 RLS: kitchen and waiter see no stock, managers see only their outlets, no direct ledger writes

Result at this commit: `verify-db.sh` exit 0, 181 OK (168 from earlier phases, 13 new blocks).

App checks: `src/modules/inventory/inventory.test.ts` (13 tests: units, stock status, expiry, costs, paise conversion).

## Limitations

- Refund behaviour (no restock) follows from the posting trigger firing only on `completed`. It is not asserted by a dedicated test.
- Modifiers have no recipe lines. Upcharged extras are not deducted.
- Recipes are per product. Variants do not change the recipe.
- Food cost % uses `orders.subtotal_minor` for the same completed orders. Check that this matches the finance definition before reporting it externally.
- Alerts appear on the page only. There are no notifications.
- Business deletion is blocked while ledger rows exist. This is deliberate and needs an archival flow before tenant offboarding is built.
- Reconciliation compares the cache with the ledger and batches. It cannot detect a row changed by a superuser outside the application.
- Money is entered in rupees in the UI and stored in paise. Quantities are stored with three decimals.
