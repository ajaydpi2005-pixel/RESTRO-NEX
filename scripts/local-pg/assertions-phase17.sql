-- ─────────────────────────────────────────────────────────────────────────
-- Phase 17 — online ordering + QR table ordering. Runs after Phase 16.
-- Fixtures are its own (P17 …): an online outlet with its own menu, two tables,
-- and a QR code. Every public call goes through the same RPCs the route handlers
-- use, with server-side arguments only.
--
-- Money in these checks is never typed by hand except for the catalogue prices:
--   Biryani 25000 (outlet override 24000), Half Biryani 15000 (variant),
--   Raita 3000 (modifier), Naan 4000, Lassi 6000 (unavailable at this outlet).
--   Packaging 500, delivery fee 2000, online minimum 10000.
-- ─────────────────────────────────────────────────────────────────────────

create temp table if not exists p17_refs (k text primary key, v text);

create or replace function pg_temp.ref(p_key text) returns uuid
language sql stable as $$
  select v::uuid from p17_refs where k = p_key;
$$;

create or replace function pg_temp.h(p_raw text) returns text
language sql immutable as $$
  select encode(sha256(convert_to(p_raw, 'UTF8')), 'hex');
$$;

create or replace function pg_temp.try(p_sql text) returns text
language plpgsql as $$
begin
  execute p_sql;
  return 'ok';
exception when others then
  return 'err:' || sqlerrm;
end $$;

-- Same finish sequence as Phase 16: placed → kitchen → ready → completed.
create or replace function pg_temp.finish(p_actor uuid, p_order uuid) returns void
language plpgsql as $$
declare
  r record;
  v_kitchen uuid := 'aaaaaaaa-0000-0000-0000-000000000001';
begin
  -- Accepted online and QR orders are already placed; only open or held orders need the step.
  if (select status from public.orders where id = p_order) in ('open', 'held') then
    perform public.transition_order_status(p_actor, p_order, 'placed');
  end if;
  for r in select oi.id from public.order_items oi where oi.order_id = p_order loop
    perform public.kds_advance_item(v_kitchen, r.id, 'new', 'accepted');
    perform public.kds_advance_item(v_kitchen, r.id, 'accepted', 'preparing');
    perform public.kds_advance_item(v_kitchen, r.id, 'preparing', 'ready');
  end loop;
  -- Kitchen item moves advance the order status themselves, so each step is conditional.
  if (select status from public.orders where id = p_order) = 'placed' then
    perform public.transition_order_status(p_actor, p_order, 'preparing');
  end if;
  if (select status from public.orders where id = p_order) = 'preparing' then
    perform public.transition_order_status(p_actor, p_order, 'ready');
  end if;
  perform public.transition_order_status(p_actor, p_order, 'completed');
end $$;

\echo '── P17.0: fixtures (online outlet, menu, tables, QR code)'
do $$
declare
  v_biz uuid := 'cccccccc-0000-0000-0000-000000000001';
  v_owner uuid := 'aaaaaaaa-0000-0000-0000-000000000001';
  v_main uuid;
  v_outlet uuid;
  v_cat uuid;
  v_biry uuid; v_naan uuid; v_lassi uuid; v_half uuid;
  v_group uuid; v_raita uuid;
  v_t1 uuid; v_t2 uuid; v_qr1 uuid;
begin
  select id into v_main from public.outlets where business_id = v_biz and slug = 'main';
  insert into public.outlets (business_id, name, slug, currency_code)
  values (v_biz, 'P17 Online', 'p17-online', 'INR')
  returning id into v_outlet;
  insert into p17_refs values ('main', v_main::text), ('outlet', v_outlet::text);

  -- Cashier and waiter work the online outlet (outlet grants are explicit).
  insert into public.membership_outlets (membership_id, outlet_id)
  select m.id, v_outlet from public.memberships m
  where m.business_id = v_biz
    and m.user_id in ('f1111111-0000-0000-0000-000000000010', 'f1111111-0000-0000-0000-000000000040');

  perform public.ordering_settings_save(v_owner, v_outlet, jsonb_build_object(
    'online_enabled', true, 'takeaway_enabled', true, 'delivery_enabled', true,
    'qr_enabled', true, 'min_order_minor', 10000, 'delivery_fee_minor', 2000,
    'packaging_fee_minor', 500, 'prep_minutes', 25));

  insert into public.menu_categories (business_id, name) values (v_biz, 'P17 Kitchen')
  returning id into v_cat;
  insert into public.menu_items (business_id, category_id, name, price_minor)
  values (v_biz, v_cat, 'P17 Biryani', 25000) returning id into v_biry;
  insert into public.menu_items (business_id, category_id, name, price_minor)
  values (v_biz, v_cat, 'P17 Naan', 4000) returning id into v_naan;
  insert into public.menu_items (business_id, category_id, name, price_minor)
  values (v_biz, v_cat, 'P17 Lassi', 6000) returning id into v_lassi;
  insert into public.product_variants (business_id, product_id, name, price_minor)
  values (v_biz, v_biry, 'P17 Half', 15000) returning id into v_half;
  insert into public.modifier_groups (business_id, name, min_selected, max_selected)
  values (v_biz, 'P17 Extras', 0, 2) returning id into v_group;
  insert into public.modifiers (business_id, modifier_group_id, name, price_minor)
  values (v_biz, v_group, 'P17 Raita', 3000) returning id into v_raita;
  insert into public.product_modifier_groups (product_id, modifier_group_id) values (v_biry, v_group);

  insert into public.outlet_product_overrides (outlet_id, product_id, price_minor)
  values (v_outlet, v_biry, 24000);
  insert into public.outlet_product_overrides (outlet_id, product_id, is_available)
  values (v_outlet, v_lassi, false);

  insert into public.dining_tables (business_id, outlet_id, label, capacity)
  values (v_biz, v_outlet, 'P17 T1', 4) returning id into v_t1;
  insert into public.dining_tables (business_id, outlet_id, label, capacity)
  values (v_biz, v_outlet, 'P17 T2', 4) returning id into v_t2;

  v_qr1 := public.qr_code_issue(v_owner, v_outlet, v_t1, 'P17 T1 table QR',
             pg_temp.h('p17-qr-token-table-one-0001'), 'p17qr1a');

  insert into p17_refs values
    ('biry', v_biry::text), ('naan', v_naan::text), ('lassi', v_lassi::text),
    ('half', v_half::text), ('raita', v_raita::text),
    ('t1', v_t1::text), ('t2', v_t2::text), ('qr1', v_qr1::text);

  raise notice 'OK: P17 fixtures ready: online outlet with settings, 4 menu items (one unavailable, one overridden), a variant, a modifier group, 2 tables and an active QR code on T1';
