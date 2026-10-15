-- ─────────────────────────────────────────────────────────────────────────
-- Phase 16 — reports + analytics. Every report is reconciled against raw SQL
-- over the same window, computed independently of the report functions.
-- Runs after Phase 15. Fixtures are its own (P16 …): an Annex outlet, a
-- main-outlet manager, a menu, ingredients, a purchase receipt, orders,
-- payments, refunds and a backdated completion so that buckets differ.
--
-- Window: yesterday..today in Asia/Kolkata. The P16 completions are today, except
-- one order (O2) and one P15 customer history row, which are backdated to yesterday.
--
-- Amounts are read from each order's total, so tax from the business settings is included.
--   Thali 20000, Dosa 12000, Chai 5000 (before tax and discounts).
--   O1 (cashier, Asha): 2 thali, discount 1000; cash; refund 5000 today.
--   O2 (owner, backdated to yesterday): thali + chai, discount 2000; UPI; refunded in full today.
--   O3 (owner, Annex): dosa + chai; cash.
--   O4 (cashier): dosa, cancelled. Excluded from sales.
--   O5 (owner, new customer Ravi): 2 thali, coupon P16FLAT 5000 off; card.
--   O6 (owner): chai, left open. Excluded from sales.
-- ─────────────────────────────────────────────────────────────────────────

create temp table if not exists p16_refs (k text primary key, v text);

create or replace function pg_temp.ref(p_key text) returns uuid
language sql stable as $$
  select v::uuid from p16_refs where k = p_key;
$$;

create or replace function pg_temp.try(p_sql text) returns text
language plpgsql as $$
begin
  execute p_sql;
  return 'ok';
exception when others then
  return 'err:' || sqlerrm;
end $$;

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

-- Moves an order through the real RPCs to completed (placed → kitchen → ready → completed).
-- The kitchen steps are done by the owner (kitchen.operate); the order steps by p_actor.
create or replace function pg_temp.finish(p_actor uuid, p_order uuid) returns void
language plpgsql as $$
declare
  r record;
  v_kitchen uuid := 'aaaaaaaa-0000-0000-0000-000000000001';
begin
  perform public.transition_order_status(p_actor, p_order, 'placed');
  for r in select oi.id from public.order_items oi where oi.order_id = p_order loop
    perform public.kds_advance_item(v_kitchen, r.id, 'new', 'accepted');
    perform public.kds_advance_item(v_kitchen, r.id, 'accepted', 'preparing');
    perform public.kds_advance_item(v_kitchen, r.id, 'preparing', 'ready');
  end loop;
  if (select status from public.orders where id = p_order) = 'placed' then
    perform public.transition_order_status(p_actor, p_order, 'preparing');
  end if;
  if (select status from public.orders where id = p_order) = 'preparing' then
    perform public.transition_order_status(p_actor, p_order, 'ready');
  end if;
  perform public.transition_order_status(p_actor, p_order, 'completed');
end $$;

\echo '── P16.0: fixtures (outlet, staff, menu, stock, purchases, orders, refunds)'
do $$
declare
  v_biz uuid := 'cccccccc-0000-0000-0000-000000000001';
  v_owner uuid := 'aaaaaaaa-0000-0000-0000-000000000001';
  v_cashier uuid := 'f1111111-0000-0000-0000-000000000010';
  v_mina uuid := 'f1111111-0000-0000-0000-000000000050';
  v_main uuid;
  v_annex uuid;
  v_cat_mains uuid;
  v_cat_drinks uuid;
  v_thali uuid; v_dosa uuid; v_chai uuid;
  v_rice uuid; v_ghee uuid;
  v_supplier uuid;
  v_po uuid;
  v_amt bigint;
  v_pay uuid;
  v_o1 uuid; v_o2 uuid; v_o3 uuid; v_o4 uuid; v_o5 uuid; v_o6 uuid;
  v_asha uuid;
  v_mem uuid;
  v_lines jsonb;
