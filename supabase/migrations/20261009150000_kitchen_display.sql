-- ============================================================================
-- Phase 11 — Kitchen Display System (KDS)
--
-- Design (see docs/KDS.md):
--   * order_items carry a kitchen lifecycle (pending → new → accepted →
--     preparing → ready → completed, plus cancelled) and a station.
--   * kitchen_items is a money-free projection of ACTIVE kitchen work,
--     kept in sync by triggers. Kitchen clients read only this projection,
--     so price data never reaches the KDS.
--   * kitchen_events records cancellations / removals for the cancelled-item
--     notification and sound.
--   * All kitchen writes go through SECURITY DEFINER RPCs that check
--     kitchen.operate / kitchen.manage via require_outlet_permission.
--   * Kitchen permissions never include billing, refunds or settings.
--   * Order RLS becomes outlet-scoped (has_outlet_access), closing the
--     cross-outlet read path that realtime would otherwise expose.
-- ============================================================================

-- ── 1. permissions (kitchen domain) ─────────────────────────────────────────

insert into public.permissions (key, domain, action, description) values
  ('kitchen.view',    'kitchen', 'view',    'See kitchen tickets and station queues.'),
  ('kitchen.operate', 'kitchen', 'operate', 'Accept and advance kitchen tickets and items; set priority; acknowledge cancellations.'),
  ('kitchen.manage',  'kitchen', 'manage',  'Configure kitchen stations and category/item routing.')
on conflict (key) do nothing;

insert into public.role_permissions (role_key, permission_key)
select r.role_key, p.permission_key
from (values ('owner'), ('business_admin'), ('outlet_manager')) as r(role_key)
cross join (values ('kitchen.view'), ('kitchen.operate'), ('kitchen.manage')) as p(permission_key)
on conflict (role_key, permission_key) do nothing;

-- Kitchen staff: work the board only. No manage, no financial permissions.
insert into public.role_permissions (role_key, permission_key) values
  ('kitchen_staff', 'kitchen.view'),
  ('kitchen_staff', 'kitchen.operate')
on conflict (role_key, permission_key) do nothing;

-- ── 2. schema additions on orders / order_items ─────────────────────────────

alter table public.orders
  add column kitchen_priority boolean not null default false;

alter table public.order_items
  add column station_id uuid references public.kitchen_stations (id) on delete set null,
  add column kitchen_status text not null default 'pending'
    constraint order_items_kitchen_status_allowed check (
      kitchen_status in ('pending', 'new', 'accepted', 'preparing', 'ready', 'completed', 'cancelled')
    ),
  add column kitchen_status_at timestamptz not null default now(),
  add column kitchen_sent_at timestamptz;

create index order_items_kitchen_idx on public.order_items (order_id, kitchen_status);
create index order_items_station_idx on public.order_items (station_id);

-- ── 3. routing table ────────────────────────────────────────────────────────

create table public.kitchen_routes (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  outlet_id uuid not null references public.outlets (id) on delete cascade,
  target_type text not null
    constraint kitchen_routes_target_type_allowed check (target_type in ('category', 'item', 'combo')),
  target_id uuid not null,
  station_id uuid not null references public.kitchen_stations (id) on delete cascade,
  created_at timestamptz not null default now(),
  constraint kitchen_routes_unique_target unique (outlet_id, target_type, target_id)
);

create index kitchen_routes_station_idx on public.kitchen_routes (station_id);

-- ── 4. projection + events ──────────────────────────────────────────────────

create table public.kitchen_items (
  id uuid primary key,  -- = order_items.id
  business_id uuid not null references public.businesses (id) on delete cascade,
  outlet_id uuid not null references public.outlets (id) on delete cascade,
  order_id uuid not null references public.orders (id) on delete cascade,
  order_number integer not null,
  order_type text not null,
  table_label text,
  station_id uuid references public.kitchen_stations (id) on delete set null,
  item_name text not null,
  quantity integer not null,
  item_notes text,
  modifiers jsonb not null default '[]'::jsonb,
  -- Terminal rows (completed / cancelled) are kept on purpose: finished work
  -- leaves the board by an UPDATE, so realtime never needs DELETE events.
  kitchen_status text not null
    constraint kitchen_items_status_allowed check (
      kitchen_status in ('new', 'accepted', 'preparing', 'ready', 'completed', 'cancelled')
    ),
  kitchen_status_at timestamptz not null,
  sent_at timestamptz not null,
  priority boolean not null default false,
  position integer not null default 0,
  updated_at timestamptz not null default now()
);

