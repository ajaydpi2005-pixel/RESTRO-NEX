-- ─────────────────────────────────────────────────────────────────────────
-- RestroNex Phase 9 assertions: floors, sections, table lifecycle.
-- Runs after Phase 1-8 fixtures (alice owns Tenant A cccc…0001 with outlets
-- 'main' + 'branch'; bob owns Tenant B dddd…0002; carol eeee…0003 is an
-- un-granted waiter in Tenant A; P8 menu items exist in both tenants).
-- ─────────────────────────────────────────────────────────────────────────

\echo '── P9.0: fixtures via Phase 9 RPCs (owner configures floor/section/tables)'
do $$
declare
  v_biz_a uuid := 'cccccccc-0000-0000-0000-000000000001';
  v_actor uuid := 'aaaaaaaa-0000-0000-0000-000000000001';
  v_outlet_a uuid;
  v_floor uuid;
  v_section uuid;
begin
  select id into v_outlet_a from public.outlets
  where business_id = v_biz_a and slug = 'main';
  if v_outlet_a is null then raise exception 'fixture outlet A missing'; end if;

  -- every pre-existing outlet got a default floor from the migration backfill
  if not exists (select 1 from public.floors where outlet_id = v_outlet_a) then
    raise exception 'backfill did not create a default floor';
  end if;

  v_floor := public.save_floor(v_actor, null, v_outlet_a, 'Level 1');
  v_section := public.save_section(v_actor, null, v_outlet_a, v_floor, 'P9 Window');

  perform public.save_table(v_actor, null, v_outlet_a, v_section, 'T-P9A', 2);
  perform public.save_table(v_actor, null, v_outlet_a, v_section, 'T-P9B', 4);
  perform public.save_table(v_actor, null, v_outlet_a, v_section, 'T-P9C', 2);
  perform public.save_table(v_actor, null, v_outlet_a, v_section, 'T-P9D', 4);

  -- direct insert without floor_id must land on the default floor
  if not exists (
    select 1 from public.dining_sections s
    join public.floors f on f.id = s.floor_id
    where s.outlet_id = v_outlet_a and f.name = 'Main Floor'
  ) then
    raise exception 'default-floor column default did not resolve';
  end if;

  raise notice 'OK: phase-9 fixtures configured through RPCs';
end $$;

\echo '── P9.1: schema shape + RLS (clients can never write table status)'
do $$
begin
  if not exists (select 1 from pg_tables where schemaname = 'public' and tablename = 'floors') then
    raise exception 'missing table: floors';
  end if;
  if not exists (select 1 from pg_class c where c.relname = 'floors' and c.relrowsecurity) then
    raise exception 'RLS not enabled on floors';
  end if;
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'dining_tables' and column_name = 'status'
  ) or not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'dining_tables' and column_name = 'current_order_id'
  ) then
    raise exception 'dining_tables missing Phase 9 columns';
  end if;
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'dining_sections'
      and column_name = 'floor_id' and is_nullable = 'NO'
  ) then
    raise exception 'dining_sections.floor_id must be NOT NULL';
  end if;
  raise notice 'OK: floors table, status columns, floor_id NOT NULL';
end $$;

do $$
begin
  set role authenticated;
  set request.jwt.claims = '{"sub": "aaaaaaaa-0000-0000-0000-000000000001", "role": "authenticated"}';
  begin
    update public.dining_tables set status = 'occupied', reservation_note = 'hax'
    where label in ('T-P9A', 'T-P9B', 'T-P9C', 'T-P9D');
  exception when insufficient_privilege then
    null; -- an ACL denial is equally acceptable
  end;
  reset role;
  if exists (
    select 1 from public.dining_tables
    where label in ('T-P9A', 'T-P9B', 'T-P9C', 'T-P9D')
      and (status <> 'available' or reservation_note is not null)
  ) then
    raise exception 'client flipped a table status directly';
  end if;
  raise notice 'OK: direct client writes to dining_tables.status have no effect';
end $$;

\echo '── P9.2: configuration RPC authorisation + guards'
do $$
declare
  v_biz_a uuid := 'cccccccc-0000-0000-0000-000000000001';
  v_outlet_a uuid;
  v_branch uuid;
  v_floor uuid;
  v_branch_floor uuid;
  v_section uuid;
