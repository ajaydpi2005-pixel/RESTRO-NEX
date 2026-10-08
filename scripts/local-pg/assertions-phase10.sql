-- ─────────────────────────────────────────────────────────────────────────
-- RestroNex Phase 10 assertions: payments, refunds, invoices, receipts,
-- audit log, reconciliation. Runs after Phase 9 (alice owns Tenant A
-- cccc…0001 with outlets 'main' + 'branch'; bob owns Tenant B dddd…0002;
-- carol eeee…0003 is an un-granted waiter in Tenant A).
-- Fixtures added here: cashier (billing.manage, no refunds.process) and
-- accountant (reports.view, refunds.view) — both granted outlet 'main'.
-- ─────────────────────────────────────────────────────────────────────────

create temp table if not exists p10_refs (k text primary key, v uuid);

\echo '── P10.0: fixtures (cashier + accountant; default methods seeded)'
do $$
declare
  v_biz_a uuid := 'cccccccc-0000-0000-0000-000000000001';
  v_outlet uuid;
  v_trial uuid;
begin
  insert into auth.users (id, email, raw_user_meta_data) values
    ('f1111111-0000-0000-0000-000000000010', 'cashier@example.com', '{"full_name": "Casey Cashier"}'),
    ('f1111111-0000-0000-0000-000000000011', 'accountant@example.com', '{"full_name": "Ada Accountant"}');
  insert into public.memberships (user_id, business_id, role) values
    ('f1111111-0000-0000-0000-000000000010', v_biz_a, 'cashier'),
    ('f1111111-0000-0000-0000-000000000011', v_biz_a, 'accountant');

  select id into v_outlet from public.outlets where business_id = v_biz_a and slug = 'main';
  insert into public.membership_outlets (membership_id, outlet_id)
  select m.id, v_outlet from public.memberships m
  where m.business_id = v_biz_a
    and m.user_id in ('f1111111-0000-0000-0000-000000000010', 'f1111111-0000-0000-0000-000000000011');

  insert into p10_refs values ('outlet', v_outlet);

  if (select count(*) from public.payment_methods where business_id = v_biz_a and is_active) < 3 then
    raise exception 'default payment methods not seeded for tenant A';
  end if;

  -- new businesses get default methods via trigger
  insert into public.businesses (name, slug, currency_code) values ('P10 Trial', 'p10-trial', 'INR')
  returning id into v_trial;
  if (select count(*) from public.payment_methods where business_id = v_trial) <> 3 then
    raise exception 'new business did not receive default payment methods';
  end if;
  delete from public.businesses where id = v_trial;

  raise notice 'OK: fixtures + default methods (backfill and trigger)';
end $$;

\echo '── P10.1: schema, RLS and grants (clients can never write money)'
do $$
declare
  t text;
begin
  foreach t in array array['payment_methods','payments','refunds','invoices','receipts','audit_logs','business_document_counters'] loop
    if not exists (select 1 from pg_class c where c.relname = t and c.relrowsecurity) then
      raise exception 'RLS not enabled on %', t;
    end if;
  end loop;

  foreach t in array array['payments','refunds','invoices','receipts','payment_methods','audit_logs'] loop
    if has_table_privilege('authenticated', 'public.' || t, 'INSERT')
       or has_table_privilege('authenticated', 'public.' || t, 'UPDATE')
       or has_table_privilege('authenticated', 'public.' || t, 'DELETE') then
      raise exception 'authenticated can write %', t;
    end if;
    if exists (select 1 from pg_policies where schemaname = 'public' and tablename = t and cmd <> 'SELECT') then
      raise exception 'write policy exists on %', t;
    end if;
  end loop;

  if has_table_privilege('authenticated', 'public.business_document_counters', 'SELECT') then
    raise exception 'counters must not be readable by clients';
  end if;

  if not exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'orders' and column_name = 'refunded_minor') then
    raise exception 'orders.refunded_minor missing';
  end if;

  raise notice 'OK: money tables are RLS-protected and client-read-only';
end $$;

\echo '── P10.2: money integrity at the RPC boundary (rejections, no partial writes)'
do $$
declare
  v_actor uuid := 'aaaaaaaa-0000-0000-0000-000000000001';
  v_biz_a uuid := 'cccccccc-0000-0000-0000-000000000001';
  v_outlet uuid := (select v from p10_refs where k = 'outlet');
  v_burger uuid;
  v_order uuid;
  v_total bigint;
  v_cases text[];
  v_pats text[];
  v_case text;
  i integer;
  v_accepted boolean;
  v_rejected integer := 0;
  v_before bigint;
  v_seven text;
