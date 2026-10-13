-- ─────────────────────────────────────────────────────────────────────────
-- Phase 15 — CRM + loyalty: customers, phone linking, coupons, reward
-- vouchers, the points ledger, refunds, and reconciliation.
-- Runs after Phase 14. Uses its own menu item, coupons and customers (P15 …).
--
-- Worked numbers (paise):
--   Thali = 20000. Points rate: 10000 per point (₹100 of net spend).
--   Order 1 (Asha): 2 thalis = 40000, SAVE10 = 4000 → net 36000 → 3 points.
--   Order G (Asha): 1 thali = 20000, reward 3000 → net 17000 → 1 point.
--   Balance: 3 → +100 adjust → 103 → redeem 50 → 53 → redeem 50 → 3
--            → order G +1 → 4 → full refund of G claws back 1 → 3.
-- ─────────────────────────────────────────────────────────────────────────

create temp table if not exists p15_refs (k text primary key, v text);

create or replace function pg_temp.ref(p_key text) returns uuid
language sql stable as $$
  select v::uuid from p15_refs where k = p_key;
$$;

-- Runs a statement and reports 'ok' or 'err:<message>'. Used for refusals.
create or replace function pg_temp.try(p_sql text) returns text
language plpgsql as $$
begin
  execute p_sql;
  return 'ok';
exception when others then
  return 'err:' || sqlerrm;
end $$;

-- Runs a statement that returns text and reports 'ok:<value>' or 'err:<message>'.
create or replace function pg_temp.try_val(p_sql text) returns text
language plpgsql as $$
declare
  v text;
begin
  execute p_sql into v;
  return 'ok:' || coalesce(v, '');
exception when others then
  return 'err:' || sqlerrm;
end $$;

create or replace function pg_temp.items(p_product uuid, p_qty integer) returns jsonb
language sql immutable as $$
  select jsonb_build_array(jsonb_build_object('item_type', 'product', 'product_id', p_product, 'quantity', p_qty));
$$;

\echo '── P15.0: fixtures (menu item, loyalty settings, rewards, coupons)'
do $$
declare
  v_biz uuid := 'cccccccc-0000-0000-0000-000000000001';
  v_owner uuid := 'aaaaaaaa-0000-0000-0000-000000000001';
  v_outlet uuid;
  v_cat uuid;
  v_thali uuid;
  v_reward uuid;
begin
  select id into v_outlet from public.outlets where business_id = v_biz and slug = 'main';
  insert into public.menu_categories (business_id, name) values (v_biz, 'P15 Cat') returning id into v_cat;
  insert into public.menu_items (business_id, category_id, name, price_minor)
  values (v_biz, v_cat, 'P15 Thali', 20000) returning id into v_thali;
  insert into p15_refs values ('outlet', v_outlet::text), ('thali', v_thali::text);

  perform public.loyalty_settings_save(v_owner, v_biz, true, 10000);

  v_reward := public.loyalty_reward_save(v_owner, v_biz, null, 'P15 Free Tea', 50, 'flat', 3000, null, true);
  insert into p15_refs values ('reward_tea', v_reward::text);

  insert into p15_refs values ('coupon_save10', public.coupon_save(v_owner, v_biz, null, 'p15save10', 'P15 Ten percent',
    'percent', 10, 5000, 10000, null, null, null, null, true)::text);
  insert into p15_refs values ('coupon_flat', public.coupon_save(v_owner, v_biz, null, 'P15FLAT', 'P15 Flat fifty',
    'flat', 5000, null, 30000, null, null, 1, null, true)::text);
  insert into p15_refs values ('coupon_once', public.coupon_save(v_owner, v_biz, null, 'P15ONCE', 'P15 Once per customer',
    'percent', 15, null, 0, null, null, null, 1, true)::text);
  insert into p15_refs values ('coupon_old', public.coupon_save(v_owner, v_biz, null, 'P15OLD', 'P15 Expired',
    'flat', 1000, null, 0, null, public.business_today() - 1, null, null, true)::text);

  raise notice 'OK: fixtures ready (thali, loyalty at 10000 per point, one reward, four coupons)';
end $$;

\echo '── P15.1: customers are managed by customers.manage and validated'
do $$
declare
  v_biz uuid := 'cccccccc-0000-0000-0000-000000000001';
  v_owner uuid := 'aaaaaaaa-0000-0000-0000-000000000001';
  v_accountant uuid := 'f1111111-0000-0000-0000-000000000011';
  v_asha uuid;
  v_r text;
