-- RestroNex — Phase 2: outlet-level access + tenant resolution support
--
-- Business membership (Phase 1) answers "which tenant does this user belong
-- to". This migration adds the outlet layer required by spec §10: outlet
-- users must only access authorised outlets.
--
-- Access model:
--   * roles owner / business_admin  → implicit access to every outlet of the
--     business
--   * every other role              → explicit grants in membership_outlets
-- Grants are managed server-side (staff management, Phase 5+); there are no
-- client-writable policies on the grant table.

create table public.membership_outlets (
  membership_id uuid not null references public.memberships (id) on delete cascade,
  outlet_id uuid not null references public.outlets (id) on delete cascade,
  granted_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (membership_id, outlet_id)
);

create index if not exists membership_outlets_outlet_idx
  on public.membership_outlets (outlet_id);

alter table public.membership_outlets enable row level security;

-- Can the current user OPERATE in this outlet? (visibility of the outlet
-- row itself stays business-scoped for the outlet switcher; operations on
-- outlet-scoped data — orders, tables, stock — gate on this function.)
create or replace function public.has_outlet_access(p_outlet_id uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1
    from public.outlets o
    join public.memberships m
      on m.business_id = o.business_id
     and m.user_id = auth.uid()
     and m.status = 'active'
    left join public.membership_outlets mo
      on mo.membership_id = m.id
     and mo.outlet_id = o.id
    where o.id = p_outlet_id
      and (m.role in ('owner', 'business_admin') or mo.outlet_id is not null)
  );
$$;

revoke all on function public.has_outlet_access(uuid) from public;
revoke all on function public.has_outlet_access(uuid) from anon;
grant execute on function public.has_outlet_access(uuid) to authenticated;
grant execute on function public.has_outlet_access(uuid) to service_role;

-- One round-trip for the server tenant resolver: every outlet id the
-- current user can operate in.
create or replace function public.accessible_outlet_ids()
returns setof uuid
language sql
security definer
stable
set search_path = public
as $$
  select o.id
  from public.outlets o
  where public.has_outlet_access(o.id);
$$;

revoke all on function public.accessible_outlet_ids() from public;
revoke all on function public.accessible_outlet_ids() from anon;
grant execute on function public.accessible_outlet_ids() to authenticated;
grant execute on function public.accessible_outlet_ids() to service_role;

-- Members can view the outlet grants inside businesses they belong to
-- (needed for staff management UIs); writes stay server-side.
create policy "membership_outlets_select_member"
  on public.membership_outlets for select
  to authenticated
  using (
    exists (
      select 1
      from public.memberships m
      where m.id = membership_outlets.membership_id
        and (m.user_id = auth.uid() or public.has_business_access(m.business_id))
    )
  );