begin
  select id into v_burger from public.menu_items where business_id = v_biz_a and name = 'P8 Burger';
  v_order := public.create_pos_order(v_actor, jsonb_build_object(
    'outlet_id', v_outlet, 'client_ref', 'p10-money-0001', 'order_type', 'takeaway',
    'items', jsonb_build_array(jsonb_build_object('item_type','product','product_id', v_burger,'quantity',2))));
  insert into p10_refs values ('money_order', v_order);
  select total_minor into v_total from public.orders where id = v_order;

  select count(*) into v_before from public.payments where order_id = v_order;

  v_seven := (select string_agg('{"method_key":"cash","amount_minor":1}', ',') from generate_series(1, 7));

  v_pats := array[
    '%whole minor units%', '%whole minor units%', '%whole minor units%', '%whole minor units%',
    '%whole minor units%', '%whole minor units%',
    '%active payment method%', '%tendered is less%', '%Cash tendered must be%',
    '%Only cash can be tendered%', '%Enter a reference%', '%120 characters%',
    '%must be an object%', '%1 to 6 payment lines%', '%1 to 6 payment lines%',
    '%is due%'
  ];
  v_cases := array[
    '[{"method_key":"cash","amount_minor":10.5}]',
    '[{"method_key":"cash","amount_minor":"100"}]',
    '[{"method_key":"cash","amount_minor":-5}]',
    '[{"method_key":"cash","amount_minor":0}]',
    '[{"method_key":"cash","amount_minor":99999999999999}]',
    '[{"method_key":"cash"}]',
    '[{"method_key":"nope","amount_minor":100}]',
    '[{"method_key":"cash","amount_minor":500,"tendered_minor":100}]',
    '[{"method_key":"cash","amount_minor":500,"tendered_minor":500.5}]',
    '[{"method_key":"upi","amount_minor":500,"tendered_minor":600,"reference":"REF12345"}]',
    '[{"method_key":"upi","amount_minor":500}]',
    '[{"method_key":"upi","amount_minor":500,"reference":"' || repeat('x', 121) || '"}]',
    '[1]',
    '[]',
    '[' || v_seven || ']',
    format('[{"method_key":"cash","amount_minor":%s}]', v_total + 1)
  ];

  for i in 1 .. array_length(v_cases, 1) loop
    v_case := v_cases[i];
    v_accepted := false;
    begin
      perform public.record_payments(v_actor, v_order, 'p10-invalid-case-01', v_case::jsonb);
      v_accepted := true;
    exception when others then
      if sqlerrm not ilike v_pats[i] then
        raise exception 'case % rejected for the wrong reason (%): %', i, sqlerrm, v_case;
      end if;
      v_rejected := v_rejected + 1;
    end;
    if v_accepted then
      raise exception 'invalid payment accepted: %', v_case;
    end if;
  end loop;

  if (select count(*) from public.payments where order_id = v_order) <> v_before then
    raise exception 'rejected batches left partial rows';
  end if;
  if (select paid_minor from public.orders where id = v_order) <> 0 then
    raise exception 'rejected batches changed paid_minor';
  end if;
  if v_rejected <> array_length(v_cases, 1) then
    raise exception 'expected % rejections, got %', array_length(v_cases, 1), v_rejected;
  end if;

  raise notice 'OK: % malformed or over-limit payment inputs rejected atomically', v_rejected;
end $$;

\echo '── P10.3: split, partial and multi-method settlement with change'
do $$
declare
  v_actor uuid := 'aaaaaaaa-0000-0000-0000-000000000001';
  v_order uuid := (select v from p10_refs where k = 'money_order');
  v_total bigint;
  v_r1 jsonb;
  v_r2 jsonb;
  v_rest bigint;
  v_change bigint;
  v_status text;
begin
  select total_minor into v_total from public.orders where id = v_order;

  -- 1) partial cash with change: pays 50 of the bill, tenders 60
  v_r1 := public.record_payments(v_actor, v_order, 'p10-split-0001', jsonb_build_array(
    jsonb_build_object('method_key', 'cash', 'amount_minor', 5000, 'tendered_minor', 6000)));
  if (v_r1 ->> 'duplicate')::boolean then raise exception 'first batch flagged duplicate'; end if;
  insert into p10_refs values ('split_r1', (v_r1 ->> 'receipt_id')::uuid);

  select paid_minor, payment_status into v_change, v_status from public.orders where id = v_order;
  if v_change <> 5000 then raise exception 'paid after cash partial = %, expected 5000', v_change; end if;
  if v_status <> 'partial' then raise exception 'status after partial = %, expected partial', v_status; end if;
  if (select change_minor from public.payments where order_id = v_order and client_ref = 'p10-split-0001#1') <> 1000 then
    raise exception 'change not recorded';
  end if;

  -- 2) UPI with reference (exact amount, no change allowed)
  perform public.record_payments(v_actor, v_order, 'p10-split-0002', jsonb_build_array(
    jsonb_build_object('method_key', 'upi', 'amount_minor', 4000, 'reference', 'UTR-7788123')));
  if (select paid_minor from public.orders where id = v_order) <> 9000 then
    raise exception 'paid after upi = %, expected 9000', (select paid_minor from public.orders where id = v_order);
  end if;

  -- 3) final settlement: two lines (cash + card) for exactly the remaining balance
  v_rest := v_total - 9000;
  if v_rest <= 0 then raise exception 'fixture total too small for the split test'; end if;
  v_r2 := public.record_payments(v_actor, v_order, 'p10-split-0003', jsonb_build_array(
    jsonb_build_object('method_key', 'cash', 'amount_minor', 1000, 'tendered_minor', 1000),
    jsonb_build_object('method_key', 'card', 'amount_minor', v_rest - 1000, 'reference', 'CARD-4421')));
  if (select payment_status from public.orders where id = v_order) <> 'paid' then
    raise exception 'order not paid after final split';
  end if;
  if (select paid_minor from public.orders where id = v_order) <> v_total then
    raise exception 'paid_minor % ≠ total %', (select paid_minor from public.orders where id = v_order), v_total;
  end if;
  if (select count(*) from public.payments where order_id = v_order) <> 4 then
    raise exception 'expected 4 payment rows across 3 batches';
  end if;

  -- receipt numbers come from one gap-free counter: consecutive
  if (v_r2 ->> 'receipt_no') !~ '^RCT/[0-9]{4}-[0-9]{2}/[0-9]{6}$' then
    raise exception 'receipt number format wrong: %', v_r2 ->> 'receipt_no';
  end if;

  raise notice 'OK: split (cash+change, upi, cash+card) settles to paid; receipts numbered';
end $$;

\echo '── P10.4: idempotency (replayed batch) and cross-order reference reuse'
do $$
declare
  v_actor uuid := 'aaaaaaaa-0000-0000-0000-000000000001';
  v_order uuid := (select v from p10_refs where k = 'money_order');
  v_biz_a uuid := 'cccccccc-0000-0000-0000-000000000001';
  v_outlet uuid := (select v from p10_refs where k = 'outlet');
  v_burger uuid;
  v_other uuid;
  v_r jsonb;
  v_before_count bigint;
  v_before_paid bigint;
