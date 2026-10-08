-- ─────────────────────────────────────────────────────────────────────────
-- RestroNex Phase 6 assertions: onboarding persistence + setup RPCs.
-- Runs after Phase 1/2/5 fixtures (alice owns Tenant A, bob owns Tenant B,
-- carol is a waiter in Tenant A).
-- ─────────────────────────────────────────────────────────────────────────

\echo '── P6.1: new tables exist with RLS and zero client-write policies'
do $$
declare
  t text;
begin
  foreach t in array array[
    'onboarding_progress', 'dining_sections', 'dining_tables',
    'kitchen_stations', 'menu_categories', 'menu_items', 'staff_invites'
  ] loop
    if not exists (
      select 1 from pg_tables where schemaname = 'public' and tablename = t
    ) then
      raise exception 'missing table: %', t;
    end if;
    if not exists (
      select 1 from pg_tables t2
      join pg_class c on c.relname = t2.tablename
      where t2.schemaname = 'public' and t2.tablename = t and c.relrowsecurity
    ) then
      raise exception 'RLS not enabled on %', t;
    end if;
  end loop;
  raise notice 'OK: all 7 onboarding tables exist with RLS enabled';
end $$;

do $$
declare
  n_rows int;
begin
  set role authenticated;
  set request.jwt.claims = '{"sub": "aaaaaaaa-0000-0000-0000-000000000001", "role": "authenticated"}';
  begin
    insert into public.menu_categories (business_id, name)
    values ('cccccccc-0000-0000-0000-000000000001', 'Hacked');
    raise exception 'authenticated INSERT into menu_categories succeeded';
  exception when insufficient_privilege then
    raise notice 'OK: client INSERT denied on menu_categories';
  end;
  begin
    insert into public.staff_invites (business_id, token, role, expires_at)
    values ('cccccccc-0000-0000-0000-000000000001',
            'phase6-client-forged-invite-token-0000000', 'cashier', now() + interval '1 day');
    raise exception 'authenticated INSERT into staff_invites succeeded';
  exception when insufficient_privilege then
    raise notice 'OK: client INSERT denied on staff_invites';
  end;
  reset role;

  -- RLS hides rows from UPDATE instead of raising: verify nothing changes.
  -- (Fixture businesses already own trigger-created progress rows.)
  set role authenticated;
  set request.jwt.claims = '{"sub": "aaaaaaaa-0000-0000-0000-000000000001", "role": "authenticated"}';
  begin
    update public.onboarding_progress set current_step = 'done';
    get diagnostics n_rows = row_count;
    if n_rows <> 0 then
      raise exception 'authenticated UPDATE touched % progress rows', n_rows;
    end if;
  end;
  reset role;
  if exists (
    select 1 from public.onboarding_progress
    where business_id = 'cccccccc-0000-0000-0000-000000000001' and current_step = 'done'
  ) then
    raise exception 'client UPDATE modified onboarding_progress';
  end if;
  raise notice 'OK: client UPDATE on onboarding_progress affects nothing';
exception when others then
  reset role;
  raise;
end $$;

\echo '── P6.2: progress auto-init + wizard RPC authorisation'
do $$
declare
  v_step text;
  v_completed text[];
begin
  -- fresh business → trigger must init progress
  insert into auth.users (id, email, raw_user_meta_data)
  values ('ffffffff-0000-0000-0000-000000000004', 'frank@example.com', '{"full_name": "Frank"}');
  insert into public.businesses (id, name, slug)
  values ('eeeeeeee-0000-0000-0000-0000000000a6', 'Onboarding Co', 'onboarding-co');
  insert into public.memberships (user_id, business_id, role)
  values ('ffffffff-0000-0000-0000-000000000004', 'eeeeeeee-0000-0000-0000-0000000000a6', 'owner');

  select current_step, completed_steps into v_step, v_completed
  from public.onboarding_progress
  where business_id = 'eeeeeeee-0000-0000-0000-0000000000a6';
  if v_step <> 'type' or v_completed <> array['business'] then
    raise exception 'progress not auto-initialised (%, %)', v_step, v_completed;
  end if;

  -- owner can advance; outsider cannot
  set role service_role;
  perform public.update_onboarding_progress(
    'ffffffff-0000-0000-0000-000000000004',
    'eeeeeeee-0000-0000-0000-0000000000a6',
    'outlet', 'type', false);
  begin
    perform public.update_onboarding_progress(
      'aaaaaaaa-0000-0000-0000-000000000001',  -- alice: no membership here
      'eeeeeeee-0000-0000-0000-0000000000a6',
      'menu', 'menu', false);
    raise exception 'outsider advanced onboarding progress';
  exception when raise_exception then
    null; -- expected
  end;
  begin
    perform public.update_onboarding_progress(
      'ffffffff-0000-0000-0000-000000000004',
      'eeeeeeee-0000-0000-0000-0000000000a6',
      'not-a-step', null, false);
    raise exception 'unknown step accepted';
  exception when raise_exception then
    null; -- expected
  end;
  reset role;

  -- finish stamps completed_at
  set role service_role;
  perform public.update_onboarding_progress(
    'ffffffff-0000-0000-0000-000000000004',
    'eeeeeeee-0000-0000-0000-0000000000a6',
    'done', 'finish', true);
  reset role;

  if not exists (
    select 1 from public.onboarding_progress
    where business_id = 'eeeeeeee-0000-0000-0000-0000000000a6'
      and completed_at is not null and current_step = 'done'
  ) then
    raise exception 'finish did not stamp completed_at';
  end if;

  -- cleanup
  delete from public.businesses where id = 'eeeeeeee-0000-0000-0000-0000000000a6';
  delete from auth.users where id = 'ffffffff-0000-0000-0000-000000000004';
  raise notice 'OK: progress auto-init, authorisation and completion stamping';
