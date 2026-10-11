-- RestroNex Phase 13: recipes + inventory.
--
--   * ingredients and units (with same-family conversions into a base unit)
--   * recipes: product → ingredient quantities, combos explode into their products
--   * stock ledger (inventory_movements): append-only, every change traceable
--   * stock_levels cache + batch balances, kept in step by a trigger and checked by
--     inventory_reconcile(); the cache is never written directly
--   * batches with expiry: FEFO consumption that skips expired stock
--   * receipts, wastage, counts (adjustments), transfers between outlets
--   * recipe consumption when an order reaches `completed`, posted once per order
--
-- Money: costs are minor units per base unit (numeric 14,4). Values are exact
-- (numeric 16,4) and only rounded for display.
--
-- Writes go through service-role RPCs that re-check the permission in SQL.

-- ── 1. units ────────────────────────────────────────────────────────────────

create table public.units (
  code text primary key,
  label text not null,
  family text not null
    constraint units_family_allowed check (family in ('mass', 'volume', 'count')),
  to_base numeric(18, 6) not null
    constraint units_to_base_positive check (to_base > 0),
  is_base boolean not null default false
);

insert into public.units (code, label, family, to_base, is_base) values
  ('g', 'Gram', 'mass', 1, true),
  ('kg', 'Kilogram', 'mass', 1000, false),
  ('ml', 'Millilitre', 'volume', 1, true),
  ('l', 'Litre', 'volume', 1000, false),
  ('pc', 'Piece', 'count', 1, true),
  ('dz', 'Dozen', 'count', 12, false)
on conflict (code) do nothing;

alter table public.units enable row level security;
revoke all on public.units from public, anon, authenticated;
grant select on public.units to authenticated;
create policy "units_select_authenticated" on public.units for select to authenticated using (true);

-- Convert a quantity in `p_unit` into the ingredient's base unit (same family only).
create or replace function public.inventory_base_qty(p_ingredient_unit text, p_unit text, p_qty numeric)
returns numeric
language plpgsql
stable
set search_path = public
as $$
declare
  v_family text;
  v_factor numeric;
  v_base_family text;
begin
  select u.family, u.to_base into v_family, v_factor from public.units u where u.code = p_unit;
  select u.family into v_base_family from public.units u where u.code = p_ingredient_unit and u.is_base;
  if v_factor is null or v_base_family is null then
    raise exception 'Unknown unit.' using errcode = 'P0001';
  end if;
  if v_family <> v_base_family then
    raise exception 'Unit % does not match the ingredient unit.', p_unit using errcode = 'P0001';
  end if;
  return p_qty * v_factor;
end;
$$;

-- Cost per base unit from a cost quoted per `p_unit`.
create or replace function public.inventory_base_unit_cost(p_unit text, p_cost_per_unit numeric)
returns numeric
language sql
stable
set search_path = public
as $$
  select p_cost_per_unit / u.to_base from public.units u where u.code = p_unit;
$$;

-- ── 2. ingredients ──────────────────────────────────────────────────────────

create table public.ingredients (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  name text not null
    constraint ingredients_name_length check (char_length(name) between 1 and 80),
  unit text not null
    constraint ingredients_unit_base check (unit in ('g', 'ml', 'pc')),
  cost_per_unit numeric(14, 4) not null default 0
    constraint ingredients_cost_range check (cost_per_unit >= 0),
  minimum_stock numeric(14, 3) not null default 0
    constraint ingredients_minimum_range check (minimum_stock >= 0),
  maximum_stock numeric(14, 3)
    constraint ingredients_maximum_range check (maximum_stock is null or maximum_stock >= minimum_stock),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ingredients_name_unique unique (business_id, name)
);

alter table public.ingredients enable row level security;
revoke all on public.ingredients from public, anon, authenticated;
grant select on public.ingredients to authenticated;
create policy "ingredients_select_inventory" on public.ingredients for select to authenticated
  using (public.has_business_permission(business_id, 'inventory.view'));

-- ── 3. stock levels (cache) and batches ─────────────────────────────────────

create table public.inventory_stock (
  business_id uuid not null references public.businesses (id) on delete cascade,
  outlet_id uuid not null references public.outlets (id) on delete cascade,
  ingredient_id uuid not null references public.ingredients (id) on delete cascade,
  on_hand numeric(14, 3) not null default 0,
  updated_at timestamptz not null default now(),
  primary key (outlet_id, ingredient_id)
);

alter table public.inventory_stock enable row level security;
revoke all on public.inventory_stock from public, anon, authenticated;
grant select on public.inventory_stock to authenticated;
create policy "inventory_stock_select_outlet" on public.inventory_stock for select to authenticated
  using (public.has_outlet_permission(outlet_id, 'inventory.view'));

create table public.inventory_batches (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  outlet_id uuid not null references public.outlets (id) on delete cascade,
  ingredient_id uuid not null references public.ingredients (id) on delete restrict,
  batch_code text
    constraint inventory_batches_code_length check (batch_code is null or char_length(batch_code) <= 40),
  received_qty numeric(14, 3) not null
    constraint inventory_batches_received_positive check (received_qty > 0),
  remaining_qty numeric(14, 3) not null default 0
    constraint inventory_batches_remaining_range check (remaining_qty >= 0),
  unit_cost numeric(14, 4) not null
    constraint inventory_batches_cost_range check (unit_cost >= 0),
  received_on date not null default current_date,
  expires_on date,
  source text not null
    constraint inventory_batches_source_allowed check (source in ('receipt', 'transfer_in', 'adjustment')),
  created_at timestamptz not null default now(),
  constraint inventory_batches_expiry_order check (expires_on is null or expires_on >= received_on)
);

