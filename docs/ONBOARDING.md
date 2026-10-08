# RestroNex — Phase 6: Restaurant Onboarding

The first-time setup experience: **Signup → Verification → Business → Restaurant
type → Outlet → Business settings → Tax → Tables → Kitchen → Menu → Staff
invites → Dashboard**. Premium, progressive, and resumable — every step
persists real data; nothing is fake or throwaway.

## Flow & steps

| # | Step | Persists to | Skippable |
|---|---|---|---|
| 1 | `business` | `businesses` (+ owner membership via `create_business()`) | no |
| 2 | `type` | `businesses.restaurant_type` | no |
| 3 | `outlet` | `outlets` (code auto-generated from name) | no |
| 4 | `settings` | `businesses` contact/address/currency/timezone | yes |
| 5 | `tax` | `businesses.tax_number`, `businesses.tax_settings` jsonb | yes |
| 6 | `tables` | `dining_sections` + `dining_tables` | yes |
| 7 | `kitchen` | `kitchen_stations` | yes |
| 8 | `menu` | `menu_categories` + `menu_items` | yes |
| 9 | `staff` | `staff_invites` (token links) | yes |
| 10 | `finish` | stamps `onboarding_progress.completed_at` | — |

Signup + email verification are Phase 2/3; the wizard picks new users up
automatically (the dashboard redirects accounts with zero memberships to
`/onboarding`).

## Resume later

`onboarding_progress` (PK `business_id`) stores `current_step`,
`completed_steps text[]` and `completed_at`. A trigger auto-creates the row
when a business is inserted (i.e. inside `create_business()`), initialised to
`type` with `business` already complete. `/onboarding` resolves the target
business server-side (owner/admin memberships only, most recent incomplete
one wins) and deep links are reconciled against prerequisites — you can never
land on a step you aren't ready for.

Completion state: `completed_at` is stamped by the finish step; the dashboard
shows a success banner (`?onboarded=1`), a "resume setup" banner while
onboarding is incomplete, and an invitation-accepted banner (`?joined=1`).

## Security model

- **Actor = session user.** The hidden `businessId` field is a selector only;
  every action re-verifies an active owner/business_admin membership before
  writing (`authorizeSetup`), plus the relevant RBAC permission
  (`settings.manage`, `outlets.manage`, `menu.manage`, `staff.manage`).
- **No client writes.** All seven new tables have RLS enabled with
  SELECT-only member policies; writes go through service-role actions or
  SECURITY DEFINER RPCs that re-check membership themselves.
- **Atomic setup RPCs** (service-role only): `set_outlet_floor_plan`,
  `set_outlet_kitchen_stations`, `set_business_menu` — replace semantics,
  validated payloads, count caps (500 tables / 20 stations / 1000 items).
- **Staff invites**: 32-char base64url tokens, expiry (1/7/30 days), optional
  email lock, owner can never be invited (CHECK constraint), outlet-scoped
  roles require ≥1 outlet. Acceptance (`accept_staff_invite`) is atomic:
  validates token state, creates/reactivates the membership and outlet grants,
  marks the token used. Tokens are visible only to owners/admins (RLS).
- **Wizard state RPC** `update_onboarding_progress` rejects non-owner/admin
  actors and unknown steps.

## Data model notes

- Menu is **business-level** (shared across outlets); outlet availability,
  variants/modifiers/combos arrive with Phase 7's universal menu.
- Tables/kitchen stations are the real production entities later phases build
  on (Phase 9 dine-in, Phase 11 KDS) — onboarding only seeds them.
- `tax_settings` shape: `{enabled, rates:[{name, pct, inclusive}], invoice_footer}`.

## Verification layers

1. **Unit** (`npm test`): step registry (order/prereqs/percent/states),
   price→minor-unit conversion, floor-plan/kitchen/menu/tax/invite schemas.
2. **Local DB** (`npm run db:verify`, assertions-phase6.sql): RLS denials on
   every new table, progress trigger + RPC authorisation, atomic replace
   semantics, invite lifecycle (accept/reuse/expired/revoked/email-lock/
   owner-ban/outlet requirement), token visibility.
3. **Hosted E2E** (`npm run test:onboarding:e2e` — requires pushed
   migrations + running app): full wizard via real form POSTs, persistence
   checks, invite acceptance by a second user, and attacks (waiter running
   owner steps, skipping required steps, forging admin invites, token reuse).