begin
  v_asha := public.customer_save(v_owner, v_biz, null, 'Asha Rao', '+91 98765 43210', 'asha@example.com', null);
  insert into p15_refs values ('asha', v_asha::text);

  -- the same phone in another format is the same customer
  v_r := pg_temp.try(format('select public.customer_save(%L, %L, null, %L, %L, null, null)',
    v_owner, v_biz, 'Asha Duplicate', '9876543210'));
  if v_r not like 'err:%Another customer already uses this phone number%' then
    raise exception 'duplicate phone accepted: %', v_r;
  end if;

  v_r := pg_temp.try(format('select public.customer_save(%L, %L, null, %L, %L, null, null)',
    v_accountant, v_biz, 'Not Allowed', '9000000001'));
  if v_r not like 'err:%customers.manage%' then
    raise exception 'accountant can manage customers: %', v_r;
  end if;

  v_r := pg_temp.try(format('select public.customer_save(%L, %L, null, %L, %L, null, null)',
    v_owner, v_biz, 'Short Phone', 'abc'));
  if v_r not like 'err:%at least 7 digits%' then
    raise exception 'bad phone accepted: %', v_r;
  end if;

  v_r := pg_temp.try(format('select public.customer_save(%L, %L, null, %L, %L, %L, null)',
    v_owner, v_biz, 'Bad Email', '9000000002', 'not-an-email'));
  if v_r not like 'err:%valid email%' then
    raise exception 'bad email accepted: %', v_r;
  end if;

  raise notice 'OK: customers need customers.manage, one customer per phone, and valid phone and email';
end $$;

\echo '── P15.2: orders link to customers by phone; a new phone creates the customer'
do $$
declare
  v_biz uuid := 'cccccccc-0000-0000-0000-000000000001';
  v_owner uuid := 'aaaaaaaa-0000-0000-0000-000000000001';
  v_outlet uuid := pg_temp.ref('outlet');
  v_thali uuid := pg_temp.ref('thali');
  v_asha uuid := pg_temp.ref('asha');
  v_o1 uuid; v_o2 uuid; v_o3 uuid;
  v_cust uuid;
  v_name text;
begin
  v_o1 := public.create_pos_order(v_owner, jsonb_build_object(
    'outlet_id', v_outlet, 'client_ref', 'p15-order-01', 'order_type', 'takeaway',
    'customer_phone', '9876543210', 'customer_name', 'Asha',
    'discount', jsonb_build_object('type', 'none'),
    'items', pg_temp.items(v_thali, 1)));
  insert into p15_refs values ('o1', v_o1::text);
  if (select customer_id from public.orders where id = v_o1) is distinct from v_asha then
    raise exception 'order 1 not linked to Asha by phone';
  end if;

  v_o2 := public.create_pos_order(v_owner, jsonb_build_object(
    'outlet_id', v_outlet, 'client_ref', 'p15-order-02', 'order_type', 'takeaway',
    'customer_phone', '+91 99999 00011',
    'discount', jsonb_build_object('type', 'none'),
    'items', pg_temp.items(v_thali, 1)));
  insert into p15_refs values ('o2', v_o2::text);
  select c.id, c.name into v_cust, v_name from public.orders o join public.customers c on c.id = o.customer_id
  where o.id = v_o2;
  if v_cust is null or v_name <> 'Customer 0011' then
    raise exception 'new phone did not create a customer (got %)', v_name;
  end if;

  v_o3 := public.create_pos_order(v_owner, jsonb_build_object(
    'outlet_id', v_outlet, 'client_ref', 'p15-order-03', 'order_type', 'takeaway',
    'discount', jsonb_build_object('type', 'none'),
    'items', pg_temp.items(v_thali, 1)));
  insert into p15_refs values ('o3', v_o3::text);
  if (select customer_id from public.orders where id = v_o3) is not null then
    raise exception 'order without a phone was linked to a customer';
  end if;

  -- amending an order with a phone links it, and the phone is the only identity
  perform public.amend_pos_order(v_owner, v_o3, jsonb_build_object(
    'customer_phone', '9876543210', 'customer_name', 'Asha',
    'discount', jsonb_build_object('type', 'none'), 'charges', '[]'::jsonb,
    'items', pg_temp.items(v_thali, 1)));
  if (select customer_id from public.orders where id = v_o3) is distinct from v_asha then
    raise exception 'amend did not link the order to Asha';
  end if;

  raise notice 'OK: orders link to the customer with the same phone, a new phone creates one, and amend re-links';
end $$;

\echo '── P15.3: coupons are checked for minimum, validity, duplicates and role'
do $$
declare
  v_biz uuid := 'cccccccc-0000-0000-0000-000000000001';
  v_cashier uuid := 'f1111111-0000-0000-0000-000000000010';
  v_waiter uuid := 'f1111111-0000-0000-0000-000000000040';
  v_o1 uuid := pg_temp.ref('o1');
  v_o2 uuid := pg_temp.ref('o2');
  v_o3 uuid := pg_temp.ref('o3');
  v_disc bigint; v_promo bigint; v_r text; v_total bigint; v_sub bigint; v_tax bigint; v_charges bigint;
