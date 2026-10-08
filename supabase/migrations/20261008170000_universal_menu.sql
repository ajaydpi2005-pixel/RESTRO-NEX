-- RestroNex — Phase 7: Universal menu management
--
-- The menu becomes the single source of truth feeding POS, KDS, online
-- ordering, inventory and reports. Phase 6's starter tables (menu_categories,
-- menu_items) are EXTENDED — never duplicated — so onboarding data carries
-- straight over:
--
--   menu_categories      + parent_id        → categories & subcategories
--   menu_items           + sku, image, tax  → products
--   product_variants     (new)              → variants
--   modifier_groups / modifiers / product_modifier_groups (new)
--                                           → modifiers & add-ons (an add-on
--                                             is a modifier group with
--                                             min_selected = 0)
--   combos / combo_items (new)
--   outlet_product_overrides / outlet_variant_overrides (new)
--                                           → outlet pricing & availability
--
-- Security model: RLS on everything, member-scoped SELECT, ZERO client write
-- policies. Writes go through server actions (RBAC-checked) using the service
-- role. Storage gets its first tenant-scoped object policies.

-- ── categories + subcategories ──────────────────────────────────────────────

alter table public.menu_categories
  add column if not exists parent_id uuid references public.menu_categories (id) on delete cascade;

create index if not exists menu_categories_parent_idx
  on public.menu_categories (parent_id);

-- One level of nesting only: a subcategory cannot itself have a parent.
create or replace function public.menu_categories_depth_check()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.parent_id is not null then
    if new.parent_id = new.id then
      raise exception 'a category cannot be its own parent' using errcode = 'P0001';
    end if;
    if exists (
      select 1 from public.menu_categories
      where id = new.parent_id and parent_id is not null
    ) then
      raise exception 'subcategories cannot be nested deeper than one level' using errcode = 'P0001';
    end if;
  end if;
  return new;
end;
$$;

revoke all on function public.menu_categories_depth_check()
  from public, anon, authenticated, service_role;

create trigger menu_categories_depth
  before insert or update of parent_id on public.menu_categories
  for each row execute function public.menu_categories_depth_check();

-- ── products (menu_items) ───────────────────────────────────────────────────

alter table public.menu_items
  add column if not exists sku text
    constraint menu_items_sku_format check (sku is null or sku ~ '^[A-Za-z0-9][A-Za-z0-9._-]{1,31}$'),
  add column if not exists image_path text,
  add column if not exists tax_rate_pct numeric(6,3)
    constraint menu_items_tax_range check (tax_rate_pct is null or (tax_rate_pct >= 0 and tax_rate_pct <= 100));

create unique index if not exists menu_items_business_sku_unique
  on public.menu_items (business_id, sku) where sku is not null;

comment on column public.menu_items.sku is 'Stock keeping unit; unique within the business.';
comment on column public.menu_items.tax_rate_pct is
  'Product-level tax override; NULL inherits the business tax settings.';
comment on column public.menu_items.image_path is
  'Object path inside the menu-media bucket: {business_id}/{product_id}/file.';

-- ── variants ────────────────────────────────────────────────────────────────

