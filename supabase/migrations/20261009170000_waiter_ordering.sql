-- RestroNex Phase 12: waiter / captain ordering.
--
-- Connects the mobile waiter app to the same POS and KDS data:
--   * waiters create and amend open orders, send them to the kitchen, and add
--     further rounds to sent orders (append-only: sent lines are never rewritten);
--   * waiters never set discounts or charges; the cashier's values are preserved;
--   * "request bill" stamps the order so the cashier sees it on the floor;
--   * kitchen progress moves the order status along the allowed transitions, so
--     the POS can complete an order once its kitchen work is done;
--   * completion is blocked while kitchen items are still in progress.
--
-- Every waiter write goes through a service-role RPC that re-checks membership and
-- the outlet permission (orders.manage) inside the database.

-- ── 1. bill request marker ──────────────────────────────────────────────────

alter table public.orders
  add column if not exists bill_requested_at timestamptz,
  add column if not exists bill_requested_by uuid references auth.users (id) on delete set null;

-- ── 2. submission ledger (idempotency for waiter writes) ───────────────────

create table if not exists public.order_submissions (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  client_ref text not null
    constraint order_submissions_ref_length check (char_length(client_ref) between 8 and 64),
  order_id uuid not null references public.orders (id) on delete cascade,
  actor_id uuid references auth.users (id) on delete set null,
  kind text not null
    constraint order_submissions_kind_allowed check (kind in ('create', 'amend', 'append')),
  created_at timestamptz not null default now(),
  constraint order_submissions_ref_unique unique (business_id, client_ref)
);

alter table public.order_submissions enable row level security;
revoke all on public.order_submissions from public, anon, authenticated;

-- ── 3. kitchen progress → order status ──────────────────────────────────────
-- placed → preparing once any item is accepted/in progress;
-- placed|preparing → ready once every live item is ready (or served).
-- Only the allowed transitions are used; nothing else changes the order.

