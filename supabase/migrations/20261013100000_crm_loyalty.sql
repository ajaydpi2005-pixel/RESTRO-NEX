-- ─────────────────────────────────────────────────────────────────────────
-- Phase 15 — CRM + loyalty: customers, addresses, loyalty settings, an
-- append-only points ledger, rewards, reward vouchers, coupons, and order
-- promotions.
--
-- Rules this migration enforces:
--   * A customer is identified by phone (last 10 digits, unique per business).
--     A trigger links every order that has a phone to its customer, so POS
--     create, amend, split and merge all link the same way.
--   * Points live in loyalty_transactions, an append-only ledger. The running
--     balance (loyalty_accounts) is maintained by the ledger trigger and can
--     never go negative.
--   * Points are earned once per order, when it completes, from net spend
--     (subtotal minus discounts; tax and charges excluded). A refund that fully
--     reverses an order claws back what it earned, capped at the balance.
--   * An order carries at most one promotion: a coupon, or one reward voucher.
--     Its amount is recomputed inside pos_apply_totals on every price change.
--   * A reward voucher is issued once per redemption (idempotent on client_ref),
--     can sit on one order at a time, and is consumed when that order completes.
--   * Coupon usage is counted at completion. Applying a coupon also counts the
--     open applications, so a usage limit cannot be oversold.
--   * Writes go through RPCs (service role). Authenticated users read under
--     customers.view. Money RPCs also check discounts.apply and orders.manage.
-- ─────────────────────────────────────────────────────────────────────────

-- ── 1. helpers ──────────────────────────────────────────────────────────────

-- Identity key for a phone number: the last 10 digits, or all digits when the
-- number is shorter. Null when there are fewer than 7 digits (no customer link).
create or replace function public.customer_phone_key(p_phone text)
returns text
language sql
immutable
set search_path = public
as $$
  select case
    when length(d.digits) >= 10 then right(d.digits, 10)
    when length(d.digits) >= 7 then d.digits
    else null
  end
  from (select regexp_replace(coalesce(p_phone, ''), '\D', '', 'g') as digits) d;
$$;

-- Discount on a base amount. p_base is the subtotal after any manual discount.
create or replace function public.promo_amount(
  p_subtotal bigint,
  p_base bigint,
  p_type text,
  p_value bigint,
  p_max bigint,
  p_min_subtotal bigint
)
returns bigint
language plpgsql
immutable
set search_path = public
as $$
declare
  v bigint;
begin
  if p_base <= 0 or p_subtotal < coalesce(p_min_subtotal, 0) then return 0; end if;
  if p_type = 'percent' then
    v := round(p_base * p_value / 100.0)::bigint;
  else
    v := least(p_value, p_base);
  end if;
  if p_max is not null then v := least(v, p_max); end if;
  return greatest(least(v, p_base), 0);
end;
$$;

revoke all on function public.customer_phone_key(text) from public, anon, authenticated, service_role;
revoke all on function public.promo_amount(bigint, bigint, text, bigint, bigint, bigint)
  from public, anon, authenticated, service_role;

-- Append-only guard for ledgers (points, coupon usage).
create or replace function public.crm_ledger_append_only()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  raise exception 'Ledger rows are append-only.' using errcode = '42501';
end;
$$;

revoke all on function public.crm_ledger_append_only() from public, anon, authenticated, service_role;

-- ── 2. customers ────────────────────────────────────────────────────────────