begin
  select id into v_outlet_a from public.outlets where business_id = v_biz_a and slug = 'main';
  select id into v_branch from public.outlets where business_id = v_biz_a and slug = 'branch';
  select id into v_floor from public.floors where outlet_id = v_outlet_a and name = 'Level 1';
  select id into v_branch_floor from public.floors where outlet_id = v_branch limit 1;
  if v_branch_floor is null then
    raise exception 'branch outlet has no default floor (trigger/backfill failed)';
  end if;

  -- non-member (bob) cannot configure tenant A
  begin
    perform public.save_floor('bbbbbbbb-0000-0000-0000-000000000002', null, v_outlet_a, 'Hack');
    raise exception 'non-member created a floor';
  exception when others then
    if sqlerrm not ilike '%not a member%' then raise; end if;
  end;

  -- waiter without outlet grant cannot configure
  begin
    perform public.save_table('eeeeeeee-0000-0000-0000-000000000003', null, v_outlet_a,
      (select id from public.dining_sections where name = 'P9 Window'), 'T-X', 2);
    raise exception 'un-granted waiter created a table';
  exception when others then
    if sqlerrm not ilike '%not assigned to this outlet%' then raise; end if;
  end;

  -- duplicate floor name
  begin
    perform public.save_floor('aaaaaaaa-0000-0000-0000-000000000001', null, v_outlet_a, 'Level 1');
    raise exception 'duplicate floor name accepted';
  exception when others then
    if sqlerrm not ilike '%already exists%' then raise; end if;
  end;

  -- section must hang off a floor of the same outlet
  begin
    perform public.save_section('aaaaaaaa-0000-0000-0000-000000000001', null, v_outlet_a,
      v_branch_floor, 'Wrong floor');
    raise exception 'section accepted a floor from another outlet';
  exception when others then
    if sqlerrm not ilike '%belongs to this outlet%' then raise; end if;
  end;

  -- delete guards
  begin
    perform public.delete_floor('aaaaaaaa-0000-0000-0000-000000000001', v_floor);
    raise exception 'floor with sections deleted';
  exception when others then
    if sqlerrm not ilike '%sections first%' then raise; end if;
  end;
  select id into v_section from public.dining_sections where name = 'P9 Window';
  begin
    perform public.delete_section('aaaaaaaa-0000-0000-0000-000000000001', v_section);
    raise exception 'section with tables deleted';
  exception when others then
    if sqlerrm not ilike '%tables first%' then raise; end if;
  end;

  raise notice 'OK: configuration authorisation + delete guards';
end $$;

\echo '── P9.3: reservations'
do $$
declare
  v_actor uuid := 'aaaaaaaa-0000-0000-0000-000000000001';
  v_table uuid;
begin
  select id into v_table from public.dining_tables where label = 'T-P9A';

  perform public.reserve_table(v_actor, v_table, 'Mr Rao, 8pm');
  if (select status from public.dining_tables where id = v_table) <> 'reserved' then
    raise exception 'reserve did not set status';
  end if;
  if (select reservation_note from public.dining_tables where id = v_table) <> 'Mr Rao, 8pm' then
    raise exception 'reservation note not stored';
  end if;

  begin
    perform public.reserve_table(v_actor, v_table, 'again');
    raise exception 'reserved table reserved twice';
  exception when others then
    if sqlerrm not ilike '%only available%' then raise; end if;
  end;

  perform public.release_table(v_actor, v_table);
  if (select status from public.dining_tables where id = v_table) <> 'available' then
    raise exception 'release did not restore availability';
  end if;

  begin
    perform public.release_table(v_actor, v_table);
    raise exception 'available table released';
  exception when others then
    if sqlerrm not ilike '%only reserved%' then raise; end if;
  end;

  raise notice 'OK: reserve/release guards';
end $$;

\echo '── P9.4: create_pos_order occupies the table; double-seating rejected'
do $$
declare
  v_biz_a uuid := 'cccccccc-0000-0000-0000-000000000001';
  v_biz_b uuid := 'dddddddd-0000-0000-0000-000000000002';
  v_actor uuid := 'aaaaaaaa-0000-0000-0000-000000000001';
  v_outlet_a uuid;
  v_branch uuid;
  v_outlet_b uuid;
  v_table_b uuid;
  v_table uuid;
  v_table_c uuid;
  v_fries uuid;
  v_order uuid;