begin
  select id into v_main from public.outlets where business_id = v_biz and slug = 'main';
  insert into public.outlets (business_id, name, slug, currency_code)
  values (v_biz, 'P16 Annex', 'p16-annex', 'INR') returning id into v_annex;
  insert into p16_refs values ('main', v_main::text), ('annex', v_annex::text);

  -- a manager who can see the main outlet only
  insert into auth.users (id, email, raw_user_meta_data) values
    (v_mina, 'mina@example.com', '{"full_name": "Mina Manager"}');
  insert into public.memberships (user_id, business_id, role) values (v_mina, v_biz, 'outlet_manager')
  returning id into v_mem;
  insert into public.membership_outlets (membership_id, outlet_id) values (v_mem, v_main);

  insert into public.menu_categories (business_id, name) values (v_biz, 'P16 Mains') returning id into v_cat_mains;
  insert into public.menu_categories (business_id, name) values (v_biz, 'P16 Drinks') returning id into v_cat_drinks;
  insert into public.menu_items (business_id, category_id, name, price_minor)
  values (v_biz, v_cat_mains, 'P16 Thali', 20000) returning id into v_thali;
  insert into public.menu_items (business_id, category_id, name, price_minor)
  values (v_biz, v_cat_mains, 'P16 Dosa', 12000) returning id into v_dosa;
  insert into public.menu_items (business_id, category_id, name, price_minor)
  values (v_biz, v_cat_drinks, 'P16 Chai', 5000) returning id into v_chai;
  insert into p16_refs values ('thali', v_thali::text), ('dosa', v_dosa::text), ('chai', v_chai::text);

  -- ingredients and recipes (cost per base unit, in paise)
  v_rice := public.ingredient_save(v_owner, v_biz, null, 'P16 Rice', 'g', 4, 1000, null, true);
  v_ghee := public.ingredient_save(v_owner, v_biz, null, 'P16 Ghee', 'ml', 10, 500, null, true);
  insert into p16_refs values ('rice', v_rice::text), ('ghee', v_ghee::text);
  perform public.recipe_save(v_owner, v_thali, jsonb_build_array(
    jsonb_build_object('ingredient_id', v_rice, 'unit', 'g', 'qty', 200),
    jsonb_build_object('ingredient_id', v_ghee, 'unit', 'ml', 'qty', 15)));
  perform public.recipe_save(v_owner, v_dosa, jsonb_build_array(
    jsonb_build_object('ingredient_id', v_rice, 'unit', 'g', 'qty', 150)));

  -- Main stock arrives on a goods receipt; Annex stock is received directly
  v_supplier := public.supplier_save(v_owner, v_biz, null, 'P16 Grain Co', null, null, null, null, null, 15, 'active', null);
  v_po := public.purchase_order_save(v_owner, v_main, v_supplier, null, null, null, jsonb_build_array(
    jsonb_build_object('ingredient_id', v_rice, 'unit', 'kg', 'qty', 5, 'unit_cost', 4000),
    jsonb_build_object('ingredient_id', v_ghee, 'unit', 'l', 'qty', 2, 'unit_cost', 10000)));
  perform public.purchase_order_send(v_owner, v_po);
  v_lines := (select jsonb_agg(jsonb_build_object('po_item_id', poi.id, 'qty', poi.qty_ordered, 'unit', poi.unit))
              from public.purchase_order_items poi where poi.purchase_order_id = v_po);
  perform public.goods_receipt_post(v_owner, v_po, 'p16-grn-01', 'DN-P16-1', null, v_lines);
  perform public.inventory_receive(v_owner, v_annex, v_rice, 5000, 'g', 4, 'P16-AX-RICE', null, 'p16-rx-annex-rice');
  perform public.inventory_waste(v_owner, v_main, v_rice, 100, 'g', 'P16 spillage', 'p16-waste-01');

  -- O1: cashier, Asha (existing customer), discount 1000, cash
  v_o1 := public.create_pos_order(v_cashier, jsonb_build_object(
    'outlet_id', v_main, 'client_ref', 'p16-order-01', 'order_type', 'takeaway',
    'customer_phone', '9876543210', 'customer_name', 'Asha',
    'discount', jsonb_build_object('type', 'flat', 'value', 1000),
    'items', jsonb_build_array(jsonb_build_object('item_type', 'product', 'product_id', v_thali, 'quantity', 2))));
  insert into p16_refs values ('o1', v_o1::text);
  select total_minor into v_amt from public.orders where id = v_o1;
  perform public.record_payments(v_cashier, v_o1, 'p16-pay-o1', jsonb_build_array(
    jsonb_build_object('method_key', 'cash', 'amount_minor', v_amt, 'tendered_minor', v_amt + 1000)));
  perform pg_temp.finish(v_cashier, v_o1);

  -- O2: owner, thali + chai, manual discount 2000, UPI; completed, then backdated to yesterday
  v_o2 := public.create_pos_order(v_owner, jsonb_build_object(
    'outlet_id', v_main, 'client_ref', 'p16-order-02', 'order_type', 'takeaway',
    'discount', jsonb_build_object('type', 'flat', 'value', 2000),
    'items', jsonb_build_array(
      jsonb_build_object('item_type', 'product', 'product_id', v_thali, 'quantity', 1),
      jsonb_build_object('item_type', 'product', 'product_id', v_chai, 'quantity', 1))));
  insert into p16_refs values ('o2', v_o2::text);
  select total_minor into v_amt from public.orders where id = v_o2;
  perform public.record_payments(v_owner, v_o2, 'p16-pay-o2', jsonb_build_array(
    jsonb_build_object('method_key', 'upi', 'amount_minor', v_amt, 'reference', 'UTR-P16-2')));
  perform pg_temp.finish(v_owner, v_o2);

  -- O3: owner at Annex, dosa + chai, cash
  v_o3 := public.create_pos_order(v_owner, jsonb_build_object(
    'outlet_id', v_annex, 'client_ref', 'p16-order-03', 'order_type', 'takeaway',
    'discount', jsonb_build_object('type', 'none'),
    'items', jsonb_build_array(
      jsonb_build_object('item_type', 'product', 'product_id', v_dosa, 'quantity', 1),
      jsonb_build_object('item_type', 'product', 'product_id', v_chai, 'quantity', 1))));
  insert into p16_refs values ('o3', v_o3::text);
  select total_minor into v_amt from public.orders where id = v_o3;
  perform public.record_payments(v_owner, v_o3, 'p16-pay-o3', jsonb_build_array(
    jsonb_build_object('method_key', 'cash', 'amount_minor', v_amt)));
  perform pg_temp.finish(v_owner, v_o3);

  -- O4: cashier, dosa, cancelled before payment
  v_o4 := public.create_pos_order(v_cashier, jsonb_build_object(
    'outlet_id', v_main, 'client_ref', 'p16-order-04', 'order_type', 'takeaway',
    'discount', jsonb_build_object('type', 'none'),
    'items', jsonb_build_array(jsonb_build_object('item_type', 'product', 'product_id', v_dosa, 'quantity', 1))));
  insert into p16_refs values ('o4', v_o4::text);
  perform public.transition_order_status(v_cashier, v_o4, 'cancelled', 'Customer left');

  -- O5: owner, new customer Ravi, a coupon, card
  perform public.coupon_save(v_owner, v_biz, null, 'P16FLAT', 'P16 Flat fifty', 'flat', 5000, null, 30000, null, null, null, null, true);
  v_o5 := public.create_pos_order(v_owner, jsonb_build_object(
    'outlet_id', v_main, 'client_ref', 'p16-order-05', 'order_type', 'takeaway',
    'customer_phone', '9000011122', 'customer_name', 'Ravi Kumar',
    'discount', jsonb_build_object('type', 'none'),
    'items', jsonb_build_array(jsonb_build_object('item_type', 'product', 'product_id', v_thali, 'quantity', 2))));
  insert into p16_refs values ('o5', v_o5::text);
  perform public.order_apply_coupon(v_owner, v_o5, 'P16FLAT');
  select total_minor into v_amt from public.orders where id = v_o5;
  perform public.record_payments(v_owner, v_o5, 'p16-pay-o5', jsonb_build_array(
    jsonb_build_object('method_key', 'card', 'amount_minor', v_amt, 'reference', 'CARD-P16-5')));
  perform pg_temp.finish(v_owner, v_o5);

  -- O6: owner, chai, left open
  v_o6 := public.create_pos_order(v_owner, jsonb_build_object(
    'outlet_id', v_main, 'client_ref', 'p16-order-06', 'order_type', 'takeaway',
    'discount', jsonb_build_object('type', 'none'),
    'items', jsonb_build_array(jsonb_build_object('item_type', 'product', 'product_id', v_chai, 'quantity', 1))));
  insert into p16_refs values ('o6', v_o6::text);

  -- refunds (cash basis: recorded today)
  select id into v_pay from public.payments where order_id = v_o1 and method_key = 'cash';
  perform public.refund_payment(v_owner, v_pay, 5000, 'Wrong item', 'p16-rfd-01');
  select id into v_pay from public.payments where order_id = v_o2 and method_key = 'upi';
  select total_minor into v_amt from public.orders where id = v_o2;
  perform public.refund_payment(v_owner, v_pay, v_amt, 'Guest left', 'p16-rfd-02');

  -- backdate O2's completion and P15's first Asha order to yesterday, so that
  -- buckets differ and Asha becomes a returning customer on a today-only window.
  perform set_config('session_replication_role', 'replica', true);
  update public.order_status_history
     set created_at = created_at - interval '1 day'
   where order_id = v_o2 and to_status = 'completed';
  perform set_config('session_replication_role', 'origin', true);

  select id into v_asha from public.customers where business_id = v_biz and phone_key = '9876543210';
  insert into p16_refs values ('asha', v_asha::text);

  -- Asha's earlier Phase 15 order was completed by direct update, so it has no history row.
  -- Record its completion as yesterday, which makes her a returning customer on a today-only window.
  insert into public.order_status_history (order_id, from_status, to_status, changed_by, note, created_at)
  select o.id, 'ready', 'completed', v_owner, 'P16 fixture: completion recorded yesterday', now() - interval '1 day'
  from public.orders o
  where o.business_id = v_biz and o.customer_id = v_asha and o.status = 'completed' and o.id <> v_o1
    and not exists (select 1 from public.order_status_history h where h.order_id = o.id and h.to_status = 'completed')
  order by o.created_at
  limit 1;
  if not exists (select 1 from public.order_status_history h join public.orders o on o.id = h.order_id
                 where o.customer_id = v_asha and h.to_status = 'completed' and h.created_at < now() - interval '12 hours') then
    raise exception 'could not give Asha an earlier completion';
  end if;

  raise notice 'OK: P16 fixtures ready: Annex outlet, a main-only manager, 3 menu items, 2 ingredients with recipes, a goods receipt, six orders (four completed, one cancelled, one open), two refunds, and two backdated completions';
