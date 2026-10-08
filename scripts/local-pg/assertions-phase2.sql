-- ─────────────────────────────────────────────────────────────────────────
-- RestroNex Phase 2 assertions: outlet-level access & tenant resolution.
-- Runs after assertions.sql (same fixtures: alice owns Tenant A, bob owns
-- Tenant B; each tenant has one outlet named "main").
-- ─────────────────────────────────────────────────────────────────────────

-- ── Fixtures ───────────────────────────────────────────────────────────────
-- carol: waiter in Tenant A (restricted role, no outlet grants yet)
insert into auth.users (id, email, raw_user_meta_data) values
  ('eeeeeeee-0000-0000-0000-000000000003', 'carol@example.com', '{"full_name": "Carol Waiter"}');

insert into public.memberships (user_id, business_id, role) values
  ('eeeeeeee-0000-0000-0000-000000000003', 'cccccccc-0000-0000-0000-000000000001', 'waiter');

-- second outlet for Tenant A to prove per-outlet granularity
insert into public.outlets (id, business_id, name, slug, currency_code) values
  ('ffffffff-0000-0000-0000-0000000000a2', 'cccccccc-0000-0000-0000-000000000001', 'Tenant A Branch', 'branch', 'INR');

\echo '── Structure: membership_outlets protected'
do $$
begin
  if not exists (
    select 1 from pg_class c
    where c.relname = 'membership_outlets'
      and c.relnamespace = 'public'::regnamespace
      and c.relrowsecurity
  ) then
    raise exception 'membership_outlets missing or RLS disabled';
  end if;
  raise notice 'OK: membership_outlets exists with RLS enabled';
end
$$;

-- ── carol (waiter, no grants): cannot operate in any outlet ───────────────
set role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub": "eeeeeeee-0000-0000-0000-000000000003", "role": "authenticated"}',
  false
);

\echo '── Outlet access: restricted role without grants gets nothing'
do $$
declare
  main_id uuid;
begin
  select id into main_id from public.outlets where slug = 'main'
    and business_id = 'cccccccc-0000-0000-0000-000000000001';

  if public.has_outlet_access(main_id) then
    raise exception 'OUTLET FAIL: carol can operate in main without a grant';
  end if;
  if public.has_outlet_access('ffffffff-0000-0000-0000-0000000000a2') then
    raise exception 'OUTLET FAIL: carol can operate in branch without a grant';
  end if;
  if exists (select 1 from public.accessible_outlet_ids()) then
    raise exception 'OUTLET FAIL: accessible_outlet_ids not empty for carol';
  end if;
  raise notice 'OK: waiter with no grants has zero outlet access';
end
$$;

-- carol still SEES both outlets of her business (outlet switcher visibility)
do $$
declare
  n int;
begin
  select count(*) into n from public.outlets;
  if n <> 2 then raise exception 'VISIBILITY FAIL: carol sees % outlets, expected 2', n; end if;
  raise notice 'OK: business-scoped outlet visibility intact (2 outlets)';
end
$$;

reset role;

-- Grant carol access to the main outlet only (service-side action). The main
-- outlet was created with a generated id, so resolve it dynamically.
insert into public.membership_outlets (membership_id, outlet_id, granted_by)
select m.id, o.id, 'aaaaaaaa-0000-0000-0000-000000000001'
from public.memberships m
join public.outlets o
  on o.business_id = m.business_id and o.slug = 'main'
where m.user_id = 'eeeeeeee-0000-0000-0000-000000000003'
  and m.business_id = 'cccccccc-0000-0000-0000-000000000001';

set role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub": "eeeeeeee-0000-0000-0000-000000000003", "role": "authenticated"}',
  false
);

\echo '── Outlet access: explicit grant unlocks exactly one outlet'
do $$
declare
  main_id uuid;
  ids uuid[];
begin
  select id into main_id from public.outlets where slug = 'main'
    and business_id = 'cccccccc-0000-0000-0000-000000000001';

  if not public.has_outlet_access(main_id) then
    raise exception 'OUTLET FAIL: granted outlet not accessible';
  end if;
  if public.has_outlet_access('ffffffff-0000-0000-0000-0000000000a2') then
    raise exception 'OUTLET FAIL: ungranted outlet accessible';
  end if;

  select array_agg(x) into ids from public.accessible_outlet_ids() x;
  if ids is distinct from array[main_id] then
    raise exception 'OUTLET FAIL: accessible set is %', ids;
  end if;
  raise notice 'OK: grant unlocks exactly the granted outlet';
end
$$;

\echo '── Outlet access: no cross-tenant outlet access'
do $$
declare
  b_outlet uuid;
begin
  select id into b_outlet from public.outlets
  where business_id = 'dddddddd-0000-0000-0000-000000000002' limit 1;
  if public.has_outlet_access(b_outlet) then
    raise exception 'SECURITY FAIL: carol can operate a Tenant B outlet';
  end if;
  raise notice 'OK: Tenant B outlets inaccessible to Tenant A member';
end
$$;

reset role;

-- ── alice (owner): implicit access to every outlet of Tenant A only ───────
set role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub": "aaaaaaaa-0000-0000-0000-000000000001", "role": "authenticated"}',
  false
);

\echo '── Outlet access: owner role implies all outlets of own business'
do $$
declare
  n int;
  b_outlet uuid;
begin
  select count(*) into n from public.accessible_outlet_ids();
  if n <> 2 then raise exception 'OWNER FAIL: alice accesses % outlets, expected 2', n; end if;

  select id into b_outlet from public.outlets
  where business_id = 'dddddddd-0000-0000-0000-000000000002' limit 1;
  if public.has_outlet_access(b_outlet) then
    raise exception 'SECURITY FAIL: owner crossed tenant boundary';
  end if;
  raise notice 'OK: owner has all own-business outlets, none cross-tenant';
end
$$;

\echo '── Outlet access: unknown outlets are rejected'
do $$
begin
  if public.has_outlet_access('00000000-0000-0000-0000-000000000099') then
    raise exception 'SECURITY FAIL: phantom outlet accessible';
  end if;
  raise notice 'OK: non-existent outlet ids deny access';
end
$$;

reset role;

-- ── Grant table: no client writes, scoped reads ────────────────────────────
set role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub": "eeeeeeee-0000-0000-0000-000000000003", "role": "authenticated"}',
  false
);

\echo '── Grants: members see own-business grants only, inserts denied'
do $$
declare
  n int;
begin
  select count(*) into n from public.membership_outlets;
  if n <> 1 then raise exception 'GRANT VISIBILITY FAIL: carol sees % grant rows, expected 1', n; end if;

  begin
    insert into public.membership_outlets (membership_id, outlet_id)
    select m.id, 'ffffffff-0000-0000-0000-0000000000a2'
    from public.memberships m where m.user_id = auth.uid();
    raise exception 'SECURITY FAIL: client inserted its own outlet grant';
  exception when insufficient_privilege then
    raise notice 'OK: grant rows read-scoped, client inserts denied (42501)';
  end;
end
$$;

reset role;

\echo ''
\echo '✅ ALL PHASE 2 OUTLET-ACCESS ASSERTIONS PASSED'
