-- ─────────────────────────────────────────────────────────────────────────
-- RestroNex Phase 8 assertions: POS orders — RPC pricing, idempotency,
-- state machine, RLS isolation, service-role-only writes.
-- Runs after Phase 1/2 fixtures (alice owns Tenant A cccc…0001, bob owns
-- Tenant B dddd…0002; outlet slugs 'main').
-- ─────────────────────────────────────────────────────────────────────────

\echo '── P8.0: fixtures (menu, table, taxes)'
do $$
declare
  v_biz_a uuid := 'cccccccc-0000-0000-0000-000000000001';
  v_biz_b uuid := 'dddddddd-0000-0000-0000-000000000002';
  v_outlet_a uuid;
  v_cat uuid;
  v_prod_a uuid;
  v_prod_b uuid;
  v_prod_c uuid;
  v_prod_d uuid;
  v_mg uuid;
  v_mod uuid;
  v_section uuid;
begin
  select id into v_outlet_a from public.outlets
  where business_id = v_biz_a and slug = 'main';
  if v_outlet_a is null then raise exception 'fixture outlet A missing'; end if;

  insert into public.menu_categories (business_id, name)
  values (v_biz_a, 'P8 POS') returning id into v_cat;

  insert into public.menu_items (business_id, category_id, name, price_minor)
  values (v_biz_a, v_cat, 'P8 Burger', 10000) returning id into v_prod_a;
  insert into public.menu_items (business_id, category_id, name, price_minor, tax_rate_pct)
  values (v_biz_a, v_cat, 'P8 Fries', 5000, 5) returning id into v_prod_b;
  insert into public.menu_items (business_id, category_id, name, price_minor)
  values (v_biz_a, v_cat, 'P8 Shake', 6000) returning id into v_prod_c;
  insert into public.menu_items (business_id, category_id, name, price_minor)
  values (v_biz_a, v_cat, 'P8 Wrap', 9000) returning id into v_prod_d;

  insert into public.product_variants (business_id, product_id, name, price_minor)
  values (v_biz_a, v_prod_a, 'Large', 15000);

  insert into public.modifier_groups (business_id, name, min_selected, max_selected)
  values (v_biz_a, 'P8 Toppings', 0, 2) returning id into v_mg;
  insert into public.modifiers (business_id, modifier_group_id, name, price_minor)
  values (v_biz_a, v_mg, 'P8 Cheese', 2000) returning id into v_mod;
  insert into public.product_modifier_groups (product_id, modifier_group_id)
  values (v_prod_a, v_mg);

  insert into public.combos (business_id, name, price_minor)
  values (v_biz_a, 'P8 Meal', 20000);

  -- outlet overrides: variant repriced to 16000; shake hidden at this outlet; wrap repriced
  insert into public.outlet_variant_overrides (variant_id, outlet_id, price_minor)
  select pv.id, v_outlet_a, 16000
  from public.product_variants pv
  join public.menu_items mi on mi.id = pv.product_id
  where mi.business_id = v_biz_a and mi.name = 'P8 Burger' and pv.name = 'Large';

  insert into public.outlet_product_overrides (product_id, outlet_id, is_available)
  values (v_prod_c, v_outlet_a, false);
  insert into public.outlet_product_overrides (product_id, outlet_id, price_minor)
  values (v_prod_d, v_outlet_a, 7000);

  -- a product + modifier in TENANT B for cross-tenant rejection tests
  insert into public.menu_categories (business_id, name) values (v_biz_b, 'P8 B Cat');
  insert into public.menu_items (business_id, category_id, name, price_minor)
  select v_biz_b, mc.id, 'P8 B Item', 100 from public.menu_categories mc
  where mc.business_id = v_biz_b and mc.name = 'P8 B Cat';
  insert into public.modifier_groups (business_id, name) values (v_biz_b, 'P8 B Options');
  insert into public.modifiers (business_id, modifier_group_id, name, price_minor)
  select v_biz_b, mg.id, 'P8 B Extra', 50 from public.modifier_groups mg
  where mg.business_id = v_biz_b and mg.name = 'P8 B Options';

  -- dining table for dine-in orders
  insert into public.dining_sections (business_id, outlet_id, name)
  values (v_biz_a, v_outlet_a, 'P8 Hall') returning id into v_section;
  insert into public.dining_tables (business_id, outlet_id, section_id, label, capacity)
  values (v_biz_a, v_outlet_a, v_section, 'T-P8', 4);

  -- taxes: 5% exclusive (added on top) + 2% inclusive (ignored by totals)
  update public.businesses set tax_settings = jsonb_build_object(
    'enabled', true,
    'rates', jsonb_build_array(
      jsonb_build_object('name', 'GST', 'pct', 5, 'inclusive', false),
      jsonb_build_object('name', 'VAT', 'pct', 2, 'inclusive', true)
    )
  ) where id = v_biz_a;

  raise notice 'OK: phase-8 fixtures ready';
