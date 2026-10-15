-- ─────────────────────────────────────────────────────────────────────────
-- Phase 16 — reports. Read-only aggregates over the real transaction tables.
--
-- Conventions (documented in docs/REPORTS.md):
--   * Business day is Asia/Kolkata, the same rule as business_today().
--   * Sales, revenue, tax, discounts and food cost use the day an order was
--     COMPLETED (order_status_history, to_status = 'completed').
--   * Refunds and payments use the day they were RECORDED (cash basis).
--     Revenue is therefore billed on orders completed in the period, less
--     refunds recorded in the period.
--   * Tax refunded is the refund's pro-rata share of the order's tax:
--     round(refund × order tax ÷ order total).
--   * Every function checks reports.view, plus the extra permission its data
--     needs, and limits outlets to what the caller can access.
--   * Each function returns jsonb { total, rows, summary }. total counts the
--     rows before pagination; summary covers every row in the window.
-- ─────────────────────────────────────────────────────────────────────────

-- ── helpers ─────────────────────────────────────────────────────────────

create or replace function public.report_day(p_ts timestamptz)
returns date
language sql
immutable
set search_path = public
as $$
  select (p_ts at time zone 'Asia/Kolkata')::date;
$$;

-- Midnight at the start of a business day, as an instant. Used for index-friendly bounds.
create or replace function public.report_start(p_day date)
returns timestamptz
language sql
immutable
set search_path = public
as $$
  select (p_day::timestamp at time zone 'Asia/Kolkata');
$$;

create or replace function public.report_period(p_day date, p_grain text)
returns date
language sql
immutable
set search_path = public
as $$
  select case coalesce(p_grain, 'day')
    when 'week' then date_trunc('week', p_day::timestamp)::date
    when 'month' then date_trunc('month', p_day::timestamp)::date
    else p_day
  end;
$$;

create or replace function public.report_period_end(p_start date, p_grain text)
returns date
language sql
immutable
set search_path = public
as $$
  select case coalesce(p_grain, 'day')
    when 'week' then p_start + 6
    when 'month' then (date_trunc('month', p_start::timestamp) + interval '1 month - 1 day')::date
    else p_start
  end;
$$;

create or replace function public.report_guard(
  p_from date,
  p_to date,
  p_grain text,
  p_limit integer,
  p_offset integer
)
returns void
language plpgsql
immutable
set search_path = public
as $$
begin
  if p_from is null or p_to is null or p_to < p_from then
    raise exception 'Choose a valid date range.' using errcode = 'P0001';
  end if;
  if p_to - p_from > 400 then
    raise exception 'Choose a date range of 400 days or less.' using errcode = 'P0001';
  end if;
  if coalesce(p_grain, 'day') not in ('day', 'week', 'month') then
    raise exception 'Choose day, week or month.' using errcode = 'P0001';
  end if;
  if p_limit is null or p_limit < 1 or p_limit > 20000 then
    raise exception 'Page size must be between 1 and 20000.' using errcode = 'P0001';
  end if;
  if p_offset is null or p_offset < 0 then
    raise exception 'Offset cannot be negative.' using errcode = 'P0001';
  end if;
end;
$$;

create or replace function public.report_user_name(p_user uuid)
returns text
language sql
stable
set search_path = public
as $$
  select coalesce(
    (select nullif(trim(up.full_name), '') from public.user_profiles up where up.id = p_user),
    (select up.email::text from public.user_profiles up where up.id = p_user),
    'Unknown user'
  );
$$;

-- Checks reports.view, plus an extra permission when the report needs one. Returns the
-- outlets the caller may see, narrowed to p_outlet_ids when given.
create or replace function public.report_access(
  p_actor uuid,
  p_business_id uuid,
  p_outlet_ids uuid[],
  p_extra text
)
returns uuid[]
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_role text;
  v_ids uuid[];
begin
  if p_actor is null then
    raise exception 'Sign in to view reports.' using errcode = '42501';
  end if;
  if not public.actor_has_permission(p_actor, p_business_id, 'reports.view') then
    raise exception 'Your role does not allow this action (reports.view).' using errcode = '42501';
  end if;
  if p_extra is not null and not public.actor_has_permission(p_actor, p_business_id, p_extra) then
    raise exception 'Your role does not allow this action (%).', p_extra using errcode = '42501';
  end if;

  select m.role into v_role
  from public.memberships m
  where m.user_id = p_actor and m.business_id = p_business_id and m.status = 'active'
  limit 1;
  if v_role is null then
    raise exception 'Your role does not allow this action (reports.view).' using errcode = '42501';
  end if;

  if v_role in ('owner', 'business_admin') then
    select coalesce(array_agg(o.id), '{}') into v_ids
    from public.outlets o where o.business_id = p_business_id;
  else
    select coalesce(array_agg(distinct mo.outlet_id), '{}') into v_ids
    from public.memberships m
    join public.membership_outlets mo on mo.membership_id = m.id
    where m.user_id = p_actor and m.business_id = p_business_id and m.status = 'active';
  end if;

  if p_outlet_ids is not null and cardinality(p_outlet_ids) > 0 then
    select coalesce(array_agg(x), '{}') into v_ids
    from unnest(v_ids) as x
    where x = any(p_outlet_ids);
  end if;
  return v_ids;
end;
$$;

-- First completed order per customer, across all outlets. Decides new vs returning.
create or replace function public.report_customer_first_day(p_business_id uuid)
returns table (customer_id uuid, first_day date)
language sql
stable
security definer
set search_path = public
as $$
  select o.customer_id, min(public.report_day(h.created_at))
  from public.order_status_history h
  join public.orders o on o.id = h.order_id
  where o.business_id = p_business_id
    and o.status = 'completed'
    and h.to_status = 'completed'
    and o.customer_id is not null
  group by o.customer_id;
$$;

-- Orders completed in the window, one row per order.
create or replace function public.report_orders(
  p_business_id uuid,
  p_outlets uuid[],
  p_from date,
  p_to date
)
returns table (
  order_id uuid,
  outlet_id uuid,
  order_number integer,
  order_type text,
  created_by uuid,
  created_day date,
  completed_by uuid,
  completed_day date,
  customer_id uuid,
  subtotal_minor bigint,
  discount_minor bigint,
  promotion_minor bigint,
  tax_minor bigint,
  charges_minor bigint,
  total_minor bigint,
  refunded_minor bigint
)
language sql
stable
security definer
set search_path = public
as $$
  with done as (
    select distinct on (h.order_id) h.order_id, h.created_at as completed_at, h.changed_by
    from public.order_status_history h
    where h.to_status = 'completed'
      and h.created_at >= public.report_start(p_from)
      and h.created_at < public.report_start(p_to + 1)
    order by h.order_id, h.created_at
  )
  select o.id, o.outlet_id, o.order_number, o.order_type, o.created_by,
         public.report_day(o.created_at),
         d.changed_by, public.report_day(d.completed_at), o.customer_id,
         o.subtotal_minor, o.discount_minor, o.promotion_minor, o.tax_minor,
         o.charges_minor, o.total_minor, o.refunded_minor
  from done d
  join public.orders o on o.id = d.order_id
  where o.business_id = p_business_id
    and o.status = 'completed'
    and o.outlet_id = any(p_outlets);
