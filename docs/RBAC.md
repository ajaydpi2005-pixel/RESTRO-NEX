# RestroNex RBAC + Permission System (Phase 5)

Spec §11 (roles + granular permissions), §29 (staff management), §39
(`roles` / `permissions` / `role_permissions` entities).

## Enforcement model

```
request → server action → zod validation
                       → requirePermission(businessId, permission, outletId?)
                            1. actor from Supabase SESSION (never from input)
                            2. active membership (service-client read)
                            3. role → permission via code catalogue
                            4. outlet grant check (owner/admin implicit)
                       → service-role write
```

**Frontend permission checks are cosmetic.** Every sensitive operation
re-runs the full chain server-side; hiding a button in the UI grants
nothing. The UI uses the same catalogue only to avoid rendering dead ends.

## Catalogue

Two synchronized copies:

| Where | Role |
| --- | --- |
| `src/lib/rbac/permissions.ts` | enforcement authority on hot paths (unit-tested) |
| `roles` / `permissions` / `role_permissions` tables (migration `20261008150000_rbac.sql`) | queryable/auditable catalogue; SELECT-only for API roles |

`npm run test:rbac:e2e` asserts the two stay in sync on the live project.

### Roles (assignment rank)

| Role | Rank | Scope |
| --- | --- | --- |
| Owner | 100 | business |
| Admin (`business_admin`) | 90 | business |
| Outlet Manager | 70 | outlet |
| Inventory Manager | 60 | business |
| Accountant | 55 | business |
| Cashier | 50 | outlet |
| Waiter | 40 | outlet |
| Kitchen Staff | 30 | outlet |

### Permission matrix (26 permissions × 13 domains)

Domains: orders, billing, discounts, refunds, menu, inventory, purchasing,
customers, reports, staff, settings, outlets, subscriptions.

| Permission | owner | admin | outlet mgr | inventory | accountant | cashier | waiter | kitchen |
| --- | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: |
| orders.view / manage | ✓ | ✓ | ✓ | · | · | ✓ | ✓ | view |
| billing.view / manage | ✓ | ✓ | ✓ | · | view | ✓ | view | · |
| discounts.apply / manage | ✓ | ✓ | ✓ | · | · | apply | · | · |
| refunds.view / process / manage | ✓ | ✓ | ✓ | · | view | · | · | · |
| menu.view / manage | ✓ | ✓ | ✓ | view | · | view | view | view |
| inventory.view / manage | ✓ | ✓ | view | ✓ | · | · | · | · |
| purchasing.view / manage | ✓ | ✓ | · | ✓ | · | · | · | · |
| customers.view / manage | ✓ | ✓ | ✓ | · | view | view | view | · |
| reports.view | ✓ | ✓ | ✓ | ✓ | ✓ | · | · | · |
| staff.view / manage | ✓ | ✓ | view | · | · | · | · | · |
| settings.view / manage | ✓ | ✓ | view | · | · | · | · | · |
| outlets.view / manage | ✓ | ✓ | view | · | · | · | · | · |
| subscriptions.view / manage | ✓ | view | · | · | view | · | · | · |

Waiters get **no** financial administration (spec §19).

## Role assignment rules

- The `owner` role is **never assignable** through staff management.
- An actor may only assign roles **strictly below** their own rank
  (`canAssignRole`), and may only manage members below their rank.
- Members cannot change their own role/status/outlets through the staff UI
  (self-service would be an escalation vector).
- Outlet-scoped roles require at least one outlet grant when added.

## Outlet assignment

- `owner` / `business_admin` reach every outlet implicitly.
- Everyone else needs rows in `membership_outlets` (granted via the staff
  UI, written by service role only — no client-write policies).
- `has_outlet_access()` / `accessible_outlet_ids()` (Phase 2) enforce this
  at the database level for outlet-scoped data.

## Verification

- **Unit**: `src/lib/rbac/rbac.test.ts` — catalogue integrity, all 13
  domains, hierarchy/anti-escalation rules (16 tests).
- **Local DB**: `scripts/local-pg/assertions-phase5.sql` via
  `npm run db:verify` — catalogue completeness, read-only catalogue,
  outlet-grant gating, self-escalation trigger.
- **Live E2E**: `npm run test:rbac:e2e` (requires the hosted project with
  migrations 20261008140000 + 20261008150000 pushed) — self-promotion,
  cashier→staff/settings/outlets attacks, owner-role assignment ban,
  cross-tenant staff manipulation, deactivation revocation, catalogue sync.