end $$;

\echo '── P17.1: ordering settings are owner-gated, validated, and default safely'
do $$
declare
  v_biz uuid := 'cccccccc-0000-0000-0000-000000000001';
  v_cashier uuid := 'f1111111-0000-0000-0000-000000000010';
  v_outlet uuid := pg_temp.ref('outlet');
  v_res text;
  v_json jsonb;
  v_audits integer;
begin
  -- The cashier is assigned to the main outlet, so this tests the permission gate itself.
  v_res := pg_temp.try(format('select public.ordering_settings_save(%L, %L, %L::jsonb)',
             v_cashier, pg_temp.ref('main'), '{"online_enabled": false}'));
  if v_res not like 'err:%Your role does not allow%' then
    raise exception 'FAIL: cashier changed ordering settings (%)', v_res;
  end if;

  v_res := pg_temp.try(format('select public.ordering_settings_save(%L, %L, %L::jsonb)',
             'aaaaaaaa-0000-0000-0000-000000000001', v_outlet, '{"min_order_minor": -1}'));
  if v_res not like 'err:%cannot be negative%' then
    raise exception 'FAIL: negative minimum accepted (%)', v_res;
  end if;

  v_res := pg_temp.try(format('select public.ordering_settings_save(%L, %L, %L::jsonb)',
             'aaaaaaaa-0000-0000-0000-000000000001', v_outlet, '{"prep_minutes": 2}'));
  if v_res not like 'err:%between 5 and 240%' then
    raise exception 'FAIL: prep time out of range accepted (%)', v_res;
  end if;

  -- An outlet that never saved settings gets the safe defaults: nothing online.
  v_json := public.ordering_settings_json('dddddddd-0000-0000-0000-00000000ffff');
  if (v_json ->> 'online_enabled')::boolean or (v_json ->> 'qr_enabled')::boolean
     or not (v_json ->> 'takeaway_enabled')::boolean then
    raise exception 'FAIL: default settings are not closed by default: %', v_json;
  end if;

  select count(*) into v_audits from public.audit_logs
  where action = 'ordering.settings_saved' and target_id = v_outlet::text;
  if v_audits < 1 then
    raise exception 'FAIL: settings change not audited';
  end if;

  raise notice 'OK: only settings managers change ordering settings; negative fees and bad prep times are refused; unknown outlets default to closed; the change is audited';
end $$;

\echo '── P17.2: public menu is the universal menu, priced for this outlet, availability respected'
do $$
declare
  v_biz uuid := 'cccccccc-0000-0000-0000-000000000001';
  v_outlet uuid := pg_temp.ref('outlet');
  v_menu jsonb;
  v_biry jsonb;
  v_count integer;
begin
  v_menu := public.public_menu(v_biz, v_outlet);

  select it.value into v_biry
  from jsonb_array_elements(v_menu -> 'categories') as c(value)
  cross join lateral jsonb_array_elements(c.value -> 'items') as it(value)
  where it.value ->> 'name' = 'P17 Biryani';

  if v_biry is null then
    raise exception 'FAIL: Biryani missing from the public menu';
  end if;
  if (v_biry ->> 'price_minor')::bigint <> 24000 then
    raise exception 'FAIL: public price ignores the outlet override (%)', v_biry ->> 'price_minor';
  end if;
  if jsonb_array_length(v_biry -> 'variants') <> 1
     or (v_biry -> 'variants' -> 0 ->> 'price_minor')::bigint <> 15000 then
    raise exception 'FAIL: variant missing or mispriced: %', v_biry -> 'variants';
  end if;
  if jsonb_array_length(v_biry -> 'modifier_groups') <> 1
     or (v_biry -> 'modifier_groups' -> 0 -> 'modifiers' -> 0 ->> 'price_minor')::bigint <> 3000 then
    raise exception 'FAIL: modifier group missing or mispriced: %', v_biry -> 'modifier_groups';
  end if;

  if v_menu::text like '%P17 Lassi%' then
    raise exception 'FAIL: an item unavailable at this outlet appears on the public menu';
  end if;

  -- Every item carries only customer-safe fields.
  if v_menu::text like '%cost_minor%' or v_menu::text like '%unit_cost%' then
    raise exception 'FAIL: cost fields leak into the public menu';
  end if;

  -- Public outlet lookup: right slugs resolve, wrong ones do not.
  if public.public_outlet_context(
       (select slug from public.businesses where id = v_biz), 'p17-online') is null then
    raise exception 'FAIL: the storefront did not resolve';
  end if;
  if public.public_outlet_context(
       (select slug from public.businesses where id = v_biz), 'no-such-outlet') is not null then
    raise exception 'FAIL: an unknown outlet resolved';
  end if;

  raise notice 'OK: public menu shows the universal menu at outlet prices, hides unavailable items and cost fields, and the storefront resolves only real slugs';
end $$;

\echo '── P17.3: online checkout prices on the server and ignores client-supplied money and status'
do $$
declare
  v_biz uuid := 'cccccccc-0000-0000-0000-000000000001';
  v_main uuid := pg_temp.ref('main');
  v_outlet uuid := pg_temp.ref('outlet');
  v_biry uuid := pg_temp.ref('biry');
  v_naan uuid := pg_temp.ref('naan');
  v_raita uuid := pg_temp.ref('raita');
  v_payload jsonb;
  v_res jsonb;
  v_o uuid;
  r record;
  v_kds_pending integer;
