-- ─────────────────────────────────────────────────────────────────────────
-- Phase 12 — waiter ordering: Waiter → POS → KDS, end to end, on real RPCs.
-- Runs after Phase 11. Uses its own tables (T-P12A, T-P12B) so earlier
-- fixtures are untouched.
-- ─────────────────────────────────────────────────────────────────────────

-- helpers: run a call and return its error text ('ok' when it succeeds)
create or replace function pg_temp.try_submit(p_actor uuid, p_payload jsonb, p_send boolean)
returns text language plpgsql as $$
begin
  perform public.waiter_submit_order(p_actor, p_payload, p_send);
  return 'ok';
exception when others then
  return sqlerrm;
end $$;

create or replace function pg_temp.try_bill(p_actor uuid, p_order uuid)
returns text language plpgsql as $$
begin
  perform public.waiter_request_bill(p_actor, p_order);
  return 'ok';
exception when others then
  return sqlerrm;
end $$;

create or replace function pg_temp.try_pay(p_actor uuid, p_order uuid, p_key text, p_lines jsonb)
returns text language plpgsql as $$
begin
  perform public.record_payments(p_actor, p_order, p_key, p_lines);
  return 'ok';
exception when others then
  return sqlerrm;
end $$;

\echo '── P12.0: fixtures (waiters, two tables in main)'
do $$
declare
  v_biz uuid := 'cccccccc-0000-0000-0000-000000000001';
  v_main uuid; v_branch uuid; v_section uuid;
begin
  select id into v_main from public.outlets where business_id = v_biz and slug = 'main';
  select id into v_branch from public.outlets where business_id = v_biz and slug = 'branch';

  insert into auth.users (id, email, raw_user_meta_data) values
    ('f1111111-0000-0000-0000-000000000040', 'p12waiter@example.com', '{"full_name": "Wendy Waiter"}'),
    ('f1111111-0000-0000-0000-000000000041', 'p12branchwaiter@example.com', '{"full_name": "Ben Branch"}');
  insert into public.memberships (user_id, business_id, role) values
    ('f1111111-0000-0000-0000-000000000040', v_biz, 'waiter'),
    ('f1111111-0000-0000-0000-000000000041', v_biz, 'waiter');
  insert into public.membership_outlets (membership_id, outlet_id)
  select m.id, v_main from public.memberships m
  where m.business_id = v_biz and m.user_id = 'f1111111-0000-0000-0000-000000000040';
  insert into public.membership_outlets (membership_id, outlet_id)
  select m.id, v_branch from public.memberships m
  where m.business_id = v_biz and m.user_id = 'f1111111-0000-0000-0000-000000000041';

  insert into public.dining_sections (business_id, outlet_id, name) values (v_biz, v_main, 'P12 Patio');
  select id into v_section from public.dining_sections where outlet_id = v_main and name = 'P12 Patio';
  insert into public.dining_tables (business_id, outlet_id, section_id, label, capacity) values
    (v_biz, v_main, v_section, 'T-P12A', 4),
    (v_biz, v_main, v_section, 'T-P12B', 4);

  perform set_config('p12.table_a', (select id::text from public.dining_tables where outlet_id = v_main and label = 'T-P12A'), false);
  perform set_config('p12.table_b', (select id::text from public.dining_tables where outlet_id = v_main and label = 'T-P12B'), false);
  raise notice 'OK: waiters and tables ready';
end $$;

\echo '── P12.1: waiter submissions are validated and outlet-scoped'
do $$
declare
  v_biz uuid := 'cccccccc-0000-0000-0000-000000000001';
  v_waiter uuid := 'f1111111-0000-0000-0000-000000000040';
  v_branch_waiter uuid := 'f1111111-0000-0000-0000-000000000041';
  v_kitchen uuid := 'f1111111-0000-0000-0000-000000000020';
  v_main uuid; v_burger uuid; v_table uuid; v_payload jsonb; v_r text;