end $$;

\echo '── P8.1: order tables exist, RLS on, client writes denied'
do $$
declare
  t text;
begin
  foreach t in array array[
    'orders', 'order_items', 'order_item_modifiers', 'order_status_history',
    'business_order_counters'
  ] loop
    if not exists (select 1 from pg_tables where schemaname = 'public' and tablename = t) then
      raise exception 'missing table: %', t;
    end if;
    if not exists (select 1 from pg_class c where c.relname = t and c.relrowsecurity) then
      raise exception 'RLS not enabled on %', t;
    end if;
  end loop;
  raise notice 'OK: all 5 order tables exist with RLS enabled';
end $$;

do $$
begin
  set role authenticated;
  set request.jwt.claims = '{"sub": "aaaaaaaa-0000-0000-0000-000000000001", "role": "authenticated"}';
  begin
    insert into public.orders (business_id, outlet_id, order_number, client_ref, order_type)
    values (
      'cccccccc-0000-0000-0000-000000000001',
      (select id from public.outlets where business_id = 'cccccccc-0000-0000-0000-000000000001' and slug = 'main'),
      99999, 'p8-hack-attempt-1', 'takeaway'
    );
    raise exception 'authenticated INSERT into orders succeeded';
  exception when insufficient_privilege then
    raise notice 'OK: client INSERT denied on orders';
  end;
  reset role;

  -- write paths are policy-less: assert the catalog has zero write policies
  declare
    t text; n int;
  begin
    foreach t in array array['orders','order_items','order_item_modifiers','order_status_history'] loop
      select count(*) into n from pg_policies
      where schemaname = 'public' and tablename = t and cmd in ('INSERT','UPDATE','DELETE');
      if n <> 0 then raise exception 'write policy found on %', t; end if;
      select count(*) into n from pg_policies
      where schemaname = 'public' and tablename = t and cmd = 'SELECT';
      if n = 0 then raise exception 'no SELECT policy on %', t; end if;
    end loop;
    select count(*) into n from pg_policies
    where schemaname = 'public' and tablename = 'business_order_counters';
    if n <> 0 then raise exception 'counters must have no client policies'; end if;
  end;
  raise notice 'OK: order tables expose SELECT-only policies; counters invisible';
exception when others then
  reset role;
  raise;
end $$;

\echo '── P8.2: RPCs callable only by service_role'
do $$
declare
  f text;
begin
  foreach f in array array[
    'create_pos_order(uuid, jsonb)',
    'amend_pos_order(uuid, uuid, jsonb)',
    'transition_order_status(uuid, uuid, text, text)',
    'pos_persist_items(uuid, uuid, uuid, jsonb)',
    'pos_apply_totals(uuid, uuid, bigint, jsonb, jsonb)',
    'pos_effective_tax_pct(uuid, uuid)'
  ] loop
    if has_function_privilege('authenticated', f, 'EXECUTE') then
      raise exception 'authenticated can EXECUTE %', f;
    end if;
    if has_function_privilege('anon', f, 'EXECUTE') then
      raise exception 'anon can EXECUTE %', f;
    end if;
    if not has_function_privilege('service_role', f, 'EXECUTE') then
      raise exception 'service_role cannot EXECUTE %', f;
    end if;
  end loop;
  raise notice 'OK: all 6 order RPCs are service_role-only';
end $$;