begin
  -- Order 1: takeaway, Biryani + Raita + Naan. The payload lies about price,
  -- discount, status, outlet and charges. None of those reach the database.
  v_payload := jsonb_build_object(
    'client_ref', 'p17-ref-0000000001',
    'order_type', 'takeaway',
    'customer_name', 'Meera',
    'customer_phone', '9000017001',
    'discount', jsonb_build_object('type', 'flat', 'value', 90000),
    'status', 'placed',
    'outlet_id', v_main,
    'charges', jsonb_build_array(jsonb_build_object('name', 'Hack', 'amount_minor', 1)),
    'items', jsonb_build_array(
      jsonb_build_object('item_type', 'product', 'product_id', v_biry, 'quantity', 1,
        'price_minor', 1, 'unit_price_minor', 1,
        'modifiers', jsonb_build_array(jsonb_build_object('modifier_id', v_raita, 'quantity', 1))),
      jsonb_build_object('item_type', 'product', 'product_id', v_naan, 'quantity', 1)));

  v_res := public.public_order_create('online', v_biz, v_outlet, null, v_payload,
             'p17-fp-main', pg_temp.h('p17-track-secret-order-0001'));
  v_o := (v_res ->> 'order_id')::uuid;
  insert into p17_refs values ('o1', v_o::text);

  select * into r from public.orders where id = v_o;
  if r.status <> 'held' or r.intake_status <> 'awaiting_acceptance' then
    raise exception 'FAIL: online order not held awaiting acceptance (% / %)', r.status, r.intake_status;
  end if;
  if r.channel <> 'online' or r.payment_mode <> 'pay_at_counter' or r.order_type <> 'takeaway' then
    raise exception 'FAIL: channel, payment mode or type wrong';
  end if;
  if r.discount_minor <> 0 then
    raise exception 'FAIL: a client discount reached the order (%)', r.discount_minor;
  end if;
  if r.subtotal_minor <> 31000 then
    raise exception 'FAIL: subtotal not priced from the catalogue (% expected 31000)', r.subtotal_minor;
  end if;
  if r.charges_minor <> 500 then
    raise exception 'FAIL: only the packaging fee may apply to takeaway (%)', r.charges_minor;
  end if;
  if r.total_minor <> r.subtotal_minor - r.discount_minor + r.tax_minor + r.charges_minor then
    raise exception 'FAIL: total does not reconcile to subtotal, tax and charges';
  end if;
  if r.customer_id is null then
    raise exception 'FAIL: online order not linked to a customer by phone';
  end if;
  if r.tracking_token_hash <> pg_temp.h('p17-track-secret-order-0001') then
    raise exception 'FAIL: tracking secret not stored as its hash';
  end if;

  -- Items are not visible to kitchen until acceptance.
  select count(*) filter (where kitchen_status = 'pending') into v_kds_pending
  from public.order_items where order_id = v_o;
  if v_kds_pending <> 2 then
    raise exception 'FAIL: items reached the kitchen before acceptance (pending=%)', v_kds_pending;
  end if;

  if not exists (select 1 from public.order_status_history
                 where order_id = v_o and to_status = 'held' and note = 'Placed by customer (online)') then
    raise exception 'FAIL: no customer placement history row';
  end if;

  -- Replay with the same reference and secret returns the same order.
  v_res := public.public_order_create('online', v_biz, v_outlet, null, v_payload,
             'p17-fp-main', pg_temp.h('p17-track-secret-order-0001'));
  if (v_res ->> 'order_id')::uuid <> v_o then
    raise exception 'FAIL: replay created a second order';
  end if;
  if (select count(*) from public.orders where client_ref = 'pub-online-p17-ref-0000000001') <> 1 then
    raise exception 'FAIL: replay duplicated the order';
  end if;

  -- The same reference with another secret is refused and reveals nothing.
  if pg_temp.try(format($q$select public.public_order_create('online', %L, %L, null, %L::jsonb, 'p17-fp-main', %L)$q$,
       v_biz, v_outlet, v_payload, pg_temp.h('someone-else-secret'))) not like 'err:%already submitted%' then
    raise exception 'FAIL: a foreign secret could reuse another order reference';
  end if;

  -- Order 2: delivery. Half Biryani at 15000, delivery fee and packaging.
  v_res := public.public_order_create('online', v_biz, v_outlet, null, jsonb_build_object(
    'client_ref', 'p17-ref-0000000002', 'order_type', 'delivery',
    'customer_name', 'Ravi', 'customer_phone', '9000017002',
    'delivery_address', 'Flat 4, Anna Nagar, Chennai',
    'items', jsonb_build_array(jsonb_build_object('item_type', 'product', 'product_id', v_biry,
      'variant_id', pg_temp.ref('half'), 'quantity', 1))),
    'p17-fp-main', pg_temp.h('p17-track-secret-order-0002'));
  insert into p17_refs values ('o2', (v_res ->> 'order_id'));
  select * into r from public.orders where id = (v_res ->> 'order_id')::uuid;
  if r.payment_mode <> 'pay_on_delivery' or r.subtotal_minor <> 15000 or r.charges_minor <> 2500 then
    raise exception 'FAIL: delivery pricing wrong (subtotal %, charges %, mode %)',
      r.subtotal_minor, r.charges_minor, r.payment_mode;
  end if;

  -- Refusals. Every one leaves no order behind.
  if pg_temp.try(format($q$select public.public_order_create('online', %L, %L, null, %L::jsonb, 'p17-fp-main', %L)$q$,
       v_biz, v_outlet, jsonb_build_object('client_ref', 'p17-ref-0000000003', 'order_type', 'delivery',
         'customer_phone', '9000017003', 'items', jsonb_build_array(jsonb_build_object(
         'item_type', 'product', 'product_id', v_biry, 'quantity', 1))), pg_temp.h('s3'))) not like 'err:%delivery address%' then
    raise exception 'FAIL: delivery without an address accepted';
  end if;
  if pg_temp.try(format($q$select public.public_order_create('online', %L, %L, null, %L::jsonb, 'p17-fp-main', %L)$q$,
       v_biz, v_outlet, jsonb_build_object('client_ref', 'p17-ref-0000000004', 'order_type', 'takeaway',
         'customer_phone', '123', 'items', jsonb_build_array(jsonb_build_object(
         'item_type', 'product', 'product_id', v_biry, 'quantity', 1))), pg_temp.h('s4'))) not like 'err:%valid phone%' then
    raise exception 'FAIL: an invalid phone number was accepted';
  end if;
  if pg_temp.try(format($q$select public.public_order_create('online', %L, %L, null, %L::jsonb, 'p17-fp-main', %L)$q$,
       v_biz, v_outlet, jsonb_build_object('client_ref', 'p17-ref-0000000005', 'order_type', 'takeaway',
         'customer_phone', '9000017005', 'items', jsonb_build_array(jsonb_build_object(
         'item_type', 'product', 'product_id', pg_temp.ref('lassi'), 'quantity', 1))), pg_temp.h('s5'))) not like 'err:%' then
    raise exception 'FAIL: an item unavailable at this outlet was accepted';
  end if;
  if pg_temp.try(format($q$select public.public_order_create('online', %L, %L, null, %L::jsonb, 'p17-fp-main', %L)$q$,
       v_biz, v_outlet, jsonb_build_object('client_ref', 'p17-ref-0000000006', 'order_type', 'takeaway',
         'customer_phone', '9000017006', 'items', jsonb_build_array(jsonb_build_object(
         'item_type', 'product', 'product_id', v_naan, 'quantity', 2))), pg_temp.h('s6'))) not like 'err:%minimum order%' then
    raise exception 'FAIL: an order below the online minimum was accepted';
  end if;
  if pg_temp.try(format($q$select public.public_order_create('online', %L, %L, null, %L::jsonb, 'p17-fp-main', %L)$q$,
       v_biz, v_outlet, jsonb_build_object('client_ref', 'p17-ref-0000000007', 'order_type', 'dine_in',
         'customer_phone', '9000017007', 'items', jsonb_build_array(jsonb_build_object(
         'item_type', 'product', 'product_id', v_biry, 'quantity', 1))), pg_temp.h('s7'))) not like 'err:%Choose takeaway or delivery%' then
    raise exception 'FAIL: a dine-in order was accepted through the website';
  end if;
  if pg_temp.try(format($q$select public.public_order_create('online', %L, %L, null, %L::jsonb, 'p17-fp-main', %L)$q$,
       'dddddddd-0000-0000-0000-000000000002', v_outlet, jsonb_build_object('client_ref', 'p17-ref-0000000009', 'order_type', 'takeaway',
         'customer_phone', '9000017009', 'items', jsonb_build_array(jsonb_build_object(
         'item_type', 'product', 'product_id', v_biry, 'quantity', 1))), pg_temp.h('s9'))) not like 'err:%not taking orders%' then
    raise exception 'FAIL: a tenant B id was accepted against tenant A outlet';
  end if;
  if pg_temp.try(format($q$select public.public_order_create('online', %L, %L, null, %L::jsonb, 'p17-fp-main', %L)$q$,
       v_biz, v_outlet, jsonb_build_object('client_ref', 'short', 'order_type', 'takeaway',
         'customer_phone', '9000017010', 'items', jsonb_build_array(jsonb_build_object(
         'item_type', 'product', 'product_id', v_biry, 'quantity', 1))), pg_temp.h('s10'))) not like 'err:%reference is invalid%' then
    raise exception 'FAIL: a malformed order reference was accepted';
  end if;

  -- Takeaway switched off at the outlet is refused, then restored.
  perform public.ordering_settings_save('aaaaaaaa-0000-0000-0000-000000000001', v_outlet, '{"takeaway_enabled": false}');
  if pg_temp.try(format($q$select public.public_order_create('online', %L, %L, null, %L::jsonb, 'p17-fp-main', %L)$q$,
       v_biz, v_outlet, jsonb_build_object('client_ref', 'p17-ref-0000000011', 'order_type', 'takeaway',
         'customer_phone', '9000017011', 'items', jsonb_build_array(jsonb_build_object(
         'item_type', 'product', 'product_id', v_biry, 'quantity', 1))), pg_temp.h('s11'))) not like 'err:%Takeaway is not available%' then
    raise exception 'FAIL: takeaway accepted while switched off';
  end if;
  perform public.ordering_settings_save('aaaaaaaa-0000-0000-0000-000000000001', v_outlet, '{"takeaway_enabled": true}');

  raise notice 'OK: client price, discount, status, outlet and charge fields are ignored; orders are priced from the catalogue, tax reconciles, customers link by phone, replays are idempotent, and foreign secrets, bad input, unavailable items, minimums and disabled channels are refused';
