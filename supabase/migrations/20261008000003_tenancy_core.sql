-- RestroNex — Phase 1: tenancy core
--
-- Business (tenant) and outlet foundation. Every tenant-owned table created
-- in later phases will reference businesses.id and inherit the access pattern
-- established here.

create table public.businesses (
  id uuid primary key default gen_random_uuid(),
  name text not null
    constraint businesses_name_not_blank check (length(trim(name)) > 0),
  slug text not null unique
    constraint businesses_slug_format check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  status text not null default 'active'
    constraint businesses_status_allowed check (status in ('active', 'suspended', 'closed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger businesses_set_updated_at
  before update on public.businesses
  for each row execute function public.set_updated_at();

-- A business operates through one or many outlets (spec §10).
create table public.outlets (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  name text not null
    constraint outlets_name_not_blank check (length(trim(name)) > 0),
  slug text not null
    constraint outlets_slug_format check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  status text not null default 'active'
    constraint outlets_status_allowed check (status in ('active', 'inactive', 'closed')),
  timezone text not null default 'UTC',
  currency_code char(3) not null
    constraint outlets_currency_upper check (currency_code = upper(currency_code)),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint outlets_business_slug_unique unique (business_id, slug)
);

create trigger outlets_set_updated_at
  before update on public.outlets
  for each row execute function public.set_updated_at();

-- Free-form, phase-extensible settings (tax config, charges, hours, ...).
-- Kept as single JSONB documents so schema churn stays low; hot keys are
-- promoted to columns only when reporting or constraints demand it.
create table public.business_settings (
  business_id uuid primary key references public.businesses (id) on delete cascade,
  settings jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create trigger business_settings_set_updated_at
  before update on public.business_settings
  for each row execute function public.set_updated_at();

create table public.outlet_settings (
  outlet_id uuid primary key references public.outlets (id) on delete cascade,
  settings jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create trigger outlet_settings_set_updated_at
  before update on public.outlet_settings
  for each row execute function public.set_updated_at();
