-- ─────────────────────────────────────────────────────────────────────────
-- RestroNex Phase 2 — SECURITY TEST MATRIX
-- Runs after assertions.sql + assertions-phase2.sql on the same fixtures:
--   alice  owner of Tenant A (business cccc…01; outlets: main, branch)
--   bob    owner of Tenant B (business dddd…02; outlet: main)
--   carol  waiter in Tenant A, grant on outlet "main" only
-- Every numbered section maps to the Phase 2 prompt's required tests.
-- Every check MUST be denied (0 rows / false / SQLSTATE 42501).
-- ─────────────────────────────────────────────────────────────────────────

\echo '════════ SECURITY TEST MATRIX ════════'

-- ══ TEST 1 — Tenant A READING Tenant B ───────────────────────────────────
set role authenticated;
select set_config('request.jwt.claims',
  '{"sub": "aaaaaaaa-0000-0000-0000-000000000001", "role": "authenticated"}', false);

\echo '── TEST 1: Tenant A reading Tenant B'
do $$
declare
  n int;
  ok boolean;
begin
  select count(*) into n from public.businesses
  where id = 'dddddddd-0000-0000-0000-000000000002';
  if n <> 0 then raise exception 'T1 FAIL: businesses readable cross-tenant'; end if;

  select count(*) into n from public.outlets
  where business_id = 'dddddddd-0000-0000-0000-000000000002';
  if n <> 0 then raise exception 'T1 FAIL: outlets readable cross-tenant'; end if;

  select count(*) into n from public.memberships
  where business_id = 'dddddddd-0000-0000-0000-000000000002';
  if n <> 0 then raise exception 'T1 FAIL: memberships readable cross-tenant'; end if;

  select count(*) into n from public.user_profiles
  where id = 'bbbbbbbb-0000-0000-0000-000000000002';
  if n <> 0 then raise exception 'T1 FAIL: foreign profile readable'; end if;

  select count(*) into n from public.business_settings
  where business_id = 'dddddddd-0000-0000-0000-000000000002';
  if n <> 0 then raise exception 'T1 FAIL: foreign settings readable'; end if;

  select public.has_business_access('dddddddd-0000-0000-0000-000000000002') into ok;
  if ok then raise exception 'T1 FAIL: has_business_access true cross-tenant'; end if;

  if exists (
    select 1 from public.accessible_outlet_ids() x
    join public.outlets o on o.id = x
    where o.business_id = 'dddddddd-0000-0000-0000-000000000002'
  ) then raise exception 'T1 FAIL: foreign outlets in accessible set'; end if;

  raise notice 'T1 DENIED: all read paths (tables, roster, profile, settings, RPCs)';
end
$$;
reset role;

-- ══ TEST 2 — Tenant A MODIFYING Tenant B ─────────────────────────────────
set role authenticated;
select set_config('request.jwt.claims',
  '{"sub": "aaaaaaaa-0000-0000-0000-000000000001", "role": "authenticated"}', false);

\echo '── TEST 2: Tenant A modifying Tenant B'
do $$
declare
  n int;
begin
  update public.businesses set name = 'pwned'
  where id = 'dddddddd-0000-0000-0000-000000000002';
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'T2 FAIL: foreign business updated'; end if;

  update public.outlets set name = 'pwned'
  where business_id = 'dddddddd-0000-0000-0000-000000000002';
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'T2 FAIL: foreign outlets updated'; end if;

  update public.memberships set role = 'owner'
  where business_id = 'dddddddd-0000-0000-0000-000000000002';
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'T2 FAIL: foreign memberships updated'; end if;

  delete from public.businesses
  where id = 'dddddddd-0000-0000-0000-000000000002';
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'T2 FAIL: foreign business deleted'; end if;

  delete from public.outlets
  where business_id = 'dddddddd-0000-0000-0000-000000000002';
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'T2 FAIL: foreign outlets deleted'; end if;

  begin
    insert into public.outlets (business_id, name, slug, currency_code)
    values ('dddddddd-0000-0000-0000-000000000002', 'rogue', 'rogue', 'INR');
    raise exception 'T2 FAIL: outlet inserted into foreign tenant';
  exception when insufficient_privilege then null;
  end;

  begin
    insert into public.memberships (user_id, business_id, role)
    values ('aaaaaaaa-0000-0000-0000-000000000001',
            'dddddddd-0000-0000-0000-000000000002', 'owner');
    raise exception 'T2 FAIL: self-inserted into foreign tenant';
  exception when insufficient_privilege then null;
  end;

  raise notice 'T2 DENIED: update/delete are no-ops, inserts hit RLS 42501';