create table public.product_variants (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  product_id uuid not null references public.menu_items (id) on delete cascade,
  name text not null
    constraint product_variants_name_length check (char_length(trim(name)) between 1 and 60),
  sku text
    constraint product_variants_sku_format check (sku is null or sku ~ '^[A-Za-z0-9][A-Za-z0-9._-]{1,31}$'),
  price_minor bigint not null
    constraint product_variants_price_range check (price_minor between 0 and 100000000),
  is_available boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index product_variants_product_name_unique
  on public.product_variants (product_id, lower(trim(name)));
create index product_variants_product_idx on public.product_variants (product_id);

create trigger product_variants_set_updated_at
  before update on public.product_variants
  for each row execute function public.set_updated_at();

-- ── modifier groups, modifiers, product links ───────────────────────────────

create table public.modifier_groups (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  name text not null
    constraint modifier_groups_name_length check (char_length(trim(name)) between 1 and 60),
  min_selected integer not null default 0
    constraint modifier_groups_min_range check (min_selected >= 0),
  max_selected integer
    constraint modifier_groups_max_range check (max_selected is null or max_selected > 0),
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint modifier_groups_min_max check (max_selected is null or max_selected >= min_selected)
);

create unique index modifier_groups_business_name_unique
  on public.modifier_groups (business_id, lower(trim(name)));

create table public.modifiers (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  modifier_group_id uuid not null references public.modifier_groups (id) on delete cascade,
  name text not null
    constraint modifiers_name_length check (char_length(trim(name)) between 1 and 60),
  price_minor bigint not null default 0
    constraint modifiers_price_range check (price_minor between 0 and 100000000),
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index modifiers_group_name_unique
  on public.modifiers (modifier_group_id, lower(trim(name)));
create index modifiers_group_idx on public.modifiers (modifier_group_id);

create table public.product_modifier_groups (
  product_id uuid not null references public.menu_items (id) on delete cascade,
  modifier_group_id uuid not null references public.modifier_groups (id) on delete cascade,
  sort_order integer not null default 0,
  primary key (product_id, modifier_group_id)
);

create trigger product_modifier_groups_set_updated_at
  before update on public.modifier_groups
  for each row execute function public.set_updated_at();
create trigger modifiers_set_updated_at
  before update on public.modifiers
  for each row execute function public.set_updated_at();

-- A product can only link modifier groups from the SAME business.
create or replace function public.product_modifier_groups_same_business()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_product_business uuid;
  v_group_business uuid;
begin
  select business_id into v_product_business from public.menu_items where id = new.product_id;
  select business_id into v_group_business from public.modifier_groups where id = new.modifier_group_id;
  if v_product_business is null or v_group_business is null then
    raise exception 'product or modifier group not found' using errcode = 'P0001';
  end if;
  if v_product_business <> v_group_business then
    raise exception 'products can only link modifier groups from the same business' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

revoke all on function public.product_modifier_groups_same_business()
  from public, anon, authenticated, service_role;

create trigger product_modifier_groups_business_guard
  before insert on public.product_modifier_groups
  for each row execute function public.product_modifier_groups_same_business();

-- ── combos ──────────────────────────────────────────────────────────────────

create table public.combos (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  name text not null
    constraint combos_name_length check (char_length(trim(name)) between 1 and 80),
  sku text
    constraint combos_sku_format check (sku is null or sku ~ '^[A-Za-z0-9][A-Za-z0-9._-]{1,31}$'),
  description text
    constraint combos_description_length check (description is null or char_length(description) <= 400),
  price_minor bigint not null
    constraint combos_price_range check (price_minor between 0 and 100000000),
  image_path text,
  is_vegetarian boolean not null default true,
  tax_rate_pct numeric(6,3)
    constraint combos_tax_range check (tax_rate_pct is null or (tax_rate_pct >= 0 and tax_rate_pct <= 100)),
  is_available boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index combos_business_sku_unique
  on public.combos (business_id, sku) where sku is not null;
create index combos_business_idx on public.combos (business_id);

create table public.combo_items (
  id uuid primary key default gen_random_uuid(),
  combo_id uuid not null references public.combos (id) on delete cascade,
  product_id uuid not null references public.menu_items (id) on delete cascade,
  variant_id uuid references public.product_variants (id) on delete set null,
  quantity integer not null default 1
    constraint combo_items_quantity_range check (quantity between 1 and 20),
  sort_order integer not null default 0
);

create index combo_items_combo_idx on public.combo_items (combo_id);
create unique index combo_items_combo_product_plain_unique
  on public.combo_items (combo_id, product_id) where variant_id is null;
create unique index combo_items_combo_product_variant_unique
  on public.combo_items (combo_id, product_id, variant_id) where variant_id is not null;

create trigger combos_set_updated_at
  before update on public.combos
  for each row execute function public.set_updated_at();

-- ── outlet-specific pricing & availability ──────────────────────────────────

create table public.outlet_product_overrides (
  outlet_id uuid not null references public.outlets (id) on delete cascade,
  product_id uuid not null references public.menu_items (id) on delete cascade,
  price_minor bigint
    constraint outlet_product_overrides_price_range check (price_minor is null or price_minor between 0 and 100000000),
  is_available boolean not null default true,
  updated_at timestamptz not null default now(),
  primary key (outlet_id, product_id)
);

create table public.outlet_variant_overrides (
  outlet_id uuid not null references public.outlets (id) on delete cascade,
  variant_id uuid not null references public.product_variants (id) on delete cascade,
  price_minor bigint
    constraint outlet_variant_overrides_price_range check (price_minor is null or price_minor between 0 and 100000000),
  is_available boolean not null default true,
  updated_at timestamptz not null default now(),
  primary key (outlet_id, variant_id)
);

create index outlet_product_overrides_product_idx
  on public.outlet_product_overrides (product_id);
create index outlet_variant_overrides_variant_idx
  on public.outlet_variant_overrides (variant_id);

comment on table public.outlet_product_overrides is
  'Outlet pricing/availability exceptions. Missing row = base price & available.';

-- ── RLS: member reads, no client writes ─────────────────────────────────────

alter table public.product_variants enable row level security;
alter table public.modifier_groups enable row level security;
alter table public.modifiers enable row level security;
alter table public.product_modifier_groups enable row level security;
alter table public.combos enable row level security;
alter table public.combo_items enable row level security;
alter table public.outlet_product_overrides enable row level security;
alter table public.outlet_variant_overrides enable row level security;

create policy "product_variants_select_member"
  on public.product_variants for select to authenticated
  using (public.has_business_access(business_id));

create policy "modifier_groups_select_member"
  on public.modifier_groups for select to authenticated
  using (public.has_business_access(business_id));

create policy "modifiers_select_member"
  on public.modifiers for select to authenticated
  using (public.has_business_access(business_id));

create policy "product_modifier_groups_select_member"
  on public.product_modifier_groups for select to authenticated
  using (
    exists (
      select 1 from public.menu_items p
      where p.id = product_modifier_groups.product_id
        and public.has_business_access(p.business_id)
    )
  );

create policy "combos_select_member"
  on public.combos for select to authenticated
  using (public.has_business_access(business_id));

create policy "combo_items_select_member"
  on public.combo_items for select to authenticated
  using (
    exists (
      select 1 from public.combos c
      where c.id = combo_items.combo_id
        and public.has_business_access(c.business_id)
    )
  );

create policy "outlet_product_overrides_select_member"
  on public.outlet_product_overrides for select to authenticated
  using (
    exists (
      select 1 from public.outlets o
      where o.id = outlet_product_overrides.outlet_id
        and public.has_business_access(o.business_id)
    )
  );

create policy "outlet_variant_overrides_select_member"
  on public.outlet_variant_overrides for select to authenticated
  using (
    exists (
      select 1 from public.outlets o
      where o.id = outlet_variant_overrides.outlet_id
        and public.has_business_access(o.business_id)
    )
  );

-- ── storage policies: tenant-scoped menu media ──────────────────────────────
--
-- Object layout: menu-media/{business_id}/{product_or_combo_id}/{file}.
-- Reads are public (menus face customers); writes require an ACTIVE
-- membership with a menu-management role in the business named by the path.

create policy "menu_media_public_read"
  on storage.objects for select
  to anon, authenticated
  using (bucket_id = 'menu-media');

create policy "menu_media_member_insert"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'menu-media'
    and exists (
      select 1
      from public.memberships m
      where m.user_id = auth.uid()
        and m.status = 'active'
        and m.role in ('owner', 'business_admin', 'outlet_manager')
        and m.business_id::text = coalesce((storage.foldername(name))[1], '')
    )
  );

create policy "menu_media_member_update"
  on storage.objects for update
  to authenticated
  using (
    bucket_id = 'menu-media'
    and exists (
      select 1
      from public.memberships m
      where m.user_id = auth.uid()
        and m.status = 'active'
        and m.role in ('owner', 'business_admin', 'outlet_manager')
        and m.business_id::text = coalesce((storage.foldername(name))[1], '')
    )
  );

create policy "menu_media_member_delete"
  on storage.objects for delete
  to authenticated
  using (
    bucket_id = 'menu-media'
    and exists (
      select 1
      from public.memberships m
      where m.user_id = auth.uid()
        and m.status = 'active'
        and m.role in ('owner', 'business_admin', 'outlet_manager')
        and m.business_id::text = coalesce((storage.foldername(name))[1], '')
    )
  );