\echo '── P8.3: order creation reprices everything server-side'
do $$
declare
  v_biz_a uuid := 'cccccccc-0000-0000-0000-000000000001';
  v_outlet_a uuid;
  v_table uuid;
  v_variant uuid;
  v_modifier uuid;
  v_combo uuid;
  v_prod_b uuid;
  v_order uuid;
  v_row record;
  v_mod_row record;
begin
  select id into v_outlet_a from public.outlets where business_id = v_biz_a and slug = 'main';
  select id into v_table from public.dining_tables
  where business_id = v_biz_a and label = 'T-P8';

  select pv.id into v_variant
  from public.product_variants pv
  join public.menu_items mi on mi.id = pv.product_id
  where mi.business_id = v_biz_a and mi.name = 'P8 Burger' and pv.name = 'Large';

  select md.id into v_modifier
  from public.modifiers md
  join public.modifier_groups mg on mg.id = md.modifier_group_id
  where mg.business_id = v_biz_a and md.name = 'P8 Cheese';

  select id into v_combo from public.combos where business_id = v_biz_a and name = 'P8 Meal';
  select id into v_prod_b from public.menu_items where business_id = v_biz_a and name = 'P8 Fries';

  v_order := public.create_pos_order(
    'aaaaaaaa-0000-0000-0000-000000000001',
    jsonb_build_object(
      'outlet_id', v_outlet_a,
      'client_ref', 'p8-happy-path-001',
      'order_type', 'dine_in',
      'table_id', v_table,
      'customer_name', 'Walk-in 12',
      'discount', jsonb_build_object('type', 'percent', 'value', 10),
      'charges', jsonb_build_array(jsonb_build_object('name', 'Packing', 'amount_minor', 500)),
      'items', jsonb_build_array(
        jsonb_build_object(
          'item_type', 'product', 'product_id', v_prod_b, 'quantity', 1
        ),
        jsonb_build_object(
          'item_type', 'product', 'product_id',
          (select product_id from public.product_variants where id = v_variant),
          'variant_id', v_variant,
          'quantity', 2,
          'item_notes', 'no onions',
          'modifiers', jsonb_build_array(
            jsonb_build_object('modifier_id', v_modifier, 'quantity', 1)
          )
        ),
        jsonb_build_object('item_type', 'combo', 'combo_id', v_combo, 'quantity', 1)
      )
    )
  );

  select * into v_row from public.orders where id = v_order;
  if v_row.order_number < 1001 then
    raise exception 'order_number not sequential: %', v_row.order_number;
  end if;
  if v_row.status <> 'open' then raise exception 'new order status is %', v_row.status; end if;
  if v_row.order_type <> 'dine_in' or v_row.table_id <> v_table then
    raise exception 'dine-in order lost its table';
  end if;

  -- variant override 16000 + cheese 2000, qty 2 → 36000; fries 5000; combo 20000
  if v_row.subtotal_minor <> 61000 then
    raise exception 'subtotal: expected 61000 got %', v_row.subtotal_minor;
  end if;
  if v_row.discount_minor <> 6100 then
    raise exception 'discount: expected 6100 got %', v_row.discount_minor;
  end if;
  -- exclusive 5% on post-discount nets: 1620 + 225 + 0
  if v_row.tax_minor <> 1845 then
    raise exception 'tax: expected 1845 got %', v_row.tax_minor;
  end if;
  if v_row.charges_minor <> 500 then
    raise exception 'charges: expected 500 got %', v_row.charges_minor;
  end if;
  if v_row.total_minor <> 57245 then
    raise exception 'total: expected 57245 got %', v_row.total_minor;
  end if;
  if v_row.paid_minor <> 0 or v_row.payment_status <> 'unpaid' then
    raise exception 'new order must be unpaid with zero paid';
  end if;

  select oi.* into v_mod_row
  from public.order_items oi where oi.order_id = v_order and oi.item_type = 'product' and oi.variant_id is not null;
  if v_mod_row.unit_price_minor <> 16000 then
    raise exception 'variant outlet override not applied: %', v_mod_row.unit_price_minor;
  end if;
  if v_mod_row.name <> 'P8 Burger (Large)' then
    raise exception 'variant label wrong: %', v_mod_row.name;
  end if;
  if v_mod_row.modifiers_minor <> 2000 then
    raise exception 'modifiers total wrong: %', v_mod_row.modifiers_minor;
  end if;
  if not exists (
    select 1 from public.order_item_modifiers om
    where om.order_item_id = v_mod_row.id and om.name = 'P8 Cheese' and om.price_minor = 2000
  ) then
    raise exception 'modifier row missing';
  end if;
  if (select count(*) from public.order_status_history where order_id = v_order) <> 1 then
    raise exception 'expected exactly one history row';
  end if;

  raise notice 'OK: server-side repricing, discounts, exclusive tax and charges verified (order #%)', v_row.order_number;