$$;

-- Succeeded refunds recorded in the window, with the order and method they belong to.
create or replace function public.report_refund_rows(
  p_business_id uuid,
  p_outlets uuid[],
  p_from date,
  p_to date
)
returns table (
  refund_id uuid,
  order_id uuid,
  outlet_id uuid,
  order_number integer,
  customer_id uuid,
  payment_id uuid,
  method_key text,
  method_kind text,
  method_label text,
  amount_minor bigint,
  tax_minor bigint,
  reason text,
  created_by uuid,
  created_at timestamptz,
  created_day date
)
language sql
stable
security definer
set search_path = public
as $$
  select r.id, r.order_id, r.outlet_id, o.order_number, o.customer_id,
         r.payment_id, p.method_key, p.method_kind, coalesce(pm.label, p.method_key),
         r.amount_minor,
         case when o.total_minor > 0
              then round(r.amount_minor::numeric * o.tax_minor / o.total_minor)::bigint
              else 0::bigint end,
         r.reason, r.created_by, r.created_at, public.report_day(r.created_at)
  from public.refunds r
  join public.payments p on p.id = r.payment_id
  join public.orders o on o.id = r.order_id
  left join public.payment_methods pm on pm.business_id = r.business_id and pm.key = p.method_key
  where r.business_id = p_business_id
    and r.status = 'succeeded'
    and r.outlet_id = any(p_outlets)
    and r.created_at >= public.report_start(p_from)
    and r.created_at < public.report_start(p_to + 1);
$$;

-- Captured payments recorded in the window.
create or replace function public.report_payment_rows(
  p_business_id uuid,
  p_outlets uuid[],
  p_from date,
  p_to date
)
returns table (
  payment_id uuid,
  order_id uuid,
  outlet_id uuid,
  method_key text,
  method_kind text,
  method_label text,
  amount_minor bigint,
  created_by uuid,
  created_at timestamptz,
  created_day date
)
language sql
stable
security definer
set search_path = public
as $$
  select p.id, p.order_id, p.outlet_id, p.method_key, p.method_kind,
         coalesce(pm.label, p.method_key), p.amount_minor, p.created_by,
         p.created_at, public.report_day(p.created_at)
  from public.payments p
  left join public.payment_methods pm on pm.business_id = p.business_id and pm.key = p.method_key
  where p.business_id = p_business_id
    and p.status = 'captured'
    and p.outlet_id = any(p_outlets)
    and p.created_at >= public.report_start(p_from)
    and p.created_at < public.report_start(p_to + 1);
$$;

-- ── sales, revenue and financial periods ────────────────────────────────

-- Revenue by period. Sales (daily, weekly, monthly) and Revenue both read this.
create or replace function public.report_revenue_periods(
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
  v_grain text := coalesce(nullif(p_grain, ''), 'day');
  v_outlets uuid[];
begin
  perform public.report_guard(p_from, p_to, v_grain, p_limit, p_offset);
  v_outlets := public.report_access(p_actor, p_business_id, p_outlet_ids, null);

  return (
    with sales as (
      select public.report_period(o.completed_day, v_grain) as period_start,
             count(*) as orders,
             sum(o.subtotal_minor) as gross_minor,
             sum(o.discount_minor) as discount_minor,
             sum(o.tax_minor) as tax_minor,
             sum(o.charges_minor) as charges_minor,
             sum(o.total_minor) as billed_minor
      from public.report_orders(p_business_id, v_outlets, p_from, p_to) o
      group by 1
    ),
    refunds as (
      select public.report_period(r.created_day, v_grain) as period_start,
             sum(r.amount_minor) as refunds_minor
      from public.report_refund_rows(p_business_id, v_outlets, p_from, p_to) r
      group by 1
    ),
    periods as (
      select s.period_start from sales s
      union
      select f.period_start from refunds f
    ),
    result_rows as (
      select p.period_start,
             public.report_period_end(p.period_start, v_grain) as period_end,
             coalesce(s.orders, 0) as orders,
             coalesce(s.gross_minor, 0) as gross_minor,
             coalesce(s.discount_minor, 0) as discount_minor,
             coalesce(s.gross_minor, 0) - coalesce(s.discount_minor, 0) as net_sales_minor,
             coalesce(s.tax_minor, 0) as tax_minor,
             coalesce(s.charges_minor, 0) as charges_minor,
             coalesce(s.billed_minor, 0) as billed_minor,
             coalesce(f.refunds_minor, 0) as refunds_minor,
             coalesce(s.billed_minor, 0) - coalesce(f.refunds_minor, 0) as net_revenue_minor,
             case when coalesce(s.orders, 0) > 0
                  then round(coalesce(s.billed_minor, 0)::numeric / s.orders)
                  else 0 end as avg_order_minor
      from periods p
      left join sales s on s.period_start = p.period_start
      left join refunds f on f.period_start = p.period_start
    )
    select jsonb_build_object(
      'total', (select count(*) from result_rows),
      'rows', (select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb)
               from (select * from result_rows order by period_start desc limit p_limit offset p_offset) t),
      'summary', (select jsonb_build_object(
                    'orders', coalesce(sum(orders), 0),
                    'gross_minor', coalesce(sum(gross_minor), 0),
                    'discount_minor', coalesce(sum(discount_minor), 0),
                    'net_sales_minor', coalesce(sum(net_sales_minor), 0),
                    'tax_minor', coalesce(sum(tax_minor), 0),
                    'charges_minor', coalesce(sum(charges_minor), 0),
                    'billed_minor', coalesce(sum(billed_minor), 0),
                    'refunds_minor', coalesce(sum(refunds_minor), 0),
                    'net_revenue_minor', coalesce(sum(net_revenue_minor), 0))
                  from result_rows)
    )
  );
end;
$$;