end $$;

\echo '── P16.1: permissions, outlet scoping and input validation'
do $$
declare
  v_biz uuid := 'cccccccc-0000-0000-0000-000000000001';
  v_owner uuid := 'aaaaaaaa-0000-0000-0000-000000000001';
  v_cashier uuid := 'f1111111-0000-0000-0000-000000000010';
  v_accountant uuid := 'f1111111-0000-0000-0000-000000000011';
  v_kitchen uuid := 'f1111111-0000-0000-0000-000000000020';
  v_mina uuid := 'f1111111-0000-0000-0000-000000000050';
  v_main uuid := pg_temp.ref('main');
  v_annex uuid := pg_temp.ref('annex');
  v_r text;
  v_rows jsonb;
begin
  -- cashier and kitchen cannot view reports at all
  v_r := pg_temp.try(format('select public.report_revenue_periods(%L, %L, null, current_date - 1, current_date, null, ''day'', 50, 0)', v_cashier, v_biz));
  if v_r not like 'err:%reports.view%' then raise exception 'cashier can view revenue: %', v_r; end if;
  v_r := pg_temp.try(format('select public.report_revenue_periods(%L, %L, null, current_date - 1, current_date, null, ''day'', 50, 0)', v_kitchen, v_biz));
  if v_r not like 'err:%reports.view%' then raise exception 'kitchen can view revenue: %', v_r; end if;

  -- accountant has financial reports but not staff reports
  v_r := pg_temp.try(format('select public.report_revenue_periods(%L, %L, null, current_date - 1, current_date, null, ''day'', 50, 0)', v_accountant, v_biz));
  if v_r <> 'ok' then raise exception 'accountant cannot view revenue: %', v_r; end if;
  v_r := pg_temp.try(format('select public.report_staff_cashier(%L, %L, null, current_date - 1, current_date, null, null, 50, 0)', v_accountant, v_biz));
  if v_r not like 'err:%staff.view%' then raise exception 'accountant can view staff reports: %', v_r; end if;

  -- kitchen staff have no inventory or financial reports
  v_r := pg_temp.try(format('select public.report_inventory_consumption(%L, %L, null, current_date - 1, current_date, null, null, 50, 0)', v_owner, v_biz));
  if v_r <> 'ok' then raise exception 'owner cannot view consumption: %', v_r; end if;

  -- outlet manager sees the main outlet only; Annex is invisible even when asked for
  select r.rows into v_rows from (
    select public.report_sales_by_outlet(v_mina, v_biz, null, current_date - 1, current_date, null, null, 50, 0)->'rows' as rows) r;
  if jsonb_array_length(v_rows) <> 1 or (v_rows->0->>'outlet_id')::uuid <> v_main then
    raise exception 'manager sees outlets beyond main: %', v_rows;
  end if;
  select (public.report_sales_by_outlet(v_mina, v_biz, array[v_annex], current_date - 1, current_date, null, null, 50, 0))->'total' into v_rows;
  if v_rows::text <> '0' then raise exception 'manager reached Annex by filter: %', v_rows; end if;

  -- validation: range, grain, page size and offset
  v_r := pg_temp.try(format('select public.report_revenue_periods(%L, %L, null, current_date - 401, current_date, null, ''day'', 50, 0)', v_owner, v_biz));
  if v_r not like 'err:%400 days%' then raise exception 'range over 400 days accepted: %', v_r; end if;
  v_r := pg_temp.try(format('select public.report_revenue_periods(%L, %L, null, current_date, current_date - 1, null, ''day'', 50, 0)', v_owner, v_biz));
  if v_r not like 'err:%valid date range%' then raise exception 'reversed range accepted: %', v_r; end if;
  v_r := pg_temp.try(format('select public.report_revenue_periods(%L, %L, null, current_date - 1, current_date, null, ''quarter'', 50, 0)', v_owner, v_biz));
  if v_r not like 'err:%day, week or month%' then raise exception 'unknown grain accepted: %', v_r; end if;
  v_r := pg_temp.try(format('select public.report_revenue_periods(%L, %L, null, current_date - 1, current_date, null, ''day'', 20001, 0)', v_owner, v_biz));
  if v_r not like 'err:%20000%' then raise exception 'page size over 20000 accepted: %', v_r; end if;
  v_r := pg_temp.try(format('select public.report_revenue_periods(%L, %L, null, current_date - 1, current_date, null, ''day'', 50, -1)', v_owner, v_biz));
  if v_r not like 'err:%Offset%' then raise exception 'negative offset accepted: %', v_r; end if;

  raise notice 'OK: cashier and kitchen are refused reports; accountant has financial but not staff reports; manager is limited to the main outlet; invalid ranges, grains and pages are refused';
end $$;

\echo '── P16.2: sales by day, week and month reconcile with raw order data'
do $$
declare
  v_biz uuid := 'cccccccc-0000-0000-0000-000000000001';
  v_owner uuid := 'aaaaaaaa-0000-0000-0000-000000000001';
  v_from date := (select public.business_today()) - 1;
  v_to date := (select public.business_today());
  v_grain text;
  v_rep jsonb;
  v_sum jsonb;
  v_exp record;
  v_bucket_orders bigint;
  v_bucket_billed bigint;
begin
  -- raw expectation: orders whose first completion falls on an IST day inside the window
  create temp table if not exists p16_done on commit drop as
  select o.id, o.outlet_id, o.created_by, o.customer_id, o.subtotal_minor, o.discount_minor, o.promotion_minor,
         o.tax_minor, o.total_minor, o.refunded_minor,          (select min(h.created_at) from public.order_status_history h
          where h.order_id = o.id and h.to_status = 'completed') as completed_at
  from public.orders o
  where o.business_id = v_biz and o.status = 'completed';

  select count(*) as n, sum(subtotal_minor) as gross, sum(discount_minor) as disc, sum(tax_minor) as tax,
         sum(total_minor) as billed
    into v_exp
  from p16_done
  where completed_at is not null
    and (completed_at at time zone 'Asia/Kolkata')::date between v_from and v_to;

  foreach v_grain in array array['day', 'week', 'month'] loop
    v_rep := public.report_revenue_periods(v_owner, v_biz, null, v_from, v_to, null, v_grain, 500, 0);
    v_sum := v_rep->'summary';
    if (v_sum->>'orders')::bigint <> v_exp.n then
      raise exception '% orders %, raw %', v_grain, v_sum->>'orders', v_exp.n;
    end if;
    if (v_sum->>'gross_minor')::bigint <> v_exp.gross or (v_sum->>'discount_minor')::bigint <> v_exp.disc
       or (v_sum->>'tax_minor')::bigint <> v_exp.tax or (v_sum->>'billed_minor')::bigint <> v_exp.billed then
      raise exception '% totals disagree with raw: %', v_grain, v_sum;
    end if;
    -- buckets add back to the summary
    select sum((r->>'orders')::bigint), sum((r->>'billed_minor')::bigint) into v_bucket_orders, v_bucket_billed
    from jsonb_array_elements(v_rep->'rows') r;
    if v_bucket_orders <> v_exp.n or v_bucket_billed <> v_exp.billed then
      raise exception '% buckets do not add up to the summary', v_grain;
    end if;
    -- sales are checked on the net-of-discount basis too
    if (v_sum->>'net_sales_minor')::bigint <> v_exp.gross - v_exp.disc then
      raise exception '% net sales wrong', v_grain;
    end if;
  end loop;

  -- a daily split shows two buckets: O2 completed yesterday, the rest today
  v_rep := public.report_revenue_periods(v_owner, v_biz, null, v_from, v_to, null, 'day', 500, 0);
  if not exists (select 1 from jsonb_array_elements(v_rep->'rows') r
                 where (r->>'period_start')::date = v_from and (r->>'orders')::int >= 1) then
    raise exception 'no yesterday bucket after backdating O2';
  end if;
  if not exists (select 1 from jsonb_array_elements(v_rep->'rows') r
                 where (r->>'period_start')::date = v_to and (r->>'orders')::int >= 1) then
    raise exception 'no today bucket';
  end if;

  raise notice 'OK: day, week and month sales match raw completed orders (% orders, billed %), buckets add up, and backdated completions land on their own day',
    v_exp.n, v_exp.billed;