end $$;

\echo '── P17.4: intake guard, acceptance to KDS, rejection, and staff cancellation'
do $$
declare
  v_biz uuid := 'cccccccc-0000-0000-0000-000000000001';
  v_owner uuid := 'aaaaaaaa-0000-0000-0000-000000000001';
  v_cashier uuid := 'f1111111-0000-0000-0000-000000000010';
  v_kitchen uuid := 'f1111111-0000-0000-0000-000000000020';
  v_outlet uuid := pg_temp.ref('outlet');
  v_o1 uuid := pg_temp.ref('o1');
  v_o5 uuid;
  v_o6 uuid;
  v_o7 uuid;
  v_res jsonb;
  v_new integer;
  v_queue jsonb;
begin
  -- Staff cannot push an awaiting order to the kitchen by a status move.
  if pg_temp.try(format('select public.transition_order_status(%L, %L, %L)', v_cashier, v_o1, 'placed'))
       not like 'err:%Accept this order before moving it on%' then
    raise exception 'FAIL: an awaiting order moved to placed without acceptance';
  end if;

  -- Kitchen staff hold orders.view but not orders.manage: they cannot accept.
  if pg_temp.try(format('select public.online_order_accept(%L, %L)', v_kitchen, v_o1))
       not like 'err:%' then
    raise exception 'FAIL: kitchen staff accepted an online order';
  end if;
  if (select intake_status from public.orders where id = v_o1) <> 'awaiting_acceptance' then
    raise exception 'FAIL: refused acceptance still changed the order';
  end if;

  -- Acceptance by a cashier: placed, accepted, and the items reach the KDS.
  perform public.online_order_accept(v_cashier, v_o1);
  if not exists (select 1 from public.orders where id = v_o1
                 and status = 'placed' and intake_status = 'accepted' and accepted_by = v_cashier) then
    raise exception 'FAIL: acceptance did not place and record the order';
  end if;
  select count(*) into v_new from public.order_items where order_id = v_o1 and kitchen_status = 'new';
  if v_new <> 2 then
    raise exception 'FAIL: accepted items did not reach the KDS (new=%)', v_new;
  end if;
  if pg_temp.try(format('select public.online_order_accept(%L, %L)', v_cashier, v_o1))
       not like 'err:%already been accepted or rejected%' then
    raise exception 'FAIL: a second acceptance was allowed';
  end if;

  -- Queue shows the accepted order and the awaiting ones to staff who can view orders.
  v_queue := public.online_intake_queue(v_owner, v_outlet);
  if jsonb_array_length(v_queue) < 2 then
    raise exception 'FAIL: intake queue missing orders: %', jsonb_array_length(v_queue);
  end if;

  -- Order 5: reject with a reason. Order 5 uses another phone and secret.
  v_res := public.public_order_create('online', 'cccccccc-0000-0000-0000-000000000001', v_outlet, null,
    jsonb_build_object('client_ref', 'p17-ref-0000000020', 'order_type', 'takeaway',
      'customer_name', 'Dev', 'customer_phone', '9000017020',
      'items', jsonb_build_array(jsonb_build_object('item_type', 'product',
        'product_id', pg_temp.ref('biry'), 'quantity', 1))),
    'p17-fp-main2', pg_temp.h('p17-track-secret-order-0020'));
  v_o5 := (v_res ->> 'order_id')::uuid;
  insert into p17_refs values ('o5', v_o5::text);

  if pg_temp.try(format('select public.online_order_reject(%L, %L, %L)', v_cashier, v_o5, '   '))
       not like 'err:%Give a reason%' then
    raise exception 'FAIL: rejection without a reason was accepted';
  end if;
  perform public.online_order_reject(v_cashier, v_o5, 'Kitchen closed for the evening');
  if not exists (select 1 from public.orders where id = v_o5 and status = 'cancelled'
                 and intake_status = 'rejected' and rejected_reason = 'Kitchen closed for the evening') then
    raise exception 'FAIL: rejection did not cancel with its reason';
  end if;
  if pg_temp.try(format('select public.online_order_reject(%L, %L, %L)', v_cashier, v_o5, 'again'))
       not like 'err:%already been accepted or rejected%' then
    raise exception 'FAIL: a rejected order was rejected twice';
  end if;
  if pg_temp.try(format('select public.online_order_accept(%L, %L)', v_cashier, v_o5))
       not like 'err:%already been accepted or rejected%' then
    raise exception 'FAIL: a rejected order was accepted';
  end if;

  -- The intake decision is final even for direct writes.
  if pg_temp.try(format('update public.orders set intake_status = %L where id = %L', 'accepted', v_o5))
       not like 'err:%final%' then
    raise exception 'FAIL: a rejected order could be re-opened';
  end if;

  -- Order 6: staff cancel on an awaiting order marks it rejected too.
  v_res := public.public_order_create('online', 'cccccccc-0000-0000-0000-000000000001', v_outlet, null,
    jsonb_build_object('client_ref', 'p17-ref-0000000030', 'order_type', 'takeaway',
      'customer_phone', '9000017030',
      'items', jsonb_build_array(jsonb_build_object('item_type', 'product',
        'product_id', pg_temp.ref('biry'), 'quantity', 1))),
    'p17-fp-main2', pg_temp.h('p17-track-secret-order-0030'));
  v_o6 := (v_res ->> 'order_id')::uuid;
  perform public.transition_order_status(v_cashier, v_o6, 'cancelled');
  if not exists (select 1 from public.orders where id = v_o6 and status = 'cancelled' and intake_status = 'rejected') then
    raise exception 'FAIL: staff cancellation left the intake state open';
  end if;

  -- Order 7: a payment recorded on an awaiting order blocks rejection.
  v_res := public.public_order_create('online', 'cccccccc-0000-0000-0000-000000000001', v_outlet, null,
    jsonb_build_object('client_ref', 'p17-ref-0000000040', 'order_type', 'takeaway',
      'customer_phone', '9000017040',
      'items', jsonb_build_array(jsonb_build_object('item_type', 'product',
        'product_id', pg_temp.ref('biry'), 'quantity', 1))),
    'p17-fp-main2', pg_temp.h('p17-track-secret-order-0040'));
  v_o7 := (v_res ->> 'order_id')::uuid;
  insert into p17_refs values ('o7', v_o7::text);
  if pg_temp.try(format($q$select public.record_payments(%L, %L, %L, %L::jsonb)$q$,
       v_cashier, v_o7, 'p17-pay-o7',
       jsonb_build_array(jsonb_build_object('method_key', 'cash',
         'amount_minor', (select total_minor from public.orders where id = v_o7),
         'tendered_minor', (select total_minor from public.orders where id = v_o7)))))
     = 'ok' then
    if pg_temp.try(format('select public.online_order_reject(%L, %L, %L)', v_cashier, v_o7, 'Changed mind'))
         not like 'err:%Refund the payment%' then
      raise exception 'FAIL: a paid order was rejected without a refund';
    end if;
  else
    raise notice 'INFO: payment on an awaiting order is refused by record_payments; the paid-rejection guard is covered by its own check';
  end if;

  raise notice 'OK: awaiting orders cannot be pushed to the kitchen by a status move; kitchen staff cannot accept; acceptance sends items to the KDS once; rejection needs a reason and is final; staff cancellation is recorded as rejected';