begin
  -- the cashier applies SAVE10 to Asha's order 1 (40000 subtotal after the amend is in P15.4)
  -- here order 1 is 20000 subtotal, so 10% is 2000
  -- cashier holds discounts.apply, so this should work
  v_r := pg_temp.try_val(format('select (public.order_apply_coupon(%L, %L, %L))::text',
    'aaaaaaaa-0000-0000-0000-000000000001', v_o1, 'P15SAVE10'));
  if v_r not like 'ok:%' then raise exception 'owner could not apply SAVE10: %', v_r; end if;

  select discount_minor, promotion_minor, subtotal_minor, tax_minor, charges_minor, total_minor
    into v_disc, v_promo, v_sub, v_tax, v_charges, v_total
  from public.orders where id = v_o1;
  if v_promo <> 2000 or v_disc <> 2000 then
    raise exception 'SAVE10 on 20000 should give 2000, got discount % promotion %', v_disc, v_promo;
  end if;
  if v_total <> v_sub - v_disc + v_tax + v_charges then
    raise exception 'total does not add up after the promotion';
  end if;

  -- one promotion per order
  v_r := pg_temp.try_val(format('select (public.order_apply_coupon(%L, %L, %L))::text',
    'aaaaaaaa-0000-0000-0000-000000000001', v_o1, 'P15FLAT'));
  if v_r not like 'err:%already has a coupon or reward%' then
    raise exception 'second promotion accepted: %', v_r;
  end if;

  -- a waiter has orders.manage but not discounts.apply
  v_r := pg_temp.try_val(format('select (public.order_apply_coupon(%L, %L, %L))::text',
    v_waiter, v_o3, 'P15SAVE10'));
  if v_r not like 'err:%discounts.apply%' then
    raise exception 'waiter applied a coupon: %', v_r;
  end if;

  -- minimum subtotal: P15FLAT needs 30000, order 3 is 20000
  v_r := pg_temp.try_val(format('select (public.order_apply_coupon(%L, %L, %L))::text',
    v_cashier, v_o3, 'P15FLAT'));
  if v_r not like 'err:%below the coupon minimum%' then
    raise exception 'minimum not enforced: %', v_r;
  end if;

  -- per-customer coupons need a customer on the order; order 2 has one but no phone link check here
  v_r := pg_temp.try_val(format('select (public.order_apply_coupon(%L, %L, %L))::text',
    v_cashier, v_o3, 'P15OLD'));
  if v_r not like 'err:%not valid today%' then
    raise exception 'expired coupon accepted: %', v_r;
  end if;

  v_r := pg_temp.try_val(format('select (public.order_apply_coupon(%L, %L, %L))::text',
    v_cashier, v_o2, 'NOPE-NOPE'));
  if v_r not like 'err:%does not exist%' then
    raise exception 'unknown code accepted: %', v_r;
  end if;

  raise notice 'OK: SAVE10 gives 2000 on 20000 and the total adds up; one promotion per order; waiter, minimum, expiry and unknown codes refused';
end $$;

\echo '── P15.4: a promotion follows the order when items change'
do $$
declare
  v_owner uuid := 'aaaaaaaa-0000-0000-0000-000000000001';
  v_thali uuid := pg_temp.ref('thali');
  v_o1 uuid := pg_temp.ref('o1');
  v_disc bigint; v_promo bigint; v_sub bigint;
begin
  perform public.amend_pos_order(v_owner, v_o1, jsonb_build_object(
    'customer_phone', '9876543210', 'customer_name', 'Asha',
    'discount', jsonb_build_object('type', 'none'), 'charges', '[]'::jsonb,
    'items', pg_temp.items(v_thali, 2)));

  select subtotal_minor, discount_minor, promotion_minor into v_sub, v_disc, v_promo
  from public.orders where id = v_o1;
  if v_sub <> 40000 or v_promo <> 4000 or v_disc <> 4000 then
    raise exception 'promotion not recomputed after amend: subtotal %, promotion %', v_sub, v_promo;
  end if;

  raise notice 'OK: amending the order recomputes SAVE10 (40000 subtotal gives 4000)';
end $$;

\echo '── P15.5: completion earns points once and consumes the coupon'
do $$
declare
  v_biz uuid := 'cccccccc-0000-0000-0000-000000000001';
  v_owner uuid := 'aaaaaaaa-0000-0000-0000-000000000001';
  v_asha uuid := pg_temp.ref('asha');
  v_o1 uuid := pg_temp.ref('o1');
  v_total bigint; v_balance integer; v_earn integer; v_redeemed bigint; v_points integer;