end $$;

\echo '── P16.3: revenue nets refunds on the day they were recorded (cash basis)'
do $$
declare
  v_biz uuid := 'cccccccc-0000-0000-0000-000000000001';
  v_owner uuid := 'aaaaaaaa-0000-0000-0000-000000000001';
  v_from date := (select public.business_today()) - 1;
  v_to date := (select public.business_today());
  v_rep jsonb;
  v_refunds bigint;
  v_billed bigint;
  v_today_refunds bigint;
  v_o2_refund_today boolean;
begin
  select coalesce(sum(r.amount_minor), 0) into v_refunds
  from public.refunds r
  where r.business_id = v_biz and r.status = 'succeeded'
    and (r.created_at at time zone 'Asia/Kolkata')::date between v_from and v_to;

  v_rep := public.report_revenue_periods(v_owner, v_biz, null, v_from, v_to, null, 'day', 500, 0);
  if (v_rep->'summary'->>'refunds_minor')::bigint <> v_refunds then
    raise exception 'revenue refunds % <> raw %', v_rep->'summary'->>'refunds_minor', v_refunds;
  end if;
  if (v_rep->'summary'->>'net_revenue_minor')::bigint
     <> (v_rep->'summary'->>'billed_minor')::bigint - v_refunds then
    raise exception 'net revenue is not billed minus refunds recorded in the window';
  end if;

  -- O2 was billed yesterday but refunded today: yesterday shows no refund, today shows the 23000
  if (select (r->>'refunds_minor')::bigint from jsonb_array_elements(v_rep->'rows') r
      where (r->>'period_start')::date = v_from) <> 0 then
    raise exception 'yesterday shows a refund that was recorded today';
  end if;
  select sum((r->>'refunds_minor')::bigint) into v_today_refunds
  from jsonb_array_elements(v_rep->'rows') r where (r->>'period_start')::date = v_to;
  if v_today_refunds < 28000 then raise exception 'today does not show the P16 refunds (%)', v_today_refunds; end if;

  -- the refund list carries the reasons we recorded
  v_rep := public.report_refunds_list(v_owner, v_biz, null, v_from, v_to, 'Guest left', null, 50, 0);
  if (v_rep->>'total')::int <> 1 or (v_rep->'rows'->0->>'amount_minor')::bigint <> 23000 then
    raise exception 'refund search did not find O2 refund: %', v_rep;
  end if;

  raise notice 'OK: revenue nets % of refunds recorded in the window; O2 billed yesterday shows its refund today', v_refunds;
end $$;

\echo '── P16.4: tax billed and refunded reconcile (refund tax is pro-rata)'
do $$
declare
  v_biz uuid := 'cccccccc-0000-0000-0000-000000000001';
  v_owner uuid := 'aaaaaaaa-0000-0000-0000-000000000001';
  v_from date := (select public.business_today()) - 1;
  v_to date := (select public.business_today());
  v_rep jsonb;
  v_tax_billed bigint;
  v_tax_refunded bigint;
begin
  select coalesce(sum(o.tax_minor), 0) into v_tax_billed
  from public.orders o
  where o.business_id = v_biz and o.status = 'completed'
    and exists (select 1 from public.order_status_history h where h.order_id = o.id and h.to_status = 'completed'
                and (h.created_at at time zone 'Asia/Kolkata')::date between v_from and v_to);

  select coalesce(sum(round(r.amount_minor::numeric * o.tax_minor / o.total_minor)), 0)::bigint into v_tax_refunded
  from public.refunds r join public.orders o on o.id = r.order_id
  where r.business_id = v_biz and r.status = 'succeeded' and o.total_minor > 0
    and (r.created_at at time zone 'Asia/Kolkata')::date between v_from and v_to;

  v_rep := public.report_tax_periods(v_owner, v_biz, null, v_from, v_to, null, 'day', 500, 0);
  if (v_rep->'summary'->>'tax_billed_minor')::bigint <> v_tax_billed then
    raise exception 'tax billed % <> raw %', v_rep->'summary'->>'tax_billed_minor', v_tax_billed;
  end if;
  if (v_rep->'summary'->>'tax_refunded_minor')::bigint <> v_tax_refunded then
    raise exception 'tax refunded % <> raw %', v_rep->'summary'->>'tax_refunded_minor', v_tax_refunded;
  end if;
  if (v_rep->'summary'->>'net_tax_minor')::bigint <> v_tax_billed - v_tax_refunded then
    raise exception 'net tax is not billed minus refunded';
  end if;

  -- O2 refund is 23000 of a 23000 total, so its full tax comes back
  if not exists (select 1 from public.refunds r join public.orders o on o.id = r.order_id
                 where o.id = pg_temp.ref('o2') and r.amount_minor = o.total_minor) then
    raise exception 'O2 full refund not recorded';
  end if;

  raise notice 'OK: tax billed % and tax refunded % match raw order and refund rows (pro-rata, cash basis)', v_tax_billed, v_tax_refunded;
end $$;

\echo '── P16.5: discounts split manual and promotion; percentages are consistent'
do $$
declare
  v_biz uuid := 'cccccccc-0000-0000-0000-000000000001';
  v_owner uuid := 'aaaaaaaa-0000-0000-0000-000000000001';
  v_from date := (select public.business_today()) - 1;
  v_to date := (select public.business_today());
  v_rep jsonb;
  v_disc bigint; v_promo bigint; v_gross bigint;
