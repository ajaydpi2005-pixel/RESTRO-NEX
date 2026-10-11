-- ─────────────────────────────────────────────────────────────────────────
-- Phase 13 — recipes and inventory: ingredients, batches (FEFO), transfers,
-- wastage, counts, consumption on completed orders, food cost, reconciliation.
-- Runs after Phase 12. Uses its own ingredients (P13 …) and its own table.
--
-- Fixture note: inventory_batches requires expires_on >= received_on, so an
-- expired batch cannot be received directly. P13.4 receives it with a future
-- expiry and then backdates the batch dates to simulate time passing.
-- ─────────────────────────────────────────────────────────────────────────

-- helpers: each wrapper returns 'ok:<id>' or 'err:<message>'
create or replace function pg_temp.ing(p_name text)
returns uuid language sql stable as $$
  select id from public.ingredients
  where business_id = 'cccccccc-0000-0000-0000-000000000001' and name = 'P13 ' || p_name;
$$;

create or replace function pg_temp.try_base(p_ing_unit text, p_unit text, p_qty numeric)
returns text language plpgsql as $$
begin
  return 'ok:' || trim_scale(public.inventory_base_qty(p_ing_unit, p_unit, p_qty))::text;
exception when others then
  return 'err:' || sqlerrm;
end $$;

create or replace function pg_temp.try_ingredient(
  p_actor uuid, p_id uuid, p_name text, p_unit text, p_cost numeric, p_min numeric, p_max numeric)
returns text language plpgsql as $$
begin
  return 'ok:' || public.ingredient_save(p_actor, 'cccccccc-0000-0000-0000-000000000001', p_id,
    p_name, p_unit, p_cost, p_min, p_max, true)::text;
exception when others then
  return 'err:' || sqlerrm;
end $$;

create or replace function pg_temp.try_receive(
  p_actor uuid, p_outlet uuid, p_ing uuid, p_qty numeric, p_unit text, p_cost numeric,
  p_code text, p_exp date, p_ref text)
returns text language plpgsql as $$
begin
  return 'ok:' || public.inventory_receive(p_actor, p_outlet, p_ing, p_qty, p_unit, p_cost,
    p_code, p_exp, p_ref)::text;
exception when others then
  return 'err:' || sqlerrm;
end $$;

create or replace function pg_temp.try_waste(
  p_actor uuid, p_outlet uuid, p_ing uuid, p_qty numeric, p_unit text, p_reason text, p_ref text)
returns text language plpgsql as $$
begin
  return 'ok:' || public.inventory_waste(p_actor, p_outlet, p_ing, p_qty, p_unit, p_reason, p_ref)::text;
exception when others then
  return 'err:' || sqlerrm;
end $$;

create or replace function pg_temp.try_adjust(
  p_actor uuid, p_outlet uuid, p_ing uuid, p_counted numeric, p_unit text, p_reason text, p_ref text)
returns text language plpgsql as $$
begin
  return 'ok:' || public.inventory_adjust(p_actor, p_outlet, p_ing, p_counted, p_unit, p_reason, p_ref)::text;
exception when others then
  return 'err:' || sqlerrm;
end $$;

create or replace function pg_temp.try_transfer(
  p_actor uuid, p_from uuid, p_to uuid, p_lines jsonb, p_ref text)
returns text language plpgsql as $$
begin
  return 'ok:' || public.inventory_transfer(p_actor, p_from, p_to, p_lines, 'P13 test', p_ref)::text;
exception when others then
  return 'err:' || sqlerrm;
end $$;

create or replace function pg_temp.try_recipe(p_actor uuid, p_item uuid, p_lines jsonb)
returns text language plpgsql as $$
begin
  perform public.recipe_save(p_actor, p_item, p_lines);
  return 'ok';
exception when others then
  return 'err:' || sqlerrm;
end $$;

create or replace function pg_temp.try_pay(p_actor uuid, p_order uuid, p_key text, p_lines jsonb)
returns text language plpgsql as $$
begin
  perform public.record_payments(p_actor, p_order, p_key, p_lines);
  return 'ok';
exception when others then
  return 'err:' || sqlerrm;
end $$;

create or replace function pg_temp.stock(p_outlet uuid, p_ing uuid)
returns numeric language sql stable as $$
  select coalesce((select on_hand from public.inventory_stock
                   where outlet_id = p_outlet and ingredient_id = p_ing), 0);
$$;

\echo '── P13.0: fixtures (inventory managers, a table, products, a combo)'
do $$
declare
  v_biz uuid := 'cccccccc-0000-0000-0000-000000000001';
  v_main uuid; v_branch uuid; v_section uuid; v_combo uuid; v_burger uuid; v_fries uuid;