begin
  select total_minor into v_total from public.orders where id = v_o1;
  perform public.record_payments(v_owner, v_o1, 'p15-pay-o1', jsonb_build_array(
    jsonb_build_object('method_key', 'cash', 'amount_minor', v_total)));

  -- the test completes the order directly, as the superuser harness does elsewhere
  update public.orders set status = 'completed' where id = v_o1;

  select coalesce(sum(points), 0) into v_earn from public.loyalty_transactions
  where order_id = v_o1 and kind = 'earn';
  if v_earn <> 3 then raise exception 'expected 3 points for 36000 net, got %', v_earn; end if;

  select balance into v_balance from public.loyalty_accounts where customer_id = v_asha;
  if v_balance <> 3 then raise exception 'balance after earn is %, expected 3', v_balance; end if;

  select sum(amount_minor) into v_redeemed from public.coupon_redemptions where order_id = v_o1;
  if v_redeemed <> 4000 then raise exception 'coupon usage not recorded (%)', v_redeemed; end if;

  -- re-saving a completed order as completed earns nothing
  update public.orders set status = 'completed' where id = v_o1;
  if (select count(*) from public.loyalty_transactions where order_id = v_o1 and kind = 'earn') <> 1 then
    raise exception 'order earned points more than once';
  end if;

  raise notice 'OK: completion earns 3 points from net spend (36000), records one coupon use, and earns once';
end $$;

\echo '── P15.6: usage limits and per-customer limits hold across open orders'
do $$
declare
  v_biz uuid := 'cccccccc-0000-0000-0000-000000000001';
  v_owner uuid := 'aaaaaaaa-0000-0000-0000-000000000001';
  v_cashier uuid := 'f1111111-0000-0000-0000-000000000010';
  v_outlet uuid := pg_temp.ref('outlet');
  v_thali uuid := pg_temp.ref('thali');
  v_asha uuid := pg_temp.ref('asha');
  v_a uuid; v_b uuid; v_c uuid; v_d uuid;
  v_r text;
begin
  -- FLAT: usage_limit 1. Applying it to one open order uses the only slot.
  v_a := public.create_pos_order(v_owner, jsonb_build_object(
    'outlet_id', v_outlet, 'client_ref', 'p15-ord-a', 'order_type', 'takeaway',
    'discount', jsonb_build_object('type', 'none'), 'items', pg_temp.items(v_thali, 2)));
  v_r := pg_temp.try_val(format('select (public.order_apply_coupon(%L, %L, %L))::text', v_cashier, v_a, 'P15FLAT'));
  if v_r not like 'ok:%' then raise exception 'first P15FLAT use refused: %', v_r; end if;

  v_b := public.create_pos_order(v_owner, jsonb_build_object(
    'outlet_id', v_outlet, 'client_ref', 'p15-ord-b', 'order_type', 'takeaway',
    'discount', jsonb_build_object('type', 'none'), 'items', pg_temp.items(v_thali, 2)));
  v_r := pg_temp.try_val(format('select (public.order_apply_coupon(%L, %L, %L))::text', v_cashier, v_b, 'P15FLAT'));
  if v_r not like 'err:%fully used%' then raise exception 'usage limit oversold: %', v_r; end if;

  -- ONCE: one per customer. Asha's order 1 is completed in P15.5 and did not use it,
  -- so the first use is on a new Asha order, and a second Asha order is refused.
  v_c := public.create_pos_order(v_owner, jsonb_build_object(
    'outlet_id', v_outlet, 'client_ref', 'p15-ord-c', 'order_type', 'takeaway',
    'customer_phone', '9876543210', 'customer_name', 'Asha',
    'discount', jsonb_build_object('type', 'none'), 'items', pg_temp.items(v_thali, 1)));
  v_r := pg_temp.try_val(format('select (public.order_apply_coupon(%L, %L, %L))::text', v_cashier, v_c, 'P15ONCE'));
  if v_r not like 'ok:%' then raise exception 'first P15ONCE use refused: %', v_r; end if;

  v_d := public.create_pos_order(v_owner, jsonb_build_object(
    'outlet_id', v_outlet, 'client_ref', 'p15-ord-d', 'order_type', 'takeaway',
    'customer_phone', '9876543210', 'customer_name', 'Asha',
    'discount', jsonb_build_object('type', 'none'), 'items', pg_temp.items(v_thali, 1)));
  v_r := pg_temp.try_val(format('select (public.order_apply_coupon(%L, %L, %L))::text', v_cashier, v_d, 'P15ONCE'));
  if v_r not like 'err:%already used this coupon%' then raise exception 'per-customer limit not enforced: %', v_r; end if;

  insert into p15_refs values ('a', v_a::text), ('b', v_b::text), ('c', v_c::text), ('d', v_d::text);
  raise notice 'OK: usage limit counts open applications, and the per-customer limit holds for one customer';
end $$;

