-- ─────────────────────────────────────────────────────────────────────────
-- Phase 14 — purchasing: suppliers, purchase orders, goods receipts, supplier
-- invoices, payments, and reconciliation between purchasing and the ledger.
-- Runs after Phase 13. Uses its own ingredients and suppliers (P14 …).
--
-- Worked numbers (paise):
--   PO1: Tomato 5 kg @ 4000/kg = 20000, Flour 10 kg @ 3000/kg = 30000,
--        Cups 2 dz @ 6000/dz = 12000. Order subtotal 62000.
--   GRN1: Tomato 3 kg, Flour 10 kg, Cups 1 dz = 12000 + 30000 + 6000 = 48000.
--   GRN2: Tomato 2 kg, Cups 1 dz = 8000 + 6000 = 14000. Received total 62000.
--   Invoice 1: 12000 (tomato @4000) + 32000 (flour billed @3200, +2000 variance)
--              + 6000 (cups) = 50000 + tax 2500 = 52500.
--   Invoice 2: 8000 + 6000 = 14000, no tax. Total owed 66500.
--   Payments: 20000, then 46500. Balance ends at 0.
-- ─────────────────────────────────────────────────────────────────────────

create or replace function pg_temp.ing(p_name text)
returns uuid language sql stable as $$
  select id from public.ingredients
  where business_id = 'cccccccc-0000-0000-0000-000000000001' and name = 'P14 ' || p_name;
$$;

create or replace function pg_temp.stock(p_outlet uuid, p_ingredient uuid)
returns numeric language sql stable as $$
  select coalesce((select on_hand from public.inventory_stock
    where outlet_id = p_outlet and ingredient_id = p_ingredient), 0);
$$;

create or replace function pg_temp.supplier(p_name text)
returns uuid language sql stable as $$
  select id from public.suppliers
  where business_id = 'cccccccc-0000-0000-0000-000000000001' and name = p_name;
$$;

create or replace function pg_temp.try_supplier(p_actor uuid, p_id uuid, p_name text, p_gstin text, p_terms integer)
returns text language plpgsql as $$
begin
  return 'ok:' || public.supplier_save(p_actor, 'cccccccc-0000-0000-0000-000000000001', p_id,
    p_name, null, null, null, p_gstin, null, p_terms, 'active', null)::text;
exception when others then
  return 'err:' || sqlerrm;
end $$;

create or replace function pg_temp.try_po(p_actor uuid, p_outlet uuid, p_supplier uuid, p_id uuid, p_lines jsonb)
returns text language plpgsql as $$
begin
  return 'ok:' || public.purchase_order_save(p_actor, p_outlet, p_supplier, p_id, null, null, p_lines)::text;
exception when others then
  return 'err:' || sqlerrm;
end $$;

create or replace function pg_temp.try_send(p_actor uuid, p_po uuid)
returns text language plpgsql as $$
begin
  perform public.purchase_order_send(p_actor, p_po);
  return 'ok';
exception when others then
  return 'err:' || sqlerrm;
end $$;

create or replace function pg_temp.try_cancel(p_actor uuid, p_po uuid, p_reason text)
returns text language plpgsql as $$
begin
  perform public.purchase_order_cancel(p_actor, p_po, p_reason);
  return 'ok';
exception when others then
  return 'err:' || sqlerrm;
end $$;

create or replace function pg_temp.try_grn(p_actor uuid, p_po uuid, p_ref text, p_lines jsonb)
returns text language plpgsql as $$
begin
  return 'ok:' || public.goods_receipt_post(p_actor, p_po, p_ref, 'DN-TEST', null, p_lines)::text;
exception when others then
  return 'err:' || sqlerrm;
end $$;

create or replace function pg_temp.try_invoice(
  p_actor uuid, p_outlet uuid, p_supplier uuid, p_number text,
  p_invoice_date date, p_due date, p_tax numeric, p_ref text, p_lines jsonb)
returns text language plpgsql as $$
begin
  return 'ok:' || public.purchase_invoice_post(p_actor, p_outlet, p_supplier, p_number,
    p_invoice_date, p_due, p_tax, null, p_ref, p_lines)::text;
exception when others then
  return 'err:' || sqlerrm;
end $$;

create or replace function pg_temp.try_pay(p_actor uuid, p_business uuid, p_supplier uuid, p_amount numeric, p_ref text)
returns text language plpgsql as $$
begin
  return 'ok:' || public.supplier_payment_record(p_actor, p_business, p_supplier, p_amount,
    'cash', null, 'UTR-TEST', null, p_ref)::text;
exception when others then
  return 'err:' || sqlerrm;
end $$;

\echo '── P14.0: fixtures (ingredients for purchasing, two suppliers)'
do $$
declare
  v_biz uuid := 'cccccccc-0000-0000-0000-000000000001';
  v_owner uuid := 'aaaaaaaa-0000-0000-0000-000000000001';
  v_r text;