begin
  select id into v_main from public.outlets where business_id = v_biz and slug = 'main';
  select id into v_branch from public.outlets where business_id = v_biz and slug = 'branch';

  insert into auth.users (id, email, raw_user_meta_data) values
    ('f1111111-0000-0000-0000-000000000060', 'p13invmain@example.com', '{"full_name": "Iris Main"}'),
    ('f1111111-0000-0000-0000-000000000061', 'p13invbranch@example.com', '{"full_name": "Ivan Branch"}');
  insert into public.memberships (user_id, business_id, role) values
    ('f1111111-0000-0000-0000-000000000060', v_biz, 'inventory_manager'),
    ('f1111111-0000-0000-0000-000000000061', v_biz, 'inventory_manager');
  insert into public.membership_outlets (membership_id, outlet_id)
  select m.id, v_main from public.memberships m
  where m.business_id = v_biz and m.user_id = 'f1111111-0000-0000-0000-000000000060';
  insert into public.membership_outlets (membership_id, outlet_id)
  select m.id, v_branch from public.memberships m
  where m.business_id = v_biz and m.user_id = 'f1111111-0000-0000-0000-000000000061';

  insert into public.dining_sections (business_id, outlet_id, name) values (v_biz, v_main, 'P13 Hall');
  select id into v_section from public.dining_sections where outlet_id = v_main and name = 'P13 Hall';
  insert into public.dining_tables (business_id, outlet_id, section_id, label, capacity)
  values (v_biz, v_main, v_section, 'T-P13', 4);
  perform set_config('p13.table', (select id::text from public.dining_tables where outlet_id = v_main and label = 'T-P13'), false);

  select id into v_burger from public.menu_items where business_id = v_biz and name = 'P8 Burger';
  select id into v_fries from public.menu_items where business_id = v_biz and name = 'P8 Fries';
  insert into public.combos (business_id, name, price_minor) values (v_biz, 'P13 Meal', 20000);
  select id into v_combo from public.combos where business_id = v_biz and name = 'P13 Meal';
  insert into public.combo_items (combo_id, product_id, quantity) values
    (v_combo, v_burger, 1), (v_combo, v_fries, 1);
  perform set_config('p13.combo', v_combo::text, false);
  raise notice 'OK: inventory managers, table and combo ready';
end $$;

\echo '── P13.1: unit conversions and mismatches are refused'
do $$
declare
  v_r text;
begin
  if pg_temp.try_base('g', 'kg', 0.5) <> 'ok:500' then raise exception 'kg→g wrong: %', pg_temp.try_base('g', 'kg', 0.5); end if;
  if pg_temp.try_base('ml', 'l', 0.02) <> 'ok:20' then raise exception 'l→ml wrong: %', pg_temp.try_base('ml', 'l', 0.02); end if;
  if pg_temp.try_base('pc', 'dz', 1) <> 'ok:12' then raise exception 'dz→pc wrong: %', pg_temp.try_base('pc', 'dz', 1); end if;
  if pg_temp.try_base('g', 'kg', 2) <> 'ok:2000' then raise exception 'kg→g (2) wrong'; end if;

  v_r := pg_temp.try_base('pc', 'g', 1);
  if v_r not like 'err:%' then raise exception 'weight accepted for a count ingredient: %', v_r; end if;
  v_r := pg_temp.try_base('g', 'furlong', 1);
  if v_r not like 'err:%' then raise exception 'unknown unit accepted: %', v_r; end if;
  raise notice 'OK: units convert to base (g, ml, pc) and mismatches are refused';
end $$;

\echo '── P13.2: ingredients are managed by inventory.manage only'
do $$
declare
  v_biz uuid := 'cccccccc-0000-0000-0000-000000000001';
  v_owner uuid := 'aaaaaaaa-0000-0000-0000-000000000001';
  v_inv uuid := 'f1111111-0000-0000-0000-000000000060';
  v_waiter uuid := 'f1111111-0000-0000-0000-000000000040';
  v_kitchen uuid := 'f1111111-0000-0000-0000-000000000020';
  v_r text;
begin
  v_r := pg_temp.try_ingredient(v_waiter, null, 'P13 Bun', 'pc', 100, 10, 200);
  if v_r !~* 'err:.*(does not allow|not assigned)' then raise exception 'waiter managed ingredients: %', v_r; end if;
  v_r := pg_temp.try_ingredient(v_kitchen, null, 'P13 Bun', 'pc', 100, 10, 200);
  if v_r !~* 'err:.*(does not allow|not assigned)' then raise exception 'kitchen managed ingredients: %', v_r; end if;

  v_r := pg_temp.try_ingredient(v_inv, null, 'P13 Bun', 'kg', 100, 10, 200);
  if v_r not like 'err:%' then raise exception 'ingredient with base unit kg accepted: %', v_r; end if;

  perform pg_temp.try_ingredient(v_inv, null, 'P13 Bun', 'pc', 100, 10, 200);
  perform pg_temp.try_ingredient(v_inv, null, 'P13 Patty', 'pc', 1500, 1, 20);
  perform pg_temp.try_ingredient(v_inv, null, 'P13 Cheese', 'g', 0.6, 500, 5000);
  perform pg_temp.try_ingredient(v_inv, null, 'P13 Sauce', 'ml', 0.2, 100, 2000);
  perform pg_temp.try_ingredient(v_inv, null, 'P13 Potato', 'g', 0.05, 200, 5000);
  perform pg_temp.try_ingredient(v_inv, null, 'P13 Oil', 'ml', 0.1, 100, 2000);

  if (select count(*) from public.ingredients
      where business_id = v_biz and name like 'P13 %') <> 6 then
    raise exception 'expected six P13 ingredients';
  end if;
  raise notice 'OK: six ingredients created; waiter and kitchen refused; non-base units refused';
end $$;