\echo '── P15.7: points are a ledger; redemption is idempotent and cannot overdraw'
do $$
declare
  v_biz uuid := 'cccccccc-0000-0000-0000-000000000001';
  v_owner uuid := 'aaaaaaaa-0000-0000-0000-000000000001';
  v_accountant uuid := 'f1111111-0000-0000-0000-000000000011';
  v_asha uuid := pg_temp.ref('asha');
  v_reward uuid := pg_temp.ref('reward_tea');
  v_r text; v_balance integer; v_n integer; v_v1 uuid; v_v2 uuid; v_res jsonb;
begin
  -- 3 points cannot buy a 50-point reward
  v_r := pg_temp.try_val(format('select (public.reward_redeem(%L, %L, %L, %L, %L))::text',
    v_owner, v_biz, v_asha, v_reward, 'p15-red-short'));
  if v_r not like 'err:%Not enough points%' then raise exception 'redeemed with 3 points: %', v_r; end if;

  -- a manager adds 100 points, once. The same client_ref does nothing the second time.
  v_res := public.loyalty_points_adjust(v_owner, v_biz, v_asha, 100, 'Welcome bonus', 'p15-adj-1');
  if (v_res ->> 'duplicate')::boolean then raise exception 'first adjustment flagged duplicate'; end if;
  v_res := public.loyalty_points_adjust(v_owner, v_biz, v_asha, 100, 'Welcome bonus', 'p15-adj-1');
  if not (v_res ->> 'duplicate')::boolean then raise exception 'repeat adjustment was booked twice'; end if;

  select balance into v_balance from public.loyalty_accounts where customer_id = v_asha;
  if v_balance <> 103 then raise exception 'balance after one adjustment is %, expected 103', v_balance; end if;

  -- an adjustment cannot take the balance below zero
  v_r := pg_temp.try(format('select public.loyalty_points_adjust(%L, %L, %L, -500, %L, %L)',
    v_owner, v_biz, v_asha, 'Clawback too large', 'p15-adj-neg'));
  if v_r not like 'err:%Not enough points%' then raise exception 'balance went negative: %', v_r; end if;

  -- an adjustment needs a reason
  v_r := pg_temp.try(format('select public.loyalty_points_adjust(%L, %L, %L, 10, %L, %L)',
    v_owner, v_biz, v_asha, 'x', 'p15-adj-noreason'));
  if v_r not like 'err:%reason%' then raise exception 'adjustment without a reason accepted: %', v_r; end if;

  -- redeem once. A repeated client_ref returns the same voucher and charges nothing.
  v_res := public.reward_redeem(v_owner, v_biz, v_asha, v_reward, 'p15-red-1');
  v_v1 := (v_res ->> 'voucher_id')::uuid;
  v_res := public.reward_redeem(v_owner, v_biz, v_asha, v_reward, 'p15-red-1');
  if not (v_res ->> 'duplicate')::boolean or (v_res ->> 'voucher_id')::uuid <> v_v1 then
    raise exception 'repeat redemption was not idempotent';
  end if;

  select balance into v_balance from public.loyalty_accounts where customer_id = v_asha;
  if v_balance <> 53 then raise exception 'balance after one redemption is %, expected 53', v_balance; end if;

  -- a second redemption with a new reference is a second voucher
  v_res := public.reward_redeem(v_owner, v_biz, v_asha, v_reward, 'p15-red-2');
  v_v2 := (v_res ->> 'voucher_id')::uuid;
  if v_v2 = v_v1 then raise exception 'second redemption reused the first voucher'; end if;
  select balance into v_balance from public.loyalty_accounts where customer_id = v_asha;
  if v_balance <> 3 then raise exception 'balance after two redemptions is %, expected 3', v_balance; end if;

  -- and a third is refused: 3 points is not enough
  v_r := pg_temp.try_val(format('select (public.reward_redeem(%L, %L, %L, %L, %L))::text',
    v_owner, v_biz, v_asha, v_reward, 'p15-red-3'));
  if v_r not like 'err:%Not enough points%' then raise exception 'third redemption accepted: %', v_r; end if;

  -- an accountant (no discounts.apply) cannot redeem
  v_r := pg_temp.try_val(format('select (public.reward_redeem(%L, %L, %L, %L, %L))::text',
    v_accountant, v_biz, v_asha, v_reward, 'p15-red-acct'));
  if v_r not like 'err:%discounts.apply%' then raise exception 'accountant redeemed: %', v_r; end if;

  -- the ledger has one adjustment row and two redemption rows for these references
  select count(*) into v_n from public.loyalty_transactions
  where client_ref in ('p15-adj-1') and kind = 'adjust';
  if v_n <> 1 then raise exception 'adjustment rows = %, expected 1', v_n; end if;
  select count(*) into v_n from public.loyalty_transactions
  where customer_id = v_asha and kind = 'redeem';
  if v_n <> 2 then raise exception 'redemption rows = %, expected 2', v_n; end if;

  insert into p15_refs values ('v1', v_v1::text), ('v2', v_v2::text);
  raise notice 'OK: points are a ledger; the adjustment and redemption are idempotent; the balance never goes negative';
