-- RestroNex — Phase 1: user profiles + memberships
--
-- user_profiles mirrors auth.users 1:1 (created by trigger, never by
-- clients). memberships is the tenancy join: it answers "which user belongs
-- to which business". The full roles/permissions model lands in Phase 5;
-- the role column is constrained to the spec's role set from day one.

create table public.user_profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  full_name text,
  email citext not null unique,
  phone text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger user_profiles_set_updated_at
  before update on public.user_profiles
  for each row execute function public.set_updated_at();

-- A profile row is created automatically for every new auth user.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.user_profiles (id, full_name, email)
  values (new.id, new.raw_user_meta_data ->> 'full_name', new.email)
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

create table public.memberships (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  business_id uuid not null references public.businesses (id) on delete cascade,
  role text not null default 'cashier'
    constraint memberships_role_allowed check (
      role in (
        'owner',
        'business_admin',
        'outlet_manager',
        'cashier',
        'waiter',
        'kitchen_staff',
        'inventory_manager',
        'accountant'
      )
    ),
  status text not null default 'active'
    constraint memberships_status_allowed check (status in ('active', 'invited', 'deactivated')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint memberships_user_business_unique unique (user_id, business_id)
);

create trigger memberships_set_updated_at
  before update on public.memberships
  for each row execute function public.set_updated_at();
