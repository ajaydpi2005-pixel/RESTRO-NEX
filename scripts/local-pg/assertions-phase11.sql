-- ─────────────────────────────────────────────────────────────────────────
-- RestroNex Phase 11 assertions: Kitchen Display System.
-- Runs after Phase 10. Tenant A (cccc…0001) has outlets 'main' and 'branch';
-- alice (aaaa…0001) owns it. carol (eeee…0003) is an un-granted waiter.
-- Fixtures added here:
--   kit_main   (…0020) kitchen_staff granted 'main' only
--   kit_branch (…0021) kitchen_staff granted 'branch' only
--   mgr        (…0022) outlet_manager granted 'main'
-- Products come from Phase 8 ('P8 Burger', 'P8 Fries', 'P8 Wrap',
-- combo 'P8 Meal'); the Phase 8 Burger has modifier 'P8 Cheese'. 'P8 Shake' is
-- unavailable at main by Phase 8 design, so Phase 11 uses its own 'P11 Juice'.
-- ─────────────────────────────────────────────────────────────────────────

\echo '── P11.0: fixtures (kitchen users, stations, routes)'
do $$
declare
  v_biz_a uuid := 'cccccccc-0000-0000-0000-000000000001';
  v_alice uuid := 'aaaaaaaa-0000-0000-0000-000000000001';
  v_main uuid;
  v_branch uuid;
  v_cat uuid;
  v_burger uuid; v_shake uuid; v_meal uuid;
  v_n integer;
begin
  insert into auth.users (id, email, raw_user_meta_data) values
    ('f1111111-0000-0000-0000-000000000020', 'kitmain@example.com', '{"full_name": "Kit Main"}'),
    ('f1111111-0000-0000-0000-000000000021', 'kitbranch@example.com', '{"full_name": "Kit Branch"}'),
    ('f1111111-0000-0000-0000-000000000022', 'mgr@example.com', '{"full_name": "Mona Manager"}');
  insert into public.memberships (user_id, business_id, role) values
    ('f1111111-0000-0000-0000-000000000020', v_biz_a, 'kitchen_staff'),
    ('f1111111-0000-0000-0000-000000000021', v_biz_a, 'kitchen_staff'),
    ('f1111111-0000-0000-0000-000000000022', v_biz_a, 'outlet_manager');

  select id into v_main from public.outlets where business_id = v_biz_a and slug = 'main';
  select id into v_branch from public.outlets where business_id = v_biz_a and slug = 'branch';

  insert into public.membership_outlets (membership_id, outlet_id)
  select m.id, v_main from public.memberships m
  where m.business_id = v_biz_a and m.user_id in ('f1111111-0000-0000-0000-000000000020', 'f1111111-0000-0000-0000-000000000022');
  insert into public.membership_outlets (membership_id, outlet_id)
  select m.id, v_branch from public.memberships m
  where m.business_id = v_biz_a and m.user_id = 'f1111111-0000-0000-0000-000000000021';

  -- a category with no route, for the Unrouted lane
  insert into public.menu_categories (business_id, name) values (v_biz_a, 'P11 Bar') returning id into v_cat;
  insert into public.menu_items (business_id, category_id, name, price_minor)
  values (v_biz_a, v_cat, 'P11 Soda', 3000);
  insert into public.menu_items (business_id, category_id, name, price_minor)
  values (v_biz_a, v_cat, 'P11 Juice', 4000);

  -- stations via the Phase 11 RPC (owner has kitchen.manage)
  v_n := public.kitchen_save_stations(v_alice, v_main,
    '[{"name":"Hot kitchen","description":"Grill and fryer"},{"name":"Beverages","description":"Bar"}]'::jsonb);
  if v_n <> 2 then raise exception 'expected 2 active stations, got %', v_n; end if;

  select id into v_burger from public.menu_items where business_id = v_biz_a and name = 'P8 Burger';
  select id into v_shake from public.menu_items where business_id = v_biz_a and name = 'P11 Juice';
  select id into v_meal from public.combos where business_id = v_biz_a and name = 'P8 Meal';

  -- routes: category → Hot kitchen, item → Beverages (overrides category), combo → Hot kitchen
  v_n := public.kitchen_save_routes(v_alice, v_main, jsonb_build_array(
    jsonb_build_object('target_type','category','target_id',(select id from public.menu_categories where business_id = v_biz_a and name = 'P8 POS'),
      'station_id',(select id from public.kitchen_stations where outlet_id = v_main and name = 'Hot kitchen')),
    jsonb_build_object('target_type','item','target_id',v_shake,
      'station_id',(select id from public.kitchen_stations where outlet_id = v_main and name = 'Beverages')),
    jsonb_build_object('target_type','combo','target_id',v_meal,
      'station_id',(select id from public.kitchen_stations where outlet_id = v_main and name = 'Hot kitchen'))
  ));
  if v_n <> 3 then raise exception 'expected 3 routes, got %', v_n; end if;

  raise notice 'OK: kitchen users, stations and routes configured for outlet main';
end $$;

\echo '── P11.1: schema, RLS, grants (kitchen clients can never write; no money columns)'
do $$
declare
  t text;
  v_bad text;
begin
  foreach t in array array['kitchen_routes','kitchen_items','kitchen_events'] loop
    if not exists (select 1 from pg_class c where c.relname = t and c.relrowsecurity) then
      raise exception 'RLS not enabled on %', t;
    end if;
    if has_table_privilege('authenticated', 'public.' || t, 'INSERT')
       or has_table_privilege('authenticated', 'public.' || t, 'UPDATE')
       or has_table_privilege('authenticated', 'public.' || t, 'DELETE') then
      raise exception 'authenticated can write %', t;
    end if;
    if has_table_privilege('anon', 'public.' || t, 'SELECT') then
      raise exception 'anon can read %', t;
    end if;
  end loop;

  -- the KDS projection and events must never carry money
  select string_agg(column_name, ', ') into v_bad
  from information_schema.columns
  where table_schema = 'public'
    and table_name in ('kitchen_items', 'kitchen_events')
    and (column_name ~* '(price|minor|total|amount|tax|discount|paid|payment|refund|invoice)');
  if v_bad is not null then raise exception 'money columns on kitchen tables: %', v_bad; end if;

  -- kitchen RPCs are not callable by API roles
  if has_function_privilege('authenticated', 'public.kds_advance_item(uuid,uuid,text,text)', 'EXECUTE')
     or has_function_privilege('anon', 'public.kds_advance_item(uuid,uuid,text,text)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.kds_advance_ticket(uuid,uuid,uuid,text,text)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.kds_set_priority(uuid,uuid,boolean)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.kds_acknowledge_event(uuid,uuid)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.kitchen_save_routes(uuid,uuid,jsonb)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.kitchen_save_stations(uuid,uuid,jsonb)', 'EXECUTE') then
    raise exception 'kitchen RPC executable by an API role';
  end if;

  -- orders are outlet-scoped now (no business-wide select policy left)
  if exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'orders'
             and policyname = 'orders_select_member') then
    raise exception 'business-wide orders select policy still present';
  end if;

  raise notice 'OK: kitchen tables RLS + read-only for clients; no money columns; RPCs server-only';