end $$;

\echo '── P15.8: a reward voucher sits on one order at a time and returns when released'
do $$
declare
  v_biz uuid := 'cccccccc-0000-0000-0000-000000000001';
  v_owner uuid := 'aaaaaaaa-0000-0000-0000-000000000001';
  v_cashier uuid := 'f1111111-0000-0000-0000-000000000010';
  v_outlet uuid := pg_temp.ref('outlet');
  v_thali uuid := pg_temp.ref('thali');
  v_asha uuid := pg_temp.ref('asha');
  v_v1 uuid := pg_temp.ref('v1');
  v_e uuid; v_f uuid; v_r text; v_status text; v_order uuid; v_promo bigint; v_disc bigint;
begin
  v_e := public.create_pos_order(v_owner, jsonb_build_object(
    'outlet_id', v_outlet, 'client_ref', 'p15-ord-e', 'order_type', 'takeaway',
    'customer_phone', '9876543210', 'customer_name', 'Asha',
    'discount', jsonb_build_object('type', 'none'), 'items', pg_temp.items(v_thali, 1)));
  insert into p15_refs values ('e', v_e::text);

  v_r := pg_temp.try_val(format('select (public.order_apply_reward(%L, %L, %L))::text', v_cashier, v_e, v_v1));
  if v_r not like 'ok:%' then raise exception 'reward not applied: %', v_r; end if;

  select status into v_status from public.customer_vouchers where id = v_v1;
  if v_status <> 'applied' then raise exception 'voucher status after apply = %', v_status; end if;
  select promotion_minor, discount_minor into v_promo, v_disc from public.orders where id = v_e;
  if v_promo <> 3000 or v_disc <> 3000 then raise exception 'flat reward on 20000 should be 3000, got %', v_promo; end if;

  -- the same voucher cannot go on a second order
  v_f := public.create_pos_order(v_owner, jsonb_build_object(
    'outlet_id', v_outlet, 'client_ref', 'p15-ord-f', 'order_type', 'takeaway',
    'customer_phone', '9876543210', 'customer_name', 'Asha',
    'discount', jsonb_build_object('type', 'none'), 'items', pg_temp.items(v_thali, 1)));
  insert into p15_refs values ('f', v_f::text);
  v_r := pg_temp.try_val(format('select (public.order_apply_reward(%L, %L, %L))::text', v_cashier, v_f, v_v1));
  if v_r not like 'err:%already been used or is on another order%' then
    raise exception 'one voucher applied to two orders: %', v_r;
  end if;

  -- a phone change is refused while the reward is attached
  v_r := pg_temp.try(format('select public.amend_pos_order(%L, %L, %L)',
    v_owner, v_e, jsonb_build_object(
      'customer_phone', '+91 99999 00011', 'customer_name', 'Someone Else',
      'discount', jsonb_build_object('type', 'none'), 'charges', '[]'::jsonb,
      'items', pg_temp.items(v_thali, 1))));
  if v_r not like 'err:%Remove the coupon or reward%' then
    raise exception 'phone changed under a reward: %', v_r;
  end if;

  -- remove it: the voucher is issued again and the discount is gone
  perform public.order_remove_promotion(v_owner, v_e);
  select status into v_status from public.customer_vouchers where id = v_v1;
  if v_status <> 'issued' then raise exception 'voucher not returned after remove (%)', v_status; end if;
  select promotion_minor into v_promo from public.orders where id = v_e;
  if v_promo <> 0 then raise exception 'discount still on the order after remove'; end if;

  -- apply again, then cancel: cancelling releases the voucher and the promotion row
  perform public.order_apply_reward(v_owner, v_e, v_v1);
  perform public.transition_order_status(v_owner, v_e, 'cancelled', 'P15 test cancel');
  select status into v_status from public.customer_vouchers where id = v_v1;
  if v_status <> 'issued' then raise exception 'voucher not released on cancel (%)', v_status; end if;
  if exists (select 1 from public.order_promotions where order_id = v_e) then
    raise exception 'promotion row survived cancellation';
  end if;

  raise notice 'OK: a reward is single-use across orders, refuses a phone change while attached, and returns on remove or cancel';
end $$;