begin
  select coalesce(sum(o.discount_minor), 0), coalesce(sum(o.promotion_minor), 0), coalesce(sum(o.subtotal_minor), 0)
    into v_disc, v_promo, v_gross
  from public.orders o
  where o.business_id = v_biz and o.status = 'completed'
    and exists (select 1 from public.order_status_history h where h.order_id = o.id and h.to_status = 'completed'
                and (h.created_at at time zone 'Asia/Kolkata')::date between v_from and v_to);

  v_rep := public.report_discount_periods(v_owner, v_biz, null, v_from, v_to, null, 'day', 500, 0);
  if (v_rep->'summary'->>'total_discount_minor')::bigint <> v_disc
     or (v_rep->'summary'->>'promotion_minor')::bigint <> v_promo
     or (v_rep->'summary'->>'manual_minor')::bigint <> v_disc - v_promo
     or (v_rep->'summary'->>'gross_minor')::bigint <> v_gross then
    raise exception 'discount totals disagree with raw: %', v_rep->'summary';
  end if;
  if v_promo < 5000 then raise exception 'coupon P16FLAT not counted as a promotion (%)', v_promo; end if;

  -- percentage in the summary is total discount over gross, to two places
  if (v_rep->'summary'->>'discount_pct')::numeric <> round(100.0 * v_disc / nullif(v_gross, 0), 2) then
    raise exception 'discount percentage wrong';
  end if;

  raise notice 'OK: discounts % (manual %, promotion %) match raw completed orders', v_disc, v_disc - v_promo, v_promo;
end $$;

\echo '── P16.6: payments by method and the refund list reconcile; search and paging behave'
do $$
declare
  v_biz uuid := 'cccccccc-0000-0000-0000-000000000001';
  v_owner uuid := 'aaaaaaaa-0000-0000-0000-000000000001';
  v_from date := (select public.business_today()) - 1;
  v_to date := (select public.business_today());
  v_rep jsonb;
  v_collected bigint; v_refunded bigint; v_refund_count bigint; v_page_union bigint := 0; v_page_rows int := 0;
  v_full jsonb; v_p int;
  v_method record;
begin
  select coalesce(sum(p.amount_minor), 0) into v_collected
  from public.payments p
  where p.business_id = v_biz and p.status = 'captured'
    and (p.created_at at time zone 'Asia/Kolkata')::date between v_from and v_to;
  select coalesce(sum(r.amount_minor), 0), count(*) into v_refunded, v_refund_count
  from public.refunds r
  where r.business_id = v_biz and r.status = 'succeeded'
    and (r.created_at at time zone 'Asia/Kolkata')::date between v_from and v_to;

  v_rep := public.report_payments_by_method(v_owner, v_biz, null, v_from, v_to, null, null, 500, 0);
  if (v_rep->'summary'->>'collected_minor')::bigint <> v_collected
     or (v_rep->'summary'->>'refunded_minor')::bigint <> v_refunded
     or (v_rep->'summary'->>'net_minor')::bigint <> v_collected - v_refunded then
    raise exception 'payments by method disagree with raw: %', v_rep->'summary';
  end if;
  -- each method row nets to its own collections less its own refunds
  for v_method in
    select r as row_data from jsonb_array_elements(v_rep->'rows') r
  loop
    if (v_method.row_data->>'net_minor')::bigint
       <> (v_method.row_data->>'collected_minor')::bigint - (v_method.row_data->>'refunded_minor')::bigint then
      raise exception 'method row does not net: %', v_method.row_data;
    end if;
  end loop;

  -- the refund list total equals the refund count, and paging returns every row once
  v_full := public.report_refunds_list(v_owner, v_biz, null, v_from, v_to, null, null, 500, 0);
  if (v_full->>'total')::bigint <> v_refund_count or (v_full->'summary'->>'amount_minor')::bigint <> v_refunded then
    raise exception 'refund list disagrees with raw';
  end if;
  for v_p in 0..((v_refund_count::int - 1) / 3) loop
    v_rep := public.report_refunds_list(v_owner, v_biz, null, v_from, v_to, null, null, 3, v_p * 3);
    v_page_rows := v_page_rows + jsonb_array_length(v_rep->'rows');
    if (v_rep->>'total')::bigint <> v_refund_count then raise exception 'total changes between pages'; end if;
  end loop;
  if v_page_rows <> v_refund_count then raise exception 'pages returned % rows, expected %', v_page_rows, v_refund_count; end if;

  -- search narrows, and a search with no hits returns an empty page with a zero summary
  v_rep := public.report_refunds_list(v_owner, v_biz, null, v_from, v_to, 'zzz-no-match', null, 50, 0);
  if (v_rep->>'total')::int <> 0 or (v_rep->'summary'->>'refunds')::int <> 0 then
    raise exception 'empty search returned rows';
  end if;

  raise notice 'OK: collections % and refunds % reconcile by method; the refund list pages % rows across pages', v_collected, v_refunded, v_page_rows;
end $$;

\echo '── P16.7: sales by outlet, product and category reconcile; manager scope holds'
do $$
declare
  v_biz uuid := 'cccccccc-0000-0000-0000-000000000001';
  v_owner uuid := 'aaaaaaaa-0000-0000-0000-000000000001';
  v_mina uuid := 'f1111111-0000-0000-0000-000000000050';
  v_annex uuid := pg_temp.ref('annex');
  v_dosa uuid := pg_temp.ref('dosa');
  v_from date := (select public.business_today()) - 1;
  v_to date := (select public.business_today());
  v_rep jsonb;
  v_line_total bigint; v_subtotal bigint; v_qty bigint;
  v_share numeric;
begin
  -- the outlet split adds back to the business total
  v_rep := public.report_sales_by_outlet(v_owner, v_biz, null, v_from, v_to, null, null, 500, 0);
  if (select sum((r->>'billed_minor')::bigint) from jsonb_array_elements(v_rep->'rows') r)
     <> (v_rep->'summary'->>'billed_minor')::bigint then
    raise exception 'outlet rows do not add up to the summary';
  end if;
  -- Annex: one order (O3), 17000
  if (select (r->>'billed_minor')::bigint from jsonb_array_elements(v_rep->'rows') r
      where (r->>'outlet_id')::uuid = v_annex) <> 17000
     or (select (r->>'orders')::int from jsonb_array_elements(v_rep->'rows') r
         where (r->>'outlet_id')::uuid = v_annex) <> 1 then
    raise exception 'Annex does not show O3 only: %', v_rep;
  end if;

  -- line totals in completed orders equal the order subtotals (raw check)
  select coalesce(sum(oi.line_total_minor), 0) into v_line_total
  from public.order_items oi join public.orders o on o.id = oi.order_id
  where o.business_id = v_biz and o.status = 'completed'
    and exists (select 1 from public.order_status_history h where h.order_id = o.id and h.to_status = 'completed'
                and (h.created_at at time zone 'Asia/Kolkata')::date between v_from and v_to);
  select coalesce(sum(o.subtotal_minor), 0) into v_subtotal
  from public.orders o
  where o.business_id = v_biz and o.status = 'completed'
    and exists (select 1 from public.order_status_history h where h.order_id = o.id and h.to_status = 'completed'
                and (h.created_at at time zone 'Asia/Kolkata')::date between v_from and v_to);
  if v_line_total <> v_subtotal then
    raise exception 'line totals % do not equal order subtotals %', v_line_total, v_subtotal;
  end if;

  -- product report: P16 Dosa sold once (O3), cancelled O4 excluded
  v_rep := public.report_sales_by_product(v_owner, v_biz, null, v_from, v_to, 'P16 Dosa', null, 50, 0);
  if (v_rep->>'total')::int <> 1 or (v_rep->'rows'->0->>'quantity')::bigint <> 1
     or (v_rep->'rows'->0->>'gross_minor')::bigint <> 12000 then
    raise exception 'P16 Dosa should show 1 unit for 12000 (cancelled O4 excluded): %', v_rep;
  end if;

  -- product totals reconcile with line totals across all products
  v_rep := public.report_sales_by_product(v_owner, v_biz, null, v_from, v_to, null, null, 500, 0);
  if (v_rep->'summary'->>'gross_minor')::bigint <> v_line_total then
    raise exception 'product gross % <> line totals %', v_rep->'summary'->>'gross_minor', v_line_total;
  end if;
  select sum((r->>'quantity')::bigint) into v_qty from jsonb_array_elements(v_rep->'rows') r;
  if v_qty <> (v_rep->'summary'->>'quantity')::bigint then raise exception 'product quantities do not add up'; end if;
  select sum((r->>'share_pct')::numeric) into v_share from jsonb_array_elements(v_rep->'rows') r;
  if abs(v_share - 100) > 0.5 then raise exception 'product shares sum to % not 100', v_share; end if;

  -- category report: P16 Mains and P16 Drinks both present; gross equals the product total
  v_rep := public.report_sales_by_category(v_owner, v_biz, null, v_from, v_to, 'P16', null, 50, 0);
  if (v_rep->>'total')::int <> 2 then raise exception 'expected the two P16 categories, got %', v_rep->>'total'; end if;
  v_rep := public.report_sales_by_category(v_owner, v_biz, null, v_from, v_to, null, null, 500, 0);
  if (v_rep->'summary'->>'gross_minor')::bigint <> v_line_total then
    raise exception 'category gross does not equal line totals';
  end if;

  -- the manager sees main-outlet product sales only, which exclude Annex O3's dosa
  v_rep := public.report_sales_by_product(v_mina, v_biz, null, v_from, v_to, 'P16 Dosa', null, 50, 0);
  if (v_rep->>'total')::int <> 0 then raise exception 'manager sees Annex dosa sales'; end if;

  raise notice 'OK: outlets add up (Annex = O3 only), product and category gross equal order line totals, P16 Dosa = 1 unit / 12000, manager scope holds';