\echo '── P13.3: receiving is outlet-scoped and idempotent; FEFO batches are kept'
do $$
declare
  v_main uuid; v_branch uuid;
  v_inv uuid := 'f1111111-0000-0000-0000-000000000060';
  v_branch_inv uuid := 'f1111111-0000-0000-0000-000000000061';
  v_waiter uuid := 'f1111111-0000-0000-0000-000000000040';
  v_a text; v_again text; v_r text; v_n integer;
begin
  select id into v_main from public.outlets where business_id = 'cccccccc-0000-0000-0000-000000000001' and slug = 'main';
  select id into v_branch from public.outlets where business_id = 'cccccccc-0000-0000-0000-000000000001' and slug = 'branch';

  v_r := pg_temp.try_receive(v_waiter, v_main, pg_temp.ing('Cheese'), 2, 'kg', 600, 'CH-A', date '2099-03-01', 'p13-rcv-cheese-a');
  if v_r !~* 'err:.*(does not allow|not assigned)' then raise exception 'waiter received stock: %', v_r; end if;
  v_r := pg_temp.try_receive(v_branch_inv, v_main, pg_temp.ing('Cheese'), 2, 'kg', 600, 'CH-A', date '2099-03-01', 'p13-rcv-cheese-a');
  if v_r !~* 'err:.*(does not allow|not assigned)' then raise exception 'branch manager received at main: %', v_r; end if;

  v_a := pg_temp.try_receive(v_inv, v_main, pg_temp.ing('Cheese'), 2, 'kg', 600, 'CH-A', date '2099-03-01', 'p13-rcv-cheese-a');
  if v_a not like 'ok:%' then raise exception 'receive failed: %', v_a; end if;
  v_again := pg_temp.try_receive(v_inv, v_main, pg_temp.ing('Cheese'), 2, 'kg', 600, 'CH-A', date '2099-03-01', 'p13-rcv-cheese-a');
  if v_again <> v_a then raise exception 'repeated receive did not return the same record'; end if;
  if (select count(*) from public.inventory_batches where batch_code = 'CH-A') <> 1 then
    raise exception 'repeated receive created a second batch';
  end if;
  if pg_temp.stock(v_main, pg_temp.ing('Cheese')) <> 2000 then raise exception 'cheese on hand after receive wrong'; end if;
  if (select value_minor from public.inventory_movements
      where reference_key = 'p13-rcv-cheese-a') <> 1200 then
    raise exception 'receipt not valued at 2000 g × 0.6';
  end if;

  perform pg_temp.try_receive(v_inv, v_main, pg_temp.ing('Cheese'), 1, 'kg', 500, 'CH-B', date '2099-06-01', 'p13-rcv-cheese-b');
  perform pg_temp.try_receive(v_inv, v_main, pg_temp.ing('Bun'), 3, 'pc', 100, 'BUN-1', date '2099-12-01', 'p13-rcv-bun');
  perform pg_temp.try_receive(v_inv, v_main, pg_temp.ing('Patty'), 2, 'pc', 1500, 'PAT-1', date '2099-05-01', 'p13-rcv-patty');
  perform pg_temp.try_receive(v_inv, v_main, pg_temp.ing('Sauce'), 1, 'l', 200, 'SAU-1', date '2099-09-01', 'p13-rcv-sauce');
  perform pg_temp.try_receive(v_inv, v_main, pg_temp.ing('Potato'), 500, 'g', 0.05, 'POT-OLD', date '2099-01-01', 'p13-rcv-pot-old');
  perform pg_temp.try_receive(v_inv, v_main, pg_temp.ing('Potato'), 1000, 'g', 0.05, 'POT-NEW', date '2099-06-01', 'p13-rcv-pot-new');

  if pg_temp.stock(v_main, pg_temp.ing('Cheese')) <> 3000 then raise exception 'cheese total wrong'; end if;
  if pg_temp.stock(v_main, pg_temp.ing('Potato')) <> 1500 then raise exception 'potato total wrong'; end if;

  -- simulate time passing: the old potato batch is now expired (before any order runs)
  update public.inventory_batches
  set received_on = current_date - 10, expires_on = current_date - 1
  where batch_code = 'POT-OLD';

  -- the branch has no cheese yet and the branch manager cannot read main's stock
  select count(*) into v_n from public.inventory_batches
  where ingredient_id = pg_temp.ing('Cheese') and outlet_id = v_branch;
  if v_n <> 0 then raise exception 'receipt leaked to the branch'; end if;
  raise notice 'OK: receipts are idempotent, valued at batch cost, and outlet-scoped';
end $$;

\echo '── P13.4: recipes need menu.manage; lines convert to base units'
do $$
declare
  v_owner uuid := 'aaaaaaaa-0000-0000-0000-000000000001';
  v_inv uuid := 'f1111111-0000-0000-0000-000000000060';
  v_waiter uuid := 'f1111111-0000-0000-0000-000000000040';
  v_burger uuid; v_fries uuid; v_r text; v_n integer;
  v_lines_burger jsonb; v_lines_fries jsonb;
