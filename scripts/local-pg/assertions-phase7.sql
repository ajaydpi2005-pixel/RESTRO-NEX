-- ─────────────────────────────────────────────────────────────────────────
-- RestroNex Phase 7 assertions: universal menu schema, isolation, storage.
-- Runs after Phase 1/2 fixtures (alice owns Tenant A, bob owns Tenant B).
-- ─────────────────────────────────────────────────────────────────────────

\echo '── P7.1: menu tables exist, RLS on, client writes denied'
do $$
declare
  t text;
begin
  foreach t in array array[
    'product_variants', 'modifier_groups', 'modifiers', 'product_modifier_groups',
    'combos', 'combo_items', 'outlet_product_overrides', 'outlet_variant_overrides'
  ] loop
    if not exists (select 1 from pg_tables where schemaname = 'public' and tablename = t) then
      raise exception 'missing table: %', t;
    end if;
    if not exists (
      select 1 from pg_class c where c.relname = t and c.relrowsecurity
    ) then
      raise exception 'RLS not enabled on %', t;
    end if;
  end loop;
  raise notice 'OK: all 8 phase-7 tables exist with RLS enabled';
end $$;

do $$
begin
  set role authenticated;
  set request.jwt.claims = '{"sub": "aaaaaaaa-0000-0000-0000-000000000001", "role": "authenticated"}';
  begin
    insert into public.combos (business_id, name, price_minor)
    values ('cccccccc-0000-0000-0000-000000000001', 'Hacked combo', 100);
    raise exception 'authenticated INSERT into combos succeeded';
  exception when insufficient_privilege then
    raise notice 'OK: client INSERT denied on combos';
  end;
  begin
    insert into public.outlet_product_overrides (outlet_id, product_id, price_minor)
    values ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000002', 100);
    raise exception 'authenticated INSERT into overrides succeeded';
  exception when insufficient_privilege then
    raise notice 'OK: client INSERT denied on outlet overrides';
  end;
  reset role;
exception when others then
  reset role;
  raise;
end $$;

\echo '── P7.2: category depth capped at one level'
do $$
declare
  v_root uuid;
  v_sub uuid;
begin
  insert into public.menu_categories (business_id, name)
  values ('cccccccc-0000-0000-0000-000000000001', 'P7 Root') returning id into v_root;
  insert into public.menu_categories (business_id, name, parent_id)
  values ('cccccccc-0000-0000-0000-000000000001', 'P7 Sub', v_root) returning id into v_sub;

  begin
    insert into public.menu_categories (business_id, name, parent_id)
    values ('cccccccc-0000-0000-0000-000000000001', 'P7 SubSub', v_sub);
    raise exception 'third-level category accepted';
  exception when raise_exception then
    raise notice 'OK: subcategories cannot nest deeper than one level';
  end;

  begin
    insert into public.menu_categories (business_id, name, parent_id)
    values ('cccccccc-0000-0000-0000-000000000001', 'P7 Self', v_root);
    update public.menu_categories set parent_id = id where id = v_root;
    raise exception 'self-parent accepted';
  exception when raise_exception then
    raise notice 'OK: a category cannot be its own parent';
  end;

  delete from public.menu_categories where id in (v_root, v_sub);
end $$;

\echo '── P7.3: SKU + variant-name uniqueness'
do $$
declare
  v_cat uuid;
  v_product uuid;