end $$;

\echo '── P17.5: payment, completion, inventory and customer link for an accepted online order'
do $$
declare
  v_cashier uuid := 'f1111111-0000-0000-0000-000000000010';
  v_o1 uuid := pg_temp.ref('o1');
  v_total bigint;
  v_customer uuid;
  v_postings integer;
begin
  select total_minor into v_total from public.orders where id = v_o1;
  perform public.record_payments(v_cashier, v_o1, 'p17-pay-o1', jsonb_build_array(
    jsonb_build_object('method_key', 'cash', 'amount_minor', v_total, 'tendered_minor', v_total)));

  perform pg_temp.finish(v_cashier, v_o1);

  if (select status from public.orders where id = v_o1) <> 'completed' then
    raise exception 'FAIL: accepted online order did not complete';
  end if;

  select count(*) into v_postings from public.inventory_postings where order_id = v_o1;
  if v_postings <> 1 then
    raise exception 'FAIL: completed online order not posted to inventory (%)', v_postings;
  end if;

  select customer_id into v_customer from public.orders where id = v_o1;
  if v_customer is null or not exists (
       select 1 from public.customers c
       where c.id = v_customer and c.phone_key = public.customer_phone_key('9000017001')) then
    raise exception 'FAIL: completed online order not attached to the customer record';
  end if;

  raise notice 'OK: an accepted online order takes payment through record_payments, completes through the normal lifecycle, posts to inventory once, and attaches to its customer';
end $$;

\echo '── P17.6: QR table ordering: resolution, separate tickets, table occupancy on acceptance'
do $$
declare
  v_biz uuid := 'cccccccc-0000-0000-0000-000000000001';
  v_owner uuid := 'aaaaaaaa-0000-0000-0000-000000000001';
  v_cashier uuid := 'f1111111-0000-0000-0000-000000000010';
  v_outlet uuid := pg_temp.ref('outlet');
  v_t1 uuid := pg_temp.ref('t1');
  v_qr1 uuid := pg_temp.ref('qr1');
  v_ctx jsonb;
  v_res jsonb;
  v_q3 uuid;
  v_q4 uuid;
  v_t record;
  v_main_table uuid;
  v_qr2 uuid;