begin
  select id into v_outlet_a from public.outlets where business_id = v_biz_a and slug = 'main';
  select id into v_branch from public.outlets where business_id = v_biz_a and slug = 'branch';
  select id into v_outlet_b from public.outlets where business_id = v_biz_b and slug = 'main';
  select id into v_table from public.dining_tables where label = 'T-P9A';
  select id into v_table_c from public.dining_tables where label = 'T-P9C';
  select id into v_fries from public.menu_items where business_id = v_biz_a and name = 'P8 Fries';

  -- tenant B needs a table for cross-outlet rejection tests
  insert into public.dining_sections (business_id, outlet_id, name)
  values (v_biz_b, v_outlet_b, 'P9 B Hall');
  insert into public.dining_tables (business_id, outlet_id, section_id, label, capacity)
  select v_biz_b, v_outlet_b, s.id, 'T-B9', 2
  from public.dining_sections s
  where s.business_id = v_biz_b and s.name = 'P9 B Hall'
  returning id into v_table_b;

  -- cross-outlet table rejected
  begin
    perform public.create_pos_order(v_actor, jsonb_build_object(
      'outlet_id', v_outlet_a, 'client_ref', 'p9-xoutlet-001', 'order_type', 'dine_in',
      'table_id', v_table_b,
      'items', jsonb_build_array(jsonb_build_object('item_type','product','product_id', v_fries,'quantity',1))));
    raise exception 'foreign-outlet table accepted';
  exception when others then
    if sqlerrm not ilike '%belongs to this outlet%' then raise; end if;
  end;

  -- seat the table
  v_order := public.create_pos_order(v_actor, jsonb_build_object(
    'outlet_id', v_outlet_a, 'client_ref', 'p9-seat-001', 'order_type', 'dine_in',
    'table_id', v_table,
    'items', jsonb_build_array(jsonb_build_object('item_type','product','product_id', v_fries,'quantity',1))));
  if (select status from public.dining_tables where id = v_table) <> 'occupied' then
    raise exception 'table not occupied after order creation';
  end if;
  if (select current_order_id from public.dining_tables where id = v_table) <> v_order then
    raise exception 'current_order_id not linked';
  end if;

  -- double seating rejected
  begin
    perform public.create_pos_order(v_actor, jsonb_build_object(
      'outlet_id', v_outlet_a, 'client_ref', 'p9-seat-002', 'order_type', 'dine_in',
      'table_id', v_table,
      'items', jsonb_build_array(jsonb_build_object('item_type','product','product_id', v_fries,'quantity',1))));
    raise exception 'double-seated an occupied table';
  exception when others then
    if sqlerrm not ilike '%just taken%' then raise; end if;
  end;
  -- failed seating must not leave a ghost order
  if exists (select 1 from public.orders where client_ref = 'p9-seat-002') then
    raise exception 'ghost order left behind by failed seating';
  end if;

  -- second table occupied for later transfer tests
  perform public.create_pos_order(v_actor, jsonb_build_object(
    'outlet_id', v_outlet_a, 'client_ref', 'p9-seat-003', 'order_type', 'dine_in',
    'table_id', v_table_c,
    'items', jsonb_build_array(jsonb_build_object('item_type','product','product_id', v_fries,'quantity',1))));

  raise notice 'OK: seating occupies tables and blocks double-seating';
end $$;

\echo '── P9.5: amend swaps tables (guarded transfer)'
do $$
declare
  v_actor uuid := 'aaaaaaaa-0000-0000-0000-000000000001';
  v_outlet_a uuid;
  v_table_a uuid;
  v_table_b uuid;
  v_table_c uuid;
  v_fries uuid;
  v_order uuid;
begin
  select id into v_outlet_a from public.outlets
  where business_id = 'cccccccc-0000-0000-0000-000000000001' and slug = 'main';
  select id into v_table_a from public.dining_tables where label = 'T-P9A';
  select id into v_table_b from public.dining_tables where label = 'T-P9B';
  select id into v_table_c from public.dining_tables where label = 'T-P9C';
  select id into v_fries from public.menu_items
  where business_id = 'cccccccc-0000-0000-0000-000000000001' and name = 'P8 Fries';
  select current_order_id into v_order from public.dining_tables where id = v_table_a;

  -- moving onto an occupied table is rejected
  begin
    perform public.amend_pos_order(v_actor, v_order, jsonb_build_object(
      'outlet_id', v_outlet_a, 'table_id', v_table_c,
      'items', jsonb_build_array(jsonb_build_object('item_type','product','product_id', v_fries,'quantity',1))));
    raise exception 'amend moved onto an occupied table';
  exception when others then
    if sqlerrm not ilike '%already occupied%' then raise; end if;
  end;

  -- moving onto a free table swaps occupancy
  perform public.amend_pos_order(v_actor, v_order, jsonb_build_object(
    'outlet_id', v_outlet_a, 'table_id', v_table_b,
    'items', jsonb_build_array(jsonb_build_object('item_type','product','product_id', v_fries,'quantity',1))));
  if (select status from public.dining_tables where id = v_table_a) <> 'available' then
    raise exception 'old table not freed by amend';
  end if;
  if (select current_order_id from public.dining_tables where id = v_table_b) <> v_order then
    raise exception 'new table not linked by amend';
  end if;
  if (select table_id from public.orders where id = v_order) <> v_table_b then
    raise exception 'order.table_id not updated by amend';
  end if;

  raise notice 'OK: amend swaps tables with guards';
end $$;

\echo '── P9.6: cancelling an order frees its table'
do $$
declare
  v_actor uuid := 'aaaaaaaa-0000-0000-0000-000000000001';
  v_table_c uuid;
  v_order uuid;
begin
  select id into v_table_c from public.dining_tables where label = 'T-P9C';
  select current_order_id into v_order from public.dining_tables where id = v_table_c;

  perform public.transition_order_status(v_actor, v_order, 'cancelled');
  if (select status from public.dining_tables where id = v_table_c) <> 'available' then
    raise exception 'cancel did not free the table';
  end if;
  if (select current_order_id from public.dining_tables where id = v_table_c) is not null then
    raise exception 'cancel did not clear current_order_id';
  end if;

  raise notice 'OK: cancel frees the table';