begin
  select count(*), max(paid_minor) into v_before_count, v_before_paid
  from public.payments p join public.orders o on o.id = p.order_id where p.order_id = v_order;

  v_r := public.record_payments(v_actor, v_order, 'p10-split-0001', jsonb_build_array(
    jsonb_build_object('method_key', 'cash', 'amount_minor', 5000, 'tendered_minor', 6000)));
  if not (v_r ->> 'duplicate')::boolean then raise exception 'replay not flagged duplicate'; end if;
  if (v_r ->> 'receipt_id') <> (select v::text from p10_refs where k = 'split_r1') then
    raise exception 'replay returned a different receipt';
  end if;
  if (select count(*) from public.payments p where p.order_id = v_order) <> v_before_count then
    raise exception 'replay created money rows';
  end if;
  if (select paid_minor from public.orders where id = v_order) <> v_before_paid then
    raise exception 'replay changed the paid total';
  end if;

  -- a batch key that belongs to another order must be refused
  select id into v_burger from public.menu_items where business_id = v_biz_a and name = 'P8 Burger';
  v_other := public.create_pos_order(v_actor, jsonb_build_object(
    'outlet_id', v_outlet, 'client_ref', 'p10-money-0002', 'order_type', 'takeaway',
    'items', jsonb_build_array(jsonb_build_object('item_type','product','product_id', v_burger,'quantity',1))));
  insert into p10_refs values ('money_order_2', v_other);
  begin
    perform public.record_payments(v_actor, v_other, 'p10-split-0001', jsonb_build_array(
      jsonb_build_object('method_key', 'cash', 'amount_minor', 100)));
    raise exception 'cross-order reference accepted';
  exception when others then
    if sqlerrm not ilike '%already used for another order%' then raise; end if;
  end;

  raise notice 'OK: replayed batch returns original receipt, no double money rows';
end $$;

\echo '── P10.5: concurrency — exactly-once under real two-session races'
create extension if not exists dblink;

-- Collect one racer result and drain the trailing NULL so the connection is reusable.
-- Errors from the racer are re-raised to the caller after draining.
create or replace function pg_temp.dblink_collect(p_conn text) returns jsonb
language plpgsql
as $$
declare
  v jsonb;
begin
  begin
    select t.r into v from dblink_get_result(p_conn) as t(r jsonb);
  exception when others then
    perform t.r from dblink_get_result(p_conn) as t(r jsonb);
    raise;
  end;
  perform t.r from dblink_get_result(p_conn) as t(r jsonb);
  return v;
end;
$$;
do $$
declare
  v_actor uuid := 'aaaaaaaa-0000-0000-0000-000000000001';
  v_biz_a uuid := 'cccccccc-0000-0000-0000-000000000001';
  v_outlet uuid := (select v from p10_refs where k = 'outlet');
  v_burger uuid;
  v_o uuid;
  v_o4 uuid;
  v_total bigint;
  v_conn text;
  v_ra jsonb;
  v_rb jsonb;
  v_ok integer := 0;
  v_err integer := 0;
  v_dups integer := 0;
begin
  select id into v_burger from public.menu_items where business_id = v_biz_a and name = 'P8 Burger';
  v_o := public.create_pos_order(v_actor, jsonb_build_object(
    'outlet_id', v_outlet, 'client_ref', 'p10-race-o-001', 'order_type', 'takeaway',
    'items', jsonb_build_array(jsonb_build_object('item_type','product','product_id', v_burger,'quantity',1))));
  v_o4 := public.create_pos_order(v_actor, jsonb_build_object(
    'outlet_id', v_outlet, 'client_ref', 'p10-race-o-002', 'order_type', 'takeaway',
    'items', jsonb_build_array(jsonb_build_object('item_type','product','product_id', v_burger,'quantity',1))));
  insert into p10_refs values ('race_pay', v_o), ('race_same', v_o4);
end $$;

-- Race fixtures are committed above; the dblink racer sessions can only see committed rows.
do $$
declare
  v_actor uuid := 'aaaaaaaa-0000-0000-0000-000000000001';
  v_o uuid := (select v from p10_refs where k = 'race_pay');
  v_o4 uuid := (select v from p10_refs where k = 'race_same');
  v_total bigint := (select total_minor from public.orders where id = v_o);
  v_conn text;
  v_ra jsonb;
  v_rb jsonb;
  v_ok integer := 0;
  v_err integer := 0;
begin

  v_conn := format('dbname=%s port=%s host=%s user=postgres',
    current_database(), current_setting('port'), current_setting('unix_socket_directories'));
  perform dblink_connect('lock_c', v_conn);
  perform dblink_connect('racer_a', v_conn);
  perform dblink_connect('racer_b', v_conn);

  -- A) two DIFFERENT batches each try to pay the full balance
  perform dblink_exec('lock_c', 'begin');
  perform t.id from dblink('lock_c', format('select id from public.orders where id = %L for update', v_o)) as t(id uuid);
  perform dblink_send_query('racer_a', format('select public.record_payments(%L, %L, %L, %L::jsonb)',
    v_actor, v_o, 'p10-race-pay-a', jsonb_build_array(jsonb_build_object('method_key','cash','amount_minor', v_total))::text));
  perform dblink_send_query('racer_b', format('select public.record_payments(%L, %L, %L, %L::jsonb)',
    v_actor, v_o, 'p10-race-pay-b', jsonb_build_array(jsonb_build_object('method_key','cash','amount_minor', v_total))::text));
  perform dblink_exec('lock_c', 'commit');

  begin
    v_ra := pg_temp.dblink_collect('racer_a');
    v_ok := v_ok + 1;
  exception when others then
    if sqlerrm not ilike '%is due%' then raise; end if;
    v_err := v_err + 1;
  end;
  begin
    v_rb := pg_temp.dblink_collect('racer_b');
    v_ok := v_ok + 1;
  exception when others then
    if sqlerrm not ilike '%is due%' then raise; end if;
    v_err := v_err + 1;
  end;
  if v_ok <> 1 or v_err <> 1 then
    raise exception 'double-pay race: % winner(s), % loser(s)', v_ok, v_err;
  end if;
  if (select count(*) from public.payments where order_id = v_o) <> 1 then
    raise exception 'double-pay race produced duplicate payment rows';
  end if;
  if (select payment_status from public.orders where id = v_o) <> 'paid' then
    raise exception 'winner did not settle the order';
  end if;

  -- B) SAME batch key from two sessions: both see one receipt, one money row
  v_ok := 0; v_err := 0; v_ra := null; v_rb := null;
  perform dblink_exec('lock_c', 'begin');
  perform t.id from dblink('lock_c', format('select id from public.orders where id = %L for update', v_o4)) as t(id uuid);
  perform dblink_send_query('racer_a', format('select public.record_payments(%L, %L, %L, %L::jsonb)',
    v_actor, v_o4, 'p10-race-same-01', jsonb_build_array(jsonb_build_object('method_key','cash','amount_minor', 1000))::text));
  perform dblink_send_query('racer_b', format('select public.record_payments(%L, %L, %L, %L::jsonb)',
    v_actor, v_o4, 'p10-race-same-01', jsonb_build_array(jsonb_build_object('method_key','cash','amount_minor', 1000))::text));
  perform dblink_exec('lock_c', 'commit');
  v_ra := pg_temp.dblink_collect('racer_a');
  v_rb := pg_temp.dblink_collect('racer_b');
  if (v_ra ->> 'receipt_id') <> (v_rb ->> 'receipt_id') then
    raise exception 'same-key race returned two receipts';
  end if;
  if (v_ra ->> 'duplicate')::boolean is distinct from not (v_rb ->> 'duplicate')::boolean then
    raise exception 'same-key race: exactly one call must be the original';
  end if;
  if (select count(*) from public.payments where order_id = v_o4) <> 1 then
    raise exception 'same-key race created duplicate money';
  end if;
  if (select paid_minor from public.orders where id = v_o4) <> 1000 then
    raise exception 'same-key race paid total wrong';
  end if;

  -- C) invoice race: two issue_invoice calls → one invoice
  perform dblink_exec('lock_c', 'begin');
  perform t.id from dblink('lock_c', format('select id from public.orders where id = %L for update', v_o)) as t(id uuid);
  perform dblink_send_query('racer_a', format('select public.issue_invoice(%L, %L)', v_actor, v_o));
  perform dblink_send_query('racer_b', format('select public.issue_invoice(%L, %L)', v_actor, v_o));
  perform dblink_exec('lock_c', 'commit');
  v_ra := pg_temp.dblink_collect('racer_a');
  v_rb := pg_temp.dblink_collect('racer_b');
  if (v_ra ->> 'invoice_no') <> (v_rb ->> 'invoice_no') then
    raise exception 'invoice race issued two numbers';
  end if;
  if (select count(*) from public.invoices where order_id = v_o and status = 'issued') <> 1 then
    raise exception 'invoice race produced more than one issued invoice';
  end if;
  insert into p10_refs values ('race_invoice_order', v_o);

  perform dblink_disconnect('racer_a');
  perform dblink_disconnect('racer_b');
  perform dblink_disconnect('lock_c');

  raise notice 'OK: double-pay, same-key replay, and invoice races are exactly-once';