\echo '── P15.9: completion consumes the voucher, refunds claw back points, and reconciliation agrees'
do $$
declare
  v_biz uuid := 'cccccccc-0000-0000-0000-000000000001';
  v_owner uuid := 'aaaaaaaa-0000-0000-0000-000000000001';
  v_cashier uuid := 'f1111111-0000-0000-0000-000000000010';
  v_kitchen uuid := 'f1111111-0000-0000-0000-000000000020';
  v_accountant uuid := 'f1111111-0000-0000-0000-000000000011';
  v_outlet uuid := pg_temp.ref('outlet');
  v_thali uuid := pg_temp.ref('thali');
  v_asha uuid := pg_temp.ref('asha');
  v_v1 uuid := pg_temp.ref('v1');
  v_g uuid; v_total bigint; v_pay uuid; v_status text; v_balance integer; v_n integer;
  v_rec jsonb; v_n_rls integer; v_r text;
begin
  v_g := public.create_pos_order(v_owner, jsonb_build_object(
    'outlet_id', v_outlet, 'client_ref', 'p15-ord-g', 'order_type', 'takeaway',
    'customer_phone', '9876543210', 'customer_name', 'Asha',
    'discount', jsonb_build_object('type', 'none'), 'items', pg_temp.items(v_thali, 1)));
  insert into p15_refs values ('g', v_g::text);
  perform public.order_apply_reward(v_owner, v_g, pg_temp.ref('v2'));

  select total_minor into v_total from public.orders where id = v_g;
  perform public.record_payments(v_owner, v_g, 'p15-pay-g', jsonb_build_array(
    jsonb_build_object('method_key', 'cash', 'amount_minor', v_total)));
  update public.orders set status = 'completed' where id = v_g;

  select status into v_status from public.customer_vouchers where id = pg_temp.ref('v2');
  if v_status <> 'used' then raise exception 'voucher not consumed on completion (%)', v_status; end if;

  -- the consumed voucher cannot go on another order
  v_r := pg_temp.try_val(format('select (public.order_apply_reward(%L, %L, %L))::text',
    v_cashier, pg_temp.ref('f'), pg_temp.ref('v2')));
  if v_r not like 'err:%already been used%' then raise exception 'used voucher reapplied: %', v_r; end if;

  -- balance before the refund: 3 + 1 (order G, net 17000) = 4
  select balance into v_balance from public.loyalty_accounts where customer_id = v_asha;
  if v_balance <> 4 then raise exception 'balance after order G is %, expected 4', v_balance; end if;

  -- full refund claws back the 1 point earned on order G
  select id into v_pay from public.payments where order_id = v_g limit 1;
  perform public.refund_payment(v_owner, v_pay, v_total, 'Customer returned the order', 'p15-rfd-g');
  select balance into v_balance from public.loyalty_accounts where customer_id = v_asha;
  if v_balance <> 3 then raise exception 'balance after refund is %, expected 3', v_balance; end if;
  if (select count(*) from public.loyalty_transactions where order_id = v_g and kind = 'reversal') <> 1 then
    raise exception 'reversal not recorded once';
  end if;

  -- reconciliation agrees with the ledger
  v_rec := public.crm_reconcile(v_owner, v_biz);
  if not (v_rec ->> 'ok')::boolean then raise exception 'reconciliation disagrees: %', v_rec; end if;

  -- a balance edited outside the ledger is detected, then restored
  update public.loyalty_accounts set balance = balance + 5 where customer_id = v_asha;
  v_rec := public.crm_reconcile(v_owner, v_biz);
  if (v_rec ->> 'balance_mismatches')::integer <> 1 or (v_rec ->> 'ok')::boolean then
    raise exception 'reconciliation missed an edited balance: %', v_rec;
  end if;
  update public.loyalty_accounts set balance = balance - 5 where customer_id = v_asha;
  v_rec := public.crm_reconcile(v_owner, v_biz);
  if not (v_rec ->> 'ok')::boolean then raise exception 'reconciliation still failing after restore: %', v_rec; end if;

  -- the ledger is append-only, even to a superuser editing rows directly
  begin
    update public.loyalty_transactions set reason = 'edited' where order_id = v_g;
    raise exception 'ledger row was editable';
  exception when others then
    if sqlerrm not like '%append-only%' then raise; end if;
  end;

  -- row-level security: a kitchen user sees no customers; the accountant reads them
  set role authenticated;
  set request.jwt.claims = '{"sub": "f1111111-0000-0000-0000-000000000020", "role": "authenticated"}';
  select count(*) into v_n_rls from public.customers;
  reset role;
  if v_n_rls <> 0 then raise exception 'kitchen can read customers (%)', v_n_rls; end if;

  set role authenticated;
  set request.jwt.claims = '{"sub": "f1111111-0000-0000-0000-000000000011", "role": "authenticated"}';
  select count(*) into v_n_rls from public.customers;
  reset role;
  if v_n_rls = 0 then raise exception 'accountant cannot read customers'; end if;

  -- clients cannot write customers directly
  set role authenticated;
  set request.jwt.claims = '{"sub": "f1111111-0000-0000-0000-000000000010", "role": "authenticated"}';
  begin
    insert into public.customers (business_id, name, phone, phone_key)
    values (v_biz, 'Direct', '9000000099', '9000000099');
    reset role;
    raise exception 'cashier inserted a customer directly';
  exception when insufficient_privilege then
    reset role;
  end;

  insert into p15_refs values ('g_pay', v_pay::text);
  raise notice 'OK: completion consumes the voucher; a refund claws back 1 point; reconciliation detects an edited balance; the ledger is append-only; RLS hides customers from kitchen';