end $$;

\echo '── P11.2: permission matrix (kitchen staff never gain financial rights)'
do $$
declare
  v_keys text[];
  v_forbidden text[] := array['billing.%','refunds.%','discounts.%','settings.%','subscriptions.%',
                              'reports.%','outlets.%','staff.%','customers.%'];
  f text;
begin
  select array_agg(permission_key order by permission_key) into v_keys
  from public.role_permissions where role_key = 'kitchen_staff';
  if v_keys is distinct from array['kitchen.operate','kitchen.view','menu.view','orders.view'] then
    raise exception 'kitchen_staff permissions drifted: %', v_keys;
  end if;

  foreach f in array v_forbidden loop
    if exists (select 1 from public.role_permissions where role_key = 'kitchen_staff' and permission_key like f) then
      raise exception 'kitchen_staff holds financial/admin permission %', f;
    end if;
  end loop;

  if exists (select 1 from public.role_permissions where role_key = 'kitchen_staff' and permission_key = 'kitchen.manage') then
    raise exception 'kitchen_staff can manage routing';
  end if;

  if exists (select 1 from public.role_permissions
             where role_key in ('cashier','waiter','accountant','inventory_manager') and permission_key like 'kitchen.%') then
    raise exception 'non-kitchen role holds a kitchen permission';
  end if;

  if not exists (select 1 from public.role_permissions where role_key = 'outlet_manager' and permission_key = 'kitchen.manage')
     or not exists (select 1 from public.role_permissions where role_key = 'owner' and permission_key = 'kitchen.manage')
     or not exists (select 1 from public.role_permissions where role_key = 'business_admin' and permission_key = 'kitchen.manage') then
    raise exception 'managers are missing kitchen.manage';
  end if;

  raise notice 'OK: kitchen_staff = view + operate only; managers hold kitchen.manage';
end $$;

\echo '── P11.3: POS send routes items to stations (item > category > unrouted)'
do $$
declare
  v_biz_a uuid := 'cccccccc-0000-0000-0000-000000000001';
  v_alice uuid := 'aaaaaaaa-0000-0000-0000-000000000001';
  v_main uuid;
  v_order uuid;
  v_hot uuid; v_bev uuid;
  v_burger uuid; v_fries uuid; v_shake uuid; v_soda uuid;
  r record;
begin
  select id into v_main from public.outlets where business_id = v_biz_a and slug = 'main';
  select id into v_hot from public.kitchen_stations where outlet_id = v_main and name = 'Hot kitchen';
  select id into v_bev from public.kitchen_stations where outlet_id = v_main and name = 'Beverages';
  select id into v_burger from public.menu_items where business_id = v_biz_a and name = 'P8 Burger';
  select id into v_fries from public.menu_items where business_id = v_biz_a and name = 'P8 Fries';
  select id into v_shake from public.menu_items where business_id = v_biz_a and name = 'P11 Juice';
  select id into v_soda from public.menu_items where business_id = v_biz_a and name = 'P11 Soda';

  v_order := public.create_pos_order(v_alice, jsonb_build_object(
    'outlet_id', v_main, 'client_ref', 'p11-route-001', 'order_type', 'takeaway',
    'items', jsonb_build_array(
      jsonb_build_object('item_type','product','product_id',v_burger,'quantity',1),
      jsonb_build_object('item_type','product','product_id',v_fries,'quantity',2),
      jsonb_build_object('item_type','product','product_id',v_shake,'quantity',1),
      jsonb_build_object('item_type','product','product_id',v_soda,'quantity',1))));

  -- open orders are not on the kitchen yet
  if exists (select 1 from public.kitchen_items where order_id = v_order) then
    raise exception 'open order leaked to the KDS before sending';
  end if;
  if (select count(*) from public.order_items where order_id = v_order and kitchen_status = 'pending') <> 4 then
    raise exception 'open order items should be pending';
  end if;

  perform public.transition_order_status(v_alice, v_order, 'placed', null);

  for r in select oi.name, oi.station_id, oi.kitchen_status, oi.kitchen_sent_at
           from public.order_items oi where oi.order_id = v_order loop
    if r.kitchen_status <> 'new' or r.kitchen_sent_at is null then
      raise exception 'item % not sent (status %)', r.name, r.kitchen_status;
    end if;
    if r.name = 'P8 Burger' and r.station_id is distinct from v_hot then raise exception 'burger not routed to hot kitchen'; end if;
    if r.name = 'P8 Fries' and r.station_id is distinct from v_hot then raise exception 'fries not routed via category'; end if;
    if r.name = 'P11 Juice' and r.station_id is distinct from v_bev then raise exception 'shake item route must beat category'; end if;
    if r.name = 'P11 Soda' and r.station_id is not null then raise exception 'unrouted soda got a station'; end if;
  end loop;

  if (select count(*) from public.kitchen_items where order_id = v_order) <> 4 then
    raise exception 'sent order did not project 4 kitchen items';
  end if;
  if (select count(*) from public.kitchen_items where order_id = v_order and kitchen_status = 'new' and sent_at is not null) <> 4 then
    raise exception 'projected items not new';
  end if;
  if (select kitchen_items.item_name from public.kitchen_items where order_id = v_order and item_name = 'P8 Fries') is null then
    raise exception 'fries missing from projection';
  end if;

  raise notice 'OK: send routes by item, then category; unrouted lane for unmatched items';
end $$;

\echo '── P11.4: kitchen actions advance items and tickets (kitchen progress moves the order status)'
do $$
declare
  v_biz_a uuid := 'cccccccc-0000-0000-0000-000000000001';
  v_kit uuid := 'f1111111-0000-0000-0000-000000000020';
  v_main uuid;
  v_order uuid;
  v_hot uuid; v_bev uuid;
  v_fries uuid; v_burger uuid; v_shake uuid; v_soda uuid;
  v_n integer;
  v_status text;
  v_err text;