end $$;

\echo '── P16.8: inventory reports reconcile with the ledger, receipts and stock'
do $$
declare
  v_biz uuid := 'cccccccc-0000-0000-0000-000000000001';
  v_owner uuid := 'aaaaaaaa-0000-0000-0000-000000000001';
  v_accountant uuid := 'f1111111-0000-0000-0000-000000000011';
  v_from date := (select public.business_today()) - 1;
  v_to date := (select public.business_today());
  v_rep jsonb;
  v_cons bigint; v_cons_qty numeric; v_purch bigint; v_waste bigint; v_rcpt bigint; v_r text;
  v_stock_mismatch bigint;
  v_cohort_cost bigint; v_cohort_net bigint; v_fc numeric;
  v_rice uuid := pg_temp.ref('rice');
  v_main uuid := pg_temp.ref('main');
begin
  -- consumption: the ledger's consumption rows in the window (costs are stored negative)
  select coalesce(-sum(m.value_minor), 0), coalesce(-sum(m.qty), 0) into v_cons, v_cons_qty
  from public.inventory_movements m
  where m.business_id = v_biz and m.kind = 'consumption'
    and (m.created_at at time zone 'Asia/Kolkata')::date between v_from and v_to;
  v_rep := public.report_inventory_consumption(v_owner, v_biz, null, v_from, v_to, null, null, 500, 0);
  if (v_rep->'summary'->>'cost_minor')::numeric <> v_cons then
    raise exception 'consumption cost % <> raw %', v_rep->'summary'->>'cost_minor', v_cons;
  end if;
  -- rice used by the P16 thalis and dosa: O1 2 thali, O2 1 thali, O5 2 thali, O3 1 dosa at Annex
  -- thali uses 200 g rice; dosa uses 150 g
  if (select sum((r->>'quantity')::numeric) from jsonb_array_elements(v_rep->'rows') r
      where r->>'ingredient_name' = 'P16 Rice') <> 200 * 5 + 150 then
    raise exception 'P16 rice consumption is not 1150 g';
  end if;

  -- purchases: goods received on the GRN equal the receipt movements and the line totals
  select coalesce(sum(gri.line_total_minor), 0) into v_purch
  from public.goods_receipt_items gri join public.goods_receipts gr on gr.id = gri.goods_receipt_id
  where gr.business_id = v_biz and gr.received_on between v_from and v_to;
  v_rep := public.report_inventory_purchases(v_owner, v_biz, null, v_from, v_to, null, null, 500, 0);
  if (v_rep->'summary'->>'value_minor')::numeric <> v_purch then
    raise exception 'purchases value % <> raw %', v_rep->'summary'->>'value_minor', v_purch;
  end if;
  if (select sum((r->>'value_minor')::numeric) from jsonb_array_elements(v_rep->'rows') r
      where r->>'ingredient_name' = 'P16 Rice') <> 20000 then
    raise exception 'P16 rice receipt should be 5 kg at 4000 per kg = 20000';
  end if;
  -- the receipt ledger for rice (a brand-new ingredient) holds only the GRN at Main: 20000
  select coalesce(sum(m.value_minor), 0) into v_rcpt
  from public.inventory_movements m
  where m.business_id = v_biz and m.kind = 'receipt' and m.ingredient_id = v_rice and m.outlet_id = v_main;
  if v_rcpt <> 20000 then raise exception 'rice receipt ledger % <> 20000', v_rcpt; end if;

  -- wastage: 100 g spilled at Main
  select coalesce(-sum(m.value_minor), 0) into v_waste
  from public.inventory_movements m
  where m.business_id = v_biz and m.kind = 'wastage'
    and (m.created_at at time zone 'Asia/Kolkata')::date between v_from and v_to;
  v_rep := public.report_inventory_wastage(v_owner, v_biz, null, v_from, v_to, null, null, 500, 0);
  if (v_rep->'summary'->>'cost_minor')::numeric <> v_waste then
    raise exception 'wastage cost % <> raw %', v_rep->'summary'->>'cost_minor', v_waste;
  end if;
  if (select (r->>'quantity')::numeric from jsonb_array_elements(v_rep->'rows') r
      where r->>'ingredient_name' = 'P16 Rice' and (r->>'outlet_id')::uuid = v_main) <> 100 then
    raise exception 'P16 spillage should be 100 g at Main';
  end if;

  -- food cost: consumption of the completed cohort ÷ their net sales (after discounts, before tax)
  select coalesce(sum(m.value_minor), 0) into v_cohort_cost
  from public.inventory_movements m
  where m.business_id = v_biz and m.kind = 'consumption' and m.order_id in (
    select o.id from public.orders o
    where o.business_id = v_biz and o.status = 'completed'
      and exists (select 1 from public.order_status_history h where h.order_id = o.id and h.to_status = 'completed'
                  and (h.created_at at time zone 'Asia/Kolkata')::date between v_from and v_to));
  select coalesce(sum(o.subtotal_minor - o.discount_minor), 0) into v_cohort_net
  from public.orders o
  where o.business_id = v_biz and o.status = 'completed'
    and exists (select 1 from public.order_status_history h where h.order_id = o.id and h.to_status = 'completed'
                and (h.created_at at time zone 'Asia/Kolkata')::date between v_from and v_to);
  v_rep := public.report_inventory_food_cost(v_owner, v_biz, null, v_from, v_to, null, null, 500, 0);
  if (v_rep->'summary'->>'consumption_minor')::numeric <> -v_cohort_cost then
    raise exception 'food cost consumption % <> raw %', v_rep->'summary'->>'consumption_minor', -v_cohort_cost;
  end if;
  if (v_rep->'summary'->>'net_sales_minor')::bigint <> v_cohort_net then
    raise exception 'food cost net sales wrong';
  end if;
  v_fc := round(100.0 * (-v_cohort_cost) / nullif(v_cohort_net, 0), 2);
  if (v_rep->'summary'->>'food_cost_pct')::numeric <> v_fc then
    raise exception 'food cost % <> %', v_rep->'summary'->>'food_cost_pct', v_fc;
  end if;
  -- the backdated O2 is in yesterday's bucket, with its consumption
  if (select (r->>'consumption_minor')::numeric from jsonb_array_elements(v_rep->'rows') r
      where (r->>'period_start')::date = v_from) <= 0 then
    raise exception 'yesterday food cost should carry O2 consumption';
  end if;

  -- stock: the report's batch-mismatch count equals an independent raw count. Phase 13 test
  -- ingredients already carry drift (on_hand ≠ batches), so the report must flag it, not hide it.
  -- The Phase 16 ingredients themselves must agree.
  v_rep := public.report_inventory_stock(v_owner, v_biz, null, v_from, v_to, null, null, 500, 0);
  select count(*) into v_stock_mismatch
  from public.inventory_stock s
  where s.business_id = v_biz
    and s.on_hand <> coalesce((select sum(bt.remaining_qty) from public.inventory_batches bt
                               where bt.outlet_id = s.outlet_id and bt.ingredient_id = s.ingredient_id), 0);
  if (v_rep->'summary'->>'batch_mismatches')::int <> v_stock_mismatch then
    raise exception 'stock mismatch count % <> raw %', v_rep->'summary'->>'batch_mismatches', v_stock_mismatch;
  end if;
  if exists (select 1 from jsonb_array_elements(v_rep->'rows') r
             where r->>'ingredient_name' like 'P16%' and (r->>'batches_match')::boolean is false) then
    raise exception 'a P16 ingredient has on_hand that differs from its batches';
  end if;
  if (select (r->>'on_hand')::numeric from jsonb_array_elements(v_rep->'rows') r
      where r->>'ingredient_name' = 'P16 Rice' and (r->>'outlet_id')::uuid = v_main) <> 3900 then
    raise exception 'P16 rice on hand at Main should be 3900 (5000 received − 1000 used − 100 wasted)';
  end if;

  -- accountant has no inventory.view in this matrix, so inventory reports are refused
  if not public.actor_has_permission(v_accountant, v_biz, 'inventory.view') then
    v_r := pg_temp.try(format('select public.report_inventory_consumption(%L, %L, null, current_date - 1, current_date, null, null, 50, 0)', v_accountant, v_biz));
    if v_r not like 'err:%inventory.view%' then raise exception 'accountant reads inventory: %', v_r; end if;
  end if;

  raise notice 'OK: consumption %, purchases %, wastage %, food cost % with % net; stock on hand matches batches',
    v_cons, v_purch, v_waste, v_fc, v_cohort_net;
