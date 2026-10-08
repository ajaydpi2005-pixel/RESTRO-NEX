# RestroNex Multi-Tenant Architecture (Phase 2)

Spec references: §09 (isolation at every layer), §10 (business hierarchy),
§34 (database security).

## Model

```
Platform (RestroNex — `platform` schema, service-role only)
└── Business = Tenant (`businesses`, id = tenant_id)
    ├── Outlets (`outlets`)            1..N
    ├── Memberships (`memberships`)    user × business × role
    │   └── Outlet grants (`membership_outlets`)
    └── Users (`auth.users` ↔ `user_profiles`)
```

## Access levels

| Layer                | Mechanism                                                            |
| -------------------- | -------------------------------------------------------------------- |
| Database             | RLS on every tenant table; membership-based policies; `platform` schema ungranted to tenant roles |
| Outlet operations    | `has_outlet_access(outlet_id)` — role `owner`/`business_admin` implies all outlets of the business; every other role needs explicit rows in `membership_outlets` |
| Server               | `src/lib/tenancy` resolves every selection from the session + RLS-scoped directory |
| Frontend             | Renders only what the server directory contains (no independent client-side tenant truth; UI enforcement arrives with auth in Phase 3) |

## The golden rule (spec §09)

Client-supplied `businessId` / `outletId` / role / price / status are NEVER
trusted. Server flows must call:

```ts
import { resolveTenantSelection } from "@/lib/tenancy";

const { business, outlet } = await resolveTenantSelection(formData);
// only now is it safe to act on business.id / outlet.id
```

Internals:

1. `getTenantDirectory()` — session actor (`auth.getUser()`), then RLS-scoped
   queries for memberships, businesses, outlets and
   `rpc("accessible_outlet_ids")`.
2. `resolveSelection(directory, selection)` — pure logic mapping failures to
   `TenancyError` codes:
   `unauthenticated · no-membership · invalid-input · ambiguous-business ·
   unknown-business · ambiguous-outlet · unknown-outlet · outlet-not-accessible ·
   supabase-not-configured`.

Suspended businesses and inactive/closed outlets resolve exactly like unknown
ones, so callers cannot probe which tenants exist.

## Security-definer functions

`has_business_access`, `has_outlet_access`, `accessible_outlet_ids` are
`SECURITY DEFINER STABLE` with a locked `search_path`. They avoid recursive
policy evaluation and give the server a single round-trip for outlet access.
Executable by `authenticated` + `service_role` only.

## Verification

- `npm run db:verify` — applies migrations to a throwaway PostgreSQL and runs
  ~25 assertions: tenant isolation, outlet grants, cross-tenant denial,
  grant-table write denial, platform lockdown, service-role bypass.
- `src/lib/tenancy/*.test.ts` — pure resolution logic (unit).
- End-to-end with real sessions is exercised from Phase 3 (auth) onward.

## What is intentionally NOT here yet

- Roles/permissions tables and per-permission checks → Phase 5
- Outlet/user assignment management UI → Phases 4–6
- Storage object policies per tenant → with their features
- Subscription entitlement enforcement → Phase 20
