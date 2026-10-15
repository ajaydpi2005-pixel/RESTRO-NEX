# Super Admin (Phase 19)

Super Admin is the RestroNex operator dashboard. It is a separate area from the
restaurant app. Restaurant users cannot reach it, and a request from one gets a
404, not a 403, so the area is not revealed.

## What it covers

| Area | Route | Who can change things |
| --- | --- | --- |
| Overview | `/admin` | Read only |
| Businesses (suspend or reactivate; deactivate a staff membership) | `/admin/businesses`, `/admin/businesses/[id]` | `tenants` |
| Outlets | `/admin/outlets` | Read only |
| Users | `/admin/users`, `/admin/users/[id]` | Read only |
| Subscriptions | `/admin/subscriptions` | `plans` |
| Plans (limits and included features) | `/admin/plans` | `plans` |
| Feature entitlements (overrides) | `/admin/entitlements`, set on each business page | `plans` |
| Usage | `/admin/usage` | Read only |
| Integration health | `/admin/integrations` | Read only |
| Support queue | `/admin/support`, `/admin/support/[id]` | `support` |
| Operator audit log | `/admin/audit` | Read only |
| Platform health | `/admin/health` | Read only |
| Operators (grant and revoke) | `/admin/operators` | `operators` |

The tenant side has one addition: **Settings → Support** (`/settings/support`).
Owners and managers open tickets there and reply. Internal operator notes are
never shown.

## Access model

Operators are rows in `platform.super_admins`, each with a role.

| Role | view | support | plans | tenants | operators |
| --- | :-: | :-: | :-: | :-: | :-: |
| `super_admin` | yes | yes | yes | yes | yes |
| `support` | yes | yes | | | |
| `read_only` | yes | | | | |

The matrix is defined once in SQL (`platform.operator_permissions`). The
TypeScript copy in `src/modules/admin/access.ts` is checked against it by a test.

### Where the checks happen

A request must pass every layer that applies. Each one is enforced on the server.

1. **Proxy** (`src/proxy.ts`). The `/admin` matcher refreshes the session. An
   anonymous visitor is sent to `/admin/sign-in`.
2. **Guard layout** (`src/app/admin/(guarded)/layout.tsx`). The operator role is
   read live on every request. Anonymous visitors are redirected. Non-operators
   and an unconfigured environment get a 404. Revoking an operator takes effect
   on their next request, even with a valid login.
3. **Every page** calls `requireOperator(permission)`.
4. **Every server action** calls `requireOperator(permission)` first.
5. **Every RPC** (`public.admin_*`) starts with `platform.require_operator(actor, permission)`.
   The database rejects the call even if the layers above were bypassed.

The RPCs are executable by the service role only. A test confirms that no tenant
role can run them, and that the `platform` schema cannot be read by tenant roles.

A static test (`src/modules/admin/guard.test.ts`) fails the build if a page or
action drops its check, if a route is moved out of the guarded group, or if an
RPC name in the TypeScript layer has no matching SQL function.

### Refusal messages

Refusals never say that the Super Admin area exists. Action responses use only
our own wording. Database driver and SQL detail is logged by error code and never
shown to the browser.

## Bootstrapping the first operator

Operators are added from the **Operators** page once one exists. For the very
first operator, run `scripts/platform/grant-super-admin.sql` in the Supabase SQL
editor as a database administrator.

1. The person signs up in the app first.
2. Edit the placeholder email in the script and run it.
3. The person signs in at `/admin/sign-in`.

The script is safe to re-run. It writes an audit row each time, with actor role
`bootstrap` and no actor user. The sign-in page refuses any account that is not
an operator, and signs that account out again.

## Businesses and suspension

Suspension is enforced at the **membership** level in the database, not only in
the app:

- Suspending a business sets every `active` staff membership to `suspended`.
  Those people lose access on their next request.
- A database trigger refuses to set a membership to `active` while its business
  is not `active`. This also covers invite acceptance.
- Reactivation restores **only** the memberships that the suspension changed.
  Staff who were deactivated before the suspension stay deactivated.
- Support tickets and enforced features stop while a business is suspended.

Deactivating one person's membership does not change the business status. The
last active owner of a business cannot be deactivated.