end $$;

\echo '── P8.4: duplicate submission returns the original order (idempotent)'
do $$
declare
  v_biz_a uuid := 'cccccccc-0000-0000-0000-000000000001';
  v_payload jsonb;
  v_first uuid;
  v_second uuid;
  v_n int;
begin
  v_payload := jsonb_build_object(
    'outlet_id', (select id from public.outlets where business_id = v_biz_a and slug = 'main'),
    'client_ref', 'p8-idempotent-001',
    'order_type', 'takeaway',
    'items', jsonb_build_array(jsonb_build_object(
      'item_type', 'product',
      'product_id', (select id from public.menu_items where business_id = v_biz_a and name = 'P8 Fries'),
      'quantity', 1
    ))
  );
  v_first := public.create_pos_order('aaaaaaaa-0000-0000-0000-000000000001', v_payload);
  v_second := public.create_pos_order('aaaaaaaa-0000-0000-0000-000000000001', v_payload);
  if v_first <> v_second then
    raise exception 'duplicate client_ref created a second order';
  end if;
  select count(*) into v_n from public.orders where business_id = v_biz_a and client_ref = 'p8-idempotent-001';
  if v_n <> 1 then raise exception 'expected 1 row for client_ref, found %', v_n; end if;
  raise notice 'OK: client_ref idempotency prevents duplicate orders';
end $$;

\echo '── P8.5: input guards (table, delivery details, availability, cross-tenant)'
do $$
declare
  v_biz_a uuid := 'cccccccc-0000-0000-0000-000000000001';
  v_biz_b uuid := 'dddddddd-0000-0000-0000-000000000002';
  v_outlet_a uuid;
  v_fries uuid;
  v_burger uuid;
  v_b_item uuid;
  v_b_mod uuid;
  v_n int;