create table public.customers (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  name text not null
    constraint customers_name_length check (char_length(trim(name)) between 1 and 80),
  phone text not null
    constraint customers_phone_length check (char_length(phone) between 6 and 20),
  phone_key text not null
    constraint customers_phone_key_format check (phone_key ~ '^[0-9]{7,15}$'),
  email text
    constraint customers_email_format check (
      email is null or (char_length(email) <= 254 and email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$')
    ),
  notes text
    constraint customers_notes_length check (notes is null or char_length(notes) <= 500),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint customers_phone_key_unique unique (business_id, phone_key)
);

create table public.customer_addresses (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  customer_id uuid not null references public.customers (id) on delete cascade,
  label text not null
    constraint customer_addresses_label_length check (char_length(trim(label)) between 1 and 30),
  address text not null
    constraint customer_addresses_address_length check (char_length(trim(address)) between 1 and 300),
  created_at timestamptz not null default now()
);

create index customer_addresses_customer_idx on public.customer_addresses (customer_id);

-- Link orders to customers. Orders keep the phone and name as typed; customer_id
-- is derived from the phone, so no caller can attach an order to someone else.
alter table public.orders
  add column customer_id uuid references public.customers (id) on delete set null,
  add column promotion_minor bigint not null default 0
    constraint orders_promotion_minor_range check (promotion_minor >= 0);

create index orders_customer_idx on public.orders (customer_id) where customer_id is not null;

-- ── 3. loyalty settings, rewards, vouchers ──────────────────────────────────

create table public.loyalty_settings (
  business_id uuid primary key references public.businesses (id) on delete cascade,
  enabled boolean not null default false,
  earn_minor_per_point bigint not null default 10000
    constraint loyalty_settings_rate_range check (earn_minor_per_point between 100 and 10000000),
  updated_at timestamptz not null default now()
);

create table public.loyalty_rewards (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  name text not null
    constraint loyalty_rewards_name_length check (char_length(trim(name)) between 1 and 80),
  points_cost integer not null
    constraint loyalty_rewards_cost_range check (points_cost between 1 and 1000000),
  discount_type text not null
    constraint loyalty_rewards_type_allowed check (discount_type in ('flat', 'percent')),
  discount_value bigint not null
    constraint loyalty_rewards_value_range check (discount_value > 0),
  max_discount_minor bigint
    constraint loyalty_rewards_max_range check (max_discount_minor is null or max_discount_minor > 0),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint loyalty_rewards_percent_range check (discount_type <> 'percent' or discount_value <= 100),
  constraint loyalty_rewards_name_unique unique (business_id, name)
);

-- A voucher snapshots its reward at redemption, so later edits to the reward
-- do not change vouchers already issued.
create table public.customer_vouchers (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  customer_id uuid not null references public.customers (id) on delete restrict,
  reward_id uuid references public.loyalty_rewards (id) on delete set null,
  name text not null
    constraint customer_vouchers_name_length check (char_length(trim(name)) between 1 and 80),
  points_spent integer not null
    constraint customer_vouchers_points_range check (points_spent > 0),
  discount_type text not null
    constraint customer_vouchers_type_allowed check (discount_type in ('flat', 'percent')),
  discount_value bigint not null
    constraint customer_vouchers_value_range check (discount_value > 0),
  max_discount_minor bigint
    constraint customer_vouchers_max_range check (max_discount_minor is null or max_discount_minor > 0),
  status text not null default 'issued'
    constraint customer_vouchers_status_allowed check (status in ('issued', 'applied', 'used')),
  order_id uuid references public.orders (id) on delete set null,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint customer_vouchers_percent_range check (discount_type <> 'percent' or discount_value <= 100),
  constraint customer_vouchers_applied_order check (status = 'issued' or order_id is not null)
);

create index customer_vouchers_customer_idx on public.customer_vouchers (customer_id, status);

-- ── 4. loyalty accounts and the points ledger ───────────────────────────────

create table public.loyalty_accounts (
  customer_id uuid primary key references public.customers (id) on delete restrict,
  business_id uuid not null references public.businesses (id) on delete cascade,
  balance integer not null default 0
    constraint loyalty_accounts_balance_range check (balance >= 0),
  updated_at timestamptz not null default now()
);

create table public.loyalty_transactions (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  customer_id uuid not null references public.customers (id) on delete restrict,
  kind text not null
    constraint loyalty_transactions_kind_allowed check (kind in ('earn', 'redeem', 'reversal', 'adjust')),
  points integer not null
    constraint loyalty_transactions_points_nonzero check (points <> 0),
  balance_after integer not null default 0
    constraint loyalty_transactions_balance_range check (balance_after >= 0),
  order_id uuid references public.orders (id) on delete restrict,
  voucher_id uuid references public.customer_vouchers (id) on delete restrict,
  reason text
    constraint loyalty_transactions_reason_length check (reason is null or char_length(reason) <= 200),
  client_ref text
    constraint loyalty_transactions_client_ref_length check (client_ref is null or char_length(client_ref) <= 80),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  constraint loyalty_transactions_sign check (
    (kind = 'earn' and points > 0)
    or (kind in ('redeem', 'reversal') and points < 0)
    or (kind = 'adjust' and points <> 0)
  ),
  constraint loyalty_transactions_adjust_reason check (
    kind <> 'adjust' or char_length(trim(coalesce(reason, ''))) >= 3
  ),
  constraint loyalty_transactions_order_kind check (
    kind not in ('earn', 'reversal') or order_id is not null
  ),
  constraint loyalty_transactions_redeem_voucher check (
    kind <> 'redeem' or voucher_id is not null
  )
);

-- One earn and one reversal per order. Redemptions and adjustments are
-- idempotent through client_ref.
create unique index loyalty_transactions_earn_once
  on public.loyalty_transactions (order_id) where kind = 'earn';
create unique index loyalty_transactions_reversal_once
  on public.loyalty_transactions (order_id) where kind = 'reversal';
create unique index loyalty_transactions_client_ref_once
  on public.loyalty_transactions (business_id, client_ref) where client_ref is not null;
create index loyalty_transactions_customer_idx on public.loyalty_transactions (customer_id, created_at);

create trigger loyalty_transactions_append_only
  before update or delete on public.loyalty_transactions
  for each row execute function public.crm_ledger_append_only();

-- Applies each ledger row to the running balance. Runs before insert so the
-- row carries the balance it produced. A negative balance aborts the write.
create or replace function public.loyalty_transactions_apply()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_balance integer;
begin
  insert into public.loyalty_accounts (customer_id, business_id, balance)
  values (new.customer_id, new.business_id, 0)
  on conflict (customer_id) do nothing;

  -- lock the account, then check the result before writing, so an overdraw
  -- gets this message rather than the table's check constraint
  select a.balance into v_balance from public.loyalty_accounts a
  where a.customer_id = new.customer_id
  for update;

  v_balance := coalesce(v_balance, 0) + new.points;
  if v_balance < 0 then
    raise exception 'Not enough points for this change.' using errcode = 'P0001';
  end if;

  update public.loyalty_accounts
     set balance = v_balance, updated_at = now()
   where customer_id = new.customer_id;

  new.balance_after := v_balance;
  return new;
end;
$$;

revoke all on function public.loyalty_transactions_apply() from public, anon, authenticated, service_role;

create trigger loyalty_transactions_apply_balance
  before insert on public.loyalty_transactions
  for each row execute function public.loyalty_transactions_apply();

-- ── 5. coupons, order promotions, coupon usage ──────────────────────────────

create table public.coupons (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  code text not null
    constraint coupons_code_format check (code ~ '^[A-Z0-9-]{3,20}$'),
  name text not null
    constraint coupons_name_length check (char_length(trim(name)) between 1 and 80),
  discount_type text not null
    constraint coupons_type_allowed check (discount_type in ('flat', 'percent')),
  discount_value bigint not null
    constraint coupons_value_range check (discount_value > 0),
  max_discount_minor bigint
    constraint coupons_max_range check (max_discount_minor is null or max_discount_minor > 0),
  min_subtotal_minor bigint not null default 0
    constraint coupons_min_range check (min_subtotal_minor >= 0),
  starts_on date,
  ends_on date,
  usage_limit integer
    constraint coupons_usage_range check (usage_limit is null or usage_limit > 0),
  per_customer_limit integer
    constraint coupons_per_customer_range check (per_customer_limit is null or per_customer_limit > 0),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint coupons_percent_range check (discount_type <> 'percent' or discount_value <= 100),
  constraint coupons_dates check (starts_on is null or ends_on is null or ends_on >= starts_on),
  constraint coupons_code_unique unique (business_id, code)
);

-- The promotion on an open order. The amount is recomputed on every price change.
create table public.order_promotions (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  order_id uuid not null unique references public.orders (id) on delete cascade,
  kind text not null
    constraint order_promotions_kind_allowed check (kind in ('coupon', 'reward')),
  coupon_id uuid references public.coupons (id) on delete restrict,
  voucher_id uuid references public.customer_vouchers (id) on delete restrict,
  label text not null
    constraint order_promotions_label_length check (char_length(label) between 1 and 80),
  discount_type text not null
    constraint order_promotions_type_allowed check (discount_type in ('flat', 'percent')),
  discount_value bigint not null,
  max_discount_minor bigint,
  min_subtotal_minor bigint not null default 0,
  amount_minor bigint not null default 0
    constraint order_promotions_amount_range check (amount_minor >= 0),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  constraint order_promotions_source check (
    (kind = 'coupon' and coupon_id is not null and voucher_id is null)
    or (kind = 'reward' and voucher_id is not null and coupon_id is null)
  )
);

create unique index order_promotions_voucher_once
  on public.order_promotions (voucher_id) where voucher_id is not null;
create index order_promotions_coupon_idx on public.order_promotions (coupon_id) where coupon_id is not null;

-- Written once per coupon when its order completes. Never edited or deleted.
create table public.coupon_redemptions (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  coupon_id uuid not null references public.coupons (id) on delete restrict,
  order_id uuid not null unique references public.orders (id) on delete restrict,
  customer_id uuid references public.customers (id) on delete restrict,
  amount_minor bigint not null
    constraint coupon_redemptions_amount_range check (amount_minor > 0),
  created_at timestamptz not null default now()
);

create index coupon_redemptions_coupon_idx on public.coupon_redemptions (coupon_id, customer_id);

create trigger coupon_redemptions_append_only
  before update or delete on public.coupon_redemptions
  for each row execute function public.crm_ledger_append_only();

-- ── 6. pos_apply_totals: manual discount + order promotion ──────────────────
-- Same signature as Phase 8; the promotion is read from order_promotions, so
-- create, amend, split and merge recompute it without any change to callers.

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
  v_manual_minor bigint := 0;
  v_promo_minor bigint := 0;
  v_discount_minor bigint := 0;
  v_charge jsonb;
  v_charges_minor bigint := 0;
  v_tax_minor bigint := 0;
  v_line_share bigint;
  v_line_tax bigint;
  v_row record;
  v_promo record;
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
    v_manual_minor := round(p_subtotal * v_discount_value / 100.0)::bigint;
  elsif v_discount_type = 'flat' then
    v_manual_minor := least(v_discount_value, p_subtotal);
  end if;

  select op.* into v_promo from public.order_promotions op where op.order_id = p_order_id;
  if found then
    v_promo_minor := public.promo_amount(
      p_subtotal,
      p_subtotal - v_manual_minor,
      v_promo.discount_type,
      v_promo.discount_value,
      v_promo.max_discount_minor,
      v_promo.min_subtotal_minor
    );
    update public.order_promotions set amount_minor = v_promo_minor where id = v_promo.id;
  end if;

  v_discount_minor := v_manual_minor + v_promo_minor;

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
    promotion_minor = v_promo_minor,
    tax_minor = v_tax_minor,
    charges_minor = v_charges_minor,
    total_minor = p_subtotal - v_discount_minor + v_tax_minor + v_charges_minor
  where id = p_order_id;
end;
$$;

revoke all on function public.pos_apply_totals(uuid, uuid, bigint, jsonb, jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.pos_apply_totals(uuid, uuid, bigint, jsonb, jsonb) to service_role;

-- ── 7. triggers on orders ───────────────────────────────────────────────────

-- Link the order to a customer by phone. A new phone creates the customer.
-- An existing customer keeps their name. A phone change is refused while a
-- promotion is attached, because the promotion belongs to the old customer.
create or replace function public.orders_link_customer()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_key text;
  v_id uuid;
begin
  if tg_op = 'UPDATE' and new.customer_phone is not distinct from old.customer_phone then
    return new;
  end if;

  if tg_op = 'UPDATE' and exists (select 1 from public.order_promotions op where op.order_id = old.id) then
    raise exception 'Remove the coupon or reward before changing the customer phone.' using errcode = 'P0001';
  end if;

  v_key := public.customer_phone_key(new.customer_phone);
  if v_key is null then
    new.customer_id := null;
    return new;
  end if;

  select c.id into v_id from public.customers c
  where c.business_id = new.business_id and c.phone_key = v_key;

  if v_id is null then
    insert into public.customers (business_id, name, phone, phone_key)
    values (
      new.business_id,
      coalesce(nullif(trim(coalesce(new.customer_name, '')), ''), 'Customer ' || right(v_key, 4)),
      trim(new.customer_phone),
      v_key
    )
    on conflict (business_id, phone_key) do nothing
    returning id into v_id;

    if v_id is null then
      select c.id into v_id from public.customers c
      where c.business_id = new.business_id and c.phone_key = v_key;
    end if;
  end if;

  new.customer_id := v_id;
  return new;
end;
$$;

revoke all on function public.orders_link_customer() from public, anon, authenticated, service_role;

create trigger orders_link_customer
  before insert or update of customer_phone on public.orders
  for each row execute function public.orders_link_customer();

-- Completion earns points and consumes the promotion. Cancellation releases it.
create or replace function public.orders_crm_on_status()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_enabled boolean;
  v_rate bigint;
  v_points bigint;
  v_base bigint;
  v_promo record;
begin
  if new.status = 'completed' and old.status is distinct from 'completed' then
    select op.* into v_promo from public.order_promotions op where op.order_id = new.id;
    if found then
      if v_promo.kind = 'coupon' then
        insert into public.coupon_redemptions (business_id, coupon_id, order_id, customer_id, amount_minor)
        values (new.business_id, v_promo.coupon_id, new.id, new.customer_id, v_promo.amount_minor);
      else
        update public.customer_vouchers
           set status = 'used', order_id = new.id, updated_at = now()
         where id = v_promo.voucher_id;
      end if;
    end if;

    if new.customer_id is not null then
      select s.enabled, s.earn_minor_per_point into v_enabled, v_rate
      from public.loyalty_settings s where s.business_id = new.business_id;
      if coalesce(v_enabled, false) then
        v_base := new.subtotal_minor - new.discount_minor;
        v_points := floor(v_base / v_rate);
        if v_points > 0 then
          insert into public.loyalty_transactions (
            business_id, customer_id, kind, points, order_id, reason
          ) values (
            new.business_id, new.customer_id, 'earn', v_points::integer, new.id,
            'Order #' || new.order_number::text
          );
        end if;
      end if;
    end if;
  end if;

  if new.status = 'cancelled' and old.status is distinct from 'cancelled' then
    update public.customer_vouchers
       set status = 'issued', order_id = null, updated_at = now()
     where id in (
       select op.voucher_id from public.order_promotions op
       where op.order_id = new.id and op.voucher_id is not null
     );
    delete from public.order_promotions where order_id = new.id;
  end if;

  return new;
end;
$$;

revoke all on function public.orders_crm_on_status() from public, anon, authenticated, service_role;

create trigger orders_crm_on_status
  after update of status on public.orders
  for each row execute function public.orders_crm_on_status();

-- A full refund claws back the points the order earned, capped at the balance.
-- Partial refunds keep the points. Points already spent are not clawed back.
create or replace function public.orders_loyalty_on_refund()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_net bigint;
  v_balance integer;
  v_take bigint;
begin
  if new.payment_status = 'refunded' and old.payment_status is distinct from 'refunded'
     and new.customer_id is not null then
    select coalesce(sum(t.points), 0) into v_net
    from public.loyalty_transactions t
    where t.order_id = new.id and t.kind in ('earn', 'reversal');

    if v_net > 0 then
      select a.balance into v_balance from public.loyalty_accounts a where a.customer_id = new.customer_id;
      v_take := least(v_net, coalesce(v_balance, 0));
      if v_take > 0 then
        insert into public.loyalty_transactions (
          business_id, customer_id, kind, points, order_id, reason
        ) values (
          new.business_id, new.customer_id, 'reversal', -(v_take::integer), new.id,
          'Refund of order #' || new.order_number::text
        );
      end if;
    end if;
  end if;
  return new;
end;
$$;

revoke all on function public.orders_loyalty_on_refund() from public, anon, authenticated, service_role;

create trigger orders_loyalty_on_refund
  after update of payment_status on public.orders
  for each row execute function public.orders_loyalty_on_refund();

-- ── 8. RPCs: customers ──────────────────────────────────────────────────────

create or replace function public.customer_save(
  p_actor uuid,
  p_business_id uuid,
  p_id uuid,
  p_name text,
  p_phone text,
  p_email text,
  p_notes text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
  v_name text := trim(coalesce(p_name, ''));
  v_phone text := trim(coalesce(p_phone, ''));
  v_key text := public.customer_phone_key(p_phone);
  v_email text := nullif(trim(coalesce(p_email, '')), '');
  v_notes text := nullif(trim(coalesce(p_notes, '')), '');
begin
  if not public.actor_has_permission(p_actor, p_business_id, 'customers.manage') then
    raise exception 'Your role does not allow this action (customers.manage).' using errcode = '42501';
  end if;
  if char_length(v_name) not between 1 and 80 then
    raise exception 'Enter the customer name (up to 80 characters).' using errcode = 'P0001';
  end if;
  if v_key is null or v_phone !~ '^[+0-9 ()-]{6,20}$' then
    raise exception 'Enter a phone number with at least 7 digits.' using errcode = 'P0001';
  end if;
  if v_email is not null and (char_length(v_email) > 254 or v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$') then
    raise exception 'Enter a valid email address.' using errcode = 'P0001';
  end if;
  if v_notes is not null and char_length(v_notes) > 500 then
    raise exception 'Notes can be up to 500 characters.' using errcode = 'P0001';
  end if;

  begin
    if p_id is null then
      insert into public.customers (business_id, name, phone, phone_key, email, notes)
      values (p_business_id, v_name, v_phone, v_key, v_email, v_notes)
      returning id into v_id;
    else
      perform 1 from public.customers c where c.id = p_id and c.business_id = p_business_id for update;
      if not found then
        raise exception 'Customer not found.' using errcode = 'P0001';
      end if;
      update public.customers c set
        name = v_name, phone = v_phone, phone_key = v_key,
        email = v_email, notes = v_notes, updated_at = now()
      where c.id = p_id
      returning c.id into v_id;
    end if;
  exception when unique_violation then
    raise exception 'Another customer already uses this phone number.' using errcode = 'P0001';
  end;

  perform public.write_audit_log(p_business_id, null, p_actor, 'customer.saved',
    'customer', v_id::text, null, jsonb_build_object('name', v_name));
  return v_id;
end;
$$;

create or replace function public.customer_address_save(
  p_actor uuid,
  p_business_id uuid,
  p_customer_id uuid,
  p_id uuid,
  p_label text,
  p_address text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
  v_label text := trim(coalesce(p_label, ''));
  v_address text := trim(coalesce(p_address, ''));
begin
  if not public.actor_has_permission(p_actor, p_business_id, 'customers.manage') then
    raise exception 'Your role does not allow this action (customers.manage).' using errcode = '42501';
  end if;
  perform 1 from public.customers c where c.id = p_customer_id and c.business_id = p_business_id;
  if not found then raise exception 'Customer not found.' using errcode = 'P0001'; end if;
  if char_length(v_label) not between 1 and 30 then
    raise exception 'Label must be 1 to 30 characters.' using errcode = 'P0001';
  end if;
  if char_length(v_address) not between 1 and 300 then
    raise exception 'Address must be 1 to 300 characters.' using errcode = 'P0001';
  end if;

  if p_id is null then
    insert into public.customer_addresses (business_id, customer_id, label, address)
    values (p_business_id, p_customer_id, v_label, v_address)
    returning id into v_id;
  else
    update public.customer_addresses a set label = v_label, address = v_address
    where a.id = p_id and a.customer_id = p_customer_id and a.business_id = p_business_id
    returning a.id into v_id;
    if v_id is null then raise exception 'Address not found.' using errcode = 'P0001'; end if;
  end if;

  perform public.write_audit_log(p_business_id, null, p_actor, 'customer.address_saved',
    'customer', p_customer_id::text, null, jsonb_build_object('label', v_label));
  return v_id;
end;
$$;

create or replace function public.customer_address_delete(
  p_actor uuid,
  p_business_id uuid,
  p_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_customer uuid;
begin
  if not public.actor_has_permission(p_actor, p_business_id, 'customers.manage') then
    raise exception 'Your role does not allow this action (customers.manage).' using errcode = '42501';
  end if;
  delete from public.customer_addresses a
  where a.id = p_id and a.business_id = p_business_id
  returning a.customer_id into v_customer;
  if v_customer is null then raise exception 'Address not found.' using errcode = 'P0001'; end if;

  perform public.write_audit_log(p_business_id, null, p_actor, 'customer.address_deleted',
    'customer', v_customer::text, null, null);
end;
$$;

-- ── 9. RPCs: loyalty settings, rewards, coupons ─────────────────────────────

create or replace function public.loyalty_settings_save(
  p_actor uuid,
  p_business_id uuid,
  p_enabled boolean,
  p_earn_minor_per_point bigint
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.actor_has_permission(p_actor, p_business_id, 'customers.manage') then
    raise exception 'Your role does not allow this action (customers.manage).' using errcode = '42501';
  end if;
  if p_earn_minor_per_point is null or p_earn_minor_per_point not between 100 and 10000000 then
    raise exception 'A point must be worth between ₹1 and ₹1,00,000 of net spend.' using errcode = 'P0001';
  end if;

  insert into public.loyalty_settings (business_id, enabled, earn_minor_per_point)
  values (p_business_id, coalesce(p_enabled, false), p_earn_minor_per_point)
  on conflict (business_id) do update set
    enabled = excluded.enabled,
    earn_minor_per_point = excluded.earn_minor_per_point,
    updated_at = now();

  perform public.write_audit_log(p_business_id, null, p_actor, 'loyalty_settings.saved',
    'loyalty_settings', p_business_id::text, null,
    jsonb_build_object('enabled', coalesce(p_enabled, false), 'earn_minor_per_point', p_earn_minor_per_point));
end;
$$;

create or replace function public.loyalty_reward_save(
  p_actor uuid,
  p_business_id uuid,
  p_id uuid,
  p_name text,
  p_points_cost integer,
  p_discount_type text,
  p_discount_value bigint,
  p_max_discount_minor bigint,
  p_active boolean
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
  v_name text := trim(coalesce(p_name, ''));
begin
  if not public.actor_has_permission(p_actor, p_business_id, 'customers.manage') then
    raise exception 'Your role does not allow this action (customers.manage).' using errcode = '42501';
  end if;
  if char_length(v_name) not between 1 and 80 then
    raise exception 'Reward name must be 1 to 80 characters.' using errcode = 'P0001';
  end if;
  if p_points_cost is null or p_points_cost not between 1 and 1000000 then
    raise exception 'Points cost must be between 1 and 1,000,000.' using errcode = 'P0001';
  end if;
  if p_discount_type not in ('flat', 'percent') then
    raise exception 'Reward discount must be flat or percent.' using errcode = 'P0001';
  end if;
  if p_discount_value is null or p_discount_value <= 0
     or (p_discount_type = 'percent' and p_discount_value > 100)
     or (p_discount_type = 'flat' and p_discount_value > 10000000) then
    raise exception 'Reward discount is out of range.' using errcode = 'P0001';
  end if;
  if p_max_discount_minor is not null and p_max_discount_minor <= 0 then
    raise exception 'The maximum discount must be positive.' using errcode = 'P0001';
  end if;

  begin
    if p_id is null then
      insert into public.loyalty_rewards (
        business_id, name, points_cost, discount_type, discount_value, max_discount_minor, active
      ) values (
        p_business_id, v_name, p_points_cost, p_discount_type, p_discount_value,
        p_max_discount_minor, coalesce(p_active, true)
      ) returning id into v_id;
    else
      update public.loyalty_rewards r set
        name = v_name, points_cost = p_points_cost, discount_type = p_discount_type,
        discount_value = p_discount_value, max_discount_minor = p_max_discount_minor,
        active = coalesce(p_active, true), updated_at = now()
      where r.id = p_id and r.business_id = p_business_id
      returning r.id into v_id;
      if v_id is null then raise exception 'Reward not found.' using errcode = 'P0001'; end if;
    end if;
  exception when unique_violation then
    raise exception 'A reward with this name already exists.' using errcode = 'P0001';
  end;

  perform public.write_audit_log(p_business_id, null, p_actor, 'reward.saved',
    'loyalty_reward', v_id::text, null, jsonb_build_object('name', v_name, 'points_cost', p_points_cost));
  return v_id;
end;
$$;

create or replace function public.coupon_save(
  p_actor uuid,
  p_business_id uuid,
  p_id uuid,
  p_code text,
  p_name text,
  p_discount_type text,
  p_discount_value bigint,
  p_max_discount_minor bigint,
  p_min_subtotal_minor bigint,
  p_starts_on date,
  p_ends_on date,
  p_usage_limit integer,
  p_per_customer_limit integer,
  p_active boolean
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
  v_code text := upper(trim(coalesce(p_code, '')));
  v_name text := trim(coalesce(p_name, ''));
begin
  if not public.actor_has_permission(p_actor, p_business_id, 'customers.manage') then
    raise exception 'Your role does not allow this action (customers.manage).' using errcode = '42501';
  end if;
  if v_code !~ '^[A-Z0-9-]{3,20}$' then
    raise exception 'A coupon code is 3 to 20 letters, digits or dashes.' using errcode = 'P0001';
  end if;
  if char_length(v_name) not between 1 and 80 then
    raise exception 'Coupon name must be 1 to 80 characters.' using errcode = 'P0001';
  end if;
  if p_discount_type not in ('flat', 'percent') then
    raise exception 'Coupon discount must be flat or percent.' using errcode = 'P0001';
  end if;
  if p_discount_value is null or p_discount_value <= 0
     or (p_discount_type = 'percent' and p_discount_value > 100)
     or (p_discount_type = 'flat' and p_discount_value > 10000000) then
    raise exception 'Coupon discount is out of range.' using errcode = 'P0001';
  end if;
  if p_max_discount_minor is not null and p_max_discount_minor <= 0 then
    raise exception 'The maximum discount must be positive.' using errcode = 'P0001';
  end if;
  if coalesce(p_min_subtotal_minor, 0) < 0 then
    raise exception 'The minimum order cannot be negative.' using errcode = 'P0001';
  end if;
  if p_starts_on is not null and p_ends_on is not null and p_ends_on < p_starts_on then
    raise exception 'The end date is before the start date.' using errcode = 'P0001';
  end if;
  if p_usage_limit is not null and p_usage_limit <= 0 then
    raise exception 'The usage limit must be positive.' using errcode = 'P0001';
  end if;
  if p_per_customer_limit is not null and p_per_customer_limit <= 0 then
    raise exception 'The per-customer limit must be positive.' using errcode = 'P0001';
  end if;

  begin
    if p_id is null then
      insert into public.coupons (
        business_id, code, name, discount_type, discount_value, max_discount_minor,
        min_subtotal_minor, starts_on, ends_on, usage_limit, per_customer_limit, active
      ) values (
        p_business_id, v_code, v_name, p_discount_type, p_discount_value, p_max_discount_minor,
        coalesce(p_min_subtotal_minor, 0), p_starts_on, p_ends_on, p_usage_limit,
        p_per_customer_limit, coalesce(p_active, true)
      ) returning id into v_id;
    else
      update public.coupons c set
        code = v_code, name = v_name, discount_type = p_discount_type,
        discount_value = p_discount_value, max_discount_minor = p_max_discount_minor,
        min_subtotal_minor = coalesce(p_min_subtotal_minor, 0), starts_on = p_starts_on,
        ends_on = p_ends_on, usage_limit = p_usage_limit,
        per_customer_limit = p_per_customer_limit, active = coalesce(p_active, true),
        updated_at = now()
      where c.id = p_id and c.business_id = p_business_id
      returning c.id into v_id;
      if v_id is null then raise exception 'Coupon not found.' using errcode = 'P0001'; end if;
    end if;
  exception when unique_violation then
    raise exception 'That coupon code is already in use.' using errcode = 'P0001';
  end;

  perform public.write_audit_log(p_business_id, null, p_actor, 'coupon.saved',
    'coupon', v_id::text, null, jsonb_build_object('code', v_code));
  return v_id;
end;
$$;

-- ── 10. RPCs: points ledger and rewards ─────────────────────────────────────

-- Manual correction by a manager. Idempotent on client_ref. Refused if it would
-- take the balance below zero.
create or replace function public.loyalty_points_adjust(
  p_actor uuid,
  p_business_id uuid,
  p_customer_id uuid,
  p_points integer,
  p_reason text,
  p_client_ref text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ref text := trim(coalesce(p_client_ref, ''));
  v_reason text := trim(coalesce(p_reason, ''));
  v_existing uuid;
  v_tx uuid;
begin
  if not public.actor_has_permission(p_actor, p_business_id, 'customers.manage') then
    raise exception 'Your role does not allow this action (customers.manage).' using errcode = '42501';
  end if;
  if char_length(v_ref) not between 1 and 80 then
    raise exception 'A client reference is required.' using errcode = 'P0001';
  end if;
  if char_length(v_reason) not between 3 and 200 then
    raise exception 'Give a reason of 3 to 200 characters.' using errcode = 'P0001';
  end if;
  if p_points is null or p_points = 0 or p_points not between -1000000 and 1000000 then
    raise exception 'Enter a non-zero number of points between -1,000,000 and 1,000,000.' using errcode = 'P0001';
  end if;

  select t.id into v_existing from public.loyalty_transactions t
  where t.business_id = p_business_id and t.client_ref = v_ref;
  if v_existing is not null then
    return jsonb_build_object('duplicate', true, 'transaction_id', v_existing);
  end if;

  perform 1 from public.customers c where c.id = p_customer_id and c.business_id = p_business_id;
  if not found then raise exception 'Customer not found.' using errcode = 'P0001'; end if;

  insert into public.loyalty_transactions (
    business_id, customer_id, kind, points, reason, client_ref, created_by
  ) values (
    p_business_id, p_customer_id, 'adjust', p_points, v_reason, v_ref, p_actor
  ) returning id into v_tx;

  perform public.write_audit_log(p_business_id, null, p_actor, 'loyalty.points_adjusted',
    'customer', p_customer_id::text, null, jsonb_build_object('points', p_points, 'reason', v_reason));
  return jsonb_build_object('duplicate', false, 'transaction_id', v_tx);
end;
$$;

-- Turns points into a voucher. Idempotent on client_ref, so a double tap cannot
-- redeem twice. Each redemption is a new voucher, and a voucher is single-use.
create or replace function public.reward_redeem(
  p_actor uuid,
  p_business_id uuid,
  p_customer_id uuid,
  p_reward_id uuid,
  p_client_ref text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ref text := trim(coalesce(p_client_ref, ''));
  v_reward public.loyalty_rewards;
  v_balance integer;
  v_existing uuid;
  v_voucher uuid;
begin
  if not public.actor_has_permission(p_actor, p_business_id, 'discounts.apply') then
    raise exception 'Your role does not allow this action (discounts.apply).' using errcode = '42501';
  end if;
  if char_length(v_ref) not between 1 and 80 then
    raise exception 'A client reference is required.' using errcode = 'P0001';
  end if;

  select t.voucher_id into v_existing from public.loyalty_transactions t
  where t.business_id = p_business_id and t.client_ref = v_ref and t.kind = 'redeem';
  if v_existing is not null then
    return jsonb_build_object('duplicate', true, 'voucher_id', v_existing);
  end if;

  perform 1 from public.customers c where c.id = p_customer_id and c.business_id = p_business_id;
  if not found then raise exception 'Customer not found.' using errcode = 'P0001'; end if;

  select * into v_reward from public.loyalty_rewards r
  where r.id = p_reward_id and r.business_id = p_business_id and r.active;
  if not found then raise exception 'This reward is not available.' using errcode = 'P0001'; end if;

  select a.balance into v_balance from public.loyalty_accounts a
  where a.customer_id = p_customer_id for update;
  if coalesce(v_balance, 0) < v_reward.points_cost then
    raise exception 'Not enough points for this reward.' using errcode = 'P0001';
  end if;

  insert into public.customer_vouchers (
    business_id, customer_id, reward_id, name, points_spent,
    discount_type, discount_value, max_discount_minor, created_by
  ) values (
    p_business_id, p_customer_id, v_reward.id, v_reward.name, v_reward.points_cost,
    v_reward.discount_type, v_reward.discount_value, v_reward.max_discount_minor, p_actor
  ) returning id into v_voucher;

  insert into public.loyalty_transactions (
    business_id, customer_id, kind, points, voucher_id, reason, client_ref, created_by
  ) values (
    p_business_id, p_customer_id, 'redeem', -v_reward.points_cost, v_voucher,
    'Redeemed: ' || v_reward.name, v_ref, p_actor
  );

  perform public.write_audit_log(p_business_id, null, p_actor, 'reward.redeemed',
    'customer', p_customer_id::text, null,
    jsonb_build_object('reward', v_reward.name, 'points', v_reward.points_cost));
  return jsonb_build_object('duplicate', false, 'voucher_id', v_voucher);
end;
$$;

-- ── 11. RPCs: applying promotions to an order ───────────────────────────────

-- Locks the order and checks who may change its promotion: orders.manage at the
-- outlet and discounts.apply in the business. The order must be open or held,
-- unpaid, and not invoiced.
create or replace function public.promotion_order_guard(p_actor uuid, p_order_id uuid)
returns public.orders
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order public.orders;
begin
  select o.* into v_order from public.orders o where o.id = p_order_id for update;
  if not found then raise exception 'Order not found.' using errcode = 'P0001'; end if;

  perform public.require_outlet_permission(p_actor, v_order.outlet_id, 'orders.manage');
  if not public.actor_has_permission(p_actor, v_order.business_id, 'discounts.apply') then
    raise exception 'Your role does not allow this action (discounts.apply).' using errcode = '42501';
  end if;
  if v_order.status not in ('open', 'held') then
    raise exception 'Promotions can only change on open or held orders.' using errcode = 'P0001';
  end if;
  if v_order.paid_minor > 0 then
    raise exception 'Refund recorded payments before changing promotions.' using errcode = 'P0001';
  end if;
  if v_order.billed_at is not null then
    raise exception 'Void the invoice before changing promotions.' using errcode = 'P0001';
  end if;
  return v_order;
end;
$$;

revoke all on function public.promotion_order_guard(uuid, uuid) from public, anon, authenticated, service_role;

create or replace function public.order_apply_coupon(p_actor uuid, p_order_id uuid, p_code text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order public.orders;
  v_coupon public.coupons;
  v_code text := upper(trim(coalesce(p_code, '')));
  v_today date := public.business_today();
  v_used integer;
  v_customer_used integer;
  v_amount bigint;
begin
  v_order := public.promotion_order_guard(p_actor, p_order_id);

  if exists (select 1 from public.order_promotions op where op.order_id = p_order_id) then
    raise exception 'This order already has a coupon or reward. Remove it first.' using errcode = 'P0001';
  end if;

  select c.* into v_coupon from public.coupons c
  where c.business_id = v_order.business_id and c.code = v_code
  for update;
  if not found then raise exception 'That coupon code does not exist.' using errcode = 'P0001'; end if;
  if not v_coupon.active then raise exception 'This coupon is not active.' using errcode = 'P0001'; end if;
  if (v_coupon.starts_on is not null and v_today < v_coupon.starts_on)
     or (v_coupon.ends_on is not null and v_today > v_coupon.ends_on) then
    raise exception 'This coupon is not valid today.' using errcode = 'P0001';
  end if;
  if v_order.subtotal_minor < v_coupon.min_subtotal_minor then
    raise exception 'This order is below the coupon minimum of ₹%.', public.money_text(v_coupon.min_subtotal_minor)
      using errcode = 'P0001';
  end if;
  if v_coupon.per_customer_limit is not null and v_order.customer_id is null then
    raise exception 'Link a customer to this order to use this coupon.' using errcode = 'P0001';
  end if;

  if v_coupon.usage_limit is not null then
    select (select count(*) from public.coupon_redemptions cr where cr.coupon_id = v_coupon.id)
         + (select count(*) from public.order_promotions op where op.coupon_id = v_coupon.id)
      into v_used;
    if v_used >= v_coupon.usage_limit then
      raise exception 'This coupon has been fully used.' using errcode = 'P0001';
    end if;
  end if;

  if v_coupon.per_customer_limit is not null then
    select (select count(*) from public.coupon_redemptions cr
             where cr.coupon_id = v_coupon.id and cr.customer_id = v_order.customer_id)
         + (select count(*) from public.order_promotions op
             join public.orders o on o.id = op.order_id
             where op.coupon_id = v_coupon.id and o.customer_id = v_order.customer_id)
      into v_customer_used;
    if v_customer_used >= v_coupon.per_customer_limit then
      raise exception 'This customer has already used this coupon.' using errcode = 'P0001';
    end if;
  end if;

  v_amount := public.promo_amount(
    v_order.subtotal_minor,
    v_order.subtotal_minor - v_order.discount_minor,
    v_coupon.discount_type, v_coupon.discount_value, v_coupon.max_discount_minor, v_coupon.min_subtotal_minor
  );
  if v_amount <= 0 then
    raise exception 'This coupon gives no discount on this order.' using errcode = 'P0001';
  end if;

  insert into public.order_promotions (
    business_id, order_id, kind, coupon_id, label, discount_type, discount_value,
    max_discount_minor, min_subtotal_minor, amount_minor, created_by
  ) values (
    v_order.business_id, p_order_id, 'coupon', v_coupon.id, v_coupon.code, v_coupon.discount_type,
    v_coupon.discount_value, v_coupon.max_discount_minor, v_coupon.min_subtotal_minor, v_amount, p_actor
  );

  perform public.pos_apply_totals(
    p_order_id, v_order.business_id, v_order.subtotal_minor,
    jsonb_build_object('type', v_order.discount_type, 'value', v_order.discount_value),
    v_order.charges
  );

  perform public.write_audit_log(v_order.business_id, v_order.outlet_id, p_actor, 'order.coupon_applied',
    'order', p_order_id::text, null, jsonb_build_object('code', v_coupon.code, 'amount_minor', v_amount));
  return jsonb_build_object('label', v_coupon.code, 'amount_minor', v_amount);
end;
$$;

create or replace function public.order_apply_reward(p_actor uuid, p_order_id uuid, p_voucher_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order public.orders;
  v_voucher public.customer_vouchers;
  v_amount bigint;
begin
  v_order := public.promotion_order_guard(p_actor, p_order_id);

  if exists (select 1 from public.order_promotions op where op.order_id = p_order_id) then
    raise exception 'This order already has a coupon or reward. Remove it first.' using errcode = 'P0001';
  end if;

  select v.* into v_voucher from public.customer_vouchers v
  where v.id = p_voucher_id and v.business_id = v_order.business_id
  for update;
  if not found then raise exception 'This reward does not exist.' using errcode = 'P0001'; end if;
  if v_order.customer_id is null then
    raise exception 'Link the customer to this order before applying a reward.' using errcode = 'P0001';
  end if;
  if v_voucher.customer_id <> v_order.customer_id then
    raise exception 'This reward belongs to another customer.' using errcode = 'P0001';
  end if;
  if v_voucher.status <> 'issued' then
    raise exception 'This reward has already been used or is on another order.' using errcode = 'P0001';
  end if;

  v_amount := public.promo_amount(
    v_order.subtotal_minor,
    v_order.subtotal_minor - v_order.discount_minor,
    v_voucher.discount_type, v_voucher.discount_value, v_voucher.max_discount_minor, 0
  );
  if v_amount <= 0 then
    raise exception 'This reward gives no discount on this order.' using errcode = 'P0001';
  end if;

  insert into public.order_promotions (
    business_id, order_id, kind, voucher_id, label, discount_type, discount_value,
    max_discount_minor, min_subtotal_minor, amount_minor, created_by
  ) values (
    v_order.business_id, p_order_id, 'reward', v_voucher.id, v_voucher.name, v_voucher.discount_type,
    v_voucher.discount_value, v_voucher.max_discount_minor, 0, v_amount, p_actor
  );

  update public.customer_vouchers
     set status = 'applied', order_id = p_order_id, updated_at = now()
   where id = v_voucher.id;

  perform public.pos_apply_totals(
    p_order_id, v_order.business_id, v_order.subtotal_minor,
    jsonb_build_object('type', v_order.discount_type, 'value', v_order.discount_value),
    v_order.charges
  );

  perform public.write_audit_log(v_order.business_id, v_order.outlet_id, p_actor, 'order.reward_applied',
    'order', p_order_id::text, null, jsonb_build_object('reward', v_voucher.name, 'amount_minor', v_amount));
  return jsonb_build_object('label', v_voucher.name, 'amount_minor', v_amount);
end;
$$;

create or replace function public.order_remove_promotion(p_actor uuid, p_order_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order public.orders;
  v_promo public.order_promotions;
begin
  v_order := public.promotion_order_guard(p_actor, p_order_id);

  select op.* into v_promo from public.order_promotions op where op.order_id = p_order_id;
  if not found then raise exception 'This order has no coupon or reward.' using errcode = 'P0001'; end if;

  delete from public.order_promotions where id = v_promo.id;
  if v_promo.voucher_id is not null then
    update public.customer_vouchers
       set status = 'issued', order_id = null, updated_at = now()
     where id = v_promo.voucher_id;
  end if;

  perform public.pos_apply_totals(
    p_order_id, v_order.business_id, v_order.subtotal_minor,
    jsonb_build_object('type', v_order.discount_type, 'value', v_order.discount_value),
    v_order.charges
  );

  perform public.write_audit_log(v_order.business_id, v_order.outlet_id, p_actor, 'order.promotion_removed',
    'order', p_order_id::text, null, jsonb_build_object('label', v_promo.label));
end;
$$;

-- ── 12. reconciliation ──────────────────────────────────────────────────────
-- Counts disagreements between the derived balances and the ledgers. Every
-- count should be zero. A superuser who edits a balance directly is caught here.

create or replace function public.crm_reconcile(p_actor uuid, p_business_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_balance_mismatch integer;
  v_coupon_mismatch integer;
  v_voucher_mismatch integer;
begin
  if not public.actor_has_permission(p_actor, p_business_id, 'customers.manage') then
    raise exception 'Your role does not allow this action (customers.manage).' using errcode = '42501';
  end if;

  select count(*) into v_balance_mismatch
  from public.loyalty_accounts a
  where a.business_id = p_business_id
    and a.balance <> (select coalesce(sum(t.points), 0) from public.loyalty_transactions t
                      where t.customer_id = a.customer_id);

  -- a completed order with a coupon must have one redemption, and each redemption must match a coupon on its order
  select (select count(*) from public.order_promotions op
           join public.orders o on o.id = op.order_id
           where op.business_id = p_business_id and op.kind = 'coupon' and o.status = 'completed'
             and not exists (select 1 from public.coupon_redemptions cr where cr.order_id = o.id))
       + (select count(*) from public.coupon_redemptions cr
           where cr.business_id = p_business_id
             and not exists (select 1 from public.order_promotions op
                             where op.order_id = cr.order_id and op.kind = 'coupon'))
    into v_coupon_mismatch;

  -- voucher status must match where the voucher is
  select count(*) into v_voucher_mismatch
  from public.customer_vouchers v
  where v.business_id = p_business_id
    and not (
      (v.status = 'issued' and not exists (select 1 from public.order_promotions op where op.voucher_id = v.id))
      or (v.status = 'applied' and exists (
            select 1 from public.order_promotions op join public.orders o on o.id = op.order_id
            where op.voucher_id = v.id and o.status in ('open', 'held')))
      or (v.status = 'used' and exists (
            select 1 from public.order_promotions op join public.orders o on o.id = op.order_id
            where op.voucher_id = v.id and o.status = 'completed'))
    );

  return jsonb_build_object(
    'balance_mismatches', v_balance_mismatch,
    'coupon_mismatches', v_coupon_mismatch,
    'voucher_mismatches', v_voucher_mismatch,
    'ok', v_balance_mismatch = 0 and v_coupon_mismatch = 0 and v_voucher_mismatch = 0
  );
end;
$$;

-- ── 13. row-level security and grants ───────────────────────────────────────

alter table public.customers enable row level security;
alter table public.customer_addresses enable row level security;
alter table public.loyalty_settings enable row level security;
alter table public.loyalty_rewards enable row level security;
alter table public.customer_vouchers enable row level security;
alter table public.loyalty_accounts enable row level security;
alter table public.loyalty_transactions enable row level security;
alter table public.coupons enable row level security;
alter table public.order_promotions enable row level security;
alter table public.coupon_redemptions enable row level security;

create policy customers_read on public.customers for select
  using (public.has_business_permission(business_id, 'customers.view'));
create policy customer_addresses_read on public.customer_addresses for select
  using (public.has_business_permission(business_id, 'customers.view'));
create policy loyalty_settings_read on public.loyalty_settings for select
  using (public.has_business_permission(business_id, 'customers.view'));
create policy loyalty_rewards_read on public.loyalty_rewards for select
  using (public.has_business_permission(business_id, 'customers.view'));
create policy customer_vouchers_read on public.customer_vouchers for select
  using (public.has_business_permission(business_id, 'customers.view'));
create policy loyalty_accounts_read on public.loyalty_accounts for select
  using (public.has_business_permission(business_id, 'customers.view'));
create policy loyalty_transactions_read on public.loyalty_transactions for select
  using (public.has_business_permission(business_id, 'customers.view'));
create policy coupons_read on public.coupons for select
  using (public.has_business_permission(business_id, 'customers.view'));
create policy coupon_redemptions_read on public.coupon_redemptions for select
  using (public.has_business_permission(business_id, 'customers.view'));
create policy order_promotions_read on public.order_promotions for select
  using (exists (
    select 1 from public.orders o
    where o.id = order_id and public.has_outlet_permission(o.outlet_id, 'orders.view')
  ));

grant select on public.customers, public.customer_addresses, public.loyalty_settings,
  public.loyalty_rewards, public.customer_vouchers, public.loyalty_accounts,
  public.loyalty_transactions, public.coupons, public.order_promotions,
  public.coupon_redemptions to authenticated;

revoke all on function public.customer_save(uuid, uuid, uuid, text, text, text, text)
  from public, anon, authenticated;
grant execute on function public.customer_save(uuid, uuid, uuid, text, text, text, text) to service_role;

revoke all on function public.customer_address_save(uuid, uuid, uuid, uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.customer_address_save(uuid, uuid, uuid, uuid, text, text) to service_role;

revoke all on function public.customer_address_delete(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.customer_address_delete(uuid, uuid, uuid) to service_role;

revoke all on function public.loyalty_settings_save(uuid, uuid, boolean, bigint) from public, anon, authenticated;
grant execute on function public.loyalty_settings_save(uuid, uuid, boolean, bigint) to service_role;

revoke all on function public.loyalty_reward_save(uuid, uuid, uuid, text, integer, text, bigint, bigint, boolean)
  from public, anon, authenticated;
grant execute on function public.loyalty_reward_save(uuid, uuid, uuid, text, integer, text, bigint, bigint, boolean)
  to service_role;

revoke all on function public.coupon_save(uuid, uuid, uuid, text, text, text, bigint, bigint, bigint, date, date, integer, integer, boolean)
  from public, anon, authenticated;
grant execute on function public.coupon_save(uuid, uuid, uuid, text, text, text, bigint, bigint, bigint, date, date, integer, integer, boolean)
  to service_role;

revoke all on function public.loyalty_points_adjust(uuid, uuid, uuid, integer, text, text)
  from public, anon, authenticated;
grant execute on function public.loyalty_points_adjust(uuid, uuid, uuid, integer, text, text) to service_role;

revoke all on function public.reward_redeem(uuid, uuid, uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.reward_redeem(uuid, uuid, uuid, uuid, text) to service_role;

revoke all on function public.order_apply_coupon(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.order_apply_coupon(uuid, uuid, text) to service_role;

revoke all on function public.order_apply_reward(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.order_apply_reward(uuid, uuid, uuid) to service_role;

revoke all on function public.order_remove_promotion(uuid, uuid) from public, anon, authenticated;
grant execute on function public.order_remove_promotion(uuid, uuid) to service_role;

revoke all on function public.crm_reconcile(uuid, uuid) from public, anon, authenticated;
grant execute on function public.crm_reconcile(uuid, uuid) to service_role;
