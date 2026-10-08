-- RestroNex — Phase 1: platform schema
--
-- Platform-level data (RestroNex as a SaaS) lives in a dedicated schema that
-- tenant-facing roles can never reach. Only the service role may access it;
-- tenant isolation therefore does not depend on application-layer care alone.

-- Shared helper: keeps updated_at current on every UPDATE.
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create schema if not exists platform;

-- Lock the schema down: no tenant-facing role may even see it.
revoke all on schema platform from public;
revoke all on schema platform from anon;
revoke all on schema platform from authenticated;
grant usage on schema platform to service_role;

alter default privileges in schema platform revoke all on tables from public;
alter default privileges in schema platform revoke all on tables from anon;
alter default privileges in schema platform revoke all on tables from authenticated;
alter default privileges in schema platform grant all on tables to service_role;

-- Subscription plans (spec §32). Feature limits and entitlements are
-- configured when the subscription system ships (Phase 20).
create table platform.subscription_plans (
  id uuid primary key default gen_random_uuid(),
  code text not null unique
    constraint subscription_plans_code_upper check (code = upper(code) and length(code) > 0),
  name text not null,
  description text,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

-- Per-plan feature toggles/limits (extensible; populated in Phase 20).
create table platform.plan_features (
  id uuid primary key default gen_random_uuid(),
  plan_id uuid not null references platform.subscription_plans (id) on delete cascade,
  feature_key text not null,
  included boolean not null default false,
  limit_value bigint
    constraint plan_features_limit_non_negative check (limit_value is null or limit_value >= 0),
  created_at timestamptz not null default now(),
  constraint plan_features_plan_feature_unique unique (plan_id, feature_key)
);

-- Designated platform operators (spec §31). Super Admin is never granted
-- through public sign-up: rows here are managed out-of-band by RestroNex
-- operators via the service role.
create table platform.super_admins (
  user_id uuid primary key references auth.users (id) on delete cascade,
  granted_by uuid references auth.users (id) on delete set null,
  granted_at timestamptz not null default now()
);

alter table platform.subscription_plans enable row level security;
alter table platform.plan_features enable row level security;
alter table platform.super_admins enable row level security;
-- No policies: with RLS on and no grants, only the service role (BYPASSRLS)
-- can read these tables.