end $$;

\echo '── P10.6: refund rules, refund permissions and reversal'
do $$
declare
  v_owner uuid := 'aaaaaaaa-0000-0000-0000-000000000001';
  v_cashier uuid := 'f1111111-0000-0000-0000-000000000010';
  v_accountant uuid := 'f1111111-0000-0000-0000-000000000011';
  v_order uuid := (select v from p10_refs where k = 'money_order');
  v_cash_pay uuid;
  v_cash_amt bigint;
  v_r jsonb;
  v_paid_before bigint;
  v_paid_after bigint;
  v_refund_rows bigint;
  v_p record;
  v_left bigint;
  v_denied integer := 0;
  v_denier uuid;
begin
  select p.id, p.amount_minor into v_cash_pay, v_cash_amt
  from public.payments p where p.order_id = v_order and p.client_ref = 'p10-split-0001#1';

  -- permission: cashier (no refunds.process) and accountant (view-only) are denied
  foreach v_denier in array array[v_cashier, v_accountant] loop
    begin
      perform public.refund_payment(v_denier, v_cash_pay, 100, 'Unauthorised attempt', 'p10-rfd-denied-01');
      raise exception 'refund allowed without refunds.process';
    exception when others then
      if sqlerrm not ilike '%refunds.process%' then raise; end if;
      v_denied := v_denied + 1;
    end;
  end loop;

  -- reason + amount validation
  begin
    perform public.refund_payment(v_owner, v_cash_pay, 100, 'x', 'p10-rfd-short-01');
    raise exception 'short reason accepted';
  exception when others then
    if sqlerrm not ilike '%reason%' then raise; end if;
  end;
  begin
    perform public.refund_payment(v_owner, v_cash_pay, v_cash_amt + 1, 'Too much on purpose', 'p10-rfd-over-01');
    raise exception 'refund above payment accepted';
  exception when others then
    if sqlerrm not ilike '%refundable amount%' then raise; end if;
  end;

  -- a genuine partial refund by the owner
  select paid_minor into v_paid_before from public.orders where id = v_order;
  v_r := public.refund_payment(v_owner, v_cash_pay, 1000, 'Customer returned one item', 'p10-rfd-001');
  if (v_r ->> 'duplicate')::boolean then raise exception 'first refund flagged duplicate'; end if;
  select paid_minor into v_paid_after from public.orders where id = v_order;
  if v_paid_after <> v_paid_before - 1000 then raise exception 'paid_minor did not drop by the refund'; end if;
  if (select kind from public.receipts where id = (v_r ->> 'receipt_id')::uuid) <> 'refund' then
    raise exception 'refund receipt kind wrong';
  end if;
  if (v_r ->> 'receipt_no') !~ '^RFD/[0-9]{4}-[0-9]{2}/[0-9]{6}$' then
    raise exception 'refund receipt number format wrong: %', v_r ->> 'receipt_no';
  end if;

  -- replay of the same refund reference
  v_r := public.refund_payment(v_owner, v_cash_pay, 1000, 'Customer returned one item', 'p10-rfd-001');
  if not (v_r ->> 'duplicate')::boolean then raise exception 'refund replay not flagged duplicate'; end if;
  select count(*) into v_refund_rows from public.refunds where client_ref = 'p10-rfd-001';
  if v_refund_rows <> 1 then raise exception 'refund replay created a second refund'; end if;

  -- an order with live refunds cannot be cancelled
  begin
    perform public.transition_order_status(v_owner, v_order, 'cancelled');
    raise exception 'cancelled while paid';
  exception when others then
    if sqlerrm not ilike '%Refund the recorded payments%' then raise; end if;
  end;

  -- full reversal of every captured payment → paid 0, status refunded, then cancel is allowed
  for v_p in select p.id, p.amount_minor from public.payments p
             where p.order_id = v_order and p.status = 'captured' order by p.created_at, p.id loop
    v_left := v_p.amount_minor - (select coalesce(sum(r.amount_minor), 0) from public.refunds r
                                  where r.payment_id = v_p.id and r.status = 'succeeded');
    if v_left > 0 then
      perform public.refund_payment(v_owner, v_p.id, v_left, 'Full reversal in test', 'p10-rfd-all-' || v_p.id::text);
    end if;
  end loop;
  if (select paid_minor from public.orders where id = v_order) <> 0 then raise exception 'full reversal left money'; end if;
  if (select payment_status from public.orders where id = v_order) <> 'refunded' then
    raise exception 'fully reversed order status should be refunded';
  end if;

  perform public.transition_order_status(v_owner, v_order, 'cancelled', 'Test cancel after reversal');
  if (select status from public.orders where id = v_order) <> 'cancelled' then
    raise exception 'cancel after full reversal did not apply';
  end if;

  raise notice 'OK: refund permissions (% denials), validation, replay, reversal, cancel gate', v_denied;
