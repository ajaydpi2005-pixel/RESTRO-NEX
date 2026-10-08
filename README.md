# RestroNex

**One platform. Every restaurant.**

RestroNex is a premium multi-tenant restaurant POS & management SaaS. Restaurants create
accounts, subscribe to plans and run their operations — billing, kitchen, inventory,
customers and multi-outlet management — on one platform with strictly isolated data.

> The complete product specification lives in [`docs/MASTER_SPEC.md`](docs/MASTER_SPEC.md).
> This repository is a greenfield build executed phase by phase (spec §43–§44).

## Build status

| Phase | Scope                              | Status          |
| ----- | ---------------------------------- | --------------- |
| 0     | Project Foundation                 | ✅ Complete     |
| 1     | Supabase + Database Foundation     | ✅ Complete     |
| 2     | Multi-Tenant Architecture + RLS    | ✅ Complete     |
| 3     | Authentication                     | Next up         |
| 4–25  | See `docs/MASTER_SPEC.md` §43      | Roadmap         |

## Tech stack

| Layer       | Technology                                              |
| ----------- | ------------------------------------------------------- |
| Framework   | Next.js 16 (App Router, Turbopack) + React 19           |
| Language    | TypeScript (strict + `noUncheckedIndexedAccess`)        |
| Styling     | Tailwind CSS v4 (CSS-first tokens)                      |
| UI kit      | shadcn/ui (Radix primitives), themed with brand tokens  |
| Icons       | lucide-react                                            |
| Theming     | next-themes (class-based light/dark)                    |
| Validation  | Zod v4                                                  |
| Database    | Supabase (PostgreSQL 15+, RLS, Storage) — migrations in `supabase/` |
| Testing     | Vitest + offline Postgres RLS harness (`npm run db:verify`) |
| Lint/format | ESLint 9 (flat config) + Prettier + tailwind plugin     |

## Getting started

```bash
npm install
cp .env.example .env.local   # add Supabase keys — docs/SUPABASE_SETUP.md
npm run env:check            # verify configuration
npm run dev                  # http://localhost:3000
```

### Scripts

| Script                  | Purpose                          |
| ----------------------- | -------------------------------- |
| `npm run dev`           | Dev server (Turbopack)           |
| `npm run build`         | Production build                 |
| `npm run start`         | Serve the production build       |
| `npm run lint`          | ESLint over the whole repo       |
| `npm run typecheck`     | TypeScript `--noEmit` check      |
| `npm test`              | Vitest suite (single run)        |
| `npm run test:watch`    | Vitest watch mode                |
| `npm run format`        | Prettier write                   |
| `npm run format:check`  | Prettier verify                  |
| `npm run env:check`     | Report env configuration (no values printed) |
| `npm run db:start`      | Local Supabase stack (Docker)    |
| `npm run db:reset`      | Re-apply migrations + seed locally |
| `npm run db:verify`     | Offline migration + RLS assertion harness (no Docker) |

## Architecture

```
src/
├── app/
│   ├── (marketing)/        # Public website: /, /features, /pricing
│   ├── (auth)/             # /login, /signup
│   ├── (app)/              # Restaurant application shell
│   │   ├── dashboard/  pos/  kitchen/  menu/
│   │   ├── inventory/  customers/  reports/  settings/
│   ├── (platform)/         # Super Admin (/admin) — separately protected
│   ├── globals.css         # RestroNex design tokens (light/dark)
│   ├── icon.svg            # Brand favicon
│   ├── layout.tsx          # Root layout: fonts + theme provider
│   └── not-found.tsx
├── components/
│   ├── ui/                 # shadcn/ui primitives
│   ├── layout/             # App shell (sidebar, topbar, mobile drawer)
│   ├── site/               # Marketing header & footer
│   ├── brand/              # Logo mark & lockup (original artwork)
│   ├── module-placeholder.tsx
│   ├── theme-provider.tsx
│   └── theme-toggle.tsx
├── config/
│   ├── site.ts             # Brand copy & links (single source of truth)
│   └── modules.ts          # Roadmap module registry feeding nav + placeholders
├── lib/
│   ├── env.ts              # Zod-validated environment contract
│   ├── utils.ts            # cn() class merge helper
│   ├── supabase/           # client.ts (browser) · server.ts · admin.ts
│   └── tenancy/            # Server-side tenant/outlet resolution (see docs/TENANCY.md)
└── app/api/health/         # Honest DB connectivity probe

supabase/
├── config.toml             # Supabase CLI project config
├── migrations/             # Timestamped SQL migrations (the only way schema changes)
└── seed.sql                # Platform seed (4 plans; no fake business data)

scripts/
├── check-env.mjs           # Env configuration report
├── verify-db.sh            # Offline Postgres RLS verification harness
└── local-pg/               # Supabase emulation + assertions for the harness
```