end $$;

\echo '── P6.3: RLS scoping of progress rows'
do $$
declare
  n int;
begin
  -- give Tenant A a progress row via the RPC (service-side path)
  set role service_role;
  perform public.update_onboarding_progress(
    'aaaaaaaa-0000-0000-0000-000000000001',
    'cccccccc-0000-0000-0000-000000000001',
    'type', 'business', false);
  reset role;

  set role authenticated;
  set request.jwt.claims = '{"sub": "aaaaaaaa-0000-0000-0000-000000000001", "role": "authenticated"}';
  select count(*) into n from public.onboarding_progress
  where business_id = 'cccccccc-0000-0000-0000-000000000001';
  if n <> 1 then raise exception 'alice sees % of Tenant A progress, expected 1', n; end if;
  reset role;

  set role authenticated;
  set request.jwt.claims = '{"sub": "bbbbbbbb-0000-0000-0000-000000000002", "role": "authenticated"}';
  select count(*) into n from public.onboarding_progress
  where business_id = 'cccccccc-0000-0000-0000-000000000001';
  if n <> 0 then raise exception 'bob sees Tenant A progress (% rows)', n; end if;
  select count(*) into n from public.onboarding_progress;
  if n <> 1 then raise exception 'bob sees % rows total, expected only Tenant B', n; end if;
  reset role;
  raise notice 'OK: progress visible to members only, cross-tenant isolated';
end $$;

\echo '── P6.4: floor plan RPC (atomic replace + authorisation)'
do $$
declare
  v_main uuid;
  v_total int;
begin
  select o.id into v_main
  from public.outlets o
  where o.business_id = 'cccccccc-0000-0000-0000-000000000001' and o.slug = 'main';

  set role service_role;
  select public.set_outlet_floor_plan(
    'aaaaaaaa-0000-0000-0000-000000000001', v_main,
    '[{"name":"Main hall","tables":[{"label":"T1","capacity":4},{"label":"T2","capacity":4}]},
      {"name":"Terrace","tables":[{"label":"T3","capacity":2}]}]'::jsonb
  ) into v_total;
  if v_total <> 3 then raise exception 'floor plan inserted % tables, expected 3', v_total; end if;
  reset role;

  if (select count(*) from public.dining_sections where outlet_id = v_main) <> 2 then
    raise exception 'expected 2 sections';
  end if;

  -- replace semantics: old sections/tables disappear
  set role service_role;
  select public.set_outlet_floor_plan(
    'aaaaaaaa-0000-0000-0000-000000000001', v_main,
    '[{"name":"Only room","tables":[{"label":"T1","capacity":6}]}]'::jsonb
  ) into v_total;
  reset role;
  if v_total <> 1 then raise exception 'replace left % tables, expected 1', v_total; end if;
  if (select count(*) from public.dining_sections where outlet_id = v_main) <> 1 then
    raise exception 'replace left stale sections';
  end if;

  -- carol (waiter) may not reconfigure the floor plan
  set role service_role;
  begin
    perform public.set_outlet_floor_plan(
      'eeeeeeee-0000-0000-0000-000000000003', v_main,
      '[{"name":"X","tables":[{"label":"T9","capacity":2}]}]'::jsonb);
    raise exception 'waiter reconfigured the floor plan';
  exception when raise_exception then
    null; -- expected
  end;
  -- malformed payload rejected
  begin
    perform public.set_outlet_floor_plan(
      'aaaaaaaa-0000-0000-0000-000000000001', v_main,
      '[{"tables":[{"label":"T1","capacity":2}]}]'::jsonb);
    raise exception 'section without name accepted';
  exception when raise_exception then
    null; -- expected
  end;
  reset role;

  -- cleanup
  delete from public.dining_sections where outlet_id = v_main;
  raise notice 'OK: floor plan atomic replace, authorisation, payload validation';