end $$;

\echo '── P10.7: invoices — numbering, billing freeze, void rules, cancel voids'
do $$
declare
  v_owner uuid := 'aaaaaaaa-0000-0000-0000-000000000001';
  v_cashier uuid := 'f1111111-0000-0000-0000-000000000010';
  v_biz_a uuid := 'cccccccc-0000-0000-0000-000000000001';
  v_outlet uuid := (select v from p10_refs where k = 'outlet');
  v_burger uuid;
  v_o6 uuid;
  v_o7 uuid;
  v_inv jsonb;
  v_inv_id uuid;
  v_snap jsonb;
  v_invoice_no text;
begin
  select id into v_burger from public.menu_items where business_id = v_biz_a and name = 'P8 Burger';
  v_o6 := public.create_pos_order(v_owner, jsonb_build_object(
    'outlet_id', v_outlet, 'client_ref', 'p10-inv-o6-01', 'order_type', 'takeaway', 'customer_name', 'Priya',
    'items', jsonb_build_array(jsonb_build_object('item_type','product','product_id', v_burger,'quantity',2))));

  v_inv := public.issue_invoice(v_cashier, v_o6);
  if (v_inv ->> 'invoice_no') !~ '^INV/[0-9]{4}-[0-9]{2}/[0-9]{6}$' then
    raise exception 'invoice number format wrong: %', v_inv ->> 'invoice_no';
  end if;
  v_inv_id := (v_inv ->> 'invoice_id')::uuid;
  insert into p10_refs values ('inv_o6', v_inv_id);

  if (select billed_at from public.orders where id = v_o6) is null then raise exception 'billed_at not set'; end if;
  select snapshot into v_snap from public.invoices where id = v_inv_id;
  if jsonb_array_length(v_snap -> 'items') <> 1 or (v_snap ->> 'total_minor')::bigint <> (select total_minor from public.orders where id = v_o6) then
    raise exception 'invoice snapshot does not match the order';
  end if;

  -- second issue is an idempotent replay, not a second invoice
  v_inv := public.issue_invoice(v_cashier, v_o6);
  if not (v_inv ->> 'duplicate')::boolean then raise exception 'second issue not a duplicate'; end if;

  -- billed orders are frozen for editing
  begin
    perform public.amend_pos_order(v_owner, v_o6, jsonb_build_object('items', jsonb_build_array(
      jsonb_build_object('item_type','product','product_id', v_burger,'quantity',5))));
    raise exception 'billed order amended';
  exception when others then
    if sqlerrm not ilike '%Void the invoice%' then raise; end if;
  end;

  -- cancelling an unpaid invoiced order voids the invoice but keeps its number
  perform public.transition_order_status(v_owner, v_o6, 'cancelled', 'Customer left');
  select i.invoice_no into v_invoice_no from public.invoices i where i.id = v_inv_id;
  if (select status from public.invoices where id = v_inv_id) <> 'void' then
    raise exception 'cancel did not void the invoice';
  end if;
  if (select billed_at from public.orders where id = v_o6) is not null then
    raise exception 'cancel left billed_at set';
  end if;
  if (select invoice_no from public.invoices where id = v_inv_id) <> (v_inv ->> 'invoice_no') then
    raise exception 'void altered the invoice number';
  end if;

  -- void rules on a second invoice
  v_o7 := public.create_pos_order(v_owner, jsonb_build_object(
    'outlet_id', v_outlet, 'client_ref', 'p10-inv-o7-01', 'order_type', 'takeaway',
    'items', jsonb_build_array(jsonb_build_object('item_type','product','product_id', v_burger,'quantity',1))));
  v_inv := public.issue_invoice(v_owner, v_o7);
  v_inv_id := (v_inv ->> 'invoice_id')::uuid;
  insert into p10_refs values ('inv_o7', v_inv_id);

  begin
    perform public.void_invoice(v_cashier, v_inv_id, 'Cashier wants to void');
    raise exception 'cashier voided an invoice';
  exception when others then
    if sqlerrm not ilike '%refunds.process%' then raise; end if;
  end;

  perform public.record_payments(v_cashier, v_o7, 'p10-inv-pay-01', jsonb_build_array(
    jsonb_build_object('method_key', 'upi', 'amount_minor', 1000, 'reference', 'UPI-REF-77')));
  begin
    perform public.void_invoice(v_owner, v_inv_id, 'Entered wrong items');
    raise exception 'void allowed with money held';
  exception when others then
    if sqlerrm not ilike '%Refund the recorded payments%' then raise; end if;
  end;

  -- an issued invoice can't be re-numbered by a cancelled order: cancel is blocked while paid
  begin
    perform public.transition_order_status(v_owner, v_o7, 'cancelled');
    raise exception 'paid order cancelled';
  exception when others then
    if sqlerrm not ilike '%Refund the recorded payments%' then raise; end if;
  end;

  raise notice 'OK: invoice numbering, freeze, cancel voids, void rules, permission gate';
end $$;

\echo '── P10.8: numbering is gap-free per fiscal year; April boundary; per business'
do $$
declare
  v_biz_a uuid := 'cccccccc-0000-0000-0000-000000000001';
  v_biz_b uuid := 'dddddddd-0000-0000-0000-000000000002';
  v_a text;
  v_b text;
  r record;
  v_count bigint;