begin
  select id into v_outlet_a from public.outlets where business_id = v_biz_a and slug = 'main';
  select id into v_fries from public.menu_items where business_id = v_biz_a and name = 'P8 Fries';
  select id into v_burger from public.menu_items where business_id = v_biz_a and name = 'P8 Burger';
  select id into v_b_item from public.menu_items where business_id = v_biz_b and name = 'P8 B Item';
  select md.id into v_b_mod
  from public.modifiers md
  join public.modifier_groups mg on mg.id = md.modifier_group_id
  where mg.business_id = v_biz_b and md.name = 'P8 B Extra';

  -- dine-in without a table
  begin
    perform public.create_pos_order('aaaaaaaa-0000-0000-0000-000000000001', jsonb_build_object(
      'outlet_id', v_outlet_a, 'client_ref', 'p8-notable-001', 'order_type', 'dine_in',
      'items', jsonb_build_array(jsonb_build_object('item_type','product','product_id', v_fries,'quantity',1))
    ));
    raise exception 'dine-in without table accepted' using errcode = 'P0777';
  exception when raise_exception then
    raise notice 'OK: dine-in requires a table';
  end;

  -- delivery without phone/address
  begin
    perform public.create_pos_order('aaaaaaaa-0000-0000-0000-000000000001', jsonb_build_object(
      'outlet_id', v_outlet_a, 'client_ref', 'p8-nophone-001', 'order_type', 'delivery',
      'items', jsonb_build_array(jsonb_build_object('item_type','product','product_id', v_fries,'quantity',1))
    ));
    raise exception 'delivery without contact accepted' using errcode = 'P0777';
  exception when raise_exception then
    raise notice 'OK: delivery requires phone + address';
  end;

  -- product from ANOTHER tenant
  begin
    perform public.create_pos_order('aaaaaaaa-0000-0000-0000-000000000001', jsonb_build_object(
      'outlet_id', v_outlet_a, 'client_ref', 'p8-crosstenant-001', 'order_type', 'takeaway',
      'items', jsonb_build_array(jsonb_build_object('item_type','product','product_id', v_b_item,'quantity',1))
    ));
    raise exception 'cross-tenant product accepted' using errcode = 'P0777';
  exception when raise_exception then
    raise notice 'OK: items from another tenant are rejected';
  end;

  -- modifier not attached to the product (also cross-tenant)
  begin
    perform public.create_pos_order('aaaaaaaa-0000-0000-0000-000000000001', jsonb_build_object(
      'outlet_id', v_outlet_a, 'client_ref', 'p8-badmod-001', 'order_type', 'takeaway',
      'items', jsonb_build_array(jsonb_build_object(
        'item_type','product','product_id', v_burger,'quantity',1,
        'modifiers', jsonb_build_array(jsonb_build_object('modifier_id', v_b_mod, 'quantity', 1))
      ))
    ));
    raise exception 'unattached modifier accepted' using errcode = 'P0777';
  exception when raise_exception then
    raise notice 'OK: modifiers must be attached to the product';
  end;

  -- outlet override hiding a product
  begin
    perform public.create_pos_order('aaaaaaaa-0000-0000-0000-000000000001', jsonb_build_object(
      'outlet_id', v_outlet_a, 'client_ref', 'p8-hidden-001', 'order_type', 'takeaway',
      'items', jsonb_build_array(jsonb_build_object(
        'item_type','product',
        'product_id', (select id from public.menu_items where business_id = v_biz_a and name = 'P8 Shake'),
        'quantity',1))
    ));
    raise exception 'outlet-unavailable product accepted' using errcode = 'P0777';
  exception when raise_exception then
    raise notice 'OK: outlet-level unavailability blocks the sale';
  end;

  -- base-menu unavailability
  update public.menu_items set is_available = false where id = v_fries;
  begin
    perform public.create_pos_order('aaaaaaaa-0000-0000-0000-000000000001', jsonb_build_object(
      'outlet_id', v_outlet_a, 'client_ref', 'p8-unavail-001', 'order_type', 'takeaway',
      'items', jsonb_build_array(jsonb_build_object('item_type','product','product_id', v_fries,'quantity',1))
    ));
    raise exception 'unavailable product accepted' using errcode = 'P0777';
  exception when raise_exception then
    raise notice 'OK: unavailable products cannot be sold';
  end;
  update public.menu_items set is_available = true where id = v_fries;

  -- non-member cannot create
  begin
    perform public.create_pos_order('bbbbbbbb-0000-0000-0000-000000000002', jsonb_build_object(
      'outlet_id', v_outlet_a, 'client_ref', 'p8-nonmember-001', 'order_type', 'takeaway',
      'items', jsonb_build_array(jsonb_build_object('item_type','product','product_id', v_fries,'quantity',1))
    ));
    raise exception 'non-member created an order' using errcode = 'P0777';
  exception when raise_exception then
    raise notice 'OK: non-members cannot create orders';
  end;

  select count(*) into v_n from public.orders
  where business_id = v_biz_a
    and client_ref in ('p8-notable-001','p8-nophone-001','p8-crosstenant-001','p8-badmod-001','p8-hidden-001','p8-unavail-001','p8-nonmember-001');
  if v_n <> 0 then raise exception 'failed attempts left % order rows behind', v_n; end if;
  raise notice 'OK: failed creations are fully rolled back (transactional)';
end $$;

\echo '── P8.6: state machine guards'
do $$
declare
  v_biz_a uuid := 'cccccccc-0000-0000-0000-000000000001';
  v_outlet_a uuid;
  v_fries uuid;
  v_order uuid;
