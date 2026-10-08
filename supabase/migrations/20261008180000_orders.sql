-- RestroNex — Phase 8: POS orders + order management
--
-- Orders are created/amended exclusively through SECURITY DEFINER RPCs that
-- re-price EVERYTHING from the menu tables (clients send ids + quantities,
-- never prices), compute discount/tax/charges server-side, and write the
-- order + items + history in ONE transaction.
--
-- Duplicate prevention: (business_id, client_ref) is unique; create_pos_order
-- is idempotent on client_ref.
--
-- Order states:
--   open → held ↔ open → placed → preparing → ready → completed
--   open / held / placed / preparing → cancelled
--   (ready → completed additionally requires paid_minor >= total_minor —
--    payment collection ships in Phase 10.)

-- ── order numbering ─────────────────────────────────────────────────────────

create table public.business_order_counters (
  business_id uuid primary key references public.businesses (id) on delete cascade,
  order_seq integer not null default 1000,
  updated_at timestamptz not null default now()
);

-- ── orders ──────────────────────────────────────────────────────────────────

create table public.orders (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  outlet_id uuid not null references public.outlets (id) on delete cascade,
  order_number integer not null,
  client_ref text not null
    constraint orders_client_ref_length check (char_length(client_ref) between 8 and 64),
  created_by uuid references auth.users (id) on delete set null,
  order_type text not null
    constraint orders_type_allowed check (order_type in ('dine_in', 'takeaway', 'delivery')),
  status text not null default 'open'
    constraint orders_status_allowed check (
      status in ('open', 'held', 'placed', 'preparing', 'ready', 'completed', 'cancelled')
    ),
  payment_status text not null default 'unpaid'
    constraint orders_payment_status_allowed check (
      payment_status in ('unpaid', 'partial', 'paid', 'refunded')
    ),
  paid_minor bigint not null default 0
    constraint orders_paid_range check (paid_minor >= 0),
  table_id uuid references public.dining_tables (id) on delete set null,
  customer_name text
    constraint orders_customer_name_length check (customer_name is null or char_length(customer_name) <= 80),
  customer_phone text
    constraint orders_customer_phone_length check (customer_phone is null or char_length(customer_phone) <= 20),
  delivery_address text
    constraint orders_delivery_address_length check (delivery_address is null or char_length(delivery_address) <= 300),
  notes text
    constraint orders_notes_length check (notes is null or char_length(notes) <= 400),
  discount_type text not null default 'none'
    constraint orders_discount_type_allowed check (discount_type in ('none', 'percent', 'flat')),
  discount_value bigint not null default 0
    constraint orders_discount_value_range check (discount_value >= 0 and discount_value <= 100000000),
  charges jsonb not null default '[]'::jsonb
    constraint orders_charges_array check (jsonb_typeof(charges) = 'array' and jsonb_array_length(charges) <= 5),
  subtotal_minor bigint not null default 0 constraint orders_subtotal_range check (subtotal_minor >= 0),
  discount_minor bigint not null default 0 constraint orders_discount_minor_range check (discount_minor >= 0),
  tax_minor bigint not null default 0 constraint orders_tax_range check (tax_minor >= 0),
  charges_minor bigint not null default 0 constraint orders_charges_range check (charges_minor >= 0),
  total_minor bigint not null default 0 constraint orders_total_range check (total_minor >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint orders_client_ref_unique unique (business_id, client_ref),
  constraint orders_outlet_number_unique unique (business_id, outlet_id, order_number)
);

create index orders_outlet_status_idx on public.orders (outlet_id, status);
create index orders_business_created_idx on public.orders (business_id, created_at desc);

create trigger orders_set_updated_at
  before update on public.orders
  for each row execute function public.set_updated_at();

comment on column public.orders.client_ref is
  'Client-generated idempotency key; create_pos_order returns the existing order on repeats.';
comment on column public.orders.paid_minor is
  'Amount recorded against the order. Payment collection arrives in Phase 10; until then orders stay unpaid.';

-- ── order items + modifiers ─────────────────────────────────────────────────

create table public.order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders (id) on delete cascade,
  position integer not null default 0,
  item_type text not null
    constraint order_items_type_allowed check (item_type in ('product', 'combo')),
  product_id uuid references public.menu_items (id) on delete set null,
  combo_id uuid references public.combos (id) on delete set null,
  variant_id uuid references public.product_variants (id) on delete set null,
  name text not null,
  unit_price_minor bigint not null
    constraint order_items_unit_price_range check (unit_price_minor >= 0),
  quantity integer not null
    constraint order_items_quantity_range check (quantity between 1 and 99),
  item_notes text
    constraint order_items_notes_length check (item_notes is null or char_length(item_notes) <= 200),
  modifiers_minor bigint not null default 0
    constraint order_items_modifiers_range check (modifiers_minor >= 0),
  line_total_minor bigint not null
    constraint order_items_line_range check (line_total_minor >= 0),
  constraint order_items_target check (
    (item_type = 'product' and product_id is not null and combo_id is null)
    or (item_type = 'combo' and combo_id is not null and product_id is null and variant_id is null)
  )
);

