-- ============================================================================
-- Phase 17 — Online ordering + QR table ordering (spec §9, §26, §27, §34)
--
-- Customer-facing orders (restaurant website, QR table menu) enter the same
-- orders / order_items tables as POS orders, so POS, KDS, inventory, CRM and
-- reports all see them without a second pipeline.
--
-- Security model
--  • Public RPCs are granted to service_role ONLY. The Next.js route handlers
--    call them through the server-side admin client after validating input.
--    Anon and authenticated roles get no execute right.
--  • Tenant, outlet, prices, tax, discounts and payment status are never taken
--    from the client. Prices come from pos_persist_items (universal menu),
--    tax from pos_apply_totals, delivery and packaging fees from
--    outlet_ordering_settings. Public orders accept no discount or charges.
--  • Customers hold a random tracking secret. Only its SHA-256 hash is stored,
--    so status reads need the secret and an order id alone is not enough.
--  • Online and QR orders start as `held` with intake_status
--    `awaiting_acceptance`. A trigger refuses any status move out of that state
--    except through online_order_accept (→ placed, which sends items to KDS)
--    or cancellation (reject or staff cancel).
--  • Nothing in this phase marks an order paid. Payments remain staff-recorded
--    through record_payments. Prepaid online payment waits for a verified
--    provider webhook (external integration phase).
-- ============================================================================