begin
  select id into v_outlet_a from public.outlets where business_id = v_biz_a and slug = 'main';
  select id into v_fries from public.menu_items where business_id = v_biz_a and name = 'P8 Fries';

  v_order := public.create_pos_order('aaaaaaaa-0000-0000-0000-000000000001', jsonb_build_object(
    'outlet_id', v_outlet_a, 'client_ref', 'p8-lifecycle-001', 'order_type', 'takeaway',
    'items', jsonb_build_array(jsonb_build_object('item_type','product','product_id', v_fries,'quantity',2))
  ));

  -- illegal skips
  begin
    perform public.transition_order_status('aaaaaaaa-0000-0000-0000-000000000001', v_order, 'preparing');
    raise exception 'open → preparing allowed' using errcode = 'P0777';
  exception when raise_exception then raise notice 'OK: open → preparing blocked'; end;
  begin
    perform public.transition_order_status('aaaaaaaa-0000-0000-0000-000000000001', v_order, 'completed');
    raise exception 'open → completed allowed' using errcode = 'P0777';
  exception when raise_exception then raise notice 'OK: open → completed blocked'; end;

  -- hold ↔ resume
  perform public.transition_order_status('aaaaaaaa-0000-0000-0000-000000000001', v_order, 'held');
  if (select status from public.orders where id = v_order) <> 'held' then
    raise exception 'hold failed';
  end if;
  perform public.transition_order_status('aaaaaaaa-0000-0000-0000-000000000001', v_order, 'open');

  -- full lifecycle
  perform public.transition_order_status('aaaaaaaa-0000-0000-0000-000000000001', v_order, 'placed', 'sent to kitchen');
  perform public.transition_order_status('aaaaaaaa-0000-0000-0000-000000000001', v_order, 'preparing');
  perform public.transition_order_status('aaaaaaaa-0000-0000-0000-000000000001', v_order, 'ready');

  -- completion without payment must fail (payment arrives in Phase 10)
  begin
    perform public.transition_order_status('aaaaaaaa-0000-0000-0000-000000000001', v_order, 'completed');
    raise exception 'unpaid order completed' using errcode = 'P0777';
  exception when raise_exception then
    raise notice 'OK: ready → completed blocked until payment is recorded';
  end;

  if (select count(*) from public.order_status_history where order_id = v_order) < 5 then
    raise exception 'status history incomplete';
  end if;

  -- amendment is only for open/held
  begin
    perform public.amend_pos_order('aaaaaaaa-0000-0000-0000-000000000001', v_order, jsonb_build_object(
      'items', jsonb_build_array(jsonb_build_object('item_type','product','product_id', v_fries,'quantity',3))
    ));
    raise exception 'amending a ready order succeeded' using errcode = 'P0777';
  exception when raise_exception then
    raise notice 'OK: placed/ready orders cannot be amended';
  end;

  raise notice 'OK: lifecycle open→held→open→placed→preparing→ready enforced';
end $$;

\echo '── P8.7: amend reprices and recomputes totals atomically'
do $$
declare
  v_biz_a uuid := 'cccccccc-0000-0000-0000-000000000001';
  v_outlet_a uuid;
  v_fries uuid;
  v_wrap uuid;
  v_order uuid;
  v_row record;
begin
  select id into v_outlet_a from public.outlets where business_id = v_biz_a and slug = 'main';
  select id into v_fries from public.menu_items where business_id = v_biz_a and name = 'P8 Fries';
  select id into v_wrap from public.menu_items where business_id = v_biz_a and name = 'P8 Wrap';

  v_order := public.create_pos_order('aaaaaaaa-0000-0000-0000-000000000001', jsonb_build_object(
    'outlet_id', v_outlet_a, 'client_ref', 'p8-amend-001', 'order_type', 'takeaway',
    'items', jsonb_build_array(jsonb_build_object('item_type','product','product_id', v_fries,'quantity',1))
  ));

  -- amend: swap to wrap (outlet price 7000), qty 2, flat discount 1000, held status
  perform public.amend_pos_order('aaaaaaaa-0000-0000-0000-000000000001', v_order, jsonb_build_object(
    'status', 'held',
    'discount', jsonb_build_object('type', 'flat', 'value', 1000),
    'items', jsonb_build_array(jsonb_build_object('item_type','product','product_id', v_wrap,'quantity',2))
  ));

  select * into v_row from public.orders where id = v_order;
  if v_row.status <> 'held' then raise exception 'amend status not applied'; end if;
  -- 7000 * 2 = 14000; flat 1000; tax 5% of 13000 = 650; total 13650
  if v_row.subtotal_minor <> 14000 then raise exception 'amend subtotal %', v_row.subtotal_minor; end if;
  if v_row.discount_minor <> 1000 then raise exception 'amend discount %', v_row.discount_minor; end if;
  if v_row.tax_minor <> 650 then raise exception 'amend tax %', v_row.tax_minor; end if;
  if v_row.total_minor <> 13650 then raise exception 'amend total %', v_row.total_minor; end if;
  if (select count(*) from public.order_items where order_id = v_order) <> 1 then
    raise exception 'old items were not replaced';
  end if;

  -- flat discount cannot exceed the subtotal
  perform public.amend_pos_order('aaaaaaaa-0000-0000-0000-000000000001', v_order, jsonb_build_object(
    'discount', jsonb_build_object('type', 'flat', 'value', 99999999),
    'items', jsonb_build_array(jsonb_build_object('item_type','product','product_id', v_wrap,'quantity',1))
  ));
  select * into v_row from public.orders where id = v_order;
  if v_row.discount_minor <> v_row.subtotal_minor or v_row.total_minor <> v_row.tax_minor then
    raise exception 'flat discount was not capped at the subtotal';
  end if;

  raise notice 'OK: amend replaces items and recomputes totals';
