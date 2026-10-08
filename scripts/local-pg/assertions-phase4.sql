-- ─────────────────────────────────────────────────────────────────────────
-- RestroNex Phase 4 assertions: business + outlet management schema.
-- Runs after the Phase 1/2 fixtures exist (alice owns Tenant A
-- cccccccc-...-0001, bob owns Tenant B dddddddd-...-0002).
-- ─────────────────────────────────────────────────────────────────────────

\echo '── P4.1: slugify strips diacritics (unaccent)'
do $$
begin
  if public.slugify('Café Déli!!!') <> 'cafe-deli' then
    raise exception 'slugify diacritics failed: %', public.slugify('Café Déli!!!');
  end if;
  if public.slugify('   ') <> '' then
    raise exception 'slugify whitespace handling changed: %', public.slugify('   ');
  end if;
  raise notice 'OK: slugify folds accents; blank input handled by create_business fallback';
end $$;

\echo '── P4.2: create_business RPC is atomic + owner membership + settings row'
do $$
declare
  v_new uuid;
begin
  v_new := public.create_business(
    'aaaaaaaa-0000-0000-0000-000000000001',          -- alice
    'Phase Four Café', 'cafe', 'INR', 'Asia/Kolkata',
    'owner@phase4.example', '+91 44 0000 0000',
    '1 Test Street', null, 'Chennai', 'Tamil Nadu', '600001', 'India',
    '33PHASE4TEST1Z5', null
  );

  if not exists (select 1 from public.businesses where id = v_new and name = 'Phase Four Café') then
    raise exception 'business row missing after RPC';
  end if;
  if not exists (
    select 1 from public.memberships
    where user_id = 'aaaaaaaa-0000-0000-0000-000000000001'
      and business_id = v_new and role = 'owner' and status = 'active'
  ) then
    raise exception 'owner membership missing after RPC';
  end if;
  if not exists (select 1 from public.business_settings where business_id = v_new) then
    raise exception 'business_settings row missing after RPC';
  end if;
  raise notice 'OK: create_business created business + owner membership + settings';

  -- slug collision: same name → different slug, no error
  declare
    v_second uuid;
    v_slug_1 text; v_slug_2 text;
  begin
    select slug into v_slug_1 from public.businesses where id = v_new;
    v_second := public.create_business(
      'aaaaaaaa-0000-0000-0000-000000000001',
      'Phase Four Café', 'cafe', 'INR', 'Asia/Kolkata'
    );
    select slug into v_slug_2 from public.businesses where id = v_second;
    if v_slug_1 = v_slug_2 then
      raise exception 'slug collision not resolved: %', v_slug_1;
    end if;
    raise notice 'OK: duplicate names resolved with distinct slugs (%, %)', v_slug_1, v_slug_2;
  end;

  -- unknown owner rejected
  begin
    perform public.create_business(
      '99999999-9999-9999-9999-999999999999',
      'Ghost Owner', 'other', 'INR', 'UTC'
    );
    raise exception 'RPC accepted an owner that does not exist';
  exception when others then
    if sqlstate = 'P0001' and sqlerrm like '%owner does not exist%' then
      raise notice 'OK: unknown owner rejected';
    else
      raise;
    end if;
  end;

  -- cleanup phase-4 businesses (keep the tenant fixtures intact)
  delete from public.businesses where id in (v_new);
  delete from public.businesses where name = 'Phase Four Café';
end $$;

\echo '── P4.3: create_business revoked from API roles'
do $$
begin
  set role authenticated;
  begin
    perform public.create_business(
      'aaaaaaaa-0000-0000-0000-000000000001', 'X', 'other', 'INR', 'UTC'
    );
    raise exception 'authenticated role could call create_business directly';
  exception when insufficient_privilege then
    raise notice 'OK: authenticated role cannot call create_business';
  end;
  reset role;
exception when others then
  reset role;
  raise;
end $$;

\echo '── P4.4: outlet constraints (code, order types, hours)'
do $$
declare
  v_outlet uuid := '12121212-0000-0000-0000-000000000401';