create or replace function public.report_tax_periods(
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
  v_grain text := coalesce(nullif(p_grain, ''), 'day');
  v_outlets uuid[];
begin
  perform public.report_guard(p_from, p_to, v_grain, p_limit, p_offset);
  v_outlets := public.report_access(p_actor, p_business_id, p_outlet_ids, null);

  return (
    with sales as (
      select public.report_period(o.completed_day, v_grain) as period_start,
             count(*) as orders,
             sum(o.subtotal_minor - o.discount_minor) as taxable_minor,
             sum(o.tax_minor) as tax_billed_minor
      from public.report_orders(p_business_id, v_outlets, p_from, p_to) o
      group by 1
    ),
    refunds as (
      select public.report_period(r.created_day, v_grain) as period_start,
             sum(r.tax_minor) as tax_refunded_minor
      from public.report_refund_rows(p_business_id, v_outlets, p_from, p_to) r
      group by 1
    ),
    periods as (
      select s.period_start from sales s
      union
      select f.period_start from refunds f
    ),
    result_rows as (
      select p.period_start,
             public.report_period_end(p.period_start, v_grain) as period_end,
             coalesce(s.orders, 0) as orders,
             coalesce(s.taxable_minor, 0) as taxable_minor,
             coalesce(s.tax_billed_minor, 0) as tax_billed_minor,
             coalesce(f.tax_refunded_minor, 0) as tax_refunded_minor,
             coalesce(s.tax_billed_minor, 0) - coalesce(f.tax_refunded_minor, 0) as net_tax_minor
      from periods p
      left join sales s on s.period_start = p.period_start
      left join refunds f on f.period_start = p.period_start
    )
    select jsonb_build_object(
      'total', (select count(*) from result_rows),
      'rows', (select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb)
               from (select * from result_rows order by period_start desc limit p_limit offset p_offset) t),
      'summary', (select jsonb_build_object(
                    'orders', coalesce(sum(orders), 0),
                    'taxable_minor', coalesce(sum(taxable_minor), 0),
                    'tax_billed_minor', coalesce(sum(tax_billed_minor), 0),
                    'tax_refunded_minor', coalesce(sum(tax_refunded_minor), 0),
                    'net_tax_minor', coalesce(sum(net_tax_minor), 0))
                  from result_rows)
    )
  );
end;
$$;

create or replace function public.report_discount_periods(
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
  v_grain text := coalesce(nullif(p_grain, ''), 'day');
  v_outlets uuid[];
begin
  perform public.report_guard(p_from, p_to, v_grain, p_limit, p_offset);
  v_outlets := public.report_access(p_actor, p_business_id, p_outlet_ids, null);

  return (
    with sales as (
      select public.report_period(o.completed_day, v_grain) as period_start,
             count(*) as orders,
             count(*) filter (where o.discount_minor > 0) as discounted_orders,
             sum(o.subtotal_minor) as gross_minor,
             sum(o.discount_minor) as discount_minor,
             sum(o.promotion_minor) as promotion_minor
      from public.report_orders(p_business_id, v_outlets, p_from, p_to) o
      group by 1
    ),
    result_rows as (
      select s.period_start,
             public.report_period_end(s.period_start, v_grain) as period_end,
             s.orders,
             s.discounted_orders,
             s.gross_minor,
             s.discount_minor - s.promotion_minor as manual_minor,
             s.promotion_minor,
             s.discount_minor as total_discount_minor,
             case when s.gross_minor > 0 then round(100.0 * s.discount_minor / s.gross_minor, 2) else 0 end as discount_pct
      from sales s
    )
    select jsonb_build_object(
      'total', (select count(*) from result_rows),
      'rows', (select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb)
               from (select * from result_rows order by period_start desc limit p_limit offset p_offset) t),
      'summary', (select jsonb_build_object(
                    'orders', coalesce(sum(orders), 0),
                    'discounted_orders', coalesce(sum(discounted_orders), 0),
                    'gross_minor', coalesce(sum(gross_minor), 0),
                    'manual_minor', coalesce(sum(manual_minor), 0),
                    'promotion_minor', coalesce(sum(promotion_minor), 0),
                    'total_discount_minor', coalesce(sum(total_discount_minor), 0),
                    'discount_pct', case when coalesce(sum(gross_minor), 0) > 0
                                         then round(100.0 * sum(total_discount_minor) / sum(gross_minor), 2)
                                         else 0 end)
                  from result_rows)
    )
  );
end;
$$;

-- Refunds recorded in the window, newest first.
create or replace function public.report_refunds_list(
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
    with refunds as (
      select rr.refund_id, rr.order_id, rr.order_number, rr.created_at, rr.method_label, rr.method_kind,
             rr.amount_minor, rr.tax_minor, rr.reason, public.report_user_name(rr.created_by) as processed_by
      from public.report_refund_rows(p_business_id, v_outlets, p_from, p_to) rr
      where p_search is null or p_search = ''
         or rr.order_number::text ilike '%' || p_search || '%'
         or rr.reason ilike '%' || p_search || '%'
         or rr.method_label ilike '%' || p_search || '%'
    )
    select jsonb_build_object(
      'total', (select count(*) from refunds),
      'rows', (select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb)
               from (select * from refunds order by created_at desc, refund_id limit p_limit offset p_offset) t),
      'summary', (select jsonb_build_object(
                    'refunds', count(*),
                    'amount_minor', coalesce(sum(amount_minor), 0),
                    'tax_minor', coalesce(sum(tax_minor), 0))
                  from refunds)
    )
  );
end;
$$;

-- Collections and refunds per payment method. Net = collected − refunded.
create or replace function public.report_payments_by_method(
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
    with pays as (
      select pr.method_key, max(pr.method_label) as method_label, max(pr.method_kind) as method_kind,
             count(*) as payments_count, sum(pr.amount_minor) as collected_minor
      from public.report_payment_rows(p_business_id, v_outlets, p_from, p_to) pr
      group by pr.method_key
    ),
    refs as (
      select rr.method_key, count(*) as refunds_count, sum(rr.amount_minor) as refunded_minor
      from public.report_refund_rows(p_business_id, v_outlets, p_from, p_to) rr
      group by rr.method_key
    ),
    keys as (
      select p.method_key, p.method_label, p.method_kind from pays p
      union
      select r.method_key, pm.label, pm.kind
      from refs r
      left join public.payment_methods pm on pm.business_id = p_business_id and pm.key = r.method_key
    ),
    result_rows as (
      select k.method_key,
             coalesce(k.method_label, k.method_key) as method_label,
             coalesce(k.method_kind, 'other') as method_kind,
             coalesce(p.payments_count, 0) as payments_count,
             coalesce(p.collected_minor, 0) as collected_minor,
             coalesce(r.refunds_count, 0) as refunds_count,
             coalesce(r.refunded_minor, 0) as refunded_minor,
             coalesce(p.collected_minor, 0) - coalesce(r.refunded_minor, 0) as net_minor
      from keys k
      left join pays p on p.method_key = k.method_key
      left join refs r on r.method_key = k.method_key
      where p_search is null or p_search = ''
         or coalesce(k.method_label, k.method_key) ilike '%' || p_search || '%'
    )
    select jsonb_build_object(
      'total', (select count(*) from result_rows),
      'rows', (select coalesce(jsonb_agg(to_jsonb(t) order by t.method_label), '[]'::jsonb)
               from (select * from result_rows order by method_label limit p_limit offset p_offset) t),
      'summary', (select jsonb_build_object(
                    'payments_count', coalesce(sum(payments_count), 0),
                    'collected_minor', coalesce(sum(collected_minor), 0),
                    'refunds_count', coalesce(sum(refunds_count), 0),
                    'refunded_minor', coalesce(sum(refunded_minor), 0),
                    'net_minor', coalesce(sum(net_minor), 0))
                  from result_rows)
    )
  );