create index order_items_order_idx on public.order_items (order_id);

create table public.order_item_modifiers (
  id uuid primary key default gen_random_uuid(),
  order_item_id uuid not null references public.order_items (id) on delete cascade,
  modifier_id uuid references public.modifiers (id) on delete set null,
  name text not null,
  price_minor bigint not null
    constraint order_item_modifiers_price_range check (price_minor >= 0),
  quantity integer not null default 1
    constraint order_item_modifiers_quantity_range check (quantity between 1 and 20)
);

create index order_item_modifiers_item_idx on public.order_item_modifiers (order_item_id);

-- ── status history ──────────────────────────────────────────────────────────

create table public.order_status_history (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders (id) on delete cascade,
  from_status text,
  to_status text not null,
  note text
    constraint order_status_history_note_length check (note is null or char_length(note) <= 200),
  changed_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now()
);

create index order_status_history_order_idx on public.order_status_history (order_id);

-- ── RLS ─────────────────────────────────────────────────────────────────────

alter table public.orders enable row level security;
alter table public.order_items enable row level security;
alter table public.order_item_modifiers enable row level security;
alter table public.order_status_history enable row level security;
alter table public.business_order_counters enable row level security;

create policy "orders_select_member"
  on public.orders for select to authenticated
  using (public.has_business_access(business_id));

create policy "order_items_select_member"
  on public.order_items for select to authenticated
  using (
    exists (select 1 from public.orders o where o.id = order_items.order_id
            and public.has_business_access(o.business_id))
  );

create policy "order_item_modifiers_select_member"
  on public.order_item_modifiers for select to authenticated
  using (
    exists (
      select 1
      from public.order_items oi
      join public.orders o on o.id = oi.order_id
      where oi.id = order_item_modifiers.order_item_id
        and public.has_business_access(o.business_id)
    )
  );

create policy "order_status_history_select_member"
  on public.order_status_history for select to authenticated
  using (
    exists (select 1 from public.orders o where o.id = order_status_history.order_id
            and public.has_business_access(o.business_id))
  );

-- Counters are service-side machinery; no client visibility at all.

-- ── shared pricing helper (used by both RPCs) ───────────────────────────────
--
-- Formula (mirrored by src/modules/orders/pricing.ts — keep in lockstep):
--   line_gross  = (unit_price + modifiers) * quantity
--   subtotal    = Σ line_gross
--   discount    = percent ? round(subtotal * value / 100)
--                           : min(value, subtotal)
--   line_share  = round(discount * line_gross / subtotal)   (pro-rata)
--   line_net    = line_gross - line_share
--   line_tax    = round(line_net * rate_pct / 100)          (exclusive tax)
--   total       = subtotal - discount + Σ line_tax + Σ charges
--
-- Item tax rate = product.tax_rate_pct if set, else the business's enabled
-- EXCLUSIVE tax rates summed. Inclusive rates are printed on bills but never
-- added on top.

create or replace function public.pos_effective_tax_pct(
  p_business_id uuid,
  p_product_id uuid
)
returns numeric
language plpgsql
security definer
stable
set search_path = public
as $$
declare
  v_override numeric;
  v_enabled boolean;
  v_sum numeric;
  v_rate jsonb;
begin
  select tax_rate_pct into v_override from public.menu_items where id = p_product_id;
  if v_override is not null then
    return v_override;
  end if;

  v_enabled := coalesce(
    (select (tax_settings ->> 'enabled')::boolean from public.businesses where id = p_business_id),
    false
  );
  if not v_enabled then
    return 0;
  end if;

  v_sum := 0;
  for v_rate in
    select * from jsonb_array_elements(
      coalesce((select tax_settings -> 'rates' from public.businesses where id = p_business_id), '[]'::jsonb)
    )
  loop
    if coalesce((v_rate ->> 'inclusive')::boolean, false) = false then
      v_sum := v_sum + coalesce((v_rate ->> 'pct')::numeric, 0);
    end if;
  end loop;
  return v_sum;
end;
$$;