end $$;

\echo '── P9.7: transfer_table'
do $$
declare
  v_actor uuid := 'aaaaaaaa-0000-0000-0000-000000000001';
  v_biz_b uuid := 'dddddddd-0000-0000-0000-000000000002';
  v_outlet_a uuid;
  v_table_b uuid;
  v_table_d uuid;
  v_table_foreign uuid;
  v_order uuid;
  v_takeaway uuid;
  v_fries uuid;
begin
  select id into v_outlet_a from public.outlets
  where business_id = 'cccccccc-0000-0000-0000-000000000001' and slug = 'main';
  select id into v_table_b from public.dining_tables where label = 'T-P9B';
  select id into v_table_d from public.dining_tables where label = 'T-P9D';
  select id into v_table_foreign from public.dining_tables where label = 'T-B9';
  select current_order_id into v_order from public.dining_tables where id = v_table_b;
  select id into v_fries from public.menu_items
  where business_id = 'cccccccc-0000-0000-0000-000000000001' and name = 'P8 Fries';

  -- cross-outlet target rejected
  begin
    perform public.transfer_table(v_actor, v_order, v_table_foreign);
    raise exception 'transfer onto a foreign-outlet table accepted';
  exception when others then
    if sqlerrm not ilike '%belongs to this outlet%' then raise; end if;
  end;

  -- happy path
  perform public.transfer_table(v_actor, v_order, v_table_d);
  if (select status from public.dining_tables where id = v_table_b) <> 'available' then
    raise exception 'source table not freed by transfer';
  end if;
  if (select current_order_id from public.dining_tables where id = v_table_d) <> v_order then
    raise exception 'target table not linked by transfer';
  end if;

  -- occupied target rejected (seat T-P9B again first)
  perform public.create_pos_order(v_actor, jsonb_build_object(
    'outlet_id', v_outlet_a, 'client_ref', 'p9-seat-004', 'order_type', 'dine_in',
    'table_id', v_table_b,
    'items', jsonb_build_array(jsonb_build_object('item_type','product','product_id', v_fries,'quantity',1))));
  begin
    perform public.transfer_table(v_actor, v_order, v_table_b);
    raise exception 'transfer onto occupied table accepted';
  exception when others then
    if sqlerrm not ilike '%already occupied%' then raise; end if;
  end;

  -- non-dine-in orders cannot be transferred
  v_takeaway := public.create_pos_order(v_actor, jsonb_build_object(
    'outlet_id', v_outlet_a, 'client_ref', 'p9-takeaway-001', 'order_type', 'takeaway',
    'items', jsonb_build_array(jsonb_build_object('item_type','product','product_id', v_fries,'quantity',1))));
  begin
    perform public.transfer_table(v_actor, v_takeaway, v_table_b);
    raise exception 'takeaway order transferred to a table';
  exception when others then
    if sqlerrm not ilike '%dine-in%' then raise; end if;
  end;
  perform public.transition_order_status(v_actor, v_takeaway, 'cancelled');

  raise notice 'OK: transfer_table guards + happy path';
end $$;

\echo '── P9.8: merge_tables (items move, totals re-priced, merged order closes)'
do $$
declare
  v_actor uuid := 'aaaaaaaa-0000-0000-0000-000000000001';
  v_biz_a uuid := 'cccccccc-0000-0000-0000-000000000001';
  v_outlet_a uuid;
  v_branch uuid;
  v_table_a uuid;
  v_table_c uuid;
  v_fries uuid;
  v_keep uuid;
  v_merge uuid;
  v_branch_order uuid;
  v_keep_total bigint;
  v_merge_total bigint;