begin
  select id into v_main from public.outlets where business_id = v_biz and slug = 'main';
  select id into v_burger from public.menu_items where business_id = v_biz and name = 'P8 Burger';
  v_table := current_setting('p12.table_a')::uuid;
  v_payload := jsonb_build_object('outlet_id', v_main, 'client_ref', 'p12-probe-0001', 'order_type', 'dine_in',
    'table_id', v_table, 'items', jsonb_build_array(jsonb_build_object('item_type','product','product_id', v_burger,'quantity',1)));

  v_r := pg_temp.try_submit(v_waiter, v_payload || '{"discount":{"type":"percent","value":10}}', true);
  if v_r not ilike '%Waiters cannot apply discounts%' then raise exception 'waiter discount not refused: %', v_r; end if;

  v_r := pg_temp.try_submit(v_waiter, v_payload || '{"charges":[{"name":"Service","amount_minor":500}]}', true);
  if v_r not ilike '%Waiters cannot add charges%' then raise exception 'waiter charge not refused: %', v_r; end if;

  v_r := pg_temp.try_submit(v_waiter, v_payload || '{"order_type":"takeaway"}', true);
  if v_r not ilike '%dine-in only%' then raise exception 'takeaway not refused: %', v_r; end if;

  v_r := pg_temp.try_submit(v_waiter, v_payload || '{"items":[]}', true);
  if v_r not ilike '%Add at least one item%' then raise exception 'empty order not refused: %', v_r; end if;

  v_r := pg_temp.try_submit(v_branch_waiter, v_payload, true);
  if v_r not ilike '%not assigned to this outlet%' then raise exception 'branch waiter reached main: %', v_r; end if;

  v_r := pg_temp.try_submit(v_kitchen, v_payload, true);
  if v_r not ilike '%does not allow%' then raise exception 'kitchen staff could submit orders: %', v_r; end if;

  if exists (select 1 from public.orders where client_ref = 'p12-probe-0001') then
    raise exception 'a refused submission left an order behind';
  end if;
  raise notice 'OK: discounts, charges, takeaway and foreign outlets refused; kitchen cannot submit';
end $$;

\echo '── P12.1b: modifier group rules are enforced on every order (min and max options)'
do $$
declare
  v_biz uuid := 'cccccccc-0000-0000-0000-000000000001';
  v_main uuid; v_juice uuid; v_group uuid; v_opt_a uuid; v_opt_b uuid; v_r text;
  v_payload jsonb;
begin
  select id into v_main from public.outlets where business_id = v_biz and slug = 'main';
  select id into v_juice from public.menu_items where business_id = v_biz and name = 'P11 Juice';

  -- a required, single-choice group on the juice: 1 to 1 options
  insert into public.modifier_groups (business_id, name, min_selected, max_selected)
  values (v_biz, 'P12 Size', 1, 1) returning id into v_group;
  insert into public.modifiers (business_id, modifier_group_id, name, price_minor)
  values (v_biz, v_group, 'P12 Small', 0);
  insert into public.modifiers (business_id, modifier_group_id, name, price_minor)
  values (v_biz, v_group, 'P12 Large', 500);
  select id into v_opt_a from public.modifiers where modifier_group_id = v_group and name = 'P12 Small';
  select id into v_opt_b from public.modifiers where modifier_group_id = v_group and name = 'P12 Large';
  insert into public.product_modifier_groups (product_id, modifier_group_id) values (v_juice, v_group);

  v_payload := jsonb_build_object('outlet_id', v_main, 'order_type', 'dine_in', 'table_id', current_setting('p12.table_b'),
    'client_ref', 'p12-group-0001', 'items', jsonb_build_array(jsonb_build_object('item_type','product','product_id', v_juice,'quantity',1)));

  v_r := pg_temp.try_submit('f1111111-0000-0000-0000-000000000040', v_payload, false);
  if v_r not ilike '%needs at least 1 option%' then raise exception 'required group not enforced: %', v_r; end if;

  v_payload := jsonb_set(v_payload, '{items,0,modifiers}', jsonb_build_array(
    jsonb_build_object('modifier_id', v_opt_a, 'quantity', 1), jsonb_build_object('modifier_id', v_opt_b, 'quantity', 1)));
  v_r := pg_temp.try_submit('f1111111-0000-0000-0000-000000000040', v_payload, false);
  if v_r not ilike '%allows at most 1 option%' then raise exception 'max group not enforced: %', v_r; end if;

  if exists (select 1 from public.orders where client_ref = 'p12-group-0001') then
    raise exception 'a rule-breaking order was saved';
  end if;
  -- detach the test group so later juice orders are unaffected
  delete from public.product_modifier_groups where product_id = v_juice and modifier_group_id = v_group;
  raise notice 'OK: required and maximum modifier groups are enforced server-side';