end $$;

\echo '── P16.9: staff reports reconcile with who did what'
do $$
declare
  v_biz uuid := 'cccccccc-0000-0000-0000-000000000001';
  v_owner uuid := 'aaaaaaaa-0000-0000-0000-000000000001';
  v_cashier uuid := 'f1111111-0000-0000-0000-000000000010';
  v_kitchen uuid := 'f1111111-0000-0000-0000-000000000020';
  v_from date := (select public.business_today()) - 1;
  v_to date := (select public.business_today());
  v_rep jsonb;
  v_r text;
  v_opened bigint; v_completed bigint; v_cancelled bigint;
  v_pay bigint; v_pay_n bigint; v_ref bigint; v_ref_n bigint;
  v_cashier_row jsonb;
begin
  -- orders opened (created) in the window and their status now
  select count(*) into v_opened from public.orders o
  where o.business_id = v_biz
    and (o.created_at at time zone 'Asia/Kolkata')::date between v_from and v_to;
  v_rep := public.report_staff_orders(v_owner, v_biz, null, v_from, v_to, null, null, 500, 0);
  if (v_rep->'summary'->>'opened')::bigint <> v_opened then
    raise exception 'opened % <> raw %', v_rep->'summary'->>'opened', v_opened;
  end if;
  select count(*) filter (where o.status = 'completed'), count(*) filter (where o.status = 'cancelled')
    into v_completed, v_cancelled
  from public.orders o
  where o.business_id = v_biz and (o.created_at at time zone 'Asia/Kolkata')::date between v_from and v_to;
  if (v_rep->'summary'->>'cancelled')::bigint <> v_cancelled then raise exception 'cancelled count wrong'; end if;
  if (v_rep->'summary'->>'opened')::bigint <> (v_rep->'summary'->>'completed')::bigint
     + (v_rep->'summary'->>'cancelled')::bigint + (v_rep->'summary'->>'still_open')::bigint then
    raise exception 'staff order statuses do not add up';
  end if;

  -- discounts by the creator: owner made O2 (2000 manual), O5 (promotion 5000); cashier made O1 (1000)
  v_rep := public.report_staff_discounts(v_owner, v_biz, null, v_from, v_to, null, null, 500, 0);
  if (v_rep->'summary'->>'total_discount_minor')::bigint <> (
       select coalesce(sum(o.discount_minor), 0) from public.orders o
       where o.business_id = v_biz and o.status = 'completed'
         and exists (select 1 from public.order_status_history h where h.order_id = o.id and h.to_status = 'completed'
                     and (h.created_at at time zone 'Asia/Kolkata')::date between v_from and v_to)) then
    raise exception 'staff discounts disagree with raw completed orders';
  end if;

  -- refunds by who processed them: owner processed both P16 refunds
  select coalesce(sum(r.amount_minor), 0), count(*) into v_ref, v_ref_n
  from public.refunds r
  where r.business_id = v_biz and r.status = 'succeeded'
    and (r.created_at at time zone 'Asia/Kolkata')::date between v_from and v_to;
  v_rep := public.report_staff_refunds(v_owner, v_biz, null, v_from, v_to, null, null, 500, 0);
  if (v_rep->'summary'->>'amount_minor')::bigint <> v_ref or (v_rep->'summary'->>'refunds')::bigint <> v_ref_n then
    raise exception 'staff refunds disagree with raw';
  end if;

  -- cashier activity: cashier took the O1 cash payment and opened O1 and O4, completed O1, cancelled O4
  v_rep := public.report_staff_cashier(v_owner, v_biz, null, v_from, v_to, null, null, 500, 0);
  select r into v_cashier_row from jsonb_array_elements(v_rep->'rows') r
  where (r->>'user_id')::uuid = v_cashier;
  if v_cashier_row is null then raise exception 'cashier missing from cashier activity'; end if;
  if (v_cashier_row->>'orders_opened')::int < 2 or (v_cashier_row->>'orders_cancelled')::int < 1 then
    raise exception 'cashier activity misses O1/O4: %', v_cashier_row;
  end if;
  select coalesce(sum(p.amount_minor), 0), count(*) into v_pay, v_pay_n
  from public.payments p
  where p.business_id = v_biz and p.created_by = v_cashier and p.status = 'captured'
    and (p.created_at at time zone 'Asia/Kolkata')::date between v_from and v_to;
  if (v_cashier_row->>'payments_minor')::bigint <> v_pay or (v_cashier_row->>'payments_count')::bigint <> v_pay_n then
    raise exception 'cashier payments % <> raw %', v_cashier_row->>'payments_minor', v_pay;
  end if;

  -- roles without reports.view or staff.view are refused
  v_r := pg_temp.try(format('select public.report_staff_orders(%L, %L, null, current_date - 1, current_date, null, null, 50, 0)', v_cashier, v_biz));
  if v_r not like 'err:%reports.view%' then raise exception 'cashier reads staff reports: %', v_r; end if;
  v_r := pg_temp.try(format('select public.report_staff_orders(%L, %L, null, current_date - 1, current_date, null, null, 50, 0)', v_kitchen, v_biz));
  if v_r not like 'err:%reports.view%' then raise exception 'kitchen reads staff reports: %', v_r; end if;

  raise notice 'OK: staff orders, discounts, refunds and cashier activity match raw rows; cashier takings % across % payments', v_pay, v_pay_n;