begin
  select id into v_outlet_a from public.outlets where business_id = v_biz_a and slug = 'main';
  select id into v_branch from public.outlets where business_id = v_biz_a and slug = 'branch';
  select id into v_table_a from public.dining_tables where label = 'T-P9A';
  select id into v_table_c from public.dining_tables where label = 'T-P9C';
  select id into v_fries from public.menu_items where business_id = v_biz_a and name = 'P8 Fries';

  v_keep := public.create_pos_order(v_actor, jsonb_build_object(
    'outlet_id', v_outlet_a, 'client_ref', 'p9-keep-001', 'order_type', 'dine_in',
    'table_id', v_table_a,
    'items', jsonb_build_array(jsonb_build_object('item_type','product','product_id', v_fries,'quantity',1))));
  v_merge := public.create_pos_order(v_actor, jsonb_build_object(
    'outlet_id', v_outlet_a, 'client_ref', 'p9-merge-001', 'order_type', 'dine_in',
    'table_id', v_table_c,
    'items', jsonb_build_array(jsonb_build_object('item_type','product','product_id', v_fries,'quantity',2))));

  select total_minor into v_keep_total from public.orders where id = v_keep;
  select total_minor into v_merge_total from public.orders where id = v_merge;

  -- merging self is rejected
  begin
    perform public.merge_tables(v_actor, v_keep, v_keep);
    raise exception 'order merged into itself';
  exception when others then
    if sqlerrm not ilike '%two different orders%' then raise; end if;
  end;

  -- cross-outlet order rejected (order on the branch outlet)
  v_branch_order := public.create_pos_order(v_actor, jsonb_build_object(
    'outlet_id', v_branch, 'client_ref', 'p9-branch-001', 'order_type', 'takeaway',
    'items', jsonb_build_array(jsonb_build_object('item_type','product','product_id', v_fries,'quantity',1))));
  begin
    perform public.merge_tables(v_actor, v_keep, v_branch_order);
    raise exception 'cross-outlet merge accepted';
  exception when others then
    if sqlerrm not ilike '%same outlet%' then raise; end if;
  end;
  perform public.transition_order_status(v_actor, v_branch_order, 'cancelled');

  -- happy path
  perform public.merge_tables(v_actor, v_keep, v_merge);
  if (select count(*) from public.order_items where order_id = v_keep) <> 2 then
    raise exception 'merged items did not move to the kept order';
  end if;
  if (select status from public.orders where id = v_merge) <> 'cancelled' then
    raise exception 'merged order not cancelled';
  end if;
  if (select table_id from public.orders where id = v_merge) is not null then
    raise exception 'merged order still linked to a table';
  end if;
  if (select status from public.dining_tables where id = v_table_c) <> 'available' then
    raise exception 'merged table not freed';
  end if;
  if (select total_minor from public.orders where id = v_keep) <> v_keep_total + v_merge_total then
    raise exception 'kept order total % ≠ % + %',
      (select total_minor from public.orders where id = v_keep), v_keep_total, v_merge_total;
  end if;
  if (select current_order_id from public.dining_tables where id = v_table_a) <> v_keep then
    raise exception 'kept table lost its order link';
  end if;

  -- paid orders cannot be merged
  v_merge := public.create_pos_order(v_actor, jsonb_build_object(
    'outlet_id', v_outlet_a, 'client_ref', 'p9-merge-002', 'order_type', 'dine_in',
    'table_id', v_table_c,
    'items', jsonb_build_array(jsonb_build_object('item_type','product','product_id', v_fries,'quantity',1))));
  update public.orders set paid_minor = total_minor, payment_status = 'paid' where id = v_merge;
  begin
    perform public.merge_tables(v_actor, v_keep, v_merge);
    raise exception 'paid order merged';
  exception when others then
    if sqlerrm not ilike '%recorded payments%' then raise; end if;
  end;
  update public.orders set paid_minor = 0, payment_status = 'unpaid' where id = v_merge;
  perform public.transition_order_status(v_actor, v_merge, 'cancelled');

  raise notice 'OK: merge moves items, re-prices, closes merged order, frees table';
end $$;

\echo '── P9.9: split_order (new order on target table, both sides re-priced)'
do $$
declare
  v_actor uuid := 'aaaaaaaa-0000-0000-0000-000000000001';
  v_biz_a uuid := 'cccccccc-0000-0000-0000-000000000001';
  v_outlet_a uuid;
  v_table_a uuid;
  v_table_c uuid;
  v_table_b uuid;
  v_fries uuid;
  v_burger uuid;
  v_source uuid;
  v_new uuid;
  v_item_fries uuid;
  v_item_burger uuid;
  v_total_before bigint;