end $$;

\echo '── P12.2: waiter sends a new order (Waiter → POS → KDS)'
do $$
declare
  v_biz uuid := 'cccccccc-0000-0000-0000-000000000001';
  v_waiter uuid := 'f1111111-0000-0000-0000-000000000040';
  v_main uuid; v_burger uuid; v_juice uuid; v_cheese uuid; v_order uuid; v_status text;
  v_payload jsonb;
begin
  select id into v_main from public.outlets where business_id = v_biz and slug = 'main';
  select id into v_burger from public.menu_items where business_id = v_biz and name = 'P8 Burger';
  select id into v_juice from public.menu_items where business_id = v_biz and name = 'P11 Juice';
  select m.id into v_cheese from public.modifiers m where m.business_id = v_biz and m.name = 'P8 Cheese';

  v_payload := jsonb_build_object(
    'outlet_id', v_main, 'client_ref', 'p12-order-0001', 'order_type', 'dine_in',
    'table_id', current_setting('p12.table_a'), 'notes', 'Window seat',
    'items', jsonb_build_array(
      jsonb_build_object('item_type','product','product_id', v_burger, 'quantity', 2,
        'item_notes', 'no onion', 'modifiers', jsonb_build_array(jsonb_build_object('modifier_id', v_cheese, 'quantity', 1))),
      jsonb_build_object('item_type','product','product_id', v_juice, 'quantity', 1)));

  v_order := public.waiter_submit_order(v_waiter, v_payload, true);
  perform set_config('p12.order', v_order::text, false);

  select status into v_status from public.orders where id = v_order;
  if v_status <> 'placed' then raise exception 'sent order should be placed, is %', v_status; end if;
  if (select current_order_id from public.dining_tables where id = current_setting('p12.table_a')::uuid) <> v_order then
    raise exception 'table not occupied by the new order';
  end if;
  if (select count(*) from public.order_items where order_id = v_order) <> 2 then raise exception 'expected 2 lines'; end if;
  if (select count(*) from public.order_items where order_id = v_order and kitchen_status = 'new') <> 2 then
    raise exception 'sent lines not projected as new';
  end if;
  if (select count(*) from public.kitchen_items where order_id = v_order and kitchen_status = 'new') <> 2 then
    raise exception 'KDS did not receive the order';
  end if;
  if (select count(*) from public.kitchen_items where order_id = v_order and station_id is not null) <> 2 then
    raise exception 'KDS items not routed to a station';
  end if;
  if (select count(*) from public.order_item_modifiers om
      join public.order_items oi on oi.id = om.order_item_id
      where oi.order_id = v_order and om.name = 'P8 Cheese') <> 1 then
    raise exception 'modifier not stored on the sent line';
  end if;
  if (select item_notes from public.order_items where order_id = v_order and product_id = v_burger) <> 'no onion' then
    raise exception 'line note lost';
  end if;
  if (select total_minor from public.orders where id = v_order) <= 0 then raise exception 'total not computed'; end if;
  if (select discount_type from public.orders where id = v_order) <> 'none' then raise exception 'waiter order gained a discount'; end if;
  if not exists (select 1 from public.audit_logs where target_id = v_order::text and action = 'order.submitted') then
    raise exception 'submission not audited';
  end if;
  raise notice 'OK: waiter-sent order is placed, on the table, projected to the KDS, routed and audited';
end $$;

\echo '── P12.3: retries are idempotent'
do $$
declare
  v_biz uuid := 'cccccccc-0000-0000-0000-000000000001';
  v_order uuid := current_setting('p12.order')::uuid;
  v_again uuid; v_n integer;
begin
  v_again := public.waiter_submit_order('f1111111-0000-0000-0000-000000000040', jsonb_build_object(
    'outlet_id', (select outlet_id from public.orders where id = v_order), 'client_ref', 'p12-order-0001',
    'order_type', 'dine_in', 'table_id', current_setting('p12.table_a'), 'notes', 'Window seat',
    'items', jsonb_build_array(jsonb_build_object('item_type','product','product_id',
      (select id from public.menu_items where business_id = v_biz and name = 'P11 Juice'),'quantity',1))), true);
  if v_again <> v_order then raise exception 'retry created a different order'; end if;
  select count(*) into v_n from public.order_items where order_id = v_order;
  if v_n <> 2 then raise exception 'retry changed the lines (%)', v_n; end if;
  select count(*) into v_n from public.kitchen_items where order_id = v_order;
  if v_n <> 2 then raise exception 'retry duplicated KDS items (%)', v_n; end if;
  if (select count(*) from public.orders where client_ref = 'p12-order-0001') <> 1 then
    raise exception 'retry duplicated the order';
  end if;
  raise notice 'OK: a retried submission returns the original order and changes nothing';