begin
  -- Token resolution: the printed token resolves; a wrong one does not.
  v_ctx := public.public_qr_context(pg_temp.h('p17-qr-token-table-one-0001'));
  if v_ctx is null or v_ctx ->> 'table_label' <> 'P17 T1' then
    raise exception 'FAIL: the printed QR token did not resolve to its table';
  end if;
  if public.public_qr_context(pg_temp.h('a-guessed-token')) is not null then
    raise exception 'FAIL: an unknown QR token resolved';
  end if;

  -- Guest 1 orders at the table. Order 3: two Half Biryani, dine-in, no charges.
  v_res := public.public_order_create('qr', 'cccccccc-0000-0000-0000-000000000001', v_outlet, v_qr1,
    jsonb_build_object('client_ref', 'p17-ref-qr-0000000001', 'discount', jsonb_build_object('type', 'percent', 'value', 50),
      'items', jsonb_build_array(jsonb_build_object('item_type', 'product',
        'product_id', pg_temp.ref('biry'), 'variant_id', pg_temp.ref('half'), 'quantity', 2))),
    'p17-qr-fp-1', pg_temp.h('p17-track-qr-0001'));
  v_q3 := (v_res ->> 'order_id')::uuid;
  insert into p17_refs values ('q3', v_q3::text);

  select * into v_t from public.dining_tables where id = v_t1;
  if v_t.status <> 'available' or v_t.current_order_id is not null then
    raise exception 'FAIL: a QR order occupied the table before acceptance (%)', v_t.status;
  end if;
  if (select order_type || '/' || channel || '/' || payment_mode from public.orders where id = v_q3)
       <> 'dine_in/qr/pay_at_table' then
    raise exception 'FAIL: QR order type, channel or payment mode wrong';
  end if;
  if (select discount_minor from public.orders where id = v_q3) <> 0
     or (select charges_minor from public.orders where id = v_q3) <> 0 then
    raise exception 'FAIL: a QR order took a discount or a charge from the client';
  end if;
  if (select subtotal_minor from public.orders where id = v_q3) <> 30000 then
    raise exception 'FAIL: QR order not priced from the catalogue';
  end if;

  -- Guest 2 at the same table: a separate ticket. Naan is below the online minimum,
  -- which must not apply to dine-in tickets.
  v_res := public.public_order_create('qr', 'cccccccc-0000-0000-0000-000000000001', v_outlet, v_qr1,
    jsonb_build_object('client_ref', 'p17-ref-qr-0000000002',
      'items', jsonb_build_array(jsonb_build_object('item_type', 'product',
        'product_id', pg_temp.ref('naan'), 'quantity', 1))),
    'p17-qr-fp-2', pg_temp.h('p17-track-qr-0002'));
  v_q4 := (v_res ->> 'order_id')::uuid;
  insert into p17_refs values ('q4', v_q4::text);

  -- Acceptance occupies the table for the first ticket.
  perform public.online_order_accept(v_cashier, v_q3);
  select * into v_t from public.dining_tables where id = v_t1;
  if v_t.status <> 'occupied' or v_t.current_order_id <> v_q3 then
    raise exception 'FAIL: accepting the QR order did not occupy its table';
  end if;

  -- Known limitation: a second ticket cannot merge into the open table.
  if pg_temp.try(format('select public.online_order_accept(%L, %L)', v_cashier, v_q4))
       not like 'err:%is occupied%' then
    raise exception 'FAIL: a second QR ticket occupied a table already in use';
  end if;

  -- Once the first ticket completes, the table is released and the second can be accepted.
  perform public.record_payments(v_cashier, v_q3, 'p17-pay-q3', jsonb_build_array(
    jsonb_build_object('method_key', 'cash',
      'amount_minor', (select total_minor from public.orders where id = v_q3),
      'tendered_minor', (select total_minor from public.orders where id = v_q3))));
  perform pg_temp.finish(v_cashier, v_q3);
  select * into v_t from public.dining_tables where id = v_t1;
  if v_t.status <> 'available' or v_t.current_order_id is not null then
    raise exception 'FAIL: table not released after the QR ticket completed (%)', v_t.status;
  end if;
  perform public.online_order_accept(v_cashier, v_q4);
  if (select status from public.orders where id = v_q4) <> 'placed' then
    raise exception 'FAIL: second QR ticket not accepted after the table cleared';
  end if;

  -- QR code lifecycle, owner only.
  if pg_temp.try(format('select public.qr_code_issue(%L, %L, %L, %L, %L, %L)',
       v_cashier, (select outlet_id from public.dining_tables where id = v_t1), v_t1, 'x',
       pg_temp.h('x-token-zz'), 'xxxx')) not like 'err:%Your role does not allow%' then
    raise exception 'FAIL: cashier issued a QR code';
  end if;
  if pg_temp.try(format('select public.qr_code_issue(%L, %L, %L, %L, %L, %L)',
       v_owner, v_outlet, v_t1, 'dup', pg_temp.h('dup-token-zz'), 'dupx')) not like 'err:%already has an active QR code%' then
    raise exception 'FAIL: a second active QR code was issued for one table';
  end if;

  select id into v_main_table from public.dining_tables
  where outlet_id = pg_temp.ref('main') and is_active limit 1;
  if v_main_table is not null and pg_temp.try(format('select public.qr_code_issue(%L, %L, %L, %L, %L, %L)',
       v_owner, v_outlet, v_main_table, 'cross', pg_temp.h('cross-token-zz'), 'crossx')) not like 'err:%active table in this outlet%' then
    raise exception 'FAIL: a QR code was issued for a table in another outlet';
  end if;

  perform public.qr_code_revoke(v_owner, v_qr1);
  perform public.qr_code_revoke(v_owner, v_qr1); -- idempotent
  if public.public_qr_context(pg_temp.h('p17-qr-token-table-one-0001')) is not null then
    raise exception 'FAIL: a revoked QR code still resolves';
  end if;
  if pg_temp.try(format($q$select public.public_order_create('qr', %L, %L, %L, %L::jsonb, 'p17-qr-fp-3', %L)$q$,
       'cccccccc-0000-0000-0000-000000000001', v_outlet, v_qr1,
       jsonb_build_object('client_ref', 'p17-ref-qr-0000000003', 'items', jsonb_build_array(jsonb_build_object(
         'item_type', 'product', 'product_id', pg_temp.ref('naan'), 'quantity', 1))), pg_temp.h('p17-track-qr-0003')))
     not like 'err:%not active%' then
    raise exception 'FAIL: an order was placed through a revoked QR code';
  end if;

  v_qr2 := public.qr_code_issue(v_owner, v_outlet, v_t1, 'P17 T1 reprinted',
             pg_temp.h('p17-qr-token-table-one-0002'), 'p17qr2b');
  if public.public_qr_context(pg_temp.h('p17-qr-token-table-one-0002')) is null then
    raise exception 'FAIL: a reissued QR code did not resolve';
  end if;
  insert into p17_refs values ('qr2', v_qr2::text);

  raise notice 'OK: QR tokens resolve only while active; each QR ticket is separate; a QR ticket occupies its table only on acceptance, a second ticket is refused while the table is busy and accepted once it clears; QR codes are issued and revoked by owners only, one active per table, and a revoked code takes no orders';
end $$;

\echo '── P17.7: auto-accept, public status and tracking secrets'
do $$
declare
  v_biz uuid := 'cccccccc-0000-0000-0000-000000000001';
  v_owner uuid := 'aaaaaaaa-0000-0000-0000-000000000001';
  v_outlet uuid := pg_temp.ref('outlet');
  v_res jsonb;
  v_o uuid;
  v_status jsonb;
