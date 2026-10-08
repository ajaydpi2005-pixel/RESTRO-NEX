-- RestroNex — Phase 1: Row Level Security foundation
--
-- Rule of the platform: a user can only see tenant data for businesses where
-- they hold an ACTIVE membership. Writes that create tenants or manage staff
-- (business/outlet creation, invitations, deletions) are intentionally NOT
-- covered by permissive policies — they will flow through server-side flows
-- (Phase 4+) where permissions are enforced explicitly.

alter table public.businesses enable row level security;
alter table public.outlets enable row level security;
alter table public.business_settings enable row level security;
alter table public.outlet_settings enable row level security;
alter table public.user_profiles enable row level security;
alter table public.memberships enable row level security;

-- Membership check used by policies. SECURITY DEFINER avoids the recursive
-- policy lookup that would occur if policies on memberships queried
-- memberships directly. STABLE lets the planner cache it per statement.
create or replace function public.has_business_access(p_business_id uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1
    from public.memberships m
    where m.business_id = p_business_id
      and m.user_id = auth.uid()
      and m.status = 'active'
  );
$$;

revoke all on function public.has_business_access(uuid) from public;
revoke all on function public.has_business_access(uuid) from anon;
revoke all on function public.has_business_access(uuid) from service_role;
grant execute on function public.has_business_access(uuid) to authenticated;
grant execute on function public.has_business_access(uuid) to service_role;

-- businesses -----------------------------------------------------------------
create policy "business_select_member"
  on public.businesses for select
  to authenticated
  using (public.has_business_access(id));

create policy "business_update_member"
  on public.businesses for update
  to authenticated
  using (public.has_business_access(id))
  with check (public.has_business_access(id));
-- No INSERT/DELETE policy: tenant creation happens through server-side
-- onboarding (Phase 6), not direct client writes.

-- outlets --------------------------------------------------------------------
create policy "outlet_select_member"
  on public.outlets for select
  to authenticated
  using (public.has_business_access(business_id));

create policy "outlet_update_member"
  on public.outlets for update
  to authenticated
  using (public.has_business_access(business_id))
  with check (public.has_business_access(business_id));

-- settings -------------------------------------------------------------------
create policy "business_settings_select_member"
  on public.business_settings for select
  to authenticated
  using (public.has_business_access(business_id));

create policy "business_settings_update_member"
  on public.business_settings for update
  to authenticated
  using (public.has_business_access(business_id))
  with check (public.has_business_access(business_id));

create policy "outlet_settings_select_member"
  on public.outlet_settings for select
  to authenticated
  using (
    exists (
      select 1
      from public.outlets o
      where o.id = outlet_settings.outlet_id
        and public.has_business_access(o.business_id)
    )
  );

create policy "outlet_settings_update_member"
  on public.outlet_settings for update
  to authenticated
  using (
    exists (
      select 1
      from public.outlets o
      where o.id = outlet_settings.outlet_id
        and public.has_business_access(o.business_id)
    )
  )
  with check (
    exists (
      select 1
      from public.outlets o
      where o.id = outlet_settings.outlet_id
        and public.has_business_access(o.business_id)
    )
  );

-- user_profiles ---------------------------------------------------------------
-- Users manage only their own profile. Profiles are created by the
-- handle_new_user trigger (security definer), so no INSERT policy exists.
create policy "profile_select_own"
  on public.user_profiles for select
  to authenticated
  using (id = auth.uid());

create policy "profile_update_own"
  on public.user_profiles for update
  to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());

-- memberships ------------------------------------------------------------------
-- A user sees their own memberships plus the roster of businesses they
-- belong to. Membership writes are server-side (invitations, Phase 5+).
create policy "membership_select"
  on public.memberships for select
  to authenticated
  using (user_id = auth.uid() or public.has_business_access(business_id));

create policy "membership_update_own_status"
  on public.memberships for update
  to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());