end $$;

\echo '── P12.4: a second round appends; sent lines are never rewritten'
do $$
declare
  v_biz uuid := 'cccccccc-0000-0000-0000-000000000001';
  v_order uuid := current_setting('p12.order')::uuid;
  v_fries uuid; v_before text; v_after text; v_pos integer; v_subtotal bigint; v_n integer;
begin
  select id into v_fries from public.menu_items where business_id = v_biz and name = 'P8 Fries';
  v_before := (select string_agg(id::text || ':' || kitchen_status, ',' order by position) from public.order_items where order_id = v_order);

  perform public.waiter_submit_order('f1111111-0000-0000-0000-000000000040', jsonb_build_object(
    'outlet_id', (select outlet_id from public.orders where id = v_order), 'client_ref', 'p12-round-0002',
    'order_type', 'dine_in', 'order_id', v_order,
    'items', jsonb_build_array(jsonb_build_object('item_type','product','product_id', v_fries,'quantity',2))), true);

  if (select status from public.orders where id = v_order) <> 'placed' then
    raise exception 'appending must not change the order status';
  end if;
  select count(*) into v_n from public.order_items where order_id = v_order;
  if v_n <> 3 then raise exception 'expected 3 lines after the round, got %', v_n; end if;

  v_after := (select string_agg(id::text || ':' || kitchen_status, ',' order by position) from public.order_items
              where order_id = v_order and position <= 2);
  if v_after <> v_before then raise exception 'sent lines were rewritten: % → %', v_before, v_after; end if;

  select position into v_pos from public.order_items where order_id = v_order and product_id = v_fries;
  if v_pos <> 3 then raise exception 'appended line should be position 3, is %', v_pos; end if;
  if (select kitchen_status from public.order_items where order_id = v_order and product_id = v_fries) <> 'new' then
    raise exception 'appended line not sent to the kitchen';
  end if;
  if (select count(*) from public.kitchen_items where order_id = v_order and kitchen_status = 'new') <> 3 then
    raise exception 'KDS did not receive the appended round';
  end if;

  select coalesce(sum(line_total_minor), 0) into v_subtotal from public.order_items where order_id = v_order;
  if (select subtotal_minor from public.orders where id = v_order) <> v_subtotal then
    raise exception 'subtotal not recomputed after the round';
  end if;
  raise notice 'OK: appended round reaches the KDS; earlier lines untouched; totals recomputed';
end $$;

\echo '── P12.5: a cashier discount survives waiter edits'
do $$
declare
  v_biz uuid := 'cccccccc-0000-0000-0000-000000000001';
  v_waiter uuid := 'f1111111-0000-0000-0000-000000000040';
  v_owner uuid := 'aaaaaaaa-0000-0000-0000-000000000001';
  v_main uuid; v_juice uuid; v_burger uuid; v_draft uuid; v_table uuid; v_r text;
