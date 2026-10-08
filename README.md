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
| 1     | Supabase + Database Foundation     | Next up         |
| 2–25  | See `docs/MASTER_SPEC.md` §43      | Roadmap         |

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
| Testing     | Vitest                                                  |
| Lint/format | ESLint 9 (flat config) + Prettier + tailwind plugin     |

## Getting started

```bash
npm install
cp .env.example .env.local   # values are optional until Phase 1
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
└── lib/
    ├── env.ts              # Zod-validated environment contract
    └── utils.ts            # cn() class merge helper
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

See `.env.example`. All variables are optional in Phase 0; each later phase tightens the
contract in `src/lib/env.ts` for the services it introduces. Server-only secrets must never
carry the `NEXT_PUBLIC_` prefix.

## Multi-tenancy & security posture (design commitments)

- Tenant isolation at frontend, server and database layers (PostgreSQL RLS from Phase 2).
- Nothing client-supplied is trusted: tenant ids, roles, prices, taxes, discounts and
  payment statuses are validated server-side.
- Money handled in integer minor units; ledgers (inventory, loyalty, audit) are append-only.
- Super Admin is a separately protected surface, never granted via public sign-up.
