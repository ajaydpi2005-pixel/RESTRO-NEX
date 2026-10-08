-- ─────────────────────────────────────────────────────────────────────────────
-- RestroNex Phase 9 — Dining tables + floor management
--
-- Floors → sections → tables. Tables carry a service status
-- (available / occupied / reserved) that is owned EXCLUSIVELY by the
-- SECURITY DEFINER RPCs below — clients can never flip a table directly.
--
-- Order ↔ table lifecycle (single source of truth = orders):
--   * create_pos_order   → occupies the table (row-locked; rejects taken ones)
--   * amend_pos_order    → table changes are guarded transfers
--   * transition_order_status → cancelled / completed release the table
--   * transfer_table / merge_tables / split_order / complete_table manage the
--     dine-in operations. Every mutating RPC locks the involved table rows in
--     id order so concurrent staff actions serialise instead of corrupting.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── floors ──────────────────────────────────────────────────────────────────

create table public.floors (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  outlet_id uuid not null references public.outlets (id) on delete cascade,
  name text not null
    constraint floors_name_length check (char_length(trim(name)) between 1 and 60),
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index floors_outlet_name_unique
  on public.floors (outlet_id, lower(trim(name)));

create index floors_outlet_idx on public.floors (outlet_id);

create trigger floors_set_updated_at
  before update on public.floors
  for each row execute function public.set_updated_at();

alter table public.floors enable row level security;

create policy "floor_select_member"
  on public.floors for select
  to authenticated
  using (public.has_business_access(business_id));

-- sections now hang off a floor
alter table public.dining_sections
  add column if not exists floor_id uuid references public.floors (id) on delete cascade;

-- Every outlet gets a default floor; existing sections attach to it.
insert into public.floors (business_id, outlet_id, name)
select o.business_id, o.id, 'Main Floor'
from public.outlets o
where not exists (
  select 1 from public.floors f where f.outlet_id = o.id
);

update public.dining_sections s
set floor_id = f.id
from public.floors f
where s.outlet_id = f.outlet_id
  and s.floor_id is null
  and f.id = (
    select f2.id from public.floors f2
    where f2.outlet_id = s.outlet_id
    order by f2.sort_order, f2.created_at
    limit 1
  );

alter table public.dining_sections alter column floor_id set not null;

-- New outlets automatically get their default floor.
create or replace function public.attach_default_floor()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.floors (business_id, outlet_id, name)
  values (new.business_id, new.id, 'Main Floor');
  return new;
end;
$$;

create trigger outlets_attach_default_floor
  after insert on public.outlets
  for each row execute function public.attach_default_floor();

revoke all on function public.attach_default_floor() from public, anon, authenticated, service_role;

-- ── table service status ────────────────────────────────────────────────────

alter table public.dining_tables
  add column if not exists status text not null default 'available'
    constraint dining_tables_status_allowed
    check (status in ('available', 'occupied', 'reserved')),
  add column if not exists current_order_id uuid references public.orders (id) on delete set null,
  add column if not exists reservation_note text
    constraint dining_tables_reservation_note_length
    check (reservation_note is null or char_length(reservation_note) <= 120);

create index dining_tables_status_idx on public.dining_tables (outlet_id, status);

-- ── shared guards ───────────────────────────────────────────────────────────

-- Returns the outlet's business id after verifying the actor is an active
-- member with outlet scope (owner/admin are implicit; everyone else needs an
-- explicit membership_outlets grant). Raises otherwise.
create or replace function public.require_outlet_access(
  p_actor uuid,
  p_outlet_id uuid
)
returns uuid
language plpgsql
security definer
stable
set search_path = public
as $$
declare
  v_business_id uuid;
  v_role text;
begin
  select o.business_id into v_business_id
  from public.outlets o where o.id = p_outlet_id;
  if v_business_id is null then
    raise exception 'Outlet not found.' using errcode = 'P0001';
  end if;

  select m.role into v_role
  from public.memberships m
  where m.user_id = p_actor
    and m.business_id = v_business_id
    and m.status = 'active';
  if v_role is null then
    raise exception 'You are not a member of this business.' using errcode = 'P0001';
  end if;

  if v_role not in ('owner', 'business_admin') then
    if not exists (
      select 1
      from public.memberships m
      join public.membership_outlets mo on mo.membership_id = m.id
      where m.user_id = p_actor
        and m.business_id = v_business_id
        and m.status = 'active'
        and mo.outlet_id = p_outlet_id
    ) then
      raise exception 'You are not assigned to this outlet.' using errcode = 'P0001';
    end if;
  end if;

  return v_business_id;
end;
$$;

revoke all on function public.require_outlet_access(uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.require_outlet_access(uuid, uuid) to service_role;

create or replace function public.default_floor_for_outlet(p_outlet_id uuid)
returns uuid
language sql
security definer
stable
set search_path = public
as $$
  select f.id
  from public.floors f
  where f.outlet_id = p_outlet_id
  order by f.sort_order, f.created_at
  limit 1;
$$;

revoke all on function public.default_floor_for_outlet(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.default_floor_for_outlet(uuid) to service_role;

-- Direct inserts that omit floor_id land on the outlet's default floor
-- (keeps legacy fixtures/inserts valid; RPCs always pass an explicit floor).
create or replace function public.dining_sections_default_floor()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.floor_id is null then
    new.floor_id := public.default_floor_for_outlet(new.outlet_id);
  end if;
  if new.floor_id is null then
    raise exception 'No floor exists for this outlet yet.' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

create trigger dining_sections_default_floor_bi
  before insert on public.dining_sections
  for each row execute function public.dining_sections_default_floor();

revoke all on function public.dining_sections_default_floor()
  from public, anon, authenticated, service_role;

-- ── floor / section / table configuration RPCs ──────────────────────────────

create or replace function public.save_floor(
  p_actor uuid,
  p_floor_id uuid,
  p_outlet_id uuid,
  p_name text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_business_id uuid;
  v_name text := trim(coalesce(p_name, ''));
  v_floor_id uuid := p_floor_id;
begin
  v_business_id := public.require_outlet_access(p_actor, p_outlet_id);
  if char_length(v_name) < 1 or char_length(v_name) > 60 then
    raise exception 'Floor name must be between 1 and 60 characters.' using errcode = 'P0001';
  end if;

  if v_floor_id is null then
    insert into public.floors (business_id, outlet_id, name)
    values (v_business_id, p_outlet_id, v_name)
    returning id into v_floor_id;
  else
    update public.floors f
    set name = v_name
    where f.id = v_floor_id and f.outlet_id = p_outlet_id;
    if not found then
      raise exception 'Floor not found.' using errcode = 'P0001';
    end if;
  end if;

  return v_floor_id;
exception
  when unique_violation then
    raise exception 'A floor with this name already exists.' using errcode = 'P0001';
end;
$$;

revoke all on function public.save_floor(uuid, uuid, uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.save_floor(uuid, uuid, uuid, text) to service_role;

create or replace function public.delete_floor(
  p_actor uuid,
  p_floor_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_outlet_id uuid;
begin
  select f.outlet_id into v_outlet_id from public.floors f where f.id = p_floor_id;
  if v_outlet_id is null then
    raise exception 'Floor not found.' using errcode = 'P0001';
  end if;
  perform public.require_outlet_access(p_actor, v_outlet_id);

  if exists (select 1 from public.dining_sections s where s.floor_id = p_floor_id) then
    raise exception 'Move or delete this floor''s sections first.' using errcode = 'P0001';
  end if;

  delete from public.floors where id = p_floor_id;
end;
$$;

revoke all on function public.delete_floor(uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.delete_floor(uuid, uuid) to service_role;

create or replace function public.save_section(
  p_actor uuid,
  p_section_id uuid,
  p_outlet_id uuid,
  p_floor_id uuid,
  p_name text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_business_id uuid;
  v_name text := trim(coalesce(p_name, ''));
  v_section_id uuid := p_section_id;
begin
  v_business_id := public.require_outlet_access(p_actor, p_outlet_id);
  if char_length(v_name) < 1 or char_length(v_name) > 60 then
    raise exception 'Section name must be between 1 and 60 characters.' using errcode = 'P0001';
  end if;
  if not exists (
    select 1 from public.floors f where f.id = p_floor_id and f.outlet_id = p_outlet_id
  ) then
    raise exception 'Pick a floor that belongs to this outlet.' using errcode = 'P0001';
  end if;

  if v_section_id is null then
    insert into public.dining_sections (business_id, outlet_id, floor_id, name)
    values (v_business_id, p_outlet_id, p_floor_id, v_name)
    returning id into v_section_id;
  else
    update public.dining_sections s
    set name = v_name, floor_id = p_floor_id
    where s.id = v_section_id and s.outlet_id = p_outlet_id;
    if not found then
      raise exception 'Section not found.' using errcode = 'P0001';
    end if;
  end if;

  return v_section_id;
exception
  when unique_violation then
    raise exception 'A section with this name already exists.' using errcode = 'P0001';
end;
$$;

revoke all on function public.save_section(uuid, uuid, uuid, uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.save_section(uuid, uuid, uuid, uuid, text) to service_role;

create or replace function public.delete_section(
  p_actor uuid,
  p_section_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_outlet_id uuid;
begin
  select s.outlet_id into v_outlet_id
  from public.dining_sections s where s.id = p_section_id;
  if v_outlet_id is null then
    raise exception 'Section not found.' using errcode = 'P0001';
  end if;
  perform public.require_outlet_access(p_actor, v_outlet_id);

  if exists (select 1 from public.dining_tables t where t.section_id = p_section_id) then
    raise exception 'Move or delete this section''s tables first.' using errcode = 'P0001';
  end if;

  delete from public.dining_sections where id = p_section_id;
end;
$$;

revoke all on function public.delete_section(uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.delete_section(uuid, uuid) to service_role;

create or replace function public.save_table(
  p_actor uuid,
  p_table_id uuid,
  p_outlet_id uuid,
  p_section_id uuid,
  p_label text,
  p_capacity integer
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_business_id uuid;
  v_label text := trim(coalesce(p_label, ''));
  v_table_id uuid := p_table_id;
begin
  v_business_id := public.require_outlet_access(p_actor, p_outlet_id);
  if char_length(v_label) < 1 or char_length(v_label) > 20 then
    raise exception 'Table label must be between 1 and 20 characters.' using errcode = 'P0001';
  end if;
  if p_capacity is null or p_capacity < 1 or p_capacity > 50 then
    raise exception 'Capacity must be between 1 and 50.' using errcode = 'P0001';
  end if;
  if not exists (
    select 1 from public.dining_sections s
    where s.id = p_section_id and s.outlet_id = p_outlet_id
  ) then
    raise exception 'Pick a section that belongs to this outlet.' using errcode = 'P0001';
  end if;

  if v_table_id is null then
    insert into public.dining_tables (business_id, outlet_id, section_id, label, capacity)
    values (v_business_id, p_outlet_id, p_section_id, v_label, p_capacity)
    returning id into v_table_id;
  else
    update public.dining_tables t
    set label = v_label, capacity = p_capacity, section_id = p_section_id
    where t.id = v_table_id and t.outlet_id = p_outlet_id;
    if not found then
      raise exception 'Table not found.' using errcode = 'P0001';
    end if;
  end if;

  return v_table_id;
exception
  when unique_violation then
    raise exception 'A table with this label already exists.' using errcode = 'P0001';
end;
$$;

revoke all on function public.save_table(uuid, uuid, uuid, uuid, text, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.save_table(uuid, uuid, uuid, uuid, text, integer) to service_role;

create or replace function public.delete_table(
  p_actor uuid,
  p_table_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rec record;
begin
  select t.outlet_id, t.status, t.current_order_id
  into v_rec
  from public.dining_tables t
  where t.id = p_table_id
  for update;
  if v_rec.outlet_id is null then
    raise exception 'Table not found.' using errcode = 'P0001';
  end if;
  perform public.require_outlet_access(p_actor, v_rec.outlet_id);

  if v_rec.status = 'occupied' then
    raise exception 'Occupied tables cannot be deleted — settle or move the order first.' using errcode = 'P0001';
  end if;
  if exists (
    select 1 from public.orders o
    where o.table_id = p_table_id and o.status not in ('completed', 'cancelled')
  ) then
    raise exception 'This table still has an active order.' using errcode = 'P0001';
  end if;

  delete from public.dining_tables where id = p_table_id;
end;
$$;

revoke all on function public.delete_table(uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.delete_table(uuid, uuid) to service_role;

-- ── reservations ────────────────────────────────────────────────────────────

create or replace function public.reserve_table(
  p_actor uuid,
  p_table_id uuid,
  p_note text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rec record;
begin
  select t.outlet_id, t.status, t.is_active
  into v_rec
  from public.dining_tables t
  where t.id = p_table_id
  for update;
  if v_rec.outlet_id is null then
    raise exception 'Table not found.' using errcode = 'P0001';
  end if;
  perform public.require_outlet_access(p_actor, v_rec.outlet_id);
  if not v_rec.is_active then
    raise exception 'This table is not active.' using errcode = 'P0001';
  end if;
  if v_rec.status <> 'available' then
    raise exception 'Only available tables can be reserved.' using errcode = 'P0001';
  end if;

  update public.dining_tables
  set status = 'reserved',
      reservation_note = nullif(trim(coalesce(p_note, '')), '')
  where id = p_table_id and status = 'available';
  if not found then
    raise exception 'The table changed while you were working — refresh and retry.' using errcode = 'P0001';
  end if;
end;
$$;

revoke all on function public.reserve_table(uuid, uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.reserve_table(uuid, uuid, text) to service_role;

create or replace function public.release_table(
  p_actor uuid,
  p_table_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rec record;
begin
  select t.outlet_id, t.status
  into v_rec
  from public.dining_tables t
  where t.id = p_table_id
  for update;
  if v_rec.outlet_id is null then
    raise exception 'Table not found.' using errcode = 'P0001';
  end if;
  perform public.require_outlet_access(p_actor, v_rec.outlet_id);
  if v_rec.status <> 'reserved' then
    raise exception 'Only reserved tables can be released.' using errcode = 'P0001';
  end if;

  update public.dining_tables
  set status = 'available', reservation_note = null
  where id = p_table_id and status = 'reserved';
end;
$$;

revoke all on function public.release_table(uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.release_table(uuid, uuid) to service_role;

-- ── dine-in operations ──────────────────────────────────────────────────────

-- Move an active dine-in order to another table.
create or replace function public.transfer_table(
  p_actor uuid,
  p_order_id uuid,
  p_to_table_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order record;
  v_from record;
  v_to record;
begin
  select o.id, o.business_id, o.outlet_id, o.status, o.order_type, o.table_id, o.payment_status
  into v_order
  from public.orders o where o.id = p_order_id
  for update;
  if v_order.id is null then
    raise exception 'Order not found.' using errcode = 'P0001';
  end if;
  perform public.require_outlet_access(p_actor, v_order.outlet_id);

  if v_order.order_type <> 'dine_in' then
    raise exception 'Only dine-in orders sit on tables.' using errcode = 'P0001';
  end if;
  if v_order.status in ('completed', 'cancelled') then
    raise exception 'This order is already closed.' using errcode = 'P0001';
  end if;
  if v_order.table_id = p_to_table_id then
    raise exception 'The order is already on that table.' using errcode = 'P0001';
  end if;

  -- Lock both tables in id order to serialise concurrent moves.
  for v_to in
    select t.* from public.dining_tables t
    where t.id in (p_to_table_id, coalesce(v_order.table_id, p_to_table_id))
    order by t.id
    for update
  loop
    if v_to.id = p_to_table_id then
      if v_to.outlet_id <> v_order.outlet_id then
        raise exception 'Pick a table that belongs to this outlet.' using errcode = 'P0001';
      end if;
      if not v_to.is_active then
        raise exception 'The target table is not active.' using errcode = 'P0001';
      end if;
      if v_to.status = 'occupied' then
        raise exception 'The target table is already occupied.' using errcode = 'P0001';
      end if;
    else
      v_from := v_to;
    end if;
  end loop;

  update public.orders set table_id = p_to_table_id where id = p_order_id;
  if v_from.id is not null then
    update public.dining_tables
    set status = 'available', current_order_id = null, reservation_note = null
    where id = v_from.id and current_order_id = p_order_id;
  end if;
  update public.dining_tables
  set status = 'occupied', current_order_id = p_order_id, reservation_note = null
  where id = p_to_table_id;

  insert into public.order_status_history (order_id, from_status, to_status, changed_by, note)
  values (p_order_id, v_order.status, v_order.status, p_actor, 'Moved tables');
end;
$$;

revoke all on function public.transfer_table(uuid, uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.transfer_table(uuid, uuid, uuid) to service_role;

-- Merge one table's order into another (items move; the merged order closes).
create or replace function public.merge_tables(
  p_actor uuid,
  p_keep_order_id uuid,
  p_merge_order_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_keep record;
  v_merge record;
  v_table record;
  v_subtotal bigint;
begin
  if p_keep_order_id = p_merge_order_id then
    raise exception 'Pick two different orders to merge.' using errcode = 'P0001';
  end if;

  -- Lock both orders in id order so concurrent merges serialise.
  perform o.id from public.orders o
  where o.id in (p_keep_order_id, p_merge_order_id)
  order by o.id
  for update;

  select o.* into v_keep from public.orders o where o.id = p_keep_order_id for update;
  select o.* into v_merge from public.orders o where o.id = p_merge_order_id for update;
  if v_keep.id is null or v_merge.id is null then
    raise exception 'Order not found.' using errcode = 'P0001';
  end if;
  perform public.require_outlet_access(p_actor, v_keep.outlet_id);

  if v_merge.outlet_id <> v_keep.outlet_id then
    raise exception 'Both orders must belong to the same outlet.' using errcode = 'P0001';
  end if;
  if v_keep.order_type <> 'dine_in' or v_merge.order_type <> 'dine_in' then
    raise exception 'Only dine-in orders can be merged.' using errcode = 'P0001';
  end if;
  if v_keep.status not in ('open', 'held', 'placed', 'preparing', 'ready')
     or v_merge.status not in ('open', 'held', 'placed', 'preparing', 'ready') then
    raise exception 'Closed orders cannot be merged.' using errcode = 'P0001';
  end if;
  if v_keep.payment_status <> 'unpaid' or v_merge.payment_status <> 'unpaid' then
    raise exception 'Orders with recorded payments cannot be merged.' using errcode = 'P0001';
  end if;

  -- Move every item (modifiers follow their item rows).
  update public.order_items
  set order_id = p_keep_order_id
  where order_id = p_merge_order_id;

  -- Reprice the combined order from its (now merged) items.
  select coalesce(sum(oi.line_total_minor), 0) into v_subtotal
  from public.order_items oi
  where oi.order_id = p_keep_order_id;
  perform public.pos_apply_totals(
    p_keep_order_id, v_keep.business_id, v_subtotal,
    jsonb_build_object('type', v_keep.discount_type, 'value', v_keep.discount_value),
    null);

  -- Close the merged order and free its table.
  update public.orders
  set status = 'cancelled', table_id = null
  where id = p_merge_order_id;
  insert into public.order_status_history (order_id, from_status, to_status, changed_by, note)
  values (p_merge_order_id, v_merge.status, 'cancelled', p_actor,
          format('Merged into order #%s', v_keep.order_number));

  for v_table in
    select t.* from public.dining_tables t
    where t.current_order_id = p_merge_order_id
    order by t.id
    for update
  loop
    update public.dining_tables
    set status = 'available', current_order_id = null, reservation_note = null
    where id = v_table.id;
  end loop;

  update public.dining_tables
  set status = 'occupied', current_order_id = p_keep_order_id
  where id = v_keep.table_id and current_order_id = p_keep_order_id;
end;
$$;

revoke all on function public.merge_tables(uuid, uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.merge_tables(uuid, uuid, uuid) to service_role;

-- Split selected items out of an order onto another table as a new order.
create or replace function public.split_order(
  p_actor uuid,
  p_order_id uuid,
  p_item_ids uuid[],
  p_to_table_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order record;
  v_table record;
  v_new_order_id uuid;
  v_order_number integer;
  v_client_ref text;
  v_moved integer;
  v_remaining integer;
  v_subtotal bigint;
begin
  select o.* into v_order
  from public.orders o where o.id = p_order_id
  for update;
  if v_order.id is null then
    raise exception 'Order not found.' using errcode = 'P0001';
  end if;
  perform public.require_outlet_access(p_actor, v_order.outlet_id);

  if v_order.order_type <> 'dine_in' then
    raise exception 'Only dine-in orders can be split across tables.' using errcode = 'P0001';
  end if;
  if v_order.status in ('completed', 'cancelled') then
    raise exception 'This order is already closed.' using errcode = 'P0001';
  end if;
  if v_order.payment_status <> 'unpaid' then
    raise exception 'Orders with recorded payments cannot be split.' using errcode = 'P0001';
  end if;
  if p_item_ids is null or cardinality(p_item_ids) = 0 then
    raise exception 'Pick the items to move.' using errcode = 'P0001';
  end if;

  -- Every moved item must belong to this order, and at least one stays.
  select count(*) into v_moved
  from public.order_items oi
  where oi.order_id = p_order_id and oi.id = any (p_item_ids);
  if v_moved <> cardinality(p_item_ids) then
    raise exception 'Some items do not belong to this order.' using errcode = 'P0001';
  end if;
  select count(*) into v_remaining
  from public.order_items oi
  where oi.order_id = p_order_id and not oi.id = any (p_item_ids);
  if v_remaining = 0 then
    raise exception 'Leave at least one item on the original order — transfer the table instead.' using errcode = 'P0001';
  end if;

  select t.* into v_table
  from public.dining_tables t where t.id = p_to_table_id
  for update;
  if v_table.id is null or v_table.outlet_id <> v_order.outlet_id then
    raise exception 'Pick a table that belongs to this outlet.' using errcode = 'P0001';
  end if;
  if not v_table.is_active then
    raise exception 'The target table is not active.' using errcode = 'P0001';
  end if;
  if v_table.status = 'occupied' then
    raise exception 'The target table is already occupied.' using errcode = 'P0001';
  end if;

  -- New order on the target table.
  insert into public.business_order_counters (business_id, order_seq)
  values (v_order.business_id, 1001)
  on conflict (business_id)
  do update set order_seq = public.business_order_counters.order_seq + 1
  returning order_seq into v_order_number;

  v_client_ref := 'split-' || replace(gen_random_uuid()::text, '-', '');
  insert into public.orders (
    business_id, outlet_id, order_number, client_ref, created_by,
    order_type, status, table_id, notes
  ) values (
    v_order.business_id, v_order.outlet_id, v_order_number, v_client_ref, p_actor,
    'dine_in', 'open', p_to_table_id,
    format('Split from order #%s', v_order.order_number)
  ) returning id into v_new_order_id;

  update public.order_items
  set order_id = v_new_order_id
  where order_id = p_order_id and id = any (p_item_ids);

  -- Reprice both sides.
  select coalesce(sum(oi.line_total_minor), 0) into v_subtotal
  from public.order_items oi where oi.order_id = v_new_order_id;
  perform public.pos_apply_totals(
    v_new_order_id, v_order.business_id, v_subtotal,
    '{"type":"none"}'::jsonb, null);

  select coalesce(sum(oi.line_total_minor), 0) into v_subtotal
  from public.order_items oi where oi.order_id = p_order_id;
  perform public.pos_apply_totals(
    p_order_id, v_order.business_id, v_subtotal,
    jsonb_build_object('type', v_order.discount_type, 'value', v_order.discount_value),
    null);

  update public.dining_tables
  set status = 'occupied', current_order_id = v_new_order_id, reservation_note = null
  where id = p_to_table_id;

  insert into public.order_status_history (order_id, from_status, to_status, changed_by, note)
  values (v_new_order_id, null, 'open', p_actor,
          format('Split from order #%s', v_order.order_number));

  return v_new_order_id;
end;
$$;

revoke all on function public.split_order(uuid, uuid, uuid[], uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.split_order(uuid, uuid, uuid[], uuid) to service_role;

-- Complete a table: settle its order (must be ready + paid) and free it.
create or replace function public.complete_table(
  p_actor uuid,
  p_table_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_table record;
  v_order record;
begin
  select t.* into v_table
  from public.dining_tables t where t.id = p_table_id
  for update;
  if v_table.id is null then
    raise exception 'Table not found.' using errcode = 'P0001';
  end if;
  perform public.require_outlet_access(p_actor, v_table.outlet_id);

  if v_table.status = 'available' then
    return; -- nothing to do
  end if;

  if v_table.status = 'reserved' then
    update public.dining_tables
    set status = 'available', reservation_note = null
    where id = p_table_id;
    return;
  end if;

  -- occupied
  if v_table.current_order_id is null then
    update public.dining_tables
    set status = 'available', reservation_note = null
    where id = p_table_id;
    return;
  end if;

  select o.* into v_order
  from public.orders o where o.id = v_table.current_order_id
  for update;
  if v_order.id is null or v_order.status in ('completed', 'cancelled') then
    update public.dining_tables
    set status = 'available', current_order_id = null, reservation_note = null
    where id = p_table_id;
    return;
  end if;

  if v_order.status <> 'ready' then
    raise exception 'The order must be ready before the table is completed.' using errcode = 'P0001';
  end if;
  if v_order.payment_status <> 'paid' or v_order.paid_minor < v_order.total_minor then
    raise exception 'Settle the bill before completing this table.' using errcode = 'P0001';
  end if;

  update public.orders set status = 'completed' where id = v_order.id;
  insert into public.order_status_history (order_id, from_status, to_status, changed_by, note)
  values (v_order.id, 'ready', 'completed', p_actor, 'Table completed');

  update public.dining_tables
  set status = 'available', current_order_id = null, reservation_note = null
  where id = p_table_id;
end;
$$;

revoke all on function public.complete_table(uuid, uuid)
  from public, anon, authenticated, service_role;

-- ── Phase 8 hooks: order lifecycle now drives table status ─────────────────
-- These REPLACE the orders-migration RPCs with identical signatures and
-- behaviour, plus the table occupy/release/transfer hooks. Clients still
-- never touch dining_tables.status directly.

create or replace function public.create_pos_order(
  p_actor uuid,
  p_payload jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_outlet_id uuid;
  v_outlet_business_id uuid;
  v_order_id uuid;
  v_order_number integer;
  v_client_ref text;
  v_order_type text;
  v_status text;
  v_table_id uuid;
  v_subtotal bigint;
  v_table record;
begin
  select o.id, o.business_id into v_outlet_id, v_outlet_business_id
  from public.outlets o
  where o.id = nullif(p_payload ->> 'outlet_id', '')::uuid;
  if v_outlet_id is null then
    raise exception 'Outlet not found.' using errcode = 'P0001';
  end if;
  if not exists (
    select 1 from public.memberships m
    where m.user_id = p_actor and m.business_id = v_outlet_business_id and m.status = 'active'
  ) then
    raise exception 'You are not a member of this business.' using errcode = 'P0001';
  end if;

  v_client_ref := trim(coalesce(p_payload ->> 'client_ref', ''));
  if char_length(v_client_ref) < 8 then
    raise exception 'Missing order reference.' using errcode = 'P0001';
  end if;
  select id into v_order_id
  from public.orders
  where business_id = v_outlet_business_id and client_ref = v_client_ref;
  if v_order_id is not null then
    return v_order_id; -- duplicate submission → original order
  end if;

  v_order_type := coalesce(p_payload ->> 'order_type', '');
  if v_order_type not in ('dine_in', 'takeaway', 'delivery') then
    raise exception 'Pick an order type: dine-in, takeaway or delivery.' using errcode = 'P0001';
  end if;
  v_status := coalesce(p_payload ->> 'status', 'open');
  if v_status not in ('open', 'held') then
    raise exception 'New orders start open or held.' using errcode = 'P0001';
  end if;

  v_table_id := nullif(trim(coalesce(p_payload ->> 'table_id', '')), '')::uuid;
  if v_order_type = 'dine_in' then
    if v_table_id is null then
      raise exception 'Dine-in orders need a table.' using errcode = 'P0001';
    end if;
    if not exists (select 1 from public.dining_tables where id = v_table_id and outlet_id = v_outlet_id) then
      raise exception 'Pick a table that belongs to this outlet.' using errcode = 'P0001';
    end if;
  end if;

  if v_order_type = 'delivery' then
    if nullif(trim(coalesce(p_payload ->> 'customer_phone', '')), '') is null
       or nullif(trim(coalesce(p_payload ->> 'delivery_address', '')), '') is null then
      raise exception 'Delivery orders need a phone number and address.' using errcode = 'P0001';
    end if;
  end if;

  insert into public.business_order_counters (business_id, order_seq)
  values (v_outlet_business_id, 1001)
  on conflict (business_id)
  do update set order_seq = public.business_order_counters.order_seq + 1
  returning order_seq into v_order_number;

  insert into public.orders (
    business_id, outlet_id, order_number, client_ref, created_by,
    order_type, status, table_id,
    customer_name, customer_phone, delivery_address, notes
  ) values (
    v_outlet_business_id, v_outlet_id, v_order_number, v_client_ref, p_actor,
    v_order_type, v_status, v_table_id,
    nullif(trim(coalesce(p_payload ->> 'customer_name', '')), ''),
    nullif(trim(coalesce(p_payload ->> 'customer_phone', '')), ''),
    nullif(trim(coalesce(p_payload ->> 'delivery_address', '')), ''),
    nullif(trim(coalesce(p_payload ->> 'notes', '')), '')
  ) returning id into v_order_id;

  -- Phase 9: occupy the table under a row lock, rechecking concurrency-safely.
  if v_table_id is not null then
    select t.* into v_table
    from public.dining_tables t
    where t.id = v_table_id
    for update;
    if not v_table.is_active or v_table.status = 'occupied' then
      raise exception 'That table was just taken — pick another table.' using errcode = 'P0003';
    end if;
    update public.dining_tables
    set status = 'occupied', current_order_id = v_order_id, reservation_note = null
    where id = v_table_id;
  end if;

  v_subtotal := public.pos_persist_items(
    v_order_id, v_outlet_business_id, v_outlet_id, p_payload -> 'items');
  perform public.pos_apply_totals(
    v_order_id, v_outlet_business_id, v_subtotal,
    coalesce(p_payload -> 'discount', '{"type":"none"}'::jsonb), p_payload -> 'charges');

  insert into public.order_status_history (order_id, from_status, to_status, changed_by, note)
  values (v_order_id, null, v_status, p_actor, 'Order created');

  return v_order_id;
end;
$$;

revoke all on function public.create_pos_order(uuid, jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.create_pos_order(uuid, jsonb) to service_role;

-- ── amend order (open/held only; items replaced atomically) ────────────────

create or replace function public.amend_pos_order(
  p_actor uuid,
  p_order_id uuid,
  p_payload jsonb
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
  v_order_type text;
  v_order_table_id uuid;
  v_order_phone text;
  v_order_address text;
  v_status text;
  v_table_id uuid;
  v_subtotal bigint;
  v_table record;
begin
  select o.business_id, o.outlet_id, o.status, o.order_type, o.table_id,
         o.customer_phone, o.delivery_address
  into v_order_business_id, v_order_outlet_id, v_order_status, v_order_type,
       v_order_table_id, v_order_phone, v_order_address
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
  if v_order_status not in ('open', 'held') then
    raise exception 'Only open or held orders can be edited.' using errcode = 'P0001';
  end if;

  v_status := coalesce(p_payload ->> 'status', v_order_status);
  if v_status not in ('open', 'held') then
    raise exception 'An edited order stays open or held.' using errcode = 'P0001';
  end if;

  if v_order_type = 'dine_in' then
    v_table_id := coalesce(
      nullif(trim(coalesce(p_payload ->> 'table_id', '')), '')::uuid,
      v_order_table_id
    );
    if v_table_id is null
       or not exists (select 1 from public.dining_tables where id = v_table_id and outlet_id = v_order_outlet_id) then
      raise exception 'Dine-in orders need a valid table.' using errcode = 'P0001';
    end if;
    -- Phase 9: table changed → guarded transfer onto the new table.
    if v_table_id is distinct from v_order_table_id then
      select t.* into v_table
      from public.dining_tables t
      where t.id = v_table_id
      for update;
      if not v_table.is_active then
        raise exception 'This table is not active.' using errcode = 'P0001';
      end if;
      if v_table.status = 'occupied' and v_table.current_order_id is distinct from p_order_id then
        raise exception 'That table is already occupied.' using errcode = 'P0001';
      end if;
      if v_order_table_id is not null then
        update public.dining_tables
        set status = 'available', current_order_id = null, reservation_note = null
        where id = v_order_table_id and current_order_id = p_order_id;
      end if;
      update public.dining_tables
      set status = 'occupied', current_order_id = p_order_id, reservation_note = null
      where id = v_table_id;
    end if;
  else
    v_table_id := null;
  end if;

  if v_order_type = 'delivery' then
    if nullif(trim(coalesce(p_payload ->> 'customer_phone', v_order_phone, '')), '') is null
       or nullif(trim(coalesce(p_payload ->> 'delivery_address', v_order_address, '')), '') is null then
      raise exception 'Delivery orders need a phone number and address.' using errcode = 'P0001';
    end if;
  end if;

  update public.orders set
    status = v_status,
    table_id = v_table_id,
    customer_name = nullif(trim(coalesce(p_payload ->> 'customer_name', '')), ''),
    customer_phone = nullif(trim(coalesce(p_payload ->> 'customer_phone', '')), ''),
    delivery_address = nullif(trim(coalesce(p_payload ->> 'delivery_address', '')), ''),
    notes = nullif(trim(coalesce(p_payload ->> 'notes', '')), '')
  where id = p_order_id;

  v_subtotal := public.pos_persist_items(
    p_order_id, v_order_business_id, v_order_outlet_id, p_payload -> 'items');
  perform public.pos_apply_totals(
    p_order_id, v_order_business_id, v_subtotal,
    coalesce(p_payload -> 'discount', '{"type":"none"}'::jsonb), p_payload -> 'charges');

  if v_status <> v_order_status then
    insert into public.order_status_history (order_id, from_status, to_status, changed_by, note)
    values (p_order_id, v_order_status, v_status, p_actor, 'Order edited');
  end if;
end;
$$;

revoke all on function public.amend_pos_order(uuid, uuid, jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.amend_pos_order(uuid, uuid, jsonb) to service_role;

-- ── guarded state transitions ───────────────────────────────────────────────

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
  v_order_status text;
  v_paid_minor bigint;
  v_total_minor bigint;
  v_order_table_id uuid;
  v_allowed boolean := false;
begin
  select o.business_id, o.status, o.paid_minor, o.total_minor, o.table_id
  into v_order_business_id, v_order_status, v_paid_minor, v_total_minor, v_order_table_id
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

  if p_to = 'completed' and v_paid_minor < v_total_minor then
    raise exception 'Payment must be recorded before the order is completed.' using errcode = 'P0001';
  end if;

  update public.orders set status = p_to where id = p_order_id and status = v_order_status;
  if not found then
    raise exception 'The order changed while you were working — refresh and retry.' using errcode = 'P0001';
  end if;

  insert into public.order_status_history (order_id, from_status, to_status, changed_by, note)
  values (p_order_id, v_order_status, p_to, p_actor, nullif(trim(coalesce(p_note, '')), ''));

  -- Phase 9: closed orders free their table.
  if p_to in ('cancelled', 'completed') and v_order_table_id is not null then
    update public.dining_tables
    set status = 'available', current_order_id = null, reservation_note = null
    where id = v_order_table_id and current_order_id = p_order_id;
  end if;
end;
$$;

revoke all on function public.transition_order_status(uuid, uuid, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.transition_order_status(uuid, uuid, text, text) to service_role;

-- Phase 8 floor-plan wipe is now floor-aware and protects occupied tables.
-- Signature, return value, authorisation gate and error messages are
-- unchanged from Phase 8; sections now hang off the outlet's default floor.
create or replace function public.set_outlet_floor_plan(
  p_actor uuid,
  p_outlet_id uuid,
  p_sections jsonb
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_business_id uuid;
  v_section jsonb;
  v_table jsonb;
  v_section_id uuid;
  v_section_idx integer := 0;
  v_table_idx integer := 0;
  v_table_total integer := 0;
  v_floor_id uuid;
begin
  select business_id into v_business_id
  from public.outlets where id = p_outlet_id;

  if v_business_id is null then
    raise exception 'outlet not found' using errcode = 'P0001';
  end if;

  if not exists (
    select 1 from public.memberships m
    where m.business_id = v_business_id
      and m.user_id = p_actor
      and m.status = 'active'
      and m.role in ('owner', 'business_admin')
  ) then
    raise exception 'not authorised to configure this outlet' using errcode = 'P0001';
  end if;

  if jsonb_typeof(p_sections) <> 'array' or jsonb_array_length(p_sections) > 20 then
    raise exception 'sections must be an array of at most 20 entries' using errcode = 'P0001';
  end if;

  if exists (
    select 1 from public.dining_tables t
    where t.outlet_id = p_outlet_id and t.status = 'occupied'
  ) then
    raise exception 'occupied tables block a floor plan replace — settle or move them first' using errcode = 'P0001';
  end if;

  v_floor_id := public.default_floor_for_outlet(p_outlet_id);

  delete from public.dining_sections where outlet_id = p_outlet_id; -- tables cascade

  for v_section in select * from jsonb_array_elements(p_sections) loop
    if coalesce(jsonb_typeof(v_section -> 'name'), 'absent') <> 'string'
       or length(trim(v_section ->> 'name')) not between 1 and 60 then
      raise exception 'every section needs a name (max 60 chars)' using errcode = 'P0001';
    end if;
    if coalesce(jsonb_typeof(v_section -> 'tables'), 'absent') <> 'array' then
      raise exception 'every section needs a tables array' using errcode = 'P0001';
    end if;

    v_section_idx := v_section_idx + 1;
    v_table_idx := 0;

    insert into public.dining_sections (business_id, outlet_id, floor_id, name, sort_order)
    values (v_business_id, p_outlet_id, v_floor_id, trim(v_section ->> 'name'), v_section_idx)
    returning id into v_section_id;

    for v_table in select * from jsonb_array_elements(v_section -> 'tables') loop
      if coalesce(jsonb_typeof(v_table -> 'label'), 'absent') <> 'string'
         or length(trim(v_table ->> 'label')) not between 1 and 20 then
        raise exception 'every table needs a label (max 20 chars)' using errcode = 'P0001';
      end if;
      begin
        if (v_table ->> 'capacity')::int not between 1 and 50 then
          raise exception 'table capacity must be between 1 and 50' using errcode = 'P0001';
        end if;
      exception when others then
        raise exception 'table capacity must be a number between 1 and 50' using errcode = 'P0001';
      end;

      v_table_idx := v_table_idx + 1;
      v_table_total := v_table_total + 1;
      if v_table_total > 500 then
        raise exception 'at most 500 tables per outlet' using errcode = 'P0001';
      end if;

      insert into public.dining_tables
        (business_id, outlet_id, section_id, label, capacity, sort_order)
      values
        (v_business_id, p_outlet_id, v_section_id, trim(v_table ->> 'label'),
         (v_table ->> 'capacity')::int, v_table_idx);
    end loop;
  end loop;

  return v_table_total;
end;
$$;

revoke all on function public.set_outlet_floor_plan(uuid, uuid, jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.set_outlet_floor_plan(uuid, uuid, jsonb) to service_role;