end;
$$;

-- ── sales by outlet, product and category ───────────────────────────────

create or replace function public.report_sales_by_outlet(
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
      select o.outlet_id,
             count(*) as orders,
             sum(o.subtotal_minor) as gross_minor,
             sum(o.discount_minor) as discount_minor,
             sum(o.tax_minor) as tax_minor,
             sum(o.total_minor) as billed_minor
      from public.report_orders(p_business_id, v_outlets, p_from, p_to) o
      group by o.outlet_id
    ),
    refunds as (
      select rr.outlet_id, sum(rr.amount_minor) as refunds_minor
      from public.report_refund_rows(p_business_id, v_outlets, p_from, p_to) rr
      group by rr.outlet_id
    ),
    result_rows as (
      select ou.id as outlet_id,
             ou.name as outlet_name,
             coalesce(s.orders, 0) as orders,
             coalesce(s.gross_minor, 0) as gross_minor,
             coalesce(s.discount_minor, 0) as discount_minor,
             coalesce(s.gross_minor, 0) - coalesce(s.discount_minor, 0) as net_sales_minor,
             coalesce(s.tax_minor, 0) as tax_minor,
             coalesce(s.billed_minor, 0) as billed_minor,
             coalesce(f.refunds_minor, 0) as refunds_minor,
             coalesce(s.billed_minor, 0) - coalesce(f.refunds_minor, 0) as net_revenue_minor,
             case when coalesce(s.orders, 0) > 0
                  then round(coalesce(s.billed_minor, 0)::numeric / s.orders) else 0 end as avg_order_minor
      from public.outlets ou
      left join sales s on s.outlet_id = ou.id
      left join refunds f on f.outlet_id = ou.id
      where ou.id = any(v_outlets)
        and (p_search is null or p_search = '' or ou.name ilike '%' || p_search || '%')
    )
    select jsonb_build_object(
      'total', (select count(*) from result_rows),
      'rows', (select coalesce(jsonb_agg(to_jsonb(t) order by t.outlet_name), '[]'::jsonb)
               from (select * from result_rows order by outlet_name limit p_limit offset p_offset) t),
      'summary', (select jsonb_build_object(
                    'orders', coalesce(sum(orders), 0),
                    'gross_minor', coalesce(sum(gross_minor), 0),
                    'discount_minor', coalesce(sum(discount_minor), 0),
                    'net_sales_minor', coalesce(sum(net_sales_minor), 0),
                    'tax_minor', coalesce(sum(tax_minor), 0),
                    'billed_minor', coalesce(sum(billed_minor), 0),
                    'refunds_minor', coalesce(sum(refunds_minor), 0),
                    'net_revenue_minor', coalesce(sum(net_revenue_minor), 0))
                  from result_rows)
    )
  );
end;
$$;

-- Order lines of completed orders in the window, one row per product or combo.
create or replace function public.report_sales_by_product(
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
    with lines as (
      select oi.product_id, oi.combo_id, oi.name, oi.quantity, oi.line_total_minor, oi.order_id
      from public.order_items oi
      join public.report_orders(p_business_id, v_outlets, p_from, p_to) o on o.order_id = oi.order_id
    ),
    grouped as (
      select coalesce(l.product_id, l.combo_id) as item_id,
             case when l.combo_id is not null then 'combo' else 'product' end as item_kind,
             max(l.name) as item_name,
             count(distinct l.order_id) as orders,
             sum(l.quantity) as quantity,
             sum(l.line_total_minor) as gross_minor,
             max(l.product_id::text)::uuid as product_id
      from lines l
      group by 1, 2
    ),
    with_share as (
      select g.item_id, g.item_kind, g.item_name, g.orders, g.quantity, g.gross_minor,
             coalesce(mc.name, case when g.item_kind = 'combo' then 'Combos' else 'Uncategorised' end) as category,
             case when sum(g.gross_minor) over () > 0
                  then round(100.0 * g.gross_minor / sum(g.gross_minor) over (), 2) else 0 end as share_pct
      from grouped g
      left join public.menu_items mi on mi.id = g.product_id and g.item_kind = 'product'
      left join public.menu_categories mc on mc.id = mi.category_id
    ),
    result_rows as (
      select * from with_share ws
      where p_search is null or p_search = ''
         or ws.item_name ilike '%' || p_search || '%'
         or ws.category ilike '%' || p_search || '%'
    )
    select jsonb_build_object(
      'total', (select count(*) from result_rows),
      'rows', (select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb)
               from (select * from result_rows order by gross_minor desc, item_name limit p_limit offset p_offset) t),
      'summary', (select jsonb_build_object(
                    'items', count(*),
                    'quantity', coalesce(sum(quantity), 0),
                    'gross_minor', coalesce(sum(gross_minor), 0))
                  from result_rows)
    )
  );
end;
$$;

create or replace function public.report_sales_by_category(
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
    with lines as (
      select oi.product_id, oi.combo_id, oi.quantity, oi.line_total_minor, oi.order_id,
             coalesce(mc.name, case when oi.combo_id is not null then 'Combos' else 'Uncategorised' end) as category
      from public.order_items oi
      join public.report_orders(p_business_id, v_outlets, p_from, p_to) o on o.order_id = oi.order_id
      left join public.menu_items mi on mi.id = oi.product_id
      left join public.menu_categories mc on mc.id = mi.category_id
    ),
    grouped as (
      select l.category,
             count(distinct coalesce(l.product_id, l.combo_id)) as items,
             count(distinct l.order_id) as orders,
             sum(l.quantity) as quantity,
             sum(l.line_total_minor) as gross_minor
      from lines l
      group by l.category
    ),
    with_share as (
      select g.*,
             case when sum(g.gross_minor) over () > 0
                  then round(100.0 * g.gross_minor / sum(g.gross_minor) over (), 2) else 0 end as share_pct
      from grouped g
    ),
    result_rows as (
      select * from with_share ws
      where p_search is null or p_search = '' or ws.category ilike '%' || p_search || '%'
    )
    select jsonb_build_object(
      'total', (select count(*) from result_rows),
      'rows', (select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb)
               from (select * from result_rows order by gross_minor desc, category limit p_limit offset p_offset) t),
      'summary', (select jsonb_build_object(
                    'categories', count(*),
                    'quantity', coalesce(sum(quantity), 0),
                    'gross_minor', coalesce(sum(gross_minor), 0))
                  from result_rows)
    )
  );
end;
$$;

-- ── inventory ───────────────────────────────────────────────────────────