end $$;

\echo '── P15.10: customers, coupons and rewards are isolated by business; phones are unique per business'
do $$
declare
  v_biz uuid := 'cccccccc-0000-0000-0000-000000000001';
  v_owner uuid := 'aaaaaaaa-0000-0000-0000-000000000001';
  v_outlet uuid := pg_temp.ref('outlet');
  v_thali uuid := pg_temp.ref('thali');
  v_asha uuid := pg_temp.ref('asha');
  v_other uuid;
  v_other_asha uuid;
  v_coupon_b uuid;
  v_reward_b uuid;
  v_open uuid;
  v_res text;
  v_n_visible integer;
begin
  -- a second business, created the way the app creates one
  insert into public.businesses (name, slug, currency_code) values ('P15 Other', 'p15-other', 'INR')
  returning id into v_other;

  -- phones are unique per business, not globally: the same number may exist in both
  insert into public.customers (business_id, name, phone, phone_key)
  values (v_other, 'Asha elsewhere', '9876543210', '9876543210')
  returning id into v_other_asha;
  if v_other_asha = v_asha then raise exception 'two businesses share one customer'; end if;

  -- an order in A with Asha's number links to A's Asha, never to the other business's
  v_open := public.create_pos_order(v_owner, jsonb_build_object(
    'outlet_id', v_outlet, 'client_ref', 'p15-order-10', 'order_type', 'takeaway',
    'customer_phone', '9876543210', 'customer_name', 'Asha',
    'discount', jsonb_build_object('type', 'none'),
    'items', pg_temp.items(v_thali, 1)));
  if (select customer_id from public.orders where id = v_open) is distinct from v_asha then
    raise exception 'order in A linked to another business customer';
  end if;

  -- the owner of A cannot create or edit a customer in the other business
  v_res := pg_temp.try(format('select public.customer_save(%L, %L, null, %L, %L, null, null)',
    v_owner, v_other, 'Intruder', '9000000077'));
  if v_res not like 'err:%' then raise exception 'owner of A managed a customer in another business'; end if;
  v_res := pg_temp.try(format('select public.customer_save(%L, %L, %L, %L, %L, null, null)',
    v_owner, v_biz, v_other_asha, 'Renamed', '9876543210'));
  if v_res not like 'err:%' then raise exception 'customer id from another business was edited'; end if;

  -- a coupon that exists only in the other business cannot be applied to an order in A
  insert into public.coupons (business_id, code, name, discount_type, discount_value, min_subtotal_minor, active)
  values (v_other, 'P15BIZB', 'Other shop', 'percent', 20, 0, true)
  returning id into v_coupon_b;
  v_res := pg_temp.try(format('select public.order_apply_coupon(%L, %L, %L)', v_owner, v_open, 'P15BIZB'));
  if v_res not like 'err:%does not exist%' then raise exception 'coupon from another business applied: %', v_res; end if;

  -- a reward of the other business cannot be issued to Asha in A
  insert into public.loyalty_rewards (business_id, name, points_cost, discount_type, discount_value, active)
  values (v_other, 'Other free tea', 1, 'flat', 1000, true)
  returning id into v_reward_b;
  v_res := pg_temp.try(format('select public.reward_redeem(%L, %L, %L, %L, %L)',
    v_owner, v_biz, v_asha, v_reward_b, 'p15-redeem-x1'));
  if v_res not like 'err:%not available%' then raise exception 'reward from another business issued: %', v_res; end if;

  -- row-level security: the owner of A sees A's customers and nothing from the other business
  set role authenticated;
  set request.jwt.claims = '{"sub": "aaaaaaaa-0000-0000-0000-000000000001", "role": "authenticated"}';
  select count(*) into v_n_visible from public.customers where business_id = v_other;
  if v_n_visible <> 0 then reset role; raise exception 'owner of A can read % customers of another business', v_n_visible; end if;
  select count(*) into v_n_visible from public.coupons where business_id = v_other;
  if v_n_visible <> 0 then reset role; raise exception 'owner of A can read % coupons of another business', v_n_visible; end if;
  select count(*) into v_n_visible from public.customers where business_id = v_biz;
  if v_n_visible = 0 then reset role; raise exception 'owner of A cannot read its own customers'; end if;
  reset role;

  raise notice 'OK: phones are unique per business; orders link within their business; another business cannot write, apply or redeem; RLS hides foreign customers and coupons';
end $$;