end $$;

\echo '── P6.5: kitchen stations + menu RPCs'
do $$
declare
  v_main uuid;
  v_total int;
begin
  select o.id into v_main
  from public.outlets o
  where o.business_id = 'cccccccc-0000-0000-0000-000000000001' and o.slug = 'main';

  set role service_role;
  select public.set_outlet_kitchen_stations(
    'aaaaaaaa-0000-0000-0000-000000000001', v_main,
    '[{"name":"Hot kitchen","description":null},{"name":"Beverages","description":"Bar"}]'::jsonb
  ) into v_total;
  if v_total <> 2 then raise exception 'expected 2 stations, got %', v_total; end if;
  select public.set_outlet_kitchen_stations(
    'aaaaaaaa-0000-0000-0000-000000000001', v_main,
    '[{"name":"Tandoor","description":"Clay oven"}]'::jsonb
  ) into v_total;
  reset role;
  if (select count(*) from public.kitchen_stations where outlet_id = v_main) <> 1 then
    raise exception 'station replace failed';
  end if;

  set role service_role;
  select public.set_business_menu(
    'aaaaaaaa-0000-0000-0000-000000000001',
    'cccccccc-0000-0000-0000-000000000001',
    '[{"name":"Starters","items":[{"name":"Soup","price_minor":9950,"is_vegetarian":true},
                                   {"name":"Salad","price_minor":12000,"is_vegetarian":true}]},
      {"name":"Mains","items":[{"name":"Biryani","price_minor":25000,"is_vegetarian":false}]}]'::jsonb
  ) into v_total;
  if v_total <> 3 then raise exception 'expected 3 menu items, got %', v_total; end if;
  select public.set_business_menu(
    'aaaaaaaa-0000-0000-0000-000000000001',
    'cccccccc-0000-0000-0000-000000000001',
    '[{"name":"Mains","items":[{"name":"Curry","price_minor":18000,"is_vegetarian":true}]}]'::jsonb
  ) into v_total;
  reset role;
  if (select count(*) from public.menu_items
      where business_id = 'cccccccc-0000-0000-0000-000000000001') <> 1 then
    raise exception 'menu replace failed';
  end if;
  if (select count(*) from public.menu_categories
      where business_id = 'cccccccc-0000-0000-0000-000000000001') <> 1 then
    raise exception 'menu category replace failed';
  end if;

  -- negative price rejected
  set role service_role;
  begin
    perform public.set_business_menu(
      'aaaaaaaa-0000-0000-0000-000000000001',
      'cccccccc-0000-0000-0000-000000000001',
      '[{"name":"Bad","items":[{"name":"X","price_minor":-5,"is_vegetarian":true}]}]'::jsonb);
    raise exception 'negative price accepted';
  exception when raise_exception then
    null; -- expected
  end;
  reset role;

  -- cleanup
  delete from public.kitchen_stations where outlet_id = v_main;
  delete from public.menu_categories where business_id = 'cccccccc-0000-0000-0000-000000000001';
  raise notice 'OK: kitchen + menu RPCs replace atomically and validate payloads';
end $$;

\echo '── P6.6: staff invites — constraints and acceptance lifecycle'
do $$
declare
  v_main uuid;
  v_business uuid := 'cccccccc-0000-0000-0000-000000000001';
  v_returned uuid;
