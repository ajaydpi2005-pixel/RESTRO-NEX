-- RestroNex — Phase 6: Restaurant onboarding
--
-- First-time setup persists real data for every step of the flow:
--
--   create business → restaurant type → outlet → business settings →
--   tax settings → tables → kitchen → menu → staff invites → dashboard
--
-- New entities:
--   * onboarding_progress  — per-business wizard state (resume later)
--   * dining_sections / dining_tables — floor plan (used by Phase 9 dine-in)
--   * kitchen_stations     — KDS stations (used by Phase 11)
--   * menu_categories / menu_items — starter menu (Phase 7 extends with
--     variants/modifiers/combos; nothing here is throwaway)
--   * staff_invites        — token invitations; acceptance creates a real
--     membership + outlet grants atomically
--
-- Security model (unchanged from Phases 4/5):
--   * RLS is enabled on every table; SELECT is member-scoped, and there are
--     NO client write policies — all writes flow through server actions that
--     authorise first (RBAC) and then use the service role or the SECURITY
--     DEFINER functions below.
--   * The SECURITY DEFINER functions re-check membership themselves because
--     they run with elevated rights.

-- ── onboarding progress ─────────────────────────────────────────────────────

create table public.onboarding_progress (
  business_id uuid primary key references public.businesses (id) on delete cascade,
  current_step text not null default 'type'
    constraint onboarding_progress_step_allowed check (
      current_step in (
        'business', 'type', 'outlet', 'settings', 'tax',
        'tables', 'kitchen', 'menu', 'staff', 'finish', 'done'
      )
    ),
  completed_steps text[] not null default '{}'::text[]
    constraint onboarding_progress_completed_allowed check (
      completed_steps <@ array[
        'business', 'type', 'outlet', 'settings', 'tax',
        'tables', 'kitchen', 'menu', 'staff', 'finish'
      ]
    ),
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.onboarding_progress is
  'Per-business wizard state: where the owner left off and which steps are done.';

create trigger onboarding_progress_set_updated_at
  before update on public.onboarding_progress
  for each row execute function public.set_updated_at();

-- Every new business starts onboarding automatically (right after
-- create_business() commits the tenant row).
create or replace function public.init_onboarding_progress()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.onboarding_progress (business_id, current_step, completed_steps)
  values (new.id, 'type', array['business'])
  on conflict (business_id) do nothing;
  return new;
end;
$$;

revoke all on function public.init_onboarding_progress() from public, anon, authenticated, service_role;

create trigger businesses_init_onboarding
  after insert on public.businesses
  for each row execute function public.init_onboarding_progress();

-- ── floor plan ──────────────────────────────────────────────────────────────

create table public.dining_sections (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  outlet_id uuid not null references public.outlets (id) on delete cascade,
  name text not null
    constraint dining_sections_name_length check (char_length(trim(name)) between 1 and 60),
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index dining_sections_outlet_name_unique
  on public.dining_sections (outlet_id, lower(trim(name)));

create index dining_sections_outlet_idx on public.dining_sections (outlet_id);

create table public.dining_tables (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  outlet_id uuid not null references public.outlets (id) on delete cascade,
  section_id uuid references public.dining_sections (id) on delete cascade,
  label text not null
    constraint dining_tables_label_length check (char_length(trim(label)) between 1 and 20),
  capacity integer not null default 2
    constraint dining_tables_capacity_range check (capacity between 1 and 50),
  is_active boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index dining_tables_outlet_label_unique
  on public.dining_tables (outlet_id, lower(trim(label)));

create index dining_tables_outlet_idx on public.dining_tables (outlet_id);
create index dining_tables_section_idx on public.dining_tables (section_id);

create trigger dining_sections_set_updated_at
  before update on public.dining_sections
  for each row execute function public.set_updated_at();
create trigger dining_tables_set_updated_at
  before update on public.dining_tables
  for each row execute function public.set_updated_at();

-- ── kitchen stations ────────────────────────────────────────────────────────

create table public.kitchen_stations (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  outlet_id uuid not null references public.outlets (id) on delete cascade,
  name text not null
    constraint kitchen_stations_name_length check (char_length(trim(name)) between 1 and 60),
  description text
    constraint kitchen_stations_description_length check (description is null or char_length(description) <= 200),
  is_active boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index kitchen_stations_outlet_name_unique
  on public.kitchen_stations (outlet_id, lower(trim(name)));

create index kitchen_stations_outlet_idx on public.kitchen_stations (outlet_id);

create trigger kitchen_stations_set_updated_at
  before update on public.kitchen_stations
  for each row execute function public.set_updated_at();

-- ── starter menu ────────────────────────────────────────────────────────────
-- Menu is business-level (shared across outlets); outlet availability comes
-- with Phase 7's universal menu.

create table public.menu_categories (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  name text not null
    constraint menu_categories_name_length check (char_length(trim(name)) between 1 and 60),
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index menu_categories_business_name_unique
  on public.menu_categories (business_id, lower(trim(name)));

create index menu_categories_business_idx on public.menu_categories (business_id);

create table public.menu_items (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  category_id uuid not null references public.menu_categories (id) on delete cascade,
  name text not null
    constraint menu_items_name_length check (char_length(trim(name)) between 1 and 80),
  description text
    constraint menu_items_description_length check (description is null or char_length(description) <= 400),
  price_minor bigint not null
    constraint menu_items_price_range check (price_minor between 0 and 100000000),
  is_vegetarian boolean not null default true,
  is_available boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index menu_items_business_idx on public.menu_items (business_id);
create index menu_items_category_idx on public.menu_items (category_id);

create trigger menu_categories_set_updated_at
  before update on public.menu_categories
  for each row execute function public.set_updated_at();
create trigger menu_items_set_updated_at
  before update on public.menu_items
  for each row execute function public.set_updated_at();

-- ── staff invitations ───────────────────────────────────────────────────────
-- A token link the owner shares; acceptance (accept_staff_invite) creates the
-- real membership + outlet grants. Owner is never invitables; outlet-scoped
-- roles require at least one outlet.

create table public.staff_invites (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  email text
    constraint staff_invites_email_length check (email is null or char_length(email) <= 254),
  token text not null unique
    constraint staff_invites_token_length check (char_length(token) >= 32),
  role text not null
    constraint staff_invites_role_allowed check (
      role in (
        'business_admin', 'outlet_manager', 'cashier', 'waiter',
        'kitchen_staff', 'inventory_manager', 'accountant'
      )
    ),
  outlet_ids uuid[] not null default '{}'::uuid[],
  invited_by uuid references auth.users (id) on delete set null,
  expires_at timestamptz not null,
  accepted_by uuid references auth.users (id) on delete set null,
  accepted_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  constraint staff_invites_outlet_roles_need_outlets check (
    role = 'business_admin' or cardinality(outlet_ids) > 0
  )
);

create index staff_invites_business_idx on public.staff_invites (business_id);

comment on table public.staff_invites is
  'Pending staff invitations. Tokens are secret; read access is limited to business owners/admins.';

-- ── RLS: member-scoped reads, zero client writes ───────────────────────────

alter table public.onboarding_progress enable row level security;
alter table public.dining_sections enable row level security;
alter table public.dining_tables enable row level security;
alter table public.kitchen_stations enable row level security;
alter table public.menu_categories enable row level security;
alter table public.menu_items enable row level security;
alter table public.staff_invites enable row level security;

create policy "onboarding_progress_select_member"
  on public.onboarding_progress for select
  to authenticated
  using (public.has_business_access(business_id));

create policy "dining_sections_select_member"
  on public.dining_sections for select
  to authenticated
  using (public.has_business_access(business_id));

create policy "dining_tables_select_member"
  on public.dining_tables for select
  to authenticated
  using (public.has_business_access(business_id));

create policy "kitchen_stations_select_member"
  on public.kitchen_stations for select
  to authenticated
  using (public.has_business_access(business_id));

create policy "menu_categories_select_member"
  on public.menu_categories for select
  to authenticated
  using (public.has_business_access(business_id));

create policy "menu_items_select_member"
  on public.menu_items for select
  to authenticated
  using (public.has_business_access(business_id));

-- Invites contain secret tokens: owners/admins only.
create policy "staff_invites_select_admin"
  on public.staff_invites for select
  to authenticated
  using (
    exists (
      select 1
      from public.memberships m
      where m.business_id = staff_invites.business_id
        and m.user_id = auth.uid()
        and m.status = 'active'
        and m.role in ('owner', 'business_admin')
    )
  );

-- ── wizard state RPC ────────────────────────────────────────────────────────

create or replace function public.update_onboarding_progress(
  p_actor uuid,
  p_business_id uuid,
  p_current_step text,
  p_completed_step text default null,
  p_finish boolean default false
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (
    select 1 from public.memberships m
    where m.business_id = p_business_id
      and m.user_id = p_actor
      and m.status = 'active'
      and m.role in ('owner', 'business_admin')
  ) then
    raise exception 'not authorised to manage onboarding' using errcode = 'P0001';
  end if;

  if p_current_step not in (
    'business', 'type', 'outlet', 'settings', 'tax',
    'tables', 'kitchen', 'menu', 'staff', 'finish', 'done'
  ) then
    raise exception 'unknown onboarding step' using errcode = 'P0001';
  end if;

  insert into public.onboarding_progress (business_id, current_step, completed_steps)
  values (
    p_business_id,
    case when p_finish then 'done' else p_current_step end,
    case when p_completed_step is not null
         then array[case when p_completed_step = 'business' then 'business' else p_completed_step end]
         else '{}'::text[] end
  )
  on conflict (business_id) do update
    set current_step = case when p_finish then 'done' else excluded.current_step end,
        completed_steps = case
          when p_completed_step is not null
            and not (p_completed_step = any (public.onboarding_progress.completed_steps))
          then array_append(public.onboarding_progress.completed_steps, p_completed_step)
          else public.onboarding_progress.completed_steps
        end,
        completed_at = case when p_finish then now() else public.onboarding_progress.completed_at end;
end;
$$;

revoke all on function public.update_onboarding_progress(uuid, uuid, text, text, boolean)
  from public, anon, authenticated, service_role;
grant execute on function public.update_onboarding_progress(uuid, uuid, text, text, boolean)
  to service_role;

-- ── floor plan RPC (atomic replace) ─────────────────────────────────────────

create or replace function public.set_outlet_floor_plan(
  p_actor uuid,
  p_outlet_id uuid,
  p_sections jsonb
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_business_id uuid;
  v_section jsonb;
  v_table jsonb;
  v_section_id uuid;
  v_section_idx integer := 0;
  v_table_idx integer := 0;
  v_table_total integer := 0;
begin
  select business_id into v_business_id
  from public.outlets where id = p_outlet_id;

  if v_business_id is null then
    raise exception 'outlet not found' using errcode = 'P0001';
  end if;

  if not exists (
    select 1 from public.memberships m
    where m.business_id = v_business_id
      and m.user_id = p_actor
      and m.status = 'active'
      and m.role in ('owner', 'business_admin')
  ) then
    raise exception 'not authorised to configure this outlet' using errcode = 'P0001';
  end if;

  if jsonb_typeof(p_sections) <> 'array' or jsonb_array_length(p_sections) > 20 then
    raise exception 'sections must be an array of at most 20 entries' using errcode = 'P0001';
  end if;

  delete from public.dining_sections where outlet_id = p_outlet_id; -- tables cascade

  for v_section in select * from jsonb_array_elements(p_sections) loop
    if coalesce(jsonb_typeof(v_section -> 'name'), 'absent') <> 'string'
       or length(trim(v_section ->> 'name')) not between 1 and 60 then
      raise exception 'every section needs a name (max 60 chars)' using errcode = 'P0001';
    end if;
    if coalesce(jsonb_typeof(v_section -> 'tables'), 'absent') <> 'array' then
      raise exception 'every section needs a tables array' using errcode = 'P0001';
    end if;

    v_section_idx := v_section_idx + 1;
    v_table_idx := 0;

    insert into public.dining_sections (business_id, outlet_id, name, sort_order)
    values (v_business_id, p_outlet_id, trim(v_section ->> 'name'), v_section_idx)
    returning id into v_section_id;

    for v_table in select * from jsonb_array_elements(v_section -> 'tables') loop
      if coalesce(jsonb_typeof(v_table -> 'label'), 'absent') <> 'string'
         or length(trim(v_table ->> 'label')) not between 1 and 20 then
        raise exception 'every table needs a label (max 20 chars)' using errcode = 'P0001';
      end if;
      begin
        if (v_table ->> 'capacity')::int not between 1 and 50 then
          raise exception 'table capacity must be between 1 and 50' using errcode = 'P0001';
        end if;
      exception when others then
        raise exception 'table capacity must be a number between 1 and 50' using errcode = 'P0001';
      end;

      v_table_idx := v_table_idx + 1;
      v_table_total := v_table_total + 1;
      if v_table_total > 500 then
        raise exception 'at most 500 tables per outlet' using errcode = 'P0001';
      end if;

      insert into public.dining_tables
        (business_id, outlet_id, section_id, label, capacity, sort_order)
      values
        (v_business_id, p_outlet_id, v_section_id, trim(v_table ->> 'label'),
         (v_table ->> 'capacity')::int, v_table_idx);
    end loop;
  end loop;

  return v_table_total;
end;
$$;

revoke all on function public.set_outlet_floor_plan(uuid, uuid, jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.set_outlet_floor_plan(uuid, uuid, jsonb)
  to service_role;

-- ── kitchen stations RPC (atomic replace) ───────────────────────────────────

create or replace function public.set_outlet_kitchen_stations(
  p_actor uuid,
  p_outlet_id uuid,
  p_stations jsonb
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_business_id uuid;
  v_station jsonb;
  v_idx integer := 0;
begin
  select business_id into v_business_id
  from public.outlets where id = p_outlet_id;

  if v_business_id is null then
    raise exception 'outlet not found' using errcode = 'P0001';
  end if;

  if not exists (
    select 1 from public.memberships m
    where m.business_id = v_business_id
      and m.user_id = p_actor
      and m.status = 'active'
      and m.role in ('owner', 'business_admin')
  ) then
    raise exception 'not authorised to configure this outlet' using errcode = 'P0001';
  end if;

  if jsonb_typeof(p_stations) <> 'array' or jsonb_array_length(p_stations) > 20 then
    raise exception 'stations must be an array of at most 20 entries' using errcode = 'P0001';
  end if;

  delete from public.kitchen_stations where outlet_id = p_outlet_id;

  for v_station in select * from jsonb_array_elements(p_stations) loop
    if coalesce(jsonb_typeof(v_station -> 'name'), 'absent') <> 'string'
       or length(trim(v_station ->> 'name')) not between 1 and 60 then
      raise exception 'every station needs a name (max 60 chars)' using errcode = 'P0001';
    end if;
    if v_station ? 'description'
       and jsonb_typeof(v_station -> 'description') <> 'null'
       and (jsonb_typeof(v_station -> 'description') <> 'string'
            or length(v_station ->> 'description') > 200) then
      raise exception 'station descriptions are text of at most 200 chars' using errcode = 'P0001';
    end if;

    v_idx := v_idx + 1;
    insert into public.kitchen_stations (business_id, outlet_id, name, description, sort_order)
    values (
      v_business_id, p_outlet_id, trim(v_station ->> 'name'),
      case when v_station ? 'description' and jsonb_typeof(v_station -> 'description') = 'string'
           then v_station ->> 'description' else null end,
      v_idx
    );
  end loop;

  return v_idx;
end;
$$;

revoke all on function public.set_outlet_kitchen_stations(uuid, uuid, jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.set_outlet_kitchen_stations(uuid, uuid, jsonb)
  to service_role;

-- ── menu RPC (atomic replace) ───────────────────────────────────────────────

create or replace function public.set_business_menu(
  p_actor uuid,
  p_business_id uuid,
  p_categories jsonb
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_category jsonb;
  v_item jsonb;
  v_category_id uuid;
  v_category_idx integer := 0;
  v_item_idx integer := 0;
  v_item_total integer := 0;
  v_price bigint;
begin
  if not exists (select 1 from public.businesses where id = p_business_id) then
    raise exception 'business not found' using errcode = 'P0001';
  end if;

  if not exists (
    select 1 from public.memberships m
    where m.business_id = p_business_id
      and m.user_id = p_actor
      and m.status = 'active'
      and m.role in ('owner', 'business_admin')
  ) then
    raise exception 'not authorised to manage this menu' using errcode = 'P0001';
  end if;

  if jsonb_typeof(p_categories) <> 'array' or jsonb_array_length(p_categories) > 30 then
    raise exception 'categories must be an array of at most 30 entries' using errcode = 'P0001';
  end if;

  delete from public.menu_categories where business_id = p_business_id; -- items cascade

  for v_category in select * from jsonb_array_elements(p_categories) loop
    if coalesce(jsonb_typeof(v_category -> 'name'), 'absent') <> 'string'
       or length(trim(v_category ->> 'name')) not between 1 and 60 then
      raise exception 'every category needs a name (max 60 chars)' using errcode = 'P0001';
    end if;
    if coalesce(jsonb_typeof(v_category -> 'items'), 'absent') <> 'array' then
      raise exception 'every category needs an items array' using errcode = 'P0001';
    end if;

    v_category_idx := v_category_idx + 1;
    v_item_idx := 0;

    insert into public.menu_categories (business_id, name, sort_order)
    values (p_business_id, trim(v_category ->> 'name'), v_category_idx)
    returning id into v_category_id;

    for v_item in select * from jsonb_array_elements(v_category -> 'items') loop
      if coalesce(jsonb_typeof(v_item -> 'name'), 'absent') <> 'string'
         or length(trim(v_item ->> 'name')) not between 1 and 80 then
        raise exception 'every item needs a name (max 80 chars)' using errcode = 'P0001';
      end if;
      begin
        v_price := (v_item ->> 'price_minor')::bigint;
      exception when others then
        raise exception 'every item needs a whole-number price in minor units' using errcode = 'P0001';
      end;
      if v_price not between 0 and 100000000 then
        raise exception 'item price is out of range' using errcode = 'P0001';
      end if;
      if v_item ? 'description'
         and jsonb_typeof(v_item -> 'description') <> 'null'
         and (jsonb_typeof(v_item -> 'description') <> 'string'
              or length(v_item ->> 'description') > 400) then
        raise exception 'item descriptions are text of at most 400 chars' using errcode = 'P0001';
      end if;

      v_item_idx := v_item_idx + 1;
      v_item_total := v_item_total + 1;
      if v_item_total > 1000 then
        raise exception 'at most 1000 menu items' using errcode = 'P0001';
      end if;

      insert into public.menu_items
        (business_id, category_id, name, description, price_minor, is_vegetarian, sort_order)
      values (
        p_business_id, v_category_id, trim(v_item ->> 'name'),
        case when v_item ? 'description' and jsonb_typeof(v_item -> 'description') = 'string'
             then v_item ->> 'description' else null end,
        v_price,
        coalesce((v_item ->> 'is_vegetarian')::boolean, true),
        v_item_idx
      );
    end loop;
  end loop;

  return v_item_total;
end;
$$;

revoke all on function public.set_business_menu(uuid, uuid, jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.set_business_menu(uuid, uuid, jsonb)
  to service_role;

-- ── invite acceptance RPC ───────────────────────────────────────────────────

create or replace function public.accept_staff_invite(
  p_actor uuid,
  p_token text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_invite public.staff_invites%rowtype;
  v_email text;
  v_membership_id uuid;
  v_outlet uuid;
begin
  if not exists (select 1 from auth.users where id = p_actor) then
    raise exception 'unknown user' using errcode = 'P0001';
  end if;

  select * into v_invite from public.staff_invites where token = p_token;
  if v_invite.id is null then
    raise exception 'This invitation link is invalid.' using errcode = 'P0001';
  end if;
  if v_invite.revoked_at is not null then
    raise exception 'This invitation was revoked.' using errcode = 'P0001';
  end if;
  if v_invite.accepted_at is not null then
    raise exception 'This invitation has already been used.' using errcode = 'P0001';
  end if;
  if v_invite.expires_at <= now() then
    raise exception 'This invitation has expired.' using errcode = 'P0001';
  end if;

  if v_invite.email is not null then
    select email into v_email from auth.users where id = p_actor;
    if lower(trim(v_email)) <> lower(trim(v_invite.email)) then
      raise exception 'This invitation was issued for a different email address.' using errcode = 'P0001';
    end if;
  end if;

  -- Outlet grants must still belong to the business.
  for v_outlet in select unnest(v_invite.outlet_ids) loop
    if not exists (
      select 1 from public.outlets o
      where o.id = v_outlet and o.business_id = v_invite.business_id
    ) then
      raise exception 'This invitation references an outlet that no longer exists.' using errcode = 'P0001';
    end if;
  end loop;

  if v_invite.role <> 'business_admin' and cardinality(v_invite.outlet_ids) = 0 then
    raise exception 'This invitation is missing outlet assignments.' using errcode = 'P0001';
  end if;

  select id into v_membership_id
  from public.memberships
  where user_id = p_actor and business_id = v_invite.business_id;

  if v_membership_id is not null then
    if exists (
      select 1 from public.memberships
      where id = v_membership_id and status = 'active'
    ) then
      raise exception 'You are already a member of this business.' using errcode = 'P0001';
    end if;
    update public.memberships
    set role = v_invite.role, status = 'active'
    where id = v_membership_id;
  else
    insert into public.memberships (user_id, business_id, role, status)
    values (p_actor, v_invite.business_id, v_invite.role, 'active')
    returning id into v_membership_id;
  end if;

  delete from public.membership_outlets where membership_id = v_membership_id;
  insert into public.membership_outlets (membership_id, outlet_id, granted_by)
  select v_membership_id, unnest(v_invite.outlet_ids), v_invite.invited_by;

  update public.staff_invites
  set accepted_by = p_actor, accepted_at = now()
  where id = v_invite.id;

  return v_invite.business_id;
end;
$$;

revoke all on function public.accept_staff_invite(uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.accept_staff_invite(uuid, text)
  to service_role;