begin
  select id into v_main from public.outlets where business_id = v_biz_a and slug = 'main';
  select id into v_order from public.orders where client_ref = 'p11-route-001';
  select id into v_hot from public.kitchen_stations where outlet_id = v_main and name = 'Hot kitchen';
  select id into v_bev from public.kitchen_stations where outlet_id = v_main and name = 'Beverages';
  select oi.id into v_burger from public.order_items oi where oi.order_id = v_order and oi.name = 'P8 Burger';
  select oi.id into v_fries from public.order_items oi where oi.order_id = v_order and oi.name = 'P8 Fries';
  select oi.id into v_shake from public.order_items oi where oi.order_id = v_order and oi.name = 'P11 Juice';
  select oi.id into v_soda from public.order_items oi where oi.order_id = v_order and oi.name = 'P11 Soda';

  -- item-level: new → accepted
  if public.kds_advance_item(v_kit, v_burger, 'new', 'accepted') <> 'accepted' then raise exception 'item not accepted'; end if;
  if (select kitchen_status from public.kitchen_items where id = v_burger) <> 'accepted' then
    raise exception 'projection not updated after accept';
  end if;

  -- stale: the item is no longer 'new'
  begin
    perform public.kds_advance_item(v_kit, v_burger, 'new', 'accepted');
    raise exception 'stale transition accepted';
  exception when others then
    if sqlerrm not ilike '%another screen%' then raise; end if;
  end;

  -- skipping a step is refused
  begin
    perform public.kds_advance_item(v_kit, v_burger, 'accepted', 'ready');
    raise exception 'skipped transition accepted';
  exception when others then
    if sqlerrm not ilike '%Invalid kitchen status%' then raise; end if;
  end;

  -- ticket: Hot kitchen lane is Burger (accepted) + Fries (new)
  v_n := public.kds_advance_ticket(v_kit, v_order, v_hot, 'new', 'accepted');
  if v_n <> 1 then raise exception 'ticket accept should move only fries, moved %', v_n; end if;
  v_n := public.kds_advance_ticket(v_kit, v_order, v_hot, 'accepted', 'preparing');
  if v_n <> 2 then raise exception 'ticket preparing should move 2, moved %', v_n; end if;
  v_n := public.kds_advance_ticket(v_kit, v_order, v_hot, 'preparing', 'ready');
  if v_n <> 2 then raise exception 'ticket ready should move 2, moved %', v_n; end if;
  -- double-tap from a second screen moves nothing
  v_n := public.kds_advance_ticket(v_kit, v_order, v_hot, 'preparing', 'ready');
  if v_n <> 0 then raise exception 'duplicate ticket bump moved %', v_n; end if;
  v_n := public.kds_advance_ticket(v_kit, v_order, v_hot, 'ready', 'completed');
  if v_n <> 2 then raise exception 'ticket completion should move 2, moved %', v_n; end if;

  -- completed items leave the board: their projection row is completed, not active
  if exists (select 1 from public.kitchen_items
             where id in (v_burger, v_fries) and kitchen_status not in ('completed')) then
    raise exception 'completed items still on the board';
  end if;
  if (select count(*) from public.kitchen_items where id in (v_burger, v_fries) and kitchen_status = 'completed') <> 2 then
    raise exception 'completed items not projected as completed';
  end if;

  -- beverages lane and unrouted lane still active
  v_n := public.kds_advance_ticket(v_kit, v_order, v_bev, 'new', 'accepted');
  if v_n <> 1 then raise exception 'beverages lane should hold 1 item, moved %', v_n; end if;
  v_n := public.kds_advance_ticket(v_kit, v_order, null, 'new', 'accepted');
  if v_n <> 1 then raise exception 'unrouted lane should hold 1 item, moved %', v_n; end if;

  -- Phase 12: kitchen progress moves the order along allowed transitions. Items are
  -- accepted/ready but the beverage and unrouted lanes are still active, so the order
  -- is 'preparing' (not 'ready', and never 'completed').
  select status into v_status from public.orders where id = v_order;
  if v_status <> 'preparing' then raise exception 'order should be preparing, is %', v_status; end if;

  raise notice 'OK: item and ticket lifecycle; stale and skipped transitions refused; order preparing';
end $$;

\echo '── P11.5: kitchen RPC authorisation (outlet, permission, role)'
do $$
declare
  v_biz_a uuid := 'cccccccc-0000-0000-0000-000000000001';
  v_main uuid;
  v_order uuid;
  v_item uuid;
  v_kit_branch uuid := 'f1111111-0000-0000-0000-000000000021';
  v_acct uuid := 'f1111111-0000-0000-0000-000000000011';
  v_kit_main uuid := 'f1111111-0000-0000-0000-000000000020';
  v_carol uuid := 'eeeeeeee-0000-0000-0000-000000000003';
  v_hot uuid;
begin
  select id into v_main from public.outlets where business_id = v_biz_a and slug = 'main';
  select id into v_order from public.orders where client_ref = 'p11-route-001';
  select id into v_hot from public.kitchen_stations where outlet_id = v_main and name = 'Hot kitchen';
  select oi.id into v_item from public.order_items oi where oi.order_id = v_order and oi.name = 'P11 Soda';

  -- another outlet's kitchen staff cannot operate main's board
  begin
    perform public.kds_advance_item(v_kit_branch, v_item, 'accepted', 'preparing');
    raise exception 'cross-outlet kitchen action accepted';
  exception when others then
    if sqlerrm = 'cross-outlet kitchen action accepted' then raise; end if;
  end;

  -- accountant: no kitchen rights anywhere
  begin
    perform public.kds_set_priority(v_acct, v_order, true);
    raise exception 'accountant set kitchen priority';
  exception when others then
    if sqlerrm = 'accountant set kitchen priority' then raise; end if;
  end;

  -- kitchen staff cannot change routing or stations
  begin
    perform public.kitchen_save_routes(v_kit_main, v_main, '[]'::jsonb);
    raise exception 'kitchen staff saved routes';
  exception when others then
    if sqlerrm = 'kitchen staff saved routes' then raise; end if;
  end;
  begin
    perform public.kitchen_save_stations(v_kit_main, v_main, '[{"name":"X"}]'::jsonb);
    raise exception 'kitchen staff saved stations';
  exception when others then
    if sqlerrm = 'kitchen staff saved stations' then raise; end if;
  end;

  -- un-granted waiter
  begin
    perform public.kds_advance_ticket(v_carol, v_order, v_hot, 'accepted', 'preparing');
    raise exception 'ungranted waiter operated the KDS';
  exception when others then
    if sqlerrm = 'ungranted waiter operated the KDS' then raise; end if;
  end;

  -- the same kitchen staff member CAN operate main
  if public.kds_advance_item(v_kit_main, v_item, 'accepted', 'preparing') <> 'preparing' then
    raise exception 'kitchen staff could not operate main';
  end if;

  raise notice 'OK: cross-outlet, financial-role, un-granted and config attempts all refused';