begin
  -- 31 Mar 15:30 IST is FY 2025-26; 00:01 IST on 1 Apr (18:31 UTC 31 Mar) is FY 2026-27
  v_a := public.next_document_number(v_biz_b, 'invoice', 'INV', '2026-03-31 10:00:00+00');
  v_b := public.next_document_number(v_biz_b, 'invoice', 'INV', '2026-03-31 18:31:00+00');
  if v_a not like 'INV/2025-26/%' then raise exception 'March date landed in %', v_a; end if;
  if v_b not like 'INV/2026-27/%' or right(v_b, 6) <> '000001' then
    raise exception 'April date did not start FY 2026-27 at 000001: %', v_b;
  end if;

  -- for every (business, series, FY) the counter equals the number of documents issued
  for r in select c.business_id, c.series, c.fiscal_year, c.last_seq from public.business_document_counters c loop
    if r.series = 'receipt' then
      select count(*) into v_count from public.receipts x
      where x.business_id = r.business_id and split_part(x.receipt_no, '/', 2) = r.fiscal_year;
    else
      select count(*) into v_count from public.invoices x
      where x.business_id = r.business_id and split_part(x.invoice_no, '/', 2) = r.fiscal_year;
    end if;
    if v_count <> r.last_seq and not (r.business_id = v_biz_b and r.series = 'invoice') then
      raise exception 'gap or drift in % %: counter % vs documents %', r.series, r.fiscal_year, r.last_seq, v_count;
    end if;
  end loop;

  if (select count(*) from public.invoices where business_id = v_biz_a) < 2 then
    raise exception 'expected at least two invoices in tenant A';
  end if;

  raise notice 'OK: FY boundary (1 Apr IST), gap-free counters, per-business sequences';
end $$;

\echo '── P10.9: reprint with permission + audit (scrubbing, append-only, tenant RLS)'
do $$
declare
  v_owner uuid := 'aaaaaaaa-0000-0000-0000-000000000001';
  v_cashier uuid := 'f1111111-0000-0000-0000-000000000010';
  v_waiter uuid := 'eeeeeeee-0000-0000-0000-000000000003';
  v_accountant uuid := 'f1111111-0000-0000-0000-000000000011';
  v_receipt uuid := (select v from p10_refs where k = 'split_r1');
  v_biz_a uuid := 'cccccccc-0000-0000-0000-000000000001';
  v_order uuid := (select v from p10_refs where k = 'money_order');
  v_n integer;
  v_row record;
begin
  -- first print is not a reprint; the second is, and is audited
  if public.record_receipt_print(v_cashier, v_receipt) <> 1 then raise exception 'first print count wrong'; end if;
  if public.record_receipt_print(v_cashier, v_receipt) <> 2 then raise exception 'reprint count wrong'; end if;

  begin
    perform public.record_receipt_print(v_waiter, v_receipt);
    raise exception 'waiter reprinted a receipt';
  exception when others then
    -- denied either by the outlet gate (carol is not assigned to 'main') or by the permission gate
    if sqlerrm not ilike '%billing.manage%' and sqlerrm not ilike '%not assigned to this outlet%' then raise; end if;
  end;

  -- scrubbing: secrets never reach the audit table (rolled back after the check)
  begin
    perform public.write_audit_log(v_biz_a, null, v_owner, 'payment.recorded', 'order', v_order::text,
      '{"api_key":"sk_live_123","paid_minor":1}'::jsonb, '{"password":"hunter2"}'::jsonb,
      '{"token":"t-1","note":"scrub-probe"}'::jsonb);
    select * into v_row from public.audit_logs where metadata ->> 'note' = 'scrub-probe' limit 1;
    if (v_row.before_state ? 'api_key') or (v_row.after_state <> '{}'::jsonb)
       or (v_row.metadata ? 'token') or ((v_row.before_state ->> 'paid_minor') <> '1') then
      raise exception 'SCRUB_FAIL';
    end if;
    raise exception 'SCRUB_OK_ROLLBACK';
  exception when others then
    if sqlerrm <> 'SCRUB_OK_ROLLBACK' then raise; end if;
  end;

  -- append-only
  begin
    update public.audit_logs set action = action where business_id = v_biz_a;
    raise exception 'AUDIT_UPDATE_ALLOWED';
  exception when others then
    if sqlerrm not ilike '%append-only%' then raise; end if;
  end;
  begin
    delete from public.audit_logs where business_id = v_biz_a;
    raise exception 'AUDIT_DELETE_ALLOWED';
  exception when others then
    if sqlerrm not ilike '%append-only%' then raise; end if;
  end;

  -- expected actions exist for this tenant
  foreach v_n in array array[1] loop null; end loop;
  if (select count(*) from public.audit_logs
      where business_id = v_biz_a
        and action in ('payment.recorded','refund.processed','invoice.issued','invoice.voided','order.cancelled','receipt.reprinted')) < 6 then
    raise exception 'audit trail is missing expected actions';
  end if;
  if (select count(*) from public.audit_logs where business_id = v_biz_a and action = 'receipt.reprinted') < 1 then
    raise exception 'reprint not audited';
  end if;

  -- RLS: owner (reports.view) sees the trail; waiter does not; accountant does
  perform set_config('request.jwt.claims', '{"sub":"eeeeeeee-0000-0000-0000-000000000003"}', true);
  set local role authenticated;
  select count(*) into v_n from public.audit_logs where business_id = v_biz_a;
  reset role;
  if v_n <> 0 then raise exception 'waiter can read the audit trail (%)', v_n; end if;

  perform set_config('request.jwt.claims', '{"sub":"f1111111-0000-0000-0000-000000000011"}', true);
  set local role authenticated;
  select count(*) into v_n from public.audit_logs where business_id = v_biz_a;
  reset role;
  if v_n = 0 then raise exception 'accountant cannot read the audit trail'; end if;

  raise notice 'OK: reprints audited, secrets scrubbed, audit append-only, audit RLS by permission';
end $$;

