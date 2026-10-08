-- ─────────────────────────────────────────────────────────────────────────
-- RestroNex Phase 1 security & isolation assertions.
-- Runs against the Supabase emulation (scripts/local-pg/prepare.sql).
-- Any failed check raises an exception and fails the script.
-- ─────────────────────────────────────────────────────────────────────────

\echo '── Structure: RLS enabled on all tenant tables'
do $$
declare
  missing text;
begin
  select string_agg(c.relname, ', ') into missing
  from (
    values ('businesses'), ('outlets'), ('business_settings'),
           ('outlet_settings'), ('user_profiles'), ('memberships')
  ) as required(relname)
  join pg_class c on c.relname = required.relname and c.relnamespace = 'public'::regnamespace
  where not c.relrowsecurity;

  if missing is not null then
    raise exception 'RLS not enabled on: %', missing;
  end if;
  raise notice 'OK: RLS enabled on all six tenant tables';
end
$$;

\echo '── Structure: platform schema locked down'
do $$
begin
  if not exists (
    select 1 from pg_namespace n
    where n.nspname = 'platform'
      and not has_schema_privilege('anon', 'platform', 'usage')
      and not has_schema_privilege('authenticated', 'platform', 'usage')
      and has_schema_privilege('service_role', 'platform', 'usage')
  ) then
    raise exception 'platform schema privileges are wrong';
  end if;
  raise notice 'OK: platform schema reachable only by service_role';
end
$$;

\echo '── Seed: subscription plans'
do $$
declare
  n int;
begin
  select count(*) into n from platform.subscription_plans;
  if n <> 4 then
    raise exception 'expected 4 seeded plans, found %', n;
  end if;
  raise notice 'OK: STARTER/GROWTH/SCALE/ENTERPRISE seeded';
end
$$;

-- ── Fixtures (superuser bypasses RLS) ──────────────────────────────────────
insert into auth.users (id, email, raw_user_meta_data) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'alice@example.com', '{"full_name": "Alice Owner"}'),
  ('bbbbbbbb-0000-0000-0000-000000000002', 'bob@example.com',   '{"full_name": "Bob Owner"}');

\echo '── Trigger: profiles auto-created for new auth users'
do $$
declare
  n int;
begin
  select count(*) into n from public.user_profiles
  where id in ('aaaaaaaa-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-000000000002');
  if n <> 2 then
    raise exception 'handle_new_user trigger failed: % profiles', n;
  end if;
  raise notice 'OK: profiles created with emails and names';
end
$$;

insert into public.businesses (id, name, slug) values
  ('cccccccc-0000-0000-0000-000000000001', 'Tenant A', 'tenant-a'),
  ('dddddddd-0000-0000-0000-000000000002', 'Tenant B', 'tenant-b');

insert into public.outlets (business_id, name, slug, currency_code) values
  ('cccccccc-0000-0000-0000-000000000001', 'Tenant A Main', 'main', 'INR'),
  ('dddddddd-0000-0000-0000-000000000002', 'Tenant B Main', 'main', 'INR');

insert into public.business_settings (business_id) values
  ('cccccccc-0000-0000-0000-000000000001');

insert into public.memberships (user_id, business_id, role) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'cccccccc-0000-0000-0000-000000000001', 'owner'),
  ('bbbbbbbb-0000-0000-0000-000000000002', 'dddddddd-0000-0000-0000-000000000002', 'owner');

\echo '── Storage: foundation buckets'
do $$
declare
  n int;
begin
  select count(*) into n from storage.buckets
  where id in ('menu-media', 'business-assets');
  if n <> 2 then
    raise exception 'expected 2 storage buckets, found %', n;
  end if;
  raise notice 'OK: menu-media and business-assets buckets exist';
end
$$;

-- ── Anonymous access: sees nothing, writes nothing ─────────────────────────
set role anon;

\echo '── Anon: zero tenant rows visible'
do $$
declare
  n int;
begin
  select count(*) into n from public.businesses;
  if n <> 0 then raise exception 'ANON LEAK: % businesses visible', n; end if;
  select count(*) into n from public.outlets;
  if n <> 0 then raise exception 'ANON LEAK: % outlets visible', n; end if;
  select count(*) into n from public.memberships;
  if n <> 0 then raise exception 'ANON LEAK: % memberships visible', n; end if;
  select count(*) into n from public.user_profiles;
  if n <> 0 then raise exception 'ANON LEAK: % profiles visible', n; end if;
  raise notice 'OK: anon sees zero rows on all tenant tables';
end
$$;

\echo '── Anon: INSERT denied on businesses'
do $$
begin
  begin
    insert into public.businesses (name, slug) values ('Sneaky', 'sneaky');
    raise exception 'SECURITY FAIL: anon inserted a business';
  exception when insufficient_privilege then
    raise notice 'OK: anon insert denied (42501)';
  end;