create or replace function public.kitchen_sync_order_status(p_order_id uuid, p_actor uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status text;
begin
  select o.status into v_status from public.orders o where o.id = p_order_id for update;
  if v_status is null then
    return;
  end if;

  if v_status = 'placed' and exists (
    select 1 from public.order_items oi
    where oi.order_id = p_order_id and oi.kitchen_status in ('accepted', 'preparing', 'ready', 'completed')
  ) then
    update public.orders set status = 'preparing' where id = p_order_id and status = 'placed';
    insert into public.order_status_history (order_id, from_status, to_status, changed_by, note)
    values (p_order_id, 'placed', 'preparing', p_actor, 'Kitchen progress');
    v_status := 'preparing';
  end if;

  if v_status = 'preparing'
     and exists (
       select 1 from public.order_items oi
       where oi.order_id = p_order_id and oi.kitchen_status in ('ready', 'completed'))
     and not exists (
       select 1 from public.order_items oi
       where oi.order_id = p_order_id and oi.kitchen_status in ('new', 'accepted', 'preparing'))
  then
    update public.orders set status = 'ready' where id = p_order_id and status = 'preparing';
    insert into public.order_status_history (order_id, from_status, to_status, changed_by, note)
    values (p_order_id, 'preparing', 'ready', p_actor, 'Kitchen progress');
  end if;
end;
$$;

revoke all on function public.kitchen_sync_order_status(uuid, uuid) from public, anon, authenticated, service_role;

-- ── 4. regenerated Phase 8/9/11 functions (bodies copied with asserted edits) ─

drop function if exists public.pos_persist_items(uuid, uuid, uuid, jsonb);

create or replace function public.pos_persist_items(
  p_order_id uuid,
  p_business_id uuid,
  p_outlet_id uuid,
  p_items jsonb,
  p_append boolean default false
)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_item jsonb;
  v_modifier jsonb;
  v_group record;
  v_group_count integer;
  v_product_id uuid;
  v_product_name text;
  v_product_price bigint;
  v_product_available boolean;
  v_combo_id uuid;
  v_combo_name text;
  v_combo_price bigint;
  v_combo_available boolean;
  v_variant_id uuid;
  v_variant_name text;
  v_variant_price bigint;
  v_variant_available boolean;
  v_override_price bigint;
  v_override_available boolean;
  v_mod_id uuid;
  v_mod_name text;
  v_mod_price bigint;
  v_unit bigint;
  v_mod_total bigint;
  v_line_gross bigint;
  v_subtotal bigint := 0;
  v_position integer := 0;
  v_item_id uuid;
begin
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'The order has no items.' using errcode = 'P0001';
  end if;
  if jsonb_array_length(p_items) > 100 then
    raise exception 'At most 100 items per order.' using errcode = 'P0001';
  end if;

  -- Phase 12: append mode keeps lines already sent to the kitchen and continues the
  -- position sequence. Replace mode (default) is unchanged.
  if p_append then
    select coalesce(max(oi.position), 0) into v_position
    from public.order_items oi where oi.order_id = p_order_id;
  else
    delete from public.order_items where order_id = p_order_id; -- modifiers cascade
  end if;

  for v_item in select * from jsonb_array_elements(p_items) loop
    v_position := v_position + 1;

    if coalesce((v_item ->> 'quantity')::int, 0) not between 1 and 99 then
      raise exception 'Item quantities must be between 1 and 99.' using errcode = 'P0001';
    end if;

    if v_item ->> 'item_type' = 'product' then
      select i.id, i.name, i.price_minor, i.is_available
      into v_product_id, v_product_name, v_product_price, v_product_available
      from public.menu_items i
      where i.id = nullif(v_item ->> 'product_id', '')::uuid
        and i.business_id = p_business_id;
      if v_product_id is null then
        raise exception 'An item on this order no longer exists.' using errcode = 'P0001';
      end if;
      if v_product_available = false then
        raise exception '% is currently unavailable.', v_product_name using errcode = 'P0001';
      end if;

      v_unit := v_product_price;
      v_override_price := null;
      v_override_available := null;
      select o.price_minor, o.is_available into v_override_price, v_override_available
      from public.outlet_product_overrides o
      where o.product_id = v_product_id and o.outlet_id = p_outlet_id;
      if found then
        if v_override_available = false then
          raise exception '% is not available at this outlet.', v_product_name using errcode = 'P0001';
        end if;
        v_unit := coalesce(v_override_price, v_unit);
      end if;

      v_variant_id := null;
      v_variant_name := null;
      if nullif(v_item ->> 'variant_id', '') is not null then
        select pv.id, pv.name, pv.price_minor, pv.is_available
        into v_variant_id, v_variant_name, v_variant_price, v_variant_available
        from public.product_variants pv
        where pv.id = (v_item ->> 'variant_id')::uuid
          and pv.product_id = v_product_id;
        if v_variant_id is null then
          raise exception 'Pick a valid variant for %.', v_product_name using errcode = 'P0001';
        end if;
        if v_variant_available = false then
          raise exception '% (%) is currently unavailable.', v_product_name, v_variant_name using errcode = 'P0001';
        end if;
        v_unit := v_variant_price;
        v_override_price := null;
        v_override_available := null;
        select o.price_minor, o.is_available into v_override_price, v_override_available
        from public.outlet_variant_overrides o
        where o.variant_id = v_variant_id and o.outlet_id = p_outlet_id;
        if found then
          if v_override_available = false then
            raise exception '% (%) is not available at this outlet.', v_product_name, v_variant_name using errcode = 'P0001';
          end if;
          v_unit := coalesce(v_override_price, v_unit);
        end if;
      end if;

      -- modifiers must belong to groups attached to this product
      v_mod_total := 0;
      if jsonb_typeof(v_item -> 'modifiers') = 'array' then
        for v_modifier in select * from jsonb_array_elements(v_item -> 'modifiers') loop
          select md.id, md.name, md.price_minor
          into v_mod_id, v_mod_name, v_mod_price
          from public.modifiers md
          where md.id = nullif(v_modifier ->> 'modifier_id', '')::uuid;
          if v_mod_id is null then
            raise exception 'Unknown option on %.', v_product_name using errcode = 'P0001';
          end if;
          if not exists (
            select 1
            from public.product_modifier_groups pmg
            where pmg.product_id = v_product_id
              and pmg.modifier_group_id = (
                select m2.modifier_group_id from public.modifiers m2 where m2.id = v_mod_id
              )
          ) then
            raise exception 'That option is not offered with %.', v_product_name using errcode = 'P0001';
          end if;
          if coalesce((v_modifier ->> 'quantity')::int, 1) not between 1 and 20 then
            raise exception 'Option quantities must be between 1 and 20.' using errcode = 'P0001';
          end if;
          v_mod_total := v_mod_total + v_mod_price * coalesce((v_modifier ->> 'quantity')::int, 1);
        end loop;
      end if;

      -- Phase 12: modifier group rules (min / max options per group) apply to every channel.
      for v_group in
        select mg.id, mg.name, mg.min_selected, mg.max_selected
        from public.product_modifier_groups pmg
        join public.modifier_groups mg on mg.id = pmg.modifier_group_id
        where pmg.product_id = v_product_id
      loop
        select count(distinct m.id) into v_group_count
        from jsonb_array_elements(coalesce(v_item -> 'modifiers', '[]'::jsonb)) e
        join public.modifiers m on m.id = nullif(e ->> 'modifier_id', '')::uuid
        where m.modifier_group_id = v_group.id;
        if v_group_count < v_group.min_selected then
          raise exception '% needs at least % option(s) on %.', v_group.name, v_group.min_selected, v_product_name
            using errcode = 'P0001';
        end if;
        if v_group.max_selected is not null and v_group_count > v_group.max_selected then
          raise exception '% allows at most % option(s) on %.', v_group.name, v_group.max_selected, v_product_name
            using errcode = 'P0001';
        end if;
      end loop;

      v_line_gross := (v_unit + v_mod_total) * (v_item ->> 'quantity')::int;
      v_subtotal := v_subtotal + v_line_gross;

      insert into public.order_items (
        order_id, position, item_type, product_id, variant_id,
        name, unit_price_minor, quantity, item_notes, modifiers_minor, line_total_minor
      ) values (
        p_order_id, v_position, 'product', v_product_id, v_variant_id,
        case when v_variant_id is not null
             then v_product_name || ' (' || v_variant_name || ')'
             else v_product_name end,
        v_unit, (v_item ->> 'quantity')::int,
        nullif(trim(coalesce(v_item ->> 'item_notes', '')), ''),
        v_mod_total, v_line_gross
      ) returning id into v_item_id;

      if jsonb_typeof(v_item -> 'modifiers') = 'array' then
        for v_modifier in select * from jsonb_array_elements(v_item -> 'modifiers') loop
          select md.id, md.name, md.price_minor
          into v_mod_id, v_mod_name, v_mod_price
          from public.modifiers md where md.id = nullif(v_modifier ->> 'modifier_id', '')::uuid;
          insert into public.order_item_modifiers (order_item_id, modifier_id, name, price_minor, quantity)
          values (v_item_id, v_mod_id, v_mod_name, v_mod_price,
                  coalesce((v_modifier ->> 'quantity')::int, 1));
        end loop;
      end if;

    elsif v_item ->> 'item_type' = 'combo' then
      select c.id, c.name, c.price_minor, c.is_available
      into v_combo_id, v_combo_name, v_combo_price, v_combo_available
      from public.combos c
      where c.id = nullif(v_item ->> 'combo_id', '')::uuid
        and c.business_id = p_business_id;
      if v_combo_id is null then
        raise exception 'A combo on this order no longer exists.' using errcode = 'P0001';
      end if;
      if v_combo_available = false then
        raise exception '% is currently unavailable.', v_combo_name using errcode = 'P0001';
      end if;

      v_line_gross := v_combo_price * (v_item ->> 'quantity')::int;
      v_subtotal := v_subtotal + v_line_gross;

      insert into public.order_items (
        order_id, position, item_type, combo_id,
        name, unit_price_minor, quantity, item_notes, modifiers_minor, line_total_minor
      ) values (
        p_order_id, v_position, 'combo', v_combo_id,
        v_combo_name, v_combo_price, (v_item ->> 'quantity')::int,
        nullif(trim(coalesce(v_item ->> 'item_notes', '')), ''),
        0, v_line_gross
      );
    else
      raise exception 'Unknown item type.' using errcode = 'P0001';
    end if;
  end loop;

  return v_subtotal;
end;
$$;


revoke all on function public.pos_persist_items(uuid, uuid, uuid, jsonb, boolean)
  from public, anon, authenticated, service_role;
grant execute on function public.pos_persist_items(uuid, uuid, uuid, jsonb, boolean) to service_role;

create or replace function public.transition_order_status(
  p_actor uuid,
  p_order_id uuid,
  p_to text,
  p_note text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order_business_id uuid;
  v_order_outlet_id uuid;
  v_order_status text;
  v_paid_minor bigint;
  v_total_minor bigint;
  v_order_table_id uuid;
  v_allowed boolean := false;
  v_invoice_id uuid;
  v_invoice_no text;
begin
  select o.business_id, o.outlet_id, o.status, o.paid_minor, o.total_minor, o.table_id
  into v_order_business_id, v_order_outlet_id, v_order_status, v_paid_minor, v_total_minor, v_order_table_id
  from public.orders o where o.id = p_order_id
  for update;
  if v_order_business_id is null then
    raise exception 'Order not found.' using errcode = 'P0001';
  end if;
  if not exists (
    select 1 from public.memberships m
    where m.user_id = p_actor and m.business_id = v_order_business_id and m.status = 'active'
  ) then
    raise exception 'You are not a member of this business.' using errcode = 'P0001';
  end if;

  case v_order_status
    when 'open'      then v_allowed := p_to in ('held', 'placed', 'cancelled');
    when 'held'      then v_allowed := p_to in ('open', 'placed', 'cancelled');
    when 'placed'    then v_allowed := p_to in ('preparing', 'cancelled');
    when 'preparing' then v_allowed := p_to in ('ready', 'cancelled');
    when 'ready'     then v_allowed := p_to = 'completed';
    else v_allowed := false;
  end case;

  if not v_allowed then
    raise exception 'This order cannot move from % to %.', v_order_status, p_to using errcode = 'P0001';
  end if;

  -- Phase 12: kitchen work must be finished before the order can complete.
  if p_to = 'completed' and exists (
    select 1 from public.order_items oi
    where oi.order_id = p_order_id and oi.kitchen_status in ('new', 'accepted', 'preparing')
  ) then
    raise exception 'Kitchen items are still in progress.' using errcode = 'P0001';
  end if;

  if p_to = 'completed' and v_paid_minor < v_total_minor then
    raise exception 'Payment must be recorded before the order is completed.' using errcode = 'P0001';
  end if;

  if p_to = 'cancelled' and v_paid_minor > 0 then
    raise exception 'Refund the recorded payments before cancelling this order.' using errcode = 'P0001';
  end if;

  update public.orders set status = p_to where id = p_order_id and status = v_order_status;
  if not found then
    raise exception 'The order changed while you were working — refresh and retry.' using errcode = 'P0001';
  end if;

  insert into public.order_status_history (order_id, from_status, to_status, changed_by, note)
  values (p_order_id, v_order_status, p_to, p_actor, nullif(trim(coalesce(p_note, '')), ''));

  -- Phase 10: cancelling voids an issued invoice; its number is retained.
  if p_to = 'cancelled' then
    select i.id, i.invoice_no into v_invoice_id, v_invoice_no
    from public.invoices i where i.order_id = p_order_id and i.status = 'issued';
    if v_invoice_id is not null then
      update public.invoices
      set status = 'void', voided_by = p_actor, voided_at = now(), void_reason = 'Order cancelled'
      where id = v_invoice_id;
      update public.orders set billed_at = null where id = p_order_id;
      perform public.write_audit_log(
        v_order_business_id, v_order_outlet_id, p_actor, 'invoice.voided',
        'invoice', v_invoice_id::text,
        jsonb_build_object('status', 'issued'),
        jsonb_build_object('status', 'void'),
        jsonb_build_object('invoice_no', v_invoice_no, 'reason', 'order_cancelled')
      );
    end if;
    perform public.write_audit_log(
      v_order_business_id, v_order_outlet_id, p_actor, 'order.cancelled',
      'order', p_order_id::text,
      jsonb_build_object('status', v_order_status),
      jsonb_build_object('status', 'cancelled'),
      '{}'::jsonb
    );
  end if;

  -- Phase 9: closed orders free their table.
  if p_to in ('cancelled', 'completed') and v_order_table_id is not null then
    update public.dining_tables
    set status = 'available', current_order_id = null, reservation_note = null
    where id = v_order_table_id and current_order_id = p_order_id;
  end if;
end;
$$;

create or replace function public.kds_advance_item(
  p_actor uuid,
  p_item_id uuid,
  p_from text,
  p_to text
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_outlet uuid;
  v_current text;
begin
  select o.outlet_id, oi.kitchen_status into v_outlet, v_current
  from public.order_items oi
  join public.orders o on o.id = oi.order_id
  where oi.id = p_item_id
  for update of oi;

  if v_outlet is null then
    raise exception 'Kitchen item not found.' using errcode = 'P0001';
  end if;

  perform public.require_outlet_permission(p_actor, v_outlet, 'kitchen.operate');

  if (p_from, p_to) not in (
    ('new', 'accepted'), ('accepted', 'preparing'), ('preparing', 'ready'), ('ready', 'completed')
  ) then
    raise exception 'Invalid kitchen status change.' using errcode = 'P0001';
  end if;

  if v_current is distinct from p_from then
    raise exception 'This item changed on another screen. Refresh the board.' using errcode = 'P0001';
  end if;

  update public.order_items set kitchen_status = p_to where id = p_item_id;
  -- Phase 12: kitchen progress moves the order status (placed → preparing → ready)
  perform public.kitchen_sync_order_status(
    (select oi.order_id from public.order_items oi where oi.id = p_item_id), p_actor);
  return p_to;
end;
$$;

create or replace function public.kds_advance_ticket(
  p_actor uuid,
  p_order_id uuid,
  p_station_id uuid,
  p_from text,
  p_to text
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_outlet uuid;
  v_count integer;
begin
  select o.outlet_id into v_outlet from public.orders o where o.id = p_order_id;
  if v_outlet is null then
    raise exception 'Order not found.' using errcode = 'P0001';
  end if;

  perform public.require_outlet_permission(p_actor, v_outlet, 'kitchen.operate');

  if (p_from, p_to) not in (
    ('new', 'accepted'), ('accepted', 'preparing'), ('preparing', 'ready'), ('ready', 'completed')
  ) then
    raise exception 'Invalid kitchen status change.' using errcode = 'P0001';
  end if;

  -- Only items still at p_from move; anything already moved on another screen is skipped.
  update public.order_items oi
  set kitchen_status = p_to
  where oi.order_id = p_order_id
    and oi.station_id is not distinct from p_station_id
    and oi.kitchen_status = p_from;
  get diagnostics v_count = row_count;
  if v_count > 0 then
    -- Phase 12: kitchen progress moves the order status (placed → preparing → ready)
    perform public.kitchen_sync_order_status(p_order_id, p_actor);
  end if;
  return v_count;
end;
$$;


-- ── 5. waiter submit: create / amend / append, optionally sent to the kitchen ─

create or replace function public.waiter_submit_order(
  p_actor uuid,
  p_payload jsonb,
  p_send boolean default true
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_outlet_id uuid;
  v_business_id uuid;
  v_client_ref text;
  v_order_id uuid;
  v_ledger_order uuid;
  v_kind text;
  v_items jsonb;
  v_table_id uuid;
  v_status text;
  v_discount_type text;
  v_discount_value bigint;
  v_charges jsonb;
  v_billed_at timestamptz;
  v_paid_minor bigint;
  v_order_outlet uuid;
  v_order_business uuid;
  v_order_table uuid;
  v_subtotal bigint;
begin
  v_client_ref := trim(coalesce(p_payload ->> 'client_ref', ''));
  if char_length(v_client_ref) < 8 then
    raise exception 'Missing order reference.' using errcode = 'P0001';
  end if;

  v_outlet_id := nullif(trim(coalesce(p_payload ->> 'outlet_id', '')), '')::uuid;
  if v_outlet_id is null then
    raise exception 'Outlet not found.' using errcode = 'P0001';
  end if;

  -- membership + outlet grant + orders.manage, all re-checked here
  v_business_id := public.require_outlet_permission(p_actor, v_outlet_id, 'orders.manage');

  -- same submission reference always resolves to the same order (retries are safe)
  select s.order_id into v_ledger_order
  from public.order_submissions s
  where s.business_id = v_business_id and s.client_ref = v_client_ref;
  if v_ledger_order is not null then
    return v_ledger_order;
  end if;

  -- waiters never discount or charge; the cashier's values are preserved below
  if coalesce(p_payload -> 'discount' ->> 'type', 'none') <> 'none' then
    raise exception 'Waiters cannot apply discounts.' using errcode = '42501';
  end if;
  if jsonb_typeof(p_payload -> 'charges') = 'array' and jsonb_array_length(p_payload -> 'charges') > 0 then
    raise exception 'Waiters cannot add charges.' using errcode = '42501';
  end if;
  if coalesce(p_payload ->> 'order_type', '') <> 'dine_in' then
    raise exception 'Waiter orders are dine-in only.' using errcode = 'P0001';
  end if;

  v_items := p_payload -> 'items';
  if jsonb_typeof(v_items) is distinct from 'array' or jsonb_array_length(v_items) = 0 then
    raise exception 'Add at least one item.' using errcode = 'P0001';
  end if;

  v_order_id := nullif(trim(coalesce(p_payload ->> 'order_id', '')), '')::uuid;

  if v_order_id is null then
    -- new order on a table (create_pos_order occupies the table under a lock)
    v_table_id := nullif(trim(coalesce(p_payload ->> 'table_id', '')), '')::uuid;
    if v_table_id is null then
      raise exception 'Pick a table first.' using errcode = 'P0001';
    end if;
    v_order_id := public.create_pos_order(p_actor, jsonb_build_object(
      'outlet_id', v_outlet_id,
      'client_ref', v_client_ref,
      'order_type', 'dine_in',
      'status', 'open',
      'table_id', v_table_id,
      'notes', p_payload -> 'notes',
      'items', v_items,
      'discount', jsonb_build_object('type', 'none', 'value', 0),
      'charges', '[]'::jsonb
    ));
    v_kind := 'create';
  else
    select o.business_id, o.outlet_id, o.status, o.table_id, o.discount_type, o.discount_value,
           o.charges, o.billed_at, o.paid_minor
    into v_order_business, v_order_outlet, v_status, v_order_table, v_discount_type, v_discount_value,
         v_charges, v_billed_at, v_paid_minor
    from public.orders o where o.id = v_order_id
    for update;
    if not found or v_order_business <> v_business_id or v_order_outlet <> v_outlet_id then
      raise exception 'Order not found at this outlet.' using errcode = 'P0001';
    end if;

    if v_status in ('open', 'held') then
      -- unsent draft: replace its lines; table, discount and charges are kept as they are
      perform public.amend_pos_order(p_actor, v_order_id, jsonb_build_object(
        'status', v_status,
        'table_id', v_order_table,
        'notes', p_payload -> 'notes',
        'items', v_items,
        'discount', jsonb_build_object('type', v_discount_type, 'value', v_discount_value),
        'charges', v_charges
      ));
      v_kind := 'amend';
    elsif v_status in ('placed', 'preparing', 'ready') then
      -- sent order: append-only round; lines already in the kitchen are never rewritten
      if v_billed_at is not null then
        raise exception 'Void the invoice before adding items.' using errcode = 'P0001';
      end if;
      if v_paid_minor > 0 then
        raise exception 'Refund recorded payments before adding items.' using errcode = 'P0001';
      end if;
      perform public.pos_persist_items(v_order_id, v_business_id, v_outlet_id, v_items, true);
      select coalesce(sum(oi.line_total_minor), 0) into v_subtotal
      from public.order_items oi where oi.order_id = v_order_id;
      perform public.pos_apply_totals(
        v_order_id, v_business_id, v_subtotal,
        jsonb_build_object('type', v_discount_type, 'value', v_discount_value),
        v_charges
      );
      v_kind := 'append';
    else
      raise exception 'This order is closed and cannot take new items.' using errcode = 'P0001';
    end if;
  end if;

  if p_send then
    select o.status into v_status from public.orders o where o.id = v_order_id;
    if v_status in ('open', 'held') then
      perform public.transition_order_status(p_actor, v_order_id, 'placed', null);
    end if;
  end if;

  insert into public.order_submissions (business_id, client_ref, order_id, actor_id, kind)
  values (v_business_id, v_client_ref, v_order_id, p_actor, v_kind);

  perform public.write_audit_log(
    v_business_id, v_outlet_id, p_actor, 'order.submitted', 'order', v_order_id::text,
    '{}'::jsonb, '{}'::jsonb,
    jsonb_build_object('kind', v_kind, 'sent', p_send, 'lines', jsonb_array_length(v_items))
  );

  return v_order_id;
end;
$$;

revoke all on function public.waiter_submit_order(uuid, jsonb, boolean) from public, anon, authenticated;
grant execute on function public.waiter_submit_order(uuid, jsonb, boolean) to service_role;

-- ── 6. request bill: visible to the cashier, changes no money ───────────────

create or replace function public.waiter_request_bill(p_actor uuid, p_order_id uuid)
returns timestamptz
language plpgsql
security definer
set search_path = public
as $$
declare
  v_business_id uuid;
  v_outlet_id uuid;
  v_status text;
  v_requested timestamptz;
begin
  select o.outlet_id, o.status, o.bill_requested_at
  into v_outlet_id, v_status, v_requested
  from public.orders o where o.id = p_order_id
  for update;
  if not found then
    raise exception 'Order not found.' using errcode = 'P0001';
  end if;

  v_business_id := public.require_outlet_permission(p_actor, v_outlet_id, 'orders.manage');

  if v_status not in ('placed', 'preparing', 'ready') then
    raise exception 'Send the order to the kitchen before asking for the bill.' using errcode = 'P0001';
  end if;

  -- repeated taps keep the first request time
  if v_requested is not null then
    return v_requested;
  end if;

  update public.orders
  set bill_requested_at = now(), bill_requested_by = p_actor
  where id = p_order_id;

  perform public.write_audit_log(
    v_business_id, v_outlet_id, p_actor, 'order.bill_requested', 'order', p_order_id::text,
    '{}'::jsonb, '{}'::jsonb, '{}'::jsonb
  );

  return now();
end;
$$;

revoke all on function public.waiter_request_bill(uuid, uuid) from public, anon, authenticated;
grant execute on function public.waiter_request_bill(uuid, uuid) to service_role;