create index inventory_batches_fefo on public.inventory_batches (outlet_id, ingredient_id, expires_on, received_on);

alter table public.inventory_batches enable row level security;
revoke all on public.inventory_batches from public, anon, authenticated;
grant select on public.inventory_batches to authenticated;
create policy "inventory_batches_select_outlet" on public.inventory_batches for select to authenticated
  using (public.has_outlet_permission(outlet_id, 'inventory.view'));

-- ── 4. transfers ────────────────────────────────────────────────────────────

create table public.stock_transfers (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  from_outlet_id uuid not null references public.outlets (id) on delete cascade,
  to_outlet_id uuid not null references public.outlets (id) on delete cascade,
  note text
    constraint stock_transfers_note_length check (note is null or char_length(note) <= 200),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  constraint stock_transfers_distinct_outlets check (from_outlet_id <> to_outlet_id)
);

create table public.stock_transfer_items (
  id uuid primary key default gen_random_uuid(),
  transfer_id uuid not null references public.stock_transfers (id) on delete cascade,
  ingredient_id uuid not null references public.ingredients (id) on delete restrict,
  quantity numeric(14, 3) not null constraint stock_transfer_items_qty_positive check (quantity > 0),
  unit_cost numeric(14, 4) not null,
  value_minor numeric(16, 4) not null
);

alter table public.stock_transfers enable row level security;
alter table public.stock_transfer_items enable row level security;
revoke all on public.stock_transfers, public.stock_transfer_items from public, anon, authenticated;
grant select on public.stock_transfers, public.stock_transfer_items to authenticated;
create policy "stock_transfers_select_outlet" on public.stock_transfers for select to authenticated
  using (public.has_outlet_permission(from_outlet_id, 'inventory.view')
         or public.has_outlet_permission(to_outlet_id, 'inventory.view'));
create policy "stock_transfer_items_select_outlet" on public.stock_transfer_items for select to authenticated
  using (exists (
    select 1 from public.stock_transfers t
    where t.id = transfer_id
      and (public.has_outlet_permission(t.from_outlet_id, 'inventory.view')
           or public.has_outlet_permission(t.to_outlet_id, 'inventory.view'))));

-- ── 5. stock ledger (append-only) ───────────────────────────────────────────

create table public.inventory_movements (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  outlet_id uuid not null references public.outlets (id) on delete cascade,
  ingredient_id uuid not null references public.ingredients (id) on delete restrict,
  batch_id uuid references public.inventory_batches (id) on delete restrict,
  kind text not null
    constraint inventory_movements_kind_allowed check (
      kind in ('receipt', 'consumption', 'wastage', 'adjustment', 'transfer_out', 'transfer_in')),
  qty numeric(14, 3) not null constraint inventory_movements_qty_nonzero check (qty <> 0),
  unit_cost numeric(14, 4) not null,
  value_minor numeric(16, 4) not null,
  order_id uuid,
  transfer_id uuid references public.stock_transfers (id) on delete restrict,
  reason text
    constraint inventory_movements_reason_length check (reason is null or char_length(reason) <= 200),
  reference_key text not null,
  actor_id uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  constraint inventory_movements_reference_unique unique (business_id, reference_key),
  constraint inventory_movements_sign_matches_kind check (
    (kind in ('receipt', 'transfer_in') and qty > 0)
    or (kind in ('consumption', 'wastage', 'transfer_out') and qty < 0)
    or kind = 'adjustment')
);

create index inventory_movements_outlet_time on public.inventory_movements (outlet_id, created_at);
create index inventory_movements_order on public.inventory_movements (order_id) where order_id is not null;

alter table public.inventory_movements enable row level security;
revoke all on public.inventory_movements from public, anon, authenticated;
grant select on public.inventory_movements to authenticated;
create policy "inventory_movements_select_outlet" on public.inventory_movements for select to authenticated
  using (public.has_outlet_permission(outlet_id, 'inventory.view'));

create or replace function public.inventory_ledger_append_only()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  raise exception 'Inventory movements are append-only. Post a correction instead.' using errcode = '42501';
end;
$$;

revoke all on function public.inventory_ledger_append_only() from public, anon, authenticated;

create trigger inventory_movements_append_only
  before update or delete on public.inventory_movements
  for each row execute function public.inventory_ledger_append_only();

-- Every movement updates the outlet's stock cache and, when batched, the batch balance.
-- The batch's remaining_qty check refuses any over-draw of a batch.
create or replace function public.inventory_movements_apply()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.inventory_stock (business_id, outlet_id, ingredient_id, on_hand, updated_at)
  values (new.business_id, new.outlet_id, new.ingredient_id, new.qty, now())
  on conflict (outlet_id, ingredient_id) do update
    set on_hand = public.inventory_stock.on_hand + excluded.on_hand,
        updated_at = now();

  if new.batch_id is not null then
    update public.inventory_batches
    set remaining_qty = remaining_qty + new.qty
    where id = new.batch_id;
  end if;
  return null;
