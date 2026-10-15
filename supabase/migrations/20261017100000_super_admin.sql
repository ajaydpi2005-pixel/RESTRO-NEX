-- ─────────────────────────────────────────────────────────────────────────
-- Phase 19 — Super Admin, subscriptions, entitlements and support.
--
-- Platform data stays in the `platform` schema, which tenant roles cannot
-- reach. The Super Admin dashboard talks to it only through `public.admin_*`
-- RPCs, callable by the service role alone. Each one starts with
-- platform.require_operator(actor, permission), so the check holds even if
-- a caller skips the Next.js guards. Tenant support RPCs (`support_*`) check
-- membership through require_business_actor_permission.
--
-- Design decisions in this file:
--   * Suspension is enforced at membership level. Suspending a business sets
--     its active memberships to 'suspended'. A memberships trigger refuses to
--     set 'active' while the business is not active, so invite acceptance and
--     any direct write are covered. RLS helpers already require 'active'.
--   * Entitlements are enforced by triggers for 'integrations' (integration
--     accounts and jobs) and 'online_ordering' (orders with channel online or
--     qr). Other catalogue features are recorded and shown as 'recorded only'.
--   * The memberships self-update policy is narrowed to self-deactivation. A
--     member can no longer re-activate their own membership.
-- ─────────────────────────────────────────────────────────────────────────

-- ── 1. Operator roles ──────────────────────────────────────────────────────

alter table platform.super_admins
  add column if not exists role text not null default 'super_admin',
  add column if not exists revoked_at timestamptz,
  add column if not exists updated_at timestamptz not null default now();

alter table platform.super_admins drop constraint if exists super_admins_role_allowed;
alter table platform.super_admins add constraint super_admins_role_allowed
  check (role in ('super_admin', 'support', 'read_only'));

create trigger super_admins_set_updated_at
  before update on platform.super_admins
  for each row execute function public.set_updated_at();

create or replace function platform.operator_permissions(p_role text)
returns text[]
language sql
immutable
set search_path = ''
as $$
  select case p_role
    when 'super_admin' then array['view', 'support', 'plans', 'tenants', 'operators']::text[]
    when 'support' then array['view', 'support']::text[]
    when 'read_only' then array['view']::text[]
    else array[]::text[]
  end
$$;