end $$;

\echo '── P11.6: money is untouched by kitchen work'
do $$
declare
  v_biz_a uuid := 'cccccccc-0000-0000-0000-000000000001';
  v_order uuid;
  v_before record;
  v_after record;
  v_pay_before bigint; v_pay_after bigint;
  v_kit uuid := 'f1111111-0000-0000-0000-000000000020';
begin
  select id into v_order from public.orders where client_ref = 'p11-route-001';
  select total_minor, subtotal_minor, payment_status, status into v_before
  from public.orders where id = v_order;
  select count(*) into v_pay_before from public.payments;

  perform public.kds_set_priority(v_kit, v_order, true);
  perform public.kds_advance_ticket(v_kit, v_order, null, 'accepted', 'preparing');
  perform public.kds_advance_ticket(v_kit, v_order, null, 'preparing', 'ready');

  select total_minor, subtotal_minor, payment_status, status into v_after
  from public.orders where id = v_order;
  select count(*) into v_pay_after from public.payments;

  if v_before is distinct from v_after then raise exception 'kitchen work changed money or status'; end if;
  if v_pay_before <> v_pay_after then raise exception 'kitchen work created payments'; end if;

  -- restore for later sections
  perform public.kds_set_priority(v_kit, v_order, false);
  perform public.kds_advance_ticket(v_kit, v_order, null, 'ready', 'completed');

  raise notice 'OK: kitchen actions leave totals, payment status and payments unchanged';
end $$;

\echo '── P11.7: priority and acknowledgement'
do $$
declare
  v_biz_a uuid := 'cccccccc-0000-0000-0000-000000000001';
  v_alice uuid := 'aaaaaaaa-0000-0000-0000-000000000001';
  v_main uuid;
  v_kit uuid := 'f1111111-0000-0000-0000-000000000020';
  v_open uuid;
  v_order uuid;
  v_event uuid;
begin
  select id into v_main from public.outlets where business_id = v_biz_a and slug = 'main';

  -- priority flows to the projection
  select id into v_order from public.orders where client_ref = 'p11-route-001';
  perform public.kds_set_priority(v_kit, v_order, true);
  if (select count(*) from public.kitchen_items where order_id = v_order and priority
      and kitchen_status in ('new', 'accepted', 'preparing', 'ready')) <> 1 then
    raise exception 'priority not projected to the active items';
  end if;
  perform public.kds_set_priority(v_kit, v_order, false);
  if exists (select 1 from public.kitchen_items where order_id = v_order and priority
             and kitchen_status in ('new', 'accepted', 'preparing', 'ready')) then
    raise exception 'priority not cleared';
  end if;

  -- open orders cannot be prioritised
  v_open := public.create_pos_order(v_alice, jsonb_build_object(
    'outlet_id', v_main, 'client_ref', 'p11-open-001', 'order_type', 'takeaway',
    'items', jsonb_build_array(jsonb_build_object('item_type','product',
      'product_id',(select id from public.menu_items where business_id = v_biz_a and name = 'P8 Wrap'),'quantity',1))));
  begin
    perform public.kds_set_priority(v_kit, v_open, true);
    raise exception 'open order prioritised';
  exception when others then
    if sqlerrm = 'open order prioritised' then raise; end if;
  end;

  -- pending item of an open order becomes new when it is sent (open → placed)
  if (select count(*) from public.kitchen_items where order_id = v_open) <> 0 then
    raise exception 'open order projected';
  end if;
  perform public.transition_order_status(v_alice, v_open, 'placed', null);
  if (select count(*) from public.kitchen_items where order_id = v_open and kitchen_status = 'new') <> 1 then
    raise exception 'sent open order did not reach the board';
  end if;

  -- acknowledgement: operate permission, idempotent, outlet-bound
  select id into v_event from public.kitchen_events limit 1;
  if v_event is not null then
    raise exception 'unexpected events before any cancellation';
  end if;

  raise notice 'OK: priority projected, open orders refused, pending items reach the board when sent';
end $$;

\echo '── P11.8: cancellations notify the kitchen; removals notify too'
do $$
declare
  v_biz_a uuid := 'cccccccc-0000-0000-0000-000000000001';
  v_alice uuid := 'aaaaaaaa-0000-0000-0000-000000000001';
  v_kit uuid := 'f1111111-0000-0000-0000-000000000020';
  v_kit_branch uuid := 'f1111111-0000-0000-0000-000000000021';
  v_main uuid;
  v_order uuid;
  v_burger uuid; v_wrap uuid;
  v_cnt integer;
  v_ev uuid;