end;
$$;

revoke all on function public.inventory_movements_apply() from public, anon, authenticated;

create trigger inventory_movements_apply
  after insert on public.inventory_movements
  for each row execute function public.inventory_movements_apply();

-- ── 6. stock adjustments (count records) and idempotency ledger ─────────────

create table public.stock_adjustments (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  outlet_id uuid not null references public.outlets (id) on delete cascade,
  ingredient_id uuid not null references public.ingredients (id) on delete restrict,
  system_qty numeric(14, 3) not null,
  counted_qty numeric(14, 3) not null constraint stock_adjustments_counted_range check (counted_qty >= 0),
  delta numeric(14, 3) not null,
  reason text not null
    constraint stock_adjustments_reason_length check (char_length(reason) between 1 and 200),
  actor_id uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now()
);

alter table public.stock_adjustments enable row level security;
revoke all on public.stock_adjustments from public, anon, authenticated;
grant select on public.stock_adjustments to authenticated;
create policy "stock_adjustments_select_outlet" on public.stock_adjustments for select to authenticated
  using (public.has_outlet_permission(outlet_id, 'inventory.view'));

-- Every manual inventory write records its client reference here. A retry with the
-- same reference returns the first result instead of posting twice.
create table public.inventory_requests (
  business_id uuid not null references public.businesses (id) on delete cascade,
  client_ref text not null
    constraint inventory_requests_ref_length check (char_length(client_ref) between 8 and 64),
  kind text not null,
  result_id uuid,
  created_at timestamptz not null default now(),
  primary key (business_id, client_ref)
);

alter table public.inventory_requests enable row level security;
revoke all on public.inventory_requests from public, anon, authenticated;

-- ── 7. recipes ──────────────────────────────────────────────────────────────

create table public.recipes (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  menu_item_id uuid not null unique references public.menu_items (id) on delete cascade,
  updated_at timestamptz not null default now()
);

create table public.recipe_ingredients (
  id uuid primary key default gen_random_uuid(),
  recipe_id uuid not null references public.recipes (id) on delete cascade,
  ingredient_id uuid not null references public.ingredients (id) on delete restrict,
  quantity numeric(14, 4) not null constraint recipe_ingredients_qty_positive check (quantity > 0),
  constraint recipe_ingredients_unique unique (recipe_id, ingredient_id)
);

alter table public.recipes enable row level security;
alter table public.recipe_ingredients enable row level security;
revoke all on public.recipes, public.recipe_ingredients from public, anon, authenticated;
grant select on public.recipes, public.recipe_ingredients to authenticated;
create policy "recipes_select_menu" on public.recipes for select to authenticated
  using (public.has_business_permission(business_id, 'menu.view'));
create policy "recipe_ingredients_select_menu" on public.recipe_ingredients for select to authenticated
  using (exists (
    select 1 from public.recipes r
    where r.id = recipe_id and public.has_business_permission(r.business_id, 'menu.view')));

-- ── 8. posting record (one per completed order) ─────────────────────────────

create table public.inventory_postings (
  order_id uuid primary key,
  business_id uuid not null references public.businesses (id) on delete cascade,
  outlet_id uuid not null references public.outlets (id) on delete cascade,
  ingredient_count integer not null default 0,
  cost_minor numeric(16, 4) not null default 0,
  posted_at timestamptz not null default now()
);

alter table public.inventory_postings enable row level security;
revoke all on public.inventory_postings from public, anon, authenticated;
grant select on public.inventory_postings to authenticated;
create policy "inventory_postings_select_outlet" on public.inventory_postings for select to authenticated
  using (public.has_outlet_permission(outlet_id, 'inventory.view'));

-- ── 9. allocation: FEFO consumption from batches, shortfall at standard cost ─

-- Takes `p_qty` (base units, positive) from the outlet's batches, earliest expiry first.
-- Expired batches are skipped unless `p_include_expired` (wastage and counts dispose
-- of them). Any part no batch can cover is recorded as an unbatched shortfall at the
-- ingredient's standard cost, so the ledger still reconciles. Transfers and wastage
-- refuse a shortfall. Returns the total value posted (negative number is not used:
-- the value is returned as a positive cost).
create or replace function public.inventory_allocate(
  p_business_id uuid,
  p_outlet_id uuid,
  p_ingredient_id uuid,
  p_qty numeric,
  p_kind text,
  p_actor uuid,
  p_reference_prefix text,
  p_order_id uuid,
  p_include_expired boolean,
  p_reason text
)
returns numeric
language plpgsql
security definer
set search_path = public
as $$
declare
  v_batch record;
  v_remaining numeric := p_qty;
  v_take numeric;
  v_value numeric := 0;
  v_standard numeric;