create index kitchen_items_outlet_idx on public.kitchen_items (outlet_id, kitchen_status);

create index kitchen_items_active_idx on public.kitchen_items (outlet_id, sent_at)
  where kitchen_status in ('new', 'accepted', 'preparing', 'ready');

create table public.kitchen_events (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  outlet_id uuid not null references public.outlets (id) on delete cascade,
  order_id uuid not null references public.orders (id) on delete cascade,
  order_number integer not null,
  station_id uuid references public.kitchen_stations (id) on delete set null,
  item_name text not null,
  quantity integer not null,
  reason text not null
    constraint kitchen_events_reason_allowed check (reason in ('order_cancelled', 'item_cancelled', 'item_removed')),
  created_at timestamptz not null default now(),
  acknowledged_at timestamptz,
  acknowledged_by uuid references auth.users (id) on delete set null
);

create index kitchen_events_open_idx on public.kitchen_events (outlet_id, created_at)
  where acknowledged_at is null;

-- ── 5. RLS helper (outlet + permission, for kitchen-facing reads) ───────────

create or replace function public.has_outlet_permission(p_outlet_id uuid, p_permission text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.outlets o
    join public.memberships m
      on m.business_id = o.business_id
     and m.user_id = auth.uid()
     and m.status = 'active'
    left join public.membership_outlets mo
      on mo.membership_id = m.id
     and mo.outlet_id = o.id
    join public.role_permissions rp
      on rp.role_key = m.role
     and rp.permission_key = p_permission
    where o.id = p_outlet_id
      and (m.role in ('owner', 'business_admin') or mo.outlet_id is not null)
  );
$$;

revoke all on function public.has_outlet_permission(uuid, text) from public, anon;
grant execute on function public.has_outlet_permission(uuid, text) to authenticated, service_role;

-- ── 6. routing resolution ───────────────────────────────────────────────────
-- Order: item route → category route → null (unrouted). Combos: combo route only.
-- Inactive stations never receive new routing.

create or replace function public.kitchen_resolve_station(
  p_outlet_id uuid,
  p_product_id uuid,
  p_combo_id uuid
)
returns uuid
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_station uuid;
  v_category uuid;
begin
  if p_combo_id is not null then
    select r.station_id into v_station
    from public.kitchen_routes r
    join public.kitchen_stations s on s.id = r.station_id and s.is_active
    where r.outlet_id = p_outlet_id and r.target_type = 'combo' and r.target_id = p_combo_id;
    return v_station;
  end if;

  if p_product_id is null then
    return null;
  end if;

  select r.station_id into v_station
  from public.kitchen_routes r
  join public.kitchen_stations s on s.id = r.station_id and s.is_active
  where r.outlet_id = p_outlet_id and r.target_type = 'item' and r.target_id = p_product_id;
  if v_station is not null then
    return v_station;
  end if;

  select mi.category_id into v_category from public.menu_items mi where mi.id = p_product_id;
  if v_category is null then
    return null;
  end if;

  select r.station_id into v_station
  from public.kitchen_routes r
  join public.kitchen_stations s on s.id = r.station_id and s.is_active
  where r.outlet_id = p_outlet_id and r.target_type = 'category' and r.target_id = v_category;
  return v_station;
end;
$$;

revoke all on function public.kitchen_resolve_station(uuid, uuid, uuid) from public, anon, authenticated;

-- ── 7. projection sync ──────────────────────────────────────────────────────