begin
  select id into v_main from public.outlets where business_id = v_biz and slug = 'main';
  select id into v_juice from public.menu_items where business_id = v_biz and name = 'P11 Juice';
  select id into v_burger from public.menu_items where business_id = v_biz and name = 'P8 Burger';
  v_table := current_setting('p12.table_b')::uuid;

  -- waiter starts a draft on table B (not yet sent)
  v_draft := public.waiter_submit_order(v_waiter, jsonb_build_object(
    'outlet_id', v_main, 'client_ref', 'p12-draft-0001', 'order_type', 'dine_in', 'table_id', v_table,
    'items', jsonb_build_array(jsonb_build_object('item_type','product','product_id', v_juice,'quantity',1))), false);
  perform set_config('p12.draft', v_draft::text, false);

  if (select status from public.orders where id = v_draft) <> 'open' then raise exception 'unsent draft should be open'; end if;
  if (select status from public.dining_tables where id = v_table) <> 'occupied' then raise exception 'draft did not hold the table'; end if;
  if (select count(*) from public.kitchen_items where order_id = v_draft) <> 0 then raise exception 'draft reached the KDS'; end if;

  v_r := pg_temp.try_bill(v_waiter, v_draft);
  if v_r not ilike '%Send the order to the kitchen%' then raise exception 'bill allowed on an unsent draft: %', v_r; end if;

  -- cashier applies a discount in the POS (owner stands in for the cashier here)
  perform public.amend_pos_order(v_owner, v_draft, jsonb_build_object(
    'status', 'open', 'table_id', v_table,
    'items', jsonb_build_array(jsonb_build_object('item_type','product','product_id', v_juice,'quantity',1)),
    'discount', jsonb_build_object('type','percent','value',10), 'charges', '[]'::jsonb));

  -- waiter adds a line to the same draft
  perform public.waiter_submit_order(v_waiter, jsonb_build_object(
    'outlet_id', v_main, 'client_ref', 'p12-draft-0002', 'order_type', 'dine_in', 'order_id', v_draft,
    'items', jsonb_build_array(
      jsonb_build_object('item_type','product','product_id', v_juice,'quantity',1),
      jsonb_build_object('item_type','product','product_id', v_burger,'quantity',1))), false);

  if (select discount_type from public.orders where id = v_draft) <> 'percent'
     or (select discount_value from public.orders where id = v_draft) <> 10 then
    raise exception 'waiter edit removed the cashier discount';
  end if;
  if (select discount_minor from public.orders where id = v_draft) <= 0 then
    raise exception 'discount not applied to the waiter-edited draft';
  end if;
  if (select count(*) from public.order_items where order_id = v_draft) <> 2 then raise exception 'draft lines not replaced'; end if;

  -- waiter sends the draft: it is placed, occupies the table, and reaches the KDS
  perform public.waiter_submit_order(v_waiter, jsonb_build_object(
    'outlet_id', v_main, 'client_ref', 'p12-draft-0003', 'order_type', 'dine_in', 'order_id', v_draft,
    'items', jsonb_build_array(
      jsonb_build_object('item_type','product','product_id', v_juice,'quantity',1),
      jsonb_build_object('item_type','product','product_id', v_burger,'quantity',1))), true);

  if (select status from public.orders where id = v_draft) <> 'placed' then raise exception 'draft not sent'; end if;
  if (select discount_value from public.orders where id = v_draft) <> 10 then raise exception 'send removed the discount'; end if;
  if (select count(*) from public.kitchen_items where order_id = v_draft and kitchen_status = 'new') <> 2 then
    raise exception 'sent draft did not reach the KDS';
  end if;
  raise notice 'OK: waiter edits keep the cashier discount; sent drafts reach the KDS';
end $$;

\echo '── P12.6: request bill (idempotent, sent orders only, audited)'
do $$
declare
  v_order uuid := current_setting('p12.order')::uuid;
  v_first timestamptz; v_second timestamptz; v_r text;
begin
  v_first := public.waiter_request_bill('f1111111-0000-0000-0000-000000000040', v_order);
  v_second := public.waiter_request_bill('f1111111-0000-0000-0000-000000000040', v_order);
  if v_first is null or v_first <> v_second then raise exception 'repeat bill request changed the time'; end if;
  if (select bill_requested_at from public.orders where id = v_order) is null then raise exception 'bill request not stored'; end if;
  if not exists (select 1 from public.audit_logs where target_id = v_order::text and action = 'order.bill_requested') then
    raise exception 'bill request not audited';
  end if;

  v_r := pg_temp.try_bill('f1111111-0000-0000-0000-000000000041', v_order);
  if v_r not ilike '%not assigned to this outlet%' then raise exception 'branch waiter requested a main bill: %', v_r; end if;
  raise notice 'OK: bill request is idempotent, audited, and outlet-scoped';
end $$;

\echo '── P12.7: kitchen progress drives the order status (KDS → POS)'
do $$
declare
  v_order uuid := current_setting('p12.order')::uuid;
  v_kit uuid := 'f1111111-0000-0000-0000-000000000020';
  v_burger uuid; v_juice uuid; v_fries uuid; v_n integer; v_seen integer; v_status text;