end
$$;
reset role;

-- ══ TEST 3 — Unauthorised outlet access ──────────────────────────────────
set role authenticated;
select set_config('request.jwt.claims',
  '{"sub": "eeeeeeee-0000-0000-0000-000000000003", "role": "authenticated"}', false);

\echo '── TEST 3: user accessing unauthorised outlet'
do $$
declare
  branch_id uuid;
  n int;
begin
  select id into branch_id from public.outlets where slug = 'branch'
    and business_id = 'cccccccc-0000-0000-0000-000000000001';

  -- carol (waiter, granted "main" only) must not operate in "branch"
  if public.has_outlet_access(branch_id) then
    raise exception 'T3 FAIL: ungranted outlet accessible';
  end if;
  select count(*) into n from public.accessible_outlet_ids();
  if n <> 1 then raise exception 'T3 FAIL: accessible set size % (expected 1)', n; end if;
  raise notice 'T3a DENIED: waiter blocked from ungranted outlet in own tenant';
end
$$;
reset role;

set role authenticated;
select set_config('request.jwt.claims',
  '{"sub": "bbbbbbbb-0000-0000-0000-000000000002", "role": "authenticated"}', false);

do $$
declare
  a_main uuid;
  a_branch uuid;
begin
  -- bob owns Tenant B: even OWNER rights stop at the tenant boundary
  select id into a_main from public.outlets where slug = 'main'
    and business_id = 'cccccccc-0000-0000-0000-000000000001';
  select id into a_branch from public.outlets where slug = 'branch'
    and business_id = 'cccccccc-0000-0000-0000-000000000001';

  if public.has_outlet_access(a_main) or public.has_outlet_access(a_branch) then
    raise exception 'T3 FAIL: owner crossed tenant boundary into Tenant A outlets';
  end if;
  raise notice 'T3b DENIED: foreign owner blocked from Tenant A outlets';
end
$$;
reset role;

-- ══ TEST 4 — Invalid tenant / outlet IDs ─────────────────────────────────
set role authenticated;
select set_config('request.jwt.claims',
  '{"sub": "aaaaaaaa-0000-0000-0000-000000000001", "role": "authenticated"}', false);

\echo '── TEST 4: invalid tenant IDs'
do $$
declare
  n int;
  ok boolean;
begin
  select public.has_business_access('00000000-0000-0000-0000-000000000000') into ok;
  if ok then raise exception 'T4 FAIL: phantom business accepted'; end if;

  select public.has_outlet_access('00000000-0000-0000-0000-000000000000') into ok;
  if ok then raise exception 'T4 FAIL: phantom outlet accepted'; end if;

  select count(*) into n from public.businesses
  where id = '00000000-0000-0000-0000-000000000000';
  if n <> 0 then raise exception 'T4 FAIL: phantom business row found'; end if;

  update public.businesses set name = 'x'
  where id = '00000000-0000-0000-0000-000000000000';
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'T4 FAIL: phantom business updated'; end if;

  raise notice 'T4 DENIED: phantom/invalid ids rejected by every path';
end
$$;
reset role;

-- ══ TEST 5 — Forged request parameters ───────────────────────────────────
set role authenticated;
select set_config('request.jwt.claims',
  '{"sub": "eeeeeeee-0000-0000-0000-000000000003", "role": "authenticated"}', false);