-- ── 1. Outlet ordering settings ─────────────────────────────────────────────
create table if not exists public.outlet_ordering_settings (
  outlet_id uuid primary key references public.outlets (id) on delete cascade,
  business_id uuid not null references public.businesses (id) on delete cascade,
  online_enabled boolean not null default false,
  takeaway_enabled boolean not null default true,
  delivery_enabled boolean not null default false,
  qr_enabled boolean not null default false,
  accepting_orders boolean not null default true,
  auto_accept boolean not null default false,
  min_order_minor bigint not null default 0
    constraint outlet_ordering_min_range check (min_order_minor between 0 and 100000000),
  delivery_fee_minor bigint not null default 0
    constraint outlet_ordering_delivery_range check (delivery_fee_minor between 0 and 1000000),
  packaging_fee_minor bigint not null default 0
    constraint outlet_ordering_packaging_range check (packaging_fee_minor between 0 and 1000000),
  prep_minutes integer not null default 20
    constraint outlet_ordering_prep_range check (prep_minutes between 5 and 240),
  updated_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists outlet_ordering_settings_business_idx
  on public.outlet_ordering_settings (business_id);

drop trigger if exists outlet_ordering_settings_set_updated_at on public.outlet_ordering_settings;
create trigger outlet_ordering_settings_set_updated_at
  before update on public.outlet_ordering_settings
  for each row execute function public.set_updated_at();

alter table public.outlet_ordering_settings enable row level security;

drop policy if exists outlet_ordering_settings_select on public.outlet_ordering_settings;
create policy outlet_ordering_settings_select on public.outlet_ordering_settings
  for select to authenticated
  using (public.has_business_access(business_id));

revoke all on public.outlet_ordering_settings from public, anon;
grant select on public.outlet_ordering_settings to authenticated;

-- ── 2. QR table codes ───────────────────────────────────────────────────────
-- Only the SHA-256 hash of the printed token is stored. The raw token lives in
-- the printed QR URL and is never written to the database or logs.
create table if not exists public.qr_codes (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  outlet_id uuid not null references public.outlets (id) on delete cascade,
  table_id uuid not null references public.dining_tables (id) on delete cascade,
  label text not null
    constraint qr_codes_label_length check (char_length(trim(label)) between 1 and 60),
  token_hash text not null
    constraint qr_codes_token_hash_format check (token_hash ~ '^[0-9a-f]{64}$'),
  token_prefix text not null
    constraint qr_codes_token_prefix_length check (char_length(token_prefix) between 4 and 8),
  status text not null default 'active'
    constraint qr_codes_status_allowed check (status in ('active', 'revoked')),
  created_by uuid references auth.users (id) on delete set null,
  revoked_by uuid references auth.users (id) on delete set null,
  revoked_at timestamptz,
  last_used_at timestamptz,
  created_at timestamptz not null default now()
);

create unique index if not exists qr_codes_token_hash_unique on public.qr_codes (token_hash);
create unique index if not exists qr_codes_one_active_per_table
  on public.qr_codes (table_id) where status = 'active';
create index if not exists qr_codes_outlet_idx on public.qr_codes (outlet_id);

alter table public.qr_codes enable row level security;

drop policy if exists qr_codes_select on public.qr_codes;
create policy qr_codes_select on public.qr_codes
  for select to authenticated
  using (public.has_business_access(business_id));

revoke all on public.qr_codes from public, anon, authenticated;
-- Column-level grant: staff can see the code's state but never the hash.
grant select (id, business_id, outlet_id, table_id, label, token_prefix, status,
              created_by, revoked_by, revoked_at, last_used_at, created_at)
  on public.qr_codes to authenticated;

-- ── 3. Public rate limiting ─────────────────────────────────────────────────
create table if not exists public.public_rate_limits (
  bucket text primary key,
  window_start timestamptz not null,
  hits integer not null default 0
);

alter table public.public_rate_limits enable row level security;
revoke all on public.public_rate_limits from public, anon, authenticated;

-- ── 4. Orders: channel, intake and payment mode ─────────────────────────────
alter table public.orders
  add column if not exists channel text not null default 'pos',
  add column if not exists intake_status text,
  add column if not exists payment_mode text,
  add column if not exists tracking_token_hash text,
  add column if not exists qr_code_id uuid references public.qr_codes (id) on delete set null,
  add column if not exists accepted_at timestamptz,
  add column if not exists accepted_by uuid references auth.users (id) on delete set null,
  add column if not exists rejected_reason text;

alter table public.orders drop constraint if exists orders_channel_allowed;
alter table public.orders add constraint orders_channel_allowed
  check (channel in ('pos', 'online', 'qr'));

alter table public.orders drop constraint if exists orders_intake_status_allowed;
alter table public.orders add constraint orders_intake_status_allowed
  check (intake_status is null or intake_status in ('awaiting_acceptance', 'accepted', 'rejected'));

alter table public.orders drop constraint if exists orders_payment_mode_allowed;
alter table public.orders add constraint orders_payment_mode_allowed
  check (payment_mode is null or payment_mode in ('pay_at_counter', 'pay_on_delivery', 'pay_at_table'));

alter table public.orders drop constraint if exists orders_rejected_reason_length;
alter table public.orders add constraint orders_rejected_reason_length
  check (rejected_reason is null or char_length(rejected_reason) <= 200);

alter table public.orders drop constraint if exists orders_channel_shape;
alter table public.orders add constraint orders_channel_shape check (
  (channel = 'pos' and intake_status is null and payment_mode is null
     and tracking_token_hash is null and qr_code_id is null)
  or (channel = 'online' and order_type in ('takeaway', 'delivery')
     and intake_status is not null and payment_mode is not null
     and tracking_token_hash is not null and qr_code_id is null
     and customer_phone is not null)
  or (channel = 'qr' and order_type = 'dine_in' and table_id is not null
     and intake_status is not null and payment_mode = 'pay_at_table'
     and tracking_token_hash is not null and qr_code_id is not null)
);

create unique index if not exists orders_tracking_token_hash_unique
  on public.orders (tracking_token_hash) where tracking_token_hash is not null;
create index if not exists orders_channel_intake_idx
  on public.orders (outlet_id, channel, intake_status, status);

comment on column public.orders.channel is
  'pos = staff-entered; online = takeaway/delivery from the restaurant website; qr = dine-in table from a QR code.';
comment on column public.orders.intake_status is
  'Online and QR orders only. awaiting_acceptance until staff accept (placed, sent to KDS) or reject (cancelled).';
comment on column public.orders.tracking_token_hash is
  'SHA-256 of the customer-held tracking secret. The secret itself is never stored.';

-- Intake guard: an awaiting order cannot move forward until staff accept it.
create or replace function public.orders_intake_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.intake_status = 'awaiting_acceptance' then
    if new.status is distinct from old.status and new.status <> 'cancelled' then
      if current_setting('restronex.intake_accept', true) is distinct from 'on' then
        raise exception 'Accept this order before moving it on.' using errcode = 'P0001';
      end if;
    end if;
    if new.status = 'cancelled' and new.intake_status = 'awaiting_acceptance' then
      new.intake_status := 'rejected';
    end if;
  elsif old.intake_status is not null and new.intake_status is distinct from old.intake_status then
    raise exception 'The intake decision on this order is final.' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

revoke all on function public.orders_intake_guard() from public, anon, authenticated, service_role;

drop trigger if exists orders_intake_guard on public.orders;
create trigger orders_intake_guard
  before update of status, intake_status on public.orders
  for each row
  when (old.intake_status is not null)
  execute function public.orders_intake_guard();

-- ── 5. Helpers ──────────────────────────────────────────────────────────────

-- Settings as JSON with table defaults when an outlet has never saved settings.
create or replace function public.ordering_settings_json(p_outlet_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'online_enabled', coalesce(s.online_enabled, false),
    'takeaway_enabled', coalesce(s.takeaway_enabled, true),
    'delivery_enabled', coalesce(s.delivery_enabled, false),
    'qr_enabled', coalesce(s.qr_enabled, false),
    'accepting_orders', coalesce(s.accepting_orders, true),
    'auto_accept', coalesce(s.auto_accept, false),
    'min_order_minor', coalesce(s.min_order_minor, 0),
    'delivery_fee_minor', coalesce(s.delivery_fee_minor, 0),
    'packaging_fee_minor', coalesce(s.packaging_fee_minor, 0),
    'prep_minutes', coalesce(s.prep_minutes, 20)
  )
  from (select 1) as one
  left join public.outlet_ordering_settings s on s.outlet_id = p_outlet_id;
$$;

revoke all on function public.ordering_settings_json(uuid) from public, anon, authenticated;
grant execute on function public.ordering_settings_json(uuid) to service_role;

create or replace function public.public_rate_limit_hit(
  p_bucket text,
  p_limit integer,
  p_window_seconds integer
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now timestamptz := now();
  v_hits integer;
begin
  insert into public.public_rate_limits (bucket, window_start, hits)
  values (p_bucket, v_now, 1)
  on conflict (bucket) do update set
    window_start = case when public.public_rate_limits.window_start < v_now - make_interval(secs => p_window_seconds)
                        then v_now else public.public_rate_limits.window_start end,
    hits = case when public.public_rate_limits.window_start < v_now - make_interval(secs => p_window_seconds)
                then 1 else public.public_rate_limits.hits + 1 end
  returning hits into v_hits;

  if v_hits > p_limit then
    raise exception 'Too many requests. Please wait a few minutes and try again.' using errcode = 'P0429';
  end if;
end;
$$;

revoke all on function public.public_rate_limit_hit(text, integer, integer) from public, anon, authenticated;
grant execute on function public.public_rate_limit_hit(text, integer, integer) to service_role;

-- ── 6. Staff: ordering settings and QR codes ────────────────────────────────

create or replace function public.ordering_settings_save(
  p_actor uuid,
  p_outlet_id uuid,
  p_settings jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_business_id uuid;
  v_before jsonb;
  v_row public.outlet_ordering_settings%rowtype;
  v_cur public.outlet_ordering_settings%rowtype;
begin
  v_business_id := public.require_outlet_permission(p_actor, p_outlet_id, 'settings.manage');
  v_before := public.ordering_settings_json(p_outlet_id);

  select * into v_cur from public.outlet_ordering_settings where outlet_id = p_outlet_id;

  if coalesce((p_settings ->> 'min_order_minor')::bigint, 0) < 0
     or coalesce((p_settings ->> 'delivery_fee_minor')::bigint, 0) < 0
     or coalesce((p_settings ->> 'packaging_fee_minor')::bigint, 0) < 0 then
    raise exception 'Fees and minimums cannot be negative.' using errcode = 'P0001';
  end if;
  if coalesce((p_settings ->> 'prep_minutes')::integer, 20) not between 5 and 240 then
    raise exception 'Preparation time must be between 5 and 240 minutes.' using errcode = 'P0001';
  end if;

  insert into public.outlet_ordering_settings as s (
    outlet_id, business_id, online_enabled, takeaway_enabled, delivery_enabled, qr_enabled,
    accepting_orders, auto_accept, min_order_minor, delivery_fee_minor, packaging_fee_minor,
    prep_minutes, updated_by
  ) values (
    p_outlet_id, v_business_id,
    coalesce((p_settings ->> 'online_enabled')::boolean, coalesce(v_cur.online_enabled, false)),
    coalesce((p_settings ->> 'takeaway_enabled')::boolean, coalesce(v_cur.takeaway_enabled, true)),
    coalesce((p_settings ->> 'delivery_enabled')::boolean, coalesce(v_cur.delivery_enabled, false)),
    coalesce((p_settings ->> 'qr_enabled')::boolean, coalesce(v_cur.qr_enabled, false)),
    coalesce((p_settings ->> 'accepting_orders')::boolean, coalesce(v_cur.accepting_orders, true)),
    coalesce((p_settings ->> 'auto_accept')::boolean, coalesce(v_cur.auto_accept, false)),
    coalesce((p_settings ->> 'min_order_minor')::bigint, coalesce(v_cur.min_order_minor, 0)),
    coalesce((p_settings ->> 'delivery_fee_minor')::bigint, coalesce(v_cur.delivery_fee_minor, 0)),
    coalesce((p_settings ->> 'packaging_fee_minor')::bigint, coalesce(v_cur.packaging_fee_minor, 0)),
    coalesce((p_settings ->> 'prep_minutes')::integer, coalesce(v_cur.prep_minutes, 20)),
    p_actor
  )
  on conflict (outlet_id) do update set
    online_enabled = excluded.online_enabled,
    takeaway_enabled = excluded.takeaway_enabled,
    delivery_enabled = excluded.delivery_enabled,
    qr_enabled = excluded.qr_enabled,
    accepting_orders = excluded.accepting_orders,
    auto_accept = excluded.auto_accept,
    min_order_minor = excluded.min_order_minor,
    delivery_fee_minor = excluded.delivery_fee_minor,
    packaging_fee_minor = excluded.packaging_fee_minor,
    prep_minutes = excluded.prep_minutes,
    updated_by = excluded.updated_by
  returning * into v_row;

  perform public.write_audit_log(
    v_business_id, p_outlet_id, p_actor, 'ordering.settings_saved', 'outlet', p_outlet_id::text,
    v_before, public.ordering_settings_json(p_outlet_id), '{}'::jsonb
  );

  return public.ordering_settings_json(p_outlet_id);
end;
$$;

revoke all on function public.ordering_settings_save(uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.ordering_settings_save(uuid, uuid, jsonb) to service_role;

create or replace function public.qr_code_issue(
  p_actor uuid,
  p_outlet_id uuid,
  p_table_id uuid,
  p_label text,
  p_token_hash text,
  p_token_prefix text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_business_id uuid;
  v_id uuid;
begin
  v_business_id := public.require_outlet_permission(p_actor, p_outlet_id, 'settings.manage');

  if not exists (
    select 1 from public.dining_tables t
    where t.id = p_table_id and t.outlet_id = p_outlet_id and t.is_active
  ) then
    raise exception 'Choose an active table in this outlet.' using errcode = 'P0001';
  end if;

  if exists (
    select 1 from public.qr_codes q where q.table_id = p_table_id and q.status = 'active'
  ) then
    raise exception 'This table already has an active QR code. Revoke it first.' using errcode = 'P0001';
  end if;

  insert into public.qr_codes (
    business_id, outlet_id, table_id, label, token_hash, token_prefix, created_by
  ) values (
    v_business_id, p_outlet_id, p_table_id, trim(p_label), p_token_hash, p_token_prefix, p_actor
  )
  returning id into v_id;

  perform public.write_audit_log(
    v_business_id, p_outlet_id, p_actor, 'qr.issued', 'qr_code', v_id::text,
    null, jsonb_build_object('table_id', p_table_id, 'token_prefix', p_token_prefix), '{}'::jsonb
  );

  return v_id;
end;
$$;

revoke all on function public.qr_code_issue(uuid, uuid, uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.qr_code_issue(uuid, uuid, uuid, text, text, text) to service_role;

create or replace function public.qr_code_revoke(p_actor uuid, p_qr_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_qr public.qr_codes%rowtype;
begin
  select * into v_qr from public.qr_codes where id = p_qr_id for update;
  if v_qr.id is null then
    raise exception 'QR code not found.' using errcode = 'P0001';
  end if;

  perform public.require_outlet_permission(p_actor, v_qr.outlet_id, 'settings.manage');

  if v_qr.status <> 'active' then
    return;
  end if;

  update public.qr_codes
     set status = 'revoked', revoked_at = now(), revoked_by = p_actor
   where id = p_qr_id;

  perform public.write_audit_log(
    v_qr.business_id, v_qr.outlet_id, p_actor, 'qr.revoked', 'qr_code', p_qr_id::text,
    jsonb_build_object('status', 'active'), jsonb_build_object('status', 'revoked'), '{}'::jsonb
  );
end;
$$;

revoke all on function public.qr_code_revoke(uuid, uuid) from public, anon, authenticated;
grant execute on function public.qr_code_revoke(uuid, uuid) to service_role;

-- ── 7. Staff: accept / reject intake ────────────────────────────────────────

create or replace function public.order_intake_accept(
  p_order_id uuid,
  p_actor uuid,
  p_auto boolean
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order public.orders%rowtype;
  v_table public.dining_tables%rowtype;
begin
  select * into v_order from public.orders where id = p_order_id for update;
  if v_order.id is null then
    raise exception 'Order not found.' using errcode = 'P0001';
  end if;
  if v_order.channel = 'pos' then
    raise exception 'Only online and QR orders need acceptance.' using errcode = 'P0001';
  end if;
  if v_order.intake_status <> 'awaiting_acceptance' or v_order.status <> 'held' then
    raise exception 'This order has already been accepted or rejected.' using errcode = 'P0001';
  end if;

  if v_order.order_type = 'dine_in' then
    select * into v_table from public.dining_tables where id = v_order.table_id for update;
    if v_table.id is null or not v_table.is_active then
      raise exception 'The table for this order is no longer active. Move the order to another table first.'
        using errcode = 'P0001';
    end if;
    if v_table.status = 'reserved' then
      raise exception 'Table % is reserved. Accept after the reservation or move the order.', v_table.label
        using errcode = 'P0001';
    end if;
    if v_table.status = 'occupied' and v_table.current_order_id is distinct from p_order_id then
      raise exception 'Table % is occupied. Accept after it clears, or move the order.', v_table.label
        using errcode = 'P0003';
    end if;
    update public.dining_tables
       set status = 'occupied', current_order_id = p_order_id
     where id = v_table.id;
  end if;

  perform set_config('restronex.intake_accept', 'on', true);

  update public.orders
     set status = 'placed',
         intake_status = 'accepted',
         accepted_at = now(),
         accepted_by = p_actor
   where id = p_order_id;

  insert into public.order_status_history (order_id, from_status, to_status, changed_by, note)
  values (
    p_order_id, 'held', 'placed', p_actor,
    case when p_auto then 'Auto-accepted (' || v_order.channel || ')'
         else 'Accepted (' || v_order.channel || ')' end
  );

  perform set_config('restronex.intake_accept', '', true);

  perform public.write_audit_log(
    v_order.business_id, v_order.outlet_id, p_actor, 'order.accepted', 'order', p_order_id::text,
    jsonb_build_object('status', 'held', 'intake_status', 'awaiting_acceptance'),
    jsonb_build_object('status', 'placed', 'intake_status', 'accepted'),
    jsonb_build_object('channel', v_order.channel, 'auto', p_auto)
  );
end;
$$;

revoke all on function public.order_intake_accept(uuid, uuid, boolean) from public, anon, authenticated;
grant execute on function public.order_intake_accept(uuid, uuid, boolean) to service_role;

create or replace function public.online_order_accept(p_actor uuid, p_order_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order public.orders%rowtype;
begin
  select * into v_order from public.orders where id = p_order_id;
  if v_order.id is null then
    raise exception 'Order not found.' using errcode = 'P0001';
  end if;
  perform public.require_outlet_permission(p_actor, v_order.outlet_id, 'orders.manage');
  perform public.order_intake_accept(p_order_id, p_actor, false);
end;
$$;

revoke all on function public.online_order_accept(uuid, uuid) from public, anon, authenticated;
grant execute on function public.online_order_accept(uuid, uuid) to service_role;

create or replace function public.online_order_reject(
  p_actor uuid,
  p_order_id uuid,
  p_reason text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order public.orders%rowtype;
  v_reason text := nullif(trim(coalesce(p_reason, '')), '');
begin
  select * into v_order from public.orders where id = p_order_id for update;
  if v_order.id is null then
    raise exception 'Order not found.' using errcode = 'P0001';
  end if;
  perform public.require_outlet_permission(p_actor, v_order.outlet_id, 'orders.manage');

  if v_order.channel = 'pos' then
    raise exception 'Only online and QR orders can be rejected here.' using errcode = 'P0001';
  end if;
  if v_order.intake_status <> 'awaiting_acceptance' or v_order.status <> 'held' then
    raise exception 'This order has already been accepted or rejected.' using errcode = 'P0001';
  end if;
  if v_reason is null or char_length(v_reason) > 200 then
    raise exception 'Give a reason of up to 200 characters.' using errcode = 'P0001';
  end if;
  if v_order.paid_minor > 0 then
    raise exception 'Refund the payment on this order before rejecting it.' using errcode = 'P0001';
  end if;

  update public.orders
     set intake_status = 'rejected',
         rejected_reason = v_reason,
         status = 'cancelled'
   where id = p_order_id;

  insert into public.order_status_history (order_id, from_status, to_status, changed_by, note)
  values (p_order_id, 'held', 'cancelled', p_actor, left('Rejected: ' || v_reason, 200));

  perform public.write_audit_log(
    v_order.business_id, v_order.outlet_id, p_actor, 'order.rejected', 'order', p_order_id::text,
    jsonb_build_object('intake_status', 'awaiting_acceptance'),
    jsonb_build_object('intake_status', 'rejected'),
    jsonb_build_object('channel', v_order.channel, 'reason', v_reason)
  );
end;
$$;

revoke all on function public.online_order_reject(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.online_order_reject(uuid, uuid, text) to service_role;

-- ── 8. Public: storefront, menu and QR resolution ───────────────────────────

create or replace function public.public_outlet_context(p_business_slug text, p_outlet_slug text)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'business_id', b.id,
    'business_name', b.name,
    'business_slug', b.slug,
    'outlet_id', o.id,
    'outlet_name', o.name,
    'outlet_slug', o.slug,
    'currency_code', o.currency_code,
    'settings', public.ordering_settings_json(o.id)
  )
  from public.businesses b
  join public.outlets o on o.business_id = b.id
  where b.slug = lower(p_business_slug)
    and o.slug = lower(p_outlet_slug)
    and o.status = 'active';
$$;

revoke all on function public.public_outlet_context(text, text) from public, anon, authenticated;
grant execute on function public.public_outlet_context(text, text) to service_role;

create or replace function public.public_menu(p_business_id uuid, p_outlet_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  return (
    with item_rows as (
      select i.id, i.category_id, i.name, i.description, i.is_vegetarian, i.sort_order,
             coalesce(oo.price_minor, i.price_minor) as price_minor
      from public.menu_items i
      left join public.outlet_product_overrides oo
        on oo.product_id = i.id and oo.outlet_id = p_outlet_id
      where i.business_id = p_business_id
        and i.is_available
        and coalesce(oo.is_available, true)
    ),
    variant_rows as (
      select v.product_id,
             jsonb_agg(jsonb_build_object(
               'id', v.id,
               'name', v.name,
               'price_minor', coalesce(ov.price_minor, v.price_minor)
             ) order by v.sort_order, v.name) as variants
      from public.product_variants v
      left join public.outlet_variant_overrides ov
        on ov.variant_id = v.id and ov.outlet_id = p_outlet_id
      where v.business_id = p_business_id
        and v.is_available
        and coalesce(ov.is_available, true)
      group by v.product_id
    ),
    group_rows as (
      select pmg.product_id,
             jsonb_agg(jsonb_build_object(
               'id', g.id,
               'name', g.name,
               'min_selected', g.min_selected,
               'max_selected', g.max_selected,
               'modifiers', (
                 select coalesce(jsonb_agg(jsonb_build_object(
                          'id', m.id, 'name', m.name, 'price_minor', m.price_minor
                        ) order by m.sort_order, m.name), '[]'::jsonb)
                 from public.modifiers m where m.modifier_group_id = g.id
               )
             ) order by pmg.sort_order, g.name) as groups
      from public.product_modifier_groups pmg
      join public.modifier_groups g on g.id = pmg.modifier_group_id
      where g.business_id = p_business_id
      group by pmg.product_id
    ),
    item_json as (
      select ir.category_id, ir.sort_order, ir.name,
             jsonb_build_object(
               'id', ir.id,
               'item_type', 'product',
               'name', ir.name,
               'description', ir.description,
               'is_vegetarian', ir.is_vegetarian,
               'price_minor', ir.price_minor,
               'variants', coalesce(vr.variants, '[]'::jsonb),
               'modifier_groups', coalesce(gr.groups, '[]'::jsonb)
             ) as item
      from item_rows ir
      left join variant_rows vr on vr.product_id = ir.id
      left join group_rows gr on gr.product_id = ir.id
    ),
    category_json as (
      select c.id, c.name, c.parent_id, c.sort_order,
             jsonb_agg(ij.item order by ij.sort_order, ij.name) as items
      from public.menu_categories c
      join item_json ij on ij.category_id = c.id
      where c.business_id = p_business_id
      group by c.id, c.name, c.parent_id, c.sort_order
    ),
    combo_json as (
      select jsonb_build_object(
               'id', c.id,
               'item_type', 'combo',
               'name', c.name,
               'description', c.description,
               'is_vegetarian', c.is_vegetarian,
               'price_minor', c.price_minor,
               'variants', '[]'::jsonb,
               'modifier_groups', '[]'::jsonb
             ) as item
      from public.combos c
      where c.business_id = p_business_id and c.is_available
      order by c.sort_order, c.name
    )
    select jsonb_build_object(
      'categories', coalesce((
        select jsonb_agg(jsonb_build_object(
                 'id', cj.id, 'name', cj.name, 'parent_id', cj.parent_id, 'items', cj.items
               ) order by cj.sort_order, cj.name)
        from category_json cj
      ), '[]'::jsonb),
      'combos', coalesce((select jsonb_agg(item) from combo_json), '[]'::jsonb)
    )
  );
end;
$$;

revoke all on function public.public_menu(uuid, uuid) from public, anon, authenticated;
grant execute on function public.public_menu(uuid, uuid) to service_role;

create or replace function public.public_qr_context(p_token_hash text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_qr public.qr_codes%rowtype;
  v_result jsonb;
begin
  select q.* into v_qr
  from public.qr_codes q
  join public.dining_tables t on t.id = q.table_id
  join public.outlets o on o.id = q.outlet_id
  where q.token_hash = p_token_hash
    and q.status = 'active'
    and t.is_active
    and o.status = 'active';

  if v_qr.id is null then
    return null;
  end if;

  update public.qr_codes set last_used_at = now() where id = v_qr.id;

  select jsonb_build_object(
    'qr_code_id', v_qr.id,
    'business_id', b.id,
    'business_name', b.name,
    'outlet_id', o.id,
    'outlet_name', o.name,
    'currency_code', o.currency_code,
    'table_id', t.id,
    'table_label', t.label,
    'settings', public.ordering_settings_json(o.id)
  ) into v_result
  from public.businesses b
  join public.outlets o on o.business_id = b.id
  join public.dining_tables t on t.id = v_qr.table_id
  where b.id = v_qr.business_id and o.id = v_qr.outlet_id;

  return v_result;
end;
$$;

revoke all on function public.public_qr_context(text) from public, anon, authenticated;
grant execute on function public.public_qr_context(text) to service_role;

-- ── 9. Public: order creation and status ────────────────────────────────────

create or replace function public.public_order_status(p_order_id uuid, p_tracking_token_hash text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_result jsonb;
begin
  if p_tracking_token_hash is null then
    return null;
  end if;

  select jsonb_build_object(
    'order_id', o.id,
    'order_number', o.order_number,
    'channel', o.channel,
    'order_type', o.order_type,
    'status', o.status,
    'intake_status', o.intake_status,
    'payment_mode', o.payment_mode,
    'total_minor', o.total_minor,
    'paid_minor', o.paid_minor,
    'rejected_reason', o.rejected_reason,
    'created_at', o.created_at,
    'accepted_at', o.accepted_at,
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
               'name', i.name, 'quantity', i.quantity, 'line_total_minor', i.line_total_minor
             ) order by i.position)
      from public.order_items i where i.order_id = o.id
    ), '[]'::jsonb)
  ) into v_result
  from public.orders o
  where o.id = p_order_id
    and o.tracking_token_hash = p_tracking_token_hash;

  return v_result;
end;
$$;

revoke all on function public.public_order_status(uuid, text) from public, anon, authenticated;
grant execute on function public.public_order_status(uuid, text) to service_role;

create or replace function public.public_order_create(
  p_channel text,
  p_business_id uuid,
  p_outlet_id uuid,
  p_qr_code_id uuid,
  p_payload jsonb,
  p_fingerprint text,
  p_tracking_token_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_settings jsonb;
  v_outlet_status text;
  v_client_ref_raw text := trim(coalesce(p_payload ->> 'client_ref', ''));
  v_client_ref text;
  v_existing record;
  v_fp text := coalesce(nullif(trim(coalesce(p_fingerprint, '')), ''), 'unknown');
  v_order_type text := coalesce(p_payload ->> 'order_type', '');
  v_payment_mode text;
  v_table_id uuid;
  v_qr public.qr_codes%rowtype;
  v_name text := nullif(trim(coalesce(p_payload ->> 'customer_name', '')), '');
  v_phone text := nullif(trim(coalesce(p_payload ->> 'customer_phone', '')), '');
  v_address text := nullif(trim(coalesce(p_payload ->> 'delivery_address', '')), '');
  v_notes text := nullif(trim(coalesce(p_payload ->> 'notes', '')), '');
  v_order_number integer;
  v_order_id uuid;
  v_subtotal bigint;
  v_charges jsonb := '[]'::jsonb;
  v_min bigint;
  v_delivery_fee bigint;
  v_packaging_fee bigint;
  v_auto boolean;
  v_table_free boolean := true;
  v_table_row public.dining_tables%rowtype;
begin
  if p_channel not in ('online', 'qr') then
    raise exception 'Unknown ordering channel.' using errcode = 'P0001';
  end if;

  if v_client_ref_raw !~ '^[A-Za-z0-9_-]{16,40}$' then
    raise exception 'The order reference is invalid. Refresh the page and try again.' using errcode = 'P0001';
  end if;
  v_client_ref := 'pub-' || p_channel || '-' || v_client_ref_raw;

  if p_tracking_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'The tracking secret is invalid.' using errcode = 'P0001';
  end if;

  select o.status into v_outlet_status
  from public.outlets o
  where o.id = p_outlet_id and o.business_id = p_business_id;
  if v_outlet_status is distinct from 'active' then
    raise exception 'This outlet is not taking orders.' using errcode = 'P0001';
  end if;

  -- Idempotent replay: the same reference with the same secret returns the
  -- original order. A different secret is refused and reveals nothing.
  select o.id, o.tracking_token_hash into v_existing
  from public.orders o
  where o.business_id = p_business_id and o.client_ref = v_client_ref;
  if v_existing.id is not null then
    if v_existing.tracking_token_hash is distinct from p_tracking_token_hash then
      raise exception 'This order was already submitted.' using errcode = 'P0001';
    end if;
    return public.public_order_status(v_existing.id, p_tracking_token_hash);
  end if;

  v_settings := public.ordering_settings_json(p_outlet_id);
  if not (v_settings ->> 'accepting_orders')::boolean then
    raise exception 'This outlet is not accepting orders right now.' using errcode = 'P0001';
  end if;

  if p_channel = 'online' then
    if not (v_settings ->> 'online_enabled')::boolean then
      raise exception 'Online ordering is not available at this outlet.' using errcode = 'P0001';
    end if;
    if v_order_type not in ('takeaway', 'delivery') then
      raise exception 'Choose takeaway or delivery.' using errcode = 'P0001';
    end if;
    if v_order_type = 'takeaway' and not (v_settings ->> 'takeaway_enabled')::boolean then
      raise exception 'Takeaway is not available right now.' using errcode = 'P0001';
    end if;
    if v_order_type = 'delivery' and not (v_settings ->> 'delivery_enabled')::boolean then
      raise exception 'Delivery is not available right now.' using errcode = 'P0001';
    end if;
    if v_phone is null or public.customer_phone_key(v_phone) is null then
      raise exception 'Enter a valid phone number so the restaurant can reach you.' using errcode = 'P0001';
    end if;
    if v_order_type = 'delivery' and v_address is null then
      raise exception 'Enter a delivery address.' using errcode = 'P0001';
    end if;
    v_payment_mode := case when v_order_type = 'delivery' then 'pay_on_delivery' else 'pay_at_counter' end;
    perform public.public_rate_limit_hit('checkout:' || p_outlet_id::text || ':' || v_fp, 12, 600);
    perform public.public_rate_limit_hit('checkout-outlet:' || p_outlet_id::text, 300, 3600);
  else
    if not (v_settings ->> 'qr_enabled')::boolean then
      raise exception 'QR ordering is not available at this outlet.' using errcode = 'P0001';
    end if;
    select q.* into v_qr
    from public.qr_codes q
    where q.id = p_qr_code_id
      and q.business_id = p_business_id
      and q.outlet_id = p_outlet_id
      and q.status = 'active';
    if v_qr.id is null then
      raise exception 'This QR code is not active. Ask a team member for help.' using errcode = 'P0001';
    end if;
    select * into v_table_row from public.dining_tables where id = v_qr.table_id;
    if v_table_row.id is null or not v_table_row.is_active then
      raise exception 'This table is not active. Ask a team member for help.' using errcode = 'P0001';
    end if;
    v_table_id := v_qr.table_id;
    v_order_type := 'dine_in';
    v_payment_mode := 'pay_at_table';
    perform public.public_rate_limit_hit('qr:' || v_qr.id::text || ':' || v_fp, 20, 600);
    perform public.public_rate_limit_hit('qr-outlet:' || p_outlet_id::text, 600, 3600);
  end if;

  -- Order number, same counter as POS.
  insert into public.business_order_counters (business_id, order_seq)
  values (p_business_id, 1001)
  on conflict (business_id)
  do update set order_seq = public.business_order_counters.order_seq + 1
  returning order_seq into v_order_number;

  insert into public.orders (
    business_id, outlet_id, order_number, client_ref, created_by,
    order_type, status, table_id,
    customer_name, customer_phone, delivery_address, notes,
    channel, intake_status, payment_mode, tracking_token_hash, qr_code_id
  ) values (
    p_business_id, p_outlet_id, v_order_number, v_client_ref, null,
    v_order_type, 'held', v_table_id,
    v_name, v_phone, v_address, v_notes,
    p_channel, 'awaiting_acceptance', v_payment_mode, p_tracking_token_hash,
    case when p_channel = 'qr' then p_qr_code_id else null end
  )
  returning id into v_order_id;

  -- Server-side pricing: the universal menu resolves every price, availability
  -- and modifier rule. Unknown or unavailable items raise here.
  v_subtotal := public.pos_persist_items(v_order_id, p_business_id, p_outlet_id, p_payload -> 'items');

  -- The minimum applies to online orders only. QR dine-in tickets have none.
  v_min := (v_settings ->> 'min_order_minor')::bigint;
  if p_channel = 'online' and v_min > 0 and v_subtotal < v_min then
    raise exception 'The minimum order here is %.', public.money_text(v_min) using errcode = 'P0001';
  end if;

  v_delivery_fee := (v_settings ->> 'delivery_fee_minor')::bigint;
  v_packaging_fee := (v_settings ->> 'packaging_fee_minor')::bigint;
  if v_order_type = 'delivery' and v_delivery_fee > 0 then
    v_charges := v_charges || jsonb_build_array(jsonb_build_object('name', 'Delivery fee', 'amount_minor', v_delivery_fee));
  end if;
  if v_order_type in ('takeaway', 'delivery') and v_packaging_fee > 0 then
    v_charges := v_charges || jsonb_build_array(jsonb_build_object('name', 'Packaging', 'amount_minor', v_packaging_fee));
  end if;

  -- Public orders never carry a client discount. Only the outlet's fees apply.
  perform public.pos_apply_totals(
    v_order_id, p_business_id, v_subtotal, '{"type":"none"}'::jsonb, v_charges
  );

  insert into public.order_status_history (order_id, from_status, to_status, changed_by, note)
  values (v_order_id, null, 'held', null, 'Placed by customer (' || p_channel || ')');

  -- Auto-accept never fails the customer's order. A busy or reserved QR table
  -- leaves the order awaiting acceptance so staff can decide.
  v_auto := (v_settings ->> 'auto_accept')::boolean;
  if v_auto then
    if v_order_type = 'dine_in' then
      v_table_free := v_table_row.status = 'available';
    end if;
    if v_table_free then
      perform public.order_intake_accept(v_order_id, null, true);
    end if;
  end if;

  return public.public_order_status(v_order_id, p_tracking_token_hash);
end;
$$;

revoke all on function public.public_order_create(text, uuid, uuid, uuid, jsonb, text, text) from public, anon, authenticated;
grant execute on function public.public_order_create(text, uuid, uuid, uuid, jsonb, text, text) to service_role;

-- ── 10. Staff queue helper ──────────────────────────────────────────────────

create or replace function public.online_intake_queue(p_actor uuid, p_outlet_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  perform public.require_outlet_permission(p_actor, p_outlet_id, 'orders.view');

  return (
    select coalesce(jsonb_agg(jsonb_build_object(
             'id', o.id,
             'order_number', o.order_number,
             'channel', o.channel,
             'order_type', o.order_type,
             'status', o.status,
             'intake_status', o.intake_status,
             'payment_mode', o.payment_mode,
             'table_label', t.label,
             'customer_name', o.customer_name,
             'customer_phone', o.customer_phone,
             'delivery_address', o.delivery_address,
             'notes', o.notes,
             'total_minor', o.total_minor,
             'created_at', o.created_at,
             'accepted_at', o.accepted_at,
             'rejected_reason', o.rejected_reason,
             'items', coalesce((
               select jsonb_agg(jsonb_build_object(
                        'name', i.name, 'quantity', i.quantity, 'line_total_minor', i.line_total_minor
                      ) order by i.position)
               from public.order_items i where i.order_id = o.id
             ), '[]'::jsonb)
           ) order by o.created_at desc), '[]'::jsonb)
    from public.orders o
    left join public.dining_tables t on t.id = o.table_id
    where o.outlet_id = p_outlet_id
      and o.channel in ('online', 'qr')
      and (
        o.intake_status = 'awaiting_acceptance'
        or (o.status in ('placed', 'preparing', 'ready') and o.intake_status = 'accepted')
      )
      and o.created_at > now() - interval '2 days'
  );
end;
$$;

revoke all on function public.online_intake_queue(uuid, uuid) from public, anon, authenticated;
grant execute on function public.online_intake_queue(uuid, uuid) to service_role;

-- ── 11. Reports: sales by channel (reconciles to report_sales_by_outlet) ────

create or replace function public.report_sales_by_channel(
  p_actor uuid,
  p_business_id uuid,
  p_outlet_ids uuid[],
  p_from date,
  p_to date,
  p_search text,
  p_grain text,
  p_limit integer,
  p_offset integer
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_outlets uuid[];
begin
  perform public.report_guard(p_from, p_to, 'day', p_limit, p_offset);
  v_outlets := public.report_access(p_actor, p_business_id, p_outlet_ids, null);

  return (
    with sales as (
      select o.channel,
             o.order_type,
             count(*) as orders,
             sum(o.subtotal_minor) as gross_minor,
             sum(o.discount_minor) as discount_minor,
             sum(o.tax_minor) as tax_minor,
             sum(o.total_minor) as billed_minor
      from public.report_orders(p_business_id, v_outlets, p_from, p_to) r
      join public.orders o on o.id = r.order_id
      group by o.channel, o.order_type
    ),
    result_rows as (
      select s.channel,
             s.order_type,
             case s.order_type when 'dine_in' then 'Dine-in'
                               when 'takeaway' then 'Takeaway'
                               when 'delivery' then 'Delivery' else s.order_type end as order_type_label,
             case s.channel when 'pos' then 'Counter / POS'
                            when 'online' then 'Website'
                            when 'qr' then 'QR table' end as channel_label,
             s.orders,
             s.gross_minor,
             s.discount_minor,
             s.gross_minor - s.discount_minor as net_sales_minor,
             s.tax_minor,
             s.billed_minor,
             case when s.orders > 0 then round(s.billed_minor::numeric / s.orders) else 0 end as avg_order_minor
      from sales s
      where p_search is null or p_search = ''
         or (case s.channel when 'pos' then 'Counter / POS'
                            when 'online' then 'Website'
                            when 'qr' then 'QR table' end) ilike '%' || p_search || '%'
         or s.order_type ilike '%' || p_search || '%'
    )
    select jsonb_build_object(
      'total', (select count(*) from result_rows),
      'rows', (select coalesce(jsonb_agg(to_jsonb(t) order by t.channel_label, t.order_type_label), '[]'::jsonb)
               from (select * from result_rows order by channel_label, order_type_label limit p_limit offset p_offset) t),
      'summary', (select jsonb_build_object(
                    'orders', coalesce(sum(orders), 0),
                    'gross_minor', coalesce(sum(gross_minor), 0),
                    'discount_minor', coalesce(sum(discount_minor), 0),
                    'net_sales_minor', coalesce(sum(net_sales_minor), 0),
                    'tax_minor', coalesce(sum(tax_minor), 0),
                    'billed_minor', coalesce(sum(billed_minor), 0))
                  from result_rows)
    )
  );
end;
$$;

revoke all on function public.report_sales_by_channel(uuid, uuid, uuid[], date, date, text, text, integer, integer)
  from public, anon, authenticated;
grant execute on function public.report_sales_by_channel(uuid, uuid, uuid[], date, date, text, text, integer, integer)
  to service_role;

-- ── 12. Payment webhooks: verified, idempotent receipt log ──────────────────
-- Phase 17 registers no payment provider, so the webhook receiver refuses every
-- request before it reads the body. This table and claim function are built now
-- so that a provider added later inherits idempotency: a repeated event id is a
-- no-op, and an event id reused with a different payload is flagged.
-- A claim never changes an order or a payment. Marking an order paid stays a
-- separate, verified step that a later phase adds.
create table if not exists public.payment_webhook_events (
  id uuid primary key default gen_random_uuid(),
  provider text not null
    constraint payment_webhook_events_provider_format check (provider ~ '^[a-z][a-z0-9_]{1,31}$'),
  event_id text not null
    constraint payment_webhook_events_event_id_length check (char_length(event_id) between 1 and 120),
  event_type text,
  payload_sha256 text not null
    constraint payment_webhook_events_hash_format check (payload_sha256 ~ '^[0-9a-f]{64}$'),
  status text not null default 'received'
    constraint payment_webhook_events_status_allowed check (status in ('received', 'processed', 'ignored', 'failed')),
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  constraint payment_webhook_events_unique unique (provider, event_id)
);

alter table public.payment_webhook_events enable row level security;
revoke all on public.payment_webhook_events from public, anon, authenticated;

create or replace function public.payment_webhook_claim(
  p_provider text,
  p_event_id text,
  p_event_type text,
  p_payload_sha256 text
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_existing public.payment_webhook_events%rowtype;
begin
  if p_payload_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception 'Invalid payload digest.' using errcode = 'P0001';
  end if;

  insert into public.payment_webhook_events (provider, event_id, event_type, payload_sha256)
  values (p_provider, p_event_id, p_event_type, p_payload_sha256)
  on conflict (provider, event_id) do nothing
  returning * into v_existing;

  if v_existing.id is not null then
    return 'new';
  end if;

  select * into v_existing from public.payment_webhook_events
  where provider = p_provider and event_id = p_event_id;

  if v_existing.payload_sha256 = p_payload_sha256 then
    return 'duplicate';
  end if;
  return 'mismatch';
end;
$$;

revoke all on function public.payment_webhook_claim(text, text, text, text) from public, anon, authenticated;
grant execute on function public.payment_webhook_claim(text, text, text, text) to service_role;