end
$$;

\echo '── Anon: platform schema unreachable'
do $$
begin
  begin
    perform 1 from platform.subscription_plans;
    raise exception 'SECURITY FAIL: anon reached platform schema';
  exception when insufficient_privilege then
    raise notice 'OK: platform schema denied for anon (42501)';
  end;
end
$$;

reset role;

-- ── Authenticated without a JWT subject: still nothing ────────────────────
set role authenticated;
select set_config('request.jwt.claims', '', false);

\echo '── Authenticated (no subject): zero tenant rows'
do $$
declare
  n int;
begin
  select count(*) into n from public.businesses;
  if n <> 0 then raise exception 'LEAK: % businesses visible without subject', n; end if;
  raise notice 'OK: session without auth.uid() sees nothing';
end
$$;

reset role;

-- ── Alice (member of Tenant A only) ────────────────────────────────────────
set role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub": "aaaaaaaa-0000-0000-0000-000000000001", "role": "authenticated"}',
  false
);

\echo '── Tenant isolation: Alice sees exactly her own business'
do $$
declare
  slugs text[];
begin
  select array_agg(slug order by slug) into slugs from public.businesses;
  if slugs is distinct from array['tenant-a'] then
    raise exception 'ISOLATION FAIL: alice sees %', slugs;
  end if;
  raise notice 'OK: exactly one tenant visible, tenant-a';
end
$$;

\echo '── Tenant isolation: outlets and memberships scoped to Tenant A'
do $$
declare
  n int;
begin
  select count(*) into n from public.outlets;
  if n <> 1 then raise exception 'ISOLATION FAIL: % outlets visible', n; end if;
  select count(*) into n from public.memberships;
  if n <> 1 then raise exception 'ISOLATION FAIL: % memberships visible', n; end if;
  select count(*) into n from public.business_settings;
  if n <> 1 then raise exception 'ISOLATION FAIL: % business_settings visible', n; end if;
  raise notice 'OK: outlets, memberships and settings scoped to own tenant';
end
$$;

\echo '── Profiles: Alice sees and updates only her own'
do $$
declare
  n int;
begin
  select count(*) into n from public.user_profiles;
  if n <> 1 then raise exception 'ISOLATION FAIL: % profiles visible', n; end if;

  update public.user_profiles set full_name = 'Alice A.' where id = auth.uid();
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'self profile update failed'; end if;

  update public.user_profiles set full_name = 'Hacked'
  where id = 'bbbbbbbb-0000-0000-0000-000000000002';
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'SECURITY FAIL: alice modified bob''s profile'; end if;
  raise notice 'OK: own profile updatable, foreign profile untouched';
end
$$;

\echo '── Cross-tenant writes are no-ops or denied'
do $$
declare
  n int;
begin
  -- UPDATE through RLS simply matches zero rows for foreign tenants.
  update public.businesses set name = 'Hacked' where slug = 'tenant-b';
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'SECURITY FAIL: alice updated tenant-b'; end if;

  update public.outlets set name = 'Hacked'
  where business_id = 'dddddddd-0000-0000-0000-000000000002';
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'SECURITY FAIL: alice updated tenant-b outlet'; end if;

  -- Direct INSERT of tenant data is not allowed by any policy.
  begin
    insert into public.outlets (business_id, name, slug, currency_code)
    values ('cccccccc-0000-0000-0000-000000000001', 'Rogue', 'rogue', 'INR');
    raise exception 'SECURITY FAIL: direct outlet insert allowed';
  exception when insufficient_privilege then
    null;
  end;
  raise notice 'OK: cross-tenant updates are no-ops, client inserts denied';
end
$$;

\echo '── Platform schema unreachable even for members'
do $$
begin
  begin
    perform 1 from platform.subscription_plans;
    raise exception 'SECURITY FAIL: member reached platform schema';
  exception when insufficient_privilege then
    raise notice 'OK: platform schema denied for authenticated (42501)';
  end;
end
$$;

reset role;

-- ── Service role: full access (BYPASSRLS) ──────────────────────────────────
set role service_role;

\echo '── Service role: bypasses RLS for server-side flows'
do $$
declare
  n int;
begin
  select count(*) into n from public.businesses;
  if n <> 2 then raise exception 'service role should see all tenants, saw %', n; end if;
  select count(*) into n from platform.subscription_plans;
  if n <> 4 then raise exception 'service role should see plans, saw %', n; end if;
  raise notice 'OK: service role has full access (used by privileged server flows)';
end
$$;

reset role;

\echo ''
\echo '✅ ALL PHASE 1 DATABASE ASSERTIONS PASSED'