begin
  select oi.id into v_burger from public.order_items oi where oi.order_id = v_order and oi.name = 'P8 Burger';
  select oi.id into v_juice from public.order_items oi where oi.order_id = v_order and oi.name = 'P11 Juice';
  select oi.id into v_fries from public.order_items oi where oi.order_id = v_order and oi.name = 'P8 Fries';

  perform public.kds_advance_item(v_kit, v_burger, 'new', 'accepted');
  if (select status from public.orders where id = v_order) <> 'preparing' then
    raise exception 'accepted item should move the order to preparing';
  end if;
  if not exists (select 1 from public.order_status_history where order_id = v_order and to_status = 'preparing' and note = 'Kitchen progress') then
    raise exception 'kitchen progress not recorded in history';
  end if;

  -- the waiter reads item progress with its own session
  set role authenticated;
  set request.jwt.claims = '{"sub": "f1111111-0000-0000-0000-000000000040", "role": "authenticated"}';
  select count(*) into v_seen from public.order_items where order_id = v_order and kitchen_status = 'accepted';
  reset role;
  if v_seen <> 1 then raise exception 'waiter cannot see the kitchen progress (%)', v_seen; end if;

  -- finish burger and juice; fries still waiting → order stays preparing
  perform public.kds_advance_item(v_kit, v_burger, 'accepted', 'preparing');
  perform public.kds_advance_item(v_kit, v_burger, 'preparing', 'ready');
  perform public.kds_advance_item(v_kit, v_juice, 'new', 'accepted');
  perform public.kds_advance_item(v_kit, v_juice, 'accepted', 'preparing');
  perform public.kds_advance_item(v_kit, v_juice, 'preparing', 'ready');
  if (select status from public.orders where id = v_order) <> 'preparing' then
    raise exception 'order became ready while fries were still cooking';
  end if;

  -- only the fries line is still waiting
  select count(*) into v_n from public.order_items where order_id = v_order and kitchen_status = 'new';
  if v_n <> 1 then raise exception 'expected only the fries line still new, got %', v_n; end if;
  perform public.kds_advance_item(v_kit, v_fries, 'new', 'accepted');
  perform public.kds_advance_item(v_kit, v_fries, 'accepted', 'preparing');
  perform public.kds_advance_item(v_kit, v_fries, 'preparing', 'ready');

  select status into v_status from public.orders where id = v_order;
  if v_status <> 'ready' then raise exception 'all items ready should make the order ready, is %', v_status; end if;
  raise notice 'OK: accepted → preparing → ready follows the kitchen; the waiter sees item progress';
end $$;

\echo '── P12.8: a late round cannot be completed away from the kitchen'
do $$
declare
  v_biz uuid := 'cccccccc-0000-0000-0000-000000000001';
  v_order uuid := current_setting('p12.order')::uuid;
  v_kit uuid := 'f1111111-0000-0000-0000-000000000020';
  v_cashier uuid := 'f1111111-0000-0000-0000-000000000030';
  v_juice uuid; v_item uuid;
begin
  select id into v_juice from public.menu_items where business_id = v_biz and name = 'P11 Juice';
  perform public.waiter_submit_order('f1111111-0000-0000-0000-000000000040', jsonb_build_object(
    'outlet_id', (select outlet_id from public.orders where id = v_order), 'client_ref', 'p12-round-0003',
    'order_type', 'dine_in', 'order_id', v_order,
    'items', jsonb_build_array(jsonb_build_object('item_type','product','product_id', v_juice,'quantity',1))), true);

  if (select status from public.orders where id = v_order) <> 'ready' then
    raise exception 'a late round must not move a ready order backwards';
  end if;

  begin
    perform public.transition_order_status(v_cashier, v_order, 'completed', null);
    raise exception 'completion allowed while the late round is still cooking';
  exception when others then
    if sqlerrm not ilike '%Kitchen items are still in progress%' then raise; end if;
  end;

  select oi.id into v_item from public.order_items oi where oi.order_id = v_order and oi.kitchen_status = 'new';
  perform public.kds_advance_item(v_kit, v_item, 'new', 'accepted');
  perform public.kds_advance_item(v_kit, v_item, 'accepted', 'preparing');
  perform public.kds_advance_item(v_kit, v_item, 'preparing', 'ready');
  raise notice 'OK: completion waits for every kitchen item to finish';
end $$;

