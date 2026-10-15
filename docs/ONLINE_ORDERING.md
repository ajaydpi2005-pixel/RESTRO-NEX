# Online and QR ordering (Phase 17)

Customers order from a restaurant website or from a printed table QR code. Those orders
flow into the same order, kitchen, inventory, customer and reporting pipeline as counter
orders. This phase builds the checkout architecture. It takes no online payment and
connects to no live payment provider.

## What is built

| Area | Where |
|---|---|
| Schema, RLS, RPCs, idempotency | `supabase/migrations/20261015100000_online_ordering.sql` |
| Database assertions P17.0–P17.12 | `scripts/local-pg/assertions-phase17.sql` (run by `scripts/verify-db.sh`) |
| Shared constants, types, validation | `src/modules/online/{constants,types,schemas,cart}.ts` |
| Public service (service-role RPC wrappers) | `src/modules/online/public-service.ts` |
| Staff service and server actions | `src/modules/online/{staff-service,actions}.ts` |
| Customer storefront, table menu, tracking | `src/modules/online/components/{storefront,track-status}.tsx`, `src/app/order/…`, `src/app/q/…`, `src/app/track/…` |
| Staff queue | `src/app/(app)/orders/online/page.tsx`, `components/intake-queue.tsx` |
| Settings and QR codes | `src/app/(app)/settings/ordering/page.tsx`, `components/{ordering-settings-form,qr-panel}.tsx` |
| Public API | `src/app/api/public/checkout/route.ts`, `src/app/api/public/orders/[orderId]/route.ts` |
| Payment webhook receiver (no provider registered) | `src/app/api/webhooks/payments/[provider]/route.ts`, `src/modules/payment-gateway/` |
| Sales-by-channel report | `src/modules/reports/registry.ts` (`sales-channel`, the 25th report) |

The website and QR orders use the **universal menu**: the same products, variants,
modifier groups, combos and outlet price overrides that the POS uses.

## Trust model

- **The browser sends intent only.** Checkout accepts item ids, variant and option ids,
  quantities, notes, and contact details. It never sends a price, discount, tax, fee,
  status, business id or outlet id that the server trusts. Schemas strip unknown keys.
- **The server prices every line.** `public_order_create` re-prices from the menu
  inside the database. Cart totals on screen are estimates and say so.
- **Tenant comes from the link, not the request.** The website is resolved from the
  business and outlet slugs. The table menu is resolved from a QR token. The QR token is
  stored only as a SHA-256 hash, and a revoked code is refused.
- **Tracking uses a customer-held secret.** The browser generates a random tracking
  secret and keeps it in the URL fragment (`/track/<id>#s=…`). Browsers never send
  fragments to servers. The status request sends the secret in the `x-tracking-secret`
  header, never in the URL. The database stores only its SHA-256. A wrong secret gets the
  same 404 as an unknown order.
- **Idempotent submission.** The browser generates a client reference. A retry with the
  same reference and the same cart returns the same order. The reference is reused only
  when the cart and form are unchanged, so a changed order cannot replay an older one.
- **Staff actions are checked twice.** Each server action checks the permission in
  TypeScript (`requirePermission`), and the database check runs again with the session
  user as the actor. Accept and reject need `orders.manage`. Settings and QR codes need
  `settings.manage`. The queue view needs `orders.view`.
- **Kitchen staff** keep `orders.view`. They see the queue, but customer phone numbers
  and delivery addresses are hidden unless the viewer can manage orders. Kitchen staff
  do not gain any financial permission.
- **No raw IP addresses are stored.** The rate-limit fingerprint is a hash of the client
  address.
- **Public responses are never cached** and carry `noindex`. The QR page and tracking
  page set `Referrer-Policy: no-referrer`, so a QR token in the path does not leak to
  external sites.

## Payments

No online payment is taken in Phase 17. Every order screen says so, and the order
records its intended payment mode: pay at counter, pay on delivery, or pay at table.

An order becomes **paid** only through a verified provider webhook. That path is not
live yet:

- `payment_webhook_events` records each verified event once, with a unique key on
  (provider, event id).
- `payment_webhook_claim` returns `new`, `duplicate` (a replay, safe to acknowledge), or
  `mismatch` (the same event id with a different payload, refused with 409).
- The claim never changes an order or a payment.
- The receiver answers **404 before reading the body** while no provider is registered.
  An unknown provider, a missing signing secret (503), a bad signature (401) and an
  oversize body (413) are each refused before anything is recorded.
- Staff-recorded payments through the POS flow are unchanged.

Adding a provider later means one adapter in `src/modules/payment-gateway/registry.ts`
(verify the signature over the raw body, extract the event id and type), plus a separate,
verified step that applies a captured event to the order's payment. Neither is part of
Phase 17.

## Order rules

- A website or QR order starts as `held` with intake status `awaiting_acceptance`. It
  waits in the intake queue. Staff accept it (the order becomes `placed` and goes to the
  kitchen), or reject it with a reason shown to the customer. An outlet can auto-accept,
  and an auto-accept never fails the customer's order.
- Accepted orders go to the kitchen through the existing KDS. Kitchen item moves advance
  the order status.
- The **minimum order** applies to website orders only. QR table orders have no minimum.
- Website orders need a phone number. Delivery orders need an address. Table orders need
  only a valid QR token.
- Online orders use the same `orders` and `order_items` tables as counter orders, so the
  existing inventory and completion path applies to them. A website order with a phone
  number is linked to the customer record through the existing phone key.

## Reports

`sales-channel` groups completed orders by channel (Counter / POS, Website, QR table) and
by order type (Dine-in, Takeaway, Delivery). Its rows reconcile with the outlet report
(verified in P17 fixtures: channel totals equal the outlet total, and website and QR rows
match the raw completed orders).

## Design defaults (confirm in review)

These defaults were built and are not yet confirmed by the user:

1. The tracking secret is generated in the browser and kept in the URL fragment. The server
   stores only its hash.
2. A QR token is shown once at issue and stored only as a hash. Lost codes are replaced,
   not recovered.
3. No provider is registered, so the webhook route returns 404 before reading the body.
4. The staff queue is linked from `/orders` (`/orders/online`). Ordering settings and QR
   management are linked from `/settings` (`/settings/ordering`). The top-level navigation
   is unchanged.
5. The sales-channel report is the 25th report, in the sales group.

## Not in this phase

- Production aggregator adapters (delivery marketplaces) and any live payment provider.
- Marking an order paid from a webhook (the verified step described above).
- Push notifications to staff or customers. The queue and tracking pages poll.
- Rate-limit tuning beyond the database counter and hashed fingerprint.

## Verification

- `bash scripts/verify-db.sh` runs Phases 1–17 against a local Postgres. Phase 17 covers
  P17.0–P17.12.
- `npm test` covers the cart rules, schema validation, security helpers, the webhook
  receiver, signature verification, and the registry (including the 25-report catalogue).
- `npm run typecheck` and `npm run lint` pass.