begin
  insert into public.ingredients (business_id, name, unit, cost_per_unit, active) values
    (v_biz, 'P14 Tomato', 'g', 4, true),
    (v_biz, 'P14 Flour', 'g', 3, true),
    (v_biz, 'P14 Cups', 'pc', 500, true);

  v_r := pg_temp.try_supplier(v_owner, null, 'P14 Fresh Farms', '29ABCDE1234F1Z5', 30);
  if v_r not like 'ok:%' then raise exception 'supplier failed: %', v_r; end if;
  v_r := pg_temp.try_supplier(v_owner, null, 'P14 Packaging Co', null, 15);
  if v_r not like 'ok:%' then raise exception 'supplier failed: %', v_r; end if;
  raise notice 'OK: purchasing fixtures ready (3 ingredients, 2 suppliers)';
end $$;

\echo '── P14.1: supplier records need purchasing.manage and valid details'
do $$
declare
  v_biz uuid := 'cccccccc-0000-0000-0000-000000000001';
  v_owner uuid := 'aaaaaaaa-0000-0000-0000-000000000001';
  v_waiter uuid := 'f1111111-0000-0000-0000-000000000040';
  v_r text; v_n integer;
begin
  v_r := pg_temp.try_supplier(v_waiter, null, 'P14 Waiter Supplier', null, 0);
  if v_r !~* 'err:.*(does not allow|not assigned)' then raise exception 'waiter created a supplier: %', v_r; end if;

  v_r := pg_temp.try_supplier(v_owner, null, 'p14 fresh farms', null, 0);
  if v_r not like 'err:%already exists%' then raise exception 'duplicate supplier name accepted: %', v_r; end if;

  v_r := pg_temp.try_supplier(v_owner, null, 'P14 Bad Tax', 'NOTAGSTIN', 0);
  if v_r not like 'err:%' then raise exception 'invalid GSTIN accepted: %', v_r; end if;

  select count(*) into v_n from public.suppliers where business_id = v_biz and name like 'P14 %';
  if v_n <> 2 then raise exception 'expected 2 P14 suppliers, found %', v_n; end if;
  if (select gstin from public.suppliers where name = 'P14 Fresh Farms') <> '29ABCDE1234F1Z5' then
    raise exception 'GSTIN not stored';
  end if;
  raise notice 'OK: suppliers are restricted to purchasing.manage, unique by name, and validated';
end $$;

\echo '── P14.2: purchase orders are outlet-scoped, validated, and sent once'
do $$
declare
  v_biz uuid := 'cccccccc-0000-0000-0000-000000000001';
  v_owner uuid := 'aaaaaaaa-0000-0000-0000-000000000001';
  v_manager uuid := 'f1111111-0000-0000-0000-000000000060';
  v_branch_manager uuid := 'f1111111-0000-0000-0000-000000000061';
  v_waiter uuid := 'f1111111-0000-0000-0000-000000000040';
  v_kitchen uuid := 'f1111111-0000-0000-0000-000000000020';
  v_main uuid; v_farms uuid; v_po uuid; v_po2 uuid; v_r text; v_lines jsonb; v_n integer; v_subtotal numeric;