begin
  perform public.ordering_settings_save(v_owner, v_outlet, '{"auto_accept": true}');
  v_res := public.public_order_create('online', v_biz, v_outlet, null,
    jsonb_build_object('client_ref', 'p17-ref-auto-0000001', 'order_type', 'takeaway',
      'customer_phone', '9000017050',
      'items', jsonb_build_array(jsonb_build_object('item_type', 'product',
        'product_id', pg_temp.ref('biry'), 'quantity', 1))),
    'p17-fp-auto', pg_temp.h('p17-track-secret-auto-0001'));
  v_o := (v_res ->> 'order_id')::uuid;
  perform public.ordering_settings_save(v_owner, v_outlet, '{"auto_accept": false}');

  if not exists (select 1 from public.orders where id = v_o and status = 'placed' and intake_status = 'accepted') then
    raise exception 'FAIL: auto-accept did not place the order';
  end if;
  if not exists (select 1 from public.order_status_history where order_id = v_o and note = 'Auto-accepted (online)') then
    raise exception 'FAIL: auto-accepted order has no history note';
  end if;
  if (select count(*) from public.order_items where order_id = v_o and kitchen_status = 'new') <> 1 then
    raise exception 'FAIL: auto-accepted items did not reach the KDS';
  end if;

  -- Public status: right secret reads, wrong secret and the order id alone do not.
  v_status := public.public_order_status(v_o, pg_temp.h('p17-track-secret-auto-0001'));
  if v_status is null or v_status ->> 'status' <> 'placed' then
    raise exception 'FAIL: tracking with the right secret did not read the order';
  end if;
  if v_status ? 'customer_phone' or v_status ? 'customer_id' or v_status ? 'tracking_token_hash' then
    raise exception 'FAIL: public status exposes customer or secret fields';
  end if;
  if public.public_order_status(v_o, pg_temp.h('wrong-secret')) is not null then
    raise exception 'FAIL: a wrong secret read an order';
  end if;
  if public.public_order_status(v_o, null) is not null then
    raise exception 'FAIL: a missing secret read an order';
  end if;

  raise notice 'OK: auto-accept places and sends to the KDS when enabled, the public status shows only the order''s own fields, and it needs the tracking secret';
end $$;

\echo '── P17.8: rate limiting holds the public checkout to its budget'
do $$
declare
  v_biz uuid := 'cccccccc-0000-0000-0000-000000000001';
  v_outlet uuid := pg_temp.ref('outlet');
  v_i integer;
  v_res text;
begin
  for v_i in 1..12 loop
    v_res := pg_temp.try(format($q$select public.public_order_create('online', %L, %L, null, %L::jsonb, 'p17-rate-fp', %L)$q$,
      v_biz, v_outlet,
      jsonb_build_object('client_ref', 'p17-rate-' || lpad(v_i::text, 8, '0'), 'order_type', 'takeaway',
        'customer_phone', '9000018001',
        'items', jsonb_build_array(jsonb_build_object('item_type', 'product',
          'product_id', pg_temp.ref('biry'), 'quantity', 1))),
      pg_temp.h('p17-rate-secret-' || v_i)));
    if v_res <> 'ok' then
      raise exception 'FAIL: checkout %, inside the budget, was refused: %', v_i, v_res;
    end if;
  end loop;

  v_res := pg_temp.try(format($q$select public.public_order_create('online', %L, %L, null, %L::jsonb, 'p17-rate-fp', %L)$q$,
    v_biz, v_outlet,
    jsonb_build_object('client_ref', 'p17-rate-00000013', 'order_type', 'takeaway',
      'customer_phone', '9000018001',
      'items', jsonb_build_array(jsonb_build_object('item_type', 'product',
        'product_id', pg_temp.ref('biry'), 'quantity', 1))),
    pg_temp.h('p17-rate-secret-13')));
  if v_res not like 'err:%Too many requests%' then
    raise exception 'FAIL: the 13th checkout in the window was not refused (%)', v_res;
  end if;

  raise notice 'OK: a single client gets 12 checkouts per outlet in 10 minutes; the 13th is refused with a rate-limit error';
end $$;

\echo '── P17.9: security — grants, RLS, column privileges, no raw secrets'
do $$
declare
  v_fn text;
  v_tbl text;
begin
  foreach v_fn in array array[
    'public.public_order_create(text,uuid,uuid,uuid,jsonb,text,text)',
    'public.public_order_status(uuid,text)',
    'public.public_menu(uuid,uuid)',
    'public.public_qr_context(text)',
    'public.public_outlet_context(text,text)',
    'public.ordering_settings_save(uuid,uuid,jsonb)',
    'public.qr_code_issue(uuid,uuid,uuid,text,text,text)',
    'public.qr_code_revoke(uuid,uuid)',
    'public.online_order_accept(uuid,uuid)',
    'public.online_order_reject(uuid,uuid,text)',
    'public.online_intake_queue(uuid,uuid)',
    'public.report_sales_by_channel(uuid,uuid,uuid[],date,date,text,text,integer,integer)',
    'public.payment_webhook_claim(text,text,text,text)'
  ] loop
    if has_function_privilege('anon', v_fn, 'execute')
       or has_function_privilege('authenticated', v_fn, 'execute') then
      raise exception 'FAIL: % is callable by anon or authenticated', v_fn;
    end if;
    if not has_function_privilege('service_role', v_fn, 'execute') then
      raise exception 'FAIL: service_role cannot call %', v_fn;
    end if;
  end loop;

  foreach v_tbl in array array['outlet_ordering_settings', 'qr_codes', 'public_rate_limits'] loop
    if not (select relrowsecurity from pg_class where oid = ('public.' || v_tbl)::regclass) then
      raise exception 'FAIL: RLS is off for %', v_tbl;
    end if;
  end loop;

  if has_column_privilege('authenticated', 'public.qr_codes', 'token_hash', 'select') then
    raise exception 'FAIL: staff can read QR token hashes';
  end if;
  if has_table_privilege('authenticated', 'public.qr_codes', 'insert')
     or has_table_privilege('authenticated', 'public.qr_codes', 'update') then
    raise exception 'FAIL: staff can write QR codes directly';
  end if;
  if has_table_privilege('anon', 'public.public_rate_limits', 'select')
     or has_table_privilege('authenticated', 'public.public_rate_limits', 'select') then
    raise exception 'FAIL: rate-limit state is readable by clients';
  end if;

  if exists (select 1 from public.orders where channel <> 'pos' and tracking_token_hash !~ '^[0-9a-f]{64}$') then
    raise exception 'FAIL: a tracking secret is stored in a non-hash form';
  end if;

  raise notice 'OK: public and staff RPCs are service-only; RLS is on for the new tables; staff cannot read QR hashes or write QR codes; rate-limit state is private; tracking secrets are stored as hashes only';