begin
  -- valid insert with all Phase 4 columns
  insert into public.outlets (
    id, business_id, name, slug, code, currency_code,
    order_types, operating_hours, address_line1, city, phone
  ) values (
    v_outlet, 'cccccccc-0000-0000-0000-000000000001',
    'Phase4 Outlet', 'phase4-outlet', 'OUT-01', 'INR',
    array['dine_in','takeaway'],
    '{"mon":{"open":"09:00","close":"22:00"},"sun":null}',
    '2 Test Road', 'Chennai', '+91 44 1111 2222'
  );
  raise notice 'OK: outlet accepted with Phase 4 columns';

  -- duplicate code within the same business
  begin
    insert into public.outlets (business_id, name, slug, code, currency_code)
    values ('cccccccc-0000-0000-0000-000000000001', 'Dup Code', 'dup-code', 'OUT-01', 'INR');
    raise exception 'duplicate outlet code accepted inside one business';
  exception when unique_violation then
    raise notice 'OK: duplicate outlet code rejected per business';
  end;

  -- same code allowed in a DIFFERENT business
  insert into public.outlets (business_id, name, slug, code, currency_code)
  values ('dddddddd-0000-0000-0000-000000000002', 'Other Biz Outlet', 'other-biz-outlet', 'OUT-01', 'INR');
  raise notice 'OK: same code allowed across different businesses';

  -- bad code formats
  begin
    insert into public.outlets (business_id, name, slug, code, currency_code)
    values ('cccccccc-0000-0000-0000-000000000001', 'Bad Code', 'bad-code', 'lower case!', 'INR');
    raise exception 'invalid outlet code format accepted';
  exception when check_violation then
    raise notice 'OK: invalid outlet code format rejected';
  end;

  -- order types: unknown value / empty list
  begin
    insert into public.outlets (business_id, name, slug, currency_code, order_types)
    values ('cccccccc-0000-0000-0000-000000000001', 'Bad Types', 'bad-types', 'INR', array['buffet']);
    raise exception 'unknown order type accepted';
  exception when check_violation then
    raise notice 'OK: unknown order type rejected';
  end;
  begin
    insert into public.outlets (business_id, name, slug, currency_code, order_types)
    values ('cccccccc-0000-0000-0000-000000000001', 'No Types', 'no-types', 'INR', array[]::text[]);
    raise exception 'empty order types accepted';
  exception when check_violation then
    raise notice 'OK: empty order types rejected';
  end;

  -- operating_hours must be an object
  begin
    insert into public.outlets (business_id, name, slug, currency_code, operating_hours)
    values ('cccccccc-0000-0000-0000-000000000001', 'Bad Hours', 'bad-hours', 'INR', '["9-5"]');
    raise exception 'non-object operating_hours accepted';
  exception when check_violation then
    raise notice 'OK: non-object operating_hours rejected';
  end;

  delete from public.outlets where id = v_outlet or slug in ('other-biz-outlet');
end $$;

\echo '── P4.5: business detail constraints'
do $$
begin
  begin
    insert into public.businesses (name, slug, currency_code) values ('Lower Currency', 'lower-currency', 'inr');
    raise exception 'lowercase currency accepted';
  exception when check_violation then
    raise notice 'OK: lowercase currency rejected';
  end;

  begin
    insert into public.businesses (name, slug, restaurant_type) values ('Bad Type', 'bad-type', 'space_food');
    raise exception 'unknown restaurant type accepted';
  exception when check_violation then
    raise notice 'OK: unknown restaurant type rejected';
  end;

  begin
    insert into public.businesses (name, slug, logo_url) values ('Bad Logo', 'bad-logo', 'javascript:alert(1)');
    raise exception 'non-http logo url accepted';
  exception when check_violation then
    raise notice 'OK: non-http logo URL rejected';
  end;

  begin
    insert into public.businesses (name, slug, tax_settings) values ('Bad Tax', 'bad-tax', '[1,2]');
    raise exception 'non-object tax_settings accepted';
  exception when check_violation then
    raise notice 'OK: non-object tax_settings rejected';
  end;
end $$;

\echo '── P4.6: client INSERT still blocked by RLS'
do $$
begin
  set role authenticated;
  set request.jwt.claims = '{"sub": "aaaaaaaa-0000-0000-0000-000000000001", "role": "authenticated"}';
  begin
    insert into public.businesses (name, slug) values ('Sneaky Tenant', 'sneaky-tenant');
    raise exception 'authenticated role inserted a business directly';
  exception when insufficient_privilege then
    raise notice 'OK: direct business INSERT still denied by RLS';
  end;
  begin
    insert into public.outlets (business_id, name, slug, currency_code)
    values ('cccccccc-0000-0000-0000-000000000001', 'Sneaky Outlet', 'sneaky-outlet', 'INR');
    raise exception 'authenticated role inserted an outlet directly';
  exception when insufficient_privilege then
    raise notice 'OK: direct outlet INSERT still denied by RLS';
  end;
  reset role;
exception when others then
  reset role;
  raise;
end $$;

\echo ''
\echo '✅ PHASE 4 SCHEMA ASSERTIONS COMPLETE'