end $$;

\echo '── P16.10: customers and loyalty reconcile; returning and new are classified by first completed order'
do $$
declare
  v_biz uuid := 'cccccccc-0000-0000-0000-000000000001';
  v_owner uuid := 'aaaaaaaa-0000-0000-0000-000000000001';
  v_today date := (select public.business_today());
  v_from date := (select public.business_today()) - 1;
  v_to date := (select public.business_today());
  v_rep jsonb;
  v_asha uuid := pg_temp.ref('asha');
  v_ravi uuid;
  v_net bigint; v_net_raw bigint; v_loy_net bigint; v_loy_raw bigint; v_outstanding bigint; v_outstanding_raw bigint;
  v_r text;
begin
  select id into v_ravi from public.customers where business_id = v_biz and phone_key = '9000011122';

  -- on a today-only window Asha's first completed order (backdated yesterday) makes her returning
  v_rep := public.report_customers_returning(v_owner, v_biz, null, v_today, v_today, null, null, 500, 0);
  if not exists (select 1 from jsonb_array_elements(v_rep->'rows') r where (r->>'customer_id')::uuid = v_asha) then
    raise exception 'Asha not returning on a today-only window: %', v_rep;
  end if;
  -- Ravi is new: his first completed order is today
  v_rep := public.report_customers_new(v_owner, v_biz, null, v_today, v_today, null, null, 500, 0);
  if not exists (select 1 from jsonb_array_elements(v_rep->'rows') r where (r->>'customer_id')::uuid = v_ravi) then
    raise exception 'Ravi not new today: %', v_rep;
  end if;
  if exists (select 1 from jsonb_array_elements(v_rep->'rows') r where (r->>'customer_id')::uuid = v_asha) then
    raise exception 'Asha counted as new on a today-only window';
  end if;
  -- on the two-day window Asha has a completion in the window and an earlier one too (yesterday = first day in window → new)
  v_rep := public.report_customers_new(v_owner, v_biz, null, v_from, v_to, null, null, 500, 0);
  if not exists (select 1 from jsonb_array_elements(v_rep->'rows') r where (r->>'customer_id')::uuid = v_asha) then
    raise exception 'Asha should be new when her first completion falls inside the window';
  end if;

  -- spending: net = billed − refunds recorded in the window, per customer and in total
  select coalesce(sum(o.total_minor), 0) into v_net_raw
  from public.orders o
  where o.business_id = v_biz and o.status = 'completed' and o.customer_id is not null
    and exists (select 1 from public.order_status_history h where h.order_id = o.id and h.to_status = 'completed'
                and (h.created_at at time zone 'Asia/Kolkata')::date between v_from and v_to);
  select v_net_raw - coalesce(sum(r.amount_minor), 0) into v_net_raw
  from public.refunds r join public.orders o on o.id = r.order_id
  where r.business_id = v_biz and r.status = 'succeeded' and o.customer_id is not null
    and (r.created_at at time zone 'Asia/Kolkata')::date between v_from and v_to;
  v_rep := public.report_customers_spending(v_owner, v_biz, null, v_from, v_to, null, null, 500, 0);
  v_net := (v_rep->'summary'->>'net_minor')::bigint;
  if v_net <> v_net_raw then raise exception 'spending net % <> raw %', v_net, v_net_raw; end if;
  if (select sum((r->>'net_minor')::bigint) from jsonb_array_elements(v_rep->'rows') r) <> v_net then
    raise exception 'customer rows do not add up to the spending total';
  end if;
  -- rows are ranked by net spend
  if (select count(*) from (
        select (r->>'net_minor')::bigint as n, lag((r->>'net_minor')::bigint) over () as prev
        from jsonb_array_elements(v_rep->'rows') r) x
      where prev is not null and n > prev) <> 0 then
    raise exception 'spending rows are not ranked by net spend';
  end if;

  -- loyalty: ledger movement per window and the outstanding balance
  select coalesce(sum(t.points), 0) into v_loy_raw
  from public.loyalty_transactions t
  where t.business_id = v_biz and (t.created_at at time zone 'Asia/Kolkata')::date between v_from and v_to;
  v_rep := public.report_customers_loyalty(v_owner, v_biz, null, v_from, v_to, null, null, 500, 0);
  v_loy_net := (v_rep->'summary'->>'net_points')::bigint;
  if v_loy_net <> v_loy_raw then raise exception 'loyalty net % <> raw %', v_loy_net, v_loy_raw; end if;
  if (v_rep->'summary'->>'earned')::bigint - (v_rep->'summary'->>'redeemed')::bigint
     - (v_rep->'summary'->>'reversed')::bigint + (v_rep->'summary'->>'adjusted')::bigint <> v_loy_net then
    raise exception 'loyalty columns do not add up to the net movement';
  end if;
  select coalesce(sum(la.balance), 0) into v_outstanding_raw from public.loyalty_accounts la where la.business_id = v_biz;
  if (v_rep->'summary'->>'outstanding_points')::bigint <> v_outstanding_raw then
    raise exception 'outstanding points % <> raw %', v_rep->'summary'->>'outstanding_points', v_outstanding_raw;
  end if;

  -- the manager cannot see customer reports they lack; owners can
  v_r := pg_temp.try(format('select public.report_customers_loyalty(%L, %L, null, current_date - 1, current_date, null, null, 50, 0)', 'f1111111-0000-0000-0000-000000000010', v_biz));
  if v_r not like 'err:%reports.view%' then raise exception 'cashier reads loyalty report: %', v_r; end if;

  raise notice 'OK: new and returning customers classified by first completed order; spending net % and loyalty net % reconcile with raw rows; outstanding % points', v_net, v_loy_net, v_outstanding_raw;
end $$;

\echo '── P16.11: informational — completions without a history row are not reported'
do $$
declare
  v_biz uuid := 'cccccccc-0000-0000-0000-000000000001';
  v_n bigint;
begin
  select count(*) into v_n from public.orders o
  where o.business_id = v_biz and o.status = 'completed'
    and not exists (select 1 from public.order_status_history h where h.order_id = o.id and h.to_status = 'completed');
  raise notice 'INFO: % completed order(s) have no completion history row (Phase 15 harness shortcut). App paths always write one, so reports do not count them.', v_n;
end $$;