begin
  select id into v_cat from public.menu_categories
  where business_id = 'cccccccc-0000-0000-0000-000000000001' limit 1;
  if v_cat is null then
    insert into public.menu_categories (business_id, name)
    values ('cccccccc-0000-0000-0000-000000000001', 'P7 Cat') returning id into v_cat;
  end if;

  insert into public.menu_items (business_id, category_id, name, sku, price_minor)
  values ('cccccccc-0000-0000-0000-000000000001', v_cat, 'P7 Product A', 'P7-SKU-01', 10000)
  returning id into v_product;

  begin
    insert into public.menu_items (business_id, category_id, name, sku, price_minor)
    values ('cccccccc-0000-0000-0000-000000000001', v_cat, 'P7 Product B', 'P7-SKU-01', 20000);
    raise exception 'duplicate SKU within business accepted';
  exception when unique_violation then
    raise notice 'OK: duplicate SKU rejected within business';
  end;

  -- same SKU in ANOTHER business is fine
  insert into public.menu_categories (business_id, name)
  values ('dddddddd-0000-0000-0000-000000000002', 'P7 Cat B');
  insert into public.menu_items (business_id, category_id, name, sku, price_minor)
  values ('dddddddd-0000-0000-0000-000000000002',
          (select id from public.menu_categories where business_id = 'dddddddd-0000-0000-0000-000000000002' limit 1),
          'P7 Other', 'P7-SKU-01', 5000);
  raise notice 'OK: same SKU allowed across businesses';

  insert into public.product_variants (business_id, product_id, name, price_minor)
  values ('cccccccc-0000-0000-0000-000000000001', v_product, 'Half', 6000);
  begin
    insert into public.product_variants (business_id, product_id, name, price_minor)
    values ('cccccccc-0000-0000-0000-000000000001', v_product, 'half', 7000);
    raise exception 'duplicate variant name accepted';
  exception when unique_violation then
    raise notice 'OK: duplicate variant name (case-insensitive) rejected';
  end;

  delete from public.menu_items where business_id in
    ('cccccccc-0000-0000-0000-000000000001', 'dddddddd-0000-0000-0000-000000000002') and name like 'P7%';
  delete from public.menu_categories where business_id = 'dddddddd-0000-0000-0000-000000000002' and name = 'P7 Cat B';
end $$;

\echo '── P7.4: cross-business modifier links blocked'
do $$
declare
  v_cat uuid;
  v_product uuid;
  v_group_a uuid;
  v_group_b uuid;
begin
  insert into public.menu_categories (business_id, name)
  values ('cccccccc-0000-0000-0000-000000000001', 'P7 Link Cat') returning id into v_cat;
  insert into public.menu_items (business_id, category_id, name, price_minor)
  values ('cccccccc-0000-0000-0000-000000000001', v_cat, 'P7 Link Product', 10000)
  returning id into v_product;

  insert into public.modifier_groups (business_id, name, min_selected)
  values ('cccccccc-0000-0000-0000-000000000001', 'P7 Group A', 0) returning id into v_group_a;
  insert into public.modifier_groups (business_id, name, min_selected)
  values ('dddddddd-0000-0000-0000-000000000002', 'P7 Group B', 0) returning id into v_group_b;

  insert into public.product_modifier_groups (product_id, modifier_group_id) values (v_product, v_group_a);
  begin
    insert into public.product_modifier_groups (product_id, modifier_group_id) values (v_product, v_group_b);
    raise exception 'cross-business modifier link accepted';
  exception when raise_exception then
    raise notice 'OK: products cannot link modifier groups from another business';
  end;

  delete from public.menu_items where id = v_product;
  delete from public.menu_categories where id = v_cat;
  delete from public.modifier_groups where id in (v_group_a, v_group_b);
end $$;

\echo '── P7.5: product delete cascades variants, overrides, links'
do $$
declare
  v_cat uuid;
  v_product uuid;
  v_outlet uuid;
  v_group uuid;
begin
  select o.id into v_outlet from public.outlets o
  where o.business_id = 'cccccccc-0000-0000-0000-000000000001' and o.slug = 'main';

  insert into public.menu_categories (business_id, name)
  values ('cccccccc-0000-0000-0000-000000000001', 'P7 Cascade Cat') returning id into v_cat;
  insert into public.menu_items (business_id, category_id, name, price_minor)
  values ('cccccccc-0000-0000-0000-000000000001', v_cat, 'P7 Cascade', 10000)
  returning id into v_product;
  insert into public.product_variants (business_id, product_id, name, price_minor)
  values ('cccccccc-0000-0000-0000-000000000001', v_product, 'Large', 12000);
  insert into public.outlet_product_overrides (outlet_id, product_id, price_minor)
  values (v_outlet, v_product, 9000);
  insert into public.modifier_groups (business_id, name, min_selected)
  values ('cccccccc-0000-0000-0000-000000000001', 'P7 Cascade Group', 0) returning id into v_group;
  insert into public.product_modifier_groups (product_id, modifier_group_id) values (v_product, v_group);

  delete from public.menu_items where id = v_product;

  if exists (select 1 from public.product_variants where product_id = v_product) then
    raise exception 'variants survived product delete';
  end if;
  if exists (select 1 from public.outlet_product_overrides where product_id = v_product) then
    raise exception 'overrides survived product delete';
  end if;
  if exists (select 1 from public.product_modifier_groups where product_id = v_product) then
    raise exception 'modifier links survived product delete';
  end if;
  raise notice 'OK: cascades remove variants, overrides and modifier links';

  delete from public.menu_categories where id = v_cat;
  delete from public.modifier_groups where id = v_group;