-- Live lookup on every call, so a revoked operator loses access on the next request.
create or replace function platform.operator_role(p_user uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select sa.role
  from platform.super_admins sa
  where sa.user_id = p_user
    and sa.revoked_at is null
$$;

create or replace function platform.require_operator(p_actor uuid, p_permission text)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_role text;
begin
  if p_actor is null then
    raise exception 'Sign-in required.' using errcode = '42501';
  end if;
  v_role := platform.operator_role(p_actor);
  if v_role is null or not (p_permission = any (platform.operator_permissions(v_role))) then
    raise exception 'You do not have Super Admin access for this action.' using errcode = '42501';
  end if;
  return v_role;
end $$;

create or replace function platform.assert_not_last_super_admin(p_user uuid)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if exists (
    select 1 from platform.super_admins sa
    where sa.user_id = p_user and sa.role = 'super_admin' and sa.revoked_at is null
  ) and (
    select count(*) from platform.super_admins sa
    where sa.role = 'super_admin' and sa.revoked_at is null
  ) <= 1 then
    raise exception 'At least one active Super Admin must remain.' using errcode = 'P0001';
  end if;
end $$;

create or replace function platform.require_reason(p_reason text)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_reason text := btrim(coalesce(p_reason, ''));
begin
  if char_length(v_reason) < 3 or char_length(v_reason) > 300 then
    raise exception 'Enter a reason of 3 to 300 characters.' using errcode = 'P0001';
  end if;
  return v_reason;
end $$;

create or replace function platform.like_pattern(p_search text)
returns text
language sql
immutable
set search_path = ''
as $$
  select '%' || replace(replace(replace(btrim(coalesce(p_search, '')), '\', '\\'), '%', '\%'), '_', '\_') || '%'
$$;

-- ── 2. Admin audit trail (append-only, no grants) ──────────────────────────

-- No foreign keys on purpose: audit rows must survive user or business removal,
-- and the append-only trigger would turn ON DELETE SET NULL into an error.
create table platform.admin_audit_logs (
  id uuid primary key default gen_random_uuid(),
  actor_user_id uuid,
  actor_role text not null,
  action text not null
    constraint admin_audit_logs_action_format check (action ~ '^[a-z_]+\.[a-z_]+$'),
  target_type text not null
    constraint admin_audit_logs_target_type_length check (char_length(target_type) between 1 and 40),
  target_id text not null
    constraint admin_audit_logs_target_id_length check (char_length(target_id) between 1 and 80),
  business_id uuid,
  reason text not null
    constraint admin_audit_logs_reason_length check (char_length(reason) between 3 and 300),
  before_state jsonb,
  after_state jsonb,
  created_at timestamptz not null default now()
);

create index admin_audit_logs_created_idx on platform.admin_audit_logs (created_at desc);
create index admin_audit_logs_business_idx on platform.admin_audit_logs (business_id, created_at desc);

alter table platform.admin_audit_logs enable row level security;

create or replace function platform.admin_audit_append_only()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'Admin audit logs are append-only.' using errcode = '42501';
end $$;

create trigger admin_audit_logs_append_only
  before update or delete on platform.admin_audit_logs
  for each row execute function platform.admin_audit_append_only();

create or replace function platform.admin_audit_write(
  p_actor uuid,
  p_role text,
  p_action text,
  p_target_type text,
  p_target_id text,
  p_business_id uuid,
  p_reason text,
  p_before jsonb,
  p_after jsonb
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into platform.admin_audit_logs (
    actor_user_id, actor_role, action, target_type, target_id, business_id, reason,
    before_state, after_state
  ) values (
    p_actor, p_role, p_action, p_target_type, p_target_id, p_business_id, p_reason,
    public.audit_scrub(p_before), public.audit_scrub(p_after)
  );
end $$;

-- ── 3. Feature catalogue, plans and plan features ──────────────────────────

create function platform.default_trial_days()
returns integer
language sql
immutable
set search_path = ''
as $$
  select 14
$$;

create table platform.feature_catalog (
  feature_key text primary key
    constraint feature_catalog_key_format check (feature_key ~ '^[a-z_]+$'),
  label text not null,
  kind text not null
    constraint feature_catalog_kind_allowed check (kind in ('boolean', 'limit')),
  unit text,
  -- true only where the database refuses the feature (see the triggers in section 7).
  enforced boolean not null default false,
  description text not null,
  sort_order integer not null default 0
);

alter table platform.feature_catalog enable row level security;

insert into platform.feature_catalog (feature_key, label, kind, unit, enforced, description, sort_order) values
  ('outlets', 'Outlets', 'limit', 'outlets', false, 'Number of outlets the business can run.', 10),
  ('staff', 'Staff accounts', 'limit', 'people', false, 'Active staff memberships.', 20),
  ('pos_terminals', 'POS terminals', 'limit', 'terminals', false, 'Registered POS devices. Terminals are not modelled yet.', 30),
  ('storage_mb', 'Storage', 'limit', 'MB', false, 'Media and document storage. Storage is not metered yet.', 40),
  ('reports', 'Reports', 'boolean', null, false, 'Sales and operational reports.', 50),
  ('inventory', 'Inventory', 'boolean', null, false, 'Stock, recipes and purchasing.', 60),
  ('crm', 'Customers and loyalty', 'boolean', null, false, 'Customer records and loyalty points.', 70),
  ('online_ordering', 'Online ordering', 'boolean', null, true, 'Customer checkout and online or QR orders. Enforced in the database.', 80),
  ('integrations', 'Integrations', 'boolean', null, true, 'External integration connections and jobs. Enforced in the database.', 90);

alter table platform.subscription_plans add column if not exists sort_order integer not null default 0;

insert into platform.subscription_plans (code, name, description, is_active, sort_order) values
  ('STARTER', 'Starter', 'One outlet for a single restaurant.', true, 10),
  ('GROWTH', 'Growth', 'Multi-outlet restaurants with inventory, CRM, online ordering and integrations.', true, 20),
  ('SCALE', 'Scale', 'Larger groups with higher limits.', true, 30),
  ('ENTERPRISE', 'Enterprise', 'Custom groups. Limits are unlimited.', true, 40)
on conflict (code) do nothing;

alter table platform.plan_features drop constraint if exists plan_features_feature_fk;
alter table platform.plan_features add constraint plan_features_feature_fk
  foreign key (feature_key) references platform.feature_catalog (feature_key);

-- Placeholder limits. Confirmed by the product owner; edit any plan from the Plans page.
insert into platform.plan_features (plan_id, feature_key, included, limit_value)
select p.id, v.feature_key, v.included, v.limit_value
from (values
  ('STARTER', 'outlets', true, 1::bigint),
  ('STARTER', 'staff', true, 5::bigint),
  ('STARTER', 'pos_terminals', true, 1::bigint),
  ('STARTER', 'storage_mb', true, 1024::bigint),
  ('STARTER', 'reports', true, null::bigint),
  ('STARTER', 'inventory', false, null::bigint),
  ('STARTER', 'crm', false, null::bigint),
  ('STARTER', 'online_ordering', false, null::bigint),
  ('STARTER', 'integrations', false, null::bigint),
  ('GROWTH', 'outlets', true, 3::bigint),
  ('GROWTH', 'staff', true, 20::bigint),
  ('GROWTH', 'pos_terminals', true, 4::bigint),
  ('GROWTH', 'storage_mb', true, 5120::bigint),
  ('GROWTH', 'reports', true, null::bigint),
  ('GROWTH', 'inventory', true, null::bigint),
  ('GROWTH', 'crm', true, null::bigint),
  ('GROWTH', 'online_ordering', true, null::bigint),
  ('GROWTH', 'integrations', true, null::bigint),
  ('SCALE', 'outlets', true, 10::bigint),
  ('SCALE', 'staff', true, 75::bigint),
  ('SCALE', 'pos_terminals', true, 12::bigint),
  ('SCALE', 'storage_mb', true, 25600::bigint),
  ('SCALE', 'reports', true, null::bigint),
  ('SCALE', 'inventory', true, null::bigint),
  ('SCALE', 'crm', true, null::bigint),
  ('SCALE', 'online_ordering', true, null::bigint),
  ('SCALE', 'integrations', true, null::bigint),
  ('ENTERPRISE', 'outlets', true, null::bigint),
  ('ENTERPRISE', 'staff', true, null::bigint),
  ('ENTERPRISE', 'pos_terminals', true, null::bigint),
  ('ENTERPRISE', 'storage_mb', true, null::bigint),
  ('ENTERPRISE', 'reports', true, null::bigint),
  ('ENTERPRISE', 'inventory', true, null::bigint),
  ('ENTERPRISE', 'crm', true, null::bigint),
  ('ENTERPRISE', 'online_ordering', true, null::bigint),
  ('ENTERPRISE', 'integrations', true, null::bigint)
) as v(plan_code, feature_key, included, limit_value)
join platform.subscription_plans p on p.code = v.plan_code
on conflict (plan_id, feature_key) do nothing;

-- ── 4. Business subscriptions and feature overrides ────────────────────────

create table platform.business_subscriptions (
  business_id uuid primary key references public.businesses (id) on delete cascade,
  plan_id uuid not null references platform.subscription_plans (id),
  status text not null default 'trial'
    constraint business_subscriptions_status_allowed check (status in ('trial', 'active', 'past_due', 'cancelled')),
  trial_ends_at timestamptz,
  current_period_ends_at timestamptz,
  last_change_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint business_subscriptions_trial_has_end check (status <> 'trial' or trial_ends_at is not null)
);

create trigger business_subscriptions_set_updated_at
  before update on platform.business_subscriptions
  for each row execute function public.set_updated_at();

alter table platform.business_subscriptions enable row level security;

create table platform.business_feature_overrides (
  business_id uuid not null references public.businesses (id) on delete cascade,
  feature_key text not null references platform.feature_catalog (feature_key),
  included boolean,
  limit_value bigint
    constraint business_feature_overrides_limit_non_negative check (limit_value is null or limit_value >= 0),
  reason text not null
    constraint business_feature_overrides_reason_length check (char_length(reason) between 3 and 300),
  set_by uuid,
  updated_at timestamptz not null default now(),
  primary key (business_id, feature_key),
  constraint business_feature_overrides_has_value check (included is not null or limit_value is not null)
);

alter table platform.business_feature_overrides enable row level security;

-- Every business gets a subscription row when it is created.
create or replace function platform.provision_business_subscription()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into platform.business_subscriptions (business_id, plan_id, status, trial_ends_at)
  select new.id, p.id, 'trial', now() + make_interval(days => platform.default_trial_days())
  from platform.subscription_plans p
  where p.code = 'GROWTH'
  on conflict (business_id) do nothing;
  return new;
end $$;

create trigger businesses_provision_subscription
  after insert on public.businesses
  for each row execute function platform.provision_business_subscription();

-- Existing businesses (for example, a database created before this migration).
insert into platform.business_subscriptions (business_id, plan_id, status, trial_ends_at)
select b.id, p.id, 'trial', now() + make_interval(days => platform.default_trial_days())
from public.businesses b
cross join lateral (select id from platform.subscription_plans where code = 'GROWTH') p
on conflict (business_id) do nothing;

-- Effective entitlement. Override fields that are null fall back to the plan.
-- A business that is not active, or whose subscription is cancelled or missing,
-- gets nothing.
create or replace function platform.feature_entitlement(p_business_id uuid, p_feature text)
returns table (included boolean, limit_value bigint, source text)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_business_status text;
  v_sub_status text;
  v_plan_id uuid;
  v_plan_included boolean;
  v_plan_limit bigint;
  v_has_plan boolean := false;
  v_override_included boolean;
  v_override_limit bigint;
  v_has_override boolean := false;
begin
  select b.status, s.status, s.plan_id
    into v_business_status, v_sub_status, v_plan_id
  from public.businesses b
  left join platform.business_subscriptions s on s.business_id = b.id
  where b.id = p_business_id;

  select pf.included, pf.limit_value into v_plan_included, v_plan_limit
  from platform.plan_features pf
  where pf.plan_id = v_plan_id and pf.feature_key = p_feature;
  v_has_plan := found;

  select o.included, o.limit_value into v_override_included, v_override_limit
  from platform.business_feature_overrides o
  where o.business_id = p_business_id and o.feature_key = p_feature;
  v_has_override := found;

  included := coalesce(
    v_business_status = 'active'
    and v_sub_status in ('trial', 'active', 'past_due')
    and coalesce(v_override_included, v_plan_included, false),
    false
  );
  limit_value := coalesce(v_override_limit, v_plan_limit);
  source := case when v_has_override then 'override' when v_has_plan then 'plan' else 'none' end;
  return next;
end $$;

create or replace function platform.assert_feature(p_business_id uuid, p_feature text)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_included boolean;
  v_label text;
begin
  select e.included into v_included from platform.feature_entitlement(p_business_id, p_feature) e;
  if not coalesce(v_included, false) then
    select c.label into v_label from platform.feature_catalog c where c.feature_key = p_feature;
    raise exception '% is not included in this business''s plan.', coalesce(v_label, p_feature)
      using errcode = 'P0001';
  end if;
end $$;

create or replace function platform.plan_snapshot(p_plan_id uuid)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'code', p.code,
    'name', p.name,
    'is_active', p.is_active,
    'features', coalesce((
      select jsonb_agg(jsonb_build_object(
        'feature_key', pf.feature_key, 'included', pf.included, 'limit_value', pf.limit_value
      ) order by pf.feature_key)
      from platform.plan_features pf
      where pf.plan_id = p.id
    ), '[]'::jsonb)
  )
  from platform.subscription_plans p
  where p.id = p_plan_id
$$;

-- ── 5. Support tickets (operator-visible; notes hidden from tenants) ───────

create table platform.support_tickets (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  opened_by uuid references auth.users (id) on delete set null,
  subject text not null
    constraint support_tickets_subject_length check (char_length(subject) between 3 and 120),
  status text not null default 'open'
    constraint support_tickets_status_allowed check (status in ('open', 'waiting_customer', 'resolved')),
  priority text not null default 'normal'
    constraint support_tickets_priority_allowed check (priority in ('normal', 'urgent')),
  assigned_to uuid references auth.users (id) on delete set null,
  last_message_at timestamptz not null default now(),
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index support_tickets_queue_idx on platform.support_tickets (status, priority, last_message_at desc);
create index support_tickets_business_idx on platform.support_tickets (business_id, created_at desc);

create trigger support_tickets_set_updated_at
  before update on platform.support_tickets
  for each row execute function public.set_updated_at();

create table platform.support_ticket_messages (
  id uuid primary key default gen_random_uuid(),
  ticket_id uuid not null references platform.support_tickets (id) on delete cascade,
  author_user_id uuid references auth.users (id) on delete set null,
  author_side text not null
    constraint support_ticket_messages_side_allowed check (author_side in ('business', 'support', 'note')),
  body text not null
    constraint support_ticket_messages_body_length check (char_length(body) between 1 and 4000),
  created_at timestamptz not null default now()
);

create index support_ticket_messages_ticket_idx on platform.support_ticket_messages (ticket_id, created_at);

alter table platform.support_tickets enable row level security;
alter table platform.support_ticket_messages enable row level security;
alter table platform.admin_audit_logs enable row level security;

-- ── 6. Business and membership guards ──────────────────────────────────────

-- 'suspended' is set by a platform suspension and cleared only on reactivation.
alter table public.memberships drop constraint if exists memberships_status_allowed;
alter table public.memberships add constraint memberships_status_allowed
  check (status in ('active', 'invited', 'deactivated', 'suspended'));

-- Refuse to activate a membership while its business is not active. This covers
-- invite acceptance, which writes memberships directly.
create or replace function platform.guard_membership_business_active()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status = 'active' and (tg_op = 'INSERT' or old.status is distinct from new.status) then
    if not exists (
      select 1 from public.businesses b
      where b.id = new.business_id and b.status = 'active'
    ) then
      raise exception 'This business is suspended or closed.' using errcode = 'P0001';
    end if;
  end if;
  return new;
end $$;

create trigger memberships_guard_business_active
  before insert or update on public.memberships
  for each row execute function platform.guard_membership_business_active();

-- The self-service policy used to allow any status. Members may still leave a
-- business, but they can no longer re-activate their own membership.
drop policy if exists "membership_update_own_status" on public.memberships;
create policy "membership_leave_own"
  on public.memberships for update
  to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid() and status = 'deactivated');

-- ── 7. Entitlement triggers (enforced features) ────────────────────────────

create or replace function platform.guard_integration_feature()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform platform.assert_feature(new.business_id, 'integrations');
  return new;
end $$;

create trigger integration_accounts_guard_feature
  before insert on public.integration_accounts
  for each row execute function platform.guard_integration_feature();

create trigger integration_jobs_guard_feature
  before insert on public.integration_jobs
  for each row execute function platform.guard_integration_feature();

create or replace function platform.guard_online_channel_feature()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.channel in ('online', 'qr') then
    perform platform.assert_feature(new.business_id, 'online_ordering');
  end if;
  return new;
end $$;

create trigger orders_guard_online_feature
  before insert on public.orders
  for each row execute function platform.guard_online_channel_feature();

-- ── 8. Operator RPCs (service role only; each begins with require_operator) ─

create or replace function public.admin_health_ping(p_actor uuid)
returns timestamptz
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform platform.require_operator(p_actor, 'view');
  return now();
end $$;

create or replace function public.admin_operator_context(p_actor uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_role text := platform.operator_role(p_actor);
begin
  if v_role is null then
    return null;
  end if;
  return jsonb_build_object(
    'role', v_role,
    'permissions', to_jsonb(platform.operator_permissions(v_role))
  );
end $$;

create or replace function public.admin_operator_list(p_actor uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform platform.require_operator(p_actor, 'view');
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'user_id', sa.user_id,
      'email', u.email,
      'role', sa.role,
      'granted_at', sa.granted_at,
      'revoked_at', sa.revoked_at
    ) order by (sa.revoked_at is not null), sa.granted_at)
    from platform.super_admins sa
    left join auth.users u on u.id = sa.user_id
  ), '[]'::jsonb);
end $$;

create or replace function public.admin_operator_grant(
  p_actor uuid,
  p_email text,
  p_role text,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role text;
  v_reason text := platform.require_reason(p_reason);
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_target uuid;
  v_before jsonb;
begin
  v_role := platform.require_operator(p_actor, 'operators');
  if p_role not in ('super_admin', 'support', 'read_only') then
    raise exception 'Choose a valid operator role.' using errcode = 'P0001';
  end if;
  select u.id into v_target from auth.users u where lower(u.email) = v_email;
  if v_target is null then
    raise exception 'No account exists for that email yet. The person must sign up first.' using errcode = 'P0002';
  end if;
  if v_target = p_actor then
    raise exception 'You cannot change your own Super Admin access.' using errcode = 'P0001';
  end if;
  if p_role <> 'super_admin' then
    perform platform.assert_not_last_super_admin(v_target);
  end if;

  select jsonb_build_object('role', sa.role, 'revoked', sa.revoked_at is not null)
    into v_before
  from platform.super_admins sa
  where sa.user_id = v_target;

  insert into platform.super_admins (user_id, role, granted_by, granted_at, revoked_at)
  values (v_target, p_role, p_actor, now(), null)
  on conflict (user_id) do update
    set role = excluded.role,
        granted_by = excluded.granted_by,
        granted_at = excluded.granted_at,
        revoked_at = null;

  perform platform.admin_audit_write(
    p_actor, v_role, 'admin.operator_granted', 'operator', v_target::text, null, v_reason,
    v_before, jsonb_build_object('role', p_role, 'revoked', false)
  );
  return jsonb_build_object('user_id', v_target, 'role', p_role);
end $$;

create or replace function public.admin_operator_revoke(p_actor uuid, p_user uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role text;
  v_reason text := platform.require_reason(p_reason);
  v_target_role text;
begin
  v_role := platform.require_operator(p_actor, 'operators');
  if p_user = p_actor then
    raise exception 'You cannot revoke your own Super Admin access.' using errcode = 'P0001';
  end if;
  select sa.role into v_target_role
  from platform.super_admins sa
  where sa.user_id = p_user and sa.revoked_at is null;
  if not found then
    raise exception 'Operator not found.' using errcode = 'P0002';
  end if;
  perform platform.assert_not_last_super_admin(p_user);

  update platform.super_admins set revoked_at = now() where user_id = p_user;

  perform platform.admin_audit_write(
    p_actor, v_role, 'admin.operator_revoked', 'operator', p_user::text, null, v_reason,
    jsonb_build_object('role', v_target_role, 'revoked', false),
    jsonb_build_object('role', v_target_role, 'revoked', true)
  );
  return jsonb_build_object('user_id', p_user, 'revoked', true);
end $$;

-- Businesses ----------------------------------------------------------------

create or replace function public.admin_businesses_list(
  p_actor uuid,
  p_search text default null,
  p_status text default null,
  p_limit integer default 50,
  p_offset integer default 0
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_total bigint;
  v_rows jsonb;
  v_limit integer := least(greatest(coalesce(p_limit, 50), 1), 200);
  v_offset integer := greatest(coalesce(p_offset, 0), 0);
  v_search_active boolean := nullif(btrim(coalesce(p_search, '')), '') is not null;
  v_pattern text := platform.like_pattern(p_search);
begin
  perform platform.require_operator(p_actor, 'view');
  if p_status is not null and p_status not in ('active', 'suspended', 'closed') then
    raise exception 'Choose a valid business status.' using errcode = 'P0001';
  end if;

  with base as (
    select b.id, b.name, b.slug, b.status, b.created_at,
           s.status as subscription_status, s.trial_ends_at, p.code as plan_code
    from public.businesses b
    left join platform.business_subscriptions s on s.business_id = b.id
    left join platform.subscription_plans p on p.id = s.plan_id
    where (p_status is null or b.status = p_status)
      and (not v_search_active or b.name ilike v_pattern or b.slug ilike v_pattern)
  )
  select (select count(*) from base), (select coalesce(jsonb_agg(to_jsonb(x) order by x.created_at desc), '[]'::jsonb) from (
    select base.*,
      (select count(*) from public.outlets o where o.business_id = base.id) as outlet_count,
      (select count(*) from public.memberships m where m.business_id = base.id and m.status = 'active') as active_staff
    from base
    order by base.created_at desc
    limit v_limit offset v_offset
  ) x)
  into v_total, v_rows;

  return jsonb_build_object('total', v_total, 'rows', v_rows);
end $$;

create or replace function public.admin_business_detail(p_actor uuid, p_business_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_business jsonb;
begin
  perform platform.require_operator(p_actor, 'view');
  select to_jsonb(b) into v_business from public.businesses b where b.id = p_business_id;
  if v_business is null then
    raise exception 'Business not found.' using errcode = 'P0002';
  end if;

  return jsonb_build_object(
    'business', v_business,
    'subscription', (
      select jsonb_build_object(
        'plan_code', p.code, 'plan_name', p.name, 'status', s.status,
        'trial_ends_at', s.trial_ends_at, 'current_period_ends_at', s.current_period_ends_at,
        'last_change_reason', s.last_change_reason, 'updated_at', s.updated_at
      )
      from platform.business_subscriptions s
      join platform.subscription_plans p on p.id = s.plan_id
      where s.business_id = p_business_id
    ),
    'outlets', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', o.id, 'name', o.name, 'slug', o.slug, 'status', o.status,
        'currency_code', o.currency_code, 'timezone', o.timezone
      ) order by o.name)
      from public.outlets o where o.business_id = p_business_id
    ), '[]'::jsonb),
    'members', coalesce((
      select jsonb_agg(jsonb_build_object(
        'membership_id', m.id, 'user_id', m.user_id, 'email', up.email,
        'full_name', up.full_name, 'role', m.role, 'status', m.status, 'created_at', m.created_at
      ) order by m.created_at)
      from public.memberships m
      left join public.user_profiles up on up.id = m.user_id
      where m.business_id = p_business_id
    ), '[]'::jsonb),
    'entitlements', coalesce((
      select jsonb_agg(jsonb_build_object(
        'feature_key', c.feature_key, 'label', c.label, 'kind', c.kind, 'unit', c.unit,
        'enforced', c.enforced, 'included', e.included, 'limit_value', e.limit_value, 'source', e.source
      ) order by c.sort_order)
      from platform.feature_catalog c
      cross join lateral platform.feature_entitlement(p_business_id, c.feature_key) e
    ), '[]'::jsonb),
    'overrides', coalesce((
      select jsonb_agg(jsonb_build_object(
        'feature_key', o.feature_key, 'included', o.included, 'limit_value', o.limit_value,
        'reason', o.reason, 'updated_at', o.updated_at
      ) order by o.feature_key)
      from platform.business_feature_overrides o where o.business_id = p_business_id
    ), '[]'::jsonb),
    'usage_30d', platform.business_usage(p_business_id, now() - interval '30 days')
  );
end $$;

create or replace function platform.business_usage(p_business_id uuid, p_since timestamptz)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'since', p_since,
    'outlets', (select count(*) from public.outlets o where o.business_id = p_business_id),
    'active_staff', (select count(*) from public.memberships m where m.business_id = p_business_id and m.status = 'active'),
    'orders', (select count(*) from public.orders o where o.business_id = p_business_id and o.created_at >= p_since),
    'channel_orders', (select count(*) from public.orders o where o.business_id = p_business_id and o.channel in ('online', 'qr') and o.created_at >= p_since),
    'last_order_at', (select max(o.created_at) from public.orders o where o.business_id = p_business_id),
    'payments_captured', (select count(*) from public.payments p where p.business_id = p_business_id and p.status = 'captured' and p.created_at >= p_since),
    'payments_captured_minor_by_currency', coalesce((
      select jsonb_agg(to_jsonb(x) order by x.currency_code)
      from (
        select o.currency_code, sum(p.amount_minor)::bigint as minor
        from public.payments p
        join public.outlets o on o.id = p.outlet_id
        where p.business_id = p_business_id and p.status = 'captured' and p.created_at >= p_since
        group by o.currency_code
      ) x
    ), '[]'::jsonb),
    'integration_jobs', (select count(*) from public.integration_jobs j where j.business_id = p_business_id and j.created_at >= p_since),
    'integration_jobs_dead', (select count(*) from public.integration_jobs j where j.business_id = p_business_id and j.status = 'dead' and j.updated_at >= p_since),
    'customers_all_time', (select count(*) from public.customers c where c.business_id = p_business_id),
    'open_support_tickets', (select count(*) from platform.support_tickets t where t.business_id = p_business_id and t.status <> 'resolved')
  )
$$;

create or replace function public.admin_business_set_status(
  p_actor uuid,
  p_business_id uuid,
  p_status text,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role text;
  v_reason text := platform.require_reason(p_reason);
  v_before text;
  v_changed integer := 0;
begin
  v_role := platform.require_operator(p_actor, 'tenants');
  if p_status not in ('active', 'suspended') then
    raise exception 'Choose active or suspended.' using errcode = 'P0001';
  end if;

  select b.status into v_before from public.businesses b where b.id = p_business_id for update;
  if not found then
    raise exception 'Business not found.' using errcode = 'P0002';
  end if;
  if v_before = 'closed' then
    raise exception 'A closed business cannot be changed here.' using errcode = 'P0001';
  end if;
  if v_before = p_status then
    raise exception 'The business is already %.', p_status using errcode = 'P0001';
  end if;

  update public.businesses set status = p_status where id = p_business_id;

  if p_status = 'suspended' then
    update public.memberships set status = 'suspended'
    where business_id = p_business_id and status = 'active';
  else
    update public.memberships set status = 'active'
    where business_id = p_business_id and status = 'suspended';
  end if;
  get diagnostics v_changed = row_count;

  perform platform.admin_audit_write(
    p_actor, v_role, 'admin.business_status_changed', 'business', p_business_id::text, p_business_id, v_reason,
    jsonb_build_object('status', v_before),
    jsonb_build_object('status', p_status, 'memberships_changed', v_changed)
  );
  return jsonb_build_object('status', p_status, 'memberships_changed', v_changed);
end $$;

create or replace function public.admin_membership_deactivate(
  p_actor uuid,
  p_membership_id uuid,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role text;
  v_reason text := platform.require_reason(p_reason);
  v_business uuid;
  v_member_role text;
  v_status text;
begin
  v_role := platform.require_operator(p_actor, 'tenants');
  select m.business_id, m.role, m.status into v_business, v_member_role, v_status
  from public.memberships m
  where m.id = p_membership_id
  for update;
  if not found then
    raise exception 'Membership not found.' using errcode = 'P0002';
  end if;
  if v_status = 'deactivated' then
    raise exception 'This membership is already deactivated.' using errcode = 'P0001';
  end if;
  if v_member_role = 'owner' and v_status = 'active' and (
    select count(*) from public.memberships m2
    where m2.business_id = v_business and m2.role = 'owner' and m2.status = 'active'
  ) <= 1 then
    raise exception 'A business must keep at least one active owner.' using errcode = 'P0001';
  end if;

  update public.memberships set status = 'deactivated' where id = p_membership_id;

  perform platform.admin_audit_write(
    p_actor, v_role, 'admin.membership_deactivated', 'membership', p_membership_id::text, v_business, v_reason,
    jsonb_build_object('status', v_status, 'role', v_member_role),
    jsonb_build_object('status', 'deactivated', 'role', v_member_role)
  );
  return jsonb_build_object('membership_id', p_membership_id, 'status', 'deactivated');
end $$;

-- Outlets and users (read-only) ---------------------------------------------

create or replace function public.admin_outlets_list(
  p_actor uuid,
  p_search text default null,
  p_limit integer default 50,
  p_offset integer default 0
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_total bigint;
  v_rows jsonb;
  v_limit integer := least(greatest(coalesce(p_limit, 50), 1), 200);
  v_offset integer := greatest(coalesce(p_offset, 0), 0);
  v_search_active boolean := nullif(btrim(coalesce(p_search, '')), '') is not null;
  v_pattern text := platform.like_pattern(p_search);
begin
  perform platform.require_operator(p_actor, 'view');

  with base as (
    select o.id, o.name, o.slug, o.status, o.currency_code, o.timezone, o.created_at,
           o.business_id, b.name as business_name, b.status as business_status
    from public.outlets o
    join public.businesses b on b.id = o.business_id
    where (not v_search_active or o.name ilike v_pattern or b.name ilike v_pattern)
  )
  select (select count(*) from base), (select coalesce(jsonb_agg(to_jsonb(x) order by x.business_name, x.name), '[]'::jsonb) from (select * from base order by business_name, name limit v_limit offset v_offset) x)
  into v_total, v_rows;

  return jsonb_build_object('total', v_total, 'rows', v_rows);
end $$;

create or replace function public.admin_users_list(
  p_actor uuid,
  p_search text default null,
  p_limit integer default 50,
  p_offset integer default 0
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_total bigint;
  v_rows jsonb;
  v_limit integer := least(greatest(coalesce(p_limit, 50), 1), 200);
  v_offset integer := greatest(coalesce(p_offset, 0), 0);
  v_search_active boolean := nullif(btrim(coalesce(p_search, '')), '') is not null;
  v_pattern text := platform.like_pattern(p_search);
begin
  perform platform.require_operator(p_actor, 'view');

  with base as (
    select u.id, u.email, u.created_at, u.last_sign_in_at, up.full_name
    from auth.users u
    left join public.user_profiles up on up.id = u.id
    where (not v_search_active or u.email ilike v_pattern or up.full_name ilike v_pattern)
  )
  select (select count(*) from base), (select coalesce(jsonb_agg(to_jsonb(x) order by x.created_at desc), '[]'::jsonb) from (
    select base.id, base.email, base.full_name, base.created_at, base.last_sign_in_at,
      (select count(*) from public.memberships m where m.user_id = base.id and m.status = 'active') as active_memberships,
      (select sa.role from platform.super_admins sa where sa.user_id = base.id and sa.revoked_at is null) as operator_role
    from base
    order by base.created_at desc
    limit v_limit offset v_offset
  ) x)
  into v_total, v_rows;

  return jsonb_build_object('total', v_total, 'rows', v_rows);
end $$;

create or replace function public.admin_user_detail(p_actor uuid, p_user_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_user jsonb;
begin
  perform platform.require_operator(p_actor, 'view');
  select jsonb_build_object(
    'id', u.id, 'email', u.email, 'created_at', u.created_at,
    'last_sign_in_at', u.last_sign_in_at, 'full_name', up.full_name, 'phone', up.phone
  ) into v_user
  from auth.users u
  left join public.user_profiles up on up.id = u.id
  where u.id = p_user_id;
  if v_user is null then
    raise exception 'User not found.' using errcode = 'P0002';
  end if;

  return jsonb_build_object(
    'user', v_user,
    'operator', (
      select jsonb_build_object('role', sa.role, 'revoked', sa.revoked_at is not null)
      from platform.super_admins sa where sa.user_id = p_user_id
    ),
    'memberships', coalesce((
      select jsonb_agg(jsonb_build_object(
        'membership_id', m.id, 'business_id', m.business_id, 'business_name', b.name,
        'role', m.role, 'status', m.status, 'created_at', m.created_at
      ) order by b.name)
      from public.memberships m join public.businesses b on b.id = m.business_id
      where m.user_id = p_user_id
    ), '[]'::jsonb)
  );
end $$;

-- Plans, subscriptions and overrides ----------------------------------------

create or replace function public.admin_plans_list(p_actor uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform platform.require_operator(p_actor, 'view');
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'code', p.code,
      'name', p.name,
      'description', p.description,
      'is_active', p.is_active,
      'businesses', (select count(*) from platform.business_subscriptions s where s.plan_id = p.id),
      'features', (
        select jsonb_agg(jsonb_build_object(
          'feature_key', c.feature_key, 'label', c.label, 'kind', c.kind, 'unit', c.unit,
          'enforced', c.enforced, 'included', coalesce(pf.included, false), 'limit_value', pf.limit_value
        ) order by c.sort_order)
        from platform.feature_catalog c
        left join platform.plan_features pf on pf.plan_id = p.id and pf.feature_key = c.feature_key
      )
    ) order by p.sort_order, p.code)
    from platform.subscription_plans p
  ), '[]'::jsonb);
end $$;

create or replace function public.admin_plan_save(
  p_actor uuid,
  p_code text,
  p_name text,
  p_description text,
  p_is_active boolean,
  p_features jsonb,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role text;
  v_reason text := platform.require_reason(p_reason);
  v_code text := upper(btrim(coalesce(p_code, '')));
  v_name text := btrim(coalesce(p_name, ''));
  v_plan_id uuid;
  v_before jsonb;
  v_after jsonb;
begin
  v_role := platform.require_operator(p_actor, 'plans');

  if v_code !~ '^[A-Z][A-Z_]{1,29}$' then
    raise exception 'Plan codes use capital letters and underscores (2 to 30 characters).' using errcode = 'P0001';
  end if;
  if char_length(v_name) not between 2 and 60 then
    raise exception 'Plan name must be 2 to 60 characters.' using errcode = 'P0001';
  end if;
  if p_features is null or jsonb_typeof(p_features) <> 'array' then
    raise exception 'Features must be a list.' using errcode = 'P0001';
  end if;
  if exists (
    select 1
    from jsonb_to_recordset(p_features) as f(feature_key text, included boolean, limit_value bigint)
    left join platform.feature_catalog c on c.feature_key = f.feature_key
    where c.feature_key is null
  ) then
    raise exception 'The plan lists a feature that does not exist.' using errcode = 'P0001';
  end if;
  if exists (
    select f.feature_key
    from jsonb_to_recordset(p_features) as f(feature_key text, included boolean, limit_value bigint)
    group by f.feature_key
    having count(*) > 1
  ) then
    raise exception 'Each feature can appear only once per plan.' using errcode = 'P0001';
  end if;
  if exists (
    select 1
    from jsonb_to_recordset(p_features) as f(feature_key text, included boolean, limit_value bigint)
    join platform.feature_catalog c on c.feature_key = f.feature_key
    where f.included is null
       or (f.limit_value is not null and f.limit_value < 0)
       or (c.kind = 'boolean' and f.limit_value is not null)
  ) then
    raise exception 'Each feature needs included true or false. Limits must be zero or more, and boolean features have no limit.' using errcode = 'P0001';
  end if;

  select p.id into v_plan_id from platform.subscription_plans p where p.code = v_code;
  if v_plan_id is null then
    insert into platform.subscription_plans (code, name, description, is_active, sort_order)
    values (v_code, v_name, nullif(btrim(coalesce(p_description, '')), ''), coalesce(p_is_active, true), 50)
    returning id into v_plan_id;
    v_before := null;
  else
    v_before := platform.plan_snapshot(v_plan_id);
    update platform.subscription_plans
    set name = v_name,
        description = nullif(btrim(coalesce(p_description, '')), ''),
        is_active = coalesce(p_is_active, is_active)
    where id = v_plan_id;
  end if;

  delete from platform.plan_features where plan_id = v_plan_id;
  insert into platform.plan_features (plan_id, feature_key, included, limit_value)
  select v_plan_id, f.feature_key, f.included, f.limit_value
  from jsonb_to_recordset(p_features) as f(feature_key text, included boolean, limit_value bigint);

  v_after := platform.plan_snapshot(v_plan_id);
  perform platform.admin_audit_write(
    p_actor, v_role, 'admin.plan_saved', 'plan', v_code, null, v_reason, v_before, v_after
  );
  return jsonb_build_object('code', v_code, 'id', v_plan_id);
end $$;

create or replace function public.admin_subscriptions_list(
  p_actor uuid,
  p_status text default null,
  p_limit integer default 50,
  p_offset integer default 0
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_total bigint;
  v_rows jsonb;
  v_limit integer := least(greatest(coalesce(p_limit, 50), 1), 200);
  v_offset integer := greatest(coalesce(p_offset, 0), 0);
begin
  perform platform.require_operator(p_actor, 'view');
  if p_status is not null and p_status not in ('trial', 'active', 'past_due', 'cancelled') then
    raise exception 'Choose a valid subscription status.' using errcode = 'P0001';
  end if;

  with base as (
    select b.id as business_id, b.name as business_name, b.status as business_status,
           p.code as plan_code, s.status, s.trial_ends_at, s.current_period_ends_at,
           s.last_change_reason, s.updated_at,
           (s.status = 'trial' and s.trial_ends_at <= now() + interval '7 days') as trial_ending_soon
    from platform.business_subscriptions s
    join public.businesses b on b.id = s.business_id
    join platform.subscription_plans p on p.id = s.plan_id
    where p_status is null or s.status = p_status
  )
  select (select count(*) from base), (select coalesce(jsonb_agg(to_jsonb(x) order by x.trial_ending_soon desc, x.business_name), '[]'::jsonb) from (select * from base order by trial_ending_soon desc, business_name limit v_limit offset v_offset) x)
  into v_total, v_rows;

  return jsonb_build_object(
    'total', v_total,
    'counts', jsonb_build_object(
      'trial', (select count(*) from platform.business_subscriptions where status = 'trial'),
      'active', (select count(*) from platform.business_subscriptions where status = 'active'),
      'past_due', (select count(*) from platform.business_subscriptions where status = 'past_due'),
      'cancelled', (select count(*) from platform.business_subscriptions where status = 'cancelled'),
      'businesses_without_subscription', (
        select count(*) from public.businesses b
        where not exists (select 1 from platform.business_subscriptions s where s.business_id = b.id)
      )
    ),
    'rows', v_rows
  );
end $$;

create or replace function public.admin_subscription_set(
  p_actor uuid,
  p_business_id uuid,
  p_plan_code text,
  p_status text,
  p_trial_ends_at timestamptz,
  p_period_ends_at timestamptz,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role text;
  v_reason text := platform.require_reason(p_reason);
  v_plan_id uuid;
  v_plan_active boolean;
  v_before jsonb;
  v_after jsonb;
begin
  v_role := platform.require_operator(p_actor, 'plans');
  if p_status not in ('trial', 'active', 'past_due', 'cancelled') then
    raise exception 'Choose a valid subscription status.' using errcode = 'P0001';
  end if;
  if p_status = 'trial' and p_trial_ends_at is null then
    raise exception 'A trial needs an end date.' using errcode = 'P0001';
  end if;
  if not exists (select 1 from public.businesses b where b.id = p_business_id) then
    raise exception 'Business not found.' using errcode = 'P0002';
  end if;

  select p.id, p.is_active into v_plan_id, v_plan_active
  from platform.subscription_plans p
  where p.code = upper(btrim(coalesce(p_plan_code, '')));
  if v_plan_id is null then
    raise exception 'Plan not found.' using errcode = 'P0002';
  end if;
  if not v_plan_active then
    raise exception 'That plan is inactive and cannot be assigned.' using errcode = 'P0001';
  end if;

  select jsonb_build_object(
    'plan_code', p.code, 'status', s.status,
    'trial_ends_at', s.trial_ends_at, 'current_period_ends_at', s.current_period_ends_at
  ) into v_before
  from platform.business_subscriptions s
  join platform.subscription_plans p on p.id = s.plan_id
  where s.business_id = p_business_id;

  insert into platform.business_subscriptions (
    business_id, plan_id, status, trial_ends_at, current_period_ends_at, last_change_reason
  ) values (
    p_business_id, v_plan_id, p_status, p_trial_ends_at, p_period_ends_at, v_reason
  )
  on conflict (business_id) do update
    set plan_id = excluded.plan_id,
        status = excluded.status,
        trial_ends_at = excluded.trial_ends_at,
        current_period_ends_at = excluded.current_period_ends_at,
        last_change_reason = excluded.last_change_reason;

  v_after := jsonb_build_object(
    'plan_code', upper(btrim(p_plan_code)), 'status', p_status,
    'trial_ends_at', p_trial_ends_at, 'current_period_ends_at', p_period_ends_at
  );
  perform platform.admin_audit_write(
    p_actor, v_role, 'admin.subscription_changed', 'subscription', p_business_id::text, p_business_id, v_reason,
    v_before, v_after
  );
  return v_after;
end $$;

create or replace function public.admin_entitlement_override_set(
  p_actor uuid,
  p_business_id uuid,
  p_feature_key text,
  p_included boolean,
  p_limit_value bigint,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role text;
  v_reason text := platform.require_reason(p_reason);
  v_kind text;
  v_before jsonb;
  v_after jsonb;
begin
  v_role := platform.require_operator(p_actor, 'plans');

  select c.kind into v_kind from platform.feature_catalog c where c.feature_key = p_feature_key;
  if not found then
    raise exception 'Feature not found.' using errcode = 'P0002';
  end if;
  if not exists (select 1 from public.businesses b where b.id = p_business_id) then
    raise exception 'Business not found.' using errcode = 'P0002';
  end if;
  if v_kind = 'boolean' and p_limit_value is not null then
    raise exception 'Boolean features cannot have a limit.' using errcode = 'P0001';
  end if;
  if p_limit_value is not null and p_limit_value < 0 then
    raise exception 'A limit cannot be negative.' using errcode = 'P0001';
  end if;

  select jsonb_build_object('included', o.included, 'limit_value', o.limit_value) into v_before
  from platform.business_feature_overrides o
  where o.business_id = p_business_id and o.feature_key = p_feature_key;

  if p_included is null and p_limit_value is null then
    delete from platform.business_feature_overrides
    where business_id = p_business_id and feature_key = p_feature_key;
    v_after := null;
  else
    insert into platform.business_feature_overrides (
      business_id, feature_key, included, limit_value, reason, set_by, updated_at
    ) values (
      p_business_id, p_feature_key, p_included, p_limit_value, v_reason, p_actor, now()
    )
    on conflict (business_id, feature_key) do update
      set included = excluded.included,
          limit_value = excluded.limit_value,
          reason = excluded.reason,
          set_by = excluded.set_by,
          updated_at = excluded.updated_at;
    v_after := jsonb_build_object('included', p_included, 'limit_value', p_limit_value);
  end if;

  perform platform.admin_audit_write(
    p_actor, v_role, 'admin.override_changed', 'feature', p_feature_key, p_business_id, v_reason, v_before, v_after
  );
  return coalesce(v_after, jsonb_build_object('cleared', true));
end $$;

create or replace function public.admin_overrides_list(p_actor uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform platform.require_operator(p_actor, 'view');
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'business_id', o.business_id, 'business_name', b.name, 'feature_key', o.feature_key,
      'label', c.label, 'included', o.included, 'limit_value', o.limit_value,
      'reason', o.reason, 'updated_at', o.updated_at
    ) order by b.name, c.sort_order)
    from platform.business_feature_overrides o
    join public.businesses b on b.id = o.business_id
    join platform.feature_catalog c on c.feature_key = o.feature_key
  ), '[]'::jsonb);
end $$;

-- Usage, platform health and integration health -----------------------------

create or replace function public.admin_usage_overview(p_actor uuid, p_days integer default 30)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_days integer := least(greatest(coalesce(p_days, 30), 1), 365);
  v_since timestamptz := now() - make_interval(days => least(greatest(coalesce(p_days, 30), 1), 365));
begin
  perform platform.require_operator(p_actor, 'view');
  return jsonb_build_object(
    'window_days', v_days,
    'since', v_since,
    'measured_at', now(),
    'totals', jsonb_build_object(
      'businesses', (select count(*) from public.businesses),
      'outlets', (select count(*) from public.outlets),
      'active_staff', (select count(*) from public.memberships where status = 'active'),
      'orders', (select count(*) from public.orders where created_at >= v_since),
      'channel_orders', (select count(*) from public.orders where channel in ('online', 'qr') and created_at >= v_since),
      'payments_captured', (select count(*) from public.payments where status = 'captured' and created_at >= v_since),
      'payments_captured_minor_by_currency', coalesce((
        select jsonb_agg(to_jsonb(x) order by x.currency_code)
        from (
          select o.currency_code, sum(p.amount_minor)::bigint as minor
          from public.payments p join public.outlets o on o.id = p.outlet_id
          where p.status = 'captured' and p.created_at >= v_since
          group by o.currency_code
        ) x
      ), '[]'::jsonb),
      'integration_jobs', (select count(*) from public.integration_jobs where created_at >= v_since),
      'customers_all_time', (select count(*) from public.customers)
    ),
    'businesses', coalesce((
      select jsonb_agg(to_jsonb(x) order by (x.usage->>'orders')::bigint desc, x.name)
      from (
        select b.id, b.name, b.status,
               platform.business_usage(b.id, v_since) as usage,
               (select e.limit_value from platform.feature_entitlement(b.id, 'outlets') e) as outlets_limit,
               (select e.limit_value from platform.feature_entitlement(b.id, 'staff') e) as staff_limit
        from public.businesses b
        order by b.created_at desc
        limit 200
      ) x
    ), '[]'::jsonb)
  );
end $$;

create or replace function public.admin_platform_health(p_actor uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_day interval := interval '24 hours';
begin
  perform platform.require_operator(p_actor, 'view');
  return jsonb_build_object(
    'measured_at', now(),
    'businesses', (
      select jsonb_build_object(
        'active', count(*) filter (where b.status = 'active'),
        'suspended', count(*) filter (where b.status = 'suspended'),
        'closed', count(*) filter (where b.status = 'closed')
      ) from public.businesses b
    ),
    'subscriptions', jsonb_build_object(
      'trial', (select count(*) from platform.business_subscriptions where status = 'trial'),
      'active', (select count(*) from platform.business_subscriptions where status = 'active'),
      'past_due', (select count(*) from platform.business_subscriptions where status = 'past_due'),
      'cancelled', (select count(*) from platform.business_subscriptions where status = 'cancelled'),
      'trial_ending_7d', (select count(*) from platform.business_subscriptions where status = 'trial' and trial_ends_at <= now() + interval '7 days')
    ),
    'integrations', jsonb_build_object(
      'accounts_total', (select count(*) from public.integration_accounts),
      'accounts_in_error', (select count(*) from public.integration_accounts where status = 'error'),
      'accounts_live_enabled', (select count(*) from public.integration_accounts where mode = 'live' and enabled),
      'accounts_demo_enabled', (select count(*) from public.integration_accounts where mode = 'demo' and enabled),
      'jobs_pending', (select count(*) from public.integration_jobs where status = 'pending'),
      'jobs_running', (select count(*) from public.integration_jobs where status = 'running'),
      'jobs_dead', (select count(*) from public.integration_jobs where status = 'dead'),
      'oldest_due_job_seconds', (
        select extract(epoch from now() - min(j.next_attempt_at))::bigint
        from public.integration_jobs j
        where j.status = 'pending' and j.next_attempt_at <= now()
      ),
      'attempts_failed_24h', (select count(*) from public.integration_logs l where l.outcome in ('failed', 'exhausted') and l.created_at >= now() - v_day),
      'attempts_retry_scheduled_24h', (select count(*) from public.integration_logs l where l.outcome = 'retry_scheduled' and l.created_at >= now() - v_day)
    ),
    'webhooks', jsonb_build_object(
      'last_received_at', greatest(
        (select max(w.received_at) from public.webhook_events w),
        (select max(p.received_at) from public.payment_webhook_events p)
      ),
      'received_24h', (select count(*) from public.webhook_events w where w.received_at >= now() - v_day)
                    + (select count(*) from public.payment_webhook_events p where p.received_at >= now() - v_day),
      'failed_24h', (select count(*) from public.webhook_events w where w.status = 'failed' and w.received_at >= now() - v_day)
                  + (select count(*) from public.payment_webhook_events p where p.status = 'failed' and p.received_at >= now() - v_day)
    ),
    'agents', jsonb_build_object(
      'registered', (select count(*) from public.integration_agents where revoked_at is null),
      'online_5m', (select count(*) from public.integration_agents where revoked_at is null and last_seen_at >= now() - interval '5 minutes'),
      'revoked', (select count(*) from public.integration_agents where revoked_at is not null)
    ),
    'support', jsonb_build_object(
      'open', (select count(*) from platform.support_tickets where status = 'open'),
      'waiting_customer', (select count(*) from platform.support_tickets where status = 'waiting_customer'),
      'urgent_unresolved', (select count(*) from platform.support_tickets where priority = 'urgent' and status <> 'resolved')
    ),
    'admin_actions_24h', (select count(*) from platform.admin_audit_logs where created_at >= now() - v_day),
    'tenant_audit_events_24h', (select count(*) from public.audit_logs where created_at >= now() - v_day)
  );
end $$;

create or replace function public.admin_integration_health(
  p_actor uuid,
  p_limit integer default 100
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_limit integer := least(greatest(coalesce(p_limit, 100), 1), 500);
begin
  perform platform.require_operator(p_actor, 'view');
  return jsonb_build_object(
    'accounts', coalesce((
      select jsonb_agg(to_jsonb(x) order by (x.status = 'error') desc, x.business_name, x.provider)
      from (
        select a.id, a.business_id, b.name as business_name, a.outlet_id, o.name as outlet_name,
               a.provider, a.mode, a.enabled, a.status, a.last_tested_at, a.last_success_at, a.last_error,
               (select count(*) from public.integration_jobs j where j.account_id = a.id and j.status = 'pending') as pending_jobs,
               (select count(*) from public.integration_jobs j where j.account_id = a.id and j.status = 'dead') as dead_jobs,
               (select count(*) from public.integration_logs l
                 where l.account_id = a.id and l.outcome in ('failed', 'exhausted')
                   and l.created_at >= now() - interval '24 hours') as failed_attempts_24h
        from public.integration_accounts a
        join public.businesses b on b.id = a.business_id
        left join public.outlets o on o.id = a.outlet_id
        limit v_limit
      ) x
    ), '[]'::jsonb),
    'agents', coalesce((
      select jsonb_agg(to_jsonb(x) order by x.business_name, x.name)
      from (
        select g.id, g.business_id, b.name as business_name, g.outlet_id, o.name as outlet_name,
               g.name, g.created_at, g.last_seen_at, g.revoked_at,
               case
                 when g.revoked_at is not null then 'revoked'
                 when g.last_seen_at >= now() - interval '5 minutes' then 'online'
                 else 'offline'
               end as state
        from public.integration_agents g
        join public.businesses b on b.id = g.business_id
        left join public.outlets o on o.id = g.outlet_id
        limit v_limit
      ) x
    ), '[]'::jsonb)
  );
end $$;

-- Support queue (operator side) ---------------------------------------------

create or replace function public.admin_support_queue(
  p_actor uuid,
  p_status text default null,
  p_limit integer default 50,
  p_offset integer default 0
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_total bigint;
  v_rows jsonb;
  v_limit integer := least(greatest(coalesce(p_limit, 50), 1), 200);
  v_offset integer := greatest(coalesce(p_offset, 0), 0);
begin
  perform platform.require_operator(p_actor, 'view');
  if p_status is not null and p_status not in ('open', 'waiting_customer', 'resolved') then
    raise exception 'Choose a valid ticket status.' using errcode = 'P0001';
  end if;

  with base as (
    select t.id, t.business_id, b.name as business_name, t.subject, t.status, t.priority,
           t.assigned_to, t.last_message_at, t.created_at,
           (select count(*) from platform.support_ticket_messages m where m.ticket_id = t.id) as message_count
    from platform.support_tickets t
    join public.businesses b on b.id = t.business_id
    where p_status is null or t.status = p_status
  )
  select (select count(*) from base), (select coalesce(jsonb_agg(to_jsonb(x) order by x.priority = 'urgent' desc, x.last_message_at desc), '[]'::jsonb) from (select * from base order by priority = 'urgent' desc, last_message_at desc limit v_limit offset v_offset) x)
  into v_total, v_rows;

  return jsonb_build_object(
    'total', v_total,
    'counts', jsonb_build_object(
      'open', (select count(*) from platform.support_tickets where status = 'open'),
      'waiting_customer', (select count(*) from platform.support_tickets where status = 'waiting_customer'),
      'resolved', (select count(*) from platform.support_tickets where status = 'resolved'),
      'urgent_unresolved', (select count(*) from platform.support_tickets where priority = 'urgent' and status <> 'resolved')
    ),
    'rows', v_rows
  );
end $$;

create or replace function public.admin_support_ticket(p_actor uuid, p_ticket_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_ticket jsonb;
begin
  perform platform.require_operator(p_actor, 'view');
  select jsonb_build_object(
    'id', t.id, 'business_id', t.business_id, 'business_name', b.name,
    'subject', t.subject, 'status', t.status, 'priority', t.priority,
    'assigned_to', t.assigned_to, 'assigned_email', au.email,
    'opened_by_email', ou.email, 'created_at', t.created_at, 'last_message_at', t.last_message_at,
    'resolved_at', t.resolved_at
  ) into v_ticket
  from platform.support_tickets t
  join public.businesses b on b.id = t.business_id
  left join auth.users au on au.id = t.assigned_to
  left join auth.users ou on ou.id = t.opened_by
  where t.id = p_ticket_id;
  if v_ticket is null then
    raise exception 'Ticket not found.' using errcode = 'P0002';
  end if;

  return jsonb_build_object(
    'ticket', v_ticket,
    'messages', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', m.id, 'author_side', m.author_side, 'author_email', u.email,
        'body', m.body, 'created_at', m.created_at
      ) order by m.created_at)
      from platform.support_ticket_messages m
      left join auth.users u on u.id = m.author_user_id
      where m.ticket_id = p_ticket_id
    ), '[]'::jsonb)
  );
end $$;

create or replace function public.admin_support_reply(p_actor uuid, p_ticket_id uuid, p_body text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role text;
  v_business uuid;
  v_body text := btrim(coalesce(p_body, ''));
begin
  v_role := platform.require_operator(p_actor, 'support');
  if char_length(v_body) not between 1 and 4000 then
    raise exception 'A reply needs between 1 and 4000 characters.' using errcode = 'P0001';
  end if;
  select t.business_id into v_business from platform.support_tickets t where t.id = p_ticket_id for update;
  if not found then
    raise exception 'Ticket not found.' using errcode = 'P0002';
  end if;

  insert into platform.support_ticket_messages (ticket_id, author_user_id, author_side, body)
  values (p_ticket_id, p_actor, 'support', v_body);

  update platform.support_tickets
  set status = 'waiting_customer', last_message_at = now(), resolved_at = null
  where id = p_ticket_id;

  perform platform.admin_audit_write(
    p_actor, v_role, 'admin.support_replied', 'support_ticket', p_ticket_id::text, v_business,
    'Support ticket activity', null, jsonb_build_object('status', 'waiting_customer')
  );
  return jsonb_build_object('ticket_id', p_ticket_id, 'status', 'waiting_customer');
end $$;

create or replace function public.admin_support_note(p_actor uuid, p_ticket_id uuid, p_body text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role text;
  v_business uuid;
  v_body text := btrim(coalesce(p_body, ''));
begin
  v_role := platform.require_operator(p_actor, 'support');
  if char_length(v_body) not between 1 and 4000 then
    raise exception 'A note needs between 1 and 4000 characters.' using errcode = 'P0001';
  end if;
  select t.business_id into v_business from platform.support_tickets t where t.id = p_ticket_id;
  if not found then
    raise exception 'Ticket not found.' using errcode = 'P0002';
  end if;

  insert into platform.support_ticket_messages (ticket_id, author_user_id, author_side, body)
  values (p_ticket_id, p_actor, 'note', v_body);

  perform platform.admin_audit_write(
    p_actor, v_role, 'admin.support_noted', 'support_ticket', p_ticket_id::text, v_business,
    'Support ticket activity', null, null
  );
  return jsonb_build_object('ticket_id', p_ticket_id);
end $$;

create or replace function public.admin_support_update(
  p_actor uuid,
  p_ticket_id uuid,
  p_status text,
  p_priority text,
  p_assign_to_me boolean
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role text;
  v_before platform.support_tickets%rowtype;
  v_after platform.support_tickets%rowtype;
begin
  v_role := platform.require_operator(p_actor, 'support');
  if p_status not in ('open', 'waiting_customer', 'resolved') then
    raise exception 'Choose a valid ticket status.' using errcode = 'P0001';
  end if;
  if p_priority not in ('normal', 'urgent') then
    raise exception 'Choose a valid priority.' using errcode = 'P0001';
  end if;

  select * into v_before from platform.support_tickets t where t.id = p_ticket_id for update;
  if not found then
    raise exception 'Ticket not found.' using errcode = 'P0002';
  end if;

  update platform.support_tickets
  set status = p_status,
      priority = p_priority,
      assigned_to = case when coalesce(p_assign_to_me, false) then p_actor else assigned_to end,
      resolved_at = case
        when p_status = 'resolved' then coalesce(resolved_at, now())
        else null
      end
  where id = p_ticket_id
  returning * into v_after;

  perform platform.admin_audit_write(
    p_actor, v_role, 'admin.support_updated', 'support_ticket', p_ticket_id::text, v_after.business_id,
    'Support ticket activity',
    jsonb_build_object('status', v_before.status, 'priority', v_before.priority, 'assigned_to', v_before.assigned_to),
    jsonb_build_object('status', v_after.status, 'priority', v_after.priority, 'assigned_to', v_after.assigned_to)
  );
  return jsonb_build_object('ticket_id', p_ticket_id, 'status', v_after.status, 'priority', v_after.priority);
end $$;

-- Audit reads ----------------------------------------------------------------

create or replace function public.admin_audit_list(
  p_actor uuid,
  p_business_id uuid default null,
  p_limit integer default 50,
  p_offset integer default 0
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_total bigint;
  v_rows jsonb;
  v_limit integer := least(greatest(coalesce(p_limit, 50), 1), 200);
  v_offset integer := greatest(coalesce(p_offset, 0), 0);
begin
  perform platform.require_operator(p_actor, 'view');

  select count(*) into v_total
  from platform.admin_audit_logs l
  where p_business_id is null or l.business_id = p_business_id;

  select coalesce(jsonb_agg(to_jsonb(x) order by x.created_at desc), '[]'::jsonb) into v_rows
  from (
    select l.id, l.created_at, l.actor_user_id, u.email as actor_email, l.actor_role, l.action,
           l.target_type, l.target_id, l.business_id, l.reason, l.before_state, l.after_state
    from platform.admin_audit_logs l
    left join auth.users u on u.id = l.actor_user_id
    where p_business_id is null or l.business_id = p_business_id
    order by l.created_at desc
    limit v_limit offset v_offset
  ) x;

  return jsonb_build_object('total', v_total, 'rows', v_rows);
end $$;

-- Reads a business's tenant audit log. Reads are not logged (decision recorded in docs/SUPER_ADMIN.md).
create or replace function public.admin_tenant_audit_list(
  p_actor uuid,
  p_business_id uuid,
  p_action_prefix text default null,
  p_limit integer default 50,
  p_offset integer default 0
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_total bigint;
  v_rows jsonb;
  v_limit integer := least(greatest(coalesce(p_limit, 50), 1), 200);
  v_offset integer := greatest(coalesce(p_offset, 0), 0);
  v_prefix text := nullif(btrim(coalesce(p_action_prefix, '')), '');
begin
  perform platform.require_operator(p_actor, 'view');
  if p_business_id is null then
    raise exception 'Choose a business.' using errcode = 'P0001';
  end if;

  select count(*) into v_total
  from public.audit_logs a
  where a.business_id = p_business_id
    and (v_prefix is null or left(a.action, char_length(v_prefix)) = v_prefix);

  select coalesce(jsonb_agg(to_jsonb(x) order by x.created_at desc), '[]'::jsonb) into v_rows
  from (
    select a.id, a.created_at, a.action, a.target_type, a.target_id, a.outlet_id,
           a.actor_user_id, u.email as actor_email, a.before_state, a.after_state
    from public.audit_logs a
    left join auth.users u on u.id = a.actor_user_id
    where a.business_id = p_business_id
      and (v_prefix is null or left(a.action, char_length(v_prefix)) = v_prefix)
    order by a.created_at desc
    limit v_limit offset v_offset
  ) x;

  return jsonb_build_object('total', v_total, 'rows', v_rows);
end $$;

-- ── 9. Tenant support RPCs (settings.manage on the business) ────────────────

create or replace function public.support_ticket_open(
  p_actor uuid,
  p_business_id uuid,
  p_subject text,
  p_body text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_subject text := btrim(coalesce(p_subject, ''));
  v_body text := btrim(coalesce(p_body, ''));
  v_ticket uuid;
begin
  perform public.require_business_actor_permission(p_actor, p_business_id, 'settings.manage');
  if char_length(v_subject) not between 3 and 120 then
    raise exception 'The subject needs 3 to 120 characters.' using errcode = 'P0001';
  end if;
  if char_length(v_body) not between 1 and 4000 then
    raise exception 'The message needs 1 to 4000 characters.' using errcode = 'P0001';
  end if;
  if (
    select count(*) from platform.support_tickets t
    where t.business_id = p_business_id and t.status <> 'resolved'
  ) >= 10 then
    raise exception 'You have 10 open tickets. Wait for a reply before opening another.' using errcode = 'P0001';
  end if;

  insert into platform.support_tickets (business_id, opened_by, subject)
  values (p_business_id, p_actor, v_subject)
  returning id into v_ticket;

  insert into platform.support_ticket_messages (ticket_id, author_user_id, author_side, body)
  values (v_ticket, p_actor, 'business', v_body);

  return jsonb_build_object('id', v_ticket);
end $$;

create or replace function public.support_tickets_list(p_actor uuid, p_business_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform public.require_business_actor_permission(p_actor, p_business_id, 'settings.manage');
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', t.id,
      'subject', t.subject,
      'status', t.status,
      'created_at', t.created_at,
      'last_message_at', t.last_message_at,
      'messages', coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', m.id, 'author_side', m.author_side, 'body', m.body, 'created_at', m.created_at
        ) order by m.created_at)
        from platform.support_ticket_messages m
        where m.ticket_id = t.id and m.author_side in ('business', 'support')
      ), '[]'::jsonb)
    ) order by t.last_message_at desc)
    from platform.support_tickets t
    where t.business_id = p_business_id
  ), '[]'::jsonb);
end $$;

create or replace function public.support_ticket_reply(
  p_actor uuid,
  p_business_id uuid,
  p_ticket_id uuid,
  p_body text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_body text := btrim(coalesce(p_body, ''));
begin
  perform public.require_business_actor_permission(p_actor, p_business_id, 'settings.manage');
  if char_length(v_body) not between 1 and 4000 then
    raise exception 'The message needs 1 to 4000 characters.' using errcode = 'P0001';
  end if;
  if not exists (
    select 1 from platform.support_tickets t
    where t.id = p_ticket_id and t.business_id = p_business_id
    for update
  ) then
    raise exception 'Ticket not found.' using errcode = 'P0002';
  end if;

  insert into platform.support_ticket_messages (ticket_id, author_user_id, author_side, body)
  values (p_ticket_id, p_actor, 'business', v_body);

  update platform.support_tickets
  set status = 'open', last_message_at = now(), resolved_at = null
  where id = p_ticket_id;

  return jsonb_build_object('ticket_id', p_ticket_id, 'status', 'open');
end $$;

-- ── 10. Grants: service role only ───────────────────────────────────────────

do $$
declare
  r record;
begin
  for r in
    select p.oid::regprocedure as sig
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public', 'platform')
      and (p.proname like 'admin\_%' escape '\' or p.proname like 'support\_%' escape '\'
           or p.proname in (
             'require_operator', 'operator_role', 'operator_permissions', 'assert_not_last_super_admin',
             'require_reason', 'like_pattern', 'admin_audit_write', 'admin_audit_append_only',
             'default_trial_days', 'provision_business_subscription', 'feature_entitlement',
             'assert_feature', 'plan_snapshot', 'business_usage', 'guard_membership_business_active',
             'guard_integration_feature', 'guard_online_channel_feature'
           ))
  loop
    execute format('revoke all on function %s from public, anon, authenticated', r.sig);
  end loop;
end $$;

-- Only RPCs that the server calls directly are granted to the service role.
do $$
declare
  r record;
begin
  for r in
    select p.oid::regprocedure as sig
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and (p.proname like 'admin\_%' escape '\' or p.proname like 'support\_%' escape '\')
  loop
    execute format('grant execute on function %s to service_role', r.sig);
  end loop;
end $$;

-- Platform helpers stay internal. Revoke from the service role too.
revoke all on function platform.require_operator(uuid, text) from service_role;
revoke all on function platform.operator_role(uuid) from service_role;
revoke all on function platform.operator_permissions(text) from service_role;
revoke all on function platform.assert_not_last_super_admin(uuid) from service_role;
revoke all on function platform.admin_audit_write(uuid, text, text, text, text, uuid, text, jsonb, jsonb) from service_role;
revoke all on function platform.feature_entitlement(uuid, text) from service_role;
revoke all on function platform.business_usage(uuid, timestamptz) from service_role;