begin
  select id into v_burger from public.menu_items where business_id = 'cccccccc-0000-0000-0000-000000000001' and name = 'P8 Burger';
  select id into v_fries from public.menu_items where business_id = 'cccccccc-0000-0000-0000-000000000001' and name = 'P8 Fries';

  v_lines_burger := jsonb_build_array(
    jsonb_build_object('ingredient_id', pg_temp.ing('Bun'), 'unit', 'pc', 'qty', 1),
    jsonb_build_object('ingredient_id', pg_temp.ing('Patty'), 'unit', 'pc', 'qty', 1),
    jsonb_build_object('ingredient_id', pg_temp.ing('Cheese'), 'unit', 'g', 'qty', 40),
    jsonb_build_object('ingredient_id', pg_temp.ing('Sauce'), 'unit', 'l', 'qty', 0.02));
  v_lines_fries := jsonb_build_array(
    jsonb_build_object('ingredient_id', pg_temp.ing('Potato'), 'unit', 'g', 'qty', 200),
    jsonb_build_object('ingredient_id', pg_temp.ing('Oil'), 'unit', 'l', 'qty', 0.03));

  v_r := pg_temp.try_recipe(v_waiter, v_burger, v_lines_burger);
  if v_r !~* 'err:.*(does not allow|not assigned)' then raise exception 'waiter edited a recipe: %', v_r; end if;
  v_r := pg_temp.try_recipe(v_inv, v_burger, v_lines_burger);
  if v_r !~* 'err:.*(does not allow|not assigned)' then raise exception 'inventory manager edited a recipe without menu.manage: %', v_r; end if;

  v_r := pg_temp.try_recipe(v_owner, v_burger, jsonb_build_array(
    jsonb_build_object('ingredient_id', pg_temp.ing('Bun'), 'unit', 'g', 'qty', 1)));
  if v_r not like 'err:%' then raise exception 'unit mismatch accepted in a recipe: %', v_r; end if;

  if pg_temp.try_recipe(v_owner, v_burger, v_lines_burger) <> 'ok' then raise exception 'owner could not save burger recipe'; end if;
  if pg_temp.try_recipe(v_owner, v_fries, v_lines_fries) <> 'ok' then raise exception 'owner could not save fries recipe'; end if;
  -- saving again replaces the lines rather than doubling them
  perform pg_temp.try_recipe(v_owner, v_burger, v_lines_burger);

  select count(*) into v_n from public.recipe_ingredients ri
  join public.recipes r on r.id = ri.recipe_id where r.menu_item_id = v_burger;
  if v_n <> 4 then raise exception 'burger recipe has % lines, expected 4', v_n; end if;
  if (select ri.quantity from public.recipe_ingredients ri join public.recipes r on r.id = ri.recipe_id
      where r.menu_item_id = v_burger and ri.ingredient_id = pg_temp.ing('Sauce')) <> 20 then
    raise exception 'sauce 0.02 l not stored as 20 ml';
  end if;
  if (select ri.quantity from public.recipe_ingredients ri join public.recipes r on r.id = ri.recipe_id
      where r.menu_item_id = v_fries and ri.ingredient_id = pg_temp.ing('Oil')) <> 30 then
    raise exception 'oil 0.03 l not stored as 30 ml';
  end if;
  raise notice 'OK: recipes need menu.manage; lines store base units and replace on save';
end $$;

\echo '── P13.5: a completed order consumes its recipes, FEFO, combos explode, shortfall is recorded'
do $$
declare
  v_biz uuid := 'cccccccc-0000-0000-0000-000000000001';
  v_main uuid; v_burger uuid; v_fries uuid; v_juice uuid; v_order uuid; v_item uuid;
  v_waiter uuid := 'f1111111-0000-0000-0000-000000000040';
  v_kit uuid := 'f1111111-0000-0000-0000-000000000020';
  v_cashier uuid := 'f1111111-0000-0000-0000-000000000030';
  v_total bigint; v_cost numeric; v_posted integer; v_n integer;
