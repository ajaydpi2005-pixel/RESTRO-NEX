-- RestroNex — Phase 4: business + outlet management details
--
-- Phase 1 created the tenancy core (names, slugs, statuses). Phase 4 adds
-- the operational profile fields the owner manages: logo, address, contact,
-- tax information, currency, timezone and restaurant type for the business;
-- outlet code, address, contact, order types and operating hours per outlet.
--
-- New columns are nullable (or defaulted) so existing rows stay valid.
-- Client INSERTs remain forbidden by RLS: tenant creation flows through the
-- server-side create_business() RPC below.

-- ── businesses ──────────────────────────────────────────────────────────────

alter table public.businesses
  add column if not exists logo_url text
    constraint businesses_logo_url_http check (logo_url is null or logo_url ~ '^https?://'),
  add column if not exists email text,
  add column if not exists phone text,
  add column if not exists address_line1 text,
  add column if not exists address_line2 text,
  add column if not exists city text,
  add column if not exists state text,
  add column if not exists postal_code text,
  add column if not exists country text,
  add column if not exists currency_code char(3) not null default 'INR'
    constraint businesses_currency_upper check (currency_code = upper(currency_code)),
  add column if not exists timezone text not null default 'Asia/Kolkata',
  add column if not exists restaurant_type text
    constraint businesses_restaurant_type_allowed check (
      restaurant_type is null or restaurant_type in (
        'quick_service', 'casual_dining', 'fine_dining', 'cafe',
        'cloud_kitchen', 'bakery', 'bar_pub', 'food_truck', 'other'
      )
    ),
  add column if not exists tax_number text,
  add column if not exists tax_settings jsonb not null default '{}'::jsonb
    constraint businesses_tax_settings_object check (jsonb_typeof(tax_settings) = 'object');

comment on column public.businesses.currency_code is
  'ISO-4217 code; business-level default inherited by new outlets.';
comment on column public.businesses.timezone is
  'IANA timezone; business-level default inherited by new outlets.';

-- ── outlets ─────────────────────────────────────────────────────────────────

alter table public.outlets
  add column if not exists code text
    constraint outlets_code_format check (code ~ '^[A-Z0-9][A-Z0-9_-]{0,15}$'),
  add column if not exists email text,
  add column if not exists phone text,
  add column if not exists address_line1 text,
  add column if not exists address_line2 text,
  add column if not exists city text,
  add column if not exists state text,
  add column if not exists postal_code text,
  add column if not exists country text,
  add column if not exists order_types text[] not null default '{dine_in}'
    constraint outlets_order_types_allowed check (
      cardinality(order_types) > 0
      and order_types <@ array['dine_in', 'takeaway', 'delivery']
    ),
  add column if not exists operating_hours jsonb not null default '{}'::jsonb
    constraint outlets_operating_hours_object check (jsonb_typeof(operating_hours) = 'object');

alter table public.outlets
  add constraint outlets_business_code_unique unique (business_id, code);

comment on column public.outlets.code is
  'Short human-readable outlet code, unique within the business (e.g. OUT-01).';
comment on column public.outlets.operating_hours is
  'Per-day schedule: {"mon":{"open":"09:00","close":"22:00"}, ..., "sun":null}. null day = closed.';

create index if not exists outlets_business_code_idx
  on public.outlets (business_id, code);

-- ── slug helpers ────────────────────────────────────────────────────────────

create extension if not exists unaccent;

-- Mirrors the app-side slugify (src/modules/business/schemas.ts): strip
-- diacritics, fold non-alphanumerics to single dashes, lowercase.
create or replace function public.slugify(p_input text)
returns text
language sql
stable
as $$
  select lower(trim(both '-' from regexp_replace(regexp_replace(
    unaccent(coalesce(p_input, '')),
    '[^A-Za-z0-9]+', '-', 'g'),
    '-{2,}', '-', 'g')))
$$;

revoke all on function public.slugify(text) from public, anon, authenticated, service_role;
grant execute on function public.slugify(text) to service_role;

-- ── atomic tenant creation ──────────────────────────────────────────────────
--
-- Creates the business, the owner membership and the empty settings document
-- in ONE transaction so a failed step can never leave an ownerless tenant.
-- Server-side flows only: revoked from authenticated/anon.

create or replace function public.create_business(
  p_owner_id uuid,
  p_name text,
  p_restaurant_type text,
  p_currency_code char(3),
  p_timezone text,
  p_email text default null,
  p_phone text default null,
  p_address_line1 text default null,
  p_address_line2 text default null,
  p_city text default null,
  p_state text default null,
  p_postal_code text default null,
  p_country text default null,
  p_tax_number text default null,
  p_logo_url text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_base_slug text;
  v_slug text;
  v_attempt int := 0;
  v_business_id uuid;
begin
  if not exists (select 1 from auth.users where id = p_owner_id) then
    raise exception 'owner does not exist' using errcode = 'P0001';
  end if;

  if length(trim(coalesce(p_name, ''))) = 0 then
    raise exception 'business name is required' using errcode = 'P0001';
  end if;

  v_base_slug := public.slugify(p_name);
  if length(v_base_slug) < 2 then
    v_base_slug := 'restaurant';
  end if;
  v_base_slug := left(v_base_slug, 48);

  loop
    v_attempt := v_attempt + 1;
    v_slug := case when v_attempt = 1 then v_base_slug
                   else v_base_slug || '-' || substr(md5(random()::text), 1, 5) end;
    begin
      insert into public.businesses (
        name, slug, logo_url, email, phone,
        address_line1, address_line2, city, state, postal_code, country,
        currency_code, timezone, restaurant_type, tax_number
      ) values (
        trim(p_name), v_slug, p_logo_url, p_email, p_phone,
        p_address_line1, p_address_line2, p_city, p_state, p_postal_code, p_country,
        upper(p_currency_code), p_timezone, p_restaurant_type, p_tax_number
      )
      returning id into v_business_id;
      exit;
    exception when unique_violation then
      if v_attempt >= 5 then
        raise;
      end if;
    end;
  end loop;

  insert into public.memberships (user_id, business_id, role, status)
  values (p_owner_id, v_business_id, 'owner', 'active');

  insert into public.business_settings (business_id, settings)
  values (v_business_id, '{}'::jsonb);

  return v_business_id;
end;
$$;

revoke all on function public.create_business(
  uuid, text, text, char, text,
  text, text, text, text, text, text, text, text, text, text
) from public, anon, authenticated, service_role;
grant execute on function public.create_business(
  uuid, text, text, char, text,
  text, text, text, text, text, text, text, text, text, text
) to service_role;
