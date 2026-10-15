-- ─────────────────────────────────────────────────────────────────────────
-- RestroNex Super Admin — bootstrap the FIRST operator.
--
-- Run once, by a database administrator, in the Supabase SQL editor (or with
-- psql as the postgres role). Operators added later use the Operators page
-- in Super Admin, which checks permissions and writes the audit row itself.
--
-- Before running:
--   1. The person must already have an account: they sign up in the app.
--   2. Replace the placeholder email below. Nothing else needs editing.
--
-- Safe to re-run: an existing operator row is set back to super_admin and
-- un-revoked. Every run writes an audit row (action admin.operator_granted,
-- actor role 'bootstrap', no actor user).
-- Never paste a password or service-role key into this file.
-- ─────────────────────────────────────────────────────────────────────────

begin;

do $$
declare
  v_email text := 'REPLACE-WITH-OPERATOR-EMAIL@example.com';
  v_user uuid;
  v_before jsonb;
begin
  if v_email like 'REPLACE-WITH-%' then
    raise exception 'Edit the placeholder email in scripts/platform/grant-super-admin.sql first.';
  end if;

  select u.id into v_user
  from auth.users u
  where lower(u.email) = lower(v_email);

  if v_user is null then
    raise exception 'No account exists for %. Ask the person to sign up first.', v_email;
  end if;

  select jsonb_build_object('role', sa.role, 'revoked', sa.revoked_at is not null)
    into v_before
  from platform.super_admins sa
  where sa.user_id = v_user;

  insert into platform.super_admins (user_id, role, granted_by, revoked_at)
  values (v_user, 'super_admin', null, null)
  on conflict (user_id) do update
    set role = 'super_admin', revoked_at = null;

  perform platform.admin_audit_write(
    null, 'bootstrap', 'admin.operator_granted', 'operator', v_user::text, null,
    'First operator granted from the SQL editor',
    v_before,
    jsonb_build_object('role', 'super_admin', 'revoked', false)
  );

  raise notice 'Super Admin granted to %. Sign in at /admin/sign-in.', v_email;
end $$;

commit;