\echo '── TEST 5: forged request parameters'
do $$
declare
  n int;
begin
  -- (a) self-membership re-pointed at another tenant
  begin
    update public.memberships
    set business_id = 'dddddddd-0000-0000-0000-000000000002'
    where user_id = auth.uid();
    raise exception 'T5 FAIL: membership re-pointed to foreign tenant';
  exception when insufficient_privilege then null;
  end;

  -- (b) self role-escalation to owner
  begin
    update public.memberships set role = 'owner' where user_id = auth.uid();
    raise exception 'T5 FAIL: self role escalation allowed';
  exception when insufficient_privilege then null;
  end;

  -- (c) legitimate self-status change still works (not over-restricted)
  update public.memberships set status = 'deactivated' where user_id = auth.uid();
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'T5 FAIL: legitimate self-status update broken'; end if;
  update public.memberships set status = 'active' where user_id = auth.uid();
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'T5 FAIL: could not restore membership status'; end if;

  raise notice 'T5 DENIED: forged business_id/role blocked; legitimate status update intact';
end
$$;

do $$
begin
  -- (d) profile hijack attempt: adopting another user's unique email
  begin
    update public.user_profiles set email = 'bob@example.com'
    where id = auth.uid();
    raise exception 'T5 FAIL: duplicate email accepted';
  exception when unique_violation then null;
  end;
  raise notice 'T5 DENIED: unique constraints back the profile policy';
end
$$;
reset role;

-- ══ TEST 6 — Direct database queries attempting cross-tenant access ──────
\echo '── TEST 6: direct database queries (role-switch, as PostgREST would)'

-- (a) anonymous direct SQL
set role anon;
do $$
declare
  n int;
begin
  select count(*) into n from public.businesses;
  if n <> 0 then raise exception 'T6 FAIL: anon direct read returned rows'; end if;

  begin
    insert into public.memberships (user_id, business_id, role)
    values ('aaaaaaaa-0000-0000-0000-000000000001',
            'cccccccc-0000-0000-0000-000000000001', 'owner');
    raise exception 'T6 FAIL: anon direct insert allowed';
  exception when insufficient_privilege then null;
  end;
  raise notice 'T6a DENIED: anon direct SQL read/write';
end
$$;
reset role;

-- (b) Tenant B directly attacking Tenant A rows by known id
set role authenticated;
select set_config('request.jwt.claims',
  '{"sub": "bbbbbbbb-0000-0000-0000-000000000002", "role": "authenticated"}', false);
do $$
declare
  n int;
begin
  update public.businesses set name = 'pwned' where slug = 'tenant-a';
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'T6 FAIL: direct cross-tenant update by slug'; end if;

  delete from public.memberships
  where user_id = 'aaaaaaaa-0000-0000-0000-000000000001';
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'T6 FAIL: direct delete of foreign membership'; end if;

  select count(*) into n from public.user_profiles
  where email = 'alice@example.com';
  if n <> 0 then raise exception 'T6 FAIL: foreign profile leaked via direct SQL'; end if;
  raise notice 'T6b DENIED: direct SQL cross-tenant attack (known slugs/ids/emails)';
end
$$;
reset role;

-- (c) direct SQL against the platform (Super Admin) schema
set role authenticated;
do $$
begin
  begin
    perform 1 from platform.super_admins;
    raise exception 'T6 FAIL: direct SQL reached platform.super_admins';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into platform.super_admins (user_id)
    values ('aaaaaaaa-0000-0000-0000-000000000001');
    raise exception 'T6 FAIL: self-promoted to super admin';
  exception when insufficient_privilege then null;
  end;
  raise notice 'T6c DENIED: direct SQL cannot reach or write platform/Super Admin';
end
$$;
reset role;

\echo ''
\echo '✅ SECURITY MATRIX COMPLETE: ALL 6 REQUIRED ATTACK CLASSES DENIED'