Staff can leave a business themselves. Their self-service permission was narrowed
in this phase: a member may set their own membership to `deactivated`, and no
other status. Before this change, a removed staff member could reactivate their
own membership. The Phase 2 test for this was updated to match.

## Subscriptions and plans

Subscriptions are **operator-managed** in this phase. No payment provider is
connected, so nothing is charged. Billing is Phase 20.

- Every business gets a subscription on creation. The default is a **14-day GROWTH
  trial** (`platform.default_trial_days()` returns 14).
- Statuses: `trial`, `active`, `past_due`, `cancelled`.
- A trial needs an end date. Dates are read as the end of that day in IST.

Placeholder plan limits. These are not final prices. Edit them on the Plans page.

| Plan | Outlets | Staff | POS terminals | Storage | Online ordering | Integrations |
| --- | --- | --- | --- | --- | --- | --- |
| STARTER | 1 | 5 | 1 | 1024 MB | off | off |
| GROWTH | 3 | 20 | 4 | 5120 MB | on | on |
| SCALE | 10 | 75 | 12 | 25600 MB | on | on |
| ENTERPRISE | unlimited | unlimited | unlimited | unlimited | on | on |

Reports are on for every plan. Inventory and CRM are on for every plan except
STARTER.

A plan change applies to every business on the plan immediately.

## Entitlements

The effective value of a feature is the business **override** if one is set, and
the **plan** value otherwise.

Only two features are enforced by the database:

- `online_ordering` on orders with channel `online` or `qr`.
- `integrations` on integration accounts and jobs.

Other features are **recorded but not enforced yet**: outlets, staff, POS
terminals, storage, reports, inventory and CRM. The Entitlements page says so for
each feature, and the business page labels the "Enforced" column.

## Support

- A business has at most **10 unresolved tickets**.
- Statuses: open, waiting for customer, resolved. Priority: normal, urgent.
- Operator replies are visible to the business. Internal notes are not. The
  database removes them before the tenant RPC returns, and a test checks this.
- Opening and replying are blocked for suspended businesses.

## Audit

- Every operator change writes an audit row in the same transaction: who, when,
  the action, the target, the business, a reason of 3 to 300 characters, and the
  before and after state. Secrets are scrubbed by `public.audit_scrub`.
- `platform.admin_audit_logs` is append-only. Updates and deletes are rejected.
- **Tenant audit reads are not logged per access.** Operators can read a
  business's trail on its detail page. Operator *changes* are always logged. This
  was a design decision accepted by the product owner.

## What is measured and what is not

Every number comes from a live query. A figure that cannot be measured is shown
as **not measured**, never as zero.

Measured now:

- Business, subscription, outlet, staff, order, payment and job counts.
- Captured payment value, summed **per currency**. Currencies are never mixed.
- Integration account status, pending and dead jobs, failed attempts in 24 hours.
- Print agents online (seen in the last 5 minutes), webhook receipt and failures.
- A database round trip, timed on each request.

Not measured in this phase:

- Uptime and availability.
- Application error rate and latency percentiles.
- Connection pool usage and query error counts.
- Storage used per business. Storage is not metered yet.
- Third-party provider API latency and quota.

The Usage page reads the **200 most recently created** businesses. It says so.

## Security notes and limits

- Operator accounts are ordinary RestroNex accounts with an operator row. **Turn
  on two-factor authentication for every operator account** in the Supabase
  dashboard. This phase does not add a second factor inside Super Admin.
- `admin_operator_context` is the one `admin_*` function without a permission
  check. It returns the operator role for a given user id, so the server can
  decide whether a freshly signed-in user is an operator. It is service-role only,
  and the server passes only the verified session user's id.
- The last active `super_admin` cannot be revoked. An operator cannot revoke
  their own access.
- Guards fail closed. If Supabase is not configured, the Super Admin area returns
  404.

## Verification

- `scripts/verify-db.sh`: Phase 19 assertions P19.0 to P19.17, all passing. P19.17
  checks that every RPC returns the keys the dashboard reads.
- `src/modules/admin/*.test.ts` and `src/modules/support/schemas.test.ts`:
  access, formatting, input validation and the static guard.

## Not in this phase

- Billing, invoices and payment collection (Phase 20).
- Second factor inside Super Admin.
- Storage metering and API usage metering.
- Enforcement of outlet, staff, terminal and storage limits.