begin
  for v_batch in
    select b.id, b.remaining_qty, b.unit_cost
    from public.inventory_batches b
    where b.outlet_id = p_outlet_id
      and b.ingredient_id = p_ingredient_id
      and b.remaining_qty > 0
      and (p_include_expired or b.expires_on is null or b.expires_on >= (now() at time zone 'Asia/Kolkata')::date)
    order by b.expires_on asc nulls last, b.received_on asc, b.created_at asc, b.id asc
    for update
  loop
    exit when v_remaining <= 0;
    v_take := least(v_batch.remaining_qty, v_remaining);
    insert into public.inventory_movements (
      business_id, outlet_id, ingredient_id, batch_id, kind, qty, unit_cost, value_minor,
      order_id, reason, reference_key, actor_id
    ) values (
      p_business_id, p_outlet_id, p_ingredient_id, v_batch.id, p_kind, -v_take, v_batch.unit_cost,
      -v_take * v_batch.unit_cost, p_order_id, p_reason,
      p_reference_prefix || ':b:' || v_batch.id::text, p_actor
    );
    v_value := v_value + v_take * v_batch.unit_cost;
    v_remaining := v_remaining - v_take;
  end loop;

  if v_remaining > 0 then
    if p_kind in ('transfer_out', 'wastage', 'adjustment') then
      raise exception 'Not enough stock on hand for this movement.' using errcode = 'P0001';
    end if;
    select i.cost_per_unit into v_standard from public.ingredients i where i.id = p_ingredient_id;
    insert into public.inventory_movements (
      business_id, outlet_id, ingredient_id, batch_id, kind, qty, unit_cost, value_minor,
      order_id, reason, reference_key, actor_id
    ) values (
      p_business_id, p_outlet_id, p_ingredient_id, null, p_kind, -v_remaining, v_standard,
      -v_remaining * v_standard, p_order_id, p_reason, p_reference_prefix || ':short', p_actor
    );
    v_value := v_value + v_remaining * v_standard;
  end if;

  return v_value;
end;
$$;

revoke all on function public.inventory_allocate(uuid, uuid, uuid, numeric, text, uuid, text, uuid, boolean, text)
  from public, anon, authenticated, service_role;

-- ── 10. manual operations (service role; each re-checks permission) ─────────

-- Idempotency helper: returns (already_done, result_id). Claims the reference otherwise.
create or replace function public.inventory_claim(p_business_id uuid, p_client_ref text, p_kind text)
returns table (already_done boolean, result_id uuid)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_kind text;
  v_result uuid;
begin
  if char_length(coalesce(p_client_ref, '')) < 8 then
    raise exception 'Missing reference for this change.' using errcode = 'P0001';
  end if;
  insert into public.inventory_requests (business_id, client_ref, kind)
  values (p_business_id, p_client_ref, p_kind)
  on conflict (business_id, client_ref) do nothing;
  if found then
    return query select false, null::uuid;
    return;
  end if;
  select r.kind, r.result_id into v_kind, v_result
  from public.inventory_requests r
  where r.business_id = p_business_id and r.client_ref = p_client_ref;
  if v_kind <> p_kind then
    raise exception 'This reference was already used for another change.' using errcode = 'P0001';
  end if;
  return query select true, v_result;
end;
$$;

revoke all on function public.inventory_claim(uuid, text, text) from public, anon, authenticated, service_role;

