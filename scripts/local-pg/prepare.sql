-- ─────────────────────────────────────────────────────────────────────────
-- RestroNex local verification harness: Supabase emulation for bare
-- PostgreSQL. Used ONLY by scripts/verify-db.sh to validate migrations and
-- RLS without Docker. Never deployed to real environments.
-- ─────────────────────────────────────────────────────────────────────────

-- API roles, mirroring Supabase's role model.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin bypassrls;
  end if;
end
$$;

-- Supabase grants usage on public to the API roles and auto-grants objects
-- created by the postgres role.
grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;

-- auth schema emulation -------------------------------------------------------
create schema if not exists auth;

-- Columns mirror the hosted auth.users: phone and last_sign_in_at are read by
-- the Super Admin user list and detail RPCs.
create table if not exists auth.users (
  id uuid primary key default gen_random_uuid(),
  email text unique,
  phone text,
  raw_user_meta_data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  last_sign_in_at timestamptz
);

grant usage on schema auth to anon, authenticated, service_role;
grant select on table auth.users to authenticated, service_role;

-- Faithful auth.uid(): PostgREST exposes the JWT subject via
-- request.jwt.claims. Tests set this GUC to simulate a signed-in user.
create or replace function auth.uid()
returns uuid
language sql
stable
as $$
  select (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')::uuid
$$;

-- storage schema emulation ----------------------------------------------------
create schema if not exists storage;

create table if not exists storage.buckets (
  id text primary key,
  name text not null unique,
  public boolean not null default false,
  created_at timestamptz not null default now()
);

grant usage on schema storage to anon, authenticated, service_role;
grant select on table storage.buckets to anon, authenticated, service_role;

-- Minimal objects table + helpers so Phase 7's storage policies can be
-- created and asserted locally (real Supabase ships these natively).
create table if not exists storage.objects (
  id uuid primary key default gen_random_uuid(),
  bucket_id text references storage.buckets (id),
  name text not null,
  owner uuid,
  created_at timestamptz not null default now()
);
alter table storage.objects enable row level security;

create or replace function storage.foldername(p_name text)
returns text[]
language sql
immutable
as $$
  select case
    when p_name like '%/%' then string_to_array(regexp_replace(p_name, '/[^/]*$', ''), '/')
    else '{}'::text[]
  end;
$$;

-- Role privileges on objects (RLS policies decide who may actually act).
grant select on table storage.objects to anon, authenticated, service_role;
grant insert, update, delete on table storage.objects to authenticated, service_role;