begin
  select id into v_main from public.outlets where business_id = v_biz_a and slug = 'main';

  -- order cancellation: active items → cancelled, events raised, board cleared
  v_order := public.create_pos_order(v_alice, jsonb_build_object(
    'outlet_id', v_main, 'client_ref', 'p11-cancel-001', 'order_type', 'takeaway',
    'items', jsonb_build_array(
      jsonb_build_object('item_type','product','product_id',(select id from public.menu_items where business_id = v_biz_a and name = 'P8 Burger'),'quantity',1),
      jsonb_build_object('item_type','product','product_id',(select id from public.menu_items where business_id = v_biz_a and name = 'P11 Soda'),'quantity',1))));
  perform public.transition_order_status(v_alice, v_order, 'placed', null);
  select oi.id into v_burger from public.order_items oi where oi.order_id = v_order and oi.name = 'P8 Burger';
  perform public.kds_advance_item(v_kit, v_burger, 'new', 'accepted');

  perform public.transition_order_status(v_alice, v_order, 'cancelled', 'Customer left');

  if (select count(*) from public.order_items where order_id = v_order and kitchen_status = 'cancelled') <> 2 then
    raise exception 'cancelled order items not cancelled on the kitchen side';
  end if;
  if exists (select 1 from public.kitchen_items where order_id = v_order
             and kitchen_status in ('new', 'accepted', 'preparing', 'ready')) then
    raise exception 'cancelled order still on the board';
  end if;
  select count(*) into v_cnt from public.kitchen_events
  where order_id = v_order and reason = 'order_cancelled' and acknowledged_at is null;
  if v_cnt <> 2 then raise exception 'expected 2 cancellation events, got %', v_cnt; end if;

  -- item removal from a sent order notifies the kitchen
  v_order := public.create_pos_order(v_alice, jsonb_build_object(
    'outlet_id', v_main, 'client_ref', 'p11-remove-001', 'order_type', 'takeaway',
    'items', jsonb_build_array(
      jsonb_build_object('item_type','product','product_id',(select id from public.menu_items where business_id = v_biz_a and name = 'P8 Wrap'),'quantity',1),
      jsonb_build_object('item_type','product','product_id',(select id from public.menu_items where business_id = v_biz_a and name = 'P8 Fries'),'quantity',1))));
  perform public.transition_order_status(v_alice, v_order, 'placed', null);
  select oi.id into v_wrap from public.order_items oi where oi.order_id = v_order and oi.name = 'P8 Wrap';
  delete from public.order_items where id = v_wrap;

  if exists (select 1 from public.kitchen_items where id = v_wrap) then
    raise exception 'removed item still on the board';
  end if;
  select count(*) into v_cnt from public.kitchen_events
  where order_id = v_order and reason = 'item_removed' and item_name = 'P8 Wrap';
  if v_cnt <> 1 then raise exception 'item removal produced % events', v_cnt; end if;

  -- acknowledgement: outlet-bound and idempotent
  select id into v_ev from public.kitchen_events where order_id = v_order and reason = 'item_removed';
  begin
    perform public.kds_acknowledge_event(v_kit_branch, v_ev);
    raise exception 'other outlet acknowledged the event';
  exception when others then
    if sqlerrm = 'other outlet acknowledged the event' then raise; end if;
  end;
  perform public.kds_acknowledge_event(v_kit, v_ev);
  perform public.kds_acknowledge_event(v_kit, v_ev);
  if (select acknowledged_by from public.kitchen_events where id = v_ev) <> v_kit then
    raise exception 'acknowledgement not recorded';
  end if;

  raise notice 'OK: order cancel and item removal raise events; acknowledgement outlet-bound and idempotent';
end $$;

\echo '── P11.9: moves between orders (merge/split) keep the board truthful'
do $$
declare
  v_biz_a uuid := 'cccccccc-0000-0000-0000-000000000001';
  v_alice uuid := 'aaaaaaaa-0000-0000-0000-000000000001';
  v_main uuid;
  v_sent uuid; v_open uuid;
  v_item uuid;
  v_status text;
begin
  select id into v_main from public.outlets where business_id = v_biz_a and slug = 'main';
  select id into v_sent from public.orders where client_ref = 'p11-route-001';

  -- sent item moved onto an open order: still sent, now listed under the new order
  select oi.id into v_item from public.order_items oi
  where oi.order_id = v_sent and oi.name = 'P11 Juice' and oi.kitchen_status = 'accepted';
  if v_item is null then raise exception 'expected an accepted shake on the sent order'; end if;
  v_open := public.create_pos_order(v_alice, jsonb_build_object(
    'outlet_id', v_main, 'client_ref', 'p11-move-dst', 'order_type', 'takeaway',
    'items', jsonb_build_array(jsonb_build_object('item_type','product',
      'product_id',(select id from public.menu_items where business_id = v_biz_a and name = 'P8 Wrap'),'quantity',1))));

  update public.order_items set order_id = v_open where id = v_item;
  select kitchen_status into v_status from public.order_items where id = v_item;
  if v_status = 'pending' then raise exception 'sent item became pending on move'; end if;
  if (select order_id from public.kitchen_items where id = v_item) is distinct from v_open then
    raise exception 'projection still points at the old order';
  end if;

  -- pending item moved onto a sent order is sent with it
  v_item := (select oi.id from public.order_items oi where oi.order_id = v_open and oi.name = 'P8 Wrap');
  update public.order_items set order_id = v_sent where id = v_item;
  if (select kitchen_status from public.order_items where id = v_item) <> 'new' then
    raise exception 'pending item merged into a sent order did not start';
  end if;
  if not exists (select 1 from public.kitchen_items where id = v_item and order_id = v_sent) then
    raise exception 'merged item missing from board';
  end if;

  raise notice 'OK: moved items keep their kitchen state and follow their new order';
end $$;

\echo '── P11.10: station changes never reroute in-flight work; deactivation is safe'
do $$
declare
  v_biz_a uuid := 'cccccccc-0000-0000-0000-000000000001';
  v_alice uuid := 'aaaaaaaa-0000-0000-0000-000000000001';
  v_main uuid;
  v_hot uuid; v_bev uuid;
  v_order uuid;
  v_n integer;
begin
  select id into v_main from public.outlets where business_id = v_biz_a and slug = 'main';
  select id into v_hot from public.kitchen_stations where outlet_id = v_main and name = 'Hot kitchen';
  select id into v_bev from public.kitchen_stations where outlet_id = v_main and name = 'Beverages';

  -- drop Beverages from the config: it is deactivated, not deleted
  v_n := public.kitchen_save_stations(v_alice, v_main, '[{"name":"Hot kitchen"}]'::jsonb);
  if v_n <> 1 then raise exception 'expected 1 active station, got %', v_n; end if;
  if not exists (select 1 from public.kitchen_stations where id = v_bev and not is_active) then
    raise exception 'removed station not deactivated';
  end if;

  -- a new Shake now has no active route target → unrouted (never a dead station)
  v_order := public.create_pos_order(v_alice, jsonb_build_object(
    'outlet_id', v_main, 'client_ref', 'p11-deact-001', 'order_type', 'takeaway',
    'items', jsonb_build_array(jsonb_build_object('item_type','product',
      'product_id',(select id from public.menu_items where business_id = v_biz_a and name = 'P11 Juice'),'quantity',1))));
  if (select station_id from public.order_items where order_id = v_order) is not null then
    raise exception 'item routed to a deactivated station';
  end if;

  -- restore: same station ids come back, routing resumes
  v_n := public.kitchen_save_stations(v_alice, v_main,
    '[{"name":"Hot kitchen"},{"name":"beverages"}]'::jsonb);
  if v_n <> 2 then raise exception 'expected 2 stations after restore, got %', v_n; end if;
  if not exists (select 1 from public.kitchen_stations where id = v_bev and is_active) then
    raise exception 'station identity lost on reactivation';
  end if;
  v_order := public.create_pos_order(v_alice, jsonb_build_object(
    'outlet_id', v_main, 'client_ref', 'p11-restore-001', 'order_type', 'takeaway',
    'items', jsonb_build_array(jsonb_build_object('item_type','product',
      'product_id',(select id from public.menu_items where business_id = v_biz_a and name = 'P11 Juice'),'quantity',1))));
  if (select station_id from public.order_items where order_id = v_order) is distinct from v_bev then
    raise exception 'routing did not resume after reactivation';
  end if;

  -- a sent branch order gives the isolation checks something to refuse
  v_order := public.create_pos_order(v_alice, jsonb_build_object(
    'outlet_id', (select id from public.outlets where business_id = v_biz_a and slug = 'branch'),
    'client_ref', 'p11-branch-001', 'order_type', 'takeaway',
    'items', jsonb_build_array(jsonb_build_object('item_type','product',
      'product_id',(select id from public.menu_items where business_id = v_biz_a and name = 'P8 Burger'),'quantity',1))));
  perform public.transition_order_status(v_alice, v_order, 'placed', null);

  -- onboarding entry point keeps working and is non-destructive too
  v_n := public.set_outlet_kitchen_stations(v_alice, v_main, '[{"name":"Hot kitchen"},{"name":"Beverages"}]'::jsonb);
  if v_n <> 2 then raise exception 'onboarding station save returned %', v_n; end if;

  raise notice 'OK: deactivated stations are never targets; reactivation keeps ids and routing';