create or replace function public.inventory_receive(
  p_actor uuid,
  p_outlet_id uuid,
  p_ingredient_id uuid,
  p_qty numeric,
  p_unit text,
  p_unit_cost numeric,
  p_batch_code text,
  p_expires_on date,
  p_client_ref text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_business uuid;
  v_ing record;
  v_claim record;
  v_qty_base numeric;
  v_cost_base numeric;
  v_batch uuid;
begin
  v_business := public.require_outlet_permission(p_actor, p_outlet_id, 'inventory.manage');
  if p_qty is null or p_qty <= 0 then raise exception 'Quantity must be more than zero.' using errcode = 'P0001'; end if;
  if p_unit_cost is null or p_unit_cost < 0 then raise exception 'Cost cannot be negative.' using errcode = 'P0001'; end if;

  select * into v_claim from public.inventory_claim(v_business, p_client_ref, 'receive');
  if v_claim.already_done then return v_claim.result_id; end if;

  select i.* into v_ing from public.ingredients i where i.id = p_ingredient_id and i.business_id = v_business;
  if not found or not v_ing.active then raise exception 'Ingredient not found.' using errcode = 'P0001'; end if;

  v_qty_base := public.inventory_base_qty(v_ing.unit, p_unit, p_qty);
  v_cost_base := p_unit_cost / (select to_base from public.units where code = p_unit);

  insert into public.inventory_batches (
    business_id, outlet_id, ingredient_id, batch_code, received_qty, remaining_qty, unit_cost, expires_on, source
  ) values (
    v_business, p_outlet_id, p_ingredient_id, nullif(trim(coalesce(p_batch_code, '')), ''), v_qty_base, 0,
    v_cost_base, p_expires_on, 'receipt'
  ) returning id into v_batch;

  insert into public.inventory_movements (
    business_id, outlet_id, ingredient_id, batch_id, kind, qty, unit_cost, value_minor, reference_key, actor_id
  ) values (
    v_business, p_outlet_id, p_ingredient_id, v_batch, 'receipt', v_qty_base, v_cost_base,
    v_qty_base * v_cost_base, 'receive:' || p_client_ref, p_actor
  );

  update public.inventory_requests set result_id = v_batch
  where business_id = v_business and client_ref = p_client_ref;
  return v_batch;
end;
$$;

create or replace function public.inventory_waste(
  p_actor uuid,
  p_outlet_id uuid,
  p_ingredient_id uuid,
  p_qty numeric,
  p_unit text,
  p_reason text,
  p_client_ref text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_business uuid;
  v_ing record;
  v_claim record;
  v_qty_base numeric;
  v_on_hand numeric;
begin
  v_business := public.require_outlet_permission(p_actor, p_outlet_id, 'inventory.manage');
  if p_qty is null or p_qty <= 0 then raise exception 'Quantity must be more than zero.' using errcode = 'P0001'; end if;
  if char_length(trim(coalesce(p_reason, ''))) = 0 then
    raise exception 'Say why this stock is being thrown away.' using errcode = 'P0001';
  end if;

  select * into v_claim from public.inventory_claim(v_business, p_client_ref, 'waste');
  if v_claim.already_done then return v_claim.result_id; end if;

  select i.* into v_ing from public.ingredients i where i.id = p_ingredient_id and i.business_id = v_business;
  if not found then raise exception 'Ingredient not found.' using errcode = 'P0001'; end if;

  v_qty_base := public.inventory_base_qty(v_ing.unit, p_unit, p_qty);
  select coalesce(s.on_hand, 0) into v_on_hand from public.inventory_stock s
  where s.outlet_id = p_outlet_id and s.ingredient_id = p_ingredient_id
  for update;
  if coalesce(v_on_hand, 0) < v_qty_base then
    raise exception 'Wastage is more than the stock on hand.' using errcode = 'P0001';
  end if;

  perform public.inventory_allocate(v_business, p_outlet_id, p_ingredient_id, v_qty_base, 'wastage',
    p_actor, 'waste:' || p_client_ref, null, true, trim(p_reason));

  update public.inventory_requests set result_id = null
  where business_id = v_business and client_ref = p_client_ref;
  return null;
end;
$$;

-- A count: the outlet's stock is set to the counted quantity through a movement.
create or replace function public.inventory_adjust(
  p_actor uuid,
  p_outlet_id uuid,
  p_ingredient_id uuid,
  p_counted numeric,
  p_unit text,
  p_reason text,
  p_client_ref text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_business uuid;
  v_ing record;
  v_claim record;
  v_counted_base numeric;
  v_on_hand numeric;
  v_delta numeric;
  v_batch uuid;
  v_standard numeric;
begin
  v_business := public.require_outlet_permission(p_actor, p_outlet_id, 'inventory.manage');
  if p_counted is null or p_counted < 0 then raise exception 'Counted quantity cannot be negative.' using errcode = 'P0001'; end if;
  if char_length(trim(coalesce(p_reason, ''))) = 0 then
    raise exception 'Give a reason for the adjustment.' using errcode = 'P0001';
  end if;

  select * into v_claim from public.inventory_claim(v_business, p_client_ref, 'adjust');
  if v_claim.already_done then return v_claim.result_id; end if;

  select i.* into v_ing from public.ingredients i where i.id = p_ingredient_id and i.business_id = v_business;
  if not found then raise exception 'Ingredient not found.' using errcode = 'P0001'; end if;

  v_counted_base := public.inventory_base_qty(v_ing.unit, p_unit, p_counted);
  insert into public.inventory_stock (business_id, outlet_id, ingredient_id, on_hand)
  values (v_business, p_outlet_id, p_ingredient_id, 0)
  on conflict (outlet_id, ingredient_id) do nothing;
  select s.on_hand into v_on_hand from public.inventory_stock s
  where s.outlet_id = p_outlet_id and s.ingredient_id = p_ingredient_id
  for update;

  v_delta := v_counted_base - v_on_hand;
  if v_delta > 0 then
    v_standard := v_ing.cost_per_unit;
    insert into public.inventory_batches (
      business_id, outlet_id, ingredient_id, received_qty, remaining_qty, unit_cost, source
    ) values (
      v_business, p_outlet_id, p_ingredient_id, v_delta, 0, v_standard, 'adjustment'
    ) returning id into v_batch;
    insert into public.inventory_movements (
      business_id, outlet_id, ingredient_id, batch_id, kind, qty, unit_cost, value_minor, reason, reference_key, actor_id
    ) values (
      v_business, p_outlet_id, p_ingredient_id, v_batch, 'adjustment', v_delta, v_standard,
      v_delta * v_standard, trim(p_reason), 'adjust:' || p_client_ref, p_actor
    );
  elsif v_delta < 0 then
    perform public.inventory_allocate(v_business, p_outlet_id, p_ingredient_id, -v_delta, 'adjustment',
      p_actor, 'adjust:' || p_client_ref, null, true, trim(p_reason));
  end if;

  if v_delta <> 0 then
    insert into public.stock_adjustments (
      business_id, outlet_id, ingredient_id, system_qty, counted_qty, delta, reason, actor_id
    ) values (
      v_business, p_outlet_id, p_ingredient_id, v_on_hand, v_counted_base, v_delta, trim(p_reason), p_actor
    );
  end if;

  update public.inventory_requests set result_id = null
  where business_id = v_business and client_ref = p_client_ref;
  return null;
end;
$$;

-- Moves stock between two outlets of the same business. Source batches are taken
-- FEFO (usable stock only); the destination gets batches carrying the same expiry and
-- cost. Refuses if the source cannot cover every line.
create or replace function public.inventory_transfer(
  p_actor uuid,
  p_from_outlet_id uuid,
  p_to_outlet_id uuid,
  p_lines jsonb,
  p_note text,
  p_client_ref text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_business uuid;
  v_to_business uuid;
  v_claim record;
  v_transfer uuid;
  v_line jsonb;
  v_ing record;
  v_qty_base numeric;
  v_usable numeric;
  v_need numeric;
  v_src record;
  v_take numeric;
  v_dest uuid;
  v_line_value numeric;
begin
  v_business := public.require_outlet_permission(p_actor, p_from_outlet_id, 'inventory.manage');
  v_to_business := public.require_outlet_permission(p_actor, p_to_outlet_id, 'inventory.manage');
  if v_business <> v_to_business then raise exception 'Transfers stay inside one business.' using errcode = 'P0001'; end if;
  if p_from_outlet_id = p_to_outlet_id then raise exception 'Choose two different outlets.' using errcode = 'P0001'; end if;
  if jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'Add at least one line to transfer.' using errcode = 'P0001';
  end if;

  select * into v_claim from public.inventory_claim(v_business, p_client_ref, 'transfer');
  if v_claim.already_done then return v_claim.result_id; end if;

  insert into public.stock_transfers (business_id, from_outlet_id, to_outlet_id, note, created_by)
  values (v_business, p_from_outlet_id, p_to_outlet_id, nullif(trim(coalesce(p_note, '')), ''), p_actor)
  returning id into v_transfer;

  for v_line in select * from jsonb_array_elements(p_lines) loop
    select i.* into v_ing from public.ingredients i
    where i.id = nullif(v_line ->> 'ingredient_id', '')::uuid and i.business_id = v_business;
    if not found then raise exception 'Ingredient not found.' using errcode = 'P0001'; end if;
    v_qty_base := public.inventory_base_qty(v_ing.unit, v_line ->> 'unit',
      (v_line ->> 'qty')::numeric);
    if v_qty_base <= 0 then raise exception 'Quantity must be more than zero.' using errcode = 'P0001'; end if;

    select coalesce(sum(b.remaining_qty), 0) into v_usable
    from public.inventory_batches b
    where b.outlet_id = p_from_outlet_id and b.ingredient_id = v_ing.id and b.remaining_qty > 0
      and (b.expires_on is null or b.expires_on >= (now() at time zone 'Asia/Kolkata')::date);
    if v_usable < v_qty_base then
      raise exception 'Not enough usable % at the source outlet.', v_ing.name using errcode = 'P0001';
    end if;

    v_need := v_qty_base;
    v_line_value := 0;
    for v_src in
      select b.* from public.inventory_batches b
      where b.outlet_id = p_from_outlet_id and b.ingredient_id = v_ing.id and b.remaining_qty > 0
        and (b.expires_on is null or b.expires_on >= (now() at time zone 'Asia/Kolkata')::date)
      order by b.expires_on asc nulls last, b.received_on asc, b.created_at asc, b.id asc
      for update
    loop
      exit when v_need <= 0;
      v_take := least(v_src.remaining_qty, v_need);

      insert into public.inventory_batches (
        business_id, outlet_id, ingredient_id, batch_code, received_qty, remaining_qty, unit_cost,
        received_on, expires_on, source
      ) values (
        v_business, p_to_outlet_id, v_ing.id, v_src.batch_code, v_take, 0, v_src.unit_cost,
        v_src.received_on, v_src.expires_on, 'transfer_in'
      ) returning id into v_dest;

      insert into public.inventory_movements (
        business_id, outlet_id, ingredient_id, batch_id, kind, qty, unit_cost, value_minor,
        transfer_id, reference_key, actor_id
      ) values (
        v_business, p_from_outlet_id, v_ing.id, v_src.id, 'transfer_out', -v_take, v_src.unit_cost,
        -v_take * v_src.unit_cost, v_transfer, 'transfer:' || v_transfer::text || ':out:' || v_src.id::text, p_actor
      );
      insert into public.inventory_movements (
        business_id, outlet_id, ingredient_id, batch_id, kind, qty, unit_cost, value_minor,
        transfer_id, reference_key, actor_id
      ) values (
        v_business, p_to_outlet_id, v_ing.id, v_dest, 'transfer_in', v_take, v_src.unit_cost,
        v_take * v_src.unit_cost, v_transfer, 'transfer:' || v_transfer::text || ':in:' || v_dest::text, p_actor
      );

      v_line_value := v_line_value + v_take * v_src.unit_cost;
      v_need := v_need - v_take;
    end loop;

    insert into public.stock_transfer_items (transfer_id, ingredient_id, quantity, unit_cost, value_minor)
    values (v_transfer, v_ing.id, v_qty_base, v_line_value / v_qty_base, v_line_value);
  end loop;

  update public.inventory_requests set result_id = v_transfer
  where business_id = v_business and client_ref = p_client_ref;
  return v_transfer;
end;
$$;

-- ── 11. recipe consumption on completed orders ──────────────────────────────

-- Posts the order's recipe consumption once. A second call (or a second completion)
-- finds the posting row and does nothing. Combos explode into their component products.
create or replace function public.inventory_post_order(p_order_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order record;
  v_new uuid;
  v_line record;
  v_value numeric;
  v_total numeric := 0;
  v_count integer := 0;
begin
  select o.id, o.business_id, o.outlet_id, o.status into v_order
  from public.orders o where o.id = p_order_id;
  if not found or v_order.status <> 'completed' then
    return;
  end if;

  insert into public.inventory_postings (order_id, business_id, outlet_id)
  values (p_order_id, v_order.business_id, v_order.outlet_id)
  on conflict (order_id) do nothing
  returning order_id into v_new;
  if v_new is null then
    return; -- already posted: never deduct twice
  end if;

  for v_line in
    select need.ingredient_id, sum(need.qty) as qty
    from (
      select rin.ingredient_id, oi.quantity::numeric * rin.quantity as qty
      from public.order_items oi
      join public.recipes r on r.menu_item_id = oi.product_id
      join public.recipe_ingredients rin on rin.recipe_id = r.id
      where oi.order_id = p_order_id and oi.product_id is not null
      union all
      select rin.ingredient_id, oi.quantity::numeric * ci.quantity * rin.quantity as qty
      from public.order_items oi
      join public.combo_items ci on ci.combo_id = oi.combo_id
      join public.recipes r on r.menu_item_id = ci.product_id
      join public.recipe_ingredients rin on rin.recipe_id = r.id
      where oi.order_id = p_order_id and oi.combo_id is not null
    ) need
    group by need.ingredient_id
  loop
    v_value := public.inventory_allocate(
      v_order.business_id, v_order.outlet_id, v_line.ingredient_id, v_line.qty, 'consumption',
      null, 'consume:' || p_order_id::text || ':' || v_line.ingredient_id::text, p_order_id, false,
      'Recipe consumption');
    v_total := v_total + v_value;
    v_count := v_count + 1;
  end loop;

  update public.inventory_postings
  set ingredient_count = v_count, cost_minor = v_total
  where order_id = p_order_id;
end;
$$;

revoke all on function public.inventory_post_order(uuid) from public, anon, authenticated, service_role;

create or replace function public.orders_inventory_trigger()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status = 'completed' and old.status is distinct from 'completed' then
    perform public.inventory_post_order(new.id);
  end if;
  return null;
end;
$$;

revoke all on function public.orders_inventory_trigger() from public, anon, authenticated;

create trigger orders_inventory_post
  after update of status on public.orders
  for each row execute function public.orders_inventory_trigger();

-- ── 12. catalogue writes (ingredients, recipes) ─────────────────────────────

create or replace function public.ingredient_save(
  p_actor uuid,
  p_business_id uuid,
  p_id uuid,
  p_name text,
  p_unit text,
  p_cost_per_unit numeric,
  p_minimum_stock numeric,
  p_maximum_stock numeric,
  p_active boolean
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
  v_old record;
begin
  if not public.actor_has_permission(p_actor, p_business_id, 'inventory.manage') then
    raise exception 'Your role does not allow this action (inventory.manage).' using errcode = '42501';
  end if;
  if not exists (select 1 from public.units u where u.code = p_unit and u.is_base) then
    raise exception 'Choose a base unit: g, ml or pc.' using errcode = 'P0001';
  end if;
  if p_cost_per_unit is null or p_cost_per_unit < 0 then raise exception 'Cost cannot be negative.' using errcode = 'P0001'; end if;
  if coalesce(p_minimum_stock, 0) < 0 then raise exception 'Minimum stock cannot be negative.' using errcode = 'P0001'; end if;
  if p_maximum_stock is not null and p_maximum_stock < coalesce(p_minimum_stock, 0) then
    raise exception 'Maximum stock must be at least the minimum.' using errcode = 'P0001';
  end if;

  if p_id is null then
    insert into public.ingredients (business_id, name, unit, cost_per_unit, minimum_stock, maximum_stock, active)
    values (p_business_id, trim(p_name), p_unit, p_cost_per_unit, coalesce(p_minimum_stock, 0), p_maximum_stock, coalesce(p_active, true))
    returning id into v_id;
  else
    select * into v_old from public.ingredients where id = p_id and business_id = p_business_id for update;
    if not found then raise exception 'Ingredient not found.' using errcode = 'P0001'; end if;
    if p_unit <> v_old.unit and exists (select 1 from public.inventory_movements m where m.ingredient_id = p_id) then
      raise exception 'The unit cannot change once stock has been recorded.' using errcode = 'P0001';
    end if;
    update public.ingredients
    set name = trim(p_name), unit = p_unit, cost_per_unit = p_cost_per_unit,
        minimum_stock = coalesce(p_minimum_stock, 0), maximum_stock = p_maximum_stock,
        active = coalesce(p_active, true), updated_at = now()
    where id = p_id
    returning id into v_id;
  end if;
  return v_id;
end;
$$;

revoke all on function public.ingredient_save(uuid, uuid, uuid, text, text, numeric, numeric, numeric, boolean)
  from public, anon, authenticated;
grant execute on function public.ingredient_save(uuid, uuid, uuid, text, text, numeric, numeric, numeric, boolean)
  to service_role;

-- Replaces the recipe for one product. An empty list removes the recipe.
create or replace function public.recipe_save(p_actor uuid, p_menu_item_id uuid, p_lines jsonb)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_business uuid;
  v_recipe uuid;
  v_line jsonb;
  v_ing record;
  v_qty numeric;
begin
  select m.business_id into v_business from public.menu_items m where m.id = p_menu_item_id;
  if v_business is null then raise exception 'Menu item not found.' using errcode = 'P0001'; end if;
  if not public.actor_has_permission(p_actor, v_business, 'menu.manage') then
    raise exception 'Your role does not allow this action (menu.manage).' using errcode = '42501';
  end if;
  if jsonb_typeof(p_lines) <> 'array' then raise exception 'Invalid recipe.' using errcode = 'P0001'; end if;
  if jsonb_array_length(p_lines) > 60 then raise exception 'At most 60 ingredients per recipe.' using errcode = 'P0001'; end if;

  if jsonb_array_length(p_lines) = 0 then
    delete from public.recipes where menu_item_id = p_menu_item_id;
    return null;
  end if;

  insert into public.recipes (business_id, menu_item_id)
  values (v_business, p_menu_item_id)
  on conflict (menu_item_id) do update set updated_at = now()
  returning id into v_recipe;

  delete from public.recipe_ingredients where recipe_id = v_recipe;

  for v_line in select * from jsonb_array_elements(p_lines) loop
    select i.* into v_ing from public.ingredients i
    where i.id = nullif(v_line ->> 'ingredient_id', '')::uuid and i.business_id = v_business and i.active;
    if not found then raise exception 'Choose an active ingredient for every line.' using errcode = 'P0001'; end if;
    v_qty := public.inventory_base_qty(v_ing.unit, v_line ->> 'unit', (v_line ->> 'qty')::numeric);
    if v_qty <= 0 then raise exception 'Quantity must be more than zero.' using errcode = 'P0001'; end if;
    insert into public.recipe_ingredients (recipe_id, ingredient_id, quantity)
    values (v_recipe, v_ing.id, v_qty)
    on conflict (recipe_id, ingredient_id)
    do update set quantity = public.recipe_ingredients.quantity + excluded.quantity;
  end loop;

  return v_recipe;
end;
$$;

revoke all on function public.recipe_save(uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.recipe_save(uuid, uuid, jsonb) to service_role;

-- ── 13. reconciliation ──────────────────────────────────────────────────────

-- For every ingredient at one outlet: the cached level, the ledger total, the batch
-- balances and the unbatched shortfall. `consistent` is true when the three agree:
--   on_hand = ledger total = batch remaining + unbatched shortfall.
create or replace function public.inventory_reconcile(p_actor uuid, p_outlet_id uuid)
returns table (
  ingredient_id uuid,
  ingredient_name text,
  on_hand numeric,
  ledger_total numeric,
  batch_remaining numeric,
  unbatched numeric,
  consistent boolean
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_business uuid;
begin
  v_business := public.require_outlet_permission(p_actor, p_outlet_id, 'inventory.view');
  return query
  select
    i.id,
    i.name,
    coalesce(s.on_hand, 0)::numeric,
    coalesce(l.total, 0)::numeric,
    coalesce(b.remaining, 0)::numeric,
    coalesce(l.unbatched, 0)::numeric,
    (coalesce(s.on_hand, 0) = coalesce(l.total, 0)
      and coalesce(l.total, 0) = coalesce(b.remaining, 0) + coalesce(l.unbatched, 0))
  from public.ingredients i
  left join public.inventory_stock s on s.outlet_id = p_outlet_id and s.ingredient_id = i.id
  left join lateral (
    select sum(m.qty) as total,
           sum(m.qty) filter (where m.batch_id is null) as unbatched
    from public.inventory_movements m
    where m.outlet_id = p_outlet_id and m.ingredient_id = i.id
  ) l on true
  left join lateral (
    select sum(bb.remaining_qty) as remaining
    from public.inventory_batches bb
    where bb.outlet_id = p_outlet_id and bb.ingredient_id = i.id
  ) b on true
  where i.business_id = v_business
    and (s.ingredient_id is not null or l.total is not null)
  order by i.name;
end;
$$;

revoke all on function public.inventory_reconcile(uuid, uuid) from public, anon, authenticated;
grant execute on function public.inventory_reconcile(uuid, uuid) to service_role;

-- ── 14. RPC grants: manual writes are service-role only ─────────────────────

revoke all on function public.inventory_receive(uuid, uuid, uuid, numeric, text, numeric, text, date, text)
  from public, anon, authenticated;
grant execute on function public.inventory_receive(uuid, uuid, uuid, numeric, text, numeric, text, date, text)
  to service_role;
revoke all on function public.inventory_waste(uuid, uuid, uuid, numeric, text, text, text)
  from public, anon, authenticated;
grant execute on function public.inventory_waste(uuid, uuid, uuid, numeric, text, text, text) to service_role;
revoke all on function public.inventory_adjust(uuid, uuid, uuid, numeric, text, text, text)
  from public, anon, authenticated;
grant execute on function public.inventory_adjust(uuid, uuid, uuid, numeric, text, text, text) to service_role;
revoke all on function public.inventory_transfer(uuid, uuid, uuid, jsonb, text, text)
  from public, anon, authenticated;
grant execute on function public.inventory_transfer(uuid, uuid, uuid, jsonb, text, text) to service_role;
revoke all on function public.inventory_base_qty(text, text, numeric) from public, anon;
grant execute on function public.inventory_base_qty(text, text, numeric) to authenticated, service_role;