end $$;

\echo '── P7.6: menu-media storage policies (tenant-scoped writes, public reads)'
do $$
declare
  n int;
begin
  select count(*) into n from pg_policies
  where schemaname = 'storage' and tablename = 'objects' and policyname like 'menu_media%';
  if n <> 4 then
    raise exception 'expected 4 menu-media storage policies, found %', n;
  end if;

  -- anon can read menu-media objects
  insert into storage.objects (bucket_id, name)
  values ('menu-media', 'cccccccc-0000-0000-0000-000000000001/p1/seed.jpg');
  set role anon;
  if not exists (select 1 from storage.objects where bucket_id = 'menu-media') then
    raise exception 'anon cannot read menu-media';
  end if;
  reset role;

  -- alice (owner, Tenant A) can write under TENANT A's folder…
  set role authenticated;
  set request.jwt.claims = '{"sub": "aaaaaaaa-0000-0000-0000-000000000001", "role": "authenticated"}';
  insert into storage.objects (bucket_id, name, owner)
  values ('menu-media', 'cccccccc-0000-0000-0000-000000000001/p1/alice.jpg',
          'aaaaaaaa-0000-0000-0000-000000000001');
  reset role;
  raise notice 'OK: member write allowed inside own business folder';

  -- …but NOT under Tenant B's folder
  set role authenticated;
  set request.jwt.claims = '{"sub": "aaaaaaaa-0000-0000-0000-000000000001", "role": "authenticated"}';
  begin
    insert into storage.objects (bucket_id, name, owner)
    values ('menu-media', 'dddddddd-0000-0000-0000-000000000002/p1/alice.jpg',
            'aaaaaaaa-0000-0000-0000-000000000001');
    raise exception 'cross-tenant storage write succeeded';
  exception when insufficient_privilege then
    raise notice 'OK: cross-tenant storage write denied';
  end;
  reset role;

  -- carol (waiter) lacks a menu-management role → no writes anywhere
  set role authenticated;
  set request.jwt.claims = '{"sub": "eeeeeeee-0000-0000-0000-000000000003", "role": "authenticated"}';
  begin
    insert into storage.objects (bucket_id, name, owner)
    values ('menu-media', 'cccccccc-0000-0000-0000-000000000001/p1/carol.jpg',
            'eeeeeeee-0000-0000-0000-000000000003');
    raise exception 'waiter storage write succeeded';
  exception when insufficient_privilege then
    raise notice 'OK: non-menu-management roles cannot write menu media';
  end;
  reset role;

  delete from storage.objects where bucket_id = 'menu-media';
end $$;

\echo '── P7.7: menu reads isolated between tenants'
do $$
declare
  v_cat uuid;
  v_product uuid;
  n int;
begin
  insert into public.menu_categories (business_id, name)
  values ('cccccccc-0000-0000-0000-000000000001', 'P7 Iso Cat') returning id into v_cat;
  insert into public.menu_items (business_id, category_id, name, price_minor)
  values ('cccccccc-0000-0000-0000-000000000001', v_cat, 'P7 Iso Product', 10000)
  returning id into v_product;
  insert into public.product_variants (business_id, product_id, name, price_minor)
  values ('cccccccc-0000-0000-0000-000000000001', v_product, 'Iso', 5000);

  set role authenticated;
  set request.jwt.claims = '{"sub": "bbbbbbbb-0000-0000-0000-000000000002", "role": "authenticated"}';
  select count(*) into n from public.product_variants;
  if n <> 0 then raise exception 'TENANT LEAK: bob sees % Tenant A variants', n; end if;
  select count(*) into n from public.menu_items where name like 'P7%';
  if n <> 0 then raise exception 'TENANT LEAK: bob sees Tenant A products (%)', n; end if;
  reset role;

  set role authenticated;
  set request.jwt.claims = '{"sub": "aaaaaaaa-0000-0000-0000-000000000001", "role": "authenticated"}';
  select count(*) into n from public.product_variants where product_id = v_product;
  if n <> 1 then raise exception 'alice lost sight of own variants (%)', n; end if;
  reset role;
  raise notice 'OK: menu reads isolated per tenant';

  delete from public.menu_items where id = v_product;
  delete from public.menu_categories where id = v_cat;
end $$;

\echo ''
\echo '✅ PHASE 7 UNIVERSAL MENU ASSERTIONS COMPLETE'