create or replace function public.report_inventory_consumption(
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
  v_outlets := public.report_access(p_actor, p_business_id, p_outlet_ids, 'inventory.view');

  return (
    with grouped as (
      select m.outlet_id, ou.name as outlet_name, m.ingredient_id, i.name as ingredient_name, i.unit,
             -sum(m.qty) as quantity,
             -sum(m.value_minor) as cost_minor
      from public.inventory_movements m
      join public.ingredients i on i.id = m.ingredient_id
      join public.outlets ou on ou.id = m.outlet_id
      where m.business_id = p_business_id
        and m.kind = 'consumption'
        and m.outlet_id = any(v_outlets)
        and m.created_at >= public.report_start(p_from)
        and m.created_at < public.report_start(p_to + 1)
      group by m.outlet_id, ou.name, m.ingredient_id, i.name, i.unit
    ),
    result_rows as (
      select g.*, case when g.quantity > 0 then round(g.cost_minor / g.quantity, 4) else 0 end as avg_unit_cost
      from grouped g
      where p_search is null or p_search = ''
         or g.ingredient_name ilike '%' || p_search || '%'
         or g.outlet_name ilike '%' || p_search || '%'
    )
    select jsonb_build_object(
      'total', (select count(*) from result_rows),
      'rows', (select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb)
               from (select * from result_rows order by cost_minor desc, ingredient_name limit p_limit offset p_offset) t),
      'summary', (select jsonb_build_object(
                    'ingredients', count(distinct ingredient_id),
                    'quantity_lines', count(*),
                    'cost_minor', coalesce(sum(cost_minor), 0))
                  from result_rows)
    )
  );
end;
$$;

-- Goods received in the window, by the receipt date.
create or replace function public.report_inventory_purchases(
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
  v_outlets := public.report_access(p_actor, p_business_id, p_outlet_ids, 'inventory.view');

  return (
    with grouped as (
      select gr.outlet_id, ou.name as outlet_name, gri.ingredient_id, i.name as ingredient_name, i.unit,
             count(distinct gr.id) as receipts,
             sum(gri.qty_base) as quantity,
             sum(gri.line_total_minor) as value_minor
      from public.goods_receipt_items gri
      join public.goods_receipts gr on gr.id = gri.goods_receipt_id
      join public.ingredients i on i.id = gri.ingredient_id
      join public.outlets ou on ou.id = gr.outlet_id
      where gr.business_id = p_business_id
        and gr.outlet_id = any(v_outlets)
        and gr.received_on between p_from and p_to
      group by gr.outlet_id, ou.name, gri.ingredient_id, i.name, i.unit
    ),
    result_rows as (
      select g.*, case when g.quantity > 0 then round(g.value_minor / g.quantity, 4) else 0 end as avg_unit_cost
      from grouped g
      where p_search is null or p_search = ''
         or g.ingredient_name ilike '%' || p_search || '%'
         or g.outlet_name ilike '%' || p_search || '%'
    )
    select jsonb_build_object(
      'total', (select count(*) from result_rows),
      'rows', (select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb)
               from (select * from result_rows order by value_minor desc, ingredient_name limit p_limit offset p_offset) t),
      'summary', (select jsonb_build_object(
                    'ingredients', count(distinct ingredient_id),
                    'receipts', coalesce(sum(receipts), 0),
                    'value_minor', coalesce(sum(value_minor), 0))
                  from result_rows)
    )
  );
end;
$$;

create or replace function public.report_inventory_wastage(
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
  v_outlets := public.report_access(p_actor, p_business_id, p_outlet_ids, 'inventory.view');

  return (
    with grouped as (
      select m.outlet_id, ou.name as outlet_name, m.ingredient_id, i.name as ingredient_name, i.unit,
             count(*) as entries,
             -sum(m.qty) as quantity,
             -sum(m.value_minor) as cost_minor,
             string_agg(distinct m.reason, '; ') as reasons
      from public.inventory_movements m
      join public.ingredients i on i.id = m.ingredient_id
      join public.outlets ou on ou.id = m.outlet_id
      where m.business_id = p_business_id
        and m.kind = 'wastage'
        and m.outlet_id = any(v_outlets)
        and m.created_at >= public.report_start(p_from)
        and m.created_at < public.report_start(p_to + 1)
      group by m.outlet_id, ou.name, m.ingredient_id, i.name, i.unit
    ),
    result_rows as (
      select * from grouped g
      where p_search is null or p_search = ''
         or g.ingredient_name ilike '%' || p_search || '%'
         or coalesce(g.reasons, '') ilike '%' || p_search || '%'
    )
    select jsonb_build_object(
      'total', (select count(*) from result_rows),
      'rows', (select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb)
               from (select * from result_rows order by cost_minor desc, ingredient_name limit p_limit offset p_offset) t),
      'summary', (select jsonb_build_object(
                    'ingredients', count(distinct ingredient_id),
                    'entries', coalesce(sum(entries), 0),
                    'cost_minor', coalesce(sum(cost_minor), 0))
                  from result_rows)
    )
  );
end;
$$;

-- Theoretical food cost: recipe consumption posted by the completed orders in each
-- period, divided by net sales (after discounts, before tax). Wastage is shown beside it.
create or replace function public.report_inventory_food_cost(
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
  v_grain text := coalesce(nullif(p_grain, ''), 'day');
  v_outlets uuid[];
begin
  perform public.report_guard(p_from, p_to, v_grain, p_limit, p_offset);
  v_outlets := public.report_access(p_actor, p_business_id, p_outlet_ids, 'inventory.view');

  return (
    with cohort as (
      select o.order_id, o.completed_day, o.subtotal_minor - o.discount_minor as net_sales_minor
      from public.report_orders(p_business_id, v_outlets, p_from, p_to) o
    ),
    consumption as (
      select m.order_id, -sum(m.value_minor) as cost_minor
      from public.inventory_movements m
      where m.business_id = p_business_id
        and m.kind = 'consumption'
        and m.order_id in (select c.order_id from cohort c)
      group by m.order_id
    ),
    sales as (
      select public.report_period(c.completed_day, v_grain) as period_start,
             count(*) as orders,
             sum(c.net_sales_minor) as net_sales_minor,
             sum(coalesce(cs.cost_minor, 0)) as consumption_minor
      from cohort c
      left join consumption cs on cs.order_id = c.order_id
      group by 1
    ),
    waste as (
      select public.report_period(public.report_day(m.created_at), v_grain) as period_start,
             -sum(m.value_minor) as wastage_minor
      from public.inventory_movements m
      where m.business_id = p_business_id
        and m.kind = 'wastage'
        and m.outlet_id = any(v_outlets)
        and m.created_at >= public.report_start(p_from)
        and m.created_at < public.report_start(p_to + 1)
      group by 1
    ),
    periods as (
      select s.period_start from sales s
      union
      select w.period_start from waste w
    ),
    result_rows as (
      select p.period_start,
             public.report_period_end(p.period_start, v_grain) as period_end,
             coalesce(s.orders, 0) as orders,
             coalesce(s.net_sales_minor, 0) as net_sales_minor,
             coalesce(s.consumption_minor, 0) as consumption_minor,
             case when coalesce(s.net_sales_minor, 0) > 0
                  then round(100.0 * s.consumption_minor / s.net_sales_minor, 2) else 0 end as food_cost_pct,
             coalesce(w.wastage_minor, 0) as wastage_minor,
             case when coalesce(s.net_sales_minor, 0) > 0
                  then round(100.0 * coalesce(w.wastage_minor, 0) / s.net_sales_minor, 2) else 0 end as wastage_pct
      from periods p
      left join sales s on s.period_start = p.period_start
      left join waste w on w.period_start = p.period_start
    )
    select jsonb_build_object(
      'total', (select count(*) from result_rows),
      'rows', (select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb)
               from (select * from result_rows order by period_start desc limit p_limit offset p_offset) t),
      'summary', (select jsonb_build_object(
                    'orders', coalesce(sum(orders), 0),
                    'net_sales_minor', coalesce(sum(net_sales_minor), 0),
                    'consumption_minor', coalesce(sum(consumption_minor), 0),
                    'food_cost_pct', case when coalesce(sum(net_sales_minor), 0) > 0
                                          then round(100.0 * sum(consumption_minor) / sum(net_sales_minor), 2)
                                          else 0 end,
                    'wastage_minor', coalesce(sum(wastage_minor), 0))
                  from result_rows)
    )
  );