begin
  select id into v_main from public.outlets where business_id = v_biz and slug = 'main';
  select id into v_burger from public.menu_items where business_id = v_biz and name = 'P8 Burger';
  select id into v_fries from public.menu_items where business_id = v_biz and name = 'P8 Fries';
  select id into v_juice from public.menu_items where business_id = v_biz and name = 'P11 Juice';

  -- two burgers, one fries, one juice (no recipe), and a combo (burger + fries)
  v_order := public.waiter_submit_order(v_waiter, jsonb_build_object(
    'outlet_id', v_main, 'client_ref', 'p13-order-0001', 'order_type', 'dine_in',
    'table_id', current_setting('p13.table'),
    'items', jsonb_build_array(
      jsonb_build_object('item_type', 'product', 'product_id', v_burger, 'quantity', 2),
      jsonb_build_object('item_type', 'product', 'product_id', v_fries, 'quantity', 1),
      jsonb_build_object('item_type', 'product', 'product_id', v_juice, 'quantity', 1),
      jsonb_build_object('item_type', 'combo', 'combo_id', current_setting('p13.combo'), 'quantity', 1))), true);
  perform set_config('p13.order', v_order::text, false);

  -- nothing is consumed while the order is still open
  if (select count(*) from public.inventory_movements where order_id = v_order) <> 0 then
    raise exception 'stock consumed before the order completed';
  end if;

  for v_item in select id from public.order_items where order_id = v_order and kitchen_status = 'new' loop
    perform public.kds_advance_item(v_kit, v_item, 'new', 'accepted');
    perform public.kds_advance_item(v_kit, v_item, 'accepted', 'preparing');
    perform public.kds_advance_item(v_kit, v_item, 'preparing', 'ready');
  end loop;

  select total_minor into v_total from public.orders where id = v_order;
  perform public.record_payments(v_cashier, v_order, 'p13-pay-0001', jsonb_build_array(
    jsonb_build_object('method_key', 'cash', 'amount_minor', v_total, 'tendered_minor', v_total)));
  perform public.transition_order_status(v_cashier, v_order, 'completed', null);

  if not exists (select 1 from public.inventory_postings where order_id = v_order) then
    raise exception 'completing the order did not post consumption';
  end if;

  -- burgers 3 (2 + combo), fries 2 (1 + combo), juice 1 (no recipe)
  if (select coalesce(-sum(qty), 0) from public.inventory_movements
      where order_id = v_order and ingredient_id = pg_temp.ing('Bun')) <> 3 then
    raise exception 'bun consumption wrong (combo not exploded?)';
  end if;
  if (select coalesce(-sum(qty), 0) from public.inventory_movements
      where order_id = v_order and ingredient_id = pg_temp.ing('Cheese')) <> 120 then
    raise exception 'cheese consumption not 3 × 40 g';
  end if;
  if (select coalesce(-sum(qty), 0) from public.inventory_movements
      where order_id = v_order and ingredient_id = pg_temp.ing('Sauce')) <> 60 then
    raise exception 'sauce consumption not 3 × 20 ml';
  end if;
  if (select coalesce(-sum(qty), 0) from public.inventory_movements
      where order_id = v_order and ingredient_id = pg_temp.ing('Potato')) <> 400 then
    raise exception 'potato consumption not 2 × 200 g';
  end if;
  if (select coalesce(-sum(qty), 0) from public.inventory_movements
      where order_id = v_order and ingredient_id = pg_temp.ing('Oil')) <> 60 then
    raise exception 'oil consumption not 2 × 30 ml';
  end if;

  -- FEFO: cheese comes from the earliest batch first, and the expired potato batch is skipped
  if (select remaining_qty from public.inventory_batches where batch_code = 'CH-A') <> 1880 then
    raise exception 'cheese not taken from the earliest-expiring batch first';
  end if;
  if (select remaining_qty from public.inventory_batches where batch_code = 'CH-B') <> 1000 then
    raise exception 'later cheese batch touched too early';
  end if;
  if (select remaining_qty from public.inventory_batches where batch_code = 'POT-NEW') <> 600 then
    raise exception 'potato not taken from the live batch';
  end if;

  -- patty: 2 on hand, 3 needed → one unbatched shortfall at standard cost, not a failed sale
  if pg_temp.stock(v_main, pg_temp.ing('Patty')) <> -1 then raise exception 'patty shortfall not recorded as -1'; end if;
  if pg_temp.stock(v_main, pg_temp.ing('Oil')) <> -60 then raise exception 'oil shortfall not recorded as -60'; end if;

  -- food cost at actual batch cost: bun 300 + patty 4500 + cheese 72 + sauce 12 + potato 20 + oil 6
  select cost_minor into v_cost from public.inventory_postings where order_id = v_order;
  if v_cost <> 4910 then raise exception 'food cost % , expected 4910', v_cost; end if;
  -- one consumption line per ingredient; a patty shortfall adds a second ledger row for the same ingredient
  select ingredient_count into v_posted from public.inventory_postings where order_id = v_order;
  if v_posted <> 6 then raise exception 'posting counted % ingredients, expected 6', v_posted; end if;
  if v_posted <> (select count(distinct ingredient_id) from public.inventory_movements where order_id = v_order) then
    raise exception 'posting ingredient count does not match the ledger';
  end if;
  if (select sum(value_minor) from public.inventory_movements where order_id = v_order) <> -4910 then
    raise exception 'ledger value does not equal the food cost';
  end if;
  raise notice 'OK: completion consumed FEFO batches, exploded the combo, recorded shortfalls and food cost 4910';
end $$;

\echo '── P13.6: duplicate posting is prevented'
do $$
declare
  v_order uuid := current_setting('p13.order')::uuid;
  v_before integer; v_after integer; v_postings integer;
begin
  select count(*) into v_before from public.inventory_movements where order_id = v_order;
  perform public.inventory_post_order(v_order);
  update public.orders set status = 'completed' where id = v_order;
  select count(*) into v_after from public.inventory_movements where order_id = v_order;
  if v_after <> v_before then raise exception 'repeat posting created % extra movements', v_after - v_before; end if;
  select count(*) into v_postings from public.inventory_postings where order_id = v_order;
  if v_postings <> 1 then raise exception 'order has % postings', v_postings; end if;
  raise notice 'OK: re-posting and re-completing an order never deducts twice';
end $$;

\echo '── P13.7: the ledger is append-only and cannot be deleted from the business'
do $$
declare
  v_mov uuid; v_biz uuid := 'cccccccc-0000-0000-0000-000000000001';