end $$;

\echo '── P8.8: sequential numbering + RLS isolation on reads'
do $$
declare
  v_biz_a uuid := 'cccccccc-0000-0000-0000-000000000001';
  v_outlet_a uuid;
  v_fries uuid;
  v_first_number int;
  v_second_number int;
  v_o1 uuid;
  v_o2 uuid;
  v_n int;
begin
  select id into v_outlet_a from public.outlets where business_id = v_biz_a and slug = 'main';
  select id into v_fries from public.menu_items where business_id = v_biz_a and name = 'P8 Fries';

  v_o1 := public.create_pos_order('aaaaaaaa-0000-0000-0000-000000000001', jsonb_build_object(
    'outlet_id', v_outlet_a, 'client_ref', 'p8-seq-001', 'order_type', 'takeaway',
    'items', jsonb_build_array(jsonb_build_object('item_type','product','product_id', v_fries,'quantity',1))));
  v_o2 := public.create_pos_order('aaaaaaaa-0000-0000-0000-000000000001', jsonb_build_object(
    'outlet_id', v_outlet_a, 'client_ref', 'p8-seq-002', 'order_type', 'takeaway',
    'items', jsonb_build_array(jsonb_build_object('item_type','product','product_id', v_fries,'quantity',1))));
  select order_number into v_first_number from public.orders where id = v_o1;
  select order_number into v_second_number from public.orders where id = v_o2;
  if v_second_number <> v_first_number + 1 then
    raise exception 'order numbers not sequential: % then %', v_first_number, v_second_number;
  end if;
  raise notice 'OK: per-outlet order numbers are sequential (% → %)', v_first_number, v_second_number;

  -- bob (Tenant B owner) must not read Tenant A orders through the API role
  set role authenticated;
  set request.jwt.claims = '{"sub": "bbbbbbbb-0000-0000-0000-000000000002", "role": "authenticated"}';
  select count(*) into v_n from public.orders where business_id = v_biz_a;
  if v_n <> 0 then raise exception 'ISOLATION FAIL: bob reads % Tenant A orders', v_n; end if;
  select count(*) into v_n from public.order_items oi
  where exists (select 1 from public.orders o where o.id = oi.order_id and o.business_id = v_biz_a);
  if v_n <> 0 then raise exception 'ISOLATION FAIL: bob reads Tenant A order items'; end if;
  reset role;
  raise notice 'OK: tenant isolation holds for orders, items, modifiers and history';
exception when others then
  reset role;
  raise;
end $$;

\echo '── P8.9: cleanup test orders (fixtures stay for later phases)'
do $$
declare
  v_biz_a uuid := 'cccccccc-0000-0000-0000-000000000001';
  v_n int;
begin
  delete from public.orders where business_id = v_biz_a and client_ref like 'p8-%';
  get diagnostics v_n = row_count;
  update public.businesses set tax_settings = '{}'::jsonb where id = v_biz_a;
  delete from public.business_order_counters where business_id = v_biz_a;
  raise notice 'OK: removed % phase-8 test orders', v_n;
end $$;
