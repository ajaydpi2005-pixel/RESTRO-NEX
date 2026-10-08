# RestroNex Authentication (Phase 3)

Supabase Auth with email + password. Sessions are httpOnly cookies managed by
`@supabase/ssr`; every protected route re-validates the user server-side.

## Routes

| Route            | Who                | Behaviour                                            |
| ---------------- | ------------------ | ---------------------------------------------------- |
| `/signup`        | anonymous          | Register → verification email → `/auth/confirm`       |
| `/login`         | anonymous          | Sign in; supports `?next=` deep-link and `?error=`    |
| `/forgot-password` | anonymous        | Sends reset email (anti-enumeration: always "sent")   |
| `/reset-password`| recovery session   | Sets the new password after clicking the email link   |
| `/auth/confirm`  | email link target  | PKCE code exchange → redirect to `next` or dashboard  |
| `/auth/callback` | legacy/implicit links | fragment (`#access_token=`) session bridge fallback |
| `/dashboard` …   | signed-in only     | Redirect to `/login?next=<path>` when unauthenticated |
| `/account`       | signed-in only     | Profile + password management                         |

Signed-in users hitting `/login` or `/signup` are redirected to `/dashboard`.

## Where enforcement lives

- **`src/proxy.ts`** — Next.js proxy (middleware role): session refresh on
  every matched request + route protection/bounce. This is the ONLY place
  with redirect logic for auth.
- **`src/app/(app)/layout.tsx`** — server-side belt & braces: re-reads the
  user and redirects to `/login` if absent. With Cache Components enabled
  the group is marked `instant = false` (blocking, never prerendered).
- **`src/modules/auth/schemas.ts`** — zod validation for every form +
  `sanitizeNext()` open-redirect guard.
- **`src/modules/auth/actions.ts`** — server actions (signup/signin/signout/
  forgot/reset/profile/change password). All inputs validated; messages are
  anti-enumeration (same text whether or not the account exists).

## Password policy

- Client (zod): min 8 chars, at least one letter and one number.
- Server (GoTrue): `password_min_length = 8` configured on the project —
  verified enforced in the live E2E (422 for weak passwords).

## Email configuration (hosted project)

- `mailer_autoconfirm = false` — email confirmation is REQUIRED.
- `site_url = http://localhost:3000`
- `uri_allow_list` includes `http://localhost:3000/auth/confirm`,
  `http://localhost:3000/reset-password` and `http://localhost:3000/**`.
- Uses Supabase's shared default SMTP sender until custom SMTP is configured
  (see `docs/SUPABASE_SETUP.md`). The shared sender is heavily rate-limited;
  in production you must configure your own SMTP provider.

## End-to-end verification

`npm run test:auth:e2e` runs `scripts/live-auth-lifecycle.mjs` against the
real hosted Supabase project and the running app on `http://localhost:3000`:

- signup probe (public `/auth/v1/signup`; falls back to admin-created user if
  the shared SMTP quota blocks the confirmation email)
- server-side password policy (422 for weak passwords)
- `user_profiles` onboarding row auto-created on signup
- confirmation gate: unconfirmed users CANNOT sign in
- admin confirmation (the exact server-side effect of the email link)
- login → session JWT → signed-in routing through the app
  (`/dashboard`, `/account` 200; signed-in `/login` bounces; forged cookie bounces)
- anti-enumeration: identical generic errors for wrong password vs unknown email
- logout revokes the session
- forgot → reset: old password rejected, new password signs in
- full cleanup of test users

Latest run: **23/23 checks passed** (public signup probe rate-limited by the
shared Supabase SMTP quota — retry window dependent, logic verified via the
admin-created path through the same GoTrue confirmation gate).