begin
  select id into v_mov from public.inventory_movements where order_id = current_setting('p13.order')::uuid limit 1;
  begin
    update public.inventory_movements set reason = 'tampered' where id = v_mov;
    raise exception 'LEDGER_UPDATED';
  exception when others then
    if sqlerrm = 'LEDGER_UPDATED' then raise exception 'ledger row was updated'; end if;
  end;
  begin
    delete from public.inventory_movements where id = v_mov;
    raise exception 'LEDGER_DELETED';
  exception when others then
    if sqlerrm = 'LEDGER_DELETED' then raise exception 'ledger row was deleted'; end if;
  end;
  begin
    delete from public.businesses where id = v_biz;
    raise exception 'BUSINESS_DELETED';
  exception when others then
    if sqlerrm = 'BUSINESS_DELETED' then raise exception 'business deleted while stock movements exist'; end if;
  end;
  raise notice 'OK: movements cannot be updated or deleted, and the business cannot be deleted while they exist';
end $$;

\echo '── P13.8: wastage refuses shortfalls, disposes of expired stock, and is idempotent'
do $$
declare
  v_main uuid;
  v_inv uuid := 'f1111111-0000-0000-0000-000000000060';
  v_waiter uuid := 'f1111111-0000-0000-0000-000000000040';
  v_a text; v_again text; v_r text;
begin
  select id into v_main from public.outlets where business_id = 'cccccccc-0000-0000-0000-000000000001' and slug = 'main';

  -- the expired batch was skipped by the order, so it is still 500 g
  if (select remaining_qty from public.inventory_batches where batch_code = 'POT-OLD') <> 500 then
    raise exception 'expired potato was consumed';
  end if;

  v_r := pg_temp.try_waste(v_waiter, v_main, pg_temp.ing('Sauce'), 10, 'ml', 'spill', 'p13-waste-w');
  if v_r !~* 'err:.*(does not allow|not assigned)' then raise exception 'waiter wasted stock: %', v_r; end if;

  v_a := pg_temp.try_waste(v_inv, v_main, pg_temp.ing('Potato'), 500, 'g', 'expired', 'p13-waste-old');
  if v_a not like 'ok:%' then raise exception 'expired wastage failed: %', v_a; end if;
  v_again := pg_temp.try_waste(v_inv, v_main, pg_temp.ing('Potato'), 500, 'g', 'expired', 'p13-waste-old');
  if v_again <> v_a then raise exception 'repeated wastage did not return the same record'; end if;
  if pg_temp.stock(v_main, pg_temp.ing('Potato')) <> 600 then raise exception 'potato after wastage wrong'; end if;
  if (select remaining_qty from public.inventory_batches where batch_code = 'POT-OLD') <> 0 then
    raise exception 'expired batch not emptied';
  end if;

  v_r := pg_temp.try_waste(v_inv, v_main, pg_temp.ing('Sauce'), 2000, 'ml', 'spill', 'p13-waste-big');
  if v_r not like 'err:%' then raise exception 'wastage beyond stock accepted: %', v_r; end if;
  v_r := pg_temp.try_waste(v_inv, v_main, pg_temp.ing('Oil'), 10, 'ml', 'spill', 'p13-waste-oil');
  if v_r not like 'err:%' then raise exception 'wastage recorded against a shortfall: %', v_r; end if;
  v_r := pg_temp.try_waste(v_inv, v_main, pg_temp.ing('Sauce'), 10, 'ml', '   ', 'p13-waste-noreason');
  if v_r not like 'err:%' then raise exception 'wastage without a reason accepted: %', v_r; end if;
  raise notice 'OK: wastage disposes of expired stock, refuses shortfalls, and is idempotent';
end $$;

\echo '── P13.9: counts post the difference and never accept a negative count'
do $$
declare
  v_main uuid;
  v_inv uuid := 'f1111111-0000-0000-0000-000000000060';
  v_r text; v_n integer;
begin
  select id into v_main from public.outlets where business_id = 'cccccccc-0000-0000-0000-000000000001' and slug = 'main';

  v_r := pg_temp.try_adjust(v_inv, v_main, pg_temp.ing('Cheese'), -1, 'g', 'count', 'p13-adj-neg');
  if v_r not like 'err:%' then raise exception 'negative count accepted: %', v_r; end if;
  v_r := pg_temp.try_adjust(v_inv, v_main, pg_temp.ing('Cheese'), 2000, 'g', '  ', 'p13-adj-noreason');
  if v_r not like 'err:%' then raise exception 'count without a reason accepted: %', v_r; end if;

  -- counted 2000 g against 2880 g on hand: a -880 g adjustment from the earliest batch
  if pg_temp.try_adjust(v_inv, v_main, pg_temp.ing('Cheese'), 2000, 'g', 'monthly count', 'p13-adj-cheese') not like 'ok:%' then
    raise exception 'cheese count failed';
  end if;
  if pg_temp.stock(v_main, pg_temp.ing('Cheese')) <> 2000 then raise exception 'cheese after count wrong'; end if;
  if (select remaining_qty from public.inventory_batches where batch_code = 'CH-A') <> 1000 then
    raise exception 'downward count not taken from the earliest batch';
  end if;
  if (select delta from public.stock_adjustments where reason = 'monthly count') <> -880 then
    raise exception 'adjustment delta not recorded';
  end if;

  -- counting oil up from a shortfall of -60 to 500 posts a +560 receipt-like batch
  if pg_temp.try_adjust(v_inv, v_main, pg_temp.ing('Oil'), 500, 'ml', 'found in store', 'p13-adj-oil') not like 'ok:%' then
    raise exception 'oil count failed';
  end if;
  if pg_temp.stock(v_main, pg_temp.ing('Oil')) <> 500 then raise exception 'oil after count wrong'; end if;
  raise notice 'OK: counts post the signed difference, need a reason, and refuse negative counts';