begin
  select id into v_main from public.outlets where business_id = v_biz and slug = 'main';
  v_farms := pg_temp.supplier('P14 Fresh Farms');
  v_lines := jsonb_build_array(
    jsonb_build_object('ingredient_id', pg_temp.ing('Tomato'), 'unit', 'kg', 'qty', 5, 'unit_cost', 4000),
    jsonb_build_object('ingredient_id', pg_temp.ing('Flour'), 'unit', 'kg', 'qty', 10, 'unit_cost', 3000),
    jsonb_build_object('ingredient_id', pg_temp.ing('Cups'), 'unit', 'dz', 'qty', 2, 'unit_cost', 6000));

  v_r := pg_temp.try_po(v_waiter, v_main, v_farms, null, v_lines);
  if v_r !~* 'err:.*(does not allow|not assigned)' then raise exception 'waiter created an order: %', v_r; end if;
  v_r := pg_temp.try_po(v_kitchen, v_main, v_farms, null, v_lines);
  if v_r !~* 'err:.*(does not allow|not assigned)' then raise exception 'kitchen created an order: %', v_r; end if;
  v_r := pg_temp.try_po(v_branch_manager, v_main, v_farms, null, v_lines);
  if v_r !~* 'err:.*(does not allow|not assigned)' then raise exception 'branch manager ordered for main: %', v_r; end if;

  v_r := pg_temp.try_po(v_manager, v_main, v_farms, null, v_lines);
  if v_r not like 'ok:%' then raise exception 'order failed: %', v_r; end if;
  v_po := substring(v_r from 4)::uuid;
  perform set_config('p14.po1', v_po::text, false);

  select count(*) into v_n from public.purchase_order_items where purchase_order_id = v_po;
  select subtotal_minor into v_subtotal from public.purchase_orders where id = v_po;
  if v_n <> 3 then raise exception 'PO1 has % lines, expected 3', v_n; end if;
  if v_subtotal <> 62000 then raise exception 'PO1 subtotal % , expected 62000', v_subtotal; end if;
  if (select qty_ordered_base from public.purchase_order_items where purchase_order_id = v_po and ingredient_id = pg_temp.ing('Cups')) <> 24 then
    raise exception 'cups not converted to 24 pc';
  end if;
  if (select status from public.purchase_orders where id = v_po) <> 'draft' then raise exception 'new order not draft'; end if;

  -- one line per ingredient; units must fit the ingredient; quantities must be positive
  v_r := pg_temp.try_po(v_manager, v_main, v_farms, null, jsonb_build_array(
    jsonb_build_object('ingredient_id', pg_temp.ing('Tomato'), 'unit', 'kg', 'qty', 1, 'unit_cost', 4000),
    jsonb_build_object('ingredient_id', pg_temp.ing('Tomato'), 'unit', 'kg', 'qty', 1, 'unit_cost', 4000)));
  if v_r not like 'err:%once per order%' then raise exception 'duplicate ingredient accepted: %', v_r; end if;
  v_r := pg_temp.try_po(v_manager, v_main, v_farms, null, jsonb_build_array(
    jsonb_build_object('ingredient_id', pg_temp.ing('Tomato'), 'unit', 'pc', 'qty', 1, 'unit_cost', 4000)));
  if v_r not like 'err:%' then raise exception 'mismatched unit accepted: %', v_r; end if;
  v_r := pg_temp.try_po(v_manager, v_main, v_farms, null, jsonb_build_array(
    jsonb_build_object('ingredient_id', pg_temp.ing('Flour'), 'unit', 'kg', 'qty', 0, 'unit_cost', 3000)));
  if v_r not like 'err:%more than zero%' then raise exception 'zero quantity accepted: %', v_r; end if;

  -- a draft can be edited; once sent it cannot
  v_r := pg_temp.try_po(v_manager, v_main, v_farms, v_po, v_lines);
  if v_r <> 'ok:' || v_po::text then raise exception 'draft edit failed: %', v_r; end if;
  if (select count(*) from public.purchase_order_items where purchase_order_id = v_po) <> 3 then
    raise exception 'draft edit did not replace the lines';
  end if;

  v_r := pg_temp.try_send(v_waiter, v_po);
  if v_r !~* 'err:.*(does not allow|not assigned)' then raise exception 'waiter sent an order: %', v_r; end if;
  if pg_temp.try_send(v_manager, v_po) <> 'ok' then raise exception 'send failed'; end if;
  if (select status from public.purchase_orders where id = v_po) <> 'sent' then raise exception 'order not sent'; end if;
  if pg_temp.try_send(v_manager, v_po) not like 'err:%Only draft%' then raise exception 'order sent twice'; end if;
  v_r := pg_temp.try_po(v_manager, v_main, v_farms, v_po, v_lines);
  if v_r not like 'err:%Only draft orders can be edited%' then raise exception 'sent order edited: %', v_r; end if;

  -- a second order, cancelled while still a draft
  v_r := pg_temp.try_po(v_manager, v_main, v_farms, null, jsonb_build_array(
    jsonb_build_object('ingredient_id', pg_temp.ing('Cups'), 'unit', 'dz', 'qty', 3, 'unit_cost', 6000)));
  v_po2 := substring(v_r from 4)::uuid;
  if pg_temp.try_cancel(v_manager, v_po2, 'x') not like 'err:%at least 3 characters%' then raise exception 'cancel without reason accepted'; end if;
  if pg_temp.try_cancel(v_manager, v_po2, 'Duplicate order') <> 'ok' then raise exception 'draft cancel failed'; end if;
  if (select status from public.purchase_orders where id = v_po2) <> 'cancelled' then raise exception 'not cancelled'; end if;
  perform set_config('p14.po2', v_po2::text, false);
  raise notice 'OK: orders are outlet-scoped, validated, editable only as drafts, sent once, and cancellable while unreceived';
end $$;

\echo '── P14.3: goods receipts post to the ledger, reject over-receipt, and are idempotent'
do $$
declare
  v_biz uuid := 'cccccccc-0000-0000-0000-000000000001';
  v_manager uuid := 'f1111111-0000-0000-0000-000000000060';
  v_branch_manager uuid := 'f1111111-0000-0000-0000-000000000061';
  v_waiter uuid := 'f1111111-0000-0000-0000-000000000040';
  v_po uuid := current_setting('p14.po1')::uuid;
  v_po2 uuid := current_setting('p14.po2')::uuid;
  v_main uuid; v_r text; v_grn uuid; v_again text; v_n integer; v_value numeric;
  v_tomato uuid := pg_temp.ing('Tomato'); v_flour uuid := pg_temp.ing('Flour'); v_cups uuid := pg_temp.ing('Cups');
  v_po_tomato uuid; v_po_flour uuid; v_po_cups uuid; v_po2_cups uuid;