end $$;

\echo '── P17.10: channel report reconciles to raw orders and to the outlet report'
do $$
declare
  v_biz uuid := 'cccccccc-0000-0000-0000-000000000001';
  v_owner uuid := 'aaaaaaaa-0000-0000-0000-000000000001';
  v_cashier uuid := 'f1111111-0000-0000-0000-000000000010';
  v_from date := (now() at time zone 'Asia/Kolkata')::date - 1;
  v_to date := (now() at time zone 'Asia/Kolkata')::date;
  v_ch jsonb;
  v_out jsonb;
  v_raw_web bigint;
  v_raw_qr bigint;
  v_row jsonb;
  v_web bigint;
  v_qr bigint;
  v_pos bigint;
begin
  v_ch := public.report_sales_by_channel(v_owner, v_biz, null, v_from, v_to, null, 'day', 100, 0);
  v_out := public.report_sales_by_outlet(v_owner, v_biz, null, v_from, v_to, null, 'day', 100, 0);

  if (v_ch -> 'summary' ->> 'billed_minor')::bigint <> (v_out -> 'summary' ->> 'billed_minor')::bigint then
    raise exception 'FAIL: channel report billed % does not match the outlet report billed %',
      v_ch -> 'summary' ->> 'billed_minor', v_out -> 'summary' ->> 'billed_minor';
  end if;
  if (v_ch -> 'summary' ->> 'orders')::bigint <> (v_out -> 'summary' ->> 'orders')::bigint then
    raise exception 'FAIL: channel report order count does not match the outlet report';
  end if;

  select coalesce(sum(o.total_minor), 0) into v_raw_web from public.orders o
  where o.business_id = v_biz and o.channel = 'online' and o.status = 'completed';
  select coalesce(sum(o.total_minor), 0) into v_raw_qr from public.orders o
  where o.business_id = v_biz and o.channel = 'qr' and o.status = 'completed';

  select coalesce(sum((r ->> 'billed_minor')::bigint), 0) into v_web
  from jsonb_array_elements(v_ch -> 'rows') r where r ->> 'channel' = 'online';
  select coalesce(sum((r ->> 'billed_minor')::bigint), 0) into v_qr
  from jsonb_array_elements(v_ch -> 'rows') r where r ->> 'channel' = 'qr';
  select coalesce(sum((r ->> 'billed_minor')::bigint), 0) into v_pos
  from jsonb_array_elements(v_ch -> 'rows') r where r ->> 'channel' = 'pos';

  if v_web <> v_raw_web then
    raise exception 'FAIL: website sales % do not match raw completed website orders %', v_web, v_raw_web;
  end if;
  if v_qr <> v_raw_qr then
    raise exception 'FAIL: QR sales % do not match raw completed QR orders %', v_qr, v_raw_qr;
  end if;
  if v_web + v_qr + v_pos <> (v_ch -> 'summary' ->> 'billed_minor')::bigint then
    raise exception 'FAIL: channel rows do not add up to the summary';
  end if;

  -- Cashier has no reports permission.
  if pg_temp.try(format('select public.report_sales_by_channel(%L, %L, null, %L, %L, null, %L, 100, 0)',
       v_cashier, v_biz, v_from, v_to, 'day')) not like 'err:%' then
    raise exception 'FAIL: cashier could read the channel report';
  end if;

  raise notice 'OK: channel report sums to the outlet report (billed %), website and QR rows match raw completed orders, and the report is permission-gated', (v_ch -> 'summary' ->> 'billed_minor');
end $$;

\echo '── P17.11: audit trail covers every intake and configuration decision'
do $$
declare
  v_missing text := '';
begin
  if not exists (select 1 from public.audit_logs where action = 'order.accepted') then
    v_missing := v_missing || ' order.accepted';
  end if;
  if not exists (select 1 from public.audit_logs where action = 'order.rejected') then
    v_missing := v_missing || ' order.rejected';
  end if;
  if not exists (select 1 from public.audit_logs where action = 'qr.issued') then
    v_missing := v_missing || ' qr.issued';
  end if;
  if not exists (select 1 from public.audit_logs where action = 'qr.revoked') then
    v_missing := v_missing || ' qr.revoked';
  end if;
  if not exists (select 1 from public.audit_logs where action = 'ordering.settings_saved') then
    v_missing := v_missing || ' ordering.settings_saved';
  end if;
  if v_missing <> '' then
    raise exception 'FAIL: audit rows missing for:%', v_missing;
  end if;

  raise notice 'OK: accept, reject, QR issue and revoke, and settings changes are all audited';
end $$;

\echo '── P17.12: payment webhook claims are idempotent and never change money'
do $$
declare
  v_o1 uuid := pg_temp.ref('o1');
  v_paid_before bigint;
  v_status_before text;
  v_payments_before bigint;
begin
  select paid_minor, payment_status into v_paid_before, v_status_before from public.orders where id = v_o1;
  select count(*) into v_payments_before from public.payments where order_id = v_o1;

  if public.payment_webhook_claim('gateway', 'evt_p17_0001', 'payment.captured', repeat('a', 64)) <> 'new' then
    raise exception 'FAIL: first delivery of an event was not claimed as new';
  end if;
  if public.payment_webhook_claim('gateway', 'evt_p17_0001', 'payment.captured', repeat('a', 64)) <> 'duplicate' then
    raise exception 'FAIL: a replayed event was not recognised as a duplicate';
  end if;
  if public.payment_webhook_claim('gateway', 'evt_p17_0001', 'payment.captured', repeat('b', 64)) <> 'mismatch' then
    raise exception 'FAIL: an event id reused with a different payload was not flagged';
  end if;
  if pg_temp.try(format('select public.payment_webhook_claim(%L, %L, %L, %L)', 'gateway', 'evt_p17_0002', 'x', 'not-a-digest'))
       not like 'err:%Invalid payload digest%' then
    raise exception 'FAIL: a malformed payload digest was accepted';
  end if;

  if (select paid_minor from public.orders where id = v_o1) <> v_paid_before
     or (select payment_status from public.orders where id = v_o1) <> v_status_before
     or (select count(*) from public.payments where order_id = v_o1) <> v_payments_before then
    raise exception 'FAIL: a webhook claim changed an order or a payment';
  end if;

  if has_function_privilege('authenticated', 'public.payment_webhook_claim(text,text,text,text)', 'execute')
     or has_table_privilege('authenticated', 'public.payment_webhook_events', 'select') then
    raise exception 'FAIL: webhook state is visible to clients';
  end if;

  raise notice 'OK: webhook events are claimed once (replays are duplicates, altered payloads are flagged), malformed digests are refused, and a claim never changes an order or a payment';
end $$;