### Route map

| Route        | Surface                                  | Delivered in      |
| ------------ | ---------------------------------------- | ----------------- |
| `/`          | Marketing home                           | Phase 0           |
| `/features`  | Feature roadmap                          | Phase 0           |
| `/pricing`   | Plans overview                           | Phase 0           |
| `/login`     | Authentication entry                     | Phase 3           |
| `/signup`    | Registration entry                       | Phase 3           |
| `/dashboard` | Owner dashboard                          | Phases 6 → 16     |
| `/pos`       | Point of sale                            | Phase 8           |
| `/kitchen`   | Kitchen Display System                   | Phase 11          |
| `/menu`      | Universal menu management                | Phase 7           |
| `/inventory` | Recipes + inventory                      | Phase 13          |
| `/customers` | CRM + loyalty                            | Phase 15          |
| `/reports`   | Reports + analytics                      | Phase 16          |
| `/settings`  | Business/outlet/staff configuration      | Phases 4–5        |
| `/admin`     | Super Admin console                      | Phase 19          |

Pages for phases that have not shipped yet render honest roadmap placeholders from
`src/config/modules.ts` — no fake data, no dead controls.

## Design system

Tokens are defined once in `src/app/globals.css` and drive both themes via CSS variables.

| Token            | Value     | Usage                                    |
| ---------------- | --------- | ---------------------------------------- |
| Deep green-black | `#101B19` | Brand ink, sidebar, CTAs (light theme)   |
| Champagne gold   | `#D4B477` | Accent only — never the dominant colour  |
| Warm white       | `#F5F3EE` | Backgrounds, dark-theme foreground       |

Plus semantic tokens (`background`, `card`, `primary`, `secondary`, `muted`, `accent`,
`destructive`, `border`, `ring`, `sidebar-*`, `chart-*`) for light and dark mode, radius
scale, and `font-display` (Fraunces) for marketing headlines vs `font-sans` (Inter) for UI.

UX rules (spec §41): POS favours speed, KDS favours visibility, dashboards favour
information hierarchy, marketing favours brand experience.

## Environment variables

See `.env.example`; the step-by-step Supabase walkthrough lives in
[`docs/SUPABASE_SETUP.md`](docs/SUPABASE_SETUP.md). From Phase 1, database code paths require
`NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` and the server-only
`SUPABASE_SERVICE_ROLE_KEY`. Server-only secrets must never carry the `NEXT_PUBLIC_` prefix, and
the service-role key is only ever read by `src/lib/supabase/admin.ts` in server code.

## Multi-tenancy & security posture

- Tenant isolation at frontend, server and database layers (PostgreSQL RLS).
  The full model is documented in [`docs/TENANCY.md`](docs/TENANCY.md).
- Nothing client-supplied is trusted: tenant ids, roles, prices, taxes,
  discounts and payment statuses are validated server-side. Server flows
  resolve selections via `src/lib/tenancy` (`resolveTenantSelection`).
- Outlet-level access: `owner`/`business_admin` imply all outlets; other
  roles need explicit grants (`membership_outlets`).
- Money handled in integer minor units; ledgers (inventory, loyalty, audit) are append-only.
- Super Admin is a separately protected surface, never granted via public sign-up.