begin
  select id into v_outlet_a from public.outlets where business_id = v_biz_a and slug = 'main';
  select id into v_table_a from public.dining_tables where label = 'T-P9A';
  select id into v_table_b from public.dining_tables where label = 'T-P9B';
  select id into v_table_c from public.dining_tables where label = 'T-P9C';
  select id into v_fries from public.menu_items where business_id = v_biz_a and name = 'P8 Fries';
  select id into v_burger from public.menu_items where business_id = v_biz_a and name = 'P8 Burger';

  v_source := public.create_pos_order(v_actor, jsonb_build_object(
    'outlet_id', v_outlet_a, 'client_ref', 'p9-split-001', 'order_type', 'dine_in',
    'table_id', v_table_c,
    'items', jsonb_build_array(
      jsonb_build_object('item_type','product','product_id', v_fries,'quantity',1),
      jsonb_build_object('item_type','product','product_id', v_burger,'quantity',1))));
  select total_minor into v_total_before from public.orders where id = v_source;
  select id into v_item_burger from public.order_items where order_id = v_source and product_id = v_burger;
  select id into v_item_fries from public.order_items where order_id = v_source and product_id = v_fries;

  -- moving every item is rejected
  begin
    perform public.split_order(v_actor, v_source, array[v_item_burger, v_item_fries], v_table_a);
    raise exception 'split moved every item';
  exception when others then
    if sqlerrm not ilike '%leave at least one item%' then raise; end if;
  end;

  -- occupied target rejected (T-P9B is occupied from P9.7)
  begin
    perform public.split_order(v_actor, v_source, array[v_item_burger], v_table_b);
    raise exception 'split onto an occupied table';
  exception when others then
    if sqlerrm not ilike '%already occupied%' then raise; end if;
  end;

  -- foreign item ids rejected
  begin
    perform public.split_order(v_actor, v_source,
      array[(select id from public.order_items where order_id <> v_source limit 1)], v_table_a);
    raise exception 'split accepted a foreign item';
  exception when others then
    if sqlerrm not ilike '%do not belong%' then raise; end if;
  end;

  -- happy path: burger moves to T-P9A (after freeing it)
  perform public.transition_order_status(v_actor,
    (select current_order_id from public.dining_tables where id = v_table_a), 'cancelled');
  v_new := public.split_order(v_actor, v_source, array[v_item_burger], v_table_a);

  if (select count(*) from public.order_items where order_id = v_new) <> 1 then
    raise exception 'split order did not receive exactly one item';
  end if;
  if (select count(*) from public.order_items where order_id = v_source) <> 1 then
    raise exception 'source order lost more than the split item';
  end if;
  if (select order_type from public.orders where id = v_new) <> 'dine_in'
     or (select status from public.orders where id = v_new) <> 'open' then
    raise exception 'split order has wrong type/status';
  end if;
  if (select current_order_id from public.dining_tables where id = v_table_a) <> v_new then
    raise exception 'split target table not occupied by new order';
  end if;
  if (select status from public.dining_tables where id = v_table_c) <> 'occupied' then
    raise exception 'source table lost its occupancy';
  end if;
  if (select total_minor from public.orders where id = v_source)
     + (select total_minor from public.orders where id = v_new) <> v_total_before then
    raise exception 'split totals % + % ≠ original %',
      (select total_minor from public.orders where id = v_source),
      (select total_minor from public.orders where id = v_new),
      v_total_before;
  end if;

  raise notice 'OK: split creates a new table order and re-prices both sides';
end $$;

\echo '── P9.10: complete_table (settlement gate + reservation release)'
do $$
declare
  v_actor uuid := 'aaaaaaaa-0000-0000-0000-000000000001';
  v_biz_a uuid := 'cccccccc-0000-0000-0000-000000000001';
  v_outlet_a uuid;
  v_table_a uuid;
  v_table_b uuid;
  v_table_d uuid;
  v_order uuid;
  v_fries uuid;
begin
  select id into v_outlet_a from public.outlets where business_id = v_biz_a and slug = 'main';
  select id into v_table_a from public.dining_tables where label = 'T-P9A';
  select id into v_table_b from public.dining_tables where label = 'T-P9B';
  select id into v_table_d from public.dining_tables where label = 'T-P9D';
  select id into v_fries from public.menu_items where business_id = v_biz_a and name = 'P8 Fries';

  -- available table: no-op (fresh table so the other fixtures stay untouched)
  insert into public.dining_tables (business_id, outlet_id, section_id, label, capacity)
  select business_id, outlet_id, section_id, 'T-P9E', 2
  from public.dining_tables where label = 'T-P9A';
  perform public.complete_table(v_actor,
    (select id from public.dining_tables where label = 'T-P9E'));
  if (select status from public.dining_tables where label = 'T-P9E') <> 'available' then
    raise exception 'complete_table disturbed an available table';
  end if;

  -- reserved table: released
  perform public.transition_order_status(v_actor,
    (select current_order_id from public.dining_tables where id = v_table_b), 'cancelled');
  perform public.reserve_table(v_actor, v_table_b, 'tonight');
  perform public.complete_table(v_actor, v_table_b);
  if (select status from public.dining_tables where id = v_table_b) <> 'available' then
    raise exception 'complete_table did not release a reserved table';
  end if;

  -- occupied table with unpaid order: settlement gate blocks
  v_order := (select current_order_id from public.dining_tables where id = v_table_a);
  perform public.transition_order_status(v_actor, v_order, 'placed');
  perform public.transition_order_status(v_actor, v_order, 'preparing');
  perform public.transition_order_status(v_actor, v_order, 'ready');
  begin
    perform public.complete_table(v_actor, v_table_a);
    raise exception 'unpaid table completed';
  exception when others then
    if sqlerrm not ilike '%settle the bill%' then raise; end if;
  end;

  -- order not ready yet: blocked too
  perform public.create_pos_order(v_actor, jsonb_build_object(
    'outlet_id', v_outlet_a, 'client_ref', 'p9-notready-001', 'order_type', 'dine_in',
    'table_id', v_table_b,
    'items', jsonb_build_array(jsonb_build_object('item_type','product','product_id', v_fries,'quantity',1))));
  update public.orders set paid_minor = total_minor, payment_status = 'paid'
  where id = (select current_order_id from public.dining_tables where id = v_table_b);
  begin
    perform public.complete_table(v_actor, v_table_b);
    raise exception 'not-ready table completed';
  exception when others then
    if sqlerrm not ilike '%must be ready%' then raise; end if;
  end;
  update public.orders set paid_minor = 0, payment_status = 'unpaid'
  where id = (select current_order_id from public.dining_tables where id = v_table_b);

  -- paid + ready → completes order and frees table (Phase 10 payment seam
  -- is not live yet, so the paid state is simulated directly in the test)
  update public.orders set paid_minor = total_minor, payment_status = 'paid' where id = v_order;
  perform public.complete_table(v_actor, v_table_a);
  if (select status from public.orders where id = v_order) <> 'completed' then
    raise exception 'paid ready order not completed';
  end if;
  if (select status from public.dining_tables where id = v_table_a) <> 'available' then
    raise exception 'paid table not freed';
  end if;

  raise notice 'OK: complete_table settlement gate + release semantics';