end;
$$;

-- Stock on hand now (point in time). Value comes from the batches that hold it.
create or replace function public.report_inventory_stock(
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
  v_outlets := public.report_access(p_actor, p_business_id, p_outlet_ids, 'inventory.view');

  return (
    with stock as (
      select s.outlet_id, ou.name as outlet_name, s.ingredient_id, i.name as ingredient_name, i.unit,
             s.on_hand, i.minimum_stock,
             coalesce(b.batch_qty, 0) as batch_qty,
             coalesce(b.batch_value_minor, 0) as value_minor
      from public.inventory_stock s
      join public.ingredients i on i.id = s.ingredient_id
      join public.outlets ou on ou.id = s.outlet_id
      left join lateral (
        select sum(bt.remaining_qty) as batch_qty,
               sum(bt.remaining_qty * bt.unit_cost) as batch_value_minor
        from public.inventory_batches bt
        where bt.outlet_id = s.outlet_id and bt.ingredient_id = s.ingredient_id
      ) b on true
      where s.business_id = p_business_id
        and s.outlet_id = any(v_outlets)
        and i.active
    ),
    result_rows as (
      select st.*,
             st.on_hand < st.minimum_stock as below_minimum,
             st.batch_qty = st.on_hand as batches_match
      from stock st
      where p_search is null or p_search = ''
         or st.ingredient_name ilike '%' || p_search || '%'
         or st.outlet_name ilike '%' || p_search || '%'
    )
    select jsonb_build_object(
      'total', (select count(*) from result_rows),
      'rows', (select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb)
               from (select * from result_rows order by outlet_name, ingredient_name limit p_limit offset p_offset) t),
      'summary', (select jsonb_build_object(
                    'items', count(*),
                    'value_minor', coalesce(sum(value_minor), 0),
                    'below_minimum', count(*) filter (where below_minimum),
                    'batch_mismatches', count(*) filter (where not batches_match))
                  from result_rows)
    )
  );
end;
$$;

-- ── staff ───────────────────────────────────────────────────────────────

create or replace function public.report_staff_orders(
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
  v_outlets := public.report_access(p_actor, p_business_id, p_outlet_ids, 'staff.view');

  return (
    with opened as (
      select o.created_by as user_id, o.status, o.total_minor
      from public.orders o
      where o.business_id = p_business_id
        and o.outlet_id = any(v_outlets)
        and o.created_at >= public.report_start(p_from)
        and o.created_at < public.report_start(p_to + 1)
    ),
    grouped as (
      select op.user_id,
             count(*) as opened,
             count(*) filter (where op.status = 'completed') as completed,
             count(*) filter (where op.status = 'cancelled') as cancelled,
             count(*) filter (where op.status not in ('completed', 'cancelled')) as still_open,
             coalesce(sum(op.total_minor) filter (where op.status = 'completed'), 0) as completed_minor
      from opened op
      group by op.user_id
    ),
    result_rows as (
      select g.user_id, public.report_user_name(g.user_id) as user_name,
             g.opened, g.completed, g.cancelled, g.still_open, g.completed_minor
      from grouped g
      where p_search is null or p_search = ''
         or public.report_user_name(g.user_id) ilike '%' || p_search || '%'
    )
    select jsonb_build_object(
      'total', (select count(*) from result_rows),
      'rows', (select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb)
               from (select * from result_rows order by opened desc, user_name limit p_limit offset p_offset) t),
      'summary', (select jsonb_build_object(
                    'opened', coalesce(sum(opened), 0),
                    'completed', coalesce(sum(completed), 0),
                    'cancelled', coalesce(sum(cancelled), 0),
                    'still_open', coalesce(sum(still_open), 0),
                    'completed_minor', coalesce(sum(completed_minor), 0))
                  from result_rows)
    )
  );
end;
$$;

-- Discounts granted on orders completed in the window, by the staff member who created the order.
create or replace function public.report_staff_discounts(
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
  v_outlets := public.report_access(p_actor, p_business_id, p_outlet_ids, 'staff.view');

  return (
    with cohort as (
      select o.created_by as user_id, o.subtotal_minor, o.discount_minor, o.promotion_minor
      from public.report_orders(p_business_id, v_outlets, p_from, p_to) o
    ),
    grouped as (
      select c.user_id,
             count(*) as orders,
             count(*) filter (where c.discount_minor > 0) as discounted_orders,
             sum(c.subtotal_minor) as gross_minor,
             sum(c.discount_minor) as discount_minor,
             sum(c.promotion_minor) as promotion_minor
      from cohort c
      group by c.user_id
    ),
    result_rows as (
      select g.user_id, public.report_user_name(g.user_id) as user_name,
             g.orders, g.discounted_orders, g.gross_minor,
             g.discount_minor - g.promotion_minor as manual_minor,
             g.promotion_minor, g.discount_minor as total_discount_minor,
             case when g.gross_minor > 0 then round(100.0 * g.discount_minor / g.gross_minor, 2) else 0 end as discount_pct
      from grouped g
      where p_search is null or p_search = ''
         or public.report_user_name(g.user_id) ilike '%' || p_search || '%'
    )
    select jsonb_build_object(
      'total', (select count(*) from result_rows),
      'rows', (select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb)
               from (select * from result_rows order by total_discount_minor desc, user_name limit p_limit offset p_offset) t),
      'summary', (select jsonb_build_object(
                    'orders', coalesce(sum(orders), 0),
                    'discounted_orders', coalesce(sum(discounted_orders), 0),
                    'gross_minor', coalesce(sum(gross_minor), 0),
                    'manual_minor', coalesce(sum(manual_minor), 0),
                    'promotion_minor', coalesce(sum(promotion_minor), 0),
                    'total_discount_minor', coalesce(sum(total_discount_minor), 0))
                  from result_rows)
    )
  );
end;
$$;