end $$;

\echo '── P11.11: routing validation (business and outlet isolation)'
do $$
declare
  v_biz_a uuid := 'cccccccc-0000-0000-0000-000000000001';
  v_biz_b uuid := 'dddddddd-0000-0000-0000-000000000002';
  v_alice uuid := 'aaaaaaaa-0000-0000-0000-000000000001';
  v_main uuid; v_branch uuid;
  v_b_cat uuid;
  v_branch_station uuid;
  v_n integer;
begin
  select id into v_main from public.outlets where business_id = v_biz_a and slug = 'main';
  select id into v_branch from public.outlets where business_id = v_biz_a and slug = 'branch';
  select id into v_b_cat from public.menu_categories where business_id = v_biz_b limit 1;

  v_n := public.kitchen_save_stations(v_alice, v_branch, '[{"name":"Branch Grill"}]'::jsonb);
  select id into v_branch_station from public.kitchen_stations where outlet_id = v_branch and name = 'Branch Grill';

  -- another tenant's category
  begin
    perform public.kitchen_save_routes(v_alice, v_main, jsonb_build_array(jsonb_build_object(
      'target_type','category','target_id',v_b_cat,
      'station_id',(select id from public.kitchen_stations where outlet_id = v_main and name = 'Hot kitchen'))));
    raise exception 'foreign category routed';
  exception when others then
    if sqlerrm = 'foreign category routed' then raise; end if;
  end;

  -- a station from another outlet
  begin
    perform public.kitchen_save_routes(v_alice, v_main, jsonb_build_array(jsonb_build_object(
      'target_type','category','target_id',(select id from public.menu_categories where business_id = v_biz_a and name = 'P8 POS'),
      'station_id',v_branch_station)));
    raise exception 'cross-outlet station routed';
  exception when others then
    if sqlerrm = 'cross-outlet station routed' then raise; end if;
  end;

  -- unknown target type
  begin
    perform public.kitchen_save_routes(v_alice, v_main, jsonb_build_array(jsonb_build_object(
      'target_type','table','target_id',v_b_cat,
      'station_id',(select id from public.kitchen_stations where outlet_id = v_main and name = 'Hot kitchen'))));
    raise exception 'unknown target type accepted';
  exception when others then
    if sqlerrm = 'unknown target type accepted' then raise; end if;
  end;

  -- a failed save must not wipe the existing routes (atomic)
  if (select count(*) from public.kitchen_routes where outlet_id = v_main) <> 3 then
    raise exception 'failed route save changed the existing routes';
  end if;

  raise notice 'OK: foreign targets, cross-outlet stations and bad types refused; routes stay intact';
end $$;

\echo '── P11.12: modifiers and special instructions reach the kitchen'
do $$
declare
  v_biz_a uuid := 'cccccccc-0000-0000-0000-000000000001';
  v_alice uuid := 'aaaaaaaa-0000-0000-0000-000000000001';
  v_main uuid;
  v_order uuid;
  v_burger uuid;
  v_mod uuid;
  v_mods jsonb;
  v_notes text;
begin
  select id into v_main from public.outlets where business_id = v_biz_a and slug = 'main';
  select m.id into v_mod from public.modifiers m
  join public.modifier_groups g on g.id = m.modifier_group_id
  where m.business_id = v_biz_a and m.name = 'P8 Cheese';

  v_order := public.create_pos_order(v_alice, jsonb_build_object(
    'outlet_id', v_main, 'client_ref', 'p11-mod-001', 'order_type', 'takeaway',
    'items', jsonb_build_array(jsonb_build_object('item_type','product',
      'product_id',(select id from public.menu_items where business_id = v_biz_a and name = 'P8 Burger'),
      'quantity',2, 'item_notes','no onion',
      'modifiers', jsonb_build_array(jsonb_build_object('modifier_id', v_mod, 'quantity', 1))))));
  perform public.transition_order_status(v_alice, v_order, 'placed', null);

  select modifiers, item_notes into v_mods, v_notes
  from public.kitchen_items where order_id = v_order;
  if v_mods is null or v_mods -> 0 ->> 'name' <> 'P8 Cheese' then
    raise exception 'modifier not projected: %', v_mods;
  end if;
  if v_notes <> 'no onion' then raise exception 'special instructions not projected'; end if;
  if (select quantity from public.kitchen_items where order_id = v_order) <> 2 then
    raise exception 'quantity not projected';
  end if;

  raise notice 'OK: modifiers, quantities and special instructions projected to the KDS';
end $$;

\echo '── P11.13: outlet-scoped reads (realtime-safe) and anonymous denial'
set role authenticated;
set request.jwt.claims = '{"sub": "f1111111-0000-0000-0000-000000000020", "role": "authenticated"}';
do $$
declare
  v_main uuid; v_branch uuid;
  v_n integer;
