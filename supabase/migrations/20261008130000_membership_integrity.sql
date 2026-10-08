-- RestroNex — Phase 2: membership integrity trigger
--
-- Closes a forged-parameter gap: the memberships UPDATE policy verifies
-- user_id = auth.uid() on the NEW row, which alone would let a member
-- re-point their own membership at another tenant's business_id or
-- escalate their own role to 'owner'. Identity fields are therefore
-- immutable for RLS-scoped roles; privileged roles (postgres,
-- service_role — both BYPASSRLS/superuser) manage them server-side.
-- Status remains self-service (a member may deactivate themselves).

create or replace function public.memberships_protect_identity()
returns trigger
language plpgsql
as $$
declare
  privileged boolean;
begin
  select coalesce(rolsuper, false) or coalesce(rolbypassrls, false)
    into privileged
  from pg_roles
  where rolname = current_user;

  if not privileged then
    if new.user_id is distinct from old.user_id
       or new.business_id is distinct from old.business_id
       or new.role is distinct from old.role then
      raise exception 'membership identity fields are immutable for this role'
        using errcode = '42501';
    end if;
  end if;

  return new;
end;
$$;

create trigger memberships_protect_identity
  before update on public.memberships
  for each row execute function public.memberships_protect_identity();