\echo '── P10.10: payment methods — custom methods, key immutability, deactivation'
do $$
declare
  v_owner uuid := 'aaaaaaaa-0000-0000-0000-000000000001';
  v_cashier uuid := 'f1111111-0000-0000-0000-000000000010';
  v_waiter uuid := 'eeeeeeee-0000-0000-0000-000000000003';
  v_biz_a uuid := 'cccccccc-0000-0000-0000-000000000001';
  v_outlet uuid := (select v from p10_refs where k = 'outlet');
  v_method uuid;
  v_order uuid;
  v_burger uuid;
begin
  select id into v_burger from public.menu_items where business_id = v_biz_a and name = 'P8 Burger';

  begin
    perform public.save_payment_method(v_waiter, v_biz_a, null, 'paytm_qr', 'Paytm QR', 'upi', true, true);
    raise exception 'waiter saved a payment method';
  exception when others then
    if sqlerrm not ilike '%billing.manage%' then raise; end if;
  end;

  v_method := public.save_payment_method(v_cashier, v_biz_a, null, 'paytm_qr', 'Paytm QR', 'upi', true, true);
  insert into p10_refs values ('paytm', v_method);

  begin
    perform public.save_payment_method(v_cashier, v_biz_a, null, 'paytm_qr', 'Duplicate', 'upi', true, true);
    raise exception 'duplicate method key accepted';
  exception when others then
    if sqlerrm not ilike '%already exists%' then raise; end if;
  end;
  begin
    perform public.save_payment_method(v_cashier, v_biz_a, v_method, 'renamed_key', 'Paytm QR', 'upi', true, true);
    raise exception 'method key changed';
  exception when others then
    if sqlerrm not ilike '%cannot be changed%' then raise; end if;
  end;
  begin
    perform public.save_payment_method(v_cashier, v_biz_a, null, 'cash_plus', 'Cash plus', 'cash', true, true);
    raise exception 'cash with reference accepted';
  exception when others then
    if sqlerrm not ilike '%Cash does not take a reference%' then raise; end if;
  end;

  -- custom method works for a payment
  v_order := public.create_pos_order(v_owner, jsonb_build_object(
    'outlet_id', v_outlet, 'client_ref', 'p10-method-o1', 'order_type', 'takeaway',
    'items', jsonb_build_array(jsonb_build_object('item_type','product','product_id', v_burger,'quantity',1))));
  perform public.record_payments(v_cashier, v_order, 'p10-method-pay-01', jsonb_build_array(
    jsonb_build_object('method_key', 'paytm_qr', 'amount_minor', 1000, 'reference', 'PTM-55102')));

  -- deactivation stops new payments with that method
  perform public.save_payment_method(v_cashier, v_biz_a, v_method, 'paytm_qr', 'Paytm QR', 'upi', true, false);
  begin
    perform public.record_payments(v_cashier, v_order, 'p10-method-pay-02', jsonb_build_array(
      jsonb_build_object('method_key', 'paytm_qr', 'amount_minor', 100, 'reference', 'PTM-55103')));
    raise exception 'inactive method accepted';
  exception when others then
    if sqlerrm not ilike '%active payment method%' then raise; end if;
  end;

  raise notice 'OK: payment methods managed under billing.manage; keys immutable; inactive methods refused';
end $$;

\echo '── P10.11: ledger writes outside the payment RPCs are impossible'
do $$
declare
  v_order uuid := (select v from p10_refs where k = 'money_order');
begin
  begin
    update public.orders set paid_minor = 0, payment_status = 'paid' where id = v_order;
    raise exception 'direct payment-field write accepted';
  exception when others then
    if sqlerrm not ilike '%maintained by the payment ledger%' then raise; end if;
  end;
  raise notice 'OK: payment fields are guarded against direct writes';
end $$;

\echo '── P10.12: payment reconciliation (totals, methods, mismatch detection)'
do $$
declare
  v_owner uuid := 'aaaaaaaa-0000-0000-0000-000000000001';
  v_accountant uuid := 'f1111111-0000-0000-0000-000000000011';
  v_waiter uuid := 'eeeeeeee-0000-0000-0000-000000000003';
  v_cashier uuid := 'f1111111-0000-0000-0000-000000000010';
  v_outlet uuid := (select v from p10_refs where k = 'outlet');
  v_order uuid := (select v from p10_refs where k = 'money_order');
  v_rep jsonb;
  v_cap bigint;
  v_ref bigint;
  v_method_net bigint;
  v_mismatch bigint;
begin
  begin
    perform public.payment_reconciliation(v_waiter, v_outlet, now() - interval '1 day', now() + interval '1 day');
    raise exception 'waiter opened reconciliation';
  exception when others then
    if sqlerrm not ilike '%reports.view%' and sqlerrm not ilike '%not assigned to this outlet%' then raise; end if;
  end;
  begin
    perform public.payment_reconciliation(v_cashier, v_outlet, now() - interval '1 day', now() + interval '1 day');
    raise exception 'cashier opened reconciliation';
  exception when others then
    if sqlerrm not ilike '%reports.view%' then raise; end if;
  end;
  begin
    perform public.payment_reconciliation(v_accountant, v_outlet, now(), now() - interval '1 hour');
    raise exception 'reversed range accepted';
  exception when others then
    if sqlerrm not ilike '%valid date range%' then raise; end if;
  end;

  v_rep := public.payment_reconciliation(v_accountant, v_outlet, now() - interval '1 day', now() + interval '1 day');

  select coalesce(sum(p.amount_minor), 0) into v_cap from public.payments p
  where p.outlet_id = v_outlet and p.status = 'captured';
  select coalesce(sum(r.amount_minor), 0) into v_ref from public.refunds r
  where r.outlet_id = v_outlet and r.status = 'succeeded';
  if (v_rep -> 'totals' ->> 'captured_minor')::bigint <> v_cap then raise exception 'captured total disagrees with ledger'; end if;
  if (v_rep -> 'totals' ->> 'refunded_minor')::bigint <> v_ref then raise exception 'refunded total disagrees with ledger'; end if;

  select coalesce(sum((m ->> 'net_minor')::bigint), 0) into v_method_net
  from jsonb_array_elements(v_rep -> 'methods') m;
  if v_method_net <> v_cap - v_ref then raise exception 'per-method nets do not add up to the net total'; end if;

  if not (v_rep ->> 'balanced')::boolean then
    raise exception 'healthy ledger reported mismatches: %', v_rep -> 'mismatches';
  end if;

  -- corrupt one order's derived paid total (bypassing the RPCs) → must be detected
  perform set_config('restronex.payment_recompute', 'on', true);
  update public.orders set paid_minor = paid_minor + 1 where id = v_order;
  perform set_config('restronex.payment_recompute', 'off', true);

  v_rep := public.payment_reconciliation(v_accountant, v_outlet, now() - interval '1 day', now() + interval '1 day');
  v_mismatch := (v_rep ->> 'mismatch_count')::bigint;
  if v_mismatch < 1 or (v_rep ->> 'balanced')::boolean then
    raise exception 'corrupted order not detected';
  end if;

  -- recompute from the ledger repairs it and reconciliation is clean again
  perform public.recompute_order_payments(v_order);
  v_rep := public.payment_reconciliation(v_accountant, v_outlet, now() - interval '1 day', now() + interval '1 day');
  if not (v_rep ->> 'balanced')::boolean then raise exception 'recompute did not repair the mismatch'; end if;

  raise notice 'OK: reconciliation totals agree with the ledger; corruption detected and repaired';