begin
  select id into v_main from public.outlets where business_id = 'cccccccc-0000-0000-0000-000000000001' and slug = 'main';
  select id into v_branch from public.outlets where business_id = 'cccccccc-0000-0000-0000-000000000001' and slug = 'branch';

  select count(*) into v_n from public.kitchen_items where outlet_id = v_main;
  if v_n = 0 then raise exception 'kitchen staff cannot see their own outlet board'; end if;
  select count(*) into v_n from public.kitchen_items where outlet_id = v_branch;
  if v_n <> 0 then raise exception 'kitchen staff of main can read branch board (%)', v_n; end if;
  if (select count(*) from public.orders where outlet_id = v_branch and client_ref = 'p11-branch-001') <> 0 then
    raise exception 'main kitchen staff can see the branch order';
  end if;
  select count(*) into v_n from public.orders where outlet_id = v_branch;
  if v_n <> 0 then raise exception 'main kitchen staff can read branch orders (%)', v_n; end if;
  select count(*) into v_n from public.order_items oi
  join public.orders o on o.id = oi.order_id where o.outlet_id = v_branch;
  if v_n <> 0 then raise exception 'main kitchen staff can read branch order items (%)', v_n; end if;
  select count(*) into v_n from public.kitchen_events where outlet_id = v_branch;
  if v_n <> 0 then raise exception 'kitchen events leak across outlets'; end if;
  raise notice 'OK: kitchen_staff sees main board only';
end $$;
reset role;

set role authenticated;
set request.jwt.claims = '{"sub": "f1111111-0000-0000-0000-000000000021", "role": "authenticated"}';
do $$
declare
  v_main uuid;
  v_n integer;
begin
  select id into v_main from public.outlets where business_id = 'cccccccc-0000-0000-0000-000000000001' and slug = 'main';
  select count(*) into v_n from public.kitchen_items where outlet_id = v_main;
  if v_n <> 0 then raise exception 'branch kitchen staff can read main board (%)', v_n; end if;
  select count(*) into v_n from public.kitchen_items where outlet_id = (select id from public.outlets
    where business_id = 'cccccccc-0000-0000-0000-000000000001' and slug = 'branch');
  if v_n = 0 then raise exception 'branch kitchen staff cannot see their own board'; end if;
  select count(*) into v_n from public.orders where outlet_id = v_main;
  if v_n <> 0 then raise exception 'branch kitchen staff can read main orders (%)', v_n; end if;
  select count(*) into v_n from public.kitchen_routes where outlet_id = v_main;
  if v_n <> 0 then raise exception 'branch kitchen staff can read main routes'; end if;
  raise notice 'OK: branch kitchen staff sees nothing from main';
end $$;
reset role;

set role authenticated;
set request.jwt.claims = '{"sub": "eeeeeeee-0000-0000-0000-000000000003", "role": "authenticated"}';
do $$
declare
  v_main uuid;
  v_n integer;
begin
  select id into v_main from public.outlets where business_id = 'cccccccc-0000-0000-0000-000000000001' and slug = 'main';
  select count(*) into v_n from public.orders where outlet_id = v_main;
  if v_n <> 0 then raise exception 'un-granted waiter can read main orders (%)', v_n; end if;
  raise notice 'OK: un-granted waiter sees no outlet orders';
end $$;
reset role;

set role authenticated;
set request.jwt.claims = '{"sub": "f1111111-0000-0000-0000-000000000020", "role": "authenticated"}';
do $$
begin
  begin
    update public.kitchen_items set kitchen_status = 'completed';
    raise exception 'client updated the kitchen projection';
  exception when insufficient_privilege then
    null;
  end;
  begin
    delete from public.kitchen_events;
    raise exception 'client deleted kitchen events';
  exception when insufficient_privilege then
    null;
  end;
  raise notice 'OK: kitchen clients cannot write the projection or events directly';
end $$;
reset role;

set role anon;
do $$
begin
  begin
    perform 1 from public.kitchen_items limit 1;
    raise exception 'anon read kitchen items';
  exception when insufficient_privilege then
    null;
  end;
  raise notice 'OK: anonymous role cannot read the board';
end $$;
reset role;
reset request.jwt.claims;

\echo '── P11.14: realtime publication and replica identity'
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime'
                   and schemaname = 'public' and tablename = 'kitchen_items') then
      raise exception 'kitchen_items not in supabase_realtime';
    end if;
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime'
                   and schemaname = 'public' and tablename = 'kitchen_events') then
      raise exception 'kitchen_events not in supabase_realtime';
    end if;
    raise notice 'OK: kitchen_items and kitchen_events published to supabase_realtime';
  else
    raise notice 'SKIP: supabase_realtime publication absent in this local cluster (checked on hosted)';
  end if;
  if (select relreplident from pg_class where relname = 'kitchen_items') <> 'd'
     or (select relreplident from pg_class where relname = 'kitchen_events') <> 'd' then
    raise exception 'kitchen tables must keep DEFAULT replica identity (no full rows in delete payloads)';
  end if;
  raise notice 'OK: kitchen tables keep DEFAULT replica identity (delete payloads carry ids only)';
end $$;

\echo '── P11.15: order deletion cascades cleanly (no orphan board rows)'
do $$
declare
  v_order uuid;
begin
  select id into v_order from public.orders where client_ref = 'p11-mod-001';
  delete from public.orders where id = v_order;
  if exists (select 1 from public.kitchen_items where order_id = v_order) then
    raise exception 'orphan board rows after order delete';
  end if;
  if exists (select 1 from public.kitchen_events where order_id = v_order) then
    raise exception 'orphan events after order delete';
  end if;
  raise notice 'OK: deleting an order clears its board rows without error';
end $$;

\echo '── P11.16: Phase 10 money reads are scoped (kitchen staff read no money; outlet grants respected)'
do $$
declare
  v_biz uuid := 'cccccccc-0000-0000-0000-000000000001';
  v_main uuid; v_branch uuid;