end $$;

\echo '── P9.11: floor-plan replace is floor-aware and protects occupied tables'
do $$
declare
  v_actor uuid := 'aaaaaaaa-0000-0000-0000-000000000001';
  v_biz_a uuid := 'cccccccc-0000-0000-0000-000000000001';
  v_outlet_a uuid;
begin
  select id into v_outlet_a from public.outlets where business_id = v_biz_a and slug = 'main';

  -- occupied tables block a full replace
  begin
    perform public.set_outlet_floor_plan(v_actor, v_outlet_a,
      '[{"name":"Fresh start","tables":[{"label":"N1","capacity":2}]}]'::jsonb);
    raise exception 'floor plan replaced over occupied tables';
  exception when others then
    if sqlerrm not ilike '%occupied%' then raise; end if;
  end;

  raise notice 'OK: set_outlet_floor_plan guards occupied tables';
end $$;

\echo '── P9.12: concurrent seatings — exactly one wins (real two-session race)'
create extension if not exists dblink;
-- committed before the race block so the dblink sessions can see the row
insert into public.dining_tables (business_id, outlet_id, section_id, label, capacity)
select o.business_id, o.id, s.id, 'T-P9RACE', 4
from public.outlets o
join public.dining_sections s on s.outlet_id = o.id and s.name = 'P9 Window'
where o.business_id = 'cccccccc-0000-0000-0000-000000000001' and o.slug = 'main';
do $$
declare
  v_biz_a uuid := 'cccccccc-0000-0000-0000-000000000001';
  v_actor uuid := 'aaaaaaaa-0000-0000-0000-000000000001';
  v_outlet_a uuid;
  v_race uuid;
  v_fries uuid;
  v_conn text;
  v_sql_a text;
  v_sql_b text;
  v_res uuid;
  v_winners integer := 0;
begin
  select id into v_outlet_a from public.outlets where business_id = v_biz_a and slug = 'main';
  select id into v_fries from public.menu_items where business_id = v_biz_a and name = 'P8 Fries';
  -- T-P9RACE is inserted (and committed) by the statement above this block so
  -- the dblink racer sessions can see it.
  select id into v_race from public.dining_tables where label = 'T-P9RACE';

  v_conn := format('dbname=%s port=%s host=%s user=postgres',
    current_database(), current_setting('port'), current_setting('unix_socket_directories'));

  perform dblink_connect('lock_c', v_conn);
  perform dblink_connect('racer_a', v_conn);
  perform dblink_connect('racer_b', v_conn);

  -- Hold the table row lock in a side transaction so both racers queue up.
  perform dblink_exec('lock_c', 'begin');
  perform t.id from dblink('lock_c', format(
    'select id from public.dining_tables where id = %L for update', v_race)) as t(id uuid);

  v_sql_a := format(
    'select public.create_pos_order(%L, jsonb_build_object('
    '''outlet_id'', %L, ''client_ref'', ''p9-race-a-001'', ''order_type'', ''dine_in'', '
    '''table_id'', %L, ''items'', jsonb_build_array(jsonb_build_object('
    '''item_type'', ''product'', ''product_id'', %L, ''quantity'', 1))))',
    v_actor, v_outlet_a, v_race, v_fries);
  v_sql_b := format(
    'select public.create_pos_order(%L, jsonb_build_object('
    '''outlet_id'', %L, ''client_ref'', ''p9-race-b-001'', ''order_type'', ''dine_in'', '
    '''table_id'', %L, ''items'', jsonb_build_array(jsonb_build_object('
    '''item_type'', ''product'', ''product_id'', %L, ''quantity'', 1))))',
    v_actor, v_outlet_a, v_race, v_fries);

  -- Fire both concurrently, then release the gate.
  perform dblink_send_query('racer_a', v_sql_a);
  perform dblink_send_query('racer_b', v_sql_b);
  perform dblink_exec('lock_c', 'commit');

  begin
    declare v_tmp uuid; begin
      select t.order_id into v_tmp from dblink_get_result('racer_a') as t(order_id uuid);
      if v_tmp is not null then v_winners := v_winners + 1; end if;
    end;
  exception when others then
    if sqlerrm not ilike '%just taken%' then raise; end if;
  end;
  begin
    declare v_tmp uuid; begin
      select t.order_id into v_tmp from dblink_get_result('racer_b') as t(order_id uuid);
      if v_tmp is not null then v_winners := v_winners + 1; end if;
    end;
  exception when others then
    if sqlerrm not ilike '%just taken%' then raise; end if;
  end;

  if v_winners <> 1 then
    raise exception 'concurrent seating produced % winners (expected exactly 1)', v_winners;
  end if;
  if (select count(*) from public.orders where client_ref like 'p9-race-%') <> 1 then
    raise exception 'lost-winner ghost order survived';
  end if;
  if (select status from public.dining_tables where id = v_race) <> 'occupied'
     or (select current_order_id from public.dining_tables where id = v_race)
        <> (select id from public.orders where client_ref like 'p9-race-%') then
    raise exception 'table not occupied by the winning order';
  end if;

  perform dblink_disconnect('lock_c');
  perform dblink_disconnect('racer_a');
  perform dblink_disconnect('racer_b');
  raise notice 'OK: concurrent double-seating serialised — exactly one winner';