revoke all on function public.pos_effective_tax_pct(uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.pos_effective_tax_pct(uuid, uuid) to service_role;

-- ── create / amend / transition RPCs ────────────────────────────────────────
--
-- pos_persist_items: validates every item against the menu (business match,
-- availability incl. outlet overrides), resolves server-side prices, inserts
-- items + modifier rows, returns the subtotal.
-- pos_apply_totals: discount shares, exclusive tax, charges → order totals.
-- Both are internal helpers for create_pos_order / amend_pos_order.

create or replace function public.pos_persist_items(
  p_order_id uuid,
  p_business_id uuid,
  p_outlet_id uuid,
  p_items jsonb
)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_item jsonb;
  v_modifier jsonb;
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

  delete from public.order_items where order_id = p_order_id; -- modifiers cascade

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

revoke all on function public.pos_persist_items(uuid, uuid, uuid, jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.pos_persist_items(uuid, uuid, uuid, jsonb) to service_role;

create or replace function public.pos_apply_totals(
  p_order_id uuid,
  p_business_id uuid,
  p_subtotal bigint,
  p_discount jsonb,
  p_charges jsonb
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_discount_type text;
  v_discount_value bigint;
  v_discount_minor bigint := 0;
  v_charge jsonb;
  v_charges_minor bigint := 0;
  v_tax_minor bigint := 0;
  v_line_share bigint;
  v_line_tax bigint;
  v_row record;
begin
  v_discount_type := coalesce(p_discount ->> 'type', 'none');
  v_discount_value := coalesce((p_discount ->> 'value')::bigint, 0);
  if v_discount_type not in ('none', 'percent', 'flat') or v_discount_value < 0 then
    raise exception 'Invalid discount.' using errcode = 'P0001';
  end if;
  if v_discount_type = 'percent' and v_discount_value > 100 then
    raise exception 'Percentage discounts cannot exceed 100%%.' using errcode = 'P0001';
  end if;

  if v_discount_type = 'percent' then
    v_discount_minor := round(p_subtotal * v_discount_value / 100.0)::bigint;
  elsif v_discount_type = 'flat' then
    v_discount_minor := least(v_discount_value, p_subtotal);
  end if;

  for v_row in
    select oi.id, oi.line_total_minor,
           case when oi.item_type = 'product'
                then public.pos_effective_tax_pct(p_business_id, oi.product_id)
                else 0 end as tax_pct
    from public.order_items oi
    where oi.order_id = p_order_id
  loop
    if p_subtotal > 0 then
      v_line_share := round(v_discount_minor * v_row.line_total_minor / p_subtotal::numeric)::bigint;
    else
      v_line_share := 0;
    end if;
    v_line_tax := round((v_row.line_total_minor - v_line_share) * v_row.tax_pct / 100.0)::bigint;
    v_tax_minor := v_tax_minor + v_line_tax;
  end loop;

  if jsonb_typeof(p_charges) not in ('array', 'null') then
    raise exception 'Invalid charges.' using errcode = 'P0001';
  end if;
  if jsonb_typeof(p_charges) = 'array' and jsonb_array_length(p_charges) > 5 then
    raise exception 'At most 5 charges per order.' using errcode = 'P0001';
  end if;
  for v_charge in select * from jsonb_array_elements(coalesce(p_charges, '[]'::jsonb)) loop
    if coalesce(jsonb_typeof(v_charge -> 'name'), 'absent') <> 'string'
       or length(trim(v_charge ->> 'name')) not between 1 and 40 then
      raise exception 'Every charge needs a name (max 40 chars).' using errcode = 'P0001';
    end if;
    begin
      if (v_charge ->> 'amount_minor')::bigint not between 0 and 10000000 then
        raise exception 'Charge amount out of range.' using errcode = 'P0001';
      end if;
    exception when others then
      raise exception 'Charge amounts must be whole minor units.' using errcode = 'P0001';
    end;
    v_charges_minor := v_charges_minor + (v_charge ->> 'amount_minor')::bigint;
  end loop;

  update public.orders set
    discount_type = v_discount_type,
    discount_value = v_discount_value,
    charges = coalesce(p_charges, '[]'::jsonb),
    subtotal_minor = p_subtotal,
    discount_minor = v_discount_minor,
    tax_minor = v_tax_minor,
    charges_minor = v_charges_minor,
    total_minor = p_subtotal - v_discount_minor + v_tax_minor + v_charges_minor
  where id = p_order_id;
end;
$$;

revoke all on function public.pos_apply_totals(uuid, uuid, bigint, jsonb, jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.pos_apply_totals(uuid, uuid, bigint, jsonb, jsonb) to service_role;

-- ── create order (idempotent on client_ref) ─────────────────────────────────

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
begin
  select o.business_id, o.outlet_id, o.status, o.order_type, o.table_id,
         o.customer_phone, o.delivery_address
  into v_order_business_id, v_order_outlet_id, v_order_status, v_order_type,
       v_order_table_id, v_order_phone, v_order_address
  from public.orders o where o.id = p_order_id;
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
  v_allowed boolean := false;
begin
  select o.business_id, o.status, o.paid_minor, o.total_minor
  into v_order_business_id, v_order_status, v_paid_minor, v_total_minor
  from public.orders o where o.id = p_order_id;
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
end;
$$;

revoke all on function public.transition_order_status(uuid, uuid, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.transition_order_status(uuid, uuid, text, text) to service_role;