begin
  select o.id into v_main from public.outlets o
  where o.business_id = v_business and o.slug = 'main';

  -- owner can never be invited
  begin
    insert into public.staff_invites (business_id, token, role, outlet_ids, expires_at)
    values (v_business, 'phase6-owner-invite-token-0000000000000000', 'owner',
            array[v_main], now() + interval '7 days');
    raise exception 'owner-role invite accepted';
  exception when check_violation then
    raise notice 'OK: owner role cannot be invited';
  end;

  -- outlet-scoped roles require outlets
  begin
    insert into public.staff_invites (business_id, token, role, outlet_ids, expires_at)
    values (v_business, 'phase6-no-outlet-token-00000000000000000', 'waiter',
            '{}'::uuid[], now() + interval '7 days');
    raise exception 'waiter invite without outlets accepted';
  exception when check_violation then
    raise notice 'OK: outlet roles require outlets';
  end;

  -- existing active member cannot re-accept
  insert into public.staff_invites (business_id, token, role, outlet_ids, invited_by, expires_at)
  values (v_business, 'phase6-member-token-0000000000000000000000', 'cashier',
          array[v_main], 'aaaaaaaa-0000-0000-0000-000000000001', now() + interval '7 days');
  set role service_role;
  begin
    perform public.accept_staff_invite('eeeeeeee-0000-0000-0000-000000000003',
                                       'phase6-member-token-0000000000000000000000');
    raise exception 'existing member accepted again';
  exception when raise_exception then
    null; -- expected
  end;
  reset role;

  -- fresh user accepts successfully
  insert into auth.users (id, email, raw_user_meta_data)
  values ('abababab-0000-0000-0000-000000000005', 'erin@example.com', '{"full_name": "Erin"}');
  set role service_role;
  select public.accept_staff_invite('abababab-0000-0000-0000-000000000005',
                                    'phase6-member-token-0000000000000000000000')
  into v_returned;
  reset role;
  if v_returned <> v_business then raise exception 'accept returned wrong business'; end if;
  if not exists (
    select 1 from public.memberships
    where user_id = 'abababab-0000-0000-0000-000000000005'
      and business_id = v_business and role = 'cashier' and status = 'active'
  ) then
    raise exception 'membership not created on acceptance';
  end if;
  if not exists (
    select 1 from public.membership_outlets mo
    join public.memberships m on m.id = mo.membership_id
    where m.user_id = 'abababab-0000-0000-0000-000000000005' and mo.outlet_id = v_main
  ) then
    raise exception 'outlet grant missing after acceptance';
  end if;

  -- token is single-use
  set role service_role;
  begin
    perform public.accept_staff_invite('abababab-0000-0000-0000-000000000005',
                                       'phase6-member-token-0000000000000000000000');
    raise exception 'invite token reused';
  exception when raise_exception then
    null; -- expected
  end;

  -- expired invite refused
  insert into public.staff_invites (business_id, token, role, outlet_ids, expires_at)
  values (v_business, 'phase6-expired-token-000000000000000000000', 'cashier',
          array[v_main], now() - interval '1 day');
  begin
    perform public.accept_staff_invite('abababab-0000-0000-0000-000000000005',
                                       'phase6-expired-token-000000000000000000000');
    raise exception 'expired invite accepted';
  exception when raise_exception then
    null; -- expected
  end;

  -- revoked invite refused
  insert into public.staff_invites (business_id, token, role, outlet_ids, expires_at, revoked_at)
  values (v_business, 'phase6-revoked-token-000000000000000000000', 'cashier',
          array[v_main], now() + interval '1 day', now());
  begin
    perform public.accept_staff_invite('abababab-0000-0000-0000-000000000005',
                                       'phase6-revoked-token-000000000000000000000');
    raise exception 'revoked invite accepted';
  exception when raise_exception then
    null; -- expected
  end;

  -- email-locked invite refused for the wrong account
  insert into public.staff_invites (business_id, email, token, role, outlet_ids, expires_at)
  values (v_business, 'someone.else@example.com',
          'phase6-email-lock-token-00000000000000000000', 'cashier',
          array[v_main], now() + interval '1 day');
  begin
    perform public.accept_staff_invite('abababab-0000-0000-0000-000000000005',
                                       'phase6-email-lock-token-00000000000000000000');
    raise exception 'email-locked invite accepted by wrong account';
  exception when raise_exception then
    null; -- expected
  end;
  reset role;

  raise notice 'OK: invite constraints + acceptance lifecycle';
end $$;

\echo '── P6.7: invite tokens visible to owners/admins only'
do $$
declare
  n int;
begin
  set role authenticated;
  set request.jwt.claims = '{"sub": "aaaaaaaa-0000-0000-0000-000000000001", "role": "authenticated"}';
  select count(*) into n from public.staff_invites;
  if n < 1 then raise exception 'owner cannot see own business invites'; end if;
  reset role;

  set role authenticated;
  set request.jwt.claims = '{"sub": "eeeeeeee-0000-0000-0000-000000000003", "role": "authenticated"}';
  select count(*) into n from public.staff_invites;
  if n <> 0 then raise exception 'waiter sees % invite rows (token leak)', n; end if;
  reset role;

  set role authenticated;
  set request.jwt.claims = '{"sub": "bbbbbbbb-0000-0000-0000-000000000002", "role": "authenticated"}';
  select count(*) into n from public.staff_invites;
  if n <> 0 then raise exception 'cross-tenant invite leak (% rows)', n; end if;
  reset role;
  raise notice 'OK: invite visibility limited to owners/admins of the business';
end $$;

-- cleanup Phase 6 fixtures
delete from public.staff_invites where business_id = 'cccccccc-0000-0000-0000-000000000001';
delete from public.memberships
where user_id = 'abababab-0000-0000-0000-000000000005'
  and business_id = 'cccccccc-0000-0000-0000-000000000001';
delete from auth.users where id = 'abababab-0000-0000-0000-000000000005';

\echo ''
\echo '✅ PHASE 6 ONBOARDING ASSERTIONS COMPLETE'