begin
  select id into v_main from public.outlets where business_id = v_biz and slug = 'main';
  select id into v_po_tomato from public.purchase_order_items where purchase_order_id = v_po and ingredient_id = v_tomato;
  select id into v_po_flour from public.purchase_order_items where purchase_order_id = v_po and ingredient_id = v_flour;
  select id into v_po_cups from public.purchase_order_items where purchase_order_id = v_po and ingredient_id = v_cups;
  select id into v_po2_cups from public.purchase_order_items where purchase_order_id = v_po2;

  -- refusals
  v_r := pg_temp.try_grn(v_waiter, v_po, 'p14-grn-waiter', jsonb_build_array(
    jsonb_build_object('po_item_id', v_po_tomato, 'qty', 1, 'unit', 'kg')));
  if v_r !~* 'err:.*(does not allow|not assigned)' then raise exception 'waiter received stock: %', v_r; end if;
  v_r := pg_temp.try_grn(v_branch_manager, v_po, 'p14-grn-branch', jsonb_build_array(
    jsonb_build_object('po_item_id', v_po_tomato, 'qty', 1, 'unit', 'kg')));
  if v_r !~* 'err:.*(does not allow|not assigned)' then raise exception 'branch manager received at main: %', v_r; end if;
  v_r := pg_temp.try_grn(v_manager, v_po, 'p14-grn-over', jsonb_build_array(
    jsonb_build_object('po_item_id', v_po_tomato, 'qty', 6, 'unit', 'kg')));
  if v_r not like 'err:%More than ordered%' then raise exception 'over-receipt accepted: %', v_r; end if;
  v_r := pg_temp.try_grn(v_manager, v_po, 'p14-grn-expired', jsonb_build_array(
    jsonb_build_object('po_item_id', v_po_flour, 'qty', 1, 'unit', 'kg', 'batch_code', 'OLD', 'expires_on', '2000-01-01')));
  if v_r not like 'err:%already expired%' then raise exception 'expired batch accepted: %', v_r; end if;
  v_r := pg_temp.try_grn(v_manager, v_po, 'p14-grn-foreign', jsonb_build_array(
    jsonb_build_object('po_item_id', v_po2_cups, 'qty', 1, 'unit', 'dz')));
  if v_r not like 'err:%does not belong%' then raise exception 'foreign line accepted: %', v_r; end if;
  if (select count(*) from public.goods_receipts where purchase_order_id = v_po) <> 0 then
    raise exception 'a refused receipt left a receipt behind';
  end if;

  -- GRN1: a partial delivery of everything
  v_r := pg_temp.try_grn(v_manager, v_po, 'p14-grn-0001', jsonb_build_array(
    jsonb_build_object('po_item_id', v_po_tomato, 'qty', 3, 'unit', 'kg', 'batch_code', 'TOM-1', 'expires_on', '2099-01-01'),
    jsonb_build_object('po_item_id', v_po_flour, 'qty', 10, 'unit', 'kg', 'batch_code', 'FLR-1', 'expires_on', '2099-06-01'),
    jsonb_build_object('po_item_id', v_po_cups, 'qty', 1, 'unit', 'dz', 'batch_code', 'CUP-1')));
  if v_r not like 'ok:%' then raise exception 'GRN1 failed: %', v_r; end if;
  v_grn := substring(v_r from 4)::uuid;
  perform set_config('p14.grn1', v_grn::text, false);

  if (select count(*) from public.goods_receipt_items where goods_receipt_id = v_grn) <> 3 then
    raise exception 'GRN1 should have 3 lines';
  end if;
  -- every receipt line created exactly one ledger receipt, valued at the order cost
  select count(*), coalesce(sum(m.value_minor), 0) into v_n, v_value
  from public.inventory_movements m
  join public.goods_receipt_items gri on m.reference_key = 'grn:' || gri.id::text
  where gri.goods_receipt_id = v_grn and m.kind = 'receipt';
  if v_n <> 3 then raise exception 'GRN1 produced % ledger receipts, expected 3', v_n; end if;
  if v_value <> 48000 then raise exception 'GRN1 ledger value % , expected 48000', v_value; end if;
  if pg_temp.stock(v_main, v_tomato) <> 3000 then raise exception 'tomato on hand after GRN1 wrong'; end if;
  if pg_temp.stock(v_main, v_flour) <> 10000 then raise exception 'flour on hand after GRN1 wrong'; end if;
  if pg_temp.stock(v_main, v_cups) <> 12 then raise exception 'cups on hand after GRN1 wrong'; end if;
  if (select status from public.purchase_orders where id = v_po) <> 'partially_received' then
    raise exception 'PO1 not partially received after GRN1';
  end if;

  -- a retry with the same reference returns the same receipt and books nothing new
  v_again := pg_temp.try_grn(v_manager, v_po, 'p14-grn-0001', jsonb_build_array(
    jsonb_build_object('po_item_id', v_po_tomato, 'qty', 3, 'unit', 'kg')));
  if v_again <> 'ok:' || v_grn::text then raise exception 'retry did not return the same receipt: %', v_again; end if;
  if (select count(*) from public.goods_receipts where purchase_order_id = v_po) <> 1 then
    raise exception 'retry created a second receipt';
  end if;
  if (select count(*) from public.inventory_movements where reference_key like 'grn:%') <> 3 then
    raise exception 'retry booked extra ledger receipts';
  end if;

  -- over-receipt against the cups that are now partly received
  v_r := pg_temp.try_grn(v_manager, v_po, 'p14-grn-cups-over', jsonb_build_array(
    jsonb_build_object('po_item_id', v_po_cups, 'qty', 2, 'unit', 'dz')));
  if v_r not like 'err:%More than ordered%' then raise exception 'cups over-receipt accepted: %', v_r; end if;
  -- a partly received order cannot be cancelled (status moves to partially_received on receipt)
  if pg_temp.try_cancel(v_manager, v_po, 'changed mind') not like 'err:%Only draft or sent orders can be cancelled%' then
    raise exception 'partly received order cancelled';
  end if;
  raise notice 'OK: GRN1 booked three receipts worth 48000 and refused over-receipt, expired and foreign lines';