begin
  select id into v_main from public.outlets where business_id = v_biz and slug = 'main';
  select id into v_branch from public.outlets where business_id = v_biz and slug = 'branch';

  insert into auth.users (id, email, raw_user_meta_data) values
    ('f1111111-0000-0000-0000-000000000030', 'p11cashmain@example.com', '{"full_name": "Cash Main"}'),
    ('f1111111-0000-0000-0000-000000000031', 'p11cashbranch@example.com', '{"full_name": "Cash Branch"}');
  insert into public.memberships (user_id, business_id, role) values
    ('f1111111-0000-0000-0000-000000000030', v_biz, 'cashier'),
    ('f1111111-0000-0000-0000-000000000031', v_biz, 'cashier');
  insert into public.membership_outlets (membership_id, outlet_id)
  select m.id, v_main from public.memberships m
  where m.business_id = v_biz and m.user_id = 'f1111111-0000-0000-0000-000000000030';
  insert into public.membership_outlets (membership_id, outlet_id)
  select m.id, v_branch from public.memberships m
  where m.business_id = v_biz and m.user_id = 'f1111111-0000-0000-0000-000000000031';

  -- expected counts, taken as the owner of the cluster (bypasses RLS)
  perform set_config('p11.exp.payments', (select count(*) from public.payments where outlet_id = v_main)::text, false);
  perform set_config('p11.exp.receipts', (select count(*) from public.receipts where outlet_id = v_main)::text, false);
  perform set_config('p11.exp.invoices', (select count(*) from public.invoices where outlet_id = v_main)::text, false);
  perform set_config('p11.exp.refunds', (select count(*) from public.refunds where outlet_id = v_main)::text, false);
  perform set_config('p11.exp.methods', (select count(*) from public.payment_methods where business_id = v_biz)::text, false);
  if current_setting('p11.exp.payments')::int = 0 or current_setting('p11.exp.methods')::int = 0 then
    raise exception 'fixture has no main payments or payment methods; the scope test would be vacuous';
  end if;
  raise notice 'OK: P11.16 fixtures ready (main payments=%, methods=%)',
    current_setting('p11.exp.payments'), current_setting('p11.exp.methods');
end $$;

-- kitchen staff: no billing.view and no refunds.view, so every money table is empty
set role authenticated;
set request.jwt.claims = '{"sub": "f1111111-0000-0000-0000-000000000020", "role": "authenticated"}';
do $$
declare
  v_biz uuid := 'cccccccc-0000-0000-0000-000000000001';
  v_main uuid; n integer;
begin
  select id into v_main from public.outlets where business_id = v_biz and slug = 'main';
  select count(*) into n from public.payments where outlet_id = v_main;
  if n <> 0 then raise exception 'kitchen staff can read payments (%)', n; end if;
  select count(*) into n from public.receipts where outlet_id = v_main;
  if n <> 0 then raise exception 'kitchen staff can read receipts (%)', n; end if;
  select count(*) into n from public.invoices where outlet_id = v_main;
  if n <> 0 then raise exception 'kitchen staff can read invoices (%)', n; end if;
  select count(*) into n from public.refunds where outlet_id = v_main;
  if n <> 0 then raise exception 'kitchen staff can read refunds (%)', n; end if;
  select count(*) into n from public.payment_methods where business_id = v_biz;
  if n <> 0 then raise exception 'kitchen staff can read payment methods (%)', n; end if;
  raise notice 'OK: kitchen staff read no payments, receipts, invoices, refunds or payment methods';
end $$;
reset role;

-- cashier granted main: sees main's money rows exactly as the owner does
set role authenticated;
set request.jwt.claims = '{"sub": "f1111111-0000-0000-0000-000000000030", "role": "authenticated"}';
do $$
declare
  v_biz uuid := 'cccccccc-0000-0000-0000-000000000001';
  v_main uuid; n integer;
begin
  select id into v_main from public.outlets where business_id = v_biz and slug = 'main';
  select count(*) into n from public.payments where outlet_id = v_main;
  if n <> current_setting('p11.exp.payments')::int then raise exception 'main cashier sees % payments, expected %', n, current_setting('p11.exp.payments'); end if;
  select count(*) into n from public.receipts where outlet_id = v_main;
  if n <> current_setting('p11.exp.receipts')::int then raise exception 'main cashier sees % receipts, expected %', n, current_setting('p11.exp.receipts'); end if;
  select count(*) into n from public.invoices where outlet_id = v_main;
  if n <> current_setting('p11.exp.invoices')::int then raise exception 'main cashier sees % invoices, expected %', n, current_setting('p11.exp.invoices'); end if;
  -- cashiers hold billing.view but not refunds.view (rbac matrix): no refund rows
  select count(*) into n from public.refunds where outlet_id = v_main;
  if n <> 0 then raise exception 'cashier without refunds.view can read refunds (%)', n; end if;
  select count(*) into n from public.payment_methods where business_id = v_biz;
  if n <> current_setting('p11.exp.methods')::int then raise exception 'main cashier sees % payment methods, expected %', n, current_setting('p11.exp.methods'); end if;
  raise notice 'OK: outlet-granted cashier reads main money rows';
end $$;
reset role;

-- cashier granted branch only: main's money rows are invisible
set role authenticated;
set request.jwt.claims = '{"sub": "f1111111-0000-0000-0000-000000000031", "role": "authenticated"}';
do $$
declare
  v_biz uuid := 'cccccccc-0000-0000-0000-000000000001';
  v_main uuid; n integer;
begin
  select id into v_main from public.outlets where business_id = v_biz and slug = 'main';
  select count(*) into n from public.payments where outlet_id = v_main;
  if n <> 0 then raise exception 'branch cashier can read main payments (%)', n; end if;
  select count(*) into n from public.receipts where outlet_id = v_main;
  if n <> 0 then raise exception 'branch cashier can read main receipts (%)', n; end if;
  select count(*) into n from public.invoices where outlet_id = v_main;
  if n <> 0 then raise exception 'branch cashier can read main invoices (%)', n; end if;
  select count(*) into n from public.refunds where outlet_id = v_main;
  if n <> 0 then raise exception 'branch cashier can read main refunds (%)', n; end if;
  raise notice 'OK: outlet isolation holds for money rows (branch cashier sees no main rows)';
end $$;
reset role;

-- accountant (business-scoped, billing.view + refunds.view): reads across outlets
set role authenticated;
set request.jwt.claims = '{"sub": "f1111111-0000-0000-0000-000000000011", "role": "authenticated"}';
do $$
declare
  v_biz uuid := 'cccccccc-0000-0000-0000-000000000001';
  v_main uuid; n integer;
begin
  select id into v_main from public.outlets where business_id = v_biz and slug = 'main';
  select count(*) into n from public.payments where outlet_id = v_main;
  if n <> current_setting('p11.exp.payments')::int then raise exception 'accountant sees % payments, expected %', n, current_setting('p11.exp.payments'); end if;
  select count(*) into n from public.refunds where outlet_id = v_main;
  if n <> current_setting('p11.exp.refunds')::int then raise exception 'accountant sees % refunds, expected %', n, current_setting('p11.exp.refunds'); end if;
  select count(*) into n from public.payment_methods where business_id = v_biz;
  if n <> current_setting('p11.exp.methods')::int then raise exception 'accountant sees % payment methods, expected %', n, current_setting('p11.exp.methods'); end if;
  raise notice 'OK: business-scoped accountant reads money rows across outlets';
end $$;
reset role;

\echo '── P11 complete'