create or replace function public.kitchen_sync_item(p_item_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v record;
begin
  select oi.id, oi.kitchen_status, oi.kitchen_status_at, oi.kitchen_sent_at, oi.station_id,
         oi.name, oi.quantity, oi.item_notes, oi.position,
         o.id as order_id, o.business_id, o.outlet_id, o.order_number, o.order_type,
         o.kitchen_priority, t.label as table_label,
         coalesce((
           select jsonb_agg(jsonb_build_object('name', m.name, 'quantity', m.quantity) order by m.name)
           from public.order_item_modifiers m
           where m.order_item_id = oi.id
         ), '[]'::jsonb) as modifiers
    into v
  from public.order_items oi
  join public.orders o on o.id = oi.order_id
  left join public.dining_tables t on t.id = o.table_id
  where oi.id = p_item_id;

  if not found or v.kitchen_status = 'pending' then
    delete from public.kitchen_items where id = p_item_id;
    return;
  end if;

  insert into public.kitchen_items (
    id, business_id, outlet_id, order_id, order_number, order_type, table_label,
    station_id, item_name, quantity, item_notes, modifiers, kitchen_status,
    kitchen_status_at, sent_at, priority, position, updated_at
  ) values (
    v.id, v.business_id, v.outlet_id, v.order_id, v.order_number, v.order_type, v.table_label,
    v.station_id, v.name, v.quantity, v.item_notes, v.modifiers, v.kitchen_status,
    v.kitchen_status_at, coalesce(v.kitchen_sent_at, v.kitchen_status_at), v.kitchen_priority,
    v.position, now()
  )
  on conflict (id) do update set
    business_id = excluded.business_id,
    outlet_id = excluded.outlet_id,
    order_id = excluded.order_id,
    order_number = excluded.order_number,
    order_type = excluded.order_type,
    table_label = excluded.table_label,
    station_id = excluded.station_id,
    item_name = excluded.item_name,
    quantity = excluded.quantity,
    item_notes = excluded.item_notes,
    modifiers = excluded.modifiers,
    kitchen_status = excluded.kitchen_status,
    kitchen_status_at = excluded.kitchen_status_at,
    sent_at = excluded.sent_at,
    priority = excluded.priority,
    position = excluded.position,
    updated_at = now();
end;
$$;

revoke all on function public.kitchen_sync_item(uuid) from public, anon, authenticated;

-- ── 8. backfill existing POS data (before triggers exist) ───────────────────

update public.order_items oi
set station_id = public.kitchen_resolve_station(o.outlet_id, oi.product_id, oi.combo_id)
from public.orders o
where o.id = oi.order_id;

update public.order_items oi
set kitchen_status = case
      when o.status in ('placed', 'preparing', 'ready') then 'new'
      when o.status = 'completed' then 'completed'
      when o.status = 'cancelled' then 'cancelled'
      else 'pending'
    end,
    kitchen_sent_at = case when o.status in ('placed', 'preparing', 'ready', 'completed') then now() else null end
from public.orders o
where o.id = oi.order_id;

-- ── 9. triggers ─────────────────────────────────────────────────────────────

-- 9a. BEFORE: stamp station and kitchen status on insert; keep status clock.
create or replace function public.kitchen_order_items_prepare()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_outlet uuid;
  v_status text;
begin
  if tg_op = 'INSERT' then
    select o.outlet_id, o.status into v_outlet, v_status
    from public.orders o where o.id = new.order_id;

    new.station_id := public.kitchen_resolve_station(v_outlet, new.product_id, new.combo_id);
    if v_status in ('placed', 'preparing', 'ready') then
      new.kitchen_status := 'new';
      new.kitchen_sent_at := now();
    else
      new.kitchen_status := 'pending';
      new.kitchen_sent_at := null;
    end if;
    new.kitchen_status_at := now();
    return new;
  end if;

  -- UPDATE: an item moved onto a sent order (merge) must not stay pending.
  if new.order_id is distinct from old.order_id then
    select o.status into v_status from public.orders o where o.id = new.order_id;
    if new.kitchen_status = 'pending' and v_status in ('placed', 'preparing', 'ready') then
      new.kitchen_status := 'new';
      new.kitchen_sent_at := now();
    end if;
  end if;

  if new.kitchen_status is distinct from old.kitchen_status then
    new.kitchen_status_at := now();
  end if;
  return new;
end;
$$;

revoke all on function public.kitchen_order_items_prepare() from public, anon, authenticated;

create trigger order_items_kitchen_prepare
  before insert or update on public.order_items
  for each row execute function public.kitchen_order_items_prepare();

-- 9b. AFTER: keep projection and events in step with every item write.
create or replace function public.kitchen_order_items_sync()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order_status text;
begin
  if tg_op = 'DELETE' then
    delete from public.kitchen_items where id = old.id;
    -- Cascade deletes (order removed) have no parent row left: no event.
    if old.kitchen_status in ('new', 'accepted', 'preparing', 'ready')
       and exists (select 1 from public.orders o where o.id = old.order_id) then
      insert into public.kitchen_events (
        business_id, outlet_id, order_id, order_number, station_id, item_name, quantity, reason
      )
      select o.business_id, o.outlet_id, o.id, o.order_number, old.station_id, old.name, old.quantity,
             'item_removed'
      from public.orders o where o.id = old.order_id;
    end if;
    return old;
  end if;

  perform public.kitchen_sync_item(new.id);

  if tg_op = 'UPDATE'
     and new.kitchen_status = 'cancelled'
     and old.kitchen_status in ('new', 'accepted', 'preparing', 'ready') then
    select o.status into v_order_status from public.orders o where o.id = new.order_id;
    insert into public.kitchen_events (
      business_id, outlet_id, order_id, order_number, station_id, item_name, quantity, reason
    )
    select o.business_id, o.outlet_id, o.id, o.order_number, new.station_id, new.name, new.quantity,
           case when v_order_status = 'cancelled' then 'order_cancelled' else 'item_cancelled' end
    from public.orders o where o.id = new.order_id;
  end if;

  return new;
end;
$$;

revoke all on function public.kitchen_order_items_sync() from public, anon, authenticated;

create trigger order_items_kitchen_sync
  after insert or update or delete on public.order_items
  for each row execute function public.kitchen_order_items_sync();

-- 9c. AFTER: modifiers change the projected modifier list.
create or replace function public.kitchen_modifiers_sync()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'DELETE' then
    perform public.kitchen_sync_item(old.order_item_id);
    return old;
  end if;
  perform public.kitchen_sync_item(new.order_item_id);
  return new;
end;
$$;

revoke all on function public.kitchen_modifiers_sync() from public, anon, authenticated;

create trigger order_item_modifiers_kitchen_sync
  after insert or delete on public.order_item_modifiers
  for each row execute function public.kitchen_modifiers_sync();

-- 9d. AFTER: order status / priority / table changes drive the board.
create or replace function public.kitchen_orders_sync()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_item record;
begin
  if new.status is distinct from old.status then
    -- Sending: POS moved the order into the kitchen.
    if old.status in ('open', 'held') and new.status in ('placed', 'preparing', 'ready') then
      update public.order_items
      set kitchen_status = 'new', kitchen_sent_at = now()
      where order_id = new.id and kitchen_status = 'pending';
    end if;

    -- Cancelling: active kitchen work is cancelled (events are raised per item).
    if new.status = 'cancelled' then
      update public.order_items
      set kitchen_status = 'cancelled'
      where order_id = new.id and kitchen_status in ('new', 'accepted', 'preparing', 'ready');
    end if;

    -- Completing: the work is done from the POS side; clear the board.
    if new.status = 'completed' then
      update public.order_items
      set kitchen_status = 'completed'
      where order_id = new.id and kitchen_status in ('new', 'accepted', 'preparing', 'ready');
    end if;
  end if;

  if new.kitchen_priority is distinct from old.kitchen_priority
     or new.table_id is distinct from old.table_id
     or new.order_type is distinct from old.order_type
     or new.order_number is distinct from old.order_number then
    for v_item in select id from public.order_items where order_id = new.id loop
      perform public.kitchen_sync_item(v_item.id);
    end loop;
  end if;

  return new;
end;
$$;

revoke all on function public.kitchen_orders_sync() from public, anon, authenticated;

create trigger orders_kitchen_sync
  after update on public.orders
  for each row execute function public.kitchen_orders_sync();

-- ── 10. initial projection from backfilled data ─────────────────────────────

do $$
declare
  v_id uuid;
begin
  for v_id in select id from public.order_items loop
    perform public.kitchen_sync_item(v_id);
  end loop;
end;
$$;

-- ── 11. station + routing config (atomic, deactivates instead of deleting) ──

create or replace function public.kitchen_apply_stations(
  p_business_id uuid,
  p_outlet_id uuid,
  p_stations jsonb
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_station jsonb;
  v_idx integer := 0;
  v_name text;
  v_description text;
  v_id uuid;
  v_kept uuid[] := '{}';
begin
  if jsonb_typeof(p_stations) <> 'array' or jsonb_array_length(p_stations) > 20 then
    raise exception 'stations must be an array of at most 20 entries' using errcode = 'P0001';
  end if;

  for v_station in select * from jsonb_array_elements(p_stations) loop
    if coalesce(jsonb_typeof(v_station -> 'name'), 'absent') <> 'string'
       or length(trim(v_station ->> 'name')) not between 1 and 60 then
      raise exception 'every station needs a name (max 60 chars)' using errcode = 'P0001';
    end if;
    if v_station ? 'description'
       and jsonb_typeof(v_station -> 'description') <> 'null'
       and (jsonb_typeof(v_station -> 'description') <> 'string'
            or length(v_station ->> 'description') > 200) then
      raise exception 'station descriptions are text of at most 200 chars' using errcode = 'P0001';
    end if;

    v_name := trim(v_station ->> 'name');
    v_description := case when jsonb_typeof(v_station -> 'description') = 'string'
                          then v_station ->> 'description' else null end;
    v_idx := v_idx + 1;

    insert into public.kitchen_stations (business_id, outlet_id, name, description, sort_order, is_active)
    values (p_business_id, p_outlet_id, v_name, v_description, v_idx, true)
    on conflict (outlet_id, (lower(trim(name)))) do update
      set name = excluded.name,
          description = excluded.description,
          sort_order = excluded.sort_order,
          is_active = true,
          updated_at = now()
    returning id into v_id;

    if v_id = any (v_kept) then
      raise exception 'station names must be unique' using errcode = 'P0001';
    end if;
    v_kept := v_kept || v_id;
  end loop;

  -- Removed stations are kept (deactivated) so existing tickets and routes stay intact.
  update public.kitchen_stations
  set is_active = false, updated_at = now()
  where outlet_id = p_outlet_id
    and is_active
    and not (id = any (v_kept));

  return (select count(*)::integer from public.kitchen_stations
          where outlet_id = p_outlet_id and is_active);
end;
$$;

revoke all on function public.kitchen_apply_stations(uuid, uuid, jsonb) from public, anon, authenticated;

-- Onboarding entry point: same owner/admin gate as before, now non-destructive.
create or replace function public.set_outlet_kitchen_stations(
  p_actor uuid,
  p_outlet_id uuid,
  p_stations jsonb
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_business_id uuid;
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

  return public.kitchen_apply_stations(v_business_id, p_outlet_id, p_stations);
end;
$$;

revoke all on function public.set_outlet_kitchen_stations(uuid, uuid, jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.set_outlet_kitchen_stations(uuid, uuid, jsonb) to service_role;

create or replace function public.kitchen_save_stations(
  p_actor uuid,
  p_outlet_id uuid,
  p_stations jsonb
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_business_id uuid;
begin
  v_business_id := public.require_outlet_permission(p_actor, p_outlet_id, 'kitchen.manage');
  return public.kitchen_apply_stations(v_business_id, p_outlet_id, p_stations);
end;
$$;

revoke all on function public.kitchen_save_stations(uuid, uuid, jsonb)
  from public, anon, authenticated;
grant execute on function public.kitchen_save_stations(uuid, uuid, jsonb) to service_role;

create or replace function public.kitchen_save_routes(
  p_actor uuid,
  p_outlet_id uuid,
  p_routes jsonb
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_business_id uuid;
  v_route jsonb;
  v_type text;
  v_target uuid;
  v_station uuid;
  v_count integer := 0;
  v_uuid_pattern constant text :=
    '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
  v_exists boolean;
begin
  v_business_id := public.require_outlet_permission(p_actor, p_outlet_id, 'kitchen.manage');

  if jsonb_typeof(p_routes) <> 'array' or jsonb_array_length(p_routes) > 500 then
    raise exception 'routes must be an array of at most 500 entries' using errcode = 'P0001';
  end if;

  delete from public.kitchen_routes where outlet_id = p_outlet_id;

  for v_route in select * from jsonb_array_elements(p_routes) loop
    v_type := v_route ->> 'target_type';
    if v_type not in ('category', 'item', 'combo') then
      raise exception 'route target must be a category, item or combo' using errcode = 'P0001';
    end if;
    if coalesce(v_route ->> 'target_id', '') !~ v_uuid_pattern
       or coalesce(v_route ->> 'station_id', '') !~ v_uuid_pattern then
      raise exception 'routes need valid target and station ids' using errcode = 'P0001';
    end if;
    v_target := (v_route ->> 'target_id')::uuid;
    v_station := (v_route ->> 'station_id')::uuid;

    select exists (
      select 1 from public.kitchen_stations s
      where s.id = v_station and s.outlet_id = p_outlet_id and s.is_active
    ) into v_exists;
    if not v_exists then
      raise exception 'routes must point at an active station of this outlet' using errcode = 'P0001';
    end if;

    if v_type = 'category' then
      select exists (select 1 from public.menu_categories c
                     where c.id = v_target and c.business_id = v_business_id) into v_exists;
    elsif v_type = 'item' then
      select exists (select 1 from public.menu_items i
                     where i.id = v_target and i.business_id = v_business_id) into v_exists;
    else
      select exists (select 1 from public.combos c
                     where c.id = v_target and c.business_id = v_business_id) into v_exists;
    end if;
    if not v_exists then
      raise exception 'routed target does not belong to this business' using errcode = 'P0001';
    end if;

    insert into public.kitchen_routes (business_id, outlet_id, target_type, target_id, station_id)
    values (v_business_id, p_outlet_id, v_type, v_target, v_station)
    on conflict (outlet_id, target_type, target_id) do update
      set station_id = excluded.station_id;
    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$$;

revoke all on function public.kitchen_save_routes(uuid, uuid, jsonb)
  from public, anon, authenticated;
grant execute on function public.kitchen_save_routes(uuid, uuid, jsonb) to service_role;

-- ── 12. kitchen operations (never touch money) ──────────────────────────────

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
  return v_count;
end;
$$;

create or replace function public.kds_set_priority(
  p_actor uuid,
  p_order_id uuid,
  p_priority boolean
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_outlet uuid;
  v_status text;
begin
  select o.outlet_id, o.status into v_outlet, v_status
  from public.orders o where o.id = p_order_id
  for update;
  if v_outlet is null then
    raise exception 'Order not found.' using errcode = 'P0001';
  end if;

  perform public.require_outlet_permission(p_actor, v_outlet, 'kitchen.operate');

  if v_status not in ('placed', 'preparing', 'ready') then
    raise exception 'Only sent orders can be prioritised.' using errcode = 'P0001';
  end if;

  update public.orders set kitchen_priority = p_priority where id = p_order_id;
  return p_priority;
end;
$$;

create or replace function public.kds_acknowledge_event(p_actor uuid, p_event_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_outlet uuid;
begin
  select e.outlet_id into v_outlet from public.kitchen_events e where e.id = p_event_id;
  if v_outlet is null then
    raise exception 'Notification not found.' using errcode = 'P0001';
  end if;

  perform public.require_outlet_permission(p_actor, v_outlet, 'kitchen.operate');

  update public.kitchen_events
  set acknowledged_at = now(), acknowledged_by = p_actor
  where id = p_event_id and acknowledged_at is null;
  return true;
end;
$$;

-- Kitchen RPCs: service role only (server actions call them after checks).
revoke all on function public.kds_advance_item(uuid, uuid, text, text) from public, anon, authenticated;
revoke all on function public.kds_advance_ticket(uuid, uuid, uuid, text, text) from public, anon, authenticated;
revoke all on function public.kds_set_priority(uuid, uuid, boolean) from public, anon, authenticated;
revoke all on function public.kds_acknowledge_event(uuid, uuid) from public, anon, authenticated;
grant execute on function public.kds_advance_item(uuid, uuid, text, text) to service_role;
grant execute on function public.kds_advance_ticket(uuid, uuid, uuid, text, text) to service_role;
grant execute on function public.kds_set_priority(uuid, uuid, boolean) to service_role;
grant execute on function public.kds_acknowledge_event(uuid, uuid) to service_role;

-- ── 13. RLS ─────────────────────────────────────────────────────────────────

alter table public.kitchen_routes enable row level security;
alter table public.kitchen_items enable row level security;
alter table public.kitchen_events enable row level security;

create policy "kitchen_routes_select_kitchen"
  on public.kitchen_routes for select to authenticated
  using (public.has_outlet_permission(outlet_id, 'kitchen.view'));

create policy "kitchen_items_select_kitchen"
  on public.kitchen_items for select to authenticated
  using (public.has_outlet_permission(outlet_id, 'kitchen.view'));

create policy "kitchen_events_select_kitchen"
  on public.kitchen_events for select to authenticated
  using (public.has_outlet_permission(outlet_id, 'kitchen.view'));

revoke all on public.kitchen_routes, public.kitchen_items, public.kitchen_events from public, anon, authenticated;
grant select on public.kitchen_routes, public.kitchen_items, public.kitchen_events to authenticated;

-- Pre-existing gap (Phase 8): order reads were business-wide, so a user
-- scoped to one outlet could read another outlet's orders with their own
-- session. Scope them to the outlet. Business owners/admins are unaffected.
drop policy if exists "orders_select_member" on public.orders;
create policy "orders_select_outlet"
  on public.orders for select to authenticated
  using (public.has_outlet_access(outlet_id));

drop policy if exists "order_items_select_member" on public.order_items;
create policy "order_items_select_outlet"
  on public.order_items for select to authenticated
  using (
    exists (select 1 from public.orders o
            where o.id = order_items.order_id
              and public.has_outlet_access(o.outlet_id))
  );

drop policy if exists "order_item_modifiers_select_member" on public.order_item_modifiers;
create policy "order_item_modifiers_select_outlet"
  on public.order_item_modifiers for select to authenticated
  using (
    exists (
      select 1
      from public.order_items oi
      join public.orders o on o.id = oi.order_id
      where oi.id = order_item_modifiers.order_item_id
        and public.has_outlet_access(o.outlet_id)
    )
  );

drop policy if exists "order_status_history_select_member" on public.order_status_history;
create policy "order_status_history_select_outlet"
  on public.order_status_history for select to authenticated
  using (
    exists (select 1 from public.orders o
            where o.id = order_status_history.order_id
              and public.has_outlet_access(o.outlet_id))
  );

-- ── 14. realtime ────────────────────────────────────────────────────────────

-- Replica identity stays DEFAULT on purpose. FULL would put whole rows (item
-- names, modifiers) into DELETE payloads that are not row-level filtered; with
-- DEFAULT a delete carries only the id. Finished work is never deleted in normal
-- flow (see kitchen_items), so this path is only reached by order/item removal.
alter table public.kitchen_items replica identity default;
alter table public.kitchen_events replica identity default;

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'kitchen_items'
    ) then
      alter publication supabase_realtime add table public.kitchen_items;
    end if;
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'kitchen_events'
    ) then
      alter publication supabase_realtime add table public.kitchen_events;
    end if;
  end if;
end;
$$;