end $$;

\echo '── P14.4: the rest of the order completes the receipts; the order closes'
do $$
declare
  v_biz uuid := 'cccccccc-0000-0000-0000-000000000001';
  v_manager uuid := 'f1111111-0000-0000-0000-000000000060';
  v_po uuid := current_setting('p14.po1')::uuid;
  v_main uuid; v_r text; v_n integer; v_value numeric;
  v_po_tomato uuid; v_po_cups uuid;
begin
  select id into v_main from public.outlets where business_id = v_biz and slug = 'main';
  select id into v_po_tomato from public.purchase_order_items where purchase_order_id = v_po and ingredient_id = pg_temp.ing('Tomato');
  select id into v_po_cups from public.purchase_order_items where purchase_order_id = v_po and ingredient_id = pg_temp.ing('Cups');

  v_r := pg_temp.try_grn(v_manager, v_po, 'p14-grn-0002', jsonb_build_array(
    jsonb_build_object('po_item_id', v_po_tomato, 'qty', 2, 'unit', 'kg', 'batch_code', 'TOM-2', 'expires_on', '2099-02-01'),
    jsonb_build_object('po_item_id', v_po_cups, 'qty', 1, 'unit', 'dz', 'batch_code', 'CUP-2')));
  if v_r not like 'ok:%' then raise exception 'GRN2 failed: %', v_r; end if;
  perform set_config('p14.grn2', substring(v_r from 4), false);

  if (select status from public.purchase_orders where id = v_po) <> 'received' then
    raise exception 'PO1 not received after the final delivery';
  end if;
  if (select count(*) from public.goods_receipts where purchase_order_id = v_po) <> 2 then
    raise exception 'PO1 should have two receipts';
  end if;
  select coalesce(sum(m.value_minor), 0) into v_value
  from public.inventory_movements m
  join public.goods_receipt_items gri on m.reference_key = 'grn:' || gri.id::text
  join public.goods_receipts gr on gr.id = gri.goods_receipt_id
  where gr.purchase_order_id = v_po and m.kind = 'receipt';
  if v_value <> 62000 then raise exception 'received value % does not equal the order subtotal 62000', v_value; end if;
  if pg_temp.stock(v_main, pg_temp.ing('Tomato')) <> 5000 then raise exception 'tomato on hand wrong after GRN2'; end if;
  if pg_temp.stock(v_main, pg_temp.ing('Cups')) <> 24 then raise exception 'cups on hand wrong after GRN2'; end if;

  if pg_temp.try_grn(v_manager, v_po, 'p14-grn-late', jsonb_build_array(
    jsonb_build_object('po_item_id', v_po_cups, 'qty', 1, 'unit', 'dz'))) not like 'err:%not open for receiving%' then
    raise exception 'received order accepted another receipt';
  end if;
  if pg_temp.try_cancel(v_manager, v_po, 'changed mind') not like 'err:%Only draft or sent orders can be cancelled%' then
    raise exception 'received order cancelled';
  end if;
  raise notice 'OK: GRN2 closes the order; the ledger holds exactly the 62000 ordered; a closed order refuses receipts';
end $$;

\echo '── P14.5: supplier invoices bill received lines once, from one supplier and outlet'
do $$
declare
  v_biz uuid := 'cccccccc-0000-0000-0000-000000000001';
  v_manager uuid := 'f1111111-0000-0000-0000-000000000060';
  v_branch_manager uuid := 'f1111111-0000-0000-0000-000000000061';
  v_waiter uuid := 'f1111111-0000-0000-0000-000000000040';
  v_main uuid; v_farms uuid; v_packaging uuid;
  v_tom1 uuid; v_flr1 uuid; v_cup1 uuid; v_tom2 uuid; v_cup2 uuid;
  v_r text; v_inv1 uuid; v_inv2 uuid; v_total numeric; v_sub numeric; v_tax numeric; v_items integer;
  v_today date := public.business_today();