end $$;

\echo '── P9.13: reserve vs seat race — final state stays consistent'
-- Seating a reserved table is VALID (the reservation is consumed), so the
-- invariant here is not mutual exclusion but a corruption-free end state:
-- either reserved (reserve won, seating failed) or occupied by exactly one
-- order with the reservation note cleared.
do $$
declare
  v_biz_a uuid := 'cccccccc-0000-0000-0000-000000000001';
  v_actor uuid := 'aaaaaaaa-0000-0000-0000-000000000001';
  v_outlet_a uuid;
  v_table uuid;
  v_fries uuid;
  v_conn text;
  v_status text;
  v_order uuid;
  v_note text;
begin
  select id into v_outlet_a from public.outlets where business_id = v_biz_a and slug = 'main';
  select id into v_fries from public.menu_items where business_id = v_biz_a and name = 'P8 Fries';
  select id into v_table from public.dining_tables where label = 'T-P9E';

  v_conn := format('dbname=%s port=%s host=%s user=postgres',
    current_database(), current_setting('port'), current_setting('unix_socket_directories'));
  perform dblink_connect('lock_c', v_conn);
  perform dblink_connect('rsv', v_conn);
  perform dblink_connect('seat', v_conn);

  perform dblink_exec('lock_c', 'begin');
  perform t.id from dblink('lock_c', format(
    'select id from public.dining_tables where id = %L for update', v_table)) as t(id uuid);

  perform dblink_send_query('rsv', format(
    'select public.reserve_table(%L, %L, ''race'')', v_actor, v_table));
  perform dblink_send_query('seat', format(
    'select public.create_pos_order(%L, jsonb_build_object('
    '''outlet_id'', %L, ''client_ref'', ''p9-resrace-001'', ''order_type'', ''dine_in'', '
    '''table_id'', %L, ''items'', jsonb_build_array(jsonb_build_object('
    '''item_type'', ''product'', ''product_id'', %L, ''quantity'', 1))))',
    v_actor, v_outlet_a, v_table, v_fries));
  perform dblink_exec('lock_c', 'commit');

  begin
    perform t.x from dblink_get_result('rsv') as t(x text);
  exception when others then
    if sqlerrm not ilike '%only available%' then raise; end if;
  end;
  begin
    perform t.order_id from dblink_get_result('seat') as t(order_id uuid);
  exception when others then
    if sqlerrm not ilike '%just taken%' then raise; end if;
  end;

  select t.status, t.current_order_id, t.reservation_note
  into v_status, v_order, v_note
  from public.dining_tables t where t.id = v_table;

  if v_status = 'occupied' then
    if v_order is null then
      raise exception 'occupied table without a linked order';
    end if;
    if v_note is not null then
      raise exception 'reservation note survived seating';
    end if;
    if (select count(*) from public.orders where client_ref = 'p9-resrace-001') <> 1 then
      raise exception 'occupying order missing';
    end if;
  elsif v_status = 'reserved' then
    if v_order is not null then
      raise exception 'reserved table still linked to an order';
    end if;
  else
    raise exception 'table left in unexpected status %', v_status;
  end if;

  perform dblink_disconnect('lock_c');
  perform dblink_disconnect('rsv');
  perform dblink_disconnect('seat');
  raise notice 'OK: reserve-vs-seat race leaves a consistent table state (%)', v_status;
end $$;
