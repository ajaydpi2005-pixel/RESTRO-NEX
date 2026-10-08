# Supabase Setup — RestroNex (Phase 1)

Everything the database needs is already written: migrations live in
`supabase/migrations/`, the seed in `supabase/seed.sql`. This guide connects
that work to a real Supabase project.

## 1. Create the project

1. Sign in (or create an account) at <https://supabase.com>.
2. **New project**:
   - Name: `RestroNex`
   - Database password: use a strong generated password and store it in your
     password manager — it is shown only once.
   - Region: pick the one closest to your users (e.g. `ap-south-1` Mumbai for
     India).
3. Wait for provisioning to finish.

## 2. Collect credentials

Project Settings → **API Keys / Data API**:

| Value                   | Where it goes                    | Reaches the browser? |
| ----------------------- | -------------------------------- | -------------------- |
| Project URL             | `NEXT_PUBLIC_SUPABASE_URL`       | Yes (safe by design) |
| `anon` / `publishable`  | `NEXT_PUBLIC_SUPABASE_ANON_KEY`  | Yes (RLS-protected)  |
| `service_role` / `secret` | `SUPABASE_SERVICE_ROLE_KEY`    | **Never** — server only |

Fill them into `.env.local` (see `.env.example`). Never commit `.env.local`.

## 3. Verify the environment

```bash
npm run env:check
```

## 4. Apply migrations + seed

Install the Supabase CLI (already a devDependency), log in, link and push:

```bash
npx supabase login          # opens a browser login
npx supabase link --project-ref <your-project-ref>   # ref is in the project URL
npx supabase db push        # applies supabase/migrations/* in order
```

Seed the four subscription plans. Hosted projects: open the SQL editor once
and run `supabase/seed.sql`, or from a machine with `psql`:

```bash
psql "<your db connection string>" -f supabase/seed.sql
```

### Local alternative (Docker)

```bash
npm run db:start            # boots the full local Supabase stack
npm run db:reset            # applies migrations + seed from scratch
npm run db:status           # local URLs and keys
```

Then copy the printed local URL/anon/service values into `.env.local`.

## 5. Verify the connection

```bash
npm run dev
curl http://localhost:3000/api/health
# → {"status":"ok","supabase":"connected"}
```

Without credentials the same endpoint honestly reports
`"supabase":"not_configured"`.

## 6. Verify migrations + RLS offline (no Supabase account needed)

```bash
npm run db:verify
```

This spins up a throwaway PostgreSQL cluster, emulates Supabase's API roles /
`auth.uid()` / storage, applies all migrations and seed, then runs 15 security
assertions (tenant isolation, platform lockdown, anon denial, service-role
bypass). Use it any time you change a migration.

## Security rules of this repository

- `SUPABASE_SERVICE_ROLE_KEY` bypasses RLS — it is only read by
  `src/lib/supabase/admin.ts` in server code paths.
- Browser/server clients (`client.ts`, `server.ts`) use the anon key only;
  every row they can touch is filtered by RLS.
- No migration may contain `disable row level security` (a test enforces this).
- The `platform` schema is granted to `service_role` only.

## What exists after Phase 1

| Area      | Objects                                                                    |
| --------- | -------------------------------------------------------------------------- |
| Platform  | `platform.subscription_plans`, `platform.plan_features`, `platform.super_admins` |
| Tenancy   | `businesses`, `outlets`, `business_settings`, `outlet_settings`            |
| Users     | `user_profiles` (+ auth trigger), `memberships`                            |
| Storage   | buckets `menu-media`, `business-assets` (object policies deferred)         |
| RLS       | membership-based SELECT/UPDATE policies; no client-side INSERT/DELETE      |

Deliberately deferred: roles/permissions tables (Phase 5), menu/order/inventory
schemas (Phases 7+), storage object policies (with their features),
subscriptions/entitlements (Phase 20).

## Auth configuration (Phase 3)

Applied via the Management API (`PATCH /v1/projects/<ref>/config/auth`) and
verified server-side — these are NOT client-side conventions:

| Setting              | Value                                                                | Why                                        |
| -------------------- | -------------------------------------------------------------------- | ------------------------------------------ |
| `password_min_length`| `8`                                                                  | matches client zod rules, enforced by GoTrue |
| `mailer_autoconfirm` | `false`                                                              | email confirmation is mandatory            |
| `site_url`           | `http://localhost:3000`                                              | default redirect target for email links    |
| `uri_allow_list`     | `http://localhost:3000/auth/confirm,http://localhost:3000/reset-password,http://localhost:3000/**` | allow `emailRedirectTo` targets |

When you deploy to a real domain, add that origin to `uri_allow_list` and set
`site_url` accordingly, and configure a custom SMTP provider (the shared
default sender is rate-limited — see `docs/AUTH.md`).