begin
  select id into v_main from public.outlets where business_id = v_biz and slug = 'main';
  v_farms := pg_temp.supplier('P14 Fresh Farms');
  v_packaging := pg_temp.supplier('P14 Packaging Co');
  select gri.id into v_tom1 from public.goods_receipt_items gri where gri.batch_code = 'TOM-1';
  select gri.id into v_flr1 from public.goods_receipt_items gri where gri.batch_code = 'FLR-1';
  select gri.id into v_cup1 from public.goods_receipt_items gri where gri.batch_code = 'CUP-1';
  select gri.id into v_tom2 from public.goods_receipt_items gri where gri.batch_code = 'TOM-2';
  select gri.id into v_cup2 from public.goods_receipt_items gri where gri.batch_code = 'CUP-2';

  v_r := pg_temp.try_invoice(v_waiter, v_main, v_farms, 'FF-0', v_today, v_today + 30, 0, 'p14-inv-waiter',
    jsonb_build_array(jsonb_build_object('goods_receipt_item_id', v_tom1, 'unit_cost', 4000)));
  if v_r !~* 'err:.*(does not allow|not assigned)' then raise exception 'waiter billed a supplier: %', v_r; end if;
  v_r := pg_temp.try_invoice(v_branch_manager, v_main, v_farms, 'FF-0', v_today, v_today + 30, 0, 'p14-inv-branch',
    jsonb_build_array(jsonb_build_object('goods_receipt_item_id', v_tom1, 'unit_cost', 4000)));
  if v_r !~* 'err:.*(does not allow|not assigned)' then raise exception 'branch manager billed main: %', v_r; end if;
  v_r := pg_temp.try_invoice(v_manager, v_main, v_packaging, 'PC-1', v_today, v_today + 15, 0, 'p14-inv-wrong',
    jsonb_build_array(jsonb_build_object('goods_receipt_item_id', v_tom1, 'unit_cost', 4000)));
  if v_r not like 'err:%different supplier%' then raise exception 'wrong supplier billed: %', v_r; end if;
  v_r := pg_temp.try_invoice(v_manager, v_main, v_farms, 'FF-0', v_today, v_today - 1, 0, 'p14-inv-dates',
    jsonb_build_array(jsonb_build_object('goods_receipt_item_id', v_tom1, 'unit_cost', 4000)));
  if v_r not like 'err:%before the invoice date%' then raise exception 'due date before invoice accepted: %', v_r; end if;

  -- invoice 1: tomato at the order price, flour billed 200 paise/kg above the order, cups at order price, 5% tax
  v_r := pg_temp.try_invoice(v_manager, v_main, v_farms, 'FF-1001', v_today, v_today + 30, 2500, 'p14-inv-0001',
    jsonb_build_array(
      jsonb_build_object('goods_receipt_item_id', v_tom1, 'unit_cost', 4000),
      jsonb_build_object('goods_receipt_item_id', v_flr1, 'unit_cost', 3200),
      jsonb_build_object('goods_receipt_item_id', v_cup1, 'unit_cost', 6000)));
  if v_r not like 'ok:%' then raise exception 'invoice 1 failed: %', v_r; end if;
  v_inv1 := substring(v_r from 4)::uuid;
  perform set_config('p14.inv1', v_inv1::text, false);

  select subtotal_minor, total_minor into v_sub, v_total from public.purchase_invoices where id = v_inv1;
  if v_sub <> 50000 or v_total <> 52500 then raise exception 'invoice 1 totals % / % (expected 50000 / 52500)', v_sub, v_total; end if;

  -- retry returns the same invoice
  if pg_temp.try_invoice(v_manager, v_main, v_farms, 'FF-1001', v_today, v_today + 30, 2500, 'p14-inv-0001',
       jsonb_build_array(jsonb_build_object('goods_receipt_item_id', v_tom1, 'unit_cost', 4000))) <> 'ok:' || v_inv1::text then
    raise exception 'invoice retry did not return the same invoice';
  end if;

  -- same number for the same supplier is refused, whatever the case
  if pg_temp.try_invoice(v_manager, v_main, v_farms, 'ff-1001', v_today, v_today + 30, 0, 'p14-inv-dup',
       jsonb_build_array(jsonb_build_object('goods_receipt_item_id', v_tom2, 'unit_cost', 4000))) not like 'err:%already recorded%' then
    raise exception 'duplicate invoice number accepted';
  end if;
  -- a receipt line can be billed once
  if pg_temp.try_invoice(v_manager, v_main, v_farms, 'FF-1003', v_today, v_today + 30, 0, 'p14-inv-rebill',
       jsonb_build_array(jsonb_build_object('goods_receipt_item_id', v_tom1, 'unit_cost', 4000))) not like 'err:%Already billed%' then
    raise exception 'receipt line billed twice';
  end if;

  -- invoice 2: the second delivery, no tax
  v_r := pg_temp.try_invoice(v_manager, v_main, v_farms, 'FF-1002', v_today, v_today + 30, 0, 'p14-inv-0002',
    jsonb_build_array(
      jsonb_build_object('goods_receipt_item_id', v_tom2, 'unit_cost', 4000),
      jsonb_build_object('goods_receipt_item_id', v_cup2, 'unit_cost', 6000)));
  if v_r not like 'ok:%' then raise exception 'invoice 2 failed: %', v_r; end if;
  v_inv2 := substring(v_r from 4)::uuid;
  select total_minor into v_total from public.purchase_invoices where id = v_inv2;
  if v_total <> 14000 then raise exception 'invoice 2 total % , expected 14000', v_total; end if;

  select count(*) into v_items from public.purchase_invoice_items where invoice_id in (v_inv1, v_inv2);
  if v_items <> 5 then raise exception 'expected 5 billed lines, found %', v_items; end if;
  raise notice 'OK: invoices bill each receipt line once, from one supplier and outlet, with totals computed on the server';
end $$;