\echo '── P12.9: the waiter cannot take money, edit money, or read the kitchen board'
do $$
declare
  v_order uuid := current_setting('p12.order')::uuid;
  v_waiter uuid := 'f1111111-0000-0000-0000-000000000040';
  v_r text; v_n integer;
begin
  v_r := pg_temp.try_pay(v_waiter, v_order, 'p12-waiter-pay', jsonb_build_array(
    jsonb_build_object('method_key', 'cash', 'amount_minor', 1, 'tendered_minor', 1)));
  if v_r not ilike '%does not allow%' then raise exception 'waiter could record a payment: %', v_r; end if;
  if (select paid_minor from public.orders where id = v_order) <> 0 then raise exception 'waiter payment changed the ledger'; end if;

  set role authenticated;
  set request.jwt.claims = '{"sub": "f1111111-0000-0000-0000-000000000040", "role": "authenticated"}';
  begin
    update public.orders set discount_type = 'flat', discount_value = 500 where id = v_order;
  exception when insufficient_privilege then
    null;
  end;
  select count(*) into v_n from public.kitchen_items;
  reset role;
  if v_n <> 0 then raise exception 'waiter can read the kitchen board (%)', v_n; end if;

  if (select discount_type from public.orders where id = v_order) <> 'none' then
    raise exception 'waiter direct update changed the discount';
  end if;
  raise notice 'OK: waiter cannot pay, cannot edit money directly, and cannot read the KDS board';
end $$;

\echo '── P12.10: the cashier sees the bill request, takes payment and completes'
do $$
declare
  v_order uuid := current_setting('p12.order')::uuid;
  v_cashier uuid := 'f1111111-0000-0000-0000-000000000030';
  v_total bigint; v_requested timestamptz; v_r text;
begin
  set role authenticated;
  set request.jwt.claims = '{"sub": "f1111111-0000-0000-0000-000000000030", "role": "authenticated"}';
  select bill_requested_at into v_requested from public.orders where id = v_order;
  reset role;
  if v_requested is null then raise exception 'cashier cannot see the bill request'; end if;

  select total_minor into v_total from public.orders where id = v_order;
  perform public.record_payments(v_cashier, v_order, 'p12-pay-0001', jsonb_build_array(
    jsonb_build_object('method_key', 'cash', 'amount_minor', v_total, 'tendered_minor', v_total)));
  perform public.transition_order_status(v_cashier, v_order, 'completed', null);

  if (select status from public.orders where id = v_order) <> 'completed' then raise exception 'order not completed'; end if;
  if (select status from public.dining_tables where id = current_setting('p12.table_a')::uuid) <> 'available' then
    raise exception 'completing the order did not free the table';
  end if;
  if (select payment_status from public.orders where id = v_order) <> 'paid' then raise exception 'order not marked paid'; end if;

  -- a closed order takes no more waiter items
  v_r := pg_temp.try_submit('f1111111-0000-0000-0000-000000000040', jsonb_build_object(
    'outlet_id', (select outlet_id from public.orders where id = v_order), 'client_ref', 'p12-late-0001',
    'order_type', 'dine_in', 'order_id', v_order,
    'items', jsonb_build_array(jsonb_build_object('item_type','product','product_id',
      (select id from public.menu_items where name = 'P11 Juice' and business_id = 'cccccccc-0000-0000-0000-000000000001'),'quantity',1))), true);
  if v_r not ilike '%closed and cannot take new items%' then raise exception 'closed order accepted items: %', v_r; end if;
  raise notice 'OK: cashier sees the request, takes payment, completes; table freed; closed orders refuse items';
end $$;

\echo '── P12.11: outlet isolation for waiters'
do $$
declare
  v_biz uuid := 'cccccccc-0000-0000-0000-000000000001';
  v_main uuid; v_n integer;
begin
  select id into v_main from public.outlets where business_id = v_biz and slug = 'main';
  set role authenticated;
  set request.jwt.claims = '{"sub": "f1111111-0000-0000-0000-000000000041", "role": "authenticated"}';
  select count(*) into v_n from public.orders where outlet_id = v_main;
  reset role;
  if v_n <> 0 then raise exception 'branch waiter can read main orders (%)', v_n; end if;
  raise notice 'OK: a branch waiter sees no main orders';
end $$;

\echo '── P12 complete'