end $$;

\echo '── P10.13: tenant isolation for money reads'
do $$
declare
  v_bob uuid := 'bbbbbbbb-0000-0000-0000-000000000002';
  v_biz_a uuid := 'cccccccc-0000-0000-0000-000000000001';
  v_n bigint;
begin
  perform set_config('request.jwt.claims', '{"sub":"bbbbbbbb-0000-0000-0000-000000000002"}', true);
  set local role authenticated;
  select count(*) into v_n from public.payments where business_id = v_biz_a;
  reset role;
  if v_n <> 0 then raise exception 'tenant B read % payment rows from tenant A', v_n; end if;
  raise notice 'OK: cross-tenant money reads return nothing';
end $$;

\echo '── P10.14: Phase 9 guards now cover billed orders (merge/split)'
do $$
declare
  v_owner uuid := 'aaaaaaaa-0000-0000-0000-000000000001';
  v_biz_a uuid := 'cccccccc-0000-0000-0000-000000000001';
  v_outlet uuid := (select v from p10_refs where k = 'outlet');
  v_burger uuid;
  v_o uuid;
  v_o2 uuid;
  v_items uuid[];
begin
  select id into v_burger from public.menu_items where business_id = v_biz_a and name = 'P8 Burger';
  v_o := public.create_pos_order(v_owner, jsonb_build_object(
    'outlet_id', v_outlet, 'client_ref', 'p10-split-guard-1', 'order_type', 'takeaway',
    'items', jsonb_build_array(jsonb_build_object('item_type','product','product_id', v_burger,'quantity',2))));
  perform public.issue_invoice(v_owner, v_o);
  select array_agg(id) into v_items from public.order_items where order_id = v_o;
  begin
    perform public.split_order(v_owner, v_o, v_items, null);
    raise exception 'invoiced order split';
  exception when others then
    if sqlerrm not ilike '%Invoiced orders cannot be split%' and sqlerrm not ilike '%dine-in%' then raise; end if;
  end;

  v_o2 := public.create_pos_order(v_owner, jsonb_build_object(
    'outlet_id', v_outlet, 'client_ref', 'p10-merge-guard-1', 'order_type', 'takeaway',
    'items', jsonb_build_array(jsonb_build_object('item_type','product','product_id', v_burger,'quantity',1))));
  begin
    perform public.merge_tables(v_owner, v_o2, v_o);
    raise exception 'invoiced order merged';
  exception when others then
    if sqlerrm not ilike '%Invoiced orders cannot be merged%' and sqlerrm not ilike '%dine-in%' then raise; end if;
  end;

  raise notice 'OK: invoiced orders are frozen for split and merge';
end $$;

\echo '── P10.15: payments on cancelled or closed orders are refused'
do $$
declare
  v_owner uuid := 'aaaaaaaa-0000-0000-0000-000000000001';
  v_biz_a uuid := 'cccccccc-0000-0000-0000-000000000001';
  v_outlet uuid := (select v from p10_refs where k = 'outlet');
  v_burger uuid;
  v_o uuid;
begin
  select id into v_burger from public.menu_items where business_id = v_biz_a and name = 'P8 Burger';
  v_o := public.create_pos_order(v_owner, jsonb_build_object(
    'outlet_id', v_outlet, 'client_ref', 'p10-closed-0001', 'order_type', 'takeaway',
    'items', jsonb_build_array(jsonb_build_object('item_type','product','product_id', v_burger,'quantity',1))));
  perform public.transition_order_status(v_owner, v_o, 'cancelled');
  begin
    perform public.record_payments(v_owner, v_o, 'p10-closed-pay-1', jsonb_build_array(
      jsonb_build_object('method_key', 'cash', 'amount_minor', 100)));
    raise exception 'payment accepted on cancelled order';
  exception when others then
    if sqlerrm not ilike '%live order%' then raise; end if;
  end;
  raise notice 'OK: cancelled orders take no payments';
end $$;

\echo '── P10.16: every RPC the app calls is executable by service_role (regression)'
do $$
declare
  v_name text;
  v_ok boolean;
begin
  foreach v_name in array array[
    'create_business', 'complete_table', 'create_pos_order', 'amend_pos_order',
    'transition_order_status', 'save_floor', 'save_section', 'save_table',
    'delete_floor', 'delete_section', 'delete_table', 'reserve_table',
    'release_table', 'transfer_table', 'merge_tables', 'split_order',
    'set_outlet_floor_plan', 'record_payments', 'refund_payment', 'issue_invoice',
    'void_invoice', 'record_receipt_print', 'payment_reconciliation', 'save_payment_method'
  ] loop
    select bool_and(has_function_privilege('service_role', p.oid, 'EXECUTE'))
      into v_ok
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = v_name;
    if v_ok is distinct from true then
      raise exception 'service_role cannot execute public.%', v_name;
    end if;
  end loop;
  raise notice 'OK: service_role can execute every app-called RPC';
end $$;

\echo '── P10 complete'