\echo '── P14.6: supplier payments cannot exceed the balance and are idempotent'
do $$
declare
  v_biz uuid := 'cccccccc-0000-0000-0000-000000000001';
  v_owner uuid := 'aaaaaaaa-0000-0000-0000-000000000001';
  v_waiter uuid := 'f1111111-0000-0000-0000-000000000040';
  v_farms uuid; v_owed numeric; v_r text; v_pay1 text; v_n integer;
begin
  v_farms := pg_temp.supplier('P14 Fresh Farms');
  select coalesce(sum(total_minor), 0) - (select coalesce(sum(amount_minor), 0) from public.supplier_payments where supplier_id = v_farms)
    into v_owed from public.purchase_invoices where supplier_id = v_farms;
  if v_owed <> 66500 then raise exception 'balance % , expected 66500', v_owed; end if;

  v_r := pg_temp.try_pay(v_waiter, v_biz, v_farms, 1000, 'p14-pay-waiter');
  if v_r !~* 'err:.*(does not allow|not assigned)' then raise exception 'waiter paid a supplier: %', v_r; end if;
  v_r := pg_temp.try_pay(v_owner, v_biz, v_farms, 70000, 'p14-pay-over');
  if v_r not like 'err:%more than the amount owed%' then raise exception 'overpayment accepted: %', v_r; end if;

  v_pay1 := pg_temp.try_pay(v_owner, v_biz, v_farms, 20000, 'p14-pay-0001');
  if v_pay1 not like 'ok:%' then raise exception 'payment failed: %', v_pay1; end if;
  if pg_temp.try_pay(v_owner, v_biz, v_farms, 20000, 'p14-pay-0001') <> v_pay1 then
    raise exception 'payment retry was not idempotent';
  end if;
  select count(*) into v_n from public.supplier_payments where supplier_id = v_farms;
  if v_n <> 1 then raise exception 'retry recorded a second payment'; end if;

  -- pay the rest, to the paisa
  if pg_temp.try_pay(v_owner, v_biz, v_farms, 46500, 'p14-pay-0002') not like 'ok:%' then raise exception 'final payment refused'; end if;
  select coalesce(sum(total_minor), 0) - (select coalesce(sum(amount_minor), 0) from public.supplier_payments where supplier_id = v_farms)
    into v_owed from public.purchase_invoices where supplier_id = v_farms;
  if v_owed <> 0 then raise exception 'balance after payment % , expected 0', v_owed; end if;
  if pg_temp.try_pay(v_owner, v_biz, v_farms, 1, 'p14-pay-0003') not like 'err:%more than the amount owed%' then
    raise exception 'payment accepted on a zero balance';
  end if;
  raise notice 'OK: payments are capped at the balance, idempotent, and the balance closes to zero';
end $$;

\echo '── P14.7: posted purchasing records cannot be changed or deleted'
do $$
declare
  v_grn uuid := current_setting('p14.grn1')::uuid;
  v_inv uuid := current_setting('p14.inv1')::uuid;
  v_pay uuid;
begin
  select id into v_pay from public.supplier_payments limit 1;
  begin
    update public.goods_receipts set delivery_note = 'edited' where id = v_grn;
    raise exception 'RECEIPT_UPDATED';
  exception when others then
    if sqlerrm = 'RECEIPT_UPDATED' then raise exception 'posted receipt was edited'; end if;
  end;
  begin
    delete from public.goods_receipt_items where goods_receipt_id = v_grn;
    raise exception 'RECEIPT_LINE_DELETED';
  exception when others then
    if sqlerrm = 'RECEIPT_LINE_DELETED' then raise exception 'receipt line was deleted'; end if;
  end;
  begin
    update public.purchase_invoices set notes = 'edited' where id = v_inv;
    raise exception 'INVOICE_UPDATED';
  exception when others then
    if sqlerrm = 'INVOICE_UPDATED' then raise exception 'posted invoice was edited'; end if;
  end;
  begin
    delete from public.supplier_payments where id = v_pay;
    raise exception 'PAYMENT_DELETED';
  exception when others then
    if sqlerrm = 'PAYMENT_DELETED' then raise exception 'payment was deleted'; end if;
  end;
  raise notice 'OK: receipts, invoice lines, invoices and payments refuse update and delete';
end $$;

\echo '── P14.8: outlet isolation and permissions on purchasing data'
do $$
declare
  v_biz uuid := 'cccccccc-0000-0000-0000-000000000001';
  v_main uuid; v_branch uuid; v_n integer;