create or replace function public.report_staff_refunds(
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
  v_outlets := public.report_access(p_actor, p_business_id, p_outlet_ids, 'staff.view');

  return (
    with grouped as (
      select rr.created_by as user_id, count(*) as refunds, sum(rr.amount_minor) as amount_minor
      from public.report_refund_rows(p_business_id, v_outlets, p_from, p_to) rr
      group by rr.created_by
    ),
    result_rows as (
      select g.user_id, public.report_user_name(g.user_id) as user_name, g.refunds, g.amount_minor,
             case when g.refunds > 0 then round(g.amount_minor::numeric / g.refunds) else 0 end as avg_refund_minor
      from grouped g
      where p_search is null or p_search = ''
         or public.report_user_name(g.user_id) ilike '%' || p_search || '%'
    )
    select jsonb_build_object(
      'total', (select count(*) from result_rows),
      'rows', (select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb)
               from (select * from result_rows order by amount_minor desc, user_name limit p_limit offset p_offset) t),
      'summary', (select jsonb_build_object(
                    'refunds', coalesce(sum(refunds), 0),
                    'amount_minor', coalesce(sum(amount_minor), 0))
                  from result_rows)
    )
  );
end;
$$;

-- What each staff member did in the window: orders opened, completed and cancelled, payments taken, refunds processed.
create or replace function public.report_staff_cashier(
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
  v_outlets := public.report_access(p_actor, p_business_id, p_outlet_ids, 'staff.view');

  return (
    with opened as (
      select o.created_by as user_id, count(*) as n
      from public.orders o
      where o.business_id = p_business_id and o.outlet_id = any(v_outlets)
        and o.created_at >= public.report_start(p_from) and o.created_at < public.report_start(p_to + 1)
      group by o.created_by
    ),
    completed as (
      select c.completed_by as user_id, count(*) as n
      from public.report_orders(p_business_id, v_outlets, p_from, p_to) c
      group by c.completed_by
    ),
    cancelled as (
      select h.changed_by as user_id, count(*) as n
      from public.order_status_history h
      join public.orders o on o.id = h.order_id
      where o.business_id = p_business_id and o.outlet_id = any(v_outlets)
        and h.to_status = 'cancelled'
        and h.created_at >= public.report_start(p_from) and h.created_at < public.report_start(p_to + 1)
      group by h.changed_by
    ),
    taken as (
      select pr.created_by as user_id, count(*) as n, sum(pr.amount_minor) as amount_minor
      from public.report_payment_rows(p_business_id, v_outlets, p_from, p_to) pr
      group by pr.created_by
    ),
    refunded as (
      select rr.created_by as user_id, count(*) as n, sum(rr.amount_minor) as amount_minor
      from public.report_refund_rows(p_business_id, v_outlets, p_from, p_to) rr
      group by rr.created_by
    ),
    people as (
      select user_id from opened where user_id is not null
      union select user_id from completed where user_id is not null
      union select user_id from cancelled where user_id is not null
      union select user_id from taken where user_id is not null
      union select user_id from refunded where user_id is not null
    ),
    result_rows as (
      select p.user_id, public.report_user_name(p.user_id) as user_name,
             coalesce(op.n, 0) as orders_opened,
             coalesce(cm.n, 0) as orders_completed,
             coalesce(cx.n, 0) as orders_cancelled,
             coalesce(tk.n, 0) as payments_count,
             coalesce(tk.amount_minor, 0) as payments_minor,
             coalesce(rf.n, 0) as refunds_count,
             coalesce(rf.amount_minor, 0) as refunds_minor
      from people p
      left join opened op on op.user_id = p.user_id
      left join completed cm on cm.user_id = p.user_id
      left join cancelled cx on cx.user_id = p.user_id
      left join taken tk on tk.user_id = p.user_id
      left join refunded rf on rf.user_id = p.user_id
      where p_search is null or p_search = ''
         or public.report_user_name(p.user_id) ilike '%' || p_search || '%'
    )
    select jsonb_build_object(
      'total', (select count(*) from result_rows),
      'rows', (select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb)
               from (select * from result_rows order by payments_minor desc, user_name limit p_limit offset p_offset) t),
      'summary', (select jsonb_build_object(
                    'orders_opened', coalesce(sum(orders_opened), 0),
                    'orders_completed', coalesce(sum(orders_completed), 0),
                    'orders_cancelled', coalesce(sum(orders_cancelled), 0),
                    'payments_count', coalesce(sum(payments_count), 0),
                    'payments_minor', coalesce(sum(payments_minor), 0),
                    'refunds_count', coalesce(sum(refunds_count), 0),
                    'refunds_minor', coalesce(sum(refunds_minor), 0))
                  from result_rows)
    )
  );
end;
$$;

-- ── customers ───────────────────────────────────────────────────────────

-- Customers with completed orders in the window, with their first-ever order day.
-- status: 'new' = first completed order in the window, 'returning' = earlier order,
-- null = both. Spending is the same rows, ranked by net spend.
create or replace function public.report_customer_activity(
  p_actor uuid,
  p_business_id uuid,
  p_outlet_ids uuid[],
  p_from date,
  p_to date,
  p_search text,
  p_status text,
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
  v_outlets := public.report_access(p_actor, p_business_id, p_outlet_ids, 'customers.view');

  return (
    with act as (
      select o.customer_id,
             count(*) as orders,
             sum(o.total_minor) as billed_minor,
             max(o.completed_day) as last_order_day
      from public.report_orders(p_business_id, v_outlets, p_from, p_to) o
      where o.customer_id is not null
      group by o.customer_id
    ),
    refunded as (
      select rr.customer_id, sum(rr.amount_minor) as refunds_minor
      from public.report_refund_rows(p_business_id, v_outlets, p_from, p_to) rr
      where rr.customer_id is not null
      group by rr.customer_id
    ),
    firsts as (
      select f.customer_id, f.first_day from public.report_customer_first_day(p_business_id) f
    ),
    people as (
      select c.id as customer_id, c.name, c.phone,
             case when f.first_day between p_from and p_to then 'new' else 'returning' end as status,
             f.first_day as first_order_day,
             a.last_order_day,
             a.orders,
             a.billed_minor,
             coalesce(rf.refunds_minor, 0) as refunds_minor,
             a.billed_minor - coalesce(rf.refunds_minor, 0) as net_minor,
             coalesce(la.balance, 0) as points_balance
      from act a
      join public.customers c on c.id = a.customer_id
      left join firsts f on f.customer_id = a.customer_id
      left join refunded rf on rf.customer_id = a.customer_id
      left join public.loyalty_accounts la on la.customer_id = a.customer_id
    ),
    result_rows as (
      select pe.*,
             case when pe.orders > 0 then round(pe.billed_minor::numeric / pe.orders) else 0 end as avg_order_minor
      from people pe
      where (p_status is null or pe.status = p_status)
        and (p_search is null or p_search = '' or pe.name ilike '%' || p_search || '%'
             or pe.phone ilike '%' || p_search || '%')
    )
    select jsonb_build_object(
      'total', (select count(*) from result_rows),
      'rows', (select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb)
               from (select * from result_rows order by net_minor desc, name limit p_limit offset p_offset) t),
      'summary', (select jsonb_build_object(
                    'customers', count(*),
                    'new_customers', count(*) filter (where status = 'new'),
                    'returning_customers', count(*) filter (where status = 'returning'),
                    'orders', coalesce(sum(orders), 0),
                    'billed_minor', coalesce(sum(billed_minor), 0),
                    'refunds_minor', coalesce(sum(refunds_minor), 0),
                    'net_minor', coalesce(sum(net_minor), 0))
                  from result_rows)
    )
  );