end $$;

\echo '── P13.10: transfers move stock between outlets without creating or losing units'
do $$
declare
  v_biz uuid := 'cccccccc-0000-0000-0000-000000000001';
  v_main uuid; v_branch uuid; v_transfer uuid; v_again uuid; v_r text;
  v_inv uuid := 'f1111111-0000-0000-0000-000000000060';
  v_branch_inv uuid := 'f1111111-0000-0000-0000-000000000061';
  v_waiter uuid := 'f1111111-0000-0000-0000-000000000040';
  v_before numeric; v_after numeric;
  v_owner uuid := 'aaaaaaaa-0000-0000-0000-000000000001';
begin
  select id into v_main from public.outlets where business_id = v_biz and slug = 'main';
  select id into v_branch from public.outlets where business_id = v_biz and slug = 'branch';
  v_before := pg_temp.stock(v_main, pg_temp.ing('Cheese')) + pg_temp.stock(v_branch, pg_temp.ing('Cheese'));

  v_r := pg_temp.try_transfer(v_waiter, v_main, v_branch,
    jsonb_build_array(jsonb_build_object('ingredient_id', pg_temp.ing('Cheese'), 'unit', 'g', 'qty', 100)), 'p13-tr-waiter');
  if v_r !~* 'err:.*(does not allow|not assigned)' then raise exception 'waiter moved stock: %', v_r; end if;

  -- an inventory manager of the branch only cannot take stock out of main
  v_r := pg_temp.try_transfer(v_branch_inv, v_main, v_branch,
    jsonb_build_array(jsonb_build_object('ingredient_id', pg_temp.ing('Cheese'), 'unit', 'g', 'qty', 100)), 'p13-tr-branchmgr');
  if v_r !~* 'err:.*(does not allow|not assigned)' then raise exception 'branch manager moved main stock: %', v_r; end if;

  -- a main-only manager cannot send stock to a branch they do not manage
  v_r := pg_temp.try_transfer(v_inv, v_main, v_branch,
    jsonb_build_array(jsonb_build_object('ingredient_id', pg_temp.ing('Cheese'), 'unit', 'g', 'qty', 100)), 'p13-tr-onesided');
  if v_r !~* 'err:.*(does not allow|not assigned)' then raise exception 'one-sided transfer accepted: %', v_r; end if;

  v_r := pg_temp.try_transfer(v_inv, v_main, v_main,
    jsonb_build_array(jsonb_build_object('ingredient_id', pg_temp.ing('Cheese'), 'unit', 'g', 'qty', 100)), 'p13-tr-same');
  if v_r not like 'err:%different outlets%' then raise exception 'same-outlet transfer accepted: %', v_r; end if;

  -- the owner has both outlets, so this failure can only be about stock
  v_r := pg_temp.try_transfer(v_owner, v_main, v_branch,
    jsonb_build_array(jsonb_build_object('ingredient_id', pg_temp.ing('Cheese'), 'unit', 'g', 'qty', 5000)), 'p13-tr-big');
  if v_r not like 'err:%' or v_r ilike '%not assigned%' then raise exception 'transfer beyond stock not refused on stock: %', v_r; end if;

  -- 1500 g: 1000 g from CH-A then 500 g from CH-B
  v_r := pg_temp.try_transfer(v_owner, v_main, v_branch,
    jsonb_build_array(jsonb_build_object('ingredient_id', pg_temp.ing('Cheese'), 'unit', 'g', 'qty', 1500)), 'p13-tr-cheese');
  if v_r not like 'ok:%' then raise exception 'transfer failed: %', v_r; end if;
  v_transfer := substring(v_r from 4)::uuid;
  v_again := public.inventory_transfer(v_owner, v_main, v_branch,
    jsonb_build_array(jsonb_build_object('ingredient_id', pg_temp.ing('Cheese'), 'unit', 'g', 'qty', 1500)), 'P13 test', 'p13-tr-cheese');
  if v_again <> v_transfer then raise exception 'repeated transfer did not return the same record'; end if;

  if pg_temp.stock(v_main, pg_temp.ing('Cheese')) <> 500 then raise exception 'main cheese after transfer wrong'; end if;
  if pg_temp.stock(v_branch, pg_temp.ing('Cheese')) <> 1500 then raise exception 'branch cheese after transfer wrong'; end if;
  v_after := pg_temp.stock(v_main, pg_temp.ing('Cheese')) + pg_temp.stock(v_branch, pg_temp.ing('Cheese'));
  if v_after <> v_before then raise exception 'transfer created or lost stock (% → %)', v_before, v_after; end if;
  if (select count(*) from public.inventory_batches
      where outlet_id = v_branch and ingredient_id = pg_temp.ing('Cheese') and expires_on is not null) <> 2 then
    raise exception 'transferred batches did not keep their expiry';
  end if;
  raise notice 'OK: transfers are both-side permissioned, conserve stock, keep expiry, and are idempotent';
