-- ─────────────────────────────────────────────────────────────────────────────
-- RestroNex Phase 10 — Payments, billing, receipts, refunds, audit
--
-- Source of truth for money:
--   * payments / refunds rows are the ledger (integer minor units, bigint).
--   * orders.paid_minor / refunded_minor / payment_status are DERIVED from the
--     ledger by recompute_order_payments(). A guard trigger rejects any other
--     writer, so a client or a stray update can never claim a bill is paid.
--   * Every mutating RPC locks the order row FOR UPDATE first (lock order:
--     orders → payments) and dedupes on client_ref, so double-submits and races
--     cannot double-charge or double-refund.
--   * Gateways (Razorpay etc.) are NOT wired: provider is 'manual' only.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── helpers ─────────────────────────────────────────────────────────────────

create or replace function public.actor_has_permission(
  p_actor uuid,
  p_business_id uuid,
  p_permission text
)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1
    from public.memberships m
    join public.role_permissions rp on rp.role_key = m.role
    where m.user_id = p_actor
      and m.business_id = p_business_id
      and m.status = 'active'
      and rp.permission_key = p_permission
  );
$$;

revoke all on function public.actor_has_permission(uuid, uuid, text) from public, anon;
grant execute on function public.actor_has_permission(uuid, uuid, text) to authenticated, service_role;

-- Outlet-scoped gate used by every money RPC. Returns the business id.
create or replace function public.require_outlet_permission(
  p_actor uuid,
  p_outlet_id uuid,
  p_permission text
)
returns uuid
language plpgsql
security definer
stable
set search_path = public
as $$
declare
  v_business_id uuid;
begin
  v_business_id := public.require_outlet_access(p_actor, p_outlet_id);
  if not public.actor_has_permission(p_actor, v_business_id, p_permission) then
    raise exception 'Your role does not allow this action (%).', p_permission
      using errcode = '42501';
  end if;
  return v_business_id;
end;
$$;

revoke all on function public.require_outlet_permission(uuid, uuid, text)
  from public, anon, authenticated, service_role;

-- Money → display text, numeric-exact (never float). 12050 → "120.50".
create or replace function public.money_text(p_minor bigint)
returns text
language sql
immutable
as $$
  select to_char(p_minor::numeric / 100, 'FM999999999999990.00');
$$;

-- Removes obviously sensitive keys from audit payloads (defence in depth:
-- callers must never pass secrets in the first place).
create or replace function public.audit_scrub(p_value jsonb)
returns jsonb
language sql
immutable
as $$
  select case
    when p_value is null then null
    when jsonb_typeof(p_value) <> 'object' then p_value
    else coalesce((
      select jsonb_object_agg(e.key, e.value)
      from jsonb_each(p_value) e
      where not (
        e.key ilike '%secret%' or e.key ilike '%password%' or e.key ilike '%token%'
        or e.key ilike '%api_key%' or e.key ilike '%service_role%' or e.key ilike '%signature%'
      )
    ), '{}'::jsonb)
  end;
$$;

-- ── document counters (gap-free, per business, per Indian fiscal year) ─────

create table public.business_document_counters (
  business_id uuid not null references public.businesses (id) on delete cascade,
  series text not null constraint business_document_counters_series check (series in ('invoice', 'receipt')),
  fiscal_year text not null constraint business_document_counters_fy_format check (fiscal_year ~ '^[0-9]{4}-[0-9]{2}$'),
  last_seq bigint not null default 0 check (last_seq >= 0),
  updated_at timestamptz not null default now(),
  primary key (business_id, series, fiscal_year)
);

alter table public.business_document_counters enable row level security;
revoke all on table public.business_document_counters from anon, authenticated;