begin
  select id into v_main from public.outlets where business_id = v_biz and slug = 'main';
  select id into v_branch from public.outlets where business_id = v_biz and slug = 'branch';

  set role authenticated;
  set request.jwt.claims = '{"sub": "f1111111-0000-0000-0000-000000000040", "role": "authenticated"}';
  select count(*) into v_n from public.suppliers;
  if v_n <> 0 then reset role; raise exception 'waiter can read suppliers (%)', v_n; end if;
  select count(*) into v_n from public.purchase_orders;
  if v_n <> 0 then reset role; raise exception 'waiter can read purchase orders (%)', v_n; end if;
  reset role;

  set role authenticated;
  set request.jwt.claims = '{"sub": "f1111111-0000-0000-0000-000000000020", "role": "authenticated"}';
  select count(*) into v_n from public.goods_receipts;
  if v_n <> 0 then reset role; raise exception 'kitchen can read receipts (%)', v_n; end if;
  select count(*) into v_n from public.supplier_payments;
  if v_n <> 0 then reset role; raise exception 'kitchen can read payments (%)', v_n; end if;
  reset role;

  set role authenticated;
  set request.jwt.claims = '{"sub": "f1111111-0000-0000-0000-000000000060", "role": "authenticated"}';
  select count(*) into v_n from public.purchase_orders where outlet_id = v_main;
  if v_n = 0 then reset role; raise exception 'main manager cannot see main orders'; end if;
  select count(*) into v_n from public.purchase_orders where outlet_id = v_branch;
  if v_n <> 0 then reset role; raise exception 'main manager sees branch orders (%)', v_n; end if;
  reset role;

  set role authenticated;
  set request.jwt.claims = '{"sub": "f1111111-0000-0000-0000-000000000061", "role": "authenticated"}';
  select count(*) into v_n from public.goods_receipts where outlet_id = v_main;
  if v_n <> 0 then reset role; raise exception 'branch manager sees main receipts (%)', v_n; end if;
  reset role;

  set role authenticated;
  set request.jwt.claims = '{"sub": "aaaaaaaa-0000-0000-0000-000000000001", "role": "authenticated"}';
  select count(*) into v_n from public.purchase_invoices;
  if v_n = 0 then reset role; raise exception 'owner cannot see invoices'; end if;
  begin
    insert into public.suppliers (business_id, name) values (v_biz, 'P14 Direct Insert');
    reset role;
    raise exception 'DIRECT_INSERT';
  exception when others then
    reset role;
    if sqlerrm = 'DIRECT_INSERT' then raise exception 'owner inserted a supplier directly'; end if;
  end;
  raise notice 'OK: waiter and kitchen see no purchasing data; managers are outlet-scoped; writes go through RPCs only';
end $$;

\echo '── P14.9: reconciliation — purchasing agrees with the ledger, and a broken record is detected'
do $$
declare
  v_biz uuid := 'cccccccc-0000-0000-0000-000000000001';
  v_owner uuid := 'aaaaaaaa-0000-0000-0000-000000000001';
  v_main uuid; v_bad integer; v_rows integer; v_variance numeric; v_flag boolean; v_inv_bad integer;
  v_gri uuid := (select id from public.goods_receipt_items where batch_code = 'CUP-2');
  v_original numeric;
begin
  select id into v_main from public.outlets where business_id = v_biz and slug = 'main';

  select count(*), count(*) filter (where not ok) into v_rows, v_bad
  from public.purchasing_reconcile(v_owner, v_main);
  if v_rows <> 6 then raise exception 'expected 6 reconciliation checks, got %', v_rows; end if;
  if v_bad <> 0 then
    raise exception 'purchasing reconciliation failed: %',
      (select string_agg(check_name || ' expected ' || expected || ' actual ' || actual, '; ')
       from public.purchasing_reconcile(v_owner, v_main) where not ok);
  end if;

  -- the stock cache and ledger still agree after receiving
  select count(*) into v_inv_bad from public.inventory_reconcile(v_owner, v_main) where not consistent;
  if v_inv_bad <> 0 then raise exception 'stock reconciliation has % inconsistent rows', v_inv_bad; end if;

  -- price variance: flour billed 3200/kg against 3000/kg ordered, on 10 kg
  select coalesce(sum((pii.unit_cost - poi.unit_cost) * pii.qty), 0) into v_variance
  from public.purchase_invoice_items pii
  join public.goods_receipt_items gri on gri.id = pii.goods_receipt_item_id
  join public.purchase_order_items poi on poi.id = gri.purchase_order_item_id;
  if v_variance <> 2000 then raise exception 'price variance % , expected 2000', v_variance; end if;

  -- detector: a receipt line altered behind the ledger must fail the value check.
  -- The immutability trigger is disabled only for this block and restored before it ends.
  alter table public.goods_receipt_items disable trigger goods_receipt_items_immutable;
  select unit_cost into v_original from public.goods_receipt_items where id = v_gri;
  update public.goods_receipt_items set unit_cost = unit_cost + 1 where id = v_gri;
  select ok into v_flag from public.purchasing_reconcile(v_owner, v_main)
    where check_name = 'Receipt value in the ledger equals the receipt lines';
  update public.goods_receipt_items set unit_cost = v_original where id = v_gri;
  alter table public.goods_receipt_items enable trigger goods_receipt_items_immutable;
  if v_flag is not false then raise exception 'reconciliation did not detect an altered receipt line'; end if;

  select count(*) into v_bad from public.purchasing_reconcile(v_owner, v_main) where not ok;
  if v_bad <> 0 then raise exception 'reconciliation still failing after restore (%)', v_bad; end if;
  raise notice 'OK: all six purchasing checks agree with the ledger; an altered receipt is detected and the record restored';
end $$;

\echo '── P14 complete'