end;
$$;

create or replace function public.report_customers_new(
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
language sql
stable
security definer
set search_path = public
as $$
  select public.report_customer_activity(p_actor, p_business_id, p_outlet_ids, p_from, p_to, p_search, 'new', p_limit, p_offset);
$$;

create or replace function public.report_customers_returning(
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
language sql
stable
security definer
set search_path = public
as $$
  select public.report_customer_activity(p_actor, p_business_id, p_outlet_ids, p_from, p_to, p_search, 'returning', p_limit, p_offset);
$$;

create or replace function public.report_customers_spending(
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
language sql
stable
security definer
set search_path = public
as $$
  select public.report_customer_activity(p_actor, p_business_id, p_outlet_ids, p_from, p_to, p_search, null, p_limit, p_offset);
$$;

-- Loyalty ledger movement by period. Outstanding balance is point-in-time.
create or replace function public.report_customers_loyalty(
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
  v_grain text := coalesce(nullif(p_grain, ''), 'day');
  v_outlets uuid[];
begin
  perform public.report_guard(p_from, p_to, v_grain, p_limit, p_offset);
  -- Loyalty is business-wide, so the outlet filter does not narrow it.
  v_outlets := public.report_access(p_actor, p_business_id, p_outlet_ids, 'customers.view');

  return (
    with ledger as (
      select public.report_period(public.report_day(t.created_at), v_grain) as period_start,
             sum(t.points) filter (where t.kind = 'earn') as earned,
             -sum(t.points) filter (where t.kind = 'redeem') as redeemed,
             -sum(t.points) filter (where t.kind = 'reversal') as reversed,
             sum(t.points) filter (where t.kind = 'adjust') as adjusted,
             sum(t.points) as net_points,
             count(*) filter (where t.kind = 'redeem') as rewards_issued
      from public.loyalty_transactions t
      where t.business_id = p_business_id
        and t.created_at >= public.report_start(p_from)
        and t.created_at < public.report_start(p_to + 1)
      group by 1
    ),
    result_rows as (
      select l.period_start,
             public.report_period_end(l.period_start, v_grain) as period_end,
             coalesce(l.earned, 0) as earned,
             coalesce(l.redeemed, 0) as redeemed,
             coalesce(l.reversed, 0) as reversed,
             coalesce(l.adjusted, 0) as adjusted,
             coalesce(l.net_points, 0) as net_points,
             coalesce(l.rewards_issued, 0) as rewards_issued
      from ledger l
    )
    select jsonb_build_object(
      'total', (select count(*) from result_rows),
      'rows', (select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb)
               from (select * from result_rows order by period_start desc limit p_limit offset p_offset) t),
      'summary', (select jsonb_build_object(
                    'earned', coalesce(sum(earned), 0),
                    'redeemed', coalesce(sum(redeemed), 0),
                    'reversed', coalesce(sum(reversed), 0),
                    'adjusted', coalesce(sum(adjusted), 0),
                    'net_points', coalesce(sum(net_points), 0),
                    'rewards_issued', coalesce(sum(rewards_issued), 0),
                    'outstanding_points', (select coalesce(sum(la.balance), 0)
                                           from public.loyalty_accounts la where la.business_id = p_business_id),
                    'accounts_with_points', (select count(*) from public.loyalty_accounts la
                                             where la.business_id = p_business_id and la.balance > 0))
                  from result_rows)
    )
  );
end;
$$;

-- ── indexes for the report windows ──────────────────────────────────────

create index if not exists order_status_history_completed_idx
  on public.order_status_history (created_at)
  where to_status = 'completed';
create index if not exists refunds_business_created_idx on public.refunds (business_id, created_at);
create index if not exists payments_business_created_idx on public.payments (business_id, created_at);
create index if not exists inventory_movements_kind_created_idx
  on public.inventory_movements (business_id, kind, created_at);
create index if not exists goods_receipts_received_idx on public.goods_receipts (business_id, received_on);
create index if not exists loyalty_transactions_created_idx on public.loyalty_transactions (business_id, created_at);

-- ── privileges ──────────────────────────────────────────────────────────
-- Helpers are internal. Report functions run only through the service role, after the
-- server checks the session. Each one still checks the actor's permissions itself.

revoke all on function public.report_day(timestamptz) from public, anon, authenticated;
revoke all on function public.report_start(date) from public, anon, authenticated;
revoke all on function public.report_period(date, text) from public, anon, authenticated;
revoke all on function public.report_period_end(date, text) from public, anon, authenticated;
revoke all on function public.report_guard(date, date, text, integer, integer) from public, anon, authenticated;
revoke all on function public.report_user_name(uuid) from public, anon, authenticated;
revoke all on function public.report_access(uuid, uuid, uuid[], text) from public, anon, authenticated;
revoke all on function public.report_customer_first_day(uuid) from public, anon, authenticated;
revoke all on function public.report_orders(uuid, uuid[], date, date) from public, anon, authenticated;
revoke all on function public.report_refund_rows(uuid, uuid[], date, date) from public, anon, authenticated;
revoke all on function public.report_payment_rows(uuid, uuid[], date, date) from public, anon, authenticated;
revoke all on function public.report_customer_activity(uuid, uuid, uuid[], date, date, text, text, integer, integer)
  from public, anon, authenticated;

do $$
declare
  f text;
begin
  foreach f in array array[
    'report_revenue_periods', 'report_tax_periods', 'report_discount_periods', 'report_refunds_list',
    'report_payments_by_method', 'report_sales_by_outlet', 'report_sales_by_product', 'report_sales_by_category',
    'report_inventory_consumption', 'report_inventory_purchases', 'report_inventory_wastage',
    'report_inventory_food_cost', 'report_inventory_stock', 'report_staff_orders', 'report_staff_discounts',
    'report_staff_refunds', 'report_staff_cashier', 'report_customers_new', 'report_customers_returning',
    'report_customers_spending', 'report_customers_loyalty'
  ] loop
    execute format(
      'revoke all on function public.%I(uuid, uuid, uuid[], date, date, text, text, integer, integer) from public, anon, authenticated',
      f);
    execute format(
      'grant execute on function public.%I(uuid, uuid, uuid[], date, date, text, text, integer, integer) to service_role',
      f);
  end loop;
end
$$;