-- Fiscal year runs 1 April → 31 March, evaluated in Asia/Kolkata.
-- The counter row is upserted (row-locked) inside the caller's transaction,
-- so numbers are gap-free for committed documents and roll back with failures.
create or replace function public.next_document_number(
  p_business_id uuid,
  p_series text,
  p_prefix text,
  p_at timestamptz
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_local timestamp;
  v_start integer;
  v_fy text;
  v_seq bigint;
begin
  v_local := p_at at time zone 'Asia/Kolkata';
  v_start := case
    when extract(month from v_local) >= 4 then extract(year from v_local)::integer
    else extract(year from v_local)::integer - 1
  end;
  v_fy := v_start::text || '-' || right((v_start + 1)::text, 2);

  insert into public.business_document_counters as c (business_id, series, fiscal_year, last_seq)
  values (p_business_id, p_series, v_fy, 1)
  on conflict (business_id, series, fiscal_year)
  do update set last_seq = c.last_seq + 1, updated_at = now()
  returning c.last_seq into v_seq;

  return p_prefix || '/' || v_fy || '/' || lpad(v_seq::text, 6, '0');
end;
$$;

revoke all on function public.next_document_number(uuid, text, text, timestamptz)
  from public, anon, authenticated, service_role;

-- ── orders: derived payment fields ─────────────────────────────────────────

alter table public.orders
  add column if not exists refunded_minor bigint not null default 0 constraint orders_refunded_nonneg check (refunded_minor >= 0),
  add column if not exists billed_at timestamptz;

create or replace function public.derive_payment_status(
  p_total_minor bigint,
  p_captured_minor bigint,
  p_refunded_minor bigint
)
returns text
language plpgsql
immutable
as $$
declare
  v_net bigint := p_captured_minor - p_refunded_minor;
begin
  if p_total_minor = 0 then return 'paid'; end if;
  if p_captured_minor = 0 then return 'unpaid'; end if;
  if v_net <= 0 then return 'refunded'; end if;
  if v_net < p_total_minor then return 'partial'; end if;
  return 'paid';
end;
$$;

revoke all on function public.derive_payment_status(bigint, bigint, bigint)
  from public, anon, authenticated, service_role;

create or replace function public.order_net_paid(p_order_id uuid)
returns bigint
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_captured bigint;
  v_refunded bigint;
begin
  select coalesce(sum(p.amount_minor), 0)::bigint into v_captured
  from public.payments p where p.order_id = p_order_id and p.status = 'captured';
  select coalesce(sum(r.amount_minor), 0)::bigint into v_refunded
  from public.refunds r where r.order_id = p_order_id and r.status = 'succeeded';
  return v_captured - v_refunded;
end;
$$;

revoke all on function public.order_net_paid(uuid) from public, anon, authenticated, service_role;

-- Only the ledger writers below may change derived payment fields.
create or replace function public.orders_payment_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if (new.paid_minor, new.refunded_minor, new.payment_status)
     is distinct from (old.paid_minor, old.refunded_minor, old.payment_status)
     and coalesce(current_setting('restronex.payment_recompute', true), 'off') <> 'on' then
    raise exception 'Payment status is maintained by the payment ledger.' using errcode = '42501';
  end if;
  return new;
end;
$$;

revoke all on function public.orders_payment_guard() from public, anon, authenticated, service_role;

create trigger orders_payment_guard
  before update on public.orders
  for each row execute function public.orders_payment_guard();

create or replace function public.recompute_order_payments(p_order_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_total bigint;
  v_captured bigint;
  v_refunded bigint;
begin
  select o.total_minor into v_total from public.orders o where o.id = p_order_id;
  select coalesce(sum(p.amount_minor), 0)::bigint into v_captured
  from public.payments p where p.order_id = p_order_id and p.status = 'captured';
  select coalesce(sum(r.amount_minor), 0)::bigint into v_refunded
  from public.refunds r where r.order_id = p_order_id and r.status = 'succeeded';

  perform set_config('restronex.payment_recompute', 'on', true);
  update public.orders
  set paid_minor = greatest(v_captured - v_refunded, 0),
      refunded_minor = v_refunded,
      payment_status = public.derive_payment_status(v_total, v_captured, v_refunded)
  where id = p_order_id;
  perform set_config('restronex.payment_recompute', 'off', true);
end;
$$;

revoke all on function public.recompute_order_payments(uuid) from public, anon, authenticated, service_role;

-- ── audit log (append-only) ────────────────────────────────────────────────

create table public.audit_logs (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  outlet_id uuid references public.outlets (id) on delete set null,
  actor_user_id uuid references auth.users (id) on delete set null,
  action text not null constraint audit_logs_action_format check (action ~ '^[a-z_]+\.[a-z_]+$'),
  target_type text not null constraint audit_logs_target_type check (char_length(target_type) between 1 and 40),
  target_id text not null constraint audit_logs_target_id check (char_length(target_id) between 1 and 80),
  before_state jsonb,
  after_state jsonb,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index audit_logs_business_created_idx on public.audit_logs (business_id, created_at desc);
create index audit_logs_target_idx on public.audit_logs (business_id, target_type, target_id);

alter table public.audit_logs enable row level security;
revoke all on table public.audit_logs from anon, authenticated;
grant select on table public.audit_logs to authenticated;

create or replace function public.audit_logs_append_only()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  raise exception 'Audit logs are append-only.' using errcode = '42501';
end;
$$;

create trigger audit_logs_append_only
  before update or delete on public.audit_logs
  for each row execute function public.audit_logs_append_only();

create or replace function public.write_audit_log(
  p_business_id uuid,
  p_outlet_id uuid,
  p_actor uuid,
  p_action text,
  p_target_type text,
  p_target_id text,
  p_before jsonb,
  p_after jsonb,
  p_metadata jsonb default '{}'::jsonb
)
returns void
language sql
security definer
set search_path = public
as $$
  insert into public.audit_logs (
    business_id, outlet_id, actor_user_id, action, target_type, target_id,
    before_state, after_state, metadata
  ) values (
    p_business_id, p_outlet_id, p_actor, p_action, p_target_type, p_target_id,
    public.audit_scrub(p_before), public.audit_scrub(p_after),
    coalesce(public.audit_scrub(p_metadata), '{}'::jsonb)
  );
$$;

revoke all on function public.write_audit_log(uuid, uuid, uuid, text, text, text, jsonb, jsonb, jsonb)
  from public, anon, authenticated, service_role;

-- ── payment methods (per business, configurable) ───────────────────────────

create table public.payment_methods (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  key text not null constraint payment_methods_key_format check (key ~ '^[a-z][a-z0-9_]{1,30}$'),
  label text not null constraint payment_methods_label_length check (char_length(label) between 1 and 40),
  kind text not null constraint payment_methods_kind_allowed check (kind in ('cash', 'upi', 'card', 'other')),
  requires_reference boolean not null default false,
  is_active boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint payment_methods_business_key_unique unique (business_id, key),
  constraint payment_methods_cash_no_reference check (kind <> 'cash' or requires_reference = false)
);

create trigger payment_methods_set_updated_at
  before update on public.payment_methods
  for each row execute function public.set_updated_at();

alter table public.payment_methods enable row level security;
revoke all on table public.payment_methods from anon, authenticated;
grant select on table public.payment_methods to authenticated;

create policy "payment_methods_select_member"
  on public.payment_methods for select
  to authenticated
  using (public.has_business_access(business_id));

create or replace function public.seed_default_payment_methods(p_business_id uuid)
returns void
language sql
security definer
set search_path = public
as $$
  insert into public.payment_methods (business_id, key, label, kind, requires_reference, sort_order)
  values
    (p_business_id, 'cash', 'Cash', 'cash', false, 10),
    (p_business_id, 'upi', 'UPI', 'upi', true, 20),
    (p_business_id, 'card', 'Card', 'card', true, 30)
  on conflict (business_id, key) do nothing;
$$;

revoke all on function public.seed_default_payment_methods(uuid) from public, anon, authenticated, service_role;

create or replace function public.businesses_seed_payment_methods()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.seed_default_payment_methods(new.id);
  return new;
end;
$$;

revoke all on function public.businesses_seed_payment_methods() from public, anon, authenticated, service_role;

create trigger businesses_seed_payment_methods
  after insert on public.businesses
  for each row execute function public.businesses_seed_payment_methods();

-- Backfill businesses created before Phase 10.
insert into public.payment_methods (business_id, key, label, kind, requires_reference, sort_order)
select b.id, v.key, v.label, v.kind, v.requires_reference, v.sort_order
from public.businesses b
cross join (values
  ('cash', 'Cash', 'cash', false, 10),
  ('upi', 'UPI', 'upi', true, 20),
  ('card', 'Card', 'card', true, 30)
) as v(key, label, kind, requires_reference, sort_order)
on conflict (business_id, key) do nothing;

-- ── receipts (numbered documents for every money movement) ────────────────

create table public.receipts (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  outlet_id uuid not null references public.outlets (id) on delete cascade,
  order_id uuid not null references public.orders (id) on delete cascade,
  receipt_no text not null constraint receipts_no_format check (char_length(receipt_no) between 5 and 40),
  kind text not null constraint receipts_kind_allowed check (kind in ('payment', 'refund')),
  amount_minor bigint not null constraint receipts_amount_positive check (amount_minor > 0),
  balance_after_minor bigint not null constraint receipts_balance_nonneg check (balance_after_minor >= 0),
  batch_key text not null constraint receipts_batch_key_length check (char_length(batch_key) between 8 and 64),
  print_count integer not null default 0 constraint receipts_print_count_nonneg check (print_count >= 0),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  constraint receipts_business_no_unique unique (business_id, receipt_no),
  constraint receipts_business_batch_unique unique (business_id, kind, batch_key)
);

create index receipts_order_idx on public.receipts (order_id, created_at);

alter table public.receipts enable row level security;
revoke all on table public.receipts from anon, authenticated;
grant select on table public.receipts to authenticated;

create policy "receipts_select_member"
  on public.receipts for select
  to authenticated
  using (public.has_business_access(business_id));

-- ── payments (ledger) ──────────────────────────────────────────────────────

create table public.payments (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  outlet_id uuid not null references public.outlets (id) on delete cascade,
  order_id uuid not null references public.orders (id) on delete cascade,
  receipt_id uuid not null references public.receipts (id) on delete restrict,
  method_key text not null,
  method_kind text not null constraint payments_method_kind_allowed check (method_kind in ('cash', 'upi', 'card', 'other')),
  provider text not null default 'manual' constraint payments_provider_manual_only check (provider = 'manual'),
  provider_payment_id text constraint payments_provider_ref_length check (provider_payment_id is null or char_length(provider_payment_id) between 1 and 120),
  status text not null default 'captured' constraint payments_status_allowed check (status in ('captured', 'pending', 'failed')),
  amount_minor bigint not null constraint payments_amount_positive check (amount_minor > 0),
  tendered_minor bigint not null,
  change_minor bigint not null default 0 constraint payments_change_nonneg check (change_minor >= 0),
  reference text constraint payments_reference_length check (reference is null or char_length(reference) between 1 and 120),
  client_ref text not null constraint payments_client_ref_length check (char_length(client_ref) between 8 and 80),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  constraint payments_business_client_ref_unique unique (business_id, client_ref),
  constraint payments_tender_covers_amount check (tendered_minor >= amount_minor),
  constraint payments_tender_math check (tendered_minor - amount_minor = change_minor),
  constraint payments_change_cash_only check (change_minor = 0 or method_kind = 'cash'),
  constraint payments_method_fk foreign key (business_id, method_key)
    references public.payment_methods (business_id, key)
);

create index payments_order_idx on public.payments (order_id);
create index payments_outlet_created_idx on public.payments (outlet_id, created_at);

alter table public.payments enable row level security;
revoke all on table public.payments from anon, authenticated;
grant select on table public.payments to authenticated;

create policy "payments_select_member"
  on public.payments for select
  to authenticated
  using (public.has_business_access(business_id));

-- ── refunds (ledger) ───────────────────────────────────────────────────────

create table public.refunds (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  outlet_id uuid not null references public.outlets (id) on delete cascade,
  order_id uuid not null references public.orders (id) on delete cascade,
  payment_id uuid not null references public.payments (id) on delete restrict,
  receipt_id uuid not null references public.receipts (id) on delete restrict,
  amount_minor bigint not null constraint refunds_amount_positive check (amount_minor > 0),
  reason text not null constraint refunds_reason_length check (char_length(btrim(reason)) between 3 and 200),
  status text not null default 'succeeded' constraint refunds_status_allowed check (status in ('succeeded', 'pending', 'failed')),
  provider text not null default 'manual' constraint refunds_provider_manual_only check (provider = 'manual'),
  provider_refund_id text constraint refunds_provider_ref_length check (provider_refund_id is null or char_length(provider_refund_id) between 1 and 120),
  client_ref text not null constraint refunds_client_ref_length check (char_length(client_ref) between 8 and 80),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  constraint refunds_business_client_ref_unique unique (business_id, client_ref)
);

create index refunds_payment_idx on public.refunds (payment_id);
create index refunds_order_idx on public.refunds (order_id);
create index refunds_outlet_created_idx on public.refunds (outlet_id, created_at);

alter table public.refunds enable row level security;
revoke all on table public.refunds from anon, authenticated;
grant select on table public.refunds to authenticated;

create policy "refunds_select_member"
  on public.refunds for select
  to authenticated
  using (public.has_business_access(business_id));

-- ── invoices (numbered, one issued invoice per order) ─────────────────────

create table public.invoices (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  outlet_id uuid not null references public.outlets (id) on delete cascade,
  order_id uuid not null references public.orders (id) on delete cascade,
  invoice_no text not null constraint invoices_no_format check (char_length(invoice_no) between 5 and 40),
  status text not null default 'issued' constraint invoices_status_allowed check (status in ('issued', 'void')),
  total_minor bigint not null constraint invoices_total_nonneg check (total_minor >= 0),
  snapshot jsonb not null,
  issued_by uuid references auth.users (id) on delete set null,
  issued_at timestamptz not null default now(),
  voided_by uuid references auth.users (id) on delete set null,
  voided_at timestamptz,
  void_reason text constraint invoices_void_reason_length check (void_reason is null or char_length(void_reason) between 3 and 200),
  constraint invoices_business_no_unique unique (business_id, invoice_no),
  constraint invoices_void_fields check ((status = 'void') = (voided_at is not null))
);

create unique index invoices_one_issued_per_order on public.invoices (order_id) where status = 'issued';

alter table public.invoices enable row level security;
revoke all on table public.invoices from anon, authenticated;
grant select on table public.invoices to authenticated;

create policy "invoices_select_member"
  on public.invoices for select
  to authenticated
  using (public.has_business_access(business_id));

create policy "audit_logs_select_reports"
  on public.audit_logs for select
  to authenticated
  using (public.actor_has_permission(auth.uid(), business_id, 'reports.view'));

-- ── payment method management ──────────────────────────────────────────────

create or replace function public.save_payment_method(
  p_actor uuid,
  p_business_id uuid,
  p_method_id uuid,
  p_key text,
  p_label text,
  p_kind text,
  p_requires_reference boolean,
  p_is_active boolean
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_method public.payment_methods%rowtype;
  v_before jsonb;
  v_after jsonb;
  v_id uuid;
begin
  if not public.actor_has_permission(p_actor, p_business_id, 'billing.manage') then
    raise exception 'Your role does not allow this action (billing.manage).' using errcode = '42501';
  end if;
  if p_label is null or char_length(btrim(p_label)) not between 1 and 40 then
    raise exception 'Label must be 1 to 40 characters.' using errcode = 'P0001';
  end if;
  if p_kind not in ('cash', 'upi', 'card', 'other') then
    raise exception 'Unknown payment kind.' using errcode = 'P0001';
  end if;
  if p_kind = 'cash' and coalesce(p_requires_reference, false) then
    raise exception 'Cash does not take a reference.' using errcode = 'P0001';
  end if;

  if p_method_id is null then
    if p_key is null or p_key !~ '^[a-z][a-z0-9_]{1,30}$' then
      raise exception 'Method key: lowercase letters, digits and underscores, 2 to 31 characters.' using errcode = 'P0001';
    end if;
    if exists (select 1 from public.payment_methods where business_id = p_business_id and key = p_key) then
      raise exception 'A payment method with this key already exists.' using errcode = 'P0001';
    end if;
    insert into public.payment_methods (business_id, key, label, kind, requires_reference, is_active, sort_order)
    values (p_business_id, p_key, btrim(p_label), p_kind, coalesce(p_requires_reference, false),
            coalesce(p_is_active, true),
            coalesce((select max(sort_order) + 10 from public.payment_methods where business_id = p_business_id), 100))
    returning id into v_id;
    v_after := jsonb_build_object('key', p_key, 'label', btrim(p_label), 'kind', p_kind,
                                  'is_active', coalesce(p_is_active, true));
    v_before := null;
  else
    select * into v_method from public.payment_methods
    where id = p_method_id and business_id = p_business_id for update;
    if v_method.id is null then
      raise exception 'Payment method not found.' using errcode = 'P0001';
    end if;
    if p_key is not null and p_key <> v_method.key then
      raise exception 'Payment method keys cannot be changed once created.' using errcode = 'P0001';
    end if;
    v_before := jsonb_build_object('label', v_method.label, 'kind', v_method.kind,
                                   'requires_reference', v_method.requires_reference,
                                   'is_active', v_method.is_active);
    update public.payment_methods
    set label = btrim(p_label), kind = p_kind,
        requires_reference = coalesce(p_requires_reference, false),
        is_active = coalesce(p_is_active, v_method.is_active)
    where id = p_method_id
    returning id into v_id;
    v_after := jsonb_build_object('label', btrim(p_label), 'kind', p_kind,
                                  'requires_reference', coalesce(p_requires_reference, false),
                                  'is_active', coalesce(p_is_active, v_method.is_active));
  end if;

  perform public.write_audit_log(p_business_id, null, p_actor, 'payment_method.saved',
    'payment_method', v_id::text, v_before, v_after,
    jsonb_build_object('key', coalesce(p_key, v_method.key)));
  return v_id;
end;
$$;

revoke all on function public.save_payment_method(uuid, uuid, uuid, text, text, text, boolean, boolean)
  from public, anon, authenticated;
grant execute on function public.save_payment_method(uuid, uuid, uuid, text, text, text, boolean, boolean)
  to service_role;

-- ── Phase 8/9 money-touching RPCs, redefined for Phase 10 ───────────────
-- Bodies are carried forward from Phase 9 with only the billed/paid guards added.

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
  -- Phase 10: a billed or paid bill is frozen until the money/invoice is reversed.
  if exists (select 1 from public.orders o where o.id = p_order_id and o.billed_at is not null) then
    raise exception 'Void the invoice before editing this order.' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.orders o where o.id = p_order_id and o.paid_minor > 0) then
    raise exception 'Refund recorded payments before editing this order.' using errcode = 'P0001';
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
  -- Phase 10: invoiced orders are frozen.
  if v_keep.billed_at is not null or v_merge.billed_at is not null then
    raise exception 'Invoiced orders cannot be merged. Void the invoice first.' using errcode = 'P0001';
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
  -- Phase 10: invoiced orders are frozen.
  if v_order.billed_at is not null then
    raise exception 'Invoiced orders cannot be split. Void the invoice first.' using errcode = 'P0001';
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


-- ── record_payments: split / partial / multi-method settlement ─────────────
-- p_lines: [{ "method_key": "cash", "amount_minor": 12050, "tendered_minor": 15000, "reference": "..." }]
-- Idempotent per batch: line n gets client_ref = p_batch_key || '#' || n.
create or replace function public.record_payments(
  p_actor uuid,
  p_order_id uuid,
  p_batch_key text,
  p_lines jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order record;
  v_existing_receipt_id uuid;
  v_line jsonb;
  v_method record;
  v_idx integer := 0;
  v_count integer;
  v_amount bigint;
  v_tendered bigint;
  v_tender_given boolean;
  v_reference text;
  v_sum bigint := 0;
  v_net_before bigint;
  v_due bigint;
  v_receipt_id uuid;
  v_receipt_no text;
  v_net_after bigint;
  v_methods jsonb := '[]'::jsonb;
  v_receipt_row record;
begin
  if p_batch_key is null or p_batch_key !~ '^[A-Za-z0-9_-]{8,64}$' then
    raise exception 'Payment reference must be 8 to 64 letters, digits, dashes or underscores.' using errcode = 'P0001';
  end if;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' then
    raise exception 'Enter at least one payment.' using errcode = 'P0001';
  end if;
  if jsonb_array_length(p_lines) not between 1 and 6 then
    raise exception 'A bill accepts 1 to 6 payment lines.' using errcode = 'P0001';
  end if;

  -- Lock the order FIRST: serialises every money writer for this bill.
  select o.id, o.business_id, o.outlet_id, o.status, o.total_minor
  into v_order
  from public.orders o where o.id = p_order_id
  for update;
  if v_order.id is null then
    raise exception 'Order not found.' using errcode = 'P0001';
  end if;
  perform public.require_outlet_permission(p_actor, v_order.outlet_id, 'billing.manage');

  -- Idempotency: a replayed batch returns the original receipt.
  select p.receipt_id into v_existing_receipt_id
  from public.payments p
  where p.business_id = v_order.business_id and p.client_ref = p_batch_key || '#1';
  if v_existing_receipt_id is not null then
    if not exists (
      select 1 from public.payments p
      where p.business_id = v_order.business_id and p.client_ref = p_batch_key || '#1' and p.order_id = p_order_id
    ) then
      raise exception 'This payment reference was already used for another order.' using errcode = 'P0001';
    end if;
    select r.receipt_no, r.amount_minor, r.balance_after_minor into v_receipt_row
    from public.receipts r where r.id = v_existing_receipt_id;
    return jsonb_build_object(
      'duplicate', true,
      'receipt_id', v_existing_receipt_id,
      'receipt_no', v_receipt_row.receipt_no,
      'amount_minor', v_receipt_row.amount_minor,
      'balance_due_minor', v_receipt_row.balance_after_minor
    );
  end if;

  if v_order.status not in ('open', 'held', 'placed', 'preparing', 'ready') then
    raise exception 'Payments can only be taken on a live order.' using errcode = 'P0001';
  end if;

  v_net_before := public.order_net_paid(p_order_id);
  v_due := v_order.total_minor - v_net_before;
  if v_due <= 0 then
    raise exception 'Nothing is due on this order.' using errcode = 'P0001';
  end if;

  -- Validation pass (nothing is written until every line is valid).
  for v_line in select e.value from jsonb_array_elements(p_lines) e loop
    v_idx := v_idx + 1;
    if jsonb_typeof(v_line) <> 'object' then
      raise exception 'Each payment line must be an object.' using errcode = 'P0001';
    end if;
    -- Integer minor units only: reject decimals, exponents, signs, strings.
    if coalesce(jsonb_typeof(v_line -> 'amount_minor'), 'null') <> 'number'
       or coalesce(v_line ->> 'amount_minor', '') !~ '^[1-9][0-9]{0,12}$' then
      raise exception 'Payment amounts must be whole minor units greater than zero.' using errcode = 'P0001';
    end if;
    v_amount := (v_line ->> 'amount_minor')::bigint;

    select m.* into v_method from public.payment_methods m
    where m.business_id = v_order.business_id and m.key = v_line ->> 'method_key' and m.is_active;
    if v_method.id is null then
      raise exception 'Choose an active payment method for every line.' using errcode = 'P0001';
    end if;

    v_reference := nullif(btrim(coalesce(v_line ->> 'reference', '')), '');
    if v_reference is not null and char_length(v_reference) > 120 then
      raise exception 'References must be 120 characters or fewer.' using errcode = 'P0001';
    end if;
    if v_method.requires_reference and v_reference is null then
      raise exception 'Enter a reference for %.', v_method.label using errcode = 'P0001';
    end if;

    v_tender_given := coalesce(jsonb_typeof(v_line -> 'tendered_minor'), 'null') <> 'null';
    if v_method.kind = 'cash' then
      if v_tender_given then
        if jsonb_typeof(v_line -> 'tendered_minor') <> 'number'
           or (v_line ->> 'tendered_minor') !~ '^[1-9][0-9]{0,12}$' then
          raise exception 'Cash tendered must be whole minor units greater than zero.' using errcode = 'P0001';
        end if;
        v_tendered := (v_line ->> 'tendered_minor')::bigint;
      else
        v_tendered := v_amount;
      end if;
      if v_tendered < v_amount then
        raise exception 'Cash tendered is less than the amount for this line.' using errcode = 'P0001';
      end if;
    else
      if v_tender_given then
        if jsonb_typeof(v_line -> 'tendered_minor') <> 'number'
           or (v_line ->> 'tendered_minor') !~ '^[1-9][0-9]{0,12}$' then
          raise exception 'Only cash can be tendered above the amount.' using errcode = 'P0001';
        end if;
        if (v_line ->> 'tendered_minor')::bigint <> v_amount then
          raise exception 'Only cash can be tendered above the amount.' using errcode = 'P0001';
        end if;
      end if;
      v_tendered := v_amount;
    end if;

    v_sum := v_sum + v_amount;
  end loop;

  if v_sum > v_due then
    raise exception 'Payments total % but only % is due.',
      public.money_text(v_sum), public.money_text(v_due) using errcode = 'P0001';
  end if;

  -- Receipt first (payments reference it), numbered from the gap-free counter.
  v_receipt_no := public.next_document_number(v_order.business_id, 'receipt', 'RCT', now());
  v_receipt_id := gen_random_uuid();
  insert into public.receipts (
    id, business_id, outlet_id, order_id, receipt_no, kind, amount_minor,
    balance_after_minor, batch_key, created_by
  ) values (
    v_receipt_id, v_order.business_id, v_order.outlet_id, p_order_id, v_receipt_no, 'payment', v_sum,
    v_due - v_sum, p_batch_key, p_actor
  );

  v_idx := 0;
  for v_line in select e.value from jsonb_array_elements(p_lines) e loop
    v_idx := v_idx + 1;
    v_amount := (v_line ->> 'amount_minor')::bigint;
    select m.* into v_method from public.payment_methods m
    where m.business_id = v_order.business_id and m.key = v_line ->> 'method_key' and m.is_active;
    v_reference := nullif(btrim(coalesce(v_line ->> 'reference', '')), '');
    v_tender_given := coalesce(jsonb_typeof(v_line -> 'tendered_minor'), 'null') <> 'null';
    v_tendered := case
      when v_method.kind = 'cash' and v_tender_given then (v_line ->> 'tendered_minor')::bigint
      else v_amount
    end;

    insert into public.payments (
      business_id, outlet_id, order_id, receipt_id, method_key, method_kind, provider,
      status, amount_minor, tendered_minor, change_minor, reference, client_ref, created_by
    ) values (
      v_order.business_id, v_order.outlet_id, p_order_id, v_receipt_id, v_method.key, v_method.kind, 'manual',
      'captured', v_amount, v_tendered, v_tendered - v_amount, v_reference,
      p_batch_key || '#' || v_idx, p_actor
    );
    v_methods := v_methods || jsonb_build_array(v_method.key);
  end loop;

  perform public.recompute_order_payments(p_order_id);
  v_net_after := public.order_net_paid(p_order_id);

  perform public.write_audit_log(
    v_order.business_id, v_order.outlet_id, p_actor, 'payment.recorded',
    'order', p_order_id::text,
    jsonb_build_object('paid_minor', v_net_before),
    jsonb_build_object('paid_minor', v_net_after),
    jsonb_build_object('receipt_no', v_receipt_no, 'amount_minor', v_sum, 'methods', v_methods)
  );

  return jsonb_build_object(
    'duplicate', false,
    'receipt_id', v_receipt_id,
    'receipt_no', v_receipt_no,
    'amount_minor', v_sum,
    'balance_due_minor', v_due - v_sum
  );
end;
$$;

revoke all on function public.record_payments(uuid, uuid, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.record_payments(uuid, uuid, text, jsonb) to service_role;

-- ── refund_payment: refund against one captured payment ────────────────────
create or replace function public.refund_payment(
  p_actor uuid,
  p_payment_id uuid,
  p_amount_minor bigint,
  p_reason text,
  p_client_ref text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_payment public.payments%rowtype;
  v_order_id uuid;
  v_order_total bigint;
  v_existing record;
  v_refunded bigint;
  v_refundable bigint;
  v_net_before bigint;
  v_receipt_id uuid;
  v_receipt_no text;
  v_reason text := btrim(coalesce(p_reason, ''));
begin
  if p_client_ref is null or p_client_ref !~ '^[A-Za-z0-9_-]{8,64}$' then
    raise exception 'Refund reference must be 8 to 64 letters, digits, dashes or underscores.' using errcode = 'P0001';
  end if;

  select p.order_id into v_order_id from public.payments p where p.id = p_payment_id;
  if v_order_id is null then
    raise exception 'Payment not found.' using errcode = 'P0001';
  end if;

  -- Lock order, then payment (same order as every other money writer).
  select o.total_minor into v_order_total from public.orders o where o.id = v_order_id for update;
  select * into v_payment from public.payments p where p.id = p_payment_id for update;

  perform public.require_outlet_permission(p_actor, v_payment.outlet_id, 'refunds.process');

  -- Idempotency on the refund reference.
  select r.id, r.payment_id, r.receipt_id into v_existing
  from public.refunds r
  where r.business_id = v_payment.business_id and r.client_ref = p_client_ref;
  if v_existing.id is not null then
    if v_existing.payment_id <> p_payment_id then
      raise exception 'This refund reference was already used.' using errcode = 'P0001';
    end if;
    return jsonb_build_object(
      'duplicate', true,
      'refund_id', v_existing.id,
      'receipt_id', v_existing.receipt_id,
      'receipt_no', (select r.receipt_no from public.receipts r where r.id = v_existing.receipt_id)
    );
  end if;

  if v_payment.status <> 'captured' then
    raise exception 'Only captured payments can be refunded.' using errcode = 'P0001';
  end if;
  if p_amount_minor is null or p_amount_minor <= 0 then
    raise exception 'Refund amount must be greater than zero.' using errcode = 'P0001';
  end if;
  if char_length(v_reason) not between 3 and 200 then
    raise exception 'Give a reason for the refund (3 to 200 characters).' using errcode = 'P0001';
  end if;

  select coalesce(sum(r.amount_minor), 0)::bigint into v_refunded
  from public.refunds r
  where r.payment_id = p_payment_id and r.status in ('succeeded', 'pending');
  v_refundable := v_payment.amount_minor - v_refunded;
  if p_amount_minor > v_refundable then
    raise exception 'Refund exceeds the refundable amount of %.', public.money_text(v_refundable)
      using errcode = 'P0001';
  end if;

  v_net_before := public.order_net_paid(v_order_id);
  v_receipt_no := public.next_document_number(v_payment.business_id, 'receipt', 'RFD', now());
  v_receipt_id := gen_random_uuid();
  insert into public.receipts (
    id, business_id, outlet_id, order_id, receipt_no, kind, amount_minor,
    balance_after_minor, batch_key, created_by
  ) values (
    v_receipt_id, v_payment.business_id, v_payment.outlet_id, v_order_id, v_receipt_no, 'refund', p_amount_minor,
    v_order_total - (v_net_before - p_amount_minor), p_client_ref, p_actor
  );

  insert into public.refunds (
    business_id, outlet_id, order_id, payment_id, receipt_id, amount_minor, reason,
    status, provider, client_ref, created_by
  ) values (
    v_payment.business_id, v_payment.outlet_id, v_order_id, p_payment_id, v_receipt_id, p_amount_minor, v_reason,
    'succeeded', 'manual', p_client_ref, p_actor
  );

  perform public.recompute_order_payments(v_order_id);

  perform public.write_audit_log(
    v_payment.business_id, v_payment.outlet_id, p_actor, 'refund.processed',
    'payment', p_payment_id::text,
    jsonb_build_object('net_paid_minor', v_net_before, 'payment_refundable_minor', v_refundable),
    jsonb_build_object('net_paid_minor', v_net_before - p_amount_minor,
                       'payment_refundable_minor', v_refundable - p_amount_minor),
    jsonb_build_object('receipt_no', v_receipt_no, 'amount_minor', p_amount_minor,
                       'reason', v_reason, 'order_id', v_order_id)
  );

  return jsonb_build_object(
    'duplicate', false,
    'receipt_id', v_receipt_id,
    'receipt_no', v_receipt_no,
    'amount_minor', p_amount_minor
  );
end;
$$;

revoke all on function public.refund_payment(uuid, uuid, bigint, text, text)
  from public, anon, authenticated;
grant execute on function public.refund_payment(uuid, uuid, bigint, text, text) to service_role;

-- ── issue_invoice: numbered invoice snapshot, one issued invoice per order ─
create or replace function public.issue_invoice(p_actor uuid, p_order_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order record;
  v_existing record;
  v_invoice_id uuid;
  v_invoice_no text;
  v_snapshot jsonb;
  v_business_name text;
  v_outlet record;
  v_table_label text;
begin
  select o.* into v_order from public.orders o where o.id = p_order_id for update;
  if v_order.id is null then
    raise exception 'Order not found.' using errcode = 'P0001';
  end if;
  perform public.require_outlet_permission(p_actor, v_order.outlet_id, 'billing.manage');

  select i.id, i.invoice_no into v_existing
  from public.invoices i where i.order_id = p_order_id and i.status = 'issued';
  if v_existing.id is not null then
    return jsonb_build_object('duplicate', true, 'invoice_id', v_existing.id, 'invoice_no', v_existing.invoice_no);
  end if;

  if v_order.status = 'cancelled' then
    raise exception 'Cancelled orders cannot be invoiced.' using errcode = 'P0001';
  end if;
  if not exists (select 1 from public.order_items oi where oi.order_id = p_order_id) then
    raise exception 'Add items to the order before issuing an invoice.' using errcode = 'P0001';
  end if;

  select b.name into v_business_name from public.businesses b where b.id = v_order.business_id;
  select ou.name, ou.currency_code into v_outlet from public.outlets ou where ou.id = v_order.outlet_id;
  select t.label into v_table_label from public.dining_tables t where t.id = v_order.table_id;

  v_invoice_no := public.next_document_number(v_order.business_id, 'invoice', 'INV', now());

  v_snapshot := jsonb_build_object(
    'business_name', v_business_name,
    'outlet_name', v_outlet.name,
    'currency_code', v_outlet.currency_code,
    'order_number', v_order.order_number,
    'order_type', v_order.order_type,
    'table_label', v_table_label,
    'customer_name', v_order.customer_name,
    'customer_phone', v_order.customer_phone,
    'delivery_address', v_order.delivery_address,
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
        'name', oi.name,
        'quantity', oi.quantity,
        'unit_price_minor', oi.unit_price_minor,
        'modifiers_minor', oi.modifiers_minor,
        'line_total_minor', oi.line_total_minor,
        'item_notes', oi.item_notes,
        'modifiers', coalesce((
          select jsonb_agg(jsonb_build_object('name', m.name, 'quantity', m.quantity, 'price_minor', m.price_minor)
                           order by m.name)
          from public.order_item_modifiers m where m.order_item_id = oi.id
        ), '[]'::jsonb)
      ) order by oi.position)
      from public.order_items oi where oi.order_id = p_order_id
    ), '[]'::jsonb),
    'subtotal_minor', v_order.subtotal_minor,
    'discount_minor', v_order.discount_minor,
    'tax_minor', v_order.tax_minor,
    'charges_minor', v_order.charges_minor,
    'charges', v_order.charges,
    'total_minor', v_order.total_minor,
    'paid_minor', public.order_net_paid(p_order_id)
  );

  v_invoice_id := gen_random_uuid();
  insert into public.invoices (
    id, business_id, outlet_id, order_id, invoice_no, status, total_minor, snapshot, issued_by
  ) values (
    v_invoice_id, v_order.business_id, v_order.outlet_id, p_order_id, v_invoice_no, 'issued',
    v_order.total_minor, v_snapshot, p_actor
  );

  update public.orders set billed_at = now() where id = p_order_id;

  perform public.write_audit_log(
    v_order.business_id, v_order.outlet_id, p_actor, 'invoice.issued',
    'invoice', v_invoice_id::text, null,
    jsonb_build_object('invoice_no', v_invoice_no, 'total_minor', v_order.total_minor),
    jsonb_build_object('order_id', p_order_id)
  );

  return jsonb_build_object('duplicate', false, 'invoice_id', v_invoice_id, 'invoice_no', v_invoice_no);
end;
$$;

revoke all on function public.issue_invoice(uuid, uuid) from public, anon, authenticated;
grant execute on function public.issue_invoice(uuid, uuid) to service_role;

-- ── void_invoice: manager correction; blocked while money is still held ───
create or replace function public.void_invoice(p_actor uuid, p_invoice_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_invoice record;
  v_status text;
  v_reason text := btrim(coalesce(p_reason, ''));
begin
  select i.id, i.business_id, i.outlet_id, i.order_id, i.invoice_no, i.status
  into v_invoice
  from public.invoices i where i.id = p_invoice_id;
  if v_invoice.id is null then
    raise exception 'Invoice not found.' using errcode = 'P0001';
  end if;

  perform 1 from public.orders o where o.id = v_invoice.order_id for update;
  perform public.require_outlet_permission(p_actor, v_invoice.outlet_id, 'refunds.process');

  select i.status into v_status from public.invoices i where i.id = p_invoice_id for update;
  if v_status <> 'issued' then
    raise exception 'This invoice is already void.' using errcode = 'P0001';
  end if;
  if char_length(v_reason) not between 3 and 200 then
    raise exception 'Give a reason for voiding the invoice (3 to 200 characters).' using errcode = 'P0001';
  end if;
  if public.order_net_paid(v_invoice.order_id) > 0 then
    raise exception 'Refund the recorded payments before voiding this invoice.' using errcode = 'P0001';
  end if;

  update public.invoices
  set status = 'void', voided_by = p_actor, voided_at = now(), void_reason = v_reason
  where id = p_invoice_id;
  update public.orders set billed_at = null where id = v_invoice.order_id;

  perform public.write_audit_log(
    v_invoice.business_id, v_invoice.outlet_id, p_actor, 'invoice.voided',
    'invoice', p_invoice_id::text,
    jsonb_build_object('status', 'issued'),
    jsonb_build_object('status', 'void'),
    jsonb_build_object('invoice_no', v_invoice.invoice_no, 'reason', v_reason)
  );

  return jsonb_build_object('invoice_no', v_invoice.invoice_no);
end;
$$;

revoke all on function public.void_invoice(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.void_invoice(uuid, uuid, text) to service_role;

-- ── record_receipt_print: every print counted; reprints audited ───────────
create or replace function public.record_receipt_print(p_actor uuid, p_receipt_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_receipt record;
  v_count integer;
begin
  select r.id, r.business_id, r.outlet_id, r.receipt_no into v_receipt
  from public.receipts r where r.id = p_receipt_id;
  if v_receipt.id is null then
    raise exception 'Receipt not found.' using errcode = 'P0001';
  end if;
  perform public.require_outlet_permission(p_actor, v_receipt.outlet_id, 'billing.manage');

  update public.receipts set print_count = print_count + 1
  where id = p_receipt_id
  returning print_count into v_count;

  if v_count > 1 then
    perform public.write_audit_log(
      v_receipt.business_id, v_receipt.outlet_id, p_actor, 'receipt.reprinted',
      'receipt', p_receipt_id::text, null, null,
      jsonb_build_object('receipt_no', v_receipt.receipt_no, 'print_count', v_count)
    );
  end if;
  return v_count;
end;
$$;

revoke all on function public.record_receipt_print(uuid, uuid) from public, anon, authenticated;
grant execute on function public.record_receipt_print(uuid, uuid) to service_role;

-- ── payment_reconciliation: ledger totals per method + order mismatches ────
create or replace function public.payment_reconciliation(
  p_actor uuid,
  p_outlet_id uuid,
  p_from timestamptz,
  p_to timestamptz
)
returns jsonb
language plpgsql
security definer
stable
set search_path = public
as $$
declare
  v_business_id uuid;
  v_methods jsonb;
  v_captured bigint;
  v_refunded bigint;
  v_payment_count bigint;
  v_refund_count bigint;
  v_issued bigint;
  v_voided bigint;
  v_mismatch_count bigint;
  v_mismatches jsonb;
begin
  if p_from is null or p_to is null or p_to <= p_from then
    raise exception 'Choose a valid date range.' using errcode = 'P0001';
  end if;
  v_business_id := public.require_outlet_permission(p_actor, p_outlet_id, 'reports.view');

  with cap as (
    select p.method_key, count(*) as n, sum(p.amount_minor)::bigint as s
    from public.payments p
    where p.outlet_id = p_outlet_id and p.status = 'captured'
      and p.created_at >= p_from and p.created_at < p_to
    group by p.method_key
  ), ref as (
    select p.method_key, count(*) as n, sum(r.amount_minor)::bigint as s
    from public.refunds r
    join public.payments p on p.id = r.payment_id
    where r.outlet_id = p_outlet_id and r.status = 'succeeded'
      and r.created_at >= p_from and r.created_at < p_to
    group by p.method_key
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'method_key', coalesce(cap.method_key, ref.method_key),
           'payment_count', coalesce(cap.n, 0),
           'refund_count', coalesce(ref.n, 0),
           'captured_minor', coalesce(cap.s, 0),
           'refunded_minor', coalesce(ref.s, 0),
           'net_minor', coalesce(cap.s, 0) - coalesce(ref.s, 0)
         ) order by coalesce(cap.method_key, ref.method_key)), '[]'::jsonb)
  into v_methods
  from cap full join ref on ref.method_key = cap.method_key;

  select count(*), coalesce(sum(p.amount_minor), 0)::bigint
  into v_payment_count, v_captured
  from public.payments p
  where p.outlet_id = p_outlet_id and p.status = 'captured'
    and p.created_at >= p_from and p.created_at < p_to;

  select count(*), coalesce(sum(r.amount_minor), 0)::bigint
  into v_refund_count, v_refunded
  from public.refunds r
  where r.outlet_id = p_outlet_id and r.status = 'succeeded'
    and r.created_at >= p_from and r.created_at < p_to;

  select count(*) filter (where i.issued_at >= p_from and i.issued_at < p_to),
         count(*) filter (where i.voided_at >= p_from and i.voided_at < p_to)
  into v_issued, v_voided
  from public.invoices i where i.outlet_id = p_outlet_id;

  -- Order-level integrity: derived order fields must equal the ledger.
  with ledger as (
    select o.id, o.order_number, o.total_minor, o.paid_minor, o.refunded_minor, o.payment_status,
           coalesce((select sum(p.amount_minor) from public.payments p
                     where p.order_id = o.id and p.status = 'captured'), 0)::bigint as captured,
           coalesce((select sum(r.amount_minor) from public.refunds r
                     where r.order_id = o.id and r.status = 'succeeded'), 0)::bigint as refunded
    from public.orders o
    where o.outlet_id = p_outlet_id
  ), bad as (
    select l.* from ledger l
    where l.paid_minor <> greatest(l.captured - l.refunded, 0)
       or l.refunded_minor <> l.refunded
       or l.payment_status <> public.derive_payment_status(l.total_minor, l.captured, l.refunded)
  )
  select count(*)::bigint,
         coalesce(jsonb_agg(jsonb_build_object(
           'order_id', b.id,
           'order_number', b.order_number,
           'expected_paid_minor', greatest(b.captured - b.refunded, 0),
           'recorded_paid_minor', b.paid_minor,
           'expected_refunded_minor', b.refunded,
           'recorded_refunded_minor', b.refunded_minor,
           'expected_status', public.derive_payment_status(b.total_minor, b.captured, b.refunded),
           'recorded_status', b.payment_status
         ) order by b.order_number) filter (where true), '[]'::jsonb)
  into v_mismatch_count, v_mismatches
  from bad b;

  return jsonb_build_object(
    'from', p_from,
    'to', p_to,
    'totals', jsonb_build_object(
      'payment_count', v_payment_count,
      'refund_count', v_refund_count,
      'captured_minor', v_captured,
      'refunded_minor', v_refunded,
      'net_minor', v_captured - v_refunded
    ),
    'methods', v_methods,
    'invoices', jsonb_build_object('issued', coalesce(v_issued, 0), 'voided', coalesce(v_voided, 0)),
    'mismatch_count', v_mismatch_count,
    'mismatches', (select coalesce(jsonb_agg(x), '[]'::jsonb)
                   from (select e.value as x from jsonb_array_elements(v_mismatches) e limit 50) s),
    'balanced', v_mismatch_count = 0
  );
end;
$$;

revoke all on function public.payment_reconciliation(uuid, uuid, timestamptz, timestamptz)
  from public, anon, authenticated;
grant execute on function public.payment_reconciliation(uuid, uuid, timestamptz, timestamptz) to service_role;

-- ── transition_order_status (Phase 8 contract + Phase 10 money rules) ─────
-- * completed requires the bill to be fully paid (net of refunds).
-- * cancelled is blocked while net paid > 0 (refund first).
-- * cancelling voids any issued invoice (number retained) and releases billing.
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

revoke all on function public.transition_order_status(uuid, uuid, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.transition_order_status(uuid, uuid, text, text) to service_role;