end $$;

\echo '── P13.11: reconciliation agrees with the ledger, including shortfalls'
do $$
declare
  v_main uuid; v_branch uuid; v_bad integer; v_unbatched numeric; v_onhand numeric;
  v_owner uuid := 'aaaaaaaa-0000-0000-0000-000000000001';
begin
  select id into v_main from public.outlets where business_id = 'cccccccc-0000-0000-0000-000000000001' and slug = 'main';
  select id into v_branch from public.outlets where business_id = 'cccccccc-0000-0000-0000-000000000001' and slug = 'branch';

  select count(*) into v_bad from public.inventory_reconcile(v_owner, v_main) where not consistent;
  if v_bad <> 0 then raise exception 'main reconciliation has % inconsistent rows', v_bad; end if;
  select count(*) into v_bad from public.inventory_reconcile(v_owner, v_branch) where not consistent;
  if v_bad <> 0 then raise exception 'branch reconciliation has % inconsistent rows', v_bad; end if;

  select unbatched, on_hand into v_unbatched, v_onhand from public.inventory_reconcile(v_owner, v_main)
  where ingredient_name = 'P13 Patty';
  if v_unbatched <> -1 or v_onhand <> -1 then raise exception 'patty shortfall not reconciled (%, %)', v_onhand, v_unbatched; end if;
  raise notice 'OK: reconciliation is consistent at both outlets, and shortfalls appear as unbatched stock';
end $$;

\echo '── P13.12: outlet isolation and permissions on stock data'
do $$
declare
  v_biz uuid := 'cccccccc-0000-0000-0000-000000000001';
  v_main uuid; v_branch uuid; v_n integer; v_r text;
begin
  select id into v_main from public.outlets where business_id = v_biz and slug = 'main';
  select id into v_branch from public.outlets where business_id = v_biz and slug = 'branch';

  -- kitchen and waiter see no stock data at all
  set role authenticated;
  set request.jwt.claims = '{"sub": "f1111111-0000-0000-0000-000000000020", "role": "authenticated"}';
  select count(*) into v_n from public.inventory_movements;
  reset role;
  if v_n <> 0 then raise exception 'kitchen can read the stock ledger (%)', v_n; end if;

  set role authenticated;
  set request.jwt.claims = '{"sub": "f1111111-0000-0000-0000-000000000040", "role": "authenticated"}';
  select count(*) into v_n from public.ingredients;
  reset role;
  if v_n <> 0 then raise exception 'waiter can read ingredients (%)', v_n; end if;

  -- main-only manager sees main movements but none from the branch
  set role authenticated;
  set request.jwt.claims = '{"sub": "f1111111-0000-0000-0000-000000000060", "role": "authenticated"}';
  select count(*) into v_n from public.inventory_movements where outlet_id = v_main;
  if v_n = 0 then reset role; raise exception 'main manager cannot see main movements'; end if;
  select count(*) into v_n from public.inventory_movements where outlet_id = v_branch;
  reset role;
  if v_n <> 0 then raise exception 'main manager sees branch movements (%)', v_n; end if;

  -- branch manager sees the transfer-in at the branch and nothing at main
  set role authenticated;
  set request.jwt.claims = '{"sub": "f1111111-0000-0000-0000-000000000061", "role": "authenticated"}';
  select count(*) into v_n from public.inventory_movements where outlet_id = v_branch;
  if v_n = 0 then reset role; raise exception 'branch manager cannot see branch movements'; end if;
  select count(*) into v_n from public.inventory_movements where outlet_id = v_main;
  reset role;
  if v_n <> 0 then raise exception 'branch manager sees main movements (%)', v_n; end if;

  -- owners see everything
  set role authenticated;
  set request.jwt.claims = '{"sub": "aaaaaaaa-0000-0000-0000-000000000001", "role": "authenticated"}';
  select count(*) into v_n from public.inventory_movements;
  reset role;
  if v_n = 0 then raise exception 'owner cannot see stock movements'; end if;

  -- nobody writes the ledger directly
  begin
    set role authenticated;
    set request.jwt.claims = '{"sub": "aaaaaaaa-0000-0000-0000-000000000001", "role": "authenticated"}';
    insert into public.inventory_movements (business_id, outlet_id, ingredient_id, kind, qty, unit_cost, value_minor, reference_key)
    values (v_biz, v_main, pg_temp.ing('Bun'), 'receipt', 1, 1, 1, 'p13-direct');
    reset role;
    raise exception 'DIRECT_INSERT';
  exception when others then
    reset role;
    if sqlerrm = 'DIRECT_INSERT' then raise exception 'owner inserted a ledger row directly'; end if;
  end;

  v_r := pg_temp.try_receive('f1111111-0000-0000-0000-000000000020', v_main, pg_temp.ing('Bun'), 1, 'pc', 100, 'K', null, 'p13-kit-rcv');
  if v_r !~* 'err:.*(does not allow|not assigned)' then raise exception 'kitchen received stock: %', v_r; end if;
  raise notice 'OK: kitchen and waiter see no stock; managers are outlet-scoped; the ledger has no direct writes';
end $$;

\echo '── P13 complete'
